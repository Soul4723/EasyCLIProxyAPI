use super::*;

pub(super) fn load_estimated_cost(
    connection: &Connection,
    filter: &UsageSqlFilter,
) -> Result<(f64, u64), String> {
    let prices = load_model_prices(connection)?;
    let groups = load_usage_cost_groups(connection, filter)?;
    Ok(sum_usage_cost(&groups, &prices))
}

pub(super) fn load_usage_cost_groups(
    connection: &Connection,
    filter: &UsageSqlFilter,
) -> Result<Vec<UsageCostGroup>, String> {
    let long_context_sql = format!(
        "input_tokens > {LONG_CONTEXT_INPUT_TOKEN_THRESHOLD} OR (input_tokens > {GROK_47_LONG_CONTEXT_INPUT_TOKEN_THRESHOLD} AND {GROK_47_MODEL_SQL})"
    );
    let sql = format!(
        r#"
        SELECT
            model,
            alias,
            service_tier,
            response_service_tier,
            executor_type,
            provider,
            auth_type,
            COUNT(*),
            COALESCE(SUM(input_tokens), 0),
            COALESCE(SUM(output_tokens), 0),
            COALESCE(SUM(cache_read_tokens), 0),
            COALESCE(SUM(cache_creation_tokens), 0),
            COALESCE(SUM(CASE WHEN ({long_context_sql}) THEN input_tokens ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN ({long_context_sql}) THEN output_tokens ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN ({long_context_sql}) THEN cache_read_tokens ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN ({long_context_sql}) THEN cache_creation_tokens ELSE 0 END), 0),
            COALESCE(SUM(total_tokens), 0)
        FROM usage_events{}
        GROUP BY model, alias, service_tier, response_service_tier, executor_type, provider, auth_type
        "#,
        filter.clause
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Failed to prepare usage cost query: {error}"))?;
    let groups = statement
        .query_map(params_from_iter(filter.params.iter()), |row| {
            Ok(UsageCostGroup {
                model: row.get(0)?,
                alias: row.get(1)?,
                service_tier: row.get(2)?,
                response_service_tier: row.get(3)?,
                executor_type: row.get(4)?,
                provider: row.get(5)?,
                auth_type: row.get(6)?,
                requests: from_sql_i64(row.get(7)?),
                tokens: CostTokens {
                    input: from_sql_i64(row.get(8)?),
                    output: from_sql_i64(row.get(9)?),
                    cache_read: from_sql_i64(row.get(10)?),
                    cache_creation: from_sql_i64(row.get(11)?),
                    long_input: from_sql_i64(row.get(12)?),
                    long_output: from_sql_i64(row.get(13)?),
                    long_cache_read: from_sql_i64(row.get(14)?),
                    long_cache_creation: from_sql_i64(row.get(15)?),
                },
                total_tokens: from_sql_i64(row.get(16)?),
            })
        })
        .map_err(|error| format!("Failed to query usage costs: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read usage costs: {error}"))?;
    Ok(groups)
}

pub(super) fn sum_usage_cost(groups: &[UsageCostGroup], prices: &HashMap<String, ModelPrice>) -> (f64, u64) {
    let mut total_cost = 0.0;
    let mut priced_requests = 0_u64;
    for group in groups {
        let Some((model, price)) = resolve_model_price(&group.model, &group.alias, prices) else {
            continue;
        };
        let identity = format!(
            "{} {} {}",
            group.executor_type, group.provider, group.auth_type
        )
        .to_ascii_lowercase();
        let service_tier =
            if identity.contains("codex") || group.response_service_tier.trim().is_empty() {
                group.service_tier.as_str()
            } else {
                group.response_service_tier.as_str()
            };
        total_cost += cost_for_price(model, service_tier, &group.tokens, &price);
        priced_requests = priced_requests.saturating_add(group.requests);
    }
    (total_cost, priced_requests)
}

pub(super) fn cost_for_price(model: &str, service_tier: &str, tokens: &CostTokens, price: &ModelPrice) -> f64 {
    let price = enriched_model_price(model, price);
    let long_output_multiplier = if is_model_family(model, "grok-4.7") {
        2.0
    } else {
        1.5
    };
    let short_cost = cost_for_token_segment(
        tokens.input.saturating_sub(tokens.long_input),
        tokens.output.saturating_sub(tokens.long_output),
        tokens.cache_read.saturating_sub(tokens.long_cache_read),
        tokens
            .cache_creation
            .saturating_sub(tokens.long_cache_creation),
        &price,
        1.0,
        1.0,
    );
    let long_cost = cost_for_token_segment(
        tokens.long_input,
        tokens.long_output,
        tokens.long_cache_read,
        tokens.long_cache_creation,
        &price,
        2.0,
        long_output_multiplier,
    );
    let tier = service_tier.trim().to_ascii_lowercase();
    let multiplier = match tier.as_str() {
        "flex" | "batch" => 0.5,
        "priority" | "fast" => service_tier_multiplier(model),
        _ => 1.0,
    };
    // A grouped total can contain both context lengths. Long-context overrides
    // must not suppress the service-tier multiplier on its short requests.
    let long_multiplier = if matches!(tier.as_str(), "priority" | "fast")
        && !is_model_family(model, "gpt-6")
    {
        1.0
    } else {
        multiplier
    };
    short_cost * multiplier + long_cost * long_multiplier
}

pub(super) fn usage_record_cost(record: &UsageRecord, prices: &HashMap<String, ModelPrice>) -> Option<UsageRecordCost> {
    let (model, price) = resolve_model_price(&record.model, &record.alias, prices)?;
    let input = record.tokens.input_tokens;
    // Keep the same context buckets and tier selection as the aggregate pricing query.
    let long = input > LONG_CONTEXT_INPUT_TOKEN_THRESHOLD
        || (input > GROK_47_LONG_CONTEXT_INPUT_TOKEN_THRESHOLD && is_model_family(model, "grok-4.7"));
    let tokens = CostTokens {
        input,
        output: record.tokens.output_tokens,
        cache_read: record.tokens.cache_read_tokens,
        cache_creation: record.tokens.cache_creation_tokens,
        long_input: if long { input } else { 0 },
        long_output: if long { record.tokens.output_tokens } else { 0 },
        long_cache_read: if long { record.tokens.cache_read_tokens } else { 0 },
        long_cache_creation: if long { record.tokens.cache_creation_tokens } else { 0 },
    };
    let identity = format!("{} {} {}", record.executor_type, record.provider, record.auth_type).to_ascii_lowercase();
    let tier = if identity.contains("codex") || record.response_service_tier.trim().is_empty() {
        &record.service_tier
    } else {
        &record.response_service_tier
    };
    Some(UsageRecordCost {
        total: cost_for_price(model, tier, &tokens, &price),
        pricing_model: price.model,
    })
}

pub(super) fn cost_for_token_segment(
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    price: &ModelPrice,
    input_multiplier: f64,
    output_multiplier: f64,
) -> f64 {
    let prompt = input.saturating_sub(cache_read.saturating_add(cache_creation));
    ((prompt as f64 * price.prompt
        + cache_read as f64 * price.cache_read
        + cache_creation as f64 * price.cache_creation)
        * input_multiplier
        + output as f64 * price.completion * output_multiplier)
        / TOKENS_PER_PRICE_UNIT
}

pub(super) fn official_model_price(model: &str) -> Option<ModelPrice> {
    find_model_price(cached_bundled_model_prices().ok()?, model).cloned()
}

pub(super) fn bundled_model_prices() -> Result<HashMap<String, ModelPrice>, String> {
    cached_bundled_model_prices().cloned()
}

pub(super) fn cached_bundled_model_prices() -> Result<&'static HashMap<String, ModelPrice>, String> {
    static PRICES: LazyLock<Result<HashMap<String, ModelPrice>, String>> =
        LazyLock::new(|| parse_model_price_catalog(BUNDLED_MODEL_PRICE_CATALOG, "builtin", 0));
    PRICES.as_ref().map_err(Clone::clone)
}

