use super::*;

#[cfg(test)]
pub(crate) fn build_codex_agent_config(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<String, String> {
    build_codex_agent_config_with_oauth(existing, base_url, api_key, model, false)
}

pub(crate) fn build_codex_agent_config_with_oauth(
    existing: Option<&str>,
    base_url: &str,
    api_key: &str,
    model: &str,
    oauth_configuration: bool,
) -> Result<String, String> {
    use toml_edit::{value, Document, Item, Table};

    let mut document = match existing.filter(|value| !value.trim().is_empty()) {
        Some(value) => value
            .parse::<Document>()
            .map_err(|_| "Invalid Codex config.toml format".to_string())?,
        None => Document::new(),
    };
    set_codex_table_item(
        document.as_table_mut(),
        "model_provider",
        value(MANAGED_AGENT_PROVIDER_ID),
    );
    set_codex_table_item(document.as_table_mut(), "model", value(model));
    set_codex_table_item(
        document.as_table_mut(),
        "model_catalog_json",
        value(CODEX_MODEL_CATALOG_FILE),
    );
    if !document
        .get("model_providers")
        .is_some_and(toml_edit::Item::is_table)
    {
        document.remove("model_providers");
        document["model_providers"] = Item::Table(Table::new());
    }
    let providers = document["model_providers"]
        .as_table_mut()
        .ok_or_else(|| "Codex model_providers must be a TOML table".to_string())?;
    if !providers
        .get(MANAGED_AGENT_PROVIDER_ID)
        .is_some_and(toml_edit::Item::is_table)
    {
        providers.remove(MANAGED_AGENT_PROVIDER_ID);
        providers.insert(MANAGED_AGENT_PROVIDER_ID, Item::Table(Table::new()));
    }
    let provider = providers
        .get_mut(MANAGED_AGENT_PROVIDER_ID)
        .and_then(Item::as_table_mut)
        .ok_or_else(|| "Codex cpa-gui provider must be a TOML table".to_string())?;
    set_codex_table_item(provider, "name", value("EasyCLIProxyAPI"));
    set_codex_table_item(provider, "base_url", value(base_url));
    set_codex_table_item(provider, "wire_api", value("responses"));
    set_codex_table_item(provider, "experimental_bearer_token", value(api_key));
    if oauth_configuration {
        set_codex_table_item(provider, "requires_openai_auth", value(true));
    } else {
        provider.remove("requires_openai_auth");
    }
    let rendered = document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("Failed to validate Codex configuration: {error}"))?;
    Ok(rendered)
}

pub(crate) fn build_codex_api_auth(api_key: &str) -> Result<String, String> {
    let mut rendered = serde_json::to_string_pretty(&serde_json::json!({
        "auth_mode": "apikey",
        "OPENAI_API_KEY": api_key,
    }))
    .map_err(|error| format!("Failed to generate Codex auth.json: {error}"))?;
    rendered.push('\n');
    Ok(rendered)
}

pub(crate) fn build_codex_auth_update(
    home: &Path,
    api_key: &str,
    oauth_configuration: bool,
) -> Result<AgentFileUpdate, String> {
    let path = codex_configuration_directory(home).join("auth.json");
    let after = if oauth_configuration {
        if validate_codex_oauth_login_at(&path).is_ok() {
            read_optional_text(&path)?
                .ok_or_else(|| "Codex OAuth login credentials were deleted before the application configuration was applied. Sign in again".to_string())?
        } else {
            available_codex_oauth_auth(home)?
        }
    } else {
        let path_text = read_optional_text(&path)?;
        let mut root = parse_agent_json_object(path_text.as_deref(), "Codex auth.json")?;
        for key in ["tokens", "last_refresh"] { root.remove(key); }
        root.insert("auth_mode".into(), serde_json::json!("apikey"));
        root.insert("OPENAI_API_KEY".into(), serde_json::json!(api_key));
        render_agent_json(root, "Codex auth.json")?
    };
    Ok(AgentFileUpdate { path, after })
}

pub(super) const CODEX_MANAGED_ROOT_KEYS: [&str; 3] = ["model_provider", "model", "model_catalog_json"];
pub(super) const CODEX_MANAGED_PROVIDER_KEYS: [&str; 5] = [
    "name",
    "base_url",
    "wire_api",
    "experimental_bearer_token",
    "requires_openai_auth",
];

pub(crate) fn set_codex_table_item(
    table: &mut toml_edit::Table,
    key: &str,
    mut item: toml_edit::Item,
) {
    if let (Some(current), Some(next)) = (
        table.get(key).and_then(toml_edit::Item::as_value),
        item.as_value_mut(),
    ) {
        *next.decor_mut() = current.decor().clone();
    }
    *table.entry(key).or_insert(toml_edit::Item::None) = item;
}

pub(crate) fn restore_codex_table_item(
    current: &mut toml_edit::Table,
    original: Option<&toml_edit::Table>,
    key: &str,
) {
    let original_item = original.and_then(|table| table.get(key)).cloned();
    if let Some(item) = original_item {
        let existed = current.contains_key(key);
        let original_key_decor = original.and_then(|table| table.key_decor(key)).cloned();
        set_codex_table_item(current, key, item);
        if !existed {
            if let (Some(current_decor), Some(original_decor)) =
                (current.key_decor_mut(key), original_key_decor)
            {
                *current_decor = original_decor;
            }
        }
    } else {
        current.remove(key);
    }
}

