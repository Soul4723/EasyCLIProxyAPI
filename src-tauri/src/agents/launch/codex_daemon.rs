use super::*;

#[tauri::command]
pub(crate) async fn get_codex_cli_daemon_running(
    app: tauri::AppHandle,
    executable_path: Option<String>,
) -> Result<bool, String> {
    let expected = app.state::<GuiConfigState>().snapshot()?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to get user directory: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<GuiConfigState>();
        let _target_operation = state.blocking_client_target_operation(&expected)?;
        codex_cli_daemon_running(&home, executable_path.as_deref().map(Path::new))
    })
    .await
    .map_err(|error| format!("Codex CLI background service check task failed: {error}"))?
}

static CODEX_CLI_DAEMON_RESTARTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(super) struct CodexCliDaemonRestartGuard;

impl Drop for CodexCliDaemonRestartGuard {
    fn drop(&mut self) {
        CODEX_CLI_DAEMON_RESTARTING.store(false, std::sync::atomic::Ordering::Release);
    }
}

// A second `daemon restart` issued while Codex is still draining the first would restart the
// replacement daemon as well, so only one restart may run at a time across all windows.
pub(super) fn begin_codex_cli_daemon_restart() -> Option<CodexCliDaemonRestartGuard> {
    CODEX_CLI_DAEMON_RESTARTING
        .compare_exchange(false, true, std::sync::atomic::Ordering::Acquire, std::sync::atomic::Ordering::Relaxed)
        .ok()
        .map(|_| CodexCliDaemonRestartGuard)
}

#[tauri::command]
pub(crate) async fn restart_codex_cli_daemon(
    app: tauri::AppHandle,
    executable_path: Option<String>,
) -> Result<(), String> {
    let expected = app.state::<GuiConfigState>().snapshot()?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to get user directory: {error}"))?;
    let guard = begin_codex_cli_daemon_restart()
        .ok_or_else(|| "A Codex CLI background service restart is already in progress".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<GuiConfigState>();
        let _target_operation = state.blocking_client_target_operation(&expected)?;
        let _guard = guard;
        validate_selected_agent_restart(&expected, AgentClient::Codex, &home)?;
        restart_codex_cli_daemon_process(&home, executable_path.as_deref().map(Path::new))
    })
    .await
    .map_err(|error| format!("Codex CLI background service restart task failed: {error}"))?
}

fn codex_cli_daemon_running(home: &Path, executable_override: Option<&Path>) -> Result<bool, String> {
    let mut command = codex_cli_daemon_command(home, executable_override, "version")?;
    let output = match command_output_with_timeout(&mut command, Duration::from_secs(10))
        .map_err(|error| format!("Failed to check the Codex CLI background service: {error}"))?
    {
        CommandOutputOutcome::Completed(output) => output,
        CommandOutputOutcome::TimedOut(timeout) => {
            return Err(timeout.message("Checking the Codex CLI background service"));
        }
    };
    parse_codex_cli_daemon_status(output.status.success(), &output.stdout, &output.stderr)
}

pub(super) fn parse_codex_cli_daemon_status(
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<bool, String> {
    if !success {
        let detail = String::from_utf8_lossy(stderr).trim().to_string();
        // A stopped daemon leaves no listener on the control socket: ENOENT, or connection
        // refused on macOS (61), Linux (111) and Windows (10061).
        if detail.contains("failed to connect to ")
            && detail.contains("app-server-control.sock")
            && [2, 61, 111, 10061]
                .iter()
                .any(|code| detail.contains(&format!("(os error {code})")))
        {
            return Ok(false);
        }
        let detail = if detail.is_empty() {
            String::from_utf8_lossy(stdout).trim().to_string()
        } else {
            detail
        };
        return Err(format!(
            "Failed to check the Codex CLI background service{}",
            if detail.is_empty() { String::new() } else { format!(": {detail}") }
        ));
    }
    let value: serde_json::Value = serde_json::from_slice(stdout).map_err(|error| {
        format!("Invalid Codex CLI background service status response: {error}")
    })?;
    match value.get("status").and_then(serde_json::Value::as_str) {
        Some("running") => Ok(true),
        _ => Err("Unexpected Codex CLI background service status response".to_string()),
    }
}

fn restart_codex_cli_daemon_process(home: &Path, executable_override: Option<&Path>) -> Result<(), String> {
    let mut command = codex_cli_daemon_command(home, executable_override, "restart")?;
    // Codex drains running turns before it force-stops the old daemon, which alone can take about a
    // minute, so a shorter limit reports a timeout while the restart is still in progress.
    let output = match command_output_with_timeout(&mut command, Duration::from_secs(150))
        .map_err(|error| format!("Failed to restart the Codex CLI background service: {error}"))?
    {
        CommandOutputOutcome::Completed(output) => output,
        CommandOutputOutcome::TimedOut(timeout) => {
            return Err(timeout.message("Restarting the Codex CLI background service"));
        }
    };
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(format!(
        "Failed to restart the Codex CLI background service{}",
        if detail.is_empty() { String::new() } else { format!(": {detail}") }
    ))
}

pub(super) fn codex_cli_daemon_command(
    home: &Path,
    executable_override: Option<&Path>,
    action: &str,
) -> Result<Command, String> {
    let executable = executable_override.filter(|path| path.is_file()).map(Path::to_path_buf)
        .or_else(|| find_agent_executable(AgentClient::Codex, home))
        .ok_or_else(|| "Executable for Codex not found".to_string())?;
    let mut command = command_for_executable(&executable, &["app-server", "daemon", action])?;
    configure_background_command(&mut command);
    configure_agent_command_environment(&mut command, home, &executable)?;
    Ok(command)
}
