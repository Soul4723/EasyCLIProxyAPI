use super::*;

pub(super) struct SessionIndexTitleUpdate {
    pub(super) path: PathBuf,
    pub(super) original: Vec<u8>,
    pub(super) previous: Value,
    pub(super) next: Value,
}

pub(super) fn latest_session_index_entry(bytes: &[u8], session_id: &str) -> Result<Option<Value>, String> {
    let text = std::str::from_utf8(bytes)
        .map_err(|error| format!("session_index.jsonl is not UTF-8: {error}"))?;
    let target = normalize_thread_id(session_id);
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .rfind(|record| {
            record
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| normalize_thread_id(id) == target)
        }))
}

pub(super) fn build_session_index_title_update(
    codex_home: &Path,
    session_id: &str,
    new_title: &str,
) -> Result<Option<SessionIndexTitleUpdate>, String> {
    let path = codex_home.join("session_index.jsonl");
    if !path.is_file() {
        return Ok(None);
    }
    let canonical_home = fs::canonicalize(codex_home)
        .map_err(|error| format!("Failed to resolve Codex home: {error}"))?;
    let path = fs::canonicalize(&path)
        .map_err(|error| format!("Failed to resolve session_index.jsonl: {error}"))?;
    if !path.starts_with(&canonical_home) {
        return Err("session_index.jsonl resolves outside Codex home".to_string());
    }
    let original =
        fs::read(&path).map_err(|error| format!("Failed to read session_index.jsonl: {error}"))?;
    let Some(previous) = latest_session_index_entry(&original, session_id)? else {
        return Ok(None);
    };
    if previous["thread_name"].as_str() == Some(new_title) {
        return Ok(None);
    }
    let mut next = previous.clone();
    next["thread_name"] = json!(new_title);
    next["updated_at"] = json!(Utc::now().to_rfc3339());
    Ok(Some(SessionIndexTitleUpdate {
        path,
        original,
        previous,
        next,
    }))
}

pub(super) fn append_session_index_entry(path: &Path, current: &[u8], entry: &Value) -> Result<(), String> {
    // Preserve the file identity: Codex may already hold an append handle.
    if !current.is_empty() && !current.ends_with(b"\n") {
        return Err(
            "session_index.jsonl has an unterminated record; reload after its writer finishes"
                .to_string(),
        );
    }
    let newline = if current.ends_with(b"\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let bytes = format!("{entry}{newline}");
    OpenOptions::new()
        .append(true)
        .open(path)
        .and_then(|mut file| {
            file.write_all(bytes.as_bytes())?;
            file.sync_all()
        })
        .map_err(|error| format!("Failed to append session_index.jsonl: {error}"))
}

pub(super) fn apply_session_index_title_update(update: &SessionIndexTitleUpdate) -> Result<(), String> {
    let current = fs::read(&update.path)
        .map_err(|error| format!("Failed to reread session_index.jsonl before saving: {error}"))?;
    let id = update.previous["id"].as_str().unwrap_or_default();
    if latest_session_index_entry(&current, id)?.as_ref() != Some(&update.previous) {
        return Err(
            "The session index entry changed during saving; reload before editing".to_string(),
        );
    }
    append_session_index_entry(&update.path, &current, &update.next)
}

pub(super) fn restore_session_index(update: &SessionIndexTitleUpdate) -> Result<(), String> {
    let current = fs::read(&update.path).map_err(|error| {
        format!("Failed to reread session_index.jsonl before rollback: {error}")
    })?;
    let id = update.previous["id"].as_str().unwrap_or_default();
    let latest = latest_session_index_entry(&current, id)?;
    if latest.as_ref() == Some(&update.previous) {
        return Ok(());
    }
    if latest.as_ref() != Some(&update.next) {
        return Err(
            "session_index.jsonl changed externally; refusing to overwrite newer index records"
                .to_string(),
        );
    }
    let mut restored = update.previous.clone();
    restored["updated_at"] = json!(Utc::now().to_rfc3339());
    append_session_index_entry(&update.path, &current, &restored)
}