pub(crate) fn parse_codex_document(
    content: Option<&str>,
    label: &str,
) -> Result<toml_edit::Document, String> {
    use toml_edit::Document;

    match content.filter(|value| !value.trim().is_empty()) {
        Some(value) => value
            .parse::<Document>()
            .map_err(|_| format!("Invalid {label} format")),
        None => Ok(Document::new()),
    }
}

pub(crate) fn codex_provider_table(document: &toml_edit::Document) -> Option<&toml_edit::Table> {
    document
        .as_table()
        .get("model_providers")
        .and_then(toml_edit::Item::as_table)
        .and_then(|providers| providers.get(MANAGED_AGENT_PROVIDER_ID))
        .and_then(toml_edit::Item::as_table)
}

pub(crate) fn ensure_codex_provider_table(
    document: &mut toml_edit::Document,
) -> Result<&mut toml_edit::Table, String> {
    use toml_edit::{Item, Table};

    let root = document.as_table_mut();
    if !root.contains_key("model_providers") {
        root.insert("model_providers", Item::Table(Table::new()));
    }
    let providers = root
        .get_mut("model_providers")
        .and_then(Item::as_table_mut)
        .ok_or_else(|| "Codex model_providers must be a TOML table".to_string())?;
    if !providers.contains_key(MANAGED_AGENT_PROVIDER_ID) {
        providers.insert(MANAGED_AGENT_PROVIDER_ID, Item::Table(Table::new()));
    }
    providers
        .get_mut(MANAGED_AGENT_PROVIDER_ID)
        .and_then(Item::as_table_mut)
        .ok_or_else(|| "Codex cpa-gui provider must be a TOML table".to_string())
}

pub(crate) fn merge_missing_codex_table_items(
    current: &mut toml_edit::Table,
    original: &toml_edit::Table,
) {
    for (key, original_item) in original.iter() {
        if !current.contains_key(key) {
            current.insert(key, original_item.clone());
            continue;
        }
        if let (Some(current_table), Some(original_table)) = (
            current.get_mut(key).and_then(toml_edit::Item::as_table_mut),
            original_item.as_table(),
        ) {
            merge_missing_codex_table_items(current_table, original_table);
        }
    }
}

pub(crate) fn build_restored_codex_agent_config(
    current: Option<&str>,
    original: Option<&str>,
) -> Result<Option<String>, String> {
    build_restored_codex_agent_config_with_policy(current, original, true)
}

pub(crate) fn build_restored_codex_agent_config_with_policy(
    current: Option<&str>,
    original: Option<&str>,
    retain_dormant_provider: bool,
) -> Result<Option<String>, String> {
    use toml_edit::Item;

    let mut current_document = parse_codex_document(current, "Current Codex config.toml")?;
    let original_document = original
        .map(|content| parse_codex_document(Some(content), "Original Codex config.toml"))
        .transpose()?;
    if let Some(original_document) = original_document.as_ref() {
        merge_missing_codex_table_items(
            current_document.as_table_mut(),
            original_document.as_table(),
        );
    }

    for key in CODEX_MANAGED_ROOT_KEYS {
        restore_codex_table_item(
            current_document.as_table_mut(),
            original_document
                .as_ref()
                .map(|document| document.as_table()),
            key,
        );
    }

    let original_provider_items = CODEX_MANAGED_PROVIDER_KEYS
        .into_iter()
        .map(|key| {
            (
                key,
                original_document
                    .as_ref()
                    .and_then(codex_provider_table)
                    .and_then(|provider| provider.get(key))
                    .cloned(),
            )
        })
        .collect::<Vec<_>>();
    let needs_provider = original_provider_items
        .iter()
        .any(|(_, item)| item.is_some());

    if needs_provider {
        let provider = ensure_codex_provider_table(&mut current_document)?;
        let original_provider = original_document.as_ref().and_then(codex_provider_table);
        for (key, item) in &original_provider_items {
            if item.is_some() {
                restore_codex_table_item(provider, original_provider, key);
            } else {
                provider.remove(key);
            }
        }
    } else if !retain_dormant_provider {
        if let Some(providers) = current_document
            .as_table_mut()
            .get_mut("model_providers")
            .and_then(Item::as_table_mut)
        {
            if let Some(provider) = providers
                .get_mut(MANAGED_AGENT_PROVIDER_ID)
                .and_then(Item::as_table_mut)
            {
                for key in CODEX_MANAGED_PROVIDER_KEYS {
                    provider.remove(key);
                }
                if provider.is_empty() {
                    providers.remove(MANAGED_AGENT_PROVIDER_ID);
                }
            }
        }
    }

    let remove_providers = current_document
        .as_table()
        .get("model_providers")
        .and_then(Item::as_table)
        .is_some_and(toml_edit::Table::is_empty);
    if remove_providers {
        current_document.as_table_mut().remove("model_providers");
    }

    let rendered = current_document.to_string();
    toml::from_str::<toml::Value>(&rendered)
        .map_err(|error| format!("Failed to validate restored Codex configuration: {error}"))?;
    if original.is_none() && rendered.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(rendered))
    }
}

pub(crate) fn validate_codex_catalog(catalog: &str, model: &str) -> Result<(), String> {
    let root: serde_json::Value = serde_json::from_str(catalog)
        .map_err(|_| "Invalid Codex model catalog format".to_string())?;
    let models = root
        .get("models")
        .and_then(serde_json::Value::as_array)
        .filter(|models| !models.is_empty())
        .ok_or_else(|| "Codex model catalog must contain a non-empty models array".to_string())?;
    if !models.iter().any(|entry| {
        entry
            .get("slug")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|slug| slug.eq_ignore_ascii_case(model))
    }) {
        return Err(format!("Default model {model} is not in the generated Codex model catalog"));
    }
    Ok(())
}
