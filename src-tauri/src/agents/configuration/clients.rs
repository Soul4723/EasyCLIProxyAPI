use super::*;

pub(crate) fn build_opencode_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    let mut root = parse_agent_json5_object(existing, "OpenCode opencode.json")?;
    root.entry("$schema".to_string())
        .or_insert_with(|| serde_json::json!("https://opencode.ai/config.json"));
    let providers = ensure_json_object_entry(&mut root, "provider");
    let models = ordered_agent_models(available_models, model)
        .into_iter()
        .map(|model| {
            let display_name = model.alias.as_deref().unwrap_or(&model.name).to_string();
            (model.name, serde_json::json!({ "name": display_name }))
        })
        .collect::<serde_json::Map<_, _>>();
    let managed_provider = ensure_json_object_entry(providers, MANAGED_AGENT_PROVIDER_ID);
    managed_provider.insert(
        "npm".to_string(),
        serde_json::json!("@ai-sdk/openai-compatible"),
    );
    managed_provider.insert("name".to_string(), serde_json::json!("EasyCLIProxyAPI"));
    let options = ensure_json_object_entry(managed_provider, "options");
    options.insert("baseURL".to_string(), serde_json::json!(base_url));
    options.insert("apiKey".to_string(), serde_json::json!(api_key));
    managed_provider.insert("models".to_string(), serde_json::Value::Object(models));
    root.insert(
        "model".to_string(),
        serde_json::json!(format!("{MANAGED_AGENT_PROVIDER_ID}/{model}")),
    );
    let rendered = render_agent_json(root, "OpenCode configuration")?;
    let comments = existing.map(extract_json5_comments).unwrap_or_default();
    if comments.is_empty() {
        Ok(rendered)
    } else {
        Ok(format!("{}\n{rendered}", comments.join("\n")))
    }
}

