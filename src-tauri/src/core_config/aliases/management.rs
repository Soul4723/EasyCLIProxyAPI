use super::*;

pub(crate) async fn fetch_management_config_yaml(config: &GuiConfigFile) -> Result<String, String> {
    management_v8_yaml_to_legacy_view(&fetch_management_raw_config_yaml(config).await?)
}

pub(crate) async fn fetch_management_raw_config_yaml(config: &GuiConfigFile) -> Result<String, String> {
    let client = management_api::management_http_client_for(config)?;
    let response = client
        .get(management_endpoint(config, "config.yaml")?)
        .header("Authorization", management_authorization(config)?)
        .header(
            reqwest::header::ACCEPT,
            "application/yaml,text/yaml,text/plain",
        )
        .send()
        .await
        .map_err(|error| format_management_request_error("Failed to read kernel YAML configuration", &error))?;
    read_management_text(response).await
}

pub(crate) async fn put_management_config_yaml(
    config: &GuiConfigFile,
    content: &str,
) -> Result<(), String> {
    let current = fetch_management_config_yaml(config).await?;
    put_management_legacy_alias_view_changes(config, &current, content).await
}

pub(crate) async fn put_management_oauth_model_aliases(
    config: &GuiConfigFile,
    aliases: &serde_json::Value,
) -> Result<(), String> {
    let client = management_api::management_http_client_for(config)?;
    let response = client
        .put(management_endpoint(config, "config/oauth/model-alias")?)
        .header("Authorization", management_authorization(config)?)
        .json(aliases)
        .send()
        .await
        .map_err(|error| format_management_request_error("Failed to save OAuth model alias", &error))?;
    read_management_value(response).await.map(|_| ())
}

pub(crate) const V8_PROVIDER_FAMILIES: [(&str, &str); 8] = [
    ("gemini-api-key", "gemini"),
    ("interactions-api-key", "interactions"),
    ("vertex-api-key", "vertex"),
    ("codex-api-key", "codex"),
    ("claude-api-key", "claude"),
    ("xai-api-key", "xai"),
    ("meta-api-key", "meta"),
    ("openai-compatibility", "openai-compatibility"),
];

fn is_v8_shared_provider_field(field: &str) -> bool {
    matches!(
        field,
        "priority"
            | "prefix"
            | "proxy-url"
            | "headers"
            | "models"
            | "excluded-models"
            | "disable-cooling"
            | "request-retry"
            | "request-scoped-errors"
            | "base-url"
    )
}

fn normalize_v8_provider_record(
    provider: &str,
    record: &serde_norway::Mapping,
) -> serde_norway::Mapping {
    let mut record = record.clone();
    if provider == "openai-compatibility" {
        record.remove(yaml_key("test-model"));
        record.remove(yaml_key("testModel"));
    }
    if let Some(models) = record
        .get_mut(yaml_key("models"))
        .and_then(serde_norway::Value::as_sequence_mut)
    {
        for model in models {
            let Some(thinking) = model
                .as_mapping_mut()
                .and_then(|model| model.get_mut(yaml_key("thinking")))
                .and_then(serde_norway::Value::as_mapping_mut)
            else {
                continue;
            };
            for (json, yaml) in [
                ("zero_allowed", "zero-allowed"),
                ("dynamic_allowed", "dynamic-allowed"),
            ] {
                if let Some(value) = thinking.remove(yaml_key(json)) {
                    thinking.entry(yaml_key(yaml)).or_insert(value);
                }
            }
        }
    }
    record
}

