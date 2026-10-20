//! Turns the two cache parts into the briefing. Pure: the caller passes `now`, so every relative
//! time ("resets in 1h12m") is computed at read time from absolute timestamps in the cache.
use super::model::{CoreAccount, CorePart, QuotaAccount, QuotaPart, QuotaWindow};
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// Quota data older than this is flagged stale (same limit the Quota page draws stripes at).
pub(crate) const STALE_AFTER_MS: i64 = 30 * 60_000;
/// Guidance thresholds, derived from the numbers only (documented in `skills/cpa-brief/SKILL.md`):
/// a provider whose best account has at least `HIGH_PCT` left on its tightest window is "swarm"
/// material, below `LOW_PCT` it is "low"; an unavailable provider that recovers within `SOON_MS`
/// is worth waiting for.
pub(crate) const HIGH_PCT: f64 = 50.0;
pub(crate) const LOW_PCT: f64 = 20.0;
pub(crate) const SOON_MS: i64 = 30 * 60_000;
/// Model families listed per provider in the default text (`--model` and `--json` list all).
const TEXT_MODEL_CAP: usize = 4;
const TEXT_COOL_CAP: usize = 4;
const PROVIDER_ORDER: [&str; 6] = super::model::QUOTA_PROVIDERS;

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Filters {
    pub(crate) provider: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) accounts: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Status {
    Ok,
    Low,
    Out,
    Cool,
    Err,
    Off,
}

impl Status {
    fn word(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Low => "low",
            Self::Out => "out",
            Self::Cool => "cool",
            Self::Err => "err",
            Self::Off => "off",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WindowView {
    /// `5h`, `wk` or `lim`.
    pub(crate) label: &'static str,
    pub(crate) group: String,
    pub(crate) pct: i64,
    /// Milliseconds until reset; None when the window is full or the reset is unknown.
    pub(crate) reset_in_ms: Option<i64>,
    /// The reset time passed since the quota was read: shown as `reset`.
    pub(crate) reset_passed: bool,
    /// Exhausted at the strict 0.5% threshold when evaluated.
    exhausted: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct AccountView {
    pub(crate) label: String,
    pub(crate) status: Status,
    pub(crate) back_ms: Option<i64>,
    pub(crate) plan: String,
    pub(crate) balance: Option<String>,
    pub(crate) windows: Vec<WindowView>,
}

#[derive(Clone, Debug)]
pub(crate) struct ProviderView {
    pub(crate) id: String,
    pub(crate) status: Status,
    pub(crate) usable: usize,
    pub(crate) total: usize,
    pub(crate) back_ms: Option<i64>,
    pub(crate) windows: Vec<WindowView>,
    pub(crate) balance: Option<String>,
    /// Usable accounts exist but none has quota data.
    pub(crate) no_quota: bool,
    pub(crate) models_ok: Vec<String>,
    pub(crate) models_cool: Vec<(String, i64)>,
    /// Best single-account bottleneck, the number the guidance line is based on.
    pub(crate) headroom: Option<f64>,
    pub(crate) accounts: Vec<AccountView>,
}

#[derive(Clone, Debug)]
pub(crate) struct Briefing {
    pub(crate) mode: String,
    /// `up`, `down` or `unknown`.
    pub(crate) core_state: &'static str,
    pub(crate) core_age_ms: Option<i64>,
    pub(crate) core_error: String,
    pub(crate) quota_age_ms: Option<i64>,
    pub(crate) quota_stale: bool,
    pub(crate) providers: Vec<ProviderView>,
    pub(crate) guide: Option<String>,
    pub(crate) model_filter: Option<String>,
    pub(crate) provider_filter: Option<String>,
}

pub(crate) struct Inputs<'a> {
    pub(crate) mode: &'a str,
    pub(crate) quota: Option<&'a QuotaPart>,
    pub(crate) core: Option<&'a CorePart>,
    pub(crate) now_ms: i64,
}

/// Compact duration: `<1m`, `22m`, `1h12m`, `13h`, `3d4h`. Used for resets and ages.
pub(crate) fn format_duration(ms: i64) -> String {
    let minutes = ms.max(0) / 60_000;
    let (days, hours, mins) = (minutes / 1440, (minutes % 1440) / 60, minutes % 60);
    if days > 0 {
        if hours > 0 { format!("{days}d{hours}h") } else { format!("{days}d") }
    } else if hours > 0 {
        if mins > 0 && hours < 10 { format!("{hours}h{mins}m") } else { format!("{hours}h") }
    } else if minutes == 0 {
        "<1m".to_string()
    } else {
        format!("{mins}m")
    }
}

struct Acct<'a> {
    label: String,
    core: Option<&'a CoreAccount>,
    quota: Option<&'a QuotaAccount>,
    status: Status,
    back_ms: Option<i64>,
    /// Effective view of each window at `now`.
    windows: Vec<WindowView>,
}

struct Eff {
    pct: f64,
    reset_in_ms: Option<i64>,
    passed: bool,
}

fn evaluate(window: &QuotaWindow, now_ms: i64) -> Option<Eff> {
    let pct = match window.remaining_percent {
        Some(pct) => pct,
        None if window.available => 100.0,
        None => return None,
    };
    match window.reset_at_ms {
        // The window reset after the quota was read; what was used since is unknown, so count it as full.
        Some(reset) if reset <= now_ms => Some(Eff { pct: 100.0, reset_in_ms: None, passed: true }),
        Some(reset) => Some(Eff { pct, reset_in_ms: Some(reset - now_ms), passed: false }),
        None => Some(Eff { pct, reset_in_ms: None, passed: false }),
    }
}

fn label_of(window: &QuotaWindow) -> &'static str {
    match window.kind.as_str() {
        "5h" => "5h",
        "weekly" => "wk",
        _ => "lim",
    }
}