pub(super) fn parse_model_price_catalog(
    content: &str,
    source: &str,
    updated_at_ms: i64,
) -> Result<HashMap<String, ModelPrice>, String> {
    let catalog = serde_json::from_str::<ModelPriceCatalog>(content)
        .map_err(|error| format!("Failed to parse model pricing file: {error}"))?;
    if catalog.schema_version != 1 {
        return Err(format!(
            "Unsupported model pricing file version {}",
            catalog.schema_version
        ));
    }
    if catalog.models.is_empty() {
        return Err("Model pricing file contains no models".to_string());
    }
    let _catalog_updated_at = catalog.updated_at;
    let mut prices = HashMap::with_capacity(catalog.models.len());
    for (model, entry) in catalog.models {
        let cache_read = entry.cache_read_per_1_m.unwrap_or(0.0);
        let cache_creation = entry.cache_creation_per_1_m.unwrap_or(0.0);
        let price = ModelPrice {
            model: model.trim().to_string(),
            prompt: entry.input_per_1_m,
            completion: entry.output_per_1_m,
            cache_read,
            cache_creation,
            prompt_configured: true,
            completion_configured: true,
            cache_read_configured: entry.cache_read_per_1_m.is_some(),
            cache_creation_configured: entry.cache_creation_per_1_m.is_some(),
            source: source.to_string(),
            source_model_id: String::new(),
            updated_at_ms,
        };
        validate_model_price(&price)?;
        prices.insert(price.model.clone(), price);
    }
    Ok(prices)
}

