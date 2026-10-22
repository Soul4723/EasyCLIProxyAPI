use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn remote_fixture(body: &'static str) -> (GuiConfigFile, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: format!("http://{}", listener.local_addr().unwrap()),
        remote_management_key: "fixture-management-key".into(),
        // Any accidental Local fallback must fail, not contact a real core.
        port: 0,
        ..GuiConfigFile::default()
    };
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let mut bytes = [0; 2048];
                let count = socket.read(&mut bytes).await.unwrap();
                if count == 0 { break; }
                request.extend_from_slice(&bytes[..count]);
            }
            let request = String::from_utf8_lossy(&request).to_ascii_lowercase();
            let body = if request.starts_with("get /v8/management/config.yaml ") {
                assert!(request.contains("authorization: bearer fixture-management-key\r\n"));
                body
            } else {
                assert!(request.starts_with("get /v1/models"), "{request}");
                assert!(request.contains("authorization: bearer fixture-client-key\r\n"));
                assert!(!request.contains("fixture-management-key"));
                "{\"data\":[{\"id\":\"fixture-model\"}]}"
            };
            let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (config, server)
}

#[tokio::test]
async fn remote_agents_write_detect_and_fetch_using_only_remote_client_credentials() {
    let (remote, server) = remote_fixture("port: 9443\napi-keys:\n  - fixture-client-key\n  - unused-client-key\n").await;
    let key = agent_client_api_key(&remote).await.unwrap();
    assert_eq!(key, "fixture-client-key");
    let home = std::env::temp_dir().join(format!("remote-agents-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&home).unwrap();
    let runtime = codex_catalog::parse_runtime_models(&serde_json::json!({"models": [{"id": "fixture-model"}]})).unwrap();
    let catalog = codex_catalog::prepare_catalog(&runtime).unwrap().json;
    for client in [AgentClient::ClaudeCode, AgentClient::Codex, AgentClient::OpenCode] {
        let updates = build_agent_updates(client, &home, &remote, &key, "fixture-model", &[], Some(&catalog)).unwrap();
        for update in &updates {
            assert!(!update.after.contains("fixture-management-key"));
            write_bytes_directly(&update.path, update.after.as_bytes()).unwrap();
        }
        let contents = updates.iter().map(|update| update.after.as_str()).collect::<Vec<_>>().join("\n");
        assert!(contents.contains(&remote.client_origin()));
        assert!(contents.contains("fixture-client-key"));
        let paths = agent_config_paths(client, &home);
        assert!(inspect_agent_managed_config(client, &paths, &remote, &key).unwrap().0);
        assert!(!inspect_agent_managed_config(client, &paths, 54321, &key).unwrap().0);
        assert!(agent_has_managed_marker(client, &paths).unwrap());
        let images = config_images(&config_paths(client.id(), &home).unwrap()).unwrap();
        backups::validate_restore_target(&remote, client.id(), &images, &key).unwrap();
        if client == AgentClient::Codex {
            switch_codex_remote_compaction_for_target(&home, true, &remote).unwrap();
            assert!(codex_remote_compaction_enabled(&home).unwrap());
            switch_codex_openai_provider_for_target(&home, true, &remote).unwrap();
            assert!(codex_openai_proxy_enabled(&home).unwrap());
        }
        let local = GuiConfigFile { port: 54321, ..GuiConfigFile::default() };
        let updates = build_agent_updates(client, &home, &local, "local-client-key", "fixture-model", &[], Some(&catalog)).unwrap();
        for update in updates { write_bytes_directly(&update.path, update.after.as_bytes()).unwrap(); }
        assert!(inspect_agent_managed_config(client, &paths, &local, "local-client-key").unwrap().0);
        assert!(!inspect_agent_managed_config(client, &paths, &remote, &key).unwrap().0);
        // Local restores keep accepting this computer's core, whatever its port or key.
        let local_images = config_images(&config_paths(client.id(), &home).unwrap()).unwrap();
        backups::validate_restore_target(&GuiConfigFile::default(), client.id(), &local_images, "rotated-key").unwrap();
    }
    assert_eq!(fetch_agent_models(&remote, &key).await.unwrap()[0].name, "fixture-model");
    assert_eq!(fetch_codex_runtime_models(&remote, &key).await.unwrap()[0].slug, "fixture-model");
    fs::remove_dir_all(home).unwrap();
    server.abort();
}

#[tokio::test]
async fn remote_agents_never_fall_back_when_client_key_discovery_fails() {
    let (remote, server) = remote_fixture("api-keys: []\n").await;
    assert!(agent_client_api_key(&remote).await.unwrap_err().contains("no client API key"));
    server.abort();
    let invalid = GuiConfigFile {
        remote_management_origin: "not an origin".into(),
        ..remote
    };
    assert!(agent_client_api_key(&invalid).await.is_err());
    assert!(invalid.validate_client_origin().is_err());
}

#[test]
fn remote_codex_controls_recognize_only_the_selected_origin() {
    let remote = GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: "https://core.example:9443".into(),
        ..GuiConfigFile::default()
    };
    assert!(is_managed_agent_target_url("https://core.example:9443/v1", &remote));
    for url in ["http://127.0.0.1:54321/v1", "https://other.example/v1", "https://core.example:9443/v1?key=no"] {
        assert!(!is_managed_agent_target_url(url, &remote));
    }
    let cache = AgentConfigStatusCache::default();
    cache.replace(&remote, "key", vec![]).unwrap();
    assert!(cache.get(&remote, "key").unwrap().is_some());
    assert!(cache.get(54321, "key").unwrap().is_none());
}

#[test]
fn deepseek_harness_backups_expect_the_writers_base_url() {
    let remote = GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: "https://core.example:9443".into(),
        ..GuiConfigFile::default()
    };
    let backup = |api: &str, url: &str| -> Images {
        let settings = format!("llm-pi-ai:\n  providers:\n    {DEEPSEEK_HARNESS_PROVIDER_ID}:\n      api: {api}\n      baseURL: {url}\n");
        let secrets = serde_json::json!({ DEEPSEEK_HARNESS_CREDENTIAL: "client-key" }).to_string();
        vec![
            (PathBuf::from("settings.yaml"), Some(settings.into_bytes())),
            (PathBuf::from("secrets.json"), Some(secrets.into_bytes())),
        ]
    };
    for (api, url) in [("anthropic-messages", "https://core.example:9443"), ("openai-completions", "https://core.example:9443/v1")] {
        backups::validate_restore_target(&remote, "deepseek-harness", &backup(api, url), "client-key").unwrap();
    }
    assert!(backups::validate_restore_target(&remote, "deepseek-harness", &backup("anthropic-messages", "https://core.example:9443/v1"), "client-key").is_err());
}

#[test]
fn local_restore_refuses_a_backup_made_against_another_computer() {
    let remote = GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: "https://core.example:9443".into(),
        ..GuiConfigFile::default()
    };
    let home = std::env::temp_dir().join(format!("remote-restore-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&home).unwrap();
    for update in build_agent_updates(AgentClient::OpenCode, &home, &remote, "remote-client-key", "fixture-model", &[], None).unwrap() {
        write_bytes_directly(&update.path, update.after.as_bytes()).unwrap();
    }
    let images = config_images(&config_paths(AgentClient::OpenCode.id(), &home).unwrap()).unwrap();
    backups::validate_restore_target(&remote, AgentClient::OpenCode.id(), &images, "remote-client-key").unwrap();
    assert!(backups::validate_restore_target(&GuiConfigFile::default(), AgentClient::OpenCode.id(), &images, "local-client-key").is_err());
    fs::remove_dir_all(home).unwrap();
}
