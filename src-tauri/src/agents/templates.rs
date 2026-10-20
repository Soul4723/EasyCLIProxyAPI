use super::*;

#[cfg(test)]
mod tests;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemplatePreview {
    revision: String,
    files: Vec<String>,
}

struct TemplatePlan {
    client: String,
    paths: Vec<PathBuf>,
    before: Images,
    after: Images,
    mappings: Option<ClaudeDesktopModelMappings>,
    mapping_revision: String,
    model: String,
    core: Option<(String, String)>,
    preview: TemplatePreview,
}

pub(crate) fn build_codex_template_auth(home: &Path) -> Result<AgentFileUpdate, String> {
    let path = codex_configuration_directory(home).join("auth.json");
    validate_codex_oauth_login_at(&path)?;
    let current = read_agent_bytes(&path)?.ok_or(CODEX_OAUTH_LOGIN_REQUIRED_ERROR)?;
    let value = parse(&path, text(Some(&current))?)?;
    let mut target = serde_json::Map::new();
    for key in ["auth_mode", "tokens", "last_refresh"] {
        if let Some(value) = value.get(key) {
            target.insert(key.into(), value.clone());
        }
    }
    Ok(AgentFileUpdate {
        path,
        after: serde_json::to_string_pretty(&target).map_err(|_| "Failed to generate authentication template")?,
    })
}

pub(crate) fn build_pi_template_updates(
    home: &Path,
    port: impl AgentClientOrigin,
    api_key: &str,
    model: &str,
) -> Result<Vec<AgentFileUpdate>, String> {
    if port.validate_client_origin().is_err() {
        return Err("Invalid CPA address or key".into());
    }
    let settings = serde_json::json!({"packages": [PI_CLIPROXYAPI_PACKAGE]}).to_string();
    Ok(vec![
        AgentFileUpdate {
            path: pi_provider_config_path(home),
            after: build_pi_provider_config(None, &port.client_origin(), api_key)?,
        },
        AgentFileUpdate {
            path: pi_provider_settings_path(home),
            after: build_pi_provider_settings(&settings, model)?,
        },
    ])
}

pub(crate) async fn prepare_desktop_core_update(
    config: &GuiConfigFile,
    mappings: &mut ClaudeDesktopModelMappings,
    models: &[AgentModelOption],
) -> Result<(String, String), String> {
    let before = fetch_management_config_yaml(config)
        .await
        .map_err(agent_core_error)?;
    assign_available_claude_desktop_aliases(mappings, models, &before).map_err(agent_core_error)?;
    let after = match ensure_claude_desktop_model_aliases_in_yaml(&before, mappings, models) {
        Ok(after) => after,
        Err(_) => {
            let definitions = fetch_oauth_model_definitions(config).await;
            ensure_claude_desktop_model_aliases_with_oauth_definitions_in_yaml(
                &before,
                mappings,
                models,
                &definitions,
            )
            .map_err(agent_core_error)?
        }
    };
    Ok((before, after))
}

pub(crate) fn agent_core_error(error: String) -> String {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("automatic restoration failed")
        || normalized.contains("rollback failed")
        || normalized.contains("rollback both failed")
    {
        "Kernel alias or agent configuration write failed, and rollback also failed. Check the current configuration".into()
    } else if normalized.contains("original configuration was restored") {
        "Kernel alias or agent configuration write failed. Original configuration was restored. Check the connection and model mapping, then try again".into()
    } else if normalized.contains("configuration changed") {
        "Kernel configuration changed. Preview it again and retry".into()
    } else if normalized.contains("already used by another model") {
        "Model alias is already used by another model. Choose a different alias and try again".into()
    } else if normalized.contains("unable to determine")
        && normalized.contains("cpa configuration source")
        && normalized.contains("model")
    {
        "Unable to find a valid access source for the original model. Make sure access is enabled and the original model or alias is not blocked, then refresh the model list and try again".into()
    } else if normalized.starts_with("updated kernel configuration does not match the expected value")
        || normalized.starts_with("failed to validate updated kernel configuration")
    {
        "Kernel configuration format compatibility check failed. Alias synchronization was canceled, and the original configuration was not written".into()
    } else if normalized.starts_with("failed to parse kernel yaml configuration") {
        "Invalid kernel YAML configuration format. Check the format and try again".into()
    } else if normalized.starts_with("management api error (401)")
        || normalized.starts_with("management api error (403)")
        || normalized.starts_with("management interface unavailable")
    {
        "Kernel management interface authentication failed. Check the management key and try again".into()
    } else {
        "Kernel model alias synchronization failed. Check the kernel connection and model mapping".into()
    }
}

