use super::*;

pub(super) fn extract_content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(arr) => {
            let mut parts = Vec::new();
            for item in arr {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    parts.push(text);
                } else if let Some(text) = item.as_str() {
                    parts.push(text);
                }
            }
            parts.join("\n")
        }
        Value::Object(obj) => obj
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
}

pub(super) fn extract_reasoning_text(payload: &Value) -> String {
    if let Some(text) = payload.get("thinking").and_then(Value::as_str) {
        return text.to_string();
    }
    for field in ["summary_text", "raw_content", "summary", "content"] {
        if let Some(value) = payload.get(field) {
            let text = extract_content_text(value);
            if !text.is_empty() {
                return text;
            }
        }
    }
    if payload.get("encrypted_content").is_some() {
        return String::from("[Encrypted reasoning block]");
    }
    String::new()
}

pub(super) fn message_content_type(role: Option<&str>) -> &'static str {
    if role == Some("assistant") {
        "output_text"
    } else {
        "input_text"
    }
}

pub(super) fn is_tool_response(payload_type: &str) -> bool {
    matches!(payload_type, "function_call" | "function_call_output")
        || payload_type.contains("tool")
}

pub(super) fn update_content_text(content: &mut Value, new_text: &str, content_type: &str) {
    match content {
        Value::String(_) => {
            *content = Value::String(new_text.to_string());
        }
        Value::Array(arr) => {
            let original = std::mem::take(arr);
            let mut replacement = Vec::with_capacity(original.len());
            let mut updated = false;
            for mut item in original {
                if item.is_string() {
                    if updated {
                        continue;
                    }
                    replacement.push(json!(new_text));
                    updated = true;
                    continue;
                }
                if let Some(obj) = item.as_object_mut() {
                    if obj.contains_key("text") {
                        if updated {
                            continue;
                        }
                        obj.insert("text".to_string(), json!(new_text));
                        if obj.contains_key("text_elements") {
                            obj.insert("text_elements".to_string(), json!([]));
                        }
                        if obj.contains_key("type") {
                            obj.insert("type".to_string(), json!(content_type));
                        }
                        updated = true;
                    }
                }
                replacement.push(item);
            }
            if updated {
                *arr = replacement;
            } else {
                replacement.push(json!({"type": content_type, "text": new_text}));
                *arr = replacement;
            }
        }
        Value::Object(object) if object.contains_key("text") => {
            object.insert("text".to_string(), json!(new_text));
            if object.contains_key("text_elements") {
                object.insert("text_elements".to_string(), json!([]));
            }
            if object.contains_key("type") {
                object.insert("type".to_string(), json!(content_type));
            }
        }
        _ => {
            *content = json!([{"type": content_type, "text": new_text}]);
        }
    }
}

pub(super) fn validate_raw_jsonl(raw_jsonl: &str, session_id: &str) -> Result<Vec<(usize, Value)>, String> {
    let mut records = Vec::new();
    let mut matching_session_meta = false;
    for (line_idx, line) in raw_jsonl.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let record = serde_json::from_str::<Value>(trimmed)
            .map_err(|error| format!("Validation error at line {}: {error}", line_idx + 1))?;
        if !record.is_object() {
            return Err(format!(
                "Validation error at line {}: Each JSONL record must be an object",
                line_idx + 1
            ));
        }
        if record.get("type").and_then(Value::as_str) == Some("session_meta") {
            let record_id = record
                .get("payload")
                .and_then(|payload| payload.get("id"))
                .and_then(Value::as_str);
            if record_id != Some(session_id) {
                return Err(format!(
                    "Validation error at line {}: session_meta belongs to a different session",
                    line_idx + 1
                ));
            }
            matching_session_meta = true;
        }
        records.push((line_idx, record));
    }
    if records.is_empty() {
        return Err("Raw JSONL cannot be empty".to_string());
    }
    if !matching_session_meta {
        return Err(format!(
            "Raw JSONL does not contain session_meta for session {session_id}"
        ));
    }
    Ok(records)
}

pub(super) fn apply_rollout_metadata(record: &mut Value, request: &SaveCodexSessionContextRequest) {
    let record_type = record.get("type").and_then(Value::as_str);
    if record_type == Some("session_meta") {
        if let Some(payload) = record.get_mut("payload").and_then(Value::as_object_mut) {
            if let Some(title) = request.title.as_ref() {
                payload.insert("title".to_string(), json!(title));
            }
            if let Some(cwd) = request.cwd.as_ref() {
                payload.insert("cwd".to_string(), json!(cwd));
            }
            if let Some(provider) = request.model_provider.as_ref() {
                payload.insert("model_provider".to_string(), json!(provider));
            }
        }
    } else if record_type == Some("turn_context") {
        if let Some(payload) = record.get_mut("payload").and_then(Value::as_object_mut) {
            if let Some(cwd) = request.cwd.as_ref() {
                payload.insert("cwd".to_string(), json!(cwd));
            }
            if let Some(model) = request.model.as_ref() {
                payload.insert("model".to_string(), json!(model));
            }
        }
    }
}

