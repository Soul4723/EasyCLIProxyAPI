use super::cli::{parse_args, Args};
use super::model::*;
use super::refresh::{self, is_fresh, parse_credentials, parse_models, CORE_FAILURE_TTL_MS, CORE_TTL_MS};
use super::render::{self, format_duration, Filters, Inputs};
use serde_json::json;
use std::ffi::OsString;

const NOW: i64 = 1_800_000_000_000;
const MIN: i64 = 60_000;
const HOUR: i64 = 60 * MIN;

fn window(kind: &str, pct: f64, reset_in: Option<i64>) -> QuotaWindow {
    QuotaWindow {
        kind: kind.into(),
        remaining_percent: Some(pct),
        reset_at_ms: reset_in.map(|ms| NOW + ms),
        ..Default::default()
    }
}

fn quota_account(index: &str, provider: &str, label: &str, windows: Vec<QuotaWindow>) -> QuotaAccount {
    QuotaAccount {
        auth_index: index.into(),
        provider: provider.into(),
        label: label.into(),
        fetched_at_ms: Some(NOW - 6 * MIN),
        windows,
        ..Default::default()
    }
}

fn core_account(index: &str, provider: &str, models: &[&str]) -> CoreAccount {
    CoreAccount {
        auth_index: index.into(),
        provider: provider.into(),
        models: models.iter().map(|m| m.to_string()).collect(),
        models_at_ms: NOW,
        ..Default::default()
    }
}

fn core(accounts: Vec<CoreAccount>) -> CorePart {
    CorePart { origin: "http://core.example.test".into(), checked_at_ms: NOW, ok_at_ms: NOW, up: true, accounts, ..Default::default() }
}

fn quota(accounts: Vec<QuotaAccount>) -> QuotaPart {
    QuotaPart { origin: "http://core.example.test".into(), published_at_ms: NOW - 6 * MIN, accounts }
}

/// claude: 2 accounts with room; codex: 5h nearly out with a reset in 22m; xai: one account with a balance.
fn fixture() -> (QuotaPart, CorePart) {
    let mut xai = quota_account("x1", "xai", "xa***@e***.com", vec![]);
    xai.credit_balance = Some("$12.40".into());
    let quota = quota(vec![
        quota_account("c1", "claude", "al***@e***.com", vec![window("5h", 62.0, Some(HOUR + 12 * MIN)), window("weekly", 81.0, Some(3 * 24 * HOUR + 4 * HOUR))]),
        quota_account("c2", "claude", "bo***@e***.com", vec![window("5h", 30.0, Some(2 * HOUR)), window("weekly", 70.0, Some(4 * 24 * HOUR))]),
        quota_account("g1", "codex", "ca***@e***.com", vec![window("5h", 8.0, Some(22 * MIN)), window("weekly", 40.0, Some(2 * 24 * HOUR))]),
        xai,
    ]);
    let core = core(vec![
        core_account("c1", "claude", &["opus-5-5", "sonnet-5-5", "haiku-5-5"]),
        core_account("c2", "claude", &["opus-5-5", "sonnet-5-5", "haiku-5-5"]),
        core_account("g1", "codex", &["gpt-6-luna", "gpt-6-sol"]),
        core_account("x1", "xai", &["grok-4.7"]),
    ]);
    (quota, core)
}

fn briefing(quota: &QuotaPart, core: &CorePart, filters: &Filters) -> render::Briefing {
    render::build(&Inputs { mode: "local", quota: Some(quota), core: Some(core), now_ms: NOW }, filters)
}

fn text(quota: &QuotaPart, core: &CorePart, filters: &Filters) -> String {
    render::text(&briefing(quota, core, filters))
}

#[test]
fn durations_are_compact_and_round_down() {
    assert_eq!(format_duration(0), "<1m");
    assert_eq!(format_duration(59_999), "<1m");
    assert_eq!(format_duration(MIN), "1m");
    assert_eq!(format_duration(22 * MIN), "22m");
    assert_eq!(format_duration(HOUR), "1h");
    assert_eq!(format_duration(HOUR + 12 * MIN), "1h12m");
    assert_eq!(format_duration(13 * HOUR + 30 * MIN), "13h");
    assert_eq!(format_duration(24 * HOUR), "1d");
    assert_eq!(format_duration(3 * 24 * HOUR + 4 * HOUR + 59 * MIN), "3d4h");
    assert_eq!(format_duration(-5 * MIN), "<1m");
}

#[test]
fn default_text_is_one_line_per_provider_with_guidance() {
    let (quota, core) = fixture();
    let out = text(&quota, &core, &Filters::default());
    assert_eq!(
        out,
        "cpa local core=up quota_age=6m\n\
         claude ok 2/2 5h=62%~1h12m wk=81%~3d4h | haiku-5-5 opus-5-5 sonnet-5-5\n\
         codex low 1/1 5h=8%~22m wk=40%~2d | gpt-6-luna gpt-6-sol\n\
         xai ok 1/1 bal=$12.40 quota=n/a | grok-4.7\n\
         guide: swarm=claude light=codex(5h=8%~22m)\n"
    );
}

