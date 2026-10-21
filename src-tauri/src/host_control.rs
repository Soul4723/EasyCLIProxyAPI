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
    CoreConnectionMode, CoreDownloadState, CoreInstallResult, CoreInstallTask, CoreLatest,
    CoreOperation, CoreProcessState, CoreStatus, GuiConfigFile, GuiConfigState,
};
use serde::de::DeserializeOwned;
use tauri::Emitter;
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
/// The default listener port is the core's port + 100: with the release channels' core ports
/// (8317-8319) that is 8417-8419, so no channel's listener meets any channel's core or listener.
pub(crate) const PORT_OFFSET: u16 = 100;
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
/// An install downloads, verifies and swaps the core on the host before replying.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(1200);
const LATEST_TIMEOUT: Duration = Duration::from_secs(60);
const INSTALL_POLL: Duration = Duration::from_millis(700);
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
    /// The host app's Start Core on Launch setting. Optional so older hosts still parse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) start_core_on_launch: Option<bool>,
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
            start_core_on_launch: None,
        }
    }
}

/// A core version for the install route: `v`, three numeric parts and an optional suffix.
pub(crate) fn valid_core_version(version: &str) -> bool {
    let version = version.strip_prefix('v').unwrap_or(version);
    let (core, suffix) = match version.split_once('-') {
        Some((_, "")) => return false,
        Some((core, suffix)) => (core, suffix),
        None => (version, ""),
    };
    let parts = core.split('.').collect::<Vec<_>>();
    version.len() <= 64
        && parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
}

/// Install results and tasks leave the host without its local paths.
fn without_paths(mut result: CoreInstallResult) -> CoreInstallResult {
    result.install_dir.clear();
    result.binary_path = None;
    result
}

fn task_without_paths(mut task: CoreInstallTask) -> CoreInstallTask {
    task.result = task.result.map(without_paths);
    task.message = task.message.as_deref().map(public_message);
    task
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
        "Listen address must be an IP address and port, for example 0.0.0.0:8417".to_string()
    })?;
    if address.port() < 1024 {
        return Err("Choose a listen port from 1024 to 65535".into());
    }
    if address.port() == core_port {
        return Err("The listen port must differ from the core's port".into());
    }
    Ok(address)
}

/// Used when no listen address is saved: every interface, on the core's port + 100.
pub(crate) fn default_address(core_port: u16) -> Option<String> {
    core_port
        .checked_add(PORT_OFFSET)
        .map(|port| format!("0.0.0.0:{port}"))
}

/// The saved listen address, or the default for this core's port when none is saved.
pub(crate) fn effective_address(config: &GuiConfigFile) -> Result<SocketAddr, String> {
    let saved = config.host_control_address.trim();
    let value = if saved.is_empty() {
        default_address(config.port).ok_or("Enter a listen address for remote control")?
    } else {
        saved.to_string()
    };
    parse_listen_address(&value, config.port)
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
    /// The latest core release for the host's platform and download source.
    Latest,
    /// The host's core install task (progress).
    InstallTask,
    /// Install a core version (`None`: the latest) with the host's download, the official
    /// checksum required, and the client's job id on the task.
    Install { version: Option<String>, job: Option<String> },
    /// Cancel the running install, only if it is this job's.
    CancelInstall { job: String },
    StartCoreOnLaunch(bool),
}