fn window_views(windows: &[QuotaWindow], now_ms: i64) -> Vec<WindowView> {
    windows
        .iter()
        .filter_map(|window| {
            let eff = evaluate(window, now_ms)?;
            let reset_in_ms = if eff.pct >= 100.0 { None } else { eff.reset_in_ms };
            let view = WindowView {
                label: label_of(window),
                group: window.group.clone(),
                pct: if eff.pct < 0.5 { 0 } else { eff.pct.round() as i64 },
                reset_in_ms,
                reset_passed: eff.passed,
                exhausted: eff.pct < 0.5 && !eff.passed,
            };
            Some(view)
        })
        .collect()
}

fn active_model_cooldown(core: &CoreAccount, model: &str, now_ms: i64) -> Option<i64> {
    core.cooldowns
        .iter()
        .filter(|c| c.scope == "model" && c.model == model && c.retry_at_ms > now_ms)
        .map(|c| c.retry_at_ms)
        .max()
}

fn classify<'a>(
    core: Option<&'a CoreAccount>,
    quota: Option<&'a QuotaAccount>,
    index: usize,
    now_ms: i64,
) -> Acct<'a> {
    let windows = quota.map(|q| window_views(&q.windows, now_ms)).unwrap_or_default();
    // Only the account's own windows decide exhaustion; a model-group window at 0% blocks just those models.
    let exhausted_until = windows
        .iter()
        .filter(|view| view.exhausted && view.group.is_empty())
        .filter_map(|view| view.reset_in_ms)
        .max();
    let exhausted = windows.iter().any(|view| view.exhausted && view.group.is_empty());
    let disabled = core.map(|c| c.disabled).unwrap_or(false) || quota.map(|q| q.disabled).unwrap_or(false);
    let mut cool_until: Option<i64> = None;
    let mut errored = false;
    if let Some(core) = core {
        for cooldown in core.cooldowns.iter().filter(|c| c.scope == "credential" && c.retry_at_ms > now_ms) {
            cool_until = cool_until.max(Some(cooldown.retry_at_ms - now_ms));
        }
        if core.unavailable {
            match core.retry_at_ms {
                Some(retry) if retry > now_ms => cool_until = cool_until.max(Some(retry - now_ms)),
                Some(_) => {}
                None => errored = cool_until.is_none(),
            }
        }
    }
    let (status, back_ms) = if disabled {
        (Status::Off, None)
    } else if errored {
        (Status::Err, None)
    } else if exhausted {
        (Status::Out, cool_until.max(exhausted_until))
    } else if cool_until.is_some() {
        (Status::Cool, cool_until)
    } else {
        (Status::Ok, None)
    };
    let label = quota
        .map(|q| q.label.clone())
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| format!("acct{}", index + 1));
    Acct { label, core, quota, status, back_ms, windows }
}

