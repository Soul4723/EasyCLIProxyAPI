use super::*;
use super::super::model::CoreAccount;

const NOW: i64 = 1_800_000_000_000;
const MIN: i64 = 60_000;
const SECRET_EMAIL: &str = "alice.private@example.org";
const SECRET_TOKEN: &str = "sk-live-0123456789abcdefSECRET";

fn labels(rows: &[Row]) -> Vec<&str> {
    rows.iter().map(|row| row.label.as_str()).collect()
}

// Fixtures mirror tests/unit/quota/quotaService.test.ts.
#[test]
fn codex_rows_match_the_app() {
    let rows = codex_rows(&json!({ "rate_limit": { "allowed": true, "primary_window": { "used_percent": 97, "limit_window_seconds": 604800, "reset_at": 1784698723 } } }), NOW);
    assert_eq!(rows, [Row { label: "Weekly limit".into(), remaining: Some(3.0), reset_at_ms: Some(1_784_698_723_000) }]);

    let rows = codex_rows(&json!({
        "rate_limit": { "primary_window": { "used_percent": 10, "limit_window_seconds": 18000 }, "secondary_window": { "used_percent": 20, "limit_window_seconds": 2592000 } },
        "additional_rate_limits": [{ "limit_name": "Enhanced code review", "rate_limit": { "primary_window": { "used_percent": 30, "limit_window_seconds": 604800 } } }]
    }), NOW);
    assert_eq!(labels(&rows), ["5-hour limit", "Monthly limit", "Enhanced code review Weekly limit"]);

    let rows = codex_rows(&json!({ "plan_type": "team", "rate_limit": { "primary_window": { "used_percent": 10 }, "secondary_window": { "used_percent": 20 } } }), NOW);
    assert_eq!(labels(&rows), ["5-hour limit", "Weekly limit"]);

    let rows = codex_rows(&json!({ "rateLimit": { "allowed": false, "primaryWindow": { "limitWindowSeconds": 604800 }, "secondaryWindow": { "limitWindowSeconds": 18000, "resetAfterSeconds": 3600 } } }), NOW);
    assert_eq!(labels(&rows), ["5-hour limit", "Weekly limit"]);
    assert_eq!(rows.iter().map(|row| row.remaining).collect::<Vec<_>>(), [Some(0.0), None]);
    assert_eq!(rows[0].reset_at_ms, Some(NOW + 3_600_000));

    for used in [json!([]), json!([25]), json!({}), json!(false), json!(""), json!(" ")] {
        assert_eq!(codex_rows(&json!({ "rate_limit": { "primary_window": { "used_percent": used } } }), NOW)[0].remaining, None);
    }
    let small = codex_rows(&json!({ "rate_limit": { "primary_window": { "used_percent": 0.63 } } }), NOW)[0].remaining.unwrap();
    assert!((small - 99.37).abs() < 1e-9);
}

#[test]
fn claude_rows_match_the_app() {
    assert!((claude_rows(&json!({ "five_hour": { "utilization": 0.44 } }))[0].remaining.unwrap() - 99.56).abs() < 1e-9);

    let limit = |percent: Value, active: bool, name: &str| json!({
        "kind": "weekly_scoped", "percent": percent, "is_active": active,
        "scope": { "model": { "display_name": name } }, "resets_at": "2030-01-01T00:00:00Z"
    });
    let rows = claude_rows(&json!({
        "iguana_necktie": { "utilization": 41 }, "five_hour": { "utilization": 10 },
        "limits": [null, limit(Value::Null, true, "Fable"), limit(json!(12), false, "Fable 5"), limit(json!(64), true, "Fable"), limit(json!(99), true, "Sonnet")]
    }));
    assert_eq!(rows.iter().map(|row| (row.label.as_str(), row.remaining)).collect::<Vec<_>>(), [("5-hour window", Some(90.0)), ("7-day Fable window", Some(36.0))]);
    assert_eq!(rows[1].reset_at_ms, Some(1_893_456_000_000));

    let rows = claude_rows(&json!({ "iguana_necktie": { "utilization": 41 }, "limits": [{ "kind": "weekly_scoped", "percent": null, "scope": { "model": { "display_name": "Fable" } } }] }));
    assert_eq!(rows, [Row { label: "7-day Fable window".into(), remaining: Some(59.0), reset_at_ms: None }]);

    let rows = claude_rows(&json!({
        "five_hour": { "utilization": 20, "resets_at": "2027-01-01T00:00:00Z" },
        "extra_usage": { "is_enabled": true, "monthly_limit": 5000, "used_credits": 1250, "utilization": 25 }
    }));
    assert_eq!(rows.last().unwrap(), &Row { label: "Extra usage".into(), remaining: Some(75.0), reset_at_ms: None });
}

