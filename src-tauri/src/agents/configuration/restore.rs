use super::*;

pub(crate) fn restore_json_key(
    current: &mut serde_json::Map<String, serde_json::Value>,
    original: Option<&serde_json::Map<String, serde_json::Value>>,
    key: &str,
) {
    if let Some(value) = original.and_then(|root| root.get(key)).cloned() {
        current.insert(key.to_string(), value);
    } else {
        current.remove(key);
    }
}

pub(crate) fn parse_restored_json_object(
    content: Option<&str>,
    label: &str,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
    content
        .map(|content| parse_agent_json_object(Some(content), label))
        .transpose()
}

pub(crate) fn parse_restored_json5_object(
    content: Option<&str>,
    label: &str,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
    content
        .map(|content| parse_agent_json5_object(Some(content), label))
        .transpose()
}

pub(crate) fn render_restored_json(
    root: serde_json::Map<String, serde_json::Value>,
    original_existed: bool,
    label: &str,
) -> Result<Option<String>, String> {
    if root.is_empty() && !original_existed {
        Ok(None)
    } else {
        render_agent_json(root, label).map(Some)
    }
}

pub(super) fn restore_claude_code_compaction_settings(
    root: &mut serde_json::Map<String, serde_json::Value>,
    original: Option<&serde_json::Map<String, serde_json::Value>>,
) {
    let env = root.get("env").and_then(serde_json::Value::as_object);
    let mut managed_models = [
        "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
    ].iter().filter_map(|key| env?.get(*key)?.as_str())
        .chain(root.get("model").and_then(serde_json::Value::as_str))
        .map(|model| strip_claude_code_context_suffix(model).to_string())
        .collect::<Vec<_>>();
    if let Some(recorded) = env.and_then(|env| env.get(CLAUDE_CODE_MANAGED_MODEL_SETTINGS_ENV))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok()) {
        managed_models = recorded;
    }
    managed_models.sort();
    managed_models.dedup();
    for key in ["autoCompactWindow", "autoCompactEnabled"] {
        restore_json_key(root, original, key);
    }
    let original_models = original.and_then(|root| root.get("modelSettings"));
    if original_models.is_some_and(|value| !value.is_object()) {
        restore_json_key(root, original, "modelSettings");
        return;
    }
    let original_models = original_models.and_then(serde_json::Value::as_object);
    if let Some(models) = root.get_mut("modelSettings").and_then(serde_json::Value::as_object_mut) {
        for model in managed_models {
            let original_entry = original_models.and_then(|models| models.get(&model));
            if let Some(entry) = models.get_mut(&model).and_then(serde_json::Value::as_object_mut) {
                restore_json_key(entry, original_entry.and_then(serde_json::Value::as_object), "autoCompactWindow");
                if entry.is_empty() && original_entry.is_none() {
                    models.remove(&model);
                }
            }
        }
        if models.is_empty() && original_models.is_none() {
            root.remove("modelSettings");
        }
    }
}

pub(crate) fn build_restored_claude_code_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let mut root = parse_agent_json_object(Some(current), "Current Claude Code configuration")?;
    let original_root = parse_restored_json_object(original, "Original Claude Code configuration")?;
    restore_claude_code_compaction_settings(&mut root, original_root.as_ref());
    restore_json_key(&mut root, original_root.as_ref(), "model");
    let original_env = original_root
        .as_ref()
        .and_then(|root| root.get("env"))
        .and_then(serde_json::Value::as_object);
    if root.get("env").is_some_and(serde_json::Value::is_object) {
        let env = root
            .get_mut("env")
            .and_then(serde_json::Value::as_object_mut)
            .expect("Claude Code env was checked as an object");
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
            restore_json_key(env, original_env, key);
        }
        if env.is_empty() && original_env.is_none() {
            root.remove("env");
        }
    } else {
        restore_json_key(&mut root, original_root.as_ref(), "env");
    }
    render_restored_json(root, original.is_some(), "Restored Claude Code configuration")
}