pub(crate) fn build_zcode_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    let mut root = parse_agent_json_object(existing, "ZCode provider_config.json")?;
    if root.get("schemaVersion").is_some_and(|version| version != 1) {
        return Err("Unsupported ZCode provider configuration schemaVersion".to_string());
    }
    root.insert("schemaVersion".to_string(), serde_json::json!(1));
    let config = ensure_json_object_entry(&mut root, "config");
    let provider_rules = ensure_json_object_entry(config, "providerConfigRules");
    let rules = provider_rules
        .entry("providerRules")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or("ZCode providerRules must be an array")?;
    let managed_index = rules.iter().position(|rule| {
        rule.get("providerId").and_then(serde_json::Value::as_str)
            == Some(MANAGED_AGENT_PROVIDER_ID)
    });
    let previous = managed_index.and_then(|index| rules.get(index));
    let mut managed = previous.cloned().unwrap_or_else(|| serde_json::json!({}));
    let managed_obj = managed.as_object_mut().ok_or("ZCode managed provider must be an object")?;
    managed_obj.insert("providerId".to_string(), serde_json::json!(MANAGED_AGENT_PROVIDER_ID));
    managed_obj.insert("providerName".to_string(), serde_json::json!("EasyCLIProxyAPI"));
    managed_obj.insert("enabled".to_string(), serde_json::json!(true));
    let provider_config = ensure_json_object_entry(managed_obj, "config");
    provider_config.insert("group".to_string(), serde_json::json!("standard-personal"));
    let access = ensure_json_object_entry(provider_config, "access");
    access.insert("type".to_string(), serde_json::json!("api-key"));
    access.insert("apiKey".to_string(), serde_json::json!(api_key));
    let api = ensure_json_object_entry(provider_config, "api");
    api.insert("type".to_string(), serde_json::json!("anthropic-messages"));
    api.insert("baseUrl".to_string(), serde_json::json!(base_url));
    let ordered = ordered_agent_models(available_models, model);
    let model_names = ordered.iter().map(|option| option.name.as_str()).collect::<Vec<_>>();
    provider_config.insert("personalModelIds".to_string(), serde_json::json!(model_names));
    provider_config.insert("modelOrder".to_string(), serde_json::json!(model_names));
    rules.retain(|rule| {
        rule.get("providerId").and_then(serde_json::Value::as_str)
            != Some(MANAGED_AGENT_PROVIDER_ID)
    });
    rules.insert(managed_index.unwrap_or(rules.len()).min(rules.len()), managed);

    let model_rules = ensure_json_object_entry(config, "modelConfigRules");
    let manual_rules = model_rules
        .entry("manualProviderModelRules")
        .or_insert_with(|| serde_json::json!([]))
        .as_array()
        .ok_or("ZCode manualProviderModelRules must be an array")?;
    let existing_manual_rules = manual_rules.iter().filter_map(|rule| {
        if rule.get("providerId").and_then(serde_json::Value::as_str)
            != Some(MANAGED_AGENT_PROVIDER_ID) {
            return None;
        }
        Some((rule.get("modelId")?.as_str()?.to_string(), rule.clone()))
    }).collect::<std::collections::HashMap<_, _>>();
    let first_manual_index = manual_rules.iter().position(|rule| {
        rule.get("providerId").and_then(serde_json::Value::as_str)
            == Some(MANAGED_AGENT_PROVIDER_ID)
    }).unwrap_or(manual_rules.len());
    let rules = model_rules
        .entry("providerModelRules")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or("ZCode providerModelRules must be an array")?;
    let existing_rules = rules.iter().filter_map(|rule| {
        if rule.get("providerId").and_then(serde_json::Value::as_str)
            != Some(MANAGED_AGENT_PROVIDER_ID) {
            return None;
        }
        Some((rule.get("modelId")?.as_str()?.to_string(), rule.clone()))
    }).collect::<std::collections::HashMap<_, _>>();
    let first_managed_index = rules.iter().position(|rule| {
        rule.get("providerId").and_then(serde_json::Value::as_str)
            == Some(MANAGED_AGENT_PROVIDER_ID)
    }).unwrap_or(rules.len());
    rules.retain(|rule| {
        rule.get("providerId").and_then(serde_json::Value::as_str)
            != Some(MANAGED_AGENT_PROVIDER_ID)
    });
    let mut manual_updates = Vec::new();
    for option in ordered {
        let manual = existing_manual_rules.get(&option.name);
        if option.context_window.is_none()
            && manual.is_none()
            && !existing_rules.contains_key(&option.name)
        {
            continue;
        }
        let mut rule = manual.or_else(|| existing_rules.get(&option.name))
            .cloned().unwrap_or_else(|| serde_json::json!({}));
        let entry = rule.as_object_mut().ok_or("ZCode model rule must be an object")?;
        entry.insert("providerId".to_string(), serde_json::json!(MANAGED_AGENT_PROVIDER_ID));
        entry.insert("modelId".to_string(), serde_json::json!(option.name));
        let properties = ensure_json_object_entry(ensure_json_object_entry(entry, "config"), "properties");
        if let Some(context_window) = option.context_window {
            properties.insert("contextWindow".to_string(), serde_json::json!(context_window));
        } else if manual.is_none() {
            // Smart rules inherit ZCode defaults; manual rules require a complete
            // config, including contextWindow, even when CPA has no runtime limit.
            properties.remove("contextWindow");
        }
        if properties.is_empty() {
            entry.get_mut("config").and_then(serde_json::Value::as_object_mut)
                .expect("ZCode model config was created").remove("properties");
        }
        if manual.is_some() {
            manual_updates.push(rule);
        } else {
            rules.insert((first_managed_index + rules.iter().filter(|entry| {
                entry.get("providerId").and_then(serde_json::Value::as_str)
                    == Some(MANAGED_AGENT_PROVIDER_ID)
            }).count()).min(rules.len()), rule);
        }
    }
    let manual_rules = model_rules.get_mut("manualProviderModelRules")
        .and_then(serde_json::Value::as_array_mut)
        .expect("ZCode manual model rules were checked as an array");
    manual_rules.retain(|rule| {
        rule.get("providerId").and_then(serde_json::Value::as_str)
            != Some(MANAGED_AGENT_PROVIDER_ID)
    });
    for (offset, rule) in manual_updates.into_iter().enumerate() {
        manual_rules.insert((first_manual_index + offset).min(manual_rules.len()), rule);
    }
    if let Some(provider_order) = config.get_mut("providerOrder") {
        let provider_order = provider_order.as_array_mut()
            .ok_or("ZCode providerOrder must be an array")?;
        if !provider_order.iter().any(|value| value.as_str() == Some(MANAGED_AGENT_PROVIDER_ID)) {
            provider_order.push(serde_json::json!(MANAGED_AGENT_PROVIDER_ID));
        }
    }
    let mut selection = serde_json::json!({
        "providerId": MANAGED_AGENT_PROVIDER_ID,
        "modelId": model,
    });
    if let Some(previous) = config.get("defaultModelSelection") {
        if previous.get("providerId").and_then(serde_json::Value::as_str)
            == Some(MANAGED_AGENT_PROVIDER_ID)
            && previous.get("modelId").and_then(serde_json::Value::as_str) == Some(model)
        {
            if let Some(options) = previous.get("options") {
                selection["options"] = options.clone();
            }
        }
    }
    config.insert("defaultModelSelection".to_string(), selection);
    render_agent_json(root, "ZCode provider configuration")
}

