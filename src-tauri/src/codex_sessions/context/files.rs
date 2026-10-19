use super::*;

pub(super) fn discover_thread_history_databases(codex_home: &Path) -> Vec<PathBuf> {
    let sqlite_home = resolve_sqlite_home(codex_home);
    let mut candidates = Vec::new();
    let scan_directories = [
        codex_home.to_path_buf(),
        sqlite_home.clone(),
        sqlite_home.join("sqlite"),
    ];
    for directory in scan_directories {
        if let Ok(entries) = fs::read_dir(&directory) {
            for entry in entries.flatten() {
                let candidate_path = entry.path();
                if candidate_path.is_file() && sqlite_candidate(&candidate_path) {
                    if let Some(file_name) = candidate_path.file_name().and_then(OsStr::to_str) {
                        if file_name.starts_with("thread_history")
                            && !candidates.contains(&candidate_path)
                        {
                            candidates.push(candidate_path);
                        }
                    }
                }
            }
        }
    }
    candidates.sort();
    candidates
}

pub(super) fn acquire_session_writer_lock(codex_home: &Path, session_id: &str) -> Result<fs::File, String> {
    let lock_directory = codex_home.join("thread-writer-locks");
    ensure_context_path_in_home(codex_home, &lock_directory)?;
    fs::create_dir_all(&lock_directory).map_err(|error| {
        format!(
            "Failed to create session writer lock directory {}: {error}",
            lock_directory.display()
        )
    })?;
    // Codex coordinates lock-file cleanup and rollout publication before opening
    // the per-thread lock. Honor that same order to avoid locking a stale inode.
    let _coordination = acquire_context_lock_file(
        codex_home,
        &lock_directory.join(".coordination.lock"),
        "Codex writer coordination is busy. Retry after current writes finish",
    )?;
    let lock_path = lock_directory.join(format!("{session_id}.lock"));
    acquire_context_lock_file(
        codex_home, &lock_path,
        &format!("Session {session_id} is currently active. Close the session before editing its context"),
    )
}

pub(super) fn acquire_context_lock_file(
    codex_home: &Path,
    lock_path: &Path,
    busy_message: &str,
) -> Result<fs::File, String> {
    ensure_context_path_in_home(codex_home, lock_path)?;
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
    {
        Ok(file) => file,
        Err(error) if is_locked_io_error(&error) => {
            return Err(busy_message.to_string());
        }
        Err(error) => {
            return Err(format!(
                "Failed to verify the session writer lock {}: {error}",
                lock_path.display()
            ));
        }
    };
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(busy_message.to_string()),
        Err(std::fs::TryLockError::Error(error)) if is_locked_io_error(&error) => {
            Err(busy_message.to_string())
        }
        Err(std::fs::TryLockError::Error(error)) => Err(format!(
            "Failed to verify the session writer lock {}: {error}",
            lock_path.display()
        )),
    }
}

pub(super) fn validate_session_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("Session ID cannot be empty".to_string());
    }
    if trimmed.len() > 128 {
        return Err("Session ID exceeds maximum length".to_string());
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.contains(':')
    {
        return Err("Session ID contains invalid path characters".to_string());
    }
    if !trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return Err("Session ID contains disallowed characters".to_string());
    }
    Ok(trimmed.to_string())
}

