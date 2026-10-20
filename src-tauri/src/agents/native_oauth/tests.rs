use super::*;

struct TestHome(PathBuf);
impl TestHome {
    fn new() -> Self {
        let path = crate::unique_test_temp_path("cpa-native-oauth");
        fs::create_dir_all(path.join(".codex")).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(".codex").join(name)
    }
    fn write(&self, name: &str, content: &str) {
        fs::write(self.path(name), content).unwrap();
    }
    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.path(name)).unwrap()
    }
    fn config(&self) -> toml::Value {
        toml::from_str(&self.read("config.toml")).unwrap()
    }
}
impl Drop for TestHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const CPA_CONFIG: &str = r#"model_provider = "cpa-gui"
model = "cpa-alias"
model_catalog_json = "cpa-gui-model-catalog.json"
openai_base_url = "http://localhost:8317/v1"
chatgpt_base_url = "http://localhost:8317/chatgpt"
forced_login_method = "api"
profile = "legacy-cpa"
# keep this comment
approval_policy = "on-request"
[mcp_servers.example]
command = "example"
[model_providers.cpa-gui]
name = "EasyCLIProxyAPI"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"
experimental_bearer_token = "test-api-key"
[model_providers.openai]
base_url = "http://localhost:8317/v1"
"#;
const OAUTH: &str = r#"{"auth_mode":"chatgpt","tokens":{"access_token":"test-token","refresh_token":"test-refresh"},"last_refresh":"today","custom":"keep"}"#;

#[test]
fn openai_proxy_switch_preserves_endpoint_auth_and_history_and_restores_override() {
    let home = TestHome::new();
    home.write("config.toml", "openai_base_url = \"https://original.example/v1\"\n[model_providers.openai]\nbase_url = \"https://example.com/v1\"\n");
    home.write("auth.json", OAUTH);
    apply_cpa(&home, true).unwrap();
    let before = home.config();
    let auth = home.read("auth.json");
    fs::create_dir_all(home.path("sessions")).unwrap();
    fs::write(home.path("sessions/untouched.jsonl"), "original history").unwrap();
    switch_codex_openai_provider(&home.0, 8317, true).unwrap();
    assert!(codex_openai_proxy_enabled(&home.0).unwrap());
    assert!(!codex_native_oauth_enabled(&home.0).unwrap());
    let switched = home.config();
    assert_eq!(switched["model_providers"], before["model_providers"]);
    assert_eq!(switched["openai_base_url"], before["model_providers"]["cpa-gui"]["base_url"]);
    assert_eq!(home.read("auth.json"), auth);
    assert_eq!(home.read("sessions/untouched.jsonl"), "original history");
    assert!(inspect_codex_agent_config(&home.path("config.toml"), 8317, "test-api-key").unwrap().0);
    // Repeated enabling must not replace the saved original override.
    switch_codex_openai_provider(&home.0, 8317, true).unwrap();
    assert!(apply_cpa(&home, false).is_err());
    apply_cpa(&home, true).unwrap();
    assert!(codex_openai_proxy_enabled(&home.0).unwrap());
    assert!(current_codex_oauth_configuration(&home.0).unwrap());
    switch_codex_openai_provider(&home.0, 8317, false).unwrap();
    assert_eq!(home.config()["model_providers"]["openai"], before["model_providers"]["openai"]);
    assert_eq!(home.config()["openai_base_url"], before["openai_base_url"]);
}

#[test]
fn openai_proxy_close_and_official_round_trip_restore_correct_routing() {
    let home = TestHome::new();
    let original = "model = \"official\"\n[model_providers.openai]\nbase_url = \"https://example.com/v1\"\n";
    home.write("config.toml", original);
    home.write("auth.json", OAUTH);
    apply_cpa(&home, true).unwrap();
    switch_codex_openai_provider(&home.0, 8317, true).unwrap();
    close_codex_configuration(&home.0).unwrap();
    assert_eq!(home.config()["model_providers"]["openai"]["base_url"].as_str(), Some("https://example.com/v1"));
    apply_cpa(&home, true).unwrap();
    switch_codex_openai_provider(&home.0, 8317, true).unwrap();
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert!(!codex_openai_proxy_enabled(&home.0).unwrap());
    assert!(home.config().get("model_providers").and_then(|p| p.get("openai")).is_none());
    apply_cpa(&home, true).unwrap();
    assert!(codex_openai_proxy_enabled(&home.0).unwrap());
    close_codex_configuration(&home.0).unwrap();
    assert!(!codex_openai_proxy_enabled(&home.0).unwrap());
    assert!(home.config().get("openai_base_url").is_none());
}

