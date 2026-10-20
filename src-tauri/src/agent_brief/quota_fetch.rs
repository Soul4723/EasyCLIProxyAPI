//! Quota refresh done by the `--brief` CLI when an enabled account has no quota read newer than
//! `QUOTA_TTL_MS`, so agents get fresh windows while the app is closed. Like the app's Quota page
//! (`quotaService.ts`) it asks the core to call each provider's read-only usage endpoint through
//! `POST requests/api-call` (the core fills in `$TOKEN$`). Only `ALLOWED_URLS` are ever requested;
//! no inference endpoint. Reads go to their own file, so `quota.json` keeps its single writer (the
//! app); the two are merged per account and the newest read wins.
use super::cli::{now_ms, read_part, wait_for_lock, LockAcquireError, RefreshLock};
use super::model::{sanitize_accounts, CorePart, QuotaAccount, QuotaPart, QuotaWindow};
use super::refresh::{get_json, normalize_provider};
use crate::management_api::{management_authorization, management_endpoint, management_http_client_for};
use crate::GuiConfigFile;
use base64::Engine;
use futures_util::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

pub(crate) const FETCHED_FILE: &str = "quota-cli.json";
const LOCK_FILE: &str = "quota.lock";
/// An account read this recently (by the app or the CLI) is not read again.
pub(crate) const QUOTA_TTL_MS: i64 = 5 * 60_000;
/// An account whose read failed is not retried sooner than this.
pub(crate) const QUOTA_FAILURE_TTL_MS: i64 = 15 * 60_000;
const MAX_FETCHES: usize = 24;
const FETCH_CONCURRENCY: usize = 6;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const REFRESH_DEADLINE: Duration = Duration::from_secs(20);

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const DEVIN_STATUS_URL: &str = "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const DEVIN_STATUS_DATA: &str = r#"{"metadata":{"ideName":"chisel","ideVersion":"3000.10.21","apiKey":"$TOKEN$","locale":"en","os":"darwin","extensionVersion":"3000.10.21","clientName":"chisel"}}"#;
/// Every provider URL the CLI may have the core call: read-only usage and status reads.
pub(crate) const ALLOWED_URLS: [&str; 3] = [CLAUDE_USAGE_URL, CODEX_USAGE_URL, DEVIN_STATUS_URL];
/// Providers the CLI reads itself. Antigravity (needs the credential file for its project), xAI
/// (large billing parser; paid accounts have no read-only quota) and Kimi come only from the app.
pub(crate) const FETCH_PROVIDERS: [&str; 3] = ["claude", "codex", "devin"];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct FetchedPart {
    pub(crate) origin: String,
    pub(crate) accounts: Vec<QuotaAccount>,
    /// Last failed read per account.
    pub(crate) failed_at_ms: BTreeMap<String, i64>,
}

/// The quota to show: the app's snapshot merged with the CLI's own reads, refreshed first when needed.
pub(super) fn current(
    config: &GuiConfigFile,
    dir: &Path,
    origin: &str,
    app: Option<QuotaPart>,
    core: Option<&CorePart>,
) -> Option<QuotaPart> {
    let fetched = read_part::<FetchedPart>(dir, FETCHED_FILE).filter(|part| part.origin == origin);
    let fetched = match core.filter(|core| core.up) {
        Some(core) if !wanted(core, app.as_ref(), fetched.as_ref(), now_ms()).is_empty() => {
            refresh_shared(config, dir, origin, app.as_ref(), core, fetched)
        }
        _ => fetched,
    };
    merge(app, fetched)
}

