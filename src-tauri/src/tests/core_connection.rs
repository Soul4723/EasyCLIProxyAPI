use super::*;
use crate::core_connection::{test_core_connection, CoreConnection};

#[tokio::test]
async fn connection_test_authenticates_only_the_candidate_management_target() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut data = [0; 8192];
        let count = stream.read(&mut data).unwrap();
        let request = String::from_utf8_lossy(&data[..count]).to_ascii_lowercase();
        assert!(request.starts_with("get /v8/management/config "));
        assert!(request.contains("authorization: bearer fixture-management"));
        assert!(!request.contains("fixture-client"));
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\nContent-Type: application/json\r\nX-CPA-VERSION: 8.1.2\r\nConnection: close\r\n\r\n{\"config-version\":8}").unwrap();
    });
    let candidate = CoreConnection {
        mode: CoreConnectionMode::Remote,
        management_origin: origin,
        management_key: "fixture-management".into(),
        client_origin: "http://127.0.0.1:1".into(),
        client_key: "fixture-client".into(),
    };
    let result = test_core_connection(candidate).await.unwrap();
    assert!(result.connected, "{}", result.message);
    assert_eq!(result.version.as_deref(), Some("8.1.2"));
    server.join().unwrap();
}

#[tokio::test]
async fn saved_remote_draft_survives_local_mode_and_reload_without_changing_local_keys() {
    use crate::core_connection::{get_core_connection, save_core_connection};
    let directory = super::support::agent_test_home("remote-draft");
    let path = directory.join("config.toml");
    let mut state = GuiConfigState::new(GuiConfigFile {
        host: "127.0.0.1".into(), port: 9187,
        management_secret_key: "local-management-key-fixture".into(),
        api_keys: vec![GuiApiKeyEntry { key: "local-client-key-fixture".into(), remark: "local note".into() }],
        ..GuiConfigFile::default()
    });
    state.persistence_path = Some(path.clone());
    let app = tauri::test::mock_builder()
        .manage(state)
        .manage(AgentConfigStatusCache::default())
        .manage(CoreProcessState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let remote = CoreConnection {
        mode: CoreConnectionMode::Remote,
        management_origin: "http://remote.invalid:8317".into(),
        management_key: "remote-management".into(),
        client_origin: "http://client.invalid:8318".into(),
        client_key: String::new(),
    };
    let saved = save_core_connection(app.handle().clone(), app.state(), remote).await.unwrap();
    assert_eq!(saved.management_origin, "http://remote.invalid:8317");
    let local = save_core_connection(app.handle().clone(), app.state(), CoreConnection { mode: CoreConnectionMode::Local, ..saved }).await.unwrap();
    assert_eq!(local.mode, CoreConnectionMode::Local);
    assert_eq!(local.management_key, "remote-management");
    assert_eq!(local.client_origin, "http://client.invalid:8318");
    assert_eq!(get_core_connection(app.state()).unwrap().management_key, "remote-management");
    let local_settings = get_gui_settings(app.state()).unwrap();
    assert_eq!(local_settings.host, "127.0.0.1");
    assert_eq!(local_settings.port, 9187);
    // Inspect the user-visible persisted file, then reopen through the public get seam.
    let mut restored: GuiConfigFile = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();

    assert_eq!(restored.management_secret_key, "local-management-key-fixture");
    assert_eq!(restored.api_keys[0].key, "local-client-key-fixture");
    assert_eq!(restored.api_keys[0].remark, "local note");
    restored.target_revision = 0;
    app.state::<GuiConfigState>().replace_external(restored).unwrap();
    assert_eq!(get_core_connection(app.state()).unwrap().management_origin, "http://remote.invalid:8317");
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn remote_settings_read_returns_remote_values_without_importing_them_into_local_settings() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 8192];
        let size = stream.read(&mut request).unwrap();
        assert!(String::from_utf8_lossy(&request[..size]).starts_with("GET /v8/management/config.yaml "));
        let body = "config-version: 8\nserver: {host: 10.0.0.9, port: 9999}\naccess: {api-keys: [remote-client]}\n";
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
    });
    let directory = super::support::agent_test_home("remote-read");
    let mut state = GuiConfigState::new(GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: origin.clone(),
        remote_management_key: "fixture-management".into(),
        remote_client_origin: origin,
        remote_client_key: "fixture-client".into(),
        ..GuiConfigFile::default()
    });
    state.persistence_path = Some(directory.join("config.toml"));
    let app = tauri::test::mock_builder().manage(state)
        .manage(AgentConfigStatusCache::default()).manage(CoreProcessState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let view = get_core_config_settings(app.state()).await.unwrap();
    assert_eq!(view.port, 9999);
    assert_eq!(view.api_keys[0].api_key, "remote-client");
    let local = crate::core_connection::save_core_connection(app.handle().clone(), app.state(), CoreConnection {
        mode: CoreConnectionMode::Local, management_origin: String::new(), management_key: String::new(), client_origin: String::new(), client_key: String::new(),
    }).await.unwrap();
    assert_eq!(local.mode, CoreConnectionMode::Local);
    server.join().unwrap();
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn connection_test_distinguishes_auth_server_and_contract_failures_without_echoing_secrets() {
    for (status, body, expected) in [
        (401, "fixture-management fixture-client", "Core rejected the management key"),
        (403, "fixture-management", "Remote management access is forbidden"),
        (404, "fixture-client", "Core does not expose the v8 management API"),
        (500, "fixture-management", "Core management request failed (HTTP 500)"),
        (200, "<html>login</html>", "Core did not return a v8 configuration"),
        (200, r#"{"config-version":7}"#, "Core did not return a v8 configuration"),
        (302, "", "Core management request failed (HTTP 302)"),
    ] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 8192]; stream.read(&mut request).unwrap();
            stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nLocation: http://127.0.0.1:1/leak\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
        });
        let result = test_core_connection(CoreConnection {
            mode: CoreConnectionMode::Remote, management_origin: origin.clone(), management_key: "fixture-management".into(), client_origin: origin, client_key: "fixture-client".into(),
        }).await.unwrap();
        assert!(!result.connected);
        assert_eq!(result.message, expected);
        assert!(result.version.is_none());
        server.join().unwrap();
    }
}

