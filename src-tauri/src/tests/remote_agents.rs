use super::*;
use super::support::*;

#[tokio::test]
async fn codex_mutations_reject_stale_target_revisions_before_work() {
    let app = tauri::test::mock_builder()
        .manage(GuiConfigState::new(GuiConfigFile::default()))
        .manage(AgentConfigStatusCache::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let expected_error = "The core connection changed; request cancelled";

    assert_eq!(set_codex_openai_provider(app.handle().clone(), false, 1).await.err().as_deref(), Some(expected_error));
    assert_eq!(set_codex_remote_compaction(app.handle().clone(), false, 1).err().as_deref(), Some(expected_error));
    let request = serde_json::from_value(serde_json::json!({
        "revision": "fixture",
        "models": [],
        "review_model": { "model": null }
    })).unwrap();
    assert_eq!(save_codex_model_catalog_editor(app.handle().clone(), app.state(), request, 1).await.err().as_deref(), Some(expected_error));

    // Local mode uses the same in-memory revision contract; the current revision is accepted.
    let local = GuiConfigState::new(GuiConfigFile::default());
    assert_eq!(local.snapshot().unwrap().connection_mode, CoreConnectionMode::Local);
    assert!(local.ensure_revision(0).is_ok());
    assert_eq!(local.ensure_revision(1).err().as_deref(), Some(expected_error));
}

fn remote_target(origin: &str, key: &str) -> GuiConfigFile {
    GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: "http://management.invalid:9141".into(),
        remote_management_key: "fixture-management-never-client".into(),
        remote_client_origin: origin.into(),
        remote_client_key: key.into(),
        ..GuiConfigFile::default()
    }
}

#[test]
fn remote_agents_write_inspect_rotate_and_restore_isolated_configs() {
    let models = test_agent_models(&["gpt-5.6-sol"]);
    let catalog = test_codex_models(&["gpt-5.6-sol"]);
    for client in [AgentClient::ClaudeCode, AgentClient::ClaudeDesktop, AgentClient::Codex,
        AgentClient::OpenCode, AgentClient::OpenClaw, AgentClient::Hermes,
        AgentClient::DeepSeekHarness, AgentClient::ZCode, AgentClient::WorkBuddy,
        AgentClient::AntigravityCli, AgentClient::CopilotCli, AgentClient::VscodeCopilot,
        AgentClient::KimiCode, AgentClient::GrokBuild, AgentClient::Omp] {
        let home = agent_test_home(&format!("remote-{}", client.id()));
        let paths = agent_config_paths(client, &home);
        if !client.supported_platform() {
            assert!(validate_agent_can_enable(client, &home, 8317, "unused", None).is_err());
            fs::remove_dir_all(home).unwrap();
            continue;
        }
        if client == AgentClient::WorkBuddy {
            fs::create_dir_all(paths[0].parent().unwrap()).unwrap();
            fs::write(&paths[0], r#"{"models":[],"unrelated":true}"#).unwrap();
        }
        if client == AgentClient::VscodeCopilot {
            let cache = paths[0].parent().unwrap().join("ezcpa-copilot/credential.json");
            fs::create_dir_all(cache.parent().unwrap()).unwrap();
            fs::write(cache, serde_json::json!({"keyHash": sha256_bytes(b"fixture-client"),
                "secretReference":"${input:chat.lm.secret.fixture}"}).to_string()).unwrap();
        }
        let original = config_images(&paths).unwrap();
        let target = remote_target("https://client.example.test:9443", "fixture-client");
        let mappings = ClaudeDesktopModelMappings::all("gpt-5.6-sol");
        let apply = |target: &GuiConfigFile| apply_agent_configuration_with_oauth(client, &home,
            target, effective_agent_api_key(target), "gpt-5.6-sol", AgentConfigurationOptions {
                models: &models, codex_catalog: Some(&catalog), oauth_configuration: false,
                claude_code_model_mappings: Some(&mappings), claude_desktop_model_mappings: Some(&mappings),
            });
        apply(&target).unwrap_or_else(|error| panic!("{}: {error}", client.id()));
        let configured = inspect_agent_managed_config(client, &paths, &target, "fixture-client")
            .unwrap_or_else(|error| panic!("{}: {error}", client.id()));
        assert!(configured.0, "{} must inspect the selected remote client", client.id());
        assert!(!inspect_agent_managed_config(client, &paths, 8317, "fixture-client").unwrap().0,
            "{} must not inspect as local", client.id());
        let serialized = config_images(&paths).unwrap().into_iter().filter_map(|(_, bytes)| bytes)
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string()).collect::<String>();
        assert!(serialized.contains("https://client.example.test:9443"), "{}", client.id());
        assert!(!serialized.contains("fixture-management-never-client"));
        let backup = serde_json::to_value(create_backup(client.id(), &home).unwrap()).unwrap();
        assert_eq!(backup["restorable"], true);
        let rotated = remote_target("http://other-client.example.test:8319", "fixture-client");
        apply(&rotated).unwrap();
        assert!(!inspect_agent_managed_config(client, &paths, &target, "fixture-client").unwrap().0);
        assert!(inspect_agent_managed_config(client, &paths, &rotated, "fixture-client").unwrap().0);
        clear_agent_managed_configuration(client, &home, &rotated).unwrap();
        if client == AgentClient::Codex {
            // Existing Close behavior restores official routing, retaining the
            // inactive CPA provider for later re-enable (not full file reset).
            let value: toml::Value = toml::from_str(&fs::read_to_string(&paths[0]).unwrap()).unwrap();
            assert!(value.get("model_provider").is_none());
            assert!(value.get("model").is_none());
        } else {
            for ((_, actual), (_, before)) in config_images(&paths).unwrap().iter().zip(&original) {
                match (actual, before) {
                    (Some(actual), Some(before)) => assert!(agent_config_semantically_equal(client,
                        std::str::from_utf8(actual).unwrap(), std::str::from_utf8(before).unwrap()), "{} restoration", client.id()),
                    _ => assert_eq!(actual, before, "{} restoration", client.id()),
                }
            }
        }
        fs::remove_dir_all(home).unwrap();
    }
}