fn primary<'a>(acct: &'a Acct<'_>) -> impl Iterator<Item = &'a WindowView> {
    acct.windows.iter().filter(|view| view.group.is_empty())
}

fn bottleneck(acct: &Acct) -> Option<f64> {
    primary(acct).map(|view| view.pct as f64).reduce(f64::min)
}

fn balance_of(account: &Acct) -> Option<String> {
    account.quota.and_then(|q| if q.credits_unlimited { Some("unlimited".to_string()) } else { q.credit_balance.clone() })
}

/// Natural order: digit runs compare as numbers, so `opus-5-10` sorts after `opus-5-9`.
fn natural_key(id: &str) -> (Vec<(u8, u64, String)>, Vec<u64>) {
    let mut key = Vec::new();
    let mut dates = Vec::new();
    let mut chars = id.chars().peekable();
    while let Some(&c) = chars.peek() {
        let digits = c.is_ascii_digit();
        let mut run = String::new();
        while let Some(&n) = chars.peek() {
            if n.is_ascii_digit() != digits {
                break;
            }
            run.push(n);
            chars.next();
        }
        if digits {
            let value = run.parse().unwrap_or(u64::MAX);
            if run.len() >= 6 { dates.push(value); } else { key.push((0, value, String::new())); }
        } else {
            key.push((1, 0, run));
        }
    }
    (key, dates)
}

fn version_key(id: &str) -> Vec<u64> {
    let mut versions = Vec::new();
    for token in id.split(|c: char| !c.is_ascii_digit()).filter(|token| !token.is_empty()) {
        let value = token.parse().unwrap_or(u64::MAX);
        if token.len() < 6 { versions.push(value); }
    }
    versions
}

/// A model family is its id without version and date tokens: `claude-sonnet-5-5` and
/// `claude-3-7-sonnet-20250219` are both `claude-sonnet`, while `gpt-6-luna` and `gpt-6-sol` stay apart.
fn family(id: &str) -> String {
    let words: Vec<&str> = id.split('-').filter(|t| !t.chars().all(|c| c.is_ascii_digit() || c == '.')).collect();
    if words.is_empty() { id.to_string() } else { words.join("-") }
}

/// The default text shows the newest models first, with family name as a tie-breaker.
fn featured(models: &[String], cap: usize) -> Vec<&String> {
    let mut best: std::collections::BTreeMap<String, &String> = Default::default();
    // Image-generation models are never what a coding agent delegates to; `--model image` still lists them.
    for model in models.iter().filter(|m| !m.to_ascii_lowercase().contains("image")) {
        let slot = best.entry(family(model)).or_insert(model);
        if natural_key(model) > natural_key(slot) {
            *slot = model;
        }
    }
    let mut featured: Vec<_> = best.into_values().collect();
    featured.sort_by(|a, b| version_key(b).cmp(&version_key(a)).then_with(|| family(a).cmp(&family(b))));
    featured.truncate(cap);
    featured
}

fn provider_rank(id: &str) -> (usize, String) {
    (PROVIDER_ORDER.iter().position(|p| *p == id).unwrap_or(PROVIDER_ORDER.len()), id.to_string())
}

fn matches_model(id: &str, filter: &Option<String>) -> bool {
    filter.as_ref().map(|needle| id.to_ascii_lowercase().contains(needle)).unwrap_or(true)
}