// Explicitly opt in with isolated credentials; never runs in the default suite.
#[tokio::test]
#[ignore = "requires an explicitly configured isolated remote core"]
async fn isolated_remote_core_connection_command() {
    let origin = std::env::var("CPA_REMOTE_TEST_ORIGIN").expect("isolated test origin");
    let management_key = std::env::var("CPA_REMOTE_TEST_MANAGEMENT_KEY").expect("isolated management key");
    let client_key = std::env::var("CPA_REMOTE_TEST_CLIENT_KEY").expect("isolated client key");
    let version = std::env::var("CPA_REMOTE_TEST_VERSION").expect("expected core version");
    let candidate = CoreConnection {
        mode: CoreConnectionMode::Remote,
        management_origin: origin.clone(), management_key, client_origin: origin, client_key,
    };
    let result = test_core_connection(candidate.clone()).await.unwrap();
    assert!(result.connected, "{}", result.message);
    assert_eq!(result.version.as_deref(), Some(version.as_str()));
    let app = tauri::test::mock_builder().manage(GuiConfigState::new(GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: candidate.management_origin.clone(),
        remote_management_key: candidate.management_key.clone(),
        remote_client_origin: candidate.client_origin.clone(),
        remote_client_key: candidate.client_key.clone(),
        ..GuiConfigFile::default()
    })).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let settings = get_core_config_settings(app.state()).await.unwrap();
    assert_eq!(settings.port, reqwest::Url::parse(&candidate.management_origin).unwrap().port().unwrap());
    let extended = get_extended_core_config(app.state()).await.unwrap();
    assert_eq!(extended.get("config-version").and_then(serde_json::Value::as_u64), Some(8));
    let rejected = test_core_connection(CoreConnection { management_key: "incorrect-isolated-fixture-key".into(), ..candidate }).await.unwrap();
    assert!(!rejected.connected);
    assert_eq!(rejected.message, "Core rejected the management key");
    assert!(rejected.version.is_none());
}

fn serve_config_steps(steps: Vec<(&'static str, &'static str, u16, &'static str)>) -> (String, std::thread::JoinHandle<()>) {
    use std::io::BufRead;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        for (expected_line, expected_body, status, body) in steps {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = std::io::BufReader::new(&mut stream);
            let mut line = String::new(); reader.read_line(&mut line).unwrap();
            assert_eq!(line.trim(), expected_line);
            let mut length = 0;
            loop {
                let mut header = String::new(); reader.read_line(&mut header).unwrap();
                if header == "\r\n" { break; }
                let header = header.to_ascii_lowercase();
                assert!(!header.starts_with("if-match:"));
                if let Some(value) = header.strip_prefix("content-length:") { length = value.trim().parse().unwrap(); }
            }
            let mut request_body = vec![0; length]; reader.read_exact(&mut request_body).unwrap();
            assert_eq!(String::from_utf8(request_body).unwrap(), expected_body);
            stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
        }
    });
    (origin, worker)
}

