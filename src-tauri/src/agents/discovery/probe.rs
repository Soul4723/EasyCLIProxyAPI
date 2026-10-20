use super::*;

pub(crate) const COMMAND_TIMEOUT_DIAGNOSTIC_LIMIT: usize = 1024;

pub(crate) enum CommandOutputOutcome {
    Completed(std::process::Output),
    TimedOut(CommandTimeout),
}

pub(crate) struct CommandTimeout {
    pub(crate) timeout: Duration,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) termination_error: Option<String>,
}

impl CommandTimeout {
    pub(crate) fn message(&self, probe: &str) -> String {
        let mut message = format!(
            "{probe} probe timed out after {:.1}s (stdout: {:?}; stderr: {:?})",
            self.timeout.as_secs_f64(),
            String::from_utf8_lossy(&self.stdout),
            String::from_utf8_lossy(&self.stderr),
        );
        if let Some(error) = &self.termination_error {
            message.push_str(&format!("; process termination incomplete: {error}"));
        }
        message
    }
}

pub(crate) fn log_probe_timeout(probe: &str, timeout: &CommandTimeout) {
    eprintln!("{}", timeout.message(probe));
}

pub(crate) fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> io::Result<CommandOutputOutcome> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command.spawn()?;
    let mut child = AgentProbeChild::new(child);
    let mut stdout = child
        .child
        .as_mut()
        .expect("probe child is present before reader startup")
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Unable to read agent detection standard output"))?;
    let mut stderr = child
        .child
        .as_mut()
        .expect("probe child is present before reader startup")
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Unable to read agent detection error output"))?;
    let stdout_diagnostics = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let stderr_diagnostics = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let timed_out = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Reader threads must not hold the caller past the deadline while a
    // descendant keeps either inherited pipe open.
    let stdout_capture = std::sync::Arc::clone(&stdout_diagnostics);
    let stdout_timed_out = std::sync::Arc::clone(&timed_out);
    let stdout_reader = thread::Builder::new()
        .spawn(move || read_command_output(stdout, stdout_capture, stdout_timed_out))?;
    let stderr_capture = std::sync::Arc::clone(&stderr_diagnostics);
    let stderr_timed_out = std::sync::Arc::clone(&timed_out);
    let stderr_reader = thread::Builder::new()
        .spawn(move || read_command_output(stderr, stderr_capture, stderr_timed_out))?;
    let deadline = Instant::now() + timeout;
    loop {
        if child.has_exited()? && stdout_reader.is_finished() && stderr_reader.is_finished() {
            let stdout = stdout_reader.join().map_err(|_| {
                io::Error::other("Agent detection output thread exited unexpectedly")
            })??;
            let stderr = stderr_reader.join().map_err(|_| {
                io::Error::other("Agent detection error thread exited unexpectedly")
            })??;
            let status = child.reap()?;
            return Ok(CommandOutputOutcome::Completed(std::process::Output {
                status,
                stdout,
                stderr,
            }));
        }
        if Instant::now() >= deadline {
            timed_out.store(true, std::sync::atomic::Ordering::Release);
            let mut timeout = CommandTimeout {
                timeout,
                stdout: read_diagnostic_snippet(&stdout_diagnostics),
                stderr: read_diagnostic_snippet(&stderr_diagnostics),
                termination_error: None,
            };
            timeout.termination_error = child.terminate();
            return Ok(CommandOutputOutcome::TimedOut(timeout));
        }
        thread::sleep(AGENT_VERSION_PROBE_POLL_INTERVAL);
    }
}

struct AgentProbeChild {
    child: Option<Child>,
    reaped: bool,
    status: Option<std::process::ExitStatus>,
    cleanup_attempted: bool,
}

impl AgentProbeChild {
    fn new(child: Child) -> Self {
        Self {
            child: Some(child),
            reaped: false,
            status: None,
            cleanup_attempted: false,
        }
    }

