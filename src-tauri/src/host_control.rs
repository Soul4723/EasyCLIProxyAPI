//! Remote host control. EasyCLIProxyAPI on the core's computer, which already supervises that
//! core, can let EasyCLIProxyAPI on another computer start, stop and restart it. CLIProxyAPI's
//! management API has no lifecycle endpoints, and a stopped core cannot answer a start request.
//!
//! Host side (Local mode, opt-in, off by default): one small HTTP/1.1 listener with its own key.
//! Every operation reuses the local lifecycle functions under the core-operation lock.
//! Client side (Remote mode): status and lifecycle requests to that listener.
//! The wire contract is documented in docs/remote-core.md.

use crate::{
    core_connection::{CoreConnection, CoreConnectionTestResult},
    CoreConnectionMode, CoreOperation, CoreProcessState, CoreStatus, GuiConfigFile, GuiConfigState,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpListener,
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;

pub(crate) const PROTOCOL_VERSION: u32 = 1;
/// Required on every request. Browsers cannot send it cross-origin without a preflight, which is refused.
pub(crate) const PROTOCOL_HEADER: &str = "x-easycli-host-control";
pub(crate) const PATH_PREFIX: &str = "/host-control/v1";
pub(crate) const DEFAULT_ADDRESS: &str = "0.0.0.0:8318";
pub(crate) const STOPPED_ON_REMOTE_HOST: &str = "Stopped on remote host";
pub(crate) const NOT_CONFIGURED: &str =
    "Set up remote host control in Core connection to start, stop or restart a remote core";
const REMOTE_MODE_PAUSED: &str =
    "Remote control is available only while this app runs the local core";
const KEY_PREFIX: &str = "ehc_";
const MAX_HEAD_BYTES: usize = 8 * 1024;
const MAX_HEADERS: usize = 32;
const MAX_CONNECTIONS: usize = 8;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
/// Start and restart wait for the core's management port on the host.
const OPERATION_TIMEOUT: Duration = Duration::from_secs(120);
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
const MAX_FAILURES: u32 = 10;
const MAX_TRACKED_PEERS: usize = 1024;
/// Headers only browsers send. Their presence means a web page is making the request.
const BROWSER_HEADERS: [&str; 7] = [
    "origin",
    "referer",
    "cookie",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "sec-fetch-user",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostOperation {
    Start,
    Stop,
    Restart,
}

impl HostOperation {
    fn name(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
        }
    }

    fn local(self) -> CoreOperation {
        match self {
            Self::Start => crate::start_core_process_with_state,
            Self::Stop => crate::stop_core_process_with_state,
            Self::Restart => crate::restart_core_process_with_state,
        }
    }
}

/// The host's core, as sent to the client. No local paths.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostCoreStatus {
    pub(crate) protocol: u32,
    pub(crate) installed: bool,
    pub(crate) running: bool,
    pub(crate) ready: bool,
    pub(crate) starting: bool,
    pub(crate) managed: bool,
    pub(crate) process_id: Option<u32>,
    pub(crate) current_version: Option<String>,
    pub(crate) message: String,
}

impl HostCoreStatus {
    pub(crate) fn from_status(status: &CoreStatus) -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            installed: status.installed,
            running: status.running,
            ready: status.ready,
            starting: status.starting,
            managed: status.managed,
            process_id: status.process_id,
            current_version: status.current_version.clone(),
            message: status.message.clone(),
        }
    }
}

/// Part of a Remote `CoreStatus` when host control is configured.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostControlView {
    pub(crate) reachable: bool,
    pub(crate) message: String,
}

// ---------------------------------------------------------------------------------------------
// Keys and settings validation

pub(crate) fn generate_key() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Failed to generate a host control key: {error}"))?;
    Ok(format!("{KEY_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
}

pub(crate) fn validate_key_format(key: &str) -> Result<(), String> {
    if key.len() < 32 || key.len() > 256 || !key.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(
            "Host control key must be 32 to 256 printable characters without spaces".into(),
        );
    }
    Ok(())
}

/// The host's key must be valid and differ from this core's management and client keys.
pub(crate) fn validate_host_key(config: &GuiConfigFile) -> Result<(), String> {
    let key = config.host_control_key.as_str();
    validate_key_format(key)?;
    if key == config.management_secret_key.trim()
        || config.api_keys.iter().any(|entry| entry.key.trim() == key)
    {
        return Err("Host control key must differ from the management and client keys".into());
    }
    Ok(())
}

