use super::*;

pub(crate) fn inspect_agent_config_with_executables(
    client: AgentClient,
    home: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
    executable_override: Option<&Path>,
    desktop_override: Option<&Path>,
) -> AgentConfigStatus {
    let paths = agent_config_paths(client, home);
    let config_exists = paths.iter().any(|path| path.is_file());
    let result = config_paths(client.id(), home)
        .and_then(|mut paths| {
            if client == AgentClient::Codex && codex_native_oauth_enabled(home)? {
                paths.retain(|path| {
                    path.file_name().and_then(|name| name.to_str())
                        != Some(CODEX_MODEL_CATALOG_FILE)
                });
            }
            config_images(&paths)
        })
        .and_then(|images| validate_config_images(&images))
        .and_then(|_| inspect_agent_managed_config(client, &paths, port, api_key))
        .and_then(|(configured, model, oauth_configuration)| {
            if client == AgentClient::Codex && configured {
                let model = model
                    .as_deref()
                    .ok_or_else(|| "Codex configuration is missing a default model".to_string())?;
                validate_codex_catalog_file(&paths[0], model)?;
            }
            Ok((configured, model, oauth_configuration))
        });
    let (configured, current_model, oauth_configuration, config_valid, error) = match result {
        Ok((configured, model, oauth_configuration)) => {
            (configured, model, oauth_configuration, true, None)
        }
        Err(_) => (
            false,
            None,
            false,
            false,
            Some(
                "Failed to read or parse configuration. Check file permissions, restore from a manual backup, or repair it with the base configuration template"
                    .to_string(),
            ),
        ),
    };
    let copilot_cli = (client == AgentClient::CopilotCli)
        .then(|| detect_copilot_cli(home, executable_override)).flatten();
    let executable = if client == AgentClient::CopilotCli {
        copilot_cli.as_ref().map(|(path, _)| path.clone())
    } else { executable_override.filter(|path| path.is_file()
        || (matches!(client, AgentClient::ClaudeDesktop | AgentClient::ZCode | AgentClient::WorkBuddy)
            && manual_desktop_path(Some(path)).is_some())).map(Path::to_path_buf)
        .or_else(|| find_agent_executable(client, home)) };
    let plugin_version = (client == AgentClient::VscodeCopilot).then(||
        executable.as_deref().and_then(|path| read_vscode_copilot_version(path, home))).flatten();
    let cli_version = if client == AgentClient::CopilotCli {
        copilot_cli.map(|(_, version)| version)
    } else if client == AgentClient::VscodeCopilot {
        None
    } else if should_probe_primary_agent_executable_version(client) {
        executable
            .as_deref()
            .and_then(|path| read_agent_version(path, home))
    } else {
        None
    };
    let codex_app_installation = (client == AgentClient::Codex)
        .then(|| manual_desktop_path(desktop_override)
            .map(|path| DesktopAppTarget::Application(path.to_path_buf()))
            .or_else(|| find_codex_app_installation(home)))
        .flatten();
    let opencode_desktop_application = (client == AgentClient::OpenCode)
        .then(|| manual_desktop_path(desktop_override).map(Path::to_path_buf)
            .or_else(|| find_opencode_desktop_application(home)))
        .flatten();
    let harness_desktop_application = (client == AgentClient::DeepSeekHarness)
        .then(|| manual_desktop_path(desktop_override).map(Path::to_path_buf)
            .or_else(|| find_deepseek_harness_desktop_application(home)))
        .flatten();
    let app_version = match client {
        AgentClient::VscodeCopilot => executable.as_deref().and_then(|path| read_vscode_version(path, home)),
        AgentClient::ClaudeDesktop => read_claude_desktop_version(home),
        AgentClient::Codex => codex_app_installation
            .as_ref()
            .and_then(|installation| read_codex_app_installation_version(installation, home)),
        AgentClient::OpenCode => opencode_desktop_application
            .as_deref()
            .and_then(read_opencode_desktop_version),
        AgentClient::DeepSeekHarness => harness_desktop_application
            .as_deref()
            .and_then(read_deepseek_harness_desktop_version),
        AgentClient::ZCode => executable.as_deref().and_then(read_zcode_app_version),
        AgentClient::WorkBuddy => executable.as_deref().and_then(read_workbuddy_app_version),
        _ => None,
    };
    let version = { cli_version.clone().or_else(|| app_version.clone()).or_else(|| {
        (client == AgentClient::DeepSeekHarness)
            .then(|| read_deepseek_harness_profile_version(home))
            .flatten()
    }) };
    let app_installed = codex_app_installation.is_some()
        || opencode_desktop_application.is_some()
        || harness_desktop_application.is_some();
    let installed = agent_installation_detected(
        client,
        version.as_deref(),
        executable.is_some(),
        app_installed,
    );
    let launch_targets = if installed { agent_launch_targets(
        client,
        executable.as_deref(),
        app_version.as_deref(),
        app_installed,
    ) } else { Vec::new() };
    let mut warnings = Vec::new();
    if !client.supported_platform() {
        warnings.push("The current platform does not support Claude Desktop 3P configuration".to_string());
    } else if !installed && config_exists {
        warnings.push(
            "Only a configuration file was detected. You can still edit the configuration and connect it to CPA, but launch functionality is unavailable".to_string(),
        );
    }
    if let Some(message) = error.as_ref() {
        warnings.push(message.clone());
    }

    let configuration_synchronized = agent_configuration_is_synchronized(client, home, configured);

    AgentConfigStatus {
        id: client.id().to_string(),
        name: client.name().to_string(),
        supported_platform: client.supported_platform(),
        installed,
        plugin_installed: client != AgentClient::VscodeCopilot || plugin_version.is_some(),
        launch_targets,
        version,
        cli_version,
        app_version,
        plugin_version,
        config_paths: paths.iter().map(|path| path_to_string(path)).collect(),
        config_exists,
        config_valid,
        configured,
        configuration_synchronized,
        connection_state: agent_connection_state(
            configured,
            config_valid,
            agent_has_connection_evidence(client, &paths),
        )
        .into(),
        current_model: current_model.clone(),
        oauth_configuration,
        codex_native_oauth: client == AgentClient::Codex
            && codex_native_oauth_enabled(home).unwrap_or(false),
        codex_openai_provider: client == AgentClient::Codex
            && codex_openai_proxy_enabled(home).unwrap_or(false),
        codex_remote_compaction: client == AgentClient::Codex
            && codex_remote_compaction_enabled(home).unwrap_or(false),
        modification_enabled: configured,
        modification_state: if !config_valid {
            "invalid"
        } else if configured {
            "applied"
        } else {
            "unconfigured"
        }
        .into(),
        backup_available: false,
        applied_model: current_model,
        claude_code_model_mappings: (client == AgentClient::ClaudeCode)
            .then(|| inspect_claude_code_model_mappings(&paths[0]).ok().flatten())
            .flatten(),
        claude_desktop_model_mappings: (client == AgentClient::ClaudeDesktop)
            .then(|| current_desktop_mappings(home))
            .flatten(),
        warnings,
        error,
    }
}

