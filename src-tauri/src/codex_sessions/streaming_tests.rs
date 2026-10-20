//! The repair and index scans stream rollouts instead of holding the session store in memory.
//! The in-memory implementations they replaced are kept below as oracles.

use super::tests::test_root;
use super::*;
use std::io::Write;

struct Rng(u64);

impl Rng {
    fn draw(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

fn thread_uuid(index: usize) -> String {
    format!("{index:08x}-0000-4000-8000-{index:012x}")
}

fn fixed_mtime(index: usize) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_700_000_000 + index as u64)
}

fn set_mtime(path: &Path, modified: SystemTime) {
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
}

/// One line of a synthetic rollout, without its terminator.
fn mixed_line(rng: &mut Rng, file: usize, line: usize) -> String {
    let id = if rng.draw().is_multiple_of(3) {
        format!("fork-{file}-{line}")
    } else {
        thread_uuid(file)
    };
    match rng.draw() % 16 {
        0 => format!(
            r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"C:/work/{file}","model_provider":"openai","extra":{{"b":1,"a":[1,2,{{"z":null}}]}}}}}}"#
        ),
        1 => format!(
            r#"{{"type":"session_meta","payload":{{"id":"{id}","cwd":"C:/work","model_provider":"cpa-gui"}}}}"#
        ),
        2 => format!(r#"{{"type":"session_meta","payload":{{"id":"{id}"}}}}"#),
        3 => format!(
            r#"{{"type":"session\u005fmeta","payload":{{"id":"{id}","model_provider":"openai"}}}}"#
        ),
        4 => format!(
            r#"{{"t\u0079pe":"session_meta","payload":{{"id":"{id}","model_provider":"legacy"}}}}"#
        ),
        5 => r#"{"type":"session_meta","payload":"not an object"}"#.to_string(),
        6 => r#"{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}"#.to_string(),
        7 => r#"{"type":"response_item","payload":{"encrypted_content":"ciphertext"}}"#.to_string(),
        8 => format!(
            r#"{{"type":"response_item","payload":{{"text":"{}\"type\":\"session_meta\" {}"}}}}"#,
            "filler ".repeat(1 + (rng.draw() % 40_000) as usize),
            "tail ".repeat(1 + (rng.draw() % 1000) as usize)
        ),
        9 => r#"{"type":"session_meta","payload":{"id":"cut""#.to_string(),
        10 => String::new(),
        11 => r#"{"type":"event_msg","payload":{"type":"session_meta","id":"nested"}}"#.to_string(),
        12 => r#"{"type":"event_msg","payload":{"text":"h\u00e9llo 世界 \u001b[0m"}}"#.to_string(),
        13 => format!(
            r#"{{"type":"session_meta","payload":{{"id":"local:{id}","cwd":"\\\\?\\C:\\Users\\x","model_provider":"openai"}}}}"#
        ),
        14 => r#"{"type":"session_meta","payload":{"id":"  ","cwd":"  ","model_provider":"other"}}"#
            .to_string(),
        _ => format!(r#"{{"type":"event_msg","payload":{{"type":"user_input","n":{line}}}}}"#),
    }
}

fn mixed_rollout(rng: &mut Rng, file: usize) -> Vec<u8> {
    let lines = 5 + (rng.draw() % 60) as usize;
    let mut out = String::new();
    for line in 0..lines {
        out.push_str(&mixed_line(rng, file, line));
        out.push_str(match rng.draw() % 4 {
            0 => "\r\n",
            _ => "\n",
        });
    }
    if rng.draw().is_multiple_of(3) {
        // No terminator on the last line.
        out.push_str(&mixed_line(rng, file, lines));
    }
    out.into_bytes()
}

