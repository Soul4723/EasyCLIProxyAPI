use super::*;

struct CoreRestore {
    before: String,
    after: String,
}

pub(crate) struct RestorePlan {
    paths: Vec<PathBuf>,
    pub(crate) preview: BackupPreview,
    local_revision: String,
    before: Images,
    after: Images,
    version: BackupVersion,
    core: Option<CoreRestore>,
}

fn local_restore_plan(client: &str, home: &Path, id: &str) -> Result<RestorePlan, String> {
    let _guard = AGENT_CONFIG_FILE_LOCK
        .lock()
        .map_err(|_| "Configuration file lock is poisoned")?;
    let paths = config_paths(client, home)?;
    let (preview, before, after) = preview(client, &paths, id)?;
    let version = read_version(client, &paths, id)?;
    Ok(RestorePlan {
        paths,
        local_revision: preview.revision.clone(),
        preview,
        before,
        after,
        version,
        core: None,
    })
}

fn desktop_restore_configuration(
    plan: &RestorePlan,
) -> Result<Option<(ClaudeDesktopModelMappings, Vec<AgentModelOption>)>, String> {
    if plan.version.client != "claude-desktop" {
        return Ok(None);
    }
    if !desktop_profile_needs_mapping(&plan.after)?
        && plan.version.mappings.as_ref()
            .and_then(|m| m.desktop_models.as_ref()).is_none()
    {
        return Ok(None);
    }
    let (path, bytes) = &plan.after[2];
    let profile = parse(path, text(bytes.as_deref())?)?;
    let names = profile
        .get("inferenceModels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let mut mappings = plan.version.mappings.as_ref().ok_or(
            "This backup version lacks Claude Desktop model mappings and cannot safely restore kernel routing. Reconfigure the models",
        )?.clone();
    if mappings.desktop_models.is_none() {
        let roles = [
            (CLAUDE_DESKTOP_OPUS_MODEL_ID, LEGACY_CLAUDE_DESKTOP_MODEL_IDS[0], &mappings.opus, mappings.opus_1m),
            (CLAUDE_DESKTOP_SONNET_MODEL_ID, LEGACY_CLAUDE_DESKTOP_MODEL_IDS[1], &mappings.sonnet, mappings.sonnet_1m),
            (CLAUDE_DESKTOP_HAIKU_MODEL_ID, LEGACY_CLAUDE_DESKTOP_MODEL_IDS[2], &mappings.haiku, mappings.haiku_1m),
        ];
        let mut entries = Vec::<ClaudeDesktopModelMapping>::new();
        for id in names {
            let Some((_, _, source, context_1m)) = roles.iter()
                .find(|(_, _, source, _)| source.eq_ignore_ascii_case(id))
                .or_else(|| roles.iter().find(|(current, legacy, _, _)| {
                    current.eq_ignore_ascii_case(id) || legacy.eq_ignore_ascii_case(id)
                }))
            else {
                return Err("A model ID in this backup has no corresponding source, so kernel routing cannot be safely restored".into());
            };
            if let Some(existing) = entries.iter_mut()
                .find(|entry| entry.model_id().eq_ignore_ascii_case(id))
            {
                existing.context_1m |= *context_1m;
            } else {
                entries.push(ClaudeDesktopModelMapping {
                    model: source.to_string(),
                    alias: if source.eq_ignore_ascii_case(id) {
                        String::new()
                    } else {
                        id.into()
                    },
                    context_1m: *context_1m,
                });
            }
        }
        mappings.desktop_models = Some(entries);
    }
    let entries = mappings.desktop_models.as_ref().ok_or("Backup model mapping is missing")?;
    validate_claude_desktop_entries(entries)?;
    let models = entries.iter()
        .map(|entry| AgentModelOption {
            name: entry.source_or_alias().to_string(),
            alias: None,
            is_alias: false,
            context_window: None,
            input_modalities: None,
            harness_metadata: None,
        })
        .collect();
    Ok(Some((mappings, models)))
}