/// `Ok(None)` while the head is incomplete.
pub(crate) fn parse_head(buffer: &[u8]) -> Result<Option<Request>, Reply> {
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut request = httparse::Request::new(&mut headers);
    match request.parse(buffer) {
        Ok(httparse::Status::Complete(length)) if length > MAX_HEAD_BYTES => {
            Err(Reply::error(431, "Request head is too large"))
        }
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
    let not_found = || Reply::error(404, "Not found");
    let path = request.path.strip_prefix(PATH_PREFIX).ok_or_else(not_found)?;
    let (method, route) = match path {
        "/status" => ("GET", Route::Status),
        "/core/start" => ("POST", Route::Operate(HostOperation::Start)),
        "/core/stop" => ("POST", Route::Operate(HostOperation::Stop)),
        "/core/restart" => ("POST", Route::Operate(HostOperation::Restart)),
        "/core/latest" => ("GET", Route::Latest),
        "/core/install" => ("GET", Route::InstallTask),
        "/core/install/cancel" => ("POST", Route::CancelInstall { job: String::new() }),
        "/core/install/latest" => ("POST", Route::Install { version: None, job: None }),
        "/settings/start-core-on-launch/on" => ("POST", Route::StartCoreOnLaunch(true)),
        "/settings/start-core-on-launch/off" => ("POST", Route::StartCoreOnLaunch(false)),
        other => match other.strip_prefix("/core/install/") {
            Some(version) if valid_core_version(version) => {
                ("POST", Route::Install { version: Some(version.to_string()), job: None })
            }
            _ => return Err(not_found()),
        },
    };
    if request.method != method {
        return Err(Reply::error(405, "Method not allowed"));
    }
    let job = match request.single(INSTALL_JOB_HEADER) {
        None => None,
        Some(value) => Some(
            std::str::from_utf8(value)
                .ok()
                .filter(|job| valid_job(job))
                .ok_or_else(|| Reply::error(400, "Invalid install job"))?
                .to_string(),
        ),
    };
    match route {
        Route::Install { version, .. } => Ok(Route::Install { version, job }),
        Route::CancelInstall { .. } => job
            .map(|job| Route::CancelInstall { job })
            .ok_or_else(|| Reply::error(400, "Missing install job")),
        other => Ok(other),
    }
}

pub(crate) const INSTALL_JOB_HEADER: &str = "x-easycli-install-job";

pub(crate) fn valid_job(job: &str) -> bool {
    (16..=64).contains(&job.len()) && job.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

/// Throttles failed authentications per peer address. Only failed keys are counted and only
/// failed keys are refused, so a shared address (NAT, VPN exit) never locks out the right key.
/// The table is bounded: when full, the oldest entry makes room.
#[derive(Default)]
pub(crate) struct FailureLimiter {
    peers: Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

impl FailureLimiter {
    /// Records one failed key; `true` when this peer is over the limit (reply 429, not 401).
    pub(crate) fn record_failure(&self, peer: IpAddr) -> bool {
        let Ok(mut peers) = self.peers.lock() else {
            return true;
        };
        let now = Instant::now();
        peers.retain(|_, (_, since)| now.duration_since(*since) < FAILURE_WINDOW);
        if !peers.contains_key(&peer) && peers.len() >= MAX_TRACKED_PEERS {
            if let Some(oldest) = peers.iter().min_by_key(|(_, (_, since))| *since).map(|(peer, _)| *peer) {
                peers.remove(&oldest);
            }
        }
        let entry = peers.entry(peer).or_insert((0, now));
        entry.0 = entry.0.saturating_add(1);
        entry.0 > MAX_FAILURES
    }

    #[cfg(test)]
    pub(crate) fn tracked(&self) -> usize {
        self.peers.lock().map(|peers| peers.len()).unwrap_or_default()
    }
}

/// Listener limits; tests shorten them.
#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub(crate) head_timeout: Duration,
    pub(crate) max_connections: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            head_timeout: HEAD_TIMEOUT,
            max_connections: MAX_CONNECTIONS,
        }
    }
}

type HostError = (u16, String);

/// What the listener controls. The app implementation drives this computer's core.
pub(crate) trait HostBackend: Send + Sync + 'static {
    fn handle(&self, route: Route) -> BoxFuture<'static, Result<serde_json::Value, HostError>>;
}

pub(crate) struct Context {
    key: String,
    backend: Arc<dyn HostBackend>,
    failures: FailureLimiter,
    limits: Limits,
}

pub(crate) fn new_context(key: String, backend: Arc<dyn HostBackend>) -> Arc<Context> {
    new_context_with(key, backend, Limits::default())
}

pub(crate) fn new_context_with(
    key: String,
    backend: Arc<dyn HostBackend>,
    limits: Limits,
) -> Arc<Context> {
    Arc::new(Context {
        key,
        backend,
        failures: FailureLimiter::default(),
        limits,
    })
}