pub(super) fn parse_models_dev_prices(
    content: &str,
    updated_at_ms: i64,
) -> Result<Vec<ModelPrice>, String> {
    let catalog: Value = serde_json::from_str(content)
        .map_err(|error| format!("Failed to parse models.dev pricing: {error}"))?;
    let providers = catalog
        .get("providers")
        .and_then(Value::as_object)
        .or_else(|| catalog.as_object())
        .ok_or("Invalid models.dev pricing catalog format")?;
    let mut prices = Vec::new();
    for (provider, entry) in providers {
        let Some(models) = entry
            .get("models")
            .and_then(Value::as_object)
        else {
            continue;
        };
        for (model_id, entry) in models {
            let Some(cost) = entry.get("cost") else {
                continue;
            };
            let (Some(prompt), Some(completion)) = (
                cost.get("input").and_then(Value::as_f64),
                cost.get("output").and_then(Value::as_f64),
            ) else {
                continue;
            };
            let cache_read = cost.get("cache_read").and_then(Value::as_f64);
            let cache_creation = cost.get("cache_write").and_then(Value::as_f64);
            let price = ModelPrice {
                model: model_id.trim().to_string(),
                prompt,
                completion,
                cache_read: cache_read.unwrap_or(0.0),
                cache_creation: cache_creation.unwrap_or(0.0),
                prompt_configured: true,
                completion_configured: true,
                cache_read_configured: cache_read.is_some(),
                cache_creation_configured: cache_creation.is_some(),
                source: "models.dev".to_string(),
                source_model_id: format!("{provider}/{model_id}"),
                updated_at_ms,
            };
            validate_model_price(&price)?;
            prices.push(price);
        }
    }
    if prices.is_empty() {
        return Err("models.dev has no available model pricing".to_string());
    }
    Ok(prices)
}

