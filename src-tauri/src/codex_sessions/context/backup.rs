use super::*;

pub(super) fn create_context_edit_backup(
    codex_home: &Path,
    session_id: &str,
    rollout_path: Option<&Path>,
    rollout_bytes: Option<&[u8]>,
    database_path: Option<&Path>,
    session_index_bytes: Option<&[u8]>,
    thread_history_databases: &[PathBuf],
) -> Result<PathBuf, String> {
    ensure_context_path_in_home(
        codex_home,
        &codex_home.join("backups_state/easy-cli-proxy-api/session-context-edits"),
    )?;
    let directory = create_operation_directory(codex_home, "session-context-edits", session_id)?;
    let mut rollout_backup = Value::Null;
    if let (Some(path), Some(bytes)) = (rollout_path, rollout_bytes) {
        let file_name = path
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("rollout.jsonl");
        let relative = PathBuf::from("rollouts").join(file_name);
        let target = directory.join(&relative);
        fs::create_dir_all(target.parent().unwrap_or(&directory))
            .map_err(|error| format!("Failed to create context backup directory: {error}"))?;
        crate::write_bytes_atomically(&target, bytes)?;
        rollout_backup = json!({
            "originalPath": path.to_string_lossy(),
            "backupPath": relative.to_string_lossy().replace('\\', "/"),
            "sha256": sha256_hex(bytes)
        });
    }
    let mut database_backup = Value::Null;
    if let Some(path) = database_path {
        let connection = open_read_only(path)?;
        let mut tables = Map::new();
        for (table, key) in [("threads", "id"), ("local_thread_catalog", "thread_id")] {
            let rows = select_rows_if_supported(
                &connection,
                table,
                &[key],
                &format!("{key} = ?1"),
                &[&session_id],
            )?;
            if !rows.is_empty() {
                tables.insert(table.to_string(), Value::Array(rows));
            }
        }
        database_backup = json!({
            "databasePath": path.to_string_lossy(),
            "tables": tables
        });
        write_json_atomically(&directory.join("database-rows.json"), &database_backup)?;
    }
    if !thread_history_databases.is_empty() {
        let mut history_backups = Vec::new();
        for database_path in thread_history_databases {
            let connection = open_read_only(database_path)?;
            let mut tables_map = Map::new();
            for (table_name, column_name) in [
                ("thread_items", "thread_id"),
                ("thread_turns", "thread_id"),
                ("thread_history_projection_state", "thread_id"),
            ] {
                let rows = select_rows_if_supported(
                    &connection,
                    table_name,
                    &[column_name],
                    &format!("{column_name} = ?1"),
                    &[&session_id],
                )
                .map_err(|error| {
                    format!(
                        "Failed to back up {table_name} from {}: {error}",
                        database_path.display()
                    )
                })?;
                if !rows.is_empty() {
                    tables_map.insert(table_name.to_string(), Value::Array(rows));
                }
            }
            history_backups.push(json!({
                "databasePath": database_path.to_string_lossy(),
                "tables": tables_map
            }));
        }
        if !history_backups.is_empty() {
            write_json_atomically(
                &directory.join("thread-history-rows.json"),
                &Value::Array(history_backups),
            )?;
        }
    }
    if let Some(bytes) = session_index_bytes {
        crate::write_bytes_atomically(&directory.join("session_index.jsonl.bak"), bytes)?;
    }
    write_json_atomically(
        &directory.join("metadata.json"),
        &json!({
            "schemaVersion": 1,
            "kind": "session-context-edit",
            "createdAt": Utc::now().to_rfc3339(),
            "sessionId": session_id,
            "rollout": rollout_backup,
            "database": database_backup,
            "threadHistoryBackedUp": !thread_history_databases.is_empty(),
            "sessionIndexBackedUp": session_index_bytes.is_some(),
            "managedBy": "EasyCLIProxyAPI"
        }),
    )?;
    Ok(directory)
}

pub(super) fn sqlite_param_for_json(value: Option<&Value>) -> Box<dyn ToSql> {
    match value {
        Some(Value::String(text)) => Box::new(text.clone()),
        Some(Value::Number(number)) => {
            if let Some(integer) = number.as_i64() {
                Box::new(integer)
            } else if let Some(float) = number.as_f64() {
                Box::new(float)
            } else {
                Box::new(None::<String>)
            }
        }
        Some(Value::Bool(flag)) => Box::new(*flag),
        _ => Box::new(None::<String>),
    }
}

