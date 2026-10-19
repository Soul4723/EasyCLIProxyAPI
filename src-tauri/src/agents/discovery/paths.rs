use super::*;

#[cfg(not(test))]
pub(crate) fn agent_configuration_environment(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

#[cfg(test)]
pub(crate) fn agent_configuration_environment(_: &str) -> Option<PathBuf> {
    None
}

pub(crate) fn agent_config_paths(client: AgentClient, home: &Path) -> Vec<PathBuf> {
    match client {
        AgentClient::ClaudeCode => {
            let directory = home.join(".claude");
            let settings = directory.join("settings.json");
            let legacy = directory.join("claude.json");
            let settings_state_exists = agent_state_path(std::slice::from_ref(&settings))
                .map(|path| path.exists())
                .unwrap_or(false);
            let legacy_state_exists = agent_state_path(std::slice::from_ref(&legacy))
                .map(|path| path.exists())
                .unwrap_or(false);
            vec![if settings_state_exists {
                settings
            } else if legacy_state_exists || (!settings.exists() && legacy.exists()) {
                legacy
            } else {
                settings
            }]
        }
        AgentClient::ClaudeDesktop => claude_desktop_config_paths(home),
        AgentClient::Codex => vec![codex_configuration_directory(home).join("config.toml")],
        AgentClient::OpenCode => vec![opencode_config_path(home)],
        AgentClient::OpenClaw => vec![openclaw_agent_config_path(home)],
        AgentClient::Hermes => vec![hermes_agent_config_path(home)],
        AgentClient::DeepSeekHarness => {
            let directory = deepseek_harness_home(home);
            vec![
                directory.join(DEEPSEEK_HARNESS_SETTINGS_FILE),
                directory.join(DEEPSEEK_HARNESS_CREDENTIALS_FILE),
            ]
        }
        AgentClient::WorkBuddy => vec![workbuddy_home(home).join("models.json")],
        AgentClient::AntigravityCli => antigravity_config_paths(client, home),
        AgentClient::CopilotCli | AgentClient::VscodeCopilot => copilot_config_paths(client, home),
        AgentClient::ZCode => vec![home.join(".zcode/v2").join(ZCODE_PROVIDER_CONFIG_FILE)],
        AgentClient::KimiCode => vec![kimi_code_home(home).join(KIMI_CODE_CONFIG_FILE)],
        AgentClient::GrokBuild => vec![grok_build_home(home).join(GROK_BUILD_CONFIG_FILE)],
        AgentClient::Omp => {
            let directory = omp_agent_directory(home);
            vec![directory.join(OMP_MODELS_FILE), directory.join(OMP_SETTINGS_FILE)]
        }
    }
}

pub(crate) fn opencode_config_path(home: &Path) -> PathBuf {
    #[cfg(test)]
    let (custom_config, xdg_config_home): (Option<PathBuf>, Option<PathBuf>) = (None, None);
    #[cfg(not(test))]
    let custom_config = env::var_os("OPENCODE_CONFIG").map(PathBuf::from);
    #[cfg(not(test))]
    let xdg_config_home = env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    opencode_config_path_from_environment(
        home,
        custom_config.as_deref(),
        xdg_config_home.as_deref(),
    )
}

pub(crate) fn opencode_config_path_from_environment(
    home: &Path,
    custom_config: Option<&Path>,
    xdg_config_home: Option<&Path>,
) -> PathBuf {
    if let Some(path) = custom_config.filter(|path| !path.as_os_str().is_empty()) {
        return path.to_path_buf();
    }

    let config_directory = xdg_config_home
        .filter(|path| path.is_absolute())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".config"))
        .join("opencode");
    let json = config_directory.join("opencode.json");
    let jsonc = config_directory.join("opencode.jsonc");
    let candidates = [json.clone(), jsonc];

    candidates
        .iter()
        .find(|path| {
            agent_state_path(std::slice::from_ref(*path))
                .map(|state| state.exists())
                .unwrap_or(false)
        })
        .or_else(|| candidates.iter().find(|path| path.is_file()))
        .cloned()
        .unwrap_or(json)
}

