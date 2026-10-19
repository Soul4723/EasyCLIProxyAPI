use super::*;

pub(crate) fn build_claude_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    models: &[AgentModelOption],
    mappings: Option<&ClaudeDesktopModelMappings>,
) -> Result<String, String> {
    let mut root = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_json::from_str::<serde_json::Value>(value)
            .map_err(|_| "Invalid Claude Code settings.json format".to_string())?,
        None => serde_json::json!({}),
    };
    let root = root
        .as_object_mut()
        .ok_or_else(|| "Claude Code settings.json root must be an object".to_string())?;
    // Track only the compaction windows CPA owns so route changes and closing
    // the connection can remove them without deleting unrelated model settings.
    let previous_managed_models = root.get("env").and_then(serde_json::Value::as_object)
        .and_then(|env| env.get(CLAUDE_CODE_MANAGED_MODEL_SETTINGS_ENV))
        .and_then(serde_json::Value::as_str)
        .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
        .unwrap_or_default();
    let mappings = mappings
        .cloned()
        .unwrap_or_else(|| ClaudeDesktopModelMappings::all(model));
    let max_context_tokens = mappings.max_context_tokens;
    let model_settings = claude_code_model_settings(&mappings);
    let subagent_model = model_settings.haiku.clone();
    // Explicit/default session selections may switch roles, while Subagents may use
    // another model. A global Sonnet-derived effort override is wrong for both.
    let effort_level = if mappings.startup_model.is_none() && mappings.subagent_model.is_none() {
        claude_code_model_effort_level(models, &mappings.sonnet)?
    } else {
        None
    };
    let env = ensure_json_object_entry(root, "env");
    env.remove("ANTHROPIC_API_KEY");
    env.remove("CLAUDE_CODE_EFFORT_LEVEL");
    env.remove(CLAUDE_CODE_AUTO_MODE_SERVER_ENV);
    for (key, value) in [
        ("ANTHROPIC_BASE_URL", base_url),
        ("ANTHROPIC_AUTH_TOKEN", api_key),
        (
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            model_settings.haiku.as_str(),
        ),
        (
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            model_settings.sonnet.as_str(),
        ),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL", model_settings.opus.as_str()),
        (
            "ANTHROPIC_DEFAULT_FABLE_MODEL",
            model_settings.fable.as_str(),
        ),
    ] {
        env.insert(
            key.to_string(),
            serde_json::Value::String(value.to_string()),
        );
    }
    env.insert(
        "EASYCLIPROXY_MANAGE_CLAUDE_CODE_DEFAULT_MODEL".to_string(),
        serde_json::Value::String(if mappings.startup_model.as_ref().map_or(mappings.manage_default_model, |value| !value.trim().is_empty()) { "1" } else { "0" }.to_string()),
    );
    env.insert(
        "EASYCLIPROXY_MANAGE_CLAUDE_CODE_SUBAGENT_MODEL".to_string(),
        serde_json::Value::String(if mappings.subagent_model.as_ref().map_or(mappings.manage_subagent_model, |value| !value.trim().is_empty()) { "1" } else { "0" }.to_string()),
    );
    let explicit_startup_model = mappings.startup_model.as_ref().map(|model| model.trim().to_string());
    if mappings.startup_model.is_some() {
        // Claude Code's official persistent startup-model setting is the root
        // `model` key. Keep ANTHROPIC_MODEL out of the generated file so the
        // saved choice can still be changed from Claude Code's /model picker.
        env.remove("ANTHROPIC_MODEL");
    } else if mappings.manage_default_model {
        env.insert(
            "ANTHROPIC_MODEL".to_string(),
            serde_json::Value::String(model_settings.sonnet.clone()),
        );
    } else if env
        .get("ANTHROPIC_MODEL")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value == model_settings.opus || value == model_settings.sonnet || value == model_settings.haiku)
    {
        env.remove("ANTHROPIC_MODEL");
    }
    if let Some(model) = &mappings.subagent_model {
        if model.trim().is_empty() {
            env.remove("CLAUDE_CODE_SUBAGENT_MODEL");
        } else {
            env.insert("CLAUDE_CODE_SUBAGENT_MODEL".into(), serde_json::Value::String(model.trim().into()));
        }
    } else if mappings.manage_subagent_model {
        env.entry("CLAUDE_CODE_SUBAGENT_MODEL".to_string())
            .or_insert_with(|| serde_json::Value::String(subagent_model));
    } else if env
        .get("CLAUDE_CODE_SUBAGENT_MODEL")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value == model_settings.opus || value == model_settings.sonnet || value == model_settings.haiku)
    {
        env.remove("CLAUDE_CODE_SUBAGENT_MODEL");
    }
    env.insert(
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV.to_string(),
        serde_json::Value::String("1".to_string()),
    );
    env.insert(
        CLAUDE_CODE_AUTO_MODE_SERVER_ENV.to_string(),
        serde_json::Value::String("0".to_string()),
    );
    for (key, value) in [
        (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV, mappings.auto_compact_pct.to_string()),
        (DISABLE_AUTO_COMPACT_ENV, if mappings.disable_auto_compact { "1" } else { "0" }.to_string()),
    ] {
        env.insert(key.to_string(), serde_json::Value::String(value));
    }
    for (key, value) in claude_code_model_presentation_environment(&mappings, models)? {
        env.insert(key, serde_json::Value::String(value));
    }
    if let Some(effort_level) = effort_level {
        env.insert(
            "CLAUDE_CODE_EFFORT_LEVEL".to_string(),
            serde_json::Value::String(effort_level),
        );
    }
    // Claude Code reads one context window from settings.json env and
    // compacts at the smaller of that window and the compact setting.
    let fable_model = if mappings.fable.trim().is_empty() { mappings.sonnet.as_str() } else { mappings.fable.as_str() };
    let mut model_ids = std::collections::BTreeSet::<String>::new();
    for model_id in [fable_model, mappings.opus.as_str(), mappings.sonnet.as_str(), mappings.haiku.as_str()] {
        let model_id = strip_claude_code_context_suffix(model_id).trim();
        if !model_id.is_empty() {
            model_ids.insert(model_id.to_string());
        }
    }
    for model in [&mappings.startup_model, &mappings.subagent_model] {
        let Some(model) = model.as_deref().map(str::trim).filter(|value| !value.is_empty()) else { continue; };
        let role = strip_claude_code_context_suffix(model).trim().to_ascii_lowercase();
        let resolved = match role.as_str() {
            "opus" => mappings.opus.as_str(),
            "sonnet" => mappings.sonnet.as_str(),
            "haiku" => mappings.haiku.as_str(),
            "fable" => fable_model,
            _ => model,
        };
        let model_id = strip_claude_code_context_suffix(resolved).trim();
        if !model_id.is_empty() {
            model_ids.insert(model_id.to_string());
        }
    }
    let env = ensure_json_object_entry(root, "env");
    let window_text = max_context_tokens.to_string();
    env.insert(CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV.to_string(), serde_json::Value::String(window_text.clone()));
    env.insert(CLAUDE_CODE_AUTO_COMPACT_WINDOW_ENV.to_string(), serde_json::Value::String(window_text));
    root.insert("autoCompactWindow".into(), serde_json::Value::Number(max_context_tokens.into()));
    root.insert("autoCompactEnabled".into(), serde_json::Value::Bool(!mappings.disable_auto_compact));
    let managed_model_ids = model_ids.iter().cloned().collect::<Vec<_>>();
    let model_settings_json = ensure_json_object_entry(root, "modelSettings");
    for model in previous_managed_models {
        if model_ids.contains(&model) { continue; }
        if let Some(entry) = model_settings_json.get_mut(&model).and_then(serde_json::Value::as_object_mut) {
            entry.remove("autoCompactWindow");
            if entry.is_empty() { model_settings_json.remove(&model); }
        }
    }
    for model_id in model_ids {
        let entry = ensure_json_object_entry(model_settings_json, &model_id);
        entry.insert("autoCompactWindow".into(), serde_json::Value::Number(max_context_tokens.into()));
    }
    if let Some(model) = explicit_startup_model {
        if model.is_empty() {
            root.remove("model");
        } else {
            root.insert("model".into(), serde_json::Value::String(model));
        }
    }
    if mappings.startup_model.is_none() && mappings.manage_default_model {
        root.insert(
            "model".to_string(),
            serde_json::Value::String(model_settings.sonnet),
        );
    } else if mappings.startup_model.is_none() && root
        .get("model")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value == model_settings.opus || value == model_settings.sonnet || value == model_settings.haiku)
    {
        root.remove("model");
    }
    // The saved selection identifies a CPA default separately from a later
    // user change made through Claude Code's own /model picker.
    let managed_startup = root.get("model").and_then(serde_json::Value::as_str)
        .filter(|_| mappings.startup_model.as_ref().map_or(mappings.manage_default_model, |model| !model.trim().is_empty()))
        .map(str::to_string);
    let env = ensure_json_object_entry(root, "env");
    env.insert(CLAUDE_CODE_MANAGED_MODEL_SETTINGS_ENV.into(), serde_json::Value::String(
        serde_json::to_string(&managed_model_ids).map_err(|_| "Failed to record managed Claude Code models".to_string())?));
    if let Some(model) = managed_startup {
        env.insert(CLAUDE_CODE_MANAGED_STARTUP_MODEL_ENV.into(), serde_json::Value::String(model));
    } else {
        env.remove(CLAUDE_CODE_MANAGED_STARTUP_MODEL_ENV);
    }
    let mut rendered = serde_json::to_string_pretty(&serde_json::Value::Object(root.clone()))
        .map_err(|error| format!("Failed to generate Claude Code configuration: {error}"))?;
    rendered.push('\n');
    Ok(rendered)
}