pub(crate) fn ensure_toml_child_table<'a>(
    parent: &'a mut toml_edit::Table,
    key: &str,
) -> &'a mut toml_edit::Table {
    use toml_edit::{Item, Table};

    if !parent.get(key).is_some_and(Item::is_table) {
        parent.remove(key);
        parent.insert(key, Item::Table(Table::new()));
    }
    parent
        .get_mut(key)
        .and_then(Item::as_table_mut)
        .expect("inserted TOML table must remain a table")
}

pub(crate) fn managed_model_alias(model: &str) -> String {
    format!("{MANAGED_AGENT_PROVIDER_ID}/{model}")
}


pub(crate) fn build_omp_models_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
) -> Result<String, String> {
    render_agent_yaml_mapping_update(existing, "Oh My Pi models.yml", |root| {
        let providers = root
            .entry(yaml_key("providers"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()));
        let providers = providers
            .as_mapping_mut()
            .ok_or_else(|| "Oh My Pi providers must be a YAML mapping".to_string())?;
        let mut provider = serde_norway::Mapping::new();
        provider.insert(yaml_key("baseUrl"), serde_norway::Value::String(base_url.to_string()));
        provider.insert(
            yaml_key("apiKey"),
            serde_norway::Value::String(api_key.to_string()),
        );
        provider.insert(
            yaml_key("api"),
            serde_norway::Value::String(OMP_AGENT_API.to_string()),
        );
        let mut discovery = serde_norway::Mapping::new();
        discovery.insert(
            yaml_key("type"),
            serde_norway::Value::String("openai-models-list".to_string()),
        );
        provider.insert(yaml_key("discovery"), serde_norway::Value::Mapping(discovery));
        providers.insert(
            yaml_key(OMP_AGENT_PROVIDER_ID),
            serde_norway::Value::Mapping(provider),
        );
        Ok(())
    })
}

pub(crate) fn build_omp_settings_config(
    existing: Option<&str>,
    model: &str,
) -> Result<String, String> {
    render_agent_yaml_mapping_update(existing, "Oh My Pi config.yml", |root| {
        let roles = root
            .entry(yaml_key("modelRoles"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()));
        let roles = roles
            .as_mapping_mut()
            .ok_or_else(|| "Oh My Pi modelRoles must be a YAML mapping".to_string())?;
        roles.insert(
            yaml_key("default"),
            serde_norway::Value::String(format!("{OMP_AGENT_PROVIDER_ID}/{model}")),
        );
        Ok(())
    })
}

