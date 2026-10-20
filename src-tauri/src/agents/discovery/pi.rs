use super::*;

pub(crate) fn read_pi_provider_version(home: &Path) -> Result<Option<String>, String> {
    let path = pi_provider_package_json_path(home);
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Failed to read Pi provider package.json {}: {error}",
            path_to_string(&path)
        )
    })?;
    let package = serde_json::from_str::<serde_json::Value>(&content).map_err(|error| {
        format!(
            "Failed to parse Pi provider package.json {}: {error}",
            path_to_string(&path)
        )
    })?;
    Ok(package
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string))
}

pub(crate) fn parse_pi_provider_latest_version(
    payload: &serde_json::Value,
) -> Result<String, String> {
    payload
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Invalid Pi provider version returned by npm registry".to_string())
}

pub(crate) async fn fetch_pi_provider_latest_version(proxy_url: &str) -> Result<String, String> {
    let client = build_http_client_with_proxy(
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(12)),
        proxy_url,
        "Failed to create Pi provider update check client",
    )?;
    let response = client
        .get(PI_CLIPROXYAPI_NPM_LATEST_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, APP_USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("Failed to query latest Pi provider version: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Failed to query latest Pi provider version: HTTP {}",
            status.as_u16()
        ));
    }
    let payload = response
        .json::<serde_json::Value>()
        .await
        .map_err(|_| "Failed to parse latest Pi provider version".to_string())?;
    parse_pi_provider_latest_version(&payload)
}

pub(crate) fn pi_provider_update_available(installed: &str, latest: &str) -> Result<bool, String> {
    let parse = |value: &str| {
        semver::Version::parse(value.trim().trim_start_matches('v'))
            .map_err(|_| format!("Failed to parse Pi provider version {value}"))
    };
    Ok(parse(latest)? > parse(installed)?)
}

pub(crate) fn pi_package_source_matches(value: &str) -> bool {
    let value = value.trim();
    value == PI_CLIPROXYAPI_PACKAGE || value.starts_with(&format!("{PI_CLIPROXYAPI_PACKAGE}@"))
}

pub(crate) fn read_pi_settings(home: &Path) -> Result<Option<serde_json::Value>, String> {
    let path = pi_provider_settings_path(home);
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Failed to read Pi settings.json {}: {error}",
            path_to_string(&path)
        )
    })?;
    serde_json::from_str::<serde_json::Value>(&content)
        .map(Some)
        .map_err(|error| {
            format!(
                "Failed to parse Pi settings.json {}: {error}",
                path_to_string(&path)
            )
        })
}

pub(crate) fn pi_settings_contains_provider(settings: &serde_json::Value) -> bool {
    settings
        .get("packages")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|packages| {
            packages.iter().any(|package| {
                package.as_str().is_some_and(pi_package_source_matches)
                    || package
                        .get("source")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(pi_package_source_matches)
            })
        })
}

pub(crate) fn pi_provider_package_installed(home: &Path) -> Result<bool, String> {
    Ok(read_pi_settings(home)?
        .as_ref()
        .is_some_and(pi_settings_contains_provider))
}

pub(crate) fn build_pi_provider_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
) -> Result<String, String> {
    let mut root = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_json::from_str::<serde_json::Value>(value)
            .map_err(|_| "Failed to parse Pi CLIProxyAPI configuration".to_string())?,
        None => serde_json::json!({}),
    };
    let object = root
        .as_object_mut()
        .ok_or_else(|| "Pi CLIProxyAPI configuration root must be a JSON object".to_string())?;
    object.insert("baseUrl".to_string(), serde_json::json!(base_url));
    object.insert("apiKey".to_string(), serde_json::json!(api_key));
    let mut rendered = serde_json::to_string_pretty(&root)
        .map_err(|error| format!("Failed to generate Pi CLIProxyAPI configuration: {error}"))?;
    rendered.push('\n');
    Ok(rendered)
}

pub(crate) fn build_pi_provider_settings(
    existing: &str,
    default_model: &str,
) -> Result<String, String> {
    let default_model = default_model.trim();
    if default_model.is_empty() {
        return Err("Pi default model cannot be empty".to_string());
    }
    let mut root = serde_json::from_str::<serde_json::Value>(existing)
        .map_err(|_| "Failed to parse Pi settings.json".to_string())?;
    let object = root
        .as_object_mut()
        .ok_or_else(|| "Pi settings.json root must be a JSON object".to_string())?;
    let packages = object
        .entry("packages")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| "Pi settings.json packages must be an array".to_string())?;
    if !packages.iter().any(|package| {
        package.as_str().is_some_and(pi_package_source_matches)
            || package
                .get("source")
                .and_then(serde_json::Value::as_str)
                .is_some_and(pi_package_source_matches)
    }) {
        packages.push(serde_json::json!(PI_CLIPROXYAPI_PACKAGE));
    }
    object.insert(
        "defaultProvider".to_string(),
        serde_json::json!(PI_CLIPROXYAPI_PROVIDER_ID),
    );
    object.insert("defaultModel".to_string(), serde_json::json!(default_model));
    let mut rendered = serde_json::to_string_pretty(&root)
        .map_err(|error| format!("Failed to generate Pi settings.json: {error}"))?;
    rendered.push('\n');
    Ok(rendered)
}

