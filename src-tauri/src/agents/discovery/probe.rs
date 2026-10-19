use super::*;

pub(crate) fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> io::Result<Option<std::process::Output>> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("Unable to read agent detection standard output"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Unable to read agent detection error output"))?;
    thread::scope(|scope| {
        let stdout_reader = scope.spawn(move || {
            let mut output = Vec::new();
            stdout.read_to_end(&mut output).map(|_| output)
        });
        let stderr_reader = scope.spawn(move || {
            let mut output = Vec::new();
            stderr.read_to_end(&mut output).map(|_| output)
        });
        let deadline = Instant::now() + timeout;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break Some(status);
            }
            if Instant::now() >= deadline {
                terminate_agent_probe_process(&mut child);
                break None;
            }
            thread::sleep(AGENT_VERSION_PROBE_POLL_INTERVAL);
        };
        let stdout = stdout_reader
            .join()
            .map_err(|_| io::Error::other("Agent detection output thread exited unexpectedly"))??;
        let stderr = stderr_reader
            .join()
            .map_err(|_| io::Error::other("Agent detection error thread exited unexpectedly"))??;
        Ok(status.map(|status| std::process::Output {
            status,
            stdout,
            stderr,
        }))
    })
}

pub(super) fn terminate_agent_probe_process(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let process_id = child.id().to_string();
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &process_id, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_command(&mut command);
        let _ = command.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub(crate) fn read_agent_version(path: &Path, home: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    let mut command = windows_command_for_executable(path, false);

    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new(path);

    command.arg("--version");
    configure_background_command(&mut command);
    configure_agent_command_environment(&mut command, home, path).ok()?;
    let output = command_output_with_timeout(&mut command, AGENT_VERSION_PROBE_TIMEOUT).ok()??;
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