#[test]
fn windows_follow_the_selected_headroom_account() {
    let (mut quota, core) = fixture();
    // The second account has a better weekly window, but the first has more total headroom.
    quota.accounts[1].windows = vec![window("5h", 30.0, Some(2 * HOUR)), window("weekly", 95.0, Some(5 * 24 * HOUR))];
    let out = text(&quota, &core, &Filters::default());
    assert!(out.contains("claude ok 2/2 5h=62%~1h12m wk=81%~3d4h "), "{out}");
}

#[test]
fn passed_reset_counts_as_full_and_never_prints_a_negative_time() {
    let (mut quota, core) = fixture();
    quota.accounts[2].windows = vec![window("5h", 0.0, Some(-5 * MIN)), window("weekly", 40.0, Some(2 * 24 * HOUR))];
    let out = text(&quota, &core, &Filters::default());
    assert!(out.contains("codex ok 1/1 5h=reset wk=40%~2d"), "{out}");
    assert!(!out.contains("~-"), "{out}");
}

#[test]
fn exhausted_window_makes_the_account_out_until_its_reset() {
    let (mut quota, core) = fixture();
    quota.accounts[2].windows = vec![window("5h", 0.0, Some(22 * MIN)), window("weekly", 40.0, Some(2 * 24 * HOUR))];
    let out = text(&quota, &core, &Filters::default());
    assert!(out.contains("codex out 0/1 back=22m 5h=<1%~22m wk=40%~2d"), "{out}");
    assert!(out.contains("guide: swarm=claude wait=codex~22m"), "{out}");
    assert!(!out.contains("gpt-6-luna"), "an exhausted provider lists no routable model: {out}");
    let asked = text(&quota, &core, &Filters { model: Some("luna".into()), ..Default::default() });
    assert!(asked.contains("codex out 0/1 back=22m") && asked.contains("| cool:gpt-6-luna~22m\n"), "{asked}");
}

#[test]
fn exhausted_window_without_reset_has_unknown_recovery_and_is_avoided() {
    let (mut quota, core) = fixture();
    quota.accounts[2].windows = vec![window("5h", 0.0, None), window("weekly", 40.0, Some(2 * 24 * HOUR))];
    let out = text(&quota, &core, &Filters::default());
    assert!(out.contains("codex out 0/1 back=? 5h=<1% wk=40%~2d"), "{out}");
    assert!(out.contains("guide: swarm=claude avoid=codex"), "{out}");
    assert!(!out.contains("back=<1m"), "{out}");
}

#[test]
fn windows_and_guide_use_the_same_headroom_account() {
    let (mut quota, core) = fixture();
    quota.accounts[0].windows = vec![window("5h", 90.0, Some(HOUR)), window("weekly", 5.0, Some(2 * 24 * HOUR))];
    quota.accounts[1].windows = vec![window("5h", 2.0, Some(HOUR)), window("weekly", 80.0, Some(2 * 24 * HOUR))];
    let out = text(&quota, &core, &Filters::default());
    assert!(out.contains("claude low 2/2 5h=90%~1h wk=5%~2d"), "{out}");
    assert!(out.contains("guide: light=claude(wk=5%~2d)"), "{out}");
}

#[test]
fn fractional_headroom_below_half_percent_prints_exhausted_consistently() {
    let (mut quota, core) = fixture();
    quota.accounts[2].windows = vec![window("5h", 0.4, Some(22 * MIN)), window("weekly", 40.0, Some(2 * 24 * HOUR))];
    let out = text(&quota, &core, &Filters::default());
    assert!(out.contains("codex out 0/1 back=22m 5h=<1%~22m"), "{out}");
    assert!(out.contains("guide: swarm=claude wait=codex~22m"), "{out}");
}

#[test]
fn guidance_uses_exact_thresholds_while_display_floors_percentages() {
    let (mut quota, core) = fixture();
    for (pct, status, display, guide) in [
        (19.6, "low", "5h=19%", "light=codex"),
        (20.0, "ok", "5h=20%", "light=codex"),
        (49.6, "ok", "5h=49%", "light=codex"),
        (50.0, "ok", "5h=50%", "swarm=codex"),
    ] {
        quota.accounts[2].windows = vec![window("5h", pct, Some(HOUR))];
        let out = text(&quota, &core, &Filters { provider: Some("codex".into()), ..Default::default() });
        assert!(out.contains(&format!("codex {status} 1/1 {display}")), "{pct}: {out}");
        assert!(out.contains(&format!("guide: {guide}")), "{pct}: {out}");
    }
}