#[test]
fn openai_proxy_requires_managed_configuration_and_rejects_profile_overrides() {
    let home = TestHome::new();
    home.write("config.toml", "model_provider = \"openai\"\n");
    let before = home.read("config.toml");
    assert!(switch_codex_openai_provider(&home.0, 8317, true).is_err());
    assert_eq!(home.read("config.toml"), before);
    home.write("config.toml", CPA_CONFIG);
    assert!(switch_codex_openai_provider(&home.0, 8317, true).is_err());
    assert_eq!(home.read("config.toml"), CPA_CONFIG);
}

#[tokio::test]
async fn openai_proxy_checks_the_credentials_the_builtin_provider_actually_sends() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (oauth, status) in [(false, 200), (true, 200), (true, 401)] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut bytes = [0; 1024];
                let n = stream.read(&mut bytes).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&bytes[..n]);
                if request.windows(4).any(|w| w == b"\r\n\r\n") { break; }
            }
            let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
            assert!(request.starts_with("get /v1/models "));
            assert!(request.contains(if oauth { "authorization: bearer test-token" } else { "authorization: bearer test-api-key" }));
            let response = format!("HTTP/1.1 {status} Test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let config = build_codex_agent_config_with_oauth(None, &base, "test-api-key", "model", oauth).unwrap();
        let auth = if oauth { OAUTH.to_string() } else { build_codex_api_auth("test-api-key").unwrap() };
        let result = validate_codex_openai_proxy_auth(&agent_catalog_http_client(8317).unwrap(), 8317, &config, &auth).await;
        if status == 200 { assert!(result.is_ok(), "{result:?}"); }
        else { assert_eq!(result.unwrap_err(), "CPA_CODEX_OAUTH_AUTH_UNSUPPORTED"); }
        server.await.unwrap();
    }
}

#[test]
fn native_oauth_round_trip_preserves_cpa_and_unrelated_user_edits() {
    let home = TestHome::new();
    home.write("config.toml", CPA_CONFIG);
    let api = build_codex_api_auth("test-api-key").unwrap();
    home.write("auth.json", &api);
    home.write(CODEX_MODEL_CATALOG_FILE, "existing catalog");
    let original = home.config();
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert!(codex_native_oauth_enabled(&home.0).unwrap());
    let native = home.config();
    assert_eq!(native["model_provider"].as_str(), Some("openai"));
    assert_eq!(native["forced_login_method"].as_str(), Some("chatgpt"));
    for key in [
        "model",
        "model_catalog_json",
        "openai_base_url",
        "chatgpt_base_url",
        "profile",
    ] {
        assert!(native.get(key).is_none(), "{key}");
    }
    assert!(native["model_providers"].get("openai").is_none());
    assert_eq!(
        native["model_providers"]["cpa-gui"],
        original["model_providers"]["cpa-gui"]
    );
    assert!(!home.path("auth.json").exists());
    assert!(ensure_codex_cpa_mode(&home.0).is_err());
    assert!(
        !sync_codex_model_catalog_if_configured(&home.0, 8317, "test-api-key", &[], "unused")
            .unwrap()
    );
    home.write("auth.json", OAUTH);
    home.write(
        "config.toml",
        &home.read("config.toml").replace("on-request", "never"),
    );
    switch_codex_native_oauth(&home.0, false).unwrap();
    assert!(!codex_native_oauth_enabled(&home.0).unwrap());
    let restored = home.config();
    for key in ROUTING_KEYS {
        assert_eq!(restored.get(*key), original.get(*key), "{key}");
    }
    assert_eq!(restored["model_providers"], original["model_providers"]);
    assert_eq!(restored["approval_policy"].as_str(), Some("never"));
    assert!(home.read("config.toml").contains("# keep this comment"));
    assert_eq!(home.read("auth.json"), api);
    assert_eq!(home.read(CODEX_MODEL_CATALOG_FILE), "existing catalog");
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert_eq!(home.read("auth.json"), OAUTH);
}

#[test]
fn native_oauth_retains_refreshed_tokens_and_native_model_across_switches() {
    let home = TestHome::new();
    home.write("config.toml", CPA_CONFIG);
    home.write("auth.json", OAUTH);
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert_eq!(home.read("auth.json"), OAUTH);
    let refreshed = OAUTH.replace("test-refresh", "rotated-refresh");
    home.write("auth.json", &refreshed);
    home.write(
        "config.toml",
        &("model = \"native-model\"\n".to_string() + &home.read("config.toml")),
    );
    switch_codex_native_oauth(&home.0, false).unwrap();
    assert_eq!(home.read("auth.json"), refreshed);
    assert_eq!(home.config()["model"].as_str(), Some("cpa-alias"));
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert_eq!(home.config()["model"].as_str(), Some("native-model"));
    assert_eq!(home.read("auth.json"), refreshed);
    fs::remove_file(home.path("auth.json")).unwrap();
    switch_codex_native_oauth(&home.0, false).unwrap();
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert!(
        !home.path("auth.json").exists(),
        "Never resurrect credentials after the user signs out"
    );
}

