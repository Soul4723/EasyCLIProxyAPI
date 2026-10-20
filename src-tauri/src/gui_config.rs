use super::*;

pub(crate) fn normalize_app_locale(locale: &str) -> &'static str {
    let normalized = locale.trim().to_ascii_lowercase();
    if normalized.starts_with("ja") {
        "ja"
    } else if normalized == "zh-tw"
        || normalized == "zh-hk"
        || normalized == "zh-mo"
        || normalized.starts_with("zh-hant")
    {
        "zh-TW"
    } else if normalized.starts_with("zh") {
        "zh-CN"
    } else {
        "en"
    }
}

pub(crate) struct GuiConfigState {
    pub(crate) inner: Mutex<GuiConfigFile>,
    pub(crate) target_operation: std::sync::Arc<tokio::sync::Mutex<()>>,
    pub(crate) oauth_sessions: Mutex<HashMap<String, u64>>,
    #[cfg(test)]
    pub(crate) persistence_path: Option<PathBuf>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub(crate) struct GuiConfigFile {
    #[serde(skip)]
    pub(crate) target_revision: u64,
    #[serde(default)]
    pub(crate) connection_mode: CoreConnectionMode,
    #[serde(default)]
    pub(crate) remote_management_origin: String,
    #[serde(default)]
    pub(crate) remote_management_key: String,
    #[serde(default)]
    pub(crate) remote_client_origin: String,
    #[serde(default)]
    pub(crate) remote_client_key: String,
    pub(crate) locale: String,
    pub(crate) port: u16,
    pub(crate) allow_lan: bool,
    pub(crate) host: String,
    pub(crate) run_on_startup: bool,
    pub(crate) start_core_on_launch: bool,
    pub(crate) silent_start: bool,
    pub(crate) close_behavior: WindowsCloseBehavior,
    pub(crate) default_terminal: String,
    pub(crate) window_width: Option<u32>,
    pub(crate) window_height: Option<u32>,
    pub(crate) window_x: Option<i32>,
    pub(crate) window_y: Option<i32>,
    pub(crate) auth_dir: String,
    pub(crate) auth_dir_user_selected: bool,
    pub(crate) image_generation_user_selected: bool,
    #[serde(deserialize_with = "deserialize_gui_api_keys")]
    pub(crate) api_keys: Vec<GuiApiKeyEntry>,
    pub(crate) api_access_remarks: Vec<GuiApiAccessRemark>,
    pub(crate) management_secret_key: String,
    pub(crate) debug: bool,
    pub(crate) commercial_mode: bool,
    pub(crate) logging_to_file: bool,
    pub(crate) logs_max_total_size_mb: u32,
    pub(crate) error_logs_max_files: u32,
    pub(crate) usage_statistics_enabled: bool,
    #[serde(rename = "usage_statistics_disabled", skip_serializing_if = "Option::is_none")]
    pub(crate) usage_statistics_disabled: Option<bool>,
    pub(crate) redis_usage_queue_retention_seconds: u32,
    pub(crate) request_log: bool,
    pub(crate) plugins_enabled: bool,
    pub(crate) routing_strategy: String,
    pub(crate) proxy_url: String,
    pub(crate) proxy_override: bool,
    pub(crate) download_source: VersionDownloadSource,
    pub(crate) custom_download_mirrors: Vec<String>,
    pub(crate) active_custom_download_mirror: String,
    pub(crate) prefer_gitcode_downloads: bool,
    /// Explicit opt-in to fall back to mirrors when the selected source fails.
    pub(crate) allow_mirror_fallback: bool,
    pub(crate) routing_session_affinity: bool,
    pub(crate) routing_session_affinity_ttl: String,
    pub(crate) disable_cooling: bool,
    pub(crate) request_retry: u32,
    pub(crate) max_retry_credentials: u32,
    pub(crate) max_retry_interval: i64,
    pub(crate) streaming_bootstrap_retries: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CoreConnectionMode {
    #[default]
    Local,
    Remote,
}

impl CoreConnectionMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Remote => "remote",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum VersionDownloadSource {
    #[default]
    Github,
    Gitcode,
    GhProxy,
    GhFast,
    Custom,
}

impl VersionDownloadSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitcode => "gitcode",
            Self::GhProxy => "gh-proxy",
            Self::GhFast => "gh-fast",
            Self::Custom => "custom",
        }
    }

    pub(crate) fn from_str(value: &str) -> Option<Self> {
        match value.trim() {
            "github" => Some(Self::Github),
            "gitcode" => Some(Self::Gitcode),
            "gh-proxy" => Some(Self::GhProxy),
            "gh-fast" => Some(Self::GhFast),
            "custom" => Some(Self::Custom),
            _ => None,
        }
    }

    pub(crate) fn display_name(self) -> &'static str {
        match self {
            Self::Github => "GitHub",
            Self::Gitcode => "GitCode",
            Self::GhProxy => "gh-proxy.com",
            Self::GhFast => "ghfast.top",
            Self::Custom => "Custom mirror",
        }
    }

    pub(crate) fn github_proxy_prefix(self) -> Option<&'static str> {
        match self {
            Self::GhProxy => Some("https://gh-proxy.com/"),
            Self::GhFast => Some("https://ghfast.top/"),
            Self::Custom => None,
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VersionDownloadCandidate {
    pub(crate) source: VersionDownloadSource,
    pub(crate) custom_url: Option<String>,
}

impl VersionDownloadCandidate {
    pub(crate) fn builtin(source: VersionDownloadSource) -> Self {
        Self {
            source,
            custom_url: None,
        }
    }

    pub(crate) fn custom(url: &str) -> Self {
        Self {
            source: VersionDownloadSource::Custom,
            custom_url: Some(url.to_string()),
        }
    }

    pub(crate) fn key(&self) -> String {
        self.custom_url
            .as_ref()
            .map(|url| format!("custom:{url}"))
            .unwrap_or_else(|| self.source.as_str().to_string())
    }

    pub(crate) fn display_name(&self) -> String {
        self.custom_url
            .as_ref()
            .and_then(|url| reqwest::Url::parse(url).ok())
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_else(|| self.source.display_name().to_string())
    }

    pub(crate) fn proxy_prefix(&self) -> Option<&str> {
        self.custom_url
            .as_deref()
            .or_else(|| self.source.github_proxy_prefix())
    }
}

pub(crate) fn version_source_url(source: &VersionDownloadCandidate, github_url: &str) -> String {
    source
        .proxy_prefix()
        .map(|prefix| format!("{prefix}{github_url}"))
        .unwrap_or_else(|| github_url.to_string())
}

/// Sources to try, in order: the one the user selected, then GitHub. Other mirrors
/// are tried only when the user has opted in to mirror fallback.
pub(crate) fn version_download_source_candidates(
    preferred: VersionDownloadCandidate,
    gitcode_available: bool,
    custom_mirrors: &[String],
    allow_mirror_fallback: bool,
) -> Vec<VersionDownloadCandidate> {
    let mut candidates = vec![
        preferred,
        VersionDownloadCandidate::builtin(VersionDownloadSource::Github),
    ];
    if allow_mirror_fallback {
        candidates.extend([
            VersionDownloadCandidate::builtin(VersionDownloadSource::Gitcode),
            VersionDownloadCandidate::builtin(VersionDownloadSource::GhProxy),
            VersionDownloadCandidate::builtin(VersionDownloadSource::GhFast),
        ]);
        candidates.extend(
            custom_mirrors
                .iter()
                .map(|url| VersionDownloadCandidate::custom(url)),
        );
    }
    candidates.retain(|candidate| {
        gitcode_available || candidate.source != VersionDownloadSource::Gitcode
    });
    candidates
        .into_iter()
        .fold(Vec::new(), |mut sources, source| {
            if !sources.contains(&source) {
                sources.push(source);
            }
            sources
        })
}

pub(crate) fn normalize_custom_download_mirror_url(value: &str) -> Result<String, String> {
    let mut url =
        reqwest::Url::parse(value.trim()).map_err(|error| format!("Invalid mirror URL: {error}"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Mirror URL must be an HTTPS URL without authentication, port, query parameters, or fragment".to_string());
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url.to_string())
}

impl GuiConfigFile {
    pub(crate) fn selected_download_candidate(&self) -> VersionDownloadCandidate {
        if self.download_source == VersionDownloadSource::Custom
            && self
                .custom_download_mirrors
                .contains(&self.active_custom_download_mirror)
        {
            VersionDownloadCandidate::custom(&self.active_custom_download_mirror)
        } else {
            VersionDownloadCandidate::builtin(self.download_source)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WindowsCloseAction {
    Exit,
    MinimizeToTray,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WindowsCloseBehavior {
    #[default]
    Ask,
    Exit,
    MinimizeToTray,
}

impl WindowsCloseBehavior {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Exit => "exit",
            Self::MinimizeToTray => "minimize-to-tray",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct GuiApiKeyEntry {
    pub(crate) key: String,
    #[serde(default)]
    pub(crate) remark: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct GuiApiAccessRemark {
    pub(crate) provider_section: String,
    pub(crate) api_key_hash: String,
    #[serde(default)]
    pub(crate) record_hash: String,
    pub(crate) remark: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiAccessRemarkLocator {
    pub(crate) provider_name: String,
    pub(crate) base_url: String,
    pub(crate) api_keys: Vec<String>,
    #[serde(default)]
    pub(crate) config_identity: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiAccessRemarkQuery {
    pub(crate) provider_section: String,
    #[serde(flatten)]
    pub(crate) locator: ApiAccessRemarkLocator,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiAccessRemarkUpdate {
    pub(crate) provider_section: String,
    pub(crate) previous_records: Vec<ApiAccessRemarkLocator>,
    pub(crate) records: Vec<ApiAccessRemarkLocator>,
    pub(crate) all_records: Vec<ApiAccessRemarkLocator>,
    pub(crate) remark: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum GuiApiKeyInput {
    Legacy(String),
    Entry(GuiApiKeyEntry),
}

pub(crate) fn deserialize_gui_api_keys<'de, D>(deserializer: D) -> Result<Vec<GuiApiKeyEntry>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries = Vec::<GuiApiKeyInput>::deserialize(deserializer)?;
    Ok(entries
        .into_iter()
        .map(|entry| match entry {
            GuiApiKeyInput::Legacy(key) => GuiApiKeyEntry {
                remark: String::new(),
                key,
            },
            GuiApiKeyInput::Entry(entry) => entry,
        })
        .collect())
}

impl Default for GuiConfigFile {
    fn default() -> Self {
        Self {
            target_revision: 0,
            connection_mode: CoreConnectionMode::Local,
            remote_management_origin: String::new(),
            remote_management_key: String::new(),
            remote_client_origin: String::new(),
            remote_client_key: String::new(),

            locale: "en".to_string(),
            port: 8317,
            allow_lan: false,
            host: "127.0.0.1".to_string(),
            run_on_startup: false,
            start_core_on_launch: true,
            silent_start: false,
            close_behavior: WindowsCloseBehavior::Ask,
            default_terminal: DEFAULT_AGENT_TERMINAL.to_string(),
            window_width: Some(DEFAULT_MAIN_WINDOW_WIDTH),
            window_height: Some(DEFAULT_MAIN_WINDOW_HEIGHT),
            window_x: None,
            window_y: None,
            auth_dir: DEFAULT_AUTH_DIR.to_string(),
            auth_dir_user_selected: false,
            image_generation_user_selected: false,
            api_keys: vec![default_api_key_entry()],
            api_access_remarks: Vec::new(),
            management_secret_key: LEGACY_DEFAULT_MANAGEMENT_SECRET_KEY.to_string(),
            debug: false,
            commercial_mode: false,
            logging_to_file: false,
            logs_max_total_size_mb: DEFAULT_LOGS_MAX_TOTAL_SIZE_MB,
            error_logs_max_files: DEFAULT_ERROR_LOGS_MAX_FILES,
            usage_statistics_enabled: true,
            usage_statistics_disabled: None,
            redis_usage_queue_retention_seconds: DEFAULT_REDIS_USAGE_QUEUE_RETENTION_SECONDS,
            request_log: false,
            plugins_enabled: false,
            routing_strategy: "round-robin".to_string(),
            proxy_url: String::new(),
            proxy_override: false,
            download_source: VersionDownloadSource::Github,
            custom_download_mirrors: Vec::new(),
            active_custom_download_mirror: String::new(),
            prefer_gitcode_downloads: false,
            allow_mirror_fallback: false,
            routing_session_affinity: false,
            routing_session_affinity_ttl: String::new(),
            disable_cooling: DEFAULT_DISABLE_COOLING,
            request_retry: DEFAULT_REQUEST_RETRY,
            max_retry_credentials: DEFAULT_MAX_RETRY_CREDENTIALS,
            max_retry_interval: DEFAULT_MAX_RETRY_INTERVAL,
            streaming_bootstrap_retries: DEFAULT_STREAMING_BOOTSTRAP_RETRIES,
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
pub(crate) struct GuiConfigPresence {
    pub(crate) connection_mode: Option<CoreConnectionMode>,
    pub(crate) remote_management_origin: Option<String>,
    pub(crate) remote_management_key: Option<String>,
    pub(crate) remote_client_origin: Option<String>,
    pub(crate) remote_client_key: Option<String>,
    pub(crate) locale: Option<String>,
    pub(crate) port: Option<u16>,
    pub(crate) allow_lan: Option<bool>,
    pub(crate) host: Option<String>,
    pub(crate) auth_dir: Option<String>,
    pub(crate) api_keys: Option<Vec<GuiApiKeyInput>>,
    pub(crate) api_access_remarks: Option<Vec<GuiApiAccessRemark>>,
    pub(crate) management_secret_key: Option<String>,
    pub(crate) close_behavior: Option<WindowsCloseBehavior>,
    pub(crate) default_terminal: Option<String>,
    pub(crate) start_core_on_launch: Option<bool>,
    pub(crate) silent_start: Option<bool>,
    pub(crate) debug: Option<bool>,
    pub(crate) commercial_mode: Option<bool>,
    pub(crate) logging_to_file: Option<bool>,
    pub(crate) logs_max_total_size_mb: Option<u32>,
    pub(crate) error_logs_max_files: Option<u32>,
    pub(crate) usage_statistics_enabled: Option<bool>,
    pub(crate) redis_usage_queue_retention_seconds: Option<u32>,
    pub(crate) request_log: Option<bool>,
    pub(crate) plugins_enabled: Option<bool>,
    pub(crate) routing_strategy: Option<String>,
    pub(crate) proxy_url: Option<String>,
    pub(crate) proxy_override: Option<bool>,
    pub(crate) download_source: Option<VersionDownloadSource>,
    pub(crate) custom_download_mirrors: Option<Vec<String>>,
    pub(crate) active_custom_download_mirror: Option<String>,
    pub(crate) prefer_gitcode_downloads: Option<bool>,
    pub(crate) allow_mirror_fallback: Option<bool>,
    pub(crate) routing_session_affinity: Option<bool>,
    pub(crate) routing_session_affinity_ttl: Option<String>,
    pub(crate) disable_cooling: Option<bool>,
    pub(crate) request_retry: Option<u32>,
    pub(crate) max_retry_credentials: Option<u32>,
    pub(crate) max_retry_interval: Option<i64>,
    pub(crate) streaming_bootstrap_retries: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuiSettings {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) allow_lan: bool,
    pub(crate) run_on_startup: bool,
    pub(crate) close_behavior: WindowsCloseBehavior,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VersionSourceSettings {
    pub(crate) source: String,
    pub(crate) gitcode_available: bool,
    pub(crate) custom_mirrors: Vec<String>,
    pub(crate) mirror_fallback: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SoftwareSettings {
    pub(crate) close_behavior: WindowsCloseBehavior,
    pub(crate) autostart_enabled: bool,
    pub(crate) start_core_on_launch: bool,
    pub(crate) silent_start_enabled: bool,
    pub(crate) default_terminal: String,
    pub(crate) available_terminals: Vec<AgentTerminalOption>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SoftwareSettingsInput {
    pub(crate) close_behavior: WindowsCloseBehavior,
    pub(crate) autostart_enabled: bool,
    pub(crate) start_core_on_launch: bool,
    pub(crate) silent_start_enabled: bool,
    pub(crate) default_terminal: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuiNetworkSettings {
    pub(crate) port: u16,
    pub(crate) allow_lan: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuiNetworkRoutingSettings {
    pub(crate) port: u16,
    pub(crate) allow_lan: bool,
    pub(crate) routing_session_affinity: bool,
    pub(crate) routing_session_affinity_ttl: String,
    #[serde(default)]
    pub(crate) disable_cooling: bool,
    pub(crate) request_retry: u32,
    pub(crate) max_retry_credentials: u32,
    pub(crate) max_retry_interval: i64,
    pub(crate) streaming_bootstrap_retries: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuiNetworkEndpointSettings {
    pub(crate) host: String,
    pub(crate) port: u16,
    #[serde(default)]
    pub(crate) proxy_url: Option<String>,
    #[serde(default)]
    pub(crate) proxy_override: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuiRetrySettings {
    #[serde(default)]
    pub(crate) disable_cooling: bool,
    pub(crate) request_retry: u32,
    pub(crate) max_retry_credentials: u32,
    pub(crate) max_retry_interval: i64,
    pub(crate) streaming_bootstrap_retries: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuiSessionRoutingSettings {
    pub(crate) routing_session_affinity: bool,
    pub(crate) routing_session_affinity_ttl: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreTlsSettings {
    pub(crate) enabled: bool,
    pub(crate) cert: String,
    pub(crate) key: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreSensitiveWordsSettings {
    pub(crate) antigravity_sensitive_words: Vec<String>,
    pub(crate) devin_sensitive_words: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreLoggingSettingsInput {
    pub(crate) debug: bool,
    pub(crate) commercial_mode: bool,
    pub(crate) logging_to_file: bool,
    pub(crate) logs_max_total_size_mb: u32,
    pub(crate) error_logs_max_files: u32,
    pub(crate) usage_statistics_enabled: bool,
    pub(crate) redis_usage_queue_retention_seconds: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreConfigSettings {
    #[serde(skip_serializing)]
    pub(crate) host: String,
    #[serde(skip_serializing)]
    pub(crate) port: u16,
    #[serde(skip_serializing)]
    pub(crate) auth_dir: String,
    pub(crate) api_keys: Vec<String>,
    pub(crate) management_secret_configured: bool,
    pub(crate) debug: bool,
    pub(crate) commercial_mode: bool,
    pub(crate) logging_to_file: bool,
    pub(crate) logs_max_total_size_mb: u32,
    pub(crate) error_logs_max_files: u32,
    pub(crate) usage_statistics_enabled: bool,
    pub(crate) redis_usage_queue_retention_seconds: u32,
    pub(crate) request_log: bool,
    pub(crate) plugins_enabled: bool,
    pub(crate) routing_strategy: String,
    pub(crate) proxy_url: String,
    pub(crate) routing_session_affinity: bool,
    pub(crate) routing_session_affinity_ttl: String,
    pub(crate) disable_cooling: bool,
    pub(crate) request_retry: u32,
    pub(crate) max_retry_credentials: u32,
    pub(crate) max_retry_interval: i64,
    pub(crate) streaming_bootstrap_retries: u32,
    #[allow(dead_code)]
    #[serde(skip_serializing)]
    pub(crate) management_secret_key: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreApiKeyView {
    pub(crate) api_key: String,
    pub(crate) remark: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreConfigView {
    pub(crate) host: String,
    pub(crate) api_keys: Vec<CoreApiKeyView>,
    pub(crate) management_secret_configured: bool,
    pub(crate) port: u16,
    pub(crate) allow_lan: bool,
    pub(crate) debug: bool,
    pub(crate) commercial_mode: bool,
    pub(crate) logging_to_file: bool,
    pub(crate) logs_max_total_size_mb: u32,
    pub(crate) error_logs_max_files: u32,
    pub(crate) usage_statistics_enabled: bool,
    pub(crate) redis_usage_queue_retention_seconds: u32,
    pub(crate) request_log: bool,
    pub(crate) plugins_enabled: bool,
    pub(crate) routing_strategy: String,
    pub(crate) proxy_url: String,
    pub(crate) proxy_override: bool,
    pub(crate) routing_session_affinity: bool,
    pub(crate) routing_session_affinity_ttl: String,
    pub(crate) disable_cooling: bool,
    pub(crate) request_retry: u32,
    pub(crate) max_retry_credentials: u32,
    pub(crate) max_retry_interval: i64,
    pub(crate) streaming_bootstrap_retries: u32,
}

impl GuiConfigState {
    pub(crate) fn new(config: GuiConfigFile) -> Self {
        Self {
            inner: Mutex::new(config),
            target_operation: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            oauth_sessions: Mutex::new(HashMap::new()),
            #[cfg(test)]
            persistence_path: None,
        }
    }

    pub(crate) fn snapshot(&self) -> Result<GuiConfigFile, String> {
        self.inner
            .lock()
            .map(|config| config.clone())
            .map_err(|_| "GUI configuration status lock is poisoned".to_string())
    }

    // Fencing rejects calls from a stale document after a core-target switch.
    // See docs/remote-core.md, “Fencing and revision semantics”.
    pub(crate) fn ensure_revision(&self, expected_revision: u64) -> Result<(), String> {
        if self.snapshot()?.target_revision != expected_revision {
            return Err("The core connection changed; request cancelled".to_string());
        }
        Ok(())
    }

    pub(crate) fn ensure_target(&self, expected: &GuiConfigFile) -> Result<(), String> {
        let current = self.snapshot()?;
        if current.target_revision != expected.target_revision {
            return Err("Core connection changed; discard the previous target response".to_string());
        }
        Ok(())
    }

    // Acquire in the blocking worker, not its awaiter: cancellation must not
    // release the fence while an accepted filesystem/process write is running.
    pub(crate) fn blocking_client_target_operation(&self, expected: &GuiConfigFile) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
        let guard = self.blocking_target_operation(expected)?;
        expected.validate_client_origin()?;
        Ok(guard)
    }

    pub(crate) fn blocking_target_operation(&self, expected: &GuiConfigFile) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
        let guard = self.target_operation.blocking_lock();
        self.ensure_target(expected)?;
        Ok(guard)
    }

    pub(crate) fn blocking_local_target_operation(&self, expected: &GuiConfigFile) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
        let guard = self.blocking_target_operation(expected)?;
        crate::core_connection::require_local(&self.snapshot()?)?;
        Ok(guard)
    }

    pub(crate) fn replace_external(&self, mut config: GuiConfigFile) -> Result<bool, String> {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "GUI configuration status lock is poisoned".to_string())?;
        let changed = core_connection::target_changed(&current, &config);
        config.target_revision = current.target_revision.wrapping_add(u64::from(changed));
        *current = config;
        Ok(changed)
    }

    pub(crate) fn replace_core_settings_external(
        &self,
        settings: &CoreConfigSettings,
    ) -> Result<GuiConfigFile, String> {
        crate::core_connection::require_local(&self.snapshot()?)?;
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "GUI configuration status lock is poisoned".to_string())?;
        let mut config = current.clone();
        apply_core_settings_to_gui_config(&mut config, settings);
        apply_external_core_proxy_override(&mut config, settings)?;
        sanitize_gui_config(&mut config)?;
        validate_gui_config(&config)?;
        *current = config.clone();
        Ok(config)
    }

    pub(crate) fn update_network(&self, port: u16, allow_lan: bool) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.port = port;
            config.allow_lan = allow_lan;
            config.host = if allow_lan { "0.0.0.0" } else { "127.0.0.1" }.to_string();
            Ok(())
        })
    }

    pub(crate) fn update_network_routing(&self, settings: &GuiConfigFile) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.port = settings.port;
            config.allow_lan = settings.allow_lan;
            config.host = settings.host.clone();
            config.proxy_url = settings.proxy_url.clone();
            config.routing_session_affinity = settings.routing_session_affinity;
            config.routing_session_affinity_ttl = settings.routing_session_affinity_ttl.clone();
            config.disable_cooling = settings.disable_cooling;
            config.request_retry = settings.request_retry;
            config.max_retry_credentials = settings.max_retry_credentials;
            config.max_retry_interval = settings.max_retry_interval;
            config.streaming_bootstrap_retries = settings.streaming_bootstrap_retries;
            Ok(())
        })
    }

    pub(crate) fn update_network_endpoint(&self, settings: &GuiConfigFile) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.host = settings.host.clone();
            config.allow_lan = settings.allow_lan;
            config.port = settings.port;
            config.proxy_url = settings.proxy_url.clone();
            config.proxy_override = settings.proxy_override;
            Ok(())
        })
    }

    pub(crate) fn update_retry_settings(&self, settings: &GuiConfigFile) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.disable_cooling = settings.disable_cooling;
            config.request_retry = settings.request_retry;
            config.max_retry_credentials = settings.max_retry_credentials;
            config.max_retry_interval = settings.max_retry_interval;
            config.streaming_bootstrap_retries = settings.streaming_bootstrap_retries;
            Ok(())
        })
    }

    pub(crate) fn update_session_routing(&self, settings: &GuiConfigFile) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.routing_session_affinity = settings.routing_session_affinity;
            config.routing_session_affinity_ttl = settings.routing_session_affinity_ttl.clone();
            Ok(())
        })
    }

    pub(crate) fn set_run_on_startup(&self, run_on_startup: bool) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.run_on_startup = run_on_startup;
            Ok(())
        })
    }

    pub(crate) fn set_close_behavior(
        &self,
        close_behavior: WindowsCloseBehavior,
    ) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.close_behavior = close_behavior;
            Ok(())
        })
    }

    pub(crate) fn set_software_preferences(
        &self,
        close_behavior: WindowsCloseBehavior,
        start_core_on_launch: bool,
        silent_start: bool,
        default_terminal: String,
    ) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.close_behavior = close_behavior;
            config.start_core_on_launch = start_core_on_launch;
            config.silent_start = silent_start;
            config.default_terminal = normalize_agent_terminal(&default_terminal);
            Ok(())
        })
    }

    pub(crate) fn set_locale(&self, locale: String) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.locale = normalize_app_locale(&locale).to_string();
            Ok(())
        })
    }

    pub(crate) fn set_download_candidate(
        &self,
        candidate: VersionDownloadCandidate,
    ) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            if let Some(url) = &candidate.custom_url {
                if !config.custom_download_mirrors.contains(url) {
                    return Err("Custom mirror does not exist".to_string());
                }
                config.active_custom_download_mirror = url.clone();
            }
            config.download_source = candidate.source;
            config.prefer_gitcode_downloads = candidate.source == VersionDownloadSource::Gitcode;
            Ok(())
        })
    }

    pub(crate) fn set_mirror_fallback(&self, enabled: bool) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.allow_mirror_fallback = enabled;
            Ok(())
        })
    }

    pub(crate) fn set_window_geometry(
        &self,
        size: SavedWindowSize,
        position: Option<tauri::PhysicalPosition<i32>>,
    ) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.window_width = Some(size.width);
            config.window_height = Some(size.height);
            config.window_x = position.map(|position| position.x);
            config.window_y = position.map(|position| position.y);
            Ok(())
        })
    }

    pub(crate) fn set_management_secret_key(&self, secret_key: String) -> Result<GuiConfigFile, String> {
        self.update(|config| {
            config.management_secret_key = secret_key;
            Ok(())
        })
    }

    pub(crate) fn sync_core_settings(&self, settings: &CoreConfigSettings) -> Result<GuiConfigFile, String> {
        self.sync_core_settings_internal(settings, None, false, false)
    }

    pub(crate) fn sync_core_logging_settings(&self, settings: &CoreConfigSettings) -> Result<GuiConfigFile, String> {
        self.sync_core_settings_internal(settings, None, false, true)
    }

    pub(crate) fn sync_core_settings_external(
        &self,
        settings: &CoreConfigSettings,
    ) -> Result<GuiConfigFile, String> {
        self.sync_core_settings_internal(settings, None, true, false)
    }

    pub(crate) fn sync_core_settings_with_api_key(
        &self,
        settings: &CoreConfigSettings,
        added_api_key: Option<GuiApiKeyEntry>,
    ) -> Result<GuiConfigFile, String> {
        self.sync_core_settings_internal(settings, added_api_key, false, false)
    }

    pub(crate) fn sync_core_settings_internal(
        &self,
        settings: &CoreConfigSettings,
        added_api_key: Option<GuiApiKeyEntry>,
        apply_external_proxy: bool,
        save_usage_preference: bool,
    ) -> Result<GuiConfigFile, String> {
        crate::core_connection::require_local(&self.snapshot()?)?;
        self.update(|config| {
            config.api_keys = merge_core_api_keys_with_gui_metadata(
                &config.api_keys,
                &settings.api_keys,
                added_api_key.as_ref(),
            );
            config.host = settings.host.clone();
            config.port = settings.port;
            config.allow_lan = !is_loopback_host(&settings.host);
            config.auth_dir = settings.auth_dir.clone();
            config.debug = settings.debug;
            config.commercial_mode = settings.commercial_mode;
            config.logging_to_file = settings.logging_to_file;
            config.logs_max_total_size_mb = settings.logs_max_total_size_mb;
            config.error_logs_max_files = settings.error_logs_max_files;
            config.usage_statistics_enabled = settings.usage_statistics_enabled;
            if save_usage_preference {
                config.usage_statistics_disabled = (!settings.usage_statistics_enabled).then_some(true);
            }
            config.redis_usage_queue_retention_seconds =
                settings.redis_usage_queue_retention_seconds;
            config.request_log = settings.request_log;
            if let Some(secret_key) = settings
                .management_secret_key
                .as_deref()
                .filter(|secret_key| !is_hashed_management_secret_key(secret_key))
            {
                config.management_secret_key = secret_key.to_string();
            }
            config.plugins_enabled = settings.plugins_enabled;
            config.routing_strategy = settings.routing_strategy.clone();
            config.routing_session_affinity = settings.routing_session_affinity;
            config.routing_session_affinity_ttl = settings.routing_session_affinity_ttl.clone();
            config.disable_cooling = settings.disable_cooling;
            config.request_retry = settings.request_retry;
            config.max_retry_credentials = settings.max_retry_credentials;
            config.max_retry_interval = settings.max_retry_interval;
            config.streaming_bootstrap_retries = settings.streaming_bootstrap_retries;
            if apply_external_proxy {
                apply_external_core_proxy_override(config, settings)?;
            }
            Ok(())
        })
    }

    pub(crate) fn update<F>(&self, update: F) -> Result<GuiConfigFile, String>
    where
        F: FnOnce(&mut GuiConfigFile) -> Result<(), String>,
    {
        let mut current = self
            .inner
            .lock()
            .map_err(|_| "GUI configuration status lock is poisoned".to_string())?;
        let mut config = current.clone();
        update(&mut config)?;
        sanitize_gui_config(&mut config)?;
        if config == *current {
            return Ok(config);
        }
        #[cfg(test)]
        if let Some(path) = &self.persistence_path {
            write_gui_config_to_path(&config, path)?;
        } else {
            write_gui_config(&config)?;
        }
        #[cfg(not(test))]
        write_gui_config(&config)?;
        *current = config.clone();
        Ok(config)
    }
}