pub(crate) fn agent_installation_detected(
    client: AgentClient,
    version: Option<&str>,
    executable_found: bool,
    app_installed: bool,
) -> bool {
    if client == AgentClient::CopilotCli {
        return executable_found && version.is_some();
    }
    executable_found
        || app_installed
        || (client == AgentClient::ClaudeDesktop && version.is_some())
}

pub(crate) fn should_probe_primary_agent_executable_version(client: AgentClient) -> bool {
    // Desktop apps must use metadata only. A PATH entry (including a differently
    // cased path or a wrapper) is not proof of a separate, safe CLI entry point.
    !matches!(client, AgentClient::ClaudeDesktop | AgentClient::ZCode | AgentClient::WorkBuddy)
}

pub(crate) fn agent_launch_targets(
    client: AgentClient,
    executable: Option<&Path>,
    app_version: Option<&str>,
    app_installed: bool,
) -> Vec<AgentLaunchTarget> {
    let mut targets = Vec::new();
    match client {
        AgentClient::ClaudeDesktop => {
            if executable.is_some() || app_version.is_some() {
                targets.push(AgentLaunchTarget {
                    id: "app".to_string(),
                    label: "Claude Desktop".to_string(),
                    detail: executable
                        .map(path_to_string)
                        .unwrap_or_else(|| "Claude Desktop application".to_string()),
                });
            }
        }
        AgentClient::Codex => {
            if app_installed {
                targets.push(AgentLaunchTarget {
                    id: "app".to_string(),
                    label: "Codex App".to_string(),
                    detail: "Codex desktop application".to_string(),
                });
            }
            if let Some(executable) = executable {
                targets.push(AgentLaunchTarget {
                    id: "cli".to_string(),
                    label: "Codex CLI".to_string(),
                    detail: path_to_string(executable),
                });
            }
        }
        AgentClient::OpenCode => {
            if let Some(executable) = executable {
                targets.push(AgentLaunchTarget {
                    id: "cli".to_string(),
                    label: "OpenCode CLI".to_string(),
                    detail: path_to_string(executable),
                });
            }
            if app_installed {
                targets.push(AgentLaunchTarget {
                    id: "app".to_string(),
                    label: "OpenCode Desktop".to_string(),
                    detail: "OpenCode Desktop".to_string(),
                });
            }
        }
        AgentClient::ZCode | AgentClient::WorkBuddy | AgentClient::VscodeCopilot => {
            if let Some(executable) = executable {
                targets.push(AgentLaunchTarget {
                    id: "app".to_string(),
                    label: client.name().to_string(),
                    detail: path_to_string(executable),
                });
            }
        }
        AgentClient::DeepSeekHarness => {
            if let Some(executable) = executable {
                targets.push(AgentLaunchTarget {
                    id: "cli".to_string(),
                    label: "DeepSeek Harness Web".to_string(),
                    detail: format!("{} web", path_to_string(executable)),
                });
            }
            if app_installed {
                targets.push(AgentLaunchTarget {
                    id: "app".to_string(),
                    label: "DeepSeek Harness Desktop".to_string(),
                    detail: "DeepSeek Harness Desktop".to_string(),
                });
            }
        }
        _ => {
            if let Some(executable) = executable {
                targets.push(AgentLaunchTarget {
                    id: "cli".to_string(),
                    label: client.name().to_string(),
                    detail: path_to_string(executable),
                });
            }
        }
    }
    targets
}