pub(crate) async fn commit_agent_with_core<T>(
    config: &GuiConfigFile,
    mut mappings: Option<ClaudeDesktopModelMappings>,
    models: &[AgentModelOption],
    commit: impl FnOnce(Option<&ClaudeDesktopModelMappings>) -> Result<T, String>,
) -> Result<T, String> {
    let (before, after) = if let Some(mappings) = mappings.as_mut() {
        prepare_desktop_core_update(config, mappings, models).await?
    } else {
        return commit(None);
    };
    commit_management_alias_config_changes(config, &before, &after, || commit(mappings.as_ref()))
        .await
        .map_err(agent_core_error)
}

// Remote aliases use Phase1's narrow non-replaying writer. A client-file
// failure cannot roll back remote changes over a concurrent management editor.
pub(crate) async fn commit_agent_with_selected_core<T>(
    state: &GuiConfigState,
    config: &GuiConfigFile,
    mut mappings: Option<ClaudeDesktopModelMappings>,
    models: &[AgentModelOption],
    commit: impl FnOnce(Option<&ClaudeDesktopModelMappings>) -> Result<T, String>,
) -> Result<T, String> {
    if config.connection_mode == CoreConnectionMode::Local {
        return commit_agent_with_core(config, mappings, models, commit).await;
    }
    if let Some(mapping) = mappings.as_mut() {
        let (before, after) = prepare_desktop_core_update(config, mapping, models).await?;
        save_remote_alias_changes(state, config, &before, &after).await.map_err(|_| {
            "Remote alias save did not complete; changes may have applied. Reload before retrying".to_string()
        })?;
        state.ensure_target(config)?;
        commit(mappings.as_ref()).map_err(|_| {
            "Remote aliases were saved but the local client configuration failed. Inspect both before retrying".to_string()
        })
    } else { state.ensure_target(config)?; commit(None) }
}

async fn prepare_template_plan(
    config: &GuiConfigFile,
    home: &Path,
    client: &str,
    model: &str,
    oauth_configuration: bool,
    claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
) -> Result<TemplatePlan, String> {
    if client == "codex" { ensure_codex_cpa_mode(home)?; }
    let paths = config_paths(client, home)?;
    let api_key = effective_agent_api_key(config);
    let (model, mappings, before, after, core) = if client == PI_AGENT_ID {
        let model = resolve_pi_default_model(config, model).await?;
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "Configuration file lock is poisoned")?;
        let before = config_images(&paths)?;
        let updates = build_pi_template_updates(home, config, api_key, &model)?;
        let after = prepare_config_updates(client, &paths, &before, &updates, true)?;
        (model, None, before, after, None)
    } else {
        let parsed = AgentClient::parse(client)?;
        let prepared = fetch_prepared_agent_models(parsed, config).await?;
        let model = resolve_agent_configuration_model(
            parsed, &prepared.models, model, claude_desktop_model_mappings.as_ref(),
        )?;
        let code_mappings = resolve_claude_code_model_mappings(
            parsed,
            &prepared.models,
            &model,
            claude_code_model_mappings,
        )?;
        let mut mappings = resolve_claude_desktop_model_mappings(
            parsed,
            &prepared.models,
            &model,
            claude_desktop_model_mappings,
        )?;
        let core = if let Some(mappings) = mappings.as_mut() {
            let prepared_desktop = fetch_prepared_agent_models(AgentClient::ClaudeDesktop, config).await?;
            Some(prepare_desktop_core_update(config, mappings, &prepared_desktop.models).await?)
        } else {
            None
        };
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "Configuration file lock is poisoned")?;
        let before = config_images(&paths)?;
        let updates = build_agent_template_updates(AgentDefaultConfiguration {
            client: parsed,
            home,
            port: config,
            api_key,
            model: &model,
            models: &prepared.models,
            codex_catalog: prepared.codex_catalog.as_deref(),
            oauth_configuration,
            claude_code_model_mappings: code_mappings.as_ref(),
            claude_desktop_model_mappings: mappings.as_ref(),
        })?;
        let after = prepare_config_updates(client, &paths, &before, &updates, true)?;
        (model, mappings, before, after, core)
    };
    let mapping_revision = mapping_revision(client, &paths)?;
    let core_revision = core
        .as_ref()
        .map(|(a, b)| {
            Ok::<_, String>((
                model_alias_config_revision(a)?,
                model_alias_config_revision(b)?,
            ))
        })
        .transpose()?;
    let revision = sha256_bytes(
        &serde_json::to_vec(&(
            config.target_revision,
            image_revision(&before),
            image_revision(&after),
            &mapping_revision,
            &mappings,
            core_revision,
        ))
        .map_err(|_| "Failed to generate template preview")?,
    );
    let preview = TemplatePreview {
        revision,
        files: paths.iter().map(|p| path_to_string(p)).collect(),
    };
    Ok(TemplatePlan {
        client: client.into(),
        paths,
        before,
        after,
        model,
        mappings,
        mapping_revision,
        core,
        preview,
    })
}