/// A multi-file store with every line kind; returns the rollout paths in scan order.
fn write_store(root: &Path, files: usize, include_invalid: bool) -> Vec<PathBuf> {
    let mut rng = Rng(0x5eed);
    let directories = ["sessions/2026/07", "sessions/2026/08", "archived_sessions"];
    for directory in directories {
        fs::create_dir_all(root.join(directory)).unwrap();
    }
    for index in 0..files {
        let name = format!("rollout-2026-07-01T00-00-00-{}.jsonl", thread_uuid(index));
        let path = root.join(directories[index % directories.len()]).join(name);
        let bytes = match index {
            // Never has a session_meta.
            0 => b"{\"type\":\"event_msg\",\"payload\":{}}\n\n{\"x\":1}\n".to_vec(),
            // Empty.
            1 => Vec::new(),
            // Already on the target provider.
            2 => format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{}\",\"model_provider\":\"cpa-gui\"}}}}\n{{\"type\":\"event_msg\"}}\n",
                thread_uuid(2)
            )
            .into_bytes(),
            // Not UTF-8.
            3 if include_invalid => vec![b'{', 0xff, 0xfe, b'\n'],
            _ => mixed_rollout(&mut rng, index),
        };
        fs::write(&path, bytes).unwrap();
        set_mtime(&path, fixed_mtime(index));
    }
    collect_rollout_files(root).unwrap()
}

struct OracleRepair {
    original: Vec<u8>,
    next: Vec<u8>,
    thread_id: Option<String>,
    cwd: Option<String>,
    has_user_event: bool,
    providers: Vec<String>,
    encrypted_content: bool,
    changed: bool,
}

/// `build_rollout_repair` as it was before streaming: whole file in memory, every line parsed.
fn oracle_build_rollout_repair(
    path: &Path,
    target_provider: &str,
) -> Result<Option<OracleRepair>, String> {
    let original =
        fs::read(path).map_err(|error| format!("Failed to read rollout {}: {error}", path.display()))?;
    let text = String::from_utf8(original.clone())
        .map_err(|error| format!("Rollout is not UTF-8 {}: {error}", path.display()))?;
    let mut next = String::with_capacity(text.len());
    let mut changed = false;
    let mut session_meta_count = 0usize;
    let mut thread_id = None;
    let mut cwd = None;
    let mut providers = Vec::new();
    for segment in text.split_inclusive('\n') {
        let (body_with_cr, newline) = segment
            .strip_suffix('\n')
            .map_or((segment, ""), |body| (body, "\n"));
        let (body, carriage) = body_with_cr
            .strip_suffix('\r')
            .map_or((body_with_cr, ""), |body| (body, "\r"));
        let mut output = body.to_string();
        if let Ok(mut record) = serde_json::from_str::<Value>(body) {
            if record.get("type").and_then(Value::as_str) == Some("session_meta") {
                if let Some(payload) = record.get_mut("payload").and_then(Value::as_object_mut) {
                    session_meta_count += 1;
                    if thread_id.is_none() {
                        thread_id = payload
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|value| !value.trim().is_empty())
                            .map(ToString::to_string);
                    }
                    if cwd.is_none() {
                        cwd = payload
                            .get("cwd")
                            .and_then(Value::as_str)
                            .and_then(normalize_workspace_path);
                    }
                    if let Some(provider) = payload.get("model_provider").and_then(Value::as_str) {
                        providers.push(provider.to_string());
                    }
                    if payload.get("model_provider").and_then(Value::as_str)
                        != Some(target_provider)
                    {
                        payload.insert("model_provider".to_string(), json!(target_provider));
                        output = serde_json::to_string(&record)
                            .map_err(|error| format!("Failed to serialize session_meta: {error}"))?;
                        changed = true;
                    }
                }
            }
        }
        next.push_str(&output);
        next.push_str(carriage);
        next.push_str(newline);
    }
    if session_meta_count == 0 {
        return Ok(None);
    }
    let has_user_event = text.contains("\"user_message\"") || text.contains("\"user_input\"");
    let encrypted_content = text.contains("encrypted_content");
    Ok(Some(OracleRepair {
        original,
        next: next.into_bytes(),
        thread_id,
        cwd,
        has_user_event,
        providers,
        encrypted_content,
        changed,
    }))
}