pub(crate) fn prepare_omp_managed_removal(paths: &[PathBuf]) -> Result<Images, String> {
    if paths.len() != 2 {
        return Err("Invalid number of Oh My Pi configuration paths".to_string());
    }
    let mut updates = Vec::new();
    if paths[0].is_file() {
        let content = fs::read_to_string(&paths[0]).map_err(|error| {
            format!("Failed to read Oh My Pi models.yml {}: {error}", path_to_string(&paths[0]))
        })?;
        let rendered = render_agent_yaml_mapping_update(Some(&content), "Oh My Pi models.yml", |root| {
            let mut remove_providers = false;
            if let Some(providers) = root
                .get_mut(yaml_key("providers"))
                .and_then(serde_norway::Value::as_mapping_mut)
            {
                providers.remove(yaml_key(OMP_AGENT_PROVIDER_ID));
                remove_providers = providers.is_empty();
            }
            if remove_providers {
                root.remove(yaml_key("providers"));
            }
            Ok(())
        })?;
        let root = parse_agent_yaml_mapping(Some(&rendered), "Oh My Pi models.yml")?;
        updates.push((
            paths[0].clone(),
            (!root.is_empty()).then(|| rendered.into_bytes()),
        ));
    }
    if paths[1].is_file() {
        let content = fs::read_to_string(&paths[1]).map_err(|error| {
            format!("Failed to read Oh My Pi config.yml {}: {error}", path_to_string(&paths[1]))
        })?;
        let rendered = render_agent_yaml_mapping_update(Some(&content), "Oh My Pi config.yml", |root| {
            let mut remove_roles = false;
            if let Some(roles) = root
                .get_mut(yaml_key("modelRoles"))
                .and_then(serde_norway::Value::as_mapping_mut)
            {
                if roles
                    .get(yaml_key("default"))
                    .and_then(serde_norway::Value::as_str)
                    .is_some_and(|value| value.starts_with(&format!("{OMP_AGENT_PROVIDER_ID}/")))
                {
                    roles.remove(yaml_key("default"));
                }
                remove_roles = roles.is_empty();
            }
            if remove_roles {
                root.remove(yaml_key("modelRoles"));
            }
            Ok(())
        })?;
        let root = parse_agent_yaml_mapping(Some(&rendered), "Oh My Pi config.yml")?;
        updates.push((
            paths[1].clone(),
            (!root.is_empty()).then(|| rendered.into_bytes()),
        ));
    }
    Ok(updates.into_iter().collect())
}

pub(crate) fn build_restored_omp_models(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let original_root = parse_agent_yaml_mapping(original, "Original Oh My Pi models.yml")?;
    let rendered = render_agent_yaml_mapping_update(Some(current), "Current Oh My Pi models.yml", |root| {
        let original_provider = yaml_mapping_value(&original_root, "providers")
            .and_then(serde_norway::Value::as_mapping)
            .and_then(|providers| yaml_mapping_value(providers, OMP_AGENT_PROVIDER_ID))
            .cloned();
        let providers = root
            .entry(yaml_key("providers"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()));
        let providers = providers
            .as_mapping_mut()
            .ok_or_else(|| "Oh My Pi providers must be a YAML mapping".to_string())?;
        if let Some(provider) = original_provider {
            providers.insert(yaml_key(OMP_AGENT_PROVIDER_ID), provider);
        } else {
            providers.remove(yaml_key(OMP_AGENT_PROVIDER_ID));
        }
        if providers.is_empty()
            && yaml_mapping_value(&original_root, "providers").is_none()
        {
            root.remove(yaml_key("providers"));
        }
        Ok(())
    })?;
    let root = parse_agent_yaml_mapping(Some(&rendered), "Restored Oh My Pi models.yml")?;
    Ok((!root.is_empty() || original.is_some()).then_some(rendered))
}

pub(crate) fn build_restored_omp_settings(
    current: &str,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    let original_root = parse_agent_yaml_mapping(original, "Original Oh My Pi config.yml")?;
    let rendered = render_agent_yaml_mapping_update(Some(current), "Current Oh My Pi config.yml", |root| {
        restore_yaml_key(root, Some(&original_root), "modelRoles");
        Ok(())
    })?;
    let root = parse_agent_yaml_mapping(Some(&rendered), "Restored Oh My Pi config.yml")?;
    Ok((!root.is_empty() || original.is_some()).then_some(rendered))
}

pub(crate) fn build_kimi_code_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    use toml_edit::{value, Array, Item, Table};

    let mut document = parse_codex_document(existing, "Kimi Code config.toml")?;
    set_codex_table_item(
        document.as_table_mut(),
        "default_model",
        value(managed_model_alias(model)),
    );

    let providers = ensure_toml_child_table(document.as_table_mut(), "providers");
    let provider = ensure_toml_child_table(providers, MANAGED_AGENT_PROVIDER_ID);
    set_codex_table_item(provider, "type", value("openai"));
    set_codex_table_item(provider, "base_url", value(base_url));
    set_codex_table_item(provider, "api_key", value(api_key));

    let models = ensure_toml_child_table(document.as_table_mut(), "models");
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let stale = models
        .iter()
        .map(|(key, _)| key.to_string())
        .filter(|key| key.starts_with(&prefix))
        .collect::<Vec<_>>();
    for key in stale {
        models.remove(&key);
    }
    for option in ordered_agent_models(available_models, model) {
        let mut entry = Table::new();
        entry.insert("provider", value(MANAGED_AGENT_PROVIDER_ID));
        entry.insert("model", value(option.name.clone()));
        entry.insert(
            "display_name",
            value(option.alias.as_deref().unwrap_or(&option.name)),
        );
        let context = option
            .context_window
            .unwrap_or(200_000)
            .min(i64::MAX as u64) as i64;
        entry.insert("max_context_size", value(context));
        let mut capabilities = Array::new();
        capabilities.push("tool_use");
        entry.insert("capabilities", value(capabilities));
        models.insert(&managed_model_alias(&option.name), Item::Table(entry));
    }
    let rendered = document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("Failed to validate Kimi Code configuration: {error}"))?;
    Ok(rendered)
}

