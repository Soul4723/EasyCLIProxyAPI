use super::*;

pub(crate) fn initialize_usage_storage() -> Result<(), String> {
    let root = usage_root_dir()?;
    migrate_legacy_usage_storage(&root)?;
    initialize_usage_storage_at(&root)
}

#[cfg(target_os = "macos")]
pub(super) fn migrate_legacy_usage_storage(target: &Path) -> Result<(), String> {
    let legacy = executable_dir()?.join(USAGE_DIR_NAME);
    migrate_usage_storage_directory(&legacy, target)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn migrate_legacy_usage_storage(target: &Path) -> Result<(), String> {
    let _ = target;
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn migrate_usage_storage_directory(source: &Path, target: &Path) -> Result<(), String> {
    if source == target || !source.is_dir() || target.exists() {
        return Ok(());
    }
    let target_parent = target
        .parent()
        .ok_or_else(|| "Usage records target directory has no parent directory".to_string())?;
    fs::create_dir_all(target_parent)
        .map_err(|error| format!("Failed to create usage records migration target directory: {error}"))?;
    if fs::rename(source, target).is_ok() {
        return Ok(());
    }

    if let Err(error) = copy_usage_storage_directory(source, target) {
        let _ = fs::remove_dir_all(target);
        return Err(format!("Failed to migrate legacy usage records: {error}"));
    }
    if let Err(error) = fs::remove_dir_all(source) {
        eprintln!(
            "Legacy usage records were copied, but the original directory could not be cleaned up {}: {error}",
            source.display()
        );
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn copy_usage_storage_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("Failed to create usage records directory: {error}"))?;
    let entries = fs::read_dir(source).map_err(|error| format!("Failed to read legacy usage records: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read legacy usage record entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to read legacy usage record entry type: {error}"))?;
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_usage_storage_directory(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &destination)
                .map_err(|error| format!("Failed to copy legacy usage records: {error}"))?;
        } else {
            return Err(format!(
                "Legacy usage records contain an unsupported file type: {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

pub(super) fn initialize_usage_storage_at(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|error| format!("Failed to create usage records directory: {error}"))?;
    let mut connection = open_usage_database_at(root)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("Failed to enable SQLite WAL: {error}"))?;
    migrate_usage_database(&mut connection, root)?;
    migrate_legacy_json_storage(&mut connection, root)?;
    cleanup_usage_inbox(&connection, Local::now())?;
    enforce_usage_database_limit(&connection).map(|_| ())
}

#[tauri::command]
pub(crate) async fn repair_usage_cache_records(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageRepairResult, String> {
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || repair_usage_cache_records_at(&usage_root_dir_for(&config)?)).await
}

#[tauri::command]
pub(crate) async fn get_usage_storage_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageStorageSettings, String> {
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || {
        let root = usage_root_dir_for(&config)?;
        let connection = open_usage_database_at(&root)?;
        load_usage_storage_settings(&connection, &root, 0)
    })
    .await
}

#[tauri::command]
pub(crate) async fn save_usage_storage_settings(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    max_database_size_mb: u64,
) -> Result<UsageStorageSettings, String> {
    let config = gui_config_state.snapshot()?;
    let settings = run_usage_task(move || {
        let root = usage_root_dir_for(&config)?;
        let connection = open_usage_database_at(&root)?;
        save_usage_database_limit(&connection, max_database_size_mb)?;
        let deleted = enforce_usage_database_limit(&connection)?;
        load_usage_storage_settings(&connection, &root, deleted)
    })
    .await?;
    app.state::<UsageCollectorState>()
        .set_total_records(settings.total_records);
    if settings.deleted_records > 0 {
        emit_usage_updated(&app, Local::now().to_rfc3339());
    }
    Ok(settings)
}

#[tauri::command]
pub(crate) async fn shrink_usage_database(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    target_database_size_mb: u64,
) -> Result<UsageStorageSettings, String> {
    let config = gui_config_state.snapshot()?;
    let settings = run_usage_task(move || {
        let root = usage_root_dir_for(&config)?;
        let connection = open_usage_database_at(&root)?;
        let deleted = shrink_usage_database_to_mb(&connection, target_database_size_mb)?;
        load_usage_storage_settings(&connection, &root, deleted)
    })
    .await?;
    app.state::<UsageCollectorState>()
        .set_total_records(settings.total_records);
    if settings.deleted_records > 0 {
        emit_usage_updated(&app, Local::now().to_rfc3339());
    }
    Ok(settings)
}

pub(super) fn repair_usage_cache_records_at(root: &Path) -> Result<UsageRepairResult, String> {
    let mut connection = open_usage_database_at(root)?;
    let candidate_count: i64 = connection
        .query_row(
            r#"SELECT COUNT(*) FROM usage_events
               WHERE lower(trim(model)) = 'unknown'
                  OR (input_tokens > 0
                      AND cache_read_tokens + cache_creation_tokens > input_tokens
                      AND (lower(executor_type) = 'claudeexecutor'
                           OR lower(provider) = 'claude'
                           OR lower(provider) LIKE '%anthropic%'))"#,
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to check historical usage records for invalid rows: {error}"))?;

    if candidate_count <= 0 {
        return Ok(UsageRepairResult::default());
    }

    let backup_path = {
        let backup_dir = root.join(USAGE_BACKUP_DIR_NAME);
        fs::create_dir_all(&backup_dir)
            .map_err(|error| format!("Failed to create Claude usage record migration backup directory: {error}"))?;
        let backup_path = backup_dir.join(format!(
            "usage-before-history-repair-v2-{}.db",
            unique_file_stamp()
        ));
        connection
            .execute(
                "VACUUM INTO ?1",
                params![backup_path.to_string_lossy().to_string()],
            )
            .map_err(|error| format!("Failed to back up Claude usage records: {error}"))?;
        backup_path.to_string_lossy().to_string()
    };

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to begin Claude usage record migration transaction: {error}"))?;
    let migrated = transaction
        .execute(
            r#"UPDATE usage_events
               SET input_tokens = input_tokens + cache_read_tokens + cache_creation_tokens,
                   total_tokens = CASE
                       WHEN total_tokens = 0
                            OR total_tokens = input_tokens + output_tokens
                       THEN input_tokens + cache_read_tokens + cache_creation_tokens + output_tokens
                       ELSE total_tokens
                   END,
                   cached_tokens = MAX(cached_tokens, cache_read_tokens + cache_creation_tokens)
               WHERE input_tokens > 0
                 AND cache_read_tokens + cache_creation_tokens > input_tokens
                 AND lower(trim(model)) <> 'unknown'
                 AND (lower(executor_type) = 'claudeexecutor'
                      OR lower(provider) = 'claude'
                      OR lower(provider) LIKE '%anthropic%')"#,
            [],
        )
        .map_err(|error| format!("Failed to migrate Claude usage records: {error}"))?;
    let deleted = transaction
        .execute(
            "DELETE FROM usage_events WHERE lower(trim(model)) = 'unknown'",
            [],
        )
        .map_err(|error| format!("Failed to delete historical unknown records: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit Claude usage record migration: {error}"))?;
    Ok(UsageRepairResult {
        scanned: candidate_count.max(0) as u64,
        repaired: migrated as u64,
        deleted: deleted as u64,
        backup_path: Some(backup_path),
    })
}

pub(super) fn migrate_usage_database(connection: &mut Connection, root: &Path) -> Result<(), String> {
    match detect_usage_database_layout(connection)? {
        UsageDatabaseLayout::Empty => initialize_usage_schema(connection),
        UsageDatabaseLayout::CurrentV3 => {
            initialize_usage_schema(connection)?;
            migrate_usage_event_key_uniqueness(connection)
        }
        UsageDatabaseLayout::LegacyV2 => {
            let backup_path = create_usage_migration_backup(connection, root)?;
            if let Err(error) = migrate_legacy_v2_usage_schema(connection) {
                return Err(format!(
                    "Failed to migrate legacy usage records database; backup retained at {}: {error}",
                    backup_path.display()
                ));
            }
            initialize_usage_schema(connection)
        }
    }
}

pub(super) fn detect_usage_database_layout(connection: &Connection) -> Result<UsageDatabaseLayout, String> {
    if !usage_table_exists(connection, "usage_events")? {
        return Ok(UsageDatabaseLayout::Empty);
    }
    let columns = usage_table_columns(connection, "usage_events")?;
    let legacy_columns = [
        "event_key",
        "timestamp_ms",
        "local_hour",
        "api_key_hash",
        "api_key_display",
        "api_key_remark",
    ];
    if !legacy_columns
        .iter()
        .all(|column| columns.contains(*column))
    {
        return Err("Unrecognized usage records database schema; automatic migration refused".to_string());
    }
    let keeper_columns = [
        "api_group_key",
        "model_alias",
        "client_ip",
        "x_forwarded_for",
        "user_agent",
        "generate",
        "cached_tokens",
        "collector_source",
    ];
    let keeper_column_count = keeper_columns
        .iter()
        .filter(|column| columns.contains(**column))
        .count();
    if keeper_column_count == 0 && !usage_table_exists(connection, "usage_inbox")? {
        return Ok(UsageDatabaseLayout::LegacyV2);
    }
    if keeper_column_count == keeper_columns.len()
        && usage_table_exists(connection, "usage_inbox")?
        && usage_table_exists(connection, "usage_aggregation_checkpoints")?
    {
        return Ok(UsageDatabaseLayout::CurrentV3);
    }
    Err("Incomplete usage records database migration detected; further modifications refused".to_string())
}

pub(super) fn usage_table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            params![table],
            |row| row.get::<_, i64>(0),
        )
        .map(|exists| exists != 0)
        .map_err(|error| format!("Failed to inspect SQLite table {table}: {error}"))
}

pub(super) fn usage_table_columns(connection: &Connection, table: &str) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare("SELECT name FROM pragma_table_info(?1)")
        .map_err(|error| format!("Failed to prepare SQLite table schema read for {table}: {error}"))?;
    let columns = statement
        .query_map(params![table], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Failed to read SQLite table schema {table}: {error}"))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Failed to parse SQLite table schema {table}: {error}"))?;
    Ok(columns)
}

