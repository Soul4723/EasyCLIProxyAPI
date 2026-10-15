use super::*;

#[tauri::command]
pub(crate) fn get_lan_ipv4() -> Option<String> {
    detect_lan_ipv4().map(|address| address.to_string())
}

#[tauri::command]
pub(crate) fn get_core_tls_settings() -> Result<CoreTlsSettings, String> {
    let _connection_guard = crate::core_connection::local_operation()?;
    current_core_tls_settings()
}

#[tauri::command]
pub(crate) fn save_core_tls_settings(
    cache: tauri::State<'_, AgentConfigStatusCache>,
    settings: CoreTlsSettings,
) -> Result<CoreTlsSettings, String> {
    let _connection_guard = crate::core_connection::local_operation()?;
    let settings = normalize_core_tls_settings(settings)?;
    patch_core_tls_settings(&settings)?;
    cache.clear()?;
    Ok(settings)
}

#[tauri::command]
pub(crate) async fn get_core_sensitive_words_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreSensitiveWordsSettings, String> {
    let config = gui_config_state.snapshot()?;
    if config.core_connection.is_remote() {
        let content = fetch_management_raw_config_yaml(&config).await?;
        let document = serde_norway::from_str(&content).map_err(|error| format!("Invalid remote core YAML: {error}"))?;
        crate::core_connection::ensure_current(&config)?;
        return core_sensitive_words_settings_from_value(&document);
    }
    let _connection_guard = crate::core_connection::local_operation()?;
    read_core_sensitive_words_settings()
}

#[tauri::command]
pub(crate) async fn save_core_sensitive_words_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    settings: CoreSensitiveWordsSettings,
) -> Result<CoreSensitiveWordsSettings, String> {
    let config = gui_config_state.snapshot()?;
    if config.core_connection.is_remote() {
        let normalized = normalize_core_sensitive_words_settings(settings);
        super::extended::save_remote_core_values(&config, &[
            ("oauth/providers/antigravity/sensitive-words", serde_json::json!(normalized.antigravity_sensitive_words)),
            ("oauth/providers/devin/sensitive-words", serde_json::json!(normalized.devin_sensitive_words)),
        ]).await?;
        return Ok(normalized);
    }
    let _connection_guard = crate::core_connection::local_operation()?;
    let normalized = normalize_core_sensitive_words_settings(settings);
    patch_core_sensitive_words_settings(&normalized)?;
    Ok(normalized)
}

pub(crate) fn detect_lan_ipv4() -> Option<Ipv4Addr> {
    for target in ["192.0.2.1:80", "8.8.8.8:80"] {
        let Ok(socket) = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) else {
            continue;
        };
        if socket.connect(target).is_err() {
            continue;
        }
        let Ok(local_address) = socket.local_addr() else {
            continue;
        };
        let IpAddr::V4(address) = local_address.ip() else {
            continue;
        };
        if !address.is_unspecified() && !address.is_loopback() {
            return Some(address);
        }
    }
    None
}

