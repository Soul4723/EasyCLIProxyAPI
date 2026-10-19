use super::*;

pub(crate) fn ensure_claude_desktop_model_aliases_in_yaml(
    content: &str,
    mappings: &ClaudeDesktopModelMappings,
    models: &[AgentModelOption],
) -> Result<String, String> {
    ensure_claude_desktop_model_aliases_with_codex_oauth_in_yaml(content, mappings, models, &[])
}

pub(crate) fn ensure_claude_desktop_model_aliases_with_codex_oauth_in_yaml(
    content: &str,
    mappings: &ClaudeDesktopModelMappings,
    models: &[AgentModelOption],
    codex_oauth_models: &[CodexModelDefinition],
) -> Result<String, String> {
    let codex_channel = oauth_alias_channel("codex")
        .ok_or_else(|| "Codex OAuth alias channel definition is missing".to_string())?;
    let definitions = [OAuthModelDefinitions {
        channel: codex_channel,
        models: codex_oauth_models.to_vec(),
    }];
    ensure_claude_desktop_model_aliases_with_oauth_definitions_in_yaml(
        content,
        mappings,
        models,
        &definitions,
    )
}

pub(crate) fn ensure_claude_desktop_model_aliases_with_oauth_definitions_in_yaml(
    content: &str,
    mappings: &ClaudeDesktopModelMappings,
    models: &[AgentModelOption],
    oauth_model_definitions: &[OAuthModelDefinitions],
) -> Result<String, String> {
    ensure_claude_desktop_model_aliases_with_oauth_definitions_and_routes_in_yaml(
        content,
        mappings,
        models,
        oauth_model_definitions,
        [
            CLAUDE_DESKTOP_OPUS_MODEL_ID,
            CLAUDE_DESKTOP_SONNET_MODEL_ID,
            CLAUDE_DESKTOP_HAIKU_MODEL_ID,
        ],
    )
}

pub(crate) fn assign_available_claude_desktop_aliases(
    mappings: &mut ClaudeDesktopModelMappings,
    models: &[AgentModelOption],
    content: &str,
) -> Result<(), String> {
    let Some(entries) = mappings.desktop_models.as_mut() else {
        return Ok(());
    };
    if entries.is_empty() {
        return Ok(());
    }
    let document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    let sources = document
        .get()
        .as_mapping()
        .cloned()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let managed_aliases = managed_claude_desktop_aliases(&sources);
    let mut planned = entries.clone();
    for index in 0..planned.len() {
        if !planned[index].has_mapping() {
            continue;
        }
        let alias = planned[index].alias.trim().to_string();
        if !claude_desktop_alias_conflicts(&sources, models, &alias, &managed_aliases) {
            continue;
        }
        let suffixed = format!("{alias}-cc");
        let occupied_by_sibling = planned.iter().enumerate().any(|(other_index, entry)| {
            other_index != index && entry.model_id().eq_ignore_ascii_case(&suffixed)
        });
        if occupied_by_sibling
            || !valid_claude_desktop_alias(&suffixed)
            || claude_desktop_alias_conflicts(&sources, models, &suffixed, &managed_aliases)
        {
            return Err(format!(
                "Alias {alias} is already used by another model. Choose a different alias"
            ));
        }
        planned[index].alias = suffixed;
    }
    *entries = planned;
    Ok(())
}

fn claude_desktop_alias_conflicts(
    sources: &serde_norway::Mapping,
    models: &[AgentModelOption],
    alias: &str,
    managed_aliases: &[String],
) -> bool {
    let occupied = configured_model_client_identity(sources, alias).is_some()
        || models
            .iter()
            .any(|model| model.name.eq_ignore_ascii_case(alias));
    let unmanaged_collision = claude_desktop_configured_models(sources)
        .into_iter()
        .any(|model| {
            configured_model_identity(model).is_some_and(|(_, existing, _)| {
                existing.eq_ignore_ascii_case(alias) && !is_managed_claude_model_alias(model, &existing)
            })
        });
    unmanaged_collision
        || (occupied
            && !managed_aliases
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(alias)))
}

