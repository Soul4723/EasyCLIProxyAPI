use super::*;

pub(super) fn persist_queue_items_from_source(
    root: &Path,
    source: &str,
    items: Vec<Value>,
    config: &GuiConfigFile,
) -> Result<UsagePersistOutcome, String> {
    let mut connection = open_usage_database_at(root)?;
    enqueue_usage_queue_items(&mut connection, source, items)?;
    process_usage_inbox(&mut connection, config)
}

pub(super) fn enqueue_usage_queue_items(
    connection: &mut Connection,
    source: &str,
    items: Vec<Value>,
) -> Result<usize, String> {
    let messages = items
        .into_iter()
        .map(|item| {
            serde_json::to_string(&item)
                .map_err(|error| format!("Failed to serialize CPA usage records: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    enqueue_usage_raw_messages(connection, source, messages)
}

pub(super) fn enqueue_usage_raw_messages(
    connection: &mut Connection,
    source: &str,
    messages: Vec<String>,
) -> Result<usize, String> {
    let messages = messages
        .into_iter()
        .filter(|message| !is_ignorable_usage_message(message))
        .collect::<Vec<_>>();
    if messages.is_empty() {
        return Ok(0);
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to begin SQLite usage records inbox transaction: {error}"))?;
    let mut statement = transaction
        .prepare(
            r#"
            INSERT INTO usage_inbox (
                source, message_hash, raw_message, status, attempt_count,
                received_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, 'pending', 0, ?4, ?4, ?4)
            "#,
        )
        .map_err(|error| format!("Failed to prepare SQLite usage records inbox write: {error}"))?;
    let received_at = Local::now().to_rfc3339();
    let mut inserted = 0_usize;
    for raw_message in messages {
        inserted = inserted.saturating_add(
            statement
                .execute(params![
                    source,
                    hash_text(&raw_message),
                    raw_message,
                    received_at,
                ])
                .map_err(|error| format!("Failed to write SQLite usage records inbox: {error}"))?,
        );
    }
    drop(statement);
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit SQLite usage records inbox: {error}"))?;
    Ok(inserted)
}

pub(super) fn is_ignorable_usage_message(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return true;
    }
    if trimmed.contains("\"request_id\"") {
        return false;
    }

    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != 1 {
        return false;
    }
    object
        .get("refresh")
        .and_then(Value::as_bool)
        .is_some_and(|enabled| enabled)
        || object
            .get("support_refresh")
            .and_then(Value::as_bool)
            .is_some_and(|enabled| enabled)
}

pub(super) fn persist_raw_usage_messages_from_source(
    root: &Path,
    source: &str,
    raw_messages: Vec<String>,
    config: &GuiConfigFile,
) -> Result<UsagePersistOutcome, String> {
    persist_raw_usage_messages_on(&mut open_usage_database_at(root)?, source, raw_messages, config)
}

pub(super) fn persist_raw_usage_messages_on(
    connection: &mut Connection,
    source: &str,
    raw_messages: Vec<String>,
    config: &GuiConfigFile,
) -> Result<UsagePersistOutcome, String> {
    enqueue_usage_raw_messages(connection, source, raw_messages)?;
    process_usage_inbox(connection, config)
}

pub(super) fn process_usage_inbox(
    connection: &mut Connection,
    config: &GuiConfigFile,
) -> Result<UsagePersistOutcome, String> {
    let rows = list_processable_usage_inbox(connection, USAGE_INBOX_PROCESS_LIMIT)?;
    if rows.is_empty() {
        return Ok(UsagePersistOutcome::default());
    }
    let mut valid_rows = Vec::with_capacity(rows.len());
    let mut records = Vec::with_capacity(rows.len());
    for row in rows {
        let parsed = serde_json::from_str::<Value>(&row.raw_message)
            .map_err(|error| format!("Failed to parse inbox JSON: {error}"))
            .and_then(|value| normalize_usage_record(value, config));
        match parsed {
            Ok(mut record) => {
                record.collector_source = row.source.clone();
                valid_rows.push(row);
                records.push(record);
            }
            Err(error) => mark_usage_inbox_decode_failed(connection, row.id, &error)?,
        }
    }
    if records.is_empty() {
        return Ok(UsagePersistOutcome {
            inserted: 0,
            deleted: enforce_usage_database_limit(connection)?,
        });
    }

    let persist_result = (|| -> Result<usize, String> {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Failed to begin SQLite inbox processing transaction: {error}"))?;
        let inserted = insert_usage_records_in_transaction(&transaction, &records)?;
        let processed_at = Local::now().to_rfc3339();
        for (row, record) in valid_rows.iter().zip(records.iter()) {
            transaction
                .execute(
                    r#"
                    UPDATE usage_inbox
                    SET status = 'processed', attempt_count = attempt_count + 1,
                        last_error = '', usage_event_key = ?1,
                        processed_at = ?2, updated_at = ?2
                    WHERE id = ?3
                    "#,
                    params![record.id, processed_at, row.id],
                )
                .map_err(|error| format!("Failed to mark SQLite usage records inbox as processed: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("Failed to commit SQLite inbox processing transaction: {error}"))?;
        Ok(inserted)
    })();
    match persist_result {
        Ok(inserted) => Ok(UsagePersistOutcome {
            inserted,
            deleted: enforce_usage_database_limit(connection)?,
        }),
        Err(error) => {
            mark_usage_inbox_process_failed(connection, &valid_rows, &error)?;
            Err(error)
        }
    }
}

pub(super) fn list_processable_usage_inbox(
    connection: &Connection,
    limit: usize,
) -> Result<Vec<UsageInboxRow>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, source, raw_message, attempt_count
            FROM usage_inbox
            WHERE status IN ('pending', 'process_failed')
              AND attempt_count < ?1
            ORDER BY id ASC
            LIMIT ?2
            "#,
        )
        .map_err(|error| format!("Failed to prepare SQLite usage records inbox read: {error}"))?;
    let rows = statement
        .query_map(
            params![
                USAGE_INBOX_MAX_ATTEMPTS,
                limit.min(i64::MAX as usize) as i64
            ],
            |row| {
                Ok(UsageInboxRow {
                    id: row.get(0)?,
                    source: row.get(1)?,
                    raw_message: row.get(2)?,
                    attempt_count: row.get(3)?,
                })
            },
        )
        .map_err(|error| format!("Failed to query SQLite usage records inbox: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read SQLite usage records inbox: {error}"))?;
    Ok(rows)
}

pub(super) fn mark_usage_inbox_decode_failed(
    connection: &Connection,
    id: i64,
    error: &str,
) -> Result<(), String> {
    let now = Local::now().to_rfc3339();
    connection
        .execute(
            r#"
            UPDATE usage_inbox
            SET status = 'decode_failed', attempt_count = attempt_count + 1,
                last_error = ?1, processed_at = ?2, updated_at = ?2
            WHERE id = ?3
            "#,
            params![bounded_usage_inbox_error(error), now, id],
        )
        .map(|_| ())
        .map_err(|update_error| {
            format!("Error marking SQLite usage records inbox decode failure: {update_error}")
        })
}

pub(super) fn mark_usage_inbox_process_failed(
    connection: &Connection,
    rows: &[UsageInboxRow],
    error: &str,
) -> Result<(), String> {
    let now = Local::now().to_rfc3339();
    let error = bounded_usage_inbox_error(error);
    for row in rows {
        let next_attempt = row.attempt_count.saturating_add(1);
        let status = if next_attempt >= USAGE_INBOX_MAX_ATTEMPTS {
            "discarded"
        } else {
            "process_failed"
        };
        connection
            .execute(
                r#"
                UPDATE usage_inbox
                SET status = ?1, attempt_count = ?2, last_error = ?3,
                    processed_at = CASE WHEN ?1 = 'discarded' THEN ?4 ELSE NULL END,
                    updated_at = ?4
                WHERE id = ?5
                "#,
                params![status, next_attempt, error, now, row.id],
            )
            .map_err(|update_error| {
                format!("Error marking SQLite usage records inbox processing failure: {update_error}")
            })?;
    }
    Ok(())
}

pub(super) fn bounded_usage_inbox_error(error: &str) -> String {
    error.chars().take(1_000).collect()
}

pub(super) fn cleanup_usage_inbox(connection: &Connection, now: DateTime<Local>) -> Result<(), String> {
    let processed_cutoff = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|value| value.and_local_timezone(Local).single())
        .unwrap_or(now)
        .to_rfc3339();
    let failed_cutoff = (now - chrono::Duration::days(7)).to_rfc3339();
    connection
        .execute(
            "DELETE FROM usage_inbox WHERE status = 'processed' AND processed_at < ?1",
            params![processed_cutoff],
        )
        .map_err(|error| format!("Failed to clean up processed usage records inbox: {error}"))?;
    connection
        .execute(
            "DELETE FROM usage_inbox WHERE status IN ('decode_failed', 'discarded') AND updated_at < ?1",
            params![failed_cutoff],
        )
        .map_err(|error| format!("Failed to clean up failed usage records inbox: {error}"))?;
    Ok(())
}

#[cfg(test)]
pub(super) fn insert_usage_records(
    connection: &mut Connection,
    records: &[UsageRecord],
) -> Result<usize, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to begin SQLite usage records transaction: {error}"))?;
    let inserted = insert_usage_records_in_transaction(&transaction, records)?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit SQLite usage records: {error}"))?;
    Ok(inserted)
}

pub(super) fn insert_usage_records_in_transaction(
    transaction: &Transaction<'_>,
    records: &[UsageRecord],
) -> Result<usize, String> {
    if records.is_empty() {
        return Ok(0);
    }
    let mut statement = transaction
        .prepare(
            r#"
            INSERT INTO usage_events (
                event_key, timestamp, timestamp_ms, local_hour, latency_ms, ttft_ms,
                source, auth_index, failed, provider, model, alias, reasoning_effort,
                service_tier, response_service_tier, executor_type, endpoint, auth_type,
                api_key_hash, api_key_display, api_key_remark, request_id,
                api_group_key, model_alias, client_ip, x_forwarded_for, user_agent,
                generate, cached_tokens, collector_source,
                input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
                cache_creation_tokens, total_tokens, canceled, failure_status,
                failure_body, created_at, response_model
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30,
                ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41
            )
            "#,
        )
        .map_err(|error| format!("Failed to prepare SQLite usage records write: {error}"))?;
    let created_at = Local::now().to_rfc3339();
    let mut inserted = 0_usize;
    for record in records {
        let api_group_key = if !record.api_group_key.trim().is_empty() {
            record.api_group_key.as_str()
        } else if !record.api_key_hash.trim().is_empty() {
            record.api_key_hash.as_str()
        } else if !record.provider.trim().is_empty() {
            record.provider.as_str()
        } else if !record.endpoint.trim().is_empty() {
            record.endpoint.as_str()
        } else {
            "unknown"
        };
        let collector_source = if record.collector_source.trim().is_empty() {
            "legacy_json"
        } else {
            record.collector_source.as_str()
        };
        inserted = inserted.saturating_add(
            statement
                .execute(params![
                    record.id,
                    record.timestamp,
                    record_timestamp_millis(record),
                    record_local_hour(record),
                    to_sql_i64(record.latency_ms),
                    record.ttft_ms.map(to_sql_i64),
                    record.source,
                    record.auth_index,
                    record.failed,
                    record.provider,
                    record.model,
                    record.alias,
                    record.reasoning_effort,
                    record.service_tier,
                    record.response_service_tier,
                    record.executor_type,
                    record.endpoint,
                    record.auth_type,
                    record.api_key_hash,
                    record.api_key_display,
                    record.api_key_remark,
                    record.request_id,
                    api_group_key,
                    if record.alias.trim().is_empty() {
                        None::<&str>
                    } else {
                        Some(record.alias.as_str())
                    },
                    record.client_ip,
                    record.x_forwarded_for,
                    record.user_agent,
                    record.generate,
                    to_sql_i64(record.cached_tokens),
                    collector_source,
                    to_sql_i64(record.tokens.input_tokens),
                    to_sql_i64(record.tokens.output_tokens),
                    to_sql_i64(record.tokens.reasoning_tokens),
                    to_sql_i64(record.tokens.cache_read_tokens),
                    to_sql_i64(record.tokens.cache_creation_tokens),
                    to_sql_i64(record.tokens.total_tokens),
                    record.canceled,
                    i64::from(record.failure_status),
                    record.failure_body,
                    created_at,
                    record.response_model,
                ])
                .map_err(|error| format!("Failed to write SQLite usage records: {error}"))?,
        );
    }
    Ok(inserted)
}
