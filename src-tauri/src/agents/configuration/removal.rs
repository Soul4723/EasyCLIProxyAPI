use super::*;

pub(crate) fn clear_agent_managed_configuration(
    client: AgentClient,
    home: &Path,
    port: impl AgentClientOrigin,
) -> Result<AgentConfigActionResult, String> {
    if client == AgentClient::Codex {
        return close_codex_configuration(home);
    }
    let paths = config_paths(client.id(), home)?;
    let before = config_images(&paths)?;
    validate_client_config_images(client.id(), &before)?;
    let recorded_restore = prepare_recorded_integration_restore(client, &paths, &before)?;
    let after = if let Some(after) = recorded_restore {
        after
    } else if !port.local_client() {
        return Err(
            "Remote agent configuration has no app-owned restore record; refusing to modify it"
                .to_string(),
        );
    } else {
        let mut after = before.clone();
        for (path, bytes) in prepare_agent_managed_removal(client, &paths, port)? {
            let entry = after
                .iter_mut()
                .find(|(candidate, _)| candidate == &path)
                .ok_or("Configuration cleanup path mismatch")?;
            entry.1 = bytes;
        }
        after
    };
    let mut result = commit_config(
        client.id(),
        &paths,
        &before,
        &after,
        "clear-integration",
        None,
    )?;
    result.enabled = false;
    Ok(result)
}

#[cfg(test)]
pub(crate) fn remove_agent_managed_configuration(
    client: AgentClient,
    paths: &[PathBuf],
) -> Result<Vec<String>, String> {
    let updates = prepare_agent_managed_removal(client, paths, GuiConfigFile::default().port)?;
    write_config_images(client.id(), &updates)?;
    Ok(updates
        .iter()
        .map(|(path, _)| path_to_string(path))
        .collect())
}

pub(crate) fn prepare_agent_json_removal<F>(
    path: &Path,
    label: &str,
    update: F,
) -> Result<Option<FileSnapshot>, String>
where
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> bool,
{
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {label} {}: {error}", path_to_string(path)))?;
    let mut root = parse_agent_json_object(Some(&content), label)?;
    if !update(&mut root) {
        return Ok(None);
    }
    let bytes = if root.is_empty() {
        None
    } else {
        Some(render_agent_json(root, label)?.into_bytes())
    };
    Ok(Some((path.to_path_buf(), bytes)))
}

pub(crate) fn prepare_claude_desktop_managed_removal(paths: &[PathBuf]) -> Result<Images, String> {
    if paths.len() != 4 {
        return Err("Claude Desktop configuration path is unavailable on the current platform".to_string());
    }
    let meta = read_agent_json_or_empty(&paths[3], "Claude Desktop configuration index")?;
    let applied_id = meta.get("appliedId").and_then(serde_json::Value::as_str);
    let managed_active = applied_id == Some(CLAUDE_DESKTOP_PROFILE_ID)
        || (applied_id.is_none() && agent_has_managed_marker(AgentClient::ClaudeDesktop, paths)?);
    let mut changed = Vec::new();
    for (path, label) in [
        (&paths[0], "Claude Desktop main configuration"),
        (&paths[1], "Claude Desktop 3P configuration"),
    ] {
        if let Some(update) = prepare_agent_json_removal(path, label, |root| {
            if managed_active
                && root
                    .get("deploymentMode")
                    .and_then(serde_json::Value::as_str)
                    == Some("3p")
            {
                root.remove("deploymentMode");
                true
            } else {
                false
            }
        })? {
            changed.push(update);
        }
    }

    if let Some(update) =
        prepare_agent_json_removal(&paths[2], "Claude Desktop gateway configuration", |root| {
            let mut updated = false;
            for key in [
                "disableDeploymentModeChooser",
                "inferenceGatewayApiKey",
                "inferenceGatewayAuthScheme",
                "inferenceGatewayBaseUrl",
                "inferenceProvider",
                "inferenceModels",
            ] {
                updated |= root.remove(key).is_some();
            }
            updated
        })?
    {
        changed.push(update);
    }

    if let Some(update) =
        prepare_agent_json_removal(&paths[3], "Claude Desktop configuration index", |root| {
            let mut updated = false;
            if root.get("appliedId").and_then(serde_json::Value::as_str)
                == Some(CLAUDE_DESKTOP_PROFILE_ID)
            {
                root.remove("appliedId");
                updated = true;
            }
            let entries_empty = if let Some(entries) = root
                .get_mut("entries")
                .and_then(serde_json::Value::as_array_mut)
            {
                let previous_len = entries.len();
                entries.retain(|entry| {
                    entry.get("id").and_then(serde_json::Value::as_str)
                        != Some(CLAUDE_DESKTOP_PROFILE_ID)
                });
                updated |= entries.len() != previous_len;
                entries.is_empty()
            } else {
                false
            };
            if entries_empty {
                root.remove("entries");
            }
            updated
        })?
    {
        changed.push(update);
    }
    Ok(changed)
}

