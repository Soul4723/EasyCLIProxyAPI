use super::*;

mod paths;
pub(crate) use paths::*;
mod pi;
pub(crate) use pi::*;
mod packages;
pub(crate) use packages::*;
mod codex_auth;
pub(crate) use codex_auth::*;
mod desktop_paths;
pub(crate) use desktop_paths::*;
mod inspection;
pub(crate) use inspection::*;
mod desktop;
pub(crate) use desktop::*;
mod executables;
pub(crate) use executables::*;
mod probe;
pub(crate) use probe::*;
mod models;
pub(crate) use models::*;
mod client_config;
pub(crate) use client_config::*;

const AGENT_VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const AGENT_VERSION_PROBE_POLL_INTERVAL: Duration = Duration::from_millis(20);

pub(crate) fn expected_agent_record_paths(client: AgentClient, paths: &[PathBuf]) -> Vec<PathBuf> {
    if client == AgentClient::Codex && paths.len() == 1 {
        let mut expected = paths.to_vec();
        expected.push(paths[0].with_file_name(CODEX_MODEL_CATALOG_FILE));
        expected.push(paths[0].with_file_name("auth.json"));
        expected
    } else {
        paths.to_vec()
    }
}

pub(crate) fn hermes_agent_config_path(home: &Path) -> PathBuf {
    if let Some(directory) = agent_configuration_environment("HERMES_HOME") {
        return directory.join("config.yaml");
    }
    #[cfg(target_os = "windows")]
    {
        agent_configuration_environment("LOCALAPPDATA")
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join("hermes/config.yaml")
    }
    #[cfg(not(target_os = "windows"))]
    home.join(".hermes/config.yaml")
}

fn hermes_managed_provider(root: &serde_yaml::Value) -> Option<&serde_yaml::Value> {
    let custom_provider = root
        .get("custom_providers")
        .and_then(serde_yaml::Value::as_sequence)
        .and_then(|providers| {
            providers.iter().find(|provider| {
                provider.get("name").and_then(serde_yaml::Value::as_str)
                    == Some(MANAGED_AGENT_PROVIDER_ID)
            })
        });
    custom_provider.or_else(|| {
        root.get("providers")
            .and_then(serde_yaml::Value::as_mapping)
            .and_then(|providers| {
                providers
                    .iter()
                    .find(|(key, provider)| {
                        key.as_str() == Some(MANAGED_AGENT_PROVIDER_ID)
                            || provider.get("name").and_then(serde_yaml::Value::as_str)
                                == Some(MANAGED_AGENT_PROVIDER_ID)
                    })
                    .map(|(_, provider)| provider)
            })
    })
}

pub(crate) fn manual_desktop_path(path: Option<&Path>) -> Option<&Path> {
    path.filter(|path| {
        path.is_file()
            || (cfg!(target_os = "macos") && path.is_dir()
                && path.extension().is_some_and(|extension| extension == "app"))
    })
}
