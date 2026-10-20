use super::*;

pub(super) fn deepseek_harness_launch_mode(
    options: Option<&DeepSeekHarnessLaunchOptions>,
) -> Result<String, String> {
    let mode = options
        .map(|options| options.mode.trim().to_ascii_lowercase())
        .filter(|mode| !mode.is_empty())
        .unwrap_or_else(|| "web".to_string());
    if matches!(
        mode.as_str(),
        "web" | "headless" | "acp" | "sdk" | "sdk-minimal" | "custom"
    ) {
        Ok(mode)
    } else {
        Err(format!("Unsupported DeepSeek Harness launch mode: {mode}"))
    }
}

pub(super) fn agent_cli_launch_arguments(
    client: AgentClient,
    deepseek_harness_options: Option<&DeepSeekHarnessLaunchOptions>,
) -> Result<Vec<String>, String> {
    if client != AgentClient::DeepSeekHarness {
        if deepseek_harness_options.is_some() {
            return Err("DeepSeek Harness launch options cannot be used with other clients".to_string());
        }
        return Ok(Vec::new());
    }

    build_deepseek_harness_launch_arguments(deepseek_harness_options)
}

pub(super) fn build_deepseek_harness_launch_arguments(
    options: Option<&DeepSeekHarnessLaunchOptions>,
) -> Result<Vec<String>, String> {
    let mode = deepseek_harness_launch_mode(options)?;
    let profile = match mode.as_str() {
        "web" | "headless" | "acp" | "sdk" | "sdk-minimal" => mode.as_str(),
        "custom" => validate_deepseek_harness_profile(
            options
                .and_then(|options| options.profile.as_deref())
                .unwrap_or_default(),
        )?,
        _ => return Err(format!("Unsupported DeepSeek Harness launch mode: {mode}")),
    };
    let mut arguments = if profile == "web" {
        vec!["web".to_string()]
    } else {
        vec!["--profile".to_string(), profile.to_string()]
    };

    if let Some(options) = options {
        for patch in &options.patches {
            arguments.push("--patch".to_string());
            arguments.push(validate_deepseek_harness_argument(patch, "Patch path")?);
        }
    }

    match mode.as_str() {
        "web" => {
            if let Some(host) = options
                .and_then(|options| options.web_host.as_deref())
                .map(str::trim)
                .filter(|host| !host.is_empty())
            {
                arguments.push("--host".to_string());
                arguments.push(validate_deepseek_harness_argument(host, "Web host")?);
            }
            if let Some(port) = options.and_then(|options| options.web_port) {
                arguments.push("--port".to_string());
                arguments.push(port.to_string());
            }
            if options.and_then(|options| options.open_browser) == Some(false) {
                arguments.push("--no-open".to_string());
            }
            if let Some(options) = options {
                for authority in &options.trusted_hosts {
                    arguments.push("--trusted-host".to_string());
                    arguments.push(validate_deepseek_harness_argument(
                        authority,
                        "trusted host",
                    )?);
                }
            }
        }
        "headless" => {
            let task = options
                .and_then(|options| options.task.as_deref())
                .unwrap_or_default();
            arguments.push(validate_deepseek_harness_argument(task, "Headless task")?);
        }
        "acp" | "sdk" | "sdk-minimal" | "custom" => {}
        _ => unreachable!(),
    }
    Ok(arguments)
}

impl DeepSeekHarnessProcessState {
    pub(super) fn status(&self) -> Result<DeepSeekHarnessProcessStatus, String> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| "DeepSeek Harness process status lock is poisoned".to_string())?;
        let Some(managed) = process.as_mut() else {
            return Ok(DeepSeekHarnessProcessStatus::default());
        };
        match managed.child.try_wait() {
            Ok(None) => Ok(DeepSeekHarnessProcessStatus {
                running: true,
                pid: Some(managed.child.id()),
                mode: Some(managed.mode.clone()),
            }),
            Ok(Some(_)) => {
                *process = None;
                Ok(DeepSeekHarnessProcessStatus::default())
            }
            Err(error) => Err(format!("Failed to check DeepSeek Harness process status: {error}")),
        }
    }
}

#[tauri::command]
pub(crate) fn get_deepseek_harness_process_status(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    process_state: tauri::State<'_, DeepSeekHarnessProcessState>,
) -> Result<DeepSeekHarnessProcessStatus, String> {
    let _target_operation = gui_config_state.target_operation.try_lock().map_err(|_| "Core target operation is in progress".to_string())?;
    process_state.status()
}