pub(crate) fn prepare_claude_code_managed_removal(
    paths: &[PathBuf],
    expected_base_url: &str,
) -> Result<Images, String> {
    let Some(path) = paths.first() else {
        return Err("Claude Code configuration path is unavailable on the current platform".to_string());
    };
    let expected_base_url = reqwest::Url::parse(expected_base_url)
        .map_err(|_| "Invalid CPA access URL".to_string())?;
    let updated = prepare_agent_json_removal(path, "Claude Code configuration", |root| {
        let managed_model = root
            .get("env")
            .and_then(serde_json::Value::as_object)
            .and_then(|env| env.get(CLAUDE_CODE_MANAGED_STARTUP_MODEL_ENV).or_else(|| env.get("ANTHROPIC_MODEL")))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let managed = root
            .get("env")
            .and_then(serde_json::Value::as_object)
            .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|url| {
                reqwest::Url::parse(url.trim()).is_ok_and(|url| url == expected_base_url)
            });
        if !managed {
            return false;
        }
        let has_managed_model_record = root.get("env").and_then(serde_json::Value::as_object)
            .is_some_and(|env| env.contains_key(CLAUDE_CODE_MANAGED_STARTUP_MODEL_ENV));
        let managed_role_selection = !has_managed_model_record && root.get("model").and_then(serde_json::Value::as_str)
            .is_some_and(|model| {
                let base = strip_claude_code_context_suffix(model);
                matches!(base.to_ascii_lowercase().as_str(), "opus" | "sonnet" | "haiku" | "fable")
                    || root.get("env").and_then(serde_json::Value::as_object).is_some_and(|env| {
                        ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
                            "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL"]
                            .iter().any(|key| env.get(*key).and_then(serde_json::Value::as_str)
                                .is_some_and(|route| strip_claude_code_context_suffix(route) == base))
                    })
            });
        restore_claude_code_compaction_settings(root, None);
        if managed_role_selection || root.get("model").and_then(serde_json::Value::as_str) == managed_model.as_deref() {
            root.remove("model");
        }
        let env_empty = if let Some(env) = root
            .get_mut("env")
            .and_then(serde_json::Value::as_object_mut)
        {
            for key in [
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_FABLE_MODEL",
                "EASYCLIPROXY_MANAGE_CLAUDE_CODE_DEFAULT_MODEL",
                "EASYCLIPROXY_MANAGE_CLAUDE_CODE_SUBAGENT_MODEL",
                CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV,
                CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV,
                CLAUDE_CODE_AUTO_COMPACT_WINDOW_ENV,
                CLAUDE_CODE_AUTO_MODE_SERVER_ENV,
                CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV,
                DISABLE_AUTO_COMPACT_ENV,
                CLAUDE_CODE_MANAGED_MODEL_SETTINGS_ENV,
                CLAUDE_CODE_MANAGED_STARTUP_MODEL_ENV,
                "CLAUDE_CODE_SUBAGENT_MODEL",
                "CLAUDE_CODE_EFFORT_LEVEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
                "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
                "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
                "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
                "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
                "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
                "ANTHROPIC_CUSTOM_MODEL_OPTION",
                "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
                "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
            ] {
                env.remove(key);
            }
            env.is_empty()
        } else {
            false
        };
        if env_empty {
            root.remove("env");
        }
        true
    })?;
    Ok(updated.into_iter().collect())
}