pub(crate) fn agent_configuration_is_synchronized(
    _client: AgentClient,
    _home: &Path,
    configured: bool,
) -> bool {
    configured
}

#[cfg(test)]
pub(crate) fn inspect_agent_application(
    client: AgentClient,
    home: &Path,
) -> AgentModificationInspection {
    match load_agent_applied_state(client, home) {
        Ok(Some(state)) => {
            let paths = agent_config_paths(client, home);
            let backup_available = !state.backup_files.is_empty()
                && state
                    .backup_files
                    .iter()
                    .all(|file| !file.existed_before || file.backup_path.is_file());
            if state.backup_files.is_empty() {
                match agent_has_managed_marker(client, &paths) {
                    Ok(false) => {
                        return AgentModificationInspection {
                            enabled: false,
                            state: "unconfigured".to_string(),
                            backup_available: false,
                            warnings: Vec::new(),
                        };
                    }
                    Err(error) => {
                        return AgentModificationInspection {
                            enabled: false,
                            state: "invalid".to_string(),
                            backup_available: false,
                            warnings: vec![error],
                        };
                    }
                    Ok(true) => {}
                }
            }
            let mut warnings = Vec::new();
            if state.backup_files.is_empty() {
                warnings.push("Legacy application state detected; only CPA-managed configuration fields will be removed when disabling".to_string());
            } else if !backup_available {
                warnings.push("The original configuration session backup is incomplete and cannot be safely restored yet".to_string());
            }
            AgentModificationInspection {
                enabled: true,
                state: "applied".to_string(),
                backup_available,
                warnings,
            }
        }
        Ok(None) => AgentModificationInspection {
            enabled: false,
            state: "unconfigured".to_string(),
            backup_available: false,
            warnings: Vec::new(),
        },
        Err(error) => AgentModificationInspection {
            enabled: false,
            state: "invalid".to_string(),
            backup_available: false,
            warnings: vec![error],
        },
    }
}