pub(super) fn find_rollout_for_session(
    codex_home: &Path,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    let (database_paths, _) = discover_database_paths(codex_home, false);
    for db_path in &database_paths {
        if let Ok(conn) = open_read_only(db_path) {
            if let Ok(true) = table_exists(&conn, "threads") {
                if let Ok(mut stmt) =
                    conn.prepare("SELECT rollout_path FROM threads WHERE id = ?1 LIMIT 1")
                {
                    if let Ok(mut rows) = stmt.query([session_id]) {
                        if let Ok(Some(row)) = rows.next() {
                            if let Ok(Some(path_str)) = row.get::<_, Option<String>>(0) {
                                let path = PathBuf::from(&path_str);
                                if let Some(validated) = validated_rollout_path(codex_home, &path)?
                                {
                                    return Ok(Some(validated));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if let Ok(rollout_files) = collect_rollout_files(codex_home) {
        for path in &rollout_files {
            if let Some(id) = rollout_thread_id_from_file_name(path) {
                if id == session_id {
                    return validated_rollout_path(codex_home, path);
                }
            }
        }
    }
    Ok(None)
}

pub(super) fn prune_context_edit_backups(codex_home: &Path) -> Result<(), String> {
    let root = codex_home
        .join("backups_state")
        .join("easy-cli-proxy-api")
        .join("session-context-edits");
    if !root.is_dir() {
        return Ok(());
    }
    ensure_context_path_in_home(codex_home, &root)?;
    let mut directories = fs::read_dir(&root)
        .map_err(|error| format!("Failed to read context edit backup directory: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_dir()))
        .collect::<Vec<_>>();
    directories.sort_by_key(|entry| entry.file_name());
    let keep_count = 10;
    let remove_count = directories.len().saturating_sub(keep_count);
    for entry in directories.into_iter().take(remove_count) {
        let _ = fs::remove_dir_all(entry.path());
    }
    Ok(())
}

pub(super) fn find_session_database_path(
    codex_home: &Path,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    let (database_paths, warnings) = discover_database_paths(codex_home, false);
    if !warnings.is_empty() {
        return Err(format!(
            "Unable to safely inspect all Codex session databases; saving aborted: {}",
            warnings.join("; ")
        ));
    }
    let mut matches = Vec::new();
    for path in database_paths {
        let connection = open_read_only(&path)?;
        if !table_columns(&connection, "threads")?.contains("id") {
            continue;
        }
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM threads WHERE id = ?1)",
                [session_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| {
                format!(
                    "Failed to locate session {session_id} in {}: {error}",
                    path.display()
                )
            })?
            != 0;
        if exists {
            matches.push(path);
        }
    }
    if matches.len() > 1 {
        return Err(format!(
            "Session {session_id} exists in multiple Codex databases; refusing an ambiguous update"
        ));
    }
    Ok(matches.pop())
}

pub(super) fn rollout_archive_target(
    codex_home: &Path,
    current_path: &Path,
    archived: Option<bool>,
) -> Result<PathBuf, String> {
    let Some(archived) = archived else {
        return Ok(current_path.to_path_buf());
    };
    let archived_root = validated_session_root(codex_home, "archived_sessions")?;
    let sessions_root = validated_session_root(codex_home, "sessions")?;
    let current_is_archived = is_archived_rollout_path(codex_home, current_path);
    if archived == current_is_archived {
        return Ok(current_path.to_path_buf());
    }
    let file_name = current_path
        .file_name()
        .ok_or_else(|| format!("Rollout path has no file name: {}", current_path.display()))?;
    if archived {
        return Ok(archived_root.join(file_name));
    }
    let name = file_name.to_string_lossy();
    let date = name
        .strip_prefix("rollout-")
        .and_then(|value| value.get(..10))
        .filter(|value| {
            value
                .chars()
                .enumerate()
                .all(|(index, character)| match index {
                    4 | 7 => character == '-',
                    _ => character.is_ascii_digit(),
                })
        });
    let target_dir = date.map_or(sessions_root.clone(), |date| {
        sessions_root
            .join(&date[0..4])
            .join(&date[5..7])
            .join(&date[8..10])
    });
    Ok(target_dir.join(file_name))
}

pub(super) fn is_archived_rollout_path(codex_home: &Path, path: &Path) -> bool {
    let Ok(archived_root) = fs::canonicalize(codex_home.join("archived_sessions")) else {
        return false;
    };
    path.starts_with(archived_root)
}

pub(super) fn validated_session_root(codex_home: &Path, directory: &str) -> Result<PathBuf, String> {
    let home = fs::canonicalize(codex_home).map_err(|error| {
        format!(
            "Failed to resolve Codex home {}: {error}",
            codex_home.display()
        )
    })?;
    let root = codex_home.join(directory);
    match fs::symlink_metadata(&root) {
        Ok(_) => {
            let canonical = fs::canonicalize(&root).map_err(|error| {
                format!(
                    "Failed to resolve session directory {}: {error}",
                    root.display()
                )
            })?;
            if !canonical.starts_with(&home) {
                return Err(format!(
                    "Session directory {} resolves outside Codex home",
                    root.display()
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to inspect session directory {}: {error}",
                root.display()
            ));
        }
    }
    Ok(root)
}

pub(super) fn ensure_context_path_in_home(codex_home: &Path, path: &Path) -> Result<(), String> {
    let home = fs::canonicalize(codex_home)
        .map_err(|error| format!("Failed to resolve Codex home: {error}"))?;
    let mut ancestor = path;
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(_) => {
                let canonical = fs::canonicalize(ancestor).map_err(|error| {
                    format!(
                        "Failed to resolve context path {}: {error}",
                        ancestor.display()
                    )
                })?;
                if !canonical.starts_with(&home) {
                    return Err(format!(
                        "Context path {} resolves outside Codex home",
                        path.display()
                    ));
                }
                return Ok(());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| "Context path has no existing parent".to_string())?;
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect context path {}: {error}",
                    ancestor.display()
                ))
            }
        }
    }
}
