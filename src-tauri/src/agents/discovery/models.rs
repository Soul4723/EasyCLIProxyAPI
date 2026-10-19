use super::*;

pub(crate) fn inspect_claude_agent_config(
    path: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if !path.is_file() {
        return Ok((false, None));
    }
    let root: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(path).map_err(|error| format!("Failed to read Claude Code configuration: {error}"))?,
    )
    .map_err(|_| "Failed to parse Claude Code configuration".to_string())?;
    let env = root.get("env").and_then(serde_json::Value::as_object);
    let expected_base = port.client_origin();
    let configured = env
        .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        == Some(expected_base.as_str())
        && env
            .and_then(|env| env.get("ANTHROPIC_AUTH_TOKEN"))
            .and_then(serde_json::Value::as_str)
            == Some(api_key)
        && env
            .and_then(|env| env.get(CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV))
            .and_then(serde_json::Value::as_str)
            == Some("1")
        && env
            .and_then(|env| env.get(CLAUDE_CODE_AUTO_MODE_SERVER_ENV))
            .and_then(serde_json::Value::as_str)
            == Some("0");
    let model = env
        .and_then(|env| env.get("ANTHROPIC_MODEL"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| root.get("model").and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(strip_claude_code_context_suffix)
        .map(str::to_string);
    Ok((configured, model))
}

pub(crate) fn inspect_claude_code_model_mappings(
    path: &Path,
) -> Result<Option<ClaudeDesktopModelMappings>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let root: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(path)
            .map_err(|error| format!("Failed to read Claude Code configuration: {error}"))?,
    )
    .map_err(|_| "Failed to parse Claude Code configuration".to_string())?;
    let Some(env) = root.get("env").and_then(serde_json::Value::as_object) else {
        return Ok(None);
    };
    let fallback = env
        .get("ANTHROPIC_MODEL")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| root.get("model").and_then(serde_json::Value::as_str).map(str::trim).filter(|value| !value.is_empty()));
    let read_model = |key: &str| {
        let value = env
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or(fallback)?;
        let normalized = strip_claude_code_context_suffix(value);
        Some((normalized.to_string(), normalized.len() != value.len()))
    };
    let Some((opus, opus_had_1m)) = read_model("ANTHROPIC_DEFAULT_OPUS_MODEL") else {
        return Ok(None);
    };
    let Some((sonnet, sonnet_had_1m)) = read_model("ANTHROPIC_DEFAULT_SONNET_MODEL") else {
        return Ok(None);
    };
    let Some((haiku, haiku_had_1m)) = read_model("ANTHROPIC_DEFAULT_HAIKU_MODEL") else {
        return Ok(None);
    };
    let legacy_1m = opus_had_1m || sonnet_had_1m || haiku_had_1m;
    let read_window = |value: &serde_json::Value| value.as_u64().or_else(|| value.as_str().and_then(|text| text.trim().parse::<u64>().ok()));
    let max_context_tokens = env
        .get(CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV)
        .and_then(read_window)
        .or_else(|| root.get("autoCompactWindow").and_then(read_window))
        .unwrap_or_else(|| {
            if legacy_1m {
                CLAUDE_DESKTOP_EXTENDED_CONTEXT_WINDOW
            } else {
                default_claude_code_max_context_tokens()
            }
        });
    let auto_compact_pct = env
        .get(CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV)
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.trim().parse::<u8>().ok())
        .unwrap_or_else(default_claude_auto_compact_pct);
    let disable_auto_compact = root
        .get("autoCompactEnabled")
        .and_then(serde_json::Value::as_bool)
        .map(|enabled| !enabled)
        .unwrap_or_else(|| env
            .get(DISABLE_AUTO_COMPACT_ENV)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true")));
    Ok(Some(ClaudeDesktopModelMappings {
        desktop_models: None,
        opus,
        sonnet,
        haiku,
        opus_1m: opus_had_1m,
        sonnet_1m: sonnet_had_1m,
        haiku_1m: haiku_had_1m,
        fable: read_model("ANTHROPIC_DEFAULT_FABLE_MODEL").map(|entry| entry.0).unwrap_or_default(),
        fable_1m: read_model("ANTHROPIC_DEFAULT_FABLE_MODEL").is_some_and(|entry| entry.1),
        max_context_tokens,
        auto_compact_pct,
        disable_auto_compact,
        manage_default_model: env
            .get("EASYCLIPROXY_MANAGE_CLAUDE_CODE_DEFAULT_MODEL")
            .and_then(serde_json::Value::as_str)
            .map(|value| value != "0" && !value.eq_ignore_ascii_case("false"))
            .unwrap_or(true),
        manage_subagent_model: env
            .get("EASYCLIPROXY_MANAGE_CLAUDE_CODE_SUBAGENT_MODEL")
            .and_then(serde_json::Value::as_str)
            .map(|value| value != "0" && !value.eq_ignore_ascii_case("false"))
            .unwrap_or(true),
        startup_model: Some(env
            .get("ANTHROPIC_MODEL")
            .and_then(serde_json::Value::as_str)
            .or_else(|| root.get("model").and_then(serde_json::Value::as_str))
            .unwrap_or_default()
            .to_string()),
        subagent_model: Some(env
            .get("CLAUDE_CODE_SUBAGENT_MODEL")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string()),
    }))
}

