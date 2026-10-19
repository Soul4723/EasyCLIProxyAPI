use super::*;

pub(crate) fn should_start_hidden(config: &GuiConfigFile) -> bool {
    config.silent_start
        && cfg!(any(
            target_os = "linux",
            target_os = "macos",
            target_os = "windows"
        ))
}

pub(crate) fn should_start_core_on_launch(config: &GuiConfigFile) -> bool {
    if config.connection_mode == CoreConnectionMode::Remote { return false; }
    config.start_core_on_launch
}

pub(crate) fn configure_initial_main_window(
    app_handle: &tauri::AppHandle,
    start_hidden: bool,
) -> Result<(), String> {
    let window = main_window(app_handle).ok_or_else(|| "Main window does not exist".to_string())?;

    #[cfg(target_os = "macos")]
    set_macos_dock_visible(app_handle, !start_hidden);

    #[cfg(target_os = "linux")]
    let start_hidden = if start_hidden && !linux_tray_available(app_handle) {
        eprintln!(
            "System tray is unavailable; showing the main window instead of starting hidden"
        );
        false
    } else {
        start_hidden
    };

    if start_hidden {
        return window
            .hide()
            .map_err(|error| format!("Failed to hide main window during silent startup: {error}"));
    }

    window
        .show()
        .map_err(|error| format!("Failed to show main window: {error}"))?;
    if window.is_minimized().unwrap_or(false) {
        window
            .unminimize()
            .map_err(|error| format!("Failed to restore main window: {error}"))?;
    }
    window
        .set_focus()
        .map_err(|error| format!("Failed to focus main window: {error}"))
}

pub(crate) fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
