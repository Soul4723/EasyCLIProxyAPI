use super::*;

pub(crate) fn add_model_alias_to_yaml(
    content: &str,
    source: &ResolvedThinkingAliasSource,
    alias: &str,
    effort: &str,
    fast: bool,
) -> Result<String, String> {
    if fast && !alias_source_supports_fast(source) {
        return Err("Fast supports only OpenAI-compatible API, Codex API, or Codex OAuth model sources".to_string());
    }
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let sharing_alias = configured_model_alias_exists(root, alias);

    match &source.location {
        ThinkingAliasSourceLocation::Oauth {
            channel,
            force_mapping,
        } => append_oauth_model_alias(root, channel, &source.source.model, alias, *force_mapping)?,
        ThinkingAliasSourceLocation::ConfigModel {
            section,
            provider_index,
            model_index,
        } => append_config_thinking_alias(
            root,
            section,
            *provider_index,
            *model_index,
            &source.source.model,
            alias,
            effort,
        )?,
    }

    let scope = AliasPayloadScope::for_protocol(&source.source.protocol);
    if !sharing_alias {
        remove_alias_payload_options(root, alias, &scope)?;
    }
    if !effort.is_empty() {
        let mut params_mapping = serde_norway::Mapping::new();
        insert_thinking_effort_params(&mut params_mapping, &source.source, effort)?;
        append_alias_payload_override(root, alias, &source.source.protocol, params_mapping)?;
    }
    if fast {
        let mut params_mapping = serde_norway::Mapping::new();
        params_mapping.insert(
            yaml_key("service_tier"),
            serde_norway::Value::String("priority".to_string()),
        );
        append_alias_payload_override(root, alias, &source.source.protocol, params_mapping)?;
    }

    render_updated_core_yaml(&mut document, updated)
}

pub(crate) fn append_alias_payload_override(
    root: &mut serde_norway::Mapping,
    alias: &str,
    protocol: &str,
    params_mapping: serde_norway::Mapping,
) -> Result<(), String> {
    if params_mapping.is_empty() {
        return Ok(());
    }
    let payload = root
        .entry(yaml_key("payload"))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| "payload must be a YAML mapping".to_string())?;
    let override_rules = payload
        .entry(yaml_key("override"))
        .or_insert_with(|| serde_norway::Value::Sequence(Vec::new()))
        .as_sequence_mut()
        .ok_or_else(|| "payload.override must be an array".to_string())?;

    let mut model_mapping = serde_norway::Mapping::new();
    model_mapping.insert(
        yaml_key("name"),
        serde_norway::Value::String(alias.to_string()),
    );
    model_mapping.insert(
        yaml_key("protocol"),
        serde_norway::Value::String(protocol.to_string()),
    );
    let mut rule_mapping = serde_norway::Mapping::new();
    rule_mapping.insert(
        yaml_key("models"),
        serde_norway::Value::Sequence(vec![serde_norway::Value::Mapping(model_mapping)]),
    );
    rule_mapping.insert(
        yaml_key("params"),
        serde_norway::Value::Mapping(params_mapping),
    );
    override_rules.push(serde_norway::Value::Mapping(rule_mapping));
    Ok(())
}

pub(crate) fn add_speed_alias_to_yaml(
    content: &str,
    source: &ResolvedThinkingAliasSource,
    alias: &str,
) -> Result<String, String> {
    if !alias_source_supports_fast(source) {
        return Err("Fast supports only OpenAI-compatible API, Codex API, or Codex OAuth model sources".to_string());
    }
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let sharing_alias = configured_model_alias_exists(root, alias);

    match &source.location {
        ThinkingAliasSourceLocation::Oauth {
            channel,
            force_mapping,
        } => append_oauth_model_alias(root, channel, &source.source.model, alias, *force_mapping)?,
        ThinkingAliasSourceLocation::ConfigModel {
            section,
            provider_index,
            model_index,
        } => append_config_speed_alias(
            root,
            section,
            *provider_index,
            *model_index,
            &source.source.model,
            alias,
        )?,
    }

    if !sharing_alias {
        remove_alias_payload_options(
        root,
        alias,
        &AliasPayloadScope::for_protocol(&source.source.protocol),
        )?;
    }
    let mut params_mapping = serde_norway::Mapping::new();
    params_mapping.insert(
        yaml_key("service_tier"),
        serde_norway::Value::String("priority".to_string()),
    );
    append_alias_payload_override(root, alias, &source.source.protocol, params_mapping)?;

    render_updated_core_yaml(&mut document, updated)
}

