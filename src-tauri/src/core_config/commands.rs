use super::*;

#[tauri::command]
pub(crate) async fn get_core_tls_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
) -> Result<CoreTlsSettings, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        return crate::agents::target_read_only(&gui_config_state, expected_revision, |config| async move {
            let content = crate::core_connection::read_remote_yaml(&config).await?;
            let document = serde_norway::from_str(&content).map_err(|_| "Invalid remote core configuration".to_string())?;
            core_tls_settings_from_value(&document)
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    current_core_tls_settings()
}

#[tauri::command]
pub(crate) async fn save_core_tls_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    cache: tauri::State<'_, AgentConfigStatusCache>,
    settings: CoreTlsSettings,
) -> Result<CoreTlsSettings, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        let settings = normalize_core_tls_settings(settings)?;
        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let updated = patch_core_tls_settings_yaml(content, &settings)?.unwrap_or_else(|| content.to_string());
            Ok((updated, settings))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let settings = normalize_core_tls_settings(settings)?;
    patch_core_tls_settings(&settings)?;
    cache.clear()?;
    Ok(settings)
}

#[tauri::command]
pub(crate) async fn get_core_sensitive_words_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
) -> Result<CoreSensitiveWordsSettings, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        return crate::agents::target_read_only(&gui_config_state, expected_revision, |config| async move {
            let content = crate::core_connection::read_remote_yaml(&config).await?;
            let document = serde_norway::from_str(&content).map_err(|_| "Invalid remote core configuration".to_string())?;
            core_sensitive_words_settings_from_value(&document)
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    read_core_sensitive_words_settings()
}

#[tauri::command]
pub(crate) async fn save_core_sensitive_words_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    settings: CoreSensitiveWordsSettings,
) -> Result<CoreSensitiveWordsSettings, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        let settings = normalize_core_sensitive_words_settings(settings);
        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let updated = patch_core_sensitive_words_yaml(content, &settings)?.unwrap_or_else(|| content.to_string());
            Ok((updated, settings))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let normalized = normalize_core_sensitive_words_settings(settings);
    patch_core_sensitive_words_settings(&normalized)?;
    Ok(normalized)
}

#[tauri::command]
pub(crate) fn save_gui_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    cache: tauri::State<'_, AgentConfigStatusCache>,
    settings: GuiNetworkSettings,
) -> Result<GuiSettings, String> {
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    if settings.port == 0 {
        return Err("Port must be between 1 and 65535".to_string());
    }

    let _refresh_guard = cache
        .refresh_lock
        .lock()
        .map_err(|_| "Agent configuration status refresh lock is poisoned".to_string())?;
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.port = settings.port;
    next.allow_lan = settings.allow_lan;
    next.host = if settings.allow_lan {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    }
    .to_string();
    patch_core_network_settings(&next)?;
    let config = match gui_config_state.update_network(settings.port, settings.allow_lan) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_network_settings(&previous).err();
            return Err(match rollback_error {
                Some(rollback_error) => {
                    format!("{error}; failed to roll back kernel network configuration: {rollback_error}")
                }
                None => error,
            });
        }
    };

    if config.port != previous.port {
        if let Err(error) = cache.clear() {
            eprintln!("Failed to clear agent configuration status cache: {error}");
        }
    }

    Ok(GuiSettings::from(&config))
}

