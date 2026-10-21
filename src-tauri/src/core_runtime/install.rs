use super::*;

#[tauri::command]
pub(crate) async fn check_latest_core(
    app: tauri::AppHandle,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreLatest, String> {
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    let _detection_guard = VERSION_SOURCE_DETECTION_LOCK.lock().await;
    let platform = current_core_platform()?;
    let config = gui_config_state.snapshot()?;
    let proxy_url = config.proxy_url.clone();
    let client = http_client(&proxy_url, &config.custom_download_mirrors)?;
    let requested_source = config.selected_download_candidate();
    let (release, resolved_source) = fetch_release(
        &client,
        None,
        requested_source.clone(),
        &config.custom_download_mirrors,
    )
    .await?;
    persist_automatic_download_source_switch(
        &app,
        gui_config_state.inner(),
        &requested_source,
        &resolved_source,
    )?;
    let asset = select_release_asset(&release, &platform)?;

    Ok(CoreLatest {
        version: normalize_version(&release.tag_name),
        asset_name: asset.name.clone(),
    })
}

#[tauri::command]
pub(crate) fn detect_bundled_core(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<Option<BundledCoreInfo>, String> {
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    bundled_core_archive().map(|value| value.map(|(info, _)| info))
}

#[tauri::command]
pub(crate) async fn install_bundled_core(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<CoreInstallResult, String> {
    crate::core_connection::require_local(&app.state::<GuiConfigState>().snapshot()?)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_core_operation(app.state::<CoreProcessState>().inner())?;
        let state = app.state::<CoreDownloadState>();
        let process_state = app.state::<CoreProcessState>();
        let gui_config_state = app.state::<GuiConfigState>();
        let (info, archive_path) = bundled_core_archive()?
            .ok_or_else(|| "This distribution has no bundled kernel matching the system architecture".to_string())?;
        let token = CancellationToken::new();
        state.start(token, Some(info.version.clone()))?;
        let result = install_core_with_runtime_restore(
            &app,
            process_state.inner(),
            gui_config_state.inner(),
            || install_bundled_core_inner(&window, state.inner(), &info, &archive_path),
        );
        if result.is_err() {
            let _ = cleanup_core_work_dirs();
        }
        state.finish(&window, result.clone());
        result
    })
    .await
    .map_err(|error| format!("Offline kernel installation background task failed: {error}"))?
}

pub(crate) fn core_needs_bundled_install(install_dir: &Path, bundled_version: &str) -> bool {
    let Ok(bundled_version) =
        semver::Version::parse(bundled_version.trim().trim_start_matches('v'))
    else {
        return false;
    };
    if find_core_binary(install_dir).is_none() {
        return true;
    }
    if bundled_core_version_handled(install_dir, &bundled_version) {
        return false;
    }
    read_core_metadata(install_dir)
        .and_then(|metadata| {
            semver::Version::parse(metadata.version.trim().trim_start_matches('v')).ok()
        })
        .is_none_or(|installed| bundled_version > installed)
}

pub(super) fn bundled_core_version_handled(install_dir: &Path, bundled_version: &semver::Version) -> bool {
    fs::read_to_string(install_dir.join(BUNDLED_CORE_HANDLED_VERSION_FILE))
        .ok()
        .and_then(|version| semver::Version::parse(version.trim().trim_start_matches('v')).ok())
        .is_some_and(|version| &version == bundled_version)
}

pub(crate) fn mark_bundled_core_version_handled(
    install_dir: &Path,
    bundled_version: &str,
) -> Result<(), String> {
    write_bytes_atomically(
        &install_dir.join(BUNDLED_CORE_HANDLED_VERSION_FILE),
        bundled_version.as_bytes(),
    )
    .map_err(|error| format!("Failed to record processed bundled kernel version: {error}"))
}

pub(crate) fn remember_bundled_core_when_up_to_date(
    install_dir: &Path,
    bundled_version: &str,
) -> Result<(), String> {
    let Ok(bundled) = semver::Version::parse(bundled_version.trim().trim_start_matches('v')) else {
        return Ok(());
    };
    if bundled_core_version_handled(install_dir, &bundled) {
        return Ok(());
    }
    let installed = read_core_metadata(install_dir).and_then(|metadata| {
        semver::Version::parse(metadata.version.trim().trim_start_matches('v')).ok()
    });
    if find_core_binary(install_dir).is_some()
        && installed.is_some_and(|version| version >= bundled)
    {
        mark_bundled_core_version_handled(install_dir, bundled_version)?;
    }
    Ok(())
}

pub(crate) fn auto_install_bundled_core_if_needed(app: &tauri::AppHandle) -> Result<bool, String> {
    if app.state::<GuiConfigState>().snapshot()?.connection_mode == CoreConnectionMode::Remote { return Ok(false); }

    let install_dir = core_install_dir()?;
    let (info, archive_path) = match bundled_core_archive()? {
        Some(bundled) => bundled,
        None if find_core_binary(&install_dir).is_some() => return Ok(false),
        None => return Err("CPA kernel was not detected, and this distribution has no matching offline kernel".to_string()),
    };
    if !core_needs_bundled_install(&install_dir, &info.version) {
        remember_bundled_core_when_up_to_date(&install_dir, &info.version)?;
        return Ok(false);
    }
    let window = main_window(app).ok_or_else(|| {
        "Cannot access the main window to automatically install the offline kernel".to_string()
    })?;
    let state = app.state::<CoreDownloadState>();
    state.start(CancellationToken::new(), Some(info.version.clone()))?;
    let result = install_core_with_runtime_restore(
        app,
        app.state::<CoreProcessState>().inner(),
        app.state::<GuiConfigState>().inner(),
        || install_bundled_core_inner(&window, state.inner(), &info, &archive_path),
    );
    if result.is_err() {
        let _ = cleanup_core_work_dirs();
    }
    state.finish(&window, result.clone());
    result?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn cancel_core_install(
    state: tauri::State<'_, CoreDownloadState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<(), String> {
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    state.cancel();
    Ok(())
}

#[tauri::command]
pub(crate) fn get_core_install_task(
    state: tauri::State<'_, CoreDownloadState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<CoreInstallTask, String> {
    crate::core_connection::require_local(&gui_config_state.snapshot()?)?;
    Ok(state.snapshot())
}

pub(crate) struct StagedCoreInstall {
    pub(crate) version: String,
    pub(crate) asset_name: String,
    pub(crate) install_dir: PathBuf,
    pub(crate) staging_dir: PathBuf,
    pub(crate) binary_relative_path: PathBuf,
}

#[tauri::command]
pub(crate) async fn install_core_version(
    app: tauri::AppHandle,
    window: tauri::Window,
    version: Option<String>,
) -> Result<CoreInstallResult, String> {
    crate::core_connection::require_local(&app.state::<GuiConfigState>().snapshot()?)?;
    let version = version.as_deref().map(validate_release_version).transpose()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_core_operation(app.state::<CoreProcessState>().inner())?;
        let state = app.state::<CoreDownloadState>();
        let process_state = app.state::<CoreProcessState>();
        let gui_config_state = app.state::<GuiConfigState>();
        let config = gui_config_state.snapshot()?;
        crate::core_connection::require_local(&config)?;
        let proxy_url = config.proxy_url.clone();
        let rollback_dir = core_base_dir()?.join("cpa-core.rollback");
        archive_previous_core_rollback(&rollback_dir)?;
        let token = CancellationToken::new();
        state.start(token.clone(), version.clone())?;

        // Stage download, SHA-256 verification, and archive extraction BEFORE stopping the running core.
        let staged_result = tauri::async_runtime::block_on(stage_core_version_inner(
            &app,
            &window,
            state.inner(),
            gui_config_state.inner(),
            token,
            version,
            &proxy_url,
            config.selected_download_candidate(),
            config.custom_download_mirrors.clone(),
        ));

        let result = staged_result.and_then(|staged| {
            let was_running = pause_core_for_install(&app, process_state.inner(), &config)?;
            let swap_and_restore = apply_staged_core_with_rollback(
                &staged.install_dir,
                &staged.staging_dir,
                &rollback_dir,
                || {
                    if was_running && !process_state.is_shutting_down() {
                        start_core_process_inner(process_state.inner(), &config)
                    } else {
                        Ok(())
                    }
                },
            );
            let swap_and_restore = match swap_and_restore {
                Err(error) if was_running && !process_state.is_shutting_down() => {
                    match start_core_process_inner(process_state.inner(), &config) {
                        Ok(()) => Err(error),
                        Err(resume_error) => Err(format!(
                            "{error}; failed to start the previous kernel again: {resume_error}"
                        )),
                    }
                }
                other => other,
            };
            emit_current_core_status(&app, process_state.inner(), config.port);
            swap_and_restore.map(|()| CoreInstallResult {
                version: staged.version,
                asset_name: staged.asset_name,
                install_dir: path_to_string(&staged.install_dir),
                binary_path: Some(path_to_string(
                    &staged.install_dir.join(&staged.binary_relative_path),
                )),
            })
        });

        if result.is_err() {
            let _ = cleanup_core_work_dirs();
        }
        state.finish(&window, result.clone());

        result
    })
    .await
    .map_err(|error| format!("Kernel installation background task failed: {error}"))?
}

