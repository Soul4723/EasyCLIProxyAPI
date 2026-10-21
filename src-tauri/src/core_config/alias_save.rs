use super::*;

// Compare only sections owned by the alias transaction. Unrelated settings may
// change while an editor is open and are preserved by the targeted writers.
fn validate_alias_snapshot(current: &str, latest: &str) -> Result<(), String> {
    let parse = |yaml: &str| serde_norway::from_str::<serde_norway::Value>(yaml)
        .map_err(|_| "Invalid alias configuration".to_string());
    let current = parse(current)?;
    let latest = parse(latest)?;
    for key in ["oauth-model-alias", "payload"].into_iter()
        .chain(V8_PROVIDER_FAMILIES.iter().map(|(legacy, _)| *legacy)) {
        // The v8 projection normalizes absent provider sections to empty lists.
        let empty = serde_norway::Value::Sequence(Vec::new());
        let value = |root: &serde_norway::Value| root.get(key).cloned().unwrap_or_else(|| {
            if V8_PROVIDER_FAMILIES.iter().any(|(legacy, _)| *legacy == key) {
                empty.clone()
            } else { serde_norway::Value::Mapping(serde_norway::Mapping::new()) }
        });
        if value(&current) != value(&latest) {
            return Err("Alias configuration changed since it was read. Refresh before retrying; no changes were written".into());
        }
    }
    Ok(())
}

fn alias_config_is_unchanged(current: &str, latest: &str) -> Result<bool, String> {
    let changes = management_alias_config_changes(current, latest)?;
    Ok(changes.oauth_model_aliases.is_none() && !changes.update_config_yaml)
}

fn validate_alias_transaction_state(
    current: &str,
    updated: &str,
    latest: &str,
) -> Result<(), String> {
    let parse = |content: &str| {
        serde_norway::from_str::<serde_norway::Value>(content)
            .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?
            .as_mapping()
            .cloned()
            .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())
    };
    let mut current = parse(current)?;
    let mut updated = parse(updated)?;
    let mut latest = parse(latest)?;
    for key in ["oauth-model-alias", "payload"]
        .into_iter()
        .chain(V8_PROVIDER_FAMILIES.iter().map(|(legacy, _)| *legacy))
    {
        let current_value = current.remove(yaml_key(key));
        let updated_value = updated.remove(yaml_key(key));
        let latest_value = latest.remove(yaml_key(key));
        if latest_value != current_value && latest_value != updated_value {
            return Err(
                "Other configuration changes were detected and were not overwritten".to_string(),
            );
        }
    }
    if current != updated || latest != current {
        return Err("Other configuration changes were detected and were not overwritten".to_string());
    }
    Ok(())
}

fn validate_alias_api_access_preserved(current: &str, updated: &str) -> Result<(), String> {
    let parse = |content: &str| {
        serde_norway::from_str::<serde_norway::Value>(content)
            .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))
    };
    let current = parse(current)?;
    let updated = parse(updated)?;
    for section in MODEL_ALIAS_CONFIG_SECTIONS
        .iter()
        .copied()
        .chain(["vertex-api-key", "xai-api-key", "interactions-api-key"])
    {
        let without_models = |root: &serde_norway::Value| -> Result<_, String> {
            let mut value = root
                .get(section)
                .cloned()
                .unwrap_or(serde_norway::Value::Null);
            if value.is_null() {
                return Ok(serde_norway::Value::Sequence(Vec::new()));
            }
            let providers = value
                .as_sequence_mut()
                .ok_or_else(|| format!("{section} must be an array; alias was not saved"))?;
            if MODEL_ALIAS_CONFIG_SECTIONS.contains(&section) {
                for provider in providers {
                    if let Some(provider) = provider.as_mapping_mut() {
                        provider.remove(yaml_key("models"));
                    }
                }
            }
            Ok(value)
        };
        if without_models(&current)? != without_models(&updated)? {
            return Err(format!(
                "The alias update unexpectedly changed API access configuration ({section}); write rejected"
            ));
        }
    }
    Ok(())
}

pub(crate) async fn put_management_alias_config_changes(
    config: &GuiConfigFile,
    current: &str,
    updated: &str,
) -> Result<(), String> {
    let changes = management_alias_config_changes(current, updated)?;
    if changes.oauth_model_aliases.is_none() && !changes.update_config_yaml {
        return Ok(());
    }
    commit_management_alias_config_changes(config, current, updated, || Ok(())).await
}

