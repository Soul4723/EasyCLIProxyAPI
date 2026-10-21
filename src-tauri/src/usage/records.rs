use super::*;

pub(super) fn normalize_usage_record(value: Value, config: &GuiConfigFile) -> Result<UsageRecord, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "CPA usage record must be a JSON object".to_string())?;
    let timestamp = string_field(object, "timestamp")
        .filter(|value| DateTime::parse_from_rfc3339(value).is_ok())
        .unwrap_or_else(|| Local::now().to_rfc3339());
    let request_id = string_field(object, "request_id")
        .ok_or_else(|| "CPA usage record must contain request_id".to_string())?;
    let api_key = string_field(object, "api_key").unwrap_or_default();
    let api_key_hash = hash_text(&api_key);
    let api_key_remark = config
        .api_keys
        .iter()
        .find(|entry| entry.key == api_key)
        .map(|entry| entry.remark.clone())
        .unwrap_or_default();
    let provider = string_field(object, "provider").unwrap_or_default();
    let executor_type = string_field(object, "executor_type").unwrap_or_default();
    let auth_type = string_field(object, "auth_type").unwrap_or_default();
    let tokens_object = object.get("tokens").and_then(Value::as_object);
    let cache_read_present = tokens_object
        .and_then(|tokens| tokens.get("cache_read_tokens"))
        .is_some();
    let raw_cache_read_tokens = token_u64(tokens_object, "cache_read_tokens");
    let cache_creation_tokens = token_u64(tokens_object, "cache_creation_tokens");
    let raw_cached_tokens =
        token_u64(tokens_object, "cached_tokens").max(token_u64(tokens_object, "cache_tokens"));
    let normalized_tokens = normalize_keeper_tokens(
        &executor_type,
        &provider,
        &auth_type,
        KeeperTokenValues {
            input: token_u64(tokens_object, "input_tokens"),
            output: token_u64(tokens_object, "output_tokens"),
            reasoning: token_u64(tokens_object, "reasoning_tokens"),
            cached: raw_cached_tokens,
            cache_read: raw_cache_read_tokens,
            cache_read_present,
            cache_creation: cache_creation_tokens,
            total: token_u64(tokens_object, "total_tokens"),
            clamped: ClampedTokenFields {
                input: token_was_negative(tokens_object, "input_tokens"),
                output: token_was_negative(tokens_object, "output_tokens"),
                reasoning: token_was_negative(tokens_object, "reasoning_tokens"),
                cached: token_was_negative(tokens_object, "cached_tokens")
                    || token_was_negative(tokens_object, "cache_tokens"),
                cache_read: token_was_negative(tokens_object, "cache_read_tokens"),
                cache_creation: token_was_negative(tokens_object, "cache_creation_tokens"),
                total: token_was_negative(tokens_object, "total_tokens"),
            },
        },
    );
    let tokens = UsageTokenStats {
        input_tokens: normalized_tokens.input,
        output_tokens: normalized_tokens.output,
        reasoning_tokens: normalized_tokens.reasoning,
        cache_read_tokens: normalized_tokens.cache_read,
        cache_creation_tokens: normalized_tokens.cache_creation,
        total_tokens: normalized_tokens.total,
    };
    let id = request_id.clone();
    let endpoint = string_field(object, "endpoint").unwrap_or_default();
    let failed = object
        .get("failed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let (failure_status, failure_body) = usage_failure_details(object);
    let canceled = failed && usage_failure_is_canceled(failure_status, &failure_body);
    let generate = object
        .get("generate")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            !(executor_type == "CodexWebsocketsExecutor"
                && !failed
                && tokens.input_tokens == 0
                && tokens.output_tokens == 0
                && tokens.reasoning_tokens == 0
                && tokens.cache_read_tokens == 0
                && tokens.cache_creation_tokens == 0
                && tokens.total_tokens == 0)
        });
    let api_group_key = if api_key_hash.is_empty() {
        if !provider.is_empty() {
            provider.clone()
        } else if !endpoint.is_empty() {
            endpoint.clone()
        } else {
            "unknown".to_string()
        }
    } else {
        api_key_hash.clone()
    };
    Ok(UsageRecord {
        id,
        row_id: None,
        timestamp,
        latency_ms: u64_field(object, "latency_ms"),
        ttft_ms: optional_u64_field(object, "ttft_ms"),
        source: string_field(object, "source").unwrap_or_default(),
        source_display: String::new(),
        auth_index: string_field(object, "auth_index").unwrap_or_default(),
        failed,
        canceled,
        failure_status,
        failure_body,
        provider,
        api_group_key,
        model: string_field(object, "resolved_model")
            .or_else(|| string_field(object, "resolvedModel"))
            .or_else(|| string_field(object, "model"))
            .unwrap_or_else(|| "unknown".to_string()),
        response_model: string_field(object, "response_model")
            .or_else(|| string_field(object, "responseModel")).unwrap_or_default(),
        cost: None,
        alias: string_field(object, "alias")
            .or_else(|| string_field(object, "requested_model"))
            .or_else(|| string_field(object, "requestedModel")).unwrap_or_default(),
        client_ip: string_field(object, "client_ip"),
        x_forwarded_for: string_field(object, "x_forwarded_for"),
        user_agent: string_field(object, "user_agent"),
        agent: String::new(),
        reasoning_effort: string_field(object, "reasoning_effort").unwrap_or_default(),
        service_tier: string_field(object, "service_tier").unwrap_or_default(),
        response_service_tier: string_field(object, "response_service_tier").unwrap_or_default(),
        executor_type,
        endpoint,
        auth_type,
        api_key_hash,
        api_key_display: mask_api_key(&api_key),
        api_key_remark,
        request_id,
        generate,
        cached_tokens: normalized_tokens.cached,
        collector_source: HTTP_USAGE_QUEUE_SOURCE.to_string(),
        tokens,
    })
}