#[test]
fn credential_cooldown_blocks_the_account_and_a_far_one_is_avoided() {
    let (quota, mut core) = fixture();
    core.accounts[3].unavailable = true;
    core.accounts[3].retry_at_ms = Some(NOW + 3 * HOUR);
    let out = text(&quota, &core, &Filters::default());
    assert!(out.contains("xai cool 0/1 back=3h"), "{out}");
    assert!(out.contains("avoid=xai"), "{out}");
    // Once the retry time has passed, the cached `unavailable` no longer blocks.
    let later = render::build(&Inputs { mode: "local", quota: Some(&quota), core: Some(&core), now_ms: NOW + 4 * HOUR }, &Filters::default());
    assert!(render::text(&later).contains("xai ok 1/1"));
}

#[test]
fn unavailable_without_a_retry_time_is_an_error_not_a_cooldown() {
    let (quota, mut core) = fixture();
    core.accounts[3].unavailable = true;
    let out = text(&quota, &core, &Filters::default());
    assert!(out.contains("xai err 0/1"), "{out}");
}

#[test]
fn model_cooldown_hides_a_model_only_when_no_account_can_serve_it() {
    let (quota, mut core) = fixture();
    core.accounts[0].cooldowns = vec![Cooldown { scope: "model".into(), model: "opus-5-5".into(), retry_at_ms: NOW + 4 * MIN }];
    // The second claude account still serves opus: it stays ok.
    assert!(text(&quota, &core, &Filters::default()).contains("| haiku-5-5 opus-5-5 sonnet-5-5\n"));
    core.accounts[1].cooldowns = vec![Cooldown { scope: "model".into(), model: "opus-5-5".into(), retry_at_ms: NOW + 9 * MIN }];
    let out = text(&quota, &core, &Filters::default());
    assert!(out.contains("| haiku-5-5 sonnet-5-5 cool:opus-5-5~4m\n"), "{out}");
}

#[test]
fn quota_older_than_thirty_minutes_is_flagged_stale() {
    let (mut quota, core) = fixture();
    for account in &mut quota.accounts {
        account.fetched_at_ms = Some(NOW - 2 * HOUR - 5 * MIN);
    }
    let out = text(&quota, &core, &Filters::default());
    assert!(out.starts_with("cpa local core=up quota_age=2h5m stale\n"), "{out}");
    let json = render::json(&briefing(&quota, &core, &Filters::default()));
    assert_eq!(json["quota"]["stale"], true);
    assert_eq!(json["quota"]["ageS"], 2 * 3600 + 5 * 60);
}

#[test]
fn quota_age_uses_only_accounts_in_the_filtered_output() {
    let (mut quota, core) = fixture();
    quota.accounts[2].fetched_at_ms = Some(NOW - 5 * HOUR);
    let out = text(&quota, &core, &Filters { provider: Some("claude".into()), ..Default::default() });
    assert!(out.starts_with("cpa local core=up quota_age=6m\n"), "{out}");
}

#[test]
fn core_down_serves_cached_state_and_says_so() {
    let (quota, mut core) = fixture();
    core.up = false;
    core.checked_at_ms = NOW;
    core.ok_at_ms = NOW - 12 * MIN;
    core.error = "could not connect to the core".into();
    let out = text(&quota, &core, &Filters::default());
    assert!(out.starts_with("cpa local core=down cached=12m quota_age=6m\ncore error: core unreachable\n"), "{out}");
    assert!(out.contains("claude ok 2/2 5h=62%~1h12m"), "{out}");
    assert!(!out.contains("opus-5-5"), "no model is routable while the core is unreachable: {out}");
    assert!(out.ends_with("guide: core unreachable, nothing routes now; numbers are cached\n"), "{out}");
    let json = render::json(&briefing(&quota, &core, &Filters::default()));
    assert_eq!(json["providers"][0]["models"], json!([]));
}

#[test]
fn default_text_features_the_newest_model_of_each_family() {
    let (quota, mut core) = fixture();
    let catalogue = [
        "claude-3-5-haiku-20241022", "claude-3-7-sonnet-20250219", "claude-haiku-4-5-20251001", "claude-haiku-5-5",
        "claude-opus-4-1-20250805", "claude-opus-5-5", "claude-opus-5-10", "claude-sonnet-4-6", "claude-sonnet-5-5",
    ];
    core.accounts[0].models = catalogue.iter().map(|m| m.to_string()).collect();
    core.accounts[1].models = core.accounts[0].models.clone();
    let out = text(&quota, &core, &Filters { provider: Some("claude".into()), ..Default::default() });
    assert!(out.contains("| claude-opus-5-10 claude-haiku-5-5 claude-sonnet-5-5 +6\n"), "{out}");
    core.accounts[0].models.push("claude-image-9".into());
    core.accounts[1].models = core.accounts[0].models.clone();
    let out = text(&quota, &core, &Filters { provider: Some("claude".into()), ..Default::default() });
    assert!(out.contains("| claude-opus-5-10 claude-haiku-5-5 claude-sonnet-5-5 +6\n"), "images are omitted from both list and hidden count: {out}");
    let all = text(&quota, &core, &Filters { provider: Some("claude".into()), model: Some("opus".into()), ..Default::default() });
    assert!(all.contains("| claude-opus-4-1-20250805 claude-opus-5-5 claude-opus-5-10\n"), "{all}");
}

