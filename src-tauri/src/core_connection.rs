use crate::{core_origin, current_core_tls_settings, GuiConfigFile, GuiConfigState, CoreConnectionMode, CoreStatus};
use serde::{Deserialize, Serialize};
use std::{fs, fs::File, io::{Read, Write}, path::{Component, Path, PathBuf}, time::{Duration, SystemTime, UNIX_EPOCH}};

use tauri::Emitter;

const PORTABLE_CONNECTION_FORMAT: &str = "easycli-proxy-connection";
const PORTABLE_CONNECTION_VERSION: u8 = 1;
const MAX_PORTABLE_FILE_BYTES: u64 = 1024 * 1024;

const CONNECTION_CHANGED_EVENT: &str = "core-connection-changed";

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreConnection {
    pub(crate) mode: CoreConnectionMode,
    pub(crate) management_origin: String,
    pub(crate) management_key: String,
    pub(crate) client_origin: String,
    pub(crate) client_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortableConnectionFile {
    format: String,
    version: u8,
    connection: PortableConnection,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PortableConnection {
    mode: CoreConnectionMode,
    management_origin: String,
    client_origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    management_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_key: Option<String>,
}

impl PortableConnectionFile {
    fn from_connection(connection: &CoreConnection, include_secrets: bool) -> Self {
        Self {
            format: PORTABLE_CONNECTION_FORMAT.to_string(),
            version: PORTABLE_CONNECTION_VERSION,
            connection: PortableConnection {
                mode: connection.mode,
                management_origin: connection.management_origin.clone(),
                client_origin: connection.client_origin.clone(),
                management_key: include_secrets.then(|| connection.management_key.clone()),
                client_key: include_secrets.then(|| connection.client_key.clone()),
            },
        }
    }

    fn into_connection(self) -> Result<CoreConnection, String> {
        if self.format != PORTABLE_CONNECTION_FORMAT || self.version != PORTABLE_CONNECTION_VERSION {
            return Err("Unsupported connection export format".to_string());
        }
        let mut connection = CoreConnection {
            mode: self.connection.mode,
            management_origin: self.connection.management_origin,
            management_key: self.connection.management_key.unwrap_or_default(),
            client_origin: self.connection.client_origin,
            client_key: self.connection.client_key.unwrap_or_default(),
        };
        if connection.mode != CoreConnectionMode::Remote {
            return Err("Portable connection exports must target a remote core".to_string());
        }
        if connection.management_origin.chars().any(char::is_control) {
            return Err("Connection export contains an invalid management origin".to_string());
        }
        connection.management_origin = origin(&connection.management_origin, "Management origin")?;
        if connection.management_key.chars().any(char::is_control) {
            return Err("Connection export contains invalid management credentials".to_string());
        }
        if connection.client_origin.chars().any(char::is_control) || connection.client_key.chars().any(char::is_control) {
            return Err("Connection export contains invalid client credentials".to_string());
        }
        connection.client_origin = origin(&connection.client_origin, "Client origin")?;
        Ok(connection)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreConnectionTestResult {
    pub(crate) connected: bool,
    pub(crate) version: Option<String>,
    pub(crate) message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionChangedPayload {
    revision: u64,
}

fn origin(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(value).map_err(|_| format!("Invalid {label}"))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || (parsed.path() != "/" && !parsed.path().is_empty())
    {
        return Err(format!("{label} must be an HTTP(S) origin"));
    }
    Ok(parsed.to_string().trim_end_matches('/').to_string())
}

fn normalized_connection(connection: CoreConnection) -> Result<CoreConnection, String> {
    let management_origin = origin(&connection.management_origin, "Management origin")?;
    let client_origin = origin(&connection.client_origin, "Client origin")?;
    let management_key = connection.management_key.trim().to_string();
    let client_key = connection.client_key.trim().to_string();
    if management_key.is_empty() {
        return Err("Management key is required".to_string());
    }
    crate::validate_management_secret_key(&management_key)?;
    if crate::is_hashed_management_secret_key(&management_key) {
        return Err("A plaintext management key is required".to_string());
    }
    if client_key.len() > 4096 || client_key.chars().any(char::is_control) {
        return Err("Invalid client key".to_string());
    }
    Ok(CoreConnection {
        mode: connection.mode,
        management_origin,
        management_key,
        client_origin,
        client_key,
    })
}

pub(crate) fn connection_from_config(config: &GuiConfigFile) -> Result<CoreConnection, String> {
    let tls = if config.connection_mode == CoreConnectionMode::Local { current_core_tls_settings()?.enabled } else { false };
    let local_management_origin = core_origin(&config.host, config.port, tls);
    let local_client_origin = local_management_origin.clone();
    match config.connection_mode {
        CoreConnectionMode::Local => Ok(CoreConnection {
            mode: CoreConnectionMode::Local,
            management_origin: local_management_origin,
            management_key: config.management_secret_key.clone(),
            client_origin: local_client_origin,
            client_key: config.api_keys.first().map(|entry| entry.key.clone()).unwrap_or_default(),
        }),
        CoreConnectionMode::Remote => normalized_connection(CoreConnection {
            mode: CoreConnectionMode::Remote,
            management_origin: config.remote_management_origin.clone(),
            management_key: config.remote_management_key.clone(),
            client_origin: config.remote_client_origin.clone(),
            client_key: config.remote_client_key.clone(),
        }),
    }
}

#[tauri::command]
pub(crate) fn get_core_connection(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreConnection, String> {
    Ok(settings_connection(&gui_config_state.snapshot()?))
}

fn settings_connection(config: &GuiConfigFile) -> CoreConnection {
    CoreConnection {
        mode: config.connection_mode,
        management_origin: config.remote_management_origin.clone(),
        management_key: config.remote_management_key.clone(),
        client_origin: config.remote_client_origin.clone(),
        client_key: config.remote_client_key.clone(),
    }
}

fn portable_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("Connection export path is invalid".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() || path.components().any(|component| matches!(component, Component::ParentDir)) || path.file_name().is_none() {
        return Err("Connection export path must be an absolute file path".to_string());
    }
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.file_type().is_file() { return Err("Connection export path must name a regular file".to_string()); }
    }
    let parent = path.parent().ok_or("Connection export path has no parent")?;
    if !parent.is_dir() { return Err("Connection export directory does not exist".to_string()); }
    Ok(path)
}

#[tauri::command]
pub(crate) fn export_core_connection(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    path: String,
    include_secrets: bool,
) -> Result<(), String> {
    let path = portable_path(&path)?;
    let config = gui_config_state.snapshot()?;
    if config.connection_mode != CoreConnectionMode::Remote {
        return Err("Switch to Remote mode before exporting connection settings".to_string());
    }
    let document = serde_json::to_vec_pretty(&PortableConnectionFile::from_connection(&settings_connection(&config), include_secrets))
        .map_err(|error| format!("Failed to create connection export: {error}"))?;
    write_portable_connection(&path, &document)
}

fn write_portable_connection(path: &Path, document: &[u8]) -> Result<(), String> {
    portable_path(path.to_str().ok_or("Invalid connection export path")?)?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "System clock is unavailable")?.as_nanos();
    let temporary = path.with_extension(format!("{}.{}.tmp", std::process::id(), nonce));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|error| format!("Failed to create connection export: {error}"))?;
    let write_result = file.write_all(&[document, b"\n"].concat()).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Failed to write connection export: {error}"));
    }
    if let Err(error) = crate::core_config::replace_file_atomically(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Failed to finalize connection export: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn import_core_connection(path: String) -> Result<CoreConnection, String> {
    let path = portable_path(&path)?;
    let size = fs::metadata(&path).map_err(|error| format!("Failed to read connection export: {error}"))?.len();
    if size > MAX_PORTABLE_FILE_BYTES { return Err("Connection export is too large".to_string()); }
    let mut content = String::new();
    File::open(path).and_then(|file| file.take(MAX_PORTABLE_FILE_BYTES + 1).read_to_string(&mut content))
        .map_err(|_| "Failed to read connection export".to_string())?;
    if content.len() as u64 > MAX_PORTABLE_FILE_BYTES { return Err("Connection export is too large".to_string()); }
    let export: PortableConnectionFile = serde_json::from_str(&content).map_err(|_| "Connection export is invalid or corrupted".to_string())?;
    export.into_connection()
}

// Compare only the active connection, not presentation settings or inactive drafts.
pub(crate) fn target_changed(before: &GuiConfigFile, after: &GuiConfigFile) -> bool {
    if before.connection_mode != after.connection_mode { return true; }
    match after.connection_mode {
        CoreConnectionMode::Remote => settings_connection(before) != settings_connection(after),
        CoreConnectionMode::Local => before.host != after.host
            || before.port != after.port
            || before.management_secret_key != after.management_secret_key
            || before.api_keys.first().map(|entry| &entry.key) != after.api_keys.first().map(|entry| &entry.key),
    }
}

// Caller holds target_operation and CORE_OPERATION_LOCK, in that order.
pub(crate) fn prepare_target_transition<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>, mode: CoreConnectionMode,
) -> Result<(), String> {
    use tauri::Manager;
    if mode == CoreConnectionMode::Remote {
        let process = app.state::<crate::CoreProcessState>();
        prepare_remote_process_transition(process.inner())?;
    }
    Ok(())
}

// Caller holds CORE_OPERATION_LOCK. Kept separate to exercise transition lifecycle without a GUI.
pub(crate) fn prepare_remote_process_transition(process: &crate::CoreProcessState) -> Result<(), String> {
        let mut child = process.child.lock().map_err(|_| "Core process lock is poisoned".to_string())?;
        if let Some(owned) = child.as_mut() {
            if owned.try_wait().map_err(|_| "Unable to inspect the local core process".to_string())?.is_none() {
                return Err("Stop the GUI-managed local core before switching to Remote; its lifetime is tied to this application".to_string());
            }
            *child = None;
        }
        process.disarm_supervision();
        process.clear_adopted_processes()?;
    Ok(())
}

// Caller holds target_operation; external files never bypass lifecycle refusal.
pub(crate) fn replace_external_target<R: tauri::Runtime>(app: &tauri::AppHandle<R>, config: GuiConfigFile) -> Result<(), String> {
    use tauri::Manager;
    let _operation = crate::CORE_OPERATION_LOCK.lock()
        .map_err(|_| "Core operation lock is poisoned".to_string())?;
    let state = app.state::<GuiConfigState>();
    if target_changed(&state.snapshot()?, &config) {
        prepare_target_transition(app, config.connection_mode)?;
    }
    if state.replace_external(config)? {
        invalidate_target(app, state.snapshot()?.target_revision)?;
    }
    Ok(())
}

pub(crate) fn invalidate_target<R: tauri::Runtime>(app: &tauri::AppHandle<R>, revision: u64) -> Result<(), String> {
    use tauri::Manager;
    crate::usage::invalidate_sources_cache();
    app.state::<crate::AgentConfigStatusCache>().clear()?;
    app.state::<crate::CoreProcessState>().set_starting(false);
    let _ = app.emit(CONNECTION_CHANGED_EVENT, ConnectionChangedPayload { revision });
    Ok(())
}

#[tauri::command]
pub(crate) async fn save_core_connection<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    connection: CoreConnection,
) -> Result<CoreConnection, String> {
    let connection = if connection.mode == CoreConnectionMode::Remote {
        normalized_connection(connection)?
    } else { connection };
    let _target_operation = gui_config_state.target_operation.lock().await;
    let _operation = crate::CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    let config = {
        let mut current = gui_config_state.inner.lock().map_err(|_| "GUI configuration lock is poisoned".to_string())?;
        let mut config = current.clone();
        config.connection_mode = connection.mode;
        if connection.mode == CoreConnectionMode::Remote {
            config.remote_management_origin = connection.management_origin.clone();
            config.remote_management_key = connection.management_key.clone();
            config.remote_client_origin = connection.client_origin.clone();
            config.remote_client_key = connection.client_key.clone();
        }
        if !target_changed(&current, &config) {
            return Ok(settings_connection(&current));
        }
        prepare_target_transition(&app, connection.mode)?;
        config.target_revision = current.target_revision.wrapping_add(1);
        #[cfg(test)]
        if let Some(path) = &gui_config_state.persistence_path {
            crate::write_gui_config_to_path(&config, path)?;
        } else {
            crate::write_gui_config(&config)?;
        }
        #[cfg(not(test))]
        crate::write_gui_config(&config)?;
        *current = config.clone();
        config
    };
    invalidate_target(&app, config.target_revision)?;
    Ok(settings_connection(&config))
}

#[tauri::command]
pub(crate) async fn test_core_connection(
    connection: CoreConnection,
) -> Result<CoreConnectionTestResult, String> {
    if connection.mode != CoreConnectionMode::Remote {
        return Err("Connection testing is only available for remote drafts".to_string());
    }
    let connection = normalized_connection(connection)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Failed to create connection test client".to_string())?;
    let url = format!("{}/v8/management/config", connection.management_origin);
    let response = match client
        .get(url)
        .header("Authorization", format!("Bearer {}", connection.management_key))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => {
            return Ok(CoreConnectionTestResult {
                connected: false,
                version: None,
                message: "Unable to reach the core".to_string(),
            })
        }
    };
    let version = response
        .headers()
        .get("X-CPA-VERSION")
        .or_else(|| response.headers().get("X-CLIProxyAPI-Version"))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 64 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b".-_+".contains(&byte)))
        .filter(|value| !value.contains(&connection.management_key) && (connection.client_key.is_empty() || !value.contains(&connection.client_key)))
        .map(str::to_string);
    if response.status().is_success() {
        let valid = response.json::<serde_json::Value>().await.ok()
            .and_then(|value| value.get("config-version").and_then(serde_json::Value::as_u64)) == Some(8);
        if !valid {
            return Ok(CoreConnectionTestResult { connected: false, version: None, message: "Core did not return a v8 configuration".to_string() });
        }
        Ok(CoreConnectionTestResult {
            connected: true,
            version,
            message: "Connected".to_string(),
        })
    } else {
        Ok(CoreConnectionTestResult {
            connected: false,
            version: None,
            message: match response.status().as_u16() {
                401 => "Core rejected the management key".to_string(),
                403 => "Remote management access is forbidden".to_string(),
                404 => "Core does not expose the v8 management API".to_string(),
                status => format!("Core management request failed (HTTP {status})"),
            },
        })
    }
}