#[test]
fn devin_rows_match_the_app() {
    let rows = devin_rows(&json!({ "userStatus": { "planStatus": {
        "dailyQuotaRemainingPercent": 40, "dailyQuotaResetAtUnix": "1800003600",
        "weeklyQuotaRemainingPercent": "101", "weeklyQuotaResetAtUnix": 1800300000
    } } }));
    assert_eq!(rows, [
        Row { label: "Daily quota".into(), remaining: Some(40.0), reset_at_ms: Some(1_800_003_600_000) },
        Row { label: "Weekly quota".into(), remaining: None, reset_at_ms: Some(1_800_300_000_000) },
    ]);
    assert!(devin_rows(&json!({ "userStatus": {} })).is_empty());
}

#[test]
fn windows_are_classified_and_grouped_like_the_published_snapshot() {
    let row = |label: &str, remaining: f64, reset_in: Option<i64>| Row { label: label.into(), remaining: Some(remaining), reset_at_ms: reset_in.map(|ms| NOW + ms) };
    let windows = windows(&[
        row("5-hour window", 62.0, Some(60 * MIN)),
        row("7-day Opus window", 50.0, None),
        row("Code review Weekly limit", 30.0, None),
        row("Daily quota", 40.0, Some(3 * 60 * MIN)),
        row("Extra usage", 120.0, None),
        Row { label: "Weekly quota".into(), remaining: None, reset_at_ms: None },
    ], NOW);
    let view: Vec<_> = windows.iter().map(|w| (w.kind.as_str(), w.group.as_str(), w.remaining_percent)).collect();
    assert_eq!(view, [
        ("5h", "", Some(62.0)),
        ("weekly", "7-day Opus window", Some(50.0)),
        ("weekly", "Code review", Some(30.0)),
        ("5h", "Daily quota", Some(40.0)),
        ("other", "Extra usage", Some(100.0)),
    ]);
    assert_eq!(windows[0].reset_at_ms, Some(NOW + 60 * MIN));
}

#[test]
fn accounts_are_masked_and_carry_codex_credits() {
    let file = json!({ "auth_index": "g1", "provider": "codex", "email": SECRET_EMAIL, "access_token": SECRET_TOKEN, "id_token": { "plan_type": "Plus" } });
    let account = build_account("codex", "g1", &file, &json!({
        "credits": { "balance": 12.5, "unlimited": false },
        "rate_limit": { "primary_window": { "used_percent": 10, "limit_window_seconds": 18000 } }
    }), None, NOW).unwrap();
    assert_eq!(account.label, "al***@e***.org");
    assert_eq!(account.plan, "plus");
    assert_eq!(account.credit_balance.as_deref(), Some("12.5"));
    assert_eq!(account.fetched_at_ms, Some(NOW));
    assert_eq!(mask_identifier("acct-0123456789"), "ac***89");
    assert_eq!(mask_text("Team https://user:pw@host/x for bob@example.com"), "Team https://***@host/x for b***@e***.com");
    // Claude keeps the plan it last had: its plan endpoint is not on the allowlist.
    let claude = build_account("claude", "c1", &json!({}), &json!({ "five_hour": { "utilization": 1 } }), Some("Max"), NOW).unwrap();
    assert_eq!(claude.plan, "Max");
    assert!(build_account("claude", "c1", &json!({}), &json!({ "error": "x" }), None, NOW).is_err());
}

