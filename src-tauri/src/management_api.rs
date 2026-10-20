#[cfg(target_os = "windows")]
use super::windows_explorer_executable;
use super::{
    auth_dir_path_for_core, configure_background_command, core_install_dir, core_logs_dir_path,
    core_origin, current_core_tls_settings, is_hashed_management_secret_key, open_oauth_url_inner,
    path_to_string, GuiConfigFile, GuiConfigState, MAX_OAUTH_SESSION_TTL,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    error::Error,
    fs,
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, LazyLock, Mutex, Weak,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

static REQUESTS: LazyLock<Mutex<HashMap<String, CancellationToken>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
static MANAGEMENT_CLIENTS: LazyLock<Mutex<HashMap<ManagementClientKey, CachedManagementClient>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static RUNTIME_TOKENS: LazyLock<Mutex<HashMap<tokio::runtime::Id, Weak<RuntimeToken>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_RUNTIME_GENERATION: AtomicU64 = AtomicU64::new(1);
static NEXT_CLIENT_ACCESS: AtomicU64 = AtomicU64::new(1);
const MAX_MANAGEMENT_CLIENTS: usize = 8;
// Keep this aligned with PLUGIN_SESSION_MAX_MS and MAX_SESSION_MS (30 minutes).
const DEFAULT_OAUTH_SESSION_TTL: Duration = Duration::from_secs(30 * 60);

struct RuntimeToken {
    generation: u64,
}

struct CachedManagementClient {
    client: Arc<reqwest::Client>,
    last_used: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ManagementClientKey {
    origin: String,
    accept_invalid_certs: bool,
    tls_cert: Option<String>,
    tls_key: Option<String>,
    runtime_generation: u64,
}

// Reserve before sending so cancellation also works before the HTTP request starts.
#[tauri::command]
pub(crate) fn prepare_management_request() -> Result<String, String> {
    let mut requests = REQUESTS
        .lock()
        .map_err(|_| "Request registry unavailable")?;
    if requests.len() >= 256 {
        return Err("Too many pending management requests".into());
    }
    let id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed).to_string();
    requests.insert(id.clone(), CancellationToken::new());
    Ok(id)
}

#[tauri::command]
pub(crate) fn cancel_management_request(request_id: String) -> Result<(), String> {
    if let Some(token) = REQUESTS
        .lock()
        .map_err(|_| "Request registry unavailable")?
        .remove(&request_id)
    {
        token.cancel();
    }
    Ok(())
}

struct RequestCleanup(String);
impl Drop for RequestCleanup {
    fn drop(&mut self) {
        if let Ok(mut requests) = REQUESTS.lock() {
            requests.remove(&self.0);
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OAuthStartResult {
    url: String,
    state: Option<String>,
    user_code: Option<String>,
    flow: Option<String>,
    expires_in: Option<u64>,
    opened: bool,
    open_error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OAuthStatusResult {
    status: String,
    error: Option<String>,
}

#[derive(Deserialize)]
struct OAuthStartApiResponse {
    url: Option<String>,
    state: Option<String>,
    user_code: Option<String>,
    flow: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    #[serde(rename = "error_message")]
    error_message: Option<String>,
}

#[derive(Deserialize)]
struct OAuthStatusApiResponse {
    status: Option<String>,
    error: Option<String>,
    #[serde(rename = "error_message")]
    error_message: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagementRequest {
    request_id: Option<String>,
    method: String,
    path: String,
    query: Option<HashMap<String, String>>,
    #[serde(default, deserialize_with = "deserialize_management_body")]
    body: Option<serde_json::Value>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    expected_revision: u64,
}

fn deserialize_management_body<'de, D>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // An explicit v8 null is a JSON value, not an omitted request body.
    serde_json::Value::deserialize(deserializer).map(Some)
}

#[tauri::command]
pub(crate) async fn management_request(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    request: ManagementRequest,
) -> Result<serde_json::Value, String> {
    management_request_for_target(&gui_config_state, request).await
}

async fn management_request_for_target(
    gui_config_state: &GuiConfigState,
    request: ManagementRequest,
) -> Result<serde_json::Value, String> {
    let id = request.request_id.clone();
    cancellable_management_request(id, management_request_inner(gui_config_state, request)).await
}

async fn cancellable_management_request(
    request_id: Option<String>,
    operation: impl std::future::Future<Output = Result<serde_json::Value, String>>,
) -> Result<serde_json::Value, String> {
    let cancellation = if let Some(id) = &request_id {
        let token = REQUESTS
            .lock()
            .map_err(|_| "Request registry unavailable")?
            .get(id)
            .cloned()
            .ok_or("Management API request cancelled")?;
        Some((token, RequestCleanup(id.clone())))
    } else {
        None
    };
    if let Some((token, _cleanup)) = cancellation {
        tokio::select! {
            biased;
            _ = token.cancelled() => Err("Management API request cancelled".into()),
            result = operation => result,
        }
    } else {
        operation.await
    }
}

async fn management_request_inner(
    gui_config_state: &GuiConfigState,
    request: ManagementRequest,
) -> Result<serde_json::Value, String> {
    let config = gui_config_state.snapshot()?;
    if request.expected_revision != config.target_revision {
        return Err("The core connection changed; request cancelled".to_string());
    }
    let target_operation = gui_config_state.target_operation.lock().await;
    gui_config_state.ensure_target(&config)?;
    let method = match request.method.trim().to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Unsupported management API request method".to_string()),
    };
    let path = request.path.trim();
    if path.is_empty() || path.contains("://") || path.contains("..")
        || path.contains(['\\', '?', '#']) || path.to_ascii_lowercase().contains("%2e")
        || path.chars().any(char::is_control)
    {
        return Err("Invalid management API path".to_string());
    }
    let read_only = is_read_only_request(&method, path);

    let oauth_state = match (method.as_str(), path.trim_start_matches('/')) {
        ("GET", "oauth/status") | ("DELETE", "oauth/session") => {
            let state = request.query.as_ref().and_then(|query| query.get("state"))
                .ok_or("OAuth request is missing state")?;
            ensure_oauth_target(gui_config_state, &config, state)?;
            Some(state.clone())
        }
        ("POST", "oauth/callback") => {
            let url = request.body.as_ref().and_then(|body| body.get("redirect_url"))
                .and_then(serde_json::Value::as_str).ok_or("OAuth callback is missing redirect_url")?;
            let state = oauth_callback_state(url)?;
            ensure_oauth_target(gui_config_state, &config, &state)?;
            Some(state)
        }
        _ => None
    };
    let terminal_oauth_request = method == reqwest::Method::DELETE && path.trim_start_matches('/') == "oauth/session";
    let client = management_http_client_for(&config)?;
    let mut builder = client
        .request(method, management_endpoint(&config, path)?)
        .header("Authorization", management_authorization(&config)?);
    if let Some(timeout_ms) = request.timeout_ms {
        builder = builder.timeout(Duration::from_millis(timeout_ms.clamp(1_000, 120_000)));
    }
    if let Some(query) = request.query {
        builder = builder.query(&query);
    }
    if let Some(body) = request.body {
        builder = management_request_body(builder, path, body)?;
    }

    // Reads only hold the fence while the target is validated and the request built: a slow
    // upstream call must not stall other management traffic, connection saves or crash recovery.
    // A target change during the call is caught by the revision re-check below. Writes keep the
    // fence so a switch waits for them and they reach the core in submission order.
    let _write_fence = if read_only {
        drop(target_operation);
        None
    } else {
        Some(target_operation)
    };
    let response = builder
        .send()
        .await
        .map_err(|err| format_management_request_error("Management API request failed", &err))?;
    let value = read_management_value(response).await;
    gui_config_state.ensure_target(&config)?;
    let value = value?;
    if terminal_oauth_request && value.get("status").and_then(serde_json::Value::as_str) == Some("ok") {
        if let Some(state) = oauth_state {
            forget_oauth_session(gui_config_state, &state)?;
        }
    }
    Ok(value)
}

// `requests/api-call` is the core's proxy to a provider's own API (quota, model lists): it
// changes nothing in the core, so it is treated like a read.
fn is_read_only_request(method: &reqwest::Method, path: &str) -> bool {
    *method == reqwest::Method::GET
        || (*method == reqwest::Method::POST && path.trim_start_matches('/') == "requests/api-call")
}

fn management_request_body(
    builder: reqwest::RequestBuilder,
    path: &str,
    body: serde_json::Value,
) -> Result<reqwest::RequestBuilder, String> {
    if path.trim_start_matches('/') == "config.yaml" {
        let yaml = body.as_str().ok_or("YAML configuration must be text")?;
        Ok(builder
            .header("Content-Type", "application/yaml")
            .body(yaml.to_owned()))
    } else {
        Ok(builder.json(&body))
    }
}

#[tauri::command]
pub(crate) async fn import_vertex_credential(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    name: String,
    data: Vec<u8>,
    location: Option<String>,
    expected_revision: u64,
) -> Result<serde_json::Value, String> {
    import_vertex_credential_for_target(&gui_config_state, name, data, location, expected_revision).await
}

async fn import_vertex_credential_for_target(
    gui_config_state: &GuiConfigState,
    name: String,
    data: Vec<u8>,
    location: Option<String>,
    expected_revision: u64,
) -> Result<serde_json::Value, String> {
    let name = name.trim();
    if name.is_empty() || !name.to_ascii_lowercase().ends_with(".json") {
        return Err("Credential filename must end with .json".to_string());
    }
    let config = gui_config_state.snapshot()?;
    let _target_operation = gui_config_state.target_operation.lock().await;
    if config.target_revision != expected_revision {
        return Err("Core connection changed; upload cancelled".to_string());
    }
    gui_config_state.ensure_target(&config)?;
    let part = reqwest::multipart::Part::bytes(data)
        .file_name(name.to_owned())
        .mime_str("application/json")
        .map_err(|error| error.to_string())?;
    let mut form = reqwest::multipart::Form::new().part("file", part);
    if let Some(location) = location.filter(|value| !value.trim().is_empty()) {
        form = form.text("location", location.trim().to_owned());
    }
    let response = management_http_client_for(&config)?
        .post(management_endpoint(&config, "oauth/import")?)
        .header("Authorization", management_authorization(&config)?)
        .query(&[("provider", "vertex")])
        .multipart(form)
        .send()
        .await
        .map_err(|error| format_management_request_error("Failed to import Vertex credential", &error))?;
    let value = read_management_value(response).await;
    gui_config_state.ensure_target(&config)?;
    value
}

#[tauri::command]
pub(crate) fn get_management_target_revision(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<u64, String> {
    Ok(gui_config_state.snapshot()?.target_revision)
}

#[tauri::command]
pub(crate) async fn upload_auth_file(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    name: String,
    data: Vec<u8>,
    expected_revision: u64,
) -> Result<serde_json::Value, String> {
    upload_auth_file_for_target(&gui_config_state, name, data, expected_revision).await
}

async fn upload_auth_file_for_target(
    gui_config_state: &GuiConfigState,
    name: String,
    data: Vec<u8>,
    expected_revision: u64,
) -> Result<serde_json::Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() || !name.to_ascii_lowercase().ends_with(".json") {
        return Err("Credential filename must end with .json".to_string());
    }

    let config = gui_config_state.snapshot()?;
    let _target_operation = gui_config_state.target_operation.lock().await;
    if config.target_revision != expected_revision {
        return Err("Core connection changed; upload cancelled".to_string());
    }
    gui_config_state.ensure_target(&config)?;
    let client = management_http_client_for(&config)?;
    let mut query = HashMap::new();
    query.insert("name".to_string(), name);
    let response = client
        .post(management_endpoint(&config, "credentials")?)
        .header("Authorization", management_authorization(&config)?)
        .query(&query)
        .header("Content-Type", "application/json")
        .body(data)
        .send()
        .await
        .map_err(|err| format_management_request_error("Failed to upload credential file", &err))?;
    let value = read_management_value(response).await;
    gui_config_state.ensure_target(&config)?;
    value
}

#[tauri::command]
pub(crate) fn open_auth_files_directory(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<(), String> {
    let _operation = super::CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    let config = gui_config_state.snapshot()?;
    super::core_connection::require_local(&config)?;
    let install_dir = core_install_dir()?;
    let auth_dir = auth_dir_path_for_core(&config.auth_dir, &install_dir)?;
    fs::create_dir_all(&auth_dir)
        .map_err(|error| format!("Failed to create credentials directory {}: {error}", path_to_string(&auth_dir)))?;
    open_directory_in_file_manager(&auth_dir)
}

#[tauri::command]
pub(crate) fn open_core_logs_directory(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<(), String> {
    let _operation = super::CORE_OPERATION_LOCK.lock().map_err(|_| "Core operation lock is poisoned".to_string())?;
    let config = gui_config_state.snapshot()?;
    super::core_connection::require_local(&config)?;
    let install_dir = core_install_dir()?;
    let logs_dir = core_logs_dir_path(&config.auth_dir, &install_dir)?;
    fs::create_dir_all(&logs_dir)
        .map_err(|error| format!("Failed to create log directory {}: {error}", path_to_string(&logs_dir)))?;

    open_directory_in_file_manager(&logs_dir)
}

fn open_directory_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = Command::new(windows_explorer_executable());
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command.arg(path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_background_command(&mut command);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to open directory {}: {error}", path_to_string(path)))
}

#[tauri::command]
pub(crate) async fn start_oauth_login(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    provider: String,
    browser: Option<String>,
    plugin_provider: Option<bool>,
    expected_revision: u64,
) -> Result<OAuthStartResult, String> {
    let config = gui_config_state.snapshot()?;
    if config.target_revision != expected_revision {
        return Err("The core connection changed; request cancelled".to_string());
    }
    let _target_operation = gui_config_state.target_operation.lock().await;
    gui_config_state.ensure_target(&config)?;
    if config.connection_mode == super::CoreConnectionMode::Local {
        super::network_proxy::prepare_oauth(&app).await;
    }
    let provider_key = normalize_oauth_request_provider(&provider, plugin_provider.unwrap_or(false))?;
    let client = management_http_client_for(&config)?;
    let mut request = client
        .get(management_endpoint(&config, "oauth/auth-url")?)
        .header("Authorization", management_authorization(&config)?);
    request = request.query(&[("provider", provider_key.as_str())]);
    if management_oauth_uses_webui_callback(&provider_key) {
        request = request.query(&[("is_webui", "true")]);
    }
    let response = request
        .send()
        .await
        .map_err(|err| format_management_request_error("Failed to request OAuth login URL", &err))?;
    let payload = read_management_json::<OAuthStartApiResponse>(response).await?;
    if config.connection_mode == super::CoreConnectionMode::Remote && (payload.error.is_some() || payload.error_message.is_some()) {
        return Err("Remote core could not start OAuth authorization".to_string());
    }
    gui_config_state.ensure_target(&config)?;
    let mut result = normalize_oauth_start_response(payload)?;
    if let Some(state) = &result.state {
        let ttl = oauth_session_ttl(result.expires_in);
        gui_config_state.oauth_sessions.lock().map_err(|_| "OAuth session lock is poisoned".to_string())?
            .insert(state.clone(), config.target_revision, ttl, std::time::Instant::now())?;
    }
    match open_oauth_url_inner(&app, &result.url, browser.as_deref()) {
        Ok(()) => result.opened = true,
        Err(error) => result.open_error = Some(error),
    }
    Ok(result)
}

fn normalize_oauth_start_response(payload: OAuthStartApiResponse) -> Result<OAuthStartResult, String> {
    if let Some(error) = payload
        .error
        .or(payload.error_message)
        .filter(|value| !value.trim().is_empty())
    {
        return Err(error);
    }
    let url = payload
        .url
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Kernel did not return an OAuth login URL".to_string())?;
    let state = payload
        .state
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    Ok(OAuthStartResult {
        url,
        state,
        user_code: payload
            .user_code
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        flow: payload
            .flow
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty()),
        expires_in: payload.expires_in.filter(|value| *value > 0),
        opened: false,
        open_error: None,
    })
}

#[tauri::command]
pub(crate) async fn get_oauth_status(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    state: String,
    expected_revision: u64,
) -> Result<OAuthStatusResult, String> {
    let state = state.trim().to_string();
    if state.is_empty() {
        return Err("OAuth state cannot be empty".to_string());
    }
    let config = gui_config_state.snapshot()?;
    if config.target_revision != expected_revision {
        return Err("The core connection changed; request cancelled".to_string());
    }
    // Polled every few seconds: the fence only validates the target; the request runs unlocked.
    let request = {
        let _target_operation = gui_config_state.target_operation.lock().await;
        gui_config_state.ensure_target(&config)?;
        ensure_oauth_target(&gui_config_state, &config, &state)?;
        management_http_client_for(&config)?
            .get(management_endpoint(&config, "oauth/status")?)
            .header("Authorization", management_authorization(&config)?)
            .query(&[("state", state.as_str())])
    };
    let response = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            forget_oauth_session(&gui_config_state, &state)?;
            return Err(format_management_request_error("Failed to query OAuth status", &err));
        }
    };
    let payload = match read_management_json::<OAuthStatusApiResponse>(response).await {
        Ok(payload) => payload,
        Err(error) => {
            forget_oauth_session(&gui_config_state, &state)?;
            return Err(error);
        }
    };
    gui_config_state.ensure_target(&config)?;
    let status = payload
        .status
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "wait".to_string());
    if status != "wait" || payload.error.is_some() || payload.error_message.is_some() {
        forget_oauth_session(&gui_config_state, &state)?;
    }
    Ok(OAuthStatusResult {
        status,
        error: payload
            .error
            .or(payload.error_message)
            .map(|value| if config.connection_mode == super::CoreConnectionMode::Remote { "Remote OAuth authorization failed; start authorization again".to_string() } else { value.trim().to_string() })
            .filter(|value| !value.is_empty()),
    })
}

#[tauri::command]
pub(crate) async fn submit_oauth_callback(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    provider: String,
    redirect_url: String,
    plugin_provider: Option<bool>,
    expected_revision: u64,
) -> Result<(), String> {
    let redirect_url = redirect_url.trim().to_string();
    if redirect_url.is_empty() {
        return Err("Callback URL cannot be empty".to_string());
    }
    let config = gui_config_state.snapshot()?;
    if config.target_revision != expected_revision {
        return Err("The core connection changed; request cancelled".to_string());
    }
    let callback_state = oauth_callback_state(&redirect_url)?;
    let _target_operation = gui_config_state.target_operation.lock().await;
    gui_config_state.ensure_target(&config)?;
    ensure_oauth_target(&gui_config_state, &config, &callback_state)?;
    let provider_key = normalize_oauth_request_provider(&provider, plugin_provider.unwrap_or(false))?;
    let client = management_http_client_for(&config)?;
    let body = serde_json::json!({
        "provider": provider_key,
        "redirect_url": redirect_url,
    });
    let response = match client
        .post(management_endpoint(&config, "oauth/callback")?)
        .header("Authorization", management_authorization(&config)?)
        .json(&body)
        .send()
        .await {
        Ok(response) => response,
        Err(err) => {
            return Err(format_management_request_error("Failed to submit OAuth callback", &err));
        }
    };
    let status = response.status();
    let text = match response.text().await {
        Ok(text) => text,
        Err(err) => {
            return Err(format_management_request_error("Failed to read OAuth callback response", &err));
        }
    };
    gui_config_state.ensure_target(&config)?;
    forget_oauth_callback_if_terminal(&gui_config_state, &callback_state, status)?;
    if !status.is_success() {
        return Err(format_management_error(status.as_u16(), &text));
    }
    Ok(())
}

pub(crate) fn management_http_client_for(config: &GuiConfigFile) -> Result<reqwest::Client, String> {
    let tls_settings = (config.connection_mode == super::CoreConnectionMode::Local)
        .then(current_core_tls_settings)
        .transpose()?;
    management_http_client_for_with_tls_settings(config, tls_settings.as_ref())
}

fn management_http_client_for_with_tls_settings(
    config: &GuiConfigFile,
    tls_settings: Option<&super::CoreTlsSettings>,
) -> Result<reqwest::Client, String> {
    let origin = if config.connection_mode == super::CoreConnectionMode::Local {
        core_origin(
            &config.host,
            config.port,
            tls_settings.is_some_and(|settings| settings.enabled),
        )
    } else {
        // Client construction historically did not validate a Remote target. Keep that
        // behavior for onboarding and partial configurations; endpoint resolution owns
        // target validation before any request is sent.
        config.remote_management_origin.clone()
    };
    let accept_invalid_certs = tls_settings.as_ref().is_some_and(|settings| settings.enabled);
    cached_management_http_client(
        &origin,
        accept_invalid_certs,
        tls_settings.as_ref().map(|settings| settings.cert.clone()),
        tls_settings.as_ref().map(|settings| settings.key.clone()),
    )
        .map(|client| (*client).clone())
}

fn cached_management_http_client(
    origin: &str,
    accept_invalid_certs: bool,
    tls_cert: Option<String>,
    tls_key: Option<String>,
) -> Result<Arc<reqwest::Client>, String> {
    let Ok(parsed) = reqwest::Url::parse(origin) else {
        return build_management_http_client(accept_invalid_certs).map(Arc::new);
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return build_management_http_client(accept_invalid_certs).map(Arc::new);
    }
    // reqwest's connection pool is tied to the runtime that first drives it. Do not
    // share a pooled client across Tauri/test runtimes, which may be shut down separately.
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return build_management_http_client(accept_invalid_certs).map(Arc::new);
    };
    let runtime_generation = runtime_generation(&runtime)?;
    let key = ManagementClientKey {
        origin: parsed.origin().ascii_serialization(),
        accept_invalid_certs,
        tls_cert,
        tls_key,
        runtime_generation,
    };
    let mut clients = MANAGEMENT_CLIENTS
        .lock()
        .map_err(|_| "Management client cache unavailable".to_string())?;
    let access = NEXT_CLIENT_ACCESS.fetch_add(1, Ordering::Relaxed);
    if let Some(entry) = clients.get_mut(&key) {
        entry.last_used = access;
        return Ok(Arc::clone(&entry.client));
    }
    let client = build_management_http_client(accept_invalid_certs)?;
    let client = Arc::new(client);
    evict_oldest_management_client_if_full(&mut clients);
    clients.insert(
        key,
        CachedManagementClient {
            client: Arc::clone(&client),
            last_used: access,
        },
    );
    Ok(client)
}

fn evict_oldest_management_client_if_full(
    clients: &mut HashMap<ManagementClientKey, CachedManagementClient>,
) {
    if clients.len() < MAX_MANAGEMENT_CLIENTS {
        return;
    }
    if let Some(oldest_key) = clients
        .iter()
        .min_by_key(|(_, entry)| entry.last_used)
        .map(|(key, _)| key.clone())
    {
        clients.remove(&oldest_key);
    }
}

fn runtime_generation(runtime: &tokio::runtime::Handle) -> Result<u64, String> {
    let (token, is_new) = runtime_token_for_id(runtime.id())?;
    let generation = token.generation;
    if is_new {
        // Keep a strong token alive until this runtime drops its async tasks.
        drop(runtime.spawn(async move {
            let _token = token;
            std::future::pending::<()>().await;
        }));
    }
    Ok(generation)
}

fn runtime_token_for_id(
    runtime_id: tokio::runtime::Id,
) -> Result<(Arc<RuntimeToken>, bool), String> {
    let mut tokens = RUNTIME_TOKENS
        .lock()
        .map_err(|_| "Management runtime registry unavailable".to_string())?;
    tokens.retain(|_, token| token.strong_count() > 0);
    if let Some(token) = tokens.get(&runtime_id).and_then(Weak::upgrade) {
        return Ok((token, false));
    }

    let generation = NEXT_RUNTIME_GENERATION.fetch_add(1, Ordering::Relaxed);
    let token = Arc::new(RuntimeToken { generation });
    tokens.insert(runtime_id, Arc::downgrade(&token));
    Ok((token, true))
}

fn build_management_http_client(accept_invalid_certs: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(accept_invalid_certs)
        .build()
        .map_err(|_| "Failed to create management client".to_string())
}

fn oauth_callback_state(redirect_url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(redirect_url).map_err(|_| "Invalid OAuth callback URL".to_string())?;
    let states: Vec<_> = parsed.query_pairs().filter(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned()).collect();
    if states.len() != 1 || states[0].trim().is_empty() {
        return Err("OAuth callback URL must contain exactly one state".to_string());
    }
    Ok(states.into_iter().next().unwrap())
}

fn ensure_oauth_target(state: &GuiConfigState, config: &GuiConfigFile, oauth_state: &str) -> Result<(), String> {
    let mut sessions = state.oauth_sessions.lock().map_err(|_| "OAuth session lock is poisoned".to_string())?;
    if !sessions.contains_for_revision(oauth_state, config.target_revision, std::time::Instant::now()) {
        return Err("OAuth session belongs to a different or expired core connection; start login again".to_string());
    }
    Ok(())
}

fn oauth_session_ttl(expires_in: Option<u64>) -> Duration {
    Duration::from_secs(
        expires_in
            .filter(|seconds| *seconds > 0)
            .unwrap_or(DEFAULT_OAUTH_SESSION_TTL.as_secs())
            .min(MAX_OAUTH_SESSION_TTL.as_secs()),
    )
}

fn forget_oauth_session(state: &GuiConfigState, oauth_state: &str) -> Result<(), String> {
    state.oauth_sessions.lock().map_err(|_| "OAuth session lock is poisoned".to_string())?.remove(oauth_state);
    Ok(())
}

fn forget_oauth_callback_if_terminal(
    state: &GuiConfigState,
    oauth_state: &str,
    status: reqwest::StatusCode,
) -> Result<(), String> {
    if status.is_success()
        || matches!(status, reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::CONFLICT | reqwest::StatusCode::GONE)
    {
        forget_oauth_session(state, oauth_state)?;
    }
    Ok(())
}

pub(crate) fn format_management_request_error(
    action: &str,
    error: &(dyn Error + 'static),
) -> String {
    if let Some(error) = error.downcast_ref::<reqwest::Error>() {
        if error.is_timeout() { return format!("{action}: request timed out"); }
        if error.is_connect() { return format!("{action}: could not connect to the core"); }
    }
    action.to_string()
}

pub(crate) fn management_plaintext_key(config: &GuiConfigFile) -> Result<&str, String> {
    let secret_key = if config.connection_mode == super::CoreConnectionMode::Remote { config.remote_management_key.trim() } else { config.management_secret_key.trim() };
    if secret_key.is_empty() || is_hashed_management_secret_key(secret_key) {
        return Err("Management interface unavailable: no plaintext management key is available".to_string());
    }
    Ok(secret_key)
}

pub(crate) fn management_authorization(config: &GuiConfigFile) -> Result<String, String> {
    Ok(format!("Bearer {}", management_plaintext_key(config)?))
}

pub(crate) fn management_endpoint(config: &GuiConfigFile, path: &str) -> Result<String, String> {
    if config.connection_mode == super::CoreConnectionMode::Remote {
        let connection = super::core_connection::connection_from_config(config)?;
        return Ok(format!("{}/v8/management/{}", connection.management_origin, path.trim_start_matches('/')));
    }
    if config.port == 0 {
        return Err("Invalid kernel port".to_string());
    }
    let path = path.trim_start_matches('/');
    let origin = core_origin(
        &config.host,
        config.port,
        current_core_tls_settings()?.enabled,
    );
    Ok(format!("{origin}/v8/management/{path}"))
}

fn normalize_oauth_request_provider(provider: &str, plugin_provider: bool) -> Result<String, String> {
    if !plugin_provider {
        return normalize_management_oauth_provider(provider);
    }
    // Plugin provider IDs are literal backend identifiers. A plugin named grok
    // or cognition must not be redirected to the built-in xai or devin flow.
    let key = provider.trim().to_ascii_lowercase();
    if key.is_empty()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("Invalid OAuth provider".to_string());
    }
    Ok(key)
}

fn normalize_management_oauth_provider(provider: &str) -> Result<String, String> {
    let key = provider.trim().to_ascii_lowercase().replace('_', "-");
    let key = match key.as_str() {
        "claude" | "anthropic" => "claude".to_string(),
        "anti-gravity" => "antigravity".to_string(),
        "cognition" => "devin".to_string(),
        "muse" => "meta".to_string(),
        "grok" | "x-ai" | "x.ai" => "xai".to_string(),
        other => other.to_string(),
    };
    if key.is_empty()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("Invalid OAuth provider".to_string());
    }
    Ok(key)
}

