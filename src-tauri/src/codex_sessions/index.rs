use super::*;

pub(super) fn preview_session_index_cleanup_from_home(
    codex_home: &Path,
) -> Result<SessionIndexCleanupPreview, String> {
    let live_ids = collect_live_thread_ids(codex_home)?;
    let path = codex_home.join("session_index.jsonl");
    let Some(plan) = build_session_index_plan(&path, &live_ids)? else {
        return Ok(SessionIndexCleanupPreview {
            snapshot_sha256: sha256_hex(&[]),
            candidates: Vec::new(),
        });
    };
    Ok(SessionIndexCleanupPreview {
        snapshot_sha256: plan.snapshot_sha256,
        candidates: plan.candidates,
    })
}

fn collect_live_thread_ids(codex_home: &Path) -> Result<HashSet<String>, String> {
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
    let (database_paths, database_warnings) = discover_database_paths(codex_home, true);
    if !database_warnings.is_empty() {
        return Err(format!(
            "Unable to fully verify all Codex databases; invalid session record check aborted: {}",
            database_warnings.join("；")
        ));
    }
    for path in database_paths {
        let connection = open_read_only(&path)?;
        for (table, column) in REFERENCE_TABLE_COLUMNS {
            let columns = table_columns(&connection, table)?;
            if !columns.contains(column) {
                continue;
            }
            let sql = format!(
                "SELECT DISTINCT \"{}\" FROM \"{}\" WHERE COALESCE(\"{}\", '') <> ''",
                column, table, column
            );
            let mut statement = connection
                .prepare(&sql)
                .map_err(|error| format!("Failed to read session reference {}: {error}", path.display()))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("Failed to read session reference {}: {error}", path.display()))?;
            for id in rows
                .collect::<rusqlite::Result<HashSet<_>>>()
                .map_err(|error| format!("Failed to read session reference {}: {error}", path.display()))?
            {
                ids.insert(normalize_thread_id(&id));
                ids.insert(id);
            }
        }
    }
    Ok(ids)
}

pub(super) fn rollout_thread_id_from_file_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    if stem.len() < 36 {
        return None;
    }
    let candidate = &stem[stem.len() - 36..];
    candidate
        .chars()
        .enumerate()
        .all(|(index, character)| match index {
            8 | 13 | 18 | 23 => character == '-',
            _ => character.is_ascii_hexdigit(),
        })
        .then(|| candidate.to_string())
}

fn build_session_index_plan(
    path: &Path,
    live_ids: &HashSet<String>,
) -> Result<Option<SessionIndexPlan>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let original =
        fs::read(path).map_err(|error| format!("Failed to read session_index.jsonl: {error}"))?;
    let original_text = String::from_utf8(original.clone())
        .map_err(|error| format!("session_index.jsonl is not UTF-8: {error}"))?;
    let mut seen_candidates = HashSet::new();
    let candidates = original_text
        .lines()
        .filter_map(known_session_index_candidate)
        .filter(|candidate| {
            !live_ids.contains(&candidate.id)
                && !live_ids.contains(&normalize_thread_id(&candidate.id))
        })
        .filter(|candidate| seen_candidates.insert(candidate.id.clone()))
        .collect();
    Ok(Some(SessionIndexPlan {
        path: path.to_path_buf(),
        snapshot_sha256: sha256_hex(&original),
        original,
        original_text,
        candidates,
    }))
}

fn known_session_index_candidate(line: &str) -> Option<SessionIndexCleanupCandidate> {
    let record = serde_json::from_str::<Value>(line).ok()?;
    let object = record.as_object()?;
    if object.len() != 3
        || !["id", "thread_name", "updated_at"]
            .iter()
            .all(|key| object.contains_key(*key))
    {
        return None;
    }
    let id = object.get("id")?.as_str()?.trim();
    let thread_name = object.get("thread_name")?.as_str()?;
    let updated_at = object.get("updated_at")?.as_str()?;
    if id.is_empty() || updated_at.trim().is_empty() {
        return None;
    }
    Some(SessionIndexCleanupCandidate {
        id: id.to_string(),
        thread_name: thread_name.to_string(),
        updated_at: updated_at.to_string(),
    })
}