pub(super) fn parse_litellm_prices(content: &str, updated_at_ms: i64) -> Result<Vec<ModelPrice>, String> {
    let catalog: Value = serde_json::from_str(content)
        .map_err(|error| format!("Failed to parse LiteLLM pricing: {error}"))?;
    let models = catalog.as_object().ok_or("Invalid LiteLLM pricing catalog format")?;
    let mut prices = Vec::new();
    for (model_id, entry) in models {
        let mode = entry.get("mode").and_then(Value::as_str).unwrap_or_default();
        if !matches!(mode, "chat" | "completion" | "responses") {
            continue;
        }
        if let Some(modalities) = entry.get("supported_output_modalities").and_then(Value::as_array) {
            if !modalities.iter().any(|value| value.as_str() == Some("text")) {
                continue;
            }
        }
        let (Some(prompt), Some(completion)) = (
            entry.get("input_cost_per_token").and_then(Value::as_f64),
            entry.get("output_cost_per_token").and_then(Value::as_f64),
        ) else {
            continue;
        };
        let cache_read = entry
            .get("cache_read_input_token_cost")
            .and_then(Value::as_f64)
            .or_else(|| entry.get("input_cost_per_token_cache_hit").and_then(Value::as_f64));
        let cache_creation = entry
            .get("cache_creation_input_token_cost")
            .and_then(Value::as_f64);
        let price = ModelPrice {
            model: model_id.trim().to_string(),
            prompt: prompt * TOKENS_PER_PRICE_UNIT,
            completion: completion * TOKENS_PER_PRICE_UNIT,
            cache_read: cache_read.unwrap_or(0.0) * TOKENS_PER_PRICE_UNIT,
            cache_creation: cache_creation.unwrap_or(0.0) * TOKENS_PER_PRICE_UNIT,
            prompt_configured: true,
            completion_configured: true,
            cache_read_configured: cache_read.is_some(),
            cache_creation_configured: cache_creation.is_some(),
            source: "litellm-sync".to_string(),
            source_model_id: model_id.clone(),
            updated_at_ms,
        };
        if validate_model_price(&price).is_ok() {
            prices.push(price);
        }
    }
    if prices.is_empty() {
        return Err("LiteLLM has no available model pricing".to_string());
    }
    Ok(prices)
}

pub(super) fn find_model_price<'a>(
    prices: &'a HashMap<String, ModelPrice>,
    model: &str,
) -> Option<&'a ModelPrice> {
    if let Some(price) = prices.get(model) {
        return Some(price);
    }
    let case_insensitive = prices
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case(model))
        .collect::<Vec<_>>();
    if case_insensitive.len() == 1 {
        return Some(case_insensitive[0].1);
    }
    let tail = canonical_model_tail(model);
    let exact_tail = prices
        .iter()
        .filter(|(key, _)| canonical_model_tail(key) == tail)
        .collect::<Vec<_>>();
    if exact_tail.len() == 1 {
        return Some(exact_tail[0].1);
    }
    let normalized_tail = normalized_model_tail(model);
    prices
        .iter()
        .filter_map(|(key, price)| {
            let key_tail = normalized_model_tail(key);
            normalized_tail
                .starts_with(&format!("{key_tail}-"))
                .then_some((key_tail.len(), price))
        })
        .max_by_key(|(length, _)| *length)
        .map(|(_, price)| price)
}

pub(super) fn resolve_model_price<'a>(
    model: &'a str,
    alias: &'a str,
    prices: &HashMap<String, ModelPrice>,
) -> Option<(&'a str, ModelPrice)> {
    for candidate in [model, alias] {
        if candidate.trim().is_empty() {
            continue;
        }
        if let Some(price) = find_model_price(prices, candidate) {
            return Some((model, price.clone()));
        }
    }
    None
}

pub(super) fn enriched_model_price(model: &str, price: &ModelPrice) -> ModelPrice {
    let mut price = price.clone();
    if let Some(official) = official_model_price(model) {
        if !price.prompt_configured && price.prompt <= 0.0 {
            price.prompt = official.prompt;
        }
        if !price.completion_configured && price.completion <= 0.0 {
            price.completion = official.completion;
        }
    }
    price
}

pub(super) fn is_model_family(model: &str, family: &str) -> bool {
    let normalized = model
        .trim()
        .to_ascii_lowercase()
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string();
    normalized == family || normalized.starts_with(&format!("{family}-"))
}