/// Restores the `threads` / `local_thread_catalog` rows captured before the
/// save. `update_session_database` commits before the later rollout-index and
/// thread-history steps run, so a late failure must roll this back as well.
pub(super) fn restore_session_database_backup(backup_dir: &Path) -> Result<(), String> {
    let backup_file = backup_dir.join("database-rows.json");
    if !backup_file.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&backup_file).map_err(|error| {
        format!(
            "Failed to read database backup {}: {error}",
            backup_file.display()
        )
    })?;
    let entry: Value = serde_json::from_str(&content).map_err(|error| {
        format!(
            "Failed to parse database backup {}: {error}",
            backup_file.display()
        )
    })?;
    let Some(db_path) = entry.get("databasePath").and_then(Value::as_str) else {
        return Ok(());
    };
    let db_path = PathBuf::from(db_path);
    if !db_path.exists() {
        return Ok(());
    }
    let mut connection = open_read_write(&db_path)?;
    let transaction = connection.transaction().map_err(|error| {
        format!(
            "Failed to start the session database rollback for {}: {error}",
            db_path.display()
        )
    })?;
    if let Some(tables) = entry.get("tables").and_then(Value::as_object) {
        for (table_name, rows_value) in tables {
            if !table_exists(&transaction, table_name)? {
                continue;
            }
            let Some(rows) = rows_value.as_array() else {
                continue;
            };
            for row in rows {
                let Some(row_map) = row.as_object() else {
                    continue;
                };
                let columns: Vec<&str> = row_map.keys().map(String::as_str).collect();
                let placeholders: Vec<String> =
                    (1..=columns.len()).map(|idx| format!("?{idx}")).collect();
                let sql = format!(
                    "INSERT OR REPLACE INTO \"{}\" ({}) VALUES ({})",
                    table_name.replace('"', "\"\""),
                    columns.join(", "),
                    placeholders.join(", ")
                );
                let params: Vec<Box<dyn ToSql>> = columns
                    .iter()
                    .map(|column| sqlite_param_for_json(row_map.get(*column)))
                    .collect();
                let refs: Vec<&dyn ToSql> = params.iter().map(|item| item.as_ref()).collect();
                transaction
                    .execute(&sql, refs.as_slice())
                    .map_err(|error| {
                        format!(
                            "Failed to restore {table_name} in {} during rollback: {error}",
                            db_path.display()
                        )
                    })?;
            }
        }
    }
    transaction.commit().map_err(|error| {
        format!(
            "Failed to commit the session database rollback for {}: {error}",
            db_path.display()
        )
    })
}

pub(super) fn restore_thread_history_backup(backup_dir: &Path, session_id: &str) -> Result<(), String> {
    let backup_file = backup_dir.join("thread-history-rows.json");
    if !backup_file.is_file() {
        return Ok(());
    }
    let content = fs::read_to_string(&backup_file).map_err(|error| {
        format!(
            "Failed to read thread history backup {}: {error}",
            backup_file.display()
        )
    })?;
    let entries: Vec<Value> = serde_json::from_str(&content).map_err(|error| {
        format!(
            "Failed to parse thread history backup {}: {error}",
            backup_file.display()
        )
    })?;

    for entry in entries {
        let db_path_str = match entry.get("databasePath").and_then(Value::as_str) {
            Some(path) => path,
            None => continue,
        };
        let db_path = PathBuf::from(db_path_str);
        if !db_path.exists() {
            continue;
        }
        let mut connection = open_read_write(&db_path)?;
        let transaction = connection.transaction().map_err(|error| {
            format!(
                "Failed to start rollback transaction for {}: {error}",
                db_path.display()
            )
        })?;

        for table_name in [
            "thread_items",
            "thread_turns",
            "thread_history_projection_state",
        ] {
            if !table_exists(&transaction, table_name)? {
                continue;
            }
            transaction
                .execute(
                    &format!("DELETE FROM \"{table_name}\" WHERE thread_id = ?1"),
                    [session_id],
                )
                .map_err(|error| {
                    format!(
                        "Failed to clear {table_name} in {} during rollback: {error}",
                        db_path.display()
                    )
                })?;
        }

        if let Some(tables) = entry.get("tables").and_then(Value::as_object) {
            for (table_name, rows_val) in tables {
                if let Some(rows) = rows_val.as_array() {
                    for row in rows {
                        if let Some(row_map) = row.as_object() {
                            if !table_exists(&transaction, table_name)? {
                                continue;
                            }
                            let columns: Vec<&str> = row_map.keys().map(String::as_str).collect();
                            let placeholders: Vec<String> =
                                (1..=columns.len()).map(|idx| format!("?{idx}")).collect();
                            let sql = format!(
                                "INSERT OR REPLACE INTO \"{}\" ({}) VALUES ({})",
                                table_name.replace('"', "\"\""),
                                columns.join(", "),
                                placeholders.join(", ")
                            );
                            let params_vec: Vec<Box<dyn ToSql>> = columns
                                .iter()
                                .map(|col| sqlite_param_for_json(row_map.get(*col)))
                                .collect();
                            let refs: Vec<&dyn ToSql> =
                                params_vec.iter().map(|item| item.as_ref()).collect();
                            transaction.execute(&sql, refs.as_slice()).map_err(|error| {
                                format!(
                                    "Failed to restore {table_name} rows in {} during rollback: {error}",
                                    db_path.display()
                                )
                            })?;
                        }
                    }
                }
            }
        }
        transaction.commit().map_err(|error| {
            format!(
                "Failed to commit rollback transaction for {}: {error}",
                db_path.display()
            )
        })?;
    }
    Ok(())
}