pub(crate) fn build_restored_claude_desktop_config(
    index: usize,
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let mut root = parse_agent_json_object(Some(current), "Current Claude Desktop configuration")?;
    let original_root = parse_restored_json_object(original, "Original Claude Desktop configuration")?;
    match index {
        0 | 1 => restore_json_key(&mut root, original_root.as_ref(), "deploymentMode"),
        2 => {
            for key in [
                "disableDeploymentModeChooser",
                "inferenceGatewayApiKey",
                "inferenceGatewayAuthScheme",
                "inferenceGatewayBaseUrl",
                "inferenceProvider",
                "inferenceModels",
            ] {
                restore_json_key(&mut root, original_root.as_ref(), key);
            }
        }
        3 => {
            restore_json_key(&mut root, original_root.as_ref(), "appliedId");
            let mut entries = root
                .remove("entries")
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            entries.retain(|entry| {
                entry.get("id").and_then(serde_json::Value::as_str)
                    != Some(CLAUDE_DESKTOP_PROFILE_ID)
            });
            let original_managed_entries = original_root
                .as_ref()
                .and_then(|root| root.get("entries"))
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter(|entry| {
                    entry.get("id").and_then(serde_json::Value::as_str)
                        == Some(CLAUDE_DESKTOP_PROFILE_ID)
                })
                .cloned();
            entries.extend(original_managed_entries);
            if !entries.is_empty()
                || original_root
                    .as_ref()
                    .and_then(|root| root.get("entries"))
                    .is_some()
            {
                root.insert("entries".to_string(), serde_json::Value::Array(entries));
            }
        }
        _ => return Err("Invalid Claude Desktop configuration file index".to_string()),
    }
    render_restored_json(root, original.is_some(), "Restored Claude Desktop configuration")
}

pub(crate) fn build_restored_opencode_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let mut root = parse_agent_json5_object(Some(current), "Current OpenCode configuration")?;
    let original_root = parse_restored_json5_object(original, "Original OpenCode configuration")?;
    for key in ["$schema", "model"] {
        restore_json_key(&mut root, original_root.as_ref(), key);
    }
    let original_provider = original_root
        .as_ref()
        .and_then(|root| root.get("provider"))
        .and_then(serde_json::Value::as_object);
    let original_managed = original_provider
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
        .and_then(serde_json::Value::as_object);
    if root
        .get("provider")
        .is_some_and(serde_json::Value::is_object)
    {
        let providers = root
            .get_mut("provider")
            .and_then(serde_json::Value::as_object_mut)
            .expect("OpenCode provider was checked as an object");
        if providers
            .get(MANAGED_AGENT_PROVIDER_ID)
            .is_some_and(serde_json::Value::is_object)
        {
            let managed = providers
                .get_mut(MANAGED_AGENT_PROVIDER_ID)
                .and_then(serde_json::Value::as_object_mut)
                .expect("OpenCode managed provider was checked as an object");
            for key in ["npm", "name", "models"] {
                restore_json_key(managed, original_managed, key);
            }
            let original_options = original_managed
                .and_then(|managed| managed.get("options"))
                .and_then(serde_json::Value::as_object);
            if managed
                .get("options")
                .is_some_and(serde_json::Value::is_object)
            {
                let options = managed
                    .get_mut("options")
                    .and_then(serde_json::Value::as_object_mut)
                    .expect("OpenCode options were checked as an object");
                for key in ["baseURL", "apiKey"] {
                    restore_json_key(options, original_options, key);
                }
                if options.is_empty() && original_options.is_none() {
                    managed.remove("options");
                }
            } else {
                restore_json_key(managed, original_managed, "options");
            }
            if managed.is_empty() && original_managed.is_none() {
                providers.remove(MANAGED_AGENT_PROVIDER_ID);
            }
        } else if let Some(original_managed) = original_provider
            .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
            .cloned()
        {
            providers.insert(MANAGED_AGENT_PROVIDER_ID.to_string(), original_managed);
        }
        if providers.is_empty() && original_provider.is_none() {
            root.remove("provider");
        }
    } else {
        restore_json_key(&mut root, original_root.as_ref(), "provider");
    }
    let restored = render_restored_json(root, original.is_some(), "Restored OpenCode configuration")?;
    Ok(restored.map(|rendered| {
        let comments = extract_json5_comments(current);
        if comments.is_empty() {
            rendered
        } else {
            format!("{}\n{rendered}", comments.join("\n"))
        }
    }))
}