pub(super) fn service_tier_multiplier(model: &str) -> f64 {
    if is_model_family(model, "gpt-5.5") {
        2.5
    } else if is_model_family(model, "gpt-6")
        || is_model_family(model, "gpt-5.6")
        || is_model_family(model, "gpt-5.4")
        || is_model_family(model, "gpt-5.4-mini")
        || is_model_family(model, "gpt-5.3-codex")
    {
        2.0
    } else {
        1.0
    }
}

pub(super) fn load_model_prices(connection: &Connection) -> Result<HashMap<String, ModelPrice>, String> {
    let mut merged = bundled_model_prices()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT model, prompt_per_1m, completion_per_1m,
                   cache_read_per_1m, cache_creation_per_1m,
                   prompt_configured, completion_configured,
                   cache_read_configured, cache_creation_configured,
                   source, source_model_id, updated_at_ms
            FROM model_prices ORDER BY model
            "#,
        )
        .map_err(|error| format!("Failed to prepare model pricing query: {error}"))?;
    let prices = statement
        .query_map([], |row| {
            Ok(ModelPrice {
                model: row.get(0)?,
                prompt: row.get(1)?,
                completion: row.get(2)?,
                cache_read: row.get(3)?,
                cache_creation: row.get(4)?,
                prompt_configured: row.get(5)?,
                completion_configured: row.get(6)?,
                cache_read_configured: row.get(7)?,
                cache_creation_configured: row.get(8)?,
                source: row.get(9)?,
                source_model_id: row.get(10)?,
                updated_at_ms: row.get(11)?,
            })
        })
        .map_err(|error| format!("Failed to query model pricing: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read model pricing: {error}"))?;
    for price in prices {
        if price.source != "litellm" {
            if let Some(existing) = merged
                .keys()
                .find(|model| model.eq_ignore_ascii_case(&price.model))
                .cloned()
            {
                merged.remove(&existing);
            }
            merged.insert(price.model.clone(), price);
        }
    }
    Ok(merged)
}

pub(super) fn validate_model_price(price: &ModelPrice) -> Result<(), String> {
    if price.model.trim().is_empty() {
        return Err("Model name cannot be empty".to_string());
    }
    for value in [
        price.prompt,
        price.completion,
        price.cache_read,
        price.cache_creation,
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(format!("Model {} contains invalid pricing", price.model));
        }
    }
    Ok(())
}

