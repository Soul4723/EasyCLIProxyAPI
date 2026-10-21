use super::*;

pub(super) fn update_session_database(
    path: &Path,
    session_id: &str,
    request: &SaveCodexSessionContextRequest,
    rollout_path: Option<&Path>,
) -> Result<(), String> {
    let mut connection = open_read_write(path)?;
    let transaction = connection.transaction().map_err(|error| {
        format!(
            "Failed to begin session context transaction {}: {error}",
            path.display()
        )
    })?;
    let columns = table_columns(&transaction, "threads")?;
    let mut updates = Vec::new();
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();
    let title_column = if columns.contains("title") {
        "title"
    } else {
        "name"
    };
    for (column, value) in [
        (title_column, request.title.as_ref()),
        ("cwd", request.cwd.as_ref()),
        ("model", request.model.as_ref()),
        ("model_provider", request.model_provider.as_ref()),
    ] {
        if columns.contains(column) {
            if let Some(value) = value {
                updates.push(format!("{column} = ?"));
                params.push(Box::new(value.clone()));
            }
        }
    }
    if let Some(archived) = request.archived {
        if columns.contains("archived") {
            updates.push("archived = ?".to_string());
            params.push(Box::new(i64::from(archived)));
        }
        if columns.contains("archived_at") {
            updates.push("archived_at = ?".to_string());
            params.push(Box::new(if archived {
                Some(Utc::now().timestamp())
            } else {
                None::<i64>
            }));
        }
    }
    if let Some(rollout_path) = rollout_path {
        if columns.contains("rollout_path") {
            updates.push("rollout_path = ?".to_string());
            params.push(Box::new(rollout_path.to_string_lossy().to_string()));
        }
    }
    let now_ts = Utc::now().timestamp();
    let now_ms = Utc::now().timestamp_millis();
    if columns.contains("updated_at") {
        updates.push("updated_at = ?".to_string());
        params.push(Box::new(now_ts));
    }
    if columns.contains("updated_at_ms") {
        updates.push("updated_at_ms = ?".to_string());
        params.push(Box::new(now_ms));
    }
    if updates.is_empty() {
        return Err(format!(
            "Database {} has no supported thread columns",
            path.display()
        ));
    }
    params.push(Box::new(session_id.to_string()));
    let sql = format!("UPDATE threads SET {} WHERE id = ?", updates.join(", "));
    let refs = params
        .iter()
        .map(|value| value.as_ref())
        .collect::<Vec<_>>();
    let changed = transaction
        .execute(&sql, refs.as_slice())
        .map_err(|error| {
            format!(
                "Failed to update session database {}: {error}",
                path.display()
            )
        })?;
    if changed != 1 {
        return Err(format!(
            "Session {session_id} disappeared from database {} during the update",
            path.display()
        ));
    }
    if table_exists(&transaction, "local_thread_catalog")? {
        let columns = table_columns(&transaction, "local_thread_catalog")?;
        let mut updates = Vec::new();
        let mut params: Vec<Box<dyn ToSql>> = Vec::new();
        for (column, value) in [
            ("display_title", request.title.as_ref()),
            ("cwd", request.cwd.as_ref()),
            ("model_provider", request.model_provider.as_ref()),
        ] {
            if columns.contains(column) {
                if let Some(value) = value {
                    updates.push(format!("{column} = ?"));
                    params.push(Box::new(value.clone()));
                }
            }
        }
        if columns.contains("source_updated_at") {
            updates.push("source_updated_at = ?".to_string());
            params.push(Box::new(now_ts as f64));
        }
        if !updates.is_empty() {
            params.push(Box::new(session_id.to_string()));
            let sql = format!(
                "UPDATE local_thread_catalog SET {} WHERE thread_id = ?",
                updates.join(", ")
            );
            let refs = params
                .iter()
                .map(|value| value.as_ref())
                .collect::<Vec<_>>();
            transaction
                .execute(&sql, refs.as_slice())
                .map_err(|error| {
                    format!(
                        "Failed to update local session catalog {}: {error}",
                        path.display()
                    )
                })?;
        }
    }
    transaction.commit().map_err(|error| {
        format!(
            "Failed to commit session context transaction {}: {error}",
            path.display()
        )
    })
}

