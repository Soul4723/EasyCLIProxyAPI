//! Core-state refresh done by the `--brief` CLI when its cached copy is older than the TTL.
//! Only the core's own management API is read (`GET /credentials`, `GET /credentials/models`);
//! no provider endpoint and no `requests/api-call` is ever used, so a query costs no provider quota.
use super::model::{Cooldown, CoreAccount, CorePart};
use crate::management_api::{management_authorization, management_endpoint, management_http_client_for};
use crate::GuiConfigFile;
use chrono::DateTime;
use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;

/// A successful read stays fresh this long; concurrent agents share one round trip per window.
pub(crate) const CORE_TTL_MS: i64 = 60_000;
/// A failed read is retried sooner, but not on every query while the core is down.
pub(crate) const CORE_FAILURE_TTL_MS: i64 = 15_000;
/// Per-credential model lists change rarely (plan or config edits), so they live much longer.
const MODELS_TTL_MS: i64 = 15 * 60_000;
const MAX_MODEL_FETCHES: usize = 32;
const MODEL_FETCH_CONCURRENCY: usize = 8;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);

pub(crate) fn is_fresh(core: &CorePart, now_ms: i64) -> bool {
    let ttl = if core.up { CORE_TTL_MS } else { CORE_FAILURE_TTL_MS };
    core.checked_at_ms <= now_ms && now_ms - core.checked_at_ms < ttl
}

/// Same names the app uses for quota providers (`providerForFile`), applied to every provider id.
pub(crate) fn normalize_provider(raw: &str) -> String {
    let value = raw.trim().to_ascii_lowercase().replace('_', "-");
    match value.as_str() {
        "anthropic" => "claude",
        "x-ai" | "x.ai" | "grok" => "xai",
        "cognition" => "devin",
        "anti-gravity" => "antigravity",
        "muse" => "meta",
        other => other,
    }
    .to_string()
}

fn rfc3339_ms(value: &Value) -> Option<i64> {
    DateTime::parse_from_rfc3339(value.as_str()?).ok().map(|time| time.timestamp_millis())
}