pub(super) fn install_core_with_runtime_restore<F>(
    app: &tauri::AppHandle,
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
    install: F,
) -> Result<CoreInstallResult, String>
where
    F: FnOnce() -> Result<CoreInstallResult, String>,
{
    let config = gui_config_state.snapshot()?;
    crate::core_connection::require_local(&config)?;
    let was_running = pause_core_for_install(app, process_state, &config)?;
    let result = install();
    restore_core_after_install(app, process_state, &config, was_running, result)
}

pub(super) fn pause_core_for_install(
    app: &tauri::AppHandle,
    process_state: &CoreProcessState,
    config: &GuiConfigFile,
) -> Result<bool, String> {
    crate::core_connection::require_local(config)?;
    let was_running = pause_core_process_for_install(process_state)?;
    if was_running {
        emit_current_core_status(app, process_state, config.port);
    }
    Ok(was_running)
}

pub(crate) fn pause_core_process_for_install(
    process_state: &CoreProcessState,
) -> Result<bool, String> {
    process_state.ensure_active()?;
    let was_running = current_core_status(Some(process_state), None)?.running
        || process_state.recovery.wants_running();
    process_state.disarm_supervision();
    if was_running {
        stop_core_process_inner(process_state)?;
    }
    Ok(was_running)
}

