use super::*;

pub(super) fn find_desktop_restart_target(
    client: AgentClient,
    home: &Path,
    executable_override: Option<&Path>,
) -> Result<DesktopAppTarget, String> {
    if let Some(path) = manual_desktop_path(executable_override) {
        return Ok(DesktopAppTarget::Application(path.to_path_buf()));
    }
    let target = match client {
        AgentClient::Codex => find_codex_app_installation(home),
        AgentClient::OpenCode => find_opencode_desktop_application(home).map(DesktopAppTarget::Application),
        AgentClient::ZCode => {
            find_zcode_desktop_executable(home).map(DesktopAppTarget::Application)
        }
        AgentClient::WorkBuddy => {
            find_workbuddy_desktop_executable(home).map(DesktopAppTarget::Application)
        }
        AgentClient::ClaudeDesktop => {
            let executable = find_claude_desktop_executable(home).map(DesktopAppTarget::Application);
            #[cfg(target_os = "windows")]
            {
                executable
                    .or_else(|| find_windows_claude_app_id().map(DesktopAppTarget::WindowsAppId))
            }
            #[cfg(not(target_os = "windows"))]
            {
                executable
            }
        }
        _ => None,
    };
    target.ok_or_else(|| format!("{} desktop application was not detected. Detect it again", client.name()))
}

#[cfg(target_os = "windows")]
pub(super) fn stop_other_desktop(target: &DesktopAppTarget, label: &str) -> Result<(), String> {
    let (executable, install_root) = windows_desktop_stop_target(target)?;
    stop_windows_matching_processes(executable.as_deref(), install_root.as_deref(), &[], label)
}

#[cfg(target_os = "macos")]
pub(super) fn stop_other_desktop(target: &DesktopAppTarget, label: &str) -> Result<(), String> {
    let DesktopAppTarget::Application(path) = target;
    stop_macos_desktop_application(path, label)
}

