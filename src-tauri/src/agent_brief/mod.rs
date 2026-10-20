//! Agent briefing: `cpa-gui --brief` prints, from cached state, how much headroom each provider has
//! and which models are routable now, so an agent can plan before it delegates. See
//! `docs/agent-briefing.md`.
//!
//! * The running app publishes its quota cache (already masked) through `agent_briefing_publish`.
//! * The CLI reads the core's own management API when its copy is older than a TTL.
//! * When no read of an enabled account is newer than 5 min, the CLI reads Claude, Codex and Devin
//!   quota itself through the core's `requests/api-call` (read-only usage URLs only).
//! * Nothing polls, and nothing ever sends an inference request.
mod cli;
mod model;
mod quota_fetch;
mod refresh;
mod render;
#[cfg(test)]
mod tests;

pub(crate) use cli::run_cli;
use model::{sanitize_accounts, QuotaAccount, QuotaPart, QUOTA_FILE};
use std::path::PathBuf;

const APP_DIR: &str = "com.cpa.gui";

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from).filter(|path| path.is_absolute())
}

/// Per-user directory of the cache files and the launcher (`CPA_BRIEF_DIR` overrides it for tests).
/// It matches Tauri's app data directory for the bundle identifier, so the path is stable across
/// app moves and updates while the GUI config stays next to the executable.
pub(crate) fn agent_dir() -> Result<PathBuf, String> {
    if let Some(dir) = env_path("CPA_BRIEF_DIR") {
        return Ok(dir);
    }
    #[cfg(target_os = "windows")]
    let base = env_path("APPDATA");
    #[cfg(target_os = "macos")]
    let base = env_path("HOME").map(|home| home.join("Library").join("Application Support"));
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base = env_path("XDG_DATA_HOME").or_else(|| env_path("HOME").map(|home| home.join(".local").join("share")));
    base.map(|base| base.join(APP_DIR).join("agent")).ok_or_else(|| "Cannot determine the user data directory".to_string())
}

#[cfg(windows)]
const LAUNCHER_NAME: &str = "cpa-brief.cmd";
#[cfg(not(windows))]
const LAUNCHER_NAME: &str = "cpa-brief";

fn launcher_script(executable: &std::path::Path) -> Result<String, String> {
    let path = executable.to_string_lossy();
    if path.chars().any(|c| c.is_control()) {
        return Err("The executable path has control characters".to_string());
    }
    #[cfg(windows)]
    {
        if path.contains('"') || path.contains('%') {
            return Err("The executable path cannot be used in a launcher".to_string());
        }
        Ok(format!("@echo off\r\n\"{path}\" --brief %*\r\n"))
    }
    #[cfg(not(windows))]
    {
        let quoted = format!("'{}'", path.replace('\'', "'\\''"));
        Ok(format!("#!/bin/sh\n# Written by EasyCLIProxyAPI on start; prints the agent briefing.\nexec {quoted} --brief \"$@\"\n"))
    }
}

/// (Re)writes the launcher that the skill names. Rewritten only when its content changes.
pub(crate) fn write_launcher() -> Result<PathBuf, String> {
    let path = agent_dir()?.join(LAUNCHER_NAME);
    let executable = std::env::current_exe().map_err(|error| format!("Cannot read the executable path: {error}"))?;
    crate::write_bytes_atomically(&path, launcher_script(&executable)?.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).map(|meta| meta.permissions().mode() & 0o777).unwrap_or(0);
        if mode != 0o755 {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("Cannot make the launcher executable: {error}"))?;
        }
    }
    Ok(path)
}

/// Receives the frontend's masked quota snapshot. Fenced: a document from before a core switch
/// cannot overwrite the new target's cache.
#[tauri::command]
pub(crate) async fn agent_briefing_publish(
    config: tauri::State<'_, crate::GuiConfigState>,
    accounts: Vec<QuotaAccount>,
    expected_revision: u64,
) -> Result<(), String> {
    config.ensure_revision(expected_revision)?;
    let snapshot = config.snapshot()?;
    let origin = crate::core_connection::connection_from_config(&snapshot)?.management_origin;
    let dir = agent_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        let part = QuotaPart { origin, published_at_ms: cli::now_ms(), accounts: sanitize_accounts(accounts) };
        let bytes = serde_json::to_vec(&part).map_err(|_| "Cannot encode the briefing".to_string())?;
        crate::write_private_bytes_atomically(&dir.join(QUOTA_FILE), &bytes)
    })
    .await
    .map_err(|_| "Briefing write was interrupted".to_string())?
}