pub(crate) fn append_oauth_model_alias(
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
    channel_aliases.push(serde_norway::Value::Mapping(alias_mapping));
    Ok(())
}

pub(crate) fn append_config_thinking_alias(
    root: &mut serde_norway::Mapping,
    section: &str,
    provider_index: usize,
    model_index: usize,
    expected_model: &str,
    alias: &str,
    effort: &str,
) -> Result<(), String> {
    let providers = yaml_mapping_value_mut(root, section)
        .and_then(serde_norway::Value::as_sequence_mut)
        .ok_or_else(|| format!("{section} must be an array"))?;
    let provider = providers
        .get_mut(provider_index)
        .and_then(serde_norway::Value::as_mapping_mut)
        .ok_or_else(|| "Model provider changed. Refresh and try again".to_string())?;
    let models = yaml_mapping_value_mut(provider, "models")
        .and_then(serde_norway::Value::as_sequence_mut)
        .ok_or_else(|| format!("{section}.models must be an array"))?;
    let source = models
        .get(model_index)
        .cloned()
        .ok_or_else(|| "Source model changed. Refresh and try again".to_string())?;
    let (_, current_model, _) =
        configured_model_identity(&source).ok_or_else(|| "Invalid source model configuration format".to_string())?;
    if !current_model.eq_ignore_ascii_case(expected_model) {
        return Err("Source model changed. Refresh and try again".to_string());
    }
    let mut alias_model = source.as_mapping().cloned().unwrap_or_else(|| {
        let mut mapping = serde_norway::Mapping::new();
        if let Some(name) = source.as_str() {
            mapping.insert(
                yaml_key("name"),
                serde_norway::Value::String(name.to_string()),
            );
        }
        mapping
    });
    alias_model.insert(
        yaml_key("alias"),
        serde_norway::Value::String(alias.to_string()),
    );
    if !effort.is_empty() {
        if let Some(display_name) = yaml_mapping_value(&alias_model, "display-name")
            .and_then(serde_norway::Value::as_str)
            .map(str::to_string)
        {
            alias_model.insert(
                yaml_key("display-name"),
                serde_norway::Value::String(format!("{display_name} ({effort})")),
            );
        }
    }
    models.push(serde_norway::Value::Mapping(alias_model));
    Ok(())
}

pub(crate) fn append_config_speed_alias(
    root: &mut serde_norway::Mapping,
    section: &str,
    provider_index: usize,
    model_index: usize,
    expected_model: &str,
    alias: &str,
) -> Result<(), String> {
    let providers = yaml_mapping_value_mut(root, section)
        .and_then(serde_norway::Value::as_sequence_mut)
        .ok_or_else(|| format!("{section} must be an array"))?;
    let provider = providers
        .get_mut(provider_index)
        .and_then(serde_norway::Value::as_mapping_mut)
        .ok_or_else(|| "Model provider changed. Refresh and try again".to_string())?;
    let models = yaml_mapping_value_mut(provider, "models")
        .and_then(serde_norway::Value::as_sequence_mut)
        .ok_or_else(|| format!("{section}.models must be an array"))?;
    let source = models
        .get(model_index)
        .cloned()
        .ok_or_else(|| "Source model changed. Refresh and try again".to_string())?;
    let (_, current_model, _) =
        configured_model_identity(&source).ok_or_else(|| "Invalid source model configuration format".to_string())?;
    if !current_model.eq_ignore_ascii_case(expected_model) {
        return Err("Source model changed. Refresh and try again".to_string());
    }
    let mut alias_model = source.as_mapping().cloned().unwrap_or_else(|| {
        let mut mapping = serde_norway::Mapping::new();
        if let Some(name) = source.as_str() {
            mapping.insert(
                yaml_key("name"),
                serde_norway::Value::String(name.to_string()),
            );
        }
        mapping
    });
    alias_model.insert(
        yaml_key("alias"),
        serde_norway::Value::String(alias.to_string()),
    );
    if let Some(display_name) = yaml_mapping_value(&alias_model, "display-name")
        .and_then(serde_norway::Value::as_str)
        .map(str::to_string)
    {
        alias_model.insert(
            yaml_key("display-name"),
            serde_norway::Value::String(format!("{display_name} (Fast)")),
        );
    }
    models.push(serde_norway::Value::Mapping(alias_model));
    Ok(())
}