pub(crate) async fn respond(request: &Request, peer: IpAddr, context: &Context) -> Reply {
    if let Err(reply) = screen(request) {
        return reply;
    }
    if !authenticate(request, &context.key) {
        return if context.failures.record_failure(peer) {
            Reply::error(429, "Too many failed attempts; try again later")
        } else {
            Reply::error(401, "Missing or invalid host control key")
        };
    }
    let route = match route(request) {
        Ok(route) => route,
        Err(reply) => return reply,
    };
    match context.backend.handle(route).await {
        Ok(value) => Reply::json(&value),
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
    let reply = match tokio::time::timeout(context.limits.head_timeout, read_head(&mut stream)).await {
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
    let slots = Arc::new(Semaphore::new(context.limits.max_connections));
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

/// Reasons that are safe to send to the client. Anything else can name local paths (startup
/// logs, install and rollback directories), so it stays in this host's log.
const PUBLIC_REASONS: [&str; 8] = [
    crate::CORE_OPERATION_BUSY,
    "CPA kernel is not currently running",
    "This operation is only available for the local core",
    "Application is exiting; kernel operation canceled",
    crate::OFFICIAL_CHECKSUM_MISSING,
    crate::OFFICIAL_CHECKSUM_MISMATCH,
    "Downloaded file SHA-256 verification failed",
    "Download canceled",
];

/// A message for the wire: a known public reason or a completed-install note, else the generic one.
pub(crate) fn public_message(message: &str) -> String {
    let completed = message.ends_with(" installation complete")
        && !message.contains(['/', '\\'])
        && message.len() <= 80;
    if PUBLIC_REASONS.contains(&message) || completed {
        message.to_string()
    } else {
        PRIVATE_FAILURE.to_string()
    }
}
pub(crate) const PRIVATE_FAILURE: &str =
    "The operation failed on the remote host; the details are in that EasyCLIProxyAPI's log";

/// Busy (another operation holds the core-operation lock) is a conflict; the rest are failures,
/// sent with a public message only.
pub(crate) fn operation_error(error: String) -> HostError {
    if error == crate::CORE_OPERATION_BUSY {
        (409, error)
    } else if PUBLIC_REASONS.contains(&error.as_str()) {
        (500, error)
    } else {
        eprintln!("Remote host control request failed: {error}");
        (500, PRIVATE_FAILURE.into())
    }
}

fn json<T: Serialize>(value: T) -> Result<serde_json::Value, HostError> {
    serde_json::to_value(value).map_err(|error| (500, error.to_string()))
}

async fn host_status(app: tauri::AppHandle) -> Result<HostCoreStatus, HostError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<HostCoreStatus, String> {
        let config = app.state::<GuiConfigState>().snapshot()?;
        let status =
            crate::current_core_status(Some(app.state::<CoreProcessState>().inner()), Some(config.port))?;
        Ok(HostCoreStatus {
            start_core_on_launch: Some(config.start_core_on_launch),
            ..HostCoreStatus::from_status(&status)
        })
    })
    .await
    .map_err(|error| operation_error(error.to_string()))?
    .map_err(operation_error)
}

fn with_start_core_on_launch(app: &tauri::AppHandle, status: &CoreStatus) -> HostCoreStatus {
    HostCoreStatus {
        start_core_on_launch: app
            .state::<GuiConfigState>()
            .snapshot()
            .ok()
            .map(|config| config.start_core_on_launch),
        ..HostCoreStatus::from_status(status)
    }
}

impl HostBackend for AppBackend {
    fn handle(&self, route: Route) -> BoxFuture<'static, Result<serde_json::Value, HostError>> {
        let app = self.0.clone();
        Box::pin(async move {
            require_host_mode(&app)?;
            match route {
                Route::Status => json(host_status(app).await?),
                // Same path as this app's buttons: lock, Local check, lifecycle, status event.
                Route::Operate(operation) => {
                    let status = crate::run_core_command(app.clone(), operation.local())
                        .await
                        .map_err(operation_error)?;
                    json(with_start_core_on_launch(&app, &status))
                }
                Route::Latest => json(
                    crate::check_latest_core_local(&app)
                        .await
                        .map_err(|error| (500, error))?,
                ),
                Route::InstallTask => {
                    json(task_without_paths(app.state::<CoreDownloadState>().snapshot()))
                }
                // The host's own install: core-operation lock, staged download, checksum, swap
                // with rollback, and the previous running state restored. Progress also shows on
                // the host's window.
                Route::Install { version, job } => {
                    let window = crate::main_window(&app)
                        .ok_or((500, "The host app's main window is not available".to_string()))?;
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        crate::install_core_version_blocking(&app, &window, version, true, job)
                    })
                    .await
                    .map_err(|error| (500, error.to_string()))?
                    .map_err(operation_error)?;
                    json(without_paths(result))
                }
                Route::CancelInstall { job } => {
                    let state = app.state::<CoreDownloadState>();
                    let task = state.snapshot();
                    if task.running && task.job.as_deref() != Some(job.as_str()) {
                        return Err((409, "Another install is running on this host".into()));
                    }
                    if task.running {
                        state.cancel();
                    }
                    json(task_without_paths(state.snapshot()))
                }
                Route::StartCoreOnLaunch(enabled) => {
                    app.state::<GuiConfigState>()
                        .update(|config| {
                            config.start_core_on_launch = enabled;
                            Ok(())
                        })
                        .map_err(|error| (500, error))?;
                    json(host_status(app).await?)
                }
            }
        })
    }
}