pub(crate) fn remote_status(connection: &CoreConnection, result: CoreConnectionTestResult) -> CoreStatus {
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
        connection_mode: Some("remote".to_string()),
        remote_origin: Some(connection.management_origin.clone()),
        message: result.message,
        recovery: None,
    }
}

pub(crate) fn require_local(config: &GuiConfigFile) -> Result<(), String> {
    if config.connection_mode == CoreConnectionMode::Remote {
        Err("This operation is only available for the local core".to_string())
    } else { Ok(()) }
}

pub(crate) async fn fetch_client_models(config: &GuiConfigFile) -> Result<serde_json::Value, String> {
    crate::agents::fetch_agent_model_payload(config, crate::effective_agent_api_key(config)).await
}

pub(crate) async fn read_remote_yaml(config: &GuiConfigFile) -> Result<String, String> {
    let response = crate::management_api::management_http_client_for(config)?
        .get(crate::management_api::management_endpoint(config, "config.yaml")?)
        .header("Authorization", crate::management_api::management_authorization(config)?)
        .send().await.map_err(|_| "Failed to read remote configuration".to_string())?;
    crate::management_api::read_management_text(response).await
}

struct RemoteConfigChange {
    path: Vec<String>,
    before: Option<serde_json::Value>,
    after: Option<serde_json::Value>,
}