#[test]
fn image_only_catalogue_has_no_hidden_model_count() {
    let (quota, mut core) = fixture();
    core.accounts[0].models = vec!["claude-image-9".into(), "claude-image-10".into()];
    core.accounts[1].models = core.accounts[0].models.clone();
    let out = text(&quota, &core, &Filters { provider: Some("claude".into()), ..Default::default() });
    assert!(out.contains("claude ok 2/2 5h=62%~1h12m wk=81%~3d4h\n"), "{out}");
    assert!(!out.contains("+"), "{out}");
}

#[test]
fn date_tokens_do_not_outrank_newer_model_versions() {
    let (quota, mut core) = fixture();
    let catalogue = [
        "claude-opus-4-20250514", "claude-opus-4-1-20250805", "claude-opus-4-8",
        "claude-sonnet-4-5-20250929", "claude-sonnet-4-6",
    ];
    core.accounts[0].models = catalogue.iter().map(|m| m.to_string()).collect();
    core.accounts[1].models = core.accounts[0].models.clone();
    let out = text(&quota, &core, &Filters { provider: Some("claude".into()), ..Default::default() });
    assert!(out.contains("| claude-opus-4-8 claude-sonnet-4-6"), "{out}");
    assert!(!out.contains("claude-opus-4-20250514") && !out.contains("claude-sonnet-4-5-20250929"), "{out}");
}

#[test]
fn a_core_that_answered_with_no_accounts_is_a_normal_empty_briefing() {
    let empty = core(vec![]);
    let b = render::build(&Inputs { mode: "local", quota: None, core: Some(&empty), now_ms: NOW }, &Filters::default());
    assert_eq!(render::text(&b), "cpa local core=up quota=none\nno accounts known yet\n");
}

#[test]
fn without_a_core_part_quota_only_accounts_are_shown() {
    let (quota, _) = fixture();
    let b = render::build(&Inputs { mode: "remote", quota: Some(&quota), core: None, now_ms: NOW }, &Filters::default());
    let out = render::text(&b);
    assert!(out.starts_with("cpa remote core=unknown quota_age=6m\n"), "{out}");
    assert!(out.contains("claude ok 2/2 5h=62%~1h12m"), "{out}");
    assert!(!out.contains('|'), "no model list without core data: {out}");
}

#[test]
fn without_quota_the_header_says_none() {
    let (_, core) = fixture();
    let b = render::build(&Inputs { mode: "local", quota: None, core: Some(&core), now_ms: NOW }, &Filters::default());
    let out = render::text(&b);
    assert!(out.starts_with("cpa local core=up quota=none\n"), "{out}");
    assert!(out.contains("claude ok 2/2 quota=n/a"), "{out}");
}

#[test]
fn filters_narrow_by_provider_and_model_and_accounts_adds_lines() {
    let (quota, core) = fixture();
    let only_codex = text(&quota, &core, &Filters { provider: Some("codex".into()), ..Default::default() });
    assert!(only_codex.contains("codex low") && !only_codex.contains("claude"), "{only_codex}");
    let alias = text(&quota, &core, &Filters { provider: Some("Anthropic".into()), ..Default::default() });
    assert!(alias.contains("claude ok") && !alias.contains("codex"), "{alias}");
    let by_model = text(&quota, &core, &Filters { model: Some("SONNET".into()), ..Default::default() });
    assert!(by_model.contains("claude ok 2/2 5h=62%~1h12m wk=81%~3d4h | sonnet-5-5\n"), "{by_model}");
    assert!(!by_model.contains("codex") && !by_model.contains("opus"), "{by_model}");
    let none = text(&quota, &core, &Filters { model: Some("nonexistent".into()), ..Default::default() });
    assert!(none.contains("no provider serves a model matching \"nonexistent\""), "{none}");
    let accounts = text(&quota, &core, &Filters { provider: Some("claude".into()), accounts: true, ..Default::default() });
    assert!(accounts.contains("\n  al***@e***.com ok 5h=62%~1h12m wk=81%~3d4h\n  bo***@e***.com ok 5h=30%~2h wk=70%~4d\n"), "{accounts}");
}

#[test]
fn model_lists_are_capped_in_text_but_complete_in_json() {
    let (quota, mut core) = fixture();
    let many: Vec<String> =
        ["amber", "birch", "cedar", "dune", "ember", "fjord", "grove", "hazel", "iris", "juniper"].iter().map(|m| m.to_string()).collect();
    core.accounts[0].models = many.clone();
    core.accounts[1].models = many.clone();
    let out = text(&quota, &core, &Filters { provider: Some("claude".into()), ..Default::default() });
    assert!(out.contains("| amber birch cedar dune +6\n"), "{out}");
    let json = render::json(&briefing(&quota, &core, &Filters { provider: Some("claude".into()), ..Default::default() }));
    assert_eq!(json["providers"][0]["models"].as_array().unwrap().len(), 10);
}