pub(crate) fn prepare_codex_managed_removal(paths: &[PathBuf]) -> Result<Images, String> {
    use toml_edit::{Document, Item};

    let Some(path) = paths.first() else {
        return Err("Codex configuration path is unavailable on the current platform".to_string());
    };
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read Codex configuration {}: {error}", path_to_string(path)))?;
    let mut document = content
        .parse::<Document>()
        .map_err(|_| "Failed to parse Codex configuration".to_string())?;
    restore_codex_proxy_identity_for_removal(&mut document, path)?;
    let managed_selected =
        document.get("model_provider").and_then(Item::as_str) == Some(MANAGED_AGENT_PROVIDER_ID);
    let managed_catalog =
        document.get("model_catalog_json").and_then(Item::as_str) == Some(CODEX_MODEL_CATALOG_FILE);
    let managed_provider = document
        .get("model_providers")
        .and_then(Item::as_table)
        .is_some_and(|providers| providers.contains_key(MANAGED_AGENT_PROVIDER_ID));
    if !managed_selected && !managed_catalog && !managed_provider {
        return Ok(Vec::new());
    }
    if managed_selected {
        document.remove("model_provider");
        document.remove("model");
    }
    if managed_catalog {
        document.remove("model_catalog_json");
    }
    let rendered = document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("Failed to validate restored Codex configuration: {error}"))?;
    let mut changed = vec![(
        path.clone(),
        (!rendered.trim().is_empty()).then(|| rendered.into_bytes()),
    )];
    if managed_catalog {
        changed.push((path.with_file_name(CODEX_MODEL_CATALOG_FILE), None));
    }
    Ok(changed)
}

pub(crate) fn prepare_opencode_managed_removal(paths: &[PathBuf]) -> Result<Images, String> {
    let Some(path) = paths.first() else {
        return Err("OpenCode configuration path is unavailable on the current platform".to_string());
    };
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let updated = prepare_agent_json5_removal(path, "OpenCode configuration", |root| {
        let mut changed = false;
        if root
            .get("model")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|model| model.starts_with(&prefix))
        {
            root.remove("model");
            changed = true;
        }
        let providers_empty = if let Some(providers) = root
            .get_mut("provider")
            .and_then(serde_json::Value::as_object_mut)
        {
            changed |= providers.remove(MANAGED_AGENT_PROVIDER_ID).is_some();
            providers.is_empty()
        } else {
            false
        };
        if providers_empty {
            root.remove("provider");
        }
        changed
    })?;
    Ok(updated.into_iter().collect())
}

pub(crate) fn prepare_zcode_managed_removal(paths: &[PathBuf]) -> Result<Images, String> {
    let path = paths.first().ok_or("ZCode provider configuration path is unavailable")?;
    let updated = prepare_agent_json_removal(path, "ZCode provider configuration", |root| {
        let Some(config) = root.get_mut("config").and_then(serde_json::Value::as_object_mut) else {
            return false;
        };
        let mut changed = false;
        if config.get("defaultModelSelection")
            .and_then(|selection| selection.get("providerId"))
            .and_then(serde_json::Value::as_str) == Some(MANAGED_AGENT_PROVIDER_ID)
        {
            config.remove("defaultModelSelection");
            changed = true;
        }
        if let Some(order) = config.get_mut("providerOrder").and_then(serde_json::Value::as_array_mut) {
            let old_len = order.len();
            order.retain(|item| item.as_str() != Some(MANAGED_AGENT_PROVIDER_ID));
            changed |= order.len() != old_len;
        }
        if let Some(rules) = config.get_mut("providerConfigRules")
            .and_then(|value| value.get_mut("providerRules"))
            .and_then(serde_json::Value::as_array_mut)
        {
            let old_len = rules.len();
            rules.retain(|rule| rule.get("providerId").and_then(serde_json::Value::as_str)
                != Some(MANAGED_AGENT_PROVIDER_ID));
            changed |= rules.len() != old_len;
        }
        for key in ["providerModelRules", "manualProviderModelRules"] {
            if let Some(rules) = config.get_mut("modelConfigRules")
                .and_then(|value| value.get_mut(key))
                .and_then(serde_json::Value::as_array_mut)
            {
                let old_len = rules.len();
                rules.retain(|rule| rule.get("providerId").and_then(serde_json::Value::as_str)
                    != Some(MANAGED_AGENT_PROVIDER_ID));
                changed |= rules.len() != old_len;
            }
        }
        changed
    })?;
    Ok(updated.into_iter().collect())
}