fn remote_config_changes(
    path: &[String], before: Option<&serde_json::Value>, after: Option<&serde_json::Value>,
    changes: &mut Vec<RemoteConfigChange>,
) {
    if before == after { return; }
    if let (Some(serde_json::Value::Object(before)), Some(serde_json::Value::Object(after))) = (before, after) {
        let keys = before.keys().chain(after.keys()).collect::<std::collections::BTreeSet<_>>();
        for key in keys {
            let mut child = path.to_vec(); child.push(key.clone());
            remote_config_changes(&child, before.get(key), after.get(key), changes);
        }
    } else {
        changes.push(RemoteConfigChange { path: path.to_vec(), before: before.cloned(), after: after.cloned() });
    }
}

fn remote_config_json(content: &str) -> Result<serde_json::Value, String> {
    serde_norway::from_str(content).map_err(|_| "Invalid remote configuration document".to_string())
}

fn config_path_value<'a>(document: &'a serde_json::Value, path: &[String]) -> Option<&'a serde_json::Value> {
    path.iter().try_fold(document, |node, key| node.as_object()?.get(key))
}

// v8.0.29 has no ETag/If-Match contract. One preflight read checks every changed
// field before the first write, but cannot make the read/write pair atomic, and a
// change by another client during the batch is not detected. Replace only changed
// values; never replay a failed write or roll back over another client's changes.
pub(crate) async fn write_remote_yaml(
    state: &GuiConfigState, config: &GuiConfigFile, original: &str, updated: &str,
) -> Result<(), String> {
    write_remote_yaml_batch(state, config, original, updated, true).await
}

