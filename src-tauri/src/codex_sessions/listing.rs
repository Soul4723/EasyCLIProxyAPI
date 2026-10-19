use super::*;

pub(super) fn list_codex_sessions_from_home(
    codex_home: &Path,
    offset: usize,
    requested_limit: usize,
) -> Result<CodexSessionPage, String> {
    let limit = requested_limit.clamp(1, MAX_PAGE_SIZE);
    let fetch_limit = offset.saturating_add(limit).saturating_add(1);
    let (database_paths, mut warnings) = discover_database_paths(codex_home, false);
    let mut sessions = Vec::new();
    let mut total_session_ids = HashSet::new();
    for path in &database_paths {
        match list_sessions_from_database(path, fetch_limit) {
            Ok(mut items) => sessions.append(&mut items),
            Err(error) => warnings.push(error),
        }
        match list_session_ids_from_database(path) {
            Ok(ids) => total_session_ids.extend(ids),
            Err(error) => warnings.push(error),
        }
    }
    let (mut rollout_sessions, rollout_warnings) =
        list_sessions_from_rollouts(codex_home, &total_session_ids);
    sessions.append(&mut rollout_sessions);
    warnings.extend(rollout_warnings);
    total_session_ids.extend(
        sessions
            .iter()
            .map(|session| session_identity_key(&session.id))
            .filter(|id| !id.is_empty()),
    );
    let mut sessions = merge_session_summaries(sessions);
    sessions.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then_with(|| right.id.cmp(&left.id))
            .then_with(|| left.database_path.cmp(&right.database_path))
    });
    let has_more = sessions.len() > offset.saturating_add(limit);
    let sessions = sessions.into_iter().skip(offset).take(limit).collect();
    Ok(CodexSessionPage {
        codex_home: codex_home.to_string_lossy().to_string(),
        database_paths: database_paths
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
        sessions,
        total_count: total_session_ids.len(),
        offset,
        limit,
        has_more,
        warnings,
    })
}

fn merge_session_summaries(sessions: Vec<CodexSessionSummary>) -> Vec<CodexSessionSummary> {
    let mut merged = Vec::<CodexSessionSummary>::new();
    let mut positions = HashMap::<String, usize>::new();
    for session in sessions {
        let key = session_identity_key(&session.id);
        let Some(index) = positions.get(&key).copied() else {
            positions.insert(key, merged.len());
            merged.push(session);
            continue;
        };
        let existing = &mut merged[index];
        let candidate_is_newer = session.updated_at_ms > existing.updated_at_ms;
        if candidate_is_newer {
            let mut next = session;
            fill_missing_session_fields(&mut next, existing);
            *existing = next;
        } else {
            fill_missing_session_fields(existing, &session);
        }
    }
    merged
}

fn fill_missing_session_fields(target: &mut CodexSessionSummary, fallback: &CodexSessionSummary) {
    if target.title.trim().is_empty() {
        target.title = fallback.title.clone();
    }
    if target.cwd.trim().is_empty() {
        target.cwd = fallback.cwd.clone();
    }
    if target.model_provider.trim().is_empty() {
        target.model_provider = fallback.model_provider.clone();
    }
    if target.database_path.trim().is_empty() {
        target.database_path = fallback.database_path.clone();
    }
    if target.updated_at_ms.is_none() {
        target.updated_at_ms = fallback.updated_at_ms;
    }
}

fn list_sessions_from_rollouts(
    codex_home: &Path,
    indexed_ids: &HashSet<String>,
) -> (Vec<CodexSessionSummary>, Vec<String>) {
    let mut warnings = Vec::new();
    let metadata = match read_session_index_metadata(codex_home) {
        Ok(metadata) => metadata,
        Err(error) => {
            warnings.push(error);
            HashMap::new()
        }
    };
    let paths = match collect_rollout_files(codex_home) {
        Ok(paths) => paths,
        Err(error) => {
            warnings.push(error);
            return (Vec::new(), warnings);
        }
    };
    let mut sessions = Vec::new();
    for path in paths {
        let Some(id) = rollout_thread_id_from_file_name(&path) else {
            continue;
        };
        if indexed_ids.contains(&session_identity_key(&id)) {
            continue;
        }
        sessions.push(summarize_rollout_session(codex_home, &path, &id, &metadata));
    }
    (sessions, warnings)
}

