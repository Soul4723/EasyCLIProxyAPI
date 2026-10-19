use super::*;

pub(super) fn delete_codex_sessions_from_home(
    codex_home: &Path,
    session_ids: Vec<String>,
) -> Result<CodexSessionDeleteBatchResult, String> {
    let _guard = CODEX_SESSION_WRITE_LOCK
        .lock()
        .map_err(|_| "Codex session write lock is poisoned".to_string())?;
    let mut unique = Vec::new();
    let mut seen = HashSet::new();
    for value in session_ids {
        let id = normalize_thread_id(&value);
        if !id.is_empty() && seen.insert(id.clone()) {
            unique.push(id);
        }
    }
    if unique.is_empty() {
        return Err("Select at least one valid session ID".to_string());
    }
    if unique.len() > MAX_PAGE_SIZE {
        return Err(format!("You can delete up to {MAX_PAGE_SIZE} sessions at a time"));
    }
    let (database_paths, database_warnings) = discover_database_paths(codex_home, false);
    if !database_warnings.is_empty() {
        return Err(format!(
            "Unable to safely inspect all Codex session databases; deletion aborted: {}",
            database_warnings.join("；")
        ));
    }
    let mut results = Vec::new();
    for id in unique {
        results.push(delete_one_session(codex_home, &database_paths, &id));
    }
    let deleted_count = results
        .iter()
        .filter(|result| matches!(result.status.as_str(), "deleted" | "partial"))
        .count();
    let failed_count = results.len().saturating_sub(deleted_count);
    Ok(CodexSessionDeleteBatchResult {
        results,
        deleted_count,
        failed_count,
    })
}

fn delete_one_session(
    codex_home: &Path,
    database_paths: &[PathBuf],
    session_id: &str,
) -> CodexSessionDeleteResult {
    let outcome = (|| -> Result<CodexSessionDeleteResult, String> {
        let mut plans = Vec::new();
        for path in database_paths {
            if let Some(plan) = build_database_delete_plan(path, session_id)? {
                plans.push(plan);
            }
        }
        if plans.is_empty() {
            return Ok(CodexSessionDeleteResult {
                session_id: session_id.to_string(),
                status: "notFound".to_string(),
                message: "Session not found in the local database".to_string(),
                backup_path: None,
            });
        }
        let backup_dir = create_delete_backup(codex_home, session_id, &plans)?;
        for (committed_databases, plan) in plans.iter().enumerate() {
            if let Err(error) = apply_database_delete_plan(plan, session_id) {
                let status = if committed_databases > 0 {
                    "partial"
                } else {
                    "failed"
                };
                return Ok(CodexSessionDeleteResult {
                    session_id: session_id.to_string(),
                    status: status.to_string(),
                    message: format!(
                        "Committed {committed_databases} database transactions; deletion failed for the remaining databases: {error}"
                    ),
                    backup_path: Some(backup_dir.to_string_lossy().to_string()),
                });
            }
        }
        let mut rollout_errors = Vec::new();
        let mut rollout_paths = plans
            .iter()
            .flat_map(|plan| plan.rollout_paths.iter().cloned())
            .collect::<Vec<_>>();
        rollout_paths.sort();
        rollout_paths.dedup();
        for path in rollout_paths {
            if !rollout_candidate(codex_home, &path).is_file() {
                continue;
            }
            match validated_rollout_path(codex_home, &path) {
                Ok(Some(path)) => {
                    if let Err(error) = fs::remove_file(&path) {
                        if error.kind() != std::io::ErrorKind::NotFound {
                            rollout_errors.push(format!("{}: {error}", path.display()));
                        }
                    }
                }
                Ok(None) => rollout_errors.push(format!(
                    "Preserved rollout outside the Codex session directory: {}",
                    path.display()
                )),
                Err(error) => rollout_errors.push(error),
            }
        }
        let (status, message) = if rollout_errors.is_empty() {
            ("deleted", "Deleted local database records and rollout files".to_string())
        } else {
            (
                "partial",
                format!(
                    "Database records were deleted, but some rollouts were not: {}",
                    rollout_errors.join("；")
                ),
            )
        };
        Ok(CodexSessionDeleteResult {
            session_id: session_id.to_string(),
            status: status.to_string(),
            message,
            backup_path: Some(backup_dir.to_string_lossy().to_string()),
        })
    })();
    outcome.unwrap_or_else(|message| CodexSessionDeleteResult {
        session_id: session_id.to_string(),
        status: "failed".to_string(),
        message,
        backup_path: None,
    })
}