pub(crate) fn build(inputs: &Inputs, filters: &Filters) -> Briefing {
    let now_ms = inputs.now_ms;
    let model_filter = filters.model.as_ref().map(|m| m.trim().to_ascii_lowercase()).filter(|m| !m.is_empty());
    let provider_filter = filters.provider.as_ref().map(|p| super::refresh::normalize_provider(p)).filter(|p| !p.is_empty());

    // Accounts: the core's list is authoritative when present; quota-only accounts fill in when it is not.
    let core_accounts: &[CoreAccount] = inputs.core.map(|c| c.accounts.as_slice()).unwrap_or(&[]);
    let quota_accounts: &[QuotaAccount] = inputs.quota.map(|q| q.accounts.as_slice()).unwrap_or(&[]);
    let mut per_provider: std::collections::BTreeMap<String, Vec<Acct>> = Default::default();
    if core_accounts.is_empty() && !inputs.core.is_some_and(|core| core.up) {
        for (n, quota) in quota_accounts.iter().enumerate() {
            let acct = classify(None, Some(quota), n, now_ms);
            per_provider.entry(quota.provider.clone()).or_default().push(acct);
        }
    } else {
        for core in core_accounts {
            let quota = quota_accounts.iter().find(|q| q.auth_index == core.auth_index);
            let list = per_provider.entry(core.provider.clone()).or_default();
            let n = list.len();
            list.push(classify(Some(core), quota, n, now_ms));
        }
    }

    let mut ids: Vec<String> = per_provider.keys().cloned().collect();
    ids.sort_by_key(|id| provider_rank(id));
    let mut providers = Vec::new();
    let mut displayed_quota_indices = BTreeSet::new();
    for id in ids {
        if provider_filter.as_ref().is_some_and(|p| *p != id) {
            continue;
        }
        let accounts = &per_provider[&id];
        let enabled: Vec<&Acct> = accounts.iter().filter(|a| a.status != Status::Off).collect();
        let usable: Vec<&Acct> = enabled.iter().copied().filter(|a| a.status == Status::Ok).collect();
        let headroom_account = usable.iter().copied().filter(|a| bottleneck(a).is_some())
            .max_by(|a, b| bottleneck(a).unwrap().partial_cmp(&bottleneck(b).unwrap()).unwrap_or(std::cmp::Ordering::Equal));
        let headroom = headroom_account.and_then(bottleneck);
        let back_ms = if usable.is_empty() { enabled.iter().filter_map(|a| a.back_ms).min() } else { None };
        let status = if enabled.is_empty() {
            Status::Off
        } else if usable.is_empty() {
            if enabled.iter().any(|a| a.status == Status::Out) {
                Status::Out
            } else if enabled.iter().any(|a| a.status == Status::Cool) {
                Status::Cool
            } else {
                Status::Err
            }
        } else if headroom.is_some_and(|h| h < LOW_PCT) {
            Status::Low
        } else {
            Status::Ok
        };
        let selected_account = headroom_account.or_else(|| enabled.iter().copied().min_by_key(|a| a.back_ms.unwrap_or(i64::MAX)));
        let windows = selected_account.map(|a| {
            let mut views: Vec<_> = primary(a).cloned().collect();
            if views.is_empty() {
                if let Some(view) = a.windows.iter().min_by_key(|view| view.pct) {
                    views.push(WindowView { label: "lim", ..view.clone() });
                }
            }
            views
        }).unwrap_or_default();
        let balance = selected_account.and_then(balance_of);

        // Models: exact per-credential lists. A model is "ok" when an account that can route now serves it
        // without a model cooldown, otherwise it "cools" until the first serving account recovers.
        let mut model_ids: BTreeSet<String> = BTreeSet::new();
        for acct in enabled.iter() {
            if let Some(core) = acct.core {
                model_ids.extend(core.models.iter().cloned());
            }
        }
        let mut models_ok = Vec::new();
        let mut models_cool = Vec::new();
        for model in model_ids.iter().filter(|m| matches_model(m, &model_filter)) {
            let lower = model.to_ascii_lowercase();
            let serving: Vec<&&Acct> = enabled.iter().filter(|a| a.core.is_some_and(|c| c.models.contains(model))).collect();
            let mut free = false;
            let mut back: Option<i64> = None;
            for acct in serving {
                let core = acct.core.expect("serving accounts have core data");
                let cooling = active_model_cooldown(core, &lower, now_ms).map(|retry| retry - now_ms);
                match (acct.status, cooling) {
                    (Status::Ok, None) => free = true,
                    (Status::Ok, Some(wait)) => back = Some(back.map_or(wait, |b| b.min(wait))),
                    (Status::Cool | Status::Out, _) => {
                        if let Some(wait) = acct.back_ms {
                            back = Some(back.map_or(wait, |b| b.min(wait)));
                        }
                    }
                    _ => {}
                }
            }
            if free {
                models_ok.push(model.clone());
            } else if let Some(wait) = back {
                models_cool.push((model.clone(), wait));
            }
        }
        models_ok.sort_by_key(|model| natural_key(model));
        models_cool.sort_by_key(|(model, _)| natural_key(model));
        if usable.is_empty() && model_filter.is_none() {
            // The provider line already says nothing is usable and when it returns; naming every model adds noise.
            models_cool.clear();
        }
        if model_filter.is_some() && models_ok.is_empty() && models_cool.is_empty() {
            continue;
        }
        displayed_quota_indices.extend(accounts.iter().filter_map(|a| a.quota.map(|q| q.auth_index.as_str())));
        if inputs.core.is_some_and(|core| !core.up || !super::refresh::is_fresh(core, now_ms)) {
            // Nothing routes while the core is unreachable, so the cached model list would mislead.
            models_ok.clear();
            models_cool.clear();
        }

        let account_views = if filters.accounts {
            accounts
                .iter()
                .map(|a| AccountView {
                    label: a.label.clone(),
                    status: a.status,
                    back_ms: a.back_ms,
                    plan: a.quota.map(|q| q.plan.clone()).unwrap_or_default(),
                    balance: balance_of(a),
                    windows: a.windows.clone(),
                })
                .collect()
        } else {
            Vec::new()
        };
        providers.push(ProviderView {
            id,
            status,
            usable: usable.len(),
            total: enabled.len(),
            back_ms,
            no_quota: !usable.is_empty() && windows.is_empty(),
            windows,
            balance,
            models_ok,
            models_cool,
            headroom,
            accounts: account_views,
        });
    }

    // Quota age covers only the accounts visible after the active filters.
    let quota_age_ms = inputs.quota.filter(|q| q.accounts.iter().any(|a| displayed_quota_indices.contains(a.auth_index.as_str()))).map(|q| {
        let oldest = q.accounts.iter().filter(|a| displayed_quota_indices.contains(a.auth_index.as_str())).filter_map(|a| a.fetched_at_ms).min().unwrap_or(q.published_at_ms);
        (now_ms - oldest).max(0)
    });
    let (core_state, core_age_ms, core_error) = match inputs.core {
        None => ("unknown", None, String::new()),
        Some(core) if core.up && super::refresh::is_fresh(core, now_ms) => ("up", Some((now_ms - core.checked_at_ms).max(0)), String::new()),
        Some(core) if !core.up && super::refresh::is_fresh(core, now_ms) && (core.error.contains("connect") || core.error.contains("timed out")) => ("down", (core.ok_at_ms > 0).then(|| (now_ms - core.ok_at_ms).max(0)), "core unreachable".to_string()),
        Some(core) => ("stale", (core.ok_at_ms > 0).then(|| (now_ms - core.ok_at_ms).max(0)), String::new()),
    };
    let guide = if core_state == "down" {
        Some("guide: core unreachable, nothing routes now; numbers are cached".to_string())
    } else if core_state == "stale" {
        Some("guide: core state is stale; routing is unknown".to_string())
    } else {
        guide_line(&providers)
    };
    Briefing {
        mode: inputs.mode.to_string(),
        core_state,
        core_age_ms,
        core_error,
        quota_stale: quota_age_ms.is_some_and(|age| age > STALE_AFTER_MS),
        quota_age_ms,
        providers,
        guide,
        model_filter,
        provider_filter,
    }
}

