use super::*;

#[tauri::command]
pub(crate) async fn get_codex_session_context(
    app: tauri::AppHandle,
    request: GetCodexSessionContextRequest,
) -> Result<CodexSessionContextDetail, String> {
    let expected = app.state::<crate::GuiConfigState>().snapshot()?;
    crate::core_connection::require_local(&expected)?;
    let user_home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to get user directory: {error}"))?;
    let codex_home = resolve_codex_home(&user_home);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::GuiConfigState>();
        read_without_target_fence(&state, &expected, || {
            let limit = request
                .message_limit
                .unwrap_or(DEFAULT_CONTEXT_PAGE_SIZE)
                .clamp(1, MAX_CONTEXT_PAGE_SIZE);
            get_codex_session_context_page_from_home(
                &codex_home,
                &request.session_id,
                request.message_offset.unwrap_or(0),
                limit,
            )
        })
    })
    .await
    .map_err(|error| format!("Failed to read Codex session context: {error}"))?
}

#[tauri::command]
pub(crate) async fn save_codex_session_context(
    app: tauri::AppHandle,
    request: SaveCodexSessionContextRequest,
) -> Result<SaveCodexSessionContextResult, String> {
    let expected = app.state::<crate::GuiConfigState>().snapshot()?;
    crate::core_connection::require_local(&expected)?;
    let user_home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to get user directory: {error}"))?;
    let codex_home = resolve_codex_home(&user_home);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::GuiConfigState>();
        let _target_operation = state.blocking_local_target_operation(&expected)?;
        save_codex_session_context_from_home(&codex_home, request)
    })
    .await
    .map_err(|error| format!("Failed to save Codex session context: {error}"))?
}

#[tauri::command]
pub(crate) async fn open_codex_session_rollout(
    app: tauri::AppHandle,
    request: GetCodexSessionContextRequest,
) -> Result<(), String> {
    let expected = app.state::<crate::GuiConfigState>().snapshot()?;
    crate::core_connection::require_local(&expected)?;
    let user_home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to get user directory: {error}"))?;
    let codex_home = resolve_codex_home(&user_home);
    let session_id = validate_session_id(&normalize_thread_id(&request.session_id))?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::GuiConfigState>();
        read_without_target_fence(&state, &expected, || {
            let path = find_rollout_for_session(&codex_home, &session_id)?
                .ok_or_else(|| "This session has no rollout file to open".to_string())?;
            tauri_plugin_opener::open_path(path, None::<&str>)
                .map_err(|error| format!("Failed to open rollout with the default application: {error}"))
        })
    })
    .await
    .map_err(|error| format!("Failed to locate session rollout: {error}"))?
}

/// The whole session in one response; tests and callers that need every message use this.
#[cfg(test)]
pub(super) fn get_codex_session_context_from_home(
    codex_home: &Path,
    raw_session_id: &str,
) -> Result<CodexSessionContextDetail, String> {
    get_codex_session_context_page_from_home(codex_home, raw_session_id, 0, usize::MAX)
}