pub(crate) fn build_restored_zcode_provider_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let mut root = serde_json::Value::Object(parse_agent_json_object(
        Some(current), "Current ZCode provider configuration",
    )?);
    let original_root = parse_restored_json_object(original, "Original ZCode provider configuration")?
        .map(serde_json::Value::Object);
    if root.pointer("/config").is_none() {
        return render_restored_json(
            root.as_object().cloned().ok_or("Invalid ZCode provider configuration")?,
            original.is_some(),
            "Restored ZCode provider configuration",
        );
    }
    let config = root.pointer_mut("/config").and_then(serde_json::Value::as_object_mut)
        .ok_or("ZCode provider configuration has invalid config")?;
    let original_config = original_root.as_ref().and_then(|value| value.pointer("/config"));
    if original.is_none() || config.get("defaultModelSelection")
        .and_then(|selection| selection.get("providerId"))
        .and_then(serde_json::Value::as_str) == Some(MANAGED_AGENT_PROVIDER_ID)
    {
        if let Some(selection) = original_config.and_then(|value| value.get("defaultModelSelection")) {
            config.insert("defaultModelSelection".to_string(), selection.clone());
        } else {
            config.remove("defaultModelSelection");
        }
    }
    if let Some(order) = config.get_mut("providerOrder").and_then(serde_json::Value::as_array_mut) {
        order.retain(|item| item.as_str() != Some(MANAGED_AGENT_PROVIDER_ID));
        if let Some(original_order) = original_config
            .and_then(|value| value.get("providerOrder"))
            .and_then(serde_json::Value::as_array)
        {
            if let Some(index) = original_order.iter().position(|item| item.as_str() == Some(MANAGED_AGENT_PROVIDER_ID)) {
                order.insert(index.min(order.len()), serde_json::json!(MANAGED_AGENT_PROVIDER_ID));
            }
        }
    }
    for pointer in [
        "/providerConfigRules/providerRules",
        "/modelConfigRules/providerModelRules",
        "/modelConfigRules/manualProviderModelRules",
    ] {
        let Some(rules) = root.pointer(&format!("/config{pointer}"))
            .and_then(serde_json::Value::as_array).cloned() else {
            continue;
        };
        let mut retained = rules.into_iter().filter(|rule| {
            rule.get("providerId").and_then(serde_json::Value::as_str)
                != Some(MANAGED_AGENT_PROVIDER_ID)
        }).collect::<Vec<_>>();
        if let Some(original_rules) = original_config.and_then(|value| value.pointer(pointer))
            .and_then(serde_json::Value::as_array)
        {
            for (index, rule) in original_rules.iter().enumerate() {
                if rule.get("providerId").and_then(serde_json::Value::as_str)
                    == Some(MANAGED_AGENT_PROVIDER_ID)
                {
                    retained.insert(index.min(retained.len()), rule.clone());
                }
            }
        }
        if let Some(target) = root.pointer_mut(&format!("/config{pointer}")) {
            *target = serde_json::Value::Array(retained);
        }
    }
    if original.is_none() {
        let config = root.get("config");
        let only_empty_scaffold = config
            .and_then(serde_json::Value::as_object)
            .is_some_and(|config| {
                config.get("defaultModelSelection").is_none()
                    && config.get("providerOrder").and_then(serde_json::Value::as_array)
                        .is_none_or(Vec::is_empty)
                    && root.pointer("/config/providerConfigRules/providerRules")
                        .and_then(serde_json::Value::as_array).is_some_and(Vec::is_empty)
                    && root.pointer("/config/modelConfigRules/providerModelRules")
                        .and_then(serde_json::Value::as_array).is_some_and(Vec::is_empty)
                    && root.pointer("/config/modelConfigRules/manualProviderModelRules")
                        .and_then(serde_json::Value::as_array).is_some_and(Vec::is_empty)
                    && config.len() <= 3
            });
        if only_empty_scaffold && root.as_object().is_some_and(|root| root.len() <= 2) {
            return Ok(None);
        }
    }
    render_agent_json(root.as_object().cloned().ok_or("Invalid ZCode provider configuration")?,
        "Restored ZCode provider configuration").map(Some)
}

pub(crate) fn build_restored_kimi_code_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    build_restored_managed_toml_client_config(
        current,
        original,
        "Kimi Code",
        Some(("providers", &["type", "base_url", "api_key"])),
        "models",
        None,
        "default_model",
    )
}

pub(crate) fn build_restored_grok_build_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    build_restored_managed_toml_client_config(
        current,
        original,
        "Grok Build",
        None,
        "model",
        Some("models"),
        "default",
    )
}