pub(crate) fn strip_claude_code_context_suffix(value: &str) -> &str {
    let mut value = value.trim();
    loop {
        let Some(suffix_start) = value.len().checked_sub(4) else {
            return value;
        };
        if !value[suffix_start..].eq_ignore_ascii_case("[1m]") {
            return value;
        }
        value = value[..suffix_start].trim_end();
    }
}

pub(crate) fn agent_model_source_name<'a>(
    models: &'a [AgentModelOption],
    model_name: &'a str,
) -> &'a str {
    let model_name = strip_claude_code_context_suffix(model_name);
    let Some(model) = models
        .iter()
        .find(|model| model.name.eq_ignore_ascii_case(model_name))
    else {
        return model_name;
    };
    if model.is_alias {
        model.alias.as_deref().unwrap_or(model.name.as_str())
    } else {
        model.name.as_str()
    }
}

pub(crate) fn agent_model_context_window(
    models: &[AgentModelOption],
    model_name: &str,
) -> Option<u64> {
    let model_name = strip_claude_code_context_suffix(model_name);
    let selected = models
        .iter()
        .find(|model| model.name.eq_ignore_ascii_case(model_name))?;
    if !selected.is_alias {
        return Some(
            selected
                .context_window
                .unwrap_or(DEFAULT_CLAUDE_CONTEXT_WINDOW),
        );
    }
    selected
        .alias
        .as_deref()
        .and_then(|source| {
            models
                .iter()
                .find(|model| model.name.eq_ignore_ascii_case(source))
        })
        .and_then(|model| model.context_window)
        .or(selected.context_window)
        .or(Some(DEFAULT_CLAUDE_CONTEXT_WINDOW))
}

pub(crate) fn claude_effective_context_window(
    models: &[AgentModelOption],
    model_name: &str,
    enable_1m: bool,
) -> Option<u64> {
    let context_window = agent_model_context_window(models, model_name);
    if enable_1m {
        return Some(
            context_window
                .unwrap_or(DEFAULT_CLAUDE_CONTEXT_WINDOW)
                .max(CLAUDE_DESKTOP_EXTENDED_CONTEXT_WINDOW),
        );
    }
    context_window
}

pub(crate) fn agent_model_display_name<'a>(
    models: &'a [AgentModelOption],
    model_name: &'a str,
) -> &'a str {
    let model_name = strip_claude_code_context_suffix(model_name);
    let Some(model) = models
        .iter()
        .find(|model| model.name.eq_ignore_ascii_case(model_name))
    else {
        return model_name;
    };
    if model.is_alias {
        model.name.as_str()
    } else {
        model.alias.as_deref().unwrap_or(model.name.as_str())
    }
}

pub(crate) fn claude_code_model_effort_level(
    models: &[AgentModelOption],
    model_name: &str,
) -> Result<Option<String>, String> {
    claude_catalog::claude_code_effort_level_for(agent_model_source_name(models, model_name))
}

pub(crate) fn claude_code_model_setting(model_name: &str, enable_1m_variant: bool) -> String {
    let model_name = strip_claude_code_context_suffix(model_name);
    if enable_1m_variant {
        format!("{model_name}[1m]")
    } else {
        model_name.to_string()
    }
}

pub(crate) fn claude_code_model_settings(
    mappings: &ClaudeDesktopModelMappings,
) -> ClaudeDesktopModelMappings {
    ClaudeDesktopModelMappings {
        desktop_models: None,
        opus: claude_code_model_setting(&mappings.opus, mappings.opus_1m),
        sonnet: claude_code_model_setting(&mappings.sonnet, mappings.sonnet_1m),
        haiku: claude_code_model_setting(&mappings.haiku, mappings.haiku_1m),
        opus_1m: mappings.opus_1m,
        sonnet_1m: mappings.sonnet_1m,
        haiku_1m: mappings.haiku_1m,
        fable: claude_code_model_setting(if mappings.fable.is_empty() { &mappings.sonnet } else { &mappings.fable }, if mappings.fable.is_empty() { mappings.sonnet_1m } else { mappings.fable_1m }),
        fable_1m: mappings.fable_1m,
        max_context_tokens: mappings.max_context_tokens,
        auto_compact_pct: mappings.auto_compact_pct,
        disable_auto_compact: mappings.disable_auto_compact,
        manage_default_model: mappings.manage_default_model,
        manage_subagent_model: mappings.manage_subagent_model,
        startup_model: mappings.startup_model.clone(),
        subagent_model: mappings.subagent_model.clone(),
    }
}