fn window_text(view: &WindowView) -> String {
    if view.reset_passed {
        return format!("{}=reset", view.label);
    }
    let pct = if view.pct == 0 { "<1%".to_string() } else { format!("{}%", view.pct) };
    match view.reset_in_ms {
        Some(ms) => format!("{}={pct}~{}", view.label, format_duration(ms)),
        None => format!("{}={pct}", view.label),
    }
}

/// `swarm=` providers with plenty of headroom, `light=` those running low (with their tightest
/// window), `wait=` unavailable ones that recover soon, `avoid=` the rest. Numbers only.
fn guide_line(providers: &[ProviderView]) -> Option<String> {
    let (mut swarm, mut light, mut wait, mut avoid) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for provider in providers {
        match provider.status {
            Status::Off => {}
            Status::Out | Status::Cool | Status::Err => match provider.back_ms {
                Some(ms) if ms <= SOON_MS => wait.push(format!("{}~{}", provider.id, format_duration(ms))),
                _ => avoid.push(provider.id.clone()),
            },
            Status::Ok | Status::Low => {
                let Some(headroom) = provider.headroom else { continue };
                if provider.status == Status::Ok && headroom >= HIGH_PCT {
                    swarm.push(provider.id.clone());
                } else {
                    let tight = provider.windows.iter().min_by_key(|w| w.pct);
                    let detail = tight.map(|w| format!("({})", window_text(w))).unwrap_or_default();
                    light.push(format!("{}{detail}", provider.id));
                }
            }
        }
    }
    let mut parts = Vec::new();
    for (name, list) in [("swarm", swarm), ("light", light), ("wait", wait), ("avoid", avoid)] {
        if !list.is_empty() {
            parts.push(format!("{name}={}", list.join(",")));
        }
    }
    (!parts.is_empty()).then(|| format!("guide: {}", parts.join(" ")))
}