pub(crate) fn build_grok_build_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    use toml_edit::{value, Item, Table};

    let mut document = parse_codex_document(existing, "Grok Build config.toml")?;
    let defaults = ensure_toml_child_table(document.as_table_mut(), "models");
    set_codex_table_item(defaults, "default", value(managed_model_alias(model)));

    let models = ensure_toml_child_table(document.as_table_mut(), "model");
    let prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let stale = models
        .iter()
        .map(|(key, _)| key.to_string())
        .filter(|key| key.starts_with(&prefix))
        .collect::<Vec<_>>();
    for key in stale {
        models.remove(&key);
    }
    for option in ordered_agent_models(available_models, model) {
        let mut entry = Table::new();
        entry.insert("model", value(option.name.clone()));
        entry.insert("base_url", value(base_url));
        entry.insert(
            "name",
            value(option.alias.as_deref().unwrap_or(&option.name)),
        );
        entry.insert("api_key", value(api_key));
        entry.insert("api_backend", value("chat_completions"));
        let context = option
            .context_window
            .unwrap_or(200_000)
            .min(i64::MAX as u64) as i64;
        entry.insert("context_window", value(context));
        models.insert(&managed_model_alias(&option.name), Item::Table(entry));
    }
    let rendered = document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("Failed to validate Grok Build configuration: {error}"))?;
    Ok(rendered)
}

pub(crate) fn build_openclaw_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    let mut root = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => json5::from_str::<serde_json::Value>(value)
            .map_err(|_| "Invalid OpenClaw openclaw.json format".to_string())?,
        None => serde_json::json!({}),
    };
    let root = root
        .as_object_mut()
        .ok_or_else(|| "OpenClaw openclaw.json root must be an object".to_string())?;
    let ordered_models = ordered_agent_models(available_models, model);
    let models = ensure_json_object_entry(root, "models");
    models
        .entry("mode".to_string())
        .or_insert_with(|| serde_json::json!("merge"));
    let providers = ensure_json_object_entry(models, "providers");
    let managed_provider = ensure_json_object_entry(providers, MANAGED_AGENT_PROVIDER_ID);
    let existing_model_entries = managed_provider
        .get("models")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    managed_provider.insert("baseUrl".to_string(), serde_json::json!(base_url));
    managed_provider.insert("apiKey".to_string(), serde_json::json!(api_key));
    managed_provider.insert("api".to_string(), serde_json::json!("openai-completions"));
    managed_provider.insert(
        "models".to_string(),
        serde_json::Value::Array(
            ordered_models
                .iter()
                .map(|model| {
                    let mut entry = existing_model_entries
                        .iter()
                        .find(|entry| {
                            entry.get("id").and_then(serde_json::Value::as_str)
                                == Some(model.name.as_str())
                        })
                        .and_then(serde_json::Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    entry.insert("id".to_string(), serde_json::json!(model.name.clone()));
                    entry.insert(
                        "name".to_string(),
                        serde_json::json!(model.alias.as_deref().unwrap_or(&model.name)),
                    );
                    if let Some(context_window) = model.context_window {
                        entry.insert(
                            "contextWindow".to_string(),
                            serde_json::json!(context_window),
                        );
                    }
                    if let Some(input_modalities) = model.input_modalities.as_ref() {
                        entry.insert(
                            "input".to_string(),
                            serde_json::json!(input_modalities),
                        );
                    }
                    if let Some(max_tokens) = model
                        .harness_metadata
                        .as_ref()
                        .and_then(|metadata| metadata.get("maxTokens"))
                    {
                        entry
                            .entry("maxTokens".to_string())
                            .or_insert_with(|| max_tokens.clone());
                    }
                    serde_json::Value::Object(entry)
                })
                .collect(),
        ),
    );
    let agents = ensure_json_object_entry(root, "agents");
    let defaults = ensure_json_object_entry(agents, "defaults");
    let default_model = ensure_json_object_entry(defaults, "model");
    default_model.insert(
        "primary".to_string(),
        serde_json::json!(format!("{MANAGED_AGENT_PROVIDER_ID}/{model}")),
    );
    let model_catalog = ensure_json_object_entry(defaults, "models");
    let managed_prefix = format!("{MANAGED_AGENT_PROVIDER_ID}/");
    let existing_catalog = model_catalog.clone();
    model_catalog.retain(|name, _| !name.starts_with(&managed_prefix));
    for model in &ordered_models {
        let name = format!("{MANAGED_AGENT_PROVIDER_ID}/{}", model.name);
        let mut entry = existing_catalog
            .get(&name)
            .and_then(serde_json::Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(alias) = model.alias.as_deref() {
            entry.insert("alias".to_string(), serde_json::json!(alias));
        } else {
            entry.remove("alias");
        }
        model_catalog.insert(name, serde_json::Value::Object(entry));
    }
    let rendered = render_agent_json(root.clone(), "OpenClaw configuration")?;
    let comments = existing.map(extract_json5_comments).unwrap_or_default();
    if comments.is_empty() {
        Ok(rendered)
    } else {
        Ok(format!("{}\n{rendered}", comments.join("\n")))
    }
}

pub(crate) fn extract_json5_comments(content: &str) -> Vec<String> {
    let bytes = content.as_bytes();
    let mut comments = Vec::new();
    let mut index = 0;
    let mut quote = None;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == active_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
            index += 1;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            let start = index;
            index += 2;
            while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') {
                index += 1;
            }
            comments.push(content[start..index].to_string());
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            let start = index;
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            index = (index + 2).min(bytes.len());
            comments.push(content[start..index].to_string());
            continue;
        }
        index += 1;
    }
    comments
}

