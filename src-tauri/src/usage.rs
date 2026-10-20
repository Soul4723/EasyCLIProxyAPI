use crate::management_api;
mod resp;
mod sources;
mod token;
mod store;
pub(crate) use store::*;
mod collector;
pub(crate) use collector::*;
mod inbox;
use inbox::*;
mod records;
use records::*;
mod queries;
pub(crate) use queries::*;
mod pricing;
pub(crate) use pricing::*;
mod export;
pub(crate) use export::*;

#[cfg(test)]
mod tests;

#[cfg(target_os = "macos")]
use super::executable_dir;
#[cfg(test)]
use super::VersionDownloadSource;
use super::{
    apply_configured_proxy, core_base_dir, current_core_status, format_management_request_error,
    management_authorization, management_endpoint, CoreConnectionMode, CoreProcessState,
    GuiConfigFile, GuiConfigState,
};
use chrono::{DateTime, Local};
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row,
    Transaction,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, LazyLock, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;

use self::{
    resp::{pull_usage_queue, UsageSubscription},
    token::{
        normalize as normalize_keeper_tokens, ClampedTokenFields, TokenValues as KeeperTokenValues,
    },
};

const USAGE_DIR_NAME: &str = "usage-records";
const REMOTE_USAGE_DIR_NAME: &str = "remote";
const USAGE_DATABASE_FILE: &str = "usage.db";
const USAGE_BACKUP_DIR_NAME: &str = "backups";
const LEGACY_USAGE_EVENTS_DIR: &str = "events";
const LEGACY_USAGE_INBOX_DIR: &str = "inbox";
const LEGACY_JSON_MIGRATION_KEY: &str = "legacy_json_v1";
const USAGE_DATABASE_MIGRATION_KEY: &str = "keeper_v3";
const USAGE_FAILURE_MIGRATION_KEY: &str = "failure_details_v4";
const USAGE_EVENT_KEY_MIGRATION_KEY: &str = "event_key_v5";
const USAGE_DATABASE_MAX_MB_KEY: &str = "max_database_size_mb";
const USAGE_UPDATED_EVENT: &str = "usage-records-updated";
const USAGE_SCHEMA_VERSION: u8 = 1;
const USAGE_DATABASE_SCHEMA_VERSION: i64 = 6;
const MAX_USAGE_FAILURE_BODY_CHARS: usize = 2_000;
const USAGE_QUEUE_BATCH_SIZE: usize = 10_000;
const USAGE_INBOX_PROCESS_LIMIT: usize = 500;
const USAGE_INBOX_MAX_ATTEMPTS: i64 = 5;
const USAGE_SUBSCRIBE_RETRY_SECONDS: u64 = 30;
const REMOTE_EMPTY_POLL_MIN_SECONDS: u64 = 2;
const REMOTE_EMPTY_POLL_MAX_SECONDS: u64 = 30;
const USAGE_QUEUE_KEY: &str = "usage";
const LEGACY_USAGE_QUEUE_KEY: &str = "queue";
const HTTP_USAGE_QUEUE_SOURCE: &str = "http_pull:usage_queue";
const SQLITE_BUSY_TIMEOUT_SECONDS: u64 = 5;
const BYTES_PER_MB: u64 = 1024 * 1024;
const TOKENS_PER_PRICE_UNIT: f64 = 1_000_000.0;
const LONG_CONTEXT_INPUT_TOKEN_THRESHOLD: u64 = 272_000;
const GROK_47_LONG_CONTEXT_INPUT_TOKEN_THRESHOLD: u64 = 200_000;
const GROK_47_MODEL_SQL: &str = concat!(
    "(LOWER(TRIM(model)) = 'grok-4.7'",
    " OR LOWER(TRIM(model)) LIKE 'grok-4.7-%'",
    " OR LOWER(TRIM(model)) LIKE '%/grok-4.7'",
    " OR LOWER(TRIM(model)) LIKE '%/grok-4.7-%')"
);
const BUNDLED_MODEL_PRICE_CATALOG: &str = include_str!("../resources/model_prices.json");
const MODEL_PRICE_SYNC_URL: &str = "https://models.dev/api.json";
const LITELLM_PRICE_SYNC_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODEL_PRICE_SYNC_MAX_BYTES: usize = 16 * 1024 * 1024;
const MODEL_PRICE_SYNC_ATTEMPTS: usize = 2;
const USAGE_DISPLAY_MODEL_SQL: &str =
    "COALESCE(NULLIF(TRIM(alias), ''), NULLIF(TRIM(model), ''), 'unknown')";

