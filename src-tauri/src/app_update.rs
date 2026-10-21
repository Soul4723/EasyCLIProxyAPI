//! Application update entry points and platform-specific helpers.
//!
//! - `settings`: update source settings
//! - `releases`: release discovery and redirect validation
//! - `manifest`: manifest and asset validation
//! - `download`: download and staging
//! - `archive`: archive extraction
//! - `portable`: portable replacement and rollback helper
//! - `macos`: macOS application updates

use super::*;

pub(crate) const PORTABLE_UPDATE_HELPER_ACK_FILE: &str = "update-helper-started.ack";
const PORTABLE_UPDATE_HELPER_START_TIMEOUT: Duration = Duration::from_secs(10);
#[tauri::command]
pub(crate) fn get_app_update_task(state: tauri::State<'_, AppUpdateState>) -> AppUpdateTask {
    state.snapshot()
}

#[tauri::command]
pub(crate) fn cancel_app_update(state: tauri::State<'_, AppUpdateState>) -> Result<(), String> {
    let task = state.snapshot();
    if !task.running || !task.cancellable {
        return Err("The current application update stage cannot be canceled".to_string());
    }
    state.cancel();
    Ok(())
}

#[tauri::command]
pub(crate) async fn start_app_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppUpdateState>,
) -> Result<(), String> {
    if portable_update_platform_key().is_none() {
        return Err("The current platform does not support in-app automatic upgrades".to_string());
    }
    let token = CancellationToken::new();
    state.start(token.clone())?;
    let task = state.snapshot();
    let _ = app.emit(APP_UPDATE_PROGRESS_EVENT, task);
    let update_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = async {
            let state = update_app.state::<AppUpdateState>();
            let gui_config_state = update_app.state::<GuiConfigState>();
            let pending = refresh_app_update_for_install(state.inner(), &token, async {
                let (info, pending) =
                    resolve_app_update(&update_app, gui_config_state.inner()).await?;
                pending.ok_or_else(|| {
                    if info.update_available {
                        info.unsupported_reason
                            .unwrap_or_else(|| "The current version does not support automatic updates".to_string())
                    } else {
                        "No application update is currently available to install. Check for updates again".to_string()
                    }
                })
            })
            .await?;
            let _ = update_app.emit(APP_UPDATE_PROGRESS_EVENT, state.snapshot());
            let config = gui_config_state.snapshot()?;
            download_and_stage_portable_app_update(
                &update_app,
                &pending,
                &token,
                &config.proxy_url,
                config.selected_download_candidate(),
            )
            .await
        }
        .await;
        if let Err(error) = outcome {
            let state = update_app.state::<AppUpdateState>();
            let cancelled = token.is_cancelled();
            let task = state.finish(
                if cancelled { "cancelled" } else { "failed" },
                Some(if cancelled {
                    "Application update download canceled".to_string()
                } else {
                    error
                }),
            );
            let _ = update_app.emit(APP_UPDATE_PROGRESS_EVENT, task);
        }
    });
    Ok(())
}

pub(crate) async fn refresh_app_update_for_install<F>(
    state: &AppUpdateState,
    token: &CancellationToken,
    refresh: F,
) -> Result<PendingAppUpdate, String>
where
    F: std::future::Future<Output = Result<PendingAppUpdate, String>>,
{
    let pending = tokio::select! {
        biased;
        _ = token.cancelled() => return Err("Application update download canceled".to_string()),
        result = refresh => result?,
    };
    state.start_download(&pending)?;
    Ok(pending)
}

pub(crate) fn portable_update_ack_argument() -> Option<PathBuf> {
    let mut args = env::args_os();
    while let Some(argument) = args.next() {
        if argument == "--portable-update-ack" {
            let path = PathBuf::from(args.next()?);
            let parent = path.parent()?;
            let valid_name =
                path.file_name().and_then(|value| value.to_str()) == Some("update-started.ack");
            let valid_parent = parent.starts_with(env::temp_dir())
                && parent
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.starts_with("EasyCLIProxyAPI-update-"));
            return (valid_name && valid_parent).then_some(path);
        }
    }
    None
}

mod settings;
mod releases;
mod manifest;
mod download;
mod archive;
mod portable;
#[cfg(any(target_os = "macos", test))]
mod macos;

pub(crate) use settings::*;
pub(crate) use releases::*;
pub(crate) use manifest::*;
pub(crate) use download::*;
pub(crate) use archive::*;
pub(crate) use portable::*;
#[cfg(any(target_os = "macos", test))]
pub(crate) use macos::*;
