use super::*;

#[cfg(target_os = "macos")]
pub(crate) const APP_UPDATE_MANIFEST_NAME: &str = "portable-update-darwin-v2.json";
pub(crate) const CODEX_MODEL_CATALOG_URL: &str = "https://raw.githubusercontent.com/router-for-me/EasyCLIProxyAPI/main/src-tauri/resources/codex_models/model-catalog.json";
pub(crate) const CODEX_MODEL_CATALOG_OVERRIDE_DIR: &str = "codex_models";
pub(crate) const CODEX_MODEL_CATALOG_SOURCE_FILE: &str = "model-catalog.json";
pub(crate) const MAX_CODEX_MODEL_CATALOG_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const APP_UPDATE_PROGRESS_EVENT: &str = "app-update-progress";
pub(crate) const PORTABLE_APP_MANIFEST_FILE: &str = "portable-app.json";
#[cfg(windows)]
pub(crate) const PORTABLE_APP_BINARY: &str = "EasyCLIProxyAPI.exe";
#[cfg(target_os = "linux")]
pub(crate) const PORTABLE_APP_BINARY: &str = "EasyCLIProxyAPI";
pub(crate) const CORE_INSTALL_PROGRESS_EVENT: &str = "core-install-progress";
pub(crate) const CORE_STATUS_EVENT: &str = "core-status-changed";
pub(crate) const CONFIG_FILES_CHANGED_EVENT: &str = "config-files-changed";
pub(crate) const VERSION_DOWNLOAD_SOURCE_CHANGED_EVENT: &str = "version-download-source-changed";
pub(crate) static VERSION_SOURCE_DETECTION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) const WINDOWS_CLOSE_REQUEST_EVENT: &str = "windows-close-requested";
pub(crate) const CORE_METADATA_FILE: &str = "cpa-gui-meta.json";
pub(crate) const CORE_CONFIG_FILE: &str = "config.yaml";
pub(crate) const CORE_EXAMPLE_CONFIG_FILE: &str = "config.example.yaml";
pub(crate) const CORE_VERSION_FILE: &str = "core-version.txt";
pub(crate) const CORE_CHECKSUMS_FILE: &str = "checksums.txt";
pub(crate) const GUI_CONFIG_FILE: &str = "config.toml";
pub(crate) const LEGACY_GUI_CONFIG_FILE: &str = "cpa-gui.yaml";
pub(crate) const MIN_MAIN_WINDOW_WIDTH: u32 = 640;
pub(crate) const MIN_MAIN_WINDOW_HEIGHT: u32 = 600;
pub(crate) const MAX_SAVED_WINDOW_DIMENSION: u32 = 16_384;
pub(crate) const DEFAULT_MAIN_WINDOW_WIDTH: u32 = 1280;
pub(crate) const DEFAULT_MAIN_WINDOW_HEIGHT: u32 = 800;
pub(crate) const LEGACY_DEFAULT_MAIN_WINDOW_WIDTH: u32 = 1531;
pub(crate) const LEGACY_DEFAULT_MAIN_WINDOW_HEIGHT: u32 = 891;
pub(crate) const OAUTH_DIR_NAME: &str = "oauth";
pub(crate) const DEFAULT_AUTH_DIR: &str = "../oauth";
pub(crate) const DEFAULT_API_KEY: &str = "123456";
pub(crate) const DEFAULT_AGENT_TERMINAL: &str = "auto";
pub(crate) const DEFAULT_API_KEY_INITIAL_REMARK: &str = "Default key";
pub(crate) const DEFAULT_REQUEST_RETRY: u32 = 3;
pub(crate) const DEFAULT_MAX_RETRY_CREDENTIALS: u32 = 0;
pub(crate) const DEFAULT_MAX_RETRY_INTERVAL: i64 = 30;
pub(crate) const DEFAULT_STREAMING_BOOTSTRAP_RETRIES: u32 = 0;
pub(crate) const DEFAULT_DISABLE_COOLING: bool = true;
pub(crate) const DEFAULT_LOGS_MAX_TOTAL_SIZE_MB: u32 = 0;
pub(crate) const DEFAULT_ERROR_LOGS_MAX_FILES: u32 = 10;
pub(crate) const DEFAULT_REDIS_USAGE_QUEUE_RETENTION_SECONDS: u32 = 60;
pub(crate) const LEGACY_DEFAULT_MANAGEMENT_SECRET_KEY: &str = "123456";
pub(crate) const MANAGED_AGENT_PROVIDER_ID: &str = "cpa-gui";
pub(crate) const ZCODE_PROVIDER_CONFIG_FILE: &str = "provider_config.json";
pub(crate) const KIMI_CODE_CONFIG_FILE: &str = "config.toml";
pub(crate) const GROK_BUILD_CONFIG_FILE: &str = "config.toml";
pub(crate) const DEEPSEEK_HARNESS_PROVIDER_ID: &str = "easy-cliproxyapi";
pub(crate) const DEEPSEEK_HARNESS_CREDENTIAL: &str = "EASYCLIPROXYAPI_API_KEY";
pub(crate) const DEEPSEEK_HARNESS_CREDENTIALS_VERSION: u64 = 1;
pub(crate) const DEEPSEEK_HARNESS_DEFAULT_WEB_PORT: u16 = 3080;
pub(crate) const DEEPSEEK_HARNESS_SETTINGS_FILE: &str = "settings.yaml";
pub(crate) const DEEPSEEK_HARNESS_CREDENTIALS_FILE: &str = ".credentials.yaml";
pub(crate) const PI_AGENT_ID: &str = "pi";
pub(crate) const PI_AGENT_NAME: &str = "Pi";
pub(crate) const OMP_AGENT_PROVIDER_ID: &str = "easy-cliproxyapi";
pub(crate) const OMP_AGENT_API: &str = "openai-responses";
pub(crate) const OMP_MODELS_FILE: &str = "models.yml";
pub(crate) const OMP_SETTINGS_FILE: &str = "config.yml";
pub(crate) const PI_CLIPROXYAPI_PACKAGE: &str = "npm:@router-for-me/pi-cliproxyapi-provider";
pub(crate) const PI_CLIPROXYAPI_NPM_LATEST_URL: &str =
    "https://registry.npmjs.org/@router-for-me%2Fpi-cliproxyapi-provider/latest";
