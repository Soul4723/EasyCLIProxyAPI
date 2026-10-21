use super::*;

mod deepseek;
pub(crate) use deepseek::*;
mod claude;
pub(crate) use claude::*;
mod claude_desktop;
pub(crate) use claude_desktop::*;
mod removal;
pub(crate) use removal::*;
mod restore;
pub(crate) use restore::*;
mod codex;
pub(crate) use codex::*;
mod clients;
pub(crate) use clients::*;

#[cfg(test)]
pub(crate) fn build_agent_updates(
    client: AgentClient,
    home: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
    model: &str,
    models: &[AgentModelOption],
    codex_catalog: Option<&str>,
) -> Result<Vec<AgentFileUpdate>, String> {
    build_agent_updates_with_oauth(
        client,
        home,
        port,
        api_key,
        model,
        AgentConfigurationOptions {
            models,
            codex_catalog,
            oauth_configuration: false,
            claude_code_model_mappings: None,
            claude_desktop_model_mappings: None,
        },
    )
}

pub(crate) fn build_agent_updates_with_oauth(
    client: AgentClient,
    home: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
    model: &str,
    options: AgentConfigurationOptions<'_>,
) -> Result<Vec<AgentFileUpdate>, String> {
    let AgentConfigurationOptions {
        models,
        codex_catalog,
        oauth_configuration,
        claude_code_model_mappings,
        claude_desktop_model_mappings,
    } = options;
    let paths = agent_config_paths(client, home);
    let root_base = port.client_origin();
    let openai_base = format!("{root_base}/v1");
    match client {
        AgentClient::ClaudeCode => {
            let before = read_optional_text(&paths[0])?;
            let after = build_claude_agent_config(
                before.as_deref(),
                &root_base,
                api_key,
                model,
                models,
                claude_code_model_mappings,
            )
            ?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::ClaudeDesktop => {
            if paths.len() != 4 {
                return Err("Claude Desktop configuration path is unavailable on the current platform".to_string());
            }
            let normal_before = read_optional_text(&paths[0])?;
            let threep_before = read_optional_text(&paths[1])?;
            let profile_before = read_optional_text(&paths[2])?;
            let meta_before = read_optional_text(&paths[3])?;
            Ok(vec![
                AgentFileUpdate {
                    path: paths[0].clone(),
                    after: build_claude_desktop_deployment_config(normal_before.as_deref())
                        ?,
                },
                AgentFileUpdate {
                    path: paths[1].clone(),
                    after: build_claude_desktop_deployment_config(threep_before.as_deref())
                        ?,
                },
                AgentFileUpdate {
                    path: paths[2].clone(),
                    after: build_claude_desktop_profile(
                        profile_before.as_deref(),
                        &root_base,
                        api_key,
                        model,
                        models,
                        claude_desktop_model_mappings,
                    )
                    ?,
                },
                AgentFileUpdate {
                    path: paths[3].clone(),
                    after: build_claude_desktop_meta(meta_before.as_deref())
                        ?,
                },
            ])
        }
        AgentClient::Codex => {
            let before = read_optional_text(&paths[0])?;
            let after = build_codex_agent_config_with_oauth(
                before.as_deref(),
                &openai_base,
                api_key,
                model,
                oauth_configuration,
            )
            ?;
            let mut updates = vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }];
            let catalog = codex_catalog.ok_or_else(|| "Unable to generate Codex model catalog".to_string())?;
            validate_codex_catalog(catalog, model)?;
            updates.push(AgentFileUpdate {
                path: codex_model_catalog_path(home),
                after: catalog.to_string(),
            });
            updates.push(build_codex_auth_update(home, api_key, oauth_configuration)?);
            Ok(updates)
        }
        AgentClient::OpenCode => {
            let before = read_optional_text(&paths[0])?;
            let after = build_opencode_agent_config(
                before.as_deref(),
                &openai_base,
                api_key,
                model,
                models,
            )
            ?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::OpenClaw => {
            let before = read_optional_text(&paths[0])?;
            let after = build_openclaw_agent_config(
                before.as_deref(),
                &openai_base,
                api_key,
                model,
                models,
            )
            ?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::Hermes => {
            let before = read_optional_text(&paths[0])?;
            let after =
                build_hermes_agent_config(before.as_deref(), &openai_base, api_key, model, models)
                    ?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::DeepSeekHarness => {
            if paths.len() != 2 {
                return Err("Invalid number of DeepSeek Harness configuration paths".to_string());
            }
            let settings_before = read_optional_text(&paths[0])?;
            let credentials_before = read_optional_text(&paths[1])?;
            Ok(vec![
                AgentFileUpdate {
                    path: paths[0].clone(),
                    after: build_deepseek_harness_settings(
                        settings_before.as_deref(),
                        &openai_base,
                        model,
                        models,
                    )?,
                },
                AgentFileUpdate {
                    path: paths[1].clone(),
                    after: build_deepseek_harness_credentials(
                        credentials_before.as_deref(),
                        api_key,
                    )?,
                },
            ])
        }
        AgentClient::CopilotCli | AgentClient::VscodeCopilot => build_copilot_updates(client, home, &openai_base, api_key, model, models, false),
        AgentClient::AntigravityCli => build_antigravity_updates(client, home, &root_base, api_key, model, false),
        AgentClient::WorkBuddy => {
            let before = read_optional_text(&paths[0])?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after: build_workbuddy_agent_config(before.as_deref(), &openai_base, api_key, model, models)?,
            }])
        }
        AgentClient::ZCode => {
            let before = read_optional_text(&paths[0])?;
            let after = build_zcode_agent_config(
                before.as_deref(), &openai_base, api_key, model, models,
            )?;
            Ok(vec![AgentFileUpdate { path: paths[0].clone(), after }])
        }
        AgentClient::KimiCode => {
            let before = read_optional_text(&paths[0])?;
            let after = build_kimi_code_agent_config(
                before.as_deref(),
                &openai_base,
                api_key,
                model,
                models,
            )
            ?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::GrokBuild => {
            let before = read_optional_text(&paths[0])?;
            let after = build_grok_build_agent_config(
                before.as_deref(),
                &openai_base,
                api_key,
                model,
                models,
            )
            ?;
            Ok(vec![AgentFileUpdate {
                path: paths[0].clone(),
                after,
            }])
        }
        AgentClient::Omp => {
            if paths.len() != 2 {
                return Err("Invalid number of Oh My Pi configuration paths".to_string());
            }
            let models_before = read_optional_text(&paths[0])?;
            let settings_before = read_optional_text(&paths[1])?;
            Ok(vec![
                AgentFileUpdate {
                    path: paths[0].clone(),
                    after: build_omp_models_config(models_before.as_deref(), &openai_base, api_key)?,
                },
                AgentFileUpdate {
                    path: paths[1].clone(),
                    after: build_omp_settings_config(settings_before.as_deref(), model)?,
                },
            ])
        }
    }
}

