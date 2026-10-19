use super::*;

pub(crate) async fn fetch_oauth_channel_model_definitions(
    config: &GuiConfigFile,
    channel: &str,
) -> Result<Vec<CodexModelDefinition>, String> {
    let client = management_api::management_http_client_for(config)?;
    let response = client
        .get(management_endpoint(
            config,
            &format!("routing/model-definitions/{channel}"),
        )?)
        .header("Authorization", management_authorization(config)?)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| {
            format_management_request_error(&format!("Failed to read {channel} OAuth model definition"), &error)
        })?;
    let payload = read_management_value(response).await?;
    parse_codex_model_definitions(&payload)
}

pub(crate) async fn fetch_oauth_model_definitions(
    config: &GuiConfigFile,
) -> Vec<OAuthModelDefinitions> {
    let active_channels = fetch_active_oauth_alias_channels(config).await.ok();
    let mut definitions = Vec::new();
    for channel in OAUTH_ALIAS_CHANNELS {
        if active_channels
            .as_ref()
            .is_some_and(|active| !active.contains(channel.key))
        {
            continue;
        }
        if let Ok(models) = fetch_oauth_channel_model_definitions(config, channel.key).await {
            definitions.push(OAuthModelDefinitions { channel, models });
        }
    }
    definitions
}

#[cfg(test)]
pub(crate) fn resolved_thinking_alias_sources(
    content: &str,
    definitions: &[CodexModelDefinition],
    available_models: &[AgentModelOption],
) -> Result<Vec<ResolvedThinkingAliasSource>, String> {
    let definitions = codex_oauth_definition_set(definitions);
    resolved_oauth_alias_sources(
        content,
        &definitions,
        available_models,
        AliasSourceCapability::Reasoning,
    )
}

#[cfg(test)]
pub(crate) fn resolved_speed_alias_sources(
    content: &str,
    definitions: &[CodexModelDefinition],
    available_models: &[AgentModelOption],
) -> Result<Vec<ResolvedThinkingAliasSource>, String> {
    let definitions = codex_oauth_definition_set(definitions);
    resolved_oauth_alias_sources(
        content,
        &definitions,
        available_models,
        AliasSourceCapability::Fast,
    )
}

#[cfg(test)]
pub(crate) fn resolved_alias_sources(
    content: &str,
    definitions: &[CodexModelDefinition],
    available_models: &[AgentModelOption],
    require_reasoning_levels: bool,
) -> Result<Vec<ResolvedThinkingAliasSource>, String> {
    let definitions = codex_oauth_definition_set(definitions);
    resolved_oauth_alias_sources(
        content,
        &definitions,
        available_models,
        if require_reasoning_levels {
            AliasSourceCapability::Reasoning
        } else {
            AliasSourceCapability::Base
        },
    )
}

#[cfg(test)]
pub(crate) fn codex_oauth_definition_set(
    definitions: &[CodexModelDefinition],
) -> Vec<OAuthModelDefinitions> {
    vec![OAuthModelDefinitions {
        channel: OAUTH_ALIAS_CHANNELS
            .iter()
            .copied()
            .find(|channel| channel.key == "codex")
            .expect("codex OAuth alias channel must exist"),
        models: definitions.to_vec(),
    }]
}

pub(crate) fn resolved_oauth_alias_sources(
    content: &str,
    definition_sets: &[OAuthModelDefinitions],
    available_models: &[AgentModelOption],
    capability: AliasSourceCapability,
) -> Result<Vec<ResolvedThinkingAliasSource>, String> {
    let document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    let root = document
        .as_mapping()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let mut sources = Vec::new();
    collect_config_thinking_alias_sources(
        root,
        "codex-api-key",
        "Codex API",
        "codex-api",
        "codex",
        available_models,
        &mut sources,
    )?;
    collect_config_thinking_alias_sources(
        root,
        "openai-compatibility",
        "OpenAI-compatible",
        "openai-compatible",
        "openai",
        available_models,
        &mut sources,
    )?;
    collect_config_thinking_alias_sources(
        root,
        "claude-api-key",
        "Claude API",
        "claude-api",
        "claude",
        available_models,
        &mut sources,
    )?;
    collect_config_thinking_alias_sources(
        root,
        "gemini-api-key",
        "Gemini API",
        "gemini-api",
        "gemini",
        available_models,
        &mut sources,
    )?;
    match capability {
        AliasSourceCapability::Reasoning => {
            sources.retain(|source| !source.source.reasoning_levels.is_empty())
        }
        AliasSourceCapability::Fast => sources.retain(alias_source_supports_fast),
        AliasSourceCapability::Base => {}
    }
    let configured_codex_api_models = sources
        .iter()
        .filter(|source| source.source.kind == "codex-api")
        .map(|source| source.source.model.to_ascii_lowercase())
        .collect::<std::collections::HashSet<_>>();
    for definition_set in definition_sets {
        let channel = definition_set.channel;
        let supports_capability = match capability {
            AliasSourceCapability::Base => true,
            AliasSourceCapability::Reasoning => channel.supports_reasoning,
            AliasSourceCapability::Fast => channel.supports_fast,
        };
        if !supports_capability {
            continue;
        }
        sources.extend(
            definition_set
                .models
                .iter()
                .filter(|definition| {
                    (capability != AliasSourceCapability::Reasoning
                        || !definition.reasoning_levels.is_empty())
                        && thinking_alias_model_is_available(available_models, &definition.id)
                        && (channel.key != "codex"
                            || !configured_codex_api_models
                                .contains(&definition.id.to_ascii_lowercase()))
                })
                .map(|definition| ResolvedThinkingAliasSource {
                    source: ThinkingAliasSource {
                        id: format!("{}:{}", channel.kind, definition.id),
                        model: definition.id.clone(),
                        display_name: definition.display_name.clone(),
                        provider: channel.provider.to_string(),
                        kind: channel.kind.to_string(),
                        protocol: channel.protocol.to_string(),
                        reasoning_levels: definition.reasoning_levels.clone(),
                    },
                    location: ThinkingAliasSourceLocation::Oauth {
                        channel: channel.key,
                        force_mapping: channel.force_mapping,
                    },
                }),
        );
    }
    Ok(sources)
}