pub(crate) fn ensure_claude_desktop_model_aliases_with_oauth_definitions_and_routes_in_yaml(
    content: &str,
    mappings: &ClaudeDesktopModelMappings,
    models: &[AgentModelOption],
    oauth_model_definitions: &[OAuthModelDefinitions],
    routes: [&str; 3],
) -> Result<String, String> {
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;

    let sources = root.clone();
    if let Some(entries) = &mappings.desktop_models {
        validate_claude_desktop_entries(entries)?;
        let managed_aliases = managed_claude_desktop_aliases(&sources);
        for entry in entries {
            if !entry.has_mapping() {
                continue;
            }
            if claude_desktop_alias_conflicts(&sources, models, &entry.alias, &managed_aliases) {
                return Err(format!("Alias {} is already used by another model. Choose a different alias", entry.alias));
            }
        }
        for alias in managed_aliases {
            if !entries.iter().any(|entry| entry.source_or_alias().eq_ignore_ascii_case(&alias)) {
                remove_managed_claude_model_alias(root, &alias)?;
            }
        }
        for entry in entries {
            if entry.has_mapping() {
                ensure_claude_desktop_model_alias(
                    root,
                    &sources,
                    &entry.model,
                    &entry.alias,
                    oauth_model_definitions,
                )?;
            }
        }
        if *root == sources {
            return Ok(content.to_string());
        }
        return render_updated_core_yaml(&mut document, updated);
    }
    for alias in managed_claude_desktop_aliases(&sources) {
        if !is_claude_desktop_route_id(&alias)
            && ![&mappings.opus, &mappings.sonnet, &mappings.haiku]
                .iter()
                .any(|model| model.eq_ignore_ascii_case(&alias))
        {
            remove_managed_claude_model_alias(root, &alias)?;
        }
    }
    for (alias, source_model) in [
        (routes[0], mappings.opus.as_str()),
        (routes[1], mappings.sonnet.as_str()),
        (routes[2], mappings.haiku.as_str()),
    ] {
        if let Some(paired_alias) = paired_claude_desktop_alias(alias) {
            remove_managed_claude_model_alias(root, paired_alias)?;
        }
        if claude_desktop_uses_source_directly(source_model, models) {
            if !source_model.eq_ignore_ascii_case(alias) {
                remove_managed_claude_model_alias(root, alias)?;
            }
            continue;
        }
        let direct_alias = models
            .iter()
            .any(|model| model.name.eq_ignore_ascii_case(source_model) && model.is_alias);
        if direct_alias {
            if !source_model.eq_ignore_ascii_case(alias) {
                remove_managed_claude_model_alias(root, alias)?;
            }
        } else {
            ensure_claude_desktop_model_alias(
                root,
                &sources,
                source_model,
                alias,
                oauth_model_definitions,
            )?;
        }
    }
    if *root == sources {
        return Ok(content.to_string());
    }
    render_updated_core_yaml(&mut document, updated)
}

pub(crate) fn validate_claude_desktop_entries(
    entries: &[ClaudeDesktopModelMapping],
) -> Result<(), String> {
    if entries.is_empty() {
        return Err("Add at least one Claude Desktop model".into());
    }
    let mut ids = HashSet::new();
    for entry in entries {
        validate_agent_model(entry.source_or_alias())?;
        if entry.source_or_alias().chars().any(char::is_whitespace) {
            return Err("Source model ID cannot contain whitespace".into());
        }
        let alias = entry.alias.trim();
        if !alias.is_empty() && !alias.eq_ignore_ascii_case(entry.source_or_alias()) && !valid_claude_desktop_alias(alias) {
            return Err(format!("Claude Desktop alias {alias} must start with claude-, may contain only lowercase letters, numbers, hyphens, and periods, and cannot contain other model family names such as gpt, grok, gemini, or deepseek"));
        }
        let id = entry.model_id();
        if !ids.insert(id.to_ascii_lowercase()) {
            return Err(format!("Duplicate Claude Desktop model ID: {id}"));
        }
    }
    Ok(())
}

pub(crate) fn valid_claude_desktop_alias(alias: &str) -> bool {
    claude_desktop_alias_has_valid_syntax(alias) && !claude_desktop_has_other_model_family(alias)
}

fn claude_desktop_alias_has_valid_syntax(alias: &str) -> bool {
    alias.len() <= 128
        && alias.strip_prefix("claude-").is_some_and(|rest| {
            !rest.is_empty()
                && rest.split(['-', '.']).all(|part| {
                    !part.is_empty()
                        && part.bytes().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
                })
        })
}