#[tauri::command]
pub(crate) fn save_gui_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    cache: tauri::State<'_, AgentConfigStatusCache>,
    settings: GuiNetworkSettings,
) -> Result<GuiSettings, String> {
    let _connection_guard = crate::core_connection::local_operation()?;
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
    cache: tauri::State<'_, AgentConfigStatusCache>,
    settings: GuiNetworkRoutingSettings,
) -> Result<CoreConfigView, String> {
    let _connection_guard = crate::core_connection::local_operation()?;
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
pub(crate) fn save_network_endpoint_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    cache: tauri::State<'_, AgentConfigStatusCache>,
    settings: GuiNetworkEndpointSettings,
) -> Result<CoreConfigView, String> {
    let _connection_guard = crate::core_connection::local_operation()?;
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
            .unwrap_or_else(|| !proxy_url.is_empty());
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
    settings: GuiRetrySettings,
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        return super::extended::save_remote_core_values(&snapshot, &[
            ("routing/cooldown/disable-cooling", serde_json::json!(settings.disable_cooling)),
            ("routing/retry/request-retry", serde_json::json!(settings.request_retry)),
            ("routing/retry/max-retry-credentials", serde_json::json!(settings.max_retry_credentials)),
            ("routing/retry/max-retry-interval", serde_json::json!(settings.max_retry_interval)),
            ("requests/streaming/bootstrap-retries", serde_json::json!(settings.streaming_bootstrap_retries)),
        ]).await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
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
    settings: GuiSessionRoutingSettings,
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        let ttl = normalize_session_affinity_ttl(settings.routing_session_affinity_ttl)?;
        return super::extended::save_remote_core_values(&snapshot, &[
            ("routing/session-affinity", serde_json::json!(settings.routing_session_affinity)),
            ("routing/session-affinity-ttl", serde_json::json!(ttl)),
        ]).await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
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
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        return super::extended::remote_core_config_view(&snapshot).await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
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
    settings: CoreLoggingSettingsInput,
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        if !(1..=3600).contains(&settings.redis_usage_queue_retention_seconds) {
            return Err("Redis usage queue retention must be between 1 and 3600 seconds".to_string());
        }
        return super::extended::save_remote_core_values(&snapshot, &[
            ("observability/logs/debug", serde_json::json!(settings.debug)),
            ("server/commercial-mode", serde_json::json!(settings.commercial_mode)),
            ("observability/logs/logging-to-file", serde_json::json!(settings.logging_to_file)),
            ("observability/logs/logs-max-total-size-mb", serde_json::json!(settings.logs_max_total_size_mb)),
            ("observability/logs/error-logs-max-files", serde_json::json!(settings.error_logs_max_files)),
            ("observability/usage/usage-statistics-enabled", serde_json::json!(settings.usage_statistics_enabled)),
            ("observability/usage/redis-usage-queue-retention-seconds", serde_json::json!(settings.redis_usage_queue_retention_seconds)),
        ]).await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
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
    api_key: String,
    remark: String,
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        let _target_guard = crate::core_connection::target_operation()?;
        crate::core_connection::ensure_current(&snapshot)?;
        let api_key = api_key.trim().to_string();
        validate_core_api_key(&api_key)?;
        validate_api_key_remark(remark.trim())?;
        if !remark.trim().is_empty() {
            return Err("Remote API key notes are not supported; save the key without a note".to_string());
        }
        let mut keys = super::extended::remote_core_config_view(&snapshot)
            .await?
            .api_keys
            .iter()
            .map(|entry| entry.api_key.clone())
            .collect::<Vec<_>>();
        if keys.contains(&api_key) {
            return Err("This authentication key already exists".to_string());
        }
        keys.push(api_key);
        return super::extended::save_remote_core_values(
            &snapshot,
            &[("access/api-keys", serde_json::json!(keys))],
        )
        .await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
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
    original_api_key: String,
    api_key: String,
    remark: String,
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        let _target_guard = crate::core_connection::target_operation()?;
        crate::core_connection::ensure_current(&snapshot)?;
        let api_key = api_key.trim().to_string();
        validate_core_api_key(&api_key)?;
        validate_api_key_remark(remark.trim())?;
        if !remark.trim().is_empty() {
            return Err("Remote API key notes are not supported; save the key without a note".to_string());
        }
        let mut keys = super::extended::remote_core_config_view(&snapshot)
            .await?
            .api_keys
            .iter()
            .map(|entry| entry.api_key.clone())
            .collect::<Vec<_>>();
        replace_core_api_key_value(&mut keys, original_api_key.trim(), api_key)?;
        return super::extended::save_remote_core_values(
            &snapshot,
            &[("access/api-keys", serde_json::json!(keys))],
        )
        .await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
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
    api_key: String,
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        let _target_guard = crate::core_connection::target_operation()?;
        crate::core_connection::ensure_current(&snapshot)?;
        let mut keys = super::extended::remote_core_config_view(&snapshot)
            .await?
            .api_keys
            .iter()
            .map(|entry| entry.api_key.clone())
            .collect::<Vec<_>>();
        remove_core_api_key_value(&mut keys, api_key.trim())?;
        return super::extended::save_remote_core_values(
            &snapshot,
            &[("access/api-keys", serde_json::json!(keys))],
        )
        .await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
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
    secret_key: String,
) -> Result<CoreConfigView, String> {
    let _connection_guard = crate::core_connection::local_operation()?;
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
) -> Result<CoreConfigView, String> {
    let _connection_guard = crate::core_connection::local_operation()?;
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
    enabled: bool,
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        return super::extended::save_remote_core_values(&snapshot, &[("plugins/enabled", serde_json::json!(enabled))]).await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
    let mut settings = current_core_config_settings(gui_config_state.inner())?;
    settings.plugins_enabled = enabled;
    patch_core_plugins_enabled(settings.plugins_enabled)?;
    let config = gui_config_state.sync_core_settings(&settings)?;
    Ok(CoreConfigView::from(&config))
}

#[tauri::command]
pub(crate) async fn set_core_request_log(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    enabled: bool,
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        return super::extended::save_remote_core_values(&snapshot, &[("observability/logs/request-log", serde_json::json!(enabled))]).await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
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
    strategy: String,
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        validate_routing_strategy(&strategy)?;
        return super::extended::save_remote_core_values(&snapshot, &[("routing/strategy", serde_json::json!(strategy))]).await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
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
    proxy_url: String,
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        let proxy_url = network_proxy::normalize_optional_proxy_url(&proxy_url)?;
        return super::extended::save_remote_core_values(&snapshot, &[("requests/proxy-url", serde_json::json!(proxy_url))]).await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
    network_proxy::set_manual(gui_config_state.inner(), proxy_url)?;
    Ok(CoreConfigView::from(&gui_config_state.snapshot()?))
}

#[tauri::command]
pub(crate) async fn set_core_session_affinity(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    enabled: bool,
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        return super::extended::save_remote_core_values(&snapshot, &[("routing/session-affinity", serde_json::json!(enabled))]).await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
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
    ttl: String,
) -> Result<CoreConfigView, String> {
    let snapshot = gui_config_state.snapshot()?;
    if snapshot.core_connection.is_remote() {
        let ttl = normalize_session_affinity_ttl(ttl)?;
        return super::extended::save_remote_core_values(&snapshot, &[("routing/session-affinity-ttl", serde_json::json!(ttl))]).await;
    }
    let _connection_guard = crate::core_connection::local_operation()?;
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
