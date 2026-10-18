//! Opt-in, credential-pinned window ignition. No credentials are persisted here.
use crate::{GuiConfigFile, GuiConfigState, CoreConnectionMode};
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::{Path, PathBuf}, sync::Mutex};
use tauri::{Emitter, Manager};

const HISTORY_LIMIT: usize = 200;
const RESET_GRACE_MS: i64 = 3_000;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Credential { provider: String, auth_file_name: String, auth_index: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveHours { start: String, end: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Retry { max_attempts: u32, interval_seconds: u32, backoff: f64, circuit_seconds: u32 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunResult { schedule_id: String, at: i64, ok: bool, http_status: Option<u16>, message: String, attempt: u32 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Schedule {
    id: String, credential: Credential, target: String, enabled: bool,
    mode: String, times: Vec<String>, weekdays: Vec<u32>, timezone: String,
    window_kind: String, model: Option<String>, active_hours: Option<ActiveHours>, retry: Retry,
    last_run: Option<RunResult>, next_run: Option<i64>, observed_reset: Option<i64>,
    consumed_reset: Option<i64>, attempt: u32, circuit_until: Option<i64>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Store { schedules: Vec<Schedule>, history: Vec<RunResult> }
struct Inner { store: Store, running: HashSet<String>, error: Option<String> }
pub(crate) struct Lighting { path: PathBuf, inner: Mutex<Inner> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capability { provider: String, supported: bool, default_model: Option<String>, allowed_windows: Vec<String>, reason: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status { running: bool, only_while_app_running: bool, current_target: String, running_ids: Vec<String>, error: Option<String> }

fn now() -> i64 { Utc::now().timestamp_millis() }
fn hash(value: &str) -> String { format!("{:x}", Sha256::digest(value.as_bytes())) }
// Include management authorization's fingerprint, never the secret itself. Switching
// accounts on the same remote origin must not rebind an existing schedule.
fn target(config: &GuiConfigFile) -> Result<String, String> {
    let endpoint = if config.connection_mode == CoreConnectionMode::Remote {
        crate::management_api::management_endpoint(config, "")?
    } else { format!("local:{}:{}:{}", config.host, config.port, config.auth_dir) };
    let key = if config.connection_mode == CoreConnectionMode::Remote { &config.remote_management_key } else { &config.management_secret_key };
    Ok(hash(&format!("{endpoint}\n{}", key.trim())))
}
fn schedule_id(s: &Schedule) -> String { hash(&serde_json::to_string(&(&s.target, &s.credential)).expect("serializable identity")) }
fn time(value: &str) -> Result<NaiveTime, String> {
    if value.len() != 5 || value.as_bytes()[2] != b':' { return Err("Use HH:MM times".into()); }
    NaiveTime::parse_from_str(value, "%H:%M").map_err(|_| "Use valid HH:MM times".into())
}
fn validate(s: &Schedule) -> Result<(), String> {
    if s.credential.provider.trim().is_empty() || s.credential.auth_file_name.trim().is_empty() || s.credential.auth_index.trim().is_empty() { return Err("Provider, auth filename and auth index are required".into()); }
    if s.credential.auth_file_name.len() > 512 || s.credential.auth_index.len() > 512 { return Err("Credential identity is too long".into()); }
    s.timezone.parse::<Tz>().map_err(|_| "Use an IANA timezone (for example Australia/Melbourne)")?;
    if !["5h", "weekly"].contains(&s.window_kind.as_str()) { return Err("Unsupported window kind".into()); }
    if !["schedule", "after_reset"].contains(&s.mode.as_str()) { return Err("Unsupported lighting mode".into()); }
    if s.weekdays.is_empty() || s.weekdays.iter().any(|d| !(1..=7).contains(d)) { return Err("Choose weekdays (Monday=1 to Sunday=7)".into()); }
    if s.times.len() > 24 || (s.mode == "schedule" && s.times.is_empty()) { return Err("Choose 1 to 24 daily times".into()); }
    for t in &s.times { time(t)?; }
    if let Some(hours) = &s.active_hours { if time(&hours.start)? == time(&hours.end)? { return Err("Active hours must differ (omit for all day)".into()); } }
    if s.retry.max_attempts == 0 || s.retry.max_attempts > 10 || !(1..=86400).contains(&s.retry.interval_seconds) || !s.retry.backoff.is_finite() || !(1.0..=10.0).contains(&s.retry.backoff) || !(60..=604800).contains(&s.retry.circuit_seconds) { return Err("Invalid retry policy".into()); }
    if s.model.as_ref().is_some_and(|v| v.len() > 200 || v.trim().is_empty() || v.chars().any(char::is_control)) { return Err("Invalid model".into()); }
    if s.enabled && !capability(&s.credential.provider).supported { return Err("Lighting is unsupported for this provider".into()); }
    Ok(())
}
fn capability(provider: &str) -> Capability {
    let model = match provider { "codex" => Some("gpt-5.5"), "claude" => Some("claude-haiku-4-5-20251001"), _ => None };
    Capability { provider: provider.into(), supported: model.is_some(), default_model: model.map(str::to_owned), allowed_windows: if model.is_some() { vec!["5h".into(), "weekly".into()] } else { vec![] }, reason: model.is_none().then(|| "Credential-pinned ignition has not been verified for this provider".into()) }
}
#[tauri::command]
pub(crate) fn lighting_capabilities() -> Vec<Capability> { ["codex", "claude", "antigravity", "gemini", "kimi", "xai", "devin"].into_iter().map(capability).collect() }

// DST policy: nonexistent wall times are skipped; repeated times use the first
// occurrence only. Calendar arithmetic, not 24-hour additions, preserves local time.
fn local_instant(tz: Tz, day: chrono::NaiveDate, t: NaiveTime) -> Option<i64> {
    match tz.from_local_datetime(&day.and_time(t)) { LocalResult::Single(dt) => Some(dt.timestamp_millis()), LocalResult::Ambiguous(a, b) => Some(a.min(b).timestamp_millis()), LocalResult::None => None }
}
fn allowed(s: &Schedule, at: i64) -> bool {
    let Ok(tz) = s.timezone.parse::<Tz>() else { return false; };
    let Some(dt) = DateTime::from_timestamp_millis(at).map(|v| v.with_timezone(&tz)) else { return false; };
    if !s.weekdays.contains(&dt.weekday().number_from_monday()) { return false; }
    let Some(hours) = &s.active_hours else { return true; };
    let (Ok(start), Ok(end)) = (time(&hours.start), time(&hours.end)) else { return false; };
    let t = dt.time();
    if start < end { t >= start && t < end } else { t >= start || t < end }
}
fn bound(s: &Schedule, at: i64) -> Option<i64> {
    if allowed(s, at) { return Some(at); }
    let tz = s.timezone.parse::<Tz>().ok()?;
    let day = DateTime::from_timestamp_millis(at)?.with_timezone(&tz).date_naive();
    let mut candidates = Vec::new();
    for offset in 0..=8 {
        let d = day.checked_add_signed(Duration::days(offset))?;
        // Midnight matters for overnight windows and weekday transitions.
        let mut starts = vec![NaiveTime::MIN];
        if let Some(h) = &s.active_hours { starts.push(time(&h.start).ok()?); }
        for start in starts {
            if let Some(candidate) = local_instant(tz, d, start) { if candidate >= at && allowed(s, candidate) { candidates.push(candidate); } }
        }
    }
    candidates.into_iter().min()
}
fn next_run(s: &Schedule, after: i64) -> Option<i64> {
    if !s.enabled || !capability(&s.credential.provider).supported { return None; }
    if s.mode == "after_reset" {
        let reset = s.observed_reset?;
        if s.consumed_reset.is_some_and(|v| reset <= v) { return None; }
        // Don't ignite a stale window after days offline. A fresh observation is needed.
        if after > reset.saturating_add(24 * 60 * 60 * 1000) { return None; }
        return bound(s, reset.saturating_add(RESET_GRACE_MS).max(after));
    }
    let tz = s.timezone.parse::<Tz>().ok()?;
    let day = DateTime::from_timestamp_millis(after)?.with_timezone(&tz).date_naive();
    let mut candidates = Vec::new();
    for offset in 0..=8 {
        let d = day.checked_add_signed(Duration::days(offset))?;
        for t in &s.times {
            if let Some(candidate) = local_instant(tz, d, time(t).ok()?) { if candidate > after && allowed(s, candidate) { candidates.push(candidate); } }
        }
    }
    candidates.into_iter().min()
}
fn finish(s: &mut Schedule, result: &RunResult) {
    s.last_run = Some(result.clone());
    if result.ok {
        s.attempt = 0; s.circuit_until = None; s.next_run = next_run(s, result.at);
    } else if result.attempt < s.retry.max_attempts {
        let delay = (s.retry.interval_seconds as f64 * s.retry.backoff.powi(result.attempt.saturating_sub(1) as i32)).min(86400.0) as i64 * 1000;
        s.next_run = s.enabled.then(|| bound(s, result.at + delay)).flatten();
    } else {
        let resume = result.at + i64::from(s.retry.circuit_seconds) * 1000;
        s.circuit_until = Some(resume); s.attempt = 0;
        s.next_run = if s.mode == "after_reset" { s.enabled.then(|| bound(s, resume)).flatten() } else { next_run(s, resume) };
    }
}
fn load(path: &Path) -> Result<Store, String> {
    match std::fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(_) => Err("Cannot read lighting storage; runner paused".into()),
        Ok(bytes) => {
            let store: Store = serde_json::from_slice(&bytes).map_err(|_| "Invalid lighting storage; runner paused")?;
            if store.schedules.len() > 1000 || store.history.len() > HISTORY_LIMIT { return Err("Lighting storage exceeds limits".into()); }
            for s in &store.schedules { validate(s)?; if s.id != schedule_id(s) { return Err("Lighting identity mismatch".into()); } }
            Ok(store)
        }
    }
}
impl Lighting {
    fn update<T>(&self, change: impl FnOnce(&mut Inner) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.inner.lock().map_err(|_| "Lighting lock poisoned")?;
        if let Some(error) = &guard.error { return Err(error.clone()); }
        let old = guard.store.clone();
        let old_running = guard.running.clone();
        let value = match change(&mut guard) { Ok(value) => value, Err(error) => { guard.store = old; guard.running = old_running; return Err(error); } };
        if let Err(error) = crate::write_bytes_atomically(&self.path, &serde_json::to_vec_pretty(&guard.store).map_err(|_| "Cannot encode lighting storage")?) {
            guard.store = old; guard.running = old_running; guard.error = Some("Cannot persist lighting state; runner paused".into()); return Err(error);
        }
        Ok(value)
    }
}
pub(crate) fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("lighting.json");
    let (store, error) = match load(&path) { Ok(mut s) => { // Never replay missed daily slots after restart.
        for rule in &mut s.schedules {
            let at = now();
            rule.next_run = if rule.attempt > 0 || rule.circuit_until.is_some_and(|v| v > at) {
                // A persisted retry resumes within the configured active hours.
                rule.next_run.and_then(|v| bound(rule, v.max(at)))
            } else { next_run(rule, at) };
        }
        (s, None)
    }, Err(e) => (Store::default(), Some(e)) };
    app.manage(Lighting { path, inner: Mutex::new(Inner { store, running: HashSet::new(), error }) });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let state = app.state::<Lighting>();
            let config = app.state::<GuiConfigState>();
            let Ok(current) = config.snapshot().and_then(|c| target(&c)) else { continue; };
            let ids = {
                let Ok(g) = state.inner.lock() else { continue; };
                if g.error.is_some() { continue; }
                g.store.schedules.iter().filter(|s| s.enabled && s.target == current && s.next_run.is_some_and(|v| v <= now()) && !g.running.contains(&s.id)).map(|s| s.id.clone()).collect::<Vec<_>>()
            };
            for id in ids {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { let _ = run(&app, &id, false).await; });
            }
        }
    });
    Ok(())
}
#[tauri::command]
pub(crate) fn lighting_list(state: tauri::State<'_, Lighting>) -> Result<Vec<Schedule>, String> { Ok(state.inner.lock().map_err(|_| "Lighting lock poisoned")?.store.schedules.clone()) }
#[tauri::command]
pub(crate) fn lighting_get(state: tauri::State<'_, Lighting>, id: String) -> Result<Option<Schedule>, String> { Ok(lighting_list(state)?.into_iter().find(|s| s.id == id)) }
#[tauri::command]
pub(crate) async fn lighting_save(state: tauri::State<'_, Lighting>, config: tauri::State<'_, GuiConfigState>, mut schedule: Schedule, expected_revision: u64) -> Result<Schedule, String> {
    let _fence = config.target_operation.lock().await;
    let cfg = config.snapshot()?;
    if cfg.target_revision != expected_revision || schedule.target != target(&cfg)? { return Err("Core connection changed; schedule not saved".into()); }
    validate(&schedule)?;
    schedule.id = schedule_id(&schedule);
    state.update(|g| {
        if g.running.contains(&schedule.id) { return Err("Lighting is running; try again after it completes".into()); }
        let previous = g.store.schedules.iter().find(|s| s.id == schedule.id);
        schedule.last_run = previous.and_then(|s| s.last_run.clone());
        schedule.observed_reset = previous.and_then(|s| s.observed_reset);
        schedule.consumed_reset = previous.and_then(|s| s.consumed_reset);
        schedule.attempt = 0; schedule.circuit_until = None;
        schedule.next_run = next_run(&schedule, now());
        g.store.schedules.retain(|s| s.id != schedule.id);
        if g.store.schedules.len() >= 1000 { return Err("Too many lighting schedules".into()); }
        g.store.schedules.push(schedule.clone()); Ok(schedule)
    })
}
#[tauri::command]
pub(crate) fn lighting_delete(state: tauri::State<'_, Lighting>, id: String) -> Result<(), String> {
    state.update(|g| { if g.running.contains(&id) { return Err("Lighting is running".into()); } g.store.schedules.retain(|s| s.id != id); Ok(()) })
}
#[tauri::command]
pub(crate) fn lighting_set_enabled(state: tauri::State<'_, Lighting>, id: String, enabled: bool) -> Result<Schedule, String> {
    state.update(|g| {
        if g.running.contains(&id) { return Err("Lighting is running".into()); }
        let s = g.store.schedules.iter_mut().find(|s| s.id == id).ok_or("Schedule not found")?;
        if enabled && !capability(&s.credential.provider).supported { return Err("Unsupported provider".into()); }
        s.enabled = enabled; s.attempt = 0; s.circuit_until = None; s.next_run = next_run(s, now()); Ok(s.clone())
    })
}
#[tauri::command]
pub(crate) async fn lighting_report_reset(state: tauri::State<'_, Lighting>, config: tauri::State<'_, GuiConfigState>, id: String, reset_at: i64, expected_revision: u64) -> Result<Schedule, String> {
    let _fence = config.target_operation.lock().await;
    let cfg = config.snapshot()?;
    if cfg.target_revision != expected_revision { return Err("Core connection changed; reset not recorded".into()); }
    let current = target(&cfg)?;
    if reset_at < now() - 86_400_000 || reset_at > now() + 32 * 86_400_000 { return Err("Reset observation outside supported range".into()); }
    state.update(|g| {
        let s = g.store.schedules.iter_mut().find(|s| s.id == id).ok_or("Schedule not found")?;
        if s.target != current { return Err("Reset belongs to a different connection".into()); }
        s.observed_reset = Some(reset_at);
        if s.attempt == 0 && s.circuit_until.is_none() && !g.running.contains(&id) { s.next_run = next_run(s, now()); }
        Ok(s.clone())
    })
}
#[tauri::command]
pub(crate) fn lighting_history(state: tauri::State<'_, Lighting>, id: Option<String>) -> Result<Vec<RunResult>, String> {
    Ok(state.inner.lock().map_err(|_| "Lighting lock poisoned")?.store.history.iter().rev().filter(|r| id.as_ref().is_none_or(|id| id == &r.schedule_id)).cloned().collect())
}
#[tauri::command]
pub(crate) fn lighting_status(state: tauri::State<'_, Lighting>, config: tauri::State<'_, GuiConfigState>) -> Result<Status, String> {
    let g = state.inner.lock().map_err(|_| "Lighting lock poisoned")?;
    Ok(Status { running: g.error.is_none(), only_while_app_running: true, current_target: target(&config.snapshot()?)?, running_ids: g.running.iter().cloned().collect(), error: g.error.clone() })
}
#[tauri::command]
pub(crate) async fn lighting_run_now(app: tauri::AppHandle, id: String) -> Result<RunResult, String> { run(&app, &id, true).await }

async fn run<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str, manual: bool) -> Result<RunResult, String> {
    let state = app.state::<Lighting>();
    let config = app.state::<GuiConfigState>();
    // Same fence used by target changes; pinned config stays valid through send.
    let _fence = config.target_operation.lock().await;
    let cfg = config.snapshot()?;
    let current = target(&cfg)?;
    if !manual {
        state.update(|g| {
            let s = g.store.schedules.iter_mut().find(|s| s.id == id).ok_or("Schedule not found")?;
            if s.target != current { return Err("Schedule belongs to another core connection".into()); }
            if let Some(due) = s.next_run {
                let at = now();
                if !allowed(s, at) { s.next_run = if s.mode == "schedule" && s.attempt == 0 { next_run(s, at) } else { bound(s, at) }; }
                if s.mode == "schedule" && s.attempt == 0 && due < at - 60_000 { s.next_run = next_run(s, at); }
                if s.mode == "after_reset" && s.attempt == 0 && s.observed_reset.is_some_and(|v| at > v + 86_400_000) { s.next_run = None; }
            }
            Ok(())
        })?;
    }
    let schedule = state.update(|g| {
        if g.running.contains(id) { return Err("Lighting already running for this credential".into()); }
        let s = g.store.schedules.iter_mut().find(|s| s.id == id).ok_or("Schedule not found")?;
        if s.target != current { return Err("Schedule belongs to another core connection".into()); }
        if !capability(&s.credential.provider).supported { return Err("Unsupported provider".into()); }
        if !manual && (!s.enabled || !s.next_run.is_some_and(|v| v <= now()) || s.circuit_until.is_some_and(|v| v > now())) { return Err("Schedule is not due".into()); }
        if manual { s.attempt = 0; s.circuit_until = None; }
        s.attempt += 1;
        // Persist consumed reset before HTTP; a process crash must not replay it.
        if s.mode == "after_reset" { s.consumed_reset = s.observed_reset; }
        s.next_run = None;
        g.running.insert(id.to_owned()); Ok(s.clone())
    })?;
    let outcome = ping(&cfg, &schedule).await;
    let result = match outcome {
        Ok((status, ok)) => RunResult { schedule_id: id.into(), at: now(), ok, http_status: Some(status), message: if ok { "Tiny request accepted; refresh quota to confirm window start" } else { "Provider rejected or did not complete the tiny request" }.into(), attempt: schedule.attempt },
        Err(_) => RunResult { schedule_id: id.into(), at: now(), ok: false, http_status: None, message: "Lighting request failed; check core connection and credential".into(), attempt: schedule.attempt },
    };
    let saved = state.update(|g| {
        g.running.remove(id);
        let s = g.store.schedules.iter_mut().find(|s| s.id == id).ok_or("Schedule not found")?;
        finish(s, &result);
        g.store.history.push(result.clone());
        if g.store.history.len() > HISTORY_LIMIT { g.store.history.remove(0); }
        Ok(())
    });
    // Even a persistence failure is observable; status exposes that the runner paused.
    let _ = app.emit("lighting-run-result", &result);
    saved?;
    Ok(result)
}

async fn management(config: &GuiConfigFile, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let client = crate::management_api::management_http_client_for(config)?;
    let mut req = client.request(method, crate::management_api::management_endpoint(config, path)?).header("Authorization", crate::management_api::management_authorization(config)?).timeout(std::time::Duration::from_secs(45));
    if let Some(body) = body { req = req.json(&body); }
    let res = req.send().await.map_err(|_| "Lighting transport failed")?;
    crate::management_api::read_management_value(res).await
}
fn index(value: &Value) -> Option<String> { match value { Value::String(v) => Some(v.trim().into()), Value::Number(n) => Some(n.to_string()), _ => None } }
fn matching_credential<'a>(files: &'a Value, credential: &Credential) -> Option<&'a Value> {
    files.get("files").or_else(|| files.get("credentials")).unwrap_or(files).as_array()?.iter().find(|f| {
        let provider = f.get("provider").or_else(|| f.get("type")).and_then(Value::as_str).unwrap_or("");
        let provider = if provider == "anthropic" { "claude" } else { provider };
        provider == credential.provider && f.get("name").and_then(Value::as_str) == Some(&credential.auth_file_name) && f.get("auth_index").or_else(|| f.get("authIndex")).and_then(index).as_deref() == Some(&credential.auth_index) && f.get("disabled").and_then(Value::as_bool) != Some(true)
    })
}
fn ping_payload(s: &Schedule, file: &Value) -> Result<Value, String> {
    let model = s.model.clone().or_else(|| capability(&s.credential.provider).default_model).ok_or("Unsupported provider")?;
    let (url, mut header, body) = match s.credential.provider.as_str() {
        "claude" => ("https://api.anthropic.com/v1/messages?beta=true", json!({"Authorization":"Bearer $TOKEN$", "Content-Type":"application/json", "anthropic-version":"2023-06-01", "anthropic-beta":"claude-code-20250219,oauth-2025-04-20", "x-app":"cli", "User-Agent":"claude-cli/2.1.7 (external, cli)"}), json!({"model":model,"max_tokens":1,"system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}],"messages":[{"role":"user","content":"hi"}]})),
        "codex" => ("https://chatgpt.com/backend-api/codex/responses", json!({"Authorization":"Bearer $TOKEN$", "Content-Type":"application/json", "Accept":"text/event-stream", "originator":"codex_cli_rs", "User-Agent":"codex-tui/0.149.1"}), json!({"model":model,"instructions":"Reply with OK.","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"reasoning":{"effort":"none"},"store":false,"stream":true})),
        _ => return Err("Unsupported provider".into()),
    };
    if s.credential.provider == "codex" {
        for candidate in [file.get("account_id"), file.pointer("/metadata/account_id"), file.pointer("/attributes/account_id"), file.pointer("/id_token/chatgpt_account_id")] {
            if let Some(account) = candidate.and_then(Value::as_str).filter(|v| !v.is_empty()) { header["ChatGPT-Account-Id"] = json!(account); break; }
        }
    }
    Ok(json!({"authIndex":s.credential.auth_index,"method":"POST","url":url,"header":header,"data":body.to_string()}))
}
fn response_ok(provider: &str, response: &Value) -> (u16, bool) {
    let status = response.get("status_code").or_else(|| response.get("statusCode")).and_then(Value::as_u64).and_then(|v| u16::try_from(v).ok()).unwrap_or(0);
    let body = response.get("body").or_else(|| response.get("bodyText")).unwrap_or(&Value::Null);
    let ok = if provider == "codex" {
        body.as_str().is_some_and(|text| text.lines().filter_map(|line| line.strip_prefix("data:")).filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok()).any(|v| v["type"] == "response.completed" && v.pointer("/response/status").and_then(Value::as_str) == Some("completed")))
    } else {
        let parsed = body.as_str().and_then(|v| serde_json::from_str::<Value>(v).ok()).unwrap_or_else(|| body.clone());
        parsed["type"] == "message" && parsed.get("error").is_none()
    };
    (status, (200..300).contains(&status) && ok)
}
async fn ping(config: &GuiConfigFile, s: &Schedule) -> Result<(u16, bool), String> {
    // Re-resolve identity every run: an index alone may be recycled by the core.
    let files = management(config, reqwest::Method::GET, "credentials", None).await?;
    let file = matching_credential(&files, &s.credential).ok_or("Credential missing, disabled or changed")?;
    let payload = ping_payload(s, file)?;
    let response = management(config, reqwest::Method::POST, "requests/api-call", Some(payload)).await?;
    Ok(response_ok(&s.credential.provider, &response))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;
    fn rule(mode: &str) -> Schedule { Schedule { id:"x".into(), credential:Credential{provider:"codex".into(),auth_file_name:"a.json".into(),auth_index:"1".into()}, target:"t".into(), enabled:true, mode:mode.into(), times:vec!["09:00".into()], weekdays:(1..=5).collect(), timezone:"Australia/Melbourne".into(), window_kind:"5h".into(), model:None, active_hours:None, retry:Retry{max_attempts:3,interval_seconds:5,backoff:2.0,circuit_seconds:60}, last_run:None,next_run:None,observed_reset:None,consumed_reset:None,attempt:0,circuit_until:None } }
    #[test] fn schedule_skips_weekend() { let s=rule("schedule"); let fri=chrono_tz::Australia::Melbourne.with_ymd_and_hms(2026,10,23,10,0,0).unwrap().timestamp_millis(); let next=next_run(&s,fri).unwrap(); assert_eq!(DateTime::from_timestamp_millis(next).unwrap().with_timezone(&chrono_tz::Australia::Melbourne).weekday(), chrono::Weekday::Mon); }
    #[test] fn schedule_respects_dst_wall_time() { let s=rule("schedule"); let before=chrono_tz::Australia::Melbourne.with_ymd_and_hms(2026,10,3,23,0,0).unwrap().timestamp_millis(); let next=next_run(&s,before).unwrap(); let dt=DateTime::from_timestamp_millis(next).unwrap().with_timezone(&chrono_tz::Australia::Melbourne); assert_eq!((dt.hour(),dt.minute()),(9,0)); }
    #[test] fn after_reset_waits_for_observation_and_grace() { let mut s=rule("after_reset"); assert!(next_run(&s,now()).is_none()); let reset=chrono_tz::Australia::Melbourne.with_ymd_and_hms(2026,10,19,12,0,0).unwrap().timestamp_millis(); s.observed_reset=Some(reset); assert_eq!(next_run(&s,reset-1).unwrap(), reset+RESET_GRACE_MS); s.consumed_reset=Some(reset); assert!(next_run(&s,now()).is_none()); }
    #[test] fn active_hours_bound() { let mut s=rule("schedule"); s.active_hours=Some(ActiveHours{start:"07:00".into(),end:"22:00".into()}); let at=chrono_tz::Australia::Melbourne.with_ymd_and_hms(2026,10,20,23,0,0).unwrap().timestamp_millis(); let next=next_run(&s,at).unwrap(); let dt=DateTime::from_timestamp_millis(next).unwrap().with_timezone(&chrono_tz::Australia::Melbourne); assert_eq!(dt.hour(),9); }
    #[test] fn retry_backoff_then_circuit() { let mut s=rule("schedule"); let r=RunResult{schedule_id:"x".into(),at:now(),ok:false,http_status:Some(500),message:"x".into(),attempt:1}; finish(&mut s,&r); assert!(s.next_run.is_some()); let r2=RunResult{attempt:3,..r}; finish(&mut s,&r2); assert!(s.circuit_until.is_some()); }
    #[test] fn schedule_identity_is_stable() { let s=rule("schedule"); assert_eq!(schedule_id(&s),schedule_id(&s)); }
}
