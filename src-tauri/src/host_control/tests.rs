use super::*;
use crate::{
    core_connection::remote_status_with_host, run_locked_core_operation, CORE_OPERATION_BUSY,
    CORE_OPERATION_LOCK,
};

const KEY: &str = "ehc_test-host-control-key-0123456789abcdef";

fn request(method: &str, path: &str, headers: &[(&str, &str)]) -> Request {
    Request {
        method: method.into(),
        path: path.into(),
        headers: headers
            .iter()
            .map(|(name, value)| (name.to_ascii_lowercase(), value.as_bytes().to_vec()))
            .collect(),
    }
}

fn authorized(method: &str, path: &str, extra: &[(&str, &str)]) -> Request {
    let bearer = format!("Bearer {KEY}");
    let mut headers = vec![("Authorization", bearer.as_str()), (PROTOCOL_HEADER, "1")];
    headers.extend_from_slice(extra);
    request(method, path, &headers)
}

fn sample_status(running: bool) -> HostCoreStatus {
    HostCoreStatus {
        protocol: PROTOCOL_VERSION,
        installed: true,
        running,
        ready: running,
        starting: false,
        managed: running,
        process_id: running.then_some(4242),
        current_version: Some("v8.0.36".into()),
        message: if running {
            "CPA kernel is running"
        } else {
            "CPA kernel is installed but not running"
        }
        .into(),
        start_core_on_launch: Some(true),
    }
}

fn sample_install_result() -> CoreInstallResult {
    CoreInstallResult {
        version: "v8.0.37".into(),
        asset_name: "CLIProxyAPI_8.0.37_linux_amd64.tar.gz".into(),
        install_dir: "/home/host/cpa-core".into(),
        binary_path: Some("/home/host/cpa-core/cli-proxy-api".into()),
    }
}

fn sample_task(running: bool) -> CoreInstallTask {
    CoreInstallTask {
        running,
        cancellable: running,
        phase: if running { "Downloading" } else { "Installation complete" }.into(),
        downloaded: 10,
        total: Some(20),
        percent: Some(50.0),
        message: None,
        result: (!running).then(sample_install_result),
    }
}

#[test]
fn generated_keys_are_random_prefixed_and_valid() {
    let first = generate_key().unwrap();
    let second = generate_key().unwrap();
    assert!(first.starts_with("ehc_"));
    assert_eq!(first.len(), 4 + 43);
    assert_ne!(first, second);
    validate_key_format(&first).unwrap();
    for bad in [
        String::new(),
        "short".to_string(),
        "x".repeat(31),
        "x".repeat(257),
        format!("{} x", "y".repeat(40)),
        format!("{}\n", "y".repeat(40)),
    ] {
        assert!(validate_key_format(&bad).is_err(), "{bad:?}");
    }
}

#[test]
fn host_key_must_differ_from_management_and_client_keys() {
    let management = "management-key-0123456789abcdef-0123";
    let mut config = GuiConfigFile {
        host_control_key: KEY.into(),
        management_secret_key: management.into(),
        ..GuiConfigFile::default()
    };
    validate_host_key(&config).unwrap();
    config.management_secret_key = KEY.into();
    assert!(validate_host_key(&config).is_err());
    config.management_secret_key = management.into();
    config.api_keys[0].key = KEY.into();
    assert!(validate_host_key(&config).is_err());
    config.api_keys[0].key = "client".into();
    config.host_control_key = "too-short".into();
    assert!(validate_host_key(&config).is_err());
}

#[test]
fn listen_address_is_an_ip_and_unprivileged_port_other_than_the_core() {
    for value in ["0.0.0.0:8417", " 100.64.0.1:8417 ", "127.0.0.1:65535", "[::]:9000"] {
        parse_listen_address(value, 8317).unwrap();
    }
    for value in [
        "",
        "8417",
        ":8417",
        "localhost:8417",
        "0.0.0.0",
        "0.0.0.0:80",
        "0.0.0.0:0",
        "0.0.0.0:8317",
        "http://0.0.0.0:8417",
    ] {
        assert!(parse_listen_address(value, 8317).is_err(), "{value:?}");
    }
}

#[test]
fn default_listen_address_follows_the_core_port_apart_from_every_channel_core() {
    // Stable, Beta and Dev cores default to 8317, 8318 and 8319.
    for (core, listener) in [(8317, 8417), (8318, 8418), (8319, 8419)] {
        assert_eq!(default_address(core).unwrap(), format!("0.0.0.0:{listener}"));
        let config = GuiConfigFile { port: core, ..GuiConfigFile::default() };
        let address = effective_address(&config).unwrap();
        assert_eq!(address.port(), listener);
        assert!(!(8317..=8319).contains(&address.port()));
    }
    assert!(default_address(65500).is_none());
    let config = GuiConfigFile { port: 65500, ..GuiConfigFile::default() };
    assert!(effective_address(&config).is_err(), "no default past the last port");
    let saved = GuiConfigFile { host_control_address: " 100.64.0.1:9000 ".into(), ..GuiConfigFile::default() };
    assert_eq!(effective_address(&saved).unwrap().to_string(), "100.64.0.1:9000");
}

