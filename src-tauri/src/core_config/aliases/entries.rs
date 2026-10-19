use super::*;

pub(crate) fn thinking_aliases_from_yaml(content: &str) -> Result<Vec<ThinkingAliasEntry>, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    thinking_aliases_from_value(&document)
}

pub(crate) fn thinking_aliases_from_value(
    document: &serde_norway::Value,
) -> Result<Vec<ThinkingAliasEntry>, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let mut entries = Vec::new();
    if let Some(oauth_aliases) = yaml_mapping_value(root, "oauth-model-alias") {
        let oauth_aliases = oauth_aliases
            .as_mapping()
            .ok_or_else(|| "oauth-model-alias must be a YAML mapping".to_string())?;
        for (channel, channel_aliases) in oauth_aliases {
            let channel = channel.as_str().unwrap_or("unknown");
            let channel_aliases = channel_aliases
                .as_sequence()
                .ok_or_else(|| format!("oauth-model-alias.{channel} must be an array"))?;
            let (provider, kind, protocol) = oauth_alias_channel_details(channel);
            for (model_index, entry) in channel_aliases.iter().enumerate() {
                let Some(mapping) = entry.as_mapping() else {
                    continue;
                };
                let Some(source_model) = yaml_mapping_value(mapping, "name")
                    .and_then(serde_norway::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                let Some(alias) = yaml_mapping_value(mapping, "alias")
                    .and_then(serde_norway::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                entries.push(ThinkingAliasEntry {
                    position: ModelAliasPosition { section: "oauth-model-alias".into(), provider_index: None, model_index },
                    source_model: source_model.to_string(),
                    alias: alias.to_string(),
                    effort: find_thinking_alias_effort(root, alias, &protocol),
                    provider: provider.clone(),
                    kind: kind.clone(),
                    oauth_channel: Some(channel.to_string()),
                });
            }
        }
    }
    collect_config_thinking_alias_entries(
        root,
        "codex-api-key",
        "Codex API",
        "codex-api",
        "codex",
        &mut entries,
    )?;
    collect_config_thinking_alias_entries(
        root,
        "openai-compatibility",
        "OpenAI-compatible",
        "openai-compatible",
        "openai",
        &mut entries,
    )?;
    collect_config_thinking_alias_entries(
        root,
        "claude-api-key",
        "Claude API",
        "claude-api",
        "claude",
        &mut entries,
    )?;
    collect_config_thinking_alias_entries(
        root,
        "gemini-api-key",
        "Gemini API",
        "gemini-api",
        "gemini",
        &mut entries,
    )?;
    entries.sort_by(|left, right| {
        left.provider
            .to_ascii_lowercase()
            .cmp(&right.provider.to_ascii_lowercase())
            .then_with(|| {
                left.alias
                    .to_ascii_lowercase()
                    .cmp(&right.alias.to_ascii_lowercase())
            })
    });
    Ok(entries)
}

pub(crate) fn speed_aliases_from_yaml(content: &str) -> Result<Vec<SpeedAliasEntry>, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    speed_aliases_from_value(&document)
}

pub(crate) fn speed_aliases_from_value(
    document: &serde_norway::Value,
) -> Result<Vec<SpeedAliasEntry>, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let mut entries = Vec::new();
    if let Some(oauth_aliases) = yaml_mapping_value(root, "oauth-model-alias") {
        let oauth_aliases = oauth_aliases
            .as_mapping()
            .ok_or_else(|| "oauth-model-alias must be a YAML mapping".to_string())?;
        for (channel, channel_aliases) in oauth_aliases {
            let channel = channel.as_str().unwrap_or("unknown");
            let channel_aliases = channel_aliases
                .as_sequence()
                .ok_or_else(|| format!("oauth-model-alias.{channel} must be an array"))?;
            let (provider, kind, protocol) = oauth_alias_channel_details(channel);
            for (model_index, entry) in channel_aliases.iter().enumerate() {
                let Some(mapping) = entry.as_mapping() else {
                    continue;
                };
                let Some(source_model) = yaml_mapping_value(mapping, "name")
                    .and_then(serde_norway::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                let Some(alias) = yaml_mapping_value(mapping, "alias")
                    .and_then(serde_norway::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    continue;
                };
                let Some(service_tier) = find_speed_alias_service_tier(root, alias, &protocol)
                else {
                    continue;
                };
                entries.push(SpeedAliasEntry {
                    position: ModelAliasPosition { section: "oauth-model-alias".into(), provider_index: None, model_index },
                    source_model: source_model.to_string(),
                    alias: alias.to_string(),
                    service_tier,
                    provider: provider.clone(),
                    kind: kind.clone(),
                    oauth_channel: Some(channel.to_string()),
                });
            }
        }
    }
    collect_config_speed_alias_entries(
        root,
        "codex-api-key",
        "Codex API",
        "codex-api",
        "codex",
        &mut entries,
    )?;
    collect_config_speed_alias_entries(
        root,
        "openai-compatibility",
        "OpenAI-compatible",
        "openai-compatible",
        "openai",
        &mut entries,
    )?;
    entries.sort_by(|left, right| {
        left.provider
            .to_ascii_lowercase()
            .cmp(&right.provider.to_ascii_lowercase())
            .then_with(|| {
                left.alias
                    .to_ascii_lowercase()
                    .cmp(&right.alias.to_ascii_lowercase())
            })
    });
    Ok(entries)
}