fn read_session_index_metadata(
    codex_home: &Path,
) -> Result<HashMap<String, SessionIndexMetadata>, String> {
    let path = codex_home.join("session_index.jsonl");
    if !path.is_file() {
        return Ok(HashMap::new());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read session_index.jsonl: {error}"))?;
    let mut metadata = HashMap::new();
    for line in content.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(object) = record.as_object() else {
            continue;
        };
        let Some(id) = object
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let item = SessionIndexMetadata {
            title: object
                .get("thread_name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            updated_at_ms: object
                .get("updated_at")
                .and_then(Value::as_str)
                .and_then(parse_session_timestamp_millis),
        };
        metadata.insert(id.to_string(), item.clone());
        let normalized = normalize_thread_id(id);
        if !normalized.is_empty() {
            metadata.entry(normalized).or_insert(item);
        }
    }
    Ok(metadata)
}

fn summarize_rollout_session(
    codex_home: &Path,
    path: &Path,
    id: &str,
    metadata: &HashMap<String, SessionIndexMetadata>,
) -> CodexSessionSummary {
    let normalized_id = normalize_thread_id(id);
    let index_metadata = metadata.get(id).or_else(|| metadata.get(&normalized_id));
    let updated_at_ms = index_metadata
        .and_then(|item| item.updated_at_ms)
        .or_else(|| {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        });
    CodexSessionSummary {
        id: id.to_string(),
        title: index_metadata
            .map(|item| item.title.clone())
            .unwrap_or_default(),
        cwd: String::new(),
        model_provider: String::new(),
        archived: path.starts_with(codex_home.join("archived_sessions")),
        updated_at_ms,
        database_path: String::new(),
    }
}

fn parse_session_timestamp_millis(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(value) = value.parse::<i64>() {
        return Some(if value.abs() < 100_000_000_000 {
            value.saturating_mul(1_000)
        } else {
            value
        });
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

fn list_sessions_from_database(
    path: &Path,
    limit: usize,
) -> Result<Vec<CodexSessionSummary>, String> {
    let connection = open_read_only(path)?;
    let mut sessions = Vec::new();
    if table_exists(&connection, "threads")? {
        sessions.extend(list_thread_rows(&connection, path, limit)?);
    }
    if table_exists(&connection, "automation_runs")? {
        sessions.extend(list_automation_rows(&connection, path, limit)?);
    }
    Ok(sessions)
}

fn list_session_ids_from_database(path: &Path) -> Result<HashSet<String>, String> {
    let connection = open_read_only(path)?;
    let mut ids = HashSet::new();
    for (table, column) in [("threads", "id"), ("automation_runs", "thread_id")] {
        let columns = table_columns(&connection, table)?;
        if !columns.contains(column) {
            continue;
        }
        let sql = format!(
            "SELECT DISTINCT \"{column}\" FROM \"{table}\" WHERE COALESCE(\"{column}\", '') <> ''"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| format!("Failed to count sessions {}: {error}", path.display()))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Failed to count sessions {}: {error}", path.display()))?;
        for id in rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Failed to count sessions {}: {error}", path.display()))?
        {
            let id = session_identity_key(&id);
            if !id.is_empty() {
                ids.insert(id);
            }
        }
    }
    Ok(ids)
}

fn list_thread_rows(
    connection: &Connection,
    path: &Path,
    limit: usize,
) -> Result<Vec<CodexSessionSummary>, String> {
    let columns = table_columns(connection, "threads")?;
    if !columns.contains("id") {
        return Ok(Vec::new());
    }
    let title = if columns.contains("title") && columns.contains("name") {
        "COALESCE(NULLIF(title, ''), NULLIF(name, ''), '')"
    } else {
        optional_column(&columns, "title", optional_column(&columns, "name", "''"))
    };
    let cwd = optional_column(&columns, "cwd", "''");
    let provider = optional_column(&columns, "model_provider", "''");
    let archived = optional_column(&columns, "archived", "0");
    let updated = if columns.contains("updated_at_ms") {
        "updated_at_ms".to_string()
    } else if columns.contains("updated_at") {
        normalized_millis_expression("updated_at")
    } else if columns.contains("created_at_ms") {
        "created_at_ms".to_string()
    } else if columns.contains("created_at") {
        normalized_millis_expression("created_at")
    } else {
        "NULL".to_string()
    };
    let sql = format!(
        "SELECT id, {title}, {cwd}, {provider}, {archived}, {updated} FROM threads ORDER BY COALESCE({updated}, 0) DESC, id DESC LIMIT ?1"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to read session database {}: {error}", path.display()))?;
    let rows = statement
        .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
            Ok(CodexSessionSummary {
                id: row.get(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                cwd: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                model_provider: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                archived: row.get::<_, Option<i64>>(4)?.unwrap_or_default() != 0,
                updated_at_ms: row.get(5)?,
                database_path: path.to_string_lossy().to_string(),
            })
        })
        .map_err(|error| format!("Failed to read session database {}: {error}", path.display()))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Failed to read session database {}: {error}", path.display()))
}

fn list_automation_rows(
    connection: &Connection,
    path: &Path,
    limit: usize,
) -> Result<Vec<CodexSessionSummary>, String> {
    let columns = table_columns(connection, "automation_runs")?;
    if !columns.contains("thread_id") {
        return Ok(Vec::new());
    }
    let title = optional_column(&columns, "thread_title", "''");
    let cwd = optional_column(&columns, "source_cwd", "''");
    let status = optional_column(&columns, "status", "''");
    let updated = if columns.contains("updated_at") {
        normalized_millis_expression("updated_at")
    } else if columns.contains("created_at") {
        normalized_millis_expression("created_at")
    } else {
        "NULL".to_string()
    };
    let sql = format!(
        "SELECT thread_id, {title}, {cwd}, {status}, {updated} FROM automation_runs WHERE COALESCE(thread_id, '') <> '' ORDER BY COALESCE({updated}, 0) DESC, thread_id DESC LIMIT ?1"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to read automation session database {}: {error}", path.display()))?;
    let rows = statement
        .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
            let status = row.get::<_, Option<String>>(3)?.unwrap_or_default();
            Ok(CodexSessionSummary {
                id: row.get(0)?,
                title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                cwd: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                model_provider: String::new(),
                archived: status.eq_ignore_ascii_case("archived"),
                updated_at_ms: row.get(4)?,
                database_path: path.to_string_lossy().to_string(),
            })
        })
        .map_err(|error| format!("Failed to read automation session database {}: {error}", path.display()))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Failed to read automation session database {}: {error}", path.display()))
}

pub(super) fn normalize_thread_id(value: &str) -> String {
    value
        .trim()
        .strip_prefix("local:")
        .unwrap_or(value.trim())
        .trim()
        .to_string()
}

fn session_identity_key(value: &str) -> String {
    let normalized = normalize_thread_id(value);
    if normalized.is_empty() {
        value.trim().to_string()
    } else {
        normalized
    }
}