fn claude_desktop_configured_models(root: &serde_norway::Mapping) -> Vec<&serde_norway::Value> {
    let mut models = Vec::new();
    for section in MODEL_ALIAS_CONFIG_SECTIONS {
        for provider in yaml_mapping_value(root, section)
            .and_then(serde_norway::Value::as_sequence)
            .into_iter()
            .flatten()
        {
            if let Some(entries) = provider.as_mapping()
                .and_then(|provider| yaml_mapping_value(provider, "models"))
                .and_then(serde_norway::Value::as_sequence)
            {
                models.extend(entries);
            }
        }
    }
    if let Some(channels) = yaml_mapping_value(root, "oauth-model-alias")
        .and_then(serde_norway::Value::as_mapping)
    {
        for entries in channels.values().filter_map(serde_norway::Value::as_sequence) {
            models.extend(entries);
        }
    }
    models
}

pub(crate) fn managed_claude_desktop_aliases(root: &serde_norway::Mapping) -> Vec<String> {
    claude_desktop_configured_models(root).into_iter().filter_map(|model| {
        let (_, alias, _) = configured_model_identity(model)?;
        is_managed_claude_model_alias(model, &alias).then_some(alias)
    }).collect::<BTreeSet<_>>().into_iter().collect()
}

#[cfg(test)]
pub(crate) fn remove_managed_claude_model_aliases_in_yaml(content: &str) -> Result<String, String> {
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let mut changed = false;
    for alias in [
        CLAUDE_DESKTOP_OPUS_MODEL_ID,
        CLAUDE_DESKTOP_SONNET_MODEL_ID,
        CLAUDE_DESKTOP_HAIKU_MODEL_ID,
        LEGACY_CLAUDE_DESKTOP_MODEL_IDS[0],
        LEGACY_CLAUDE_DESKTOP_MODEL_IDS[1],
        LEGACY_CLAUDE_DESKTOP_MODEL_IDS[2],
    ] {
        changed |= remove_managed_claude_model_alias(root, alias)?;
    }
    if !changed {
        return Ok(content.to_string());
    }
    render_updated_core_yaml(&mut document, updated)
}

pub(crate) fn remove_managed_claude_model_alias(
    root: &mut serde_norway::Mapping,
    alias: &str,
) -> Result<bool, String> {
    let mut changed = false;
    for section in MODEL_ALIAS_CONFIG_SECTIONS {
        let Some(providers) = yaml_mapping_value_mut(root, section) else {
            continue;
        };
        let providers = providers
            .as_sequence_mut()
            .ok_or_else(|| format!("{section} must be an array"))?;
        for provider in providers {
            let Some(provider) = provider.as_mapping_mut() else {
                continue;
            };
            let Some(models) = yaml_mapping_value_mut(provider, "models") else {
                continue;
            };
            let models = models
                .as_sequence_mut()
                .ok_or_else(|| format!("{section}.models must be an array"))?;
            let before = models.len();
            models.retain(|model| !is_managed_claude_model_alias(model, alias));
            changed |= models.len() != before;
        }
    }
    changed |= remove_oauth_claude_model_alias(root, alias, true)?;
    Ok(changed)
}

pub(crate) fn remove_existing_claude_model_alias(
    root: &mut serde_norway::Mapping,
    alias: &str,
) -> Result<bool, String> {
    let mut changed = false;
    for section in MODEL_ALIAS_CONFIG_SECTIONS {
        let Some(providers) = yaml_mapping_value_mut(root, section) else {
            continue;
        };
        let providers = providers
            .as_sequence_mut()
            .ok_or_else(|| format!("{section} must be an array"))?;
        for provider in providers {
            let Some(provider) = provider.as_mapping_mut() else {
                continue;
            };
            let Some(models) = yaml_mapping_value_mut(provider, "models") else {
                continue;
            };
            let models = models
                .as_sequence_mut()
                .ok_or_else(|| format!("{section}.models must be an array"))?;
            let before = models.len();
            models.retain(|model| !occupies_claude_client_alias(model, alias));
            changed |= models.len() != before;
        }
    }
    changed |= remove_oauth_claude_model_alias(root, alias, false)?;
    Ok(changed)
}