pub(crate) fn collect_config_thinking_alias_entries(
    root: &serde_norway::Mapping,
    section: &str,
    fallback_provider: &str,
    kind: &str,
    protocol: &str,
    entries: &mut Vec<ThinkingAliasEntry>,
) -> Result<(), String> {
    let Some(providers) = yaml_mapping_value(root, section) else {
        return Ok(());
    };
    let providers = providers
        .as_sequence()
        .ok_or_else(|| format!("{section} must be an array"))?;
    for (provider_index, provider) in providers.iter().enumerate() {
        let Some(provider) = provider.as_mapping() else {
            continue;
        };
        let provider_name =
            thinking_alias_provider_name(provider, fallback_provider, provider_index);
        let Some(models) = yaml_mapping_value(provider, "models") else {
            continue;
        };
        let models = models
            .as_sequence()
            .ok_or_else(|| format!("{section}.models must be an array"))?;
        for (model_index, model) in models.iter().enumerate() {
            let Some((source_model, alias, _)) = configured_model_identity(model) else {
                continue;
            };
            if source_model == alias {
                continue;
            }
            let effort = find_thinking_alias_effort(root, &alias, protocol);
            if effort.is_none() && find_speed_alias_service_tier(root, &alias, protocol).is_some() {
                continue;
            }
            entries.push(ThinkingAliasEntry {
                position: ModelAliasPosition { section: section.into(), provider_index: Some(provider_index), model_index },
                source_model,
                alias,
                effort,
                provider: provider_name.clone(),
                kind: kind.to_string(),
                oauth_channel: None,
            });
        }
    }
    Ok(())
}

pub(crate) fn collect_config_speed_alias_entries(
    root: &serde_norway::Mapping,
    section: &str,
    fallback_provider: &str,
    kind: &str,
    protocol: &str,
    entries: &mut Vec<SpeedAliasEntry>,
) -> Result<(), String> {
    let Some(providers) = yaml_mapping_value(root, section) else {
        return Ok(());
    };
    let providers = providers
        .as_sequence()
        .ok_or_else(|| format!("{section} must be an array"))?;
    for (provider_index, provider) in providers.iter().enumerate() {
        let Some(provider) = provider.as_mapping() else {
            continue;
        };
        let provider_name =
            thinking_alias_provider_name(provider, fallback_provider, provider_index);
        let Some(models) = yaml_mapping_value(provider, "models") else {
            continue;
        };
        let models = models
            .as_sequence()
            .ok_or_else(|| format!("{section}.models must be an array"))?;
        for (model_index, model) in models.iter().enumerate() {
            let Some((source_model, alias, _)) = configured_model_identity(model) else {
                continue;
            };
            if source_model == alias {
                continue;
            }
            let Some(service_tier) = find_speed_alias_service_tier(root, &alias, protocol) else {
                continue;
            };
            entries.push(SpeedAliasEntry {
                position: ModelAliasPosition { section: section.into(), provider_index: Some(provider_index), model_index },
                source_model,
                alias,
                service_tier,
                provider: provider_name.clone(),
                kind: kind.to_string(),
                oauth_channel: None,
            });
        }
    }
    Ok(())
}

fn alias_override_params<'a>(
    root: &'a serde_norway::Mapping,
    alias: &'a str,
    protocol: &'a str,
) -> impl Iterator<Item = (&'a serde_norway::Mapping, bool)> {
    ["override-raw", "override"]
        .into_iter()
        .flat_map(move |section| {
            nested_yaml_value(root, &["payload", section])
                .and_then(serde_norway::Value::as_sequence)
                .into_iter()
                .flatten()
                .rev()
                .filter_map(move |rule| {
                    let rule = rule.as_mapping()?;
                    let models = yaml_mapping_value(rule, "models")?.as_sequence()?;
                    if !models
                        .iter()
                        .any(|model| thinking_payload_model_matches(model, alias, protocol))
                    {
                        return None;
                    }
                    Some((
                        yaml_mapping_value(rule, "params")?.as_mapping()?,
                        section == "override-raw",
                    ))
                })
        })
}

fn alias_payload_string(params: &serde_norway::Mapping, key: &str, raw: bool) -> Option<String> {
    let value = yaml_mapping_value(params, key)?.as_str()?;
    let decoded;
    let value = if raw {
        decoded = serde_json::from_str::<serde_json::Value>(value).ok()?;
        decoded.as_str()?
    } else {
        value
    };
    let value = value.trim().to_ascii_lowercase();
    (!value.is_empty()).then_some(value)
}