static USAGE_QUERY_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

static INITIALIZED_REMOTE_USAGE_ROOTS: LazyLock<Mutex<HashSet<PathBuf>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

async fn run_usage_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let permit = USAGE_QUERY_SLOTS
        .acquire()
        .await
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        task()
    })
    .await
    .map_err(|error| format!("Usage records background task failed: {error}"))?
}

pub(crate) struct UsageCollectorState {
    readiness_requested: AtomicBool,
    readiness_generation: AtomicU64,
    readiness_notify: tokio::sync::Notify,
    inner: Mutex<UsageCollectorInner>,
}

struct UsageCollectorInner {
    token: Option<CancellationToken>,
    status: UsageCollectorStatus,
    connection_key: Option<String>,
    connection_mode: String,
    remote_origin: Option<String>,
    target_revision: u64,
    paused: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UsageDatabaseLayout {
    Empty,
    LegacyV2,
    CurrentV3,
}

#[derive(Debug)]
struct UsageInboxRow {
    id: i64,
    source: String,
    raw_message: String,
    attempt_count: i64,
}

#[derive(Clone, Copy, Default)]
struct UsagePersistOutcome {
    inserted: usize,
    deleted: u64,
}

impl UsagePersistOutcome {
    fn add(&mut self, other: Self) {
        self.inserted = self.inserted.saturating_add(other.inserted);
        self.deleted = self.deleted.saturating_add(other.deleted);
    }
}

#[derive(Debug, Eq, PartialEq)]
struct UsageMigrationSnapshot {
    records: i64,
    input_tokens: i64,
    output_tokens: i64,
    reasoning_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    total_tokens: i64,
    successes: i64,
    failures: i64,
    first_timestamp: Option<String>,
    last_timestamp: Option<String>,
}

impl Default for UsageCollectorState {
    fn default() -> Self {
        Self {
            readiness_requested: AtomicBool::new(false),
            readiness_generation: AtomicU64::new(0),
            readiness_notify: tokio::sync::Notify::new(),
            inner: Mutex::new(UsageCollectorInner {
                token: None,
                status: UsageCollectorStatus::waiting(),
                connection_key: None,
                connection_mode: "local".to_string(),
                remote_origin: None,
                target_revision: 0,
                paused: false,
            }),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageCollectorStatus {
    state: String,
    message: String,
    last_collected_at: Option<String>,
    total_records: u64,
    connection_mode: String,
    remote_origin: Option<String>,
    target_revision: u64,
    paused: bool,
    destructive_pop: bool,
}

impl UsageCollectorStatus {
    fn waiting() -> Self {
        Self {
            state: "waiting-core".to_string(),
            message: "Waiting for kernel startup".to_string(),
            last_collected_at: None,
            total_records: 0,
            connection_mode: "local".to_string(),
            remote_origin: None,
            target_revision: 0,
            paused: false,
            destructive_pop: false,
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct UsageTokenStats {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    reasoning_tokens: u64,
    #[serde(default)]
    cache_read_tokens: u64,
    #[serde(default)]
    cache_creation_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct UsageRecord {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    row_id: Option<String>,
    timestamp: String,
    #[serde(default)]
    latency_ms: u64,
    #[serde(default)]
    ttft_ms: Option<u64>,
    #[serde(default)]
    source: String,
    #[serde(default)]
    source_display: String,
    #[serde(default)]
    auth_index: String,
    #[serde(default)]
    failed: bool,
    #[serde(default)]
    canceled: bool,
    #[serde(default)]
    failure_status: u16,
    #[serde(default)]
    failure_body: String,
    #[serde(default)]
    provider: String,
    #[serde(default, skip_serializing)]
    api_group_key: String,
    #[serde(default)]
    model: String,
    #[serde(default, alias = "responseModel")]
    response_model: String,
    // Derived from the active price catalog when reading a page; never trust imported estimates.
    #[serde(default, skip_deserializing)]
    cost: Option<UsageRecordCost>,
    #[serde(default)]
    alias: String,
    #[serde(default, skip_serializing)]
    client_ip: Option<String>,
    #[serde(default, skip_serializing)]
    x_forwarded_for: Option<String>,
    #[serde(default, skip_serializing)]
    user_agent: Option<String>,
    // Derived on reads; imported labels never override persisted request identity.
    #[serde(default, skip_deserializing)]
    agent: String,
    #[serde(default)]
    reasoning_effort: String,
    #[serde(default)]
    service_tier: String,
    #[serde(default)]
    response_service_tier: String,
    #[serde(default)]
    executor_type: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    auth_type: String,
    #[serde(default)]
    api_key_hash: String,
    #[serde(default)]
    api_key_display: String,
    #[serde(default)]
    api_key_remark: String,
    #[serde(default)]
    request_id: String,
    #[serde(default = "default_usage_generate", skip_serializing)]
    generate: bool,
    #[serde(default, skip_serializing)]
    cached_tokens: u64,
    #[serde(default, skip_serializing)]
    collector_source: String,
    #[serde(default)]
    tokens: UsageTokenStats,
}

#[derive(Clone, Serialize)]
struct UsageRecordCost {
    total: f64,
    pricing_model: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyUsageHourFile {
    schema_version: u8,
    records: Vec<UsageRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyUsageInboxFile {
    schema_version: u8,
    records: Vec<UsageRecord>,
}

#[derive(Clone, Default, Deserialize)]
pub(crate) struct UsageQuery {
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    upstream: Option<String>,
    #[serde(default)]
    api_key_hash: Option<String>,
    #[serde(default)]
    failed: Option<bool>,
    #[serde(default)]
    canceled: Option<bool>,
    #[serde(default)]
    page: Option<usize>,
    #[serde(default)]
    page_size: Option<usize>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageOverview {
    total_requests: u64,
    success_count: u64,
    failure_count: u64,
    canceled_count: u64,
    success_rate: f64,
    input_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_tokens: u64,
    rpm: f64,
    tpm: f64,
    tps: f64,
    tps_sample_count: u64,
    average_latency_ms: f64,
    cache_hit_rate: f64,
    estimated_cost: f64,
    priced_requests: u64,
    timeline: Vec<UsageTimelinePoint>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageRepairResult {
    scanned: u64,
    repaired: u64,
    deleted: u64,
    backup_path: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageStorageSettings {
    max_database_size_mb: u64,
    database_size_bytes: u64,
    total_records: u64,
    deleted_records: u64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPrice {
    model: String,
    prompt: f64,
    completion: f64,
    cache_read: f64,
    cache_creation: f64,
    prompt_configured: bool,
    completion_configured: bool,
    cache_read_configured: bool,
    cache_creation_configured: bool,
    source: String,
    source_model_id: String,
    updated_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelPriceCatalog {
    schema_version: u8,
    #[serde(default)]
    updated_at: String,
    models: HashMap<String, CatalogModelPrice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogModelPrice {
    input_per_1_m: f64,
    output_per_1_m: f64,
    #[serde(default)]
    cache_read_per_1_m: Option<f64>,
    #[serde(default)]
    cache_creation_per_1_m: Option<f64>,
}

#[derive(Default)]
struct CostTokens {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    long_input: u64,
    long_output: u64,
    long_cache_read: u64,
    long_cache_creation: u64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsagePricing {
    rows: Vec<UsagePriceRow>,
    total_cost: f64,
    total_requests: u64,
    priced_requests: u64,
    saved_prices: usize,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsagePriceRow {
    model: String,
    requests: u64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    total_tokens: u64,
    estimated_cost: f64,
    price: Option<ModelPrice>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPriceSyncResult {
    imported: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPriceSyncPreview {
    source: String,
    source_url: String,
    matches: Vec<ModelPrice>,
    unmatched: Vec<String>,
}

struct UsageCostGroup {
    model: String,
    alias: String,
    service_tier: String,
    response_service_tier: String,
    executor_type: String,
    provider: String,
    auth_type: String,
    requests: u64,
    tokens: CostTokens,
    total_tokens: u64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageTimelineModel {
    key: String,
    label: String,
    tokens: u64,
    requests: u64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageTimelinePoint {
    hour: String,
    requests: u64,
    success: u64,
    failure: u64,
    canceled: u64,
    tokens: u64,
    models: Vec<UsageTimelineModel>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageAnalysis {
    models: Vec<UsageCategory>,
    providers: Vec<UsageCategory>,
    sources: Vec<UsageCategory>,
    api_keys: Vec<UsageCategory>,
    upstreams: Vec<UsageUpstream>,
}

#[derive(Serialize)]
struct UsageUpstream {
    #[serde(flatten)]
    category: UsageCategory,
    provider: String,
    #[serde(rename = "isDefault")]
    is_default: bool,
}

// Old records without an identity can only be grouped by route, never by a
// raw source value that could contain an upstream or client secret.
const USAGE_UPSTREAM_SQL: &str = "CASE WHEN TRIM(auth_index) != '' THEN 'auth:' || TRIM(auth_index) ELSE 'provider:' || TRIM(provider) END";

// Product tokens verified against first-party request builders:
// https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/default_client.rs
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/core/contentGenerator.ts
// https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.0.tgz (package/cli.js)
// ponytail: recognize default CLI identities only; add variants after verifying their request builders.
// GLOB is case-sensitive and anchored, unlike substring/LIKE guesses. Never inspect routing metadata.
const USAGE_AGENT_SQL: &str = "CASE
    WHEN user_agent NOT GLOB '*claude-cli/*'
      AND user_agent NOT GLOB '*GeminiCLI/*'
      AND user_agent GLOB 'codex_cli_rs/* (*)*'
      AND substr(user_agent, 14, instr(user_agent, ' (') - 14) NOT GLOB '*[^0-9.]*'
      AND substr(user_agent, 14, instr(user_agent, ' (') - 14) NOT GLOB ''
      AND substr(user_agent, 14, instr(user_agent, ' (') - 14) NOT GLOB '.*'
      AND substr(user_agent, 14, instr(user_agent, ' (') - 14) NOT GLOB '*.'
      AND substr(user_agent, 14, instr(user_agent, ' (') - 14) NOT GLOB '*..*'
      THEN 'codex'
    WHEN user_agent GLOB 'claude-cli/* (external, cli)'
      AND substr(user_agent, 12, instr(user_agent, ' (') - 12) NOT GLOB '*[^0-9.]*'
      AND substr(user_agent, 12, instr(user_agent, ' (') - 12) NOT GLOB ''
      AND substr(user_agent, 12, instr(user_agent, ' (') - 12) NOT GLOB '.*'
      AND substr(user_agent, 12, instr(user_agent, ' (') - 12) NOT GLOB '*.'
      AND substr(user_agent, 12, instr(user_agent, ' (') - 12) NOT GLOB '*..*'
      THEN 'claude-code'
    WHEN user_agent GLOB 'GeminiCLI/* (*)'
      AND substr(user_agent, 11, instr(user_agent, ' (') - 11) GLOB '[0-9.]*/*'
      AND substr(user_agent, 11, instr(user_agent, ' (') - 11) NOT GLOB '*[^0-9A-Za-z._/-]*'
      AND substr(substr(user_agent, 11, instr(user_agent, ' (') - 11), 1, instr(substr(user_agent, 11, instr(user_agent, ' (') - 11), '/') - 1) NOT GLOB '*[^0-9.]*'
      AND substr(substr(user_agent, 11, instr(user_agent, ' (') - 11), 1, instr(substr(user_agent, 11, instr(user_agent, ' (') - 11), '/') - 1) NOT GLOB '*..*'
      AND substr(user_agent, 11, instr(user_agent, ' (') - 11) NOT GLOB '*claude-cli/*'
      THEN 'gemini-cli'
    ELSE 'unknown' END";

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageCategory {
    key: String,
    label: String,
    requests: u64,
    failures: u64,
    tokens: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageEventPage {
    items: Vec<UsageRecord>,
    total: usize,
    page: usize,
    page_size: usize,
    total_pages: usize,
}

struct UsageSqlFilter {
    clause: String,
    params: Vec<SqlValue>,
}