#[tokio::test]
async fn remote_setting_writes_only_changed_leaf_without_etag_and_detects_observed_conflict() {
    for conflict in [false, true] {
        let initial = "config-version: 8\nplugins: {enabled: false}\nserver: {port: 8317}\n";
        let fresh = if conflict { "config-version: 8\nplugins: {enabled: true}\nserver: {port: 9999}\n" }
            else { "config-version: 8\nplugins: {enabled: false}\nserver: {port: 9999}\n" };
        let mut steps = vec![("GET /v8/management/config.yaml HTTP/1.1", "", 200, initial),
            ("GET /v8/management/config.yaml HTTP/1.1", "", 200, fresh)];
        if !conflict { steps.push(("PUT /v8/management/config/plugins/enabled HTTP/1.1", "true", 200, "{}")); }
        let (origin, server) = serve_config_steps(steps);
        let state = GuiConfigState::new(GuiConfigFile { connection_mode: CoreConnectionMode::Remote,
            remote_management_origin: origin.clone(), remote_management_key: "fixture-management".into(),
            remote_client_origin: origin, remote_client_key: "fixture-client".into(), ..GuiConfigFile::default() });
        let app = tauri::test::mock_builder().manage(state)
            .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let result = set_core_plugins_enabled(app.state(), true).await;
        if conflict { assert!(result.err().unwrap().contains("Remote configuration changed")); }
        else { assert!(result.unwrap().plugins_enabled); }
        server.join().unwrap();
    }
}

#[tokio::test]
async fn remote_multiwrite_failure_reports_partial_save_without_retry_or_rollback() {
    let initial = "config-version: 8\nserver: {host: 127.0.0.1, port: 8317}\n";
    let partial = "config-version: 8\nserver: {host: 10.0.0.9, port: 8317}\n";
    let (origin, server) = serve_config_steps(vec![
        ("GET /v8/management/config.yaml HTTP/1.1", "", 200, initial),
        ("GET /v8/management/config.yaml HTTP/1.1", "", 200, initial),
        ("PUT /v8/management/config/server/host HTTP/1.1", "\"10.0.0.9\"", 200, "{}"),
        ("GET /v8/management/config.yaml HTTP/1.1", "", 200, partial),
        ("PUT /v8/management/config/server/port HTTP/1.1", "9999", 500, "sensitive server details"),
        ("GET /v8/management/config.yaml HTTP/1.1", "", 200, partial),
    ]);
    let app = tauri::test::mock_builder().manage(GuiConfigState::new(GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote, remote_management_origin: origin.clone(),
        remote_management_key: "fixture-management".into(), remote_client_origin: origin,
        ..GuiConfigFile::default()
    })).manage(AgentConfigStatusCache::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let error = save_network_endpoint_settings(app.state(), app.state(), GuiNetworkEndpointSettings {
        host: "10.0.0.9".into(), port: 9999, proxy_url: None, proxy_override: None,
    }).await.err().unwrap();
    assert!(error.contains("1 of 2 confirmed changes"));
    assert!(!error.contains("sensitive server details"));
    let current = get_core_config_settings(app.state()).await.unwrap();
    assert_eq!(current.host, "10.0.0.9");
    assert_eq!(current.port, 8317);
    server.join().unwrap();
}

#[tokio::test]
async fn remote_oauth_rejects_callback_and_poll_from_unknown_target_without_exposing_redirect() {
    let app = tauri::test::mock_builder().manage(GuiConfigState::new(GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: "http://127.0.0.1:1".into(), remote_management_key: "fixture-management".into(),
        remote_client_origin: "http://127.0.0.1:1".into(), ..GuiConfigFile::default()
    })).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let poll = crate::management_api::get_oauth_status(app.state(), "old-state".into()).await.err().unwrap();
    assert!(poll.contains("different or expired core connection"));
    let callback = crate::management_api::submit_oauth_callback(app.state(), "codex".into(),
        "http://localhost:1455/auth/callback?state=old-state&code=sensitive-fixture-code".into(), None).await.err().unwrap();
    assert!(callback.contains("different or expired core connection"));
    assert!(!callback.contains("sensitive-fixture-code"));
}

