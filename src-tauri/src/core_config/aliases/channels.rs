use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct OAuthAliasChannel {
    pub(crate) key: &'static str,
    pub(crate) provider: &'static str,
    pub(crate) kind: &'static str,
    pub(crate) protocol: &'static str,
    pub(crate) supports_reasoning: bool,
    pub(crate) supports_fast: bool,
    pub(crate) force_mapping: bool,
}

pub(crate) const OAUTH_ALIAS_CHANNELS: [OAuthAliasChannel; 9] = [
    OAuthAliasChannel {
        key: "vertex",
        provider: "Vertex OAuth",
        kind: "vertex-oauth",
        protocol: "gemini",
        supports_reasoning: true,
        supports_fast: false,
        force_mapping: false,
    },
    OAuthAliasChannel {
        key: "aistudio",
        provider: "AI Studio OAuth",
        kind: "aistudio-oauth",
        protocol: "gemini",
        supports_reasoning: true,
        supports_fast: false,
        force_mapping: false,
    },
    OAuthAliasChannel {
        key: "antigravity",
        provider: "Antigravity OAuth",
        kind: "antigravity-oauth",
        protocol: "antigravity",
        supports_reasoning: true,
        supports_fast: false,
        force_mapping: true,
    },
    OAuthAliasChannel {
        key: "claude",
        provider: "Claude OAuth",
        kind: "claude-oauth",
        protocol: "claude",
        supports_reasoning: true,
        supports_fast: false,
        force_mapping: false,
    },
    OAuthAliasChannel {
        key: "codex",
        provider: "Codex OAuth",
        kind: "codex-oauth",
        protocol: "codex",
        supports_reasoning: true,
        supports_fast: true,
        force_mapping: false,
    },
    OAuthAliasChannel {
        key: "kimi",
        provider: "Kimi OAuth",
        kind: "kimi-oauth",
        protocol: "openai",
        supports_reasoning: true,
        supports_fast: false,
        force_mapping: false,
    },
    OAuthAliasChannel {
        key: "devin",
        provider: "Devin OAuth",
        kind: "devin-oauth",
        protocol: "interactions",
        supports_reasoning: false,
        supports_fast: false,
        force_mapping: false,
    },
    OAuthAliasChannel {
        key: "xai",
        provider: "xAI OAuth",
        kind: "xai-oauth",
        protocol: "codex",
        supports_reasoning: true,
        supports_fast: false,
        force_mapping: false,
    },
    OAuthAliasChannel {
        key: "meta",
        provider: "Meta OAuth",
        kind: "meta-oauth",
        protocol: "openai",
        supports_reasoning: false,
        supports_fast: false,
        force_mapping: false,
    },
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OAuthModelDefinitions {
    pub(crate) channel: OAuthAliasChannel,
    pub(crate) models: Vec<CodexModelDefinition>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AliasSourceCapability {
    Base,
    Reasoning,
    Fast,
}

pub(crate) fn oauth_alias_channel(channel: &str) -> Option<OAuthAliasChannel> {
    OAUTH_ALIAS_CHANNELS
        .iter()
        .copied()
        .find(|candidate| candidate.key.eq_ignore_ascii_case(channel))
}

pub(crate) fn oauth_alias_channel_details(channel: &str) -> (String, String, String) {
    oauth_alias_channel(channel)
        .map(|details| {
            (
                details.provider.to_string(),
                details.kind.to_string(),
                details.protocol.to_string(),
            )
        })
        .unwrap_or_else(|| {
            let channel = channel.trim().to_ascii_lowercase();
            (
                format!("{channel} OAuth"),
                format!("{channel}-oauth"),
                channel,
            )
        })
}

pub(crate) fn normalize_oauth_alias_channel(value: &str) -> Option<&'static str> {
    let value = value.trim().to_ascii_lowercase().replace('_', "-");
    match value.as_str() {
        "vertex" | "vertex-ai" => Some("vertex"),
        "aistudio" | "ai-studio" | "gemini" | "gemini-cli" => Some("aistudio"),
        "antigravity" | "anti-gravity" => Some("antigravity"),
        "claude" | "anthropic" => Some("claude"),
        "codex" => Some("codex"),
        "kimi" | "moonshot" => Some("kimi"),
        "devin" | "cognition" => Some("devin"),
        "xai" | "x-ai" | "grok" => Some("xai"),
        "meta" | "muse" => Some("meta"),
        _ => None,
    }
}

pub(crate) async fn fetch_active_oauth_alias_channels(
    config: &GuiConfigFile,
) -> Result<std::collections::HashSet<String>, String> {
    let client = management_api::management_http_client_for(config)?;
    let response = client
        .get(management_endpoint(config, "credentials")?)
        .header("Authorization", management_authorization(config)?)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format_management_request_error("Failed to read OAuth credential sources", &error))?;
    let payload = read_management_value(response).await?;
    let files = payload
        .get("files")
        .and_then(serde_json::Value::as_array)
        .or_else(|| payload.as_array())
        .ok_or_else(|| "OAuth credential source response is missing a files array".to_string())?;
    Ok(files
        .iter()
        .filter(|file| {
            !file
                .get("disabled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
                && !file
                    .get("unavailable")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false)
        })
        .filter_map(|file| {
            ["provider", "type"]
                .into_iter()
                .find_map(|key| {
                    file.get(key)
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                })
                .and_then(normalize_oauth_alias_channel)
        })
        .map(str::to_string)
        .collect())
}