pub(crate) fn build_restored_managed_toml_client_config(
    current: &str,
    original: Option<&str>,
    label: &str,
    provider: Option<(&str, &[&str])>,
    model_entry_section: &str,
    default_section: Option<&str>,
    default_key: &str,
) -> Result<Option<String>, String> {
    use toml_edit::Item;

    let mut current_document = parse_codex_document(Some(current), &format!("Current {label} configuration"))?;
    let original_document = original
        .map(|content| parse_codex_document(Some(content), &format!("Original {label} configuration")))
        .transpose()?;
    if let Some(original_document) = original_document.as_ref() {
        merge_missing_codex_table_items(
            current_document.as_table_mut(),
            original_document.as_table(),
        );
    }

    if let Some(section) = default_section {
        let original_table = original_document
            .as_ref()
            .and_then(|document| document.as_table().get(section))
            .and_then(Item::as_table);
        if let Some(current_table) = current_document
            .as_table_mut()
            .get_mut(section)
            .and_then(Item::as_table_mut)
        {
            restore_codex_table_item(current_table, original_table, default_key);
        }
    } else {
        restore_codex_table_item(
            current_document.as_table_mut(),
            original_document
                .as_ref()
                .map(|document| document.as_table()),
            default_key,
        );
    }

    if let Some((section, managed_keys)) = provider {
        let original_provider = original_document
            .as_ref()
            .and_then(|document| document.as_table().get(section))
            .and_then(Item::as_table)
            .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
            .and_then(Item::as_table)
            .cloned();
        if let Some(providers) = current_document
            .as_table_mut()
            .get_mut(section)
            .and_then(Item::as_table_mut)
        {
            if let Some(current_provider) = providers
                .get_mut(MANAGED_AGENT_PROVIDER_ID)
                .and_then(Item::as_table_mut)
            {
                for key in managed_keys {
                    restore_codex_table_item(current_provider, original_provider.as_ref(), key);
                }
                if current_provider.is_empty() {
                    providers.remove(MANAGED_AGENT_PROVIDER_ID);
                }
            }
        }
    }

    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let original_models = original_document
        .as_ref()
        .and_then(|document| document.as_table().get(model_entry_section))
        .and_then(Item::as_table)
        .map(|models| {
            models
                .iter()
                .filter(|(key, _)| key.starts_with(&prefix))
                .map(|(key, item)| (key.to_string(), item.clone()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(models) = current_document
        .as_table_mut()
        .get_mut(model_entry_section)
        .and_then(Item::as_table_mut)
    {
        let managed = models
            .iter()
            .map(|(key, _)| key.to_string())
            .filter(|key| key.starts_with(&prefix))
            .collect::<Vec<_>>();
        for key in managed {
            models.remove(&key);
        }
        for (key, item) in &original_models {
            models.insert(key, item.clone());
        }
    } else if !original_models.is_empty() {
        let models = ensure_toml_child_table(current_document.as_table_mut(), model_entry_section);
        for (key, item) in &original_models {
            models.insert(key, item.clone());
        }
    }

    for section in provider
        .map(|(section, _)| section)
        .into_iter()
        .chain([model_entry_section])
        .chain(default_section)
    {
        let empty = current_document
            .as_table()
            .get(section)
            .and_then(Item::as_table)
            .is_some_and(toml_edit::Table::is_empty);
        if empty {
            current_document.as_table_mut().remove(section);
        }
    }
    let rendered = current_document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("Failed to validate restored {label} configuration: {error}"))?;
    if original.is_none() && rendered.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(rendered))
    }
}

pub(crate) fn build_restored_openclaw_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let current_value = json5::from_str::<serde_json::Value>(current)
        .map_err(|_| "Invalid current OpenClaw configuration format".to_string())?;
    let mut root = current_value
        .as_object()
        .cloned()
        .ok_or_else(|| "Current OpenClaw configuration root must be an object".to_string())?;
    let original_root = original
        .map(|content| {
            json5::from_str::<serde_json::Value>(content)
                .map_err(|_| "Invalid original OpenClaw configuration format".to_string())?
                .as_object()
                .cloned()
                .ok_or_else(|| "Original OpenClaw configuration root must be an object".to_string())
        })
        .transpose()?;
    let original_models = original_root
        .as_ref()
        .and_then(|root| root.get("models"))
        .and_then(serde_json::Value::as_object);
    if root.get("models").is_some_and(serde_json::Value::is_object) {
        let models = root
            .get_mut("models")
            .and_then(serde_json::Value::as_object_mut)
            .expect("OpenClaw models were checked as an object");
        restore_json_key(models, original_models, "mode");
        let original_providers = original_models
            .and_then(|models| models.get("providers"))
            .and_then(serde_json::Value::as_object);
        if models
            .get("providers")
            .is_some_and(serde_json::Value::is_object)
        {
            let providers = models
                .get_mut("providers")
                .and_then(serde_json::Value::as_object_mut)
                .expect("OpenClaw providers were checked as an object");
            let original_managed = original_providers
                .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
                .and_then(serde_json::Value::as_object);
            if providers
                .get(MANAGED_AGENT_PROVIDER_ID)
                .is_some_and(serde_json::Value::is_object)
            {
                let managed = providers
                    .get_mut(MANAGED_AGENT_PROVIDER_ID)
                    .and_then(serde_json::Value::as_object_mut)
                    .expect("OpenClaw managed provider was checked as an object");
                for key in ["baseUrl", "apiKey", "api", "models"] {
                    restore_json_key(managed, original_managed, key);
                }
                if managed.is_empty() && original_managed.is_none() {
                    providers.remove(MANAGED_AGENT_PROVIDER_ID);
                }
            } else if let Some(original_managed) = original_providers
                .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
                .cloned()
            {
                providers.insert(MANAGED_AGENT_PROVIDER_ID.to_string(), original_managed);
            }
            if providers.is_empty() && original_providers.is_none() {
                models.remove("providers");
            }
        } else {
            restore_json_key(models, original_models, "providers");
        }
        if models.is_empty() && original_models.is_none() {
            root.remove("models");
        }
    } else {
        restore_json_key(&mut root, original_root.as_ref(), "models");
    }

    let original_defaults = original_root
        .as_ref()
        .and_then(|root| root.get("agents"))
        .and_then(|agents| agents.get("defaults"))
        .and_then(serde_json::Value::as_object);
    if let Some(defaults) = root
        .get_mut("agents")
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|agents| agents.get_mut("defaults"))
        .and_then(serde_json::Value::as_object_mut)
    {
        let original_model = original_defaults
            .and_then(|defaults| defaults.get("model"))
            .and_then(serde_json::Value::as_object);
        if defaults
            .get("model")
            .is_some_and(serde_json::Value::is_object)
        {
            let model = defaults
                .get_mut("model")
                .and_then(serde_json::Value::as_object_mut)
                .expect("OpenClaw default model was checked as an object");
            restore_json_key(model, original_model, "primary");
            if model.is_empty() && original_model.is_none() {
                defaults.remove("model");
            }
        } else {
            restore_json_key(defaults, original_defaults, "model");
        }

        let original_catalog = original_defaults
            .and_then(|defaults| defaults.get("models"))
            .and_then(serde_json::Value::as_object);
        if defaults
            .get("models")
            .is_some_and(serde_json::Value::is_object)
        {
            let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
            let catalog = defaults
                .get_mut("models")
                .and_then(serde_json::Value::as_object_mut)
                .expect("OpenClaw model catalog was checked as an object");
            catalog.retain(|name, _| !name.starts_with(&prefix));
            if let Some(original_catalog) = original_catalog {
                catalog.extend(
                    original_catalog
                        .iter()
                        .filter(|(name, _)| name.starts_with(&prefix))
                        .map(|(name, value)| (name.clone(), value.clone())),
                );
            }
            if catalog.is_empty() && original_catalog.is_none() {
                defaults.remove("models");
            }
        } else {
            restore_json_key(defaults, original_defaults, "models");
        }
    }
    let original_agents = original_root
        .as_ref()
        .and_then(|root| root.get("agents"))
        .and_then(serde_json::Value::as_object);
    if let Some(agents) = root
        .get_mut("agents")
        .and_then(serde_json::Value::as_object_mut)
    {
        let remove_defaults = agents
            .get("defaults")
            .and_then(serde_json::Value::as_object)
            .is_some_and(serde_json::Map::is_empty)
            && original_defaults.is_none();
        if remove_defaults {
            agents.remove("defaults");
        }
        if agents.is_empty() && original_agents.is_none() {
            root.remove("agents");
        }
    }
    if root.is_empty() && original.is_none() {
        return Ok(None);
    }
    let rendered = render_agent_json(root, "Restored OpenClaw configuration")?;
    let comments = extract_json5_comments(current);
    Ok(Some(if comments.is_empty() {
        rendered
    } else {
        format!("{}\n{rendered}", comments.join("\n"))
    }))
}