struct RunningListener {
    address: SocketAddr,
    key: String,
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

/// What the listener should be, from saved settings: `None` when off, or the address and key.
pub(crate) fn desired_listener(config: &GuiConfigFile) -> Result<Option<(SocketAddr, String)>, String> {
    if !config.host_control_enabled {
        return Ok(None);
    }
    if config.connection_mode != CoreConnectionMode::Local {
        return Err(REMOTE_MODE_PAUSED.into());
    }
    let address = effective_address(config)?;
    validate_host_key(config)?;
    Ok(Some((address, config.host_control_key.clone())))
}

/// Woken whenever a configuration change alters the desired listener, from any path: the panel,
/// network settings (the default port follows the core port), external core-config syncs or a
/// connection change.
static LISTENER_SETTINGS_CHANGED: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub(crate) fn note_config_change(before: &GuiConfigFile, after: &GuiConfigFile) {
    if desired_listener(before) != desired_listener(after) {
        LISTENER_SETTINGS_CHANGED.notify_one();
    }
}

/// Applies the saved settings at startup and again after every change that affects the listener.
pub(crate) fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        apply(app.clone()).await;
        loop {
            LISTENER_SETTINGS_CHANGED.notified().await;
            apply(app.clone()).await;
        }
    });
}

/// Refuses a core port that is this app's explicit remote-control listen port while remote
/// control is allowed. (The default listen port is the core's port + 100 and moves with it.)
pub(crate) fn check_core_port(config: &GuiConfigFile) -> Result<(), String> {
    let saved = config.host_control_address.trim();
    if config.host_control_enabled
        && !saved.is_empty()
        && saved.parse::<SocketAddr>().is_ok_and(|address| address.port() == config.port)
    {
        return Err("The core port must differ from the remote control listen port".into());
    }
    Ok(())
}