pub(super) fn apply_session_index_cleanup_from_home(
    codex_home: &Path,
    expected_snapshot: &str,
    confirmed_ids: &[String],
    require_stopped_app: bool,
) -> Result<SessionIndexCleanupResult, String> {
    let _guard = CODEX_SESSION_WRITE_LOCK
        .lock()
        .map_err(|_| "Codex session write lock is poisoned".to_string())?;
    if require_stopped_app {
        ensure_codex_apps_stopped()?;
    }
    let live_ids = collect_live_thread_ids(codex_home)?;
    let path = codex_home.join("session_index.jsonl");
    let plan = build_session_index_plan(&path, &live_ids)?
        .ok_or_else(|| "session_index.jsonl does not exist and cannot be cleaned".to_string())?;
    if plan.snapshot_sha256 != expected_snapshot {
        return Err("session_index.jsonl changed after preview. Preview it again".to_string());
    }
    let candidate_ids = plan
        .candidates
        .iter()
        .map(|candidate| candidate.id.as_str())
        .collect::<HashSet<_>>();
    let selected = confirmed_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .map(ToString::to_string)
        .collect::<HashSet<_>>();
    if selected
        .iter()
        .any(|id| !candidate_ids.contains(id.as_str()))
    {
        return Err("The confirmation list has expired or contains non-candidate sessions. Preview again".to_string());
    }
    if selected.is_empty() {
        return Ok(SessionIndexCleanupResult {
            pruned_entries: 0,
            backup_path: None,
        });
    }
    let (next, removed) = filter_session_index(&plan.original_text, &selected);
    if removed == 0 {
        return Ok(SessionIndexCleanupResult {
            pruned_entries: 0,
            backup_path: None,
        });
    }
    let backup_dir =
        create_operation_directory(codex_home, "session-index-cleanup", "index-cleanup")?;
    fs::write(backup_dir.join("session_index.jsonl"), &plan.original)
        .map_err(|error| format!("Failed to back up session_index.jsonl: {error}"))?;
    write_json_atomically(
        &backup_dir.join("metadata.json"),
        &json!({
            "schemaVersion": 1,
            "kind": "session-index-cleanup",
            "createdAt": Utc::now().to_rfc3339(),
            "snapshotSha256": plan.snapshot_sha256,
            "removedEntries": removed,
            "managedBy": "EasyCLIProxyAPI"
        }),
    )?;
    let current = fs::read(&plan.path)
        .map_err(|error| format!("Failed to reread session_index.jsonl before writing: {error}"))?;
    if current != plan.original {
        return Err(format!(
            "session_index.jsonl changed again before writing; new content was not overwritten, and the backup is at {}",
            backup_dir.display()
        ));
    }
    if require_stopped_app {
        ensure_codex_apps_stopped()?;
    }
    let expected_after_sha256 = sha256_hex(next.as_bytes());
    crate::write_bytes_atomically(&plan.path, next.as_bytes())?;
    let written = fs::read(&plan.path)
        .map_err(|error| format!("Failed to verify session_index.jsonl after writing: {error}"))?;
    if sha256_hex(&written) != expected_after_sha256 {
        return Err(format!(
            "session_index.jsonl SHA-256 verification failed after writing; the original file backup is at {}",
            backup_dir.display()
        ));
    }
    Ok(SessionIndexCleanupResult {
        pruned_entries: removed,
        backup_path: Some(backup_dir.to_string_lossy().to_string()),
    })
}

fn filter_session_index(text: &str, selected: &HashSet<String>) -> (String, usize) {
    let mut next = String::with_capacity(text.len());
    let mut removed = 0usize;
    for segment in text.split_inclusive('\n') {
        let (body_with_cr, newline) = segment
            .strip_suffix('\n')
            .map_or((segment, ""), |body| (body, "\n"));
        let body = body_with_cr.strip_suffix('\r').unwrap_or(body_with_cr);
        let remove = known_session_index_candidate(body)
            .is_some_and(|candidate| selected.contains(&candidate.id));
        if remove {
            removed += 1;
        } else {
            next.push_str(body_with_cr);
            next.push_str(newline);
        }
    }
    (next, removed)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_locked_io_error(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::PermissionDenied
        || matches!(error.raw_os_error(), Some(32 | 33))
}