pub(crate) fn restore_yaml_key(
    current: &mut serde_norway::Mapping,
    original: Option<&serde_norway::Mapping>,
    key: &str,
) {
    if let Some(value) = original.and_then(|root| root.get(yaml_key(key))).cloned() {
        current.insert(yaml_key(key), value);
    } else {
        current.remove(yaml_key(key));
    }
}

pub(crate) fn build_restored_hermes_config(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let mut document = yaml_serde_edit::YamlValue::parse(current)
        .map_err(|_| "Invalid current Hermes configuration format".to_string())?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Current Hermes configuration root must be a mapping".to_string())?;
    let original_value = original
        .map(|content| {
            serde_norway::from_str::<serde_norway::Value>(content)
                .map_err(|_| "Invalid original Hermes configuration format".to_string())
        })
        .transpose()?;
    let original_root = original_value
        .as_ref()
        .and_then(serde_norway::Value::as_mapping);
    let original_managed = original_root
        .and_then(|root| root.get(yaml_key("custom_providers")))
        .and_then(serde_norway::Value::as_sequence)
        .and_then(|providers| {
            providers.iter().find(|provider| {
                provider.get("name").and_then(serde_norway::Value::as_str)
                    == Some(MANAGED_AGENT_PROVIDER_ID)
            })
        });
    if let Some(providers) = root
        .get_mut(yaml_key("custom_providers"))
        .and_then(serde_norway::Value::as_sequence_mut)
    {
        let current_managed = providers
            .iter()
            .find(|provider| {
                provider.get("name").and_then(serde_norway::Value::as_str)
                    == Some(MANAGED_AGENT_PROVIDER_ID)
            })
            .and_then(serde_norway::Value::as_mapping)
            .cloned();
        providers.retain(|provider| {
            provider.get("name").and_then(serde_norway::Value::as_str)
                != Some(MANAGED_AGENT_PROVIDER_ID)
        });
        let mut managed = current_managed.unwrap_or_default();
        let original_managed = original_managed.and_then(serde_norway::Value::as_mapping);
        for key in ["name", "base_url", "api_key", "api_mode", "model", "models"] {
            restore_yaml_key(&mut managed, original_managed, key);
        }
        if original_managed.is_some() {
            providers.push(serde_norway::Value::Mapping(managed));
        } else if !managed.is_empty() {
            managed.insert(
                yaml_key("name"),
                serde_norway::Value::String(MANAGED_AGENT_PROVIDER_ID.to_string()),
            );
            providers.push(serde_norway::Value::Mapping(managed));
        }
        if providers.is_empty()
            && original_root
                .and_then(|root| root.get(yaml_key("custom_providers")))
                .is_none()
        {
            root.remove(yaml_key("custom_providers"));
        }
    } else {
        restore_yaml_key(root, original_root, "custom_providers");
    }
    let original_model = original_root
        .and_then(|root| root.get(yaml_key("model")))
        .and_then(serde_norway::Value::as_mapping);
    if let Some(model) = root
        .get_mut(yaml_key("model"))
        .and_then(serde_norway::Value::as_mapping_mut)
    {
        for key in ["default", "provider"] {
            restore_yaml_key(model, original_model, key);
        }
        if model.is_empty() && original_model.is_none() {
            root.remove(yaml_key("model"));
        }
    } else {
        restore_yaml_key(root, original_root, "model");
    }
    if root.is_empty() && original.is_none() {
        return Ok(None);
    }
    render_updated_core_yaml(&mut document, updated).map(Some)
}