fn attach_core_restore(
    plan: &mut RestorePlan,
    before: String,
    after: String,
) -> Result<(), String> {
    let original =
        serde_norway::from_str::<serde_norway::Value>(&before).map_err(|e| e.to_string())?;
    let target =
        serde_norway::from_str::<serde_norway::Value>(&after).map_err(|e| e.to_string())?;
    let mut routes = vec![
        CLAUDE_DESKTOP_OPUS_MODEL_ID,
        CLAUDE_DESKTOP_SONNET_MODEL_ID,
        CLAUDE_DESKTOP_HAIKU_MODEL_ID,
        LEGACY_CLAUDE_DESKTOP_MODEL_IDS[0],
        LEGACY_CLAUDE_DESKTOP_MODEL_IDS[1],
        LEGACY_CLAUDE_DESKTOP_MODEL_IDS[2],
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<Vec<_>>();
    for root in [&original, &target]
        .into_iter()
        .filter_map(serde_norway::Value::as_mapping)
    {
        for alias in managed_claude_desktop_aliases(root) {
            if !routes.contains(&alias) {
                routes.push(alias);
            }
        }
    }
    for route in routes {
        let source = |root: &serde_norway::Value| {
            root.as_mapping()
                .and_then(|root| configured_model_client_identity(root, &route))
                .map(|(source, _)| source)
        };
        let old = source(&original);
        let new = source(&target);
        if old != new {
            plan.preview.differences.push(BackupDifference {
                file: "CPA/config.yaml".into(),
                field: format!("modelMappings.{route}"),
                before: old.unwrap_or_else(|| "—".into()),
                after: new.unwrap_or_else(|| "—".into()),
            });
        }
    }
    plan.preview.revision = sha256_bytes(
        format!(
            "{}:{}:{}",
            plan.local_revision,
            model_alias_config_revision(&before)?,
            model_alias_config_revision(&after)?
        )
        .as_bytes(),
    );
    plan.core = Some(CoreRestore { before, after });
    Ok(())
}

const RESTORE_TARGET_MISMATCH: &str = "Backup client endpoint or key does not match the selected core. Select the original target or restore an unmanaged backup";

// Inspect only the saved after-image, never the currently installed client files.
// Provider identities scope the fields so arbitrary user endpoints are not retargeted.
fn validate_restore_target(config: &GuiConfigFile, client: &str, images: &Images) -> Result<(), String> {
    // Management-only remotes intentionally have no client target to compare against.
    if config.core_connection.is_remote()
        && (config.core_connection.client_api_origin.trim().is_empty()
            || config.core_connection.client_api_key.trim().is_empty())
    {
        return Ok(());
    }
    let roots = images.iter().map(|(path, bytes)| parse(path, text(bytes.as_deref())?))
        .collect::<Result<Vec<_>, String>>()?;
    let empty = serde_json::json!({});
    let root = roots.first().unwrap_or(&empty);
    let mut connections = Vec::<(&Value, &str, &str)>::new();
    let mut add = |provider, base, key| {
        if let Some(provider) = provider { connections.push((provider, base, key)); }
    };
    match client {
        "claude-code" => {
            let env = &root["env"];
            // Claude has no provider ID. CPA's gateway flags also identify remote origins.
            if env.get("ANTHROPIC_BASE_URL").and_then(Value::as_str).is_some_and(|base| {
                is_managed_agent_base_url(base)
                    || env.get(CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV).and_then(Value::as_str) == Some("1")
                    || env.get(CLAUDE_CODE_AUTO_MODE_SERVER_ENV).and_then(Value::as_str) == Some("0")
            }) {
                add(Some(env), "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN");
            }
        }
        "claude-desktop" => add(roots.get(2), "inferenceGatewayBaseUrl", "inferenceGatewayApiKey"),
        "codex" => add(root.pointer("/model_providers/cpa-gui"), "base_url", "experimental_bearer_token"),
        "opencode" => add(root.pointer("/provider/cpa-gui/options"), "baseURL", "apiKey"),
        "openclaw" => add(root.pointer("/models/providers/cpa-gui"), "baseUrl", "apiKey"),
        "kimi-code" => add(root.pointer("/providers/cpa-gui"), "base_url", "api_key"),
        "grok-build" => {
            for (name, entry) in root.get("model").and_then(Value::as_object).into_iter().flatten() {
                if name.starts_with("cpa-gui/") { add(Some(entry), "base_url", "api_key"); }
            }
        }
        "hermes" => {
            for entry in root.get("custom_providers").and_then(Value::as_array).into_iter().flatten() {
                if entry["name"] == MANAGED_AGENT_PROVIDER_ID {
                    add(Some(entry), if entry.get("base_url").is_some() { "base_url" } else { "baseUrl" },
                        if entry.get("api_key").is_some() { "api_key" } else { "apiKey" });
                }
            }
            for (name, entry) in root.get("providers").and_then(Value::as_object).into_iter().flatten() {
                if name == MANAGED_AGENT_PROVIDER_ID || entry["name"] == MANAGED_AGENT_PROVIDER_ID {
                    add(Some(entry), if entry.get("base_url").is_some() { "base_url" } else { "baseUrl" },
                        if entry.get("api_key").is_some() { "api_key" } else { "apiKey" });
                }
            }
        }
        "zcode" => {
            for entry in root.pointer("/config/providerConfigRules/providerRules").and_then(Value::as_array).into_iter().flatten() {
                if entry["providerId"] == MANAGED_AGENT_PROVIDER_ID { add(Some(entry), "/config/api/baseUrl", "/config/access/apiKey"); }
            }
        }
        "workbuddy" => {
            for entry in root.as_array().or_else(|| root.get("models").and_then(Value::as_array)).into_iter().flatten() {
                if entry["vendor"] == MANAGED_AGENT_PROVIDER_ID { add(Some(entry), "url", "apiKey"); }
            }
        }
        "omp" => add(root.get("providers").and_then(|p| p.get(OMP_AGENT_PROVIDER_ID)), "baseUrl", "apiKey"),
        "deepseek-harness" => add(root.get("llm-pi-ai").and_then(|p| p.get("providers")).and_then(|p| p.get(DEEPSEEK_HARNESS_PROVIDER_ID)), "baseURL", ""),
        "pi" => add(Some(root), "baseUrl", "apiKey"),
        "copilot-cli" | "antigravity-cli" => {
            for entry in &roots {
                if entry["provider"] == MANAGED_AGENT_PROVIDER_ID { add(Some(entry), "baseUrl", "apiKey"); }
            }
        }
        "vscode-copilot" => {
            for group in root.as_array().into_iter().flatten() {
                if group["name"] == "CPA (EasyCLIProxyAPI)" && group["vendor"] == "customendpoint" {
                    for model in group.get("models").and_then(Value::as_array).into_iter().flatten() {
                        // The key is a native secret reference, checked against the selected key below.
                        add(Some(model), "url", "");
                    }
                }
            }
        }
        _ => return Err("Unknown agent client".into()),
    }
    for (provider, base_field, key_field) in connections {
        let field = |name: &str| if name.starts_with('/') { provider.pointer(name) } else { provider.get(name) };
        let Some(base) = field(base_field).and_then(Value::as_str).filter(|base| !base.is_empty()) else { continue; };
        let origin = base.trim_end_matches('/').strip_suffix("/v1/chat/completions")
            .or_else(|| base.trim_end_matches('/').strip_suffix("/v1"))
            .unwrap_or(base.trim_end_matches('/'));
        // Preserve fork-main Local backup semantics, including old local ports and keys.
        if !config.core_connection.is_remote() && is_managed_agent_base_url(origin) { continue; }
        let key_matches = match client {
            "deepseek-harness" => roots.get(1).and_then(|r| r.get("refs")).and_then(|r| r.get(DEEPSEEK_HARNESS_CREDENTIAL)).and_then(Value::as_str) == Some(effective_agent_api_key(config)),
            "vscode-copilot" => root.as_array().into_iter().flatten()
                .filter(|g| g["name"] == "CPA (EasyCLIProxyAPI)" && g["vendor"] == "customendpoint")
                .all(|g| copilot::backup_secret_reference_matches(&images[0].0, effective_agent_api_key(config), &g["apiKey"])),
            _ => field(key_field).and_then(Value::as_str) == Some(effective_agent_api_key(config)),
        };
        if origin != config.origin() || !key_matches || agent_target(config).is_err() {
            return Err(RESTORE_TARGET_MISMATCH.into());
        }
    }
    Ok(())
}

pub(crate) async fn prepare_restore_plan(
    config: &GuiConfigFile,
    client: &str,
    home: &Path,
    id: &str,
) -> Result<RestorePlan, String> {
    let mut plan = local_restore_plan(client, home, id)?;
    validate_restore_target(config, client, &plan.after)?;
    if let Some((mappings, models)) = desktop_restore_configuration(&plan)? {
        let before = fetch_management_config_yaml(config)
            .await
            .map_err(agent_core_error)?;
        let after = match ensure_claude_desktop_model_aliases_with_oauth_definitions_in_yaml(
            &before,
            &mappings,
            &models,
            &[],
        ) {
            Ok(after) => after,
            Err(_) => {
                let definitions = fetch_oauth_model_definitions(config).await;
                ensure_claude_desktop_model_aliases_with_oauth_definitions_in_yaml(
                    &before,
                    &mappings,
                    &models,
                    &definitions,
                )
                .map_err(agent_core_error)?
            }
        };
        attach_core_restore(&mut plan, before, after).map_err(agent_core_error)?;
    }
    plan.preview.revision = sha256_bytes(format!("{}:{}", config.target_revision, plan.preview.revision).as_bytes());
    Ok(plan)
}

pub(crate) async fn execute_restore_plan(
    config: &GuiConfigFile,
    plan: RestorePlan,
    revision: &str,
) -> Result<AgentConfigActionResult, String> {
    if plan.preview.revision != revision {
        return Err("Configuration changed after preview. Select the backup version again".into());
    }
    let commit = || {
        let _guard = AGENT_CONFIG_FILE_LOCK
            .lock()
            .map_err(|_| "Configuration file lock is poisoned")?;
        let latest = preview(&plan.version.client, &plan.paths, &plan.version.id)?.0;
        let version = read_version(&plan.version.client, &plan.paths, &plan.version.id)?;
        if latest.revision != plan.local_revision
            || serde_json::to_vec(&version).map_err(|e| e.to_string())?
                != serde_json::to_vec(&plan.version).map_err(|e| e.to_string())?
        {
            return Err("Configuration or backup changed during restoration. Select the backup version again".into());
        }
        commit_config_with_mappings(
            &plan.version.client,
            &plan.paths,
            &plan.before,
            &plan.after,
            "restore",
            plan.version.mappings.as_ref().map(|m| m.sonnet.clone()),
            plan.version.mappings.clone(),
        )
    };
    match &plan.core {
        Some(core) => {
            commit_management_alias_config_changes(config, &core.before, &core.after, commit)
                .await
                .map_err(agent_core_error)
        }
        None => commit(),
    }
}

#[tauri::command]
pub(crate) async fn preview_agent_config_backup(
    app: tauri::AppHandle,
    client: String,
    id: String,
) -> Result<BackupPreview, String> {
    let _connection_guard = crate::core_connection::target_operation()?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let config = app.state::<GuiConfigState>().snapshot()?;
    Ok(prepare_restore_plan(&config, &client, &home, &id)
        .await?
        .preview)
}

#[tauri::command]
pub(crate) async fn restore_agent_config_backup(
    app: tauri::AppHandle,
    client: String,
    id: String,
    revision: String,
) -> Result<AgentConfigActionResult, String> {
    let _connection_guard = crate::core_connection::target_operation()?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let config = app.state::<GuiConfigState>().snapshot()?;
    let plan = prepare_restore_plan(&config, &client, &home, &id).await?;
    let result = execute_restore_plan(&config, plan, &revision).await?;
    app.state::<AgentConfigStatusCache>().clear()?;
    Ok(result)
}

pub(super) fn desktop_profile_needs_mapping(images: &Images) -> Result<bool, String> {
    let (path, bytes) = &images[2];
    let profile = parse(path, text(bytes.as_deref())?)?;
    let names = profile
        .get("inferenceModels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let labeled_mapping = profile.get("inferenceModels").and_then(Value::as_array)
        .into_iter().flatten().any(|entry| {
            let name = entry.get("name").and_then(Value::as_str);
            let label = entry.get("labelOverride").and_then(Value::as_str);
            matches!((name, label), (Some(name), Some(label)) if name != label)
        });
    if !labeled_mapping && !names.iter().any(|name| is_claude_desktop_route_id(name)) {
        return Ok(false);
    }
    Ok(true)
}

#[cfg(test)]
mod target_tests {
    use super::*;

    struct TestHome(PathBuf);
    impl TestHome {
        fn new() -> Self {
            let path = env::temp_dir().join(format!("cpa-restore-target-{}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestHome {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    fn remote(origin: &str, key: &str) -> GuiConfigFile {
        let mut config = GuiConfigFile::default();
        config.core_connection.mode = crate::core_connection::ConnectionMode::Remote;
        config.core_connection.client_api_origin = origin.into();
        config.core_connection.client_api_key = key.into();
        config.core_connection.remote_management_origin = "http://127.0.0.1:1".into();
        config
    }

    #[tokio::test]
    async fn saved_managed_targets_are_fenced_before_restore_writes_for_every_client() {
        let home = TestHome::new();
        let local = GuiConfigFile::default();
        let a = remote("https://client-a.invalid", "client-a-key");
        let b = remote("https://client-b.invalid", "client-b-key");
        let runtime = codex_catalog::parse_runtime_models(&serde_json::json!({"models":[{"id":"gpt-test"}]})).unwrap();
        let prepared = prepare_codex_agent_models(&runtime).unwrap();
        for client in [AgentClient::ClaudeCode, AgentClient::ClaudeDesktop, AgentClient::Codex,
            AgentClient::OpenCode, AgentClient::OpenClaw, AgentClient::Hermes,
            AgentClient::DeepSeekHarness, AgentClient::ZCode, AgentClient::WorkBuddy,
            AgentClient::AntigravityCli, AgentClient::CopilotCli, AgentClient::VscodeCopilot,
            AgentClient::KimiCode, AgentClient::GrokBuild, AgentClient::Omp] {
            if !client.supported_platform() { continue; }
            if client == AgentClient::VscodeCopilot {
                let path = agent_config_paths(client, &home.0)[0].parent().unwrap().join("ezcpa-copilot/credential.json");
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, serde_json::to_vec(&serde_json::json!({"keyHash": sha256_bytes(b"client-a-key"), "secretReference":"${input:chat.lm.secret.fixture}"})).unwrap()).unwrap();
            }
            let paths = config_paths(client.id(), &home.0).unwrap();
            for source in [&local, &a] {
                let updates = build_agent_updates(client, &home.0, source, effective_agent_api_key(source), "gpt-test", &prepared.models, prepared.codex_catalog.as_deref()).unwrap();
                let mut after = paths.iter().map(|path| (path.clone(), None)).collect::<Images>();
                for update in updates {
                    let image = after.iter_mut().find(|(path, _)| *path == update.path).unwrap();
                    image.1 = Some(update.after.into_bytes());
                }
                assert_eq!(validate_restore_target(&b, client.id(), &after).unwrap_err(), RESTORE_TARGET_MISMATCH, "{}", client.id());
                let mut management_only = b.clone();
                management_only.core_connection.client_api_origin.clear();
                management_only.core_connection.client_api_key.clear();
                assert!(validate_restore_target(&management_only, client.id(), &after).is_ok(), "{} management-only", client.id());
                if source.core_connection.is_remote() {
                    assert!(validate_restore_target(&a, client.id(), &after).is_ok(), "{}", client.id());
                    let rotated = remote("https://client-a.invalid", "rotated-key");
                    assert!(validate_restore_target(&rotated, client.id(), &after).is_err(), "{} ignores key", client.id());
                    assert!(validate_restore_target(&local, client.id(), &after).is_err(), "{} remote to local", client.id());
                } else {
                    assert!(validate_restore_target(&local, client.id(), &after).is_ok(), "{} local regression", client.id());
                }
                // A real prepare must fail before Desktop can fetch/write aliases or any client files change.
                let mut version = make_version(client.id(), &paths, &after);
                if client == AgentClient::ClaudeDesktop {
                    version.mappings = Some(ClaudeDesktopModelMappings::all("gpt-test"));
                }
                write_version(&paths, &version).unwrap();
                let before = config_images(&paths).unwrap();
                assert_eq!(prepare_restore_plan(&b, client.id(), &home.0, &version.id).await.err().unwrap(), RESTORE_TARGET_MISMATCH, "{}", client.id());
                assert_eq!(config_images(&paths).unwrap(), before);
            }
            let empty = paths.iter().map(|path| (path.clone(), None)).collect::<Images>();
            assert!(validate_restore_target(&b, client.id(), &empty).is_ok());
        }
        let oauth = vec![(home.0.join("config.toml"), Some(build_codex_agent_config_with_oauth(
            None, "https://client-a.invalid/v1", "old-client-key", "gpt-test", true,
        ).unwrap().into_bytes()))];
        assert!(validate_restore_target(&a, "codex", &oauth).is_err());
        for source in [&local, &a] {
            let after = build_pi_template_updates(&home.0, source, effective_agent_api_key(source), "gpt-test").unwrap()
                .into_iter().map(|u| (u.path, Some(u.after.into_bytes()))).collect();
            assert!(validate_restore_target(&b, PI_AGENT_ID, &after).is_err());
            assert!(validate_restore_target(source, PI_AGENT_ID, &after).is_ok());
        }
    }

    #[tokio::test]
    async fn matching_and_unmanaged_backups_restore_exactly() {
        let home = TestHome::new();
        let a = remote("https://client-a.invalid", "client-a-key");
        let client = "claude-code";
        let paths = config_paths(client, &home.0).unwrap();
        for root in [
            serde_json::json!({"env":{"ANTHROPIC_BASE_URL":"https://client-a.invalid", "ANTHROPIC_AUTH_TOKEN":"client-a-key", CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV:"1"}}),
            serde_json::json!({"theme":"dark", "env":{"ANTHROPIC_BASE_URL":"https://unmanaged.invalid", "ANTHROPIC_AUTH_TOKEN":"user-key"}}),
            serde_json::json!({"theme":"dark"}),
        ] {
            let after = vec![(paths[0].clone(), Some(serde_json::to_vec(&root).unwrap()))];
            let version = make_version(client, &paths, &after);
            write_version(&paths, &version).unwrap();
            let plan = prepare_restore_plan(&a, client, &home.0, &version.id).await.unwrap();
            let revision = plan.preview.revision.clone();
            execute_restore_plan(&a, plan, &revision).await.unwrap();
            assert_eq!(config_images(&paths).unwrap(), after);
        }
        let after = vec![(paths[0].clone(), None)];
        let version = make_version(client, &paths, &after);
        write_version(&paths, &version).unwrap();
        let mut management_only = a.clone();
        management_only.core_connection.client_api_origin.clear();
        management_only.core_connection.client_api_key.clear();
        let plan = prepare_restore_plan(&management_only, client, &home.0, &version.id).await.unwrap();
        let revision = plan.preview.revision.clone();
        execute_restore_plan(&management_only, plan, &revision).await.unwrap();
        assert_eq!(config_images(&paths).unwrap(), after);
    }
}