#[test]
fn json_has_the_same_facts_with_relative_seconds() {
    let (quota, core) = fixture();
    let json = render::json(&briefing(&quota, &core, &Filters { provider: Some("claude".into()), ..Default::default() }));
    assert_eq!(json["mode"], "local");
    assert_eq!(json["core"]["state"], "up");
    let provider = &json["providers"][0];
    assert_eq!(provider["id"], "claude");
    assert_eq!(provider["status"], "ok");
    assert_eq!(provider["usable"], 2);
    assert_eq!(provider["windows"][0], json!({ "window": "5h", "pct": 62, "resetInS": 4320 }));
    assert_eq!(json["guide"], "swarm=claude");
}

#[test]
fn model_group_windows_do_not_exhaust_the_account() {
    let (mut quota, core) = fixture();
    let mut spare = window("5h", 0.0, Some(HOUR));
    spare.group = "Code review".into();
    quota.accounts[2].windows.push(spare);
    let out = text(&quota, &core, &Filters { provider: Some("codex".into()), ..Default::default() });
    assert!(out.contains("codex low 1/1"), "{out}");
}

#[test]
fn providers_with_only_special_pools_show_the_tightest_as_lim() {
    let (mut quota, core) = fixture();
    let mut pool = window("other", 35.0, Some(2 * HOUR));
    pool.group = "Extra usage".into();
    quota.accounts[3].windows = vec![pool];
    quota.accounts[3].credit_balance = None;
    let out = text(&quota, &core, &Filters { provider: Some("xai".into()), ..Default::default() });
    assert!(out.contains("xai ok 1/1 lim=35%~2h"), "{out}");
}

#[test]
fn disabled_accounts_are_not_counted() {
    let (quota, mut core) = fixture();
    core.accounts[1].disabled = true;
    let out = text(&quota, &core, &Filters::default());
    assert!(out.contains("claude ok 1/1 5h=62%~1h12m"), "{out}");
    core.accounts[0].disabled = true;
    assert!(text(&quota, &core, &Filters::default()).contains("claude off 0/0"));
}

#[test]
fn freshness_follows_the_ttl_and_failures_retry_sooner() {
    let mut part = core(vec![]);
    part.checked_at_ms = NOW;
    assert!(is_fresh(&part, NOW));
    assert!(is_fresh(&part, NOW + CORE_TTL_MS - 1));
    assert!(!is_fresh(&part, NOW + CORE_TTL_MS));
    part.up = false;
    assert!(is_fresh(&part, NOW + CORE_FAILURE_TTL_MS - 1));
    assert!(!is_fresh(&part, NOW + CORE_FAILURE_TTL_MS));
    // A clock that moved backwards must not freeze the cache.
    assert!(!is_fresh(&part, NOW - 1));
}

#[test]
fn core_data_older_than_ttl_is_never_reported_as_up() {
    let (quota, mut core) = fixture();
    core.checked_at_ms = NOW - CORE_TTL_MS;
    core.ok_at_ms = NOW - CORE_TTL_MS;
    let out = text(&quota, &core, &Filters::default());
    assert!(out.starts_with("cpa local core=stale cached=1m quota_age=6m\n"), "{out}");
    assert!(out.contains("guide: core state is stale; routing is unknown"), "{out}");
    assert!(!out.contains("| haiku-5-5"), "{out}");
}

#[test]
fn old_unreachable_result_is_stale_when_no_recent_refresh_confirms_it() {
    let (quota, mut core) = fixture();
    core.up = false;
    core.checked_at_ms = NOW - CORE_FAILURE_TTL_MS;
    core.ok_at_ms = NOW - HOUR;
    core.error = "could not connect to the core".into();
    let out = text(&quota, &core, &Filters::default());
    assert!(out.starts_with("cpa local core=stale cached=1h quota_age=6m\n"), "{out}");
    assert!(out.contains("guide: core state is stale; routing is unknown"), "{out}");
}

const SECRET_EMAIL: &str = "alice.private@example.org";
const SECRET_TOKEN: &str = "sk-live-0123456789abcdefSECRET";
const SECRET_NAME: &str = "claude-alice.private@example.org.json";

fn credentials_fixture() -> serde_json::Value {
    json!({
        "observed_at": "2026-10-20T06:00:00Z",
        "files": [
            {
                "id": "id-1", "auth_index": "c1", "name": SECRET_NAME, "provider": "claude", "type": "claude",
                "label": SECRET_EMAIL, "email": SECRET_EMAIL, "account": SECRET_EMAIL,
                "access_token": SECRET_TOKEN, "api_key": SECRET_TOKEN, "path": "/home/someone/.auth/x.json",
                "status": "active", "disabled": false, "unavailable": false,
                "cooldowns": [
                    { "scope": "model", "model_key": "Opus-5-5", "reason": "quota", "retry_at": "2026-10-20T06:04:00Z", "remaining_seconds": 240 },
                    { "scope": "credential", "reason": "quota", "remaining_seconds": 90 }
                ]
            },
            { "id": "id-2", "auth_index": "d1", "name": "disabled.json", "provider": "anthropic", "disabled": true, "cooldowns": null },
            { "auth_index": "", "provider": "claude" },
            { "auth_index": "z1", "name": "z.json" }
        ]
    })
}