#[test]
fn remote_target_is_both_or_neither_and_distinct_from_the_management_key() {
    assert_eq!(
        normalize_remote_target(" ", "", "m").unwrap(),
        (String::new(), String::new())
    );
    assert_eq!(
        normalize_remote_target(" http://100.64.0.1:8417/ ", &format!(" {KEY} "), "management")
            .unwrap(),
        ("http://100.64.0.1:8417".to_string(), KEY.to_string())
    );
    assert!(normalize_remote_target("http://host:8417", "", "m").is_err());
    assert!(normalize_remote_target("", KEY, "m").is_err());
    assert!(normalize_remote_target("http://host:8417/path", KEY, "m").is_err());
    assert!(normalize_remote_target("http://user@host:8417", KEY, "m").is_err());
    assert!(normalize_remote_target("http://host:8417", "short", "m").is_err());
    assert!(normalize_remote_target("http://host:8417", KEY, KEY).is_err());
}

#[test]
fn authentication_requires_one_bearer_header_with_the_exact_key() {
    assert!(authenticate(&authorized("GET", "/", &[]), KEY));
    let lower = format!("bearer {KEY}");
    assert!(authenticate(
        &request("GET", "/", &[("authorization", &lower)]),
        KEY
    ));
    for value in [
        String::new(),
        KEY.to_string(),
        format!("Basic {KEY}"),
        format!("Bearer {KEY}x"),
        format!("Bearer {}", &KEY[..KEY.len() - 1]),
        "Bearer ".to_string(),
    ] {
        assert!(
            !authenticate(&request("GET", "/", &[("Authorization", &value)]), KEY),
            "{value:?}"
        );
    }
    assert!(!authenticate(&request("GET", "/", &[]), KEY));
    let bearer = format!("Bearer {KEY}");
    assert!(!authenticate(
        &request(
            "GET",
            "/",
            &[("Authorization", &bearer), ("Authorization", &bearer)]
        ),
        KEY
    ));
    assert!(!authenticate(&authorized("GET", "/", &[]), ""));
    assert!(keys_match(KEY.as_bytes(), KEY));
    assert!(!keys_match(b"", KEY));
}

#[test]
fn screening_refuses_browsers_bodies_and_missing_protocol_header() {
    assert_eq!(screen(&authorized("GET", "/", &[])), Ok(()));
    assert_eq!(
        screen(&authorized("POST", "/", &[("Content-Length", "0")])),
        Ok(())
    );
    for header in [
        "Origin",
        "Referer",
        "Cookie",
        "Sec-Fetch-Site",
        "Sec-Fetch-Mode",
        "Sec-Fetch-Dest",
        "Sec-Fetch-User",
    ] {
        let reply = screen(&authorized("GET", "/", &[(header, "x")])).unwrap_err();
        assert_eq!(reply.status, 403, "{header}");
    }
    assert_eq!(
        screen(&authorized("POST", "/", &[("Content-Length", "4")]))
            .unwrap_err()
            .status,
        413
    );
    assert_eq!(
        screen(&authorized("POST", "/", &[("Transfer-Encoding", "chunked")]))
            .unwrap_err()
            .status,
        400
    );
    let bearer = format!("Bearer {KEY}");
    assert_eq!(
        screen(&request("GET", "/", &[("Authorization", &bearer)]))
            .unwrap_err()
            .status,
        400
    );
    assert_eq!(
        screen(&request("GET", "/", &[(PROTOCOL_HEADER, "2")]))
            .unwrap_err()
            .status,
        400
    );
    assert_eq!(
        screen(&request(
            "GET",
            "/",
            &[(PROTOCOL_HEADER, "1"), (PROTOCOL_HEADER, "1")]
        ))
        .unwrap_err()
        .status,
        400
    );
}