fn management_oauth_uses_webui_callback(provider_key: &str) -> bool {
    matches!(provider_key, "codex" | "claude" | "antigravity")
}

async fn read_management_json<T>(response: reqwest::Response) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format_management_request_error("Failed to read management API response", &err))?;
    if !status.is_success() {
        return Err(format_management_error(status.as_u16(), &text));
    }
    if text.trim().is_empty() {
        return Err("Management API returned an empty response".to_string());
    }
    serde_json::from_str::<T>(&text).map_err(|_| "Failed to parse management API response".to_string())
}

pub(crate) async fn read_management_value(
    response: reqwest::Response,
) -> Result<serde_json::Value, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format_management_request_error("Failed to read management API response", &err))?;
    if !status.is_success() {
        return Err(format_management_error(status.as_u16(), &text));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(value) => Ok(value),
        Err(_) => Ok(serde_json::Value::String(text)),
    }
}

pub(crate) async fn read_management_text(response: reqwest::Response) -> Result<String, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format_management_request_error("Failed to read management API response", &err))?;
    if !status.is_success() {
        return Err(format_management_error(status.as_u16(), &text));
    }
    Ok(text)
}

fn format_management_error(status: u16, body: &str) -> String {
    // Only the documented missing-node marker is needed by optional config reads.
    // Never surface arbitrary server text: it may contain credentials or callback URLs.
    if status == 404 && serde_json::from_str::<serde_json::Value>(body).ok()
        .and_then(|value| value.get("error").and_then(|error| error.as_str()).map(str::to_owned))
        .as_deref() == Some("not_found")
    {
        return "Management API error (404): not_found".to_string();
    }
    format!("Management API error ({status})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct SelfSignedTlsServer {
        child: std::process::Child,
        root: PathBuf,
        port: u16,
    }

    impl Drop for SelfSignedTlsServer {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn start_self_signed_tls_server() -> SelfSignedTlsServer {
        use std::io::BufRead;
        use std::sync::mpsc;

        let root = std::env::temp_dir().join(format!(
            "cpa-management-tls-{}-{}",
            std::process::id(),
            NEXT_REQUEST.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let cert = root.join("cert.pem");
        let key = root.join("key.pem");
        let cert_output = std::process::Command::new("openssl")
            .args([
                "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj",
                "/CN=localhost", "-keyout",
            ])
            .arg(&key)
            .arg("-out")
            .arg(&cert)
            .output()
            .expect("openssl must be available for the isolated TLS test");
        if !cert_output.status.success() {
            let _ = std::fs::remove_dir_all(&root);
            panic!("failed to generate the TLS test certificate");
        }
        let script = r#"
import http.server, ssl, sys
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200); self.send_header('Content-Length', '13'); self.end_headers(); self.wfile.write(b'local-core-ok')
 def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(sys.argv[1], sys.argv[2])
server.socket = ctx.wrap_socket(server.socket, server_side=True)
print(server.server_port, flush=True)
server.serve_forever()
"#;
        let child = std::process::Command::new("python3")
            .arg("-u")
            .arg("-c")
            .arg(script)
            .arg(&cert)
            .arg(&key)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap_or_else(|error| {
                let _ = std::fs::remove_dir_all(&root);
                panic!("failed to start the isolated TLS test server: {error}");
            });
        // Establish the guard before waiting for startup so all later panics kill and
        // reap the server rather than leaving it holding the CI log pipe open.
        let mut server = SelfSignedTlsServer {
            child,
            root,
            port: 0,
        };
        let stdout = server
            .child
            .stdout
            .take()
            .expect("TLS test server stdout is piped");
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = std::io::BufReader::new(stdout)
                .read_line(&mut line)
                .map(|_| line);
            let _ = sender.send(result);
        });
        let line = receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_else(|error| panic!("TLS test server did not report its port within 5 seconds: {error}"))
            .expect("failed reading TLS test server port");
        server.port = line
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("TLS test server reported an invalid port: {line:?}"));
        server
    }

    #[tokio::test]
    async fn management_client_cache_is_scoped_to_origin_and_tls_policy() {
        let first = cached_management_http_client("https://core-a.example:9443", true, Some("cert-a".into()), Some("key-a".into())).unwrap();
        let same = cached_management_http_client("https://core-a.example:9443/", true, Some("cert-a".into()), Some("key-a".into())).unwrap();
        let different_origin = cached_management_http_client("https://core-b.example:9443", true, Some("cert-a".into()), Some("key-a".into())).unwrap();
        let strict = cached_management_http_client("https://core-a.example:9443", false, None, None).unwrap();
        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &different_origin));
        assert!(!Arc::ptr_eq(&first, &strict));
    }

    #[test]
    fn management_clients_are_not_shared_across_sequential_tokio_runtimes() {
        let first_runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (first, first_generation) = first_runtime.block_on(async {
            (
                cached_management_http_client("http://sequential-runtime.example:8080", false, None, None)
                    .unwrap(),
                runtime_generation(&tokio::runtime::Handle::current()).unwrap(),
            )
        });
        drop(first_runtime);

        let second_runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (second, second_generation) = second_runtime.block_on(async {
            (
                cached_management_http_client("http://sequential-runtime.example:8080", false, None, None)
                    .unwrap(),
                runtime_generation(&tokio::runtime::Handle::current()).unwrap(),
            )
        });
        assert_ne!(first_generation, second_generation);
        assert!(!Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn reused_tokio_runtime_id_gets_a_fresh_generation_after_shutdown() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (runtime_id, first_generation) = runtime.block_on(async {
            let handle = tokio::runtime::Handle::current();
            (handle.id(), runtime_generation(&handle).unwrap())
        });
        drop(runtime);

        // Exercise Tokio's documented ID-reuse case deterministically: once the old
        // runtime's sentinel task is dropped, the same public Id must get a new token.
        let (next_token, was_new) = runtime_token_for_id(runtime_id).unwrap();
        assert!(was_new);
        assert_ne!(first_generation, next_token.generation);
    }

    #[test]
    fn management_client_cache_evicts_only_the_oldest_entry() {
        let mut clients = HashMap::new();
        let key = |index: u64| ManagementClientKey {
            origin: format!("http://cache-{index}.example"),
            accept_invalid_certs: false,
            tls_cert: None,
            tls_key: None,
            runtime_generation: 1,
        };
        for index in 0..MAX_MANAGEMENT_CLIENTS {
            clients.insert(
                key(index as u64),
                CachedManagementClient {
                    client: Arc::new(reqwest::Client::new()),
                    last_used: index as u64,
                },
            );
        }
        let oldest = key(0);
        let next_oldest = key(1);
        evict_oldest_management_client_if_full(&mut clients);
        assert_eq!(clients.len(), MAX_MANAGEMENT_CLIENTS - 1);
        assert!(!clients.contains_key(&oldest));
        assert!(clients.contains_key(&next_oldest));

        clients.insert(
            key(MAX_MANAGEMENT_CLIENTS as u64),
            CachedManagementClient {
                client: Arc::new(reqwest::Client::new()),
                last_used: MAX_MANAGEMENT_CLIENTS as u64,
            },
        );
        assert_eq!(clients.len(), MAX_MANAGEMENT_CLIENTS);
    }

    #[test]
    fn management_request_timeout_overrides_client_default() {
        let client = cached_management_http_client("http://timeout.example:8080", false, None, None).unwrap();
        let request = client.get("http://timeout.example:8080/").timeout(Duration::from_secs(7)).build().unwrap();
        assert_eq!(request.timeout(), Some(&Duration::from_secs(7)));
    }

    #[tokio::test]
    async fn switching_target_or_certificate_never_reuses_relaxed_client() {
        let original = cached_management_http_client("https://target-a.example:9443", true, Some("old-cert".into()), Some("old-key".into())).unwrap();
        let switched_target = cached_management_http_client("https://target-b.example:9443", true, Some("old-cert".into()), Some("old-key".into())).unwrap();
        let switched_certificate = cached_management_http_client("https://target-a.example:9443", true, Some("new-cert".into()), Some("new-key".into())).unwrap();
        assert!(!Arc::ptr_eq(&original, &switched_target));
        assert!(!Arc::ptr_eq(&original, &switched_certificate));
    }

    // Disposable TLS management endpoint: no installed core or user config is changed.
    #[tokio::test]
    async fn self_signed_local_tls_management_remains_compatible() {
        let server = start_self_signed_tls_server();
        let url = format!("https://127.0.0.1:{}/v8/management/config", server.port);
        let local_config = GuiConfigFile {
            connection_mode: super::super::CoreConnectionMode::Local,
            host: "127.0.0.1".into(),
            port: server.port,
            ..Default::default()
        };
        let tls_settings = super::super::CoreTlsSettings {
            enabled: true,
            cert: server.root.join("cert.pem").display().to_string(),
            key: server.root.join("key.pem").display().to_string(),
        };
        let compatible = management_http_client_for_with_tls_settings(
            &local_config,
            Some(&tls_settings),
        )
        .unwrap()
        .get(&url)
        .send()
        .await;
        let strict_local = build_management_http_client(false).unwrap().get(&url).send().await;
        let config = GuiConfigFile {
            connection_mode: super::super::CoreConnectionMode::Remote,
            remote_management_origin: format!("https://127.0.0.1:{}", server.port),
            remote_management_key: "isolated-test-management-key".into(),
            remote_client_origin: format!("https://127.0.0.1:{}", server.port),
            ..Default::default()
        };
        let strict_remote_client = management_http_client_for(&config);
        let strict_remote = match strict_remote_client.as_ref() {
            Ok(client) => Some(client.get(&url).send().await),
            Err(_) => None,
        };
        assert_eq!(compatible.unwrap().text().await.unwrap(), "local-core-ok");
        assert!(strict_local.is_err());
        assert!(strict_remote_client.is_ok());
        assert!(strict_remote.unwrap().is_err());
    }

    #[tokio::test]
    async fn partial_remote_target_can_still_construct_management_client() {
        let config = GuiConfigFile {
            connection_mode: super::super::CoreConnectionMode::Remote,
            remote_management_origin: "https://management.example".into(),
            ..Default::default()
        };
        assert!(management_http_client_for(&config).is_ok());
        assert!(management_endpoint(&config, "config").is_err());
    }

    #[tokio::test]
    async fn management_clients_never_follow_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let _request_bytes = socket.read(&mut request).await.unwrap();
                socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            }
        });
        for relaxed_tls in [false, true] {
            let client = cached_management_http_client(&url, relaxed_tls, None, None).unwrap();
            let response = tokio::time::timeout(
                Duration::from_secs(5),
                client.get(&url).bearer_auth("isolated-secret").send(),
            ).await.unwrap();
            assert_eq!(response.unwrap().status(), reqwest::StatusCode::FOUND);
        }
        tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn stale_document_requests_are_rejected_before_any_management_send() {
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            let state = GuiConfigState::new(GuiConfigFile::default());
            let revision = state.snapshot().unwrap().target_revision;
            let request = serde_json::from_value(serde_json::json!({
                "method": method, "path": "/config", "expectedRevision": revision,
                "body": {"private": "old-document-payload"}
            })).unwrap();
            let mut changed = state.snapshot().unwrap();
            changed.management_secret_key.push_str("-changed");
            changed.remote_management_key.push_str("-changed");
            state.replace_external(changed).unwrap();
            // Default config has no management endpoint/key. Revision refusal must precede
            // endpoint resolution, body construction and network dispatch in every method.
            assert!(management_request_for_target(&state, request).await.unwrap_err().contains("connection changed"));
        }
        assert!(serde_json::from_value::<ManagementRequest>(serde_json::json!({
            "method": "PUT", "path": "/config", "body": {}
        })).is_err());
    }

    #[test]
    fn oauth_session_ttl_uses_expiry_with_fallback_and_cap() {
        assert_eq!(oauth_session_ttl(Some(900)), Duration::from_secs(900));
        assert_eq!(oauth_session_ttl(Some(0)), Duration::from_secs(30 * 60));
        assert_eq!(oauth_session_ttl(None), Duration::from_secs(30 * 60));
        assert_eq!(oauth_session_ttl(Some(u64::MAX)), Duration::from_secs(24 * 60 * 60));
    }

    #[test]
    fn failed_nonterminal_callback_response_keeps_session_for_retry() {
        let config = GuiConfigFile::default();
        let state = GuiConfigState::new(config.clone());
        let now = std::time::Instant::now();
        state.oauth_sessions.lock().unwrap()
            .insert("state-A".into(), config.target_revision, Duration::from_secs(900), now).unwrap();

        forget_oauth_callback_if_terminal(&state, "state-A", reqwest::StatusCode::BAD_REQUEST).unwrap();
        assert!(ensure_oauth_target(&state, &config, "state-A").is_ok());

        forget_oauth_callback_if_terminal(&state, "state-A", reqwest::StatusCode::CONFLICT).unwrap();
        assert!(ensure_oauth_target(&state, &config, "state-A").is_err());
    }

    #[test]
    fn oauth_states_remain_bound_to_start_revision_in_both_modes() {
        for mode in [super::super::CoreConnectionMode::Local, super::super::CoreConnectionMode::Remote] {
            let config = GuiConfigFile {
                connection_mode: mode,
                ..Default::default()
            };
            let state = GuiConfigState::new(config.clone());
            state.oauth_sessions.lock().unwrap().insert("state-A".into(), config.target_revision, Duration::from_secs(900), std::time::Instant::now()).unwrap();
            assert!(ensure_oauth_target(&state, &config, "state-A").is_ok());
            assert!(ensure_oauth_target(&state, &config, "unknown").is_err());
            let mut changed = config.clone();
            changed.management_secret_key.push_str("-changed");
            changed.remote_management_key.push_str("-changed");
            state.replace_external(changed).unwrap();
            let new = state.snapshot().unwrap();
            assert!(ensure_oauth_target(&state, &new, "state-A").is_err());
            // Switching back to identical settings still cannot revive the old flow.
            state.replace_external(config).unwrap();
            assert!(ensure_oauth_target(&state, &state.snapshot().unwrap(), "state-A").is_err());
        }
    }

    #[tokio::test]
    async fn oauth_cancellation_rejects_unknown_or_old_state_before_dispatch() {
        let state = GuiConfigState::new(GuiConfigFile::default());
        state.oauth_sessions.lock().unwrap().insert("state-A".into(), 0, Duration::from_secs(900), std::time::Instant::now()).unwrap();
        let mut changed = state.snapshot().unwrap();
        changed.management_secret_key.push_str("-changed");
        changed.remote_management_key.push_str("-changed");
        state.replace_external(changed).unwrap();
        for oauth_state in ["state-A", "unknown"] {
            let request = serde_json::from_value(serde_json::json!({
                "method": "DELETE", "path": "/oauth/session",
                "expectedRevision": state.snapshot().unwrap().target_revision,
                "query": { "state": oauth_state }
            })).unwrap();
            assert!(management_request_for_target(&state, request).await.unwrap_err().contains("OAuth session belongs"));
        }
    }

    #[tokio::test]
    async fn quota_requests_reject_stale_targets_before_dispatch_and_after_lock_wait() {
        for url in ["https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
                    "https://api.anthropic.com/api/organizations/test/reset_rate_limits"] {
            for queued in [false, true] {
                let state = GuiConfigState::new(GuiConfigFile::default());
                let revision = state.snapshot().unwrap().target_revision;
                let request = serde_json::from_value(serde_json::json!({
                    "method": "POST", "path": "/requests/api-call",
                    "expectedRevision": revision, "body": { "url": url, "method": "POST", "authIndex": "shared" }
                })).unwrap();
                if queued {
                    let lock = state.target_operation.lock().await;
                    let call = management_request_for_target(&state, request);
                    tokio::pin!(call);
                    assert!(tokio::time::timeout(Duration::from_millis(10), &mut call).await.is_err());
                    let mut changed = state.snapshot().unwrap();
                    changed.management_secret_key.push_str("-changed");
                    changed.remote_management_key.push_str("-changed");
                    state.replace_external(changed).unwrap();
                    drop(lock);
                    assert!(call.await.unwrap_err().contains("connection changed"));
                } else {
                    let mut changed = state.snapshot().unwrap();
                    changed.management_secret_key.push_str("-changed");
                    changed.remote_management_key.push_str("-changed");
                    state.replace_external(changed).unwrap();
                    assert!(management_request_for_target(&state, request).await.unwrap_err().contains("connection changed"));
                }
            }
        }
    }

    // Remote core that accepts one request, reports that it arrived, and answers only when released.
    async fn run_held_request(method: &str, path: &str, switch_target: bool) -> (bool, Result<serde_json::Value, String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = GuiConfigFile {
            connection_mode: super::super::CoreConnectionMode::Remote,
            remote_management_origin: format!("http://{}", listener.local_addr().unwrap()),
            remote_management_key: "management-secret".into(),
            ..Default::default()
        };
        config.remote_client_origin = config.remote_management_origin.clone();
        let state = GuiConfigState::new(config);
        let revision = state.snapshot().unwrap().target_revision;
        let request = serde_json::from_value(serde_json::json!({
            "method": method, "path": path, "expectedRevision": revision, "body": {}
        })).unwrap();
        let (arrived_tx, arrived_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _request_bytes = socket.read(&mut [0; 4096]).await.unwrap();
            arrived_tx.send(()).unwrap();
            release_rx.await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
        });
        let call = management_request_for_target(&state, request);
        tokio::pin!(call);
        tokio::select! {
            result = &mut call => panic!("request finished before the core answered: {result:?}"),
            arrived = arrived_rx => arrived.unwrap(),
        }
        let fence_free = state.target_operation.try_lock().is_ok();
        if switch_target {
            let mut changed = state.snapshot().unwrap();
            changed.management_secret_key.push_str("-changed");
            changed.remote_management_key.push_str("-changed");
            state.replace_external(changed).unwrap();
        }
        release_tx.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), call).await.unwrap();
        server.await.unwrap();
        (fence_free, result)
    }

    #[tokio::test]
    async fn slow_reads_do_not_hold_the_target_fence() {
        for (method, path) in [("GET", "/config"), ("POST", "/requests/api-call")] {
            let (fence_free, result) = run_held_request(method, path, false).await;
            assert!(fence_free, "{method} {path} held the fence during the request");
            assert!(result.is_ok(), "{result:?}");
        }
    }

    #[tokio::test]
    async fn read_whose_target_changed_while_in_flight_is_discarded() {
        let (fence_free, result) = run_held_request("GET", "/config", true).await;
        assert!(fence_free);
        assert!(result.unwrap_err().contains("connection changed"));
    }

    #[tokio::test]
    async fn writes_keep_the_target_fence_for_the_whole_request() {
        for (method, path) in [("PUT", "/config"), ("PATCH", "/config/plugins"), ("DELETE", "/credentials"), ("POST", "/oauth/callback-x")] {
            let (fence_free, result) = run_held_request(method, path, false).await;
            assert!(!fence_free, "{method} {path} released the fence during the request");
            assert!(result.is_ok(), "{result:?}");
        }
    }

    #[tokio::test]
    async fn upload_rejects_a_target_changed_before_dispatch() {
        let state = GuiConfigState::new(GuiConfigFile::default());
        let revision = state.snapshot().unwrap().target_revision;
        // External config changes need not have reached the browser event handler.
        let mut changed = state.snapshot().unwrap();
        changed.management_secret_key.push_str("-changed");
        changed.remote_management_key.push_str("-changed");
        state.replace_external(changed).unwrap();
        let error = upload_auth_file_for_target(&state, "account.json".into(), b"{}".to_vec(), revision)
            .await.unwrap_err();
        assert!(error.contains("upload cancelled"), "{error}");
    }

    #[tokio::test]
    async fn upload_rechecks_target_after_waiting_for_operation_lock() {
        let state = GuiConfigState::new(GuiConfigFile::default());
        let revision = state.snapshot().unwrap().target_revision;
        let lock = state.target_operation.lock().await;
        let upload = upload_auth_file_for_target(&state, "account.json".into(), b"{}".to_vec(), revision);
        tokio::pin!(upload);
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut upload).await.is_err());
        let mut changed = state.snapshot().unwrap();
        changed.management_secret_key.push_str("-changed");
        changed.remote_management_key.push_str("-changed");
        state.replace_external(changed).unwrap();
        drop(lock);
        assert!(upload.await.unwrap_err().contains("connection changed"));
    }

    #[tokio::test]
    async fn vertex_import_rejects_a_target_changed_before_dispatch() {
        let state = GuiConfigState::new(GuiConfigFile::default());
        let revision = state.snapshot().unwrap().target_revision;
        let mut changed = state.snapshot().unwrap();
        changed.management_secret_key.push_str("-changed");
        changed.remote_management_key.push_str("-changed");
        state.replace_external(changed).unwrap();
        let error = import_vertex_credential_for_target(
            &state, "account.json".into(), b"{}".to_vec(), None, revision,
        ).await.unwrap_err();
        assert!(error.contains("upload cancelled"), "{error}");
    }

    #[tokio::test]
    async fn vertex_import_rechecks_target_after_waiting_for_operation_lock() {
        let state = GuiConfigState::new(GuiConfigFile::default());
        let revision = state.snapshot().unwrap().target_revision;
        let lock = state.target_operation.lock().await;
        let import = import_vertex_credential_for_target(
            &state, "account.json".into(), b"{}".to_vec(), None, revision,
        );
        tokio::pin!(import);
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut import).await.is_err());
        let mut changed = state.snapshot().unwrap();
        changed.management_secret_key.push_str("-changed");
        changed.remote_management_key.push_str("-changed");
        state.replace_external(changed).unwrap();
        drop(lock);
        assert!(import.await.unwrap_err().contains("connection changed"));
    }

    #[tokio::test]
    async fn cancellation_drops_stalled_requests_and_preserves_other_requests() {
        let id = prepare_management_request().unwrap();
        let other = prepare_management_request().unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (dropped, done) = tokio::sync::oneshot::channel();
        struct DropNotice(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for DropNotice {
            fn drop(&mut self) {
                let _ = self.0.take().unwrap().send(());
            }
        }
        let task_id = id.clone();
        let task = tokio::spawn(async move {
            cancellable_management_request(Some(task_id), async move {
                let _notice = DropNotice(Some(dropped));
                let _ = started.send(());
                std::future::pending().await
            })
            .await
        });
        ready.await.unwrap();
        cancel_management_request(id.clone()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err(), "Management API request cancelled");
        done.await.unwrap();
        assert!(!REQUESTS.lock().unwrap().contains_key(&id));
        assert!(REQUESTS.lock().unwrap().contains_key(&other));
        // Normal errors also release reservations.
        assert!(cancellable_management_request(Some(other.clone()), async {
            Err("offline".into())
        })
        .await
        .is_err());
        assert!(!REQUESTS.lock().unwrap().contains_key(&other));
    }

    #[tokio::test]
    async fn cancellation_before_dispatch_never_polls_the_http_operation() {
        let id = prepare_management_request().unwrap();
        cancel_management_request(id.clone()).unwrap();
        cancel_management_request(id.clone()).unwrap();
        let result = cancellable_management_request(Some(id), async {
            panic!("cancelled HTTP request must not be sent");
        })
        .await;
        assert_eq!(result.unwrap_err(), "Management API request cancelled");
    }

    #[test]
    fn v8_yaml_body_is_raw_text_and_config_values_remain_json() {
        let client = reqwest::Client::new();
        let yaml = "config-version: 8\naccess: {api-keys: [test-client]}\n";
        let request = management_request_body(
            client.put("http://127.0.0.1/v8/management/config.yaml"),
            "/config.yaml",
            serde_json::json!(yaml),
        )
        .unwrap()
        .build()
        .unwrap();
        assert_eq!(request.headers()["Content-Type"], "application/yaml");
        assert_eq!(request.body().unwrap().as_bytes().unwrap(), yaml.as_bytes());

        for value in [
            serde_json::Value::Null,
            serde_json::json!(false),
            serde_json::json!(0),
            serde_json::json!([]),
            serde_json::json!({}),
            serde_json::json!("direct"),
        ] {
            let request = management_request_body(
                client.put("http://127.0.0.1/v8/management/config/requests/proxy-url"),
                "/config/requests/proxy-url",
                value.clone(),
            )
            .unwrap()
            .build()
            .unwrap();
            assert_eq!(request.headers()["Content-Type"], "application/json");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(request.body().unwrap().as_bytes().unwrap()).unwrap(),
                value,
            );
        }
        assert!(management_request_body(
            client.put("http://127.0.0.1/v8/management/config.yaml"),
            "/config.yaml",
            serde_json::json!({}),
        )
        .is_err());
    }

    #[test]
    fn v8_requests_distinguish_explicit_null_from_an_absent_body() {
        let absent: ManagementRequest = serde_json::from_value(serde_json::json!({
            "method": "GET", "path": "/config", "expectedRevision": 0,
        }))
        .unwrap();
        let explicit: ManagementRequest = serde_json::from_value(serde_json::json!({
            "method": "PUT", "path": "/config/requests/payload", "body": null, "expectedRevision": 0,
        }))
        .unwrap();
        assert!(absent.body.is_none());
        assert_eq!(explicit.body, Some(serde_json::Value::Null));
    }

    #[test]
    fn plugin_oauth_preserves_literal_provider_ids_without_builtin_aliases() {
        for provider in [
            "grok",
            "cognition",
            "anti-gravity",
            "anthropic",
            "custom-sso",
        ] {
            assert_eq!(
                normalize_oauth_request_provider(provider, true).unwrap(),
                provider
            );
        }
        assert_eq!(
            normalize_oauth_request_provider(" Custom-SSO ", true).unwrap(),
            "custom-sso"
        );
        for provider in ["", "custom_sso", "custom/sso", "custom.sso", "custom sso"] {
            assert!(normalize_oauth_request_provider(provider, true).is_err());
        }
    }

    #[test]
    fn builtin_oauth_retains_aliases_when_plugin_provider_is_not_requested() {
        for (provider, expected) in [
            ("grok", "xai"),
            ("cognition", "devin"),
            ("anti-gravity", "antigravity"),
            ("anthropic", "claude"),
            ("custom_sso", "custom-sso"),
        ] {
            assert_eq!(
                normalize_oauth_request_provider(provider, false).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn management_errors_do_not_echo_untrusted_response_bodies() {
        assert_eq!(format_management_error(400, r#"{"error":"secret-key"}"#), "Management API error (400)");
        assert_eq!(format_management_error(500, "secret-key"), "Management API error (500)");
    }

    #[test]
    fn devin_oauth_does_not_claim_the_builtin_webui_callback_flow() {
        for provider in ["Devin", " cognition "] {
            let key = normalize_management_oauth_provider(provider).unwrap();
            assert_eq!(key, "devin");
            assert!(!management_oauth_uses_webui_callback(&key));
        }
    }

    #[test]
    fn meta_oauth_uses_the_device_flow() {
        for provider in ["Meta", " muse "] {
            let key = normalize_management_oauth_provider(provider).unwrap();
            assert_eq!(key, "meta");
            assert!(!management_oauth_uses_webui_callback(&key));
        }
    }

    #[test]
    fn oauth_start_preserves_device_authorization_fields_for_the_frontend() {
        let payload = serde_json::from_value::<OAuthStartApiResponse>(serde_json::json!({
            "status": "ok",
            "url": " https://auth.meta.com/device ",
            "state": " meta-device-state ",
            "user_code": " ABCD-EFGH ",
            "flow": "device",
            "expires_in": 900,
        }))
        .unwrap();
        let result = normalize_oauth_start_response(payload).unwrap();
        let value = serde_json::to_value(result).unwrap();

        assert_eq!(value["url"], "https://auth.meta.com/device");
        assert_eq!(value["state"], "meta-device-state");
        assert_eq!(value["userCode"], "ABCD-EFGH");
        assert_eq!(value["flow"], "device");
        assert_eq!(value["expiresIn"], 900);
        assert_eq!(value["opened"], false);
        assert!(value["openError"].is_null());
    }

    #[test]
    fn oauth_start_keeps_device_metadata_optional_for_existing_providers() {
        for extra in [serde_json::json!({}), serde_json::json!({
            "user_code": " ", "flow": " ", "expires_in": 0,
        })] {
            let mut payload = serde_json::json!({
                "url": "https://example.com/oauth",
                "state": "oauth-state",
            });
            payload
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let result = normalize_oauth_start_response(
                serde_json::from_value::<OAuthStartApiResponse>(payload).unwrap(),
            )
            .unwrap();

            assert!(result.user_code.is_none());
            assert!(result.flow.is_none());
            assert!(result.expires_in.is_none());
        }
    }

    #[test]
    fn core_logs_follow_the_default_auth_directory() {
        let base_dir = PathBuf::from("test-base");
        let install_dir = base_dir.join("cpa-core");

        assert_eq!(
            core_logs_dir_path("../oauth", &install_dir).unwrap(),
            base_dir.join("oauth").join("logs")
        );
    }

    #[test]
    fn core_logs_follow_a_custom_auth_directory() {
        let install_dir = PathBuf::from("test-base").join("cpa-core");
        let auth_dir = PathBuf::from("custom-auth");

        assert_eq!(
            core_logs_dir_path(auth_dir.to_str().unwrap(), &install_dir).unwrap(),
            install_dir.join(auth_dir).join("logs")
        );
    }
}