pub(crate) fn openclaw_agent_config_path(home: &Path) -> PathBuf {
    #[cfg(test)]
    let (custom_config, state_directory, openclaw_home): (
        Option<PathBuf>,
        Option<PathBuf>,
        Option<PathBuf>,
    ) = (None, None, None);
    #[cfg(not(test))]
    let custom_config = agent_configuration_environment("OPENCLAW_CONFIG_PATH");
    #[cfg(not(test))]
    let state_directory = agent_configuration_environment("OPENCLAW_STATE_DIR");
    #[cfg(not(test))]
    let openclaw_home = agent_configuration_environment("OPENCLAW_HOME");
    openclaw_agent_config_path_from_environment(
        home,
        custom_config.as_deref(),
        state_directory.as_deref(),
        openclaw_home.as_deref(),
    )
}

pub(crate) fn openclaw_agent_config_path_from_environment(
    home: &Path,
    custom_config: Option<&Path>,
    state_directory: Option<&Path>,
    openclaw_home: Option<&Path>,
) -> PathBuf {
    if let Some(path) = custom_config.filter(|path| !path.as_os_str().is_empty()) {
        return expand_openclaw_path(home, path);
    }

    if let Some(path) = state_directory.filter(|path| !path.as_os_str().is_empty()) {
        return expand_openclaw_path(home, path).join("openclaw.json");
    }

    openclaw_home
        .filter(|path| !path.as_os_str().is_empty())
        .map(|path| expand_openclaw_path(home, path))
        .unwrap_or_else(|| home.to_path_buf())
        .join(".openclaw/openclaw.json")
}

pub(super) fn expand_openclaw_path(home: &Path, path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if value == "~" {
        return home.to_path_buf();
    }
    if let Some(suffix) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home.join(suffix);
    }
    path.to_path_buf()
}

pub(crate) fn kimi_code_home(home: &Path) -> PathBuf {
    agent_configuration_environment("KIMI_CODE_HOME").unwrap_or_else(|| home.join(".kimi-code"))
}

pub(crate) fn grok_build_home(home: &Path) -> PathBuf {
    agent_configuration_environment("GROK_HOME").unwrap_or_else(|| home.join(".grok"))
}

pub(crate) fn omp_agent_directory(home: &Path) -> PathBuf {
    agent_configuration_environment("PI_CODING_AGENT_DIR").unwrap_or_else(|| home.join(".omp/agent"))
}

pub(crate) fn deepseek_harness_home(home: &Path) -> PathBuf {
    agent_configuration_environment("DSH_HOME").unwrap_or_else(|| home.join(".dsh"))
}

pub(crate) fn read_deepseek_harness_profile_version(home: &Path) -> Option<String> {
    let directory = deepseek_harness_home(home);
    [
        directory.join("profiles/node_modules/@deepseek-ai/dsh/package.json"),
        directory.join("node_modules/@deepseek-ai/dsh/package.json"),
    ]
    .into_iter()
    .find_map(|path| read_package_json_version(&path))
}

pub(crate) fn read_package_json_version(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let package = serde_json::from_str::<serde_json::Value>(&content).ok()?;
    package
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(str::to_string)
}

pub(crate) fn pi_agent_directory(home: &Path) -> PathBuf {
    agent_configuration_environment("PI_CODING_AGENT_DIR").unwrap_or_else(|| home.join(".pi/agent"))
}

pub(crate) fn pi_provider_config_path(home: &Path) -> PathBuf {
    pi_agent_directory(home).join(PI_AGENT_CONFIG_FILE)
}

pub(crate) fn pi_provider_settings_path(home: &Path) -> PathBuf {
    pi_agent_directory(home).join(PI_AGENT_SETTINGS_FILE)
}

pub(crate) fn pi_provider_package_json_path(home: &Path) -> PathBuf {
    pi_agent_directory(home)
        .join("npm/node_modules/@router-for-me/pi-cliproxyapi-provider/package.json")
}