#[test]
fn routes_dispatch_exact_paths_and_methods() {
    assert_eq!(
        route(&request("GET", "/host-control/v1/status", &[])),
        Ok(Route::Status)
    );
    for (path, operation) in [
        ("/host-control/v1/core/start", HostOperation::Start),
        ("/host-control/v1/core/stop", HostOperation::Stop),
        ("/host-control/v1/core/restart", HostOperation::Restart),
    ] {
        assert_eq!(
            route(&request("POST", path, &[])),
            Ok(Route::Operate(operation))
        );
        assert_eq!(route(&request("GET", path, &[])).unwrap_err().status, 405);
    }
    assert_eq!(
        route(&request("POST", "/host-control/v1/status", &[]))
            .unwrap_err()
            .status,
        405
    );
    assert_eq!(
        route(&request("OPTIONS", "/host-control/v1/status", &[]))
            .unwrap_err()
            .status,
        405
    );
    for (method, path, expected) in [
        ("GET", "/host-control/v1/core/latest", Route::Latest),
        ("GET", "/host-control/v1/core/install", Route::InstallTask),
        ("POST", "/host-control/v1/core/install/cancel", Route::CancelInstall),
        ("POST", "/host-control/v1/core/install/latest", Route::Install(None)),
        ("POST", "/host-control/v1/core/install/v8.0.37", Route::Install(Some("v8.0.37".into()))),
        ("POST", "/host-control/v1/core/install/8.0.37-rc.1", Route::Install(Some("8.0.37-rc.1".into()))),
        ("POST", "/host-control/v1/settings/start-core-on-launch/on", Route::StartCoreOnLaunch(true)),
        ("POST", "/host-control/v1/settings/start-core-on-launch/off", Route::StartCoreOnLaunch(false)),
    ] {
        assert_eq!(route(&request(method, path, &[])), Ok(expected), "{path}");
        let other = if method == "GET" { "POST" } else { "GET" };
        assert_eq!(route(&request(other, path, &[])).unwrap_err().status, 405, "{path}");
    }
    for path in [
        "/",
        "/host-control/v1/status?x=1",
        "/host-control/v1/core/update",
        "/host-control/v2/status",
        "/v8/management/config",
        "/host-control/v1/core/install/8.0",
        "/host-control/v1/core/install/../status",
        "/host-control/v1/core/install/8.0.37-",
        "/host-control/v1/core/install/8.0.37?x",
        "/host-control/v1/settings/start-core-on-launch/maybe",
    ] {
        assert_eq!(
            route(&request("GET", path, &[])).unwrap_err().status,
            404,
            "{path}"
        );
    }
}

#[test]
fn request_heads_are_bounded() {
    assert!(
        parse_head(b"GET /host-control/v1/status HTTP/1.1\r\nHost: x\r\n")
            .unwrap()
            .is_none()
    );
    let parsed = parse_head(
        b"GET /host-control/v1/status HTTP/1.1\r\nHost: x\r\nX-EasyCLI-Host-Control: 1\r\n\r\n",
    )
    .unwrap()
    .unwrap();
    assert_eq!(parsed.method, "GET");
    assert_eq!(parsed.path, "/host-control/v1/status");
    assert_eq!(parsed.single(PROTOCOL_HEADER), Some(b"1".as_slice()));
    assert_eq!(
        parse_head(b"\x00\x01 garbage\r\n\r\n").unwrap_err().status,
        400
    );
    let long = format!("GET / HTTP/1.1\r\nX-Long: {}", "a".repeat(MAX_HEAD_BYTES));
    assert_eq!(parse_head(long.as_bytes()).unwrap_err().status, 431);
    let many = format!(
        "GET / HTTP/1.1\r\n{}\r\n",
        "X-A: 1\r\n".repeat(MAX_HEADERS + 1)
    );
    assert_eq!(parse_head(many.as_bytes()).unwrap_err().status, 431);
    // A head that is complete but over the limit is refused too, not only an unfinished one.
    let complete = format!("GET / HTTP/1.1\r\nX-Long: {}\r\n\r\n", "a".repeat(MAX_HEAD_BYTES));
    assert_eq!(parse_head(complete.as_bytes()).unwrap_err().status, 431);
    let fits = format!("GET / HTTP/1.1\r\nX-Long: {}\r\n\r\n", "a".repeat(MAX_HEAD_BYTES - 64));
    assert!(parse_head(fits.as_bytes()).unwrap().is_some());
}


#[test]
fn replies_close_and_never_offer_cors() {
    let encoded = String::from_utf8(encode_reply(&Reply::error(401, "no"))).unwrap();
    assert!(encoded.starts_with("HTTP/1.1 401 Unauthorized\r\n"));
    assert!(encoded.contains("Connection: close\r\n"));
    assert!(encoded.contains("Cache-Control: no-store\r\n"));
    assert!(encoded.contains("WWW-Authenticate: Bearer\r\n"));
    assert!(!encoded.to_ascii_lowercase().contains("access-control-"));
    assert!(encoded.ends_with("\r\n\r\n{\"error\":\"no\"}"));
}

struct Recorder {
    calls: Arc<Mutex<Vec<&'static str>>>,
    busy: bool,
}