fn refresh_shared(
    config: &GuiConfigFile,
    dir: &Path,
    origin: &str,
    app: Option<&QuotaPart>,
    core: &CorePart,
    fetched: Option<FetchedPart>,
) -> Option<FetchedPart> {
    let read = || read_part::<FetchedPart>(dir, FETCHED_FILE).filter(|part| part.origin == origin);
    match std::fs::create_dir_all(dir).map_err(|_| LockAcquireError::Unavailable).and_then(|_| RefreshLock::acquire_named(dir, LOCK_FILE)) {
        Ok(_lock) => {
            // A caller that read the file just before another finished its refresh must not ask again.
            let fetched = read().or(fetched);
            let wanted = wanted(core, app, fetched.as_ref(), now_ms());
            if wanted.is_empty() {
                return fetched;
            }
            let plans = merge(app.cloned(), fetched.clone())
                .map(|part| part.accounts.into_iter().map(|a| (a.auth_index, a.plan)).collect())
                .unwrap_or_default();
            let now = now_ms();
            let part = tauri::async_runtime::block_on(async {
                let reads = tokio::time::timeout(REFRESH_DEADLINE, read_accounts(config, &wanted, &plans, now)).await;
                apply(origin, fetched, &wanted, reads.unwrap_or_else(|_| Err("quota refresh timed out".to_string())), now)
            });
            if let Ok(bytes) = serde_json::to_vec(&part) {
                // Failing to cache costs the next caller a refresh; without the file there is no backoff, so it is rare by design.
                let _ = crate::write_private_bytes_atomically(&dir.join(FETCHED_FILE), &bytes);
            }
            Some(part)
        }
        Err(LockAcquireError::Held) => {
            wait_for_lock(dir, LOCK_FILE);
            read().or(fetched)
        }
        // Without a writable cache there is no backoff, so providers are never asked.
        Err(LockAcquireError::Unavailable) => fetched,
    }
}

/// Enabled accounts the CLI can read whose newest read is older than the TTL and that did not fail recently.
pub(crate) fn wanted(core: &CorePart, app: Option<&QuotaPart>, fetched: Option<&FetchedPart>, now_ms: i64) -> Vec<String> {
    let newest = |index: &str| {
        app.into_iter()
            .flat_map(|part| &part.accounts)
            .chain(fetched.into_iter().flat_map(|part| &part.accounts))
            .filter(|account| account.auth_index == index)
            .filter_map(|account| account.fetched_at_ms)
            .max()
    };
    core.accounts
        .iter()
        .filter(|account| !account.disabled && FETCH_PROVIDERS.contains(&account.provider.as_str()))
        .filter(|account| newest(&account.auth_index).is_none_or(|at| now_ms - at >= QUOTA_TTL_MS))
        .filter(|account| {
            fetched.and_then(|part| part.failed_at_ms.get(&account.auth_index)).is_none_or(|at| now_ms - at >= QUOTA_FAILURE_TTL_MS)
        })
        .map(|account| account.auth_index.clone())
        .take(MAX_FETCHES)
        .collect()
}

/// Newest read per account wins; app entries keep their order and new accounts follow.
pub(crate) fn merge(app: Option<QuotaPart>, fetched: Option<FetchedPart>) -> Option<QuotaPart> {
    let Some(fetched) = fetched.filter(|part| !part.accounts.is_empty()) else { return app };
    let mut part = app.unwrap_or_else(|| QuotaPart { origin: fetched.origin.clone(), ..Default::default() });
    for account in fetched.accounts {
        let at = account.fetched_at_ms.unwrap_or(0);
        part.published_at_ms = part.published_at_ms.max(at);
        match part.accounts.iter_mut().find(|old| old.auth_index == account.auth_index) {
            Some(old) if old.fetched_at_ms.unwrap_or(0) >= at => {}
            Some(old) => *old = account,
            None => part.accounts.push(account),
        }
    }
    Some(part)
}

type Reads = Result<Vec<(String, Result<QuotaAccount, String>)>, String>;

/// Every wanted account counts as failed unless its read succeeded.
pub(crate) fn apply(origin: &str, previous: Option<FetchedPart>, wanted: &[String], reads: Reads, now_ms: i64) -> FetchedPart {
    let mut part = previous.unwrap_or_default();
    part.origin = origin.to_string();
    part.failed_at_ms.retain(|_, at| now_ms - *at < QUOTA_FAILURE_TTL_MS);
    for index in wanted {
        part.failed_at_ms.insert(index.clone(), now_ms);
    }
    for (index, read) in reads.unwrap_or_default() {
        if let Ok(account) = read {
            part.failed_at_ms.remove(&index);
            part.accounts.retain(|old| old.auth_index != index);
            part.accounts.push(account);
        }
    }
    part.accounts = sanitize_accounts(part.accounts);
    part
}