pub(crate) fn inspect_pi_provider_status_with_executable(
    home: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
    executable_override: Option<&Path>,
) -> AgentConfigStatus {
    let config_path = pi_provider_config_path(home);
    let settings_path = pi_provider_settings_path(home);
    let executable = executable_override.filter(|path| path.is_file()).map(Path::to_path_buf)
        .or_else(|| find_pi_executable(home));
    let mut errors = Vec::new();
    let (plugin_installed, default_provider_matches, current_model) = match read_pi_settings(home) {
        Ok(Some(settings)) => {
            let plugin_installed = pi_settings_contains_provider(&settings);
            let default_provider_matches = settings
                .get("defaultProvider")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| value.trim() == PI_CLIPROXYAPI_PROVIDER_ID);
            let current_model = settings
                .get("defaultModel")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            (plugin_installed, default_provider_matches, current_model)
        }
        Ok(None) => (false, false, None),
        Err(error) => {
            errors.push(error);
            (false, false, None)
        }
    };
    let mut credentials_match = false;
    if config_path.is_file() {
        match fs::read_to_string(&config_path)
            .map_err(|error| format!("Failed to read Pi CLIProxyAPI configuration: {error}"))
            .and_then(|content| {
                let root = serde_json::from_str::<serde_json::Value>(&content)
                    .map_err(|_| "Failed to parse Pi CLIProxyAPI configuration".to_string())?;
                let object = root
                    .as_object()
                    .ok_or_else(|| "Pi CLIProxyAPI configuration root must be a JSON object".to_string())?;
                let expected_base_url = port.client_origin();
                credentials_match = object
                    .get("baseUrl")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| value.trim() == expected_base_url)
                    && object.get("apiKey").and_then(serde_json::Value::as_str) == Some(api_key);
                Ok(())
            }) {
            Ok(()) => {}
            Err(error) => errors.push(error),
        }
    }
    let config_exists = config_path.is_file() || settings_path.is_file();
    let config_valid = errors.is_empty();
    let configured = plugin_installed
        && credentials_match
        && default_provider_matches
        && current_model.is_some()
        && config_valid;
    let mut warnings = Vec::new();
    if executable.is_some() && !plugin_installed && config_valid {
        warnings.push("Pi CLIProxyAPI provider plugin is not installed".to_string());
    } else if plugin_installed
        && (!credentials_match || !default_provider_matches || current_model.is_none())
        && config_valid
        && config_exists
    {
        warnings.push(
            "Pi plugin configuration is incomplete. Use “Apply Configuration” to rewrite the credentials, default provider, and default model".to_string(),
        );
    }
    if executable.is_none() && config_exists {
        warnings.push(
            "Only a Pi configuration file was detected. You can still edit the configuration and connect it to CPA, but launch functionality is unavailable".to_string(),
        );
    }
    let modification_state = if configured {
        "applied"
    } else {
        "unconfigured"
    };
    let error = errors.into_iter().next();
    let cli_version = executable
        .as_deref()
        .and_then(|path| read_agent_version(path, home));
    let plugin_version = read_pi_provider_version(home).ok().flatten();
    AgentConfigStatus {
        id: PI_AGENT_ID.to_string(),
        name: PI_AGENT_NAME.to_string(),
        supported_platform: true,
        installed: executable.is_some(),
        plugin_installed,
        launch_targets: executable
            .as_ref()
            .map(|path| {
                vec![AgentLaunchTarget {
                    id: "cli".to_string(),
                    label: PI_AGENT_NAME.to_string(),
                    detail: path_to_string(path),
                }]
            })
            .unwrap_or_default(),
        version: cli_version.clone(),
        cli_version,
        app_version: None,
        plugin_version,
        config_paths: vec![path_to_string(&config_path), path_to_string(&settings_path)],
        config_exists,
        config_valid,
        configured,
        configuration_synchronized: configured,
        connection_state: agent_connection_state(
            configured,
            config_valid,
            Ok(config_path.is_file() || default_provider_matches),
        )
        .into(),
        current_model: current_model.clone(),
        oauth_configuration: false,
        codex_native_oauth: false,
        codex_openai_provider: false,
        codex_remote_compaction: false,
        modification_enabled: configured,
        modification_state: modification_state.to_string(),
        backup_available: false,
        applied_model: current_model,
        claude_code_model_mappings: None,
        claude_desktop_model_mappings: None,
        warnings,
        error,
    }
}