#[test]
fn credentials_parse_keeps_only_availability_fields() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-10-20T06:00:00Z").unwrap().timestamp_millis();
    let parsed = parse_credentials(&credentials_fixture(), now);
    assert_eq!(parsed.len(), 2, "entries without an index or provider are dropped");
    let first = &parsed[0].account;
    assert_eq!(first.provider, "claude");
    assert_eq!(parsed[0].name, SECRET_NAME);
    assert_eq!(first.cooldowns[0], Cooldown { scope: "model".into(), model: "opus-5-5".into(), retry_at_ms: now + 4 * MIN });
    assert_eq!(first.cooldowns[1], Cooldown { scope: "credential".into(), model: String::new(), retry_at_ms: now + 90_000 });
    assert_eq!(parsed[1].account.provider, "claude", "provider aliases are normalised");
    assert!(parsed[1].account.disabled && parsed[1].account.cooldowns.is_empty());
}

#[test]
fn provider_aliases_include_xai_and_meta_names_used_by_the_core() {
    assert_eq!(refresh::normalize_provider("x.ai"), "xai");
    assert_eq!(refresh::normalize_provider("x-ai"), "xai");
    assert_eq!(refresh::normalize_provider("muse"), "meta");
}

#[test]
fn models_parse_sorts_and_dedupes_both_response_shapes() {
    assert_eq!(parse_models(&json!({ "models": [{ "id": "b" }, { "id": "a" }, { "id": "b" }, { "display_name": "x" }] })), ["a", "b"]);
    assert_eq!(parse_models(&json!({ "data": [{ "id": "m" }] })), ["m"]);
    assert!(parse_models(&json!({ "error": "name is required" })).is_empty());
}

#[test]
fn no_secret_or_identity_reaches_the_cache_or_any_output() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-10-20T06:00:00Z").unwrap().timestamp_millis();
    let mut core_part = core(parse_credentials(&credentials_fixture(), now).into_iter().map(|c| c.account).collect());
    core_part.accounts[0].models = vec!["opus-5-5".into()];
    // A webview that forgot to mask must still not leak: the command sanitises what it stores.
    let published = sanitize_accounts(vec![
        QuotaAccount { auth_index: "c1".into(), provider: "claude".into(), label: SECRET_EMAIL.into(), plan: "max".into(), windows: vec![window("5h", 50.0, Some(HOUR))], ..Default::default() },
        QuotaAccount { auth_index: "bad".into(), provider: "not-a-provider".into(), ..Default::default() },
    ]);
    assert_eq!(published.len(), 1);
    let quota_part = quota(published);
    let filters = Filters { accounts: true, ..Default::default() };
    let b = briefing(&quota_part, &core_part, &filters);
    let everything = [
        render::text(&b),
        render::json(&b).to_string(),
        serde_json::to_string(&core_part).unwrap(),
        serde_json::to_string(&quota_part).unwrap(),
    ]
    .join("\n");
    for secret in [SECRET_EMAIL, SECRET_TOKEN, SECRET_NAME, "alice", "example.org", "/home/someone", "access_token", "api_key"] {
        assert!(!everything.contains(secret), "leaked {secret:?} in:\n{everything}");
    }
}

#[test]
fn auth_index_allowlist_drops_email_filename_and_jwt_shaped_values_from_caches() {
    let bad = ["alice@example.test", "claude-alice.json", "eyJhbGciOiJub25l.eyJzdWIiOiJhbGljZSJ9.sig"];
    let published = sanitize_accounts(bad.iter().map(|index| QuotaAccount {
        auth_index: (*index).into(), provider: "claude".into(), ..Default::default()
    }).collect());
    assert!(published.is_empty());
    let quota_json = serde_json::to_string(&QuotaPart { accounts: published, ..Default::default() }).unwrap();
    for index in bad { assert!(!quota_json.contains(index), "{quota_json}"); }

    let core_json = serde_json::to_string(&parse_credentials(&json!({ "files": bad.iter().map(|index| json!({
        "auth_index": index, "provider": "claude", "name": "credential.json"
    })).collect::<Vec<_>>() }), NOW).into_iter().map(|item| item.account).collect::<Vec<_>>()).unwrap();
    for index in bad { assert!(!core_json.contains(index), "{core_json}"); }
}