#[test]
fn remote_clear_refuses_to_remove_unrecorded_claude_code_configuration() {
    let home = agent_test_home("remote-unrecorded-claude-code");
    let paths = agent_config_paths(AgentClient::ClaudeCode, &home);
    fs::create_dir_all(paths[0].parent().unwrap()).unwrap();
    let original = r#"{"env":{"ANTHROPIC_BASE_URL":"https://client.example.test:9443","ANTHROPIC_AUTH_TOKEN":"user-key"},"userSetting":true}"#;
    fs::write(&paths[0], original).unwrap();

    let result = clear_agent_managed_configuration(
        AgentClient::ClaudeCode,
        &home,
        &remote_target("https://client.example.test:9443", "fixture-client"),
    );
    assert!(result.is_err());
    assert_eq!(fs::read_to_string(&paths[0]).unwrap(), original);

    fs::remove_dir_all(home).unwrap();
}

#[test]
fn remote_pi_uses_explicit_origin_and_allows_intentionally_blank_key() {
    let home = agent_test_home("remote-pi");
    let target = remote_target("http://pi-core.example.test:8319", "");
    assert_eq!(effective_agent_api_key(&target), "");
    let updates = build_pi_template_updates(&home, &target, "", "fixture-model").unwrap();
    let config: serde_json::Value = serde_json::from_str(&updates[0].after).unwrap();
    assert_eq!(config["baseUrl"], "http://pi-core.example.test:8319");
    assert_eq!(config["apiKey"], "");
    fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn remote_models_command_uses_client_auth_and_fences_old_target_response() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (received_tx, received_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut data = [0; 8192];
        let size = stream.read(&mut data).unwrap();
        let request = String::from_utf8_lossy(&data[..size]).to_ascii_lowercase();
        assert!(request.starts_with("get /v1/models "));
        assert!(request.contains("authorization: bearer fixture-client"));
        assert!(!request.contains("fixture-management"));
        received_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let body = r#"{"data":[{"id":"fixture-model"}]}"#;
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
    });
    let app = tauri::test::mock_builder().manage(GuiConfigState::new(remote_target(&origin, "fixture-client")))
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let handle = app.handle().clone();
    let request = async { get_agent_models(handle.clone(), handle.state(), PI_AGENT_ID.into()).await };
    let change = async {
        received_rx.await.unwrap();
        let mut changed = handle.state::<GuiConfigState>().snapshot().unwrap();
        changed.remote_client_origin = "http://other.invalid".into();
        handle.state::<GuiConfigState>().replace_external(changed).unwrap();
        release_tx.send(()).unwrap();
    };
    let (result, _) = tokio::join!(request, change);
    assert!(result.unwrap_err().contains("connection changed"));
    server.join().unwrap();
}