pub(crate) fn inspect_agent_managed_config(
    client: AgentClient,
    paths: &[PathBuf],
    port: impl AgentClientOrigin,
    api_key: &str,
) -> Result<(bool, Option<String>, bool), String> {
    match client {
        AgentClient::ClaudeCode => inspect_claude_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::ClaudeDesktop if client.supported_platform() => {
            inspect_claude_desktop_agent_config(paths, port, api_key)
                .map(|(configured, model)| (configured, model, false))
        }
        AgentClient::ClaudeDesktop => Ok((false, None, false)),
        AgentClient::Codex => inspect_codex_agent_config(&paths[0], port, api_key),
        AgentClient::OpenCode => inspect_opencode_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::OpenClaw => inspect_openclaw_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::Hermes => inspect_hermes_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::DeepSeekHarness => inspect_deepseek_harness_config(paths, port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::ZCode => {
            if paths.len() != 1 {
                return Err("Invalid number of ZCode configuration paths".to_string());
            }
            inspect_zcode_agent_config(&paths[0], port, api_key)
                .map(|(configured, model)| (configured, model, false))
        }
        AgentClient::CopilotCli | AgentClient::VscodeCopilot => inspect_copilot_config(client, paths, port, api_key).map(|(configured, model)| (configured, model, false)),
        AgentClient::AntigravityCli => inspect_antigravity_config(client, paths, port, api_key).map(|(configured, model)| (configured, model, false)),
        AgentClient::WorkBuddy => inspect_workbuddy_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::KimiCode => inspect_kimi_code_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::GrokBuild => inspect_grok_build_agent_config(&paths[0], port, api_key)
            .map(|(configured, model)| (configured, model, false)),
        AgentClient::Omp => inspect_omp_agent_config(paths, port, api_key)
            .map(|(configured, model)| (configured, model, false)),
    }
}

pub(crate) fn agent_connection_state(
    configured: bool,
    valid: bool,
    managed: Result<bool, String>,
) -> &'static str {
    if !valid || managed.is_err() {
        "invalid"
    } else if configured {
        "configured"
    } else if managed == Ok(true) {
        "needs-update"
    } else {
        "not-configured"
    }
}