pub(crate) fn parse_listen_address(value: &str, core_port: u16) -> Result<SocketAddr, String> {
    let address: SocketAddr = value.trim().parse().map_err(|_| {
        "Listen address must be an IP address and port, for example 0.0.0.0:8318".to_string()
    })?;
    if address.port() < 1024 {
        return Err("Choose a listen port from 1024 to 65535".into());
    }
    if address.port() == core_port {
        return Err("The listen port must differ from the core's port".into());
    }
    Ok(address)
}

/// Client side: both empty (not configured) or a valid origin and key distinct from the management key.
pub(crate) fn normalize_remote_target(
    origin: &str,
    key: &str,
    management_key: &str,
) -> Result<(String, String), String> {
    let (origin, key) = (origin.trim(), key.trim());
    if origin.is_empty() && key.is_empty() {
        return Ok((String::new(), String::new()));
    }
    if origin.is_empty() || key.is_empty() {
        return Err("Enter both the host control URL and key, or leave both empty".into());
    }
    let origin = crate::core_connection::normalize_origin(origin).map_err(|_| {
        "Host control URL must be an HTTP(S) origin without credentials, path, query or fragment"
            .to_string()
    })?;
    validate_key_format(key)?;
    if key == management_key.trim() {
        return Err("Host control key must differ from the management key".into());
    }
    Ok((origin, key.to_string()))
}

/// The settings that define the running listener; changed only through the settings command.
pub(crate) fn listener_settings(config: &GuiConfigFile) -> (bool, &str, &str) {
    (
        config.host_control_enabled,
        config.host_control_address.as_str(),
        config.host_control_key.as_str(),
    )
}

fn keys_match(provided: &[u8], expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    // Hashing first makes the comparison independent of where and whether the lengths differ.
    let provided = Sha256::digest(provided);
    let expected = Sha256::digest(expected.as_bytes());
    let difference = provided
        .iter()
        .zip(expected.iter())
        .fold(0u8, |difference, (left, right)| difference | (left ^ right));
    std::hint::black_box(difference) == 0
}

// ---------------------------------------------------------------------------------------------
// Host side: requests

#[derive(Debug)]
pub(crate) struct Request {
    pub(crate) method: String,
    pub(crate) path: String,
    /// Lower-case names, in order.
    pub(crate) headers: Vec<(String, Vec<u8>)>,
}