#[cfg(test)]
pub(crate) fn remove_thinking_alias_from_yaml(
    content: &str,
    alias: &str,
) -> Result<String, String> {
    remove_thinking_alias_from_yaml_for_channel(content, alias, None)
}

pub(crate) fn remove_thinking_alias_from_yaml_for_channel(
    content: &str,
    alias: &str,
    oauth_channel: Option<&str>,
) -> Result<String, String> {
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let mut removed = remove_oauth_model_alias(root, alias, oauth_channel)?;
    if oauth_channel.is_none() {
        removed |= remove_config_model_alias(root, "codex-api-key", alias)?;
        removed |= remove_config_model_alias(root, "openai-compatibility", alias)?;
        removed |= remove_config_model_alias(root, "claude-api-key", alias)?;
        removed |= remove_config_model_alias(root, "gemini-api-key", alias)?;
    }
    if !removed {
        return Err(format!("Alias model {alias} does not exist. Refresh and try again"));
    }
    let scope = AliasPayloadScope::after_removal(root, alias, oauth_channel);
    remove_alias_payload_options(root, alias, &scope)?;
    render_updated_core_yaml(&mut document, updated)
}

#[cfg(test)]
pub(crate) fn remove_speed_alias_from_yaml(content: &str, alias: &str) -> Result<String, String> {
    remove_speed_alias_from_yaml_for_channel(content, alias, None)
}

pub(crate) fn remove_speed_alias_from_yaml_for_channel(
    content: &str,
    alias: &str,
    oauth_channel: Option<&str>,
) -> Result<String, String> {
    let mut document = yaml_serde_edit::YamlValue::parse(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    let mut updated = document.get().clone();
    let root = updated
        .as_mapping_mut()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let mut removed = remove_oauth_model_alias(root, alias, oauth_channel)?;
    if oauth_channel.is_none() {
        removed |= remove_config_speed_alias(root, "codex-api-key", "codex", alias)?;
        removed |= remove_config_speed_alias(root, "openai-compatibility", "openai", alias)?;
    }
    if !removed {
        return Err(format!("Alias model {alias} does not exist. Refresh and try again"));
    }
    let scope = AliasPayloadScope::after_removal(root, alias, oauth_channel);
    remove_alias_payload_options(root, alias, &scope)?;
    render_updated_core_yaml(&mut document, updated)
}

pub(crate) fn remove_oauth_model_alias(
    root: &mut serde_norway::Mapping,
    alias: &str,
    target_channel: Option<&str>,
) -> Result<bool, String> {
    let Some(oauth_aliases) = yaml_mapping_value_mut(root, "oauth-model-alias") else {
        return Ok(false);
    };
    let oauth_aliases = oauth_aliases
        .as_mapping_mut()
        .ok_or_else(|| "oauth-model-alias must be a YAML mapping".to_string())?;
    let mut removed = false;
    let mut empty_channels = Vec::new();
    for (channel, entries) in oauth_aliases.iter_mut() {
        let channel_name = channel.as_str().unwrap_or("unknown");
        if target_channel.is_some_and(|target| !target.eq_ignore_ascii_case(channel_name)) {
            continue;
        }
        let entries = entries
            .as_sequence_mut()
            .ok_or_else(|| format!("oauth-model-alias.{channel_name} must be an array"))?;
        entries.retain(|entry| {
            let matches = entry
                .as_mapping()
                .and_then(|mapping| yaml_mapping_value(mapping, "alias"))
                .and_then(serde_norway::Value::as_str)
                .is_some_and(|value| value.trim().eq_ignore_ascii_case(alias));
            removed |= matches;
            !matches
        });
        if entries.is_empty() {
            empty_channels.push(channel.clone());
        }
    }
    for channel in empty_channels {
        oauth_aliases.remove(&channel);
    }
    let remove_section = oauth_aliases.is_empty();
    if remove_section {
        root.remove(yaml_key("oauth-model-alias"));
    }
    Ok(removed)
}

pub(crate) fn configured_model_alias_exists(root: &serde_norway::Mapping, alias: &str) -> bool {
    let oauth_exists = yaml_mapping_value(root, "oauth-model-alias")
        .and_then(serde_norway::Value::as_mapping)
        .is_some_and(|channels| {
            channels.values().any(|entries| {
                entries.as_sequence().is_some_and(|entries| {
                    entries.iter().any(|entry| {
                        entry
                            .as_mapping()
                            .and_then(|mapping| yaml_mapping_value(mapping, "alias"))
                            .and_then(serde_norway::Value::as_str)
                            .is_some_and(|value| value.trim().eq_ignore_ascii_case(alias))
                    })
                })
            })
        });
    oauth_exists
        || MODEL_ALIAS_CONFIG_SECTIONS
            .iter()
            .filter_map(|section| yaml_mapping_value(root, section))
            .filter_map(serde_norway::Value::as_sequence)
            .flatten()
            .filter_map(serde_norway::Value::as_mapping)
            .filter_map(|provider| yaml_mapping_value(provider, "models"))
            .filter_map(serde_norway::Value::as_sequence)
            .flatten()
            .filter_map(|model| configured_model_identity(model).map(|(_, alias, _)| alias))
            .any(|value| value.eq_ignore_ascii_case(alias))
}

pub(crate) fn remove_config_model_alias(
    root: &mut serde_norway::Mapping,
    section: &str,
    alias: &str,
) -> Result<bool, String> {
    let Some(providers) = yaml_mapping_value_mut(root, section) else {
        return Ok(false);
    };
    let providers = providers
        .as_sequence_mut()
        .ok_or_else(|| format!("{section} must be an array"))?;
    let mut removed = false;
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
        models.retain(|model| {
            let matches = configured_model_identity(model)
                .map(|(source, model_alias, _)| {
                    source != model_alias && model_alias.eq_ignore_ascii_case(alias)
                })
                .unwrap_or(false);
            removed |= matches;
            !matches
        });
    }
    Ok(removed)
}