pub(crate) fn ensure_yaml_mapping_entry<'a>(
    root: &'a mut serde_norway::Mapping,
    key: &str,
) -> &'a mut serde_norway::Mapping {
    let key_value = serde_norway::Value::String(key.to_string());
    if !root
        .get(&key_value)
        .is_some_and(|value| value.as_mapping().is_some())
    {
        root.insert(
            key_value.clone(),
            serde_norway::Value::Mapping(serde_norway::Mapping::new()),
        );
    }
    root.get_mut(&key_value)
        .and_then(serde_norway::Value::as_mapping_mut)
        .expect("mapping entry was just normalized")
}

pub(crate) fn ensure_yaml_sequence_entry<'a>(
    root: &'a mut serde_norway::Mapping,
    key: &str,
) -> &'a mut Vec<serde_norway::Value> {
    let key_value = serde_norway::Value::String(key.to_string());
    if !root
        .get(&key_value)
        .is_some_and(|value| value.as_sequence().is_some())
    {
        root.insert(key_value.clone(), serde_norway::Value::Sequence(Vec::new()));
    }
    root.get_mut(&key_value)
        .and_then(serde_norway::Value::as_sequence_mut)
        .expect("sequence entry was just normalized")
}

pub(crate) fn build_hermes_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    available_models: &[AgentModelOption],
) -> Result<String, String> {
    let original = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_norway::from_str::<serde_norway::Value>(value)
            .map_err(|_| "Invalid Hermes config.yaml format".to_string())?,
        None => serde_norway::Value::Mapping(serde_norway::Mapping::new()),
    };
    let mut root = original.clone();
    let mapping = root
        .as_mapping_mut()
        .ok_or_else(|| "Hermes config.yaml root must be a mapping".to_string())?;
    let dictionary_provider = mapping
        .get("providers")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|providers| {
            providers
                .iter()
                .find(|(key, provider)| {
                    key.as_str() == Some(MANAGED_AGENT_PROVIDER_ID)
                        || provider.get("name").and_then(serde_norway::Value::as_str)
                            == Some(MANAGED_AGENT_PROVIDER_ID)
                })
                .and_then(|(_, provider)| provider.as_mapping().cloned())
        });
    let providers = ensure_yaml_sequence_entry(mapping, "custom_providers");
    let mut managed_provider = None;
    let mut retained_providers = Vec::with_capacity(providers.len());
    for provider in std::mem::take(providers) {
        match provider.get("name").and_then(serde_norway::Value::as_str) {
            Some(name) if name == MANAGED_AGENT_PROVIDER_ID => {
                if managed_provider.is_none() {
                    managed_provider = provider.as_mapping().cloned();
                }
            }
            Some(_) => retained_providers.push(provider),
            None => {}
        }
    }
    let mut managed_provider = managed_provider.or(dictionary_provider);
    if let Some(provider) = managed_provider.as_mut() {
        for (legacy_key, current_key) in [
            ("baseUrl", "base_url"),
            ("apiKey", "api_key"),
            ("apiMode", "api_mode"),
            ("maxTokens", "max_tokens"),
            ("contextLength", "context_length"),
        ] {
            let legacy_key = serde_norway::Value::String(legacy_key.to_string());
            let current_key = serde_norway::Value::String(current_key.to_string());
            if provider.contains_key(&current_key) {
                provider.remove(&legacy_key);
            } else if let Some(value) = provider.remove(&legacy_key) {
                provider.insert(current_key, value);
            }
        }
    }
    let ordered_models = ordered_agent_models(available_models, model);
    let existing_model_metadata = managed_provider
        .as_ref()
        .and_then(|provider| provider.get("models"))
        .and_then(serde_norway::Value::as_mapping);
    let mut provider_models = serde_norway::Mapping::new();
    for model in &ordered_models {
        let model_key = serde_norway::Value::String(model.name.clone());
        let mut metadata = existing_model_metadata
            .and_then(|models| models.get(&model_key))
            .and_then(serde_norway::Value::as_mapping)
            .cloned()
            .unwrap_or_default();
        if let Some(context_window) = model.context_window {
            let value = serde_norway::to_value(context_window)
                .map_err(|error| format!("Failed to generate Hermes model metadata: {error}"))?;
            metadata.insert(
                serde_norway::Value::String("context_length".to_string()),
                value,
            );
        }
        provider_models.insert(model_key, serde_norway::Value::Mapping(metadata));
    }
    let mut canonical_provider = serde_norway::to_value(serde_json::json!({
        "name": MANAGED_AGENT_PROVIDER_ID,
        "base_url": base_url,
        "api_key": api_key,
        "api_mode": "chat_completions",
        "model": model,
        "models": {}
    }))
    .map_err(|error| format!("Failed to generate Hermes provider: {error}"))?;
    canonical_provider
        .as_mapping_mut()
        .ok_or_else(|| "Failed to generate Hermes provider: root is not a mapping".to_string())?
        .insert(
            serde_norway::Value::String("models".to_string()),
            serde_norway::Value::Mapping(provider_models),
        );
    let canonical_provider = canonical_provider
        .as_mapping()
        .ok_or_else(|| "Failed to generate Hermes provider: root is not a mapping".to_string())?;
    let mut managed_provider = managed_provider.unwrap_or_default();
    for (key, value) in canonical_provider {
        managed_provider.insert(key.clone(), value.clone());
    }
    retained_providers.push(serde_norway::Value::Mapping(managed_provider));
    *providers = retained_providers;
    let model_config = ensure_yaml_mapping_entry(mapping, "model");
    model_config.insert(
        serde_norway::Value::String("default".to_string()),
        serde_norway::Value::String(model.to_string()),
    );
    model_config.insert(
        serde_norway::Value::String("provider".to_string()),
        serde_norway::Value::String(MANAGED_AGENT_PROVIDER_ID.to_string()),
    );
    let rendered = if let Some(existing) = existing.filter(|value| !value.trim().is_empty()) {
        render_yaml_value_changes(existing, &original, &root)
            .or_else(|_| serde_norway::to_string(&root).map_err(|_| "Failed to generate Hermes configuration".to_string()))?
    } else {
        serde_norway::to_string(&root).map_err(|error| format!("Failed to generate Hermes configuration: {error}"))?
    };
    serde_norway::from_str::<serde_norway::Value>(&rendered)
        .map_err(|error| format!("Failed to validate Hermes configuration: {error}"))?;
    Ok(rendered)
}