#[cfg(target_os = "linux")]
pub(super) fn stop_other_desktop(target: &DesktopAppTarget, label: &str) -> Result<(), String> {
    let DesktopAppTarget::Application(path) = target;
    stop_linux_desktop_application(path, label)
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub(super) fn stop_other_desktop(_target: &DesktopAppTarget, label: &str) -> Result<(), String> {
    Err(format!("The current platform does not support restarting {label}"))
}

pub(super) fn launch_codex_desktop(home: &Path, executable_override: Option<&Path>) -> Result<(), String> {
    let target = find_desktop_restart_target(AgentClient::Codex, home, executable_override)?;
    launch_codex_target(&target)
}

fn launch_codex_target(target: &DesktopAppTarget) -> Result<(), String> {
    match target {
        #[cfg(target_os = "windows")]
        DesktopAppTarget::WindowsAppId(app_id) => launch_windows_store_app(app_id, "Codex App"),
        DesktopAppTarget::Application(path) => launch_desktop_agent(path, "Codex App"),
    }
}

#[cfg(target_os = "windows")]
pub(super) fn stop_codex_desktop(target: &DesktopAppTarget) -> Result<(), String> {
    let (executable, install_root) = windows_desktop_stop_target(target)?;
    stop_windows_matching_processes(
        executable.as_deref(),
        install_root.as_deref(),
        &["ChatGPT.exe", "Codex.exe"],
        "Codex App",
    )
}

#[cfg(target_os = "windows")]
pub(super) fn stop_opencode_desktop(application: &Path) -> Result<(), String> {
    stop_windows_matching_processes(
        Some(application),
        None,
        &["OpenCode.exe"],
        "OpenCode Desktop",
    )
}

#[cfg(target_os = "macos")]
pub(super) fn stop_codex_desktop(target: &DesktopAppTarget) -> Result<(), String> {
    let DesktopAppTarget::Application(application) = target;
    stop_macos_desktop_application(application, "Codex App")
}

#[cfg(target_os = "macos")]
pub(super) fn stop_opencode_desktop(application: &Path) -> Result<(), String> {
    stop_macos_desktop_application(application, "OpenCode Desktop")
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn desktop_process_ids_from_ps(output: &str, application: &Path) -> Vec<i32> {
    let bundle = application
        .ancestors()
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"));
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let split = line.find(char::is_whitespace)?;
            let pid = line[..split].parse::<i32>().ok()?;
            if pid <= 1 || pid == std::process::id() as i32 {
                return None;
            }
            let executable = Path::new(line[split..].trim());
            (executable == application || bundle.is_some_and(|root| executable.starts_with(root)))
                .then_some(pid)
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn macos_processes_for_application(application: &Path) -> Result<Vec<i32>, String> {
    let output = Command::new("ps")
        .args(["-axww", "-o", "pid=", "-o", "comm="])
        .output()
        .map_err(|error| format!("Failed to read desktop application processes: {error}"))?;
    if !output.status.success() {
        return Err("Failed to read desktop application processes".to_string());
    }
    Ok(desktop_process_ids_from_ps(
        &String::from_utf8_lossy(&output.stdout),
        application,
    ))
}

#[cfg(target_os = "macos")]
fn stop_macos_desktop_application(application: &Path, label: &str) -> Result<(), String> {
    if macos_processes_for_application(application)?.is_empty() {
        return Ok(());
    }
    let bundle = application
        .ancestors()
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
        .unwrap_or(application);
    let escaped = path_to_string(bundle)
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let mut quit = Command::new("osascript");
    quit.args(["-e", &format!("tell application \"{escaped}\" to quit")]);
    let _ = command_output_with_timeout(&mut quit, Duration::from_secs(5));
    for _ in 0..50 {
        if macos_processes_for_application(application)?.is_empty() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    for pid in macos_processes_for_application(application)? {
        if let Err(error) = crate::process_signal::signal_process(pid as u32, libc::SIGKILL) {
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(format!("Failed to stop {label} process {pid}: {error}"));
            }
        }
    }
    for _ in 0..10 {
        if macos_processes_for_application(application)?.is_empty() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!("{label} did not close completely"))
}

#[cfg(target_os = "linux")]
pub(super) fn stop_opencode_desktop(application: &Path) -> Result<(), String> {
    stop_linux_desktop_application(application, "OpenCode Desktop")
}

#[cfg(target_os = "linux")]
fn stop_linux_desktop_application(application: &Path, label: &str) -> Result<(), String> {
    let application = fs::canonicalize(application).unwrap_or_else(|_| application.to_path_buf());
    let processes = linux_processes_for_application(&application);
    let mut signal_error = None;
    for process_id in processes {
        if let Err(error) = signal_linux_process(process_id, libc::SIGTERM) {
            signal_error.get_or_insert(error);
        }
    }

    for _ in 0..50 {
        if linux_processes_for_application(&application).is_empty() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }

    let remaining = linux_processes_for_application(&application);
    for process_id in &remaining {
        if let Err(error) = signal_linux_process(*process_id, libc::SIGKILL) {
            signal_error.get_or_insert(error);
        }
    }
    for _ in 0..10 {
        if linux_processes_for_application(&application).is_empty() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }

    let remaining = linux_processes_for_application(&application);
    if remaining.is_empty() {
        Ok(())
    } else if let Some(error) = signal_error {
        Err(error)
    } else {
        Err(format!(
            "{label} did not close completely; remaining process IDs: {}",
            remaining
                .iter()
                .map(i32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ))
    }
}

#[cfg(target_os = "linux")]
fn linux_processes_for_application(application: &Path) -> Vec<i32> {
    let current_process = std::process::id() as i32;
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut process_ids = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
        .filter(|process_id| *process_id != current_process)
        .filter(|process_id| linux_process_matches_application(*process_id, application))
        .collect::<Vec<_>>();
    process_ids.sort_unstable();
    process_ids
}

#[cfg(target_os = "linux")]
fn linux_process_matches_application(process_id: i32, application: &Path) -> bool {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let process_directory = PathBuf::from(format!("/proc/{process_id}"));
    if fs::read_link(process_directory.join("exe"))
        .ok()
        .is_some_and(|path| linux_process_path_matches(&path, application))
    {
        return true;
    }

    if let Ok(command_line) = fs::read(process_directory.join("cmdline")) {
        let installation_root = linux_opencode_nix_installation_root(application);
        if command_line
            .split(|byte| *byte == 0)
            .filter(|argument| !argument.is_empty())
            .map(|argument| Path::new(OsStr::from_bytes(argument)))
            .enumerate()
            .any(|(index, argument)| {
                (index == 0 && linux_process_path_matches(argument, application))
                    || installation_root.is_some_and(|root| {
                        fs::canonicalize(argument)
                            .ok()
                            .is_some_and(|argument| argument.starts_with(root))
                    })
            })
        {
            return true;
        }
    }

    fs::read(process_directory.join("environ"))
        .ok()
        .is_some_and(|environment| {
            environment
                .split(|byte| *byte == 0)
                .filter_map(|entry| entry.strip_prefix(b"APPIMAGE="))
                .any(|path| {
                    !path.is_empty()
                        && linux_process_path_matches(
                            Path::new(OsStr::from_bytes(path)),
                            application,
                        )
                })
        })
}

#[cfg(target_os = "linux")]
fn linux_process_path_matches(candidate: &Path, application: &Path) -> bool {
    candidate == application
        || fs::canonicalize(candidate)
            .ok()
            .is_some_and(|candidate| candidate == application)
}

#[cfg(target_os = "linux")]
fn linux_opencode_nix_installation_root(application: &Path) -> Option<&Path> {
    application.ancestors().find(|ancestor| {
        ancestor.parent() == Some(Path::new("/nix/store"))
            && ancestor
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.to_ascii_lowercase().contains("opencode"))
    })
}

#[cfg(target_os = "linux")]
fn signal_linux_process(process_id: i32, signal: i32) -> Result<(), String> {
    let error = match crate::process_signal::signal_process(process_id as u32, signal) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!("Failed to stop desktop application process {process_id}: {error}"))
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub(super) fn stop_codex_desktop(_target: &DesktopAppTarget) -> Result<(), String> {
    Err("The current platform does not support restarting Codex App".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub(super) fn stop_opencode_desktop(_application: &Path) -> Result<(), String> {
    Err("The current platform does not support restarting OpenCode Desktop".to_string())
}

pub(super) fn launch_claude_desktop(home: &Path, executable_override: Option<&Path>) -> Result<(), String> {
    let executable = manual_desktop_path(executable_override).map(Path::to_path_buf)
        .or_else(|| find_claude_desktop_executable(home));
    if let Some(executable) = executable {
        return launch_desktop_agent(&executable, "Claude Desktop");
    }
    #[cfg(target_os = "windows")]
    {
        launch_windows_claude_store_app()
    }
    #[cfg(not(target_os = "windows"))]
    Err("Claude Desktop application was not detected. Install or detect it again".to_string())
}

pub(super) fn launch_opencode_desktop(home: &Path, executable_override: Option<&Path>) -> Result<(), String> {
    let application = manual_desktop_path(executable_override).map(Path::to_path_buf)
        .or_else(|| find_opencode_desktop_application(home))
        .ok_or_else(|| "OpenCode Desktop application was not detected. Install or detect it again".to_string())?;
    launch_desktop_agent(&application, "OpenCode Desktop")
}

pub(super) fn launch_vscode_directory(executable: &Path, directory: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        // Prefer the editor binary to its batch launcher so folder names are not
        // interpreted by cmd.exe.
        let editor = executable.parent().and_then(Path::parent)
            .map(|root| root.join("Code.exe"))
            .filter(|path| path.is_file());
        match editor {
            Some(editor) => Command::new(editor),
            None => windows_command_for_executable(executable, false),
        }
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        if let Some(application) = executable.ancestors()
            .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
        {
            let mut command = Command::new("open");
            command.arg("-a").arg(application);
            command
        } else {
            Command::new(executable)
        }
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut command = Command::new(executable);

    command.arg(directory).current_dir(directory)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    configure_background_command(&mut command);
    command.spawn().map(|_| ())
        .map_err(|error| format!("Failed to start VSCode Copilot: {error}"))
}

pub(super) fn launch_desktop_agent(executable: &Path, label: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let application = executable
            .ancestors()
            .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
            .unwrap_or(executable);
        let mut command = Command::new("open");
        command.arg(application);
        command
    };

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let mut command = Command::new(executable);

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (executable, label);
        return Err("The current platform does not support desktop agents".to_string());
    }

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_command(&mut command);
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Failed to start {label}: {error}"))
    }
}

#[cfg(target_os = "windows")]
pub(super) fn launch_windows_store_app(app_id: &str, label: &str) -> Result<(), String> {
    let mut command = Command::new(windows_explorer_executable());
    command
        .arg(format!("shell:AppsFolder\\{app_id}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_background_command(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to start {label}: {error}"))
}

#[cfg(target_os = "windows")]
fn launch_windows_claude_store_app() -> Result<(), String> {
    let app_id = find_windows_claude_app_id()
        .ok_or_else(|| "No launchable Claude Desktop application found".to_string())?;
    launch_windows_store_app(&app_id, "Claude Desktop")
}