pub(super) fn sync_thread_history_projection_databases(
    database_paths: &[PathBuf],
    session_id: &str,
    plan: &RolloutSyncPlan,
) -> Result<usize, String> {
    let mut total_rows_affected = 0;
    for db_path in database_paths {
        let mut connection = open_read_write(db_path)?;
        let transaction = connection.transaction().map_err(|error| {
            format!(
                "Failed to start transaction for {}: {error}",
                db_path.display()
            )
        })?;

        validate_projection_cursor(&transaction, session_id, plan.original_projection_cursor)?;

        let has_items = table_exists(&transaction, "thread_items")?;
        if !has_items {
            continue;
        }

        let turn_columns = table_columns(&transaction, "thread_turns")?;

        for item in &plan.updated_items {
            let existing_json: Option<String> = transaction
                .query_row(
                    "SELECT item_json FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 AND item_id = ?3",
                    rusqlite::params![session_id, item.turn_id, item.item_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("Failed to read thread item {}: {error}", item.item_id))?;

            if let Some(raw_json) = existing_json {
                if let Ok(mut val) = serde_json::from_str::<Value>(&raw_json) {
                    let mut changed = false;
                    if item.item_type == "agentMessage" {
                        if let Some(obj) = val.as_object_mut() {
                            obj.insert("text".to_string(), json!(item.text));
                            changed = true;
                        }
                    } else if item.item_type == "userMessage" {
                        if let Some(obj) = val.as_object_mut() {
                            let content = obj.entry("content").or_insert_with(|| json!([]));
                            update_content_text(content, &item.text, "text");
                            changed = true;
                        }
                    } else if item.item_type == "reasoning" {
                        if let Some(obj) = val.as_object_mut() {
                            obj.remove("signature");
                            obj.remove("encrypted_content");
                            obj.insert("signature_stripped".to_string(), json!(true));
                            obj.insert("summary".to_string(), json!([item.text]));
                            obj.insert("content".to_string(), json!([]));
                            changed = true;
                        }
                    }
                    if changed {
                        if let Ok(new_json_str) = serde_json::to_string(&val) {
                            let updated = transaction
                                .execute(
                                    "UPDATE thread_items SET item_json = ?1 WHERE thread_id = ?2 AND turn_id = ?3 AND item_id = ?4",
                                    rusqlite::params![new_json_str, session_id, item.turn_id, item.item_id],
                                )
                                .map_err(|error| format!("Failed to update thread item {}: {error}", item.item_id))?;
                            total_rows_affected += updated;
                        }
                    }
                }
            }
        }

        for (deleted_id, turn_id) in &plan.deleted_item_keys {
            let deleted = transaction.execute(
                "DELETE FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 AND item_id = ?3",
                rusqlite::params![session_id, turn_id, deleted_id],
            ).map_err(|error| format!("Failed to delete thread item {deleted_id}: {error}"))?;
            total_rows_affected += deleted;
        }

        let mut new_turns = HashSet::new();
        for new_item in &plan.new_items {
            if !new_turns.insert(new_item.turn_id.as_str()) || turn_columns.is_empty() {
                continue;
            }
            let position = plan.turn_positions.get(&new_item.turn_id).ok_or_else(|| {
                format!("Missing rollout position for new turn {}", new_item.turn_id)
            })?;
            let mut columns = vec!["thread_id", "turn_id"];
            let mut values: Vec<Box<dyn ToSql>> = vec![
                Box::new(session_id.to_string()),
                Box::new(new_item.turn_id.clone()),
            ];
            for (column, value) in [
                ("rollout_ordinal", json!(position.ordinal)),
                ("rollout_byte_offset", json!(position.byte_offset)),
                ("rollout_end_ordinal", json!(position.end_ordinal)),
                ("rollout_end_byte_offset", json!(position.end_byte_offset)),
                ("status", json!(position.status)),
                ("started_at", json!(position.started_at)),
                ("completed_at", json!(position.completed_at)),
                ("duration_ms", json!(position.duration_ms)),
                ("error_json", json!(position.error_json)),
                ("root_turn_id", json!(position.root_turn_id)),
            ] {
                if turn_columns.contains(column) {
                    columns.push(column);
                    values.push(sqlite_param_for_json(Some(&value)));
                }
            }
            let placeholders = vec!["?"; columns.len()].join(", ");
            let refs = values
                .iter()
                .map(|value| value.as_ref())
                .collect::<Vec<_>>();
            total_rows_affected += transaction.execute(
                &format!("INSERT INTO thread_turns ({}) SELECT {placeholders} WHERE NOT EXISTS (SELECT 1 FROM thread_turns WHERE thread_id = ? AND turn_id = ?)", columns.join(", ")),
                rusqlite::params_from_iter(refs.into_iter().chain([
                    &session_id as &dyn ToSql, &new_item.turn_id as &dyn ToSql,
                ])),
            ).map_err(|error| format!("Failed to create thread turn {}: {error}", new_item.turn_id))?;
        }

        for (index, new_item) in plan.new_items.iter().enumerate() {
            let item_json = if new_item.item_type == "agentMessage" {
                json!({
                    "type": "agentMessage",
                    "id": new_item.item_id,
                    "text": new_item.text,
                    "phase": null,
                    "memoryCitation": null
                })
            } else {
                json!({
                    "type": "userMessage",
                    "id": new_item.item_id,
                    "clientId": null,
                    "content": [{"type": "text", "text": new_item.text}]
                })
            };
            let now_ms = Utc::now().timestamp_millis();
            let inserted = transaction
                .execute(
                    "INSERT OR REPLACE INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type, updated_at_ordinal, started_at_ms, completed_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    rusqlite::params![
                        session_id,
                        new_item.turn_id,
                        new_item.item_id,
                        plan.item_ordinals
                            .get(&(new_item.item_id.clone(), new_item.turn_id.clone()))
                            .copied()
                            .unwrap_or(plan.appended_ordinal + index as i64),
                        now_ms,
                        item_json.to_string(),
                        new_item.item_type,
                        0i64,
                        now_ms,
                        now_ms
                    ],
                )
                .map_err(|error| format!("Failed to insert thread item {}: {error}", new_item.item_id))?;
            total_rows_affected += inserted;
        }

        for ((item_id, turn_id), ordinal) in &plan.item_ordinals {
            total_rows_affected += transaction
                .execute(
                    "UPDATE thread_items SET rollout_ordinal = ?1 WHERE thread_id = ?2 AND turn_id = ?3 AND item_id = ?4",
                    rusqlite::params![ordinal, session_id, turn_id, item_id],
                )
                .map_err(|error| {
                    format!("Failed to update rollout ordinal for thread item {item_id}: {error}")
                })?;
        }

        let affected_turns: HashSet<&str> = plan
            .deleted_item_keys
            .iter()
            .map(|(_, turn)| turn.as_str())
            .chain(plan.new_items.iter().map(|item| item.turn_id.as_str()))
            .collect();
        for turn_id in affected_turns {
            let user_type = "(item_type = 'userMessage' OR (item_type = '' AND json_extract(item_json, '$.type') = 'userMessage'))";
            let agent_type = "(item_type = 'agentMessage' OR (item_type = '' AND json_extract(item_json, '$.type') = 'agentMessage'))";
            if turn_columns.contains("first_user_item_id") {
                total_rows_affected += transaction.execute(
                    &format!("UPDATE thread_turns SET first_user_item_id = (SELECT item_id FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 AND {user_type} ORDER BY rollout_ordinal LIMIT 1) WHERE thread_id = ?1 AND turn_id = ?2"),
                    rusqlite::params![session_id, turn_id],
                ).map_err(|error| format!("Failed to refresh the first user item for {turn_id}: {error}"))?;
            }
            if turn_columns.contains("final_agent_item_id") {
                let terminal = if turn_columns.contains("status") {
                    "status IN ('completed', 'interrupted', 'failed')"
                } else {
                    "1"
                };
                total_rows_affected += transaction.execute(
                    &format!("UPDATE thread_turns SET final_agent_item_id = COALESCE((SELECT item_id FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 AND {agent_type} AND json_extract(item_json, '$.phase') = 'final_answer' ORDER BY rollout_ordinal DESC LIMIT 1), CASE WHEN {terminal} THEN (SELECT item_id FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 AND {agent_type} AND json_extract(item_json, '$.phase') IS NULL ORDER BY rollout_ordinal DESC LIMIT 1) END) WHERE thread_id = ?1 AND turn_id = ?2"),
                    rusqlite::params![session_id, turn_id],
                ).map_err(|error| format!("Failed to refresh the final agent item for {turn_id}: {error}"))?;
            }
        }

        for (turn_id, position) in &plan.turn_positions {
            for (column, value) in [
                ("rollout_ordinal", Some(position.ordinal)),
                ("rollout_byte_offset", Some(position.byte_offset)),
                ("rollout_end_ordinal", position.end_ordinal),
                ("rollout_end_byte_offset", position.end_byte_offset),
            ] {
                if turn_columns.contains(column) {
                    total_rows_affected += transaction.execute(
                        &format!("UPDATE thread_turns SET {column} = ?1 WHERE thread_id = ?2 AND turn_id = ?3"),
                        rusqlite::params![value, session_id, turn_id],
                    ).map_err(|error| format!("Failed to update {column} for turn {turn_id}: {error}"))?;
                }
            }
        }

        if table_exists(&transaction, "thread_history_projection_state")? {
            if let Some(cursor) = plan.projection_cursor {
                let has_state: bool = transaction
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM thread_history_projection_state WHERE thread_id = ?1)",
                        [session_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| {
                        format!(
                            "Failed to read the thread history projection cursor for {session_id}: {error}"
                        )
                    })?;
                if has_state {
                    transaction.execute(
                        "UPDATE thread_history_projection_state SET next_rollout_byte_offset = ?1, next_rollout_ordinal = ?2 WHERE thread_id = ?3",
                        rusqlite::params![cursor.byte_offset, cursor.next_ordinal, session_id],
                    ).map_err(|error| {
                        format!("Failed to update the thread history projection cursor for {session_id}: {error}")
                    })?;
                }
            }
        }

        transaction.commit().map_err(|error| {
            format!(
                "Failed to commit thread history transaction {}: {error}",
                db_path.display()
            )
        })?;
    }
    Ok(total_rows_affected)
}