pub(crate) fn install_pi_provider_inner(
    home: &Path,
    executable: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
    default_model: &str,
    proxy_url: &str,
) -> Result<AgentConfigActionResult, String> {
    if port.validate_client_origin().is_err() {
        return Err("Invalid kernel port".to_string());
    }
    if port.local_client() && api_key.trim().is_empty() {
        return Err("EasyCLIProxyAPI has no available API key".to_string());
    }
    let settings_path = pi_provider_settings_path(home);
    let mut changed_files = Vec::new();
    if !pi_provider_package_installed(home)? {
        config_package_operation(home, "plugin-install", || {
            install_pi_package(executable, home, proxy_url)
        })?;
        changed_files.push(path_to_string(&settings_path));
    }

    let mut result = repair_pi_provider_inner(home, port, api_key, default_model)?;
    changed_files.extend(result.changed_files);
    result.changed_files = changed_files;
    Ok(result)
}

pub(crate) fn configure_pi_provider_without_cli_inner(
    home: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
    default_model: &str,
) -> Result<AgentConfigActionResult, String> {
    if port.validate_client_origin().is_err() {
        return Err("Invalid kernel port".to_string());
    }
    if port.local_client() && api_key.trim().is_empty() {
        return Err("EasyCLIProxyAPI has no available API key".to_string());
    }
    let settings_path = pi_provider_settings_path(home);
    config_package_operation(home, "plugin-config", || {
        let settings = if settings_path.is_file() {
            fs::read_to_string(&settings_path).map_err(|error| {
                format!(
                    "Failed to read Pi settings.json {}: {error}",
                    path_to_string(&settings_path)
                )
            })?
        } else {
            "{}".to_string()
        };
        let rendered = build_pi_provider_settings(&settings, default_model)?;
        write_bytes_directly(&settings_path, rendered.as_bytes())
    })?;
    repair_pi_provider_inner(home, port, api_key, default_model)
}

pub(crate) fn repair_pi_provider_inner(
    home: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
    default_model: &str,
) -> Result<AgentConfigActionResult, String> {
    if port.validate_client_origin().is_err() {
        return Err("Core port is invalid".to_string());
    }
    if port.local_client() && api_key.trim().is_empty() {
        return Err("EasyCLIProxyAPI has no usable API key".to_string());
    }
    let config_path = pi_provider_config_path(home);
    let settings_path = pi_provider_settings_path(home);
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "Configuration file lock is poisoned")?;
    let before = config_images(&config_paths(PI_AGENT_ID, home)?)?;
    validate_config_images(&before)?;
    if !pi_provider_package_installed(home)? {
        return Err("Pi CLIProxyAPI provider is not installed".to_string());
    }
    let existing = if config_path.is_file() {
        Some(fs::read_to_string(&config_path).map_err(|error| {
            format!(
                "Failed to read Pi CLIProxyAPI configuration {}: {error}",
                path_to_string(&config_path)
            )
        })?)
    } else {
        None
    };
    let base_url = port.client_origin();
    let rendered = build_pi_provider_config(existing.as_deref(), &base_url, api_key)?;
    let settings = fs::read_to_string(&settings_path).map_err(|error| {
        format!(
            "Failed to read Pi settings.json {}: {error}",
            path_to_string(&settings_path)
        )
    })?;
    let rendered_settings = build_pi_provider_settings(&settings, default_model)?;
    config_updates(
        PI_AGENT_ID,
        home,
        &before,
        &[
            AgentFileUpdate {
                path: config_path,
                after: rendered,
            },
            AgentFileUpdate {
                path: settings_path,
                after: rendered_settings,
            },
        ],
        "update",
        Some(default_model.to_string()),
        None,
    )
}

pub(crate) fn update_pi_provider_inner(
    home: &Path,
    executable: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
    default_model: &str,
    proxy_url: &str,
) -> Result<AgentConfigActionResult, String> {
    if !pi_provider_package_installed(home)? {
        return Err("Pi CLIProxyAPI provider plugin is not installed".to_string());
    }
    config_package_operation(home, "plugin-update", || {
        update_pi_package(executable, home, proxy_url)
    })?;
    let mut result = repair_pi_provider_inner(home, port, api_key, default_model)?;
    result.outcome = "updated".to_string();
    Ok(result)
}

pub(crate) fn uninstall_pi_provider_inner(
    home: &Path,
    executable: &Path,
) -> Result<AgentConfigActionResult, String> {
    if !pi_provider_package_installed(home)? {
        return Ok(action_result(
            "not-installed",
            false,
            None,
            Vec::new(),
            Vec::new(),
        ));
    }
    config_package_operation(home, "plugin-remove", || {
        remove_pi_package(executable, home)
    })?;
    Ok(action_result(
        "removed",
        false,
        None,
        vec![path_to_string(&pi_provider_settings_path(home))],
        Vec::new(),
    ))
}