pub(crate) fn flatten_v8_provider_groups(
    provider: &str,
    groups: &serde_norway::Value,
) -> Result<serde_norway::Value, String> {
    let groups = groups
        .as_sequence()
        .ok_or_else(|| format!("api-keys.{provider} must be an array"))?;
    let mut records = Vec::new();
    for (group_index, group) in groups.iter().enumerate() {
        let group = group.as_mapping().ok_or_else(|| {
            format!("api-keys.{provider}[{group_index}] must be an object")
        })?;
        let keys = yaml_mapping_value(group, "keys")
            .and_then(serde_norway::Value::as_sequence)
            .ok_or_else(|| {
                format!("api-keys.{provider}[{group_index}].keys must be an array")
            })?;
        if provider == "openai-compatibility" {
            let mut record = group.clone();
            record.remove(yaml_key("keys"));
            if !keys.is_empty() {
                record.insert(
                    yaml_key("api-key-entries"),
                    serde_norway::Value::Sequence(keys.clone()),
                );
            }
            records.push(serde_norway::Value::Mapping(normalize_v8_provider_record(
                provider, &record,
            )));
            continue;
        }
        for (key_index, key) in keys.iter().enumerate() {
            let key = key.as_mapping().ok_or_else(|| {
                format!(
                    "api-keys.{provider}[{group_index}].keys[{key_index}] must be an object"
                )
            })?;
            let mut record = serde_norway::Mapping::new();
            if let Some(name) = yaml_mapping_value(group, "name")
                .and_then(serde_norway::Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                let generated = name
                    .strip_prefix(&format!("{provider}-"))
                    .is_some_and(|suffix| {
                        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
                    });
                if !generated {
                    record.insert(yaml_key("name"), yaml_key(name));
                }
            }
            for (field, value) in group {
                if field
                    .as_str()
                    .is_some_and(is_v8_shared_provider_field)
                {
                    record.insert(field.clone(), value.clone());
                }
            }
            for (field, value) in key {
                if !value.is_null() {
                    record.insert(field.clone(), value.clone());
                }
            }
            records.push(serde_norway::Value::Mapping(normalize_v8_provider_record(
                provider, &record,
            )));
        }
    }
    Ok(serde_norway::Value::Sequence(records))
}