pub(super) fn usage_failure_body(value: &Value) -> String {
    let body = match value {
        Value::String(value) => value.trim().to_string(),
        Value::Null => String::new(),
        value => serde_json::to_string(value).unwrap_or_default(),
    };
    if body.chars().count() <= MAX_USAGE_FAILURE_BODY_CHARS {
        body
    } else {
        let mut bounded = body
            .chars()
            .take(MAX_USAGE_FAILURE_BODY_CHARS)
            .collect::<String>();
        bounded.push('…');
        bounded
    }
}

pub(super) fn usage_failure_details(object: &serde_json::Map<String, Value>) -> (u16, String) {
    let failure = object.get("fail").and_then(Value::as_object);
    let status = failure
        .and_then(|value| value.get("status_code").or_else(|| value.get("statusCode")))
        .and_then(Value::as_u64)
        .unwrap_or_default()
        .min(u16::MAX as u64) as u16;
    let body = failure
        .and_then(|value| value.get("body"))
        .map(usage_failure_body)
        .unwrap_or_default();
    (status, body)
}

pub(super) fn usage_failure_is_canceled(status: u16, body: &str) -> bool {
    if status == 499 {
        return true;
    }
    let body = body.to_ascii_lowercase();
    body.contains("context canceled") || body.contains("client closed request")
}

pub(super) fn default_usage_generate() -> bool {
    true
}

pub(super) fn record_local_hour(record: &UsageRecord) -> String {
    local_hour_from_timestamp(&record.timestamp)
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d-%H").to_string())
}

pub(super) fn local_hour_from_timestamp(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value).ok().map(|timestamp| {
        timestamp
            .with_timezone(&Local)
            .format("%Y-%m-%d-%H")
            .to_string()
    })
}

pub(super) fn record_timestamp_millis(record: &UsageRecord) -> i64 {
    parse_timestamp_millis(&record.timestamp).unwrap_or(0)
}

pub(super) fn parse_timestamp_millis(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

pub(super) fn to_sql_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

pub(super) fn from_sql_i64(value: i64) -> u64 {
    value.max(0) as u64
}

pub(super) fn unique_file_stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0)
}

pub(super) fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(|value| match value {
            Value::String(value) => Some(value.trim().to_string()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
        .filter(|value| !value.is_empty())
}

pub(super) fn u64_field(object: &serde_json::Map<String, Value>, key: &str) -> u64 {
    optional_u64_field(object, key).unwrap_or(0)
}

pub(super) fn optional_u64_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<u64> {
    object.get(key).and_then(|value| {
        value.as_u64().or_else(|| {
            value
                .as_i64()
                .map(|number| number.max(0) as u64)
                .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
        })
    })
}

pub(super) fn token_u64(object: Option<&serde_json::Map<String, Value>>, key: &str) -> u64 {
    object.map(|object| u64_field(object, key)).unwrap_or(0)
}

pub(super) fn token_was_negative(object: Option<&serde_json::Map<String, Value>>, key: &str) -> bool {
    object
        .and_then(|object| object.get(key))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
        })
        .is_some_and(|value| value < 0)
}

pub(super) fn hash_text(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(super) fn mask_api_key(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    if value.chars().count() <= 8 {
        return format!("{}••••", value.chars().take(2).collect::<String>());
    }
    let start = value.chars().take(4).collect::<String>();
    let end = value
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("{start}••••{end}")
}

pub(super) fn usage_api_key_labels(config: &GuiConfigFile) -> HashMap<String, (String, String)> {
    config
        .api_keys
        .iter()
        .map(|entry| {
            (
                hash_text(&entry.key),
                (entry.remark.trim().to_string(), mask_api_key(&entry.key)),
            )
        })
        .collect()
}

pub(super) fn api_key_category_label(remark: String, display: String) -> String {
    if !remark.is_empty() {
        remark
    } else if !display.is_empty() {
        mask_api_key(&display)
    } else {
        "Unrecorded key".to_string()
    }
}

pub(super) fn usage_source_display(config: &GuiConfigFile, provider: &str, source: &str) -> String {
    let source = source.trim();
    if source.is_empty() {
        return "Unknown source".to_string();
    }
    if let Some(remark) = config.api_access_remark_for_source(provider, source) {
        return remark.to_string();
    }
    if usage_source_looks_like_key(source) {
        mask_api_key(source)
    } else {
        source.to_string()
    }
}

pub(super) fn usage_source_looks_like_key(source: &str) -> bool {
    let source = source.trim();
    !source.contains('@')
        && !source.chars().any(char::is_whitespace)
        && (source.starts_with("sk-")
            || source.starts_with("AIza")
            || source.starts_with("key-")
            || source.chars().count() >= 48)
}

/// Safe API/CSV representation that preserves stable grouping without exposing the key.
pub(super) fn usage_source_api_value(
    source: &str,
    api_key_hash: &str,
    config: &GuiConfigFile,
) -> String {
    let normalized = source.trim();
    if normalized.is_empty() {
        return source.to_string();
    }
    let is_key = usage_source_looks_like_key(normalized)
        || (!api_key_hash.is_empty() && hash_text(normalized) == api_key_hash)
        || config.api_keys.iter().any(|entry| entry.key == normalized);
    if !is_key {
        return source.to_string();
    }
    let hash = hash_text(normalized);
    format!("{} · #{}", mask_api_key(normalized), &hash[..8])
}