/// Starts, restarts or stops the listener to match the saved settings; a listener that already
/// matches is left alone. Fails closed: invalid settings, Remote mode or a bind error leave it
/// stopped, with the reason in the settings view.
pub(crate) async fn apply(app: tauri::AppHandle) {
    let state = app.state::<HostControlState>();
    let mut running = state.listener.lock().await;
    let desired = app
        .state::<GuiConfigState>()
        .snapshot()
        .and_then(|config| desired_listener(&config));
    if let (Some(current), Ok(Some((address, key)))) = (running.as_ref(), &desired) {
        if current.address == *address && current.key == *key {
            return;
        }
    }
    if let Some(previous) = running.take() {
        previous.cancel.cancel();
        let _ = previous.task.await;
    }
    let status = match desired {
        Ok(None) => ListenerStatus::default(),
        Ok(Some((address, key))) => match TcpListener::bind(address).await {
            Ok(listener) => {
                let bound = listener
                    .local_addr()
                    .map(|bound| bound.to_string())
                    .unwrap_or_else(|_| address.to_string());
                let context = new_context(key.clone(), Arc::new(AppBackend(app.clone())));
                let cancel = CancellationToken::new();
                let task = tauri::async_runtime::spawn(serve(listener, context, cancel.clone()));
                *running = Some(RunningListener { address, key, cancel, task });
                ListenerStatus { listening: Some(bound), error: None }
            }
            Err(error) => ListenerStatus {
                listening: None,
                error: Some(format!("Cannot listen on {address}: {error}")),
            },
        },
        Err(error) => ListenerStatus { listening: None, error: Some(error) },
    };
    if let Some(error) = &status.error {
        eprintln!("Remote host control is not running: {error}");
    }
    if let Ok(mut current) = state.status.lock() {
        *current = status;
    };
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostControlSettings {
    enabled: bool,
    /// Saved address; empty means `default_address`.
    address: String,
    default_address: Option<String>,
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
        default_address: default_address(config.port),
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
    if !address.is_empty() {
        parse_listen_address(&address, config.port)?;
    }
    if update.enabled && config.connection_mode != CoreConnectionMode::Local {
        return Err(REMOTE_MODE_PAUSED.into());
    }
    if update.regenerate_key || (update.enabled && config.host_control_key.is_empty()) {
        config.host_control_key = generate_key()?;
    }
    config.host_control_enabled = update.enabled;
    config.host_control_address = address;
    if config.host_control_enabled {
        effective_address(config)?;
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
    Err(host_error(status, body))
}

/// Error text for a non-200 host reply; the host's own message is sanitised.
pub(crate) fn host_error(status: u16, body: &[u8]) -> String {
    let message = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("error")?.as_str().map(|text| display_text(text, 300)))
        .filter(|message| !message.is_empty());
    match status {
        401 => "Remote host rejected the host control key".into(),
        403 => "Remote host refused the request".into(),
        404 => "Remote host does not offer this host control request (update EasyCLIProxyAPI there, or check the URL)".into(),
        429 => "Too many failed attempts; try again in a minute".into(),
        _ => message.unwrap_or_else(|| format!("Remote host control failed (HTTP {status})")),
    }
}

async fn host_body(
    origin: &str,
    key: &str,
    method: reqwest::Method,
    path: &str,
    timeout: Duration,
    job: Option<&str>,
) -> Result<(u16, Vec<u8>), String> {
    let mut request = host_http_client()?
        .request(method, format!("{origin}{PATH_PREFIX}/{path}"))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .header(PROTOCOL_HEADER, "1")
        .timeout(timeout);
    if let Some(job) = job {
        request = request.header(INSTALL_JOB_HEADER, job);
    }
    let mut response = request
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
    Ok((status, body))
}

async fn host_request(
    origin: &str,
    key: &str,
    method: reqwest::Method,
    path: &str,
    timeout: Duration,
) -> Result<HostCoreStatus, String> {
    let (status, body) = host_body(origin, key, method, path, timeout, None).await?;
    parse_host_response(status, &body)
}

async fn host_request_json<T: DeserializeOwned>(
    connection: &CoreConnection,
    method: reqwest::Method,
    path: &str,
    timeout: Duration,
) -> Result<T, String> {
    host_request_job(connection, method, path, timeout, None).await
}

async fn host_request_job<T: DeserializeOwned>(
    connection: &CoreConnection,
    method: reqwest::Method,
    path: &str,
    timeout: Duration,
    job: Option<&str>,
) -> Result<T, String> {
    let (status, body) = host_body(
        &connection.host_control_origin,
        &connection.host_control_key,
        method,
        path,
        timeout,
        job,
    )
    .await?;
    if status != 200 {
        return Err(host_error(status, &body));
    }
    serde_json::from_slice(&body).map_err(|_| "Remote host control returned an invalid reply".to_string())
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

/// `None` in Local mode. In Remote mode the saved connection, or the refusal when host control is
/// not set up.
fn remote_host(app: &tauri::AppHandle) -> Option<Result<CoreConnection, String>> {
    let config = match app.state::<GuiConfigState>().snapshot() {
        Ok(config) => config,
        Err(error) => return Some(Err(error)),
    };
    if config.connection_mode != CoreConnectionMode::Remote {
        return None;
    }
    let connection = CoreConnection::from(&config);
    Some(if connection.host_control_origin.is_empty() {
        Err(NOT_CONFIGURED.into())
    } else {
        Ok(connection)
    })
}

/// `None` in Local mode. In Remote mode, sends the operation to the remote host's EasyCLIProxyAPI,
/// or refuses when host control is not set up.
pub(crate) async fn forward_remote_core_command(
    app: &tauri::AppHandle,
    operation: HostOperation,
) -> Option<Result<CoreStatus, String>> {
    let connection = match remote_host(app)? {
        Ok(connection) => connection,
        Err(error) => return Some(Err(error)),
    };
    Some(remote_core_command(app, connection, operation).await)
}

/// Tray Start/Stop (by the current remote state) or Restart, through remote host control.
pub(crate) async fn remote_tray_action(
    app: &tauri::AppHandle,
    restart: bool,
) -> Result<CoreStatus, String> {
    let connection = remote_host(app).ok_or("This tray action is only for a remote core")??;
    let operation = if restart {
        HostOperation::Restart
    } else if crate::core_connection::current_remote_status(&connection)
        .await
        .running
    {
        HostOperation::Stop
    } else {
        HostOperation::Start
    };
    remote_core_command(app, connection, operation).await
}

/// `None` in Local mode; the host's latest core release in Remote mode.
pub(crate) async fn forward_check_latest(app: &tauri::AppHandle) -> Option<Result<CoreLatest, String>> {
    let connection = match remote_host(app)? {
        Ok(connection) => connection,
        Err(error) => return Some(Err(error)),
    };
    Some(host_request_json(&connection, reqwest::Method::GET, "core/latest", LATEST_TIMEOUT).await)
}

/// `None` in Local mode; the host's install task in Remote mode (idle when not set up).
pub(crate) async fn forward_install_task(app: &tauri::AppHandle) -> Option<Result<CoreInstallTask, String>> {
    let connection = match remote_host(app)? {
        Ok(connection) => connection,
        Err(_) => return Some(Ok(app.state::<CoreDownloadState>().snapshot())),
    };
    Some(host_request_json(&connection, reqwest::Method::GET, "core/install", STATUS_TIMEOUT).await)
}

/// The remote install this app started: its target and job. While it runs the connection cannot
/// change, progress is relayed only for this job, and Cancel goes to this target and job.
static REMOTE_INSTALL: Mutex<Option<(CoreConnection, String)>> = Mutex::new(None);

pub(crate) struct RemoteInstallGuard;

impl Drop for RemoteInstallGuard {
    fn drop(&mut self) {
        if let Ok(mut install) = REMOTE_INSTALL.lock() {
            *install = None;
        }
    }
}

pub(crate) fn begin_remote_install(
    connection: &CoreConnection,
    job: &str,
) -> Result<RemoteInstallGuard, String> {
    let mut install = REMOTE_INSTALL
        .lock()
        .map_err(|_| "Remote install state is poisoned".to_string())?;
    if install.is_some() {
        return Err("An install on the remote host started from this app is still running".into());
    }
    *install = Some((connection.clone(), job.to_string()));
    Ok(RemoteInstallGuard)
}

/// Refuses connection changes while this app's remote install runs.
pub(crate) fn ensure_no_remote_install() -> Result<(), String> {
    match REMOTE_INSTALL.lock() {
        Ok(install) if install.is_none() => Ok(()),
        _ => Err("Wait for the core install on the remote host to finish before changing the connection".into()),
    }
}

fn running_remote_install() -> Option<(CoreConnection, String)> {
    REMOTE_INSTALL.lock().ok().and_then(|install| install.clone())
}

pub(crate) fn new_job_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("Failed to create an install job id: {error}"))?;
    Ok(format!("job-{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()))
}

/// A host task is relayed only when it is this job's and the install's target is still current.
pub(crate) fn relays_task(
    task: &CoreInstallTask,
    job: &str,
    install_target: &CoreConnection,
    current_target: Option<&CoreConnection>,
) -> bool {
    task.job.as_deref() == Some(job) && current_target == Some(install_target)
}

fn current_target(app: &tauri::AppHandle) -> Option<CoreConnection> {
    app.state::<GuiConfigState>()
        .snapshot()
        .ok()
        .map(|config| CoreConnection::from(&config))
}

/// Cancels only the install this app started, on the target it started on.
pub(crate) async fn forward_cancel_install(app: &tauri::AppHandle) -> Option<Result<(), String>> {
    let _ = remote_host(app)?;
    let Some((connection, job)) = running_remote_install() else {
        return Some(Err("No install started from this app is running on the remote host".into()));
    };
    Some(
        host_request_job::<CoreInstallTask>(
            &connection,
            reqwest::Method::POST,
            "core/install/cancel",
            STATUS_TIMEOUT,
            Some(&job),
        )
        .await
        .map(|_| ()),
    )
}

/// `None` in Local mode. In Remote mode, installs on the remote host: the request returns when the
/// host has finished; meanwhile this job's host task is polled and re-emitted as this window's
/// install progress, so the Version Management dialog works unchanged. Snapshots of an earlier or
/// another client's task (or from before the host has started this job) are never relayed.
pub(crate) async fn forward_install(
    app: &tauri::AppHandle,
    version: Option<String>,
) -> Option<Result<CoreInstallResult, String>> {
    let connection = match remote_host(app)? {
        Ok(connection) => connection,
        Err(error) => return Some(Err(error)),
    };
    let path = match version.as_deref().map(str::trim) {
        None | Some("") => "core/install/latest".to_string(),
        Some(version) if valid_core_version(version) => format!("core/install/{version}"),
        Some(_) => return Some(Err("Invalid core version".into())),
    };
    let job = match new_job_id() {
        Ok(job) => job,
        Err(error) => return Some(Err(error)),
    };
    let _guard = match begin_remote_install(&connection, &job) {
        Ok(guard) => guard,
        Err(error) => return Some(Err(error)),
    };
    let relay = |task: CoreInstallTask| {
        if relays_task(&task, &job, &connection, current_target(app).as_ref()) {
            let _ = app.emit(crate::CORE_INSTALL_PROGRESS_EVENT, task);
        }
    };
    let install = host_request_job::<CoreInstallResult>(
        &connection,
        reqwest::Method::POST,
        &path,
        INSTALL_TIMEOUT,
        Some(&job),
    );
    tokio::pin!(install);
    let mut ticker = tokio::time::interval(INSTALL_POLL);
    let result = loop {
        tokio::select! {
            result = &mut install => break result,
            _ = ticker.tick() => {
                if let Ok(task) = host_request_json::<CoreInstallTask>(
                    &connection, reqwest::Method::GET, "core/install", STATUS_TIMEOUT,
                ).await {
                    relay(task);
                }
            }
        }
    };
    if let Ok(task) =
        host_request_json::<CoreInstallTask>(&connection, reqwest::Method::GET, "core/install", STATUS_TIMEOUT).await
    {
        relay(task);
    }
    let status = crate::core_connection::current_remote_status(&connection).await;
    let _ = crate::core_connection::publish_remote_status(app, &connection, status);
    Some(result)
}

/// The remote host app's Start Core on Launch; `None` without host control or from an older host.
#[tauri::command]
pub(crate) async fn get_remote_start_core_on_launch(
    app: tauri::AppHandle,
) -> Result<Option<bool>, String> {
    match remote_host(&app) {
        Some(Ok(connection)) => Ok(fetch_host_status(
            &connection.host_control_origin,
            &connection.host_control_key,
        )
        .await?
        .start_core_on_launch),
        Some(Err(_)) => Ok(None),
        None => Err("Start Core on Launch of a remote host applies only in Remote mode".into()),
    }
}

#[tauri::command]
pub(crate) async fn set_remote_start_core_on_launch(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<bool, String> {
    let connection = remote_host(&app)
        .ok_or("Start Core on Launch of a remote host applies only in Remote mode")??;
    let path = format!(
        "settings/start-core-on-launch/{}",
        if enabled { "on" } else { "off" }
    );
    host_request(
        &connection.host_control_origin,
        &connection.host_control_key,
        reqwest::Method::POST,
        &path,
        STATUS_TIMEOUT,
    )
    .await?
    .start_core_on_launch
    .ok_or_else(|| "The remote host did not confirm the setting".into())
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
