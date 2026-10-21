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
    for value in ["0.0.0.0:8318", " 100.64.0.1:8318 ", "127.0.0.1:65535", "[::]:9000"] {
        parse_listen_address(value, 8317).unwrap();
    }
    for value in [
        "",
        "8318",
        ":8318",
        "localhost:8318",
        "0.0.0.0",
        "0.0.0.0:80",
        "0.0.0.0:0",
        "0.0.0.0:8317",
        "http://0.0.0.0:8318",
    ] {
        assert!(parse_listen_address(value, 8317).is_err(), "{value:?}");
    }
}

#[test]
fn remote_target_is_both_or_neither_and_distinct_from_the_management_key() {
    assert_eq!(
        normalize_remote_target(" ", "", "m").unwrap(),
        (String::new(), String::new())
    );
    assert_eq!(
        normalize_remote_target(" http://100.64.0.1:8318/ ", &format!(" {KEY} "), "management")
            .unwrap(),
        ("http://100.64.0.1:8318".to_string(), KEY.to_string())
    );
    assert!(normalize_remote_target("http://host:8318", "", "m").is_err());
    assert!(normalize_remote_target("", KEY, "m").is_err());
    assert!(normalize_remote_target("http://host:8318/path", KEY, "m").is_err());
    assert!(normalize_remote_target("http://user@host:8318", KEY, "m").is_err());
    assert!(normalize_remote_target("http://host:8318", "short", "m").is_err());
    assert!(normalize_remote_target("http://host:8318", KEY, KEY).is_err());
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
    for path in [
        "/",
        "/host-control/v1/status?x=1",
        "/host-control/v1/core/update",
        "/host-control/v2/status",
        "/v8/management/config",
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
}

#[test]
fn failure_limiter_blocks_a_peer_after_repeated_failures() {
    let limiter = FailureLimiter::default();
    let peer: IpAddr = "100.64.0.9".parse().unwrap();
    let other: IpAddr = "100.64.0.10".parse().unwrap();
    for _ in 0..MAX_FAILURES {
        assert!(!limiter.blocked(peer));
        limiter.record_failure(peer);
    }
    assert!(limiter.blocked(peer));
    assert!(!limiter.blocked(other));
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
    fn status(&self) -> BoxFuture<'static, Result<HostCoreStatus, HostError>> {
        self.calls.lock().unwrap().push("status");
        Box::pin(async { Ok(sample_status(true)) })
    }

    fn operate(
        &self,
        operation: HostOperation,
    ) -> BoxFuture<'static, Result<HostCoreStatus, HostError>> {
        self.calls.lock().unwrap().push(operation.name());
        let busy = self.busy;
        Box::pin(async move {
            if busy {
                Err(operation_error(CORE_OPERATION_BUSY.to_string()))
            } else {
                Ok(sample_status(operation != HostOperation::Stop))
            }
        })
    }
}

type Calls = Arc<Mutex<Vec<&'static str>>>;

async fn start_server(busy: bool) -> (SocketAddr, Calls, CancellationToken) {
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
        new_context(KEY.into(), backend),
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
async fn listener_blocks_a_peer_after_failed_keys_even_with_the_right_key() {
    let (address, calls, cancel) = start_server(false).await;
    let wrong = vec![
        "Authorization: Bearer ehc_wrong-key-0123456789abcdef-0123456".to_string(),
        "X-EasyCLI-Host-Control: 1".into(),
    ];
    for _ in 0..MAX_FAILURES {
        assert_eq!(
            raw(address, &http("GET", "/host-control/v1/status", &wrong))
                .await
                .0,
            401
        );
    }
    assert_eq!(
        raw(
            address,
            &http("GET", "/host-control/v1/status", &good_headers())
        )
        .await
        .0,
        429
    );
    assert!(calls.lock().unwrap().is_empty());
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
            let error =
                run_locked_core_operation(&process, &remote, operation.local()).unwrap_err();
            assert_eq!(error, CORE_OPERATION_BUSY);
            assert_eq!(operation_error(error).0, 409);
        }
    }
    for operation in [
        HostOperation::Start,
        HostOperation::Stop,
        HostOperation::Restart,
    ] {
        let error = run_locked_core_operation(&process, &remote, operation.local()).unwrap_err();
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
    assert_eq!(config.host_control_address, DEFAULT_ADDRESS);
    let update = |enabled: bool, address: &str, regenerate_key: bool| HostControlUpdate {
        enabled,
        address: address.into(),
        regenerate_key,
    };
    apply_update(&mut config, update(true, " 0.0.0.0:8318 ", false)).unwrap();
    assert!(config.host_control_enabled);
    assert_eq!(config.host_control_address, "0.0.0.0:8318");
    let first = config.host_control_key.clone();
    validate_host_key(&config).unwrap();
    apply_update(&mut config, update(true, "100.64.0.1:8318", false)).unwrap();
    assert_eq!(config.host_control_key, first, "saving keeps the key");
    apply_update(&mut config, update(true, "100.64.0.1:8318", true)).unwrap();
    assert_ne!(config.host_control_key, first, "regenerating replaces the key");
    apply_update(&mut config, update(false, "100.64.0.1:8318", false)).unwrap();
    assert!(!config.host_control_enabled);
    for address in ["", "localhost:8318", "0.0.0.0:8317"] {
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
    assert!(apply_update(&mut remote, update(true, DEFAULT_ADDRESS, false)).is_err());
    assert!(!remote.host_control_enabled);
}

#[test]
fn remote_status_combines_management_reachability_with_host_process_state() {
    let connection = CoreConnection {
        mode: CoreConnectionMode::Remote,
        management_origin: "http://100.64.0.1:8317".into(),
        management_key: "management".into(),
        host_control_origin: "http://100.64.0.1:8318".into(),
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
