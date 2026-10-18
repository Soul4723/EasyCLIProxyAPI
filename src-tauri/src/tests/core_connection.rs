use super::*;
use std::sync::Arc;
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
    let view = get_core_config_settings(app.state(), app.state::<GuiConfigState>().snapshot().unwrap().target_revision).await.unwrap();
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
    let settings = get_core_config_settings(app.state(), app.state::<GuiConfigState>().snapshot().unwrap().target_revision).await.unwrap();
    assert_eq!(settings.port, reqwest::Url::parse(&candidate.management_origin).unwrap().port().unwrap());
    let extended = get_extended_core_config(app.state(), app.state::<GuiConfigState>().snapshot().unwrap().target_revision).await.unwrap();
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
        let result = set_core_plugins_enabled(app.state(), app.state::<GuiConfigState>().snapshot().unwrap().target_revision, true).await;
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
    let error = save_network_endpoint_settings(app.state(), app.state::<GuiConfigState>().snapshot().unwrap().target_revision, app.state(), GuiNetworkEndpointSettings {
        host: "10.0.0.9".into(), port: 9999, proxy_url: None, proxy_override: None,
    }).await.err().unwrap();
    assert!(error.contains("1 of 2 confirmed changes"));
    assert!(!error.contains("sensitive server details"));
    let current = get_core_config_settings(app.state(), app.state::<GuiConfigState>().snapshot().unwrap().target_revision).await.unwrap();
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
    let poll = crate::management_api::get_oauth_status(app.state(), "old-state".into(), 0).await.err().unwrap();
    assert!(poll.contains("different or expired core connection"));
    let callback = crate::management_api::submit_oauth_callback(app.state(), "codex".into(),
        "http://localhost:1455/auth/callback?state=old-state&code=sensitive-fixture-code".into(), None, 0).await.err().unwrap();
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
    let entries = get_thinking_aliases(app.state(), app.state::<GuiConfigState>().snapshot().unwrap().target_revision).await.unwrap();
    assert_eq!(entries.len(), 1);
    let after = delete_thinking_alias(app.state(), app.state::<GuiConfigState>().snapshot().unwrap().target_revision, "fixture-alias".into(), Some("codex".into()), None).await.unwrap();
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