async fn execute_template_plan(
    config: &GuiConfigFile,
    plan: TemplatePlan,
    revision: &str,
) -> Result<AgentConfigActionResult, String> {
    if revision != plan.preview.revision {
        return Err("Configuration or template changed after preview. Preview the base configuration template again".into());
    }
    let commit = || {
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "Configuration file lock is poisoned")?;
        if mapping_revision(&plan.client, &plan.paths)? != plan.mapping_revision {
            return Err("Model mapping changed. Preview it again".into());
        }
        commit_config_with_mappings(
            &plan.client,
            &plan.paths,
            &plan.before,
            &plan.after,
            "template",
            Some(plan.model.clone()),
            plan.mappings.clone(),
        )
    };
    match &plan.core {
        Some((before, after)) => {
            commit_management_alias_config_changes(config, before, after, commit)
                .await
                .map_err(agent_core_error)
        }
        None => commit(),
    }
}

async fn execute_selected_template_plan(
    state: &GuiConfigState,
    config: &GuiConfigFile,
    mut plan: TemplatePlan,
    revision: &str,
) -> Result<AgentConfigActionResult, String> {
    if revision != plan.preview.revision {
        return Err("Configuration or template changed after preview. Preview it again".into());
    }
    if config.connection_mode == CoreConnectionMode::Remote {
        if let Some((before, after)) = plan.core.take() {
            save_remote_alias_changes(state, config, &before, &after).await.map_err(|_| {
                "Remote alias save did not complete; changes may have applied. Reload before retrying".to_string()
            })?;
            state.ensure_target(config)?;
            return execute_template_plan(config, plan, revision).await.map_err(|_| {
                "Remote aliases were saved but the local client configuration failed. Inspect both before retrying".to_string()
            });
        }
    }
    state.ensure_target(config)?;
    execute_template_plan(config, plan, revision).await
}

#[tauri::command]
pub(crate) async fn preview_agent_config_template(
    app: tauri::AppHandle,
    client: String,
    model: String,
    oauth_configuration: bool,
    claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
) -> Result<TemplatePreview, String> {
    let _target_state = app.state::<GuiConfigState>();
    let home = app.path().home_dir().map_err(|_| "Failed to get user directory")?;
    preview_agent_config_template_for_target(
        &_target_state,
        home,
        client,
        model,
        oauth_configuration,
        claude_code_model_mappings,
        claude_desktop_model_mappings,
    ).await
}

pub(crate) async fn preview_agent_config_template_for_target(
    target_state: &GuiConfigState,
    home: PathBuf,
    client: String,
    model: String,
    oauth_configuration: bool,
    claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
) -> Result<TemplatePreview, String> {
    super::target_read_then_apply(
        target_state,
        None,
        move |config| async move {
            prepare_template_plan(&config, &home, &client, &model, oauth_configuration,
                claude_code_model_mappings, claude_desktop_model_mappings).await
        },
        |_config, plan, _target_operation| async move { Ok(plan.preview) },
    ).await?.ok_or_else(|| super::CORE_TARGET_CHANGED_CANCELLED.to_string())
}

#[tauri::command]
pub(crate) async fn apply_agent_config_template(
    app: tauri::AppHandle,
    client: String,
    model: String,
    oauth_configuration: bool,
    claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
    revision: String,
) -> Result<AgentConfigActionResult, String> {
    let _target_state = app.state::<GuiConfigState>();
    let _target_operation = _target_state.target_operation.lock().await;
    let home = app.path().home_dir().map_err(|_| "Failed to get user directory")?;
    let config = app.state::<GuiConfigState>().snapshot()?;
    let plan = prepare_template_plan(
        &config,
        &home,
        &client,
        &model,
        oauth_configuration,
        claude_code_model_mappings,
        claude_desktop_model_mappings,
    )
    .await?;
    let result = execute_selected_template_plan(_target_state.inner(), &config, plan, &revision).await?;
    app.state::<AgentConfigStatusCache>().clear()?;
    Ok(result)
}