fn core_account(index: &str, provider: &str, disabled: bool) -> CoreAccount {
    CoreAccount { auth_index: index.into(), provider: provider.into(), disabled, ..Default::default() }
}

fn fetched_account(index: &str, at: i64) -> QuotaAccount {
    QuotaAccount { auth_index: index.into(), provider: "claude".into(), fetched_at_ms: Some(at), ..Default::default() }
}

#[test]
fn only_stale_enabled_readable_accounts_are_wanted_and_failures_back_off() {
    let core = CorePart {
        up: true,
        accounts: vec![
            core_account("c1", "claude", false),
            core_account("c2", "claude", false),
            core_account("c3", "claude", true),
            core_account("x1", "xai", false),
            core_account("g1", "codex", false),
            core_account("d1", "devin", false),
        ],
        ..Default::default()
    };
    let app = QuotaPart { accounts: vec![fetched_account("c1", NOW - MIN), fetched_account("c2", NOW - 10 * MIN)], ..Default::default() };
    let fetched = FetchedPart {
        accounts: vec![fetched_account("c2", NOW - 2 * MIN)],
        failed_at_ms: [("g1".to_string(), NOW - 5 * MIN), ("d1".to_string(), NOW - 20 * MIN)].into(),
        ..Default::default()
    };
    // c1 is fresh in the app, c2 fresh from the CLI, c3 disabled, x1 not read by the CLI, g1 failed recently.
    assert_eq!(wanted(&core, Some(&app), Some(&fetched), NOW), ["d1"]);
    assert_eq!(wanted(&core, Some(&app), Some(&fetched), NOW + 11 * MIN), ["c1", "c2", "g1", "d1"]);
}

#[test]
fn merge_keeps_the_newest_read_per_account() {
    let app = QuotaPart { origin: "o".into(), published_at_ms: NOW - 10 * MIN, accounts: vec![fetched_account("c1", NOW - 10 * MIN), fetched_account("c2", NOW - MIN)] };
    let fetched = FetchedPart { origin: "o".into(), accounts: vec![fetched_account("c1", NOW), fetched_account("c2", NOW - 5 * MIN), fetched_account("g1", NOW)], ..Default::default() };
    let merged = merge(Some(app.clone()), Some(fetched.clone())).unwrap();
    let ages: Vec<_> = merged.accounts.iter().map(|a| (a.auth_index.as_str(), a.fetched_at_ms)).collect();
    assert_eq!(ages, [("c1", Some(NOW)), ("c2", Some(NOW - MIN)), ("g1", Some(NOW))]);
    assert_eq!(merged.published_at_ms, NOW);
    assert_eq!(merge(Some(app.clone()), None), Some(app));
    assert_eq!(merge(None, Some(fetched)).unwrap().accounts.len(), 3);
}

#[test]
fn apply_records_failures_and_replaces_successes() {
    let previous = FetchedPart { accounts: vec![fetched_account("c1", NOW - 10 * MIN)], failed_at_ms: [("old".to_string(), NOW - 20 * MIN)].into(), ..Default::default() };
    let wanted = ["c1".to_string(), "g1".to_string()];
    let part = apply("o", Some(previous.clone()), &wanted, Ok(vec![("c1".into(), Ok(fetched_account("c1", NOW))), ("g1".into(), Err("x".into()))]), NOW);
    assert_eq!(part.accounts, [fetched_account("c1", NOW)]);
    assert_eq!(part.failed_at_ms, [("g1".to_string(), NOW)].into());
    // A core that cannot list credentials fails every wanted account and keeps the old reads.
    let down = apply("o", Some(previous.clone()), &wanted, Err("down".into()), NOW);
    assert_eq!(down.accounts, previous.accounts);
    assert_eq!(down.failed_at_ms.len(), 2);
}

fn jwt(claims: Value) -> String {
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    format!("{}.{}.sig", engine.encode(b"{\"alg\":\"none\"}"), engine.encode(claims.to_string()))
}