#[tokio::test]
async fn remote_model_errors_and_redirects_cannot_echo_or_forward_keys() {
    for response in [
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 14\r\nConnection: close\r\n\r\nfixture-client",
        "HTTP/1.1 200 OK\r\nContent-Length: 14\r\nConnection: close\r\n\r\nfixture-client",
        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/fixture-client\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    ] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target = remote_target(&format!("http://{}", listener.local_addr().unwrap()), "fixture-client");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut data = [0; 8192]; let _request_bytes = stream.read(&mut data).unwrap();
            stream.write_all(response.as_bytes()).unwrap();
        });
        let error = fetch_agent_model_payload(&target, effective_agent_api_key(&target)).await.unwrap_err();
        assert!(!error.contains("fixture-client"));
        assert!(!error.contains("fixture-management"));
        server.join().unwrap();
    }
}

#[tokio::test]
async fn remote_connection_events_emit_only_revision_not_credentials() {
    use tauri::Listener;
    let home = agent_test_home("remote-secret-events");
    let mut state = GuiConfigState::new(GuiConfigFile::default());
    state.persistence_path = Some(home.join("gui.toml"));
    let app = tauri::test::mock_builder().manage(state)
        .manage(AgentConfigStatusCache::default()).manage(CoreProcessState::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let events = std::sync::Arc::new(Mutex::new(Vec::new()));
    let received = events.clone();
    app.listen("core-connection-changed", move |event| received.lock().unwrap().push(event.payload().to_string()));
    let connection = crate::core_connection::CoreConnection {
        mode: CoreConnectionMode::Remote,
        management_origin: "https://management.example.test".into(),
        management_key: "fixture-management-secret".into(),
        client_origin: "https://client.example.test".into(),
        client_key: "fixture-client-secret".into(),
    };
    crate::core_connection::save_core_connection(app.handle().clone(), app.state(), connection).await.unwrap();
    let saved = app.state::<GuiConfigState>().snapshot().unwrap();
    assert_eq!(saved.remote_management_key, "fixture-management-secret");
    assert_eq!(saved.remote_client_key, "fixture-client-secret");
    let mut rotated = saved.clone();
    rotated.remote_management_key = "fixture-rotated-management-secret".into();
    rotated.remote_client_key = "fixture-rotated-client-secret".into();
    {
        let state = app.state::<GuiConfigState>();
        let _guard = state.target_operation.lock().await;
        crate::core_connection::replace_external_target(app.handle(), rotated).unwrap();
    }
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 2, "both save and external replacement must emit");
    for (event, revision) in events.iter().zip([saved.target_revision, saved.target_revision + 1]) {
        assert_eq!(serde_json::from_str::<serde_json::Value>(event).unwrap(), serde_json::json!({"revision": revision}));
        for secret in ["fixture-management-secret", "fixture-client-secret",
            "fixture-rotated-management-secret", "fixture-rotated-client-secret"] {
            assert!(!event.contains(secret));
        }
    }
    fs::remove_dir_all(home).unwrap();
}
