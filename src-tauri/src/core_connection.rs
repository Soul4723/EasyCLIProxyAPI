use super::*;
use std::sync::atomic::AtomicU64;

const PORTABLE_CONNECTION_FORMAT: &str = "easycli-proxy-connection";
const PORTABLE_CONNECTION_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ConnectionMode {
    #[default]
    Local,
    Remote,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct CoreConnection {
    pub(crate) mode: ConnectionMode,
    pub(crate) remote_management_origin: String,
    pub(crate) remote_management_key: String,
    pub(crate) client_api_origin: String,
    pub(crate) client_api_key: String,
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
    mode: ConnectionMode,
    remote_management_origin: String,
    client_api_origin: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_management_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_api_key: Option<String>,
}

impl PortableConnectionFile {
    fn from_connection(connection: &CoreConnection, include_secrets: bool) -> Self {
        Self {
            format: PORTABLE_CONNECTION_FORMAT.to_string(),
            version: PORTABLE_CONNECTION_VERSION,
            connection: PortableConnection {
                mode: connection.mode,
                remote_management_origin: connection.remote_management_origin.clone(),
                client_api_origin: connection.client_api_origin.clone(),
                remote_management_key: include_secrets.then(|| connection.remote_management_key.clone()),
                client_api_key: include_secrets.then(|| connection.client_api_key.clone()),
            },
        }
    }

    fn into_connection(self) -> Result<CoreConnection, String> {
        if self.format != PORTABLE_CONNECTION_FORMAT || self.version != PORTABLE_CONNECTION_VERSION {
            return Err("Unsupported connection export format".to_string());
        }
        let mut connection = CoreConnection {
            mode: self.connection.mode,
            remote_management_origin: self.connection.remote_management_origin,
            remote_management_key: self.connection.remote_management_key.unwrap_or_default(),
            client_api_origin: self.connection.client_api_origin,
            client_api_key: self.connection.client_api_key.unwrap_or_default(),
        };
        if connection.mode != ConnectionMode::Remote {
            return Err("Portable connection exports must target a remote core".to_string());
        }
        connection.remote_management_origin = normalize_origin(&connection.remote_management_origin)?;
        if connection.remote_management_key.chars().any(char::is_control) {
            return Err("Connection export contains invalid management credentials".to_string());
        }
        if connection.client_api_origin.chars().any(char::is_control) || connection.client_api_key.chars().any(char::is_control) {
            return Err("Connection export contains invalid client credentials".to_string());
        }
        if !connection.client_api_origin.trim().is_empty() {
            connection.client_api_origin = normalize_origin(&connection.client_api_origin)?;
            if connection.client_api_key.is_empty() { return Err("Connection export has a client origin without a client key".to_string()); }
        } else if !connection.client_api_key.is_empty() {
            return Err("Connection export has a client key without a client origin".to_string());
        }
        Ok(connection)
    }
}

static TARGET: Mutex<Option<CoreConnection>> = Mutex::new(None);
static REVISION: AtomicU64 = AtomicU64::new(0);
// Target operations hold a read lease. Switching waits for their completion, so
// an old operation cannot write client files after another target becomes active.
static OPERATIONS: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

pub(crate) fn initialize(connection: &CoreConnection) {
    *TARGET.lock().expect("core connection lock") = Some(connection.clone());
}

pub(crate) fn revision() -> u64 {
    REVISION.load(Ordering::Acquire)
}

pub(crate) fn active_connection() -> CoreConnection {
    TARGET.lock().expect("core connection lock").clone().unwrap_or_default()
}

pub(crate) fn target_operation() -> Result<tokio::sync::RwLockReadGuard<'static, ()>, String> {
    OPERATIONS.try_read().map_err(|_| "Core connection is changing; retry operation".to_string())
}

pub(crate) fn local_operation() -> Result<tokio::sync::RwLockReadGuard<'static, ()>, String> {
    let guard = OPERATIONS.try_read().map_err(|_| "Core connection is changing; retry operation".to_string())?;
    require_local(&active_connection())?;
    Ok(guard)
}

