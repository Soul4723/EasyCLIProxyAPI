//! Turns the two cache parts into the briefing. Pure: the caller passes `now`, so every relative
//! time ("resets in 1h12m") is computed at read time from absolute timestamps in the cache.
use super::model::{CoreAccount, CorePart, QuotaAccount, QuotaPart, QuotaWindow, QUOTA_PROVIDERS};
use super::refresh::{is_fresh, normalize_provider};
use serde_json::{json, Value};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

/// Quota data older than this is flagged stale (same limit the Quota page draws stripes at).
pub(crate) const STALE_AFTER_MS: i64 = 30 * 60_000;
/// Guidance thresholds, derived from the numbers only (documented in `skills/cpa-brief/SKILL.md`):
/// a provider whose best account has at least `HIGH_PCT` left on its tightest window is "swarm"
/// material, below `LOW_PCT` it is "low", below `EXHAUSTED_PCT` a window is used up; an unavailable
/// provider that recovers within `SOON_MS` is worth waiting for.
pub(crate) const HIGH_PCT: f64 = 50.0;
pub(crate) const LOW_PCT: f64 = 20.0;
const EXHAUSTED_PCT: f64 = 0.5;
pub(crate) const SOON_MS: i64 = 30 * 60_000;
/// Models (and cooling models) listed per provider in the default text; `--model` and `--json` list all.
const TEXT_CAP: usize = 4;

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
    label: &'static str,
    group: String,
    /// Exact remaining percentage; thresholds use this, the text floors it.
    pct: f64,
    /// Milliseconds until reset; None when the window is full or the reset is unknown.
    reset_in_ms: Option<i64>,
    /// The reset time passed since the quota was read: shown as `reset`.
    reset_passed: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct AccountView {
    label: String,
    status: Status,
    back_ms: Option<i64>,
    plan: String,
    balance: Option<String>,
    windows: Vec<WindowView>,
}

#[derive(Clone, Debug)]
pub(crate) struct ProviderView {
    id: String,
    status: Status,
    usable: usize,
    total: usize,
    back_ms: Option<i64>,
    windows: Vec<WindowView>,
    balance: Option<String>,
    /// Usable accounts exist but none has quota data.
    no_quota: bool,
    models_ok: Vec<String>,
    models_cool: Vec<(String, i64)>,
    /// Best single-account bottleneck, the number the guidance line is based on.
    headroom: Option<f64>,
    accounts: Vec<AccountView>,
}

#[derive(Clone, Debug)]
pub(crate) struct Briefing {
    mode: String,
    /// `up`, `down`, `stale` or `unknown`.
    core_state: &'static str,
    core_age_ms: Option<i64>,
    quota_age_ms: Option<i64>,
    providers: Vec<ProviderView>,
    guide: Option<String>,
    model_filter: Option<String>,
    provider_filter: Option<String>,
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

fn window_view(window: &QuotaWindow, now_ms: i64) -> Option<WindowView> {
    let pct = window.remaining_percent.or(window.available.then_some(100.0))?;
    let reset_in_ms = window.reset_at_ms.map(|reset| reset - now_ms);
    // The window reset after the quota was read; what was used since is unknown, so count it as full.
    let reset_passed = reset_in_ms.is_some_and(|ms| ms <= 0);
    let pct = if reset_passed { 100.0 } else { pct };
    Some(WindowView {
        label: match window.kind.as_str() {
            "5h" => "5h",
            "weekly" => "wk",
            _ => "lim",
        },
        group: window.group.clone(),
        pct,
        reset_in_ms: reset_in_ms.filter(|_| pct < 100.0),
        reset_passed,
    })
}

struct Acct<'a> {
    view: AccountView,
    core: Option<&'a CoreAccount>,
    quota: Option<&'a QuotaAccount>,
}

impl Acct<'_> {
    /// The account's own windows; model-group windows block only their models.
    fn primary(&self) -> impl Iterator<Item = &WindowView> {
        self.view.windows.iter().filter(|view| view.group.is_empty())
    }

    fn bottleneck(&self) -> Option<f64> {
        self.primary().map(|view| view.pct).reduce(f64::min)
    }
}

