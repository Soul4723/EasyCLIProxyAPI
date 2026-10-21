use super::*;

pub(crate) fn build_deepseek_harness_models(
    models: &[AgentModelOption],
    selected_model: &str,
) -> Result<serde_norway::Value, String> {
    let entries = ordered_agent_models(models, selected_model)
        .into_iter()
        .map(|model| {
            let mut entry = serde_norway::Mapping::new();
            entry.insert(yaml_key("id"), serde_norway::Value::String(model.name));
            if let Some(name) = model.alias.filter(|name| !name.trim().is_empty()) {
                entry.insert(yaml_key("name"), serde_norway::Value::String(name));
            }
            if let Some(context_window) = model.context_window {
                entry.insert(
                    yaml_key("contextWindow"),
                    serde_norway::to_value(context_window)
                        .map_err(|error| format!("Failed to serialize Harness model context: {error}"))?,
                );
            }
            if let Some(input) = model.input_modalities {
                entry.insert(
                    yaml_key("input"),
                    serde_norway::to_value(input)
                        .map_err(|_| "Failed to serialize Harness model input types")?,
                );
            }
            Ok(serde_norway::Value::Mapping(entry))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(serde_norway::Value::Sequence(entries))
}

pub(crate) fn build_deepseek_harness_settings(
    existing: Option<&str>,
    base_url: &str,
    model: &str,
    models: &[AgentModelOption],
) -> Result<String, String> {
    build_deepseek_harness_catalog_settings(
        existing,
        base_url,
        model,
        models,
        &mut DeepSeekHarnessCatalogState::default(),
    )
}

pub(crate) fn render_deepseek_harness_settings(
    existing: Option<&str>,
    base_url: &str,
    model: &str,
    published_models: serde_norway::Value,
) -> Result<String, String> {
    render_agent_yaml_mapping_update(existing, "DeepSeek Harness settings", |root| {
        let llm = root
            .entry(yaml_key("llm-pi-ai"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| "DeepSeek Harness llm-pi-ai must be a mapping".to_string())?;
        let providers = llm
            .entry(yaml_key("providers"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| "DeepSeek Harness llm-pi-ai.providers must be a mapping".to_string())?;
        let provider = providers
            .entry(yaml_key(DEEPSEEK_HARNESS_PROVIDER_ID))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| "DeepSeek Harness EasyCLIProxyAPI provider must be a mapping".to_string())?;
        for (key, value) in [
            ("displayName", "EasyCLIProxyAPI"),
            ("apiKeyEnv", DEEPSEEK_HARNESS_CREDENTIAL),
            ("api", "openai-completions"),
            ("baseURL", base_url),
        ] {
            provider.insert(
                yaml_key(key),
                serde_norway::Value::String(value.to_string()),
            );
        }
        provider.insert(yaml_key("models"), published_models);

        let selection = root
            .entry(yaml_key("agent-default-model"))
            .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
            .as_mapping_mut()
            .ok_or_else(|| "DeepSeek Harness agent-default-model must be a mapping".to_string())?;
        let same_model = selection.get(yaml_key("provider")).and_then(serde_norway::Value::as_str) == Some(DEEPSEEK_HARNESS_PROVIDER_ID)
            && selection.get(yaml_key("model")).and_then(serde_norway::Value::as_str) == Some(model);
        selection.insert(
            yaml_key("provider"),
            serde_norway::Value::String(DEEPSEEK_HARNESS_PROVIDER_ID.to_string()),
        );
        selection.insert(
            yaml_key("model"),
            serde_norway::Value::String(model.to_string()),
        );
        if !same_model { selection.remove(yaml_key("reasoningEffort")); }
        Ok(())
    })
}

pub(crate) fn build_deepseek_harness_credentials(
    existing: Option<&str>,
    api_key: &str,
) -> Result<String, String> {
    render_agent_yaml_mapping_update(existing, "DeepSeek Harness credentials", |root| {
        let refs = deepseek_harness_credentials_refs_mut(root, "DeepSeek Harness credentials")?;
        refs.insert(
            yaml_key(DEEPSEEK_HARNESS_CREDENTIAL),
            serde_norway::Value::String(api_key.to_string()),
        );
        Ok(())
    })
}

pub(super) fn deepseek_harness_credentials_version_is_supported(value: &serde_norway::Value) -> bool {
    value.as_u64() == Some(DEEPSEEK_HARNESS_CREDENTIALS_VERSION)
        || value.as_i64() == Some(DEEPSEEK_HARNESS_CREDENTIALS_VERSION as i64)
}

pub(super) fn validate_deepseek_harness_versioned_credentials(
    root: &serde_norway::Mapping,
    label: &str,
) -> Result<(), String> {
    let version =
        yaml_mapping_value(root, "version").ok_or_else(|| format!("{label} is missing the version field"))?;
    if !deepseek_harness_credentials_version_is_supported(version) {
        return Err(format!(
            "{label} version must be {DEEPSEEK_HARNESS_CREDENTIALS_VERSION}"
        ));
    }
    for key in root.keys() {
        let Some(key) = key.as_str() else {
            return Err(format!("Top-level field names in {label} must be strings"));
        };
        let _ = key;
    }
    for section in ["refs", "records"] {
        if yaml_mapping_value(root, section).is_some_and(|value| !value.is_mapping()) {
            return Err(format!("{label} {section} must be a mapping"));
        }
    }
    Ok(())
}

pub(super) fn deepseek_harness_credentials_refs_mut<'a>(
    root: &'a mut serde_norway::Mapping,
    label: &str,
) -> Result<&'a mut serde_norway::Mapping, String> {
    if root.is_empty() {
        root.insert(
            yaml_key("version"),
            serde_norway::Value::Number(DEEPSEEK_HARNESS_CREDENTIALS_VERSION.into()),
        );
    } else {
        validate_deepseek_harness_versioned_credentials(root, label)?;
        root.remove(yaml_key(DEEPSEEK_HARNESS_CREDENTIAL));
    }

    root.entry(yaml_key("refs"))
        .or_insert_with(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| format!("{label} refs must be a mapping"))
}

pub(super) fn remove_deepseek_harness_managed_credential(
    root: &mut serde_norway::Mapping,
    label: &str,
) -> Result<bool, String> {
    if root.is_empty() {
        return Ok(false);
    }

    validate_deepseek_harness_versioned_credentials(root, label)?;
    let mut changed = root.remove(yaml_key(DEEPSEEK_HARNESS_CREDENTIAL)).is_some();
    let mut remove_refs = false;
    if let Some(refs) = root
        .get_mut(yaml_key("refs"))
        .and_then(serde_norway::Value::as_mapping_mut)
    {
        changed |= refs.remove(yaml_key(DEEPSEEK_HARNESS_CREDENTIAL)).is_some();
        remove_refs = refs.is_empty();
    }
    if remove_refs {
        root.remove(yaml_key("refs"));
    }
    Ok(changed)
}

pub(super) fn deepseek_harness_credentials_document_is_empty(root: &serde_norway::Mapping) -> bool {
    root.iter().all(|(key, value)| match key.as_str() {
        Some("version") => deepseek_harness_credentials_version_is_supported(value),
        Some("refs" | "records") => value
            .as_mapping()
            .is_some_and(serde_norway::Mapping::is_empty),
        _ => false,
    })
}

pub(super) fn deepseek_harness_original_credential(
    root: &serde_norway::Mapping,
) -> Option<&serde_norway::Value> {
    yaml_mapping_value(root, "refs")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|refs| yaml_mapping_value(refs, DEEPSEEK_HARNESS_CREDENTIAL))
}

pub(crate) fn write_deepseek_harness_file(
    path: &Path,
    content: &[u8],
    owner_only: bool,
) -> Result<(), String> {
    if owner_only {
        write_private_bytes_directly(path, content)
    } else {
        write_bytes_directly(path, content)
    }
}
