use crate::{core_origin, current_core_tls_settings, GuiConfigFile, GuiConfigState, CoreConnectionMode, CoreStatus};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::Emitter;

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
    use tauri::Manager;
    if connection.mode == CoreConnectionMode::Remote {
        let process = app.state::<crate::CoreProcessState>();
        let mut child = process.child.lock().map_err(|_| "Core process lock is poisoned".to_string())?;
        if let Some(owned) = child.as_mut() {
            if owned.try_wait().map_err(|_| "Unable to inspect the local core process".to_string())?.is_none() {
                return Err("Stop the GUI-managed local core before switching to Remote; its lifetime is tied to this application".to_string());
            }
            *child = None;
        }
        process.clear_adopted_processes()?;
    }
    let config = {
        let mut current = gui_config_state.inner.lock().map_err(|_| "GUI configuration lock is poisoned".to_string())?;
        let mut config = current.clone();
        config.connection_mode = connection.mode;
        config.target_revision = config.target_revision.wrapping_add(1);
        if connection.mode == CoreConnectionMode::Remote {
            config.remote_management_origin = connection.management_origin.clone();
            config.remote_management_key = connection.management_key.clone();
            config.remote_client_origin = connection.client_origin.clone();
            config.remote_client_key = connection.client_key.clone();
        }
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
    app.state::<crate::AgentConfigStatusCache>().clear()?;
    app.state::<crate::CoreProcessState>().set_starting(false);
    let _ = app.emit(CONNECTION_CHANGED_EVENT, ConnectionChangedPayload { revision: config.target_revision });
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
    }
}

pub(crate) fn require_local(config: &GuiConfigFile) -> Result<(), String> {
    if config.connection_mode == CoreConnectionMode::Remote {
        Err("This operation is only available for the local core".to_string())
    } else { Ok(()) }
}

pub(crate) async fn fetch_client_models(config: &GuiConfigFile) -> Result<serde_json::Value, String> {
    let connection = connection_from_config(config)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .danger_accept_invalid_certs(connection.mode == CoreConnectionMode::Local)
        .build().map_err(|_| "Failed to create core model client".to_string())?;
    let mut request = client.get(format!("{}/v1/models", connection.client_origin));
    if !connection.client_key.is_empty() { request = request.bearer_auth(connection.client_key); }
    let response = request.send().await.map_err(|_| "Failed to query core models".to_string())?;
    if !response.status().is_success() {
        return Err(format!("Core model request failed (HTTP {})", response.status().as_u16()));
    }
    response.json().await.map_err(|_| "Core returned an invalid model catalog".to_string())
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

// v8.0.29 has no ETag/If-Match contract. Preflight detects observed conflicts,
// but cannot make the read/write pair atomic. Replace only changed values; never
// replay a failed write or roll back over another management client's changes.
pub(crate) async fn write_remote_yaml(
    state: &GuiConfigState, config: &GuiConfigFile, original: &str, updated: &str,
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
    for (completed, change) in changes.iter().enumerate() {
        let apply = async {
            state.ensure_target(config)?;
            let current = remote_config_json(&read_remote_yaml(config).await?)?;
            if config_path_value(&current, &change.path) != change.before.as_ref() {
                return Err("Remote configuration changed; reload before saving".to_string());
            }
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
        if let Err(error) = apply {
            return Err(format!("Remote configuration save stopped after {completed} of {total} confirmed changes; some changes may have applied. Reload before editing. {error}"));
        }
    }
    Ok(())
}
