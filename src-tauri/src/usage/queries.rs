use super::*;

pub(super) fn build_usage_filter(query: &UsageQuery) -> UsageSqlFilter {
    let mut clauses = Vec::<String>::new();
    let mut params = Vec::<SqlValue>::new();
    add_text_filter(&mut clauses, &mut params, &format!("({USAGE_AGENT_SQL})"), query.agent.as_deref());
    if let Some(start) = query.start.as_deref().and_then(parse_timestamp_millis) {
        clauses.push("timestamp_ms >= ?".to_string());
        params.push(SqlValue::Integer(start));
    }
    if let Some(end) = query.end.as_deref().and_then(parse_timestamp_millis) {
        clauses.push("timestamp_ms <= ?".to_string());
        params.push(SqlValue::Integer(end));
    }
    add_text_filter(
        &mut clauses,
        &mut params,
        USAGE_DISPLAY_MODEL_SQL,
        query.model.as_deref(),
    );
    add_text_filter(
        &mut clauses,
        &mut params,
        "provider",
        query.provider.as_deref(),
    );
    add_text_filter(&mut clauses, &mut params, "source", query.source.as_deref());
    if let Some(upstream) = query.upstream.as_deref().filter(|value| !value.is_empty()) {
        if let Some(group) = upstream.strip_prefix("group:") {
            match serde_json::from_str::<Vec<String>>(group) {
                Ok(keys) if !keys.is_empty() && keys.iter().all(|key| key.starts_with("auth:")) => {
                    clauses.push(format!("({USAGE_UPSTREAM_SQL}) IN (SELECT value FROM json_each(?))"));
                    params.push(SqlValue::Text(group.to_string()));
                }
                _ => clauses.push("0 = 1".to_string()),
            }
        } else {
            clauses.push(format!("({USAGE_UPSTREAM_SQL}) = ?"));
            params.push(SqlValue::Text(upstream.to_string()));
        }
    }
    add_text_filter(
        &mut clauses,
        &mut params,
        "api_key_hash",
        query.api_key_hash.as_deref(),
    );
    if let Some(canceled) = query.canceled {
        clauses.push("canceled = ?".to_string());
        params.push(SqlValue::Integer(i64::from(canceled)));
    }
    if let Some(failed) = query.failed {
        if failed {
            clauses.push("failed != 0 AND canceled = 0".to_string());
        } else {
            clauses.push("failed = 0".to_string());
        }
    }
    UsageSqlFilter {
        clause: if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        },
        params,
    }
}

pub(super) fn add_text_filter(
    clauses: &mut Vec<String>,
    params: &mut Vec<SqlValue>,
    column: &str,
    value: Option<&str>,
) {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        clauses.push(format!("{column} = ? COLLATE NOCASE"));
        params.push(SqlValue::Text(value.to_string()));
    }
}

#[tauri::command]
pub(crate) async fn get_usage_overview(
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageOverview, String> {
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || load_usage_overview(&open_usage_database_for(&config)?, &query)).await
}