pub(crate) fn remove_oauth_claude_model_alias(
    root: &mut serde_norway::Mapping,
    alias: &str,
    managed_only: bool,
) -> Result<bool, String> {
    let Some(oauth_aliases) = yaml_mapping_value_mut(root, "oauth-model-alias") else {
        return Ok(false);
    };
    let oauth_aliases = oauth_aliases
        .as_mapping_mut()
        .ok_or_else(|| "oauth-model-alias must be a YAML mapping".to_string())?;
    let mut changed = false;
    let mut empty_channels = Vec::new();
    for (channel, entries) in oauth_aliases.iter_mut() {
        let channel_name = channel.as_str().unwrap_or("unknown");
        let entries = entries
            .as_sequence_mut()
            .ok_or_else(|| format!("oauth-model-alias.{channel_name} must be an array"))?;
        let before = entries.len();
        entries.retain(|entry| {
            if managed_only {
                !is_managed_claude_model_alias(entry, alias)
            } else {
                !occupies_claude_client_alias(entry, alias)
            }
        });
        if entries.len() != before {
            changed = true;
            if entries.is_empty() {
                empty_channels.push(channel.clone());
            }
        }
    }
    for channel in empty_channels {
        oauth_aliases.remove(&channel);
    }
    let remove_oauth_section = changed && oauth_aliases.is_empty();
    if remove_oauth_section {
        root.remove(yaml_key("oauth-model-alias"));
    }
    Ok(changed)
}

pub(crate) fn managed_claude_alias_display_name(alias: &str) -> Option<&'static str> {
    if alias.eq_ignore_ascii_case(CLAUDE_DESKTOP_OPUS_MODEL_ID)
        || alias.eq_ignore_ascii_case(LEGACY_CLAUDE_DESKTOP_MODEL_IDS[0])
    {
        Some(MANAGED_CLAUDE_OPUS_ALIAS_DISPLAY_NAME)
    } else if alias.eq_ignore_ascii_case(CLAUDE_DESKTOP_SONNET_MODEL_ID)
        || alias.eq_ignore_ascii_case(LEGACY_CLAUDE_DESKTOP_MODEL_IDS[1])
    {
        Some(MANAGED_CLAUDE_SONNET_ALIAS_DISPLAY_NAME)
    } else if alias.eq_ignore_ascii_case(CLAUDE_DESKTOP_HAIKU_MODEL_ID)
        || alias.eq_ignore_ascii_case(LEGACY_CLAUDE_DESKTOP_MODEL_IDS[2])
    {
        Some(MANAGED_CLAUDE_HAIKU_ALIAS_DISPLAY_NAME)
    } else if claude_desktop_alias_has_valid_syntax(alias) {
        Some("EasyCLIProxyAPI managed Claude Desktop mapping")
    } else {
        None
    }
}

pub(crate) fn claude_desktop_uses_source_directly(
    source_model: &str,
    models: &[AgentModelOption],
) -> bool {
    models
        .iter()
        .any(|model| model.name.eq_ignore_ascii_case(source_model) && model.is_alias)
        || is_claude_native_model_id(source_model)
}

pub(crate) fn is_claude_native_model_id(name: &str) -> bool {
    let name = name.trim();
    if name.is_empty() || claude_desktop_has_other_model_family(name) {
        return false;
    }
    let lowered = name.to_ascii_lowercase();
    if lowered.starts_with("claude-")
        || lowered.starts_with("anthropic.")
        || lowered.contains("anthropic/")
    {
        return true;
    }
    ["opus", "sonnet", "haiku", "fable", "mythos"]
        .into_iter()
        .any(|family| {
            lowered == family
                || lowered
                    .strip_prefix(&format!("{family}-"))
                    .is_some_and(|rest| {
                        !rest.is_empty()
                            && rest
                                .chars()
                                .all(|ch| ch.is_ascii_digit() || ch == '.')
                    })
        })
}

pub(crate) fn is_claude_desktop_route_id(name: &str) -> bool {
    claude_desktop_route_pairs()
        .iter()
        .any(|(current, legacy)| current.eq_ignore_ascii_case(name) || legacy.eq_ignore_ascii_case(name))
}