fn listing() -> Value {
    json!({ "files": [
        { "auth_index": "c1", "name": "claude-alice.json", "provider": "claude", "email": SECRET_EMAIL, "access_token": SECRET_TOKEN },
        { "auth_index": "g1", "name": "codex.json", "provider": "codex", "email": "bob@example.com",
          "id_token": jwt(json!({ "https://api.openai.com/auth": { "chatgpt_account_id": "acct-123", "chatgpt_plan_type": "pro" } })) },
        { "auth_index": "d1", "name": "devin.json", "provider": "cognition" },
        { "auth_index": "x1", "name": "xai.json", "provider": "xai" },
        { "auth_index": "a1", "name": "ag.json", "provider": "antigravity" },
        { "auth_index": "k1", "name": "kimi.json", "provider": "kimi" }
    ] })
}

fn provider_reply(url: &str) -> Value {
    let body = match url {
        CLAUDE_USAGE_URL => json!({ "five_hour": { "utilization": 38, "resets_at": "2027-01-15T12:00:00Z" }, "seven_day": { "utilization": 19 } }),
        CODEX_USAGE_URL => json!({ "plan_type": "pro", "rate_limit": { "primary_window": { "used_percent": 92, "limit_window_seconds": 18000, "reset_after_seconds": 1200 } } }),
        DEVIN_STATUS_URL => json!({ "userStatus": { "planStatus": { "dailyQuotaRemainingPercent": 70 } } }),
        _ => return json!({ "status_code": 404, "body": "" }),
    };
    json!({ "status_code": 200, "header": {}, "body": body.to_string() })
}

/// A throwaway core that records each request line and body, and answers usage reads with fixtures.
async fn fake_core(log: std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let log = log.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buffer = [0u8; 8192];
                let (head, body) = loop {
                    let read = socket.read(&mut buffer).await.unwrap_or(0);
                    request.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let length = head.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                        if body.len() >= length || read == 0 {
                            break (head.to_string(), body.to_string());
                        }
                    } else if read == 0 {
                        return;
                    }
                };
                let line = head.lines().next().unwrap_or("").to_string();
                assert!(head.to_ascii_lowercase().contains("authorization: bearer test-management-key-0123456789"));
                let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                log.lock().unwrap().push((line.clone(), body.clone()));
                let reply = if line.starts_with("GET /v8/management/credentials ") {
                    listing()
                } else if line.starts_with("POST /v8/management/requests/api-call ") {
                    provider_reply(body["url"].as_str().unwrap_or(""))
                } else {
                    Value::Null
                };
                let (status, reply) = if reply.is_null() { ("404 Not Found", String::new()) } else { ("200 OK", reply.to_string()) };
                let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
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

/// Every provider request goes through the core's `requests/api-call` to an allowlisted read-only URL.
fn assert_only_allowlisted_reads(log: &[(String, Value)]) {
    for (line, body) in log {
        if line.starts_with("GET /v8/management/credentials ") {
            continue;
        }
        assert!(line.starts_with("POST /v8/management/requests/api-call "), "unexpected core request {line}");
        let url = body["url"].as_str().unwrap();
        assert!(ALLOWED_URLS.contains(&url), "{url} is not allowlisted");
        let method = body["method"].as_str().unwrap();
        assert!(method == "GET" || (method == "POST" && url == DEVIN_STATUS_URL), "{method} {url}");
        assert!(["c1", "g1", "d1"].contains(&body["authIndex"].as_str().unwrap()));
        assert!(body["header"].as_object().unwrap().values().all(|v| !v.as_str().unwrap().contains(SECRET_TOKEN)));
    }
}