#[test]
fn native_oauth_can_be_enabled_before_first_login_and_is_idempotent() {
    let home = TestHome::new();
    assert_eq!(
        switch_codex_native_oauth(&home.0, false).unwrap().outcome,
        "unchanged"
    );
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert!(!home.path("auth.json").exists());
    let paths = [
        home.path("config.toml"),
        home.path(CODEX_NATIVE_OAUTH_STATE_FILE),
    ];
    let before = config_images(&paths).unwrap();
    assert_eq!(
        switch_codex_native_oauth(&home.0, true).unwrap().outcome,
        "unchanged"
    );
    assert_eq!(config_images(&paths).unwrap(), before);
    switch_codex_native_oauth(&home.0, false).unwrap();
    assert!(home.config().as_table().unwrap().is_empty());
}

#[test]
fn native_oauth_rejects_malformed_files_without_partial_updates() {
    for name in ["config.toml", "auth.json", CODEX_NATIVE_OAUTH_STATE_FILE] {
        let home = TestHome::new();
        home.write("config.toml", CPA_CONFIG);
        home.write("auth.json", OAUTH);
        home.write(name, "malformed [");
        let paths = [
            home.path("config.toml"),
            home.path("auth.json"),
            home.path(CODEX_NATIVE_OAUTH_STATE_FILE),
        ];
        let before = config_images(&paths).unwrap();
        assert!(switch_codex_native_oauth(&home.0, true).is_err());
        assert_eq!(config_images(&paths).unwrap(), before);
    }
}

#[test]
fn native_oauth_does_not_select_api_key_when_tokens_also_exist() {
    let auth = OAUTH.replace(
        "\"auth_mode\":\"chatgpt\"",
        "\"auth_mode\":\"apikey\",\"OPENAI_API_KEY\":\"old-key\"",
    );
    let normalized: serde_json::Value =
        serde_json::from_str(&oauth_auth(Some(&auth)).unwrap().unwrap()).unwrap();
    assert_eq!(normalized["auth_mode"], "chatgpt");
    assert!(normalized.get("OPENAI_API_KEY").is_none());
    assert_eq!(normalized["tokens"]["refresh_token"], "test-refresh");
}

#[test]
fn clearing_codex_removes_native_oauth_recovery_credentials() {
    let home = TestHome::new();
    home.write("config.toml", CPA_CONFIG);
    home.write("auth.json", OAUTH);
    switch_codex_native_oauth(&home.0, true).unwrap();
    clear_codex_config_files(&home.0).unwrap();
    assert!(!home.path(CODEX_NATIVE_OAUTH_STATE_FILE).exists());
    assert!(!home.path("auth.json").exists());
    assert!(!codex_native_oauth_enabled(&home.0).unwrap());
}