pub(crate) const PI_CLIPROXYAPI_PROVIDER_ID: &str = "cliproxyapi";
pub(crate) const PI_AGENT_CONFIG_FILE: &str = "cliproxyapi.json";
pub(crate) const PI_AGENT_SETTINGS_FILE: &str = "settings.json";
pub(crate) const CODEX_MODEL_CATALOG_FILE: &str = "cpa-gui-model-catalog.json";
pub(crate) const CODEX_OAUTH_LOGIN_REQUIRED_ERROR: &str = "CODEX_OAUTH_LOGIN_REQUIRED";
pub(crate) const CLAUDE_DESKTOP_PROFILE_ID: &str = "00000000-0000-4000-8000-000000831700";
pub(crate) const CLAUDE_DESKTOP_OPUS_MODEL_ID: &str = "claude-opus-5-cpa";
pub(crate) const CLAUDE_DESKTOP_SONNET_MODEL_ID: &str = "claude-sonnet-5-cpa";
pub(crate) const CLAUDE_DESKTOP_HAIKU_MODEL_ID: &str = "claude-haiku-4-5-cpa";
pub(crate) const LEGACY_CLAUDE_DESKTOP_MODEL_IDS: [&str; 3] =
    ["claude-opus-5", "claude-sonnet-4-6", "claude-haiku-4-5"];