pub(crate) fn remove_config_speed_alias(
    root: &mut serde_norway::Mapping,
    section: &str,
    protocol: &str,
    alias: &str,
) -> Result<bool, String> {
    if find_speed_alias_service_tier(root, alias, protocol).is_none() {
        return Ok(false);
    }
    let Some(providers) = yaml_mapping_value_mut(root, section) else {
        return Ok(false);
    };
    let providers = providers
        .as_sequence_mut()
        .ok_or_else(|| format!("{section} must be an array"))?;
    let mut removed = false;
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
        models.retain(|model| {
            let matches = configured_model_identity(model)
                .map(|(source, model_alias, _)| {
                    source != model_alias && model_alias.eq_ignore_ascii_case(alias)
                })
                .unwrap_or(false);
            removed |= matches;
            !matches
        });
    }
    Ok(removed)
}

pub(crate) struct AliasPayloadScope {
    protocol: Option<String>,
    preserved_protocols: BTreeSet<String>,
}

impl AliasPayloadScope {
    fn for_protocol(protocol: &str) -> Self {
        Self {
            protocol: Some(protocol.to_string()),
            preserved_protocols: BTreeSet::new(),
        }
    }

    pub(crate) fn after_removal(root: &serde_norway::Mapping, alias: &str, channel: Option<&str>) -> Self {
        let mut preserved_protocols = BTreeSet::new();
        if let Some(channels) =
            yaml_mapping_value(root, "oauth-model-alias").and_then(serde_norway::Value::as_mapping)
        {
            for (channel, entries) in channels {
                let matches = entries.as_sequence().is_some_and(|entries| {
                    entries.iter().any(|entry| {
                        entry
                            .as_mapping()
                            .and_then(|entry| yaml_mapping_value(entry, "alias"))
                            .and_then(serde_norway::Value::as_str)
                            .is_some_and(|name| name.trim().eq_ignore_ascii_case(alias))
                    })
                });
                if matches {
                    preserved_protocols.insert(
                        oauth_alias_channel_details(channel.as_str().unwrap_or_default()).2,
                    );
                }
            }
        }
        for (section, protocol) in [
            ("codex-api-key", "codex"),
            ("openai-compatibility", "openai"),
            ("claude-api-key", "claude"),
            ("gemini-api-key", "gemini"),
        ] {
            let matches = yaml_mapping_value(root, section)
                .and_then(serde_norway::Value::as_sequence)
                .into_iter()
                .flatten()
                .filter_map(serde_norway::Value::as_mapping)
                .filter_map(|provider| yaml_mapping_value(provider, "models"))
                .filter_map(serde_norway::Value::as_sequence)
                .flatten()
                .filter_map(configured_model_identity)
                .any(|(_, name, _)| name.eq_ignore_ascii_case(alias));
            if matches {
                preserved_protocols.insert(protocol.to_string());
            }
        }
        Self {
            protocol: channel.map(|channel| oauth_alias_channel_details(channel).2),
            preserved_protocols,
        }
    }