pub(crate) fn agent_has_connection_evidence(
    client: AgentClient,
    paths: &[PathBuf],
) -> Result<bool, String> {
    let active_marker = agent_has_managed_marker(client, paths)?;
    if active_marker {
        return Ok(true);
    }
    for path in paths {
        let Some(bytes) = read_agent_bytes(path)? else {
            continue;
        };
        let content = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
        let value: serde_json::Value = match path.extension().and_then(|v| v.to_str()) {
            Some("toml") => serde_json::to_value(
                toml::from_str::<toml::Value>(content).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?,
            Some("yaml" | "yml") => serde_yaml::from_str(content).map_err(|e| e.to_string())?,
            _ => json5::from_str(content).map_err(|e| e.to_string())?,
        };
        let provider_present = client != AgentClient::Codex
            && [
                "/provider/cpa-gui",
                "/model_providers/cpa-gui",
                "/providers/cpa-gui",
                "/models/providers/cpa-gui",
            ]
            .iter()
            .any(|pointer| value.pointer(pointer).is_some());
        let selected = [
            "/model_provider",
            "/model",
            "/model/main",
            "/model/provider",
            "/default_model",
            "/models/default",
            "/agents/defaults/model/primary",
        ]
        .iter()
        .filter_map(|pointer| value.pointer(pointer).and_then(serde_json::Value::as_str))
        .any(|model| {
            model == MANAGED_AGENT_PROVIDER_ID
                || model.starts_with(&format!("{MANAGED_AGENT_PROVIDER_ID}/"))
        });
        let catalog = client == AgentClient::Codex
            && value
                .get("model_catalog_json")
                .and_then(serde_json::Value::as_str)
                == Some(CODEX_MODEL_CATALOG_FILE);
        let hermes_provider = client == AgentClient::Hermes
            && value
                .get("custom_providers")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|items| {
                    items.iter().any(|item| {
                        item.get("name").and_then(serde_json::Value::as_str)
                            == Some(MANAGED_AGENT_PROVIDER_ID)
                    })
                });
        if provider_present || selected || catalog || hermes_provider {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn agent_has_managed_marker(
    client: AgentClient,
    paths: &[PathBuf],
) -> Result<bool, String> {
    match client {
        AgentClient::ClaudeCode => {
            if !paths[0].is_file() {
                return Ok(false);
            }
            let root = read_agent_json_or_empty(&paths[0], "Claude Code configuration")?;
            let env = root.get("env");
            Ok(env
                .and_then(|value| value.get("ANTHROPIC_BASE_URL"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(is_managed_agent_base_url))
        }
        AgentClient::ClaudeDesktop => {
            if paths.len() != 4 {
                return Ok(false);
            }
            let meta = read_agent_json_or_empty(&paths[3], "Claude Desktop configuration index")?;
            let profile = read_agent_json_or_empty(&paths[2], "Claude Desktop gateway configuration")?;
            Ok(meta.get("appliedId").and_then(serde_json::Value::as_str)
                == Some(CLAUDE_DESKTOP_PROFILE_ID)
                || meta
                    .get("entries")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|entries| {
                        entries.iter().any(|entry| {
                            entry.get("id").and_then(serde_json::Value::as_str)
                                == Some(CLAUDE_DESKTOP_PROFILE_ID)
                        })
                    })
                || profile
                    .get("inferenceGatewayBaseUrl")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(is_managed_agent_base_url))
        }
        AgentClient::Codex => {
            if !paths[0].is_file() {
                return Ok(false);
            }
            let root: toml::Value = toml::from_str(
                &fs::read_to_string(&paths[0])
                    .map_err(|error| format!("Failed to read Codex configuration: {error}"))?,
            )
            .map_err(|_| "Failed to parse Codex configuration".to_string())?;
            Ok(root.get("model_provider").and_then(toml::Value::as_str)
                == Some(codex_managed_provider_id(&root)))
        }
        AgentClient::OpenCode => {
            if !paths[0].is_file() {
                return Ok(false);
            }
            let root = read_agent_json5_or_empty(&paths[0], "OpenCode configuration")?;
            let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
            let provider_exists = root
                .get("provider")
                .and_then(|value| value.get(MANAGED_AGENT_PROVIDER_ID))
                .is_some();
            let model_selected = root
                .get("model")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|model| model.starts_with(&prefix));
            Ok(provider_exists && model_selected)
        }
        AgentClient::OpenClaw => {
            if !paths[0].is_file() {
                return Ok(false);
            }
            let root: serde_json::Value = json5::from_str(
                &fs::read_to_string(&paths[0])
                    .map_err(|error| format!("Failed to read OpenClaw configuration: {error}"))?,
            )
            .map_err(|_| "Failed to parse OpenClaw configuration".to_string())?;
            let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
            let provider_exists = root
                .get("models")
                .and_then(|value| value.get("providers"))
                .and_then(|value| value.get(MANAGED_AGENT_PROVIDER_ID))
                .is_some();
            let model_selected = root
                .get("agents")
                .and_then(|value| value.get("defaults"))
                .and_then(|value| value.get("model"))
                .and_then(|value| value.get("primary"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|model| model.starts_with(&prefix));
            Ok(provider_exists && model_selected)
        }
        AgentClient::Hermes => {
            if !paths[0].is_file() {
                return Ok(false);
            }
            let root: serde_yaml::Value = serde_yaml::from_str(
                &fs::read_to_string(&paths[0])
                    .map_err(|error| format!("Failed to read Hermes configuration: {error}"))?,
            )
            .map_err(|_| "Failed to parse Hermes configuration".to_string())?;
            let provider_exists = hermes_managed_provider(&root).is_some();
            let model_selected = root
                .get("model")
                .and_then(|value| value.get("provider"))
                .and_then(serde_yaml::Value::as_str)
                == Some(MANAGED_AGENT_PROVIDER_ID);
            Ok(provider_exists && model_selected)
        }
        AgentClient::DeepSeekHarness => deepseek_harness_has_managed_marker(paths),
        AgentClient::WorkBuddy => workbuddy_has_managed_marker(&paths[0]),
        AgentClient::AntigravityCli => antigravity_has_marker(client, paths),
        AgentClient::CopilotCli | AgentClient::VscodeCopilot => copilot_has_marker(client, paths),
        AgentClient::ZCode => {
            let Some(path) = paths.first() else { return Ok(false); };
            if !path.is_file() { return Ok(false); }
            let root = read_agent_json_or_empty(path, "ZCode provider configuration")?;
            let provider_exists = root.pointer("/config/providerConfigRules/providerRules")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|rules| rules.iter().any(|rule| {
                    rule.get("providerId").and_then(serde_json::Value::as_str)
                        == Some(MANAGED_AGENT_PROVIDER_ID)
                }));
            let model_selected = root.pointer("/config/defaultModelSelection/providerId")
                .and_then(serde_json::Value::as_str)
                == Some(MANAGED_AGENT_PROVIDER_ID);
            Ok(provider_exists && model_selected)
        }
        AgentClient::KimiCode => inspect_managed_toml_model_marker(
            &paths[0],
            "Kimi Code configuration",
            Some("providers"),
            "models",
            None,
            "default_model",
        ),
        AgentClient::GrokBuild => inspect_managed_toml_model_marker(
            &paths[0],
            "Grok Build configuration",
            None,
            "model",
            Some("models"),
            "default",
        ),
        AgentClient::Omp => omp_has_managed_marker(paths),
    }
}

// The endpoint the app writes for this target: a Remote client origin, otherwise a local core address.
pub(crate) fn is_managed_agent_target_url(value: &str, target: impl AgentClientOrigin) -> bool {
    if target.local_client() { return is_managed_agent_base_url(value); }
    let origin = target.client_origin().to_ascii_lowercase();
    value.trim().to_ascii_lowercase().strip_prefix(&origin)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

pub(crate) fn is_managed_agent_base_url(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    if value.starts_with("http://127.0.0.1:")
        || value.starts_with("http://localhost:")
        || value.starts_with("https://127.0.0.1:")
        || value.starts_with("https://localhost:")
    {
        return true;
    }
    #[cfg(not(test))]
    {
        let Ok(settings) = read_installed_core_config_settings() else {
            return false;
        };
        let host = core_connect_host(&settings.host);
        let host = if host.contains(':') {
            format!("[{host}]")
        } else {
            host
        };
        value.starts_with(&format!("http://{host}:"))
            || value.starts_with(&format!("https://{host}:"))
    }
    #[cfg(test)]
    {
        false
    }
}

pub(crate) fn inspect_managed_toml_model_marker(
    path: &Path,
    label: &str,
    provider_section: Option<&str>,
    model_entry_section: &str,
    default_section: Option<&str>,
    default_key: &str,
) -> Result<bool, String> {
    if !path.is_file() {
        return Ok(false);
    }
    let root: toml::Value = toml::from_str(
        &fs::read_to_string(path).map_err(|error| format!("Failed to read {label}: {error}"))?,
    )
    .map_err(|_| format!("Failed to parse {label}"))?;
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let selected = (if let Some(section) = default_section {
        root.get(section)
            .and_then(toml::Value::as_table)
            .and_then(|section| section.get(default_key))
    } else {
        root.get(default_key)
    })
    .and_then(toml::Value::as_str)
    .filter(|model| model.starts_with(&prefix));
    let catalog_has_selected = selected.is_some_and(|model| {
        root.get(model_entry_section)
            .and_then(toml::Value::as_table)
            .is_some_and(|catalog| catalog.contains_key(model))
    });
    let provider_exists = provider_section.is_none_or(|section| {
        root.get(section)
            .and_then(toml::Value::as_table)
            .is_some_and(|providers| providers.contains_key(MANAGED_AGENT_PROVIDER_ID))
    });
    Ok(provider_exists && catalog_has_selected)
}
