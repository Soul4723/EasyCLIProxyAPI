use super::*;

pub(crate) fn current_core_status(
    process_state: Option<&CoreProcessState>,
    management_port: Option<u16>,
) -> Result<CoreStatus, String> {
    let install_dir = core_install_dir()?;
    let binary_path = find_core_binary(&install_dir);
    let installed = binary_path.is_some();
    let starting = process_state.is_some_and(CoreProcessState::is_starting);
    let managed_pid = process_state.and_then(|state| state.managed_pid());
    let management_port_open = management_port.map(is_management_port_open);
    let process_id = match managed_pid {
        Some(process_id) => Some(process_id),
        None if management_port_open.unwrap_or(true) => binary_path
            .as_ref()
            .and_then(|path| find_core_process_ids(path).first().copied()),
        None => None,
    };
    // A tracked process remains running even if a single management-port probe
    // times out. The port probe is still required before discovering an
    // untracked process, but using it to override a known live PID makes the UI
    // oscillate between running and stopped while continuing to show that PID.
    let running = process_id.is_some();
    let ready = running && management_port_open.unwrap_or(true);
    let current_version = read_core_metadata(&install_dir).map(|metadata| metadata.version);

    let message = if starting {
        "CPA kernel is starting".to_string()
    } else if !installed {
        "CPA kernel is not installed. Install the latest version first".to_string()
    } else if running {
        "CPA kernel is running".to_string()
    } else {
        "CPA kernel is installed but not running".to_string()
    };

    Ok(CoreStatus {
        installed,
        running,
        ready,
        starting,
        recovery: process_state.and_then(|state| state.recovery.status()),
        managed: managed_pid.is_some(),
        process_id,
        current_version,
        install_dir: path_to_string(&install_dir),
        binary_path: binary_path.map(|path| path_to_string(&path)),
        connection_mode: Some("local".to_string()),
        remote_origin: None,
        message,
    })
}

pub(crate) fn is_management_port_open(port: u16) -> bool {
    let listen_host = read_installed_core_config_settings()
        .map(|settings| settings.host)
        .unwrap_or_else(|_| "127.0.0.1".to_string());
    let Ok(address) = core_management_address(&listen_host, port) else {
        return false;
    };
    for attempt in 0..3 {
        if TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok() {
            return true;
        }
        if attempt < 2 {
            thread::sleep(Duration::from_millis(50));
        }
    }
    false
}

pub(super) fn core_management_address(listen_host: &str, port: u16) -> Result<SocketAddr, String> {
    let host = core_connect_host(listen_host);
    let ip = host
        .parse::<IpAddr>()
        .map_err(|_| format!("Invalid core listen IP: {listen_host}"))?;
    Ok(SocketAddr::new(ip, port))
}

pub(crate) enum CoreStartupFailure {
    ShuttingDown,
    Exited(std::process::ExitStatus),
    Spawn(String),
    StatusCheck(io::Error),
    TimedOut(u16),
}

impl CoreStartupFailure {
    fn child_has_exited(&self) -> bool {
        matches!(self, Self::Exited(_))
    }

    #[cfg(target_os = "macos")]
    fn was_killed_by_sigkill(&self) -> bool {
        use std::os::unix::process::ExitStatusExt;

        matches!(
            self,
            Self::Exited(status)
                if status.code().is_none() && status.signal() == Some(libc::SIGKILL)
        )
    }
}

impl std::fmt::Display for CoreStartupFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ShuttingDown => formatter.write_str("Application is exiting; kernel startup canceled"),
            Self::Exited(status) => write!(formatter, "CPA kernel exited immediately after startup: {status}"),
            Self::Spawn(error) => formatter.write_str(error),
            Self::StatusCheck(error) => write!(formatter, "Failed to check CPA kernel startup status: {error}"),
            Self::TimedOut(port) => {
                write!(formatter, "CPA kernel startup timed out: management port {port} was not listening within 10 seconds")
            }
        }
    }
}

pub(crate) fn core_start_log_path(install_dir: &Path, auth_dir: &str) -> Result<PathBuf, String> {
    Ok(core_logs_dir_path(auth_dir, install_dir)?.join("core-start-output.log"))
}

/// Creates the log directory 0700 when it does not exist yet; an existing directory keeps its mode. The core also
/// writes its own logs there, with its own umask.
fn create_core_log_dir(directory: &Path) -> io::Result<()> {
    if directory.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        if let Some(parent) = directory.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::DirBuilder::new().mode(0o700).create(directory) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
            result => result,
        }
    }
    #[cfg(not(unix))]
    fs::create_dir_all(directory)
}