pub(super) fn upsert_model_price(connection: &Connection, price: &ModelPrice) -> Result<(), String> {
    validate_model_price(price)?;
    connection
        .execute(
            r#"
            INSERT INTO model_prices (
                model, prompt_per_1m, completion_per_1m,
                cache_read_per_1m, cache_creation_per_1m,
                prompt_configured, completion_configured,
                cache_read_configured, cache_creation_configured,
                source, source_model_id, updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(model) DO UPDATE SET
                prompt_per_1m = excluded.prompt_per_1m,
                completion_per_1m = excluded.completion_per_1m,
                cache_per_1m = 0,
                cache_read_per_1m = excluded.cache_read_per_1m,
                cache_creation_per_1m = excluded.cache_creation_per_1m,
                prompt_configured = excluded.prompt_configured,
                completion_configured = excluded.completion_configured,
                cache_read_configured = excluded.cache_read_configured,
                cache_creation_configured = excluded.cache_creation_configured,
                source = excluded.source,
                source_model_id = excluded.source_model_id,
                updated_at_ms = excluded.updated_at_ms
            "#,
            params![
                price.model.trim(),
                price.prompt,
                price.completion,
                price.cache_read,
                price.cache_creation,
                price.prompt_configured,
                price.completion_configured,
                price.cache_read_configured,
                price.cache_creation_configured,
                price.source,
                price.source_model_id,
                price.updated_at_ms,
            ],
        )
        .map_err(|error| format!("Failed to save model pricing: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn get_usage_pricing(
    query: UsageQuery,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsagePricing, String> {
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || load_usage_pricing(&open_usage_database_for(&config)?, &query)).await
}

pub(super) fn load_usage_pricing(connection: &Connection, query: &UsageQuery) -> Result<UsagePricing, String> {
    let filter = build_usage_filter(query);
    let prices = load_model_prices(connection)?;
    let groups = load_usage_cost_groups(connection, &filter)?;
    let mut rows = HashMap::<String, UsagePriceRow>::new();
    let mut total_requests = 0_u64;
    let mut priced_requests = 0_u64;
    let mut total_cost = 0.0;
    for group in &groups {
        total_requests = total_requests.saturating_add(group.requests);
        let entry = rows
            .entry(group.model.clone())
            .or_insert_with(|| UsagePriceRow {
                model: group.model.clone(),
                ..UsagePriceRow::default()
            });
        entry.requests = entry.requests.saturating_add(group.requests);
        entry.input_tokens = entry.input_tokens.saturating_add(group.tokens.input);
        entry.output_tokens = entry.output_tokens.saturating_add(group.tokens.output);
        entry.cache_read_tokens = entry
            .cache_read_tokens
            .saturating_add(group.tokens.cache_read);
        entry.cache_creation_tokens = entry
            .cache_creation_tokens
            .saturating_add(group.tokens.cache_creation);
        entry.total_tokens = entry.total_tokens.saturating_add(group.total_tokens);

        if let Some((model, price)) = resolve_model_price(&group.model, &group.alias, &prices) {
            let identity = format!(
                "{} {} {}",
                group.executor_type, group.provider, group.auth_type
            )
            .to_ascii_lowercase();
            let service_tier =
                if identity.contains("codex") || group.response_service_tier.trim().is_empty() {
                    group.service_tier.as_str()
                } else {
                    group.response_service_tier.as_str()
                };
            let cost = cost_for_price(model, service_tier, &group.tokens, &price);
            entry.estimated_cost += cost;
            entry.price = Some(enriched_model_price(model, &price));
            total_cost += cost;
            priced_requests = priced_requests.saturating_add(group.requests);
        }
    }
    for price in prices.values() {
        rows.entry(price.model.clone())
            .or_insert_with(|| UsagePriceRow {
                model: price.model.clone(),
                price: Some(enriched_model_price(&price.model, price)),
                ..UsagePriceRow::default()
            });
    }
    let mut rows = rows.into_values().collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        left.price
            .is_some()
            .cmp(&right.price.is_some())
            .then_with(|| right.requests.cmp(&left.requests))
            .then_with(|| left.model.cmp(&right.model))
    });
    Ok(UsagePricing {
        rows,
        total_cost,
        total_requests,
        priced_requests,
        saved_prices: prices.len(),
    })
}

#[tauri::command]
pub(crate) async fn save_usage_model_price(
    mut price: ModelPrice,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<(), String> {
    price.model = price.model.trim().to_string();
    price.source = "manual".to_string();
    price.source_model_id.clear();
    price.updated_at_ms = Local::now().timestamp_millis();
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || upsert_model_price(&open_usage_database_for(&config)?, &price)).await
}

#[tauri::command]
pub(crate) async fn delete_usage_model_price(
    model: String,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<(), String> {
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || {
        let connection = open_usage_database_for(&config)?;
        connection
            .execute(
                "DELETE FROM model_prices WHERE model = ?1 COLLATE NOCASE",
                params![model.trim()],
            )
            .map_err(|error| format!("Failed to delete model pricing: {error}"))?;
        Ok(())
    })
    .await
}

pub(super) fn sync_price_for_model<'a>(model: &str, prices: &'a [ModelPrice]) -> Option<&'a ModelPrice> {
    let model = model.trim();
    if model.is_empty() {
        return None;
    }
    let exact = prices
        .iter()
        .filter(|price| price.source_model_id.eq_ignore_ascii_case(model))
        .collect::<Vec<_>>();
    if exact.len() == 1 {
        return Some(exact[0]);
    }
    let tail = model.rsplit('/').next().unwrap_or(model);
    let family = tail.to_ascii_lowercase();
    let mut candidates = prices
        .iter()
        .filter(|price| price.model.eq_ignore_ascii_case(tail))
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        let normalized = canonical_model_tail(tail);
        candidates = prices
            .iter()
            .filter(|price| canonical_model_tail(&price.model) == normalized)
            .collect();
    }
    let provider = if family.starts_with("gpt-")
        || family.starts_with("chatgpt-")
        || family.starts_with("o1-")
        || family.starts_with("o3-")
        || family.starts_with("o4-")
    {
        Some("openai")
    } else if family.starts_with("claude-") {
        Some("anthropic")
    } else if family.starts_with("gemini-") {
        Some("google")
    } else if family.starts_with("deepseek-") {
        Some("deepseek")
    } else if family.starts_with("grok-") {
        Some("xai")
    } else {
        None
    };
    if let Some(provider) = provider {
        let official = candidates
            .iter()
            .filter(|price| price.source_model_id.starts_with(&format!("{provider}/")))
            .collect::<Vec<_>>();
        if official.len() == 1 {
            return Some(official[0]);
        }
    }
    (candidates.len() == 1).then(|| candidates[0])
}