fn build_database_delete_plan(
    path: &Path,
    session_id: &str,
) -> Result<Option<DatabaseDeletePlan>, String> {
    let connection = open_read_only(path)?;
    let mut tables = Map::new();
    let mut rollout_paths = Vec::new();
    let thread_rows =
        select_rows_if_supported(&connection, "threads", &["id"], "id = ?1", &[&session_id])?;
    let has_thread_row = !thread_rows.is_empty();
    if has_thread_row {
        for row in &thread_rows {
            if let Some(path) = row.get("rollout_path").and_then(Value::as_str) {
                if !path.trim().is_empty() {
                    rollout_paths.push(PathBuf::from(path));
                }
            }
        }
        tables.insert("threads".to_string(), Value::Array(thread_rows));
        for (table, column, clause) in [
            ("thread_dynamic_tools", "thread_id", "thread_id = ?1"),
            ("thread_goals", "thread_id", "thread_id = ?1"),
            ("stage1_outputs", "thread_id", "thread_id = ?1"),
            (
                "agent_job_items",
                "assigned_thread_id",
                "assigned_thread_id = ?1",
            ),
        ] {
            let rows =
                select_rows_if_supported(&connection, table, &[column], clause, &[&session_id])?;
            if !rows.is_empty() {
                tables.insert(table.to_string(), Value::Array(rows));
            }
        }
        if let Some(clause) = thread_spawn_edge_clause(&connection)? {
            let rows = select_rows_if_supported(
                &connection,
                "thread_spawn_edges",
                &[],
                clause,
                &[&session_id],
            )?;
            if !rows.is_empty() {
                tables.insert("thread_spawn_edges".to_string(), Value::Array(rows));
            }
        }
    }
    let automation_rows = select_rows_if_supported(
        &connection,
        "automation_runs",
        &["thread_id"],
        "thread_id = ?1",
        &[&session_id],
    )?;
    let inbox_rows = select_rows_if_supported(
        &connection,
        "inbox_items",
        &["thread_id"],
        "thread_id = ?1",
        &[&session_id],
    )?;
    let has_automation_rows = !automation_rows.is_empty() || !inbox_rows.is_empty();
    if !automation_rows.is_empty() {
        tables.insert("automation_runs".to_string(), Value::Array(automation_rows));
    }
    if !inbox_rows.is_empty() {
        tables.insert("inbox_items".to_string(), Value::Array(inbox_rows));
    }
    if !has_thread_row && !has_automation_rows {
        return Ok(None);
    }
    for (table, column, clause) in [
        ("local_thread_catalog", "thread_id", "thread_id = ?1"),
        ("thread_timeline_ledger", "thread_id", "thread_id = ?1"),
    ] {
        let rows = select_rows_if_supported(&connection, table, &[column], clause, &[&session_id])?;
        if !rows.is_empty() {
            tables.insert(table.to_string(), Value::Array(rows));
        }
    }
    Ok(Some(DatabaseDeletePlan {
        path: path.to_path_buf(),
        tables,
        rollout_paths,
        has_thread_row,
        has_automation_rows,
    }))
}

fn select_rows_if_supported(
    connection: &Connection,
    table: &str,
    required_columns: &[&str],
    where_clause: &str,
    params: &[&dyn ToSql],
) -> Result<Vec<Value>, String> {
    let columns = table_columns(connection, table)?;
    if columns.is_empty()
        || required_columns
            .iter()
            .any(|column| !columns.contains(*column))
    {
        return Ok(Vec::new());
    }
    select_json_rows(
        connection,
        &format!(
            "SELECT * FROM \"{}\" WHERE {where_clause}",
            table.replace('"', "\"\"")
        ),
        params,
    )
}

