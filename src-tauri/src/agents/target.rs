use super::*;

// Explicit snapshot keeps config rendering and inspection independent of global selection.
// ponytail: numeric ports remain local-only test/helper inputs; pass a validated GUI snapshot for remote targets.
pub(crate) trait AgentEndpoint: Copy + Send + Sync {
    fn origin(self) -> String;
    fn valid(self) -> bool;
    fn local_tls(self) -> bool;
}

impl AgentEndpoint for u16 {
    fn origin(self) -> String { managed_core_loopback_origin(self) }
    fn valid(self) -> bool { self != 0 }
    fn local_tls(self) -> bool { managed_core_tls_enabled() }
}

impl AgentEndpoint for &GuiConfigFile {
    fn origin(self) -> String {
        if self.core_connection.is_remote() { self.core_connection.client_api_origin.clone() }
        else { self.port.origin() }
    }
    fn valid(self) -> bool {
        if self.core_connection.is_remote() {
            crate::core_connection::normalize_origin(&self.core_connection.client_api_origin).is_ok()
        } else { self.port.valid() }
    }
    fn local_tls(self) -> bool { !self.core_connection.is_remote() && self.port.local_tls() }
}

pub(crate) fn agent_target(config: &GuiConfigFile) -> Result<&GuiConfigFile, String> {
    if !config.valid() { return Err(if config.core_connection.is_remote() { "Set a valid client API origin for the selected core".into() } else { "Invalid kernel port".into() }); }
    let raw_key = if config.core_connection.is_remote() { &config.core_connection.client_api_key } else { effective_agent_api_key(config) };
    validate_agent_api_key(raw_key)?;
    Ok(config)
}

pub(crate) fn validate_agent_launch_target(config: &GuiConfigFile, configured: bool) -> Result<(), String> {
    if config.core_connection.is_remote() {
        agent_target(config)?;
        if !configured { return Err("Client configuration does not match the selected remote core. Apply configuration before launching".into()); }
    }
    Ok(())
}

pub(crate) fn validate_agent_api_key(key: &str) -> Result<(), String> {
    if key.trim().is_empty() || key.chars().any(char::is_control) {
        return Err("Set a valid client API key for the selected core".into());
    }
    reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))
        .map_err(|_| "Invalid client API key".to_string())?;
    Ok(())
}

