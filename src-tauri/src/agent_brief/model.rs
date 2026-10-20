//! On-disk shapes of the agent briefing cache. Two files, each written by one party only, so
//! neither needs a read-modify-write lock: `quota.json` by the running app (the frontend's
//! quota cache, already masked), `core.json` by the `--brief` CLI (core state, on demand).
use serde::{Deserialize, Serialize};

pub(crate) const QUOTA_FILE: &str = "quota.json";
pub(crate) const CORE_FILE: &str = "core.json";

/// Providers whose quota windows the app can read (`quotaService.ts`); also the briefing's display order.
pub(crate) const QUOTA_PROVIDERS: [&str; 6] = ["claude", "codex", "antigravity", "xai", "kimi", "devin"];

const MAX_ACCOUNTS: usize = 200;
const MAX_WINDOWS: usize = 12;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct QuotaWindow {
    /// `5h`, `weekly` or `other`.
    pub(crate) kind: String,
    /// Model-group prefix such as "Code review"; empty for the account's own windows.
    pub(crate) group: String,
    pub(crate) remaining_percent: Option<f64>,
    pub(crate) reset_at_ms: Option<i64>,
    /// Untouched bucket that has no percentage (Antigravity "Quota available").
    pub(crate) available: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct QuotaAccount {
    pub(crate) auth_index: String,
    pub(crate) provider: String,
    /// Masked like privacy mode (`al***@g***.com`); the frontend never sends the raw identity.
    pub(crate) label: String,
    pub(crate) plan: String,
    pub(crate) disabled: bool,
    pub(crate) fetched_at_ms: Option<i64>,
    pub(crate) credit_balance: Option<String>,
    pub(crate) credits_unlimited: bool,
    pub(crate) windows: Vec<QuotaWindow>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct QuotaPart {
    /// Management origin of the core the quota was read from; a different target drops the part.
    pub(crate) origin: String,
    pub(crate) published_at_ms: i64,
    pub(crate) accounts: Vec<QuotaAccount>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Cooldown {
    /// `credential` or `model`.
    pub(crate) scope: String,
    pub(crate) model: String,
    pub(crate) retry_at_ms: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct CoreAccount {
    pub(crate) auth_index: String,
    pub(crate) provider: String,
    pub(crate) disabled: bool,
    pub(crate) unavailable: bool,
    pub(crate) retry_at_ms: Option<i64>,
    pub(crate) cooldowns: Vec<Cooldown>,
    pub(crate) models: Vec<String>,
    pub(crate) models_at_ms: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct CorePart {
    pub(crate) origin: String,
    /// Last attempt, successful or not; the TTL runs from here.
    pub(crate) checked_at_ms: i64,
    /// Last successful read; the accounts are as old as this.
    pub(crate) ok_at_ms: i64,
    pub(crate) up: bool,
    pub(crate) error: String,
    pub(crate) accounts: Vec<CoreAccount>,
}

fn clean_text(value: &str, max_chars: usize) -> String {
    value.chars().filter(|c| !c.is_control()).take(max_chars).collect::<String>().trim().to_string()
}

fn clean_label(value: &str) -> String {
    let label = clean_text(value, 40);
    // Defence in depth: the frontend masks, and an unmasked address must never reach the cache.
    if label.contains('@') && !label.contains("***@") { "***".to_string() } else { label }
}

fn clean_balance(value: &str) -> Option<String> {
    let text = clean_text(value, 24);
    let allowed = |c: char| c.is_ascii_alphanumeric() || "$€£¥.,- ".contains(c);
    (!text.is_empty() && text.chars().all(allowed)).then_some(text)
}

pub(crate) fn valid_auth_index(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// Bounds and re-validates what the webview sent; the command never trusts its input.
pub(crate) fn sanitize_accounts(accounts: Vec<QuotaAccount>) -> Vec<QuotaAccount> {
    accounts
        .into_iter()
        .filter(|account| QUOTA_PROVIDERS.contains(&account.provider.as_str()) && valid_auth_index(account.auth_index.trim()))
        .take(MAX_ACCOUNTS)
        .map(|account| QuotaAccount {
            auth_index: account.auth_index.trim().to_string(),
            provider: account.provider,
            label: clean_label(&account.label),
            plan: clean_text(&account.plan, 24),
            disabled: account.disabled,
            fetched_at_ms: account.fetched_at_ms.filter(|ms| *ms > 0),
            credit_balance: account.credit_balance.as_deref().and_then(clean_balance),
            credits_unlimited: account.credits_unlimited,
            windows: account
                .windows
                .into_iter()
                .take(MAX_WINDOWS)
                .map(|window| QuotaWindow {
                    kind: match window.kind.as_str() {
                        "5h" | "weekly" => window.kind,
                        _ => "other".to_string(),
                    },
                    group: clean_label(&window.group),
                    remaining_percent: window.remaining_percent.filter(|p| p.is_finite()).map(|p| p.clamp(0.0, 100.0)),
                    reset_at_ms: window.reset_at_ms.filter(|ms| *ms > 0),
                    available: window.available,
                })
                .collect(),
        })
        .collect()
}
