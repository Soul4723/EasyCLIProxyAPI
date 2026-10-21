use super::*;

pub(crate) fn read_agent_json_or_empty(
    path: &Path,
    label: &str,
) -> Result<serde_json::Value, String> {
    if !path.is_file() {
        return Ok(serde_json::json!({}));
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("Failed to read {label}: {error}"))?;
    if content.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|_| format!("Failed to parse {label}"))?;
    if !value.is_object() {
        return Err(format!("{label} root must be an object"));
    }
    Ok(value)
}

pub(crate) fn read_agent_json5_or_empty(
    path: &Path,
    label: &str,
) -> Result<serde_json::Value, String> {
    if !path.is_file() {
        return Ok(serde_json::json!({}));
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("Failed to read {label}: {error}"))?;
    if content.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    let value: serde_json::Value =
        json5::from_str(&content).map_err(|_| format!("Failed to parse {label}"))?;
    if !value.is_object() {
        return Err(format!("{label} root must be an object"));
    }
    Ok(value)
}

pub(crate) fn codex_managed_provider_id(root: &toml::Value) -> &'static str {
    if root.get("model_provider").and_then(toml::Value::as_str) == Some("openai")
        && root.get("model_providers").and_then(|p| p.get(MANAGED_AGENT_PROVIDER_ID))
            .is_some_and(|p| p.get("name").and_then(toml::Value::as_str).is_some_and(is_codex_managed_provider_name)
                && root.get("openai_base_url").and_then(toml::Value::as_str)
                    .is_some_and(|base| p.get("base_url").and_then(toml::Value::as_str) == Some(base))) {
        "openai"
    } else {
        MANAGED_AGENT_PROVIDER_ID
    }
}

pub(crate) fn inspect_codex_agent_config(
    path: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
) -> Result<(bool, Option<String>, bool), String> {
    if !path.is_file() {
        return Ok((false, None, false));
    }
    let root: toml::Value = toml::from_str(
        &fs::read_to_string(path).map_err(|error| format!("Failed to read Codex configuration: {error}"))?,
    )
    .map_err(|_| "Failed to parse Codex configuration".to_string())?;
    let expected_base = format!("{}/v1", port.client_origin());
    let provider_id = codex_managed_provider_id(&root);
    let provider = root
        .get("model_providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
        .and_then(toml::Value::as_table);
    let uses_api_key = provider
        .and_then(|provider| provider.get("experimental_bearer_token"))
        .and_then(toml::Value::as_str)
        == Some(api_key);
    let oauth_configuration = provider
        .and_then(|provider| provider.get("requires_openai_auth"))
        .and_then(toml::Value::as_bool)
        == Some(true);
    let auth_path = path.with_file_name("auth.json");
    let auth_configured = if oauth_configuration {
        codex_auth_file_has_oauth_tokens(&auth_path)
    } else {
        codex_auth_file_has_api_key(&auth_path, api_key)
    };
    let configured_without_auth = root.get("model_provider").and_then(toml::Value::as_str)
        == Some(provider_id)
        && root.get("model_catalog_json").and_then(toml::Value::as_str)
            == Some(CODEX_MODEL_CATALOG_FILE)
        && provider
            .and_then(|provider| provider.get("name"))
            .and_then(toml::Value::as_str)
            .is_some_and(is_codex_managed_provider_name)
        && provider
            .and_then(|provider| provider.get("base_url"))
            .and_then(toml::Value::as_str)
            == Some(expected_base.as_str())
        && uses_api_key
        && provider
            .and_then(|provider| provider.get("wire_api"))
            .and_then(toml::Value::as_str)
            == Some("responses");
    let configured = configured_without_auth && auth_configured;
    let model = root
        .get("model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok((configured, model, oauth_configuration))
}

pub(crate) fn validate_codex_catalog_file(config_path: &Path, model: &str) -> Result<(), String> {
    let catalog_path = config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(CODEX_MODEL_CATALOG_FILE);
    let catalog = fs::read_to_string(&catalog_path).map_err(|error| {
        format!(
            "Failed to read Codex model catalog {}: {error}",
            path_to_string(&catalog_path)
        )
    })?;
    validate_codex_catalog(&catalog, model)
}

pub(crate) fn inspect_opencode_agent_config(
    path: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root = read_agent_json5_or_empty(path, "OpenCode configuration")?;
    let provider = root
        .get("provider")
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID));
    let expected_base = format!("{}/v1", port.client_origin());
    let configured = provider
        .and_then(|provider| provider.get("options"))
        .and_then(|options| options.get("baseURL"))
        .and_then(serde_json::Value::as_str)
        == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("options"))
            .and_then(|options| options.get("apiKey"))
            .and_then(serde_json::Value::as_str)
            == Some(api_key);
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let model = root
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.strip_prefix(&prefix).unwrap_or(value))
        .map(str::to_string);
    Ok((configured, model))
}