pub(super) fn load_usage_overview(
    connection: &Connection,
    query: &UsageQuery,
) -> Result<UsageOverview, String> {
    let filter = build_usage_filter(query);
    let summary_sql = format!(
        r#"
        SELECT
            COUNT(*),
            COALESCE(SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN failed != 0 AND canceled = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN canceled != 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(reasoning_tokens), 0),
            COALESCE(SUM(cache_read_tokens), 0),
            COALESCE(SUM(cache_creation_tokens), 0),
            COALESCE(SUM(total_tokens), 0),
            COALESCE(SUM(latency_ms), 0),
            COALESCE(AVG(CASE
                WHEN generate != 0
                 AND failed = 0
                 AND canceled = 0
                 AND output_tokens > 0
                 AND latency_ms > 0
                THEN output_tokens * 1000.0 / latency_ms
            END), 0.0),
            COALESCE(SUM(CASE
                WHEN generate != 0
                 AND failed = 0
                 AND canceled = 0
                 AND output_tokens > 0
                 AND latency_ms > 0
                THEN 1
                ELSE 0
            END), 0),
            MIN(timestamp_ms),
            MAX(timestamp_ms)
        FROM usage_events{}
        "#,
        filter.clause
    );
    let summary = connection
        .query_row(
            &summary_sql,
            params_from_iter(filter.params.iter()),
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, f64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, Option<i64>>(13)?,
                    row.get::<_, Option<i64>>(14)?,
                ))
            },
        )
        .map_err(|error| format!("Failed to count SQLite usage records: {error}"))?;

    let (estimated_cost, priced_requests) = load_estimated_cost(connection, &filter)?;

    let timeline_sql = format!(
        r#"
        SELECT
            CASE
                WHEN timestamp_ms > 0 THEN
                    strftime('%Y-%m-%d-%H-', datetime(timestamp_ms / 1000, 'unixepoch', 'localtime'))
                    || CASE
                        WHEN CAST(strftime('%M', datetime(timestamp_ms / 1000, 'unixepoch', 'localtime')) AS INTEGER) < 30
                        THEN '00'
                        ELSE '30'
                    END
                ELSE local_hour || '-00'
            END,
            {USAGE_DISPLAY_MODEL_SQL},
            COUNT(*),
            COALESCE(SUM(CASE WHEN failed = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN failed != 0 AND canceled = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN canceled != 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(total_tokens), 0)
        FROM usage_events{}
        GROUP BY 1, 2
        ORDER BY 1 ASC, 2 ASC
        "#,
        filter.clause
    );
    let mut statement = connection
        .prepare(&timeline_sql)
        .map_err(|error| format!("Failed to prepare SQLite usage trend query: {error}"))?;
    let timeline_rows = statement
        .query_map(params_from_iter(filter.params.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                from_sql_i64(row.get(2)?),
                from_sql_i64(row.get(3)?),
                from_sql_i64(row.get(4)?),
                from_sql_i64(row.get(5)?),
                from_sql_i64(row.get(6)?),
            ))
        })
        .map_err(|error| format!("Failed to query SQLite usage trends: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read SQLite usage trends: {error}"))?;
    let mut grouped = BTreeMap::<String, UsageTimelinePoint>::new();
    for (hour, model, requests, success, failure, canceled, tokens) in timeline_rows {
        let point = grouped.entry(hour.clone()).or_insert_with(|| UsageTimelinePoint {
            hour,
            ..UsageTimelinePoint::default()
        });
        point.requests = point.requests.saturating_add(requests);
        point.success = point.success.saturating_add(success);
        point.failure = point.failure.saturating_add(failure);
        point.canceled = point.canceled.saturating_add(canceled);
        point.tokens = point.tokens.saturating_add(tokens);
        if let Some(existing) = point.models.iter_mut().find(|item| item.key == model) {
            existing.requests = existing.requests.saturating_add(requests);
            existing.tokens = existing.tokens.saturating_add(tokens);
        } else {
            point.models.push(UsageTimelineModel {
                key: model.clone(),
                label: model,
                tokens,
                requests,
            });
        }
    }
    let timeline = grouped
        .into_values()
        .map(|mut point| {
            point.models.sort_by(|left, right| {
                right
                    .tokens
                    .cmp(&left.tokens)
                    .then_with(|| left.key.cmp(&right.key))
            });
            point
        })
        .collect::<Vec<_>>();

    let mut overview = UsageOverview {
        total_requests: from_sql_i64(summary.0),
        success_count: from_sql_i64(summary.1),
        failure_count: from_sql_i64(summary.2),
        canceled_count: from_sql_i64(summary.3),
        input_tokens: from_sql_i64(summary.4),
        output_tokens: from_sql_i64(summary.5),
        reasoning_tokens: from_sql_i64(summary.6),
        cache_read_tokens: from_sql_i64(summary.7),
        cache_creation_tokens: from_sql_i64(summary.8),
        total_tokens: from_sql_i64(summary.9),
        estimated_cost,
        priced_requests,
        timeline,
        ..UsageOverview::default()
    };
    if overview.total_requests > 0 {
        let completed_requests = overview
            .success_count
            .saturating_add(overview.failure_count);
        if completed_requests > 0 {
            overview.success_rate =
                overview.success_count as f64 * 100.0 / completed_requests as f64;
        }
        overview.average_latency_ms =
            from_sql_i64(summary.10) as f64 / overview.total_requests as f64;
        overview.tps = summary.11;
        overview.tps_sample_count = from_sql_i64(summary.12);
        if overview.input_tokens > 0 {
            overview.cache_hit_rate =
                (overview.cache_read_tokens as f64 / overview.input_tokens as f64).min(1.0);
        }
        let minutes = query_window_minutes(query, summary.13, summary.14);
        overview.rpm = overview.total_requests as f64 / minutes;
        overview.tpm = overview.total_tokens as f64 / minutes;
    }
    Ok(overview)
}