#[cfg(unix)]
#[test]
fn native_oauth_credential_cache_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let home = TestHome::new();
    home.write("config.toml", CPA_CONFIG);
    home.write("auth.json", OAUTH);
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert_eq!(
        fs::metadata(home.path(CODEX_NATIVE_OAUTH_STATE_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn native_oauth_handles_inline_provider_tables_without_losing_other_providers() {
    let home = TestHome::new();
    home.write("config.toml", "model_provider = \"cpa-gui\"\nmodel_providers = { openai = { base_url = \"http://localhost:8317/v1\" }, other = { base_url = \"http://localhost:9999\" } }\n");
    let original = home.config();
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert!(home.config()["model_providers"].get("openai").is_none());
    assert_eq!(
        home.config()["model_providers"]["other"],
        original["model_providers"]["other"]
    );
    switch_codex_native_oauth(&home.0, false).unwrap();
    assert_eq!(home.config(), original);
}

#[test]
fn restore_official_configuration_always_removes_the_cpa_catalog_setting() {
    let home = TestHome::new();
    home.write("config.toml", CPA_CONFIG);
    home.write("auth.json", OAUTH);
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert!(home.config().get("model_catalog_json").is_none());
    home.write(
        "config.toml",
        &format!(
            "model_catalog_json = \"{CODEX_MODEL_CATALOG_FILE}\"\nmodel = \"native-choice\"\n{}",
            home.read("config.toml")
        ),
    );
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert!(home.config().get("model_catalog_json").is_none());
    assert_eq!(home.config()["model"].as_str(), Some("native-choice"));
    switch_codex_native_oauth(&home.0, false).unwrap();
    assert_eq!(home.config()["model"].as_str(), Some("cpa-alias"));
}

#[test]
fn update_configuration_reconnects_cpa_and_restores_catalog_after_official_restore() {
    for oauth_configuration in [false, true] {
        let home = TestHome::new();
        home.write("config.toml", CPA_CONFIG);
        home.write("auth.json", OAUTH);
        switch_codex_native_oauth(&home.0, true).unwrap();
        let refreshed = OAUTH.replace("test-refresh", "latest-refresh");
        home.write("auth.json", &refreshed);
        let catalog = r#"{"models":[{"slug":"new-cpa-model"}]}"#;
        let result = apply_agent_configuration_with_oauth(
            AgentClient::Codex,
            &home.0,
            9321,
            "new-cpa-key",
            "new-cpa-model",
            AgentConfigurationOptions {
                models: &[],
                codex_catalog: Some(catalog),
                oauth_configuration,
                claude_code_model_mappings: None,
                claude_desktop_model_mappings: None,
            },
        )
        .unwrap();
        assert_eq!(result.outcome, "updated");
        assert!(!codex_native_oauth_enabled(&home.0).unwrap());
        let config = home.config();
        assert_eq!(config["model_provider"].as_str(), Some("cpa-gui"));
        assert_eq!(
            config["model_catalog_json"].as_str(),
            Some(CODEX_MODEL_CATALOG_FILE)
        );
        assert_eq!(config["model"].as_str(), Some("new-cpa-model"));
        assert_eq!(
            config["model_providers"]["cpa-gui"]["base_url"].as_str(),
            Some("http://127.0.0.1:9321/v1")
        );
        assert_eq!(
            config["model_providers"]["cpa-gui"]["experimental_bearer_token"].as_str(),
            Some("new-cpa-key")
        );
        assert_eq!(
            config["forced_login_method"].as_str(),
            Some(if oauth_configuration {
                "chatgpt"
            } else {
                "api"
            })
        );
        validate_codex_catalog_file(&home.path("config.toml"), "new-cpa-model").unwrap();
        if oauth_configuration {
            assert_eq!(home.read("auth.json"), refreshed);
        } else {
            assert!(codex_auth_file_has_api_key(
                &home.path("auth.json"),
                "new-cpa-key"
            ));
        }
        switch_codex_native_oauth(&home.0, true).unwrap();
        assert_eq!(home.read("auth.json"), refreshed);
        assert!(home.config().get("model_catalog_json").is_none());
    }
}

fn apply_cpa(
    home: &TestHome,
    oauth_configuration: bool,
) -> Result<AgentConfigActionResult, String> {
    apply_agent_configuration_with_oauth(
        AgentClient::Codex,
        &home.0,
        8317,
        "test-api-key",
        "cpa-alias",
        AgentConfigurationOptions {
            models: &[],
            codex_catalog: Some(r#"{"models":[{"slug":"cpa-alias"}]}"#),
            oauth_configuration,
            claude_code_model_mappings: None,
            claude_desktop_model_mappings: None,
        },
    )
}

#[test]
fn codex_apply_close_restores_original_login_and_preserves_user_edits() {
    let home = TestHome::new();
    home.write("config.toml", "model = \"official-model\"\nforced_login_method = \"chatgpt\"\napproval_policy = \"on-request\"\n[mcp_servers.example]\ncommand = \"example\"\n");
    home.write("auth.json", OAUTH);
    let original = home.config();
    apply_cpa(&home, false).unwrap();
    assert_eq!(home.config()["model_provider"].as_str(), Some("cpa-gui"));
    assert_eq!(home.config()["forced_login_method"].as_str(), Some("api"));
    assert!(codex_auth_file_has_api_key(
        &home.path("auth.json"),
        "test-api-key"
    ));
    assert!(
        validate_codex_oauth_login(&home.0).is_ok(),
        "Saved login remains selectable after API mode"
    );
    home.write(
        "config.toml",
        &format!(
            "openai_base_url = \"https://example.test/edited\"\n{}",
            home.read("config.toml").replace("on-request", "never")
        ),
    );
    let mut api: serde_json::Value = serde_json::from_str(&home.read("auth.json")).unwrap();
    api["custom"] = serde_json::json!("edited");
    home.write("auth.json", &api.to_string());
    apply_cpa(&home, true).unwrap();
    let refreshed = home
        .read("auth.json")
        .replace("test-refresh", "new-refresh");
    home.write("auth.json", &refreshed);
    apply_cpa(&home, false).unwrap();
    close_codex_configuration(&home.0).unwrap();
    let restored = home.config();
    assert_eq!(restored["model"], original["model"]);
    assert_eq!(
        restored["forced_login_method"],
        original["forced_login_method"]
    );
    assert_eq!(restored["approval_policy"].as_str(), Some("never"));
    assert_eq!(restored["mcp_servers"], original["mcp_servers"]);
    assert_eq!(
        restored["openai_base_url"].as_str(),
        Some("https://example.test/edited")
    );
    assert!(restored.get("model_catalog_json").is_none());
    assert_eq!(
        restored["model_providers"][MANAGED_AGENT_PROVIDER_ID]["base_url"].as_str(),
        Some("http://127.0.0.1:8317/v1")
    );
    let auth: serde_json::Value = serde_json::from_str(&home.read("auth.json")).unwrap();
    assert_eq!(auth["tokens"]["refresh_token"], "new-refresh");
    assert_eq!(auth["custom"], "edited");
    assert!(auth.get("OPENAI_API_KEY").is_none());
    assert_eq!(
        close_codex_configuration(&home.0).unwrap().outcome,
        "unchanged"
    );
    apply_cpa(&home, false).unwrap();
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert!(
        home.read("auth.json").contains("new-refresh"),
        "Official restore also uses the saved login"
    );
}

#[test]
fn codex_close_existing_cpa_without_recovery_record_removes_managed_fields() {
    let home = TestHome::new();
    home.write(
        "config.toml",
        &build_codex_agent_config_with_oauth(
            Some("approval_policy = \"never\"\n"),
            "http://127.0.0.1:8317/v1",
            "test-api-key",
            "cpa-alias",
            false,
        )
        .unwrap(),
    );
    home.write("auth.json", &build_codex_api_auth("test-api-key").unwrap());
    close_codex_configuration(&home.0).unwrap();
    assert_eq!(home.config()["approval_policy"].as_str(), Some("never"));
    assert!(home.config().get("model_provider").is_none());
    assert!(home.config().get("model_catalog_json").is_none());
    assert_eq!(
        home.config()["model_providers"][MANAGED_AGENT_PROVIDER_ID]["base_url"].as_str(),
        Some("http://127.0.0.1:8317/v1")
    );
    assert!(!home.path("auth.json").exists());
}

#[test]
fn codex_close_restores_preexisting_api_provider_and_key() {
    let home = TestHome::new();
    home.write("config.toml", "model_provider = \"other\"\nmodel = \"other-model\"\n[model_providers.other]\nbase_url = \"https://example.test/v1\"\n");
    home.write("auth.json", &build_codex_api_auth("original-key").unwrap());
    let original = home.config();
    apply_cpa(&home, false).unwrap();
    close_codex_configuration(&home.0).unwrap();
    let restored = home.config();
    assert_eq!(restored["model_provider"], original["model_provider"]);
    assert_eq!(restored["model"], original["model"]);
    assert_eq!(
        restored["model_providers"]["other"],
        original["model_providers"]["other"]
    );
    assert_eq!(
        restored["model_providers"][MANAGED_AGENT_PROVIDER_ID]["base_url"].as_str(),
        Some("http://127.0.0.1:8317/v1")
    );
    assert!(codex_auth_file_has_api_key(
        &home.path("auth.json"),
        "original-key"
    ));
}

#[test]
fn codex_close_does_not_resurrect_an_explicit_logout() {
    let home = TestHome::new();
    home.write("auth.json", OAUTH);
    apply_cpa(&home, true).unwrap();
    fs::remove_file(home.path("auth.json")).unwrap();
    assert!(validate_codex_oauth_login(&home.0).is_err());
    apply_cpa(&home, false).unwrap();
    assert!(validate_codex_oauth_login(&home.0).is_err());
    close_codex_configuration(&home.0).unwrap();
    assert!(!home.path("auth.json").exists());
}

#[test]
fn codex_official_restore_does_not_reuse_credentials_after_logout() {
    let home = TestHome::new();
    home.write("auth.json", OAUTH);
    apply_cpa(&home, true).unwrap();
    fs::remove_file(home.path("auth.json")).unwrap();
    switch_codex_native_oauth(&home.0, true).unwrap();
    assert!(!home.path("auth.json").exists());
}

#[test]
fn codex_close_after_official_reconnect_restores_official_routing() {
    let home = TestHome::new();
    home.write("config.toml", CPA_CONFIG);
    home.write("auth.json", OAUTH);
    switch_codex_native_oauth(&home.0, true).unwrap();
    apply_cpa(&home, false).unwrap();
    close_codex_configuration(&home.0).unwrap();
    assert_eq!(home.config()["model_provider"].as_str(), Some("openai"));
    assert_eq!(
        home.config()["forced_login_method"].as_str(),
        Some("chatgpt")
    );
    for key in [
        "model_catalog_json",
        "openai_base_url",
        "chatgpt_base_url",
        "profile",
    ] {
        assert!(home.config().get(key).is_none(), "{key}");
    }
    assert_eq!(home.read("auth.json"), OAUTH);
    assert!(!codex_native_oauth_enabled(&home.0).unwrap());
}

#[test]
fn codex_close_rejects_invalid_state_without_changing_any_files() {
    for name in ["config.toml", "auth.json", CODEX_NATIVE_OAUTH_STATE_FILE] {
        let home = TestHome::new();
        home.write("auth.json", OAUTH);
        apply_cpa(&home, false).unwrap();
        home.write(name, "invalid [");
        let paths = vec![
            home.path("config.toml"),
            home.path("auth.json"),
            home.path(CODEX_NATIVE_OAUTH_STATE_FILE),
        ];
        let before = config_images(&paths).unwrap();
        assert!(close_codex_configuration(&home.0).is_err());
        assert_eq!(config_images(&paths).unwrap(), before);
    }
}

#[test]
fn codex_failed_api_apply_preserves_login_and_recovery_record() {
    let home = TestHome::new();
    home.write("config.toml", "model = \"official-model\"\n");
    home.write("auth.json", OAUTH);
    home.write(CODEX_MODEL_CATALOG_FILE, "malformed catalog");
    let paths = vec![
        home.path("config.toml"),
        home.path("auth.json"),
        home.path(CODEX_MODEL_CATALOG_FILE),
        home.path(CODEX_NATIVE_OAUTH_STATE_FILE),
    ];
    let before = config_images(&paths).unwrap();
    assert!(apply_cpa(&home, false).is_err());
    assert_eq!(config_images(&paths).unwrap(), before);
}

#[test]
fn failed_cpa_update_preserves_official_routing_and_login() {
    let home = TestHome::new();
    home.write("config.toml", CPA_CONFIG);
    home.write("auth.json", OAUTH);
    switch_codex_native_oauth(&home.0, true).unwrap();
    let mut paths = config_paths("codex", &home.0).unwrap();
    paths.push(home.path(CODEX_NATIVE_OAUTH_STATE_FILE));
    let before = config_images(&paths).unwrap();
    let result = apply_agent_configuration_with_oauth(
        AgentClient::Codex,
        &home.0,
        8317,
        "test-api-key",
        "unavailable-model",
        AgentConfigurationOptions {
            models: &[],
            codex_catalog: Some(r#"{"models":[{"slug":"other-model"}]}"#),
            oauth_configuration: false,
            claude_code_model_mappings: None,
            claude_desktop_model_mappings: None,
        },
    );
    assert!(result.is_err());
    assert_eq!(config_images(&paths).unwrap(), before);
    assert!(codex_native_oauth_enabled(&home.0).unwrap());
    assert!(home.config().get("model_catalog_json").is_none());
}


#[test]
fn remote_compaction_defaults_off_preserves_settings_and_survives_apply() {
    let home = TestHome::new();
    apply_cpa(&home, false).unwrap();
    assert!(!codex_remote_compaction_enabled(&home.0).unwrap());
    let before = home.config();
    let auth = home.read("auth.json");
    switch_codex_remote_compaction(&home.0, 8317, true).unwrap();
    assert!(codex_remote_compaction_enabled(&home.0).unwrap());
    let mut expected = before.clone();
    expected["model_providers"]["cpa-gui"]["name"] = toml::Value::String("OpenAI".into());
    assert_eq!(home.config(), expected);
    assert_eq!(home.read("auth.json"), auth);
    assert!(inspect_codex_agent_config(&home.path("config.toml"), 8317, "test-api-key").unwrap().0);
    apply_cpa(&home, false).unwrap();
    assert!(codex_remote_compaction_enabled(&home.0).unwrap());
    switch_codex_openai_provider(&home.0, 8317, true).unwrap();
    assert!(codex_openai_proxy_enabled(&home.0).unwrap());
    assert!(inspect_codex_agent_config(&home.path("config.toml"), 8317, "test-api-key").unwrap().0);
    assert!(switch_codex_remote_compaction(&home.0, 8317, false).is_err());
    switch_codex_openai_provider(&home.0, 8317, false).unwrap();
    switch_codex_remote_compaction(&home.0, 8317, false).unwrap();
    assert!(!codex_remote_compaction_enabled(&home.0).unwrap());
    assert_eq!(home.config(), before);
}

#[test]
fn remote_compaction_rejects_unmanaged_invalid_and_profile_configs_without_writing() {
    let home = TestHome::new();
    for config in ["", "invalid = [", "model_provider = \"openai\"", CPA_CONFIG] {
        home.write("config.toml", config);
        assert!(switch_codex_remote_compaction(&home.0, 8317, true).is_err());
        assert_eq!(home.read("config.toml"), config);
    }
}

fn remote_config(origin: &str) -> GuiConfigFile {
    GuiConfigFile {
        connection_mode: CoreConnectionMode::Remote,
        remote_management_origin: origin.into(),
        remote_management_key: "test-management-key".into(),
        remote_client_origin: origin.into(),
        remote_client_key: "test-api-key".into(),
        ..GuiConfigFile::default()
    }
}

fn apply_remote_cpa(home: &TestHome, config: &GuiConfigFile) {
    apply_agent_configuration_with_oauth(
        AgentClient::Codex, &home.0, config, "test-api-key", "cpa-alias",
        AgentConfigurationOptions {
            models: &[], codex_catalog: Some(r#"{"models":[{"slug":"cpa-alias"}]}"#),
            oauth_configuration: false, claude_code_model_mappings: None, claude_desktop_model_mappings: None,
        },
    ).unwrap();
}

#[test]
fn remote_client_origin_is_managed_only_for_the_remote_target() {
    let remote = remote_config("https://client.example:8443");
    for url in ["https://client.example:8443", "HTTPS://Client.Example:8443/v1/", " https://client.example:8443/v1"] {
        assert!(is_managed_agent_target_url(url, &remote), "{url}");
    }
    for url in ["https://client.example:84431/v1", "https://client.example:8443.evil.test/v1", "https://other.example/v1", "http://127.0.0.1:8317/v1"] {
        assert!(!is_managed_agent_target_url(url, &remote), "{url}");
    }
    assert!(is_managed_agent_target_url("http://127.0.0.1:8317/v1", 8317));
    assert!(!is_managed_agent_target_url("https://client.example:8443/v1", 8317));
}

#[test]
fn remote_provider_identity_and_compaction_switch_against_the_remote_origin() {
    let home = TestHome::new();
    let remote = remote_config("https://client.example");
    apply_remote_cpa(&home, &remote);
    assert_eq!(home.config()["model_providers"]["cpa-gui"]["base_url"].as_str(), Some("https://client.example/v1"));
    let before = home.config();
    switch_codex_openai_provider(&home.0, &remote, true).unwrap();
    assert!(codex_openai_proxy_enabled(&home.0).unwrap());
    assert_eq!(home.config()["openai_base_url"].as_str(), Some("https://client.example/v1"));
    switch_codex_openai_provider(&home.0, &remote, false).unwrap();
    switch_codex_remote_compaction(&home.0, &remote, true).unwrap();
    assert!(codex_remote_compaction_enabled(&home.0).unwrap());
    switch_codex_remote_compaction(&home.0, &remote, false).unwrap();
    assert_eq!(home.config(), before);
}

#[test]
fn remote_switches_reject_a_configuration_written_for_another_target_without_writing() {
    let home = TestHome::new();
    apply_cpa(&home, false).unwrap();
    let written = home.read("config.toml");
    let remote = remote_config("https://client.example");
    assert_eq!(switch_codex_openai_provider(&home.0, &remote, true).unwrap_err(),
        "Apply the CPA configuration before changing the provider identity");
    assert_eq!(switch_codex_remote_compaction(&home.0, &remote, true).unwrap_err(),
        "Apply the CPA configuration before changing remote compaction");
    assert_eq!(home.read("config.toml"), written);
    // And the reverse: a Remote configuration is not a valid Local one.
    let other = TestHome::new();
    apply_remote_cpa(&other, &remote);
    assert!(switch_codex_openai_provider(&other.0, 8317, true).is_err());
    assert!(switch_codex_remote_compaction(&other.0, 8317, true).is_err());
}

#[tokio::test]
async fn remote_openai_proxy_auth_check_uses_the_remote_origin_and_rejects_other_targets() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let remote = remote_config(&origin);
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 2048];
        let n = stream.read(&mut request).await.unwrap();
        let request = String::from_utf8_lossy(&request[..n]).to_ascii_lowercase();
        assert!(request.starts_with("get /v1/models "));
        assert!(request.contains("authorization: bearer test-api-key"));
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
    });
    let config = build_codex_agent_config_with_oauth(None, &format!("{origin}/v1"), "test-api-key", "model", false).unwrap();
    let auth = build_codex_api_auth("test-api-key").unwrap();
    let client = agent_catalog_http_client(&remote).unwrap();
    validate_codex_openai_proxy_auth(&client, &remote, &config, &auth).await.unwrap();
    server.await.unwrap();
    // Not the configured Remote origin: refused before any request is made.
    let other = remote_config("https://client.example");
    assert_eq!(validate_codex_openai_proxy_auth(&agent_catalog_http_client(&other).unwrap(), &other, &config, &auth).await.unwrap_err(),
        "Apply the CPA configuration before changing the provider identity");
    // An invalid Remote origin is rejected by the shared client before connecting.
    assert!(agent_catalog_http_client(&remote_config("")).is_err());
}

// Kills the disposable Python server even when an assertion panics.
struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

// A Local target whose client origin is the self-signed TLS endpoint under test.
#[derive(Clone, Copy)]
struct TlsLocalTarget(u16);
impl AgentClientOrigin for TlsLocalTarget {
    fn client_origin(self) -> String { format!("https://127.0.0.1:{}", self.0) }
    fn validate_client_origin(self) -> Result<(), String> { Ok(()) }
    fn local_client(self) -> bool { true }
}

// Disposable self-signed TLS endpoint standing in for a Local core with TLS enabled.
#[tokio::test]
async fn openai_proxy_auth_check_trusts_a_self_signed_certificate_only_for_the_client_origin() {
    let root = crate::unique_test_temp_path("cpa-native-oauth-tls");
    fs::create_dir_all(&root).unwrap();
    let (cert, key) = (root.join("cert.pem"), root.join("key.pem"));
    assert!(std::process::Command::new("openssl").args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout"])
        .arg(&key).arg("-out").arg(&cert).output().unwrap().status.success());
    let script = r#"
import http.server, ssl, sys
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200); self.send_header('Content-Length', '2'); self.end_headers(); self.wfile.write(b'{}')
 def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(sys.argv[1], sys.argv[2])
server.socket = ctx.wrap_socket(server.socket, server_side=True)
print(server.server_port, flush=True)
server.serve_forever()
"#;
    let mut server = ChildGuard(std::process::Command::new("python3").arg("-u").arg("-c").arg(script).arg(&cert).arg(&key)
        .stdout(std::process::Stdio::piped()).spawn().unwrap());
    use std::io::BufRead;
    let mut port = String::new();
    std::io::BufReader::new(server.0.stdout.take().unwrap()).read_line(&mut port).unwrap();
    let port: u16 = port.trim().parse().unwrap();
    let base = format!("https://127.0.0.1:{port}/v1");
    let config = build_codex_agent_config_with_oauth(None, &base, "test-api-key", "model", false).unwrap();
    let auth = build_codex_api_auth("test-api-key").unwrap();
    let unreachable = "Unable to check CPA authentication. Ensure the core is running";
    let own = TlsLocalTarget(port);
    // The endpoint is the target's own origin: the relaxed client is used.
    validate_codex_openai_proxy_auth(&agent_catalog_http_client_with_tls(own, true).unwrap(), own, &config, &auth).await.unwrap();
    // Local TLS off: strict client rejects the self-signed certificate.
    assert_eq!(validate_codex_openai_proxy_auth(&agent_catalog_http_client_with_tls(own, false).unwrap(), own, &config, &auth).await.unwrap_err(), unreachable);
    // Another localhost endpoint is accepted by the Local matcher, but the relaxed client must not reach it.
    assert!(is_managed_agent_target_url(&base, 8317u16));
    assert_eq!(validate_codex_openai_proxy_auth(&agent_catalog_http_client_with_tls(8317u16, true).unwrap(), 8317u16, &config, &auth).await.unwrap_err(), unreachable);
    // A Remote target never trusts a self-signed certificate, even with the relaxed flag.
    let remote = remote_config(&format!("https://127.0.0.1:{port}"));
    assert_eq!(validate_codex_openai_proxy_auth(&agent_catalog_http_client_with_tls(&remote, true).unwrap(), &remote, &config, &auth).await.unwrap_err(), unreachable);
    drop(server);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_empty_or_invalid_remote_origin_never_matches_and_blocks_the_switches() {
    let mut empty = remote_config("https://management.example");
    empty.remote_client_origin.clear();
    for url in ["", "/v1", "http://127.0.0.1:8317/v1"] {
        assert!(!is_managed_agent_target_url(url, &empty), "{url:?}");
    }
    let home = TestHome::new();
    apply_cpa(&home, false).unwrap();
    let written = home.read("config.toml");
    assert_eq!(switch_codex_openai_provider(&home.0, &empty, true).unwrap_err(), "Invalid Client origin");
    assert_eq!(switch_codex_remote_compaction(&home.0, &empty, true).unwrap_err(), "Invalid Client origin");
    assert_eq!(switch_codex_openai_provider(&home.0, 0u16, true).unwrap_err(), "Invalid core port");
    assert_eq!(switch_codex_remote_compaction(&home.0, 0u16, true).unwrap_err(), "Invalid core port");
    assert_eq!(home.read("config.toml"), written);
}