pub(crate) fn group_legacy_provider_records(
    provider: &str,
    records: &serde_norway::Value,
) -> Result<serde_norway::Value, String> {
    let records = records
        .as_sequence()
        .ok_or_else(|| format!("{provider} provider configuration must be an array"))?;
    let mut groups = Vec::new();
    for (index, record) in records.iter().enumerate() {
        let record = record
            .as_mapping()
            .ok_or_else(|| format!("{provider} provider entry {index} must be an object"))?;
        let record = normalize_v8_provider_record(provider, record);
        if provider == "openai-compatibility" {
            let mut group = record.clone();
            let keys = group
                .remove(yaml_key("api-key-entries"))
                .unwrap_or_else(|| serde_norway::Value::Sequence(Vec::new()));
            group.insert(yaml_key("keys"), keys);
            groups.push(serde_norway::Value::Mapping(group));
            continue;
        }
        let mut group = serde_norway::Mapping::new();
        let name = yaml_mapping_value(&record, "name")
            .and_then(serde_norway::Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{provider}-{}", index + 1));
        group.insert(yaml_key("name"), serde_norway::Value::String(name));
        let mut key = serde_norway::Mapping::new();
        for (field, value) in &record {
            if field.as_str() == Some("name") {
                continue;
            }
            if field
                .as_str()
                .is_some_and(is_v8_shared_provider_field)
            {
                group.insert(field.clone(), value.clone());
            } else {
                key.insert(field.clone(), value.clone());
            }
        }
        group.insert(
            yaml_key("keys"),
            serde_norway::Value::Sequence(vec![serde_norway::Value::Mapping(key)]),
        );
        groups.push(serde_norway::Value::Mapping(group));
    }
    Ok(serde_norway::Value::Sequence(groups))
}

pub(crate) fn management_v8_yaml_to_legacy_view(content: &str) -> Result<String, String> {
    let mut document = serde_norway::from_str::<serde_norway::Value>(content)
        .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
    let root = document
        .as_mapping_mut()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    if yaml_mapping_value(root, "config-version").and_then(serde_norway::Value::as_i64)
        != Some(8)
    {
        return Ok(content.to_string());
    }

    let upstreams = yaml_mapping_value(root, "api-keys")
        .and_then(serde_norway::Value::as_mapping)
        .cloned()
        .unwrap_or_default();
    let client_keys = yaml_mapping_value(root, "access")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|access| yaml_mapping_value(access, "api-keys"))
        .or_else(|| yaml_mapping_value(root, "api-keys").filter(|value| value.is_sequence()))
        .cloned();
    let oauth_aliases = yaml_mapping_value(root, "oauth")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|oauth| yaml_mapping_value(oauth, "model-alias"))
        .cloned();
    let payload = yaml_mapping_value(root, "requests")
        .and_then(serde_norway::Value::as_mapping)
        .and_then(|requests| yaml_mapping_value(requests, "payload"))
        .cloned();

    if let Some(access) = yaml_mapping_value_mut(root, "access")
        .and_then(serde_norway::Value::as_mapping_mut)
    {
        access.remove(yaml_key("api-keys"));
    }
    if let Some(oauth) = yaml_mapping_value_mut(root, "oauth")
        .and_then(serde_norway::Value::as_mapping_mut)
    {
        oauth.remove(yaml_key("model-alias"));
    }
    if let Some(requests) = yaml_mapping_value_mut(root, "requests")
        .and_then(serde_norway::Value::as_mapping_mut)
    {
        requests.remove(yaml_key("payload"));
    }
    root.remove(yaml_key("api-keys"));
    // Targeted v8 writes create parents and deletes prune them. Their empty
    // shells must not look like unrelated edits to the alias transaction.
    for parent in ["access", "oauth", "requests"] {
        if yaml_mapping_value(root, parent)
            .and_then(serde_norway::Value::as_mapping)
            .is_some_and(|mapping| mapping.is_empty())
        {
            root.remove(yaml_key(parent));
        }
    }
    if let Some(client_keys) = client_keys {
        root.insert(yaml_key("api-keys"), client_keys);
    }
    if let Some(oauth_aliases) = oauth_aliases {
        root.insert(yaml_key("oauth-model-alias"), oauth_aliases);
    }
    if let Some(payload) = payload {
        root.insert(yaml_key("payload"), payload);
    }
    for (legacy, provider) in V8_PROVIDER_FAMILIES {
        // The version marker alone does not migrate a legacy file. Only an
        // explicitly present v8 family replaces its legacy spelling (including []).
        if let Some(groups) = yaml_mapping_value(&upstreams, provider) {
            root.insert(yaml_key(legacy), flatten_v8_provider_groups(provider, groups)?);
        } else {
            root.entry(yaml_key(legacy))
                .or_insert_with(|| serde_norway::Value::Sequence(Vec::new()));
        }
    }
    serde_norway::to_string(&document)
        .map_err(|error| format!("Failed to serialize kernel YAML configuration: {error}"))
}

pub(crate) async fn put_management_config_value(
    config: &GuiConfigFile,
    path: &str,
    value: &serde_norway::Value,
) -> Result<(), String> {
    let value = serde_json::to_value(value)
        .map_err(|error| format!("Failed to serialize kernel configuration value: {error}"))?;
    let client = management_api::management_http_client_for(config)?;
    let response = client
        .put(management_endpoint(config, &format!("config/{path}"))?)
        .header("Authorization", management_authorization(config)?)
        .json(&value)
        .send()
        .await
        .map_err(|error| {
            format_management_request_error("Failed to save kernel configuration", &error)
        })?;
    read_management_value(response).await.map(|_| ())
}

async fn delete_management_config_value(
    config: &GuiConfigFile,
    path: &str,
) -> Result<(), String> {
    let client = management_api::management_http_client_for(config)?;
    let response = client
        .delete(management_endpoint(config, &format!("config/{path}"))?)
        .header("Authorization", management_authorization(config)?)
        .send()
        .await
        .map_err(|error| {
            format_management_request_error("Failed to delete kernel configuration", &error)
        })?;
    read_management_value(response).await.map(|_| ())
}