pub(crate) fn thinking_effort_from_params(
    params: &serde_norway::Mapping,
    protocol: &str,
    raw: bool,
) -> Option<String> {
    [
        "reasoning.effort",
        "reasoning_effort",
        "output_config.effort",
        "generationConfig.thinkingConfig.thinkingLevel",
        "thinking.effort",
    ]
    .into_iter()
    .find_map(|key| alias_payload_string(params, key, raw))
    .or_else(
        || match alias_payload_string(params, "thinking.type", raw)?.as_str() {
            "disabled" => Some("none".to_string()),
            "adaptive" if protocol.eq_ignore_ascii_case("claude") => Some("auto".to_string()),
            _ => None,
        },
    )
}

pub(crate) fn find_thinking_alias_effort(
    root: &serde_norway::Mapping,
    alias: &str,
    protocol: &str,
) -> Option<String> {
    alias_override_params(root, alias, protocol)
        .find_map(|(params, raw)| thinking_effort_from_params(params, protocol, raw))
}

pub(crate) fn find_speed_alias_service_tier(
    root: &serde_norway::Mapping,
    alias: &str,
    protocol: &str,
) -> Option<String> {
    alias_override_params(root, alias, protocol)
        .find_map(|(params, raw)| alias_payload_string(params, "service_tier", raw))
}

pub(crate) fn thinking_payload_model_matches(
    model: &serde_norway::Value,
    alias: &str,
    protocol: &str,
) -> bool {
    let Some(model) = model.as_mapping() else {
        return false;
    };
    let name_matches = yaml_mapping_value(model, "name")
        .and_then(serde_norway::Value::as_str)
        .is_some_and(|name| name.trim().eq_ignore_ascii_case(alias));
    let protocol_matches = yaml_mapping_value(model, "protocol").is_none_or(|value| {
        value.as_str().is_some_and(|value| {
            value.trim().is_empty() || value.trim().eq_ignore_ascii_case(protocol)
        })
    });
    name_matches && protocol_matches
}

pub(crate) fn thinking_payload_model_name_matches(
    model: &serde_norway::Value,
    alias: &str,
) -> bool {
    model
        .as_mapping()
        .and_then(|model| yaml_mapping_value(model, "name"))
        .and_then(serde_norway::Value::as_str)
        .is_some_and(|name| name.trim().eq_ignore_ascii_case(alias))
}

pub(crate) fn insert_thinking_effort_params(
    params: &mut serde_norway::Mapping,
    source: &ThinkingAliasSource,
    effort: &str,
) -> Result<(), String> {
    let insert = |params: &mut serde_norway::Mapping, key: &str, value: &str| {
        params.insert(
            yaml_key(key),
            serde_norway::Value::String(value.to_string()),
        );
    };
    match source.kind.as_str() {
        "claude-oauth" | "claude-api" => {
            if effort.eq_ignore_ascii_case("none") {
                insert(params, "thinking.type", "disabled");
            } else {
                insert(params, "thinking.type", "adaptive");
                if !effort.eq_ignore_ascii_case("auto") {
                    insert(params, "output_config.effort", effort);
                }
            }
        }
        "aistudio-oauth" | "vertex-oauth" | "gemini-api" => {
            insert(
                params,
                "generationConfig.thinkingConfig.thinkingLevel",
                effort,
            );
        }
        "antigravity-oauth" => {
            insert(
                params,
                "generationConfig.thinkingConfig.thinkingLevel",
                effort,
            );
        }
        "kimi-oauth" => {
            if effort.eq_ignore_ascii_case("none") {
                insert(params, "thinking.type", "disabled");
            } else {
                insert(params, "thinking.type", "enabled");
                insert(params, "thinking.effort", effort);
            }
        }
        "codex-oauth" | "codex-api" | "xai-oauth" => {
            insert(params, "reasoning.effort", effort);
        }
        "openai-compatible" => {
            insert(params, "reasoning_effort", effort);
            if source.model.to_ascii_lowercase().starts_with("deepseek") {
                insert(params, "thinking.type", "enabled");
            }
        }
        _ => match source.protocol.as_str() {
            "codex" => insert(params, "reasoning.effort", effort),
            "openai" => insert(params, "reasoning_effort", effort),
            "claude" => {
                if effort.eq_ignore_ascii_case("none") {
                    insert(params, "thinking.type", "disabled");
                } else {
                    insert(params, "thinking.type", "adaptive");
                    if !effort.eq_ignore_ascii_case("auto") {
                        insert(params, "output_config.effort", effort);
                    }
                }
            }
            "gemini" | "antigravity" => insert(
                params,
                "generationConfig.thinkingConfig.thinkingLevel",
                effort,
            ),
            protocol => {
                return Err(format!("Forcing a reasoning effort override is not yet supported for {protocol} sources"));
            }
        },
    }
    Ok(())
}