fn thread_spawn_edge_clause(connection: &Connection) -> Result<Option<&'static str>, String> {
    let columns = table_columns(connection, "thread_spawn_edges")?;
    Ok(
        match (
            columns.contains("parent_thread_id"),
            columns.contains("child_thread_id"),
        ) {
            (true, true) => Some("parent_thread_id = ?1 OR child_thread_id = ?1"),
            (true, false) => Some("parent_thread_id = ?1"),
            (false, true) => Some("child_thread_id = ?1"),
            (false, false) => None,
        },
    )
}

fn select_json_rows(
    connection: &Connection,
    sql: &str,
    params: &[&dyn ToSql],
) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("Failed to prepare session backup query: {error}"))?;
    let columns = statement
        .column_names()
        .iter()
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    let rows = statement
        .query_map(params, |row| {
            let mut value = Map::new();
            for (index, column) in columns.iter().enumerate() {
                value.insert(column.clone(), sql_value_to_json(row.get_ref(index)?));
            }
            Ok(Value::Object(value))
        })
        .map_err(|error| format!("Failed to read session backup data: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Failed to read session backup data: {error}"))
}

fn sql_value_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => json!(value),
        ValueRef::Real(value) => json!(value),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).to_string()),
        ValueRef::Blob(value) => json!({
            "$base64": base64::engine::general_purpose::STANDARD.encode(value)
        }),
    }
}

pub(super) fn create_operation_directory(
    codex_home: &Path,
    category: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let safe_label = label
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(64)
        .collect::<String>();
    let sequence = BACKUP_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
    let name = format!(
        "{}-{}-{sequence:020}-{}",
        Utc::now().format("%Y%m%d-%H%M%S%.3f"),
        std::process::id(),
        if safe_label.is_empty() {
            "operation"
        } else {
            &safe_label
        }
    );
    let directory = codex_home
        .join("backups_state")
        .join("easy-cli-proxy-api")
        .join(category)
        .join(name);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create session backup directory {}: {error}", directory.display()))?;
    Ok(directory)
}

fn create_delete_backup(
    codex_home: &Path,
    session_id: &str,
    plans: &[DatabaseDeletePlan],
) -> Result<PathBuf, String> {
    let directory = create_operation_directory(codex_home, "deletions", session_id)?;
    let mut sources = Vec::new();
    for (index, plan) in plans.iter().enumerate() {
        let file_name = format!("database-{index}-rows.json");
        let payload = json!({
            "databasePath": plan.path.to_string_lossy(),
            "tables": plan.tables,
        });
        write_json_atomically(&directory.join(&file_name), &payload)?;
        sources.push(json!({
            "databasePath": plan.path.to_string_lossy(),
            "rowsFile": file_name,
        }));
    }
    let rollout_directory = directory.join("rollouts");
    let mut rollout_files = Vec::new();
    let mut paths = plans
        .iter()
        .flat_map(|plan| plan.rollout_paths.iter().cloned())
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    for (index, path) in paths.iter().enumerate() {
        if !rollout_candidate(codex_home, path).is_file() {
            continue;
        }
        let Some(validated) = validated_rollout_path(codex_home, path)? else {
            rollout_files.push(json!({
                "originalPath": path.to_string_lossy(),
                "backupPath": Value::Null,
                "skipped": "outside Codex session directories"
            }));
            continue;
        };
        if !validated.is_file() {
            continue;
        }
        fs::create_dir_all(&rollout_directory).map_err(|error| {
            format!(
                "Failed to create rollout backup directory {}: {error}",
                rollout_directory.display()
            )
        })?;
        let file_name = format!(
            "{index}-{}",
            validated
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or("rollout.jsonl")
        );
        let target = rollout_directory.join(&file_name);
        fs::copy(&validated, &target)
            .map_err(|error| format!("Failed to back up rollout {}: {error}", validated.display()))?;
        rollout_files.push(json!({
            "originalPath": validated.to_string_lossy(),
            "backupPath": format!("rollouts/{file_name}")
        }));
    }
    write_json_atomically(
        &directory.join("metadata.json"),
        &json!({
            "schemaVersion": 1,
            "kind": "codex-session-deletion",
            "createdAt": Utc::now().to_rfc3339(),
            "sessionId": session_id,
            "codexHome": codex_home.to_string_lossy(),
            "sources": sources,
            "rolloutFiles": rollout_files,
            "managedBy": "EasyCLIProxyAPI"
        }),
    )?;
    Ok(directory)
}