pub(crate) fn prepare_kimi_code_managed_removal(paths: &[PathBuf]) -> Result<Images, String> {
    prepare_managed_toml_client_removal(
        paths,
        "Kimi Code",
        Some("providers"),
        "models",
        None,
        "default_model",
    )
}

pub(crate) fn prepare_grok_build_managed_removal(paths: &[PathBuf]) -> Result<Images, String> {
    prepare_managed_toml_client_removal(
        paths,
        "Grok Build",
        None,
        "model",
        Some("models"),
        "default",
    )
}

pub(crate) fn prepare_managed_toml_client_removal(
    paths: &[PathBuf],
    label: &str,
    provider_section: Option<&str>,
    model_entry_section: &str,
    default_section: Option<&str>,
    default_key: &str,
) -> Result<Images, String> {
    use toml_edit::{Document, Item};

    let Some(path) = paths.first() else {
        return Err(format!("{label} configuration path is unavailable on the current platform"));
    };
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {label} configuration {}: {error}", path_to_string(path)))?;
    let mut document = content
        .parse::<Document>()
        .map_err(|_| format!("Failed to parse {label} configuration"))?;
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let mut changed = false;

    let default_table: Option<&mut dyn toml_edit::TableLike> =
        if let Some(section) = default_section {
            document
                .as_table_mut()
                .get_mut(section)
                .and_then(Item::as_table_like_mut)
        } else {
            Some(document.as_table_mut())
        };
    if let Some(table) = default_table {
        if table
            .get(default_key)
            .and_then(Item::as_str)
            .is_some_and(|model| model.starts_with(&prefix))
        {
            table.remove(default_key);
            changed = true;
        }
    }

    if let Some(section) = provider_section {
        if let Some(providers) = document
            .as_table_mut()
            .get_mut(section)
            .and_then(Item::as_table_like_mut)
        {
            changed |= providers.remove(MANAGED_AGENT_PROVIDER_ID).is_some();
        }
    }
    if let Some(models) = document
        .as_table_mut()
        .get_mut(model_entry_section)
        .and_then(Item::as_table_like_mut)
    {
        let managed = models
            .iter()
            .map(|(key, _)| key.to_string())
            .filter(|key| key.starts_with(&prefix))
            .collect::<Vec<_>>();
        changed |= !managed.is_empty();
        for key in managed {
            models.remove(&key);
        }
    }
    for section in provider_section.into_iter().chain([model_entry_section]) {
        let empty = document
            .as_table()
            .get(section)
            .and_then(Item::as_table_like)
            .is_some_and(|table| table.is_empty());
        if empty {
            document.as_table_mut().remove(section);
        }
    }
    if let Some(section) = default_section {
        let empty = document
            .as_table()
            .get(section)
            .and_then(Item::as_table_like)
            .is_some_and(|table| table.is_empty());
        if empty {
            document.as_table_mut().remove(section);
        }
    }
    if !changed {
        return Ok(Vec::new());
    }
    let rendered = document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("Failed to validate restored {label} configuration: {error}"))?;
    Ok(vec![(
        path.clone(),
        (!rendered.trim().is_empty()).then(|| rendered.into_bytes()),
    )])
}

pub(crate) fn prepare_agent_json5_removal<F>(
    path: &Path,
    label: &str,
    update: F,
) -> Result<Option<FileSnapshot>, String>
where
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> bool,
{
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {label} {}: {error}", path_to_string(path)))?;
    let value = json5::from_str::<serde_json::Value>(&content)
        .map_err(|_| format!("Failed to parse {label}"))?;
    let mut root = value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{label} root must be an object"))?;
    if !update(&mut root) {
        return Ok(None);
    }
    let bytes = if root.is_empty() {
        None
    } else {
        let rendered = render_agent_json(root, label)?;
        let comments = extract_json5_comments(&content);
        Some(
            if comments.is_empty() {
                rendered
            } else {
                format!("{}\n{rendered}", comments.join("\n"))
            }
            .into_bytes(),
        )
    };
    Ok(Some((path.to_path_buf(), bytes)))
}