    pub(crate) fn matches(&self, model: &serde_norway::Value, alias: &str) -> bool {
        if !thinking_payload_model_name_matches(model, alias) {
            return false;
        }
        let protocol = model
            .as_mapping()
            .and_then(|model| yaml_mapping_value(model, "protocol"))
            .and_then(serde_norway::Value::as_str)
            .map(str::trim)
            .filter(|protocol| !protocol.is_empty());
        match protocol {
            Some(protocol) => {
                self.protocol
                    .as_ref()
                    .is_none_or(|target| target.eq_ignore_ascii_case(protocol))
                    && !self
                        .preserved_protocols
                        .iter()
                        .any(|existing| existing.eq_ignore_ascii_case(protocol))
            }
            None => self.preserved_protocols.is_empty(),
        }
    }
}

pub(crate) fn remove_alias_payload_options(
    root: &mut serde_norway::Mapping,
    alias: &str,
    scope: &AliasPayloadScope,
) -> Result<(), String> {
    let Some(payload) = yaml_mapping_value_mut(root, "payload") else {
        return Ok(());
    };
    let payload = payload.as_mapping_mut().ok_or("payload must be a YAML mapping")?;
    for section in ["override", "override-raw"] {
        let Some(rules) = yaml_mapping_value_mut(payload, section) else {
            continue;
        };
        let rules = rules
            .as_sequence_mut()
            .ok_or_else(|| format!("payload.{section} must be an array"))?;
        let mut next = Vec::with_capacity(rules.len());
        for rule in rules.iter() {
            let Some(mapping) = rule.as_mapping() else {
                next.push(rule.clone());
                continue;
            };
            let Some(params) =
                yaml_mapping_value(mapping, "params").and_then(serde_norway::Value::as_mapping)
            else {
                next.push(rule.clone());
                continue;
            };
            let mut retained_params = params.clone();
            for key in ALIAS_EFFORT_KEYS.iter().copied().chain(["service_tier"]) {
                retained_params.remove(yaml_key(key));
            }
            if retained_params == *params {
                next.push(rule.clone());
                continue;
            }
            let Some(models) = yaml_mapping_value(mapping, "models") else {
                next.push(rule.clone());
                continue;
            };
            let models = models
                .as_sequence()
                .ok_or_else(|| format!("payload.{section}.models must be an array"))?;
            let (target, others): (Vec<_>, Vec<_>) = models
                .iter()
                .cloned()
                .partition(|model| scope.matches(model, alias));
            if target.is_empty() {
                next.push(rule.clone());
                continue;
            }
            if !others.is_empty() {
                let mut shared = mapping.clone();
                shared.insert(yaml_key("models"), serde_norway::Value::Sequence(others));
                next.push(serde_norway::Value::Mapping(shared));
            }
            if !retained_params.is_empty() {
                let mut retained = mapping.clone();
                retained.insert(yaml_key("models"), serde_norway::Value::Sequence(target));
                retained.insert(
                    yaml_key("params"),
                    serde_norway::Value::Mapping(retained_params),
                );
                next.push(serde_norway::Value::Mapping(retained));
            }
        }
        *rules = next;
        if rules.is_empty() {
            payload.remove(yaml_key(section));
        }
    }
    if payload.is_empty() {
        root.remove(yaml_key("payload"));
    }
    Ok(())
}