pub(super) fn serialize_jsonl(records: &[Value], line_ending: &str) -> Result<Vec<u8>, String> {
    let mut output = String::new();
    for record in records {
        output.push_str(
            &serde_json::to_string(record)
                .map_err(|error| format!("Failed to serialize rollout record: {error}"))?,
        );
        output.push_str(line_ending);
    }
    Ok(output.into_bytes())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TrackedItemKind {
    UserMessage,
    AgentMessage,
    Reasoning,
}

pub(super) fn response_item_retained_id(record: &Value) -> Option<String> {
    record
        .get("metadata")
        .and_then(|metadata| metadata.get("retained_source"))
        .and_then(|source| source.get("id"))
        .and_then(|id_object| id_object.get("message_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(super) fn tracked_item_text(item: &Value, kind: TrackedItemKind) -> String {
    if kind == TrackedItemKind::Reasoning {
        return extract_reasoning_text(item);
    }
    if let Some(text) = item.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            return text.to_string();
        }
    }
    extract_content_text(item.get("content").unwrap_or(&Value::Null))
}

pub(super) fn response_item_text(record: &Value) -> Option<String> {
    if record.get("type").and_then(Value::as_str) != Some("response_item") {
        return None;
    }
    let payload = record.get("payload")?;
    match payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "message" => Some(extract_content_text(
            payload.get("content").unwrap_or(&Value::Null),
        )),
        "reasoning" | "thinking" => Some(extract_reasoning_text(payload)),
        _ => None,
    }
}

/// Writes reasoning text back into the field shape the record already used so a
/// re-read returns the edited value instead of the stale original.
pub(super) fn write_reasoning_text(payload: &mut Map<String, Value>, text: &str) {
    if payload.get("thinking").and_then(Value::as_str).is_some() {
        payload.insert("thinking".to_string(), json!(text));
        return;
    }
    if payload.contains_key("summary") {
        payload.insert(
            "summary".to_string(),
            json!([{ "type": "summary_text", "text": text }]),
        );
        if payload.contains_key("content") {
            payload.insert("content".to_string(), json!([]));
        }
        return;
    }
    if payload.contains_key("content") {
        payload.insert(
            "content".to_string(),
            json!([{ "type": "text", "text": text }]),
        );
        return;
    }
    payload.insert(
        "summary".to_string(),
        json!([{ "type": "summary_text", "text": text }]),
    );
}

/// One physical copy of a projected item inside a rollout. Codex stores every
/// message twice, as a `response_item` plus an `event_msg/item_completed`
/// mirror, so one logical item can own several copies.
#[derive(Debug, Clone)]
pub(super) struct TrackedCopy {
    pub(super) line_index: usize,
    pub(super) kind: TrackedItemKind,
    pub(super) text: String,
    pub(super) is_event_copy: bool,
    pub(super) is_legacy_copy: bool,
    pub(super) turn_id: String,
    pub(super) explicit_id: Option<String>,
}

/// Every copy of one logical item, keyed by the stable item id when the rollout
/// exposes one. Codex records without `retained_source` metadata inherit the id
/// of the duplicated copy they belong to.
#[derive(Debug, Clone)]
pub(super) struct TrackedGroup {
    pub(super) id: Option<String>,
    pub(super) kind: TrackedItemKind,
    pub(super) copies: Vec<TrackedCopy>,
}

impl TrackedGroup {
    pub(super) fn first_line_index(&self) -> usize {
        self.copies
            .iter()
            .map(|copy| copy.line_index)
            .min()
            .unwrap_or_default()
    }
}

pub(super) fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

pub(super) fn tracked_kind_from_item_type(item_type: &str) -> Option<TrackedItemKind> {
    match item_type {
        "UserMessage" => Some(TrackedItemKind::UserMessage),
        "AgentMessage" => Some(TrackedItemKind::AgentMessage),
        "Reasoning" | "reasoning" => Some(TrackedItemKind::Reasoning),
        _ => None,
    }
}

pub(super) fn tracked_kind_from_role(role: &str) -> Option<TrackedItemKind> {
    match role {
        "user" => Some(TrackedItemKind::UserMessage),
        "assistant" => Some(TrackedItemKind::AgentMessage),
        _ => None,
    }
}