pub(crate) fn read_optional_text(path: &Path) -> Result<Option<String>, String> {
    read_agent_bytes(path)?.map(|bytes| String::from_utf8(bytes)
        .map_err(|_| "Configuration is not UTF-8 text. Restore it from a manual backup or repair it with the base configuration template".to_string())).transpose()
}

pub(crate) fn read_agent_yaml_mapping_or_empty(
    path: &Path,
    label: &str,
) -> Result<serde_norway::Mapping, String> {
    if !path.is_file() {
        return Ok(serde_norway::Mapping::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {label} {}: {error}", path_to_string(path)))?;
    parse_agent_yaml_mapping(Some(&content), label)
}

pub(crate) fn parse_agent_yaml_mapping(
    content: Option<&str>,
    label: &str,
) -> Result<serde_norway::Mapping, String> {
    let Some(content) = content.map(str::trim).filter(|content| !content.is_empty()) else {
        return Ok(serde_norway::Mapping::new());
    };
    serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|_| format!("Invalid {label} YAML format"))?
        .as_mapping()
        .cloned()
        .ok_or_else(|| format!("{label} root must be a YAML mapping"))
}

pub(crate) fn render_agent_yaml_mapping_update<F>(
    existing: Option<&str>,
    label: &str,
    update: F,
) -> Result<String, String>
where
    F: FnOnce(&mut serde_norway::Mapping) -> Result<(), String>,
{
    let original_mapping = parse_agent_yaml_mapping(existing, label)?;
    let original = serde_norway::Value::Mapping(original_mapping.clone());
    let mut updated_mapping = original_mapping;
    update(&mut updated_mapping)?;
    let updated = serde_norway::Value::Mapping(updated_mapping);
    if updated == original {
        return Ok(existing.unwrap_or("{}\n").to_string());
    }
    let source = existing
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .map(|_| existing.unwrap_or_default())
        .unwrap_or("{}\n");
    let mut document = yaml_serde_edit::YamlValue::parse(source)
        .map_err(|_| format!("Invalid {label} YAML format"))?;
    render_updated_core_yaml(&mut document, updated)
        .map_err(|error| format!("Failed to update {label}: {error}"))
}

pub(crate) fn write_agent_configuration_file(
    client: AgentClient,
    path: &Path,
    content: &[u8],
) -> Result<(), String> {
    if client == AgentClient::Codex
        && matches!(path.file_name().and_then(|name| name.to_str()), Some(CODEX_NATIVE_OAUTH_STATE_FILE | "auth.json"))
    {
        return write_codex_private_file(path, content);
    }
    if matches!(client, AgentClient::AntigravityCli | AgentClient::CopilotCli) {
        return write_codex_private_file(path, content);
    }
    if client == AgentClient::DeepSeekHarness {
        let owner_only = path.file_name().and_then(|name| name.to_str())
            == Some(DEEPSEEK_HARNESS_CREDENTIALS_FILE);
        write_deepseek_harness_file(path, content, owner_only)
    } else {
        write_bytes_directly(path, content)
    }
}

pub(crate) fn parse_agent_json_object(
    existing: Option<&str>,
    label: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let value = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => serde_json::from_str::<serde_json::Value>(value)
            .map_err(|_| format!("Invalid {label} format"))?,
        None => serde_json::json!({}),
    };
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{label} root must be an object"))
}