pub(crate) fn inspect_zcode_agent_config(
    path: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(path).map_err(|error| format!("Failed to read ZCode provider configuration: {error}"))?,
    )
    .map_err(|_| "Failed to parse ZCode provider configuration".to_string())?;
    if root.get("schemaVersion").and_then(serde_json::Value::as_u64) != Some(1) {
        return Ok((false, None));
    }
    let config = root.get("config");
    let provider = config
        .and_then(|config| config.get("providerConfigRules"))
        .and_then(|rules| rules.get("providerRules"))
        .and_then(serde_json::Value::as_array)
        .and_then(|rules| rules.iter().find(|rule| {
            rule.get("providerId").and_then(serde_json::Value::as_str)
                == Some(MANAGED_AGENT_PROVIDER_ID)
        }));
    let selected = config
        .and_then(|config| config.get("defaultModelSelection"));
    let model = selected
        .filter(|selection| {
            selection.get("providerId").and_then(serde_json::Value::as_str)
                == Some(MANAGED_AGENT_PROVIDER_ID)
        })
        .and_then(|selection| selection.get("modelId"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let expected_origin = port.client_origin();
    let expected_base = format!("{expected_origin}/v1");
    let provider_base = provider
        .and_then(|provider| provider.pointer("/config/api/baseUrl"))
        .and_then(serde_json::Value::as_str);
    let configured = model.as_deref().is_some_and(|model| {
        provider
            .and_then(|provider| provider.get("config"))
            .and_then(|config| config.get("personalModelIds"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|models| models.iter().any(|value| value.as_str() == Some(model)))
    }) && provider
        .and_then(|provider| provider.get("enabled"))
        .and_then(serde_json::Value::as_bool) == Some(true)
        && provider
            .and_then(|provider| provider.get("config"))
            .and_then(|config| config.get("group"))
            .and_then(serde_json::Value::as_str) == Some("standard-personal")
        && provider
            .and_then(|provider| provider.pointer("/config/access/type"))
            .and_then(serde_json::Value::as_str) == Some("api-key")
        && provider
            .and_then(|provider| provider.pointer("/config/access/apiKey"))
            .and_then(serde_json::Value::as_str) == Some(api_key)
        && provider
            .and_then(|provider| provider.pointer("/config/api/type"))
            .and_then(serde_json::Value::as_str) == Some("anthropic-messages")
        && provider_base.is_some_and(|base| {
            // Older CPA configurations used the origin. ZCode also normalizes
            // that form to /v1 before making Anthropic Messages requests.
            let base = base.trim_end_matches('/');
            base == expected_base || base == expected_origin
        });
    Ok((configured, model))
}


pub(crate) fn omp_provider_mapping(root: &serde_norway::Mapping) -> Option<&serde_norway::Mapping> {
    yaml_mapping_value(root, "providers")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|providers| yaml_mapping_value(providers, OMP_AGENT_PROVIDER_ID))
        .and_then(serde_norway::Value::as_mapping)
}

pub(crate) fn omp_selected_model(root: &serde_norway::Mapping) -> Option<String> {
    let selector = yaml_mapping_value(root, "modelRoles")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|roles| yaml_mapping_value(roles, "default"))
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let prefix = format!("{OMP_AGENT_PROVIDER_ID}/");
    selector.strip_prefix(&prefix).map(str::to_string)
}