pub(super) fn migrate_usage_event_key_uniqueness(connection: &mut Connection) -> Result<(), String> {
    let migrated = connection
        .query_row(
            "SELECT value FROM usage_metadata WHERE key = ?1",
            params![USAGE_EVENT_KEY_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("read usage event key migration state failed: {error}"))?;
    if migrated.is_some() {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("begin usage event key migration failed: {error}"))?;
    ensure_usage_event_key_non_unique_in_transaction(&transaction)?;
    transaction
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![USAGE_EVENT_KEY_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("record usage event key migration state failed: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("commit usage event key migration failed: {error}"))
}

pub(super) fn ensure_usage_event_key_non_unique_in_transaction(connection: &Connection) -> Result<(), String> {
    if !usage_table_exists(connection, "usage_events")? {
        return Ok(());
    }

    let unique_indexes = usage_event_key_unique_indexes(connection)?;
    if unique_indexes.is_empty() {
        create_usage_event_key_index(connection)?;
        return Ok(());
    }

    if unique_indexes
        .iter()
        .all(|(_, is_auto_index)| !is_auto_index)
    {
        for (index_name, _) in unique_indexes {
            connection
                .execute(
                    &format!(
                        "DROP INDEX IF EXISTS {}",
                        quote_sqlite_identifier(&index_name)
                    ),
                    [],
                )
                .map_err(|error| {
                    format!("drop unique usage event key index {index_name} failed: {error}")
                })?;
        }
        create_usage_event_key_index(connection)?;
        return Ok(());
    }

    rebuild_usage_events_without_event_key_unique(connection, &unique_indexes)
}

pub(super) fn usage_event_key_unique_indexes(connection: &Connection) -> Result<Vec<(String, bool)>, String> {
    let index_names = {
        let mut statement = connection
            .prepare("SELECT name FROM pragma_index_list(?1) WHERE \"unique\" != 0 ORDER BY seq")
            .map_err(|error| format!("prepare usage event key index query failed: {error}"))?;
        let index_names = statement
            .query_map(params!["usage_events"], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query usage event key indexes failed: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read usage event key indexes failed: {error}"))?;
        index_names
    };

    let mut matches = Vec::new();
    for index_name in index_names {
        let mut statement = connection
            .prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
            .map_err(|error| format!("prepare usage event key index columns failed: {error}"))?;
        let columns = statement
            .query_map(params![index_name.as_str()], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query usage event key index columns failed: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read usage event key index columns failed: {error}"))?;
        if columns.len() == 1 && columns[0] == "event_key" {
            matches.push((
                index_name.clone(),
                index_name.starts_with("sqlite_autoindex_"),
            ));
        }
    }
    Ok(matches)
}

pub(super) fn rebuild_usage_events_without_event_key_unique(
    connection: &Connection,
    unique_indexes: &[(String, bool)],
) -> Result<(), String> {
    let table_sql = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params!["usage_events"],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("read usage events table schema failed: {error}"))?;
    let temporary_table = format!("usage_events_rebuild_{}", unique_file_stamp());
    let create_table_sql = replace_sql_fragment_case_insensitive(
        &table_sql,
        "create table usage_events",
        &format!("CREATE TABLE {temporary_table}"),
    )
    .or_else(|| {
        replace_sql_fragment_case_insensitive(
            &table_sql,
            "create table if not exists usage_events",
            &format!("CREATE TABLE {temporary_table}"),
        )
    })
    .ok_or_else(|| "usage events table schema has an unsupported CREATE TABLE form".to_string())?;
    let create_table_sql = replace_sql_fragment_case_insensitive(
        &create_table_sql,
        "event_key text not null unique",
        "event_key TEXT NOT NULL",
    )
    .ok_or_else(|| {
        "usage events table schema does not contain the expected unique event_key constraint"
            .to_string()
    })?;

    let unique_index_names = unique_indexes
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<HashSet<_>>();
    let index_sqls = {
        let mut statement = connection
            .prepare(
                "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1 AND sql IS NOT NULL ORDER BY name",
            )
            .map_err(|error| format!("prepare usage event index schema query failed: {error}"))?;
        let index_sqls = statement
            .query_map(params!["usage_events"], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("query usage event index schemas failed: {error}"))?
            .filter_map(|row| match row {
                Ok((name, sql)) if !unique_index_names.contains(name.as_str()) => Some(Ok(sql)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read usage event index schemas failed: {error}"))?;
        index_sqls
    };

    connection
        .execute_batch(&create_table_sql)
        .map_err(|error| format!("create rebuilt usage events table failed: {error}"))?;
    connection
        .execute(
            &format!(
                "INSERT INTO {} SELECT * FROM usage_events",
                quote_sqlite_identifier(&temporary_table)
            ),
            [],
        )
        .map_err(|error| format!("copy usage events during event key migration failed: {error}"))?;
    connection
        .execute("DROP TABLE usage_events", [])
        .map_err(|error| format!("drop old usage events table failed: {error}"))?;
    connection
        .execute(
            &format!(
                "ALTER TABLE {} RENAME TO usage_events",
                quote_sqlite_identifier(&temporary_table)
            ),
            [],
        )
        .map_err(|error| format!("rename rebuilt usage events table failed: {error}"))?;

    for index_sql in index_sqls {
        connection
            .execute_batch(&index_sql)
            .map_err(|error| format!("restore usage event index failed: {error}"))?;
    }
    create_usage_event_key_index(connection)
}

pub(super) fn create_usage_event_key_index(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_events_event_key ON usage_events(event_key)",
            [],
        )
        .map(|_| ())
        .map_err(|error| format!("create usage event key index failed: {error}"))
}

pub(super) fn quote_sqlite_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub(super) fn replace_sql_fragment_case_insensitive(
    value: &str,
    needle: &str,
    replacement: &str,
) -> Option<String> {
    let value_lower = value.to_ascii_lowercase();
    let needle_lower = needle.to_ascii_lowercase();
    let start = value_lower.find(&needle_lower)?;
    let mut result = String::with_capacity(value.len() + replacement.len());
    result.push_str(&value[..start]);
    result.push_str(replacement);
    result.push_str(&value[start + needle.len()..]);
    Some(result)
}

pub(super) fn create_usage_migration_backup(connection: &Connection, root: &Path) -> Result<PathBuf, String> {
    let backup_dir = root.join(USAGE_BACKUP_DIR_NAME);
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("Failed to create usage records backup directory: {error}"))?;
    let backup_path = backup_dir.join(format!("usage-before-keeper-v3-{}.db", unique_file_stamp()));
    connection
        .execute(
            "VACUUM INTO ?1",
            params![backup_path.to_string_lossy().to_string()],
        )
        .map_err(|error| format!("Failed to back up legacy usage records database: {error}"))?;
    Ok(backup_path)
}

pub(super) fn migrate_legacy_v2_usage_schema(connection: &mut Connection) -> Result<(), String> {
    let before = load_usage_migration_snapshot(connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to begin usage records database migration transaction: {error}"))?;
    transaction
        .execute_batch(
            r#"
            ALTER TABLE usage_events ADD COLUMN api_group_key TEXT NOT NULL DEFAULT '';
            ALTER TABLE usage_events ADD COLUMN model_alias TEXT;
            ALTER TABLE usage_events ADD COLUMN client_ip TEXT;
            ALTER TABLE usage_events ADD COLUMN x_forwarded_for TEXT;
            ALTER TABLE usage_events ADD COLUMN user_agent TEXT;
            ALTER TABLE usage_events ADD COLUMN generate INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE usage_events ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE usage_events ADD COLUMN collector_source TEXT NOT NULL DEFAULT 'legacy_migration';

            UPDATE usage_events
            SET api_group_key = CASE
                    WHEN api_key_hash != '' THEN api_key_hash
                    WHEN provider != '' THEN provider
                    WHEN endpoint != '' THEN endpoint
                    ELSE 'unknown'
                END,
                model_alias = NULLIF(alias, ''),
                generate = CASE
                    WHEN failed = 0
                         AND executor_type = 'CodexWebsocketsExecutor'
                         AND input_tokens = 0
                         AND output_tokens = 0
                         AND reasoning_tokens = 0
                         AND cache_read_tokens = 0
                         AND cache_creation_tokens = 0
                         AND total_tokens = 0
                    THEN 0 ELSE 1
                END,
                cached_tokens = cache_read_tokens + cache_creation_tokens,
                collector_source = 'legacy_migration';
            "#,
        )
        .map_err(|error| format!("Failed to convert legacy usage record fields: {error}"))?;
    let after = load_usage_migration_snapshot(&transaction)?;
    if before != after {
        return Err(format!(
            "Usage record migration verification mismatch: before {before:?}, after {after:?}"
        ));
    }
    initialize_usage_schema(&transaction)?;
    ensure_usage_event_key_non_unique_in_transaction(&transaction)?;
    transaction
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![USAGE_EVENT_KEY_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("record usage event key migration state failed: {error}"))?;
    transaction
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![USAGE_DATABASE_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("Failed to write usage record migration marker: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit usage records database migration: {error}"))
}

pub(super) fn load_usage_migration_snapshot(
    connection: &Connection,
) -> Result<UsageMigrationSnapshot, String> {
    connection
        .query_row(
            r#"
            SELECT
                COUNT(*),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(reasoning_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_creation_tokens), 0),
                COALESCE(SUM(total_tokens), 0),
                COALESCE(SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN failed != 0 THEN 1 ELSE 0 END), 0),
                MIN(timestamp),
                MAX(timestamp)
            FROM usage_events
            "#,
            [],
            |row| {
                Ok(UsageMigrationSnapshot {
                    records: row.get(0)?,
                    input_tokens: row.get(1)?,
                    output_tokens: row.get(2)?,
                    reasoning_tokens: row.get(3)?,
                    cache_read_tokens: row.get(4)?,
                    cache_creation_tokens: row.get(5)?,
                    total_tokens: row.get(6)?,
                    successes: row.get(7)?,
                    failures: row.get(8)?,
                    first_timestamp: row.get(9)?,
                    last_timestamp: row.get(10)?,
                })
            },
        )
        .map_err(|error| format!("Failed to read usage record migration verification snapshot: {error}"))
}

pub(super) fn initialize_usage_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS usage_metadata (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS usage_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL,
                local_hour TEXT NOT NULL,
                latency_ms INTEGER NOT NULL DEFAULT 0,
                ttft_ms INTEGER,
                source TEXT NOT NULL DEFAULT '',
                auth_index TEXT NOT NULL DEFAULT '',
                failed INTEGER NOT NULL DEFAULT 0,
                canceled INTEGER NOT NULL DEFAULT 0,
                failure_status INTEGER NOT NULL DEFAULT 0,
                failure_body TEXT NOT NULL DEFAULT '',
                provider TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                response_model TEXT NOT NULL DEFAULT '',
                alias TEXT NOT NULL DEFAULT '',
                reasoning_effort TEXT NOT NULL DEFAULT '',
                service_tier TEXT NOT NULL DEFAULT '',
                response_service_tier TEXT NOT NULL DEFAULT '',
                executor_type TEXT NOT NULL DEFAULT '',
                endpoint TEXT NOT NULL DEFAULT '',
                auth_type TEXT NOT NULL DEFAULT '',
                api_key_hash TEXT NOT NULL DEFAULT '',
                api_key_display TEXT NOT NULL DEFAULT '',
                api_key_remark TEXT NOT NULL DEFAULT '',
                request_id TEXT NOT NULL DEFAULT '',
                api_group_key TEXT NOT NULL DEFAULT '',
                model_alias TEXT,
                client_ip TEXT,
                x_forwarded_for TEXT,
                user_agent TEXT,
                generate INTEGER NOT NULL DEFAULT 1,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                collector_source TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp
                ON usage_events(timestamp_ms DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_event_key
                ON usage_events(event_key);
            CREATE INDEX IF NOT EXISTS idx_usage_events_local_hour
                ON usage_events(local_hour, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_model_timestamp
                ON usage_events(model, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_provider_timestamp
                ON usage_events(provider, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_source_timestamp
                ON usage_events(source, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_api_key_timestamp
                ON usage_events(api_key_hash, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_failed_timestamp
                ON usage_events(failed, timestamp_ms DESC);
            CREATE INDEX IF NOT EXISTS idx_usage_events_api_group_timestamp
                ON usage_events(api_group_key, timestamp_ms DESC);

            CREATE TABLE IF NOT EXISTS usage_inbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                message_hash TEXT NOT NULL,
                raw_message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT '',
                usage_event_key TEXT NOT NULL DEFAULT '',
                received_at TEXT NOT NULL,
                processed_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_usage_inbox_status_id
                ON usage_inbox(status, id);

            CREATE TABLE IF NOT EXISTS usage_aggregation_checkpoints (
                name TEXT PRIMARY KEY NOT NULL,
                last_usage_event_id INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS model_prices (
                model TEXT PRIMARY KEY NOT NULL,
                prompt_per_1m REAL NOT NULL DEFAULT 0,
                completion_per_1m REAL NOT NULL DEFAULT 0,
                cache_per_1m REAL NOT NULL DEFAULT 0,
                cache_read_per_1m REAL NOT NULL DEFAULT 0,
                cache_creation_per_1m REAL NOT NULL DEFAULT 0,
                prompt_configured INTEGER NOT NULL DEFAULT 0,
                completion_configured INTEGER NOT NULL DEFAULT 0,
                cache_read_configured INTEGER NOT NULL DEFAULT 0,
                cache_creation_configured INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT '',
                source_model_id TEXT NOT NULL DEFAULT '',
                updated_at_ms INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )
        .map_err(|error| format!("Failed to initialize SQLite usage records schema: {error}"))?;
    ensure_usage_failure_columns(connection)?;
    ensure_usage_response_model_column(connection)?;
    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_events_canceled_timestamp ON usage_events(canceled, timestamp_ms DESC)",
            [],
        )
        .map_err(|error| format!("Failed to create SQLite canceled-record index: {error}"))?;
    connection
        .pragma_update(None, "user_version", USAGE_DATABASE_SCHEMA_VERSION)
        .map_err(|error| format!("Failed to update SQLite usage records version: {error}"))
}

pub(super) fn ensure_usage_response_model_column(connection: &Connection) -> Result<(), String> {
    if !usage_table_columns(connection, "usage_events")?.contains("response_model") {
        connection
            .execute(
                "ALTER TABLE usage_events ADD COLUMN response_model TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|error| {
                format!("Failed to add SQLite usage record response_model field: {error}")
            })?;
    }
    Ok(())
}

pub(super) fn ensure_usage_failure_columns(connection: &Connection) -> Result<(), String> {
    let mut columns = usage_table_columns(connection, "usage_events")?;
    for (column, definition) in [
        ("canceled", "INTEGER NOT NULL DEFAULT 0"),
        ("failure_status", "INTEGER NOT NULL DEFAULT 0"),
        ("failure_body", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if columns.contains(column) {
            continue;
        }
        connection
            .execute(
                &format!("ALTER TABLE usage_events ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|error| format!("Failed to add SQLite usage record field {column}: {error}"))?;
        columns.insert(column.to_string());
    }
    backfill_usage_failure_details(connection)?;
    Ok(())
}

pub(super) fn backfill_usage_failure_details(connection: &Connection) -> Result<(), String> {
    let migrated = connection
        .query_row(
            "SELECT value FROM usage_metadata WHERE key = ?1",
            params![USAGE_FAILURE_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read usage record failure-details migration status: {error}"))?;
    if migrated.is_some() {
        return Ok(());
    }

    if usage_table_exists(connection, "usage_inbox")? {
        let rows = {
            let mut statement = connection
                .prepare(
                    r#"
                    SELECT usage_event_key, raw_message
                    FROM usage_inbox
                    WHERE status = 'processed' AND usage_event_key != ''
                    "#,
                )
                .map_err(|error| format!("Failed to prepare usage record failure-details backfill: {error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| format!("Failed to query usage record failure details: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Failed to read usage record failure details: {error}"))?;
            rows
        };
        for (event_key, raw_message) in rows {
            let Some(object) = serde_json::from_str::<Value>(&raw_message)
                .ok()
                .and_then(|value| value.as_object().cloned())
            else {
                continue;
            };
            if !object
                .get("failed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                continue;
            }
            let (failure_status, failure_body) = usage_failure_details(&object);
            let canceled = usage_failure_is_canceled(failure_status, &failure_body);
            connection
                .execute(
                    r#"
                    UPDATE usage_events
                    SET canceled = ?1, failure_status = ?2, failure_body = ?3
                    WHERE event_key = ?4
                    "#,
                    params![canceled, i64::from(failure_status), failure_body, event_key],
                )
                .map_err(|error| format!("Failed to backfill usage record failure details: {error}"))?;
        }
    }

    connection
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![USAGE_FAILURE_MIGRATION_KEY, Local::now().to_rfc3339()],
        )
        .map_err(|error| format!("Failed to record usage record failure-details migration status: {error}"))?;
    Ok(())
}

/// Opens the usage database for the current connection target. Local mode is
/// unchanged; remote mode reads and writes the target's isolated namespace.
pub(super) fn open_usage_database_for(config: &GuiConfigFile) -> Result<Connection, String> {
    open_usage_database_at(&usage_root_dir_for(config)?)
}

pub(super) fn open_usage_database_at(root: &Path) -> Result<Connection, String> {
    fs::create_dir_all(root).map_err(|error| format!("Failed to create usage records directory: {error}"))?;
    let path = root.join(USAGE_DATABASE_FILE);
    let connection = Connection::open(&path)
        .map_err(|error| format!("Failed to open SQLite usage records database {}: {error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(SQLITE_BUSY_TIMEOUT_SECONDS))
        .map_err(|error| format!("Failed to set SQLite busy timeout: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("Failed to enable SQLite foreign keys: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("Failed to set SQLite synchronous mode: {error}"))?;
    Ok(connection)
}

pub(super) fn load_usage_database_limit(connection: &Connection) -> Result<u64, String> {
    let value = connection
        .query_row(
            "SELECT value FROM usage_metadata WHERE key = ?1",
            params![USAGE_DATABASE_MAX_MB_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read usage records database size limit: {error}"))?;
    value
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|error| format!("Invalid usage records database size limit: {error}"))
        })
        .transpose()
        .map(|value| value.unwrap_or(0))
}

pub(super) fn save_usage_database_limit(
    connection: &Connection,
    max_database_size_mb: u64,
) -> Result<(), String> {
    max_database_size_mb
        .checked_mul(BYTES_PER_MB)
        .ok_or_else(|| "Usage records database size limit is too large".to_string())?;
    connection
        .execute(
            r#"INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value"#,
            params![USAGE_DATABASE_MAX_MB_KEY, max_database_size_mb.to_string()],
        )
        .map(|_| ())
        .map_err(|error| format!("Failed to save usage records database size limit: {error}"))
}

pub(super) fn usage_database_active_bytes(connection: &Connection) -> Result<u64, String> {
    let page_size = connection
        .query_row("PRAGMA page_size", [], |row| row.get::<_, u64>(0))
        .map_err(|error| format!("Failed to read usage records database page size: {error}"))?;
    let page_count = connection
        .query_row("PRAGMA page_count", [], |row| row.get::<_, u64>(0))
        .map_err(|error| format!("Failed to read usage records database page count: {error}"))?;
    let free_pages = connection
        .query_row("PRAGMA freelist_count", [], |row| row.get::<_, u64>(0))
        .map_err(|error| format!("Failed to read usage records database free page count: {error}"))?;
    page_count
        .saturating_sub(free_pages)
        .checked_mul(page_size)
        .ok_or_else(|| "Usage records database size overflow".to_string())
}

pub(super) fn usage_database_allocated_bytes(connection: &Connection) -> Result<u64, String> {
    let page_size = connection
        .query_row("PRAGMA page_size", [], |row| row.get::<_, u64>(0))
        .map_err(|error| format!("Failed to read usage records database page size: {error}"))?;
    let page_count = connection
        .query_row("PRAGMA page_count", [], |row| row.get::<_, u64>(0))
        .map_err(|error| format!("Failed to read usage records database page count: {error}"))?;
    page_count
        .checked_mul(page_size)
        .ok_or_else(|| "Usage records database size overflow".to_string())
}

pub(super) fn usage_database_file_bytes(database_path: &Path) -> Result<u64, String> {
    let mut wal_path = database_path.as_os_str().to_os_string();
    wal_path.push("-wal");
    let paths = [database_path.to_path_buf(), PathBuf::from(wal_path)];
    let mut total = 0_u64;
    for path in paths {
        match fs::metadata(&path) {
            Ok(metadata) => total = total.saturating_add(metadata.len()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to read usage records database file size {}: {error}",
                    path.display()
                ));
            }
        }
    }
    Ok(total)
}

pub(super) fn usage_database_disk_bytes(root: &Path) -> Result<u64, String> {
    usage_database_file_bytes(&root.join(USAGE_DATABASE_FILE))
}

pub(super) fn usage_database_connection_disk_bytes(connection: &Connection) -> Result<u64, String> {
    let path = connection
        .path()
        .ok_or_else(|| "Unable to read usage records database file path".to_string())?;
    usage_database_file_bytes(Path::new(path))
}

pub(super) fn truncate_usage_database_wal(connection: &Connection) {
    let _ = connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    });
}

pub(super) fn load_usage_storage_settings(
    connection: &Connection,
    root: &Path,
    deleted_records: u64,
) -> Result<UsageStorageSettings, String> {
    let total_records = connection
        .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
            row.get::<_, u64>(0)
        })
        .map_err(|error| format!("Failed to count usage records: {error}"))?;
    Ok(UsageStorageSettings {
        max_database_size_mb: load_usage_database_limit(connection)?,
        database_size_bytes: usage_database_disk_bytes(root)?,
        total_records,
        deleted_records,
    })
}

pub(super) fn enforce_usage_database_limit(connection: &Connection) -> Result<u64, String> {
    let max_database_size_mb = load_usage_database_limit(connection)?;
    if max_database_size_mb == 0 {
        return Ok(0);
    }
    let max_bytes = max_database_size_mb
        .checked_mul(BYTES_PER_MB)
        .ok_or_else(|| "Usage records database size limit is too large".to_string())?;
    prune_usage_database_to_bytes(connection, max_bytes)
}

pub(super) fn shrink_usage_database_to_mb(
    connection: &Connection,
    target_database_size_mb: u64,
) -> Result<u64, String> {
    if target_database_size_mb == 0 {
        return Err("Database compaction target must be greater than 0 MB".to_string());
    }
    let target_bytes = target_database_size_mb
        .checked_mul(BYTES_PER_MB)
        .ok_or_else(|| "Database compaction target is too large".to_string())?;
    prune_usage_database_to_bytes(connection, target_bytes)
}

pub(super) fn prune_usage_database_to_bytes(connection: &Connection, max_bytes: u64) -> Result<u64, String> {
    if usage_database_connection_disk_bytes(connection)? <= max_bytes {
        return Ok(0);
    }
    truncate_usage_database_wal(connection);
    let allocated_bytes = usage_database_allocated_bytes(connection)?;
    if allocated_bytes <= max_bytes {
        return Ok(0);
    }

    let inbox_deleted = connection
        .execute(
            "DELETE FROM usage_inbox WHERE status IN ('processed', 'decode_failed', 'discarded')",
            [],
        )
        .map_err(|error| format!("Failed to clean up temporary usage data: {error}"))?;
    let mut active_bytes = usage_database_active_bytes(connection)?;
    let mut deleted_records = 0_u64;

    while active_bytes > max_bytes {
        let total_records = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, u64>(0)
            })
            .map_err(|error| format!("Failed to count usage records pending cleanup: {error}"))?;
        if total_records == 0 {
            break;
        }
        let excess = active_bytes.saturating_sub(max_bytes);
        let estimated = ((total_records as u128 * excess as u128)
            .saturating_add(active_bytes.saturating_sub(1) as u128)
            / active_bytes.max(1) as u128) as u64;
        let batch = estimated.max(1).min(total_records).min(i64::MAX as u64) as i64;
        let deleted = connection
            .execute(
                r#"DELETE FROM usage_events
                   WHERE id IN (
                       SELECT id FROM usage_events
                       ORDER BY timestamp_ms ASC, id ASC
                       LIMIT ?1
                   )"#,
                params![batch],
            )
            .map_err(|error| format!("Failed to delete oldest usage records: {error}"))?
            as u64;
        if deleted == 0 {
            break;
        }
        deleted_records = deleted_records.saturating_add(deleted);
        active_bytes = usage_database_active_bytes(connection)?;
    }

    if allocated_bytes > max_bytes || inbox_deleted > 0 || deleted_records > 0 {
        connection
            .execute_batch("VACUUM;")
            .map_err(|error| format!("Failed to reclaim usage records database space: {error}"))?;
        truncate_usage_database_wal(connection);
    }
    Ok(deleted_records)
}

pub(super) fn migrate_legacy_json_storage(connection: &mut Connection, root: &Path) -> Result<(), String> {
    let migrated = connection
        .query_row(
            "SELECT value FROM usage_metadata WHERE key = ?1",
            params![LEGACY_JSON_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read legacy usage record migration status: {error}"))?
        .is_some();
    if migrated {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to begin legacy usage record migration transaction: {error}"))?;
    let mut migrated_records = 0_usize;

    for path in sorted_json_files(&root.join(LEGACY_USAGE_EVENTS_DIR))? {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read legacy usage record {}: {error}", path.display()))?;
        let file = serde_json::from_str::<LegacyUsageHourFile>(&content)
            .map_err(|error| format!("Failed to parse legacy usage record {}: {error}", path.display()))?;
        validate_legacy_schema(file.schema_version, &path)?;
        migrated_records = migrated_records.saturating_add(insert_usage_records_in_transaction(
            &transaction,
            &file.records,
        )?);
    }

    for path in sorted_json_files(&root.join(LEGACY_USAGE_INBOX_DIR))? {
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read legacy usage record inbox {}: {error}", path.display()))?;
        let file = serde_json::from_str::<LegacyUsageInboxFile>(&content)
            .map_err(|error| format!("Failed to parse legacy usage record inbox {}: {error}", path.display()))?;
        validate_legacy_schema(file.schema_version, &path)?;
        migrated_records = migrated_records.saturating_add(insert_usage_records_in_transaction(
            &transaction,
            &file.records,
        )?);
    }

    transaction
        .execute(
            "INSERT INTO usage_metadata (key, value) VALUES (?1, ?2)",
            params![LEGACY_JSON_MIGRATION_KEY, migrated_records.to_string()],
        )
        .map_err(|error| format!("Failed to record legacy usage record migration status: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit legacy usage record migration: {error}"))?;
    Ok(())
}

pub(super) fn sorted_json_files(directory: &Path) -> Result<Vec<PathBuf>, String> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(directory)
        .map_err(|error| format!("Failed to read legacy usage records directory {}: {error}", directory.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

pub(super) fn validate_legacy_schema(version: u8, path: &Path) -> Result<(), String> {
    if version == USAGE_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(format!(
            "Unsupported legacy usage record version {version}: {}",
            path.display()
        ))
    }
}

pub(super) fn usage_root_dir() -> Result<PathBuf, String> {
    Ok(usage_base_dir()?.join(USAGE_DIR_NAME))
}

pub(super) fn usage_base_dir() -> Result<PathBuf, String> {
    core_base_dir()
}

/// Storage root for the current connection target.
///
/// Local usage is isolated from remote usage: local mode keeps the historical
/// `usage-records` root, while remote mode stores records under
/// `usage-records/remote/<target>` so records from two different cores never
/// merge. Read and write paths must resolve this the same way.
pub(super) fn usage_root_dir_for(config: &GuiConfigFile) -> Result<PathBuf, String> {
    let root = usage_root_dir_for_at(&usage_base_dir()?, config)?;
    if config.connection_mode == CoreConnectionMode::Remote {
        ensure_remote_usage_root_initialized(&root)?;
    }
    Ok(root)
}

pub(super) fn usage_root_dir_for_at(base: &Path, config: &GuiConfigFile) -> Result<PathBuf, String> {
    let root = base.join(USAGE_DIR_NAME);
    match config.connection_mode {
        CoreConnectionMode::Local => Ok(root),
        CoreConnectionMode::Remote => Ok(root
            .join(REMOTE_USAGE_DIR_NAME)
            .join(remote_usage_target_namespace(config)?)),
    }
}

/// Stable identity of a remote core for usage attribution.
///
/// The management origin identifies the core instance. The management key is
/// deliberately excluded so rotating a key keeps the same history; two distinct
/// cores must not share an origin.
pub(super) fn remote_usage_target_namespace(config: &GuiConfigFile) -> Result<String, String> {
    let connection = crate::core_connection::connection_from_config(config)?;
    let digest = hash_text(connection.management_origin.trim());
    Ok(format!("remote-{}", &digest[..16]))
}

pub(super) fn ensure_remote_usage_root_initialized(root: &Path) -> Result<(), String> {
    if INITIALIZED_REMOTE_USAGE_ROOTS
        .lock()
        .map_err(|_| "Usage storage initialization lock is poisoned".to_string())?
        .contains(root)
    {
        return Ok(());
    }
    initialize_usage_storage_at(root)?;
    INITIALIZED_REMOTE_USAGE_ROOTS
        .lock()
        .map_err(|_| "Usage storage initialization lock is poisoned".to_string())?
        .insert(root.to_path_buf());
    Ok(())
}