pub(crate) fn restore_deepseek_harness_provider(
    current: &mut serde_norway::Mapping,
    original: Option<&serde_norway::Mapping>,
) -> Result<(), String> {
    let original_llm = original
        .and_then(|root| yaml_mapping_value(root, "llm-pi-ai"))
        .and_then(serde_norway::Value::as_mapping);
    let original_providers = original_llm
        .and_then(|llm| yaml_mapping_value(llm, "providers"))
        .and_then(serde_norway::Value::as_mapping);
    let original_provider = original_providers
        .and_then(|providers| yaml_mapping_value(providers, DEEPSEEK_HARNESS_PROVIDER_ID))
        .cloned();

    if let Some(original_provider) = original_provider {
        let llm = current
            .entry(yaml_key("llm-pi-ai"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| "Current DeepSeek Harness llm-pi-ai must be a mapping".to_string())?;
        let providers = llm
            .entry(yaml_key("providers"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| "Current DeepSeek Harness llm-pi-ai.providers must be a mapping".to_string())?;
        providers.insert(yaml_key(DEEPSEEK_HARNESS_PROVIDER_ID), original_provider);
    } else {
        let mut remove_llm = false;
        if let Some(llm) = current
            .get_mut(yaml_key("llm-pi-ai"))
            .and_then(serde_norway::Value::as_mapping_mut)
        {
            let mut remove_providers = false;
            if let Some(providers) = llm
                .get_mut(yaml_key("providers"))
                .and_then(serde_norway::Value::as_mapping_mut)
            {
                providers.remove(yaml_key(DEEPSEEK_HARNESS_PROVIDER_ID));
                remove_providers = providers.is_empty() && original_providers.is_none();
            }
            if remove_providers {
                llm.remove(yaml_key("providers"));
            }
            remove_llm = llm.is_empty() && original_llm.is_none();
        }
        if remove_llm {
            current.remove(yaml_key("llm-pi-ai"));
        }
    }
    Ok(())
}

pub(crate) fn build_restored_deepseek_harness_settings(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let original_root = parse_agent_yaml_mapping(original, "Original DeepSeek Harness settings")?;
    let rendered = render_agent_yaml_mapping_update(
        Some(current),
        "Current DeepSeek Harness settings",
        |root| {
            restore_deepseek_harness_provider(root, Some(&original_root))?;
            restore_yaml_key(root, Some(&original_root), "agent-default-model");
            Ok(())
        },
    )?;
    let root = parse_agent_yaml_mapping(Some(&rendered), "Restored DeepSeek Harness settings")?;
    Ok((!root.is_empty() || original.is_some()).then_some(rendered))
}

pub(crate) fn build_restored_deepseek_harness_credentials(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let original_root = parse_agent_yaml_mapping(original, "Original DeepSeek Harness credentials")?;
    let original_credential = deepseek_harness_original_credential(&original_root).cloned();
    let original_had_refs = yaml_mapping_value(&original_root, "refs").is_some();
    let rendered = render_agent_yaml_mapping_update(
        Some(current),
        "Current DeepSeek Harness credentials",
        |root| {
            let refs =
                deepseek_harness_credentials_refs_mut(root, "Current DeepSeek Harness credentials")?;
            if let Some(value) = original_credential {
                refs.insert(yaml_key(DEEPSEEK_HARNESS_CREDENTIAL), value);
            } else {
                refs.remove(yaml_key(DEEPSEEK_HARNESS_CREDENTIAL));
            }
            let remove_refs = refs.is_empty() && !original_had_refs;
            if remove_refs {
                root.remove(yaml_key("refs"));
            }
            Ok(())
        },
    )?;
    let root = parse_agent_yaml_mapping(Some(&rendered), "Restored DeepSeek Harness credentials")?;
    if deepseek_harness_credentials_document_is_empty(&root) {
        if let Some(original) = original.filter(|_| original_root.is_empty()) {
            return Ok(Some(original.to_string()));
        }
        if original.is_none() {
            return Ok(None);
        }
    }
    Ok(Some(rendered))
}

pub(crate) fn agent_config_semantically_equal(
    client: AgentClient,
    actual: &str,
    expected: &str,
) -> bool {
    match client {
        AgentClient::Codex | AgentClient::KimiCode | AgentClient::GrokBuild => {
            toml::from_str::<toml::Value>(actual).ok()
                == toml::from_str::<toml::Value>(expected).ok()
        }
        AgentClient::OpenCode | AgentClient::OpenClaw => {
            json5::from_str::<serde_json::Value>(actual).ok()
                == json5::from_str::<serde_json::Value>(expected).ok()
        }
        AgentClient::Hermes | AgentClient::Omp => {
            serde_norway::from_str::<serde_norway::Value>(actual).ok()
                == serde_norway::from_str::<serde_norway::Value>(expected).ok()
        }
        AgentClient::DeepSeekHarness => {
            serde_norway::from_str::<serde_norway::Value>(actual).ok()
                == serde_norway::from_str::<serde_norway::Value>(expected).ok()
        }
        _ => {
            serde_json::from_str::<serde_json::Value>(actual).ok()
                == serde_json::from_str::<serde_json::Value>(expected).ok()
        }
    }
}

pub(crate) fn build_agent_session_restored_bytes(
    client: AgentClient,
    paths: &[PathBuf],
    path: &Path,
    current: Option<&[u8]>,
    original: Option<&[u8]>,
) -> Result<Option<Vec<u8>>, String> {
    build_agent_session_restored_bytes_with_preference(
        client, paths, path, current, original, true,
    )
}

pub(crate) fn build_agent_session_restored_bytes_with_preference(
    client: AgentClient,
    paths: &[PathBuf],
    path: &Path,
    current: Option<&[u8]>,
    original: Option<&[u8]>,
    prefer_exact_original: bool,
) -> Result<Option<Vec<u8>>, String> {
    let Some(current) = current else {
        return Ok(original.map(ToOwned::to_owned));
    };
    if client == AgentClient::Codex && paths.first().is_none_or(|config| config != path) {
        return Ok(original.map(ToOwned::to_owned));
    }
    let current = std::str::from_utf8(current)
        .map_err(|_| format!("Current agent configuration is not UTF-8 text: {}", path_to_string(path)))?;
    let original_bytes = original;
    let original = original_bytes
        .map(|bytes| {
            std::str::from_utf8(bytes)
                .map_err(|_| format!("Original agent configuration is not UTF-8 text: {}", path_to_string(path)))
        })
        .transpose()?;
    let restored = match client {
        AgentClient::ClaudeCode => build_restored_claude_code_config(current, original)?,
        AgentClient::ClaudeDesktop => {
            let index = paths
                .iter()
                .position(|candidate| candidate == path)
                .ok_or_else(|| "Claude Desktop restoration path mismatch".to_string())?;
            build_restored_claude_desktop_config(index, current, original)?
        }
        AgentClient::Codex => build_restored_codex_agent_config(Some(current), original)?,
        AgentClient::OpenCode => build_restored_opencode_config(current, original)?,
        AgentClient::OpenClaw => build_restored_openclaw_config(current, original)?,
        AgentClient::Hermes => build_restored_hermes_config(current, original)?,
        AgentClient::DeepSeekHarness => {
            let index = paths
                .iter()
                .position(|candidate| candidate == path)
                .ok_or_else(|| "DeepSeek Harness restoration path mismatch".to_string())?;
            match index {
                0 => build_restored_deepseek_harness_settings(current, original)?,
                1 => build_restored_deepseek_harness_credentials(current, original)?,
                _ => return Err("Invalid DeepSeek Harness restoration path index".to_string()),
            }
        }
        AgentClient::ZCode => build_restored_zcode_provider_config(current, original)?,
        AgentClient::WorkBuddy => build_restored_workbuddy_config(current, original)?,
        AgentClient::AntigravityCli => restore_antigravity_config(client, path, current, original)?,
        AgentClient::CopilotCli | AgentClient::VscodeCopilot => restore_copilot_config(client, path, current, original)?,
        AgentClient::KimiCode => build_restored_kimi_code_config(current, original)?,
        AgentClient::GrokBuild => build_restored_grok_build_config(current, original)?,
        AgentClient::Omp => {
            let index = paths
                .iter()
                .position(|candidate| candidate == path)
                .ok_or_else(|| "Oh My Pi restoration path mismatch".to_string())?;
            match index {
                0 => build_restored_omp_models(current, original)?,
                1 => build_restored_omp_settings(current, original)?,
                _ => return Err("Invalid Oh My Pi restoration path index".to_string()),
            }
        }
    };
    if prefer_exact_original {
        if let (Some(restored), Some(original), Some(original_bytes)) =
            (restored.as_deref(), original, original_bytes)
        {
            if agent_config_semantically_equal(client, restored, original) {
                return Ok(Some(original_bytes.to_vec()));
            }
        }
    }
    Ok(restored.map(String::into_bytes))
}