#[test]
fn sanitize_bounds_and_validates_what_the_webview_sends() {
    let mut account = QuotaAccount {
        auth_index: "c1".into(),
        provider: "claude".into(),
        label: "x".repeat(100),
        plan: "pro\nmax".into(),
        credit_balance: Some("$1<script>".into()),
        windows: (0..30).map(|n| QuotaWindow { kind: "weird".into(), remaining_percent: Some(150.0 + n as f64), ..Default::default() }).collect(),
        ..Default::default()
    };
    account.windows[0].remaining_percent = Some(f64::NAN);
    let clean = sanitize_accounts(vec![account]);
    assert_eq!(clean[0].label.chars().count(), 40);
    assert_eq!(clean[0].plan, "promax");
    assert_eq!(clean[0].credit_balance, None);
    assert_eq!(clean[0].windows.len(), 12);
    assert_eq!(clean[0].windows[0].kind, "other");
    assert_eq!(clean[0].windows[0].remaining_percent, None);
    assert_eq!(clean[0].windows[1].remaining_percent, Some(100.0));
    let many = (0..300).map(|n| QuotaAccount { auth_index: format!("i{n}"), provider: "codex".into(), ..Default::default() }).collect();
    assert_eq!(sanitize_accounts(many).len(), 200);
}

#[test]
fn rust_sanitizer_rejects_malformed_masked_emails_in_labels_and_groups() {
    let clean = sanitize_accounts(vec![QuotaAccount {
        auth_index: "c1".into(), provider: "claude".into(), label: "alice.private@example.org*".into(),
        windows: vec![QuotaWindow { group: "bob@corp.example".into(), ..Default::default() }], ..Default::default()
    }]);
    assert_eq!(clean[0].label, "***");
    assert_eq!(clean[0].windows[0].group, "***");
}

fn args(list: &[&str]) -> Vec<OsString> {
    list.iter().map(OsString::from).collect()
}

#[test]
fn arguments_parse_flags_with_both_value_styles() {
    assert_eq!(
        parse_args(&args(&["--json", "--accounts", "--provider", "codex", "--model=opus"])).unwrap(),
        Args { json: true, filters: Filters { provider: Some("codex".into()), model: Some("opus".into()), accounts: true }, help: false }
    );
    assert!(parse_args(&args(&["-h"])).unwrap().help);
    assert!(parse_args(&args(&["--provider"])).unwrap_err().contains("needs a value"));
    assert!(parse_args(&args(&["--bogus"])).unwrap_err().contains("unknown option"));
    for value in ["has space", "a&b", "a^b", "a%b", "a\"b", "☃"] {
        assert!(parse_args(&args(&["--model", value])).unwrap_err().contains("--model value may contain only"), "{value:?}");
        assert!(parse_args(&args(&["--provider", value])).unwrap_err().contains("--provider value may contain only"), "{value:?}");
    }
    assert!(parse_args(&args(&["--model", "claude-sonnet-5.5:latest/v2"])).is_ok());
}

#[test]
fn missing_or_unresolvable_saved_config_fails_before_cache_use() {
    assert!(super::cli::resolve_saved_target(Err("missing config".into())).is_err());
    assert!(super::cli::resolve_saved_target(Ok(crate::GuiConfigFile {
        connection_mode: crate::CoreConnectionMode::Remote,
        ..Default::default()
    })).is_err());
}

#[cfg(unix)]
#[test]
fn launcher_quotes_the_executable_path() {
    let script = super::launcher_script(std::path::Path::new("/opt/it's here/cpa-gui")).unwrap();
    assert_eq!(
        script,
        "#!/bin/sh\n# Written by EasyCLIProxyAPI on start; prints the agent briefing.\nexec '/opt/it'\\''s here/cpa-gui' --brief \"$@\"\n"
    );
    assert!(super::launcher_script(std::path::Path::new("/opt/a\nb")).is_err());
}

#[cfg(unix)]
#[test]
fn launcher_is_written_executable_and_only_rewritten_when_it_changes() {
    use std::os::unix::fs::PermissionsExt;
    let dir = crate::unique_test_temp_path("cpa-brief-launcher");
    std::env::set_var("CPA_BRIEF_DIR", &dir);
    let path = super::write_launcher().unwrap();
    assert_eq!(path, dir.join("cpa-brief"));
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o755);
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    super::write_launcher().unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), modified);
    std::env::remove_var("CPA_BRIEF_DIR");
    std::fs::remove_dir_all(dir).unwrap();
}

/// A throwaway core that records every path it is asked for.
async fn fake_core(paths: std::sync::Arc<std::sync::Mutex<Vec<String>>>) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let paths = paths.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 8192];
                let read = socket.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let line = request.lines().next().unwrap_or("").to_string();
                let authorized = request.to_ascii_lowercase().contains("authorization: bearer test-management-key-0123456789");
                paths.lock().unwrap().push(format!("{line} auth={authorized}"));
                let body = if line.contains("/credentials/models") {
                    json!({ "models": [{ "id": "opus-5-5" }, { "id": "sonnet-5-5" }] }).to_string()
                } else if line.contains("/v8/management/credentials ") || line.contains("/v8/management/credentials?") {
                    json!({ "files": [{ "auth_index": "c1", "name": "c1.json", "provider": "claude", "cooldowns": [] }] }).to_string()
                } else {
                    String::new()
                };
                let status = if body.is_empty() { "404 Not Found" } else { "200 OK" };
                let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = socket.write_all(reply.as_bytes()).await;
            });
        }
    });
    origin
}