pub(crate) fn prepare_openclaw_managed_removal(paths: &[PathBuf]) -> Result<Images, String> {
    let Some(path) = paths.first() else {
        return Err("OpenClaw configuration path is unavailable on the current platform".to_string());
    };
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let updated = prepare_agent_json5_removal(path, "OpenClaw configuration", |root| {
        let mut changed = false;
        if let Some(models) = root
            .get_mut("models")
            .and_then(serde_json::Value::as_object_mut)
        {
            let providers_empty = if let Some(providers) = models
                .get_mut("providers")
                .and_then(serde_json::Value::as_object_mut)
            {
                changed |= providers.remove(MANAGED_AGENT_PROVIDER_ID).is_some();
                providers.is_empty()
            } else {
                false
            };
            if providers_empty {
                models.remove("providers");
            }
        }
        if let Some(defaults) = root
            .get_mut("agents")
            .and_then(serde_json::Value::as_object_mut)
            .and_then(|agents| agents.get_mut("defaults"))
            .and_then(serde_json::Value::as_object_mut)
        {
            let model_empty = if let Some(model) = defaults
                .get_mut("model")
                .and_then(serde_json::Value::as_object_mut)
            {
                if model
                    .get("primary")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|model| model.starts_with(&prefix))
                {
                    model.remove("primary");
                    changed = true;
                }
                model.is_empty()
            } else {
                false
            };
            if model_empty {
                defaults.remove("model");
            }
            let catalog_empty = if let Some(catalog) = defaults
                .get_mut("models")
                .and_then(serde_json::Value::as_object_mut)
            {
                let previous_len = catalog.len();
                catalog.retain(|name, _| !name.starts_with(&prefix));
                changed |= catalog.len() != previous_len;
                catalog.is_empty()
            } else {
                false
            };
            if catalog_empty {
                defaults.remove("models");
            }
        }
        changed
    })?;
    Ok(updated.into_iter().collect())
}

pub(crate) fn prepare_hermes_managed_removal(paths: &[PathBuf]) -> Result<Images, String> {
    let Some(path) = paths.first() else {
        return Err("Hermes configuration path is unavailable on the current platform".to_string());
    };
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read Hermes configuration {}: {error}", path_to_string(path)))?;
    let mut document = yaml_serde_edit::YamlValue::parse(&content)
        .map_err(|_| "Failed to parse Hermes configuration".to_string())?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Hermes configuration root must be a mapping".to_string())?;
    let mut changed = false;
    let providers_empty = if let Some(providers) = root
        .get_mut(yaml_key("custom_providers"))
        .and_then(serde_norway::Value::as_sequence_mut)
    {
        let previous_len = providers.len();
        providers.retain(|provider| {
            provider.get("name").and_then(serde_norway::Value::as_str)
                != Some(MANAGED_AGENT_PROVIDER_ID)
        });
        changed |= providers.len() != previous_len;
        providers.is_empty()
    } else {
        false
    };
    if providers_empty {
        root.remove(yaml_key("custom_providers"));
    }
    let model_empty = if let Some(model) = root
        .get_mut(yaml_key("model"))
        .and_then(serde_norway::Value::as_mapping_mut)
    {
        if model
            .get(yaml_key("provider"))
            .and_then(serde_norway::Value::as_str)
            == Some(MANAGED_AGENT_PROVIDER_ID)
        {
            model.remove(yaml_key("provider"));
            model.remove(yaml_key("default"));
            changed = true;
        }
        model.is_empty()
    } else {
        false
    };
    if model_empty {
        root.remove(yaml_key("model"));
    }
    if !changed {
        return Ok(Vec::new());
    }
    let bytes = if root.is_empty() {
        None
    } else {
        Some(render_updated_core_yaml(&mut document, updated)?.into_bytes())
    };
    Ok(vec![(path.clone(), bytes)])
}