pub(crate) fn core_start_stdio(log_path: &Path) -> io::Result<(Stdio, Stdio)> {
    if let Some(parent) = log_path.parent() {
        create_core_log_dir(parent)?;
    }

    // The log can contain request headers in debug mode, so it is created 0600 and a loose existing log is
    // repaired. Windows relies on the inherited ACL of the profile directory.
    let mut options = File::options();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut header_file = options.open(log_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if header_file.metadata()?.permissions().mode() & 0o7777 != 0o600 {
            header_file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
    }
    writeln!(header_file, "\n===== CPA kernel startup {} =====", unix_now())?;
    drop(header_file);

    let stdout_file = File::options().append(true).open(log_path)?;
    let stderr_file = options.open(log_path)?;

    Ok((Stdio::from(stdout_file), Stdio::from(stderr_file)))
}

pub(super) fn core_start_error_with_log(error: &str, log_path: &Path, log_error: Option<&str>) -> String {
    match log_error {
        Some(log_error) => format!(
            "{error}; failed to write startup log {}: {log_error}",
            path_to_string(log_path)
        ),
        None => format!("{error}; startup log: {}", path_to_string(log_path)),
    }
}

pub(super) struct CoreStartAttemptFailure {
    failure: CoreStartupFailure,
    log_error: Option<String>,
}

impl CoreStartAttemptFailure {
    #[cfg(target_os = "macos")]
    fn was_killed_by_sigkill(&self) -> bool {
        self.failure.was_killed_by_sigkill()
    }

    fn message(&self, log_path: &Path) -> String {
        self.message_with_detail(log_path, None)
    }

    fn message_with_detail(&self, log_path: &Path, detail: Option<&str>) -> String {
        let error = match detail {
            Some(detail) => format!("{}；{detail}", self.failure),
            None => self.failure.to_string(),
        };
        core_start_error_with_log(&error, log_path, self.log_error.as_deref())
    }
}

pub(super) fn start_core_process_once(
    process_state: &CoreProcessState,
    binary_path: &Path,
    config_path: &str,
    install_dir: &Path,
    log_path: &Path,
    management_address: SocketAddr,
) -> Result<CoreChild, CoreStartAttemptFailure> {
    let mut command = Command::new(binary_path);
    command
        .args(["-config", config_path])
        .current_dir(install_dir)
        .stdin(Stdio::null());
    let log_error = match core_start_stdio(log_path) {
        Ok((stdout, stderr)) => {
            command.stdout(stdout).stderr(stderr);
            None
        }
        Err(error) => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
            Some(error.to_string())
        }
    };
    configure_background_command(&mut command);
    for variable in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        command.env_remove(variable);
    }

    let mut child = match spawn_core_child(command) {
        Ok(child) => child,
        Err(error) => {
            return Err(CoreStartAttemptFailure {
                failure: CoreStartupFailure::Spawn(error),
                log_error,
            });
        }
    };
    match wait_for_core_management_port(&mut child, management_address, process_state) {
        Ok(()) => Ok(child),
        Err(failure) => {
            if !failure.child_has_exited() {
                let _ = terminate_child(&mut child);
            }
            Err(CoreStartAttemptFailure { failure, log_error })
        }
    }
}