/// One credentials listing (labels, Codex account ids), then one usage read per wanted account.
pub(crate) async fn read_accounts(config: &GuiConfigFile, wanted: &[String], plans: &BTreeMap<String, String>, now_ms: i64) -> Reads {
    let client = management_http_client_for(config)?;
    let listing = get_json(&client, config, "credentials", &[]).await?;
    let files = listing["files"].as_array().or_else(|| listing.as_array()).cloned().unwrap_or_default();
    let reads = wanted.iter().filter_map(|index| {
        let file = files.iter().find(|file| file["auth_index"].as_str().or_else(|| file["id"].as_str()).map(str::trim) == Some(index.as_str()))?;
        let provider = normalize_provider(&read_string(file, &["provider", "type", "account_type"]));
        Some((index.clone(), provider, file))
    });
    Ok(futures_util::stream::iter(reads)
        .map(|(index, provider, file)| {
            let client = &client;
            async move {
                let read = read_account(client, config, &index, &provider, file, plans.get(&index).map(String::as_str), now_ms).await;
                (index, read)
            }
        })
        .buffer_unordered(FETCH_CONCURRENCY)
        .collect()
        .await)
}

async fn read_account(
    client: &reqwest::Client,
    config: &GuiConfigFile,
    index: &str,
    provider: &str,
    file: &Value,
    plan: Option<&str>,
    now_ms: i64,
) -> Result<QuotaAccount, String> {
    let call = api_call(provider, file).ok_or("no quota read for this provider")?;
    let mut body = json!({ "authIndex": index, "method": call.method, "url": call.url, "header": call.header });
    if let Some(data) = call.data {
        body["data"] = json!(data);
    }
    let response = client
        .post(management_endpoint(config, "requests/api-call")?)
        .header("Authorization", management_authorization(config)?)
        .json(&body)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| "core request failed".to_string())?;
    if !response.status().is_success() {
        return Err(format!("core answered HTTP {}", response.status().as_u16()));
    }
    let answer = response.json::<Value>().await.map_err(|_| "unreadable core response".to_string())?;
    let status = number(&answer["status_code"]).or_else(|| number(&answer["statusCode"])).unwrap_or(0.0);
    if !(200.0..300.0).contains(&status) {
        return Err(format!("provider answered HTTP {status}"));
    }
    let raw = if answer["body"].is_null() { &answer["bodyText"] } else { &answer["body"] };
    let payload = raw.as_str().and_then(|text| serde_json::from_str(text).ok()).unwrap_or_else(|| raw.clone());
    build_account(provider, index, file, &payload, plan, now_ms)
}

#[derive(Debug, PartialEq)]
pub(crate) struct ApiCall {
    pub(crate) method: &'static str,
    pub(crate) url: &'static str,
    pub(crate) header: Value,
    pub(crate) data: Option<&'static str>,
}

/// The same request `quotaService.ts` makes for the account; `None` for providers the CLI does not read.
pub(crate) fn api_call(provider: &str, file: &Value) -> Option<ApiCall> {
    match provider {
        "claude" => Some(ApiCall {
            method: "GET",
            url: CLAUDE_USAGE_URL,
            header: json!({ "Authorization": "Bearer $TOKEN$", "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" }),
            data: None,
        }),
        "codex" => {
            let mut header = json!({
                "Authorization": "Bearer $TOKEN$",
                "Content-Type": "application/json",
                "User-Agent": "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
            });
            let account_id = first(&codex_records(file), &["chatgpt_account_id", "chatgptAccountId", "account_id", "accountId"]);
            if !account_id.is_empty() {
                header["Chatgpt-Account-Id"] = json!(account_id);
            }
            Some(ApiCall { method: "GET", url: CODEX_USAGE_URL, header, data: None })
        }
        "devin" if !read_string(file, &["name"]).is_empty() => Some(ApiCall {
            method: "POST",
            url: DEVIN_STATUS_URL,
            header: json!({ "Content-Type": "application/json", "Connect-Protocol-Version": "1" }),
            data: Some(DEVIN_STATUS_DATA),
        }),
        _ => None,
    }
}