fn claude_desktop_route_pairs() -> [(&'static str, &'static str); 3] {
    [
        (CLAUDE_DESKTOP_OPUS_MODEL_ID, LEGACY_CLAUDE_DESKTOP_MODEL_IDS[0]),
        (CLAUDE_DESKTOP_SONNET_MODEL_ID, LEGACY_CLAUDE_DESKTOP_MODEL_IDS[1]),
        (CLAUDE_DESKTOP_HAIKU_MODEL_ID, LEGACY_CLAUDE_DESKTOP_MODEL_IDS[2]),
    ]
}

fn paired_claude_desktop_alias(alias: &str) -> Option<&'static str> {
    claude_desktop_route_pairs().into_iter().find_map(|(current, legacy)| {
        if alias.eq_ignore_ascii_case(current) {
            Some(legacy)
        } else if alias.eq_ignore_ascii_case(legacy) {
            Some(current)
        } else {
            None
        }
    })
}

fn occupies_claude_client_alias(model: &serde_norway::Value, alias: &str) -> bool {
    configured_model_identity(model).is_some_and(|(source, client_model, _)| {
        client_model.eq_ignore_ascii_case(alias) && !source.eq_ignore_ascii_case(&client_model)
    })
}

pub(crate) fn is_managed_claude_model_alias(model: &serde_norway::Value, alias: &str) -> bool {
    let Some(expected_display_name) = managed_claude_alias_display_name(alias) else {
        return false;
    };
    let Some((_, client_model, display_name)) = configured_model_identity(model) else {
        return false;
    };
    client_model.eq_ignore_ascii_case(alias)
        && display_name
            .as_deref()
            .is_some_and(|value| value == expected_display_name)
}

pub(crate) fn configured_managed_claude_alias_matches(
    root: &serde_norway::Mapping,
    alias: &str,
    source_model: &str,
) -> bool {
    let matches = |model: &serde_norway::Value| {
        is_managed_claude_model_alias(model, alias)
            && configured_model_identity(model)
                .is_some_and(|(source, _, _)| source.eq_ignore_ascii_case(source_model))
    };
    let configured_provider_alias = MODEL_ALIAS_CONFIG_SECTIONS.iter().any(|section| {
        yaml_mapping_value(root, section)
            .and_then(serde_norway::Value::as_sequence)
            .into_iter()
            .flatten()
            .filter_map(serde_norway::Value::as_mapping)
            .filter(|provider| configured_provider_model_is_enabled(provider, alias))
            .filter_map(|provider| yaml_mapping_value(provider, "models"))
            .filter_map(serde_norway::Value::as_sequence)
            .flatten()
            .any(matches)
    });
    configured_provider_alias
        || yaml_mapping_value(root, "oauth-model-alias")
            .and_then(serde_norway::Value::as_mapping)
            .into_iter()
            .flat_map(|channels| channels.values())
            .filter_map(serde_norway::Value::as_sequence)
            .flatten()
            .any(matches)
}

pub(crate) fn ensure_claude_desktop_model_alias(
    root: &mut serde_norway::Mapping,
    sources: &serde_norway::Mapping,
    source_model: &str,
    alias: &str,
    oauth_model_definitions: &[OAuthModelDefinitions],
) -> Result<(), String> {
    if configured_managed_claude_alias_matches(root, alias, source_model) {
        return Ok(());
    }
    let source = resolve_claude_desktop_alias_source(sources, source_model, alias)?;
    if let Some(source) = source {
        remove_existing_claude_model_alias(root, alias)?;
        append_claude_desktop_model_alias(root, source, alias)?;
        return Ok(());
    }
    if let Some(definition) = oauth_model_definitions.iter().find(|definition| {
        definition
            .models
            .iter()
            .any(|model| model.id.eq_ignore_ascii_case(source_model))
    }) {
        remove_existing_claude_model_alias(root, alias)?;
        append_managed_oauth_model_alias(
            root,
            definition.channel.key,
            source_model,
            alias,
            definition.channel.force_mapping,
        )?;
        return Ok(());
    }
    Err(format!(
        "Unable to determine the CPA configuration source for model {source_model}; cannot create Claude Desktop alias {alias}"
    ))
}

