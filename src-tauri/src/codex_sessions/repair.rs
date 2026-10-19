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
    let mut written = Vec::new();
    for (index, repair) in changed_repairs.iter().enumerate() {
        match crate::write_bytes_atomically(&repair.path, &repair.next) {
            Ok(()) => {
                restore_modified_time(&repair.path, repair.original_mtime);
                written.push(repair.clone());
            }
            Err(error) if is_locked_error_message(&error) => {
                let path = repair.path.to_string_lossy().to_string();
                if !skipped_locked_files.contains(&path) {
                    skipped_locked_files.push(path);
                }
            }
            Err(error) => {
                for previous in written.iter().rev() {
                    let _ = crate::write_bytes_atomically(&previous.path, &previous.original);
                    restore_modified_time(&previous.path, previous.original_mtime);
                }
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
                for previous in written.iter().rev() {
                    let _ = crate::write_bytes_atomically(&previous.path, &previous.original);
                    restore_modified_time(&previous.path, previous.original_mtime);
                }
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

fn build_rollout_repair(
    path: &Path,
    target_provider: &str,
) -> Result<Option<RolloutRepair>, String> {
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
    Ok(Some(RolloutRepair {
        path: path.to_path_buf(),
        original,
        next: next.into_bytes(),
        original_mtime: fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok(),
        thread_id,
        cwd,
        has_user_event,
        providers,
        encrypted_content: text.contains("encrypted_content"),
        changed,
    }))
}

fn normalize_workspace_path(value: &str) -> Option<String> {
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
        let file_name = format!(
            "{index}-{}",
            repair
                .path
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or("rollout.jsonl")
        );
        let target = directory.join("rollouts").join(&file_name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create rollout backup directory: {error}"))?;
        }
        fs::write(&target, &repair.original)
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
