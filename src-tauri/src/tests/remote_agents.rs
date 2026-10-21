use super::*;
use super::support::*;

fn codex_test_home(name: &str) -> PathBuf {
    let home = agent_test_home(name);
    fs::create_dir_all(home.join(".codex")).unwrap();
    home
}

fn codex_config_for_target(target: &GuiConfigFile) -> String {
    build_codex_agent_config(None, &format!("{}/v1", target.client_origin()), "fixture-client", "gpt-5.6-sol").unwrap()
}

#[tokio::test]
async fn set_codex_openai_provider_command_fences_write_and_keeps_local_behavior() {
    let expected_error = "The core connection changed; request cancelled";
    for (name, target, expected_revision, should_apply) in [
        ("provider-stale", remote_target("http://client.example.test:9443", "fixture-client"), 1, false),
        ("provider-current", remote_target("http://client.example.test:9443", "fixture-client"), 0, true),
        ("provider-local", GuiConfigFile::default(), 0, true),
    ] {
        let home = codex_test_home(name);
        let config = codex_config_for_target(&target);
        let config_path = home.join(".codex/config.toml");
        let auth_path = home.join(".codex/auth.json");
        fs::write(&config_path, &config).unwrap();
        fs::write(&auth_path, "{}").unwrap();
        let paths = vec![config_path.clone(), auth_path];
        let before = config_images(&paths).unwrap();
        let state = GuiConfigState::new(target.clone());

        let result = set_codex_openai_provider_for_target(
            &state, &home, true, expected_revision, |_, _| async { Ok(()) },
        ).await;
        if should_apply {
            result.unwrap();
            let document = parse_codex_document(Some(&fs::read_to_string(&config_path).unwrap()), "Codex config.toml").unwrap();
            assert!(codex_uses_openai_proxy(&document), "current target should apply the provider switch: {name}");
        } else {
            assert_eq!(result.unwrap_err(), expected_error);
            assert_eq!(config_images(&paths).unwrap(), before, "stale target must not mutate files");
        }
        fs::remove_dir_all(home).unwrap();
    }
}