fn classify<'a>(core: Option<&'a CoreAccount>, quota: Option<&'a QuotaAccount>, index: usize, now_ms: i64) -> Acct<'a> {
    let windows: Vec<WindowView> =
        quota.map(|q| q.windows.iter().filter_map(|w| window_view(w, now_ms)).collect()).unwrap_or_default();
    let exhausted: Vec<&WindowView> = windows.iter().filter(|v| v.group.is_empty() && v.pct < EXHAUSTED_PCT).collect();
    let mut cool_until = None;
    let mut errored = false;
    if let Some(core) = core {
        cool_until = core
            .cooldowns
            .iter()
            .filter(|c| c.scope == "credential" && c.retry_at_ms > now_ms)
            .map(|c| c.retry_at_ms - now_ms)
            .max();
        if core.unavailable {
            match core.retry_at_ms {
                Some(retry) if retry > now_ms => cool_until = cool_until.max(Some(retry - now_ms)),
                // The retry time passed: the cached `unavailable` no longer blocks.
                Some(_) => {}
                None => errored = cool_until.is_none(),
            }
        }
    }
    let (status, back_ms) = if core.is_some_and(|c| c.disabled) || quota.is_some_and(|q| q.disabled) {
        (Status::Off, None)
    } else if errored {
        (Status::Err, None)
    } else if !exhausted.is_empty() {
        (Status::Out, cool_until.max(exhausted.iter().filter_map(|v| v.reset_in_ms).max()))
    } else if cool_until.is_some() {
        (Status::Cool, cool_until)
    } else {
        (Status::Ok, None)
    };
    let view = AccountView {
        label: quota.map(|q| q.label.clone()).filter(|l| !l.is_empty()).unwrap_or_else(|| format!("acct{}", index + 1)),
        status,
        back_ms,
        plan: quota.map(|q| q.plan.clone()).unwrap_or_default(),
        balance: quota.and_then(|q| if q.credits_unlimited { Some("unlimited".to_string()) } else { q.credit_balance.clone() }),
        windows,
    };
    Acct { view, core, quota }
}

/// Version numbers and date stamps (6+ digits) in a model id, compared to find the newest.
fn version(id: &str) -> (Vec<u64>, Vec<u64>) {
    let (mut versions, mut dates) = (Vec::new(), Vec::new());
    for token in id.split(|c: char| !c.is_ascii_digit()).filter(|t| !t.is_empty()) {
        let value = token.parse().unwrap_or(u64::MAX);
        if token.len() >= 6 { dates.push(value) } else { versions.push(value) }
    }
    (versions, dates)
}

/// A model family is its id without version and date tokens: `claude-sonnet-5-5` and
/// `claude-3-7-sonnet-20250219` are both `claude-sonnet`, while `gpt-6-luna` and `gpt-6-sol` stay apart.
fn family(id: &str) -> String {
    let words: Vec<&str> = id.split('-').filter(|t| !t.chars().all(|c| c.is_ascii_digit() || c == '.')).collect();
    if words.is_empty() { id.to_string() } else { words.join("-") }
}

/// Image-generation models are never what a coding agent delegates to; `--model image` still lists them.
fn is_image(id: &str) -> bool {
    id.to_ascii_lowercase().contains("image")
}

/// The default text shows the newest model of each family, newest versions first.
fn featured(models: &[String]) -> Vec<&String> {
    let mut newest: BTreeMap<String, &String> = BTreeMap::new();
    for model in models.iter().filter(|m| !is_image(m)) {
        let slot = newest.entry(family(model)).or_insert(model);
        if version(model) > version(slot) {
            *slot = model;
        }
    }
    let mut featured: Vec<&String> = newest.into_values().collect();
    featured.sort_by_key(|m| Reverse(version(m).0));
    featured.truncate(TEXT_CAP);
    featured
}