impl HostBackend for Recorder {
    fn handle(&self, route: Route) -> BoxFuture<'static, Result<serde_json::Value, HostError>> {
        let name = match &route {
            Route::Status => "status",
            Route::Operate(operation) => operation.name(),
            Route::Latest => "latest",
            Route::InstallTask => "install-task",
            Route::Install(None) => "install-latest",
            Route::Install(Some(_)) => "install-version",
            Route::CancelInstall => "install-cancel",
            Route::StartCoreOnLaunch(true) => "launch-on",
            Route::StartCoreOnLaunch(false) => "launch-off",
        };
        self.calls.lock().unwrap().push(name);
        let busy = self.busy;
        Box::pin(async move {
            if busy && !matches!(route, Route::Status | Route::InstallTask) {
                return Err(operation_error(CORE_OPERATION_BUSY.to_string()));
            }
            Ok(match route {
                Route::Status => serde_json::to_value(sample_status(true)),
                Route::Operate(operation) => {
                    serde_json::to_value(sample_status(operation != HostOperation::Stop))
                }
                Route::Latest => serde_json::to_value(CoreLatest {
                    version: "8.0.37".into(),
                    asset_name: "CLIProxyAPI_8.0.37_linux_amd64.tar.gz".into(),
                }),
                Route::InstallTask => serde_json::to_value(task_without_paths(sample_task(true))),
                Route::CancelInstall => serde_json::to_value(task_without_paths(sample_task(false))),
                Route::Install(_) => serde_json::to_value(without_paths(sample_install_result())),
                Route::StartCoreOnLaunch(enabled) => serde_json::to_value(HostCoreStatus {
                    start_core_on_launch: Some(enabled),
                    ..sample_status(true)
                }),
            }
            .unwrap())
        })
    }
}

type Calls = Arc<Mutex<Vec<&'static str>>>;

async fn start_server(busy: bool) -> (SocketAddr, Calls, CancellationToken) {
    start_server_with(busy, Limits::default()).await
}

async fn start_server_with(busy: bool, limits: Limits) -> (SocketAddr, Calls, CancellationToken) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let backend = Arc::new(Recorder {
        calls: calls.clone(),
        busy,
    });
    let cancel = CancellationToken::new();
    tokio::spawn(serve(
        listener,
        new_context_with(KEY.into(), backend, limits),
        cancel.clone(),
    ));
    (address, calls, cancel)
}

async fn raw(address: SocketAddr, request: &str) -> (u16, String) {
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let text = String::from_utf8(response).unwrap();
    let status = text[9..12].parse().unwrap();
    (status, text.split_once("\r\n\r\n").unwrap().1.to_string())
}

fn http(method: &str, path: &str, headers: &[String]) -> String {
    let mut text = format!("{method} {path} HTTP/1.1\r\nHost: test\r\n");
    for header in headers {
        text.push_str(header);
        text.push_str("\r\n");
    }
    text.push_str("\r\n");
    text
}

fn good_headers() -> Vec<String> {
    vec![
        format!("Authorization: Bearer {KEY}"),
        "X-EasyCLI-Host-Control: 1".into(),
    ]
}

#[tokio::test]
async fn listener_authenticates_screens_and_dispatches() {
    let (address, calls, cancel) = start_server(false).await;

    let no_key = vec!["X-EasyCLI-Host-Control: 1".to_string()];
    assert_eq!(
        raw(address, &http("GET", "/host-control/v1/status", &no_key))
            .await
            .0,
        401
    );
    let mut browser = good_headers();
    browser.push("Origin: http://evil.example".into());
    assert_eq!(
        raw(address, &http("POST", "/host-control/v1/core/stop", &browser))
            .await
            .0,
        403
    );
    let preflight = vec![
        "Origin: http://evil.example".to_string(),
        "Access-Control-Request-Method: POST".into(),
    ];
    assert_eq!(
        raw(address, &http("OPTIONS", "/host-control/v1/core/stop", &preflight))
            .await
            .0,
        403
    );
    let mut body = good_headers();
    body.push("Content-Length: 4".into());
    assert_eq!(
        raw(address, &http("POST", "/host-control/v1/core/stop", &body))
            .await
            .0,
        413
    );
    assert!(
        calls.lock().unwrap().is_empty(),
        "rejected requests never reach the core"
    );

    let (status, body) = raw(
        address,
        &http("GET", "/host-control/v1/status", &good_headers()),
    )
    .await;
    assert_eq!(status, 200);
    let parsed: HostCoreStatus = serde_json::from_str(&body).unwrap();
    assert_eq!(parsed, sample_status(true));
    let (status, body) = raw(
        address,
        &http("POST", "/host-control/v1/core/stop", &good_headers()),
    )
    .await;
    assert_eq!(status, 200);
    assert!(!serde_json::from_str::<HostCoreStatus>(&body).unwrap().running);
    assert_eq!(
        raw(
            address,
            &http("GET", "/host-control/v1/core/stop", &good_headers())
        )
        .await
        .0,
        405
    );
    assert_eq!(
        raw(
            address,
            &http("POST", "/host-control/v1/core/update", &good_headers())
        )
        .await
        .0,
        404
    );
    assert_eq!(*calls.lock().unwrap(), vec!["status", "stop"]);

    // A malformed head gets a reply, not a hang (size limits: request_heads_are_bounded).
    assert_eq!(raw(address, "\x01\x02\r\n\r\n").await.0, 400);
    cancel.cancel();
}

