use super::*;

pub(crate) fn codex_configuration_directory(home: &Path) -> PathBuf {
    agent_configuration_environment("CODEX_HOME").unwrap_or_else(|| home.join(".codex"))
}

pub(crate) fn current_codex_oauth_configuration(home: &Path) -> Result<bool, String> {
    let path = codex_configuration_directory(home).join("config.toml");
    if !path.is_file() {
        return Ok(false);
    }
    let root: toml::Value = toml::from_str(
        &fs::read_to_string(&path).map_err(|error| format!("Failed to read Codex configuration: {error}"))?,
    )
    .map_err(|_| "Failed to parse Codex configuration".to_string())?;
    Ok(root
        .get("model_providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
        .and_then(toml::Value::as_table)
        .and_then(|provider| provider.get("requires_openai_auth"))
        .and_then(toml::Value::as_bool)
        == Some(true))
}

pub(crate) fn codex_auth_file_has_oauth_tokens(path: &Path) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    root.get("tokens")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|tokens| {
            tokens
                .values()
                .any(|value| value.as_str().is_some_and(|token| !token.trim().is_empty()))
        })
}

pub(crate) fn codex_auth_file_has_api_key(path: &Path, api_key: &str) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    let api_key_matches = root
        .get("OPENAI_API_KEY")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value == api_key);
    let mode_matches = root
        .get("auth_mode")
        .is_none_or(|value| value.as_str() == Some("apikey"));
    api_key_matches && mode_matches
}

pub(crate) fn validate_codex_oauth_login(home: &Path) -> Result<(), String> {
    if validate_codex_oauth_login_at(&codex_configuration_directory(home).join("auth.json")).is_ok()
    {
        return Ok(());
    }
    available_codex_oauth_auth(home).map(|_| ())
}

pub(crate) fn validate_codex_oauth_login_at(auth_path: &Path) -> Result<(), String> {
    if codex_auth_file_has_oauth_tokens(auth_path) {
        Ok(())
    } else {
        Err(CODEX_OAUTH_LOGIN_REQUIRED_ERROR.to_string())
    }
}

pub(crate) fn clear_codex_config_files(home: &Path) -> Result<Vec<String>, String> {
    let mut paths = config_paths("codex", home)?;
    paths.push(codex_configuration_directory(home).join(CODEX_NATIVE_OAUTH_STATE_FILE));
    let before = config_images(&paths)?;
    let mut after = before.clone();
    for (path, bytes) in &mut after {
        if path.file_name().and_then(|v| v.to_str()).is_some_and(|v| {
            v == "auth.json" || v == "config.toml" || v == CODEX_NATIVE_OAUTH_STATE_FILE
        }) {
            *bytes = None;
        }
    }
    Ok(commit_config("codex", &paths, &before, &after, "clear", None)?.changed_files)
}

pub(crate) fn codex_model_catalog_path(home: &Path) -> PathBuf {
    codex_configuration_directory(home).join(CODEX_MODEL_CATALOG_FILE)
}