pub(crate) fn configured_model_client_identity(
    root: &serde_norway::Mapping,
    client_model: &str,
) -> Option<(String, String)> {
    for section in MODEL_ALIAS_CONFIG_SECTIONS {
        let Some(providers) =
            yaml_mapping_value(root, section).and_then(serde_norway::Value::as_sequence)
        else {
            continue;
        };
        for provider in providers {
            let Some(provider) = provider.as_mapping() else {
                continue;
            };
            let Some(models) =
                yaml_mapping_value(provider, "models").and_then(serde_norway::Value::as_sequence)
            else {
                continue;
            };
            for model in models {
                let Some((source, configured_client_model, _)) = configured_model_identity(model)
                else {
                    continue;
                };
                if configured_client_model.eq_ignore_ascii_case(client_model) {
                    return Some((source, configured_client_model));
                }
            }
        }
    }
    if let Some(oauth_aliases) =
        yaml_mapping_value(root, "oauth-model-alias").and_then(serde_norway::Value::as_mapping)
    {
        for entries in oauth_aliases
            .values()
            .filter_map(serde_norway::Value::as_sequence)
        {
            for model in entries {
                let Some((source, configured_client_model, _)) = configured_model_identity(model)
                else {
                    continue;
                };
                if configured_client_model.eq_ignore_ascii_case(client_model) {
                    return Some((source, configured_client_model));
                }
            }
        }
    }
    None
}

enum ClaudeDesktopAliasSource {
    Provider {
        section: &'static str,
        provider_index: usize,
        model: serde_norway::Mapping,
    },
    OAuth {
        channel: String,
        model: serde_norway::Mapping,
    },
}