/// Advancing a cursor is safe only when the original durable prefix was fully
/// materialized. Refuse incomplete/stale projections rather than skipping rows.
pub(super) fn validate_projection_cursor(
    connection: &Connection,
    session_id: &str,
    expected: Option<RolloutProjectionCursor>,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    if !table_exists(connection, "thread_history_projection_state")? {
        return Ok(());
    }
    let current: Option<(i64, i64)> = connection.query_row(
        "SELECT next_rollout_byte_offset, next_rollout_ordinal FROM thread_history_projection_state WHERE thread_id = ?1",
        [session_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|error| format!("Failed to inspect the projection cursor: {error}"))?;
    if current.is_some_and(|cursor| cursor != (expected.byte_offset, expected.next_ordinal)) {
        return Err("The thread history projection is incomplete or stale. Let Codex finish indexing this session, close it, and reload before editing".to_string());
    }
    Ok(())
}

pub(super) fn format_save_rollback_error(
    base_error: String,
    rollout_rollback: Option<Result<(), String>>,
    index_rollback: Option<Result<(), String>>,
    database_rollback: Option<Result<(), String>>,
    history_rollback: Option<Result<(), String>>,
    backup_dir: &Path,
) -> String {
    let mut details = Vec::new();
    for (name, result) in [
        ("rollout", rollout_rollback),
        ("session index", index_rollback),
        ("thread history", history_rollback),
        ("session database", database_rollback),
    ] {
        if let Some(result) = result {
            details.push(match result {
                Ok(()) => format!("{name} restored"),
                Err(error) => format!("{name} rollback failed: {error}"),
            });
        }
    }
    if details.is_empty() {
        format!("{base_error}. Backup: {}", backup_dir.display())
    } else {
        format!(
            "{base_error}; {}. Backup: {}",
            details.join("; "),
            backup_dir.display()
        )
    }
}

pub(super) fn rollback_rollout(
    original_path: &Path,
    current_path: &Path,
    original_bytes: &[u8],
) -> Result<(), String> {
    if current_path != original_path && current_path.exists() {
        if let Some(parent) = original_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("Failed to recreate rollout directory during rollback: {error}")
            })?;
        }
        fs::rename(current_path, original_path).map_err(|error| {
            format!(
                "Failed to restore rollout path {}: {error}",
                original_path.display()
            )
        })?;
    }
    crate::write_bytes_atomically(original_path, original_bytes)
}
