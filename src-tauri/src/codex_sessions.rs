//! Codex session commands and shared request/result types.
//!
//! - `database`: database discovery and read helpers
//! - `listing`: session listing and merging
//! - `deletion`: deletion plans and backups
//! - `repair`: metadata repair and backup maintenance
//! - `index`: session index cleanup
//! - `process`: process guards

use base64::Engine;
use chrono::Utc;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, ToSql};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

pub(crate) mod context;

const DEFAULT_PAGE_SIZE: usize = 50;
const MAX_PAGE_SIZE: usize = 100;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const REPAIR_BACKUP_KEEP_COUNT: usize = 5;
const REPAIR_PROGRESS_EVENT: &str = "codex-session-repair-progress";
const SESSION_DIRS: [&str; 2] = ["sessions", "archived_sessions"];
const REFERENCE_TABLE_COLUMNS: [(&str, &str); 12] = [
    ("threads", "id"),
    ("local_thread_catalog", "thread_id"),
    ("automation_runs", "thread_id"),
    ("inbox_items", "thread_id"),
    ("sessions", "id"),
    ("messages", "session_id"),
    ("thread_dynamic_tools", "thread_id"),
    ("thread_goals", "thread_id"),
    ("thread_spawn_edges", "parent_thread_id"),
    ("thread_spawn_edges", "child_thread_id"),
    ("stage1_outputs", "thread_id"),
    ("agent_job_items", "assigned_thread_id"),
];

static CODEX_SESSION_WRITE_LOCK: Mutex<()> = Mutex::new(());
static BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListCodexSessionsRequest {
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_page_size")]
    limit: usize,
}

fn default_page_size() -> usize {
    DEFAULT_PAGE_SIZE
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSessionSummary {
    id: String,
    title: String,
    cwd: String,
    model_provider: String,
    archived: bool,
    updated_at_ms: Option<i64>,
    database_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSessionPage {
    codex_home: String,
    database_paths: Vec<String>,
    sessions: Vec<CodexSessionSummary>,
    total_count: usize,
    offset: usize,
    limit: usize,
    has_more: bool,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteCodexSessionsRequest {
    session_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSessionDeleteResult {
    session_id: String,
    status: String,
    message: String,
    backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSessionDeleteBatchResult {
    results: Vec<CodexSessionDeleteResult>,
    deleted_count: usize,
    failed_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSessionRepairProgress {
    phase: String,
    percent: u8,
    processed: usize,
    total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSessionRepairResult {
    target_provider: String,
    changed_rollout_files: usize,
    sqlite_rows_updated: usize,
    skipped_locked_files: Vec<String>,
    backup_path: Option<String>,
    encrypted_content_warning: Option<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionIndexCleanupCandidate {
    id: String,
    thread_name: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionIndexCleanupPreview {
    snapshot_sha256: String,
    candidates: Vec<SessionIndexCleanupCandidate>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApplySessionIndexCleanupRequest {
    snapshot_sha256: String,
    thread_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionIndexCleanupResult {
    pruned_entries: usize,
    backup_path: Option<String>,
}

#[derive(Debug)]
struct DatabaseDeletePlan {
    path: PathBuf,
    tables: Map<String, Value>,
    rollout_paths: Vec<PathBuf>,
    has_thread_row: bool,
    has_automation_rows: bool,
}

#[derive(Debug, Clone)]
struct RolloutRepair {
    path: PathBuf,
    original_len: u64,
    original_mtime: Option<SystemTime>,
    thread_id: Option<String>,
    cwd: Option<String>,
    has_user_event: bool,
    providers: Vec<String>,
    encrypted_content: bool,
    changed: bool,
}

#[derive(Debug)]
struct SessionIndexPlan {
    path: PathBuf,
    original: Vec<u8>,
    original_text: String,
    snapshot_sha256: String,
    candidates: Vec<SessionIndexCleanupCandidate>,
}

#[derive(Debug, Clone)]
struct SessionIndexMetadata {
    title: String,
    updated_at_ms: Option<i64>,
}

#[tauri::command]
pub(crate) async fn list_codex_sessions(
    app: tauri::AppHandle,
    request: Option<ListCodexSessionsRequest>,
) -> Result<CodexSessionPage, String> {
    let expected = app.state::<crate::GuiConfigState>().snapshot()?;
    crate::core_connection::require_local(&expected)?;
    let user_home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to get user directory: {error}"))?;
    let codex_home = resolve_codex_home(&user_home);
    let request = request.unwrap_or(ListCodexSessionsRequest {
        offset: 0,
        limit: DEFAULT_PAGE_SIZE,
    });
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::GuiConfigState>();
        let _target_operation = state.blocking_local_target_operation(&expected)?;
        list_codex_sessions_from_home(&codex_home, request.offset, request.limit)
    })
    .await
    .map_err(|error| format!("Failed to read Codex session task: {error}"))?
}

#[tauri::command]
pub(crate) async fn delete_codex_sessions(
    app: tauri::AppHandle,
    request: DeleteCodexSessionsRequest,
) -> Result<CodexSessionDeleteBatchResult, String> {
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
        delete_codex_sessions_from_home(&codex_home, request.session_ids)
    })
    .await
    .map_err(|error| format!("Failed to delete Codex session task: {error}"))?
}

#[tauri::command]
pub(crate) async fn repair_codex_session_metadata(
    app: tauri::AppHandle,
    expected_provider: Option<String>,
) -> Result<CodexSessionRepairResult, String> {
    let expected = app.state::<crate::GuiConfigState>().snapshot()?;
    crate::core_connection::require_local(&expected)?;
    let user_home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to get user directory: {error}"))?;
    let codex_home = resolve_codex_home(&user_home);
    let progress_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::GuiConfigState>();
        let _target_operation = state.blocking_local_target_operation(&expected)?;
        let _guard = crate::AGENT_CONFIG_FILE_LOCK.lock()
            .map_err(|_| "Agent configuration file lock is poisoned".to_string())?;
        let target_provider = resolve_current_codex_provider(&codex_home)?;
        if expected_provider.as_deref().is_some_and(|expected| expected != target_provider) {
            return Err("Codex provider changed before session synchronization. Refresh and try again".to_string());
        }
        repair_codex_session_metadata_from_home(&codex_home, &target_provider, |progress| {
            let _ = progress_app.emit(REPAIR_PROGRESS_EVENT, progress);
        })
    })
    .await
    .map_err(|error| format!("Failed to restore Codex historical session task: {error}"))?
}

#[tauri::command]
pub(crate) async fn preview_codex_session_index_cleanup(
    app: tauri::AppHandle,
) -> Result<SessionIndexCleanupPreview, String> {
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
        preview_session_index_cleanup_from_home(&codex_home)
    })
    .await
    .map_err(|error| format!("Failed to preview Codex session index task: {error}"))?
}

#[tauri::command]
pub(crate) async fn apply_codex_session_index_cleanup(
    app: tauri::AppHandle,
    request: ApplySessionIndexCleanupRequest,
) -> Result<SessionIndexCleanupResult, String> {
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
        apply_session_index_cleanup_from_home(
            &codex_home,
            &request.snapshot_sha256,
            &request.thread_ids,
            true,
        )
    })
    .await
    .map_err(|error| format!("Failed to clean up Codex session index task: {error}"))?
}

mod database;
mod listing;
mod deletion;
mod repair;
mod index;
mod process;

use database::*;
use listing::*;
use deletion::*;
use repair::*;
use index::*;
use process::*;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod streaming_tests;