impl From<&GuiConfigFile> for GuiSettings {
    fn from(config: &GuiConfigFile) -> Self {
        Self {
            host: config.host.clone(),
            port: config.port,
            allow_lan: config.allow_lan,
            run_on_startup: config.run_on_startup,
            close_behavior: config.close_behavior,
        }
    }
}

impl From<&GuiConfigFile> for CoreConfigSettings {
    fn from(config: &GuiConfigFile) -> Self {
        Self {
            host: config.host.clone(),
            port: config.port,
            auth_dir: config.auth_dir.clone(),
            api_keys: gui_api_key_values(&config.api_keys),
            management_secret_configured: !config.management_secret_key.is_empty(),
            debug: config.debug,
            commercial_mode: config.commercial_mode,
            logging_to_file: config.logging_to_file,
            logs_max_total_size_mb: config.logs_max_total_size_mb,
            error_logs_max_files: config.error_logs_max_files,
            usage_statistics_enabled: config.usage_statistics_enabled,
            redis_usage_queue_retention_seconds: config.redis_usage_queue_retention_seconds,
            request_log: config.request_log,
            plugins_enabled: config.plugins_enabled,
            routing_strategy: config.routing_strategy.clone(),
            proxy_url: config.proxy_url.clone(),
            routing_session_affinity: config.routing_session_affinity,
            routing_session_affinity_ttl: config.routing_session_affinity_ttl.clone(),
            disable_cooling: config.disable_cooling,
            request_retry: config.request_retry,
            max_retry_credentials: config.max_retry_credentials,
            max_retry_interval: config.max_retry_interval,
            streaming_bootstrap_retries: config.streaming_bootstrap_retries,
            management_secret_key: Some(config.management_secret_key.clone()),
        }
    }
}