/// The rollout half of `collect_live_thread_ids` before streaming.
fn oracle_rollout_ids(codex_home: &Path) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    for path in collect_rollout_files(codex_home)? {
        if let Some(id) = rollout_thread_id_from_file_name(&path) {
            ids.insert(id);
        }
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if is_locked_io_error(&error) => continue,
            Err(error) => return Err(format!("Failed to read rollout {}: {error}", path.display())),
        };
        for line in text.lines() {
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if record.get("type").and_then(Value::as_str) != Some("session_meta") {
                continue;
            }
            if let Some(id) = record
                .get("payload")
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("id"))
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
            {
                ids.insert(id.to_string());
                ids.insert(normalize_thread_id(id));
            }
        }
    }
    Ok(ids)
}

#[test]
fn prefilter_never_skips_a_session_meta_spelling() {
    for line in [
        r#"{"type":"session_meta","payload":{}}"#,
        r#"{"type": "session_meta"}"#,
        r#"{"payload":{},"type":"session_meta"}"#,
        r#"{"type":"session\u005fmeta"}"#,
        r#"{"type":"session\u005Fmeta"}"#,
        r#"{"type":"\u0073ession_meta"}"#,
        r#"{"type":"session_m\u0065ta"}"#,
        r#"{"t\u0079pe":"session_meta"}"#,
        r#"{"\u0074ype":"\u0073\u0065\u0073\u0073\u0069\u006f\u006e\u005f\u006d\u0065\u0074\u0061"}"#,
    ] {
        assert!(may_be_session_meta(line), "{line}");
        // Whatever the spelling, the old parser agrees it is a session_meta record.
        let record = serde_json::from_str::<Value>(line).unwrap();
        assert_eq!(record.get("type").and_then(Value::as_str), Some("session_meta"));
    }
    for line in [
        "",
        "   ",
        "not json",
        r#"{"type":"event_msg","payload":{"text":"h\u00e9llo \u001b[0m \u0041"}}"#,
        r#"{"type":"response_item"}"#,
    ] {
        assert!(!may_be_session_meta(line), "{line}");
    }
}