#[tokio::test]
async fn listener_reports_busy_core_operation_as_conflict() {
    let (address, calls, cancel) = start_server(true).await;
    let (status, body) = raw(
        address,
        &http("POST", "/host-control/v1/core/restart", &good_headers()),
    )
    .await;
    assert_eq!(status, 409);
    assert!(body.contains("another operation"), "{body}");
    assert_eq!(*calls.lock().unwrap(), vec!["restart"]);
    cancel.cancel();
}


#[tokio::test]
async fn client_sends_the_protocol_and_maps_host_replies() {
    let (address, calls, cancel) = start_server(false).await;
    let origin = format!("http://{address}");
    assert_eq!(
        fetch_host_status(&origin, KEY).await.unwrap(),
        sample_status(true)
    );
    let stopped = request_host_operation(&origin, KEY, HostOperation::Stop)
        .await
        .unwrap();
    assert!(!stopped.running);
    request_host_operation(&origin, KEY, HostOperation::Start)
        .await
        .unwrap();
    request_host_operation(&origin, KEY, HostOperation::Restart)
        .await
        .unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        vec!["status", "stop", "start", "restart"]
    );
    let error = fetch_host_status(&origin, "ehc_wrong-key-0123456789abcdef-0123456")
        .await
        .unwrap_err();
    assert!(error.contains("rejected"), "{error}");
    cancel.cancel();
    let unreachable = fetch_host_status("http://127.0.0.1:1", KEY)
        .await
        .unwrap_err();
    assert_eq!(unreachable, "Unable to reach remote host control");
}

#[test]
fn client_validates_host_responses() {
    let body = serde_json::to_vec(&sample_status(true)).unwrap();
    assert!(parse_host_response(200, &body).is_ok());
    let mut other = sample_status(true);
    other.protocol = 2;
    assert!(
        parse_host_response(200, &serde_json::to_vec(&other).unwrap())
            .unwrap_err()
            .contains("protocol")
    );
    assert!(parse_host_response(200, b"not json")
        .unwrap_err()
        .contains("invalid"));
    let mut noisy = sample_status(true);
    noisy.message = format!("line\nbreak{}", "x".repeat(400));
    let parsed = parse_host_response(200, &serde_json::to_vec(&noisy).unwrap()).unwrap();
    assert!(!parsed.message.contains('\n'));
    assert_eq!(parsed.message.chars().count(), 300);
    assert!(parse_host_response(401, b"{}")
        .unwrap_err()
        .contains("rejected"));
    assert!(parse_host_response(429, b"{}")
        .unwrap_err()
        .contains("try again"));
    assert_eq!(
        parse_host_response(409, br#"{"error":"busy\u0007 now"}"#).unwrap_err(),
        "busy now"
    );
    assert_eq!(
        parse_host_response(502, b"").unwrap_err(),
        "Remote host control failed (HTTP 502)"
    );
}

#[test]
fn lifecycle_operations_share_the_core_operation_lock_and_stay_local_only() {
    let process = CoreProcessState::new(false);
    let remote = GuiConfigState::new(GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        ..GuiConfigFile::default()
    });
    {
        let _held = CORE_OPERATION_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for operation in [
            HostOperation::Start,
            HostOperation::Stop,
            HostOperation::Restart,
        ] {
            let error = run_locked_core_operation(&process, &remote, operation.local())
                .err()
                .expect("a held lock refuses the operation");
            assert_eq!(error, CORE_OPERATION_BUSY);
            assert_eq!(operation_error(error).0, 409);
        }
    }
    for operation in [
        HostOperation::Start,
        HostOperation::Stop,
        HostOperation::Restart,
    ] {
        let error = run_locked_core_operation(&process, &remote, operation.local())
            .err()
            .expect("Remote mode refuses local lifecycle operations");
        assert!(
            error.contains("only available for the local core"),
            "{error}"
        );
        assert_eq!(operation_error(error).0, 500);
    }
    assert!(process.managed_pid().is_none());
}