pub(super) fn tracked_copies(records: &[Value]) -> Vec<TrackedCopy> {
    let mut copies = Vec::new();
    let mut current_turn_id = String::new();
    for (line_index, record) in records.iter().enumerate() {
        let record_type = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(payload) = record.get("payload") else {
            continue;
        };
        if record_type == "event_msg" {
            let event_type = payload
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if event_type == "task_started" {
                if let Some(turn_id) = payload.get("turn_id").and_then(Value::as_str) {
                    if !turn_id.is_empty() {
                        current_turn_id = turn_id.to_string();
                    }
                }
                continue;
            }
            let turn_id = payload
                .get("turn_id")
                .and_then(Value::as_str)
                .filter(|turn_id| !turn_id.is_empty())
                .unwrap_or(current_turn_id.as_str())
                .to_string();
            if matches!(event_type, "user_message" | "agent_message") {
                copies.push(TrackedCopy {
                    line_index,
                    kind: if event_type == "user_message" {
                        TrackedItemKind::UserMessage
                    } else {
                        TrackedItemKind::AgentMessage
                    },
                    text: payload["message"].as_str().unwrap_or_default().to_string(),
                    is_event_copy: true,
                    is_legacy_copy: true,
                    turn_id,
                    explicit_id: None,
                });
                continue;
            }
            if event_type != "item_completed" {
                continue;
            }
            let Some(item) = payload.get("item") else {
                continue;
            };
            let Some(kind) = tracked_kind_from_item_type(
                item.get("type").and_then(Value::as_str).unwrap_or_default(),
            ) else {
                continue;
            };
            copies.push(TrackedCopy {
                line_index,
                kind,
                text: tracked_item_text(item, kind),
                is_event_copy: true,
                is_legacy_copy: false,
                turn_id,
                explicit_id: non_empty_string(item.get("id")),
            });
            continue;
        }
        if record_type != "response_item" {
            continue;
        }
        let retained_turn_id = record
            .get("metadata")
            .and_then(|metadata| metadata.get("retained_source"))
            .and_then(|source| source.get("id"))
            .and_then(|id_object| id_object.get("turn_id"))
            .and_then(Value::as_str)
            .filter(|turn_id| !turn_id.is_empty());
        let turn_id = retained_turn_id
            .unwrap_or(current_turn_id.as_str())
            .to_string();
        match payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "message" => {
                let Some(kind) = tracked_kind_from_role(
                    payload
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ) else {
                    continue;
                };
                copies.push(TrackedCopy {
                    line_index,
                    kind,
                    text: tracked_item_text(payload, kind),
                    is_event_copy: false,
                    is_legacy_copy: false,
                    turn_id,
                    explicit_id: response_item_retained_id(record),
                });
            }
            "reasoning" | "thinking" => copies.push(TrackedCopy {
                line_index,
                kind: TrackedItemKind::Reasoning,
                text: tracked_item_text(payload, TrackedItemKind::Reasoning),
                is_event_copy: false,
                is_legacy_copy: false,
                turn_id,
                explicit_id: non_empty_string(payload.get("id"))
                    .or_else(|| response_item_retained_id(record)),
            }),
            _ => {}
        }
    }
    copies
}

/// Groups identified copies by (item id, turn); id-less mirrors still match by
/// identical text within the turn. Order alone cannot distinguish an injected
/// context message from a mirror of an actual user message.
pub(super) fn group_tracked_copies(copies: Vec<TrackedCopy>) -> Vec<TrackedGroup> {
    let mut groups: Vec<TrackedGroup> = Vec::new();
    let mut group_index_by_key: HashMap<(String, String), usize> = HashMap::new();
    let mut orphans: Vec<TrackedCopy> = Vec::new();

    for copy in copies {
        match copy.explicit_id.clone() {
            Some(id) => {
                let key = (id.clone(), copy.turn_id.clone());
                match group_index_by_key.get(&key).copied() {
                    Some(index) => groups[index].copies.push(copy),
                    None => {
                        group_index_by_key.insert(key, groups.len());
                        groups.push(TrackedGroup {
                            id: Some(id),
                            kind: copy.kind,
                            copies: vec![copy],
                        });
                    }
                }
            }
            None => orphans.push(copy),
        }
    }

    for orphan in orphans {
        let mut text_match: Option<usize> = None;
        for (index, group) in groups.iter().enumerate() {
            if group.kind != orphan.kind {
                continue;
            }
            if group.copies.iter().any(|copy| {
                copy.is_event_copy == orphan.is_event_copy
                    && copy.is_legacy_copy == orphan.is_legacy_copy
            }) {
                continue;
            }
            if !orphan.turn_id.is_empty()
                && group
                    .copies
                    .iter()
                    .all(|copy| copy.turn_id != orphan.turn_id)
            {
                continue;
            }
            if group.copies.iter().any(|copy| copy.text == orphan.text) {
                text_match = Some(index);
                break;
            }
        }
        match text_match {
            Some(index) => groups[index].copies.push(orphan),
            None => {
                let kind = orphan.kind;
                groups.push(TrackedGroup {
                    id: None,
                    kind,
                    copies: vec![orphan],
                });
            }
        }
    }

    for group in groups.iter_mut() {
        group.copies.sort_by_key(|copy| copy.line_index);
    }
    groups.sort_by_key(TrackedGroup::first_line_index);
    groups
}

