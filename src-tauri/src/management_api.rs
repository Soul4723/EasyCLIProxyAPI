#[cfg(target_os = "windows")]
use super::windows_explorer_executable;
use super::{
    auth_dir_path_for_core, configure_background_command, core_install_dir, core_logs_dir_path,
    core_origin, current_core_tls_settings, is_hashed_management_secret_key, open_oauth_url_inner,
    path_to_string, GuiConfigFile, GuiConfigState,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    error::Error,
    fs,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

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
    method: String,
    path: String,
    query: Option<HashMap<String, String>>,
    #[serde(default, deserialize_with = "deserialize_management_body")]
    body: Option<serde_json::Value>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    expected_revision: Option<u64>,
}

fn deserialize_management_body<'de, D>(deserializer: D) -> Result<Option<serde_json::Value>, D::Error>
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
    let config = gui_config_state.snapshot()?;
    if request.expected_revision.is_some_and(|revision| revision != config.target_revision) {
        return Err("The core connection changed; request cancelled".to_string());
    }
    let _target_operation = gui_config_state.target_operation.lock().await;
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

    let response = builder
        .send()
        .await
        .map_err(|err| format_management_request_error("Management API request failed", &err))?;
    let value = read_management_value(response).await;
    gui_config_state.ensure_target(&config)?;
    value
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
) -> Result<OAuthStartResult, String> {
    let config = gui_config_state.snapshot()?;
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
        gui_config_state.oauth_sessions.lock().map_err(|_| "OAuth session lock is poisoned".to_string())?
            .insert(state.clone(), config.target_revision);
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
) -> Result<OAuthStatusResult, String> {
    let state = state.trim().to_string();
    if state.is_empty() {
        return Err("OAuth state cannot be empty".to_string());
    }
    let config = gui_config_state.snapshot()?;
    let _target_operation = gui_config_state.target_operation.lock().await;
    gui_config_state.ensure_target(&config)?;
    ensure_oauth_target(&gui_config_state, &config, &state)?;
    let client = management_http_client_for(&config)?;
    let response = client
        .get(management_endpoint(&config, "oauth/status")?)
        .header("Authorization", management_authorization(&config)?)
        .query(&[("state", state)])
        .send()
        .await
        .map_err(|err| format_management_request_error("Failed to query OAuth status", &err))?;
    let payload = read_management_json::<OAuthStatusApiResponse>(response).await?;
    gui_config_state.ensure_target(&config)?;
    let status = payload
        .status
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "wait".to_string());
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
) -> Result<(), String> {
    let redirect_url = redirect_url.trim().to_string();
    if redirect_url.is_empty() {
        return Err("Callback URL cannot be empty".to_string());
    }
    let config = gui_config_state.snapshot()?;
    let _target_operation = gui_config_state.target_operation.lock().await;
    gui_config_state.ensure_target(&config)?;
    if config.connection_mode == super::CoreConnectionMode::Remote {
        let parsed = reqwest::Url::parse(&redirect_url).map_err(|_| "Invalid OAuth callback URL".to_string())?;
        let state = parsed.query_pairs().find(|(key, _)| key == "state")
            .map(|(_, value)| value.into_owned()).ok_or("OAuth callback URL is missing state")?;
        ensure_oauth_target(&gui_config_state, &config, &state)?;
    }
    let provider_key = normalize_oauth_request_provider(&provider, plugin_provider.unwrap_or(false))?;
    let client = management_http_client_for(&config)?;
    let body = serde_json::json!({
        "provider": provider_key,
        "redirect_url": redirect_url,
    });
    let response = client
        .post(management_endpoint(&config, "oauth/callback")?)
        .header("Authorization", management_authorization(&config)?)
        .json(&body)
        .send()
        .await
        .map_err(|err| format_management_request_error("Failed to submit OAuth callback", &err))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format_management_request_error("Failed to read OAuth callback response", &err))?;
    gui_config_state.ensure_target(&config)?;
    if !status.is_success() {
        return Err(format_management_error(status.as_u16(), &text));
    }
    Ok(())
}

pub(crate) fn management_http_client_for(config: &GuiConfigFile) -> Result<reqwest::Client, String> {
    if config.connection_mode == super::CoreConnectionMode::Local {
        return management_http_client();
    }
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Failed to create remote management client".to_string())
}