#[test]
fn settings_updates_generate_keys_and_fail_closed() {
    let mut config = GuiConfigFile::default();
    assert!(!config.host_control_enabled);
    assert!(config.host_control_key.is_empty());
    assert!(config.host_control_address.is_empty(), "no saved address means the default");
    let update = |enabled: bool, address: &str, regenerate_key: bool| HostControlUpdate {
        enabled,
        address: address.into(),
        regenerate_key,
    };
    apply_update(&mut config, update(true, "", false)).unwrap();
    assert!(config.host_control_enabled);
    assert!(config.host_control_address.is_empty(), "the default is not written as an address");
    assert_eq!(effective_address(&config).unwrap().to_string(), "0.0.0.0:8417");
    apply_update(&mut config, update(true, " 0.0.0.0:8417 ", false)).unwrap();
    assert_eq!(config.host_control_address, "0.0.0.0:8417");
    let first = config.host_control_key.clone();
    validate_host_key(&config).unwrap();
    apply_update(&mut config, update(true, "100.64.0.1:8417", false)).unwrap();
    assert_eq!(config.host_control_key, first, "saving keeps the key");
    apply_update(&mut config, update(true, "100.64.0.1:8417", true)).unwrap();
    assert_ne!(config.host_control_key, first, "regenerating replaces the key");
    apply_update(&mut config, update(false, "100.64.0.1:8417", false)).unwrap();
    assert!(!config.host_control_enabled);
    for address in ["localhost:8417", "0.0.0.0:8317"] {
        let mut copy = config.clone();
        assert!(
            apply_update(&mut copy, update(true, address, false)).is_err(),
            "{address:?}"
        );
    }
    let mut remote = GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        ..GuiConfigFile::default()
    };
    assert!(apply_update(&mut remote, update(true, "", false)).is_err());
    assert!(!remote.host_control_enabled);
}

#[test]
fn remote_status_combines_management_reachability_with_host_process_state() {
    let connection = CoreConnection {
        mode: CoreConnectionMode::Remote,
        management_origin: "http://100.64.0.1:8317".into(),
        management_key: "management".into(),
        host_control_origin: "http://100.64.0.1:8417".into(),
        host_control_key: KEY.into(),
    };
    let down = || CoreConnectionTestResult {
        connected: false,
        version: None,
        message: "Unable to reach the core".into(),
    };
    let up = || CoreConnectionTestResult {
        connected: true,
        version: Some("v8.0.36".into()),
        message: "Connected".into(),
    };

    let stopped = remote_status_with_host(&connection, down(), Some(Ok(sample_status(false))));
    assert!(stopped.installed && !stopped.running && !stopped.ready && !stopped.managed);
    assert_eq!(stopped.message, STOPPED_ON_REMOTE_HOST);
    assert_eq!(stopped.process_id, None);
    assert_eq!(stopped.current_version.as_deref(), Some("v8.0.36"));
    assert_eq!(
        stopped.host_control.as_ref().map(|view| view.reachable),
        Some(true)
    );

    let running = remote_status_with_host(&connection, up(), Some(Ok(sample_status(true))));
    assert!(running.running && running.ready && !running.managed);
    assert_eq!(running.process_id, Some(4242));
    assert_eq!(running.message, "Connected");

    // The process is up but its management API is not answering (for example a wrong key).
    let unanswered = remote_status_with_host(&connection, down(), Some(Ok(sample_status(true))));
    assert!(unanswered.running && !unanswered.ready);
    assert_eq!(unanswered.message, "Unable to reach the core");

    let unreachable = remote_status_with_host(
        &connection,
        up(),
        Some(Err("Unable to reach remote host control".into())),
    );
    assert!(!unreachable.installed && unreachable.running && unreachable.ready);
    assert_eq!(
        unreachable.host_control,
        Some(HostControlView {
            reachable: false,
            message: "Unable to reach remote host control".into()
        })
    );

    let unconfigured = remote_status_with_host(&connection, up(), None);
    assert!(unconfigured.host_control.is_none() && !unconfigured.installed);
    let json = serde_json::to_value(&unconfigured).unwrap();
    assert!(json.get("hostControl").is_none());
}

#[test]
fn failure_limiter_counts_failed_keys_and_stays_bounded() {
    let limiter = FailureLimiter::default();
    let peer: IpAddr = "100.64.0.9".parse().unwrap();
    for _ in 0..MAX_FAILURES {
        assert!(!limiter.record_failure(peer));
    }
    assert!(limiter.record_failure(peer), "over the limit");
    let other: IpAddr = "100.64.0.10".parse().unwrap();
    assert!(!limiter.record_failure(other), "other peers are unaffected");
    // A full table evicts the oldest entry instead of refusing new peers.
    let full = FailureLimiter::default();
    for index in 0..(MAX_TRACKED_PEERS as u32 + 10) {
        assert!(!full.record_failure(IpAddr::from(index.to_be_bytes())));
    }
    assert_eq!(full.tracked(), MAX_TRACKED_PEERS);
}