/// The account as `agentBriefing.ts` publishes it: masked label, plan, balance and windows.
pub(crate) fn build_account(
    provider: &str,
    index: &str,
    file: &Value,
    payload: &Value,
    previous_plan: Option<&str>,
    now_ms: i64,
) -> Result<QuotaAccount, String> {
    let rows = match provider {
        "claude" => claude_rows(payload),
        "codex" => codex_rows(payload, now_ms),
        "devin" => devin_rows(payload),
        _ => Vec::new(),
    };
    if rows.is_empty() {
        return Err("unrecognised quota response".to_string());
    }
    let payload_plan = read_string(payload, &["plan_type", "planType"]);
    // The app reads Claude's plan from the profile endpoint; the CLI keeps the last known one instead.
    let plan = match provider {
        "claude" => previous_plan.filter(|plan| !plan.is_empty()).map(str::to_string),
        "devin" => Some(read_string(&payload["userStatus"]["planStatus"]["planInfo"], &["planName"])).filter(|plan| !plan.is_empty()),
        _ => None,
    }
    .filter(|plan| !plan.is_empty())
    .unwrap_or(payload_plan);
    let plan = match (plan.is_empty(), provider) {
        (true, "codex") => first(&codex_records(file), &["plan_type", "planType", "chatgpt_plan_type", "chatgptPlanType"]).to_lowercase(),
        _ => plan,
    };
    let plan = if plan.is_empty() { read_string(file, &["plan_type", "plan"]) } else { plan };
    let identity = read_string(file, &["email", "account", "label"]);
    let credits = &payload["credits"];
    let balance = match &credits["balance"] {
        Value::Number(n) => n.as_f64().map(js_number),
        Value::String(text) => Some(text.trim().to_string()),
        _ => None,
    }
    .filter(|text| BALANCE_NUMBER.is_match(text));
    Ok(QuotaAccount {
        auth_index: index.to_string(),
        provider: provider.to_string(),
        label: if identity.is_empty() { String::new() } else { clip(&mask_identifier(&identity), 40) },
        plan: clip(&plan, 24),
        disabled: false,
        fetched_at_ms: Some(now_ms),
        credit_balance: if provider == "codex" { balance } else { None },
        credits_unlimited: provider == "codex" && credits["unlimited"] == json!(true),
        windows: windows(&rows, now_ms),
    })
}

/// A provider row, in the app's English labels (only used to classify the window).
#[derive(Debug, PartialEq)]
pub(crate) struct Row {
    pub(crate) label: String,
    pub(crate) remaining: Option<f64>,
    pub(crate) reset_at_ms: Option<i64>,
}

