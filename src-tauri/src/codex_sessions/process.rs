use super::*;

#[cfg(test)]
thread_local! {
    /// Stands in for the process table: `Some(ids)` makes those ids look like running Codex apps.
    pub(super) static FAKE_CODEX_PROCESS_IDS: std::cell::RefCell<Option<Vec<u32>>> =
        const { std::cell::RefCell::new(None) };
}

fn running_codex_app_process_ids() -> Result<Vec<u32>, String> {
    #[cfg(test)]
    if let Some(ids) = FAKE_CODEX_PROCESS_IDS.with(|fake| fake.borrow().clone()) {
        return Ok(ids);
    }
    codex_app_process_ids()
}

pub(super) fn ensure_codex_apps_stopped() -> Result<(), String> {
    let running = running_codex_app_process_ids()?;
    if running.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Codex App / ChatGPT is still running (process: {}). Exit it completely, then preview and clean again",
        running
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join("、")
    ))
}

#[cfg(target_os = "windows")]
fn codex_app_process_ids() -> Result<Vec<u32>, String> {
    windows_app_process_ids(&["ChatGPT.exe", "Codex.exe"])
}

#[cfg(target_os = "windows")]
fn windows_app_process_ids(names: &[&str]) -> Result<Vec<u32>, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut ids = Vec::new();
    for name in names {
        let filter = format!("IMAGENAME eq {name}");
        let output = Command::new("tasklist")
            .args(["/FI", &filter, "/FO", "CSV", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("Failed to check {name} process status: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Error checking {name} process status: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        ids.extend(parse_windows_tasklist_process_ids(&output.stdout));
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

#[cfg(target_os = "windows")]
pub(super) fn parse_windows_tasklist_process_ids(output: &[u8]) -> Vec<u32> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| {
            let columns = line
                .trim()
                .trim_matches('"')
                .split("\",\"")
                .collect::<Vec<_>>();
            columns.get(1)?.parse::<u32>().ok()
        })
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn codex_app_process_ids() -> Result<Vec<u32>, String> {
    unix_app_process_ids(&["ChatGPT", "Codex"])
}

#[cfg(not(target_os = "windows"))]
fn unix_app_process_ids(names: &[&str]) -> Result<Vec<u32>, String> {
    let mut ids = Vec::new();
    for name in names {
        let output = Command::new("pgrep")
            .args(["-x", name])
            .output()
            .map_err(|error| format!("Failed to check {name} process status: {error}"))?;
        match output.status.code() {
            Some(0) => ids.extend(
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|line| line.trim().parse::<u32>().ok()),
            ),
            Some(1) => {}
            _ => {
                return Err(format!(
                    "Error checking {name} process status: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        }
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}