    fn has_exited(&mut self) -> io::Result<bool> {
        #[cfg(unix)]
        {
            command_child_exited(
                self.child
                    .as_ref()
                    .ok_or_else(|| io::Error::other("probe child was handed to reaper"))?,
            )
        }
        #[cfg(not(unix))]
        {
            let child = self
                .child
                .as_mut()
                .ok_or_else(|| io::Error::other("probe child was handed to reaper"))?;
            if let Some(status) = child.try_wait()? {
                self.status = Some(status);
                self.reaped = true;
                Ok(true)
            } else {
                Ok(false)
            }
        }
    }

    fn reap(&mut self) -> io::Result<std::process::ExitStatus> {
        if let Some(status) = self.status.take() {
            return Ok(status);
        }
        let status = self
            .child
            .as_mut()
            .ok_or_else(|| io::Error::other("probe child was handed to reaper"))?
            .wait()?;
        self.reaped = true;
        Ok(status)
    }

    fn terminate(&mut self) -> Option<String> {
        if self.reaped {
            return Some(
                "probe process exited before inherited pipes closed; descendants may remain"
                    .to_owned(),
            );
        }
        if self.cleanup_attempted {
            return None;
        }
        self.cleanup_attempted = true;
        terminate_agent_probe_process(&mut self.child, &mut self.reaped)
    }
}

impl Drop for AgentProbeChild {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

fn read_command_output(
    mut reader: impl Read,
    diagnostics: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    timed_out: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut chunk = [0; 1024];
    loop {
        let bytes_read = reader.read(&mut chunk)?;
        if bytes_read == 0 {
            return Ok(output);
        }
        if timed_out.load(std::sync::atomic::Ordering::Acquire) {
            output = Vec::new();
        } else {
            output.extend_from_slice(&chunk[..bytes_read]);
        }
        let mut diagnostics = diagnostics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let remaining = COMMAND_TIMEOUT_DIAGNOSTIC_LIMIT.saturating_sub(diagnostics.len());
        diagnostics.extend_from_slice(&chunk[..bytes_read.min(remaining)]);
    }
}

fn read_diagnostic_snippet(diagnostics: &std::sync::Mutex<Vec<u8>>) -> Vec<u8> {
    diagnostics
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

#[cfg(unix)]
fn command_child_exited(child: &Child) -> io::Result<bool> {
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                child.id() as _,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == -1 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        // SAFETY: WNOWAIT leaves an exited child waitable so its PID continues
        // pinning its process group until cleanup signals it and reaps it.
        return Ok(unsafe { info.si_pid() } != 0);
    }
}

pub(super) fn terminate_agent_probe_process(
    child: &mut Option<Child>,
    reaped: &mut bool,
) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let process_id = child
            .as_ref()
            .expect("probe child is present before taskkill")
            .id()
            .to_string();
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &process_id, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_command(&mut command);
        let mut errors = Vec::new();
        match command.spawn() {
            Ok(mut taskkill) => {
                if !wait_for_child_bounded(&mut taskkill, Duration::from_secs(2)) {
                    let _ = taskkill.kill();
                    if !wait_for_child_bounded(&mut taskkill, Duration::from_millis(500)) {
                        errors.push("taskkill did not exit after its termination request".to_owned());
                        detach_probe_child_reaper(taskkill);
                    }
                }
            }
            Err(error) => errors.push(format!("could not start taskkill: {error}")),
        }
        // taskkill /T may miss descendants after the parent exits; a Job Object
        // is the follow-up for that Windows limitation.
        let probe_exited = if let Some(probe_child) = child.as_mut() {
            let _ = probe_child.kill();
            wait_for_child_bounded(probe_child, Duration::from_millis(500))
        } else {
            false
        };
        if probe_exited {
            *reaped = true;
        } else {
            errors.push("probe process did not exit after its termination request".to_owned());
            if let Some(probe_child) = child.take() {
                detach_probe_child_reaper(probe_child);
            }
        }
        return (!errors.is_empty()).then(|| errors.join("; "));
    }
    #[cfg(unix)]
    {
        let mut group_signal_error = None;
        let result = signal_then_reap(reaped, |step| match step {
            ProbeCleanupStep::Signal => {
                let probe_child = child
                    .as_mut()
                    .expect("probe child is present before signal/reap cleanup");
                group_signal_error =
                    crate::process_signal::signal_group(probe_child.id(), libc::SIGKILL).err();
                let _ = probe_child.kill();
                Ok(None)
            }
            ProbeCleanupStep::Reap => {
                if let Some(error) = group_signal_error.take() {
                    Err(error)
                } else {
                    child
                        .as_mut()
                        .expect("probe child remains owned until reap")
                        .wait()
                        .map(Some)
                }
            }
        });
        if let Err(error) = result {
            if let Some(probe_child) = child.take() {
                detach_probe_child_reaper(probe_child);
            }
            return Some(format!("probe process reaping was handed to a background thread: {error}"));
        }
        return None;
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let probe_child = child.as_mut().expect("probe child is present during cleanup");
        let _ = probe_child.kill();
        match probe_child.wait() {
            Ok(_) => *reaped = true,
            Err(error) => return Some(format!("could not reap probe process: {error}")),
        }
        None
    }
}