/// A model is ok when an account that can route now serves it without a model cooldown; otherwise
/// it cools until the first serving account recovers. Both lists are by family, oldest first.
fn routable_models(enabled: &[&Acct], filter: Option<&str>, now_ms: i64) -> (Vec<String>, Vec<(String, i64)>) {
    let ids: BTreeSet<&String> = enabled
        .iter()
        .filter_map(|a| a.core)
        .flat_map(|c| &c.models)
        .filter(|m| filter.is_none_or(|f| m.to_ascii_lowercase().contains(f)))
        .collect();
    let (mut ok, mut cool) = (Vec::new(), Vec::new());
    for model in ids {
        let lower = model.to_ascii_lowercase();
        let mut free = false;
        let mut back: Option<i64> = None;
        for acct in enabled {
            let Some(core) = acct.core.filter(|c| c.models.contains(model)) else { continue };
            let wait = match acct.view.status {
                Status::Ok => core
                    .cooldowns
                    .iter()
                    .filter(|c| c.scope == "model" && c.model == lower && c.retry_at_ms > now_ms)
                    .map(|c| c.retry_at_ms - now_ms)
                    .max(),
                Status::Cool | Status::Out => acct.view.back_ms,
                _ => continue,
            };
            if acct.view.status == Status::Ok && wait.is_none() {
                free = true;
                break;
            }
            if let Some(wait) = wait {
                back = Some(back.map_or(wait, |b| b.min(wait)));
            }
        }
        if free {
            ok.push(model.clone());
        } else if let Some(wait) = back {
            cool.push((model.clone(), wait));
        }
    }
    ok.sort_by_key(|m| (family(m), version(m)));
    cool.sort_by_key(|(m, _)| (family(m), version(m)));
    (ok, cool)
}