impl Request {
    fn values<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a [u8]> + 'a {
        self.headers
            .iter()
            .filter(move |(header, _)| header == name)
            .map(|(_, value)| value.as_slice())
    }

    fn single<'a>(&'a self, name: &'a str) -> Option<&'a [u8]> {
        let mut values = self.values(name);
        let value = values.next()?;
        values.next().is_none().then_some(value)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Reply {
    pub(crate) status: u16,
    pub(crate) body: String,
}

impl Reply {
    fn json<T: Serialize>(value: &T) -> Self {
        match serde_json::to_string(value) {
            Ok(body) => Self { status: 200, body },
            Err(_) => Self::error(500, "Failed to encode the response"),
        }
    }

    fn error(status: u16, message: &str) -> Self {
        Self {
            status,
            body: serde_json::json!({ "error": message }).to_string(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Route {
    Status,
    Operate(HostOperation),
}

/// `Ok(None)` while the head is incomplete.
pub(crate) fn parse_head(buffer: &[u8]) -> Result<Option<Request>, Reply> {
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut request = httparse::Request::new(&mut headers);
    match request.parse(buffer) {
        Ok(httparse::Status::Complete(_)) => Ok(Some(Request {
            method: request.method.unwrap_or_default().to_string(),
            path: request.path.unwrap_or_default().to_string(),
            headers: request
                .headers
                .iter()
                .map(|header| (header.name.to_ascii_lowercase(), header.value.to_vec()))
                .collect(),
        })),
        Ok(httparse::Status::Partial) if buffer.len() >= MAX_HEAD_BYTES => {
            Err(Reply::error(431, "Request head is too large"))
        }
        Ok(httparse::Status::Partial) => Ok(None),
        Err(httparse::Error::TooManyHeaders) => Err(Reply::error(431, "Too many headers")),
        Err(_) => Err(Reply::error(400, "Malformed request")),
    }
}

/// Refuses browser-originated requests (CSRF, DNS rebinding), request bodies and requests
/// without the protocol header. Runs before authentication.
pub(crate) fn screen(request: &Request) -> Result<(), Reply> {
    if BROWSER_HEADERS
        .iter()
        .any(|name| request.values(name).next().is_some())
    {
        return Err(Reply::error(403, "Browser requests are not accepted"));
    }
    if request.values("transfer-encoding").next().is_some() {
        return Err(Reply::error(400, "Request bodies are not accepted"));
    }
    let mut lengths = request.values("content-length");
    if lengths.any(|value| value.trim_ascii() != b"0") {
        return Err(Reply::error(413, "Request bodies are not accepted"));
    }
    if request.single(PROTOCOL_HEADER) != Some(b"1".as_slice()) {
        return Err(Reply::error(400, "Missing X-EasyCLI-Host-Control: 1 header"));
    }
    Ok(())
}

pub(crate) fn authenticate(request: &Request, key: &str) -> bool {
    let Some(value) = request.single("authorization") else {
        return false;
    };
    let Some((scheme, token)) = value.split_at_checked(7) else {
        return false;
    };
    scheme.eq_ignore_ascii_case(b"bearer ") && keys_match(token.trim_ascii(), key)
}

pub(crate) fn route(request: &Request) -> Result<Route, Reply> {
    let operation = match request.path.strip_prefix(PATH_PREFIX) {
        Some("/status") => None,
        Some("/core/start") => Some(HostOperation::Start),
        Some("/core/stop") => Some(HostOperation::Stop),
        Some("/core/restart") => Some(HostOperation::Restart),
        _ => return Err(Reply::error(404, "Not found")),
    };
    match (request.method.as_str(), operation) {
        ("GET", None) => Ok(Route::Status),
        ("POST", Some(operation)) => Ok(Route::Operate(operation)),
        _ => Err(Reply::error(405, "Method not allowed")),
    }
}

/// Counts failed authentications per peer address; fails closed when the table is full.
#[derive(Default)]
pub(crate) struct FailureLimiter {
    peers: Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

impl FailureLimiter {
    pub(crate) fn blocked(&self, peer: IpAddr) -> bool {
        let Ok(mut peers) = self.peers.lock() else {
            return true;
        };
        let now = Instant::now();
        peers.retain(|_, (_, since)| now.duration_since(*since) < FAILURE_WINDOW);
        match peers.get(&peer) {
            Some((failures, _)) => *failures >= MAX_FAILURES,
            None => peers.len() >= MAX_TRACKED_PEERS,
        }
    }

    pub(crate) fn record_failure(&self, peer: IpAddr) {
        if let Ok(mut peers) = self.peers.lock() {
            let entry = peers.entry(peer).or_insert((0, Instant::now()));
            entry.0 = entry.0.saturating_add(1);
        }
    }
}

type HostError = (u16, String);

/// What the listener controls. The app implementation drives this computer's core.
pub(crate) trait HostBackend: Send + Sync + 'static {
    fn status(&self) -> BoxFuture<'static, Result<HostCoreStatus, HostError>>;
    fn operate(&self, operation: HostOperation)
        -> BoxFuture<'static, Result<HostCoreStatus, HostError>>;
}

pub(crate) struct Context {
    key: String,
    backend: Arc<dyn HostBackend>,
    failures: FailureLimiter,
}

pub(crate) fn new_context(key: String, backend: Arc<dyn HostBackend>) -> Arc<Context> {
    Arc::new(Context {
        key,
        backend,
        failures: FailureLimiter::default(),
    })
}

pub(crate) async fn respond(request: &Request, peer: IpAddr, context: &Context) -> Reply {
    if let Err(reply) = screen(request) {
        return reply;
    }
    if context.failures.blocked(peer) {
        return Reply::error(429, "Too many failed attempts; try again later");
    }
    if !authenticate(request, &context.key) {
        context.failures.record_failure(peer);
        return Reply::error(401, "Missing or invalid host control key");
    }
    let result = match route(request) {
        Ok(Route::Status) => context.backend.status().await,
        Ok(Route::Operate(operation)) => context.backend.operate(operation).await,
        Err(reply) => return reply,
    };
    match result {
        Ok(status) => Reply::json(&status),
        Err((status, message)) => Reply::error(status, &message),
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    }
}

pub(crate) fn encode_reply(reply: &Reply) -> Vec<u8> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n",
        reply.status,
        reason(reply.status),
        reply.body.len()
    );
    if reply.status == 401 {
        head.push_str("WWW-Authenticate: Bearer\r\n");
    }
    head.push_str("\r\n");
    let mut bytes = head.into_bytes();
    bytes.extend_from_slice(reply.body.as_bytes());
    bytes
}

/// `Err(None)` closes without a reply (the peer went away).
async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Request, Option<Reply>> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let count = stream.read(&mut chunk).await.map_err(|_| None)?;
        if count == 0 {
            return Err(None);
        }
        buffer.extend_from_slice(&chunk[..count]);
        if let Some(request) = parse_head(&buffer).map_err(Some)? {
            return Ok(request);
        }
    }
}

/// One request per connection; the connection always closes after the reply.
pub(crate) async fn handle_connection<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    peer: IpAddr,
    context: &Context,
) {
    let reply = match tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut stream)).await {
        Err(_) | Ok(Err(None)) => return,
        Ok(Err(Some(reply))) => reply,
        Ok(Ok(request)) => respond(&request, peer, context).await,
    };
    let _ = tokio::time::timeout(WRITE_TIMEOUT, async {
        stream.write_all(&encode_reply(&reply)).await?;
        stream.shutdown().await
    })
    .await;
}