#[test]
fn external_target_change_invalidates_only_with_revision_payload() {
    use tauri::Listener;
    let app = tauri::test::mock_builder()
        .manage(GuiConfigState::new(GuiConfigFile::default()))
        .manage(AgentConfigStatusCache::default()).manage(CoreProcessState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let received = events.clone();
    app.listen("core-connection-changed", move |event| received.lock().unwrap().push(event.payload().to_string()));
    let state = app.state::<GuiConfigState>();
    let before = state.snapshot().unwrap();
    let _guard = state.target_operation.blocking_lock();
    let mut external = before.clone();
    external.connection_mode = CoreConnectionMode::Remote;
    external.remote_management_key = "secret-must-not-be-emitted".into();
    external.target_revision = 999;
    crate::core_connection::replace_external_target(app.handle(), external).unwrap();
    assert!(state.ensure_target(&before).is_err());
    assert_eq!(state.snapshot().unwrap().target_revision, before.target_revision + 1);
    assert_eq!(*events.lock().unwrap(), vec![format!("{{\"revision\":{}}}", before.target_revision + 1)]);
}

#[cfg(unix)]
#[test]
fn external_remote_change_refuses_owned_core_without_invalidating() {
    let app = tauri::test::mock_builder()
        .manage(GuiConfigState::new(GuiConfigFile::default()))
        .manage(AgentConfigStatusCache::default()).manage(CoreProcessState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let mut command = Command::new("sleep"); command.arg("30");
    app.state::<CoreProcessState>().store_child(spawn_core_child(command).unwrap()).unwrap();
    let state = app.state::<GuiConfigState>();
    let before = state.snapshot().unwrap();
    let _guard = state.target_operation.blocking_lock();
    let mut external = before.clone(); external.connection_mode = CoreConnectionMode::Remote;
    let result = crate::core_connection::replace_external_target(app.handle(), external);
    let process = app.state::<CoreProcessState>();
    let mut child = process.child.lock().unwrap().take().unwrap();
    let alive = child.try_wait().unwrap().is_none();
    child.kill().unwrap(); child.wait().unwrap();
    assert!(result.unwrap_err().contains("Stop the GUI-managed local core"));
    assert!(alive);
    state.ensure_target(&before).unwrap();
    assert_eq!(state.snapshot().unwrap().connection_mode, CoreConnectionMode::Local);
}

#[test]
fn pending_local_worker_revalidates_and_active_worker_fences_through_completion() {
    let state = Arc::new(GuiConfigState::new(GuiConfigFile::default()));
    let before = state.snapshot().unwrap();
    let guard = state.target_operation.blocking_lock();
    let worker_state = state.clone();
    let expected = before.clone();
    let worker = std::thread::spawn(move || worker_state.blocking_local_target_operation(&expected).is_err());
    let mut remote = before.clone(); remote.connection_mode = CoreConnectionMode::Remote;
    state.replace_external(remote).unwrap();
    drop(guard);
    assert!(worker.join().unwrap(), "Queued Local write must be rejected after switching");
    state.replace_external(before).unwrap();
    let expected = state.snapshot().unwrap();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let worker_state = state.clone();
    let worker = std::thread::spawn(move || {
        let _guard = worker_state.blocking_local_target_operation(&expected).unwrap();
        started_tx.send(()).unwrap();
        finish_rx.recv().unwrap();
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(state.target_operation.try_lock().is_err(), "Switch must wait for accepted Local work");
    finish_tx.send(()).unwrap(); worker.join().unwrap();
    assert!(state.target_operation.try_lock().is_ok());
}

#[tokio::test]
async fn cancelled_local_awaiter_does_not_release_blocking_worker_fence() {
    let state = Arc::new(GuiConfigState::new(GuiConfigFile::default()));
    let fence = Arc::new(state.target_operation.clone().lock_owned().await);
    let worker_fence = fence.clone();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let _fence = worker_fence;
        started_tx.send(()).unwrap();
        finish_rx.recv().unwrap();
    });
    started_rx.await.unwrap();
    // Dropping the caller's fence and join handle models command cancellation;
    // spawn_blocking work continues and must retain target ownership itself.
    drop(fence);
    drop(worker);
    assert!(state.target_operation.try_lock().is_err());
    finish_tx.send(()).unwrap();
    let _guard = tokio::time::timeout(Duration::from_secs(5), state.target_operation.lock()).await.unwrap();
}

#[test]
fn portable_commands_export_saved_remote_settings_without_changing_active_target() {
    use crate::core_connection::{export_core_connection, import_core_connection, get_core_connection};
    let directory = super::support::agent_test_home("portable-command");
    let path = directory.join("connection.json").to_str().unwrap().to_string();
    let app = tauri::test::mock_builder()
        .manage(GuiConfigState::new(GuiConfigFile::default()))
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    assert!(export_core_connection(app.state(), path.clone(), false).is_err());
    let config = GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: "https://saved.example".into(),
        remote_management_key: "saved-management-secret".into(),
        remote_client_origin: "https://client.example".into(),
        remote_client_key: "saved-client-secret".into(),
        ..GuiConfigFile::default()
    };
    app.state::<GuiConfigState>().replace_external(config).unwrap();
    export_core_connection(app.state(), path.clone(), false).unwrap();
    let text = fs::read_to_string(&path).unwrap();
    assert!(!text.contains("saved-management-secret"));
    assert!(!text.contains("saved-client-secret"));
    assert!(!text.contains("managementKey"));
    assert!(!text.contains("clientKey"));
    let imported = import_core_connection(path.clone()).unwrap();
    assert_eq!(imported.management_origin, "https://saved.example");
    assert!(imported.management_key.is_empty());
    assert_eq!(get_core_connection(app.state()).unwrap().management_key, "saved-management-secret");
    export_core_connection(app.state(), path.clone(), true).unwrap();
    let imported = import_core_connection(path).unwrap();
    assert_eq!(imported.management_key, "saved-management-secret");
    assert_eq!(imported.client_key, "saved-client-secret");
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn stale_document_revision_rejects_typed_and_alias_commands_before_target_io() {
    for mode in [CoreConnectionMode::Local, CoreConnectionMode::Remote] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let app = tauri::test::mock_builder().manage(GuiConfigState::new(GuiConfigFile {
            connection_mode: mode,
            target_revision: 7,
            remote_management_origin: origin.clone(),
            remote_management_key: "fixture-management".into(),
            remote_client_origin: origin,
            ..GuiConfigFile::default()
        })).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        // A mounted document belongs to revision 6, although revision 7 is now selected.
        let stale = 6;
        assert!(get_core_config_settings(app.state(), stale).await.err().unwrap().contains("connection changed"));
        assert!(get_core_tls_settings(app.state(), stale).await.err().unwrap().contains("connection changed"));
        assert!(get_core_sensitive_words_settings(app.state(), stale).await.err().unwrap().contains("connection changed"));
        assert!(get_extended_core_config(app.state(), stale).await.err().unwrap().contains("connection changed"));
        assert!(save_extended_core_config(app.state(), stale, Vec::new()).await.err().unwrap().contains("connection changed"));
        assert!(set_core_plugins_enabled(app.state(), stale, true).await.err().unwrap().contains("connection changed"));
        assert!(get_thinking_aliases(app.state(), stale).await.err().unwrap().contains("connection changed"));
        assert!(delete_thinking_alias(app.state(), stale, "fixture".into(), None, None).await.err().unwrap().contains("connection changed"));
        assert!(set_core_management_secret_key(app.state(), stale, "new-fixture".into()).err().unwrap().contains("connection changed"));
        assert_eq!(app.state::<GuiConfigState>().snapshot().unwrap().target_revision, 7);
        assert!(matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock));
    }
}

#[tokio::test]
async fn queued_typed_and_alias_commands_revalidate_revision_before_dispatch() {
    let app = tauri::test::mock_builder().manage(GuiConfigState::new(GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: "http://127.0.0.1:1".into(),
        remote_management_key: "fixture-management".into(),
        remote_client_origin: "http://127.0.0.1:1".into(),
        ..GuiConfigFile::default()
    })).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let state = app.state::<GuiConfigState>();
    let guard = state.target_operation.lock().await;
    let typed = set_core_plugins_enabled(app.state(), 0, true);
    let alias = delete_thinking_alias(app.state(), 0, "fixture".into(), None, None);
    tokio::pin!(typed, alias);
    // Poll both until they are queued behind the target lock; retain their futures.
    assert!(tokio::time::timeout(Duration::from_millis(10), &mut typed).await.is_err());
    assert!(tokio::time::timeout(Duration::from_millis(10), &mut alias).await.is_err());
    let mut next = state.snapshot().unwrap();
    next.remote_management_key = "next-fixture-management".into();
    state.replace_external(next).unwrap();
    drop(guard);
    assert!(typed.await.err().unwrap().contains("connection changed"));
    assert!(alias.await.err().unwrap().contains("connection changed"));
}
