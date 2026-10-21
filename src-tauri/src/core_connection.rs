use crate::{CoreConnectionMode, CoreStatus, GuiConfigFile, GuiConfigState};
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreConnection {
    pub(crate) mode: CoreConnectionMode,
    pub(crate) management_origin: String,
    pub(crate) management_key: String,
}

impl From<&GuiConfigFile> for CoreConnection {
    fn from(config: &GuiConfigFile) -> Self {
        Self {
            mode: config.connection_mode,
            management_origin: config.remote_management_origin.clone(),
            management_key: config.remote_management_key.clone(),
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
    Ok(connection)
}

pub(crate) fn require_local(config: &GuiConfigFile) -> Result<(), String> {
    if config.connection_mode == CoreConnectionMode::Remote {
        Err("This operation is only available for the local core".into())
    } else {
        Ok(())
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
    let process = app.state::<crate::CoreProcessState>();
    let _operation = crate::lock_core_operation(process.inner())?;
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
    let connection = normalize_connection(connection)?;
    let config = GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: connection.management_origin,
        remote_management_key: connection.management_key,
        ..GuiConfigFile::default()
    };
    let response = crate::management_api::management_http_client_for(&config)?
        .get(crate::management_api::management_endpoint(
            &config, "config",
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
                    value
                        .get("config-version")
                        .and_then(serde_json::Value::as_u64)
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
    }
}