static BALANCE_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+(?:\.\d+)?$").unwrap());
static FIVE_HOUR_WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(5|five)[\s-]?(h|hr|hour)").unwrap());
static WEEK_WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(7|seven)[\s-]?day|\bweek").unwrap());
static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}").unwrap());
static URL_USERINFO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([A-Za-z][A-Za-z0-9+.-]*://)[^\s/@]+@").unwrap());

const FIVE_HOUR_LABELS: [&str; 2] = ["5-hour window", "5-hour limit"];
const WEEKLY_LABELS: [&str; 3] = ["7-day window", "Weekly limit", "Weekly quota"];
const FIVE_HOURS_MS: i64 = 5 * 3_600_000;
const WEEK_MS: i64 = 7 * 24 * 3_600_000;

/// `classifyWindow` in `src/sections/quota/model.ts`, for the English labels.
fn classify(row: &Row, now_ms: i64) -> (&'static str, String) {
    let label = row.label.trim();
    for (kind, bases) in [("5h", &FIVE_HOUR_LABELS[..]), ("weekly", &WEEKLY_LABELS[..])] {
        if let Some(base) = bases.iter().find(|base| label.ends_with(*base)) {
            return (kind, label[..label.len() - base.len()].trim().to_string());
        }
    }
    if FIVE_HOUR_WORDS.is_match(label) {
        return ("5h", String::new());
    }
    if WEEK_WORDS.is_match(label) {
        return ("weekly", String::new());
    }
    if let Some(ahead) = row.reset_at_ms.map(|reset| reset - now_ms) {
        if ahead > 0 && ahead <= FIVE_HOURS_MS + 60_000 {
            return ("5h", label.to_string());
        }
        if ahead > 0 && ahead <= WEEK_MS + 3_600_000 {
            return ("weekly", label.to_string());
        }
    }
    ("other", String::new())
}

/// `windowsOf` in `agentBriefing.ts`.
pub(crate) fn windows(rows: &[Row], now_ms: i64) -> Vec<QuotaWindow> {
    rows.iter()
        .take(12)
        .filter_map(|row| {
            let percent = row.remaining.filter(|p| p.is_finite()).map(|p| p.clamp(0.0, 100.0))?;
            let (kind, prefix) = classify(row, now_ms);
            let label = row.label.trim();
            let plain = kind != "other"
                && prefix.is_empty()
                && FIVE_HOUR_LABELS.iter().chain(&WEEKLY_LABELS).any(|base| base.eq_ignore_ascii_case(label));
            let group = if plain { String::new() } else if prefix.is_empty() { row.label.clone() } else { prefix };
            Some(QuotaWindow {
                kind: kind.to_string(),
                group: clip(&mask_text(&group), 40),
                remaining_percent: Some(percent),
                reset_at_ms: row.reset_at_ms,
                available: false,
            })
        })
        .collect()
}

pub(crate) fn claude_rows(value: &Value) -> Vec<Row> {
    if !value.is_object() {
        return Vec::new();
    }
    let candidates: Vec<&Value> = value["limits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|limit| {
            let name = read_string(&limit["scope"]["model"], &["display_name", "displayName"]).to_lowercase();
            read_string(limit, &["kind"]).to_lowercase() == "weekly_scoped"
                && (name == "fable" || name == "fable 5")
                && number(&limit["percent"]).is_some()
        })
        .collect();
    let fable = candidates.iter().find(|limit| limit["is_active"] == json!(true)).or(candidates.first());
    let labels = [
        ("five_hour", "5-hour window"),
        ("seven_day", "7-day window"),
        ("seven_day_oauth_apps", "7-day OAuth apps window"),
        ("seven_day_opus", "7-day Opus window"),
        ("seven_day_sonnet", "7-day Sonnet window"),
        ("seven_day_cowork", "7-day Cowork window"),
        ("iguana_necktie", "7-day Fable window"),
    ];
    let mut rows: Vec<Row> = labels
        .iter()
        .filter(|(key, _)| *key != "iguana_necktie" || fable.is_none())
        .filter_map(|(key, label)| {
            let raw = value[*key].as_object()?;
            raw.contains_key("utilization").then(|| Row {
                label: label.to_string(),
                remaining: remaining_from_used(&raw["utilization"]),
                reset_at_ms: reset_for(&value[*key], &["resets_at", "resetsAt"], &[], 0),
            })
        })
        .collect();
    if let Some(fable) = fable {
        rows.push(Row {
            label: "7-day Fable window".into(),
            remaining: remaining_from_used(&fable["percent"]),
            reset_at_ms: reset_for(fable, &["resets_at", "resetsAt"], &[], 0),
        });
    }
    let extra = either(value, "extra_usage", "extraUsage");
    if extra.is_object() && boolean(either(extra, "is_enabled", "isEnabled")) == Some(true) {
        let limit = number(either(extra, "monthly_limit", "monthlyLimit"));
        let used = number(either(extra, "used_credits", "usedCredits"));
        let computed = match (limit, used) {
            (Some(limit), Some(used)) if limit > 0.0 => Some((limit - used) / limit * 100.0),
            _ => None,
        };
        rows.push(Row {
            label: "Extra usage".into(),
            remaining: remaining_from_used(&extra["utilization"]).or(computed.map(|p| p.clamp(0.0, 100.0))),
            reset_at_ms: None,
        });
    }
    rows
}