pub(crate) fn configured_provider_model_is_enabled(provider: &serde_norway::Mapping, model: &str) -> bool {
    if yaml_mapping_value(provider, "disabled") == Some(&serde_norway::Value::Bool(true)) {
        return false;
    }
    let model = model.trim().to_lowercase();
    !yaml_mapping_value(provider, "excluded-models")
        .and_then(serde_norway::Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(serde_norway::Value::as_str)
        .any(|pattern| {
            let pattern = pattern.trim().to_lowercase();
            if pattern.is_empty() {
                return false;
            }
            let Some((prefix, rest)) = pattern.split_once('*') else {
                return pattern == model;
            };
            let Some(mut remaining) = model.strip_prefix(prefix) else {
                return false;
            };
            let mut parts = rest.rsplitn(2, '*');
            let suffix = parts.next().unwrap_or_default();
            let Some(middle) = remaining.strip_suffix(suffix) else {
                return false;
            };
            remaining = middle;
            if let Some(parts) = parts.next() {
                for part in parts.split('*').filter(|part| !part.is_empty()) {
                    let Some(index) = remaining.find(part) else {
                        return false;
                    };
                    remaining = &remaining[index + part.len()..];
                }
            }
            true
        })
}

fn resolve_claude_desktop_alias_source(
    root: &serde_norway::Mapping,
    source_model: &str,
    alias: &str,
) -> Result<Option<ClaudeDesktopAliasSource>, String> {
    for upstream in [false, true] {
        let matching_model = |model: &serde_norway::Value| {
            let (name, client_model, _) = configured_model_identity(model)?;
            let matches = if upstream { &name } else { &client_model };
            if !matches.eq_ignore_ascii_case(source_model) {
                return None;
            }
            let mut model = model.as_mapping().cloned().unwrap_or_default();
            model.insert(yaml_key("name"), serde_norway::Value::String(name));
            Some(model)
        };
        for section in MODEL_ALIAS_CONFIG_SECTIONS {
            let Some(providers) = yaml_mapping_value(root, section) else {
                continue;
            };
            let providers = providers
                .as_sequence()
                .ok_or_else(|| format!("{section} must be an array"))?;
            for (provider_index, provider) in providers.iter().enumerate() {
                let Some(provider) = provider.as_mapping() else {
                    continue;
                };
                if !configured_provider_model_is_enabled(provider, alias) {
                    continue;
                }
                let Some(models) = yaml_mapping_value(provider, "models") else {
                    continue;
                };
                let models = models
                    .as_sequence()
                    .ok_or_else(|| format!("{section}.models must be an array"))?;
                if let Some(model) = models.iter().find_map(|model| {
                    let (_, client_model, _) = configured_model_identity(model)?;
                    if !configured_provider_model_is_enabled(provider, &client_model) {
                        return None;
                    }
                    matching_model(model)
                }) {
                    return Ok(Some(ClaudeDesktopAliasSource::Provider {
                        section,
                        provider_index,
                        model,
                    }));
                }
            }
        }
        if let Some(channels) =
            yaml_mapping_value(root, "oauth-model-alias").and_then(serde_norway::Value::as_mapping)
        {
            for (channel, models) in channels {
                let (Some(channel), Some(models)) = (channel.as_str(), models.as_sequence()) else {
                    continue;
                };
                if let Some(model) = models.iter().find_map(matching_model) {
                    return Ok(Some(ClaudeDesktopAliasSource::OAuth {
                        channel: channel.to_string(),
                        model,
                    }));
                }
            }
        }
    }
    Ok(None)
}

fn append_claude_desktop_model_alias(
    root: &mut serde_norway::Mapping,
    source: ClaudeDesktopAliasSource,
    alias: &str,
) -> Result<(), String> {
    let (models, mut model) = match source {
        ClaudeDesktopAliasSource::Provider {
            section,
            provider_index,
            model,
        } => {
            let models = yaml_mapping_value_mut(root, section)
                .and_then(serde_norway::Value::as_sequence_mut)
                .and_then(|providers| providers.get_mut(provider_index))
                .and_then(serde_norway::Value::as_mapping_mut)
                .and_then(|provider| yaml_mapping_value_mut(provider, "models"))
                .and_then(serde_norway::Value::as_sequence_mut)
                .ok_or("Model source configuration changed. Refresh and try again")?;
            (models, model)
        }
        ClaudeDesktopAliasSource::OAuth { channel, mut model } => {
            let aliases = root
                .entry(yaml_key("oauth-model-alias"))
                .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
                .as_mapping_mut()
                .ok_or("oauth-model-alias must be a YAML mapping")?;
            let models = aliases
                .entry(yaml_key(&channel))
                .or_insert_with(|| serde_norway::Value::Sequence(Vec::new()))
                .as_sequence_mut()
                .ok_or_else(|| format!("oauth-model-alias.{channel} must be an array"))?;
            model.insert(yaml_key("fork"), serde_norway::Value::Bool(true));
            if oauth_alias_channel(&channel).is_some_and(|channel| channel.force_mapping) {
                model.insert(yaml_key("force-mapping"), serde_norway::Value::Bool(true));
            }
            (models, model)
        }
    };
    model.insert(
        yaml_key("alias"),
        serde_norway::Value::String(alias.to_string()),
    );
    let display_name = managed_claude_alias_display_name(alias)
        .ok_or_else(|| format!("Unsupported Claude managed alias: {alias}"))?;
    model.insert(
        yaml_key("display-name"),
        serde_norway::Value::String(display_name.to_string()),
    );
    models.push(serde_norway::Value::Mapping(model));
    Ok(())
}

pub(crate) fn append_managed_oauth_model_alias(
    root: &mut serde_norway::Mapping,
    channel: &str,
    source_model: &str,
    alias: &str,
    force_mapping: bool,
) -> Result<(), String> {
    let oauth_aliases = root
        .entry(yaml_key("oauth-model-alias"))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| "oauth-model-alias must be a YAML mapping".to_string())?;
    let channel_aliases = oauth_aliases
        .entry(yaml_key(channel))
        .or_insert_with(|| serde_norway::Value::Sequence(Vec::new()))
        .as_sequence_mut()
        .ok_or_else(|| format!("oauth-model-alias.{channel} must be an array"))?;
    let display_name = managed_claude_alias_display_name(alias)
        .ok_or_else(|| format!("Unsupported Claude managed alias: {alias}"))?;
    let mut alias_mapping = serde_norway::Mapping::new();
    alias_mapping.insert(
        yaml_key("name"),
        serde_norway::Value::String(source_model.to_string()),
    );
    alias_mapping.insert(
        yaml_key("alias"),
        serde_norway::Value::String(alias.to_string()),
    );
    alias_mapping.insert(yaml_key("fork"), serde_norway::Value::Bool(true));
    if force_mapping {
        alias_mapping.insert(yaml_key("force-mapping"), serde_norway::Value::Bool(true));
    }
    alias_mapping.insert(
        yaml_key("display-name"),
        serde_norway::Value::String(display_name.to_string()),
    );
    channel_aliases.push(serde_norway::Value::Mapping(alias_mapping));
    Ok(())
}