#[test]
fn streaming_scan_matches_the_in_memory_oracle_on_a_mixed_store() {
    let root = test_root("stream-oracle");
    let paths = write_store(&root, 48, true);
    assert_eq!(paths.len(), 48);
    let mut changed = 0;
    let mut unchanged_with_meta = 0;
    let mut without_meta = 0;
    let mut errors = 0;
    for path in &paths {
        let oracle = oracle_build_rollout_repair(path, "cpa-gui");
        let streamed = build_rollout_repair(path, "cpa-gui");
        let (oracle, streamed) = match (oracle, streamed) {
            (Err(_), Err(error)) => {
                assert!(error.starts_with("Rollout is not UTF-8"), "{error}");
                errors += 1;
                continue;
            }
            (Ok(oracle), Ok(streamed)) => (oracle, streamed),
            (oracle, streamed) => panic!(
                "{}: oracle ok={} streamed ok={}",
                path.display(),
                oracle.is_ok(),
                streamed.is_ok()
            ),
        };
        let (Some(oracle), Some(streamed)) = (oracle, streamed) else {
            // Neither found a session_meta record.
            assert!(
                oracle_build_rollout_repair(path, "cpa-gui").unwrap().is_none()
                    && build_rollout_repair(path, "cpa-gui").unwrap().is_none()
            );
            without_meta += 1;
            continue;
        };
        assert_eq!(streamed.thread_id, oracle.thread_id, "{}", path.display());
        assert_eq!(streamed.cwd, oracle.cwd, "{}", path.display());
        assert_eq!(streamed.has_user_event, oracle.has_user_event, "{}", path.display());
        assert_eq!(streamed.providers, oracle.providers, "{}", path.display());
        assert_eq!(streamed.encrypted_content, oracle.encrypted_content, "{}", path.display());
        assert_eq!(streamed.changed, oracle.changed, "{}", path.display());
        assert_eq!(streamed.original_len, oracle.original.len() as u64);
        if oracle.changed {
            changed += 1;
            let mut next = Vec::new();
            scan_rollout(path, "cpa-gui", Some(&mut next)).unwrap();
            assert_eq!(next, oracle.next, "{}", path.display());
        } else {
            unchanged_with_meta += 1;
            // Nothing to rewrite: the output would equal the input.
            assert_eq!(oracle.next, oracle.original, "{}", path.display());
        }
    }
    assert!(changed >= 10 && unchanged_with_meta >= 1 && without_meta >= 2 && errors == 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn repair_output_is_byte_identical_and_untouched_files_are_not_rewritten() {
    let root = test_root("stream-repair");
    fs::write(root.join("config.toml"), "model_provider = \"cpa-gui\"\n").unwrap();
    let paths = write_store(&root, 40, false);
    let before = paths
        .iter()
        .map(|path| {
            let metadata = fs::metadata(path).unwrap();
            #[cfg(unix)]
            let inode = std::os::unix::fs::MetadataExt::ino(&metadata);
            #[cfg(not(unix))]
            let inode = 0u64;
            (
                fs::read(path).unwrap(),
                oracle_build_rollout_repair(path, "cpa-gui").unwrap(),
                metadata.modified().unwrap(),
                inode,
            )
        })
        .collect::<Vec<_>>();
    let expected_changes = before
        .iter()
        .filter(|(_, oracle, _, _)| oracle.as_ref().is_some_and(|oracle| oracle.changed))
        .count();
    assert!(expected_changes >= 10);

    let result = repair_codex_session_metadata_from_home(&root, "cpa-gui", |_| {}).unwrap();
    assert_eq!(result.changed_rollout_files, expected_changes);
    assert!(result.skipped_locked_files.is_empty());
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);

    let backup = PathBuf::from(result.backup_path.as_ref().unwrap());
    let mut backup_index = 0;
    for (path, (original, oracle, mtime, inode)) in paths.iter().zip(&before) {
        let now = fs::read(path).unwrap();
        assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), *mtime);
        match oracle {
            Some(oracle) if oracle.changed => {
                assert_eq!(now, oracle.next, "{}", path.display());
                let backed_up = backup
                    .join("rollouts")
                    .join(format!("{backup_index}-{}", path.file_name().unwrap().to_string_lossy()));
                assert_eq!(&fs::read(backed_up).unwrap(), original);
                backup_index += 1;
            }
            _ => {
                assert_eq!(&now, original, "{}", path.display());
                #[cfg(unix)]
                assert_eq!(
                    std::os::unix::fs::MetadataExt::ino(&fs::metadata(path).unwrap()),
                    *inode,
                    "unchanged rollout was rewritten: {}",
                    path.display()
                );
                #[cfg(not(unix))]
                let _ = inode;
            }
        }
    }

    // A second run has nothing to do and leaves every rollout (and the backups) alone.
    let again = repair_codex_session_metadata_from_home(&root, "cpa-gui", |_| {}).unwrap();
    assert_eq!(again.changed_rollout_files, 0);
    assert_eq!(again.backup_path, None);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rewrite_skips_a_rollout_that_changed_after_the_scan() {
    let root = test_root("stream-stale");
    fs::create_dir_all(root.join("sessions")).unwrap();
    let path = root.join("sessions/rollout.jsonl");
    let original = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"model_provider\":\"openai\"}}\n";
    fs::write(&path, original).unwrap();
    let repair = build_rollout_repair(&path, "cpa-gui").unwrap().unwrap();
    assert!(repair.changed);

    let appended = format!("{original}{{\"type\":\"event_msg\"}}\n");
    fs::write(&path, &appended).unwrap();
    match rewrite_rollout(&repair, "cpa-gui").unwrap() {
        RewriteOutcome::Skipped(warning) => assert!(warning.contains("changed during repair")),
        _ => panic!("a stale rollout must not be rewritten"),
    }
    assert_eq!(fs::read_to_string(&path).unwrap(), appended);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rollback_restores_written_rollouts_from_the_backup() {
    let root = test_root("stream-rollback");
    fs::create_dir_all(root.join("sessions")).unwrap();
    let path = root.join("sessions/rollout.jsonl");
    let original = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"model_provider\":\"openai\"}}\r\n{\"type\":\"event_msg\"}\r\n";
    fs::write(&path, original).unwrap();
    set_mtime(&path, fixed_mtime(7));
    let repair = build_rollout_repair(&path, "cpa-gui").unwrap().unwrap();
    let backup = create_repair_backup(
        &root,
        &[],
        std::slice::from_ref(&repair),
        "provider-repair",
        "cpa-gui",
    )
    .unwrap();

    assert!(matches!(
        rewrite_rollout(&repair, "cpa-gui").unwrap(),
        RewriteOutcome::Written
    ));
    assert!(fs::read_to_string(&path).unwrap().contains("cpa-gui"));
    rollback_rollouts(&[(0, &repair)], Some(backup.as_path()));
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), fixed_mtime(7));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn streamed_live_ids_match_the_oracle_and_are_reused_until_a_rollout_changes() {
    let root = test_root("stream-index");
    let paths = write_store(&root, 36, false);
    let expected = oracle_rollout_ids(&root).unwrap();

    let scans = || ROLLOUT_CONTENT_SCANS.with(std::cell::Cell::get);
    let start = scans();
    assert_eq!(collect_rollout_thread_ids(&root).unwrap(), expected);
    assert_eq!(scans() - start, paths.len());

    // Nothing changed: the second pass reads no rollout content.
    assert_eq!(collect_rollout_thread_ids(&root).unwrap(), expected);
    assert_eq!(scans() - start, paths.len());

    // A rollout that grew invalidates the whole reused result.
    let grown = &paths[5];
    let mut file = fs::OpenOptions::new().append(true).open(grown).unwrap();
    writeln!(
        file,
        "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"added-after-preview\",\"model_provider\":\"openai\"}}}}"
    )
    .unwrap();
    drop(file);
    let rescanned = collect_rollout_thread_ids(&root).unwrap();
    assert_eq!(scans() - start, paths.len() * 2);
    assert!(rescanned.contains("added-after-preview"));
    assert_eq!(rescanned, oracle_rollout_ids(&root).unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn index_cleanup_apply_reuses_the_preview_scan() {
    let root = test_root("stream-index-apply");
    fs::create_dir_all(root.join("sessions")).unwrap();
    let live = "019f480d-bbc6-7b62-8a46-99597db8bde7";
    let stale = "019f4e36-490e-7ae0-8e78-a8b3ab33a428";
    fs::write(
        root.join("sessions").join(format!("rollout-2026-{live}.jsonl")),
        format!("{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{live}\"}}}}\n"),
    )
    .unwrap();
    let line = |id: &str| json!({"id": id, "thread_name": id, "updated_at": "now"}).to_string();
    fs::write(
        root.join("session_index.jsonl"),
        format!("{}\n{}\n", line(live), line(stale)),
    )
    .unwrap();

    let start = ROLLOUT_CONTENT_SCANS.with(std::cell::Cell::get);
    let preview = preview_session_index_cleanup_from_home(&root).unwrap();
    assert_eq!(preview.candidates.len(), 1);
    let after_preview = ROLLOUT_CONTENT_SCANS.with(std::cell::Cell::get);
    assert_eq!(after_preview - start, 1);
    let result = apply_session_index_cleanup_from_home(
        &root,
        &preview.snapshot_sha256,
        &[stale.to_string()],
        false,
    )
    .unwrap();
    assert_eq!(result.pruned_entries, 1);
    assert_eq!(ROLLOUT_CONTENT_SCANS.with(std::cell::Cell::get), after_preview);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn streamed_live_ids_reject_a_non_utf8_rollout_like_before() {
    let root = test_root("stream-index-invalid");
    write_store(&root, 8, true);
    let old = oracle_rollout_ids(&root).unwrap_err();
    let new = collect_rollout_thread_ids(&root).unwrap_err();
    assert!(old.starts_with("Failed to read rollout"), "{old}");
    assert!(new.starts_with("Failed to read rollout"), "{new}");
    fs::remove_dir_all(root).unwrap();
}

#[cfg(target_os = "linux")]
fn proc_status_kib(key: &str) -> Option<u64> {
    fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix(key)?.trim().strip_suffix("kB")?.trim().parse().ok())
}

#[cfg(target_os = "linux")]
fn write_perf_rollout(path: &Path, megabytes: usize, provider: &str, id: &str) {
    let mut writer = std::io::BufWriter::new(fs::File::create(path).unwrap());
    writeln!(
        writer,
        "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"/work\",\"model_provider\":\"{provider}\"}}}}"
    )
    .unwrap();
    let filler = "x".repeat(256 * 1024);
    let target = megabytes * 1024 * 1024;
    let mut written = 0;
    let mut line = 0;
    while written < target {
        let kind = if line % 64 == 0 { "user_message" } else { "output" };
        let text = format!("{{\"type\":\"response_item\",\"payload\":{{\"kind\":\"{kind}\",\"text\":\"{filler}\"}}}}\n");
        writer.write_all(text.as_bytes()).unwrap();
        written += text.len();
        line += 1;
    }
    writer.flush().unwrap();
}

#[cfg(target_os = "linux")]
fn log_peak<T>(label: &str, work: impl FnOnce() -> T) -> T {
    // Writing 5 to clear_refs resets VmHWM to the current RSS.
    let reset = fs::write("/proc/self/clear_refs", "5").is_ok();
    let baseline = proc_status_kib("VmRSS:").unwrap_or(0);
    let started = std::time::Instant::now();
    let output = work();
    let peak = proc_status_kib("VmHWM:").unwrap_or(0);
    eprintln!(
        "[perf] {label}: baseline_rss={} MiB peak_rss={} MiB (peak reset: {reset}) elapsed={:.2?}",
        baseline / 1024,
        peak / 1024,
        started.elapsed()
    );
    output
}

/// Logged only. Run: `cargo test -- --ignored --nocapture --test-threads=1 perf_codex_sessions`
/// (`CODEX_PERF_FILES` / `CODEX_PERF_MB` size the synthetic store).
#[cfg(target_os = "linux")]
#[test]
#[ignore = "records peak RSS for a large synthetic session store; logged only"]
fn perf_codex_sessions_repair_and_index_peak_rss() {
    let env_usize = |name: &str, default: usize| {
        std::env::var(name).ok().and_then(|value| value.parse().ok()).unwrap_or(default)
    };
    let files = env_usize("CODEX_PERF_FILES", 8);
    let megabytes = env_usize("CODEX_PERF_MB", 40);
    let build = |name: &str| {
        let root = test_root(name);
        fs::create_dir_all(root.join("sessions")).unwrap();
        for index in 0..files {
            // Half the files need rewriting, half are already on the target provider.
            let provider = if index % 2 == 0 { "openai" } else { "cpa-gui" };
            let path = root.join("sessions").join(format!(
                "rollout-2026-07-01T00-00-00-{}.jsonl",
                thread_uuid(index)
            ));
            write_perf_rollout(&path, megabytes, provider, &thread_uuid(index));
        }
        root
    };
    let streamed_root = build("perf-streamed");
    let oracle_root = build("perf-oracle");
    eprintln!(
        "[perf] store: {files} rollouts x {megabytes} MiB = {} MiB per store",
        files * megabytes
    );

    let result = log_peak("repair (streaming)", || {
        repair_codex_session_metadata_from_home(&streamed_root, "cpa-gui", |_| {}).unwrap()
    });
    assert_eq!(result.changed_rollout_files, files.div_ceil(2));
    let ids = log_peak("index scan cold (streaming)", || {
        collect_rollout_thread_ids(&streamed_root).unwrap()
    });
    log_peak("index scan reused (streaming)", || {
        assert_eq!(collect_rollout_thread_ids(&streamed_root).unwrap(), ids);
    });

    // The previous implementation: scan phase of repair, which kept original + next of every file.
    let held = log_peak("repair scan (in-memory oracle)", || {
        collect_rollout_files(&oracle_root)
            .unwrap()
            .iter()
            .filter_map(|path| oracle_build_rollout_repair(path, "cpa-gui").unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(held.iter().filter(|repair| repair.changed).count(), files.div_ceil(2));
    drop(held);
    log_peak("index scan (in-memory oracle)", || {
        assert_eq!(oracle_rollout_ids(&oracle_root).unwrap(), ids);
    });
    fs::remove_dir_all(streamed_root).unwrap();
    fs::remove_dir_all(oracle_root).unwrap();
}