#[tokio::test]
async fn listener_throttles_failed_keys_but_never_the_right_key() {
    let (address, calls, cancel) = start_server(false).await;
    let wrong = vec![
        "Authorization: Bearer ehc_wrong-key-0123456789abcdef-0123456".to_string(),
        "X-EasyCLI-Host-Control: 1".into(),
    ];
    for _ in 0..MAX_FAILURES {
        assert_eq!(raw(address, &http("GET", "/host-control/v1/status", &wrong)).await.0, 401);
    }
    assert_eq!(raw(address, &http("GET", "/host-control/v1/status", &wrong)).await.0, 429);
    assert!(calls.lock().unwrap().is_empty());
    // Same address (for example a shared NAT): the right key still gets in.
    assert_eq!(raw(address, &http("GET", "/host-control/v1/status", &good_headers())).await.0, 200);
    assert_eq!(*calls.lock().unwrap(), vec!["status"]);
    cancel.cancel();
}

#[tokio::test]
async fn listener_closes_slow_heads_at_the_deadline() {
    let limits = Limits { head_timeout: Duration::from_millis(200), ..Limits::default() };
    let (address, calls, cancel) = start_server_with(false, limits).await;
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream.write_all(b"GET /host-control/v1/status HTTP/1.1\r\n").await.unwrap();
    let mut response = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response)).await;
    assert!(read.is_ok(), "the deadline closes the connection");
    assert!(response.is_empty(), "no reply to an unfinished head");
    assert!(calls.lock().unwrap().is_empty());
    cancel.cancel();
}

#[tokio::test]
async fn listener_drops_connections_beyond_the_limit() {
    let limits = Limits { head_timeout: Duration::from_secs(5), max_connections: 1 };
    let (address, _, cancel) = start_server_with(false, limits).await;
    let mut first = tokio::net::TcpStream::connect(address).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut second = tokio::net::TcpStream::connect(address).await.unwrap();
    let _ = second.write_all(http("GET", "/host-control/v1/status", &good_headers()).as_bytes()).await;
    let mut dropped = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), second.read_to_end(&mut dropped)).await;
    assert!(dropped.is_empty(), "the connection over the limit gets no reply");
    first.write_all(http("GET", "/host-control/v1/status", &good_headers()).as_bytes()).await.unwrap();
    let mut response = Vec::new();
    first.read_to_end(&mut response).await.unwrap();
    assert!(String::from_utf8(response).unwrap().starts_with("HTTP/1.1 200 "));
    cancel.cancel();
}

#[test]
fn failures_with_local_detail_are_sent_as_a_public_message() {
    let (status, message) = operation_error("Failed to start CPA kernel: see /home/user/.cpa/core-start-output.log".into());
    assert_eq!(status, 500);
    assert_eq!(message, PRIVATE_FAILURE);
    assert!(!message.contains('/'));
    assert_eq!(operation_error(CORE_OPERATION_BUSY.into()), (409, CORE_OPERATION_BUSY.to_string()));
    assert_eq!(operation_error("CPA kernel is not currently running".into()).1, "CPA kernel is not currently running");
}

#[test]
fn listener_follows_the_core_port_and_the_core_port_cannot_take_the_listen_port() {
    let base = GuiConfigFile {
        host_control_enabled: true,
        host_control_key: KEY.into(),
        ..GuiConfigFile::default()
    };
    let (address, _) = desired_listener(&base).unwrap().unwrap();
    assert_eq!(address.port(), 8417);
    let moved = GuiConfigFile { port: 9000, ..base.clone() };
    assert_eq!(desired_listener(&moved).unwrap().unwrap().0.port(), 9100, "a core-port change moves the default listener");
    assert_ne!(desired_listener(&base), desired_listener(&moved), "so it is re-applied");
    let explicit = GuiConfigFile { host_control_address: "100.64.0.1:9000".into(), ..base.clone() };
    assert!(check_core_port(&GuiConfigFile { port: 9000, ..explicit.clone() }).is_err());
    assert!(desired_listener(&GuiConfigFile { port: 9000, ..explicit.clone() }).is_err(), "an external sync fails closed");
    assert!(check_core_port(&GuiConfigFile { port: 9001, ..explicit.clone() }).is_ok());
    assert!(check_core_port(&GuiConfigFile { host_control_enabled: false, port: 9000, ..explicit }).is_ok());
    assert!(check_core_port(&moved).is_ok(), "the default never collides");
    assert_eq!(desired_listener(&GuiConfigFile { host_control_enabled: false, ..base.clone() }), Ok(None));
    assert!(desired_listener(&GuiConfigFile { connection_mode: CoreConnectionMode::Remote, ..base }).is_err());
}