pub(crate) async fn serve(listener: TcpListener, context: Arc<Context>, cancel: CancellationToken) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let accepted = tokio::select! {
            _ = cancel.cancelled() => return,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, peer)) = accepted else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        // Too many requests in flight: drop the connection rather than queue it.
        let Ok(slot) = slots.clone().try_acquire_owned() else {
            continue;
        };
        let context = context.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            let _slot = slot;
            tokio::select! {
                _ = cancel.cancelled() => {}
                _ = handle_connection(stream, peer.ip().to_canonical(), &context) => {}
            }
        });
    }
}

// ---------------------------------------------------------------------------------------------
// Host side: this app's core and the listener lifecycle

struct AppBackend(tauri::AppHandle);

fn require_host_mode(app: &tauri::AppHandle) -> Result<(), HostError> {
    let config = app
        .state::<GuiConfigState>()
        .snapshot()
        .map_err(|error| (500, error))?;
    if config.connection_mode != CoreConnectionMode::Local || !config.host_control_enabled {
        return Err((409, REMOTE_MODE_PAUSED.into()));
    }
    Ok(())
}

/// Busy (another operation holds the core-operation lock) is a conflict; the rest are failures.
pub(crate) fn operation_error(error: String) -> HostError {
    if error == crate::CORE_OPERATION_BUSY {
        (409, error)
    } else {
        (500, error)
    }
}

impl HostBackend for AppBackend {
    fn status(&self) -> BoxFuture<'static, Result<HostCoreStatus, HostError>> {
        let app = self.0.clone();
        Box::pin(async move {
            require_host_mode(&app)?;
            tauri::async_runtime::spawn_blocking(move || {
                let port = app.state::<GuiConfigState>().snapshot()?.port;
                crate::current_core_status(Some(app.state::<CoreProcessState>().inner()), Some(port))
            })
            .await
            .map_err(|error| (500, error.to_string()))?
            .map(|status| HostCoreStatus::from_status(&status))
            .map_err(|error| (500, error))
        })
    }

    fn operate(
        &self,
        operation: HostOperation,
    ) -> BoxFuture<'static, Result<HostCoreStatus, HostError>> {
        let app = self.0.clone();
        Box::pin(async move {
            require_host_mode(&app)?;
            // Same path as this app's buttons: lock, Local check, lifecycle, status event.
            crate::run_core_command(app, operation.local())
                .await
                .map(|status| HostCoreStatus::from_status(&status))
                .map_err(operation_error)
        })
    }
}

struct RunningListener {
    cancel: CancellationToken,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Clone, Default)]
struct ListenerStatus {
    listening: Option<String>,
    error: Option<String>,
}

#[derive(Default)]
pub(crate) struct HostControlState {
    listener: tokio::sync::Mutex<Option<RunningListener>>,
    status: Mutex<ListenerStatus>,
}