pub(super) fn group_turn_id(group: &TrackedGroup, fallback: &str) -> String {
    group
        .copies
        .iter()
        .map(|copy| copy.turn_id.as_str())
        .find(|turn| !turn.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

pub(super) fn group_ordinal(records: &[Value], group: &TrackedGroup) -> Option<i64> {
    let copy = group
        .copies
        .iter()
        .find(|copy| copy.is_event_copy && !copy.is_legacy_copy)
        .or_else(|| group.copies.iter().find(|copy| !copy.is_event_copy))
        .or_else(|| group.copies.first())?;
    Some(
        records
            .get(copy.line_index)?
            .get("ordinal")
            .and_then(Value::as_i64)
            .unwrap_or(copy.line_index as i64),
    )
}

/// Resolve item positions after missing ordinals have been stamped.
pub(super) fn collect_projection_positions(records: &[Value], serialized: &[u8], plan: &mut RolloutSyncPlan) {
    let fallback_turn_id = rollout_last_turn_id(records, "");
    for group in group_tracked_copies(tracked_copies(records)) {
        if let (Some(id), Some(ordinal)) = (group.id.as_ref(), group_ordinal(records, &group)) {
            let turn_id = group_turn_id(&group, &fallback_turn_id);
            plan.item_ordinals.insert((id.clone(), turn_id), ordinal);
        }
    }
    let mut byte_offset = 0;
    let mut current_turn = String::new();
    for (index, (record, line)) in records
        .iter()
        .zip(serialized.split_inclusive(|byte| *byte == b'\n'))
        .enumerate()
    {
        let end_offset = byte_offset + line.len() as i64;
        let ordinal = record
            .get("ordinal")
            .and_then(Value::as_i64)
            .unwrap_or(index as i64);
        if record.get("type").and_then(Value::as_str) == Some("event_msg") {
            if let Some(payload) = record.get("payload") {
                let event_type = payload
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let turn_id = payload
                    .get("turn_id")
                    .and_then(Value::as_str)
                    .unwrap_or(&current_turn)
                    .to_string();
                if event_type == "task_started" {
                    current_turn = turn_id.clone();
                }
                if !turn_id.is_empty()
                    && matches!(
                        event_type,
                        "task_started" | "item_completed" | "task_complete" | "turn_aborted"
                    )
                {
                    let position =
                        plan.turn_positions
                            .entry(turn_id.clone())
                            .or_insert(RolloutTurnPosition {
                                ordinal,
                                byte_offset,
                                end_ordinal: None,
                                end_byte_offset: None,
                                status: "inProgress",
                                started_at: None,
                                completed_at: None,
                                duration_ms: None,
                                error_json: None,
                                root_turn_id: None,
                            });
                    position.started_at = payload["started_at"].as_i64().or(position.started_at);
                    position.root_turn_id = non_empty_string(payload.get("root_turn_id"))
                        .or_else(|| position.root_turn_id.clone());
                    if matches!(event_type, "task_complete" | "turn_aborted") {
                        position.end_ordinal = Some(ordinal);
                        position.end_byte_offset = Some(end_offset);
                        position.error_json = payload
                            .get("error")
                            .filter(|error| !error.is_null())
                            .map(Value::to_string);
                        position.status = if event_type == "turn_aborted" {
                            "interrupted"
                        } else if position.error_json.is_some() {
                            "failed"
                        } else {
                            "completed"
                        };
                        position.completed_at = payload["completed_at"].as_i64();
                        position.duration_ms = payload["duration_ms"].as_i64();
                    }
                    // Tool items also have canonical completion records.
                    if event_type == "item_completed" {
                        if let Some(id) = payload
                            .get("item")
                            .and_then(|item| item.get("id"))
                            .and_then(Value::as_str)
                        {
                            plan.item_ordinals
                                .insert((id.to_string(), turn_id), ordinal);
                        }
                    }
                }
            }
        }
        byte_offset = end_offset;
    }
}

/// Each completion summarizes only the retained assistants preceding it in its turn.
pub(super) fn refresh_task_complete_messages(
    records: &mut [Value],
    turns: &HashSet<String>,
    session_id: &str,
) {
    let groups = group_tracked_copies(tracked_copies(records));
    let mut agents_by_line = HashMap::new();
    for group in &groups {
        if group.kind != TrackedItemKind::AgentMessage {
            continue;
        }
        if let Some(copy) = group
            .copies
            .iter()
            .find(|copy| copy.is_event_copy && !copy.is_legacy_copy)
            .or_else(|| group.copies.iter().find(|copy| !copy.is_event_copy))
            .or_else(|| group.copies.first())
        {
            agents_by_line.insert(
                copy.line_index,
                (group_turn_id(group, session_id), copy.text.clone()),
            );
        }
    }
    let mut last_by_turn = HashMap::new();
    let mut current_turn = session_id.to_string();
    for (line_index, record) in records.iter_mut().enumerate() {
        if let Some((turn, text)) = agents_by_line.get(&line_index) {
            last_by_turn.insert(turn.clone(), text.clone());
        }
        if record.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let Some(payload) = record.get_mut("payload").and_then(Value::as_object_mut) else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) == Some("task_started") {
            if let Some(turn) = non_empty_string(payload.get("turn_id")) {
                current_turn = turn;
            }
        } else if payload.get("type").and_then(Value::as_str) == Some("task_complete") {
            let turn =
                non_empty_string(payload.get("turn_id")).unwrap_or_else(|| current_turn.clone());
            if turns.contains(&turn) {
                payload.insert(
                    "last_agent_message".to_string(),
                    last_by_turn
                        .get(&turn)
                        .cloned()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                );
            }
        }
    }
}

pub(super) fn strip_reasoning_signature(object: &mut Map<String, Value>) {
    object.remove("signature");
    object.remove("encrypted_content");
    object.insert("signature_stripped".to_string(), json!(true));
}

pub(super) fn rollout_last_turn_id(records: &[Value], session_id: &str) -> String {
    let mut last_turn_id = String::new();
    for record in records {
        if record.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        let Some(payload) = record.get("payload") else {
            continue;
        };
        match payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "task_started" | "item_completed" | "task_complete" | "turn_aborted" => {
                if let Some(turn_id) = payload.get("turn_id").and_then(Value::as_str) {
                    if !turn_id.is_empty() {
                        last_turn_id = turn_id.to_string();
                    }
                }
            }
            _ => {}
        }
    }
    if last_turn_id.is_empty() {
        session_id.to_string()
    } else {
        last_turn_id
    }
}