fn detach_probe_child_reaper(child: Child) {
    // Keep ownership outside the closure until the OS confirms that the
    // thread was created. Builder::spawn returns the closure on failure only
    // by dropping it, so the shared slot lets us synchronously reap instead.
    let child_slot = std::sync::Arc::new(std::sync::Mutex::new(Some(child)));
    let reaper_slot = std::sync::Arc::clone(&child_slot);
    if thread::Builder::new()
        .name("agent-probe-reaper".to_owned())
        .spawn(move || {
            let child = reaper_slot
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            if let Some(mut child) = child {
                let _ = child.wait();
            }
        })
        .is_err()
    {
        if let Some(mut child) = child_slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            // Cleanup already requested termination. If a reaper thread cannot
            // be created, prefer waiting here over dropping an unreaped child.
            let _ = child.wait();
        }
    }
}

pub(crate) enum ProbeCleanupStep {
    Signal,
    Reap,
}

pub(crate) fn signal_then_reap<T>(
    reaped: &mut bool,
    mut step: impl FnMut(ProbeCleanupStep) -> io::Result<Option<T>>,
) -> io::Result<T> {
    if *reaped {
        return Err(io::Error::other("probe process was already reaped"));
    }
    step(ProbeCleanupStep::Signal)?;
    let result = step(ProbeCleanupStep::Reap)?
        .ok_or_else(|| io::Error::other("probe reap step returned no exit status"))?;
    *reaped = true;
    Ok(result)
}

#[cfg(target_os = "windows")]
fn wait_for_child_bounded(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(AGENT_VERSION_PROBE_POLL_INTERVAL);
            }
            Ok(None) | Err(_) => return false,
        }
    }
}

pub(crate) fn read_agent_version(path: &Path, home: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    let mut command = windows_command_for_executable(path, false);

    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new(path);

    command.arg("--version");
    configure_background_command(&mut command);
    configure_agent_command_environment(&mut command, home, path).ok()?;
    let output = match command_output_with_timeout(&mut command, AGENT_VERSION_PROBE_TIMEOUT).ok()? {
        CommandOutputOutcome::Completed(output) => output,
        CommandOutputOutcome::TimedOut(timeout) => {
            log_probe_timeout("Agent executable version", &timeout);
            return None;
        }
    };
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .find_map(normalize_detected_agent_version)
}

pub(crate) fn normalize_detected_agent_version(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= 256
        && value.chars().any(|character| character.is_ascii_digit())
        && !value.chars().any(char::is_control))
    .then(|| value.to_string())
}