// For callers whose `original` is itself a read made immediately before this call,
// so a preflight read would only repeat it; the writer then sends only the N writes.
pub(crate) async fn write_remote_yaml_after_fresh_read(
    state: &GuiConfigState, config: &GuiConfigFile, fresh: &str, updated: &str,
) -> Result<(), String> {
    write_remote_yaml_batch(state, config, fresh, updated, false).await
}

async fn write_remote_yaml_batch(
    state: &GuiConfigState, config: &GuiConfigFile, original: &str, updated: &str, preflight: bool,
) -> Result<(), String> {
    let before = remote_config_json(original)?;
    let after = remote_config_json(updated)?;
    let mut changes = Vec::new();
    remote_config_changes(&[], Some(&before), Some(&after), &mut changes);
    for change in &changes {
        if change.path.is_empty() || change.path.iter().any(|key| key.is_empty() || key.contains(['/', '\\', '?', '#', '%']) || key.chars().any(char::is_control)) {
            return Err("Remote configuration field cannot be addressed safely".to_string());
        }
    }
    let total = changes.len();
    let stopped = |completed: usize, error: String| {
        let confirmed = changes[..completed].iter().map(|change| change.path.join("/")).collect::<Vec<_>>();
        let confirmed = if confirmed.is_empty() { "none".to_string() } else { confirmed.join(", ") };
        format!("Remote configuration save stopped after {completed} of {total} confirmed changes; some changes may have applied. Reload before editing. Confirmed: {confirmed}. {error}")
    };
    if preflight && total > 0 {
        let check = async {
            state.ensure_target(config)?;
            let current = remote_config_json(&read_remote_yaml(config).await?)?;
            if changes.iter().any(|change| config_path_value(&current, &change.path) != change.before.as_ref()) {
                return Err("Remote configuration changed; reload before saving".to_string());
            }
            Ok(())
        }.await;
        check.map_err(|error| stopped(0, error))?;
    }
    for (completed, change) in changes.iter().enumerate() {
        let apply = async {
            state.ensure_target(config)?;
            let endpoint = crate::management_api::management_endpoint(config, &format!("config/{}", change.path.join("/")))?;
            let client = crate::management_api::management_http_client_for(config)?;
            let request = match &change.after {
                Some(value) => client.put(endpoint).json(value),
                None => client.delete(endpoint),
            };
            let response = request.header("Authorization", crate::management_api::management_authorization(config)?)
                .send().await.map_err(|_| "Remote write outcome is unknown; reload before any further edit".to_string())?;
            crate::management_api::read_management_text(response).await?;
            state.ensure_target(config)
        }.await;
        apply.map_err(|error| stopped(completed, error))?;
    }
    Ok(())
}

