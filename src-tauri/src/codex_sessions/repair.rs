use super::*;

pub(super) fn resolve_current_codex_provider(codex_home: &Path) -> Result<String, String> {
    let path = codex_home.join("config.toml");
    if !path.is_file() {
        return Ok("openai".to_string());
    }
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read Codex configuration {}: {error}", path.display()))?;
    let document = text
        .parse::<toml::Value>()
        .map_err(|error| format!("Failed to parse Codex configuration: {error}"))?;
    Ok(document
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
        .unwrap_or("openai")
        .to_string())
}

pub(super) fn repair_codex_session_metadata_from_home<F>(
    codex_home: &Path,
    target_provider: &str,
    mut progress: F,
) -> Result<CodexSessionRepairResult, String>
where
    F: FnMut(CodexSessionRepairProgress),
{
    let target_provider = target_provider.trim();
    if target_provider.is_empty() {
        return Err("Current Codex provider cannot be empty".to_string());
    }
    let _guard = CODEX_SESSION_WRITE_LOCK
        .lock()
        .map_err(|_| "Codex session write lock is poisoned".to_string())?;
    progress(CodexSessionRepairProgress {
        phase: "scanning".to_string(),
        percent: 10,
        processed: 0,
        total: 0,
    });
    let rollout_paths = collect_rollout_files(codex_home)?;
    let total = rollout_paths.len();
    let mut repairs = Vec::new();
    let mut skipped_locked_files = Vec::new();
    let mut warnings = Vec::new();
    for (index, path) in rollout_paths.iter().enumerate() {
        match build_rollout_repair(path, target_provider) {
            Ok(Some(repair)) => repairs.push(repair),
            Ok(None) => {}
            Err(error) if is_locked_error_message(&error) => {
                skipped_locked_files.push(path.to_string_lossy().to_string());
            }
            Err(error) => warnings.push(error),
        }
        if index % 25 == 0 || index + 1 == total {
            progress(CodexSessionRepairProgress {
                phase: "scanning".to_string(),
                percent: 10 + (((index + 1) * 25 / total.max(1)) as u8),
                processed: index + 1,
                total,
            });
        }
    }
    let projectless = load_projectless_thread_ids(codex_home)?;
    let (database_paths, database_warnings) = discover_database_paths(codex_home, false);
    warnings.extend(database_warnings);
    let (sqlite_updates_needed, database_count_warnings) =
        count_sqlite_repairs(&database_paths, &repairs, &projectless, target_provider)?;
    let sqlite_scan_incomplete = !database_count_warnings.is_empty();
    warnings.extend(database_count_warnings);
    let changed_repairs = repairs
        .iter()
        .filter(|repair| repair.changed)
        .cloned()
        .collect::<Vec<_>>();
    let backup_path =
        if changed_repairs.is_empty() && sqlite_updates_needed == 0 && !sqlite_scan_incomplete {
            None
        } else {
            progress(CodexSessionRepairProgress {
                phase: "backingUp".to_string(),
                percent: 45,
                processed: 0,
                total: changed_repairs.len(),
            });
            Some(create_repair_backup(
                codex_home,
                &database_paths,
                &changed_repairs,
                "provider-repair",
                target_provider,
            )?)
        };
    progress(CodexSessionRepairProgress {
        phase: "rewriting".to_string(),
        percent: 60,
        processed: 0,
        total: changed_repairs.len(),
    });
    // Each rollout is rebuilt from disk and written on its own, so only one file's rewritten
    // bytes are in memory at a time. Rollback restores from the backup copies for the same reason.
    let mut written: Vec<(usize, &RolloutRepair)> = Vec::new();
    for (index, repair) in changed_repairs.iter().enumerate() {
        match rewrite_rollout(repair, target_provider) {
            Ok(RewriteOutcome::Written) => written.push((index, repair)),
            Ok(RewriteOutcome::Locked) => {
                let path = repair.path.to_string_lossy().to_string();
                if !skipped_locked_files.contains(&path) {
                    skipped_locked_files.push(path);
                }
            }
            Ok(RewriteOutcome::Skipped(warning)) => warnings.push(warning),
            Err(error) => {
                rollback_rollouts(&written, backup_path.as_deref());
                return Err(format!("Failed to write historical session; rollback attempted: {error}"));
            }
        }
        progress(CodexSessionRepairProgress {
            phase: "rewriting".to_string(),
            percent: 60 + (((index + 1) * 20 / changed_repairs.len().max(1)) as u8),
            processed: index + 1,
            total: changed_repairs.len(),
        });
    }
    progress(CodexSessionRepairProgress {
        phase: "updatingDatabase".to_string(),
        percent: 85,
        processed: 0,
        total: database_paths.len(),
    });
    let sqlite_rows_updated =
        match apply_sqlite_repairs(&database_paths, &repairs, &projectless, target_provider) {
            Ok((updated, database_lock_warnings)) => {
                warnings.extend(database_lock_warnings);
                updated
            }
            Err(error) => {
                rollback_rollouts(&written, backup_path.as_deref());
                return Err(format!(
                    "Failed to update session database; rollout rollback attempted and backup retained: {error}"
                ));
            }
        };
    if backup_path.is_some() {
        prune_repair_backups(codex_home)?;
    }
    let encrypted_content_warning = encrypted_content_warning(&repairs, target_provider);
    progress(CodexSessionRepairProgress {
        phase: "complete".to_string(),
        percent: 100,
        processed: total,
        total,
    });
    Ok(CodexSessionRepairResult {
        target_provider: target_provider.to_string(),
        changed_rollout_files: written.len(),
        sqlite_rows_updated,
        skipped_locked_files,
        backup_path: backup_path.map(|path| path.to_string_lossy().to_string()),
        encrypted_content_warning,
        warnings,
    })
}