#[tauri::command]
pub(crate) async fn get_usage_analysis(
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageAnalysis, String> {
    let config = gui_config_state.snapshot()?;
    let metadata = sources::fetch(&config).await;
    run_usage_task(move || {
        let connection = open_usage_database_for(&config)?;
        let registry = sources::resolve(&connection, metadata)?;
        let mut analysis = load_usage_analysis_with_notes(&connection, &query, &config, &HashMap::new())?;
        sources::apply_analysis(&mut analysis, &registry);
        Ok(analysis)
    }).await
}

#[cfg(test)]
pub(super) fn load_usage_analysis(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
) -> Result<UsageAnalysis, String> {
    load_usage_analysis_with_notes(connection, query, config, &HashMap::new())
}

pub(super) fn load_usage_analysis_with_notes(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
    notes: &HashMap<String, String>,
) -> Result<UsageAnalysis, String> {
    let filter = build_usage_filter(query);
    let sql = format!(
        r#"
        SELECT
            {USAGE_DISPLAY_MODEL_SQL},
            COALESCE(NULLIF(TRIM(provider), ''), 'Unknown Provider'),
            COALESCE(NULLIF(TRIM(source), ''), 'Unknown source'),
            COALESCE(NULLIF(TRIM(api_key_hash), ''), 'Unrecorded key'),
            MAX(TRIM(api_key_remark)), MAX(TRIM(api_key_display)),
            COUNT(*),
            COALESCE(SUM(CASE WHEN failed != 0 AND canceled = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(total_tokens), 0), TRIM(auth_index)
        FROM usage_events{}
        GROUP BY 1, 2, 3, 4, 10
        "#,
        filter.clause
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare usage analytics query: {error}"))?;
    let mut rows = statement
        .query(params_from_iter(filter.params.iter()))
        .map_err(|error| format!("Failed to query usage analytics: {error}"))?;
    let mut categories: [HashMap<String, UsageCategory>; 4] = Default::default();
    let mut key_labels = HashMap::<String, (String, String)>::new();
    let mut source_labels = HashMap::<String, String>::new();
    let mut source_notes = HashMap::<String, Option<String>>::new();
    let mut key_sources = HashSet::<String>::new();
    let read_result = (|| -> rusqlite::Result<()> {
        while let Some(row) = rows.next()? {
            let requests = from_sql_i64(row.get(6)?);
            let failures = from_sql_i64(row.get(7)?);
            let tokens = from_sql_i64(row.get(8)?);
            let provider: String = row.get(1)?;
            let source: String = row.get(2)?;
            let api_key_hash: String = row.get(3)?;
            let auth_index: String = row.get(9)?;
            if usage_source_looks_like_key(&source)
                || (!api_key_hash.is_empty() && hash_text(source.trim()) == api_key_hash)
                || config.api_keys.iter().any(|entry| entry.key == source.trim())
            {
                key_sources.insert(source.clone());
            }
            if let Some(note) = notes.get(&auth_index) {
                // Historical indexes can disappear after reimporting a file.
                // Only conflicting known notes make a source ambiguous.
                source_notes.entry(source.clone())
                    .and_modify(|current| {
                        if current.as_ref() != Some(note) {
                            *current = None;
                        }
                    })
                    .or_insert_with(|| Some(note.clone()));
            }
            let label = usage_source_display(config, &provider, &source);
            source_labels.entry(source.clone())
                .and_modify(|current| {
                    // A source may represent several credentials; avoid assigning
                    // one credential's note to an ambiguous aggregate.
                    if *current != label {
                        *current = usage_source_display(config, "", &source);
                    }
                })
                .or_insert(label);
            for (index, group) in categories.iter_mut().enumerate() {
                let key: String = row.get(index)?;
                if index == 3 {
                    let remark: String = row.get(4)?;
                    let display: String = row.get(5)?;
                    let labels = key_labels.entry(key.clone()).or_default();
                    if remark > labels.0 {
                        labels.0 = remark;
                    }
                    if display > labels.1 {
                        labels.1 = display;
                    }
                }
                let category = group.entry(key.clone()).or_insert_with(|| UsageCategory {
                    label: key.clone(),
                    key,
                    ..UsageCategory::default()
                });
                category.requests = category.requests.saturating_add(requests);
                category.failures = category.failures.saturating_add(failures);
                category.tokens = category.tokens.saturating_add(tokens);
            }
        }
        Ok(())
    })();
    read_result.map_err(|error| format!("Failed to read usage analytics: {error}"))?;
    let [models, providers, sources, api_keys] = categories.map(sorted_usage_categories);
    let sources = sources
        .into_iter()
        .map(|mut category| {
            let raw_key = category.key.clone();
            if let Some(Some(note)) = source_notes.get(&category.key) {
                category.label = note.clone();
            } else if let Some(label) = source_labels.get(&category.key) {
                category.label = label.clone();
            }
            if key_sources.contains(&raw_key) {
                category.key = usage_source_api_value(&raw_key, &hash_text(raw_key.trim()), config);
                if category.label.contains(&raw_key) {
                    category.label = category.label.replace(&raw_key, &mask_api_key(&raw_key));
                }
            }
            category
        })
        .collect();
    let current_key_labels = usage_api_key_labels(config);
    let api_keys = api_keys
        .into_iter()
        .map(|mut category| {
            let (remark, display) = current_key_labels
                .get(&category.key)
                .cloned()
                .unwrap_or_else(|| key_labels.remove(&category.key).unwrap_or_default());
            category.label = api_key_category_label(remark, display);
            category
        })
        .collect();
    Ok(UsageAnalysis {
        models,
        providers,
        sources,
        api_keys,
        upstreams: load_usage_upstreams(connection, query, config)?,
    })
}

// Keep source labels readable like keeper; identity remains in the filter value.
pub(super) fn usage_upstream_label(config: &GuiConfigFile, provider: &str, source: &str, _auth_index: &str) -> String {
    if !source.trim().is_empty() && !config.api_keys.iter().any(|entry| entry.key == source.trim()) {
        return usage_source_display(config, provider, source);
    }
    if provider.trim().is_empty() { "Unknown source".to_string() } else { provider.trim().to_string() }
}

pub(super) fn load_usage_upstreams(connection: &Connection, query: &UsageQuery, config: &GuiConfigFile) -> Result<Vec<UsageUpstream>, String> {
    let filter = build_usage_filter(query);
    let sql = format!("SELECT {USAGE_UPSTREAM_SQL}, MAX(provider), MAX(source), MAX(TRIM(auth_index)), COUNT(*), SUM(CASE WHEN failed != 0 AND canceled = 0 THEN 1 ELSE 0 END), SUM(total_tokens) FROM usage_events{} GROUP BY 1 ORDER BY 7 DESC, 1", filter.clause);
    let mut statement = connection.prepare(&sql).map_err(|error| format!("Failed to prepare upstream query: {error}"))?;
    let rows = statement.query_map(params_from_iter(filter.params.iter()), |row| {
        let provider: String = row.get(1)?;
        let source: String = row.get(2)?;
        let auth_index: String = row.get(3)?;
        Ok(UsageUpstream {
            category: UsageCategory {
                key: row.get(0)?,
                label: usage_upstream_label(config, &provider, &source, &auth_index),
                requests: from_sql_i64(row.get(4)?),
                failures: from_sql_i64(row.get(5)?),
                tokens: from_sql_i64(row.get(6)?),
            },
            provider,
            is_default: auth_index.trim().is_empty(),
        })
    }).map_err(|error| format!("Failed to query upstreams: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| format!("Failed to read upstreams: {error}"))
}

pub(super) fn sorted_usage_categories(categories: HashMap<String, UsageCategory>) -> Vec<UsageCategory> {
    let mut categories: Vec<_> = categories.into_values().collect();
    categories.sort_by(|left, right| {
        right
            .tokens
            .cmp(&left.tokens)
            .then_with(|| right.requests.cmp(&left.requests))
            .then_with(|| left.key.cmp(&right.key))
    });
    categories
}

#[cfg(test)]
pub(super) fn load_source_categories(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
) -> Result<Vec<UsageCategory>, String> {
    let mut categories = load_simple_categories(connection, query, "source", "Unknown source")?;
    for category in &mut categories {
        category.label = usage_source_display(config, "", &category.key);
    }
    Ok(categories)
}

#[cfg(test)]
pub(super) fn load_simple_categories(
    connection: &Connection,
    query: &UsageQuery,
    column: &str,
    fallback: &str,
) -> Result<Vec<UsageCategory>, String> {
    let filter = build_usage_filter(query);
    let sql = format!(
        r#"
        SELECT
            COALESCE(NULLIF(TRIM({column}), ''), ?),
            COUNT(*),
            COALESCE(SUM(CASE WHEN failed != 0 AND canceled = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(total_tokens), 0)
        FROM usage_events{}
        GROUP BY 1
        ORDER BY 4 DESC, 2 DESC
        "#,
        filter.clause
    );
    let mut values = Vec::with_capacity(filter.params.len() + 1);
    values.push(SqlValue::Text(fallback.to_string()));
    values.extend(filter.params);
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare SQLite usage analytics query: {error}"))?;
    let categories = statement
        .query_map(params_from_iter(values.iter()), |row| {
            let key = row.get::<_, String>(0)?;
            Ok(UsageCategory {
                label: key.clone(),
                key,
                requests: from_sql_i64(row.get(1)?),
                failures: from_sql_i64(row.get(2)?),
                tokens: from_sql_i64(row.get(3)?),
            })
        })
        .map_err(|error| format!("Failed to query SQLite usage analytics: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read SQLite usage analytics: {error}"))?;
    Ok(categories)
}

#[cfg(test)]
pub(super) fn load_api_key_categories(
    connection: &Connection,
    query: &UsageQuery,
) -> Result<Vec<UsageCategory>, String> {
    let filter = build_usage_filter(query);
    let sql = format!(
        r#"
        SELECT
            COALESCE(NULLIF(TRIM(api_key_hash), ''), 'Unrecorded key'),
            MAX(TRIM(api_key_remark)),
            MAX(TRIM(api_key_display)),
            COUNT(*),
            COALESCE(SUM(CASE WHEN failed != 0 AND canceled = 0 THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(total_tokens), 0)
        FROM usage_events{}
        GROUP BY 1
        ORDER BY 6 DESC, 4 DESC
        "#,
        filter.clause
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare SQLite API Key usage analytics query: {error}"))?;
    let categories = statement
        .query_map(params_from_iter(filter.params.iter()), |row| {
            let key = row.get::<_, String>(0)?;
            let remark = row.get::<_, String>(1)?;
            let display = row.get::<_, String>(2)?;
            let label = api_key_category_label(remark, display);
            Ok(UsageCategory {
                key,
                label,
                requests: from_sql_i64(row.get(3)?),
                failures: from_sql_i64(row.get(4)?),
                tokens: from_sql_i64(row.get(5)?),
            })
        })
        .map_err(|error| format!("Failed to query SQLite API Key usage analytics: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read SQLite API Key usage analytics: {error}"))?;
    Ok(categories)
}


#[tauri::command]
pub(crate) async fn get_usage_events(
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageEventPage, String> {
    let config = gui_config_state.snapshot()?;
    let metadata = sources::fetch(&config).await;
    run_usage_task(move || {
        let connection = open_usage_database_for(&config)?;
        let registry = sources::resolve(&connection, metadata)?;
        let mut events = load_usage_events_unmasked_with_notes(
            &connection,
            &query,
            &config,
            &HashMap::new(),
        )?;
        sources::apply_events(&mut events, &registry, &config);
        mask_usage_event_sources(&mut events, &config);
        Ok(events)
    }).await
}

pub(super) fn load_usage_events_with_notes(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
    notes: &HashMap<String, String>,
) -> Result<UsageEventPage, String> {
    let mut page = load_usage_events_unmasked_with_notes(connection, query, config, notes)?;
    mask_usage_event_sources(&mut page, config);
    Ok(page)
}

pub(super) fn load_usage_events_unmasked_with_notes(
    connection: &Connection,
    query: &UsageQuery,
    config: &GuiConfigFile,
    _notes: &HashMap<String, String>,
) -> Result<UsageEventPage, String> {
    let filter = build_usage_filter(query);
    let total_sql = format!("SELECT COUNT(*) FROM usage_events{}", filter.clause);
    let total = connection
        .query_row(&total_sql, params_from_iter(filter.params.iter()), |row| {
            row.get::<_, i64>(0)
        })
        .map(from_sql_i64)
        .map_err(|error| format!("Failed to count SQLite usage events: {error}"))?
        .min(usize::MAX as u64) as usize;
    let page_size = query.page_size.unwrap_or(50).clamp(1, 5_000);
    let total_pages = total.div_ceil(page_size).max(1);
    let page = query.page.unwrap_or(1).clamp(1, total_pages);
    let offset = (page - 1).saturating_mul(page_size);

    let sql = format!(
        r#"
        SELECT
            event_key, timestamp, latency_ms, ttft_ms, source, auth_index, failed,
            provider, model, alias, reasoning_effort, service_tier,
            response_service_tier, executor_type, endpoint, auth_type,
            api_key_hash, api_key_display, api_key_remark, request_id,
            api_group_key, client_ip, x_forwarded_for, user_agent, generate,
            cached_tokens, collector_source,
            input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
            cache_creation_tokens, total_tokens, canceled, failure_status,
            failure_body, id, response_model, {USAGE_AGENT_SQL}
        FROM usage_events{}
        ORDER BY timestamp_ms DESC, id DESC
        LIMIT ? OFFSET ?
        "#,
        filter.clause
    );
    let mut values = filter.params;
    values.push(SqlValue::Integer(page_size as i64));
    values.push(SqlValue::Integer(offset.min(i64::MAX as usize) as i64));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare SQLite usage event query: {error}"))?;
    let mut items = statement
        .query_map(params_from_iter(values.iter()), usage_record_from_row)
        .map_err(|error| format!("Failed to query SQLite usage events: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read SQLite usage events: {error}"))?;
    let prices = load_model_prices(connection)?;
    let current_key_labels = usage_api_key_labels(config);
    for item in &mut items {
        if let Some((remark, display)) = current_key_labels.get(&item.api_key_hash) {
            item.api_key_remark = remark.clone();
            item.api_key_display = display.clone();
        }
        let source_is_client_key = hash_text(item.source.trim()) == item.api_key_hash
            || config.api_keys.iter().any(|entry| entry.key == item.source.trim());
        let mut identity = if item.auth_index.trim().is_empty() && !item.source.trim().is_empty() && !source_is_client_key {
            usage_source_display(config, &item.provider, &item.source)
        } else {
            usage_upstream_label(config, &item.provider, if source_is_client_key { "" } else { &item.source }, &item.auth_index)
        };
        item.source_display = identity;
        item.cost = usage_record_cost(item, &prices);
    }
    Ok(UsageEventPage {
        items,
        total,
        page,
        page_size,
        total_pages,
    })
}

pub(super) fn mask_usage_event_sources(page: &mut UsageEventPage, config: &GuiConfigFile) {
    for item in &mut page.items {
        let safe_source = usage_source_api_value(&item.source, &item.api_key_hash, config);
        if safe_source != item.source {
            item.source_display = item
                .source_display
                .replace(&item.source, &mask_api_key(&item.source));
            item.source = safe_source;
        }
    }
}

pub(super) fn usage_record_from_row(row: &Row<'_>) -> rusqlite::Result<UsageRecord> {
    Ok(UsageRecord {
        id: row.get(0)?,
        row_id: Some(row.get::<_, i64>(36)?.to_string()),
        timestamp: row.get(1)?,
        latency_ms: from_sql_i64(row.get(2)?),
        ttft_ms: row.get::<_, Option<i64>>(3)?.map(from_sql_i64),
        source: row.get(4)?,
        source_display: String::new(),
        auth_index: row.get(5)?,
        failed: row.get::<_, i64>(6)? != 0,
        canceled: row.get::<_, i64>(33)? != 0,
        failure_status: row.get::<_, i64>(34)?.clamp(0, u16::MAX as i64) as u16,
        failure_body: row.get(35)?,
        provider: row.get(7)?,
        api_group_key: row.get(20)?,
        model: row.get(8)?,
        response_model: row.get(37)?,
        cost: None,
        alias: row.get(9)?,
        client_ip: row.get(21)?,
        x_forwarded_for: row.get(22)?,
        user_agent: row.get(23)?,
        agent: row.get(38)?,
        reasoning_effort: row.get(10)?,
        service_tier: row.get(11)?,
        response_service_tier: row.get(12)?,
        executor_type: row.get(13)?,
        endpoint: row.get(14)?,
        auth_type: row.get(15)?,
        api_key_hash: row.get(16)?,
        api_key_display: row.get(17)?,
        api_key_remark: row.get(18)?,
        request_id: row.get(19)?,
        generate: row.get::<_, i64>(24)? != 0,
        cached_tokens: from_sql_i64(row.get(25)?),
        collector_source: row.get(26)?,
        tokens: UsageTokenStats {
            input_tokens: from_sql_i64(row.get(27)?),
            output_tokens: from_sql_i64(row.get(28)?),
            reasoning_tokens: from_sql_i64(row.get(29)?),
            cache_read_tokens: from_sql_i64(row.get(30)?),
            cache_creation_tokens: from_sql_i64(row.get(31)?),
            total_tokens: from_sql_i64(row.get(32)?),
        },
    })
}

pub(super) fn total_usage_records_at(root: &Path) -> Result<u64, String> {
    let connection = open_usage_database_at(root)?;
    connection
        .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(from_sql_i64)
        .map_err(|error| format!("Failed to count total SQLite usage records: {error}"))
}

pub(super) fn query_window_minutes(query: &UsageQuery, first: Option<i64>, last: Option<i64>) -> f64 {
    let start = query
        .start
        .as_deref()
        .and_then(parse_timestamp_millis)
        .or(first)
        .unwrap_or(0);
    let end = query
        .end
        .as_deref()
        .and_then(parse_timestamp_millis)
        .or(last)
        .unwrap_or(start);
    ((end.saturating_sub(start)) as f64 / 60_000.0).max(1.0)
}