pub(crate) fn build(inputs: &Inputs, filters: &Filters) -> Briefing {
    let now_ms = inputs.now_ms;
    let model_filter = filters.model.as_ref().map(|m| m.trim().to_ascii_lowercase()).filter(|m| !m.is_empty());
    let provider_filter = filters.provider.as_deref().map(normalize_provider).filter(|p| !p.is_empty());
    let (core_state, core_age_ms) = match inputs.core {
        None => ("unknown", None),
        Some(core) if core.up && is_fresh(core, now_ms) => ("up", Some((now_ms - core.checked_at_ms).max(0))),
        Some(core) => {
            // Only a core that cannot be reached is down; other failures (a rejected key, an HTTP error)
            // and old data leave routing unknown.
            let unreachable = core.error.contains("connect") || core.error.contains("timed out");
            let state = if !core.up && is_fresh(core, now_ms) && unreachable { "down" } else { "stale" };
            (state, (core.ok_at_ms > 0).then(|| (now_ms - core.ok_at_ms).max(0)))
        }
    };

    // Accounts by provider, in display order. The core's list is authoritative once it has answered;
    // until then the quota-only accounts are shown.
    let quota_accounts: &[QuotaAccount] = inputs.quota.map(|q| q.accounts.as_slice()).unwrap_or(&[]);
    let pairs: Vec<(&str, Option<&CoreAccount>, Option<&QuotaAccount>)> =
        match inputs.core.filter(|core| core.up || !core.accounts.is_empty()) {
            Some(core) => core
                .accounts
                .iter()
                .map(|c| (c.provider.as_str(), Some(c), quota_accounts.iter().find(|q| q.auth_index == c.auth_index)))
                .collect(),
            None => quota_accounts.iter().map(|q| (q.provider.as_str(), None, Some(q))).collect(),
        };
    let mut per_provider: BTreeMap<(usize, &str), Vec<Acct>> = BTreeMap::new();
    for (provider, core, quota) in pairs {
        let rank = QUOTA_PROVIDERS.iter().position(|p| *p == provider).unwrap_or(QUOTA_PROVIDERS.len());
        let list = per_provider.entry((rank, provider)).or_default();
        list.push(classify(core, quota, list.len(), now_ms));
    }

    let mut providers = Vec::new();
    let mut quota_read_at = Vec::new();
    for ((_, id), accounts) in &per_provider {
        if provider_filter.as_deref().is_some_and(|p| p != *id) {
            continue;
        }
        let enabled: Vec<&Acct> = accounts.iter().filter(|a| a.view.status != Status::Off).collect();
        let usable: Vec<&Acct> = enabled.iter().copied().filter(|a| a.view.status == Status::Ok).collect();
        let best = usable.iter().filter_map(|a| Some((*a, a.bottleneck()?))).max_by(|x, y| x.1.total_cmp(&y.1));
        let headroom = best.map(|(_, pct)| pct);
        let status = if enabled.is_empty() {
            Status::Off
        } else if usable.is_empty() {
            [Status::Out, Status::Cool].into_iter().find(|s| enabled.iter().any(|a| a.view.status == *s)).unwrap_or(Status::Err)
        } else if headroom.is_some_and(|h| h < LOW_PCT) {
            Status::Low
        } else {
            Status::Ok
        };
        let back_ms = if usable.is_empty() { enabled.iter().filter_map(|a| a.view.back_ms).min() } else { None };
        // The line shows the account the guide is based on: the best usable one, else the first to recover.
        let shown = best.map(|(a, _)| a).or_else(|| usable.first().copied()).or_else(|| {
            enabled.iter().copied().min_by_key(|a| a.view.back_ms.unwrap_or(i64::MAX))
        });
        let mut windows: Vec<WindowView> = shown.map(|a| a.primary().cloned().collect()).unwrap_or_default();
        if windows.is_empty() {
            // Only special pools (no own 5h/weekly window): show the tightest as `lim`.
            if let Some(view) = shown.and_then(|a| a.view.windows.iter().min_by(|x, y| x.pct.total_cmp(&y.pct))) {
                windows.push(WindowView { label: "lim", ..view.clone() });
            }
        }

        let (mut models_ok, mut models_cool) = routable_models(&enabled, model_filter.as_deref(), now_ms);
        if model_filter.is_some() && models_ok.is_empty() && models_cool.is_empty() {
            continue;
        }
        if core_state != "up" {
            // Nothing routes while the core is unreachable or unknown, so the cached model list would mislead.
            models_ok.clear();
            models_cool.clear();
        } else if usable.is_empty() && model_filter.is_none() {
            // The provider line already says nothing is usable and when it returns; naming every model adds noise.
            models_cool.clear();
        }
        let published_at = inputs.quota.map_or(0, |q| q.published_at_ms);
        quota_read_at.extend(accounts.iter().filter_map(|a| a.quota).map(|q| q.fetched_at_ms.unwrap_or(published_at)));
        providers.push(ProviderView {
            id: id.to_string(),
            status,
            usable: usable.len(),
            total: enabled.len(),
            back_ms,
            no_quota: !usable.is_empty() && windows.is_empty(),
            windows,
            balance: shown.and_then(|a| a.view.balance.clone()),
            models_ok,
            models_cool,
            headroom,
            accounts: if filters.accounts { accounts.iter().map(|a| a.view.clone()).collect() } else { Vec::new() },
        });
    }

    let guide = match core_state {
        "down" => Some("core unreachable, nothing routes now; numbers are cached".to_string()),
        "stale" => Some("core state is stale; routing is unknown".to_string()),
        _ => guide_line(&providers),
    };
    Briefing {
        mode: inputs.mode.to_string(),
        core_state,
        core_age_ms,
        // Quota age covers only the accounts visible after the active filters.
        quota_age_ms: quota_read_at.into_iter().min().map(|oldest| (now_ms - oldest).max(0)),
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
    let pct = if view.pct < 1.0 { "<1%".to_string() } else { format!("{}%", view.pct.floor() as i64) };
    match view.reset_in_ms {
        Some(ms) => format!("{}={pct}~{}", view.label, format_duration(ms)),
        None => format!("{}={pct}", view.label),
    }
}

fn back_text(status: Status, back_ms: Option<i64>) -> Option<String> {
    match back_ms {
        Some(ms) => Some(format!("back={}", format_duration(ms))),
        None => (status == Status::Out).then(|| "back=?".to_string()),
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
            Status::Ok | Status::Low => match provider.headroom {
                None => {}
                Some(headroom) if headroom >= HIGH_PCT => swarm.push(provider.id.clone()),
                Some(_) => {
                    let tight = provider.windows.iter().min_by(|a, b| a.pct.total_cmp(&b.pct));
                    light.push(format!("{}{}", provider.id, tight.map(|w| format!("({})", window_text(w))).unwrap_or_default()));
                }
            },
        }
    }
    let parts: Vec<String> = [("swarm", swarm), ("light", light), ("wait", wait), ("avoid", avoid)]
        .into_iter()
        .filter(|(_, list)| !list.is_empty())
        .map(|(name, list)| format!("{name}={}", list.join(",")))
        .collect();
    (!parts.is_empty()).then(|| parts.join(" "))
}

fn account_text(account: &AccountView) -> String {
    let mut parts = vec![format!("  {} {}", account.label, account.status.word())];
    parts.extend(back_text(account.status, account.back_ms));
    for view in &account.windows {
        let text = window_text(view);
        parts.push(if view.group.is_empty() { text } else { format!("{}:{text}", view.group) });
    }
    if !account.plan.is_empty() {
        parts.push(format!("plan={}", account.plan));
    }
    parts.extend(account.balance.as_ref().map(|balance| format!("bal={balance}")));
    parts.join(" ")
}