pub(super) fn collect_rollout_files(codex_home: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for directory in SESSION_DIRS {
        collect_rollout_files_recursive(&codex_home.join(directory), &mut files)?;
    }
    files.sort();
    Ok(files)
}

fn collect_rollout_files_recursive(root: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(root)
        .map_err(|error| format!("Failed to scan session directory {}: {error}", root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read session directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to read session directory entry type: {error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_rollout_files_recursive(&path, files)?;
        } else if file_type.is_file() && path.extension().and_then(OsStr::to_str) == Some("jsonl") {
            files.push(path);
        }
    }
    Ok(())
}

/// Cheap pre-filter for rollout lines: false means the line cannot be a top-level
/// `{"type":"session_meta"}` record, so it is neither parsed nor rewritten.
///
/// The parser accepts a record only when it decodes to a `type` string equal to
/// `session_meta`. A JSON string can reach that value only by spelling the literal
/// `session_meta` or by escaping at least one of its characters, and every character of
/// `session_meta` (and of `type`) is ASCII in 0x50..=0x7f, so an escaped spelling needs a
/// `\u005x`..`\u007x` escape (JSON has no short escape for them). A line with neither
/// is never a match; any false positive is simply parsed and rejected as before.
pub(super) fn may_be_session_meta(line: &str) -> bool {
    line.contains("session_meta")
        || line
            .match_indices("\\u00")
            .any(|(index, _)| matches!(line.as_bytes().get(index + 4), Some(b'5'..=b'7')))
}

pub(super) struct RolloutScan {
    original_len: u64,
    original_mtime: Option<SystemTime>,
    session_meta_count: usize,
    thread_id: Option<String>,
    cwd: Option<String>,
    providers: Vec<String>,
    has_user_event: bool,
    encrypted_content: bool,
    changed: bool,
}

/// Streams one rollout line by line (memory is bounded by the longest line). When `output` is
/// given the rewritten bytes are appended to it, otherwise only the metadata is collected.
pub(super) fn scan_rollout(
    path: &Path,
    target_provider: &str,
    mut output: Option<&mut Vec<u8>>,
) -> Result<RolloutScan, String> {
    let read_error = |error: std::io::Error| format!("Failed to read rollout {}: {error}", path.display());
    let file = fs::File::open(path).map_err(read_error)?;
    let metadata = file.metadata().map_err(read_error)?;
    let mut scan = RolloutScan {
        original_len: metadata.len(),
        original_mtime: metadata.modified().ok(),
        session_meta_count: 0,
        thread_id: None,
        cwd: None,
        providers: Vec::new(),
        has_user_event: false,
        encrypted_content: false,
        changed: false,
    };
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        if reader.read_until(b'\n', &mut bytes).map_err(read_error)? == 0 {
            break;
        }
        let segment = std::str::from_utf8(&bytes)
            .map_err(|error| format!("Rollout is not UTF-8 {}: {error}", path.display()))?;
        let (body_with_cr, newline) = segment
            .strip_suffix('\n')
            .map_or((segment, ""), |body| (body, "\n"));
        let (body, carriage) = body_with_cr
            .strip_suffix('\r')
            .map_or((body_with_cr, ""), |body| (body, "\r"));
        scan.has_user_event |= body.contains("\"user_message\"") || body.contains("\"user_input\"");
        scan.encrypted_content |= body.contains("encrypted_content");
        let mut rewritten = None;
        if may_be_session_meta(body) {
            if let Ok(mut record) = serde_json::from_str::<Value>(body) {
                if record.get("type").and_then(Value::as_str) == Some("session_meta") {
                    if let Some(payload) = record.get_mut("payload").and_then(Value::as_object_mut) {
                        scan.session_meta_count += 1;
                        if scan.thread_id.is_none() {
                            scan.thread_id = payload
                                .get("id")
                                .and_then(Value::as_str)
                                .filter(|value| !value.trim().is_empty())
                                .map(ToString::to_string);
                        }
                        if scan.cwd.is_none() {
                            scan.cwd = payload
                                .get("cwd")
                                .and_then(Value::as_str)
                                .and_then(normalize_workspace_path);
                        }
                        if let Some(provider) = payload.get("model_provider").and_then(Value::as_str) {
                            scan.providers.push(provider.to_string());
                        }
                        if payload.get("model_provider").and_then(Value::as_str)
                            != Some(target_provider)
                        {
                            payload.insert("model_provider".to_string(), json!(target_provider));
                            rewritten = Some(
                                serde_json::to_string(&record)
                                    .map_err(|error| format!("Failed to serialize session_meta: {error}"))?,
                            );
                            scan.changed = true;
                        }
                    }
                }
            }
        }
        if let Some(output) = output.as_mut() {
            output.extend_from_slice(rewritten.as_deref().unwrap_or(body).as_bytes());
            output.extend_from_slice(carriage.as_bytes());
            output.extend_from_slice(newline.as_bytes());
        }
    }
    Ok(scan)
}