impl From<&GuiConfigFile> for CoreConfigView {
    fn from(config: &GuiConfigFile) -> Self {
        Self {
            host: config.host.clone(),
            api_keys: config
                .api_keys
                .iter()
                .map(|entry| CoreApiKeyView {
                    api_key: entry.key.clone(),
                    remark: entry.remark.clone(),
                })
                .collect(),
            management_secret_configured: !config.management_secret_key.is_empty(),
            port: config.port,
            allow_lan: config.allow_lan,
            debug: config.debug,
            commercial_mode: config.commercial_mode,
            logging_to_file: config.logging_to_file,
            logs_max_total_size_mb: config.logs_max_total_size_mb,
            error_logs_max_files: config.error_logs_max_files,
            usage_statistics_enabled: config.usage_statistics_enabled,
            redis_usage_queue_retention_seconds: config.redis_usage_queue_retention_seconds,
            request_log: config.request_log,
            plugins_enabled: config.plugins_enabled,
            routing_strategy: config.routing_strategy.clone(),
            proxy_url: config.proxy_url.clone(),
            proxy_override: config.proxy_override,
            routing_session_affinity: config.routing_session_affinity,
            routing_session_affinity_ttl: config.routing_session_affinity_ttl.clone(),
            disable_cooling: config.disable_cooling,
            request_retry: config.request_retry,
            max_retry_credentials: config.max_retry_credentials,
            max_retry_interval: config.max_retry_interval,
            streaming_bootstrap_retries: config.streaming_bootstrap_retries,
        }
    }
}