pub(crate) fn parse_agent_json5_object(
    existing: Option<&str>,
    label: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let value = match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => json5::from_str::<serde_json::Value>(value)
            .map_err(|_| format!("Invalid {label} format"))?,
        None => serde_json::json!({}),
    };
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("{label} root must be an object"))
}

pub(crate) fn ensure_json_object_entry<'a>(
    root: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> &'a mut serde_json::Map<String, serde_json::Value> {
    if !root.get(key).is_some_and(serde_json::Value::is_object) {
        root.insert(key.to_string(), serde_json::json!({}));
    }
    root.get_mut(key)
        .and_then(serde_json::Value::as_object_mut)
        .expect("object entry was just normalized")
}

pub(crate) fn ensure_json_array_entry<'a>(
    root: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> &'a mut Vec<serde_json::Value> {
    if !root.get(key).is_some_and(serde_json::Value::is_array) {
        root.insert(key.to_string(), serde_json::json!([]));
    }
    root.get_mut(key)
        .and_then(serde_json::Value::as_array_mut)
        .expect("array entry was just normalized")
}

pub(crate) fn render_agent_json(
    root: serde_json::Map<String, serde_json::Value>,
    label: &str,
) -> Result<String, String> {
    let mut rendered = serde_json::to_string_pretty(&serde_json::Value::Object(root))
        .map_err(|error| format!("Failed to generate {label}: {error}"))?;
    rendered.push('\n');
    Ok(rendered)
}

pub(crate) fn ordered_agent_models(
    models: &[AgentModelOption],
    selected_model: &str,
) -> Vec<AgentModelOption> {
    let mut ordered = Vec::with_capacity(models.len().max(1));
    if let Some(selected) = models
        .iter()
        .find(|model| model.name.eq_ignore_ascii_case(selected_model))
    {
        ordered.push(selected.clone());
    } else {
        ordered.push(AgentModelOption {
            input_modalities: None,
            harness_metadata: None,
            name: selected_model.to_string(),
            alias: None,
            is_alias: false,
            context_window: None,
        });
    }
    for model in models {
        if ordered
            .iter()
            .any(|existing| existing.name.eq_ignore_ascii_case(&model.name))
        {
            continue;
        }
        ordered.push(model.clone());
    }
    ordered
}