pub(super) fn rewrite_event_item_text(
    item_object: &mut Map<String, Value>,
    kind: TrackedItemKind,
    text: &str,
) {
    if kind == TrackedItemKind::Reasoning {
        item_object.insert("summary_text".to_string(), json!([text]));
        item_object.insert("raw_content".to_string(), json!([]));
        strip_reasoning_signature(item_object);
        return;
    }
    if item_object.contains_key("text") {
        item_object.insert("text".to_string(), json!(text));
    }
    let content = item_object.entry("content").or_insert_with(|| json!([]));
    update_content_text(
        content,
        text,
        if kind == TrackedItemKind::UserMessage {
            "text"
        } else {
            "Text"
        },
    );
}

/// Keeps the ordinals a rollout already stores and only stamps the next
/// sequential values onto records that lack one, so ordinal gaps, unknown
/// records and existing history bases keep their meaning. Returns the ordinal
/// that follows the last record.
pub(super) fn stamp_rollout_ordinals(mut records: Vec<Value>) -> (Vec<Value>, i64) {
    let highest = records
        .iter()
        .filter_map(|record| record.get("ordinal").and_then(Value::as_i64))
        .max();
    let Some(highest) = highest else {
        let line_count = records.len() as i64;
        return (records, line_count);
    };
    let mut next_ordinal = highest + 1;
    for record in records.iter_mut() {
        let Some(record_map) = record.as_object_mut() else {
            continue;
        };
        if !record_map.contains_key("ordinal") {
            record_map.insert("ordinal".to_string(), json!(next_ordinal));
            next_ordinal += 1;
        }
    }
    (records, next_ordinal)
}