fn rollout_candidate(codex_home: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        codex_home.join(path)
    }
}

fn validated_rollout_path(codex_home: &Path, path: &Path) -> Result<Option<PathBuf>, String> {
    let candidate = rollout_candidate(codex_home, path);
    if !candidate.is_file() {
        return Ok(None);
    }
    let canonical_home = fs::canonicalize(codex_home).map_err(|error| {
        format!(
            "Failed to resolve Codex home {}: {error}",
            codex_home.display()
        )
    })?;
    let canonical = fs::canonicalize(&candidate).map_err(|error| {
        format!(
            "Failed to resolve rollout path {}: {error}",
            candidate.display()
        )
    })?;
    for directory in SESSION_DIRS {
        let root = codex_home.join(directory);
        if let Ok(root) = fs::canonicalize(root) {
            if root.starts_with(&canonical_home)
                && canonical.starts_with(&root)
                && canonical.extension().and_then(OsStr::to_str) == Some("jsonl")
            {
                return Ok(Some(canonical));
            }
        }
    }
    Ok(None)
}

fn apply_database_delete_plan(plan: &DatabaseDeletePlan, session_id: &str) -> Result<(), String> {
    let mut connection = open_read_write(&plan.path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to begin database transaction {}: {error}", plan.path.display()))?;
    if plan.has_thread_row {
        delete_where_if_supported(
            &transaction,
            "thread_dynamic_tools",
            &["thread_id"],
            "thread_id = ?1",
            &[&session_id],
        )?;
        delete_where_if_supported(
            &transaction,
            "thread_goals",
            &["thread_id"],
            "thread_id = ?1",
            &[&session_id],
        )?;
        if let Some(clause) = thread_spawn_edge_clause(&transaction)? {
            delete_where_if_supported(
                &transaction,
                "thread_spawn_edges",
                &[],
                clause,
                &[&session_id],
            )?;
        }
        delete_where_if_supported(
            &transaction,
            "stage1_outputs",
            &["thread_id"],
            "thread_id = ?1",
            &[&session_id],
        )?;
        let agent_columns = table_columns(&transaction, "agent_job_items")?;
        if agent_columns.contains("assigned_thread_id") {
            transaction
                .execute(
                    "UPDATE agent_job_items SET assigned_thread_id = NULL WHERE assigned_thread_id = ?1",
                    [session_id],
                )
                .map_err(|error| format!("Failed to update agent_job_items: {error}"))?;
        }
        delete_where_if_supported(&transaction, "threads", &["id"], "id = ?1", &[&session_id])?;
    }
    if plan.has_automation_rows {
        delete_where_if_supported(
            &transaction,
            "automation_runs",
            &["thread_id"],
            "thread_id = ?1",
            &[&session_id],
        )?;
        delete_where_if_supported(
            &transaction,
            "inbox_items",
            &["thread_id"],
            "thread_id = ?1",
            &[&session_id],
        )?;
    }
    delete_where_if_supported(
        &transaction,
        "local_thread_catalog",
        &["thread_id"],
        "thread_id = ?1",
        &[&session_id],
    )?;
    delete_where_if_supported(
        &transaction,
        "thread_timeline_ledger",
        &["thread_id"],
        "thread_id = ?1",
        &[&session_id],
    )?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit database deletion {}: {error}", plan.path.display()))
}

fn delete_where_if_supported(
    connection: &Connection,
    table: &str,
    required_columns: &[&str],
    where_clause: &str,
    params: &[&dyn ToSql],
) -> Result<(), String> {
    let columns = table_columns(connection, table)?;
    if columns.is_empty()
        || required_columns
            .iter()
            .any(|column| !columns.contains(*column))
    {
        return Ok(());
    }
    connection
        .execute(
            &format!(
                "DELETE FROM \"{}\" WHERE {where_clause}",
                table.replace('"', "\"\"")
            ),
            params,
        )
        .map(|_| ())
        .map_err(|error| format!("Failed to delete related records from {table}: {error}"))
}

pub(super) fn write_json_atomically(path: &Path, value: &Value) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| format!("Failed to serialize session backup: {error}"))?;
    crate::write_bytes_atomically(path, &bytes)
}