/// Metadata-only pass: a changed rollout's rewritten bytes are rebuilt from disk right before
/// it is written, so nothing proportional to the file sizes is kept between files.
pub(super) fn build_rollout_repair(
    path: &Path,
    target_provider: &str,
) -> Result<Option<RolloutRepair>, String> {
    let scan = scan_rollout(path, target_provider, None)?;
    if scan.session_meta_count == 0 {
        return Ok(None);
    }
    Ok(Some(RolloutRepair {
        path: path.to_path_buf(),
        original_len: scan.original_len,
        original_mtime: scan.original_mtime,
        thread_id: scan.thread_id,
        cwd: scan.cwd,
        has_user_event: scan.has_user_event,
        providers: scan.providers,
        encrypted_content: scan.encrypted_content,
        changed: scan.changed,
    }))
}

pub(super) enum RewriteOutcome {
    Written,
    Locked,
    Skipped(String),
}

fn rollout_matches_scan(path: &Path, repair: &RolloutRepair) -> bool {
    fs::metadata(path).is_ok_and(|metadata| {
        metadata.len() == repair.original_len && metadata.modified().ok() == repair.original_mtime
    })
}

/// Rebuilds one changed rollout and writes it atomically. A file that no longer matches what the
/// scan (and therefore the backup) saw is skipped rather than overwritten. `Err` is only a failed
/// write, which the caller answers with a rollback.
pub(super) fn rewrite_rollout(repair: &RolloutRepair, target_provider: &str) -> Result<RewriteOutcome, String> {
    let path = repair.path.as_path();
    let stale = || {
        RewriteOutcome::Skipped(format!(
            "Rollout changed during repair; left untouched {}",
            path.display()
        ))
    };
    if !rollout_matches_scan(path, repair) {
        return Ok(stale());
    }
    let mut next = Vec::with_capacity(repair.original_len as usize);
    match scan_rollout(path, target_provider, Some(&mut next)) {
        Ok(_) => {}
        Err(error) if is_locked_error_message(&error) => return Ok(RewriteOutcome::Locked),
        Err(error) => return Ok(RewriteOutcome::Skipped(error)),
    }
    if !rollout_matches_scan(path, repair) {
        return Ok(stale());
    }
    match crate::write_bytes_atomically(path, &next) {
        Ok(()) => {
            restore_modified_time(path, repair.original_mtime);
            Ok(RewriteOutcome::Written)
        }
        Err(error) if is_locked_error_message(&error) => Ok(RewriteOutcome::Locked),
        Err(error) => Err(error),
    }
}