const FIVE_HOUR_SECONDS: f64 = 18_000.0;
const WEEK_SECONDS: f64 = 604_800.0;
const MIN_MONTH_SECONDS: f64 = 28.0 * 86_400.0;
const MAX_MONTH_SECONDS: f64 = 31.0 * 86_400.0;

fn duration_text(seconds: f64) -> String {
    for (unit, name) in [(86_400.0, "days"), (3_600.0, "hours"), (60.0, "minutes")] {
        if seconds % unit == 0.0 {
            return format!("{} {name}", js_number(seconds / unit));
        }
    }
    format!("{} seconds", js_number(seconds))
}

fn codex_label(duration: Option<f64>, prefix: &str, primary: bool) -> String {
    let base = match duration {
        Some(d) if d == FIVE_HOUR_SECONDS => "5-hour limit".to_string(),
        Some(d) if d == WEEK_SECONDS => "Weekly limit".to_string(),
        Some(d) if (MIN_MONTH_SECONDS..=MAX_MONTH_SECONDS).contains(&d) => "Monthly limit".to_string(),
        Some(d) if d > 0.0 => format!("{} limit", duration_text(d)),
        Some(_) => "Unknown window limit".to_string(),
        None if primary => "5-hour limit".to_string(),
        None => "Weekly limit".to_string(),
    };
    format!("{prefix}{base}")
}

pub(crate) fn codex_rows(value: &Value, now_ms: i64) -> Vec<Row> {
    if !value.is_object() {
        return Vec::new();
    }
    let mut rows = Vec::new();
    let mut add = |limit: &Value, prefix: &str| {
        if !limit.is_object() {
            return;
        }
        let mut entries = [(either(limit, "primary_window", "primaryWindow"), true), (either(limit, "secondary_window", "secondaryWindow"), false)];
        let duration = |raw: &Value| number(either(raw, "limit_window_seconds", "limitWindowSeconds"));
        entries.sort_by_key(|&(raw, primary)| match duration(raw) {
            Some(d) if d == FIVE_HOUR_SECONDS => 0,
            Some(d) if d == WEEK_SECONDS || (MIN_MONTH_SECONDS..=MAX_MONTH_SECONDS).contains(&d) => 1,
            _ => usize::from(!primary),
        });
        let reached = limit["limit_reached"] == json!(true) || limit["limitReached"] == json!(true) || limit["allowed"] == json!(false);
        for (raw, primary) in entries {
            if !raw.is_object() {
                continue;
            }
            let reset_at_ms = reset_for(raw, &["reset_at", "resetAt"], &["reset_after_seconds", "resetAfterSeconds"], now_ms);
            rows.push(Row {
                label: codex_label(duration(raw), prefix, primary),
                remaining: remaining_from_used(either(raw, "used_percent", "usedPercent"))
                    .or_else(|| (reached && reset_at_ms.is_some()).then_some(0.0)),
                reset_at_ms,
            });
        }
    };
    add(either(value, "rate_limit", "rateLimit"), "");
    add(either(value, "code_review_rate_limit", "codeReviewRateLimit"), "Code review ");
    for (position, item) in either(value, "additional_rate_limits", "additionalRateLimits").as_array().into_iter().flatten().enumerate() {
        if !item.is_object() {
            continue;
        }
        let name = read_string(item, &["limit_name", "limitName", "metered_feature", "meteredFeature"]);
        let name = if name.is_empty() { format!("Additional {}", position + 1) } else { name };
        add(either(item, "rate_limit", "rateLimit"), &format!("{name} "));
    }
    let individual = &value["spend_control"]["individual_limit"];
    if individual.is_object() {
        let limit = number(&individual["limit"]);
        rows.push(Row {
            label: "Individual spending limit".into(),
            remaining: clamp_percent(&individual["remaining_percent"])
                .or_else(|| remaining_from_used(&individual["used_percent"]))
                .or_else(|| match (number(&individual["remaining"]), limit) {
                    (Some(remaining), Some(limit)) if limit > 0.0 => Some((remaining / limit * 100.0).clamp(0.0, 100.0)),
                    _ => None,
                }),
            reset_at_ms: reset_for(individual, &["reset_at"], &["reset_after_seconds"], now_ms),
        });
    }
    rows
}