async fn start_listener(
    app: &tauri::AppHandle,
) -> Result<Option<(String, RunningListener)>, String> {
    let config = app.state::<GuiConfigState>().snapshot()?;
    if !config.host_control_enabled {
        return Ok(None);
    }
    if config.connection_mode != CoreConnectionMode::Local {
        return Err(REMOTE_MODE_PAUSED.into());
    }
    let address = parse_listen_address(&config.host_control_address, config.port)?;
    validate_host_key(&config)?;
    let listener = TcpListener::bind(address)
        .await
        .map_err(|error| format!("Cannot listen on {address}: {error}"))?;
    let bound = listener
        .local_addr()
        .map_err(|error| format!("Cannot listen on {address}: {error}"))?
        .to_string();
    let context = new_context(config.host_control_key, Arc::new(AppBackend(app.clone())));
    let cancel = CancellationToken::new();
    let task = tauri::async_runtime::spawn(serve(listener, context, cancel.clone()));
    Ok(Some((bound, RunningListener { cancel, task })))
}

/// Starts, restarts or stops the listener to match the saved settings. Fails closed: invalid
/// settings, Remote mode or a bind error leave it stopped, with the reason in the settings view.
pub(crate) async fn apply(app: tauri::AppHandle) {
    let state = app.state::<HostControlState>();
    let mut running = state.listener.lock().await;
    if let Some(previous) = running.take() {
        previous.cancel.cancel();
        let _ = previous.task.await;
    }
    let status = match start_listener(&app).await {
        Ok(Some((address, listener))) => {
            *running = Some(listener);
            ListenerStatus {
                listening: Some(address),
                error: None,
            }
        }
        Ok(None) => ListenerStatus::default(),
        Err(error) => {
            eprintln!("Remote host control is not running: {error}");
            ListenerStatus {
                listening: None,
                error: Some(error),
            }
        }
    };
    if let Ok(mut current) = state.status.lock() {
        *current = status;
    };
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostControlSettings {
    enabled: bool,
    address: String,
    key: String,
    /// False while this app is connected to a remote core.
    available: bool,
    listening: Option<String>,
    error: Option<String>,
}

fn settings_view(app: &tauri::AppHandle) -> Result<HostControlSettings, String> {
    let config = app.state::<GuiConfigState>().snapshot()?;
    let status = app
        .state::<HostControlState>()
        .status
        .lock()
        .map(|status| status.clone())
        .unwrap_or_default();
    Ok(HostControlSettings {
        enabled: config.host_control_enabled,
        address: config.host_control_address,
        key: config.host_control_key,
        available: config.connection_mode == CoreConnectionMode::Local,
        listening: status.listening,
        error: status.error,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostControlUpdate {
    pub(crate) enabled: bool,
    pub(crate) address: String,
    #[serde(default)]
    pub(crate) regenerate_key: bool,
}

pub(crate) fn apply_update(config: &mut GuiConfigFile, update: HostControlUpdate) -> Result<(), String> {
    let address = update.address.trim().to_string();
    parse_listen_address(&address, config.port)?;
    if update.enabled && config.connection_mode != CoreConnectionMode::Local {
        return Err(REMOTE_MODE_PAUSED.into());
    }
    if update.regenerate_key || (update.enabled && config.host_control_key.is_empty()) {
        config.host_control_key = generate_key()?;
    }
    config.host_control_enabled = update.enabled;
    config.host_control_address = address;
    if config.host_control_enabled {
        validate_host_key(config)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_host_control_settings(
    app: tauri::AppHandle,
) -> Result<HostControlSettings, String> {
    settings_view(&app)
}

#[tauri::command]
pub(crate) async fn save_host_control_settings(
    app: tauri::AppHandle,
    update: HostControlUpdate,
) -> Result<HostControlSettings, String> {
    app.state::<GuiConfigState>()
        .update(|config| apply_update(config, update))?;
    apply(app.clone()).await;
    settings_view(&app)
}

// ---------------------------------------------------------------------------------------------
// Client side (Remote mode)

fn host_http_client() -> Result<reqwest::Client, String> {
    static CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
        reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| format!("Failed to create the host control client: {error}"))
    });
    CLIENT.as_ref().cloned().map_err(Clone::clone)
}

fn display_text(text: &str, limit: usize) -> String {
    text.chars().filter(|character| !character.is_control()).take(limit).collect()
}

pub(crate) fn parse_host_response(status: u16, body: &[u8]) -> Result<HostCoreStatus, String> {
    if status == 200 {
        let mut parsed: HostCoreStatus = serde_json::from_slice(body)
            .map_err(|_| "Remote host control returned an invalid status".to_string())?;
        if parsed.protocol != PROTOCOL_VERSION {
            return Err("Remote host control uses an unsupported protocol version".into());
        }
        parsed.message = display_text(&parsed.message, 300);
        parsed.current_version = parsed.current_version.map(|version| display_text(&version, 64));
        return Ok(parsed);
    }
    let message = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("error")?.as_str().map(|text| display_text(text, 300)))
        .filter(|message| !message.is_empty());
    Err(match status {
        401 => "Remote host rejected the host control key".into(),
        403 => "Remote host refused the request".into(),
        404 => "Remote host does not offer host control at this URL".into(),
        429 => "Too many failed attempts; try again in a minute".into(),
        _ => message.unwrap_or_else(|| format!("Remote host control failed (HTTP {status})")),
    })
}

async fn host_request(
    origin: &str,
    key: &str,
    method: reqwest::Method,
    path: &str,
    timeout: Duration,
) -> Result<HostCoreStatus, String> {
    let mut response = host_http_client()?
        .request(method, format!("{origin}{PATH_PREFIX}/{path}"))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .header(PROTOCOL_HEADER, "1")
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "Remote host control did not answer in time".to_string()
            } else {
                "Unable to reach remote host control".to_string()
            }
        })?;
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Remote host control response was interrupted".to_string())?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Remote host control response is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    parse_host_response(status, &body)
}

