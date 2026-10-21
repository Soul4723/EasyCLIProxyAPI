use super::*;

pub(crate) fn build_claude_desktop_deployment_config(
    existing: Option<&str>,
) -> Result<String, String> {
    let mut root = parse_agent_json_object(existing, "Claude Desktop configuration")?;
    root.insert("deploymentMode".to_string(), serde_json::json!("3p"));
    render_agent_json(root, "Claude Desktop configuration")
}

pub(crate) fn build_claude_desktop_profile(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    models: &[AgentModelOption],
    mappings: Option<&ClaudeDesktopModelMappings>,
) -> Result<String, String> {
    let mut root = parse_agent_json_object(existing, "Claude Desktop gateway configuration")?;
    root.insert(
        "disableDeploymentModeChooser".to_string(),
        serde_json::json!(true),
    );
    root.insert(
        "inferenceGatewayApiKey".to_string(),
        serde_json::json!(api_key),
    );
    root.insert(
        "inferenceGatewayAuthScheme".to_string(),
        serde_json::json!("bearer"),
    );
    root.insert(
        "inferenceGatewayBaseUrl".to_string(),
        serde_json::json!(base_url),
    );
    root.insert(
        "inferenceProvider".to_string(),
        serde_json::json!("gateway"),
    );
    let mappings = mappings
        .cloned()
        .unwrap_or_else(|| ClaudeDesktopModelMappings::all(model));
    let inference_models = if let Some(entries) = &mappings.desktop_models {
        validate_claude_desktop_entries(entries)?;
        let mut families = HashSet::new();
        entries
            .iter()
            .map(|entry| {
                let mut value = claude_desktop_inference_model(
                    entry.model_id(),
                    entry.source_or_alias(),
                    entry.context_1m,
                    models,
                );
                value["name"] = serde_json::json!(entry.model_id());
                value["labelOverride"] = serde_json::json!(entry.source_or_alias());
                if let Some(tier) = claude_desktop_family_tier(entry.model_id()) {
                    value["isFamilyDefault"] = serde_json::json!(families.insert(tier));
                }
                value
            })
            .collect()
    } else {
        vec![
            claude_desktop_inference_model(
                CLAUDE_DESKTOP_OPUS_MODEL_ID,
                &mappings.opus,
                mappings.opus_1m,
                models,
            ),
            claude_desktop_inference_model(
                CLAUDE_DESKTOP_SONNET_MODEL_ID,
                &mappings.sonnet,
                mappings.sonnet_1m,
                models,
            ),
            claude_desktop_inference_model(
                CLAUDE_DESKTOP_HAIKU_MODEL_ID,
                &mappings.haiku,
                mappings.haiku_1m,
                models,
            ),
        ]
    };
    let mut deduplicated_models = Vec::<serde_json::Value>::with_capacity(inference_models.len());
    for entry in inference_models {
        let Some(name) = entry.get("name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let existing = deduplicated_models.iter_mut().find(|existing| {
            existing
                .get("name")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|existing_name| existing_name.eq_ignore_ascii_case(name))
        });
        if let Some(existing) = existing {
            if entry.get("supports1m").and_then(serde_json::Value::as_bool) == Some(true) {
                *existing = entry;
            }
        } else {
            deduplicated_models.push(entry);
        }
    }
    root.insert(
        "inferenceModels".to_string(),
        serde_json::Value::Array(deduplicated_models),
    );
    render_agent_json(root, "Claude Desktop gateway configuration")
}

pub(crate) fn claude_desktop_inference_model(
    route_model: &str,
    source_model: &str,
    enable_1m: bool,
    models: &[AgentModelOption],
) -> serde_json::Value {
    let use_source = claude_desktop_uses_source_directly(source_model, models);
    let mut entry = serde_json::Map::new();
    entry.insert(
        "name".to_string(),
        serde_json::json!(if use_source {
            source_model
        } else {
            route_model
        }),
    );
    if !use_source {
        entry.insert("labelOverride".to_string(), serde_json::json!(source_model));
    }
    if let Some(tier) = claude_desktop_family_tier(route_model) {
        entry.insert("anthropicFamilyTier".to_string(), serde_json::json!(tier));
        entry.insert("isFamilyDefault".to_string(), serde_json::json!(true));
    }
    if enable_1m {
        entry.insert("supports1m".to_string(), serde_json::json!(true));
        entry.insert("prefer1m".to_string(), serde_json::json!(true));
    }
    serde_json::Value::Object(entry)
}

pub(crate) fn claude_desktop_family_tier(route_model: &str) -> Option<&'static str> {
    let lowered = route_model.to_ascii_lowercase();
    if lowered.starts_with("claude-opus-") || lowered.contains("-opus-")
        || route_model.eq_ignore_ascii_case(CLAUDE_DESKTOP_OPUS_MODEL_ID)
        || route_model.eq_ignore_ascii_case(LEGACY_CLAUDE_DESKTOP_MODEL_IDS[0])
    {
        Some("opus")
    } else if lowered.starts_with("claude-sonnet-") || lowered.contains("-sonnet-")
        || route_model.eq_ignore_ascii_case(CLAUDE_DESKTOP_SONNET_MODEL_ID)
        || route_model.eq_ignore_ascii_case(LEGACY_CLAUDE_DESKTOP_MODEL_IDS[1])
    {
        Some("sonnet")
    } else if lowered.starts_with("claude-haiku-") || lowered.contains("-haiku-")
        || route_model.eq_ignore_ascii_case(CLAUDE_DESKTOP_HAIKU_MODEL_ID)
        || route_model.eq_ignore_ascii_case(LEGACY_CLAUDE_DESKTOP_MODEL_IDS[2])
    {
        Some("haiku")
    } else {
        None
    }
}

pub(crate) fn build_claude_desktop_meta(existing: Option<&str>) -> Result<String, String> {
    let mut root = parse_agent_json_object(existing, "Claude Desktop configuration index")?;
    repair_claude_desktop_meta_names(&mut root);
    let entries = ensure_json_array_entry(&mut root, "entries");
    let mut managed_entry = None;
    let mut retained_entries = Vec::with_capacity(entries.len());
    for entry in std::mem::take(entries) {
        match entry.get("id").and_then(serde_json::Value::as_str) {
            Some(id) if id == CLAUDE_DESKTOP_PROFILE_ID => {
                if managed_entry.is_none() {
                    managed_entry = entry.as_object().cloned();
                }
            }
            Some(_) => retained_entries.push(entry),
            None => {}
        }
    }
    let mut managed_entry = managed_entry.unwrap_or_default();
    managed_entry.insert(
        "id".to_string(),
        serde_json::json!(CLAUDE_DESKTOP_PROFILE_ID),
    );
    managed_entry.insert("name".to_string(), serde_json::json!("EasyCLIProxyAPI"));
    retained_entries.push(serde_json::Value::Object(managed_entry));
    *entries = retained_entries;
    root.insert(
        "appliedId".to_string(),
        serde_json::json!(CLAUDE_DESKTOP_PROFILE_ID),
    );
    render_agent_json(root, "Claude Desktop configuration index")
}

pub(crate) fn repair_claude_desktop_meta_names(root: &mut serde_json::Map<String, serde_json::Value>) {
    let Some(entries) = root.get_mut("entries").and_then(serde_json::Value::as_array_mut) else {
        return;
    };
    for entry in entries {
        let Some(id) = entry.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if entry.get("name").and_then(serde_json::Value::as_str).is_none() {
            let name = format!("Configuration {id}");
            entry["name"] = serde_json::json!(name);
        }
    }
}