pub(crate) async fn commit_management_alias_config_changes<T>(
    config: &GuiConfigFile,
    current: &str,
    updated: &str,
    commit: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    static SAVE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = SAVE_LOCK.lock().await;
    validate_alias_api_access_preserved(current, updated)?;
    let changes = management_alias_config_changes(current, updated)?;
    // The management API applies only the alias/payload/provider sections below.
    // Do not reject an edit merely because an unrelated setting changed while the
    // editor was open; the targeted writer preserves those unrelated sections.
    let native_before = fetch_management_raw_config_yaml(config).await?;
    let latest = management_v8_yaml_to_legacy_view(&native_before)?;
    validate_alias_snapshot(current, &latest)?;
    let result = async {
        if let Some(aliases) = changes.oauth_model_aliases.as_ref() {
            put_management_oauth_model_aliases(config, aliases).await?;
        }
        if changes.update_config_yaml {
            put_management_config_yaml(config, updated).await?;
        }
        commit()
    }
    .await;
    match result {
        Ok(value) => Ok(value),
        Err(error) => Err(match restore_management_alias_config(config, current, updated, &native_before).await {
            Ok(()) => format!("Save failed. Original configuration was restored; you can retry: {error}"),
            Err(restore_error) => format!("Save failed: {error}; automatic restoration failed, and the configuration may be partially written. Close the editor, refresh, and inspect it: {restore_error}"),
        }),
    }
}

async fn restore_management_alias_config(
    config: &GuiConfigFile,
    current: &str,
    updated: &str,
    native_before: &str,
) -> Result<(), String> {
    let latest = fetch_management_config_yaml(config).await?;
    validate_alias_transaction_state(current, updated, &latest)?;
    let from_current = management_alias_config_changes(current, &latest)?;
    let mut errors = Vec::new();
    if from_current.update_config_yaml {
        if let Err(error) = put_management_config_yaml(config, current).await {
            errors.push(error);
        }
    }
    // Semantic rollback can leave an explicit per-key model list where the key
    // originally inherited its group. Restore the original native layout too.
    if errors.is_empty() {
        if let Err(error) = restore_native_provider_groups(config, native_before).await {
            errors.push(error);
        }
    }
    if let Some(aliases) = management_alias_config_changes(&latest, current)?.oauth_model_aliases {
        if let Err(error) = put_management_oauth_model_aliases(config, &aliases).await {
            errors.push(error);
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("；"));
    }
    if !alias_config_is_unchanged(current, &fetch_management_config_yaml(config).await?)? {
        return Err("Restored configuration does not match the original configuration".to_string());
    }
    Ok(())
}

// Translate the existing alias editor's legacy-shaped view back into the selected
// core's native groups before using the narrow, non-replaying remote writer.
pub(crate) async fn save_remote_alias_changes(
    state: &GuiConfigState, config: &GuiConfigFile, current: &str, updated: &str,
) -> Result<(), String> {
    validate_alias_api_access_preserved(current, updated)?;
    let native_before = crate::core_connection::read_remote_yaml(config).await?;
    let latest = management_v8_yaml_to_legacy_view(&native_before)?;
    validate_alias_transaction_state(current, current, &latest)?;
    let before: serde_norway::Value = serde_norway::from_str(current).map_err(|_| "Invalid alias configuration".to_string())?;
    let after: serde_norway::Value = serde_norway::from_str(updated).map_err(|_| "Invalid alias configuration".to_string())?;
    let native: serde_norway::Value = serde_norway::from_str(&native_before).map_err(|_| "Invalid remote configuration".to_string())?;
    let mut desired: serde_json::Value = serde_json::to_value(&native).map_err(|_| "Invalid remote configuration".to_string())?;
    let mut updates = Vec::new();
    for (legacy, path) in [("oauth-model-alias", vec!["oauth", "model-alias"]), ("payload", vec!["requests", "payload"])] {
        if before.get(legacy) != after.get(legacy) {
            updates.push((path, after.get(legacy).map(serde_json::to_value).transpose().map_err(|_| "Invalid alias value".to_string())?));
        }
    }
    for (legacy, provider) in V8_PROVIDER_FAMILIES {
        if before.get(legacy) == after.get(legacy) { continue; }
        let groups = match after.get(legacy) {
            Some(after) => {
                let empty = serde_norway::Value::Sequence(Vec::new());
                let before = before.get(legacy).unwrap_or(&empty);
                let existing = nested_yaml_value(native.as_mapping().ok_or("Invalid remote configuration")?, &["api-keys", provider]).cloned()
                    .unwrap_or(group_legacy_provider_records(provider, before)?);
                Some(serde_json::to_value(update_v8_provider_group_models(provider, &existing, before, after)?).map_err(|_| "Invalid provider models".to_string())?)
            },
            None => None,
        };
        updates.push((vec!["api-keys", provider], groups));
    }
    for (path, value) in updates {
        let (last, parents) = path.split_last().ok_or("Invalid alias path")?;
        let mut parent = &mut desired;
        for part in parents {
            parent = parent.as_object_mut().ok_or("Invalid alias parent")?
                .entry((*part).to_string()).or_insert_with(|| serde_json::json!({}));
        }
        let object = parent.as_object_mut().ok_or("Invalid alias parent")?;
        match value { Some(value) => { object.insert((*last).to_string(), value); }, None => { object.remove(*last); } }
    }
    let desired = serde_norway::to_string(&desired).map_err(|_| "Invalid alias update".to_string())?;
    // `native_before` was just read and validated above; it is the batch's preflight.
    crate::core_connection::write_remote_yaml_after_fresh_read(state, config, &native_before, &desired).await
}
