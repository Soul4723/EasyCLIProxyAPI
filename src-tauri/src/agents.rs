use super::*;

// Writers, inspectors and model requests use the same selected client origin.
// Ports remain supported for local helpers and isolated fixtures.
pub(crate) trait AgentClientOrigin: Copy + Send + Sync {
    fn client_origin(self) -> String;
    fn validate_client_origin(self) -> Result<(), String>;
    fn local_client(self) -> bool;
}

impl AgentClientOrigin for u16 {
    fn client_origin(self) -> String { managed_core_loopback_origin(self) }
    fn validate_client_origin(self) -> Result<(), String> {
        if self == 0 { Err("Invalid kernel port".into()) } else { Ok(()) }
    }
    fn local_client(self) -> bool { true }
}

impl AgentClientOrigin for &GuiConfigFile {
    fn client_origin(self) -> String {
        if self.connection_mode == CoreConnectionMode::Remote {
            self.remote_management_origin.trim_end_matches('/').to_string()
        } else { managed_core_loopback_origin(self.port) }
    }
    fn validate_client_origin(self) -> Result<(), String> {
        if self.local_client() { return self.port.validate_client_origin(); }
        crate::core_connection::normalize_origin(&self.remote_management_origin).map(|_| ())
    }
    fn local_client(self) -> bool { self.connection_mode == CoreConnectionMode::Local }
}

impl AgentClientOrigin for &&GuiConfigFile {
    fn client_origin(self) -> String { (*self).client_origin() }
    fn validate_client_origin(self) -> Result<(), String> { (*self).validate_client_origin() }
    fn local_client(self) -> bool { (*self).local_client() }
}

pub(crate) async fn agent_client_api_key(config: &GuiConfigFile) -> Result<String, String> {
    if config.local_client() { return Ok(effective_agent_api_key(config).to_string()); }
    let (_, _, key) = crate::provider_health::core_client_target(config, Duration::from_secs(15)).await?;
    Ok(key)
}

// Status refresh also runs on native blocking workers. Do not block a Tokio
// runtime thread on itself while reading a remote management snapshot.
fn agent_client_api_key_blocking(config: &GuiConfigFile) -> Result<String, String> {
    if config.local_client() { return Ok(effective_agent_api_key(config).to_string()); }
    thread::scope(|scope| scope.spawn(|| tauri::async_runtime::block_on(agent_client_api_key(config)))
        .join().map_err(|_| "Agent client target lookup failed".to_string())?)
}

mod backups;
mod commands;
mod configuration;
mod deepseek_harness;
mod deepseek_desktop;
mod discovery;
mod launch;
mod native_oauth;
mod state;
mod templates;
mod transactions;
mod workbuddy;
mod antigravity;
mod copilot;
#[cfg(target_os = "windows")]
mod windows_probe;
pub(crate) use backups::*;
pub(crate) use commands::*;
pub(crate) use configuration::*;
pub(crate) use deepseek_harness::*;
pub(crate) use deepseek_desktop::*;
pub(crate) use discovery::*;
pub(crate) use launch::*;
pub(crate) use native_oauth::*;
pub(crate) use state::*;
pub(crate) use templates::*;
pub(crate) use transactions::*;
pub(crate) use workbuddy::*;
pub(crate) use antigravity::*;
pub(crate) use copilot::*;
#[cfg(target_os = "windows")]
pub(crate) use windows_probe::*;

#[cfg(test)]
mod remote_tests;