pub(crate) fn validate_agent_base_url(base: &str, openai: bool) -> Result<(), String> {
    let origin = if openai { base.strip_suffix("/v1").ok_or("Client API base URL must end with /v1")? } else { base };
    crate::core_connection::normalize_origin(origin)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(origin: &str) -> GuiConfigFile {
        let mut config = GuiConfigFile::default();
        config.core_connection = crate::core_connection::CoreConnection {
            mode: crate::core_connection::ConnectionMode::Remote,
            configuration_error: None,
            remote_management_origin: "https://management.invalid".into(),
            remote_management_key: "management-secret-never-in-client".into(),
            client_api_origin: origin.into(),
            client_api_key: "remote-client-key".into(),
        };
        config
    }

    struct Home(PathBuf);
    impl Home {
        fn new() -> Self {
            let path = env::temp_dir().join(format!("cpa-remote-target-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Home {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn remote_client_target_requires_own_origin_and_key_and_never_falls_back() {
        let mut config = remote("http://100.64.0.2:8317");
        assert_eq!(agent_target(&config).unwrap().origin(), "http://100.64.0.2:8317");
        assert_eq!(effective_agent_api_key(&config), "remote-client-key");
        assert!(!agent_target(&config).unwrap().local_tls());
        assert!(validate_agent_launch_target(&config, true).is_ok());
        assert!(validate_agent_launch_target(&config, false).is_err());
        for origin in ["", "http://host/v1", "https://user:secret@host", "http://host?x=1", "http://host:0", "https://host\n"] {
            config.core_connection.client_api_origin = origin.into();
            assert!(agent_target(&config).is_err(), "accepted {origin:?}");
        }
        config.core_connection.client_api_origin = "https://client.invalid".into();
        for key in ["", "\r\nsecret", "bad\0key"] {
            config.core_connection.client_api_key = key.into();
            assert!(agent_target(&config).is_err());
        }
        assert_eq!(effective_agent_api_key(&config), "bad\0key");
        config.core_connection.mode = crate::core_connection::ConnectionMode::Local;
        assert_eq!(agent_target(&config).unwrap().origin(), config.port.origin());
        assert_eq!(effective_agent_api_key(&config), DEFAULT_API_KEY);
        assert!(validate_agent_launch_target(&config, false).is_ok());
    }

    #[test]
    fn remote_render_and_inspection_agree_for_every_client_and_detect_target_switch() {
        let home = Home::new();
        let config = remote("http://100.64.0.2:8317");
        let mut switched = config.clone();
        switched.core_connection.client_api_origin = "https://other.invalid".into();
        let runtime = codex_catalog::parse_runtime_models(&serde_json::json!({"models":[{"id":"gpt-test"}]})).unwrap();
        let prepared = prepare_codex_agent_models(&runtime).unwrap();
        for client in [AgentClient::ClaudeCode, AgentClient::ClaudeDesktop, AgentClient::Codex,
            AgentClient::OpenCode, AgentClient::OpenClaw, AgentClient::Hermes,
            AgentClient::DeepSeekHarness, AgentClient::ZCode, AgentClient::WorkBuddy,
            AgentClient::AntigravityCli, AgentClient::CopilotCli, AgentClient::VscodeCopilot,
            AgentClient::KimiCode, AgentClient::GrokBuild, AgentClient::Omp] {
            if client == AgentClient::VscodeCopilot {
                let path = agent_config_paths(client, &home.0).remove(0).parent().unwrap().join("ezcpa-copilot/credential.json");
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, serde_json::to_vec(&serde_json::json!({"keyHash": sha256_bytes(b"remote-client-key"), "secretReference":"${input:chat.lm.secret.remote}"})).unwrap()).unwrap();
            }
            let updates = build_agent_updates(client, &home.0, agent_target(&config).unwrap(), effective_agent_api_key(&config), "gpt-test", &prepared.models, prepared.codex_catalog.as_deref()).unwrap();
            let rendered = updates.iter().map(|update| update.after.as_str()).collect::<String>();
            assert!(rendered.contains("http://100.64.0.2:8317"), "{} lacks remote origin", client.id());
            if client != AgentClient::VscodeCopilot { assert!(rendered.contains("remote-client-key"), "{} lacks client key", client.id()); }
            assert!(!rendered.contains("management-secret-never-in-client"));
            assert!(!rendered.contains("management.invalid"));
            for update in updates {
                fs::create_dir_all(update.path.parent().unwrap()).unwrap();
                fs::write(update.path, update.after).unwrap();
            }
            let paths = agent_config_paths(client, &home.0);
            assert!(inspect_agent_managed_config(client, &paths, &config, effective_agent_api_key(&config)).unwrap().0, "{} disagrees with rendered remote config", client.id());
            assert!(!inspect_agent_managed_config(client, &paths, &switched, effective_agent_api_key(&switched)).unwrap().0, "{} ignores target switch", client.id());
            assert!(!inspect_agent_managed_config(client, &paths, &config, "rotated-client-key").unwrap().0, "{} ignores key switch", client.id());
        }
        let pi = build_pi_template_updates(&home.0, &config, effective_agent_api_key(&config), "gpt-test").unwrap();
        assert!(pi.iter().any(|update| update.after.contains("http://100.64.0.2:8317")));
        assert!(pi.iter().all(|update| !update.after.contains("management-secret-never-in-client")));
    }

    #[test]
    fn remote_status_cache_uses_origin_and_client_key() {
        let config = remote("http://100.64.0.2:8317");
        let mut other = config.clone();
        other.core_connection.client_api_origin = "http://100.64.0.3:8317".into();
        let cache = AgentConfigStatusCache::default();
        cache.replace(&config, effective_agent_api_key(&config), Vec::new()).unwrap();
        assert!(cache.get(&config, effective_agent_api_key(&config)).unwrap().is_some());
        assert!(cache.get(&other, effective_agent_api_key(&other)).unwrap().is_none());
        assert!(cache.get(&config, "rotated").unwrap().is_none());
        assert!(cache.get(config.port, effective_agent_api_key(&config)).unwrap().is_none());
    }

    #[tokio::test]
    async fn remote_models_authenticate_client_origin_and_reject_redirects_and_failures() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, body) in [("200 OK", r#"{"data":[{"id":"remote-model"}]}"#), ("401 Unauthorized", "remote-client-key"), ("302 Found", "")] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let config = remote(&format!("http://{}", listener.local_addr().unwrap()));
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = vec![0; 8192];
                let size = socket.read(&mut bytes).await.unwrap();
                let request = String::from_utf8_lossy(&bytes[..size]).to_ascii_lowercase();
                assert!(request.starts_with("get /v1/models "));
                assert!(request.contains("authorization: bearer remote-client-key\r\n"));
                assert!(!request.contains("management-secret"));
                socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:1/leak\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            });
            let models = fetch_agent_models(agent_target(&config).unwrap(), effective_agent_api_key(&config)).await;
            if status.starts_with("200") { assert_eq!(models.unwrap()[0].name, "remote-model"); }
            else { assert!(!models.err().unwrap().contains("remote-client-key")); }
            server.await.unwrap();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = remote(&format!("http://{}", listener.local_addr().unwrap()));
        drop(listener);
        assert!(fetch_agent_models(&config, effective_agent_api_key(&config)).await.is_err());
    }
    #[test]
    fn remote_missing_target_statuses_preserve_inspection_cache_and_recovery() {
        let home = Home::new();
        let config = remote("http://100.64.0.2:8317");
        let client = AgentClient::ClaudeCode;
        let path = agent_config_paths(client, &home.0).remove(0);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = r#"{"theme":"dark","env":{"KEEP":"yes"}}"#;
        fs::write(&path, original).unwrap();
        let models = [AgentModelOption { name: "gpt-test".into(), alias: None, is_alias: false, context_window: Some(200_000), input_modalities: None, harness_metadata: None }];
        apply_agent_configuration_with_oauth(client, &home.0, &config, effective_agent_api_key(&config), "gpt-test", AgentConfigurationOptions {
            models: &models, codex_catalog: None, oauth_configuration: false,
            claude_code_model_mappings: None, claude_desktop_model_mappings: None,
        }).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["env"]["KEEP"], "yes");
        value["newUserField"] = serde_json::json!(42);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let settings_path = pi_provider_settings_path(&home.0);
        fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
        fs::write(&settings_path, serde_json::to_vec(&serde_json::json!({"packages": [PI_CLIPROXYAPI_PACKAGE], "theme": "dark"})).unwrap()).unwrap();
        repair_pi_provider_inner(&home.0, &config, effective_agent_api_key(&config), "gpt-test").unwrap();
        let executable = home.0.join("client-fixture"); fs::write(&executable, "fixture").unwrap();
        let overrides = ["claude-code", "claude-desktop", "codex", "opencode", "openclaw", "hermes", "deepseek-harness", "zcode", "workbuddy", "antigravity-cli", "copilot-cli", "vscode-copilot", "kimi-code", "grok-build", "omp", PI_AGENT_ID].into_iter().map(|id| (id.to_string(), path_to_string(&executable))).collect();
        let statuses = inspect_agent_config_statuses_at_home(&home.0, &config, &overrides).unwrap();
        for id in [client.id(), PI_AGENT_ID] { assert!(statuses.iter().find(|s| s.id == id).unwrap().configured, "{id}"); }
        let cache = AgentConfigStatusCache::default(); cache.replace(&config, effective_agent_api_key(&config), statuses).unwrap();
        let mut switched = config.clone();
        for (origin, key) in [("", "remote-client-key"), ("http://100.64.0.2:8317", ""), ("", "")] {
            switched.core_connection.client_api_origin = origin.into(); switched.core_connection.client_api_key = key.into(); assert!(agent_target(&switched).is_err());
            assert!(cache.get(&switched, effective_agent_api_key(&switched)).unwrap().is_none());
            let statuses = inspect_agent_config_statuses_at_home(&home.0, &switched, &overrides).unwrap(); assert_eq!(statuses.len(), 16);
            assert!(statuses.iter().all(|s| !s.configured && !s.configuration_synchronized && !s.modification_enabled));
            for id in [client.id(), PI_AGENT_ID] { let status = statuses.iter().find(|s| s.id == id).unwrap(); assert!(status.config_exists && status.config_valid && status.installed, "{id}"); assert_eq!(status.connection_state, "needs-update", "{id}"); assert!(status.current_model.is_some(), "{id}"); }
            cache.replace(&switched, effective_agent_api_key(&switched), statuses).unwrap(); assert!(cache.get(&switched, effective_agent_api_key(&switched)).unwrap().unwrap().iter().all(|s| !s.configured));
        }
        clear_agent_managed_configuration(client, &home.0, &switched).unwrap();
        let restored: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(restored["theme"], "dark");
        assert_eq!(restored["env"]["KEEP"], "yes");
        assert_eq!(restored["newUserField"], 42);
        assert!(restored["env"].get("ANTHROPIC_BASE_URL").is_none());
        assert!(!fs::read_to_string(&path).unwrap().contains("remote-client-key"));
        let statuses = inspect_agent_config_statuses_at_home(&home.0, &switched, &overrides).unwrap();
        let restored_status = statuses.iter().find(|s| s.id == client.id()).unwrap();
        assert!(restored_status.config_valid && restored_status.config_exists && !restored_status.configured);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_client_models_reject_untrusted_https() {
        let home = Home::new();
        let cert = home.0.join("cert.pem");
        let key = home.0.join("key.pem");
        assert!(Command::new("openssl").args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", key.to_str().unwrap(), "-out", cert.to_str().unwrap()]).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut server = Command::new("openssl").args(["s_server", "-quiet", "-www", "-accept", &port.to_string(), "-cert", cert.to_str().unwrap(), "-key", key.to_str().unwrap()]).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        for _ in 0..20 {
            if TcpStream::connect(("127.0.0.1", port)).is_ok() { break; }
            thread::sleep(Duration::from_millis(25));
        }
        let config = remote(&format!("https://localhost:{port}"));
        let result = fetch_agent_models(&config, effective_agent_api_key(&config)).await;
        let _ = server.kill();
        let _ = server.wait();
        assert!(result.err().unwrap().to_ascii_lowercase().contains("certificate"));
    }

}