pub(crate) fn text(briefing: &Briefing) -> String {
    let mut header = vec![format!("cpa {}", briefing.mode)];
    match (briefing.core_state, briefing.core_age_ms) {
        (state @ ("down" | "stale"), Some(age)) => header.push(format!("core={state} cached={}", format_duration(age))),
        (state, _) => header.push(format!("core={state}")),
    }
    match briefing.quota_age_ms {
        Some(age) if age > STALE_AFTER_MS => header.push(format!("quota_age={} stale", format_duration(age))),
        Some(age) => header.push(format!("quota_age={}", format_duration(age))),
        None => header.push("quota=none".to_string()),
    }
    let mut lines = vec![header.join(" ")];
    for provider in &briefing.providers {
        let mut parts = vec![format!("{} {} {}/{}", provider.id, provider.status.word(), provider.usable, provider.total)];
        parts.extend(back_text(provider.status, provider.back_ms));
        parts.extend(provider.windows.iter().map(window_text));
        parts.extend(provider.balance.as_ref().map(|balance| format!("bal={balance}")));
        if provider.no_quota {
            parts.push("quota=n/a".to_string());
        }
        let capped = briefing.model_filter.is_none();
        let mut models: Vec<String> = if capped {
            let shown = featured(&provider.models_ok);
            let more = provider.models_ok.iter().filter(|m| !is_image(m)).count() - shown.len();
            shown.into_iter().cloned().chain((more > 0).then(|| format!("+{more}"))).collect()
        } else {
            provider.models_ok.clone()
        };
        let cool_cap = if capped { TEXT_CAP } else { usize::MAX };
        models.extend(provider.models_cool.iter().take(cool_cap).map(|(m, wait)| format!("cool:{m}~{}", format_duration(*wait))));
        if provider.models_cool.len() > cool_cap {
            models.push(format!("+{}cool", provider.models_cool.len() - cool_cap));
        }
        if !models.is_empty() {
            parts.push(format!("| {}", models.join(" ")));
        }
        lines.push(parts.join(" "));
        lines.extend(provider.accounts.iter().map(account_text));
    }
    if briefing.providers.is_empty() {
        lines.push(match (&briefing.provider_filter, &briefing.model_filter) {
            (_, Some(model)) => format!("no provider serves a model matching \"{model}\""),
            (Some(provider), None) => format!("no accounts for provider \"{provider}\""),
            _ => "no accounts known yet".to_string(),
        });
    }
    lines.extend(briefing.guide.as_ref().map(|guide| format!("guide: {guide}")));
    lines.join("\n") + "\n"
}

fn window_json(view: &WindowView) -> Value {
    let mut value = json!({ "window": view.label, "pct": view.pct.floor() as i64 });
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

/// Adds `backInS` and `balance` when known; shared by providers and accounts.
fn add_back_and_balance(value: &mut Value, back_ms: Option<i64>, balance: &Option<String>) {
    if let Some(ms) = back_ms {
        value["backInS"] = json!(ms / 1000);
    }
    if let Some(balance) = balance {
        value["balance"] = json!(balance);
    }
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
            add_back_and_balance(&mut value, p.back_ms, &p.balance);
            if p.no_quota {
                value["quota"] = json!("n/a");
            }
            if !p.accounts.is_empty() {
                let accounts: Vec<Value> = p
                    .accounts
                    .iter()
                    .map(|a| {
                        let mut account = json!({
                            "label": a.label,
                            "status": a.status.word(),
                            "windows": a.windows.iter().map(window_json).collect::<Vec<_>>(),
                        });
                        add_back_and_balance(&mut account, a.back_ms, &a.balance);
                        if !a.plan.is_empty() {
                            account["plan"] = json!(a.plan);
                        }
                        account
                    })
                    .collect();
                value["accountList"] = json!(accounts);
            }
            value
        })
        .collect();
    let mut value = json!({
        "mode": briefing.mode,
        "core": { "state": briefing.core_state },
        "quota": { "stale": briefing.quota_age_ms.is_some_and(|age| age > STALE_AFTER_MS) },
        "providers": providers,
    });
    if let Some(ms) = briefing.core_age_ms {
        value["core"]["ageS"] = json!(ms / 1000);
    }
    match briefing.quota_age_ms {
        Some(ms) => value["quota"]["ageS"] = json!(ms / 1000),
        None => value["quota"]["state"] = json!("none"),
    }
    if let Some(guide) = &briefing.guide {
        value["guide"] = json!(guide);
    }
    value
}
