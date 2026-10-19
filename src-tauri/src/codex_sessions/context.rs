use super::*;

mod commands;
pub(crate) use commands::*;
mod files;
use files::*;
mod backup;
use backup::*;
mod rollout;
use rollout::*;
mod database;
use database::*;
mod index;
use index::*;

#[cfg(test)]
mod tests;
use rusqlite::OptionalExtension;
use std::fs::OpenOptions;
use std::io::Write;

const MAX_RAW_JSONL_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GetCodexSessionContextRequest {
    pub(crate) session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSessionMessageItem {
    pub(crate) id: String,
    pub(crate) line_number: usize,
    pub(crate) role: String,
    pub(crate) timestamp: Option<String>,
    pub(crate) content: String,
    pub(crate) raw_type: String,
    pub(crate) model: Option<String>,
    pub(crate) call_id: Option<String>,
    #[serde(default)]
    pub(crate) signature_stripped: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSessionContextStats {
    pub(crate) total_lines: usize,
    pub(crate) message_count: usize,
    pub(crate) user_message_count: usize,
    pub(crate) assistant_message_count: usize,
    pub(crate) tool_count: usize,
    #[serde(default)]
    pub(crate) reasoning_count: usize,
    pub(crate) file_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSessionContextDetail {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) cwd: String,
    pub(crate) model_provider: String,
    pub(crate) model: Option<String>,
    pub(crate) archived: bool,
    pub(crate) updated_at_ms: Option<i64>,
    pub(crate) rollout_path: Option<String>,
    pub(crate) database_path: Option<String>,
    pub(crate) messages: Vec<CodexSessionMessageItem>,
    pub(crate) stats: CodexSessionContextStats,
    pub(crate) raw_jsonl: Option<String>,
    pub(crate) raw_jsonl_available: bool,
    pub(crate) rollout_sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSessionMessageUpdate {
    pub(crate) line_number: usize,
    pub(crate) role: Option<String>,
    pub(crate) content: Option<String>,
    pub(crate) deleted: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSessionNewMessage {
    pub(crate) role: String,
    pub(crate) content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveCodexSessionContextRequest {
    pub(crate) session_id: String,
    pub(crate) expected_rollout_sha256: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) model_provider: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) archived: Option<bool>,
    pub(crate) message_updates: Option<Vec<CodexSessionMessageUpdate>>,
    pub(crate) new_messages: Option<Vec<CodexSessionNewMessage>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveCodexSessionContextResult {
    pub(crate) success: bool,
    pub(crate) session_id: String,
    pub(crate) backup_path: Option<String>,
    pub(crate) message: String,
}
#[derive(Debug, Clone, Default)]
struct RolloutItemSync {
    item_id: String,
    turn_id: String,
    item_type: String,
    text: String,
}

#[derive(Debug, Clone, Default)]
struct RolloutSyncPlan {
    updated_items: Vec<RolloutItemSync>,
    deleted_item_keys: HashSet<(String, String)>,
    new_items: Vec<RolloutItemSync>,
    /// `None` when no rollout was rewritten, so an existing projection cursor is
    /// left untouched instead of being reset to zero.
    projection_cursor: Option<RolloutProjectionCursor>,
    original_projection_cursor: Option<RolloutProjectionCursor>,
    /// Fallback ordinal for a projected item without a canonical rollout copy.
    appended_ordinal: i64,
    /// Rollout ordinal each projected item already carries, so the local history
    /// rows keep the position the rollout stores instead of a re-sequenced line
    /// number.
    item_ordinals: HashMap<(String, String), i64>,
    turn_positions: HashMap<String, RolloutTurnPosition>,
}

#[derive(Debug, Clone)]
struct RolloutTurnPosition {
    ordinal: i64,
    byte_offset: i64,
    end_ordinal: Option<i64>,
    end_byte_offset: Option<i64>,
    status: &'static str,
    started_at: Option<i64>,
    completed_at: Option<i64>,
    duration_ms: Option<i64>,
    error_json: Option<String>,
    root_turn_id: Option<String>,
}

/// Byte offset and next ordinal the local history projection must resume from
/// after a rollout rewrite.
#[derive(Debug, Clone, Copy)]
struct RolloutProjectionCursor {
    byte_offset: i64,
    next_ordinal: i64,
}