pub(crate) async fn fetch_host_status(origin: &str, key: &str) -> Result<HostCoreStatus, String> {
    host_request(origin, key, reqwest::Method::GET, "status", STATUS_TIMEOUT).await
}

pub(crate) async fn request_host_operation(
    origin: &str,
    key: &str,
    operation: HostOperation,
) -> Result<HostCoreStatus, String> {
    let path = format!("core/{}", operation.name());
    host_request(origin, key, reqwest::Method::POST, &path, OPERATION_TIMEOUT).await
}

/// `None` in Local mode. In Remote mode, sends the operation to the remote host's EasyCLIProxyAPI,
/// or refuses when host control is not set up.
pub(crate) async fn forward_remote_core_command(
    app: &tauri::AppHandle,
    operation: HostOperation,
) -> Option<Result<CoreStatus, String>> {
    let config = match app.state::<GuiConfigState>().snapshot() {
        Ok(config) => config,
        Err(error) => return Some(Err(error)),
    };
    if config.connection_mode != CoreConnectionMode::Remote {
        return None;
    }
    let connection = CoreConnection::from(&config);
    Some(remote_core_command(app, connection, operation).await)
}

async fn remote_core_command(
    app: &tauri::AppHandle,
    connection: CoreConnection,
    operation: HostOperation,
) -> Result<CoreStatus, String> {
    if connection.host_control_origin.is_empty() {
        return Err(NOT_CONFIGURED.into());
    }
    let host = request_host_operation(
        &connection.host_control_origin,
        &connection.host_control_key,
        operation,
    )
    .await?;
    let management = crate::core_connection::poll_core_connection(connection.clone())
        .await
        .unwrap_or_else(|message| CoreConnectionTestResult {
            connected: false,
            version: None,
            message,
        });
    let status =
        crate::core_connection::remote_status_with_host(&connection, management, Some(Ok(host)));
    crate::core_connection::publish_remote_status(app, &connection, status)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostControlTestResult {
    pub(crate) connected: bool,
    pub(crate) running: Option<bool>,
    pub(crate) message: String,
}

/// Tests a draft connection's host control without saving it.
#[tauri::command]
pub(crate) async fn test_host_control(
    connection: CoreConnection,
) -> Result<HostControlTestResult, String> {
    let (origin, key) = normalize_remote_target(
        &connection.host_control_origin,
        &connection.host_control_key,
        &connection.management_key,
    )?;
    if origin.is_empty() {
        return Err("Enter the host control URL and key".into());
    }
    Ok(match fetch_host_status(&origin, &key).await {
        Ok(status) => HostControlTestResult {
            connected: true,
            running: Some(status.running),
            message: status.message,
        },
        Err(message) => HostControlTestResult {
            connected: false,
            running: None,
            message,
        },
    })
}

#[cfg(test)]
mod tests;