fn account_text(account: &AccountView) -> String {
    let mut parts = vec![format!("  {} {}", account.label, account.status.word())];
    if let Some(ms) = account.back_ms {
        parts.push(format!("back={}", format_duration(ms)));
    } else if account.status == Status::Out {
        parts.push("back=?".to_string());
    }
    for view in &account.windows {
        let text = window_text(view);
        parts.push(if view.group.is_empty() { text } else { format!("{}:{text}", view.group) });
    }
    if !account.plan.is_empty() {
        parts.push(format!("plan={}", account.plan));
    }
    if let Some(balance) = &account.balance {
        parts.push(format!("bal={balance}"));
    }
    parts.join(" ")
}

pub(crate) fn text(briefing: &Briefing) -> String {
    let mut out = String::new();
    let mut header = format!("cpa {}", briefing.mode);
    match (briefing.core_state, briefing.core_age_ms) {
        ("down", Some(age)) => header.push_str(&format!(" core=down cached={}", format_duration(age))),
        ("stale", Some(age)) => header.push_str(&format!(" core=stale cached={}", format_duration(age))),
        (state, _) => header.push_str(&format!(" core={state}")),
    }
    match briefing.quota_age_ms {
        Some(age) => {
            header.push_str(&format!(" quota_age={}", format_duration(age)));
            if briefing.quota_stale {
                header.push_str(" stale");
            }
        }
        None => header.push_str(" quota=none"),
    }
    out.push_str(&header);
    out.push('\n');
    if briefing.core_state == "down" && !briefing.core_error.is_empty() {
        out.push_str("core error: core unreachable\n");
    }
    for provider in &briefing.providers {
        let mut line = format!("{} {} {}/{}", provider.id, provider.status.word(), provider.usable, provider.total);
        if let Some(ms) = provider.back_ms {
            line.push_str(&format!(" back={}", format_duration(ms)));
        } else if provider.status == Status::Out {
            line.push_str(" back=?");
        }
        for view in &provider.windows {
            line.push(' ');
            line.push_str(&window_text(view));
        }
        if let Some(balance) = &provider.balance {
            line.push_str(&format!(" bal={balance}"));
        }
        if provider.no_quota {
            line.push_str(" quota=n/a");
        }
        let capped = briefing.model_filter.is_none();
        let shown: Vec<&String> = if capped {
            featured(&provider.models_ok, TEXT_MODEL_CAP)
        } else {
            provider.models_ok.iter().collect()
        };
        let hidden = provider.models_ok.len() - shown.len();
        let mut models: Vec<String> = shown.iter().map(|m| m.to_string()).collect();
        if hidden > 0 {
            models.push(format!("+{hidden}"));
        }
        for (model, wait) in provider.models_cool.iter().take(if capped { TEXT_COOL_CAP } else { usize::MAX }) {
            models.push(format!("cool:{model}~{}", format_duration(*wait)));
        }
        if provider.models_cool.len() > TEXT_COOL_CAP && capped {
            models.push(format!("+{}cool", provider.models_cool.len() - TEXT_COOL_CAP));
        }
        if !models.is_empty() {
            line.push_str(" | ");
            line.push_str(&models.join(" "));
        }
        out.push_str(&line);
        out.push('\n');
        for account in &provider.accounts {
            out.push_str(&account_text(account));
            out.push('\n');
        }
    }
    if briefing.providers.is_empty() {
        match (&briefing.provider_filter, &briefing.model_filter) {
            (_, Some(model)) => out.push_str(&format!("no provider serves a model matching \"{model}\"\n")),
            (Some(provider), None) => out.push_str(&format!("no accounts for provider \"{provider}\"\n")),
            _ => out.push_str("no accounts known yet\n"),
        }
    }
    if let Some(guide) = &briefing.guide {
        out.push_str(guide);
        out.push('\n');
    }
    out
}

