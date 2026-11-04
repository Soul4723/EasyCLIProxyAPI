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

const LOCAL_ONLY: &str = "This operation is only available for the local core";

fn local_tools_app(config: GuiConfigFile) -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_app();
    app.manage(GuiConfigState::new(config));
    app.manage(crate::reverse_proxy::ReverseProxyManagerState::default());
    app
}

fn assert_refused<T: std::fmt::Debug>(name: &str, result: Result<T, String>) {
    assert_eq!(result.unwrap_err(), LOCAL_ONLY, "{name} must be refused in Remote mode");
}

fn unnamed_mcp_server() -> crate::mcp_servers::McpServer {
    crate::mcp_servers::McpServer {
        id: String::new(),
        name: String::new(),
        transport: "stdio".into(),
        command: Some("echo".into()),
        args: Vec::new(),
        env: Default::default(),
        url: None,
        headers: Default::default(),
        enabled: true,
        description: None,
    }
}

fn reverse_proxy_test_config(enabled: bool) -> crate::reverse_proxy::ReverseProxyConfig {
    let missing = unique_test_temp_path("reverse-proxy-missing");
    crate::reverse_proxy::ReverseProxyConfig {
        enabled,
        listen_host: "127.0.0.1".into(),
        listen_port: 1,
        target_port: 1,
        cert_path: missing.join("cert.pem").to_string_lossy().into_owned(),
        key_path: missing.join("key.pem").to_string_lossy().into_owned(),
    }
}

#[tokio::test]
async fn remote_mode_refuses_local_reverse_proxy_mcp_and_skill_commands() {
    use crate::{agent_skills, mcp_servers, reverse_proxy};
    let app = local_tools_app(remote_config());
    assert_refused(
        "reverse_proxy_apply",
        reverse_proxy::reverse_proxy_apply(reverse_proxy_test_config(false), app.state(), app.state()).await,
    );
    assert_refused(
        "reverse_proxy_start",
        reverse_proxy::reverse_proxy_start(reverse_proxy_test_config(true), app.state(), app.state()).await,
    );
    assert_refused("reverse_proxy_stop", reverse_proxy::reverse_proxy_stop(app.state(), app.state()).await);
    // Reading the state stays open: it reports this app's own, stopped listener.
    assert!(!reverse_proxy::reverse_proxy_get_state(app.state()).await.unwrap().running);
    assert_refused("save_mcp_server", mcp_servers::save_mcp_server(unnamed_mcp_server(), app.state()));
    assert_refused("delete_mcp_server", mcp_servers::delete_mcp_server("missing".into(), app.state()));
    assert_refused(
        "set_mcp_server_enabled",
        mcp_servers::set_mcp_server_enabled("missing".into(), true, app.state()),
    );
    assert_refused(
        "import_mcp_servers_json",
        mcp_servers::import_mcp_servers_json("not json".into(), app.state()),
    );
    assert_refused("open_mcp_skills_directory", mcp_servers::open_mcp_skills_directory(app.state()));
    let missing_skill = unique_test_temp_path("skill-missing").join("SKILL.md");
    assert_refused(
        "set_skill_enabled",
        agent_skills::set_skill_enabled(missing_skill.to_string_lossy().into_owned(), true, app.state()),
    );
}

// Local inputs are chosen to fail inside each command without writing, binding or opening anything.
#[tokio::test]
async fn local_mode_runs_reverse_proxy_mcp_and_skill_commands() {
    use crate::{agent_skills, mcp_servers, reverse_proxy};
    let app = local_tools_app(GuiConfigFile::default());
    let stopped = reverse_proxy::reverse_proxy_apply(reverse_proxy_test_config(false), app.state(), app.state())
        .await
        .unwrap();
    assert!(!stopped.running);
    let start_error = reverse_proxy::reverse_proxy_start(reverse_proxy_test_config(true), app.state(), app.state())
        .await
        .unwrap_err();
    assert!(start_error.contains("Certificate file does not exist"), "{start_error}");
    assert!(!reverse_proxy::reverse_proxy_stop(app.state(), app.state()).await.unwrap().running);
    assert_eq!(
        mcp_servers::save_mcp_server(unnamed_mcp_server(), app.state()).unwrap_err(),
        "Server name cannot be empty"
    );
    let missing_id = "missing-mcp-server-for-remote-fence-test";
    assert!(mcp_servers::delete_mcp_server(missing_id.into(), app.state())
        .unwrap_err()
        .ends_with("not found"));
    assert!(mcp_servers::set_mcp_server_enabled(missing_id.into(), true, app.state())
        .unwrap_err()
        .ends_with("not found"));
    assert!(mcp_servers::import_mcp_servers_json("not json".into(), app.state())
        .unwrap_err()
        .starts_with("Failed to parse JSON"));
    let missing_skill = unique_test_temp_path("skill-missing").join("SKILL.md");
    assert!(agent_skills::set_skill_enabled(missing_skill.to_string_lossy().into_owned(), true, app.state())
        .unwrap_err()
        .starts_with("Failed to canonicalize path"));
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
    assert_eq!(presentation.status_text, "Remote core: connected");
    assert!(!presentation.toggle_enabled);
    assert!(!presentation.restart_enabled);
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
#[test]
fn remote_tray_deduplication_tracks_presentation_not_poll_metadata() {
    let connection = CoreConnection::from(&remote_config());
    let mut status = crate::core_connection::remote_status(
        &connection,
        crate::core_connection::CoreConnectionTestResult {
            connected: true,
            version: Some("v8.0.35".into()),
            message: "Connected".into(),
        },
    );
    let presentation = windows_tray_presentation(&status, false, "en");
    status.process_id = Some(123);
    status.current_version = Some("v8.0.36".into());
    status.message = "Updated status metadata".into();
    assert_eq!(presentation, windows_tray_presentation(&status, false, "en"));
    assert_ne!(presentation, windows_tray_presentation(&status, false, "ja"));
    status.ready = !status.ready;
    assert_ne!(presentation, windows_tray_presentation(&status, false, "en"));
}