fn parse_cooldowns(value: &Value, now_ms: i64) -> Vec<Cooldown> {
    // `null` means the core cannot report cooldowns (Home mode): treated as none.
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let retry_at_ms = rfc3339_ms(&item["retry_at"])
                        .or_else(|| item["remaining_seconds"].as_i64().map(|s| now_ms + s.max(0) * 1000))?;
                    Some(Cooldown {
                        scope: item["scope"].as_str().unwrap_or("credential").to_string(),
                        model: item["model_key"].as_str().unwrap_or("").trim().to_ascii_lowercase(),
                        retry_at_ms,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One credential entry of `/credentials`, plus the name the models endpoint wants (never stored).
pub(crate) struct ParsedCredential {
    pub(crate) account: CoreAccount,
    pub(crate) name: String,
}

pub(crate) fn parse_credentials(body: &Value, now_ms: i64) -> Vec<ParsedCredential> {
    let files = body["files"].as_array().or_else(|| body.as_array());
    files
        .map(|files| {
            files
                .iter()
                .filter_map(|file| {
                    let auth_index = file["auth_index"].as_str().or_else(|| file["id"].as_str())?.trim().to_string();
                    let provider = normalize_provider(file["provider"].as_str().or_else(|| file["type"].as_str())?);
                    if auth_index.is_empty() || provider.is_empty() {
                        return None;
                    }
                    let name = file["name"].as_str().or_else(|| file["id"].as_str()).unwrap_or("").to_string();
                    Some(ParsedCredential {
                        account: CoreAccount {
                            auth_index,
                            provider,
                            disabled: file["disabled"].as_bool().unwrap_or(false)
                                || file["status"].as_str() == Some("disabled"),
                            unavailable: file["unavailable"].as_bool().unwrap_or(false),
                            retry_at_ms: rfc3339_ms(&file["next_retry_after"]),
                            cooldowns: parse_cooldowns(&file["cooldowns"], now_ms),
                            models: Vec::new(),
                            models_at_ms: 0,
                        },
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn parse_models(body: &Value) -> Vec<String> {
    let mut ids: Vec<String> = body["models"]
        .as_array()
        .or_else(|| body["data"].as_array())
        .map(|items| items.iter().filter_map(|item| item["id"].as_str()).map(|id| id.trim().to_string()).collect())
        .unwrap_or_default();
    ids.retain(|id| !id.is_empty());
    ids.sort();
    ids.dedup();
    ids
}

fn failure_text(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "core timed out".to_string()
    } else if error.is_connect() {
        "could not connect to the core".to_string()
    } else {
        "core request failed".to_string()
    }
}

async fn get_json(
    client: &reqwest::Client,
    config: &GuiConfigFile,
    path: &str,
    query: &[(&str, &str)],
) -> Result<Value, String> {
    let response = client
        .get(management_endpoint(config, path)?)
        .header("Authorization", management_authorization(config)?)
        .query(query)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| failure_text(&error))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("management key rejected by the core".to_string());
    }
    if !status.is_success() {
        return Err(format!("core answered HTTP {}", status.as_u16()));
    }
    response.json::<Value>().await.map_err(|_| "unreadable core response".to_string())
}

/// Reads credentials (one GET) and, for credentials whose model list is missing or old, their
/// models (bounded, concurrent). On failure the previous accounts are kept and marked down.
pub(crate) async fn refresh(
    config: &GuiConfigFile,
    origin: &str,
    previous: Option<&CorePart>,
    now_ms: i64,
) -> CorePart {
    let down = |error: String| {
        let mut part = previous.cloned().unwrap_or_default();
        part.origin = origin.to_string();
        part.checked_at_ms = now_ms;
        part.up = false;
        part.error = error;
        part
    };
    let client = match management_http_client_for(config) {
        Ok(client) => client,
        Err(error) => return down(error),
    };
    let listing = match get_json(&client, config, "credentials", &[]).await {
        Ok(listing) => listing,
        Err(error) => return down(error),
    };
    let mut parsed = parse_credentials(&listing, now_ms);
    let known = |index: &str| previous.and_then(|p| p.accounts.iter().find(|a| a.auth_index == index));
    let mut wanted = Vec::new();
    for (position, credential) in parsed.iter_mut().enumerate() {
        if let Some(old) = known(&credential.account.auth_index) {
            credential.account.models = old.models.clone();
            credential.account.models_at_ms = old.models_at_ms;
        }
        let account = &credential.account;
        let fresh = account.models_at_ms > 0 && now_ms - account.models_at_ms < MODELS_TTL_MS;
        if !account.disabled && !fresh && !credential.name.is_empty() && wanted.len() < MAX_MODEL_FETCHES {
            wanted.push((position, credential.name.clone()));
        }
    }
    let fetched: Vec<(usize, Result<Vec<String>, String>)> = futures_util::stream::iter(wanted)
        .map(|(position, name)| {
            let client = &client;
            async move {
                let result = get_json(client, config, "credentials/models", &[("name", name.as_str())]).await;
                (position, result.map(|body| parse_models(&body)))
            }
        })
        .buffer_unordered(MODEL_FETCH_CONCURRENCY)
        .collect()
        .await;
    for (position, result) in fetched {
        // A failed model read keeps the older list; only the listing decides whether the core is up.
        parsed[position].account.models_at_ms = now_ms;
        if let Ok(models) = result { parsed[position].account.models = models; }
    }
    CorePart {
        origin: origin.to_string(),
        checked_at_ms: now_ms,
        ok_at_ms: now_ms,
        up: true,
        error: String::new(),
        accounts: parsed.into_iter().map(|credential| credential.account).collect(),
    }
}