#[tauri::command]
pub(crate) fn save_network_routing_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    cache: tauri::State<'_, AgentConfigStatusCache>,
    settings: GuiNetworkRoutingSettings,
) -> Result<CoreConfigView, String> {
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    if settings.port == 0 {
        return Err("Port must be between 1 and 65535".to_string());
    }
    let routing_session_affinity_ttl =
        normalize_session_affinity_ttl(settings.routing_session_affinity_ttl)?;

    let _refresh_guard = cache
        .refresh_lock
        .lock()
        .map_err(|_| "Agent configuration status refresh lock is poisoned".to_string())?;
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.port = settings.port;
    next.allow_lan = settings.allow_lan;
    next.host = if settings.allow_lan {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    }
    .to_string();
    next.routing_session_affinity = settings.routing_session_affinity;
    next.routing_session_affinity_ttl = routing_session_affinity_ttl.clone();
    next.disable_cooling = settings.disable_cooling;
    next.request_retry = settings.request_retry;
    next.max_retry_credentials = settings.max_retry_credentials;
    next.max_retry_interval = settings.max_retry_interval;
    next.streaming_bootstrap_retries = settings.streaming_bootstrap_retries;
    validate_gui_config(&next)?;

    patch_core_network_routing_settings(&next)?;
    let config = match gui_config_state.update_network_routing(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_network_routing_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };

    if config.port != previous.port {
        if let Err(error) = cache.clear() {
            eprintln!("Failed to clear agent configuration status cache: {error}");
        }
    }

    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn save_network_endpoint_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    cache: tauri::State<'_, AgentConfigStatusCache>,
    settings: GuiNetworkEndpointSettings,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        if settings.port == 0 { return Err("Port must be between 1 and 65535".to_string()); }
        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let mut next = remote_gui_config(content)?;
            next.host = normalize_optional_config_string(settings.host, "Listen IP")?;
            if !next.host.is_empty() && !next.host.eq_ignore_ascii_case("localhost") && next.host.parse::<IpAddr>().is_err() {
                return Err("Listen address must be empty, localhost, or a valid IPv4 or IPv6 address".to_string());
            }
            next.allow_lan = !is_loopback_host(&next.host);
            next.port = settings.port;
            let proxy = settings.proxy_url.map(|url| network_proxy::normalize_optional_proxy_url(&url)).transpose()?;
            let updated = patch_core_yaml_document(content, |document| {
                let mut changed = set_core_yaml_path_value(document, &["server", "host"], serde_norway::Value::String(next.host.clone()))?;
                changed |= set_core_yaml_path_value(document, &["server", "port"], serde_norway::to_value(next.port).map_err(|_| "Invalid port")?)?;
                if let Some(proxy) = proxy {
                    changed |= set_core_yaml_path_value(document, &["requests", "proxy-url"], serde_norway::Value::String(proxy))?;
                }
                Ok(changed)
            })?.unwrap_or_else(|| content.to_string());
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    if settings.port == 0 {
        return Err("Port must be between 1 and 65535".to_string());
    }
    let host = normalize_optional_config_string(settings.host, "Listen IP")?;
    if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") && host.parse::<IpAddr>().is_err() {
        return Err("Listen address must be empty, localhost, or a valid IPv4 or IPv6 address".to_string());
    }
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.host = host;
    next.allow_lan = !is_loopback_host(&next.host);
    next.port = settings.port;
    if settings.proxy_url.is_some() || settings.proxy_override.is_some() {
        let proxy_url = network_proxy::normalize_optional_proxy_url(
            settings.proxy_url.as_deref().unwrap_or(&next.proxy_url),
        )?;
        // Explicit mode selection lets an empty manual URL mean direct access.
        // Calls from older frontends keep the legacy behavior where an empty URL
        // means following the system proxy.
        next.proxy_override = settings
            .proxy_override
            .unwrap_or(!proxy_url.is_empty());
        next.proxy_url = if next.proxy_override {
            proxy_url
        } else {
            network_proxy::detect()
        };
    }
    validate_gui_config(&next)?;
    patch_core_network_endpoint_settings(&next)?;
    let config = match gui_config_state.update_network_endpoint(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_network_endpoint_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    if config.host != previous.host || config.port != previous.port {
        if let Err(error) = cache.clear() {
            eprintln!("Failed to clear agent configuration status cache: {error}");
        }
    }
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn save_retry_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    settings: GuiRetrySettings,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let mut next = remote_gui_config(content)?;
            next.disable_cooling = settings.disable_cooling;
            next.request_retry = settings.request_retry;
            next.max_retry_credentials = settings.max_retry_credentials;
            next.max_retry_interval = settings.max_retry_interval;
            next.streaming_bootstrap_retries = settings.streaming_bootstrap_retries;
            let updated = patch_core_retry_yaml(content, &next)?.unwrap_or_else(|| content.to_string());
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.disable_cooling = settings.disable_cooling;
    next.request_retry = settings.request_retry;
    next.max_retry_credentials = settings.max_retry_credentials;
    next.max_retry_interval = settings.max_retry_interval;
    next.streaming_bootstrap_retries = settings.streaming_bootstrap_retries;
    patch_core_retry_settings(&next)?;
    let config = match gui_config_state.update_retry_settings(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_retry_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn save_session_routing_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    settings: GuiSessionRoutingSettings,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let mut next = remote_gui_config(content)?;
            next.routing_session_affinity = settings.routing_session_affinity;
            next.routing_session_affinity_ttl = normalize_session_affinity_ttl(settings.routing_session_affinity_ttl)?;
            let updated = patch_core_session_routing_yaml(content, &next)?.unwrap_or_else(|| content.to_string());
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let ttl = normalize_session_affinity_ttl(settings.routing_session_affinity_ttl)?;
    let previous = gui_config_state.snapshot()?;
    let mut next = previous.clone();
    next.routing_session_affinity = settings.routing_session_affinity;
    next.routing_session_affinity_ttl = ttl;
    patch_core_session_routing_settings(&next)?;
    let config = match gui_config_state.update_session_routing(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_session_routing_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn get_core_config_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        return crate::agents::target_read_only(&gui_config_state, expected_revision, |config| async move {
            let content = crate::core_connection::read_remote_yaml(&config).await?;
            remote_config_view(&content)
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let settings = current_core_config_settings(gui_config_state.inner())?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    let api_keys = gui_api_key_values(&config.api_keys);
    if api_keys != settings.api_keys {
        patch_core_api_keys(&api_keys)?;
    }
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn save_core_logging_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    settings: CoreLoggingSettingsInput,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        if !(1..=3600).contains(&settings.redis_usage_queue_retention_seconds) {
            return Err("Redis usage queue retention must be between 1 and 3600 seconds".to_string());
        }
        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let mut next = CoreConfigSettings::from(&remote_gui_config(content)?);
            next.debug = settings.debug;
            next.commercial_mode = settings.commercial_mode;
            next.logging_to_file = settings.logging_to_file;
            next.logs_max_total_size_mb = settings.logs_max_total_size_mb;
            next.error_logs_max_files = settings.error_logs_max_files;
            next.usage_statistics_enabled = settings.usage_statistics_enabled;
            next.redis_usage_queue_retention_seconds = settings.redis_usage_queue_retention_seconds;
            let updated = patch_core_yaml_document(content, |doc| apply_core_logging_settings(doc, &next))?.unwrap_or_else(|| content.to_string());
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    if !(1..=3600).contains(&settings.redis_usage_queue_retention_seconds) {
        return Err("Redis usage queue retention must be between 1 and 3600 seconds".to_string());
    }

    let previous = current_core_config_settings(gui_config_state.inner())?;
    let mut next = previous.clone();
    next.debug = settings.debug;
    next.commercial_mode = settings.commercial_mode;
    next.logging_to_file = settings.logging_to_file;
    next.logs_max_total_size_mb = settings.logs_max_total_size_mb;
    next.error_logs_max_files = settings.error_logs_max_files;
    next.usage_statistics_enabled = settings.usage_statistics_enabled;
    next.redis_usage_queue_retention_seconds = settings.redis_usage_queue_retention_seconds;

    patch_core_logging_settings(&next)?;
    let config = match gui_config_state.sync_core_logging_settings(&next) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_logging_settings(&previous).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn add_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    api_key: String,
    remark: String,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let next = remote_gui_config(content)?;
            let mut keys = gui_api_key_values(&next.api_keys);
            let api_key = api_key.trim().to_string(); validate_core_api_key(&api_key)?;
            validate_api_key_remark(&remark)?;
            if keys.contains(&api_key) { return Err("This authentication key already exists".to_string()); }
            keys.push(api_key);
            let updated = patch_core_api_keys_yaml(content, &keys)?;
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let api_key = api_key.trim().to_string();
    let remark = remark.trim().to_string();
    validate_core_api_key(&api_key)?;
    validate_api_key_remark(&remark)?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    if settings
        .api_keys
        .iter()
        .any(|existing| existing == &api_key)
    {
        return Err("This authentication key already exists".to_string());
    }
    settings.api_keys.push(api_key);
    patch_core_api_keys(&settings.api_keys)?;
    let added_api_key = settings.api_keys.last().map(|key| GuiApiKeyEntry {
        key: key.clone(),
        remark,
    });
    let config = gui_config_state.sync_core_settings_with_api_key(&settings, added_api_key)?;
    Ok(CoreConfigView::from(&config))
}

pub(crate) fn replace_core_api_key_value(
    api_keys: &mut [String],
    original_api_key: &str,
    replacement_api_key: String,
) -> Result<(), String> {
    let index = api_keys
        .iter()
        .position(|existing| existing == original_api_key)
        .ok_or_else(|| "The authentication key to edit does not exist. Refresh and try again".to_string())?;
    if replacement_api_key != original_api_key
        && api_keys
            .iter()
            .any(|existing| existing == &replacement_api_key)
    {
        return Err("This authentication key already exists".to_string());
    }
    api_keys[index] = replacement_api_key;
    Ok(())
}

pub(crate) fn remove_core_api_key_value(
    api_keys: &mut Vec<String>,
    api_key: &str,
) -> Result<(), String> {
    let index = api_keys
        .iter()
        .position(|existing| existing == api_key)
        .ok_or_else(|| "The authentication key to delete does not exist. Refresh and try again".to_string())?;
    api_keys.remove(index);
    Ok(())
}

#[tauri::command]
pub(crate) async fn update_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    original_api_key: String,
    api_key: String,
    remark: String,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let next = remote_gui_config(content)?;
            let mut keys = gui_api_key_values(&next.api_keys);
            let api_key = api_key.trim().to_string(); validate_core_api_key(&api_key)?;
            validate_api_key_remark(&remark)?;
            replace_core_api_key_value(&mut keys, original_api_key.trim(), api_key)?;
            let updated = patch_core_api_keys_yaml(content, &keys)?;
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let original_api_key = original_api_key.trim();
    let api_key = api_key.trim().to_string();
    let remark = remark.trim().to_string();
    if original_api_key.is_empty() {
        return Err("The authentication key to edit cannot be empty".to_string());
    }
    validate_core_api_key(&api_key)?;
    validate_api_key_remark(&remark)?;

    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    replace_core_api_key_value(&mut settings.api_keys, original_api_key, api_key.clone())?;
    patch_core_api_keys(&settings.api_keys)?;
    let config = gui_config_state.sync_core_settings_with_api_key(
        &settings,
        Some(GuiApiKeyEntry {
            key: api_key,
            remark,
        }),
    )?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn delete_core_api_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    api_key: String,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let next = remote_gui_config(content)?;
            let mut keys = gui_api_key_values(&next.api_keys);
            remove_core_api_key_value(&mut keys, api_key.trim())?;
            let updated = patch_core_api_keys_yaml(content, &keys)?;
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("The authentication key to delete cannot be empty".to_string());
    }
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    remove_core_api_key_value(&mut settings.api_keys, api_key)?;
    patch_core_api_keys(&settings.api_keys)?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn set_core_management_secret_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    secret_key: String,
) -> Result<CoreConfigView, String> {
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let secret_key = normalize_management_secret_key(secret_key)?;
    let previous = gui_config_state.snapshot()?;
    patch_core_management_secret_key(&secret_key)?;
    let config = match gui_config_state.set_management_secret_key(secret_key) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error =
                patch_core_management_secret_key(&previous.management_secret_key).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) fn clear_core_management_secret_key(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
) -> Result<CoreConfigView, String> {
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let previous = gui_config_state.snapshot()?;
    patch_core_management_secret_key("")?;
    let config = match gui_config_state.set_management_secret_key(String::new()) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error =
                patch_core_management_secret_key(&previous.management_secret_key).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn set_core_plugins_enabled(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    enabled: bool,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {

        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let value = serde_norway::to_value(enabled).map_err(|_| "Invalid configuration value".to_string())?;
            let updated = patch_core_yaml_document(content, |doc| set_core_yaml_path_value(doc, &["plugins", "enabled"], value))?.unwrap_or_else(|| content.to_string());
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    settings.plugins_enabled = enabled;
    patch_core_plugins_enabled(settings.plugins_enabled)?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn set_core_request_log(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    enabled: bool,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {

        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let value = serde_norway::to_value(enabled).map_err(|_| "Invalid configuration value".to_string())?;
            let updated = patch_core_yaml_document(content, |doc| set_core_yaml_path_value(doc, &["observability", "logs", "request-log"], value))?.unwrap_or_else(|| content.to_string());
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    let previous_enabled = settings.request_log;
    settings.request_log = enabled;
    patch_core_request_log(settings.request_log)?;
    let config = match gui_config_state.sync_core_settings(&settings) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_request_log(previous_enabled).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn set_core_routing_strategy(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    strategy: String,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        validate_routing_strategy(&strategy)?;
        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let value = serde_norway::to_value(strategy).map_err(|_| "Invalid configuration value".to_string())?;
            let updated = patch_core_yaml_document(content, |doc| set_core_yaml_path_value(doc, &["routing", "strategy"], value))?.unwrap_or_else(|| content.to_string());
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    validate_routing_strategy(&strategy)?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    settings.routing_strategy = strategy;
    patch_core_routing_strategy(&settings.routing_strategy)?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn set_core_proxy_url(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    proxy_url: String,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        let proxy_url = network_proxy::normalize_optional_proxy_url(&proxy_url)?;
        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let value = serde_norway::to_value(proxy_url).map_err(|_| "Invalid configuration value".to_string())?;
            let updated = patch_core_yaml_document(content, |doc| set_core_yaml_path_value(doc, &["requests", "proxy-url"], value))?.unwrap_or_else(|| content.to_string());
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    network_proxy::set_manual(gui_config_state.inner(), proxy_url)?;
    Ok(CoreConfigView::from(&gui_config_state.snapshot()?))
}

#[tauri::command]
pub(crate) async fn set_core_session_affinity(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    enabled: bool,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {

        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let value = serde_norway::to_value(enabled).map_err(|_| "Invalid configuration value".to_string())?;
            let updated = patch_core_yaml_document(content, |doc| set_core_yaml_path_value(doc, &["routing", "session-affinity"], value))?.unwrap_or_else(|| content.to_string());
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    let previous_enabled = settings.routing_session_affinity;
    settings.routing_session_affinity = enabled;
    patch_core_session_affinity(settings.routing_session_affinity)?;
    let config = match gui_config_state.sync_core_settings(&settings) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_session_affinity(previous_enabled).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn set_core_session_affinity_ttl(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_revision: u64,
    ttl: String,
) -> Result<CoreConfigView, String> {
    gui_config_state.ensure_revision(expected_revision)?;
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        let ttl = normalize_session_affinity_ttl(ttl)?;
        return remote_config_edit(&gui_config_state, expected_revision, |content| {
            let value = serde_norway::to_value(ttl).map_err(|_| "Invalid configuration value".to_string())?;
            let updated = patch_core_yaml_document(content, |doc| set_core_yaml_path_value(doc, &["routing", "session-affinity-ttl"], value))?.unwrap_or_else(|| content.to_string());
            let view = remote_config_view(&updated)?;
            Ok((updated, view))
        }).await;
    }
    let _operation = CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    gui_config_state.ensure_revision(expected_revision)?;
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let ttl = normalize_session_affinity_ttl(ttl)?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    let previous_ttl = settings.routing_session_affinity_ttl.clone();
    settings.routing_session_affinity_ttl = ttl;
    patch_core_session_affinity_ttl(&settings.routing_session_affinity_ttl)?;
    let config = match gui_config_state.sync_core_settings(&settings) {
        Ok(config) => config,
        Err(error) => {
            let rollback_error = patch_core_session_affinity_ttl(&previous_ttl).err();
            return Err(config_update_error_with_rollback(error, rollback_error));
        }
    };
    Ok(CoreConfigView::from(&config))
}

// Remote edits work on a fresh remote snapshot only. No local GUI/core settings are synchronized.
async fn remote_config_edit<T>(
    state: &GuiConfigState,
    expected_revision: u64,
    edit: impl FnOnce(&str) -> Result<(String, T), String>,
) -> Result<T, String> {
    let config = state.snapshot()?;
    let _target_operation = state.target_operation.lock().await;
    state.ensure_target(&config)?;
    state.ensure_revision(expected_revision)?;
    if config.connection_mode != CoreConnectionMode::Remote {
        return Err("Core connection changed; reload settings".to_string());
    }
    let content = crate::core_connection::read_remote_yaml(&config).await?;
    let (updated, result) = edit(&content)?;
    state.ensure_target(&config)?;
    if updated != content {
        crate::core_connection::write_remote_yaml(state, &config, &content, &updated).await?;
    }
    state.ensure_target(&config)?;
    Ok(result)
}

fn remote_gui_config(content: &str) -> Result<GuiConfigFile, String> {
    let document = serde_norway::from_str(content).map_err(|_| "Invalid remote core configuration".to_string())?;
    let settings = core_config_settings_from_value(&document).map_err(|_| "Invalid remote core settings".to_string())?;
    let mut config = GuiConfigFile::default();
    apply_core_settings_to_gui_config(&mut config, &settings);
    Ok(config)
}

fn remote_config_view(content: &str) -> Result<CoreConfigView, String> {
    Ok(CoreConfigView::from(&remote_gui_config(content)?))
}