pub(crate) const MANAGED_CLAUDE_OPUS_ALIAS_DISPLAY_NAME: &str = "EasyCLIProxyAPI managed Claude Opus mapping";
pub(crate) const MANAGED_CLAUDE_SONNET_ALIAS_DISPLAY_NAME: &str =
    "EasyCLIProxyAPI managed Claude Sonnet mapping";
pub(crate) const MANAGED_CLAUDE_HAIKU_ALIAS_DISPLAY_NAME: &str =
    "EasyCLIProxyAPI managed Claude Haiku mapping";
pub(crate) const DEFAULT_CLAUDE_CONTEXT_WINDOW: u64 = 200_000;
pub(crate) const CLAUDE_DESKTOP_EXTENDED_CONTEXT_WINDOW: u64 = 1_000_000;
pub(crate) const CLAUDE_CODE_MAX_CONTEXT_TOKENS_ENV: &str = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
pub(crate) const CLAUDE_CODE_AUTO_COMPACT_WINDOW_ENV: &str = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
pub(crate) const CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY_ENV: &str =
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY";
pub(crate) const CLAUDE_CODE_AUTO_MODE_SERVER_ENV: &str = "CLAUDE_CODE_AUTO_MODE_SERVER";
pub(crate) const CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV: &str = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
pub(crate) const DISABLE_AUTO_COMPACT_ENV: &str = "DISABLE_AUTO_COMPACT";
pub(crate) const CLAUDE_CODE_MANAGED_MODEL_SETTINGS_ENV: &str = "EASYCLIPROXY_CLAUDE_CODE_MODEL_SETTINGS";
pub(crate) const CLAUDE_CODE_MANAGED_STARTUP_MODEL_ENV: &str = "EASYCLIPROXY_CLAUDE_CODE_STARTUP_MODEL";
pub(crate) const DEFAULT_CLAUDE_AUTO_COMPACT_PCT: u8 = 90;
pub(crate) const MODEL_ALIAS_CONFIG_SECTIONS: &[&str] = &[
    "codex-api-key",
    "openai-compatibility",
    "claude-api-key",
    "gemini-api-key",
];
#[cfg(test)]
pub(crate) const LEGACY_AGENT_MODIFICATION_STATE_VERSION: u8 = 1;
#[cfg(test)]
pub(crate) const AGENT_MODIFICATION_STATE_VERSION: u8 = 2;
#[cfg(test)]
pub(crate) const AGENT_APPLIED_STATE_VERSION: u8 = 4;
#[cfg(test)]
pub(crate) const AGENT_CONFIGURATION_REVISION: u8 = 1;
#[cfg(test)]
pub(crate) const AGENT_PHASE_APPLYING: &str = "applying";
#[cfg(test)]
pub(crate) const AGENT_PHASE_ACTIVE: &str = "active";
#[cfg(test)]
pub(crate) const AGENT_PHASE_RESTORING: &str = "restoring";
#[cfg(test)]
pub(crate) const AGENT_PHASE_RECOVERY: &str = "recovery";
#[cfg(test)]
pub(crate) const AGENT_MODIFICATION_STATE_CONFLICT: &str = "conflict";
pub(crate) const USER_AGENT: &str = concat!(
    "CPA-GUI/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/router-for-me/CLIProxyAPI)"
);
pub(crate) const APP_USER_AGENT: &str = concat!(
    "EasyCLIProxyAPI/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/router-for-me/EasyCLIProxyAPI)"
);
pub(crate) static CORE_CONFIG_FILE_LOCK: Mutex<()> = Mutex::new(());
pub(crate) static AGENT_CONFIG_FILE_LOCK: Mutex<()> = Mutex::new(());
#[cfg(test)]
pub(crate) static CODEX_APPLIED_STATES: LazyLock<
    Mutex<std::collections::HashMap<PathBuf, AgentAppliedState>>,
> = LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
pub(crate) static CONFIG_WRITE_HASHES: LazyLock<Mutex<std::collections::HashMap<PathBuf, String>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