pub(crate) fn format_context_window(context_window: u64) -> String {
    if context_window.is_multiple_of(1_000_000) {
        format!("{}M", context_window / 1_000_000)
    } else if context_window.is_multiple_of(1_000) {
        format!("{}K", context_window / 1_000)
    } else {
        context_window.to_string()
    }
}

pub(crate) fn claude_code_model_presentation(
    models: &[AgentModelOption],
    model_name: &str,
    enable_1m: bool,
    context_window_override: Option<u64>,
    role: Option<&str>,
) -> (String, String) {
    let display_name = agent_model_display_name(models, model_name);
    let extended = enable_1m || model_name.trim().to_ascii_lowercase().ends_with("[1m]");
    let display_name = if extended {
        format!("{display_name}[1m]")
    } else {
        display_name.to_string()
    };
    let context_window = context_window_override.unwrap_or_else(|| {
        claude_effective_context_window(models, model_name, enable_1m)
            .unwrap_or(DEFAULT_CLAUDE_CONTEXT_WINDOW)
    });
    let context_label = format_context_window(context_window);
    let name = match role {
        Some(role) => format!("{role} · {display_name}"),
        None => display_name.to_string(),
    };
    let description = if extended {
        format!("1M enabled · Auto-compact window: {context_label}")
    } else {
        format!("Auto-compact window: {context_label}")
    };
    (name, description)
}

pub(crate) fn claude_code_model_presentation_environment(
    mappings: &ClaudeDesktopModelMappings,
    models: &[AgentModelOption],
) -> Result<Vec<(String, String)>, String> {
    let opus = claude_code_model_presentation(
        models,
        &mappings.opus,
        mappings.opus_1m,
        Some(mappings.max_context_tokens),
        Some("Opus"),
    );
    let sonnet = claude_code_model_presentation(
        models,
        &mappings.sonnet,
        mappings.sonnet_1m,
        Some(mappings.max_context_tokens),
        Some("Sonnet"),
    );
    let haiku = claude_code_model_presentation(
        models,
        &mappings.haiku,
        mappings.haiku_1m,
        Some(mappings.max_context_tokens),
        Some("Haiku"),
    );
    let fable = claude_code_model_presentation(
        models,
        if mappings.fable.is_empty() { &mappings.sonnet } else { &mappings.fable },
        if mappings.fable.is_empty() { mappings.sonnet_1m } else { mappings.fable_1m },
        Some(mappings.max_context_tokens),
        Some("Fable"),
    );
    let custom = claude_code_model_presentation(
        models,
        &mappings.sonnet,
        mappings.sonnet_1m,
        Some(mappings.max_context_tokens),
        None,
    );
    let custom_model = claude_code_model_setting(&mappings.sonnet, mappings.sonnet_1m);
    Ok([
        ("ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", opus.0),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION", opus.1),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", sonnet.0),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION", sonnet.1),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", haiku.0),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION", haiku.1),
        ("ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", fable.0),
        ("ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION", fable.1),
        ("ANTHROPIC_CUSTOM_MODEL_OPTION", custom_model),
        ("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME", custom.0),
        ("ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION", custom.1),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value))
    .collect())
}

pub(crate) fn inspect_claude_desktop_agent_config(
    paths: &[PathBuf],
    port: impl AgentClientOrigin,
    api_key: &str,
) -> Result<(bool, Option<String>), String> {
    if paths.len() != 4 || !paths.iter().any(|path| path.is_file()) {
        return Ok((false, None));
    }
    let normal = read_agent_json_or_empty(&paths[0], "Claude Desktop main configuration")?;
    let threep = read_agent_json_or_empty(&paths[1], "Claude Desktop 3P configuration")?;
    let profile = read_agent_json_or_empty(&paths[2], "Claude Desktop gateway configuration")?;
    let meta = read_agent_json_or_empty(&paths[3], "Claude Desktop configuration index")?;
    let expected_base = port.client_origin();
    let configured = normal
        .get("deploymentMode")
        .and_then(serde_json::Value::as_str)
        == Some("3p")
        && threep
            .get("deploymentMode")
            .and_then(serde_json::Value::as_str)
            == Some("3p")
        && profile
            .get("inferenceGatewayBaseUrl")
            .and_then(serde_json::Value::as_str)
            == Some(expected_base.as_str())
        && profile
            .get("inferenceGatewayApiKey")
            .and_then(serde_json::Value::as_str)
            == Some(api_key)
        && meta.get("appliedId").and_then(serde_json::Value::as_str)
            == Some(CLAUDE_DESKTOP_PROFILE_ID);
    let model = profile
        .get("inferenceModels")
        .and_then(serde_json::Value::as_array)
        .and_then(|models| models.first())
        .and_then(|model| {
            model
                .as_str()
                .or_else(|| {
                    model
                        .get("labelOverride")
                        .and_then(serde_json::Value::as_str)
                })
                .or_else(|| model.get("name").and_then(serde_json::Value::as_str))
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok((configured, model))
}