pub(crate) fn inspect_omp_agent_config(
    paths: &[PathBuf],
    port: impl AgentClientOrigin,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if paths.len() != 2 || !paths[0].is_file() || !paths[1].is_file() {
        return Ok((false, None));
    }
    let models = read_agent_yaml_mapping_or_empty(&paths[0], "Oh My Pi models.yml")?;
    let settings = read_agent_yaml_mapping_or_empty(&paths[1], "Oh My Pi config.yml")?;
    let provider = omp_provider_mapping(&models);
    let model = omp_selected_model(&settings);
    let expected = format!("{}/v1", port.client_origin());
    let configured = provider
        .and_then(|provider| yaml_mapping_value(provider, "baseUrl"))
        .and_then(serde_norway::Value::as_str)
        == Some(expected.as_str())
        && provider
            .and_then(|provider| yaml_mapping_value(provider, "apiKey"))
            .and_then(serde_norway::Value::as_str)
            == Some(api_key)
        && provider
            .and_then(|provider| yaml_mapping_value(provider, "api"))
            .and_then(serde_norway::Value::as_str)
            .is_some_and(|api| api == OMP_AGENT_API || api == "openai-completions")
        && provider
            .and_then(|provider| yaml_mapping_value(provider, "discovery"))
            .and_then(serde_norway::Value::as_mapping)
            .and_then(|discovery| yaml_mapping_value(discovery, "type"))
            .and_then(serde_norway::Value::as_str)
            == Some("openai-models-list")
        && model.is_some();
    Ok((configured, model))
}

pub(crate) fn omp_has_managed_marker(paths: &[PathBuf]) -> Result<bool, String> {
    if paths.first().is_none_or(|path| !path.is_file()) {
        return Ok(false);
    }
    let models = read_agent_yaml_mapping_or_empty(&paths[0], "Oh My Pi models.yml")?;
    Ok(omp_provider_mapping(&models).is_some())
}

pub(crate) fn find_omp_executable(home: &Path) -> Option<PathBuf> {
    let bun = home.join(".bun/bin");
    #[cfg(target_os = "windows")]
    let managed = [bun.join("omp.exe"), bun.join("omp.cmd")];
    #[cfg(not(target_os = "windows"))]
    let managed = [bun.join("omp")];
    managed
        .into_iter()
        .find(|path| agent_cli_executable(path))
        .or_else(|| find_named_agent_executable(home, &["omp"]))
}