fn ensure_oauth_target(state: &GuiConfigState, config: &GuiConfigFile, oauth_state: &str) -> Result<(), String> {
    if config.connection_mode == super::CoreConnectionMode::Local { return Ok(()); }
    let sessions = state.oauth_sessions.lock().map_err(|_| "OAuth session lock is poisoned".to_string())?;
    if sessions.get(oauth_state) != Some(&config.target_revision) {
        return Err("OAuth session belongs to a different or expired core connection; start login again".to_string());
    }
    Ok(())
}

pub(crate) fn management_http_client() -> Result<reqwest::Client, String> {
    local_management_http_client(current_core_tls_settings()?.enabled)
}

fn local_management_http_client(local_tls: bool) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(local_tls)
        .build()
        .map_err(|err| format_management_request_error("Failed to create management API client", &err))
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

pub(crate) fn management_authorization(config: &GuiConfigFile) -> Result<String, String> {
    let secret_key = if config.connection_mode == super::CoreConnectionMode::Remote { config.remote_management_key.trim() } else { config.management_secret_key.trim() };
    if secret_key.is_empty() || is_hashed_management_secret_key(secret_key) {
        return Err("Management interface unavailable: no plaintext management key is available".to_string());
    }
    Ok(format!("Bearer {secret_key}"))
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

    // Disposable TLS management endpoint: no installed core or user config is changed.
    #[tokio::test]
    async fn self_signed_local_tls_management_remains_compatible() {
        let root = std::env::temp_dir().join(format!("cpa-management-tls-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let cert = root.join("cert.pem");
        let key = root.join("key.pem");
        assert!(std::process::Command::new("openssl").args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout"]).arg(&key).arg("-out").arg(&cert).output().unwrap().status.success());
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
        let mut server = std::process::Command::new("python3").arg("-u").arg("-c").arg(script).arg(&cert).arg(&key).stdout(std::process::Stdio::piped()).spawn().unwrap();
        use std::io::BufRead;
        let mut port = String::new();
        std::io::BufReader::new(server.stdout.take().unwrap()).read_line(&mut port).unwrap();
        let url = format!("https://127.0.0.1:{}/v8/management/config", port.trim());
        let compatible = local_management_http_client(true).unwrap().get(&url).send().await;
        let strict_local = local_management_http_client(false).unwrap().get(&url).send().await;
        let mut config = GuiConfigFile::default();
        config.connection_mode = super::super::CoreConnectionMode::Remote;
        let strict_remote = management_http_client_for(&config).unwrap().get(&url).send().await;
        server.kill().unwrap();
        server.wait().unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(compatible.unwrap().text().await.unwrap(), "local-core-ok");
        assert!(strict_local.is_err());
        assert!(strict_remote.is_err());
    }

    #[tokio::test]
    async fn management_clients_never_follow_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for remote in [false, true] {
            let mut config = GuiConfigFile::default();
            if remote { config.connection_mode = super::super::CoreConnectionMode::Remote; }
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let server = async {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                socket.read(&mut request).await.unwrap();
                socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            };
            let client = management_http_client_for(&config).unwrap();
            let (response, ()) = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::join!(client.get(url).bearer_auth("isolated-secret").send(), server)
            }).await.unwrap();
            assert_eq!(response.unwrap().status(), reqwest::StatusCode::FOUND);
        }
    }

    #[tokio::test]
    async fn upload_rejects_a_target_changed_before_dispatch() {
        let state = GuiConfigState::new(GuiConfigFile::default());
        let revision = state.snapshot().unwrap().target_revision;
        // External config changes need not have reached the browser event handler.
        state.replace_external(state.snapshot().unwrap()).unwrap();
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
        state.replace_external(state.snapshot().unwrap()).unwrap();
        drop(lock);
        assert!(upload.await.unwrap_err().contains("connection changed"));
    }

    #[tokio::test]
    async fn vertex_import_rejects_a_target_changed_before_dispatch() {
        let state = GuiConfigState::new(GuiConfigFile::default());
        let revision = state.snapshot().unwrap().target_revision;
        state.replace_external(state.snapshot().unwrap()).unwrap();
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
        state.replace_external(state.snapshot().unwrap()).unwrap();
        drop(lock);
        assert!(import.await.unwrap_err().contains("connection changed"));
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
            "method": "GET", "path": "/config",
        }))
        .unwrap();
        let explicit: ManagementRequest = serde_json::from_value(serde_json::json!({
            "method": "PUT", "path": "/config/requests/payload", "body": null,
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