pub(crate) fn prepare_agent_managed_removal(
    client: AgentClient,
    paths: &[PathBuf],
    port: impl AgentClientOrigin,
) -> Result<Images, String> {
    match client {
        AgentClient::ClaudeCode => {
            prepare_claude_code_managed_removal(paths, &port.client_origin())
        }
        AgentClient::ClaudeDesktop => prepare_claude_desktop_managed_removal(paths),
        AgentClient::Codex => prepare_codex_managed_removal(paths),
        AgentClient::OpenCode => prepare_opencode_managed_removal(paths),
        AgentClient::OpenClaw => prepare_openclaw_managed_removal(paths),
        AgentClient::Hermes => prepare_hermes_managed_removal(paths),
        AgentClient::DeepSeekHarness => prepare_deepseek_harness_managed_removal(paths),
        AgentClient::ZCode => prepare_zcode_managed_removal(paths),
        AgentClient::WorkBuddy => prepare_workbuddy_managed_removal(paths),
        AgentClient::AntigravityCli => prepare_antigravity_removal(client, paths),
        AgentClient::CopilotCli | AgentClient::VscodeCopilot => prepare_copilot_removal(client, paths),
        AgentClient::KimiCode => prepare_kimi_code_managed_removal(paths),
        AgentClient::GrokBuild => prepare_grok_build_managed_removal(paths),
        AgentClient::Omp => prepare_omp_managed_removal(paths),
    }
}

pub(crate) fn remove_deepseek_harness_settings_fields(root: &mut serde_norway::Mapping) -> bool {
    let mut changed = false;
    let mut remove_llm = false;
    if let Some(llm) = root
        .get_mut(yaml_key("llm-pi-ai"))
        .and_then(serde_norway::Value::as_mapping_mut)
    {
        let mut remove_providers = false;
        if let Some(providers) = llm
            .get_mut(yaml_key("providers"))
            .and_then(serde_norway::Value::as_mapping_mut)
        {
            changed |= providers
                .remove(yaml_key(DEEPSEEK_HARNESS_PROVIDER_ID))
                .is_some();
            remove_providers = providers.is_empty();
        }
        if remove_providers {
            llm.remove(yaml_key("providers"));
        }
        remove_llm = llm.is_empty();
    }
    if remove_llm {
        root.remove(yaml_key("llm-pi-ai"));
    }
    let managed_selection = root
        .get(yaml_key("agent-default-model"))
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|selection| yaml_mapping_value(selection, "provider"))
        .and_then(serde_norway::Value::as_str)
        == Some(DEEPSEEK_HARNESS_PROVIDER_ID);
    if managed_selection {
        root.remove(yaml_key("agent-default-model"));
        changed = true;
    }
    changed
}

pub(crate) fn prepare_deepseek_harness_managed_removal(
    paths: &[PathBuf],
) -> Result<Images, String> {
    if paths.len() != 2 {
        return Err("Invalid number of DeepSeek Harness configuration paths".to_string());
    }
    let mut changed_paths = Vec::new();
    if paths[0].is_file() {
        let current = fs::read_to_string(&paths[0])
            .map_err(|error| format!("Failed to read DeepSeek Harness settings: {error}"))?;
        let mut changed = false;
        let rendered = render_agent_yaml_mapping_update(
            Some(&current),
            "DeepSeek Harness settings",
            |root| {
                changed = remove_deepseek_harness_settings_fields(root);
                Ok(())
            },
        )?;
        if changed {
            let root = parse_agent_yaml_mapping(Some(&rendered), "DeepSeek Harness settings")?;
            changed_paths.push((
                paths[0].clone(),
                (!root.is_empty()).then(|| rendered.into_bytes()),
            ));
        }
    }
    if paths[1].is_file() {
        let current = fs::read_to_string(&paths[1])
            .map_err(|error| format!("Failed to read DeepSeek Harness credentials: {error}"))?;
        let mut changed = false;
        let rendered = render_agent_yaml_mapping_update(
            Some(&current),
            "DeepSeek Harness credentials",
            |root| {
                changed = remove_deepseek_harness_managed_credential(
                    root,
                    "DeepSeek Harness credentials",
                )?;
                Ok(())
            },
        )?;
        if changed {
            let root = parse_agent_yaml_mapping(Some(&rendered), "DeepSeek Harness credentials")?;
            changed_paths.push((
                paths[1].clone(),
                (!deepseek_harness_credentials_document_is_empty(&root))
                    .then(|| rendered.into_bytes()),
            ));
        }
    }
    Ok(changed_paths)
}