#[cfg(test)]
mod portable_tests {
    use super::*;
    use std::env;
    #[test]
    fn portable_file_overwrite_is_atomic_and_private() {
        let directory = env::temp_dir().join(format!("easycli-portable-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("connection.json");
        write_portable_connection(&path, b"first").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        write_portable_connection(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second\n");
        assert!(write_portable_connection(&directory, b"invalid").is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            let link = directory.join("link.json");
            symlink(&path, &link).unwrap();
            assert!(write_portable_connection(&link, b"invalid").is_err());
            assert!(import_core_connection(link.to_str().unwrap().into()).is_err());
            assert_eq!(fs::read(&path).unwrap(), b"second\n");
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn portable_connection_export_excludes_secrets_by_default_and_round_trips_when_present() {
        let connection = CoreConnection {
            mode: CoreConnectionMode::Remote,
            management_origin: "https://core.example".into(),
            management_key: "management-secret".into(),
            client_origin: "https://client.example".into(),
            client_key: "client-secret".into(),
        };
        let safe = serde_json::to_string(&PortableConnectionFile::from_connection(&connection, false)).unwrap();
        assert!(!safe.contains("management-secret"));
        assert!(!safe.contains("client-secret"));
        let without = PortableConnectionFile::from_connection(&connection, false).into_connection().unwrap();
        assert!(without.management_key.is_empty());
        assert!(without.client_key.is_empty());
        assert_eq!(without.client_origin, connection.client_origin);
        let with = PortableConnectionFile::from_connection(&connection, true).into_connection().unwrap();
        assert!(with == connection);
    }

    #[test]
    fn portable_connection_rejects_unknown_format_and_relative_paths() {
        let bad = r#"{"format":"other","version":1,"connection":{"mode":"remote","managementOrigin":"https://core.example","clientOrigin":""}}"#;
        let parsed: PortableConnectionFile = serde_json::from_str(bad).unwrap();
        assert!(parsed.into_connection().is_err());
        assert!(portable_path("connection.json").is_err());
        assert!(portable_path("/tmp/../connection.json").is_err());
    }

    #[test]
    fn portable_connection_validates_format_origins_credentials_and_size() {
        let valid = serde_json::json!({
            "format": PORTABLE_CONNECTION_FORMAT, "version": 1,
            "connection": {"mode": "remote", "managementOrigin": "https://core.example", "clientOrigin": "https://client.example"}
        });
        for (field, value) in [
            ("format", serde_json::json!("other")),
            ("version", serde_json::json!(2)),
        ] {
            let mut document = valid.clone(); document[field] = value;
            assert!(serde_json::from_value::<PortableConnectionFile>(document).unwrap().into_connection().is_err());
        }
        for (field, value) in [
            ("mode", "local"), ("managementOrigin", "https://core.example/v1"),
            ("managementOrigin", "https://user:secret@core.example"),
            ("managementOrigin", "https://core.example?key=secret"),
            ("managementOrigin", "https://core.ex\nample"),
            ("clientOrigin", ""), ("clientOrigin", "file:///tmp/core"),
            ("clientOrigin", "https://client.example/#fragment"),
            ("managementKey", "bad\nkey"), ("clientKey", "bad\tkey"),
        ] {
            let mut document = valid.clone(); document["connection"][field] = serde_json::json!(value);
            assert!(serde_json::from_value::<PortableConnectionFile>(document).unwrap().into_connection().is_err(), "{field}");
        }
        let directory = env::temp_dir().join(format!("easycli-portable-size-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("connection.json");
        fs::write(&path, serde_json::to_vec(&valid).unwrap()).unwrap();
        let imported = import_core_connection(path.to_str().unwrap().into()).unwrap();
        assert!(imported.management_key.is_empty());
        assert!(imported.client_key.is_empty());
        assert!(normalized_connection(imported).is_err()); // Saving still requires a management key.
        fs::write(&path, vec![b' '; MAX_PORTABLE_FILE_BYTES as usize + 1]).unwrap();
        assert!(matches!(import_core_connection(path.to_str().unwrap().into()), Err(error) if error.contains("too large")));
        fs::write(&path, b"not JSON").unwrap();
        assert!(import_core_connection(path.to_str().unwrap().into()).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

}