fn remote_config(origin: &str) -> crate::GuiConfigFile {
    crate::GuiConfigFile {
        connection_mode: crate::CoreConnectionMode::Remote,
        remote_management_origin: origin.into(),
        remote_management_key: "test-management-key-0123456789".into(),
        remote_client_origin: origin.into(),
        remote_client_key: "test-client-key".into(),
        ..Default::default()
    }
}

#[tokio::test]
async fn refresh_reads_only_the_core_management_api_and_reuses_fresh_model_lists() {
    let paths = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let origin = fake_core(paths.clone()).await;
    let config = remote_config(&origin);
    let first = refresh::refresh(&config, &origin, None, NOW).await;
    assert!(first.up, "{}", first.error);
    assert_eq!(first.accounts[0].models, ["opus-5-5", "sonnet-5-5"]);
    assert_eq!(
        *paths.lock().unwrap(),
        [
            "GET /v8/management/credentials HTTP/1.1 auth=true",
            "GET /v8/management/credentials/models?name=c1.json HTTP/1.1 auth=true",
        ]
    );
    // Within the model TTL a second refresh is one request: the credentials list.
    paths.lock().unwrap().clear();
    let second = refresh::refresh(&config, &origin, Some(&first), NOW + 5 * MIN).await;
    assert_eq!(paths.lock().unwrap().len(), 1);
    assert_eq!(second.accounts[0].models, first.accounts[0].models);
    // A core that cannot be reached keeps the last accounts and says why.
    let dead = refresh::refresh(&remote_config("http://127.0.0.1:1"), "http://127.0.0.1:1", Some(&second), NOW + 6 * MIN).await;
    assert!(!dead.up);
    assert_eq!(dead.error, "could not connect to the core");
    assert_eq!(dead.accounts, second.accounts);
    assert_eq!(dead.ok_at_ms, second.ok_at_ms);
}

#[test]
fn the_refresh_lock_is_exclusive_released_on_drop_and_reclaimed_when_stale() {
    let dir = crate::unique_test_temp_path("cpa-brief-lock");
    std::fs::create_dir_all(&dir).unwrap();
    let first = super::cli::RefreshLock::acquire(&dir).expect("first caller gets the lock");
    assert_eq!(super::cli::RefreshLock::acquire(&dir).unwrap_err(), super::cli::LockAcquireError::Held, "second caller must wait");
    drop(first);
    let again = super::cli::RefreshLock::acquire(&dir).expect("released on drop");
    drop(again);
    // A crashed holder leaves a lock behind; it is reclaimed once it is older than the stale limit.
    let lock = dir.join("refresh.lock");
    std::fs::write(&lock, b"").unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(61);
    std::fs::File::options().write(true).open(&lock).unwrap().set_modified(old).unwrap();
    assert!(super::cli::RefreshLock::acquire(&dir).is_ok());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn future_mtime_is_reclaimed_and_old_owner_does_not_remove_replacement() {
    let dir = crate::unique_test_temp_path("cpa-brief-lock-future");
    std::fs::create_dir_all(&dir).unwrap();
    let lock = dir.join("refresh.lock");
    std::fs::write(&lock, b"clock-skew").unwrap();
    std::fs::File::options().write(true).open(&lock).unwrap()
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(30)).unwrap();
    let owner = super::cli::RefreshLock::acquire(&dir).expect("far-future timestamp is stale");
    let replacement = b"successor-owner-token";
    std::fs::remove_file(&lock).unwrap();
    std::fs::write(&lock, replacement).unwrap();
    drop(owner);
    assert_eq!(std::fs::read(&lock).unwrap(), replacement);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_lock_directory_that_cannot_be_created_is_not_mistaken_for_an_active_lock() {
    let parent = crate::unique_test_temp_path("cpa-brief-lock-unavailable");
    std::fs::write(&parent, b"not a directory").unwrap();
    assert!(matches!(super::cli::RefreshLock::acquire(&parent), Err(super::cli::LockAcquireError::Unavailable)));
    std::fs::remove_file(parent).unwrap();
}

#[test]
fn concurrent_queries_share_one_core_refresh() {
    let paths = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let (tx, rx) = std::sync::mpsc::channel();
    let server_paths = paths.clone();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            tx.send(fake_core(server_paths).await).unwrap();
            std::future::pending::<()>().await;
        });
    });
    let origin = rx.recv().unwrap();
    let config = std::sync::Arc::new(remote_config(&origin));
    let dir = crate::unique_test_temp_path("cpa-brief-stampede");
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let (config, dir, origin) = (config.clone(), dir.clone(), origin.clone());
            std::thread::spawn(move || super::cli::refresh_core(&config, &dir, &origin, None))
        })
        .collect();
    for handle in handles {
        let part = handle.join().unwrap().expect("every caller gets a core part");
        assert!(part.up && part.accounts.len() == 1);
    }
    assert_eq!(paths.lock().unwrap().len(), 2, "8 callers, one credentials read and one model read: {:?}", paths.lock().unwrap());
    std::fs::remove_dir_all(dir).unwrap();
}
