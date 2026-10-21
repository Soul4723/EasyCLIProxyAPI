use super::*;

const MISMATCH: &str = "Backup client credentials do not match the selected core client target. Reconfigure this client instead of restoring this backup";

// Validate saved bytes, not the current files. Never retarget arbitrary user
// settings or substitute the management key for a missing Remote client key.
pub(super) fn validate_restore_target(
    config: &GuiConfigFile,
    client: &str,
    images: &Images,
) -> Result<(), String> {
    let roots = images
        .iter()
        .map(|(path, bytes)| {
            if client == "workbuddy" {
                parse_workbuddy_config(text(bytes.as_deref())?)
            } else {
                parse(path, text(bytes.as_deref())?)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let empty = Value::Null;
    let root = roots.first().unwrap_or(&empty);
    let origin = config.client_origin();
    let openai = format!("{origin}/v1");
    let key = effective_agent_api_key(config);
    let mut credentials = Vec::new();
    let mut add = |node: &Value, url: &str, secret: &str, expected: &str| -> Result<(), String> {
        if node.is_null() {
            return Ok(());
        }
        credentials.push((
            node.get(url).and_then(Value::as_str).map(str::to_owned),
            node.get(secret).and_then(Value::as_str).map(str::to_owned),
            expected.to_string(),
        ));
        Ok(())
    };
    // A loopback host (or matching installed-core host) is not ownership
    // evidence: users also run unrelated local gateways such as Ollama. Only
    // CPA's saved markers identify the Claude settings that must be fenced.
    match client {
        "claude-code" => {
            let env = &root["env"];
            let managed = env
                .as_object()
                .is_some_and(|env| env.keys().any(|k| k.starts_with("EASYCLIPROXY_")))
                || env[CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV].as_str() == Some("1")
                || env[CLAUDE_CODE_AUTO_MODE_SERVER_ENV].as_str() == Some("0");
            if managed {
                add(env, "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", &origin)?;
            }
        }
        "claude-desktop" => {
            let profile = roots.get(2).unwrap_or(&empty);
            let meta = roots.get(3).unwrap_or(&empty);
            let managed = meta["appliedId"].as_str() == Some(CLAUDE_DESKTOP_PROFILE_ID)
                || meta["entries"].as_array().is_some_and(|entries| {
                    entries
                        .iter()
                        .any(|e| e["id"].as_str() == Some(CLAUDE_DESKTOP_PROFILE_ID))
                });
            if managed {
                add(
                    profile,
                    "inferenceGatewayBaseUrl",
                    "inferenceGatewayApiKey",
                    &origin,
                )?;
            }
        }
        "codex" => add(
            &root["model_providers"][MANAGED_AGENT_PROVIDER_ID],
            "base_url",
            "experimental_bearer_token",
            &openai,
        )?,
        "opencode" => add(
            &root["provider"][MANAGED_AGENT_PROVIDER_ID]["options"],
            "baseURL",
            "apiKey",
            &openai,
        )?,
        "openclaw" => add(
            &root["models"]["providers"][MANAGED_AGENT_PROVIDER_ID],
            "baseUrl",
            "apiKey",
            &openai,
        )?,
        "kimi-code" => add(
            &root["providers"][MANAGED_AGENT_PROVIDER_ID],
            "base_url",
            "api_key",
            &openai,
        )?,
        "grok-build" => {
            if let Some(models) = root["model"].as_object() {
                for (name, node) in models {
                    if name.starts_with("cpa-gui/") {
                        add(node, "base_url", "api_key", &openai)?;
                    }
                }
            }
        }
        "omp" => add(
            &root["providers"][OMP_AGENT_PROVIDER_ID],
            "baseUrl",
            "apiKey",
            &openai,
        )?,
        "hermes" => {
            if let Some(providers) = root["custom_providers"].as_array() {
                for node in providers {
                    if node["name"] == MANAGED_AGENT_PROVIDER_ID {
                        add(node, "base_url", "api_key", &openai)?;
                    }
                }
            }
            if let Some(providers) = root["providers"].as_object() {
                for (name, node) in providers {
                    if name == MANAGED_AGENT_PROVIDER_ID
                        || node["name"] == MANAGED_AGENT_PROVIDER_ID
                    {
                        let url = if node.get("base_url").is_some() {
                            "base_url"
                        } else {
                            "baseUrl"
                        };
                        let secret = if node.get("api_key").is_some() {
                            "api_key"
                        } else {
                            "apiKey"
                        };
                        add(node, url, secret, &openai)?;
                    }
                }
            }
        }
        "zcode" => {
            if let Some(rules) = root
                .pointer("/config/providerConfigRules/providerRules")
                .and_then(Value::as_array)
            {
                for rule in rules {
                    if rule["providerId"] == MANAGED_AGENT_PROVIDER_ID {
                        let node = &rule["config"];
                        let pair = serde_json::json!({"url": node["api"]["baseUrl"], "key": node["access"]["apiKey"]});
                        add(&pair, "url", "key", &openai)?;
                    }
                }
            }
        }
        "workbuddy" => {
            if let Some(models) = root.as_array().or_else(|| root["models"].as_array()) {
                for node in models {
                    if node["vendor"] == MANAGED_AGENT_PROVIDER_ID {
                        add(node, "url", "apiKey", &format!("{openai}/chat/completions"))?;
                    }
                }
            }
        }
        "copilot-cli" | "antigravity-cli" => {
            for node in &roots {
                if node["provider"] == MANAGED_AGENT_PROVIDER_ID {
                    add(
                        node,
                        "baseUrl",
                        "apiKey",
                        if client == "copilot-cli" {
                            &openai
                        } else {
                            &origin
                        },
                    )?;
                }
            }
        }
        "vscode-copilot" => {
            for node in root.as_array().into_iter().flatten() {
                if node["name"] == "CPA (EasyCLIProxyAPI)" && node["vendor"] == "customendpoint" {
                    if !copilot_backup_credential_matches(&images[0].0, key, &node["apiKey"]) {
                        return Err(MISMATCH.into());
                    }
                    for model in node["models"].as_array().into_iter().flatten() {
                        let pair = serde_json::json!({"url": model["url"], "key": key});
                        add(&pair, "url", "key", &format!("{openai}/chat/completions"))?;
                    }
                }
            }
        }
        "deepseek-harness" => {
            let node = &root["llm-pi-ai"]["providers"][DEEPSEEK_HARNESS_PROVIDER_ID];
            if !node.is_null() {
                let secrets = roots.get(1).unwrap_or(&empty);
                let secret = secrets["refs"]
                    .get(DEEPSEEK_HARNESS_CREDENTIAL)
                    .or_else(|| secrets.get(DEEPSEEK_HARNESS_CREDENTIAL))
                    .unwrap_or(&empty);
                let pair = serde_json::json!({"url": node["baseURL"], "key": secret});
                add(&pair, "url", "key", &openai)?;
            }
        }
        PI_AGENT_ID
            if root.get("baseUrl").is_some() || root.get("apiKey").is_some() => {
            add(root, "baseUrl", "apiKey", &origin)?;
        }
        _ => {}
    }
    if !credentials.is_empty() {
        config
            .validate_client_origin()
            .map_err(|_| MISMATCH.to_string())?;
        if key.trim().is_empty() {
            return Err(MISMATCH.into());
        }
    }
    for (url, secret, expected) in credentials {
        let same_url = url
            .as_deref()
            .zip(reqwest::Url::parse(&expected).ok())
            .is_some_and(|(url, expected)| {
                reqwest::Url::parse(url).is_ok_and(|url| url == expected)
            });
        if !same_url || secret.as_deref() != Some(key) {
            return Err(MISMATCH.into());
        }
    }
    Ok(())
}