pub(super) fn build_model_price_preview(
    models: &[(String, String)],
    remote_prices: &[ModelPrice],
    source: &str,
    source_url: &str,
) -> ModelPriceSyncPreview {
    let mut matches = Vec::new();
    let mut unmatched = Vec::new();
    for (model, alias) in models {
        let matched = [model.as_str(), alias.as_str()]
            .into_iter()
            .find_map(|candidate| sync_price_for_model(candidate, remote_prices));
        if let Some(price) = matched {
            let mut price = price.clone();
            price.model = model.clone();
            matches.push(price);
        } else {
            unmatched.push(model.clone());
        }
    }
    ModelPriceSyncPreview {
        source: source.to_string(),
        source_url: source_url.to_string(),
        matches,
        unmatched,
    }
}

pub(super) fn collect_price_preview_models(
    connection: &Connection,
    query: &UsageQuery,
) -> Result<Vec<(String, String)>, String> {
    let mut models = std::collections::BTreeMap::<String, (String, String)>::new();
    for price in load_model_prices(connection)?.values() {
        models.insert(price.model.to_ascii_lowercase(), (price.model.clone(), String::new()));
    }
    let filter = build_usage_filter(query);
    for group in load_usage_cost_groups(connection, &filter)? {
        let entry = models
            .entry(group.model.to_ascii_lowercase())
            .or_insert_with(|| (group.model, String::new()));
        if entry.1.is_empty() && !group.alias.trim().is_empty() {
            entry.1 = group.alias;
        }
    }
    Ok(models.into_values().collect())
}

pub(super) async fn fetch_model_price_catalog_once(
    client: &reqwest::Client,
    source_name: &str,
    source_url: &str,
) -> Result<String, (bool, String)> {
    let mut response = client
        .get(source_url)
        .send()
        .await
        .map_err(|error| (true, format!("Failed to connect to {source_name}: {error}")))?;
    let status = response.status();
    if !status.is_success() {
        let retryable = status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS;
        return Err((retryable, format!("Failed to read {source_name} pricing: HTTP {status}")));
    }
    if response.content_length().is_some_and(|length| length > MODEL_PRICE_SYNC_MAX_BYTES as u64) {
        return Err((false, format!("{source_name} pricing catalog is too large")));
    }
    let mut content = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| (true, format!("Failed to read {source_name} response: {error}")))?
    {
        if content.len().saturating_add(chunk.len()) > MODEL_PRICE_SYNC_MAX_BYTES {
            return Err((false, format!("{source_name} pricing catalog is too large")));
        }
        content.extend_from_slice(&chunk);
    }
    String::from_utf8(content)
        .map_err(|error| (true, format!("{source_name} response is not UTF-8: {error}")))
}