pub(crate) fn start_core_process_inner(
    process_state: &CoreProcessState,
    gui_config: &GuiConfigFile,
) -> Result<(), String> {
    crate::core_connection::require_local(gui_config)?;
    process_state.ensure_active()?;
    let mut resolved_config = gui_config.clone();
    resolved_config.proxy_url = network_proxy::resolve(gui_config);
    let gui_config = &resolved_config;
    let install_dir = core_install_dir()?;
    if !gui_config.auth_dir.trim().is_empty() {
        let auth_dir = auth_dir_path_for_core(&gui_config.auth_dir, &install_dir)?;
        fs::create_dir_all(&auth_dir)
            .map_err(|error| format!("Failed to create credentials directory {}: {error}", path_to_string(&auth_dir)))?;
    }
    let binary_path = find_core_binary(&install_dir)
        .ok_or_else(|| "CPA kernel is not installed. Install the latest version first".to_string())?;

    let existing_process_ids = find_core_process_ids(&binary_path);
    if process_state.managed_pid().is_some() || !existing_process_ids.is_empty() {
        if !existing_process_ids.is_empty() {
            process_state.adopt_process_ids(&binary_path, existing_process_ids)?;
        }
        return Err("CPA kernel is already running".to_string());
    }
    let management_address = core_management_address(&gui_config.host, gui_config.port)?;
    if TcpStream::connect_timeout(&management_address, Duration::from_millis(250)).is_ok() {
        return Err(format!(
            "Port {} is in use by another program. Change the port and try again",
            gui_config.port
        ));
    }

    let config_path = merge_core_config_for_start(&install_dir, gui_config)?;
    let config_path = path_to_string(&config_path);
    let log_path = core_start_log_path(&install_dir, &gui_config.auth_dir)?;
    let start_once = || {
        start_core_process_once(
            process_state,
            &binary_path,
            &config_path,
            &install_dir,
            &log_path,
            management_address,
        )
    };

    #[cfg(target_os = "macos")]
    let child = match start_once() {
        Ok(child) => child,
        Err(failure) if failure.was_killed_by_sigkill() => {
            if let Err(heal_error) = rematerialize_core_binary(&binary_path) {
                return Err(failure.message_with_detail(
                    &log_path,
                    Some(&format!("Failed to automatically repair CPA kernel files: {heal_error}")),
                ));
            }
            match start_once() {
                Ok(child) => child,
                Err(failure) if failure.was_killed_by_sigkill() => {
                    return Err(failure.message_with_detail(
                        &log_path,
                        Some("The system terminated the CPA kernel again. Reinstall the kernel and try again"),
                    ));
                }
                Err(failure) => return Err(failure.message(&log_path)),
            }
        }
        Err(failure) => return Err(failure.message(&log_path)),
    };
    #[cfg(not(target_os = "macos"))]
    let child = start_once().map_err(|failure| failure.message(&log_path))?;

    process_state.store_child(child)?;
    Ok(())
}

pub(crate) fn wait_for_core_management_port(
    child: &mut Child,
    address: SocketAddr,
    process_state: &CoreProcessState,
) -> Result<(), CoreStartupFailure> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if process_state.is_shutting_down() {
            return Err(CoreStartupFailure::ShuttingDown);
        }
        if let Some(status) = child.try_wait().map_err(CoreStartupFailure::StatusCheck)? {
            return Err(CoreStartupFailure::Exited(status));
        }
        if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(CoreStartupFailure::TimedOut(address.port()));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn configure_child_lifetime(command: &mut Command) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;

        let parent_process_id = unsafe { libc::getpid() };
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                    return Err(io::Error::last_os_error());
                }

                if libc::getppid() != parent_process_id {
                    return Err(io::Error::other(
                        "EasyCLIProxyAPI exited before the core process started",
                    ));
                }

                Ok(())
            });
        }
    }

    #[cfg(not(target_os = "linux"))]
    let _ = command;
}

pub(crate) fn configure_background_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}

pub(crate) fn configure_networked_command(command: &mut Command, proxy_url: &str) {
    let proxy_url = proxy_url.trim();
    for variable in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        if proxy_url.is_empty() {
            command.env_remove(variable);
        } else {
            command.env(variable, proxy_url);
        }
    }
    command
        .env("NO_PROXY", "localhost,127.0.0.1,::1")
        .env("no_proxy", "localhost,127.0.0.1,::1");
}

pub(crate) fn stop_core_process_inner(process_state: &CoreProcessState) -> Result<(), String> {
    process_state.recovery.cancel();
    let mut stopped_any = false;
    let mut errors = Vec::new();

    if let Some(mut child) = process_state.take_child() {
        stopped_any = true;
        if let Err(error) = terminate_child(&mut child) {
            errors.push(error);
        }
    }

    let mut process_ids = process_state
        .take_adopted_processes()
        .into_iter()
        .filter(|process| {
            process_executable_path(process.process_id)
                .as_deref()
                .is_some_and(|path| executable_paths_match(&process.binary_path, path))
        })
        .map(|process| process.process_id)
        .collect::<Vec<_>>();
    if let Ok(install_dir) = core_install_dir() {
        if let Some(binary_path) = find_core_binary(&install_dir) {
            process_ids.extend(find_core_process_ids(&binary_path));
        }
    }
    process_ids.sort_unstable();
    process_ids.dedup();

    for process_id in process_ids {
        if !is_process_alive(process_id) {
            continue;
        }
        stopped_any = true;
        if let Err(error) = terminate_process_id(process_id) {
            errors.push(error);
        }
    }

    if !errors.is_empty() {
        Err(errors.join("；"))
    } else if stopped_any {
        Ok(())
    } else {
        Err("CPA kernel is not currently running".to_string())
    }
}