pub(crate) fn inspect_kimi_code_agent_config(
    path: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: toml::Value = toml::from_str(
        &fs::read_to_string(path).map_err(|error| format!("Failed to read Kimi Code configuration: {error}"))?,
    )
    .map_err(|_| "Failed to parse Kimi Code configuration".to_string())?;
    let expected_base = format!("{}/v1", port.client_origin());
    let provider = root
        .get("providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
        .and_then(toml::Value::as_table);
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let selected = root
        .get("default_model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| value.starts_with(&prefix));
    let model_entry = selected.and_then(|alias| {
        root.get("models")
            .and_then(toml::Value::as_table)
            .and_then(|models| models.get(alias))
            .and_then(toml::Value::as_table)
    });
    let model = model_entry
        .and_then(|entry| entry.get("model"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let configured = selected.is_some()
        && model.is_some()
        && provider
            .and_then(|provider| provider.get("type"))
            .and_then(toml::Value::as_str)
            == Some("openai")
        && provider
            .and_then(|provider| provider.get("base_url"))
            .and_then(toml::Value::as_str)
            == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("api_key"))
            .and_then(toml::Value::as_str)
            == Some(api_key)
        && model_entry
            .and_then(|entry| entry.get("provider"))
            .and_then(toml::Value::as_str)
            == Some(MANAGED_AGENT_PROVIDER_ID);
    Ok((configured, model))
}

pub(crate) fn inspect_grok_build_agent_config(
    path: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: toml::Value = toml::from_str(
        &fs::read_to_string(path).map_err(|error| format!("Failed to read Grok Build configuration: {error}"))?,
    )
    .map_err(|_| "Failed to parse Grok Build configuration".to_string())?;
    let expected_base = format!("{}/v1", port.client_origin());
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let selected = root
        .get("models")
        .and_then(toml::Value::as_table)
        .and_then(|models| models.get("default"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| value.starts_with(&prefix));
    let model_entry = selected.and_then(|alias| {
        root.get("model")
            .and_then(toml::Value::as_table)
            .and_then(|models| models.get(alias))
            .and_then(toml::Value::as_table)
    });
    let model = model_entry
        .and_then(|entry| entry.get("model"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let configured = selected.is_some()
        && model.is_some()
        && model_entry
            .and_then(|entry| entry.get("base_url"))
            .and_then(toml::Value::as_str)
            == Some(expected_base.as_str())
        && model_entry
            .and_then(|entry| entry.get("api_key"))
            .and_then(toml::Value::as_str)
            == Some(api_key)
        && model_entry
            .and_then(|entry| entry.get("api_backend"))
            .and_then(toml::Value::as_str)
            == Some("chat_completions");
    Ok((configured, model))
}

pub(crate) fn inspect_openclaw_agent_config(
    path: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let content =
        fs::read_to_string(path).map_err(|error| format!("Failed to read OpenClaw configuration: {error}"))?;
    let root: serde_json::Value = json5::from_str(&content)
        .map_err(|_| "Failed to parse OpenClaw JSON5 configuration".to_string())?;
    let provider = root
        .get("models")
        .and_then(|models| models.get("providers"))
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID));
    let expected_base = format!("{}/v1", port.client_origin());
    let configured = provider
        .and_then(|provider| provider.get("baseUrl"))
        .and_then(serde_json::Value::as_str)
        == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("apiKey"))
            .and_then(serde_json::Value::as_str)
            == Some(api_key);
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let model = root
        .get("agents")
        .and_then(|agents| agents.get("defaults"))
        .and_then(|defaults| defaults.get("model"))
        .and_then(|model| model.get("primary"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.strip_prefix(&prefix).unwrap_or(value))
        .map(str::to_string);
    Ok((configured, model))
}

pub(crate) fn inspect_hermes_agent_config(
    path: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: serde_yaml::Value = serde_yaml::from_str(
        &fs::read_to_string(path).map_err(|error| format!("Failed to read Hermes configuration: {error}"))?,
    )
    .map_err(|_| "Failed to parse Hermes YAML configuration".to_string())?;
    let provider = hermes_managed_provider(&root);
    let expected_base = format!("{}/v1", port.client_origin());
    let configured = provider
        .and_then(|provider| provider.get("base_url").or_else(|| provider.get("baseUrl")))
        .and_then(serde_yaml::Value::as_str)
        == Some(expected_base.as_str())
        && provider
            .and_then(|provider| provider.get("api_key").or_else(|| provider.get("apiKey")))
            .and_then(serde_yaml::Value::as_str)
            == Some(api_key)
        && root
            .get("model")
            .and_then(|model| model.get("provider"))
            .and_then(serde_yaml::Value::as_str)
            == Some(MANAGED_AGENT_PROVIDER_ID);
    let model = root
        .get("model")
        .and_then(|model| model.get("default"))
        .and_then(serde_yaml::Value::as_str)
        .or_else(|| provider.and_then(|provider| provider.get("model")?.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok((configured, model))
}

pub(crate) fn inspect_deepseek_harness_config(
    paths: &[PathBuf],
    port: impl AgentClientOrigin,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if paths.len() != 2 {
        return Err("Invalid number of DeepSeek Harness configuration paths".to_string());
    }
    let settings = read_agent_yaml_mapping_or_empty(&paths[0], "DeepSeek Harness settings")?;
    let credentials = read_agent_yaml_mapping_or_empty(&paths[1], "DeepSeek Harness credentials")?;
    let provider = yaml_mapping_value(&settings, "llm-pi-ai")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|section| yaml_mapping_value(section, "providers"))
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|providers| yaml_mapping_value(providers, DEEPSEEK_HARNESS_PROVIDER_ID))
        .and_then(serde_norway::Value::as_mapping);
    let selection = yaml_mapping_value(&settings, "agent-default-model")
        .and_then(serde_norway::Value::as_mapping);
    let selected_provider = selection
        .and_then(|selection| yaml_mapping_value(selection, "provider"))
        .and_then(serde_norway::Value::as_str);
    let model = (selected_provider == Some(DEEPSEEK_HARNESS_PROVIDER_ID))
        .then(|| {
            selection
                .and_then(|selection| yaml_mapping_value(selection, "model"))
                .and_then(serde_norway::Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(str::to_string)
        })
        .flatten();
    let expected_base = if provider
        .and_then(|p| yaml_mapping_value(p, "api"))
        .and_then(serde_norway::Value::as_str)
        == Some("anthropic-messages")
    {
        port.client_origin()
    } else {
        format!("{}/v1", port.client_origin())
    };
    let credentials_layout_supported = deepseek_harness_credentials_layout_supported(&credentials);
    let credential = yaml_mapping_value(&credentials, "refs")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|refs| yaml_mapping_value(refs, DEEPSEEK_HARNESS_CREDENTIAL))
        .and_then(serde_norway::Value::as_str);
    let model_is_published = model.as_deref().is_some_and(|selected| {
        provider
            .and_then(|provider| yaml_mapping_value(provider, "models"))
            .and_then(serde_norway::Value::as_sequence)
            .is_some_and(|models| {
                models.iter().any(|model| {
                    model
                        .as_mapping()
                        .and_then(|model| yaml_mapping_value(model, "id"))
                        .and_then(serde_norway::Value::as_str)
                        .is_some_and(|id| id.eq_ignore_ascii_case(selected))
                })
            })
    });
    let configured = provider
        .and_then(|provider| yaml_mapping_value(provider, "apiKeyEnv"))
        .and_then(serde_norway::Value::as_str)
        == Some(DEEPSEEK_HARNESS_CREDENTIAL)
        && provider
            .and_then(|provider| yaml_mapping_value(provider, "api"))
            .and_then(serde_norway::Value::as_str)
            .is_some_and(|api| {
                matches!(
                    api,
                    "openai-completions" | "openai-responses" | "anthropic-messages"
                )
            })
        && provider
            .and_then(|provider| yaml_mapping_value(provider, "baseURL"))
            .and_then(serde_norway::Value::as_str)
            == Some(expected_base.as_str())
        && selected_provider == Some(DEEPSEEK_HARNESS_PROVIDER_ID)
        && model_is_published
        && credentials_layout_supported
        && credential == Some(api_key);
    Ok((configured, model))
}

pub(super) fn deepseek_harness_credentials_layout_supported(credentials: &serde_norway::Mapping) -> bool {
    let Some(version) = yaml_mapping_value(credentials, "version") else {
        return false;
    };
    let version_supported = version.as_u64() == Some(DEEPSEEK_HARNESS_CREDENTIALS_VERSION)
        || version.as_i64() == Some(DEEPSEEK_HARNESS_CREDENTIALS_VERSION as i64);
    version_supported
        && credentials
            .keys()
            .all(|key| matches!(key.as_str(), Some("version" | "refs" | "records")))
        && ["refs", "records"].into_iter().all(|section| {
            yaml_mapping_value(credentials, section).is_none_or(serde_norway::Value::is_mapping)
        })
}

pub(crate) fn deepseek_harness_has_managed_marker(paths: &[PathBuf]) -> Result<bool, String> {
    if paths.len() != 2 {
        return Err("Invalid number of DeepSeek Harness configuration paths".to_string());
    }
    let settings = read_agent_yaml_mapping_or_empty(&paths[0], "DeepSeek Harness settings")?;
    let credentials = read_agent_yaml_mapping_or_empty(&paths[1], "DeepSeek Harness credentials")?;
    let provider_exists = yaml_mapping_value(&settings, "llm-pi-ai")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|section| yaml_mapping_value(section, "providers"))
        .and_then(serde_norway::Value::as_mapping)
        .is_some_and(|providers| {
            yaml_mapping_value(providers, DEEPSEEK_HARNESS_PROVIDER_ID).is_some()
        });
    let default_selected = yaml_mapping_value(&settings, "agent-default-model")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|selection| yaml_mapping_value(selection, "provider"))
        .and_then(serde_norway::Value::as_str)
        == Some(DEEPSEEK_HARNESS_PROVIDER_ID);
    let credential_exists = yaml_mapping_value(&credentials, "refs")
        .and_then(serde_norway::Value::as_mapping)
        .is_some_and(|refs| yaml_mapping_value(refs, DEEPSEEK_HARNESS_CREDENTIAL).is_some())
        || yaml_mapping_value(&credentials, DEEPSEEK_HARNESS_CREDENTIAL).is_some();
    Ok(provider_exists || default_selected || credential_exists)
}