fn require_local(connection: &CoreConnection) -> Result<(), String> {
    if connection.is_remote() { return Err("This local operation is unavailable in remote mode".to_string()); }
    Ok(())
}

pub(crate) fn ensure_current(config: &GuiConfigFile) -> Result<(), String> {
    ensure_same_target(config, revision(), &active_connection())
}

fn ensure_same_target(config: &GuiConfigFile, revision: u64, connection: &CoreConnection) -> Result<(), String> {
    if config.target_revision != revision || &config.core_connection != connection {
        return Err("Core connection changed; discard old response".to_string());
    }
    Ok(())
}

pub(crate) fn normalize_origin(value: &str) -> Result<String, String> {
    if value.chars().any(char::is_control) { return Err("Core origin cannot contain control characters".into()); }
    let value = value.trim();
    // Check raw syntax before URL parsing can erase paths, dot segments or backslashes.
    let (scheme, authority) = value.split_once("://").ok_or("Core origin must start with http:// or https://")?;
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    if !["http", "https"].iter().any(|allowed| scheme.eq_ignore_ascii_case(allowed))
        || authority.is_empty() || authority.contains(['/', '?', '#', '\\', '@', ' '])
    {
        return Err("Core origin must be HTTP or HTTPS without credentials, path, query, or fragment".into());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid core origin; use http://host:port or https://host:port".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some()
        || !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some()
        || url.port() == Some(0)
    {
        return Err("Core origin must be HTTP or HTTPS without credentials, path, query, or fragment".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

impl CoreConnection {
    pub(crate) fn is_remote(&self) -> bool { self.mode == ConnectionMode::Remote }

    pub(crate) fn normalize(mut self) -> Result<Self, String> {
        if self.is_remote() || !self.remote_management_origin.trim().is_empty() {
            self.remote_management_origin = normalize_origin(&self.remote_management_origin)?;
        }
        if self.client_api_origin.chars().any(char::is_control) {
            return Err("Client API origin cannot contain control characters".into());
        }
        if !self.client_api_origin.trim().is_empty() {
            self.client_api_origin = normalize_origin(&self.client_api_origin)?;
        }
        if self.client_api_key.chars().any(char::is_control) {
            return Err("Client API key cannot contain control characters".into());
        }
        validate_management_secret_key(&self.remote_management_key)?;
        self.remote_management_key = self.remote_management_key.trim().to_string();
        self.client_api_key = self.client_api_key.trim().to_string();
        if self.is_remote() { validate_strong_management_secret_key(&self.remote_management_key)?; }
        Ok(self)
    }

    pub(crate) fn usage_namespace(&self) -> Option<String> {
        // Keys may rotate without splitting one server's history. Never put
        // credentials into paths or combine remote records with local history.
        self.is_remote().then(|| sha256_bytes(self.remote_management_origin.as_bytes()))
    }
}

#[tauri::command]
pub(crate) fn get_core_connection(gui_config_state: tauri::State<'_, GuiConfigState>) -> Result<CoreConnection, String> {
    Ok(gui_config_state.snapshot()?.core_connection)
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
    if !config.core_connection.is_remote() {
        return Err("Switch to Remote mode before exporting connection settings".to_string());
    }
    let document = serde_json::to_vec_pretty(&PortableConnectionFile::from_connection(&config.core_connection, include_secrets))
        .map_err(|error| format!("Failed to create connection export: {error}"))?;
    let temporary = path.with_extension(format!("{}{}.tmp", path.extension().and_then(|v| v.to_str()).map(|v| format!("{v}.")).unwrap_or_default(), std::process::id()));
    if let Err(error) = fs::write(&temporary, [document.as_slice(), b"\n"].concat()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Failed to write connection export: {error}"));
    }
    let backup = path.with_extension(format!("{}{}.bak", path.extension().and_then(|v| v.to_str()).map(|v| format!("{v}.")).unwrap_or_default(), std::process::id()));
    let had_existing = path.exists();
    if had_existing { let _ = fs::remove_file(&backup); fs::rename(&path, &backup).map_err(|error| { let _ = fs::remove_file(&temporary); format!("Failed to prepare connection export: {error}") })?; }
    if let Err(error) = fs::rename(&temporary, &path) {
        if had_existing { let _ = fs::rename(&backup, &path); }
        let _ = fs::remove_file(&temporary);
        return Err(format!("Failed to finalize connection export: {error}"));
    }
    if had_existing { let _ = fs::remove_file(&backup); }
    Ok(())
}

#[tauri::command]
pub(crate) fn import_core_connection(path: String) -> Result<CoreConnection, String> {
    let path = portable_path(&path)?;
    let content = fs::read_to_string(path).map_err(|error| format!("Failed to read connection export: {error}"))?;
    let export: PortableConnectionFile = serde_json::from_str(&content).map_err(|_| "Connection export is invalid or corrupted".to_string())?;
    export.into_connection()
}

fn validate_owned_local_children(core_running: bool, harness_running: bool) -> Result<(), String> {
    if core_running {
        return Err("Stop the local core before switching to Remote; its process lifetime belongs to this app.".to_string());
    }
    if harness_running {
        return Err("Stop the managed DeepSeek Harness before switching to Remote; its process lifetime belongs to this app.".to_string());
    }
    Ok(())
}

fn require_no_owned_local_children(core: &CoreProcessState, harness: &DeepSeekHarnessProcessState) -> Result<(), String> {
    // Inspect only GUI-owned children. Adopted/external cores have no GUI-bound
    // OS lifetime and may continue running while attached remotely. Probe errors
    // reject the switch without dropping, stopping, or detaching either child.
    let core_running = match core.child.lock().map_err(|_| "Local core process status lock is poisoned".to_string())?.as_mut() {
        Some(child) => child.try_wait().map_err(|error| format!("Failed to check local core process status: {error}"))?.is_none(),
        None => false,
    };
    let harness_running = match harness.process.lock().map_err(|_| "DeepSeek Harness process status lock is poisoned".to_string())?.as_mut() {
        Some(managed) => managed.child.try_wait().map_err(|error| format!("Failed to check DeepSeek Harness process status: {error}"))?.is_none(),
        None => false,
    };
    validate_owned_local_children(core_running, harness_running)
}

#[tauri::command]
pub(crate) async fn save_core_connection(
    app: tauri::AppHandle,
    connection: CoreConnection,
) -> Result<CoreConnection, String> {
    let connection = connection.normalize()?;
    let _guard = OPERATIONS.write().await;
    // Persist only connection fields. In particular, do not sanitize local auth
    // paths or mirror remote configuration into the saved local settings.
    let state = app.state::<GuiConfigState>();
    let mut current = state.inner.lock().map_err(|_| "GUI configuration lock is poisoned".to_string())?;
    if current.core_connection == connection { return Ok(connection); }
    if !current.core_connection.is_remote() && connection.is_remote() {
        require_no_owned_local_children(
            app.state::<CoreProcessState>().inner(),
            app.state::<DeepSeekHarnessProcessState>().inner(),
        )?;
    }
    // Prepare the selected database before either persisted or active target changes.
    // A failed migration must leave the old target available.
    usage::initialize_usage_storage_for_connection(&connection)?;
    let mut next = current.clone();
    next.core_connection = connection.clone();
    write_gui_config(&next)?;
    initialize(&connection);
    REVISION.fetch_add(1, Ordering::AcqRel);
    next.target_revision = revision();
    *current = next;
    drop(current);
    app.state::<AgentConfigStatusCache>().clear()?;
    app.state::<CoreProcessState>().set_starting(false);
    app.state::<usage::UsageCollectorState>().reset_target();
    if connection.is_remote() {
        emit_core_status(&app, &remote_status_value(&connection, false, None, "Remote management connection pending".to_string()));
    } else if let Ok(status) = current_core_status(Some(app.state::<CoreProcessState>().inner()), Some(state.snapshot()?.port)) {
        emit_core_status(&app, &status);
    }
    let _ = app.emit("core-connection-changed", &connection);
    request_codex_model_catalog_refresh();
    Ok(connection)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionTestResult {
    pub(crate) version: Option<String>,
    pub(crate) message: String,
}

pub(crate) async fn probe(config: &GuiConfigFile) -> Result<ConnectionTestResult, String> {
    let response = management_http_client()?
        .get(management_endpoint(config, "config")?)
        .header("Authorization", management_authorization(config)?)
        .send().await
        .map_err(|error| format_management_request_error("Failed to reach core management API", &error))?;
    let version = ["x-cpa-version", "x-cliproxyapi-version", "x-cli-proxy-api-version"]
        .iter().find_map(|name| response.headers().get(*name)?.to_str().ok())
        .map(str::trim).filter(|version| !version.is_empty()).map(str::to_string);
    if !read_management_value(response).await?.is_object() {
        return Err("Management API returned an invalid configuration response".to_string());
    }
    Ok(ConnectionTestResult { version, message: "Authenticated management connection successful".to_string() })
}

#[tauri::command]
pub(crate) async fn test_core_connection(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    connection: CoreConnection,
) -> Result<ConnectionTestResult, String> {
    let mut config = gui_config_state.snapshot()?;
    config.core_connection = connection.normalize()?;
    probe(&config).await
}

pub(crate) async fn remote_status(config: &GuiConfigFile) -> Result<CoreStatus, String> {
    let result = probe(config).await;
    ensure_current(config)?;
    let (ready, version, message) = match result {
        Ok(result) => (true, result.version, result.message),
        Err(error) => (false, None, error),
    };
    Ok(remote_status_value(&config.core_connection, ready, version, message))
}

fn remote_status_value(connection: &CoreConnection, ready: bool, version: Option<String>, message: String) -> CoreStatus {
    CoreStatus {
        connection_mode: ConnectionMode::Remote,
        remote_origin: Some(connection.remote_management_origin.clone()),
        installed: false, running: ready, ready, starting: false, managed: false,
        process_id: None, current_version: version, install_dir: String::new(), binary_path: None, message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_connection_export_excludes_secrets_by_default_and_round_trips_when_present() {
        let connection = CoreConnection {
            mode: ConnectionMode::Remote,
            remote_management_origin: "https://core.example".into(),
            remote_management_key: "management-secret".into(),
            client_api_origin: "https://client.example".into(),
            client_api_key: "client-secret".into(),
        };
        let safe = serde_json::to_string(&PortableConnectionFile::from_connection(&connection, false)).unwrap();
        assert!(!safe.contains("management-secret"));
        assert!(!safe.contains("client-secret"));
        let without = PortableConnectionFile::from_connection(&connection, false).into_connection().unwrap();
        assert!(without.remote_management_key.is_empty());
        assert!(without.client_api_key.is_empty());
        let with = PortableConnectionFile::from_connection(&connection, true).into_connection().unwrap();
        assert_eq!(with, connection);
    }

    #[test]
    fn portable_connection_rejects_unknown_format_and_relative_paths() {
        let bad = r#"{"format":"other","version":1,"connection":{"mode":"remote","remoteManagementOrigin":"https://core.example","clientApiOrigin":""}}"#;
        let parsed: PortableConnectionFile = serde_json::from_str(bad).unwrap();
        assert!(parsed.into_connection().is_err());
        assert!(portable_path("connection.json").is_err());
        assert!(portable_path("/tmp/../connection.json").is_err());
    }

    #[test]
    fn connection_validation_and_storage_keep_targets_separate() {
        for origin in ["http://host:8317", "https://host", "http://[::1]:8317/", " HTTP://HOST:8317/ "] {
            assert!(normalize_origin(origin).is_ok());
        }
        for origin in ["ftp://host", "https://u:p@host", "https://host/path", "https://host?q=1", "https://host/#key", "https://host/v1/..", "https://host/%2e", "https://host?", "https://host#", "https://host/?", "https://host/#", r"https://host\", r"https:\host", r"https://host\v1\..", "https://@host", "https://host:0"] {
            assert!(normalize_origin(origin).is_err(), "{origin}");
        }
        for origin in ["https://host/v1/..", "https://host?", "https://host#", r"https://host\", "\n"] {
            let connection = CoreConnection { client_api_origin: origin.into(), ..CoreConnection::default() };
            assert!(connection.normalize().is_err(), "client origin {origin:?}");
        }
        assert!(CoreConnection { remote_management_key: "\nsecret".into(), ..CoreConnection::default() }.normalize().is_err());
        let connection = CoreConnection {
            mode: ConnectionMode::Remote,
            remote_management_origin: "https://example.com/".into(),
            remote_management_key: "management-secret".into(),
            client_api_origin: "http://example.com:8317".into(),
            client_api_key: "client-secret".into(),
        }.normalize().unwrap();
        let mut config = GuiConfigFile::default();
        let local_key = config.management_secret_key.clone();
        config.core_connection = connection.clone();
        let restored: GuiConfigFile = toml::from_str(&toml::to_string(&config).unwrap()).unwrap();
        assert_eq!(restored.core_connection, connection);
        assert_eq!(restored.management_secret_key, local_key);
        let directory = std::env::temp_dir().join(format!("cpa-connection-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.toml");
        write_gui_config_to_path(&config, &path).unwrap();
        let persisted: GuiConfigFile = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(persisted.core_connection, connection);
        assert_eq!(persisted.management_secret_key, local_key);
        fs::remove_dir_all(directory).unwrap();
        assert_eq!(management_authorization(&restored).unwrap(), "Bearer management-secret");
        assert_eq!(management_endpoint(&restored, "config").unwrap(), "https://example.com/v8/management/config");
        assert!(CoreConnection::default().usage_namespace().is_none());
        let mut rotated = connection.clone();
        rotated.remote_management_key = "rotated".into();
        assert_eq!(connection.usage_namespace(), rotated.usage_namespace());
        rotated.remote_management_origin = "https://another.example.com".into();
        assert_ne!(connection.usage_namespace(), rotated.usage_namespace());
    }
    fn mock_core(status: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let response = format!("HTTP/1.1 {status}\r\nX-CPA-VERSION: 8.0.29\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            socket.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (origin, thread)
    }

    fn remote_config(origin: String) -> GuiConfigFile {
        let mut config = GuiConfigFile::default();
        config.core_connection = CoreConnection {
            mode: ConnectionMode::Remote,
            remote_management_origin: origin,
            remote_management_key: "remote-management-key".into(),
            client_api_origin: "http://different-client.example:9000".into(),
            client_api_key: "client-key-must-not-leak".into(),
        };
        config.management_secret_key = "local-key-must-not-leak".into();
        config
    }

    #[tokio::test]
    async fn probe_authenticates_remote_target_and_reads_version() {
        let (origin, server) = mock_core("200 OK", "{\"server\":{\"port\":8317}}");
        let config = remote_config(origin);
        let result = probe(&config).await.unwrap();
        assert_eq!(result.version.as_deref(), Some("8.0.29"));
        let request = server.join().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /v8/management/config http/1.1\r\n"));
        assert!(request.contains("authorization: bearer remote-management-key\r\n"));
        assert!(!request.contains("client-key-must-not-leak"));
        assert!(!request.contains("local-key-must-not-leak"));
    }

    #[tokio::test]
    async fn probe_rejects_bad_auth_and_disconnection() {
        let (origin, server) = mock_core("401 Unauthorized", "{\"error\":\"invalid management key\"}");
        let error = probe(&remote_config(origin)).await.err().unwrap();
        assert!(error.contains("401"));
        assert!(error.contains("invalid management key"));
        server.join().unwrap();
        let (origin, server) = mock_core("200 OK", "<html>login page</html>");
        assert!(probe(&remote_config(origin)).await.is_err());
        server.join().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        assert!(probe(&remote_config(origin)).await.is_err());
    }

    #[tokio::test]
    async fn old_target_response_is_rejected_after_revision_or_target_change() {
        let (origin, server) = mock_core("200 OK", "{}");
        let mut snapshot = remote_config(origin);
        snapshot.target_revision = 7;
        assert!(probe(&snapshot).await.is_ok());
        server.join().unwrap();
        assert!(ensure_same_target(&snapshot, 7, &snapshot.core_connection).is_ok());
        assert!(ensure_same_target(&snapshot, 8, &snapshot.core_connection).is_err());
        assert!(ensure_same_target(&snapshot, 7, &CoreConnection::default()).is_err());
        assert!(require_local(&snapshot.core_connection).is_err());
        assert!(require_local(&CoreConnection::default()).is_ok());
        let status = remote_status_value(&snapshot.core_connection, true, Some("8.0.29".into()), "Connected".into());
        assert!(status.running && status.ready);
        assert!(!status.installed && !status.managed);
        assert!(status.process_id.is_none() && status.binary_path.is_none());
        assert!(status.install_dir.is_empty());
    }

    #[test]
    fn external_gui_edits_cannot_switch_active_target() {
        let mut initial = GuiConfigFile::default();
        initial.target_revision = 42;
        let state = GuiConfigState::new(initial.clone());
        let mut edited = remote_config("http://example.com:8317".into());
        edited.target_revision = 99;
        edited.locale = "ja".into();
        state.replace_external(edited).unwrap();
        let saved = state.inner.lock().unwrap();
        assert_eq!(saved.core_connection, initial.core_connection);
        assert_eq!(saved.target_revision, 42);
        assert_eq!(saved.locale, "ja");
    }

    #[test]
    fn remote_switch_rejects_owned_core_or_harness_without_external_process_checks() {
        assert!(validate_owned_local_children(false, false).is_ok());
        assert_eq!(validate_owned_local_children(true, false).unwrap_err(), "Stop the local core before switching to Remote; its process lifetime belongs to this app.");
        assert!(validate_owned_local_children(false, true).unwrap_err().contains("Stop the managed DeepSeek Harness"));
        assert!(validate_owned_local_children(true, true).is_err());
        let core = CoreProcessState::new(false);
        let harness = DeepSeekHarnessProcessState::default();
        assert!(require_no_owned_local_children(&core, &harness).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn rejected_remote_switch_keeps_owned_core_running() {
        let core = CoreProcessState::new(false);
        let harness = DeepSeekHarnessProcessState::default();
        let mut command = Command::new("sleep");
        command.arg("30");
        *core.child.lock().unwrap() = Some(spawn_core_child(command).unwrap());
        let rejected = require_no_owned_local_children(&core, &harness);
        let mut child = core.take_child().unwrap();
        let still_running = child.try_wait().unwrap().is_none();
        terminate_child(&mut child).unwrap();
        assert!(rejected.is_err());
        assert!(still_running);
    }


    #[tokio::test]
    async fn remote_management_config_and_usage_routes_keep_origin_and_auth_separate() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let count = socket.read(&mut buffer).unwrap();
                    if count == 0 { break; }
                    request.extend_from_slice(&buffer[..count]);
                }
                requests.push(String::from_utf8(request).unwrap());
                let body = if requests.len() == 3 { "[]" } else { "{}" };
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                socket.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        let config = remote_config(origin);
        let client = management_http_client().unwrap();
        let auth = management_authorization(&config).unwrap();
        let get_url = management_endpoint(&config, "config.yaml").unwrap();
        client.get(&get_url).header("Authorization", &auth).send().await.unwrap();
        let put_url = management_endpoint(&config, "config.yaml").unwrap();
        client.put(put_url).header("Authorization", &auth).header("Content-Type", "application/yaml").body("config-version: 8\n").send().await.unwrap();
        let usage_url = management_endpoint(&config, "observability/usage/queue").unwrap();
        client.get(usage_url).header("Authorization", &auth).query(&[("count", "10")]).send().await.unwrap();
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /v8/management/config.yaml HTTP/1.1"));
        assert!(requests[1].starts_with("PUT /v8/management/config.yaml HTTP/1.1"));
        assert!(requests[2].starts_with("GET /v8/management/observability/usage/queue?count=10 HTTP/1.1"));
        for request in requests { assert!(request.contains("authorization: Bearer remote-management-key") || request.contains("Authorization: Bearer remote-management-key")); }
        assert!(get_url.starts_with("http://"));
        assert_ne!(config.core_connection.client_api_origin, config.core_connection.remote_management_origin);
    }

}