#[cfg(unix)]
#[tokio::test]
async fn remote_selection_requires_explicit_stop_of_gui_owned_local_core() {
    let directory = super::support::agent_test_home("remote-detach");
    let mut state = GuiConfigState::new(GuiConfigFile::default());
    state.persistence_path = Some(directory.join("config.toml"));
    let app = tauri::test::mock_builder().manage(state).manage(AgentConfigStatusCache::default())
        .manage(CoreProcessState::default()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let mut command = Command::new("sleep"); command.arg("30");
    let child = spawn_core_child(command).unwrap();
    let pid = child.id();
    app.state::<CoreProcessState>().store_child(child).unwrap();
    let error = crate::core_connection::save_core_connection(app.handle().clone(), app.state(), CoreConnection {
        mode: CoreConnectionMode::Remote, management_origin: "http://remote.invalid".into(), management_key: "fixture-management".into(), client_origin: "http://client.invalid".into(), client_key: String::new(),
    }).await.err().unwrap();
    assert!(error.contains("Stop the GUI-managed local core"));
    assert_eq!(crate::core_connection::get_core_connection(app.state()).unwrap().mode, CoreConnectionMode::Local);
    let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
    unsafe { libc::kill(pid as i32, libc::SIGTERM); libc::waitpid(pid as i32, std::ptr::null_mut(), 0); }
    assert!(alive, "Rejected remote selection must leave the local child running");
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn remote_alias_removal_uses_remote_management_without_local_rollback() {
    let yaml = "config-version: 8\noauth:\n  model-alias:\n    codex:\n      - name: fixture-model\n        alias: fixture-alias\n        fork: true\n";
    let (origin, server) = serve_config_steps(vec![
        ("GET /v8/management/config.yaml HTTP/1.1", "", 200, yaml),
        ("GET /v8/management/config.yaml HTTP/1.1", "", 200, yaml),
        ("GET /v8/management/config.yaml HTTP/1.1", "", 200, yaml),
        ("GET /v8/management/config.yaml HTTP/1.1", "", 200, yaml),
        ("DELETE /v8/management/config/oauth/model-alias HTTP/1.1", "", 200, "{}"),
    ]);
    let app = tauri::test::mock_builder().manage(GuiConfigState::new(GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote, remote_management_origin: origin.clone(),
        remote_management_key: "fixture-management".into(), remote_client_origin: origin,
        ..GuiConfigFile::default()
    })).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let entries = get_thinking_aliases(app.state()).await.unwrap();
    assert_eq!(entries.len(), 1);
    let after = delete_thinking_alias(app.state(), "fixture-alias".into(), Some("codex".into()), None).await.unwrap();
    assert!(after.is_empty());
    server.join().unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn remote_exit_leaves_adopted_external_process_and_local_startup_preference_untouched() {
    let directory = super::support::agent_test_home("remote-adopted");
    let mut state = GuiConfigState::new(GuiConfigFile { run_on_startup: true, ..GuiConfigFile::default() });
    state.persistence_path = Some(directory.join("config.toml"));
    let app = tauri::test::mock_builder().manage(state).manage(AgentConfigStatusCache::default())
        .manage(CoreProcessState::default()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let mut external = Command::new("sleep").arg("30").spawn().unwrap();
    let path = fs::read_link(format!("/proc/{}/exe", external.id())).unwrap();
    app.state::<CoreProcessState>().adopt_process_ids(&path, vec![external.id()]).unwrap();
    crate::core_connection::save_core_connection(app.handle().clone(), app.state(), CoreConnection {
        mode: CoreConnectionMode::Remote, management_origin: "http://remote.invalid".into(), management_key: "fixture-management".into(), client_origin: "http://client.invalid".into(), client_key: String::new(),
    }).await.unwrap();
    shutdown_managed_core(app.state::<CoreProcessState>().inner(), app.state::<GuiConfigState>().inner());
    let running = external.try_wait().unwrap().is_none();
    let startup = get_gui_settings(app.state()).unwrap().run_on_startup;
    external.kill().unwrap(); external.wait().unwrap();
    assert!(running);
    assert!(startup);
    fs::remove_dir_all(directory).unwrap();
}
