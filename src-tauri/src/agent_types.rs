use super::*;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentConfigStatus {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) supported_platform: bool,
    pub(crate) installed: bool,
    pub(crate) plugin_installed: bool,
    pub(crate) launch_targets: Vec<AgentLaunchTarget>,
    pub(crate) version: Option<String>,
    pub(crate) cli_version: Option<String>,
    pub(crate) app_version: Option<String>,
    pub(crate) plugin_version: Option<String>,
    pub(crate) config_paths: Vec<String>,
    pub(crate) config_exists: bool,
    pub(crate) config_valid: bool,
    pub(crate) configured: bool,
    pub(crate) configuration_synchronized: bool,
    pub(crate) connection_state: String,
    pub(crate) current_model: Option<String>,
    pub(crate) oauth_configuration: bool,
    pub(crate) codex_native_oauth: bool,
    pub(crate) modification_enabled: bool,
    pub(crate) modification_state: String,
    pub(crate) backup_available: bool,
    pub(crate) applied_model: Option<String>,
    pub(crate) claude_code_model_mappings: Option<ClaudeDesktopModelMappings>,
    pub(crate) claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
    pub(crate) warnings: Vec<String>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentLaunchTarget {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) detail: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeepSeekHarnessLaunchOptions {
    pub(crate) mode: String,
    pub(crate) web_host: Option<String>,
    pub(crate) web_port: Option<u16>,
    pub(crate) open_browser: Option<bool>,
    #[serde(default)]
    pub(crate) trusted_hosts: Vec<String>,
    pub(crate) task: Option<String>,
    pub(crate) profile: Option<String>,
    #[serde(default)]
    pub(crate) patches: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeepSeekHarnessProcessStatus {
    pub(crate) running: bool,
    pub(crate) pid: Option<u32>,
    pub(crate) mode: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentConfigActionResult {
    pub(crate) outcome: String,
    pub(crate) enabled: bool,
    pub(crate) model: Option<String>,
    pub(crate) changed_files: Vec<String>,
    pub(crate) conflict_files: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiProviderUpdateStatus {
    pub(crate) installed_version: Option<String>,
    pub(crate) latest_version: Option<String>,
    pub(crate) update_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexModelCatalogUpdateResult {
    pub(crate) outcome: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentModelOption {
    pub(crate) name: String,
    pub(crate) alias: Option<String>,
    #[serde(default)]
    pub(crate) is_alias: bool,
    #[serde(default)]
    pub(crate) context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) input_modalities: Option<Vec<String>>,
    #[serde(skip)]
    pub(crate) harness_metadata: Option<serde_json::Value>,
}


#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeDesktopModelMappings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) desktop_models: Option<Vec<ClaudeDesktopModelMapping>>,
    #[serde(default)]
    pub(crate) opus: String,
    #[serde(default)]
    pub(crate) sonnet: String,
    #[serde(default)]
    pub(crate) haiku: String,
    #[serde(default)]
    pub(crate) fable: String,
    #[serde(default)]
    pub(crate) fable_1m: bool,
    #[serde(default)]
    pub(crate) opus_1m: bool,
    #[serde(default)]
    pub(crate) sonnet_1m: bool,
    #[serde(default)]
    pub(crate) haiku_1m: bool,
    #[serde(default = "default_claude_code_max_context_tokens")]
    pub(crate) max_context_tokens: u64,
    #[serde(default = "default_claude_auto_compact_pct")]
    pub(crate) auto_compact_pct: u8,
    #[serde(default)]
    pub(crate) disable_auto_compact: bool,
    /// Keep Claude Code's session/default model selection under CPA control.
    /// Defaults to true for backwards compatibility with existing profiles.
    #[serde(default = "default_true")]
    pub(crate) manage_default_model: bool,
    /// Set CLAUDE_CODE_SUBAGENT_MODEL when enabled; otherwise allow inheritance.
    /// Defaults to true for backwards compatibility with existing profiles.
    #[serde(default = "default_true")]
    pub(crate) manage_subagent_model: bool,
    /// Optional explicit model written to the root Claude Code `model` setting.
    #[serde(default)]
    pub(crate) startup_model: Option<String>,
    /// Optional explicit model written to CLAUDE_CODE_SUBAGENT_MODEL.
    #[serde(default)]
    pub(crate) subagent_model: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeDesktopModelMapping {
    #[serde(default)]
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) alias: String,
    #[serde(default)]
    pub(crate) context_1m: bool,
}

impl ClaudeDesktopModelMapping {
    pub(crate) fn model_id(&self) -> &str {
        if self.alias.trim().is_empty() {
            self.model.trim()
        } else {
            self.alias.trim()
        }
    }

    pub(crate) fn source_or_alias(&self) -> &str {
        if self.model.trim().is_empty() {
            self.alias.trim()
        } else {
            self.model.trim()
        }
    }

    pub(crate) fn has_mapping(&self) -> bool {
        !self.model.trim().is_empty()
            && !self.alias.trim().is_empty()
            && !self.model.trim().eq_ignore_ascii_case(self.alias.trim())
    }
}

pub(crate) fn default_claude_code_max_context_tokens() -> u64 {
    DEFAULT_CLAUDE_CONTEXT_WINDOW
}

pub(crate) fn default_claude_auto_compact_pct() -> u8 {
    DEFAULT_CLAUDE_AUTO_COMPACT_PCT
}

pub(crate) fn default_true() -> bool {
    true
}

impl ClaudeDesktopModelMappings {
    pub(crate) fn all(model: &str) -> Self {
        Self {
            desktop_models: None,
            opus: model.to_string(),
            sonnet: model.to_string(),
            haiku: model.to_string(),
            fable: model.to_string(),
            fable_1m: false,
            opus_1m: false,
            sonnet_1m: false,
            haiku_1m: false,
            max_context_tokens: default_claude_code_max_context_tokens(),
            auto_compact_pct: default_claude_auto_compact_pct(),
            disable_auto_compact: false,
            manage_default_model: true,
            manage_subagent_model: true,
            startup_model: None,
            subagent_model: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexModelDefinition {
    pub(crate) id: String,
    pub(crate) display_name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) context_window: Option<u64>,
    pub(crate) reasoning_levels: Vec<String>,
    pub(crate) supports_tools: Option<bool>,
}

// Coordinates in the configuration arrays; never persisted into CPA configuration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelAliasPosition {
    pub(crate) section: String,
    pub(crate) provider_index: Option<usize>,
    pub(crate) model_index: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThinkingAliasEntry {
    pub(crate) position: ModelAliasPosition,
    pub(crate) source_model: String,
    pub(crate) alias: String,
    pub(crate) effort: Option<String>,
    pub(crate) provider: String,
    pub(crate) kind: String,
    pub(crate) oauth_channel: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeedAliasEntry {
    pub(crate) position: ModelAliasPosition,
    pub(crate) source_model: String,
    pub(crate) alias: String,
    pub(crate) service_tier: String,
    pub(crate) provider: String,
    pub(crate) kind: String,
    pub(crate) oauth_channel: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThinkingAliasSource {
    pub(crate) id: String,
    pub(crate) model: String,
    pub(crate) display_name: Option<String>,
    pub(crate) provider: String,
    pub(crate) kind: String,
    pub(crate) protocol: String,
    pub(crate) reasoning_levels: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ThinkingAliasSourceLocation {
    Oauth {
        channel: &'static str,
        force_mapping: bool,
    },
    ConfigModel {
        section: &'static str,
        provider_index: usize,
        model_index: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedThinkingAliasSource {
    pub(crate) source: ThinkingAliasSource,
    pub(crate) location: ThinkingAliasSourceLocation,
}

#[cfg(test)]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentModificationRecord {
    pub(crate) version: u8,
    pub(crate) client: String,
    pub(crate) phase: String,
    pub(crate) model: String,
    pub(crate) files: Vec<AgentModificationFile>,
}

#[cfg(test)]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentModificationFile {
    pub(crate) path: PathBuf,
    pub(crate) backup_path: PathBuf,
    pub(crate) existed_before: bool,
    pub(crate) original_sha256: Option<String>,
    pub(crate) managed_sha256: String,
}

#[cfg(test)]
pub(crate) struct AgentModificationInspection {
    pub(crate) enabled: bool,
    pub(crate) state: String,
    pub(crate) backup_available: bool,
    pub(crate) warnings: Vec<String>,
}

#[cfg(test)]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentAppliedState {
    pub(crate) version: u8,
    pub(crate) client: String,
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) configuration_revision: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) claude_desktop_model_mappings: Option<ClaudeDesktopModelMappings>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) backup_files: Vec<AgentAppliedBackupFile>,
    pub(crate) updated_at_unix: u64,
}

#[cfg(test)]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentAppliedBackupFile {
    pub(crate) path: PathBuf,
    pub(crate) backup_path: PathBuf,
    pub(crate) existed_before: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AgentClient {
    ClaudeCode,
    ClaudeDesktop,
    Codex,
    OpenCode,
    OpenClaw,
    Hermes,
    DeepSeekHarness,
    ZCode,
    WorkBuddy,
    AntigravityCli,
    CopilotCli,
    VscodeCopilot,
    KimiCode,
    GrokBuild,
    Omp,
}

#[derive(Clone, Debug)]
pub(crate) enum DesktopAppTarget {
    Application(PathBuf),
    #[cfg(target_os = "windows")]
    WindowsAppId(String),
}

impl AgentClient {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "claude-code" => Ok(Self::ClaudeCode),
            "claude-desktop" => Ok(Self::ClaudeDesktop),
            "codex" => Ok(Self::Codex),
            "opencode" => Ok(Self::OpenCode),
            "openclaw" => Ok(Self::OpenClaw),
            "hermes" => Ok(Self::Hermes),
            "deepseek-harness" => Ok(Self::DeepSeekHarness),
            "zcode" => Ok(Self::ZCode),
            "workbuddy" => Ok(Self::WorkBuddy),
            "antigravity-cli" => Ok(Self::AntigravityCli),
            "copilot-cli" => Ok(Self::CopilotCli),
            "vscode-copilot" => Ok(Self::VscodeCopilot),
            "kimi-code" => Ok(Self::KimiCode),
            "grok-build" => Ok(Self::GrokBuild),
            "omp" => Ok(Self::Omp),
            _ => Err(format!("Unsupported agent client: {value}")),
        }
    }

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::ClaudeDesktop => "claude-desktop",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::OpenClaw => "openclaw",
            Self::Hermes => "hermes",
            Self::DeepSeekHarness => "deepseek-harness",
            Self::ZCode => "zcode",
            Self::WorkBuddy => "workbuddy",
            Self::AntigravityCli => "antigravity-cli",
            Self::CopilotCli => "copilot-cli",
            Self::VscodeCopilot => "vscode-copilot",
            Self::KimiCode => "kimi-code",
            Self::GrokBuild => "grok-build",
            Self::Omp => "omp",
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::ClaudeDesktop => "Claude Desktop",
            Self::Codex => "Codex",
            Self::OpenCode => "OpenCode",
            Self::OpenClaw => "OpenClaw",
            Self::Hermes => "Hermes Agent",
            Self::DeepSeekHarness => "DeepSeek Harness",
            Self::ZCode => "ZCode",
            Self::WorkBuddy => "WorkBuddy",
            Self::AntigravityCli => "Antigravity CLI",
            Self::CopilotCli => "Copilot CLI",
            Self::VscodeCopilot => "VSCode Copilot",
            Self::KimiCode => "Kimi Code",
            Self::GrokBuild => "Grok Build",
            Self::Omp => "Oh My Pi",
        }
    }

    pub(crate) fn supported_platform(self) -> bool {
        self != Self::ClaudeDesktop
            || cfg!(any(
                target_os = "windows",
                target_os = "macos",
                target_os = "linux"
            ))
    }

    pub(crate) fn executable_names(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &["claude"],
            Self::ClaudeDesktop => &[],
            Self::Codex => &["codex"],
            Self::OpenCode => &["opencode"],
            Self::OpenClaw => &["openclaw"],
            Self::Hermes => &["hermes"],
            Self::DeepSeekHarness => &["dsh"],
            Self::ZCode => &["zcode"],
            Self::WorkBuddy => &[],
            Self::AntigravityCli => &["agy"],
            Self::CopilotCli => &["copilot"],
            Self::VscodeCopilot => &["code"],
            Self::KimiCode => &["kimi"],
            Self::GrokBuild => &["grok"],
            Self::Omp => &["omp"],
        }
    }
}

pub(crate) struct AgentFileUpdate {
    pub(crate) path: PathBuf,
    pub(crate) after: String,
}

pub(crate) struct AgentConfigurationOptions<'a> {
    pub(crate) models: &'a [AgentModelOption],
    pub(crate) codex_catalog: Option<&'a str>,
    pub(crate) oauth_configuration: bool,
    pub(crate) claude_code_model_mappings: Option<&'a ClaudeDesktopModelMappings>,
    pub(crate) claude_desktop_model_mappings: Option<&'a ClaudeDesktopModelMappings>,
}

pub(crate) struct PreparedAgentModels {
    pub(crate) models: Vec<AgentModelOption>,
    pub(crate) codex_catalog: Option<String>,
}

pub(crate) type FileSnapshot = (PathBuf, Option<Vec<u8>>);
#[cfg(test)]
pub(crate) type AgentRecordExtension = (AgentModificationRecord, Vec<FileSnapshot>);