fn backup_rollout_file_name(index: usize, path: &Path) -> String {
    format!(
        "{index}-{}",
        path.file_name().and_then(OsStr::to_str).unwrap_or("rollout.jsonl")
    )
}

/// Puts back the original bytes of already written rollouts from the backup copies.
pub(super) fn rollback_rollouts(written: &[(usize, &RolloutRepair)], backup_directory: Option<&Path>) {
    let Some(backup_directory) = backup_directory else {
        return;
    };
    for (index, repair) in written.iter().rev() {
        let backup = backup_directory
            .join("rollouts")
            .join(backup_rollout_file_name(*index, &repair.path));
        let Ok(original) = fs::read(&backup) else {
            continue;
        };
        if original.len() as u64 != repair.original_len {
            continue;
        }
        let _ = crate::write_bytes_atomically(&repair.path, &original);
        restore_modified_time(&repair.path, repair.original_mtime);
    }
}

pub(super) fn normalize_workspace_path(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with(r"\\?\unc\") {
        return Some(format!(r"\\{}", value[8..].replace('/', r"\")));
    }
    if let Some(stripped) = value.strip_prefix(r"\\?\") {
        return Some(stripped.replace('\\', "/"));
    }
    Some(value.to_string())
}

pub(super) fn is_locked_error_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("os error 32")
        || lower.contains("os error 33")
        || lower.contains("database is locked")
        || lower.contains("database is busy")
        || lower.contains("sharing violation")
        || lower.contains("being used by another process")
        || lower.contains("permission denied")
        || lower.contains("access is denied")
}

fn load_projectless_thread_ids(codex_home: &Path) -> Result<HashSet<String>, String> {
    let path = codex_home.join(".codex-global-state.json");
    if !path.is_file() {
        return Ok(HashSet::new());
    }
    let value = serde_json::from_str::<Value>(
        &fs::read_to_string(&path).map_err(|error| format!("Failed to read Codex global state: {error}"))?,
    )
    .map_err(|error| format!("Failed to parse Codex global state: {error}"))?;
    Ok(value
        .get("projectless-thread-ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(ToString::to_string)
        .collect())
}

fn repair_maps(
    repairs: &[RolloutRepair],
    projectless: &HashSet<String>,
) -> (HashSet<String>, HashMap<String, String>) {
    let user_event_ids = repairs
        .iter()
        .filter(|repair| repair.has_user_event)
        .filter_map(|repair| repair.thread_id.clone())
        .collect::<HashSet<_>>();
    let cwd_by_id = repairs
        .iter()
        .filter_map(|repair| Some((repair.thread_id.clone()?, repair.cwd.clone()?)))
        .filter(|(id, _)| !projectless.contains(id))
        .collect::<HashMap<_, _>>();
    (user_event_ids, cwd_by_id)
}

fn count_sqlite_repairs(
    paths: &[PathBuf],
    repairs: &[RolloutRepair],
    projectless: &HashSet<String>,
    target_provider: &str,
) -> Result<(usize, Vec<String>), String> {
    let (user_event_ids, cwd_by_id) = repair_maps(repairs, projectless);
    let mut total = 0usize;
    let mut warnings = Vec::new();
    for path in paths {
        let count_result = (|| -> Result<usize, String> {
            let connection = open_read_only(path)?;
            let columns = table_columns(&connection, "threads")?;
            let mut count = 0usize;
            if columns.contains("model_provider") {
                count += connection
                    .query_row(
                        "SELECT COUNT(*) FROM threads WHERE COALESCE(model_provider, '') <> ?1",
                        [target_provider],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|error| format!("Failed to count provider migration rows: {error}"))?
                    as usize;
            }
            if columns.contains("has_user_event") {
                for id in &user_event_ids {
                    count += connection
                        .query_row(
                            "SELECT COUNT(*) FROM threads WHERE id = ?1 AND COALESCE(has_user_event, 0) <> 1",
                            [id],
                            |row| row.get::<_, i64>(0),
                        )
                        .map_err(|error| format!("Failed to count session visibility update rows: {error}"))?
                        as usize;
                }
            }
            if columns.contains("cwd") {
                for (id, cwd) in &cwd_by_id {
                    count += connection
                        .query_row(
                            "SELECT COUNT(*) FROM threads WHERE id = ?1 AND COALESCE(cwd, '') <> ?2",
                            (id, cwd),
                            |row| row.get::<_, i64>(0),
                        )
                        .map_err(|error| format!("Failed to count project path update rows: {error}"))?
                        as usize;
                }
            }
            Ok(count)
        })();
        match count_result {
            Ok(count) => total += count,
            Err(error) if is_locked_error_message(&error) => warnings.push(format!(
                "Database is in use; cannot pre-count synchronization rows {}: {error}",
                path.display()
            )),
            Err(error) => return Err(error),
        }
    }
    Ok((total, warnings))
}

fn apply_sqlite_repairs(
    paths: &[PathBuf],
    repairs: &[RolloutRepair],
    projectless: &HashSet<String>,
    target_provider: &str,
) -> Result<(usize, Vec<String>), String> {
    let (user_event_ids, cwd_by_id) = repair_maps(repairs, projectless);
    let mut total = 0usize;
    let mut warnings = Vec::new();
    for path in paths {
        let update_result = (|| -> Result<usize, String> {
            let mut connection = open_read_write(path)?;
            let columns = table_columns(&connection, "threads")?;
            if columns.is_empty() {
                return Ok(0);
            }
            let transaction = connection
                .transaction()
                .map_err(|error| format!("Failed to begin historical session restoration transaction {}: {error}", path.display()))?;
            let mut updated = 0usize;
            if columns.contains("model_provider") {
                updated += transaction
                    .execute(
                        "UPDATE threads SET model_provider = ?1 WHERE COALESCE(model_provider, '') <> ?1",
                        [target_provider],
                    )
                    .map_err(|error| format!("Failed to update session provider: {error}"))?;
            }
            if columns.contains("has_user_event") {
                for id in &user_event_ids {
                    updated += transaction
                        .execute(
                            "UPDATE threads SET has_user_event = 1 WHERE id = ?1 AND COALESCE(has_user_event, 0) <> 1",
                            [id],
                        )
                        .map_err(|error| format!("Failed to update session user-event flag: {error}"))?;
                }
            }
            if columns.contains("cwd") {
                for (id, cwd) in &cwd_by_id {
                    updated += transaction
                        .execute(
                            "UPDATE threads SET cwd = ?1 WHERE id = ?2 AND COALESCE(cwd, '') <> ?1",
                            (cwd, id),
                        )
                        .map_err(|error| format!("Failed to update session project path: {error}"))?;
                }
            }
            transaction
                .commit()
                .map_err(|error| format!("Failed to commit historical session restoration transaction {}: {error}", path.display()))?;
            Ok(updated)
        })();
        match update_result {
            Ok(updated) => total += updated,
            Err(error) if is_locked_error_message(&error) => warnings.push(format!(
                "Database is in use; skipped this synchronization {}: {error}",
                path.display()
            )),
            Err(error) => return Err(error),
        }
    }
    Ok((total, warnings))
}

pub(super) fn create_repair_backup(
    codex_home: &Path,
    database_paths: &[PathBuf],
    repairs: &[RolloutRepair],
    label: &str,
    target_provider: &str,
) -> Result<PathBuf, String> {
    let directory = create_operation_directory(codex_home, "session-repair", label)?;
    for name in [
        "config.toml",
        ".codex-global-state.json",
        ".codex-global-state.json.bak",
    ] {
        let source = codex_home.join(name);
        if source.is_file() {
            fs::copy(&source, directory.join(name))
                .map_err(|error| format!("Failed to back up {name}: {error}"))?;
        }
    }
    let sqlite_home = resolve_sqlite_home(codex_home);
    let mut database_files = Vec::new();
    for database_path in database_paths {
        for source in sqlite_sidecar_paths(database_path) {
            if !source.is_file() {
                continue;
            }
            let relative = source
                .strip_prefix(&sqlite_home)
                .unwrap_or(source.as_path())
                .to_path_buf();
            let target = directory.join("databases").join(&relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Failed to create database backup directory: {error}"))?;
            }
            fs::copy(&source, &target)
                .map_err(|error| format!("Failed to back up database {}: {error}", source.display()))?;
            database_files.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }
    let mut rollout_files = Vec::new();
    for (index, repair) in repairs.iter().enumerate() {
        let file_name = backup_rollout_file_name(index, &repair.path);
        let target = directory.join("rollouts").join(&file_name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create rollout backup directory: {error}"))?;
        }
        fs::copy(&repair.path, &target)
            .map_err(|error| format!("Failed to back up rollout {}: {error}", repair.path.display()))?;
        rollout_files.push(json!({
            "originalPath": repair.path.to_string_lossy(),
            "backupPath": format!("rollouts/{file_name}")
        }));
    }
    write_json_atomically(
        &directory.join("metadata.json"),
        &json!({
            "schemaVersion": 1,
            "kind": label,
            "createdAt": Utc::now().to_rfc3339(),
            "targetProvider": target_provider,
            "databaseFiles": database_files,
            "rolloutFiles": rollout_files,
            "managedBy": "EasyCLIProxyAPI"
        }),
    )?;
    Ok(directory)
}

fn sqlite_sidecar_paths(path: &Path) -> [PathBuf; 3] {
    [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.to_string_lossy())),
        PathBuf::from(format!("{}-shm", path.to_string_lossy())),
    ]
}

fn restore_modified_time(path: &Path, modified: Option<SystemTime>) {
    let Some(modified) = modified else {
        return;
    };
    if let Ok(file) = fs::File::options().write(true).open(path) {
        let _ = file.set_times(fs::FileTimes::new().set_modified(modified));
    }
}

pub(super) fn encrypted_content_warning(repairs: &[RolloutRepair], target_provider: &str) -> Option<String> {
    let mut providers = repairs
        .iter()
        .filter(|repair| repair.encrypted_content)
        .flat_map(|repair| repair.providers.iter().cloned())
        .filter(|provider| provider != target_provider)
        .collect::<Vec<_>>();
    providers.sort();
    providers.dedup();
    if providers.is_empty() {
        return None;
    }
    Some(format!(
        "Some historical sessions contain encrypted_content from {}; metadata was synchronized to {}, but continuing or compacting these sessions may fail.",
        providers.join("、"),
        target_provider
    ))
}

pub(super) fn prune_repair_backups(codex_home: &Path) -> Result<(), String> {
    let root = codex_home
        .join("backups_state")
        .join("easy-cli-proxy-api")
        .join("session-repair");
    if !root.is_dir() {
        return Ok(());
    }
    let mut directories = fs::read_dir(&root)
        .map_err(|error| format!("Failed to read historical session restoration backup: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .collect::<Vec<_>>();
    directories.sort_by_key(|entry| entry.file_name());
    let remove_count = directories.len().saturating_sub(REPAIR_BACKUP_KEEP_COUNT);
    for entry in directories.into_iter().take(remove_count) {
        let path = entry.path();
        if path.starts_with(&root) {
            fs::remove_dir_all(&path).map_err(|error| {
                format!("Failed to clean up old historical session restoration backup {}: {error}", path.display())
            })?;
        }
    }
    Ok(())
}