/// Message text for one `response_item` payload, computed only for messages inside the requested page.
fn context_item_content(p_type: &str, payload: &Value) -> String {
    match p_type {
        "message" => extract_content_text(&payload["content"]),
        "reasoning" | "thinking" => extract_reasoning_text(payload),
        tool if tool.ends_with("_output") => payload
            .get("output")
            .map(|output| {
                output
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| output.to_string())
            })
            .unwrap_or_default(),
        tool => {
            let name = payload["name"].as_str().unwrap_or("unknown_tool");
            let args = payload
                .get("arguments")
                .or_else(|| payload.get("input"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            format!("{name}({args})")
        }
    }
}

/// Loads session metadata, whole-file stats and hash, plus the `limit` messages starting at message
/// `offset`. The scan still reads the whole rollout (stats and the save guard hash need it) but only
/// builds text and payload for the requested page.
pub(super) fn get_codex_session_context_page_from_home(
    codex_home: &Path,
    raw_session_id: &str,
    message_offset: usize,
    message_limit: usize,
) -> Result<CodexSessionContextDetail, String> {
    let window_end = message_offset.saturating_add(message_limit);
    let mut total_messages = 0usize;
    let mut call_lines: HashMap<String, Vec<usize>> = HashMap::new();
    let session_id = validate_session_id(&normalize_thread_id(raw_session_id))?;
    let (database_paths, _) = discover_database_paths(codex_home, false);

    let mut title = String::new();
    let mut cwd = String::new();
    let mut model_provider = String::new();
    let mut model = None;
    let mut archived = false;
    let mut updated_at_ms = None;
    let mut matched_database_path = None;
    let mut rollout_path_buf = None;

    for db_path in &database_paths {
        if let Ok(conn) = open_read_only(db_path) {
            if let Ok(true) = table_exists(&conn, "threads") {
                let columns = table_columns(&conn, "threads").unwrap_or_default();
                let title_col =
                    optional_column(&columns, "title", optional_column(&columns, "name", "id"));
                let cwd_col = optional_column(&columns, "cwd", "''");
                let provider_col = optional_column(&columns, "model_provider", "''");
                let model_col = optional_column(&columns, "model", "''");
                let archived_col = optional_column(&columns, "archived", "0");
                let rollout_col = optional_column(&columns, "rollout_path", "''");
                let time_col = optional_column(
                    &columns,
                    "updated_at_ms",
                    optional_column(&columns, "updated_at", "NULL"),
                );

                let query = format!(
                    "SELECT {title_col}, {cwd_col}, {provider_col}, {model_col}, {archived_col}, {rollout_col}, {time_col} FROM threads WHERE id = ?1 LIMIT 1"
                );
                if let Ok(mut stmt) = conn.prepare(&query) {
                    if let Ok(mut rows) = stmt.query([&session_id]) {
                        if let Ok(Some(row)) = rows.next() {
                            matched_database_path = Some(db_path.to_string_lossy().to_string());
                            for (index, field) in
                                [(0, &mut title), (1, &mut cwd), (2, &mut model_provider)]
                            {
                                if let Ok(Some(value)) = row.get::<_, Option<String>>(index) {
                                    if !value.trim().is_empty() {
                                        *field = value;
                                    }
                                }
                            }
                            if let Ok(Some(val)) = row.get::<_, Option<String>>(3) {
                                if !val.trim().is_empty() {
                                    model = Some(val);
                                }
                            }
                            if let Ok(Some(val)) = row.get::<_, Option<i64>>(4) {
                                archived = val != 0;
                            }
                            if let Ok(Some(val)) = row.get::<_, Option<String>>(5) {
                                if !val.trim().is_empty() {
                                    let path = PathBuf::from(val);
                                    rollout_path_buf = validated_rollout_path(codex_home, &path)?;
                                }
                            }
                            if let Ok(Some(val)) = row.get::<_, Option<i64>>(6) {
                                updated_at_ms = Some(if val < 100_000_000_000 {
                                    val.saturating_mul(1000)
                                } else {
                                    val
                                });
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    if rollout_path_buf.is_none() {
        rollout_path_buf = find_rollout_for_session(codex_home, &session_id)?;
    }
    if title.is_empty() {
        if let Some(metadata) = read_session_index_metadata(codex_home)?.get(&session_id) {
            title = metadata.title.clone();
        }
    }
    if let Some(path) = rollout_path_buf.as_deref() {
        archived = archived || is_archived_rollout_path(codex_home, path);
    }

    let mut messages = Vec::new();
    let mut rollout_model = None;
    let mut total_lines = 0usize;
    let mut user_count = 0usize;
    let mut assistant_count = 0usize;
    let mut tool_count = 0usize;
    let mut reasoning_count = 0usize;
    let mut file_size_bytes = 0u64;
    let mut raw_jsonl = None;
    let mut rollout_sha256 = None;

    if let Some(ref path) = rollout_path_buf {
        let file = fs::File::open(path)
            .map_err(|error| format!("Failed to read rollout {}: {error}", path.display()))?;
        let mut hasher = Sha256::new();
        // The export text rides along with the first page only; later pages just append messages.
        let mut raw_bytes = (message_offset == 0).then(Vec::new);
        {
            let mut reader = BufReader::new(file);
            let mut line = Vec::new();
            loop {
                line.clear();
                let read = reader.read_until(b'\n', &mut line).map_err(|error| {
                    format!("Failed to read rollout {}: {error}", path.display())
                })?;
                if read == 0 {
                    break;
                }
                hasher.update(&line);
                file_size_bytes += read as u64;
                if file_size_bytes > MAX_RAW_JSONL_BYTES {
                    raw_bytes = None;
                } else if let Some(bytes) = raw_bytes.as_mut() {
                    bytes.extend_from_slice(&line);
                }
                let idx = total_lines;
                total_lines += 1;
                let Ok(record) = serde_json::from_slice::<Value>(&line) else {
                    continue;
                };
                let rec_type = record
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let payload = record.get("payload");

                if rec_type == "session_meta" {
                    if let Some(payload) = payload {
                        if title.is_empty() {
                            title = payload
                                .get("title")
                                .or_else(|| payload.get("name"))
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                        }
                        if cwd.is_empty() {
                            cwd = payload
                                .get("cwd")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                        }
                        if model_provider.is_empty() {
                            model_provider = payload
                                .get("model_provider")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                        }
                    }
                } else if rec_type == "turn_context" {
                    if let Some(payload) = payload {
                        if let Some(turn_model) = payload.get("model").and_then(Value::as_str) {
                            rollout_model = Some(turn_model.to_string());
                        }
                        if cwd.is_empty() {
                            cwd = payload
                                .get("cwd")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                        }
                    }
                } else if rec_type == "response_item" {
                    let Some(payload) = payload else { continue };
                    let p_type = payload["type"].as_str().unwrap_or_default();
                    let (prefix, role) = match p_type {
                        "message" => {
                            let role = payload["role"].as_str().unwrap_or("unknown");
                            match role {
                                "user" => user_count += 1,
                                "assistant" => assistant_count += 1,
                                _ => {}
                            }
                            ("msg", role)
                        }
                        "reasoning" | "thinking" => {
                            reasoning_count += 1;
                            ("reasoning", "reasoning")
                        }
                        tool if is_tool_response(tool) => {
                            tool_count += 1;
                            ("tool", "tool")
                        }
                        _ => continue,
                    };
                    let position = total_messages;
                    total_messages += 1;
                    // Deleting a tool call also removes its result, so every page needs the full
                    // call-id link set even for messages outside it.
                    if role == "tool" {
                        if let Some(call_id) = payload["call_id"].as_str() {
                            call_lines.entry(call_id.to_string()).or_default().push(idx);
                        }
                    }
                    if position < message_offset || position >= window_end {
                        continue;
                    }
                    messages.push(CodexSessionMessageItem {
                        id: format!("{prefix}-{idx}"),
                        line_number: idx,
                        role: role.to_string(),
                        timestamp: record["timestamp"].as_str().map(str::to_string),
                        content: context_item_content(p_type, payload),
                        linked_lines: Vec::new(),
                        raw_type: rec_type.to_string(),
                        model: rollout_model.clone().or_else(|| model.clone()),
                        call_id: if role == "tool" {
                            payload["call_id"].as_str().map(str::to_string)
                        } else {
                            None
                        },
                        signature_stripped: if role == "reasoning" {
                            payload["signature_stripped"].as_bool()
                        } else {
                            None
                        },
                    });
                }
            }
        }
        raw_jsonl = raw_bytes.and_then(|bytes| String::from_utf8(bytes).ok());
        rollout_sha256 = Some(format!("{:x}", hasher.finalize()));
    } else if matched_database_path.is_none() {
        return Err(format!(
            "Session {session_id} not found in database or rollout files"
        ));
    }

    for message in &mut messages {
        let Some(call_id) = message.call_id.as_deref() else { continue };
        if let Some(lines) = call_lines.get(call_id).filter(|lines| lines.len() > 1) {
            message.linked_lines = lines.clone();
        }
    }
    if model.is_none() {
        model = rollout_model;
    }
    Ok(CodexSessionContextDetail {
        id: session_id,
        title,
        cwd,
        model_provider,
        model,
        archived,
        updated_at_ms,
        rollout_path: rollout_path_buf.map(|path| path.to_string_lossy().to_string()),
        database_path: matched_database_path,
        messages,
        message_offset,
        total_messages,
        stats: CodexSessionContextStats {
            total_lines,
            message_count: user_count + assistant_count + reasoning_count,
            user_message_count: user_count,
            assistant_message_count: assistant_count,
            tool_count,
            reasoning_count,
            file_size_bytes,
        },
        raw_jsonl_available: raw_jsonl.is_some(),
        raw_jsonl,
        rollout_sha256,
    })
}

pub(super) fn save_codex_session_context_from_home(
    codex_home: &Path,
    request: SaveCodexSessionContextRequest,
) -> Result<SaveCodexSessionContextResult, String> {
    let session_id = validate_session_id(&normalize_thread_id(&request.session_id))?;
    let _guard = CODEX_SESSION_WRITE_LOCK
        .lock()
        .map_err(|_| "Codex session write lock is poisoned".to_string())?;
    let rollout_path = find_rollout_for_session(codex_home, &session_id)?;
    let _writer_lock = rollout_path
        .as_ref()
        .map(|_| acquire_session_writer_lock(codex_home, &session_id))
        .transpose()?;
    let database_path = find_session_database_path(codex_home, &session_id)?;
    let thread_history_paths = discover_thread_history_databases(codex_home);
    if rollout_path.is_none() && database_path.is_none() && thread_history_paths.is_empty() {
        return Err(format!("Session {session_id} was not found"));
    }
    let has_structured_changes = request
        .message_updates
        .as_ref()
        .is_some_and(|updates| !updates.is_empty())
        || request
            .new_messages
            .as_ref()
            .is_some_and(|messages| !messages.is_empty());
    if rollout_path.is_none() && has_structured_changes {
        return Err("This session has no rollout file to edit".to_string());
    }
    if rollout_path.is_none() && request.archived.is_some() {
        return Err("This session has no rollout file to archive or restore".to_string());
    }

    let mut original_rollout: Option<Vec<u8>> = None;
    let mut next_rollout: Option<Vec<u8>> = None;
    let mut target_rollout: Option<PathBuf> = None;
    let mut sync_plan = RolloutSyncPlan::default();
    if let Some(path) = rollout_path.as_deref() {
        let original = fs::read(path)
            .map_err(|error| format!("Failed to read rollout {}: {error}", path.display()))?;
        let current_sha256 = sha256_hex(&original);
        let expected_sha256 = request
            .expected_rollout_sha256
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                "The rollout snapshot is missing. Reload the session before saving".to_string()
            })?;
        if current_sha256 != expected_sha256 {
            return Err(
                "The rollout changed after it was loaded. Reload the session before saving"
                    .to_string(),
            );
        }
        let (next, plan) = build_updated_rollout(&original, &session_id, &request)?;
        let target = rollout_archive_target(codex_home, path, request.archived)?;
        ensure_context_path_in_home(codex_home, &target)?;
        if target != path && target.exists() {
            return Err(format!(
                "The archive destination already exists: {}",
                target.display()
            ));
        }
        original_rollout = Some(original);
        next_rollout = Some(next);
        target_rollout = Some(target);
        sync_plan = plan;
    }

    let session_index_update = request
        .title
        .as_deref()
        .map(|title| build_session_index_title_update(codex_home, &session_id, title))
        .transpose()?
        .flatten();

    for path in &thread_history_paths {
        validate_projection_cursor(
            &open_read_only(path)?,
            &session_id,
            sync_plan.original_projection_cursor,
        )
        .map_err(|error| {
            format!("Failed to inspect thread history projection before saving: {error}")
        })?;
    }

    let backup_dir = create_context_edit_backup(
        codex_home,
        &session_id,
        rollout_path.as_deref(),
        original_rollout.as_deref(),
        database_path.as_deref(),
        session_index_update
            .as_ref()
            .map(|update| update.original.as_slice()),
        &thread_history_paths,
    )?;

    let mut written_rollout = rollout_path.clone();
    if let (Some(source), Some(original), Some(next), Some(target)) = (
        rollout_path.as_deref(),
        original_rollout.as_deref(),
        next_rollout.as_deref(),
        target_rollout.as_deref(),
    ) {
        let current = fs::read(source).map_err(|error| {
            format!(
                "Failed to reread rollout {} before saving: {error}",
                source.display()
            )
        })?;
        if current != original {
            return Err(format!(
                "The rollout changed during the save operation; nothing was overwritten. Backup: {}",
                backup_dir.display()
            ));
        }
        if next != original {
            crate::write_bytes_atomically(source, next)?;
        }
        if target != source {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    let _ = rollback_rollout(source, source, original);
                    format!(
                        "Failed to create archive directory {}: {error}",
                        parent.display()
                    )
                })?;
            }
            if let Err(error) = fs::rename(source, target) {
                let rollback = rollback_rollout(source, source, original);
                return Err(match rollback {
                    Ok(()) => format!("Failed to move rollout to {}: {error}", target.display()),
                    Err(rollback_error) => format!(
                        "Failed to move rollout to {}: {error}; rollback also failed: {rollback_error}. Backup: {}",
                        target.display(),
                        backup_dir.display()
                    ),
                });
            }
            written_rollout = Some(target.to_path_buf());
        }
    }

    if let Some(update) = session_index_update.as_ref() {
        if let Err(error) = apply_session_index_title_update(update) {
            let rollout_rollback =
                if let (Some(original_path), Some(current_path), Some(original)) = (
                    rollout_path.as_deref(),
                    written_rollout.as_deref(),
                    original_rollout.as_deref(),
                ) {
                    Some(rollback_rollout(original_path, current_path, original))
                } else {
                    None
                };
            let index_rollback = Some(restore_session_index(update));
            let history_rollback = Some(restore_thread_history_backup(&backup_dir, &session_id));
            return Err(format_save_rollback_error(
                format!("Failed to update session index: {error}"),
                rollout_rollback,
                index_rollback,
                None,
                history_rollback,
                &backup_dir,
            ));
        }
    }

    if let Some(path) = database_path.as_deref() {
        if let Err(error) =
            update_session_database(path, &session_id, &request, written_rollout.as_deref())
        {
            let rollout_rollback =
                if let (Some(original_path), Some(current_path), Some(original)) = (
                    rollout_path.as_deref(),
                    written_rollout.as_deref(),
                    original_rollout.as_deref(),
                ) {
                    Some(rollback_rollout(original_path, current_path, original))
                } else {
                    None
                };
            let index_rollback = session_index_update.as_ref().map(restore_session_index);
            let history_rollback = Some(restore_thread_history_backup(&backup_dir, &session_id));
            return Err(format_save_rollback_error(
                format!("Database update failed: {error}"),
                rollout_rollback,
                index_rollback,
                None,
                history_rollback,
                &backup_dir,
            ));
        }
    }

    if !thread_history_paths.is_empty() {
        if let Err(error) =
            sync_thread_history_projection_databases(&thread_history_paths, &session_id, &sync_plan)
        {
            let rollout_rollback =
                if let (Some(original_path), Some(current_path), Some(original)) = (
                    rollout_path.as_deref(),
                    written_rollout.as_deref(),
                    original_rollout.as_deref(),
                ) {
                    Some(rollback_rollout(original_path, current_path, original))
                } else {
                    None
                };
            let index_rollback = session_index_update.as_ref().map(restore_session_index);
            let history_rollback = Some(restore_thread_history_backup(&backup_dir, &session_id));
            let database_rollback = Some(restore_session_database_backup(&backup_dir));
            return Err(format_save_rollback_error(
                format!("Thread history sync failed: {error}"),
                rollout_rollback,
                index_rollback,
                database_rollback,
                history_rollback,
                &backup_dir,
            ));
        }
    }

    let _ = prune_context_edit_backups(codex_home);

    Ok(SaveCodexSessionContextResult {
        success: true,
        session_id,
        backup_path: Some(backup_dir.to_string_lossy().to_string()),
        message: "Session context successfully updated".to_string(),
    })
}