#[tokio::test]
async fn set_codex_openai_provider_rechecks_revision_after_auth_validation() {
    let expected_error = "The core connection changed; request cancelled";
    let home = codex_test_home("provider-revision-changed-during-auth-validation");
    let target = remote_target("http://client.example.test:9443", "fixture-client");
    let config_path = home.join(".codex/config.toml");
    let auth_path = home.join(".codex/auth.json");
    fs::write(&config_path, codex_config_for_target(&target)).unwrap();
    fs::write(&auth_path, "{}").unwrap();
    let paths = vec![config_path, auth_path];
    let before = config_images(&paths).unwrap();
    let state = GuiConfigState::new(target);

    let result = set_codex_openai_provider_for_target(
        &state, &home, true, 0,
        |_, _| {
            // This closure stands in for the unlocked network auth validation.
            let mut changed = state.snapshot().unwrap();
            changed.remote_client_origin = "http://other-client.example.test:9443".into();
            state.replace_external(changed).unwrap();
            async { Ok(()) }
        },
    ).await;

    assert_eq!(result.unwrap_err(), expected_error);
    assert_eq!(config_images(&paths).unwrap(), before, "stale auth response must not mutate Codex files");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn set_codex_remote_compaction_command_fences_write_and_keeps_local_behavior() {
    let expected_error = "The core connection changed; request cancelled";
    for (name, target, expected_revision, should_apply) in [
        ("compaction-stale", remote_target("http://client.example.test:9443", "fixture-client"), 1, false),
        ("compaction-current", remote_target("http://client.example.test:9443", "fixture-client"), 0, true),
        ("compaction-local", GuiConfigFile::default(), 0, true),
    ] {
        let home = codex_test_home(name);
        let path = home.join(".codex/config.toml");
        let before_config = codex_config_for_target(&target);
        fs::write(&path, &before_config).unwrap();
        let state = GuiConfigState::new(target);

        let result = set_codex_remote_compaction_for_target(&state, &home, true, expected_revision);
        if should_apply {
            result.unwrap();
            assert!(codex_remote_compaction_enabled(&home).unwrap(), "current target should apply compaction: {name}");
        } else {
            assert_eq!(result.unwrap_err(), expected_error);
            assert_eq!(fs::read_to_string(&path).unwrap(), before_config, "stale target must not mutate config");
        }
        fs::remove_dir_all(home).unwrap();
    }
}

#[tokio::test]
async fn save_codex_model_catalog_editor_command_fences_write_and_keeps_local_behavior() {
    let expected_error = "The core connection changed; request cancelled";
    let runtime = codex_catalog::parse_runtime_models(&serde_json::json!({"models":[]})).unwrap();
    for (name, target, expected_revision, should_apply) in [
        ("catalog-stale", remote_target("http://client.example.test:9443", "fixture-client"), 1, false),
        ("catalog-current", remote_target("http://client.example.test:9443", "fixture-client"), 0, true),
        ("catalog-local", GuiConfigFile::default(), 0, true),
    ] {
        let home = codex_test_home(name);
        let path = home.join("codex-model-customizations.json");
        let state = GuiConfigState::new(target);
        let result = codex_catalog_editor_target_snapshot(&state, expected_revision).await;
        if should_apply {
            let config = result.unwrap();
            let snapshot = codex_catalog::editor_snapshot(&runtime).unwrap();
            let request: codex_catalog::CatalogEditorRequest = serde_json::from_value(serde_json::json!({
                "revision": serde_json::to_value(snapshot).unwrap()["revision"],
                "models": []
            })).unwrap();
            save_codex_model_catalog_for_target(
                &state, &runtime, request, config.target_revision,
                |runtime, request| {
                    let snapshot = codex_catalog::save_customizations(&path, runtime, request)?;
                    Ok((snapshot, None))
                },
            ).await.unwrap();
            assert!(path.is_file(), "current target should persist catalog customizations: {name}");
        } else {
            assert_eq!(result.err().unwrap(), expected_error);
            assert!(!path.exists(), "stale target must not create customization file");
        }
        fs::remove_dir_all(home).unwrap();
    }
}

#[tokio::test]
async fn save_codex_model_catalog_editor_rechecks_revision_after_catalog_read() {
    let expected_error = "The core connection changed; request cancelled";
    let home = codex_test_home("catalog-revision-changed-during-read");
    let path = home.join("codex-model-customizations.json");
    let target = remote_target("http://client.example.test:9443", "fixture-client");
    let state = GuiConfigState::new(target);
    let config = codex_catalog_editor_target_snapshot(&state, 0).await.unwrap();

    // This is the unlocked catalog network-read interval between taking the
    // target snapshot and saving the editor request.
    let mut changed = state.snapshot().unwrap();
    changed.remote_client_origin = "http://other-client.example.test:9443".into();
    state.replace_external(changed).unwrap();

    let runtime = codex_catalog::parse_runtime_models(&serde_json::json!({"models":[]})).unwrap();
    let snapshot = codex_catalog::editor_snapshot(&runtime).unwrap();
    let request: codex_catalog::CatalogEditorRequest = serde_json::from_value(serde_json::json!({
        "revision": serde_json::to_value(snapshot).unwrap()["revision"],
        "models": []
    })).unwrap();
    let mut applied = false;
    let result = save_codex_model_catalog_for_target(
        &state, &runtime, request, config.target_revision,
        |runtime, request| {
            applied = true;
            let snapshot = codex_catalog::save_customizations(&path, runtime, request)?;
            Ok((snapshot, None))
        },
    ).await;

    assert_eq!(result.unwrap_err(), expected_error);
    assert!(!applied, "stale catalog read must not reach the save callback");
    assert!(!path.exists(), "stale catalog read must not create customization file");
    fs::remove_dir_all(home).unwrap();
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
async fn preview_agent_config_template_cancels_after_switch_while_models_fetch_is_paused() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mut target = remote_target(&origin, "fixture-client");
    target.remote_management_origin = origin.clone();
    let app = tauri::test::mock_builder().manage(GuiConfigState::new(target))
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let home = AgentTestHome::new("preview-template-cancel");
    let state = app.state::<GuiConfigState>();
    let (arrived_tx, arrived_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // Claude Code fetches /v1/models, then reads management YAML to mark
        // configured aliases. Pause the first request, then serve both reads.
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 4096];
        let request_len = socket.read(&mut request).await.unwrap();
        assert!(String::from_utf8_lossy(&request[..request_len]).contains("/v1/models"));
        arrived_tx.send(()).unwrap();
        release_rx.await.unwrap();
        let body = r#"{"data":[{"id":"fixture-model"}]}"#;
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();

        let (mut config_socket, _) = listener.accept().await.unwrap();
        let mut config_request = [0; 4096];
        let config_len = config_socket.read(&mut config_request).await.unwrap();
        assert!(String::from_utf8_lossy(&config_request[..config_len]).contains("/v0/management/config.yaml"));
        let config_body = "{}\n";
        config_socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/yaml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{config_body}", config_body.len()).as_bytes()).await.unwrap();
    });
    let call = crate::agents::preview_agent_config_template_for_target(
        state.inner(), home.path().to_path_buf(), "claude-code".into(), "fixture-model".into(), false, None, None,
    );
    tokio::pin!(call);
    tokio::select! {
        result = &mut call => panic!("template preview finished before the model server answered: {}", if result.is_ok() { "success" } else { "error" }),
        arrived = arrived_rx => arrived.unwrap(),
    }
    assert!(state.target_operation.try_lock().is_ok(), "model fetch held the target fence");
    let mut changed = state.snapshot().unwrap();
    changed.remote_client_origin = "http://target-b.invalid:8317".into();
    changed.remote_client_key = "target-b-client".into();
    state.replace_external(changed).unwrap();
    release_tx.send(()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), call).await.unwrap();
    let error = match result { Ok(_) => panic!("template preview returned after the target changed"), Err(error) => error };
    assert!(error.contains("request cancelled"), "{error}");
    server.await.unwrap();
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