pub(super) fn restore_core_after_install<T>(
    app: &tauri::AppHandle,
    process_state: &CoreProcessState,
    config: &GuiConfigFile,
    was_running: bool,
    install_result: Result<T, String>,
) -> Result<T, String> {
    let restart_result = if was_running && !process_state.is_shutting_down() {
        start_core_process_inner(process_state, config)
    } else {
        Ok(())
    };
    emit_current_core_status(app, process_state, config.port);
    combine_install_and_restart_results(install_result, restart_result)
}

pub(crate) fn combine_install_and_restart_results<T>(
    install_result: Result<T, String>,
    restart_result: Result<(), String>,
) -> Result<T, String> {
    match (install_result, restart_result) {
        (Ok(result), Ok(())) => Ok(result),
        (Ok(_), Err(restart_error)) => {
            Err(format!("Kernel installed, but failed to automatically resume operation: {restart_error}"))
        }
        (Err(install_error), Ok(())) => Err(install_error),
        (Err(install_error), Err(restart_error)) => Err(format!(
            "{install_error}; failed to automatically restore the previous kernel running state: {restart_error}"
        )),
    }
}

pub(super) fn emit_current_core_status(app: &tauri::AppHandle, process_state: &CoreProcessState, port: u16) {
    if let Ok(status) = current_core_status(Some(process_state), Some(port)) {
        emit_core_status(app, &status);
    }
}
