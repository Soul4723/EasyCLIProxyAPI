use super::*;

mod child;
pub(crate) use child::*;
mod install;
pub(crate) use install::*;
mod staging;
pub(crate) use staging::*;
mod releases;
pub(crate) use releases::*;
mod download;
pub(crate) use download::*;
mod process;
pub(crate) use process::*;
mod bundled;
pub(crate) use bundled::*;
mod metadata;
pub(crate) use metadata::*;
mod integrity;
pub(crate) use integrity::*;
mod process_control;
pub(crate) use process_control::*;
mod supervisor;
pub(crate) use supervisor::*;
mod rollback;
pub(crate) use rollback::*;
mod archive;
pub(crate) use archive::*;
mod startup;
pub(crate) use startup::*;

pub(crate) static CORE_OPERATION_LOCK: Mutex<()> = Mutex::new(());
const BUNDLED_CORE_HANDLED_VERSION_FILE: &str = "cpa-gui-bundled-core-handled.txt";

pub(crate) fn lock_core_operation(
    process_state: &CoreProcessState,
) -> Result<std::sync::MutexGuard<'static, ()>, String> {
    let guard = CORE_OPERATION_LOCK
        .try_lock()
        .map_err(|_| "The kernel is performing another operation. Try again later".to_string())?;
    process_state.ensure_active()?;
    Ok(guard)
}

// User lifecycle actions own the operation lock; background supervision simply
// defers a pass when they are in progress, rather than recording recovery failure.
fn try_supervisor_operation(lock: &Mutex<()>) -> Result<Option<std::sync::MutexGuard<'_, ()>>, String> {
    match lock.try_lock() {
        Ok(guard) => Ok(Some(guard)),
        Err(std::sync::TryLockError::WouldBlock) => Ok(None),
        Err(std::sync::TryLockError::Poisoned(_)) => Err("Kernel operation lock is poisoned".to_string()),
    }
}

#[test]
fn supervisor_defers_busy_operation_without_recovery_error() {
    let lock = Mutex::new(());
    let guard = lock.lock().unwrap();
    assert!(try_supervisor_operation(&lock).unwrap().is_none());
    drop(guard);
    assert!(try_supervisor_operation(&lock).unwrap().is_some());
}

#[tauri::command]
pub(crate) async fn start_core_process(app: tauri::AppHandle) -> Result<CoreStatus, String> {
    run_core_command(app, start_core_process_with_state).await
}

pub(crate) fn start_core_process_with_state(
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
) -> Result<CoreStatus, String> {
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        return Err("Core lifecycle is unavailable for a remote connection".to_string());
    }
    network_proxy::refresh(gui_config_state)?;
    let config = gui_config_state.snapshot()?;
    process_state.reset_crash_restart_attempts();
    start_core_process_inner(process_state, &config)?;
    if process_state.is_supervising() {
        process_state.recovery.running();
    }
    if let Err(error) = gui_config_state.set_run_on_startup(true) {
        let _ = stop_core_process_inner(process_state);
        return Err(error);
    }
    current_core_status(Some(process_state), Some(config.port))
}

#[tauri::command]
pub(crate) async fn stop_core_process(app: tauri::AppHandle) -> Result<CoreStatus, String> {
    run_core_command(app, stop_core_process_with_state).await
}

pub(crate) fn stop_core_process_with_state(
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
) -> Result<CoreStatus, String> {
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        return Err("Core lifecycle is unavailable for a remote connection".to_string());
    }
    stop_core_process_inner(process_state)?;
    let config = gui_config_state.set_run_on_startup(false)?;
    current_core_status(Some(process_state), Some(config.port))
}

#[tauri::command]
pub(crate) async fn restart_core_process(app: tauri::AppHandle) -> Result<CoreStatus, String> {
    run_core_command(app, restart_core_process_with_state).await
}

pub(crate) fn restart_core_process_with_state(
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
) -> Result<CoreStatus, String> {
    if gui_config_state.snapshot()?.connection_mode == CoreConnectionMode::Remote {
        return Err("Core lifecycle is unavailable for a remote connection".to_string());
    }
    network_proxy::refresh(gui_config_state)?;
    let config = gui_config_state.snapshot()?;
    process_state.recovery.cancel();
    if current_core_status(Some(process_state), None)?.running {
        stop_core_process_inner(process_state)?;
    }
    process_state.reset_crash_restart_attempts();
    start_core_process_inner(process_state, &config)?;
    if process_state.is_supervising() {
        process_state.recovery.running();
    }
    if let Err(error) = gui_config_state.set_run_on_startup(true) {
        let _ = stop_core_process_inner(process_state);
        return Err(error);
    }
    current_core_status(Some(process_state), Some(config.port))
}

pub(crate) fn current_core_platform() -> Result<CorePlatform, String> {
    let os = env::consts::OS;
    let arch = env::consts::ARCH;

    let (asset_os, archive_kind) = match os {
        "linux" => ("linux", "tar.gz"),
        "macos" => ("darwin", "tar.gz"),
        "windows" => ("windows", "zip"),
        other => return Err(format!("Unsupported operating system: {other}")),
    };

    let asset_arch = match arch {
        "x86_64" => "amd64",
        "aarch64" => "aarch64",
        other => return Err(format!("Unsupported CPU architecture: {other}")),
    };

    Ok(CorePlatform {
        os: os.to_string(),
        arch: arch.to_string(),
        asset_os: asset_os.to_string(),
        asset_arch: asset_arch.to_string(),
        archive_kind: archive_kind.to_string(),
    })
}
