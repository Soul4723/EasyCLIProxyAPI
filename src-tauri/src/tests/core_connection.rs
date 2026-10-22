use super::support::*;
use super::*;
use crate::core_connection::{
    normalize_connection, normalize_origin, poll_core_connection, require_local, test_core_connection,
    CoreConnection,
};
use std::io::{Read, Write};

fn remote_config() -> GuiConfigFile {
    GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: "https://core.example:9443".into(),
        remote_management_key: "test-remote-key".into(),
        remote_host_control_origin: "http://core.example:8417".into(),
        remote_host_control_key: "ehc_test-host-control-key-0123456789abcdef".into(),
        ..GuiConfigFile::default()
    }
}

#[test]
fn remote_origin_and_key_validation() {
    assert_eq!(
        normalize_origin("https://core.example:9443/").unwrap(),
        "https://core.example:9443"
    );
    assert_eq!(
        normalize_origin("http://[::1]:1234").unwrap(),
        "http://[::1]:1234"
    );
    for value in [
        "",
        "file:///tmp/core",
        "http:core.example",
        "https://user@core.example",
        "https://@core.example",
        "https://core.example/path",
        "https://core.example/a/..",
        "https://core.example?x=1",
        "https://core.example#x",
        "https://co\nre.example",
        "https://core.example\\path",
    ] {
        assert!(normalize_origin(value).is_err(), "{value:?}");
    }
    let mut connection = CoreConnection::from(&remote_config());
    for key in ["", "bad\nkey", "$2b$hashed", "bad\tkey"] {
        connection.management_key = key.into();
        assert!(normalize_connection(connection.clone()).is_err());
    }
    assert!(normalize_connection(CoreConnection::from(&remote_config())).is_ok());
}

#[test]
fn connection_defaults_and_toml_round_trip() {
    let old: GuiConfigFile = toml::from_str("locale = 'ja'\nport = 9500\n").unwrap();
    assert_eq!(old.connection_mode, CoreConnectionMode::Local);
    assert!(old.remote_management_origin.is_empty());
    assert!(old.remote_management_key.is_empty());
    let home = agent_test_home("core-connection-round-trip");
    let path = home.join("config.toml");
    write_gui_config_to_path(&remote_config(), &path).unwrap();
    let restored: GuiConfigFile = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    fs::remove_dir_all(home).unwrap();
    assert_eq!(restored.connection_mode, CoreConnectionMode::Remote);
    assert_eq!(
        restored.remote_management_origin,
        "https://core.example:9443"
    );
    assert_eq!(restored.remote_management_key, "test-remote-key");
    assert_eq!(restored.remote_host_control_origin, "http://core.example:8417");
    assert_eq!(
        restored.remote_host_control_key,
        "ehc_test-host-control-key-0123456789abcdef"
    );
    assert!(!old.host_control_enabled && old.host_control_key.is_empty());
    assert!(old.host_control_address.is_empty());

    let home = agent_test_home("host-control-round-trip");
    let path = home.join("config.toml");
    let host = GuiConfigFile {
        host_control_enabled: true,
        host_control_address: "100.64.0.1:8417".into(),
        host_control_key: "ehc_host-key-0123456789abcdef-0123456789".into(),
        ..GuiConfigFile::default()
    };
    write_gui_config_to_path(&host, &path).unwrap();
    let restored: GuiConfigFile = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    fs::remove_dir_all(home).unwrap();
    assert_eq!(
        crate::host_control::listener_settings(&restored),
        crate::host_control::listener_settings(&host)
    );
}

#[test]
fn remote_targeting_and_local_lifecycle_refusal() {
    let config = remote_config();
    assert_eq!(
        management_endpoint(&config, "/oauth/status").unwrap(),
        "https://core.example:9443/v8/management/oauth/status"
    );
    assert_eq!(
        management_authorization(&config).unwrap(),
        "Bearer test-remote-key"
    );
    assert!(require_local(&config).is_err());
    assert!(!should_start_core_on_launch(&config));
    assert!(!should_start_hidden(&GuiConfigFile {
        silent_start: true,
        ..config.clone()
    }));
    let state = GuiConfigState::new(config);
    let process = CoreProcessState::new(false);
    assert!(start_core_process_with_state(&process, &state).is_err());
    assert!(stop_core_process_with_state(&process, &state).is_err());
    assert!(restart_core_process_with_state(&process, &state).is_err());
    let local = GuiConfigFile {
        management_secret_key: "local-test-key".into(),
        ..GuiConfigFile::default()
    };
    assert!(require_local(&local).is_ok());
    assert_eq!(
        management_authorization(&local).unwrap(),
        "Bearer local-test-key"
    );
    assert!(management_endpoint(&local, "config")
        .unwrap()
        .ends_with(":8317/v8/management/config"));
}

#[tokio::test]
async fn connection_test_maps_v8_auth_errors_and_redirects_without_saving() {
    check_connection_responses(true).await;
    check_connection_responses(false).await;
}