/// `readDevinQuota` in `devinQuota.ts`.
pub(crate) fn devin_rows(value: &Value) -> Vec<Row> {
    let status = &value["userStatus"]["planStatus"];
    let percent = |value: &Value| {
        let parsed = match value {
            Value::Number(n) => n.as_f64(),
            Value::String(text) if BALANCE_NUMBER.is_match(text.trim()) => text.trim().parse().ok(),
            _ => None,
        };
        parsed.filter(|p: &f64| (0.0..=100.0).contains(p))
    };
    let instant = |value: &Value| {
        let seconds = match value {
            Value::Number(n) => n.as_i64(),
            Value::String(text) if !text.trim().is_empty() && text.trim().bytes().all(|b| b.is_ascii_digit()) => text.trim().parse().ok(),
            _ => None,
        };
        seconds.filter(|s| *s > 0 && *s < (1 << 53) / 1000).map(|s| s * 1000)
    };
    let rows: Vec<Row> = [("daily", "Daily quota"), ("weekly", "Weekly quota")]
        .into_iter()
        .map(|(id, label)| Row {
            label: label.into(),
            remaining: percent(&status[format!("{id}QuotaRemainingPercent")]),
            reset_at_ms: instant(&status[format!("{id}QuotaResetAtUnix")]),
        })
        .collect();
    if rows.iter().any(|row| row.remaining.is_some() || row.reset_at_ms.is_some()) { rows } else { Vec::new() }
}

/// `value.a ?? value.b`.
fn either<'a>(value: &'a Value, a: &str, b: &str) -> &'a Value {
    if value[a].is_null() { &value[b] } else { &value[a] }
}

/// `readString`: the first key with a non-blank scalar value.
pub(crate) fn read_string(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .filter_map(|key| match &value[*key] {
            Value::String(text) => Some(text.trim().to_string()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            _ => None,
        })
        .find(|text| !text.is_empty())
        .unwrap_or_default()
}

/// `numberValue`.
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Object(map) if map.contains_key("val") => number(&map["val"]),
        Value::Number(n) => n.as_f64(),
        Value::String(text) if !text.trim().is_empty() => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|n| n.is_finite())
}