#[tokio::test]
async fn reads_use_only_allowlisted_usage_urls_through_the_core() {
    let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let origin = fake_core(log.clone()).await;
    let wanted: Vec<String> = ["c1", "g1", "d1", "x1", "a1", "k1", "gone"].map(String::from).to_vec();
    let reads = read_accounts(&remote_config(&origin), &wanted, &BTreeMap::new(), NOW).await.unwrap();
    let part = apply(&origin, None, &wanted, Ok(reads), NOW);

    let log = log.lock().unwrap().clone();
    assert_only_allowlisted_reads(&log);
    let mut urls: Vec<_> = log.iter().filter_map(|(_, body)| body["url"].as_str()).collect();
    urls.sort();
    assert_eq!(urls, [CLAUDE_USAGE_URL, CODEX_USAGE_URL, DEVIN_STATUS_URL], "one read per supported account; xai, antigravity and kimi are skipped");
    let codex = log.iter().find(|(_, body)| body["url"] == CODEX_USAGE_URL).unwrap();
    assert_eq!(codex.1["header"]["Chatgpt-Account-Id"], "acct-123");
    assert_eq!(codex.1["header"]["Authorization"], "Bearer $TOKEN$");
    let claude = log.iter().find(|(_, body)| body["url"] == CLAUDE_USAGE_URL).unwrap();
    assert_eq!(claude.1["header"]["anthropic-beta"], "oauth-2025-04-20");
    assert_eq!(claude.1["method"], "GET");
    assert!(claude.1.get("data").is_none());

    let indices: Vec<_> = part.accounts.iter().map(|a| a.auth_index.as_str()).collect();
    assert_eq!(indices.len(), 3);
    assert_eq!(part.failed_at_ms.keys().collect::<Vec<_>>(), ["a1", "gone", "k1", "x1"]);
    let codex = part.accounts.iter().find(|a| a.provider == "codex").unwrap();
    assert_eq!((codex.label.as_str(), codex.plan.as_str()), ("b***@e***.com", "pro"));
    assert_eq!(codex.windows[0].kind, "5h");
    assert_eq!(codex.windows[0].remaining_percent, Some(8.0));
    assert_eq!(codex.windows[0].reset_at_ms, Some(NOW + 1_200_000));
    let saved = serde_json::to_string(&part).unwrap();
    for secret in [SECRET_EMAIL, SECRET_TOKEN, "alice", "example.org", "claude-alice.json", "acct-123", "bob@"] {
        assert!(!saved.contains(secret), "leaked {secret:?} in {saved}");
    }
}

#[test]
fn concurrent_queries_share_one_quota_refresh_and_then_back_off() {
    let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let (tx, rx) = std::sync::mpsc::channel();
    let server_log = log.clone();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            tx.send(fake_core(server_log).await).unwrap();
            std::future::pending::<()>().await;
        });
    });
    let origin = rx.recv().unwrap();
    let config = std::sync::Arc::new(remote_config(&origin));
    let dir = crate::unique_test_temp_path("cpa-brief-quota-stampede");
    let core = std::sync::Arc::new(CorePart {
        origin: origin.clone(),
        up: true,
        accounts: vec![core_account("c1", "claude", false), core_account("g1", "codex", false), core_account("x1", "xai", false)],
        ..Default::default()
    });
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let (config, dir, origin, core) = (config.clone(), dir.clone(), origin.clone(), core.clone());
            std::thread::spawn(move || current(&config, &dir, &origin, None, Some(&core)))
        })
        .collect();
    for handle in handles {
        // A waiter that gives up before the refresh finishes still gets an answer (possibly none yet).
        let _ = handle.join().unwrap();
    }
    let merged = current(&config, &dir, &origin, None, Some(&core)).expect("the refresh was cached");
    assert_eq!(merged.accounts.len(), 2);
    let requests = log.lock().unwrap().clone();
    assert_only_allowlisted_reads(&requests);
    assert_eq!(requests.len(), 3, "8 callers, one listing and two usage reads: {requests:?}");
    // A core that is down is not asked for quota at all.
    let down = CorePart { up: false, ..(*core).clone() };
    std::fs::remove_file(dir.join(FETCHED_FILE)).unwrap();
    assert!(current(&config, &dir, &origin, None, Some(&down)).is_none());
    assert_eq!(log.lock().unwrap().len(), 3);
    std::fs::remove_dir_all(dir).unwrap();
}