#[tauri::command]
pub(crate) fn stop_deepseek_harness_process(
    app: tauri::AppHandle,
    process_state: tauri::State<'_, DeepSeekHarnessProcessState>,
) -> Result<DeepSeekHarnessProcessStatus, String> {
    let _target_state = app.state::<GuiConfigState>();
    let _target_operation = _target_state.target_operation.try_lock().map_err(|_| "Core target operation is in progress".to_string())?;
    stop_managed_deepseek_harness(process_state.inner())?;
    process_state.status()
}

pub(super) fn launch_managed_deepseek_harness(
    process_state: &DeepSeekHarnessProcessState,
    executable: &Path,
    working_directory: &Path,
    arguments: &[String],
    mode: &str,
    options: Option<&DeepSeekHarnessLaunchOptions>,
) -> Result<(), String> {
    let mut process = process_state
        .process
        .lock()
        .map_err(|_| "DeepSeek Harness process status lock is poisoned".to_string())?;
    if let Some(managed) = process.as_mut() {
        match managed.child.try_wait() {
            Ok(None) => {
                return Err(format!(
                    "DeepSeek Harness is already running (PID {}). Stop the current process first",
                    managed.child.id()
                ));
            }
            Ok(Some(_)) => *process = None,
            Err(error) => return Err(format!("Failed to check DeepSeek Harness process status: {error}")),
        }
    }

    if mode == "web" {
        ensure_deepseek_harness_web_endpoint_available(options)?;
    }

    let child = spawn_managed_deepseek_harness(executable, working_directory, arguments)?;
    *process = Some(ManagedDeepSeekHarnessProcess {
        child,
        mode: mode.to_string(),
        launch: DeepSeekHarnessLaunchSnapshot {
            executable: executable.to_path_buf(),
            working_directory: working_directory.to_path_buf(),
            arguments: arguments.to_vec(),
            options: options.cloned(),
        },
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn restart_deepseek_harness_process(
    app: tauri::AppHandle,
) -> Result<DeepSeekHarnessProcessStatus, String> {
    let expected = app.state::<GuiConfigState>().snapshot()?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<GuiConfigState>();
        let _target_operation = state.blocking_client_target_operation(&expected)?;
        let home = app.path().home_dir().map_err(|_| "Failed to get user directory")?;
        validate_selected_agent_restart(&expected, AgentClient::DeepSeekHarness, &home)?;
        restart_managed_deepseek_harness(app.state::<DeepSeekHarnessProcessState>().inner())
    })
    .await
    .map_err(|error| format!("DeepSeek Harness Web restart task failed: {error}"))?
}

pub(super) fn restart_managed_deepseek_harness(
    process_state: &DeepSeekHarnessProcessState,
) -> Result<DeepSeekHarnessProcessStatus, String> {
    restart_managed_deepseek_harness_with(
        process_state,
        terminate_deepseek_harness_process_tree,
        spawn_managed_deepseek_harness,
    )
}

pub(super) fn restart_managed_deepseek_harness_with(
    process_state: &DeepSeekHarnessProcessState,
    stop: impl FnOnce(&mut Child) -> Result<(), String>,
    spawn: impl FnOnce(&Path, &Path, &[String]) -> Result<Child, String>,
) -> Result<DeepSeekHarnessProcessStatus, String> {
    let mut process = process_state
        .process
        .lock()
        .map_err(|_| "DeepSeek Harness process status lock is poisoned".to_string())?;
    let managed = process
        .as_mut()
        .ok_or_else(|| "No DeepSeek Harness Web service is running".to_string())?;
    if managed
        .child
        .try_wait()
        .map_err(|error| format!("Failed to check DeepSeek Harness process status: {error}"))?
        .is_some()
    {
        *process = None;
        return Err("DeepSeek Harness Web has exited. Start it again".to_string());
    }
    if managed.mode != "web" {
        return Err("Only Web mode supports restart".to_string());
    }
    let launch = managed.launch.clone();
    if !launch.executable.is_file() || !launch.working_directory.is_dir() {
        return Err("DeepSeek Harness launcher or working directory no longer exists".to_string());
    }
    stop(&mut managed.child)?;
    *process = None;
    ensure_deepseek_harness_web_endpoint_available(launch.options.as_ref())?;
    let child = spawn(
        &launch.executable,
        &launch.working_directory,
        &launch.arguments,
    )?;
    let status = DeepSeekHarnessProcessStatus {
        running: true,
        pid: Some(child.id()),
        mode: Some("web".to_string()),
    };
    *process = Some(ManagedDeepSeekHarnessProcess {
        child,
        mode: "web".to_string(),
        launch,
    });
    Ok(status)
}

pub(super) fn ensure_deepseek_harness_web_endpoint_available(
    options: Option<&DeepSeekHarnessLaunchOptions>,
) -> Result<(), String> {
    let port = options
        .and_then(|options| options.web_port)
        .unwrap_or(DEEPSEEK_HARNESS_DEFAULT_WEB_PORT);
    if port == 0 {
        return Ok(());
    }
    let host = options
        .and_then(|options| options.web_host.as_deref())
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or("127.0.0.1");
    let listener = TcpListener::bind((host, port)).map_err(|error| {
        if error.kind() == io::ErrorKind::AddrInUse {
            format!(
                "DeepSeek Harness Web address {host}:{port} is in use. Stop the existing service or choose another port"
            )
        } else {
            format!("Cannot use DeepSeek Harness Web address {host}:{port}: {error}")
        }
    })?;
    drop(listener);
    Ok(())
}

pub(super) fn spawn_managed_deepseek_harness(
    executable: &Path,
    working_directory: &Path,
    arguments: &[String],
) -> Result<Child, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        let mut command = command_for_executable(executable, arguments)?;
        command
            .current_dir(working_directory)
            .creation_flags(
                (if cfg!(test) {
                    0x0800_0000
                } else {
                    CREATE_NEW_CONSOLE
                }) | CREATE_NEW_PROCESS_GROUP,
            );
        return command
            .spawn()
            .map_err(|error| format!("Failed to start DeepSeek Harness: {error}"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        let mut command = Command::new(executable);
        command
            .args(arguments)
            .current_dir(working_directory)
            .process_group(0);
        command
            .spawn()
            .map_err(|error| format!("Failed to start DeepSeek Harness: {error}"))
    }

    #[cfg(not(any(windows, unix)))]
    {
        let _ = (executable, working_directory, arguments);
        Err("The current platform does not support managed DeepSeek Harness startup".to_string())
    }
}

pub(crate) fn stop_managed_deepseek_harness(
    process_state: &DeepSeekHarnessProcessState,
) -> Result<(), String> {
    let mut process = process_state
        .process
        .lock()
        .map_err(|_| "DeepSeek Harness process status lock is poisoned".to_string())?;
    let Some(managed) = process.as_mut() else {
        return Ok(());
    };
    if managed
        .child
        .try_wait()
        .map_err(|error| format!("Failed to check DeepSeek Harness process status: {error}"))?
        .is_some()
    {
        *process = None;
        return Ok(());
    }
    terminate_deepseek_harness_process_tree(&mut managed.child)?;
    *process = None;
    Ok(())
}

pub(super) fn terminate_deepseek_harness_process_tree(child: &mut Child) -> Result<(), String> {
    #[cfg(windows)]
    {
        let process_id = child.id().to_string();
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &process_id, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_command(&mut command);
        let status = command
            .status()
            .map_err(|error| format!("Failed to stop DeepSeek Harness process tree: {error}"))?;
        if !status.success() {
            return Err(format!(
                "Failed to stop DeepSeek Harness process tree: PID {process_id}"
            ));
        }
        let _ = child.wait();
        return Ok(());
    }

    #[cfg(unix)]
    {
        crate::process_signal::signal_group(child.id(), libc::SIGTERM)
            .map_err(|error| format!("Failed to stop DeepSeek Harness process group: {error}"))?;
        for _ in 0..20 {
            match child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(error) => {
                    return Err(format!("Failed to check DeepSeek Harness process status: {error}"));
                }
            }
        }
        crate::process_signal::signal_group(child.id(), libc::SIGKILL)
            .map_err(|error| format!("Failed to force-stop DeepSeek Harness process group: {error}"))?;
        child
            .wait()
            .map_err(|error| format!("Failed while waiting for DeepSeek Harness process to exit: {error}"))?;
        Ok(())
    }

    #[cfg(not(any(windows, unix)))]
    {
        child
            .kill()
            .map_err(|error| format!("Failed to stop DeepSeek Harness process: {error}"))?;
        child
            .wait()
            .map_err(|error| format!("Failed while waiting for DeepSeek Harness process to exit: {error}"))?;
        Ok(())
    }
}

fn validate_deepseek_harness_profile(profile: &str) -> Result<&str, String> {
    let profile = profile.trim();
    if profile.is_empty() {
        return Err("Enter a DeepSeek Harness profile name".to_string());
    }
    if matches!(profile, "." | "..")
        || !profile.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(
            "DeepSeek Harness profile name may contain only letters, numbers, periods, hyphens, and underscores".to_string(),
        );
    }
    Ok(profile)
}

fn validate_deepseek_harness_argument(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{label} cannot contain control characters"));
    }
    Ok(value.to_string())
}