fn window_json(view: &WindowView) -> Value {
    let mut value = json!({ "window": view.label, "pct": view.pct });
    if !view.group.is_empty() {
        value["group"] = json!(view.group);
    }
    if view.reset_passed {
        value["resetPassed"] = json!(true);
    }
    if let Some(ms) = view.reset_in_ms {
        value["resetInS"] = json!(ms / 1000);
    }
    value
}

pub(crate) fn json(briefing: &Briefing) -> Value {
    let providers: Vec<Value> = briefing
        .providers
        .iter()
        .map(|p| {
            let mut value = json!({
                "id": p.id,
                "status": p.status.word(),
                "usable": p.usable,
                "accounts": p.total,
                "windows": p.windows.iter().map(window_json).collect::<Vec<_>>(),
                "models": p.models_ok,
                "modelsCooling": p.models_cool.iter().map(|(id, ms)| json!({ "id": id, "backInS": ms / 1000 })).collect::<Vec<_>>(),
            });
            if let Some(ms) = p.back_ms {
                value["backInS"] = json!(ms / 1000);
            }
            if let Some(balance) = &p.balance {
                value["balance"] = json!(balance);
            }
            if p.no_quota {
                value["quota"] = json!("n/a");
            }
            if !p.accounts.is_empty() {
                value["accountList"] = json!(p
                    .accounts
                    .iter()
                    .map(|a| {
                        let mut account = json!({
                            "label": a.label,
                            "status": a.status.word(),
                            "windows": a.windows.iter().map(window_json).collect::<Vec<_>>(),
                        });
                        if let Some(ms) = a.back_ms {
                            account["backInS"] = json!(ms / 1000);
                        }
                        if !a.plan.is_empty() {
                            account["plan"] = json!(a.plan);
                        }
                        if let Some(balance) = &a.balance {
                            account["balance"] = json!(balance);
                        }
                        account
                    })
                    .collect::<Vec<_>>());
            }
            value
        })
        .collect();
    let mut value = json!({
        "mode": briefing.mode,
        "core": { "state": briefing.core_state },
        "quota": { "stale": briefing.quota_stale },
        "providers": providers,
    });
    if let Some(ms) = briefing.core_age_ms {
        value["core"]["ageS"] = json!(ms / 1000);
    }
    if !briefing.core_error.is_empty() {
        value["core"]["error"] = json!(briefing.core_error);
    }
    if let Some(ms) = briefing.quota_age_ms {
        value["quota"]["ageS"] = json!(ms / 1000);
    } else {
        value["quota"]["state"] = json!("none");
    }
    if let Some(guide) = &briefing.guide {
        value["guide"] = json!(guide.trim_start_matches("guide: "));
    }
    value
}