async fn check_connection_responses(full_config: bool) {
    for (status, body, connected, message) in [
        (200, r#"{"config-version":8}"#, true, "Connected"),
        (200, r#"{"config-version":7}"#, false, "v8 configuration"),
        (200, "8", false, "v8 configuration"),
        (200, "not json", false, "v8 configuration"),
        (401, "{}", false, "rejected"),
        (403, "{}", false, "forbidden"),
        (404, "{}", false, "v8 management API"),
        (302, "{}", false, "HTTP 302"),
    ] {
        let body = if full_config { body } else {
            match body {
                r#"{"config-version":8}"# => "8",
                r#"{"config-version":7}"# => "7",
                "8" => r#"{"config-version":8}"#,
                other => other,
            }
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            }
            let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
            let path = if full_config { "config" } else { "config/config-version" };
            assert!(request.starts_with(&format!("get /v8/management/{path} http/1.1")));
            assert!(request.contains("authorization: bearer test-remote-key\r\n"));
            write!(socket, "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nX-CPA-VERSION: v8.0.35\r\nLocation: http://127.0.0.1:1/not-followed\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let connection = CoreConnection {
            mode: CoreConnectionMode::Remote,
            management_origin: origin.clone(),
            management_key: "test-remote-key".into(),
            ..CoreConnection::default()
        };
        let result = if full_config {
            test_core_connection(connection).await
        } else {
            poll_core_connection(connection).await
        }.unwrap();
        server.join().unwrap();
        assert_eq!(result.connected, connected);
        assert!(result.message.contains(message), "{}", result.message);
        assert_eq!(result.version.as_deref(), connected.then_some("v8.0.35"));
        let connection = CoreConnection {
            mode: CoreConnectionMode::Remote,
            management_origin: origin.clone(),
            management_key: "test-remote-key".into(),
            ..CoreConnection::default()
        };
        let status = crate::core_connection::remote_status(&connection, result);
        assert_eq!(status.running, connected);
        assert_eq!(status.ready, connected);
        assert!(!status.installed);
        assert!(status.process_id.is_none());
        assert!(status.install_dir.is_empty());
        assert_eq!(status.remote_origin.as_deref(), Some(origin.as_str()));
    }
    let connection = CoreConnection {
        mode: CoreConnectionMode::Remote,
        management_origin: "http://127.0.0.1:1".into(),
        management_key: "test-remote-key".into(),
        ..CoreConnection::default()
    };
    let result = if full_config {
        test_core_connection(connection).await
    } else {
        poll_core_connection(connection).await
    }.unwrap();
    assert!(!result.connected);
    assert_eq!(result.message, "Unable to reach the core");
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
#[test]
fn remote_tray_never_offers_process_actions() {
    let connection = CoreConnection::from(&remote_config());
    let status = crate::core_connection::remote_status(
        &connection,
        crate::core_connection::CoreConnectionTestResult {
            connected: true,
            version: Some("v8.0.35".into()),
            message: "Connected".into(),
        },
    );
    let presentation = windows_tray_presentation(&status, false, "en");
    assert_eq!(presentation.status_text, "Core on core.example: connected");
    assert!(!presentation.toggle_enabled);
    assert!(!presentation.restart_enabled);
}

/// A scripted management API: answers each connection with the next `(status, etag, body)` and
/// returns every request (head and body, lower-cased head) in order.
fn management_fixture(replies: Vec<(u16, Option<&'static str>, &'static str)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        replies.into_iter().map(|(status, etag, body)| {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            let head_end = loop {
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") { break end + 4; }
                let count = socket.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
            };
            let head = String::from_utf8(request[..head_end].to_vec()).unwrap().to_ascii_lowercase();
            let length = head.lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .map_or(0, |value| value.trim().parse::<usize>().unwrap());
            while request.len() < head_end + length {
                let count = socket.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
            }
            let etag = etag.map(|etag| format!("ETag: {etag}\r\n")).unwrap_or_default();
            write!(socket, "HTTP/1.1 {status} Test\r\n{etag}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            head + &String::from_utf8(request[head_end..].to_vec()).unwrap()
        }).collect()
    });
    (origin, server)
}

const REMOTE_YAML: &str = "config-version: 8\nserver:\n  host: 0.0.0.0\n  port: 8317\nrouting:\n  strategy: round-robin\naccess:\n  api-keys:\n  - client-one\n";

fn remote_state_for(origin: &str) -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_app();
    app.manage(GuiConfigState::new(GuiConfigFile {
        remote_management_origin: origin.into(),
        remote_host_control_origin: String::new(),
        remote_host_control_key: String::new(),
        ..remote_config()
    }));
    app.manage(AgentConfigStatusCache::default());
    app
}

#[tokio::test]
async fn remote_core_settings_are_written_through_the_management_api_with_if_match() {
    let (origin, server) = management_fixture(vec![
        (200, Some("\"etag-1\""), REMOTE_YAML),
        (200, Some("\"etag-2\""), r#"{"status":"ok","config-version":8}"#),
    ]);
    let app = remote_state_for(&origin);
    let view = set_core_routing_strategy(app.state(), "fill-first".into()).await.unwrap();
    assert_eq!(view.routing_strategy, "fill-first");
    assert_eq!(view.api_keys.len(), 1);
    let requests = server.join().unwrap();
    assert!(requests[0].starts_with("get /v8/management/config.yaml http/1.1"));
    assert!(requests[1].starts_with("put /v8/management/config.yaml http/1.1"));
    assert!(requests[1].contains("authorization: bearer test-remote-key\r\n"));
    assert!(requests[1].contains("if-match: \"etag-1\"\r\n"));
    assert!(requests[1].contains("strategy: fill-first"));
    assert!(requests[1].contains("client-one"), "the rest of the document is kept");

    // Another writer saved in between: the core answers 412 and nothing is overwritten.
    let (origin, server) = management_fixture(vec![
        (200, Some("\"etag-1\""), REMOTE_YAML),
        (412, Some("\"etag-3\""), r#"{"error":"precondition_failed"}"#),
    ]);
    let app = remote_state_for(&origin);
    let error = add_core_api_key(app.state(), "client-two".into(), String::new()).await.err().unwrap();
    assert!(error.contains("changed elsewhere"), "{error}");
    assert_eq!(server.join().unwrap().len(), 2);

    // A core without ETags is read again just before the write; a difference refuses the save.
    let (origin, server) = management_fixture(vec![
        (200, None, REMOTE_YAML),
        (200, None, "config-version: 8\nrouting:\n  strategy: fill-first\n"),
    ]);
    let app = remote_state_for(&origin);
    let error = delete_core_api_key(app.state(), "client-one".into()).await.err().unwrap();
    assert!(error.contains("changed elsewhere"), "{error}");
    assert_eq!(server.join().unwrap().len(), 2);

    // An unchanged value sends no write.
    let (origin, server) = management_fixture(vec![(200, Some("\"etag-1\""), REMOTE_YAML)]);
    let app = remote_state_for(&origin);
    set_core_routing_strategy(app.state(), "round-robin".into()).await.unwrap();
    assert_eq!(server.join().unwrap().len(), 1);
}

#[tokio::test]
async fn remote_mode_refuses_settings_that_decide_how_this_app_reaches_the_core() {
    let app = remote_state_for("http://127.0.0.1:1");
    let gui = app.state::<GuiConfigState>();
    let cache = app.state::<AgentConfigStatusCache>();
    let refused = |error: Option<String>| {
        let error = error.expect("Remote mode must refuse a connection-defining setting");
        assert!(error.contains("how this app reaches the remote core"), "{error}");
    };
    refused(
        save_core_tls_settings(
            gui.clone(),
            cache.clone(),
            CoreTlsSettings { enabled: true, cert: "cert.pem".into(), key: "key.pem".into() },
        )
        .err(),
    );
    refused(set_core_management_secret_key(gui.clone(), "new-management-key".into()).err());
    refused(clear_core_management_secret_key(gui.clone()).err());
    refused(save_gui_settings(gui.clone(), cache.clone(), GuiNetworkSettings { port: 9000, allow_lan: false }).err());
    let change: ExtendedConfigChange = serde_json::from_value(serde_json::json!({
        "path": ["server", "port"], "value": 9000, "expected": 8317, "expectedExists": true,
    }))
    .unwrap();
    refused(save_extended_core_config(gui.clone(), vec![change]).await.err());

    // Changing the remote core's port through the network card is refused before anything is written.
    let (origin, server) = management_fixture(vec![(200, Some("\"etag-1\""), REMOTE_YAML)]);
    let app = remote_state_for(&origin);
    refused(
        save_network_endpoint_settings(
            app.state(),
            app.state(),
            GuiNetworkEndpointSettings { host: "0.0.0.0".into(), port: 9000, proxy_url: None, proxy_override: None },
        )
        .await
        .err(),
    );
    assert_eq!(server.join().unwrap().len(), 1);
}

#[test]
fn emptying_an_indentationless_sequence_keeps_valid_yaml() {
    for content in [REMOTE_YAML, "config-version: 8\naccess:\n  api-keys:\n    - a\n"] {
        let updated = patch_core_api_keys_yaml(content, &[]).unwrap();
        let document: serde_norway::Value = serde_norway::from_str(&updated).unwrap();
        assert_eq!(document["access"]["api-keys"], serde_norway::Value::Sequence(Vec::new()), "{updated}");
    }
}

#[test]
fn a_connection_change_waits_for_changes_aimed_at_the_current_core() {
    let app = remote_state_for("http://127.0.0.1:1");
    let state = app.state::<GuiConfigState>();
    let config = state.snapshot().unwrap();
    let guard = crate::core_connection::begin_target_write(&state, &config).unwrap();
    let error = crate::core_connection::lock_target_writes_for_switch().err().unwrap();
    assert!(error.contains("still being saved"), "{error}");
    drop(guard);
    let switch = crate::core_connection::lock_target_writes_for_switch().unwrap();
    drop(switch);
    // A change prepared against the old core cannot start after the switch.
    state.update(|config| { config.connection_mode = CoreConnectionMode::Local; Ok(()) }).unwrap();
    let error = crate::core_connection::begin_target_write(&state, &config).err().unwrap();
    assert!(error.contains("connection changed"), "{error}");
}