#[test]
fn install_versions_are_plain_release_versions() {
    for version in ["8.0.37", "v8.0.37", "8.0.37-rc.1", "v10.20.30-beta2"] {
        assert!(valid_core_version(version), "{version}");
    }
    for version in ["", "latest", "cancel", "8.0", "8.0.37.1", "8..37", "8.0.37-", "8.0.37-a/b", "8.0.37 ", "v", &format!("8.0.{}", "1".repeat(70))] {
        assert!(!valid_core_version(version), "{version:?}");
    }
}

#[test]
fn install_replies_never_carry_host_paths() {
    let result = without_paths(sample_install_result());
    assert!(result.install_dir.is_empty() && result.binary_path.is_none());
    assert_eq!(result.version, "v8.0.37");
    let task = task_without_paths(sample_task(false));
    let result = task.result.unwrap();
    assert!(result.install_dir.is_empty() && result.binary_path.is_none());
}

#[tokio::test]
async fn client_reaches_install_latest_and_launch_routes() {
    let (address, calls, cancel) = start_server(false).await;
    let connection = CoreConnection {
        mode: CoreConnectionMode::Remote,
        host_control_origin: format!("http://{address}"),
        host_control_key: KEY.into(),
        ..CoreConnection::default()
    };
    let latest: CoreLatest = host_request_json(&connection, reqwest::Method::GET, "core/latest", STATUS_TIMEOUT)
        .await
        .unwrap();
    assert_eq!(latest.version, "8.0.37");
    let task: CoreInstallTask = host_request_json(&connection, reqwest::Method::GET, "core/install", STATUS_TIMEOUT)
        .await
        .unwrap();
    assert!(task.running);
    let installed: CoreInstallResult = host_request_json(&connection, reqwest::Method::POST, "core/install/v8.0.37", STATUS_TIMEOUT)
        .await
        .unwrap();
    assert!(installed.install_dir.is_empty() && installed.binary_path.is_none());
    let off = host_request(&connection.host_control_origin, KEY, reqwest::Method::POST, "settings/start-core-on-launch/off", STATUS_TIMEOUT)
        .await
        .unwrap();
    assert_eq!(off.start_core_on_launch, Some(false));
    assert_eq!(*calls.lock().unwrap(), vec!["latest", "install-task", "install-version", "launch-off"]);
    cancel.cancel();

    let (address, _, cancel) = start_server(true).await;
    let busy = CoreConnection { host_control_origin: format!("http://{address}"), ..connection };
    let error = host_request_json::<CoreInstallResult>(&busy, reqwest::Method::POST, "core/install/latest", STATUS_TIMEOUT)
        .await
        .unwrap_err();
    assert!(error.contains("another operation"), "{error}");
    cancel.cancel();
}

#[test]
fn older_hosts_without_the_launch_setting_still_parse() {
    let mut value = serde_json::to_value(sample_status(true)).unwrap();
    value.as_object_mut().unwrap().remove("startCoreOnLaunch");
    let parsed = parse_host_response(200, value.to_string().as_bytes()).unwrap();
    assert_eq!(parsed.start_core_on_launch, None);
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
#[test]
fn remote_tray_offers_process_actions_only_through_reachable_host_control() {
    use crate::core_connection::CoreConnectionTestResult as Management;
    let connection = CoreConnection {
        mode: CoreConnectionMode::Remote,
        management_origin: "http://100.64.0.1:8317".into(),
        management_key: "management".into(),
        host_control_origin: "http://100.64.0.1:8417".into(),
        host_control_key: KEY.into(),
    };
    let down = || Management { connected: false, version: None, message: "down".into() };
    let up = || Management { connected: true, version: Some("8.0.36".into()), message: "Connected".into() };

    let stopped = remote_status_with_host(&connection, down(), Some(Ok(sample_status(false))));
    let tray = crate::windows_tray_presentation(&stopped, false, "en");
    assert_eq!(tray.status_text, "Remote core: stopped on host");
    assert_eq!(tray.toggle_text, "Start Core");
    assert!(tray.toggle_enabled && !tray.restart_enabled);

    let running = remote_status_with_host(&connection, up(), Some(Ok(sample_status(true))));
    let tray = crate::windows_tray_presentation(&running, false, "en");
    assert_eq!(tray.status_text, "Remote core: connected");
    assert!(tray.toggle_enabled && tray.restart_enabled);
    let busy = crate::windows_tray_presentation(&running, true, "en");
    assert!(!busy.toggle_enabled && !busy.restart_enabled);

    for host in [None, Some(Err("Unable to reach remote host control".to_string()))] {
        let status = remote_status_with_host(&connection, up(), host);
        let tray = crate::windows_tray_presentation(&status, false, "en");
        assert!(!tray.toggle_enabled && !tray.restart_enabled);
    }
}