pub(super) async fn fetch_model_price_catalog(
    client: &reqwest::Client,
    source_name: &str,
    source_url: &str,
) -> Result<String, String> {
    for attempt in 1..=MODEL_PRICE_SYNC_ATTEMPTS {
        match fetch_model_price_catalog_once(client, source_name, source_url).await {
            Ok(content) => return Ok(content),
            Err((true, _)) if attempt < MODEL_PRICE_SYNC_ATTEMPTS => {
                tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
            }
            Err((retryable, error)) => {
                return Err(if retryable {
                    format!("{error} (attempted {attempt} times)")
                } else {
                    error
                });
            }
        }
    }
    unreachable!("Attempt to read the pricing catalog at least once")
}

#[tauri::command]
pub(crate) async fn preview_usage_model_prices(
    query: UsageQuery,
    source: String,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<ModelPriceSyncPreview, String> {
    let (source_name, source_url) = match source.as_str() {
        "models-dev" => ("Models.dev", MODEL_PRICE_SYNC_URL),
        "litellm" => ("LiteLLM", LITELLM_PRICE_SYNC_URL),
        _ => return Err("Unsupported pricing source".to_string()),
    };
    let config = gui_config_state.snapshot()?;
    let client_builder = reqwest::Client::builder()
        .user_agent("EasyCLIProxyAPI/0.2.97")
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60));
    let proxy_url = config.proxy_url.trim();
    let client = apply_configured_proxy(client_builder, proxy_url)
        .map_err(|error| format!("Failed to configure pricing synchronization proxy: {error}"))?
        .build()
        .map_err(|error| format!("Failed to create pricing synchronization client: {error}"))?;
    let content = fetch_model_price_catalog(&client, source_name, source_url).await?;
    let now = Local::now().timestamp_millis();
    let remote_prices = if source == "models-dev" {
        parse_models_dev_prices(&content, now)?
    } else {
        parse_litellm_prices(&content, now)?
    };

    run_usage_task(move || {
        let connection = open_usage_database_for(&config)?;
        let models = collect_price_preview_models(&connection, &query)?;
        Ok(build_model_price_preview(
            &models,
            &remote_prices,
            source_name,
            source_url,
        ))
    })
    .await
}

#[tauri::command]
pub(crate) async fn apply_usage_model_prices(
    prices: Vec<ModelPrice>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<ModelPriceSyncResult, String> {
    let mut seen = std::collections::HashSet::new();
    for price in &prices {
        validate_model_price(price)?;
        if !matches!(price.source.as_str(), "models.dev" | "litellm-sync")
            || price.source_model_id.trim().is_empty()
        {
            return Err("Invalid pricing synchronization source".to_string());
        }
        if !seen.insert(price.model.to_ascii_lowercase()) {
            return Err(format!("Duplicate model pricing: {}", price.model));
        }
    }
    let config = gui_config_state.snapshot()?;
    run_usage_task(move || {
        let mut connection = open_usage_database_for(&config)?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("Failed to begin saving model pricing: {error}"))?;
        for mut price in prices.iter().cloned() {
            price.model = price.model.trim().to_string();
            price.updated_at_ms = Local::now().timestamp_millis();
            upsert_model_price(&transaction, &price)?;
        }
        transaction
            .commit()
            .map_err(|error| format!("Failed to commit model pricing: {error}"))?;
        Ok(ModelPriceSyncResult { imported: prices.len() })
    })
    .await
}

pub(super) fn canonical_model_tail(value: &str) -> String {
    normalized_model_tail(value)
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

pub(super) fn normalized_model_tail(value: &str) -> String {
    value
        .trim()
        .rsplit('/')
        .find(|part| !part.trim().is_empty() && !part.eq_ignore_ascii_case("models"))
        .unwrap_or(value)
        .to_ascii_lowercase()
}
