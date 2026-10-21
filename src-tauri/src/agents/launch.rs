//! Agent launch orchestration and platform lifecycle helpers.
//!
//! - `terminals`: terminal selection
//! - `deepseek`: managed DeepSeek harness lifecycle
//! - `codex_daemon`: Codex daemon lifecycle
//! - `desktop`: desktop launch, stop and process matching
//! - `cli`: platform CLI launch and quoting

use super::*;
use std::net::TcpListener;

pub(crate) fn validate_selected_agent_launch(config: &GuiConfigFile, configured: bool) -> Result<(), String> {
    config.validate_client_origin()?;
    if config.connection_mode == CoreConnectionMode::Remote && !configured {
        Err("Configure this client for the selected remote client target before launching or restarting it".into())
    } else { Ok(()) }
}

fn validate_selected_agent_restart(config: &GuiConfigFile, client: AgentClient, home: &Path) -> Result<(), String> {
    if config.connection_mode == CoreConnectionMode::Local { return Ok(()); }
    let configured = inspect_agent_managed_config(client, &agent_config_paths(client, home), config,
        effective_agent_api_key(config)).map_err(|_| "Unable to inspect client configuration before restart".to_string())?.0;
    validate_selected_agent_launch(config, configured)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Preserve the existing command/helper interface in this behavior-neutral cleanup.
pub(crate) fn launch_agent(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    deepseek_process_state: tauri::State<'_, DeepSeekHarnessProcessState>,
    client: String,
    target: Option<String>,
    executable_path: Option<String>,
    desktop_executable_path: Option<String>,
    working_directory: Option<String>,
    deepseek_harness_options: Option<DeepSeekHarnessLaunchOptions>,
) -> Result<(), String> {
    let _target_operation = gui_config_state.target_operation.try_lock().map_err(|_| "Core target operation is in progress".to_string())?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to get user directory: {error}"))?;
    let config = gui_config_state.snapshot()?;
    let terminal = normalize_agent_terminal(&config.default_terminal);
    let requested_target = target
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if deepseek_harness_options.is_some() && !client.trim().eq_ignore_ascii_case("deepseek-harness")
    {
        return Err("DeepSeek Harness launch options cannot be used with other clients".to_string());
    }

    if client.trim().eq_ignore_ascii_case(PI_AGENT_ID) {
        if requested_target.is_some_and(|value| value != "cli") {
            return Err("Pi supports only CLI launch mode".to_string());
        }
        let executable_override = executable_path.as_deref().map(Path::new);
        let status = inspect_pi_provider_status_with_executable(&home, &config, effective_agent_api_key(&config), executable_override);
        validate_selected_agent_launch(&config, status.configured)?;
        if !status.installed {
            return Err("Pi CLI was not detected. Install Pi and detect it again".to_string());
        }
        let executable = executable_override.filter(|path| path.is_file()).map(Path::to_path_buf)
            .or_else(|| find_pi_executable(&home))
            .ok_or_else(|| "Pi CLI executable not found".to_string())?;
        let launch_directory = resolve_launch_directory(working_directory.as_deref(), &home)?;
        return launch_cli_agent(
            &executable,
            PI_AGENT_NAME,
            &launch_directory,
            &[],
            &[],
            &[],
            &terminal,
        );
    }

    let client = AgentClient::parse(&client)?;
    if !client.supported_platform() {
        return Err(format!("The current platform does not support launching {}", client.name()));
    }
    let executable_override = executable_path.as_deref().map(Path::new);
    let desktop_override = desktop_executable_path.as_deref().map(Path::new);
    let status = inspect_agent_config_with_executables(client, &home, &config, effective_agent_api_key(&config), executable_override, desktop_override);
    validate_selected_agent_launch(&config, status.configured)?;
    if !status.installed {
        return Err(format!("{} was not detected. Install it and detect it again", client.name()));
    }
    let default_target = status
        .launch_targets
        .first()
        .map(|target| target.id.as_str())
        .unwrap_or("cli");
    let requested_target = requested_target.unwrap_or(default_target);
    match (client, requested_target) {
        (AgentClient::ClaudeDesktop, "app") => launch_claude_desktop(&home, executable_override),
        (AgentClient::AntigravityCli, "cli")
            if antigravity_has_marker(client, &agent_config_paths(client, &home))? => {
            if !status.configured {
                return Err("Antigravity CLI configuration does not match CPA. Apply the configuration again".into());
            }
            let executable = env::current_exe().map_err(|_| "Unable to locate CPA launch adapter")?;
            let directory = resolve_launch_directory(working_directory.as_deref(), &home)?;
            launch_cli_agent(&executable, client.name(), &directory, &antigravity_cli_helper_arguments(&home), &[], &[], &terminal)
        }
        (AgentClient::CopilotCli, "cli") if copilot_has_marker(client, &agent_config_paths(client, &home))? => {
            if !status.configured { return Err("Copilot CLI configuration does not match CPA. Apply it again".into()); }
            let executable = executable_override.filter(|p| p.is_file()).map(Path::to_path_buf)
                .or_else(|| find_agent_executable(client, &home)).ok_or("Copilot CLI not found")?;
            let adapter = env::current_exe().map_err(|_| "Unable to locate CPA launch adapter")?;
            let directory = resolve_launch_directory(working_directory.as_deref(), &home)?;
            let args = vec!["--cpa-copilot-cli".into(), path_to_string(&agent_config_paths(client, &home)[0]), path_to_string(&executable)];
            launch_cli_agent(&adapter, client.name(), &directory, &args, &[], &[], &terminal)
        }
        (AgentClient::VscodeCopilot, "app") => {
            let executable = executable_override.filter(|p| p.is_file()).map(Path::to_path_buf)
                .or_else(|| find_agent_executable(client, &home)).ok_or("VS Code not found")?;
            let directory = resolve_launch_directory(working_directory.as_deref(), &home)?;
            launch_vscode_directory(&executable, &directory)
        }
        (AgentClient::WorkBuddy, "app") => {
            let executable = manual_desktop_path(executable_override).map(Path::to_path_buf)
                .or_else(|| find_workbuddy_desktop_executable(&home))
                .ok_or_else(|| "WorkBuddy application not found".to_string())?;
            launch_desktop_agent(&executable, client.name())
        }
        (AgentClient::ZCode, "app") => {
            let executable = manual_desktop_path(executable_override).map(Path::to_path_buf)
                .or_else(|| find_zcode_desktop_executable(&home))
                .ok_or_else(|| "ZCode application not found".to_string())?;
            launch_desktop_agent(&executable, client.name())
        }
        (AgentClient::Codex, "app") => {
            launch_codex_desktop(&home, desktop_override)
        }
        (AgentClient::OpenCode, "app") => launch_opencode_desktop(&home, desktop_override),
        (AgentClient::DeepSeekHarness, "app") => {
            let executable = manual_desktop_path(desktop_override).map(Path::to_path_buf)
                .or_else(|| find_deepseek_harness_desktop_application(&home))
                .ok_or_else(|| "DeepSeek Harness Desktop application not found".to_string())?;
            launch_desktop_agent(&executable, "DeepSeek Harness Desktop")
        }
        (AgentClient::ClaudeDesktop | AgentClient::ZCode | AgentClient::WorkBuddy, "cli") => {
            Err(format!("{} does not support CLI launch mode", client.name()))
        }
        (_, "cli") => {
            let executable = executable_override.filter(|path| path.is_file()).map(Path::to_path_buf)
                .or_else(|| find_agent_executable(client, &home))
                .ok_or_else(|| format!("Executable for {} not found", client.name()))?;
            let launch_directory = resolve_launch_directory(working_directory.as_deref(), &home)?;
            if client == AgentClient::DeepSeekHarness {
                let mode = deepseek_harness_launch_mode(deepseek_harness_options.as_ref())?;
                let arguments =
                    agent_cli_launch_arguments(client, deepseek_harness_options.as_ref())?;
                return launch_managed_deepseek_harness(
                    deepseek_process_state.inner(),
                    &executable,
                    &launch_directory,
                    &arguments,
                    &mode,
                    deepseek_harness_options.as_ref(),
                );
            }
            let environment_to_remove = if client == AgentClient::ClaudeCode {
                &["ANTHROPIC_API_KEY"][..]
            } else {
                &[]
            };
            let arguments = agent_cli_launch_arguments(client, deepseek_harness_options.as_ref())?;
            launch_cli_agent(
                &executable,
                client.name(),
                &launch_directory,
                &arguments,
                environment_to_remove,
                &[],
                &terminal,
            )
        }
        (_, "app") => Err(format!("{} does not support desktop App launch mode", client.name())),
        _ => Err("Unsupported agent launch mode".to_string()),
    }
}


#[tauri::command]
pub(crate) async fn restart_agent_app(
    app: tauri::AppHandle,
    client: String,
    executable_path: Option<String>,
) -> Result<(), String> {
    let expected = app.state::<GuiConfigState>().snapshot()?;
    let client = AgentClient::parse(&client)?;
    if !matches!(
        client,
        AgentClient::Codex
            | AgentClient::OpenCode
            | AgentClient::ClaudeDesktop
            | AgentClient::ZCode
            | AgentClient::WorkBuddy
    ) {
        return Err(format!("{} does not support restarting the desktop application", client.name()));
    }
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to get user directory: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<GuiConfigState>();
        let _target_operation = state.blocking_client_target_operation(&expected)?;
        let executable_override = executable_path.as_deref().map(Path::new);
        validate_selected_agent_restart(&expected, client, &home)?;
        let target = find_desktop_restart_target(client, &home, executable_override)?;
        match client {
            AgentClient::Codex => stop_codex_desktop(&target)?,
            AgentClient::OpenCode => {
                match &target {
                    DesktopAppTarget::Application(path) => stop_opencode_desktop(path)?,
                    #[cfg(target_os = "windows")]
                    DesktopAppTarget::WindowsAppId(_) => {
                        return Err("Invalid OpenCode desktop installation type".to_string());
                    }
                }
            }
            _ => stop_other_desktop(&target, client.name())?,
        }
        match &target {
            DesktopAppTarget::Application(path) => launch_desktop_agent(path, client.name()),
            #[cfg(target_os = "windows")]
            DesktopAppTarget::WindowsAppId(app_id) => {
                launch_windows_store_app(app_id, client.name())
            }
        }
    })
    .await
    .map_err(|error| format!("Desktop application restart task failed: {error}"))?
}
fn resolve_launch_directory(value: Option<&str>, fallback: &Path) -> Result<PathBuf, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(fallback.to_path_buf());
    };
    if value.chars().any(char::is_control) {
        return Err("Working directory contains invalid characters".to_string());
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("Working directory must be an absolute path".to_string());
    }
    if !path.is_dir() {
        return Err(format!("Working directory does not exist: {}", path_to_string(&path)));
    }
    Ok(path)
}

mod terminals;
mod deepseek;
mod codex_daemon;
mod desktop;
mod cli;

pub(crate) use terminals::*;
pub(crate) use deepseek::*;
pub(crate) use codex_daemon::*;
use desktop::*;
use cli::*;

#[cfg(test)]
mod tests;