pub(super) fn build_updated_rollout(
    original: &[u8],
    session_id: &str,
    request: &SaveCodexSessionContextRequest,
) -> Result<(Vec<u8>, RolloutSyncPlan), String> {
    let source = std::str::from_utf8(original)
        .map_err(|error| format!("Rollout JSONL is not UTF-8: {error}"))?;
    let line_ending = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let parsed = validate_raw_jsonl(source, session_id)?;

    let mut sync_plan = RolloutSyncPlan::default();
    let updates = request
        .message_updates
        .as_ref()
        .map(|items| {
            items
                .iter()
                .map(|item| (item.line_number, item))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();

    let removed_call_ids = parsed
        .iter()
        .filter(|(line_number, _)| {
            updates
                .get(line_number)
                .is_some_and(|update| update.deleted == Some(true))
        })
        .filter_map(|(_, record)| {
            let payload = record.get("payload")?;
            let payload_type = payload.get("type")?.as_str()?;
            if record.get("type").and_then(Value::as_str) != Some("response_item")
                || !is_tool_response(payload_type)
            {
                return None;
            }
            payload
                .get("call_id")?
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .collect::<HashSet<_>>();

    let original_records = parsed
        .iter()
        .map(|(_, record)| record.clone())
        .collect::<Vec<_>>();
    sync_plan.original_projection_cursor = Some(RolloutProjectionCursor {
        byte_offset: original.len() as i64,
        next_ordinal: original_records
            .iter()
            .filter_map(|record| record["ordinal"].as_i64())
            .max()
            .map_or(original_records.len() as i64, |ordinal| ordinal + 1),
    });
    let groups = group_tracked_copies(tracked_copies(&original_records));
    let last_turn_id = rollout_last_turn_id(&original_records, session_id);
    let mut response_to_sync_info = HashMap::new();
    for group in &groups {
        let turn = group_turn_id(group, &last_turn_id);
        let role = match group.kind {
            TrackedItemKind::UserMessage => "user",
            TrackedItemKind::AgentMessage => "assistant",
            TrackedItemKind::Reasoning => "reasoning",
        };
        let events = group
            .copies
            .iter()
            .filter(|copy| copy.is_event_copy)
            .map(|copy| parsed[copy.line_index].0)
            .collect::<Vec<_>>();
        for copy in group.copies.iter().filter(|copy| !copy.is_event_copy) {
            response_to_sync_info.insert(
                parsed[copy.line_index].0,
                (
                    turn.clone(),
                    role.to_string(),
                    group.id.clone(),
                    events.clone(),
                ),
            );
        }
    }

    let mut deleted_lines = HashSet::new();
    let mut updated_event_content = HashMap::new();
    let mut touched_agent_turns = HashSet::new();
    let mut original_line_text: HashMap<usize, String> = HashMap::new();
    for (line_idx, record) in &parsed {
        if let Some(text) = response_item_text(record) {
            original_line_text.insert(*line_idx, text);
        }
    }

    let mut update_line_numbers = updates.keys().copied().collect::<Vec<_>>();
    update_line_numbers.sort_unstable();
    for line_number in update_line_numbers {
        let update = updates[&line_number];
        if update.deleted == Some(true) {
            deleted_lines.insert(line_number);
            if let Some((turn_id, role, item_id, event_lines)) =
                response_to_sync_info.get(&line_number)
            {
                deleted_lines.extend(event_lines);
                if let Some(item_id) = item_id {
                    sync_plan
                        .deleted_item_keys
                        .insert((item_id.clone(), turn_id.clone()));
                }
                if role == "assistant" {
                    touched_agent_turns.insert(turn_id.clone());
                }
            }
        } else if update.content.is_some() || update.role.is_some() {
            if let Some((turn_id, original_role, item_id, event_lines)) =
                response_to_sync_info.get(&line_number)
            {
                if let Some(requested_role) = update.role.as_deref() {
                    if requested_role != original_role {
                        return Err(format!(
                            "Line {} cannot change the message role from {original_role} to {requested_role}; remove the message and add a new one instead",
                            line_number + 1
                        ));
                    }
                }
                let new_text = update
                    .content
                    .clone()
                    .or_else(|| original_line_text.get(&line_number).cloned())
                    .ok_or_else(|| format!("Line {} has no editable text", line_number + 1))?;
                for event_line in event_lines {
                    updated_event_content.insert(*event_line, new_text.clone());
                }
                if let Some(item_id) = item_id {
                    sync_plan.updated_items.push(RolloutItemSync {
                        item_id: item_id.clone(),
                        turn_id: turn_id.clone(),
                        item_type: match original_role.as_str() {
                            "user" => "userMessage",
                            "reasoning" => "reasoning",
                            _ => "agentMessage",
                        }
                        .to_string(),
                        text: new_text.clone(),
                    });
                }
                if original_role == "assistant" {
                    touched_agent_turns.insert(turn_id.clone());
                }
            }
        }
    }

    let mut tool_turn_id = String::new();
    for (line_idx, record) in &parsed {
        if record.get("type").and_then(Value::as_str) == Some("response_item") {
            if let Some(call_id) = record
                .get("payload")
                .and_then(|payload| payload.get("call_id"))
                .and_then(Value::as_str)
            {
                if removed_call_ids.contains(call_id) && !tool_turn_id.is_empty() {
                    sync_plan
                        .deleted_item_keys
                        .insert((call_id.to_string(), tool_turn_id.clone()));
                }
            }
        }
        if record.get("type").and_then(Value::as_str) == Some("event_msg") {
            if let Some(payload) = record.get("payload") {
                if payload.get("type").and_then(Value::as_str) == Some("task_started") {
                    tool_turn_id = payload
                        .get("turn_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                }
                if payload.get("type").and_then(Value::as_str) == Some("item_completed") {
                    if let Some(item) = payload.get("item") {
                        if let Some(item_id) = item.get("id").and_then(Value::as_str) {
                            if removed_call_ids.contains(item_id) {
                                deleted_lines.insert(*line_idx);
                                let turn_id = payload
                                    .get("turn_id")
                                    .and_then(Value::as_str)
                                    .unwrap_or(&tool_turn_id);
                                if !turn_id.is_empty() {
                                    sync_plan
                                        .deleted_item_keys
                                        .insert((item_id.to_string(), turn_id.to_string()));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let mut applied_updates = HashSet::new();
    let mut records = Vec::with_capacity(parsed.len());
    for (line_number, mut record) in parsed {
        if let Some(update) = updates.get(&line_number) {
            let payload_type = record
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let editable = record.get("type").and_then(Value::as_str) == Some("response_item")
                && (payload_type == "message"
                    || is_tool_response(payload_type)
                    || payload_type == "reasoning"
                    || payload_type == "thinking");
            if !editable {
                return Err(format!(
                    "Line {} is not an editable session message",
                    line_number + 1
                ));
            }
            applied_updates.insert(line_number);
            if update.deleted == Some(true) {
                continue;
            }
            if update.content.is_some() || update.role.is_some() {
                if payload_type == "message" {
                    let payload = record
                        .get_mut("payload")
                        .and_then(Value::as_object_mut)
                        .ok_or_else(|| {
                            format!("Line {} has no message payload", line_number + 1)
                        })?;
                    if let Some(role) = update.role.as_ref() {
                        if !matches!(role.as_str(), "user" | "assistant" | "system" | "developer") {
                            return Err(format!("Unsupported message role: {role}"));
                        }
                        payload.insert("role".to_string(), json!(role));
                    }
                    let role = payload
                        .get("role")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let content_value = payload.get_mut("content").ok_or_else(|| {
                        format!("Line {} has no message content", line_number + 1)
                    })?;
                    let text = update
                        .content
                        .clone()
                        .unwrap_or_else(|| extract_content_text(content_value));
                    update_content_text(
                        content_value,
                        &text,
                        message_content_type(role.as_deref()),
                    );
                } else if payload_type == "reasoning" || payload_type == "thinking" {
                    let payload = record
                        .get_mut("payload")
                        .and_then(Value::as_object_mut)
                        .ok_or_else(|| {
                            format!("Line {} has no reasoning payload", line_number + 1)
                        })?;
                    let existing_text = extract_reasoning_text(&Value::Object(payload.clone()));
                    let text = update.content.clone().unwrap_or(existing_text);
                    strip_reasoning_signature(payload);
                    write_reasoning_text(payload, &text);
                } else {
                    return Err(format!(
                        "Line {} only supports removal, not message editing",
                        line_number + 1
                    ));
                }
            }
        }

        if deleted_lines.contains(&line_number) {
            continue;
        }

        if record.get("type").and_then(Value::as_str) == Some("response_item") {
            if let Some(payload) = record.get("payload") {
                if is_tool_response(
                    payload
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ) && payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .is_some_and(|call_id| removed_call_ids.contains(call_id))
                {
                    continue;
                }
            }
        } else if record.get("type").and_then(Value::as_str) == Some("event_msg") {
            if let Some(new_text) = updated_event_content.get(&line_number) {
                if matches!(
                    record["payload"]["type"].as_str(),
                    Some("user_message" | "agent_message")
                ) {
                    record["payload"]["message"] = json!(new_text);
                }
                if let Some(item_obj) = record
                    .get_mut("payload")
                    .and_then(|p| p.get_mut("item"))
                    .and_then(Value::as_object_mut)
                {
                    let item_type = item_obj
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let kind = tracked_kind_from_item_type(item_type)
                        .unwrap_or(TrackedItemKind::AgentMessage);
                    rewrite_event_item_text(item_obj, kind, new_text);
                }
            }
        }

        apply_rollout_metadata(&mut record, request);
        records.push(record);
    }

    if applied_updates.len() != updates.len() {
        return Err(
            "One or more edited message lines no longer exist; reload the session".to_string(),
        );
    }

    let mut added_records = Vec::new();
    for (message_index, message) in request
        .new_messages
        .as_deref()
        .unwrap_or_default()
        .iter()
        .enumerate()
    {
        if message.content.trim().is_empty() {
            continue;
        }
        if !matches!(message.role.as_str(), "user" | "assistant") {
            return Err(format!("Unsupported new message role: {}", message.role));
        }
        let now_ts = Utc::now().to_rfc3339();
        let now_ms = Utc::now().timestamp_millis();
        let unique_item_id = format!("msg-added-{:x}-{:x}", now_ms, message_index);
        let content_type = message_content_type(Some(&message.role));

        let response = json!({
            "timestamp": now_ts, "type": "response_item",
            "payload": { "type": "message", "role": message.role,
                "content": [{ "type": content_type, "text": message.content }] }
        });
        let event = json!({
            "timestamp": now_ts, "type": "event_msg",
            "payload": { "type": "item_completed", "thread_id": session_id,
                "turn_id": last_turn_id, "completed_at_ms": now_ms, "started_at_ms": now_ms,
                "item": { "id": unique_item_id,
                    "type": if message.role == "user" { "UserMessage" } else { "AgentMessage" },
                    "content": [{ "type": if message.role == "user" { "text" } else { "Text" }, "text": message.content }] } }
        });
        if message.role == "user" {
            added_records.extend([response, event]);
        } else {
            added_records.extend([event, response]);
            touched_agent_turns.insert(last_turn_id.clone());
        }
        sync_plan.new_items.push(RolloutItemSync {
            item_id: unique_item_id,
            turn_id: last_turn_id.clone(),
            item_type: if message.role == "user" {
                "userMessage"
            } else {
                "agentMessage"
            }
            .to_string(),
            text: message.content.clone(),
        });
    }

    if !added_records.is_empty() {
        let has_turn = original_records.iter().any(|record| {
            record["type"] == "event_msg"
                && matches!(
                    record["payload"]["type"].as_str(),
                    Some("task_started" | "item_completed" | "task_complete" | "turn_aborted")
                )
                && record["payload"]["turn_id"].as_str() == Some(last_turn_id.as_str())
        });
        if !has_turn {
            let timestamp = Utc::now();
            added_records.insert(
                0,
                json!({
                    "timestamp": timestamp.to_rfc3339(), "type": "event_msg",
                    "payload": { "type": "task_started", "turn_id": last_turn_id,
                        "started_at": timestamp.timestamp() }
                }),
            );
            added_records.push(json!({
                "timestamp": timestamp.to_rfc3339(), "type": "event_msg",
                "payload": { "type": "task_complete", "turn_id": last_turn_id,
                    "started_at": timestamp.timestamp(), "completed_at": timestamp.timestamp(),
                    "duration_ms": 0, "last_agent_message": null }
            }));
        }
        // Add within the last turn, before its existing terminal record. Keep
        // completed/aborted status and timing; an open turn stays open.
        let mut insertion = records.len();
        let mut current_turn = session_id.to_string();
        for (index, record) in records.iter().enumerate() {
            if record["type"] != "event_msg" {
                continue;
            }
            let payload = &record["payload"];
            if payload["type"] == "task_started" {
                if let Some(turn) = non_empty_string(payload.get("turn_id")) {
                    current_turn = turn;
                }
            }
            let turn = payload["turn_id"]
                .as_str()
                .filter(|turn| !turn.is_empty())
                .unwrap_or(&current_turn);
            if turn == last_turn_id
                && matches!(
                    payload["type"].as_str(),
                    Some("task_complete" | "turn_aborted")
                )
            {
                insertion = index;
            }
        }
        // Explicit ordinals must remain increasing across an insertion. Shift
        // only the suffix; preserve earlier positions and existing gaps.
        let (mut stamped, _) = stamp_rollout_ordinals(records);
        if let Some(first) = stamped
            .get(insertion)
            .and_then(|record| record["ordinal"].as_i64())
        {
            for (index, record) in added_records.iter_mut().enumerate() {
                record["ordinal"] = json!(first + index as i64);
            }
            for record in &mut stamped[insertion..] {
                if let Some(ordinal) = record["ordinal"].as_i64() {
                    record["ordinal"] = json!(ordinal + added_records.len() as i64);
                }
            }
        }
        stamped.splice(insertion..insertion, added_records);
        records = stamped;
    }
    refresh_task_complete_messages(&mut records, &touched_agent_turns, session_id);

    let (records, next_ordinal) = stamp_rollout_ordinals(records);
    let serialized = serialize_jsonl(&records, line_ending)?;
    collect_projection_positions(&records, &serialized, &mut sync_plan);
    sync_plan.appended_ordinal = next_ordinal;
    sync_plan.projection_cursor = Some(RolloutProjectionCursor {
        byte_offset: serialized.len() as i64,
        next_ordinal,
    });
    Ok((serialized, sync_plan))
}