fn boolean(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => n.as_f64().map(|n| n != 0.0),
        Value::String(text) => match text.trim().to_lowercase().as_str() {
            "true" | "1" | "yes" | "y" | "on" => Some(true),
            "false" | "0" | "no" | "n" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn clamp_percent(value: &Value) -> Option<f64> {
    number(value).map(|n| n.clamp(0.0, 100.0))
}

fn remaining_from_used(value: &Value) -> Option<f64> {
    clamp_percent(value).map(|used| 100.0 - used)
}

/// `quotaResetInstant`: seconds or milliseconds since the epoch, or a date string.
fn reset_instant(value: &Value) -> Option<i64> {
    let numeric = match value {
        Value::Number(n) => n.as_f64()?,
        Value::String(text) if !text.trim().is_empty() => match text.trim().parse::<f64>() {
            Ok(n) => n,
            Err(_) => {
                let text = text.trim();
                let parsed = chrono::DateTime::parse_from_rfc3339(text).or_else(|_| chrono::DateTime::parse_from_rfc2822(text));
                return parsed.ok().map(|time| time.timestamp_millis());
            }
        },
        _ => return None,
    };
    (numeric.is_finite() && numeric > 0.0).then(|| (if numeric < 1e12 { numeric * 1000.0 } else { numeric }).round() as i64)
}

/// `quotaResetFor`: the first absolute instant, else the first relative delay in seconds.
fn reset_for(record: &Value, absolute: &[&str], relative: &[&str], now_ms: i64) -> Option<i64> {
    absolute.iter().find_map(|key| reset_instant(&record[*key])).or_else(|| {
        relative.iter().find_map(|key| {
            let seconds = match &record[*key] {
                Value::Number(n) => n.as_f64(),
                Value::String(text) if !text.trim().is_empty() => text.trim().parse::<f64>().ok(),
                _ => None,
            }?;
            (seconds.is_finite() && seconds >= 0.0).then(|| now_ms + (seconds * 1000.0).round() as i64)
        })
    })
}

/// JavaScript's `String(number)` for the values seen here.
fn js_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 { format!("{}", value as i64) } else { value.to_string() }
}

fn decode_token(value: &Value) -> Option<Value> {
    if value.is_object() {
        return Some(value.clone());
    }
    let text = value.as_str()?.trim();
    if let Ok(parsed @ Value::Object(_)) = serde_json::from_str::<Value>(text) {
        return Some(parsed);
    }
    let segment = text.split('.').nth(1).filter(|segment| !segment.is_empty())?.trim_end_matches('=');
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(segment).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object)
}

/// `codexMetadataFor`'s records: the file, its metadata and attributes, and their decoded id tokens.
fn codex_records(file: &Value) -> Vec<Value> {
    [file, &file["metadata"], &file["attributes"]]
        .into_iter()
        .filter(|record| record.is_object())
        .flat_map(|record| {
            let mut records = vec![record.clone()];
            for token in [&record["id_token"], &record["idToken"]] {
                if let Some(payload) = decode_token(token) {
                    let claim = payload["https://api.openai.com/auth"].clone();
                    records.push(payload);
                    if claim.is_object() {
                        records.push(claim);
                    }
                }
            }
            records
        })
        .collect()
}

fn first(records: &[Value], keys: &[&str]) -> String {
    records.iter().map(|record| read_string(record, keys)).find(|text| !text.is_empty()).unwrap_or_default()
}

fn clip(value: &str, max: usize) -> String {
    let printable: String = value.chars().filter(|c| *c as u32 > 31 && *c as u32 != 127).collect();
    printable.trim().chars().take(max).collect()
}

/// `maskEmail` / `maskIdentifier` in `privacyMask.ts`.
fn mask_email(email: &str) -> String {
    let Some(at) = email.rfind('@').filter(|at| *at > 0) else { return mask_identifier(email) };
    let (local, domain) = (&email[..at], &email[at + 1..]);
    let (host, suffix) = match domain.rfind('.').filter(|dot| *dot > 0) {
        Some(dot) => (&domain[..dot], &domain[dot..]),
        None => (domain, ""),
    };
    let keep = |text: &str, count: usize| text.chars().take(count).collect::<String>();
    format!("{}***@{}***{suffix}", keep(local, if local.chars().count() > 4 { 2 } else { 1 }), keep(host, 1))
}

pub(crate) fn mask_identifier(value: &str) -> String {
    let text = value.trim();
    if text.contains('@') {
        return mask_email(text);
    }
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= 4 {
        return if text.is_empty() { value.to_string() } else { "***".to_string() };
    }
    let visible = if chars.len() > 10 { 2 } else { 1 };
    format!("{}***{}", chars[..visible].iter().collect::<String>(), chars[chars.len() - visible..].iter().collect::<String>())
}

fn mask_text(text: &str) -> String {
    let text = URL_USERINFO.replace_all(text, "${1}***@");
    EMAIL.replace_all(&text, |caps: &regex::Captures| mask_email(&caps[0])).into_owned()
}

#[cfg(test)]
mod tests;