pub(crate) fn thinking_alias_model_is_available(
    available_models: &[AgentModelOption],
    model: &str,
) -> bool {
    available_models
        .iter()
        .any(|available| available.name.eq_ignore_ascii_case(model))
}

pub(crate) fn alias_source_supports_fast(source: &ResolvedThinkingAliasSource) -> bool {
    match &source.location {
        ThinkingAliasSourceLocation::Oauth { channel, .. } => *channel == "codex",
        ThinkingAliasSourceLocation::ConfigModel { section, .. } => {
            matches!(*section, "codex-api-key" | "openai-compatibility")
        }
    }
}

fn provider_has_unaliased_model(provider: &serde_norway::Mapping, upstream_model: &str) -> bool {
    yaml_mapping_value(provider, "models")
        .and_then(serde_norway::Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(configured_model_identity)
        .any(|(upstream, client, _)| {
            upstream.eq_ignore_ascii_case(upstream_model)
                && client.eq_ignore_ascii_case(&upstream)
                && configured_provider_model_is_enabled(provider, &client)
        })
}

pub(crate) fn collect_config_thinking_alias_sources(
    root: &serde_norway::Mapping,
    section: &'static str,
    fallback_provider: &str,
    kind: &str,
    protocol: &str,
    available_models: &[AgentModelOption],
    sources: &mut Vec<ResolvedThinkingAliasSource>,
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
        if matches!(
            yaml_mapping_value(provider, "disabled"),
            Some(serde_norway::Value::Bool(true))
        ) {
            continue;
        }
        let provider_name =
            thinking_alias_provider_name(provider, fallback_provider, provider_index);
        let provider_revision = sha256_bytes(
            serde_norway::to_string(provider)
                .map_err(|error| format!("Failed to read model source configuration: {error}"))?
                .as_bytes(),
        );
        let Some(models) = yaml_mapping_value(provider, "models") else {
            continue;
        };
        let models = models
            .as_sequence()
            .ok_or_else(|| format!("{section}.models must be an array"))?;
        for (model_index, model) in models.iter().enumerate() {
            let Some((upstream_model, client_model, display_name)) =
                configured_model_identity(model)
            else {
                continue;
            };
            // A matching ID may be served by another provider. Check this
            // source's exclusions too, including '*' used to disable API keys.
            if !configured_provider_model_is_enabled(provider, &client_model)
                || !thinking_alias_model_is_available(available_models, &client_model)
            {
                continue;
            }
            if !client_model.eq_ignore_ascii_case(&upstream_model)
                && provider_has_unaliased_model(provider, &upstream_model)
            {
                continue;
            }
            let reasoning_levels = configured_model_reasoning_levels(model, protocol);
            sources.push(ResolvedThinkingAliasSource {
                source: ThinkingAliasSource {
                    id: format!("{section}:{provider_index}:{model_index}:{provider_revision}"),
                    model: client_model,
                    display_name,
                    provider: provider_name.clone(),
                    kind: kind.to_string(),
                    protocol: protocol.to_string(),
                    reasoning_levels,
                },
                location: ThinkingAliasSourceLocation::ConfigModel {
                    section,
                    provider_index,
                    model_index,
                },
            });
        }
    }
    Ok(())
}

pub(crate) fn configured_model_reasoning_levels(
    model: &serde_norway::Value,
    protocol: &str,
) -> Vec<String> {
    let mut levels = model
        .as_mapping()
        .and_then(|model| yaml_mapping_value(model, "thinking"))
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|thinking| yaml_mapping_value(thinking, "levels"))
        .and_then(serde_norway::Value::as_sequence)
        .into_iter()
        .flatten()
        .filter_map(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|level| !level.is_empty())
        .map(str::to_ascii_lowercase)
        .fold(Vec::new(), |mut result, level| {
            if !result.contains(&level) {
                result.push(level);
            }
            result
        });
    if levels.is_empty() && matches!(protocol, "codex" | "openai") {
        levels = ["low", "medium", "high", "xhigh", "max"]
            .into_iter()
            .map(str::to_string)
            .collect();
    }
    levels
}

pub(crate) fn thinking_alias_provider_name(
    provider: &serde_norway::Mapping,
    fallback: &str,
    index: usize,
) -> String {
    yaml_mapping_value(provider, "name")
        .or_else(|| yaml_mapping_value(provider, "base-url"))
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{fallback} {}", index + 1))
}

pub(crate) fn configured_model_identity(
    model: &serde_norway::Value,
) -> Option<(String, String, Option<String>)> {
    if let Some(name) = model
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        return Some((name.to_string(), name.to_string(), None));
    }
    let model = model.as_mapping()?;
    let name = yaml_mapping_value(model, "name")
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    let alias = yaml_mapping_value(model, "alias")
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|alias| !alias.is_empty());
    let display_name = yaml_mapping_value(model, "display-name")
        .or_else(|| yaml_mapping_value(model, "display_name"))
        .and_then(serde_norway::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some((
        name.to_string(),
        alias.unwrap_or(name).to_string(),
        display_name,
    ))
}
