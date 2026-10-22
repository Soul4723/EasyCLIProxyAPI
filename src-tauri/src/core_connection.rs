use crate::{
    CoreApiKeyView, CoreConfigSettings, CoreConfigView, CoreConnectionMode, CoreStatus,
    GuiConfigFile, GuiConfigState,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreConnection {
    pub(crate) mode: CoreConnectionMode,
    pub(crate) management_origin: String,
    pub(crate) management_key: String,
    /// Optional EasyCLIProxyAPI host control on the remote core's computer; empty when not set up.
    #[serde(default)]
    pub(crate) host_control_origin: String,
    #[serde(default)]
    pub(crate) host_control_key: String,
}

impl From<&GuiConfigFile> for CoreConnection {
    fn from(config: &GuiConfigFile) -> Self {
        Self {
            mode: config.connection_mode,
            management_origin: config.remote_management_origin.clone(),
            management_key: config.remote_management_key.clone(),
            host_control_origin: config.remote_host_control_origin.clone(),
            host_control_key: config.remote_host_control_key.clone(),
        }
    }
}

pub(crate) fn normalize_origin(value: &str) -> Result<String, String> {
    let value = value.trim();
    let parsed = reqwest::Url::parse(value).map_err(|_| "Invalid management origin")?;
    if value.chars().any(char::is_control)
        || value.contains(['\\', '@'])
        || value.split_once("://").is_none_or(|(_, authority)| {
            authority
                .split_once('/')
                .is_some_and(|(_, path)| !path.is_empty())
        })
        || !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || (parsed.path() != "/" && !parsed.path().is_empty())
    {
        return Err("Management origin must be an HTTP(S) origin without credentials, path, query or fragment".into());
    }
    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

pub(crate) fn normalize_connection(mut connection: CoreConnection) -> Result<CoreConnection, String> {
    connection.management_origin = normalize_origin(&connection.management_origin)?;
    connection.management_key = crate::normalize_management_secret_key(connection.management_key)?;
    let (origin, key) = crate::host_control::normalize_remote_target(
        &connection.host_control_origin,
        &connection.host_control_key,
        &connection.management_key,
    )?;
    connection.host_control_origin = origin;
    connection.host_control_key = key;
    Ok(connection)
}

pub(crate) fn require_local(config: &GuiConfigFile) -> Result<(), String> {
    if config.connection_mode == CoreConnectionMode::Remote {
        Err("This operation is only available for the local core".into())
    } else {
        Ok(())
    }
}

/// Changes in flight that are aimed at the selected core: remote settings writes and agent client changes.
/// A connection change is refused while any runs, so a change started against one core never lands after
/// a switch to another.
static TARGET_WRITES: std::sync::Mutex<usize> = std::sync::Mutex::new(0);

pub(crate) struct TargetWriteGuard;

impl Drop for TargetWriteGuard {
    fn drop(&mut self) {
        if let Ok(mut writes) = TARGET_WRITES.lock() {
            *writes -= 1;
        }
    }
}

/// Starts a change aimed at `config`'s core; fails if the connection changed since `config` was read.
pub(crate) fn begin_target_write(
    state: &GuiConfigState,
    config: &GuiConfigFile,
) -> Result<TargetWriteGuard, String> {
    let mut writes = TARGET_WRITES
        .lock()
        .map_err(|_| "Core target lock is poisoned".to_string())?;
    if CoreConnection::from(&state.snapshot()?) != CoreConnection::from(config) {
        return Err("The core connection changed; reload before saving".into());
    }
    *writes += 1;
    Ok(TargetWriteGuard)
}

/// Refuses a connection change while a change aimed at the current core runs; the returned guard keeps new
/// ones from starting until the switch is saved.
pub(crate) fn lock_target_writes_for_switch() -> Result<std::sync::MutexGuard<'static, usize>, String> {
    let writes = TARGET_WRITES
        .lock()
        .map_err(|_| "Core target lock is poisoned".to_string())?;
    if *writes > 0 {
        return Err("A change to the core is still being saved. Try again when it finishes".into());
    }
    Ok(writes)
}

type RemoteConfigSnapshot = (CoreConnection, Instant, Result<serde_norway::Value, String>);
static REMOTE_CONFIG_CACHE: tokio::sync::Mutex<Option<RemoteConfigSnapshot>> =
    tokio::sync::Mutex::const_new(None);

/// The remote core's configuration, read through the management API. `None` in Local mode, where callers
/// read the local config.yaml as before. Remote edits go through `edit_remote_core_config`.
pub(crate) async fn remote_core_config_document(
    config: &GuiConfigFile,
) -> Result<Option<serde_norway::Value>, String> {
    if config.connection_mode != CoreConnectionMode::Remote {
        return Ok(None);
    }
    // One short-lived snapshot for simultaneous settings getters and model probes. Holding the
    // async lock across the read coalesces in-flight requests; credentials are part of the target.
    // Cache failures too, so a failing target is not read again by every queued caller.
    let target = CoreConnection::from(config);
    let mut cache = REMOTE_CONFIG_CACHE.lock().await;
    if let Some((cached_target, fetched_at, document)) = cache.as_ref() {
        if *cached_target == target && fetched_at.elapsed() < Duration::from_secs(5) {
            return document.clone().map(Some);
        }
    }
    let document = match crate::core_config::fetch_management_raw_config_yaml(config).await {
        Ok(content) => serde_norway::from_str(&content)
            .map_err(|error| format!("Failed to parse the remote core configuration: {error}")),
        Err(error) => Err(error),
    };
    *cache = Some((target, Instant::now(), document.clone()));
    document.map(Some)
}

/// Remote mode only: applies `edit` to the remote core's config.yaml through its management API. `edit`
/// is the same YAML patch Local mode applies to the local file; it returns the patched content (`None`
/// when nothing changes) and the command's result. The document is read with its ETag and written back
/// whole with `If-Match` (core 8.0.31+), so a save by anyone else in between is refused (412), never
/// overwritten. A core without ETags gets a second read just before the write instead, which narrows
/// but cannot close that window. The connection cannot change while the edit runs.
pub(crate) async fn edit_remote_core_config<T>(
    state: &GuiConfigState,
    edit: impl FnOnce(&str) -> Result<(Option<String>, T), String>,
) -> Result<T, String> {
    let config = state.snapshot()?;
    if config.connection_mode != CoreConnectionMode::Remote {
        return Err("The core connection changed; reload before saving".into());
    }
    let _target = begin_target_write(state, &config)?;
    let (content, etag) = fetch_remote_config_yaml(&config).await?;
    let (updated, result) = edit(&content)?;
    let Some(updated) = updated.filter(|updated| *updated != content) else {
        return Ok(result);
    };
    if etag.is_none() && fetch_remote_config_yaml(&config).await?.0 != content {
        return Err(REMOTE_CONFIG_CHANGED.into());
    }
    let mut request = crate::management_api::management_http_client_for(&config)?
        .put(crate::management_api::management_endpoint(
            &config,
            "config.yaml",
        )?)
        .header(
            "Authorization",
            crate::management_api::management_authorization(&config)?,
        )
        .header(reqwest::header::CONTENT_TYPE, "application/yaml")
        .body(updated);
    if let Some(etag) = etag {
        request = request.header(reqwest::header::IF_MATCH, etag);
    }
    let response = request.send().await.map_err(|error| {
        crate::management_api::format_management_request_error(
            "Failed to save the remote core configuration; reload to see whether it applied",
            &error,
        )
    });
    // Whatever happened, the next read must come from the core.
    *REMOTE_CONFIG_CACHE.lock().await = None;
    let response = response?;
    if response.status() == reqwest::StatusCode::PRECONDITION_FAILED {
        return Err(REMOTE_CONFIG_CHANGED.into());
    }
    crate::management_api::read_management_text(response).await?;
    Ok(result)
}

const REMOTE_CONFIG_CHANGED: &str =
    "The remote core's configuration was changed elsewhere since it was read. Nothing was saved; reload and try again";

async fn fetch_remote_config_yaml(
    config: &GuiConfigFile,
) -> Result<(String, Option<String>), String> {
    let response = crate::management_api::management_http_client_for(config)?
        .get(crate::management_api::management_endpoint(
            config,
            "config.yaml",
        )?)
        .header(
            "Authorization",
            crate::management_api::management_authorization(config)?,
        )
        .header(
            reqwest::header::ACCEPT,
            "application/yaml,text/yaml,text/plain",
        )
        .send()
        .await
        .map_err(|error| {
            crate::management_api::format_management_request_error(
                "Failed to read the remote core configuration",
                &error,
            )
        })?;
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    Ok((
        crate::management_api::read_management_text(response).await?,
        etag,
    ))
}

/// Settings view of the remote core after an edit (or unchanged).
pub(crate) fn remote_config_view_of(content: &str) -> Result<CoreConfigView, String> {
    let document = serde_norway::from_str(content)
        .map_err(|error| format!("Failed to parse the remote core configuration: {error}"))?;
    Ok(remote_config_view(
        crate::core_config::core_config_settings_from_value(&document)?,
    ))
}

/// Settings view of a remote core. Key remarks are GUI metadata of this computer, so none are shown.
pub(crate) fn remote_config_view(settings: CoreConfigSettings) -> CoreConfigView {
    CoreConfigView {
        allow_lan: !crate::core_config::is_loopback_host(&settings.host),
        host: settings.host,
        api_keys: settings
            .api_keys
            .into_iter()
            .map(|api_key| CoreApiKeyView {
                api_key,
                remark: String::new(),
            })
            .collect(),
        management_secret_configured: settings.management_secret_configured,
        port: settings.port,
        debug: settings.debug,
        commercial_mode: settings.commercial_mode,
        logging_to_file: settings.logging_to_file,
        logs_max_total_size_mb: settings.logs_max_total_size_mb,
        error_logs_max_files: settings.error_logs_max_files,
        usage_statistics_enabled: settings.usage_statistics_enabled,
        redis_usage_queue_retention_seconds: settings.redis_usage_queue_retention_seconds,
        request_log: settings.request_log,
        plugins_enabled: settings.plugins_enabled,
        routing_strategy: settings.routing_strategy,
        proxy_override: !settings.proxy_url.is_empty(),
        proxy_url: settings.proxy_url,
        routing_session_affinity: settings.routing_session_affinity,
        routing_session_affinity_ttl: settings.routing_session_affinity_ttl,
        disable_cooling: settings.disable_cooling,
        request_retry: settings.request_retry,
        max_retry_credentials: settings.max_retry_credentials,
        max_retry_interval: settings.max_retry_interval,
        streaming_bootstrap_retries: settings.streaming_bootstrap_retries,
    }
}

#[tauri::command]
pub(crate) fn get_core_connection(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreConnection, String> {
    Ok(CoreConnection::from(&gui_config_state.snapshot()?))
}

#[tauri::command]
pub(crate) fn save_core_connection(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    connection: CoreConnection,
) -> Result<CoreConnection, String> {
    let connection = if connection.mode == CoreConnectionMode::Remote {
        normalize_connection(connection)?
    } else {
        connection
    };
    crate::host_control::ensure_no_remote_install()?;
    let process = app.state::<crate::CoreProcessState>();
    let _operation = crate::lock_core_operation(process.inner())?;
    // Held until the switch is saved, so no change aimed at the old core can start meanwhile.
    let _writes = lock_target_writes_for_switch()?;
    if connection.mode == CoreConnectionMode::Remote {
        // Includes adopted processes, matching the managed flag the UI checks.
        if process.managed_pid().is_some() {
            return Err("Stop the GUI-managed local core before switching to Remote".into());
        }
        process.recovery.cancel();
    }
    let config = gui_config_state.update(|config| {
        config.connection_mode = connection.mode;
        if connection.mode == CoreConnectionMode::Remote {
            config.remote_management_origin = connection.management_origin;
            config.remote_management_key = connection.management_key;
            config.remote_host_control_origin = connection.host_control_origin;
            config.remote_host_control_key = connection.host_control_key;
        }
        Ok(())
    })?;
    if config.connection_mode == CoreConnectionMode::Remote {
        crate::usage::stop_usage_collector(&app);
    } else {
        crate::usage::start_usage_collector(app);
    }
    Ok(CoreConnection::from(&config))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreConnectionTestResult {
    pub(crate) connected: bool,
    pub(crate) version: Option<String>,
    pub(crate) message: String,
}

#[tauri::command]
pub(crate) async fn test_core_connection(
    connection: CoreConnection,
) -> Result<CoreConnectionTestResult, String> {
    check_remote_connection(connection, true).await
}

pub(crate) async fn poll_core_connection(
    connection: CoreConnection,
) -> Result<CoreConnectionTestResult, String> {
    check_remote_connection(connection, false).await
}

async fn check_remote_connection(
    connection: CoreConnection,
    full_config: bool,
) -> Result<CoreConnectionTestResult, String> {
    // Management reachability only; host control is checked separately.
    let connection = normalize_connection(CoreConnection {
        host_control_origin: String::new(),
        host_control_key: String::new(),
        ..connection
    })?;
    let config = GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: connection.management_origin,
        remote_management_key: connection.management_key,
        ..GuiConfigFile::default()
    };
    let response = crate::management_api::management_http_client_for(&config)?
        .get(crate::management_api::management_endpoint(
            &config,
            if full_config {
                "config"
            } else {
                "config/config-version"
            },
        )?)
        .header(
            "Authorization",
            crate::management_api::management_authorization(&config)?,
        )
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;
    let mut result = CoreConnectionTestResult {
        connected: false,
        version: None,
        message: "Unable to reach the core".into(),
    };
    if let Ok(response) = response {
        let status = response.status();
        if status.is_success() {
            let version = response
                .headers()
                .get("X-CPA-VERSION")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            let valid = response
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|value| {
                    if full_config {
                        value.get("config-version")?.as_u64()
                    } else {
                        value.as_u64()
                    }
                })
                == Some(8);
            result.connected = valid;
            result.version = if valid { version } else { None };
            result.message = if valid {
                "Connected"
            } else {
                "Core did not return a v8 configuration"
            }
            .into();
        } else {
            result.message = match status.as_u16() {
                401 => "Core rejected the management key".into(),
                403 => "Remote management access is forbidden".into(),
                404 => "Core does not expose the v8 management API".into(),
                status => format!("Core management request failed (HTTP {status})"),
            };
        }
    }
    Ok(result)
}

pub(crate) fn remote_status(
    connection: &CoreConnection,
    result: CoreConnectionTestResult,
) -> CoreStatus {
    CoreStatus {
        installed: false,
        running: result.connected,
        ready: result.connected,
        starting: false,
        managed: false,
        process_id: None,
        current_version: result.version,
        install_dir: String::new(),
        binary_path: None,
        connection_mode: CoreConnectionMode::Remote,
        remote_origin: Some(connection.management_origin.clone()),
        message: result.message,
        recovery: None,
        host_control: None,
    }
}

/// Remote status: management reachability from the core itself, plus (when configured) the process
/// state reported by the remote host's EasyCLIProxyAPI. Both are read concurrently.
pub(crate) async fn current_remote_status(connection: &CoreConnection) -> CoreStatus {
    let host = async {
        if connection.host_control_origin.is_empty() {
            None
        } else {
            Some(
                crate::host_control::fetch_host_status(
                    &connection.host_control_origin,
                    &connection.host_control_key,
                )
                .await,
            )
        }
    };
    let management = async {
        poll_core_connection(connection.clone())
            .await
            .unwrap_or_else(|message| CoreConnectionTestResult {
                connected: false,
                version: None,
                message,
            })
    };
    let (management, host) = tokio::join!(management, host);
    remote_status_with_host(connection, management, host)
}

pub(crate) fn remote_status_with_host(
    connection: &CoreConnection,
    management: CoreConnectionTestResult,
    host: Option<Result<crate::host_control::HostCoreStatus, String>>,
) -> CoreStatus {
    let mut status = remote_status(connection, management);
    let Some(host) = host else {
        return status;
    };
    status.host_control = Some(match host {
        Ok(host) => {
            // The host's EasyCLIProxyAPI reports the process; `ready` stays management reachability.
            status.installed = host.installed;
            status.running = host.running || status.ready;
            status.starting = host.starting;
            status.process_id = host.process_id.filter(|_| host.running);
            if status.current_version.is_none() {
                status.current_version = host.current_version;
            }
            if !status.ready && !host.running {
                status.message = crate::host_control::STOPPED_ON_REMOTE_HOST.into();
            }
            crate::host_control::HostControlView {
                reachable: true,
                message: host.message,
            }
        }
        Err(message) => crate::host_control::HostControlView {
            reachable: false,
            message,
        },
    });
    status
}

/// Publishes a remote status unless Save has selected another target meanwhile.
pub(crate) fn publish_remote_status(
    app: &tauri::AppHandle,
    connection: &CoreConnection,
    status: CoreStatus,
) -> Result<CoreStatus, String> {
    let gui_config_state = app.state::<GuiConfigState>();
    let current = gui_config_state
        .inner
        .lock()
        .map_err(|_| "GUI configuration status lock is poisoned")?;
    if CoreConnection::from(&*current) != *connection {
        return Err("Core connection changed; refresh status".into());
    }
    crate::emit_core_status(app, &status);
    Ok(status)
}