async fn put_management_legacy_alias_view_changes(
    config: &GuiConfigFile,
    current: &str,
    updated: &str,
) -> Result<(), String> {
    let parse = |content: &str| {
        let document = serde_norway::from_str::<serde_norway::Value>(content)
            .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
        document
            .as_mapping()
            .cloned()
            .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())
    };
    let mut current = parse(current)?;
    let mut updated = parse(updated)?;
    let v8 = current.get(yaml_key("config-version")).and_then(serde_norway::Value::as_i64) == Some(8);

    // OAuth aliases are written by put_management_oauth_model_aliases so their
    // transaction and rollback remain independent from other alias routes.
    current.remove(yaml_key("oauth-model-alias"));
    updated.remove(yaml_key("oauth-model-alias"));
    let current_payload = current.remove(yaml_key("payload"));
    let updated_payload = updated.remove(yaml_key("payload"));
    let mut provider_changes = Vec::new();
    for (legacy, provider) in V8_PROVIDER_FAMILIES {
        let before = current.remove(yaml_key(legacy));
        let after = updated.remove(yaml_key(legacy));
        if before != after {
            provider_changes.push((provider, before, after));
        }
    }
    // Only the extracted alias, payload, and supported provider sections are
    // written below. Unrelated configuration remains owned by the management API.

    let native = if v8 && !provider_changes.is_empty() {
        Some(parse(&fetch_management_raw_config_yaml(config).await?)?)
    } else { None };
    // Resolve every group change before writing payload rules or provider data.
    let provider_changes = provider_changes.into_iter().map(|(provider, before, after)| {
        let groups = match after {
            Some(after) => Some(if let Some(native) = &native {
                let before = before.unwrap_or_else(|| serde_norway::Value::Sequence(Vec::new()));
                let groups = match nested_yaml_value(native, &["api-keys", provider]) {
                    Some(groups) => groups.clone(),
                    None => group_legacy_provider_records(provider, &before)?,
                };
                update_v8_provider_group_models(provider, &groups, &before, &after)?
            } else { group_legacy_provider_records(provider, &after)? }),
            None => None,
        };
        Ok::<_, String>((provider, groups))
    }).collect::<Result<Vec<_>, _>>()?;

    if current_payload != updated_payload {
        if let Some(value) = updated_payload.as_ref() {
            put_management_config_value(config, "requests/payload", value).await?;
        } else {
            delete_management_config_value(config, "requests/payload").await?;
        }
    }
    for (provider, groups) in provider_changes {
        if let Some(groups) = groups.as_ref() {
            put_management_config_value(config, &format!("api-keys/{provider}"), groups).await?;
        } else {
            delete_management_config_value(config, &format!("api-keys/{provider}")).await?;
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub(crate) struct ManagementAliasConfigChanges {
    pub(crate) oauth_model_aliases: Option<serde_json::Value>,
    pub(crate) update_config_yaml: bool,
}

pub(crate) fn management_alias_config_changes(
    current: &str,
    updated: &str,
) -> Result<ManagementAliasConfigChanges, String> {
    let split = |content: &str| {
        let mut document = serde_norway::from_str::<serde_norway::Value>(content)
            .map_err(|error| format!("Failed to parse kernel YAML configuration: {error}"))?;
        let root = document
            .as_mapping_mut()
            .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
        let oauth_aliases = root
            .remove(yaml_key("oauth-model-alias"))
            .unwrap_or_else(|| serde_norway::Value::Mapping(serde_norway::Mapping::new()));
        Ok::<_, String>((document, oauth_aliases))
    };
    let (current_without_oauth, current_oauth) = split(current)?;
    let (updated_without_oauth, updated_oauth) = split(updated)?;
    let oauth_model_aliases = if current_oauth == updated_oauth {
        None
    } else {
        Some(
            serde_json::to_value(updated_oauth)
                .map_err(|error| format!("Failed to serialize OAuth model alias: {error}"))?,
        )
    };
    Ok(ManagementAliasConfigChanges {
        oauth_model_aliases,
        update_config_yaml: current_without_oauth != updated_without_oauth,
    })
}
