use super::*;

#[allow(clippy::too_many_arguments)] // Preserve the existing command/helper interface in this behavior-neutral cleanup.
pub(crate) async fn stage_core_version_inner(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    state: &CoreDownloadState,
    gui_config_state: &GuiConfigState,
    token: CancellationToken,
    version: Option<String>,
    proxy_url: &str,
    download_source: VersionDownloadCandidate,
    custom_mirrors: Vec<String>,
) -> Result<StagedCoreInstall, String> {
    let platform = current_core_platform()?;
    let client = http_client(proxy_url, &custom_mirrors)?;
    state.progress(window, "Check version", 0, None, true);
    let requested_source = download_source.clone();
    let (release, resolved_source) = fetch_release_cancelable(
        &client,
        version.as_deref(),
        &token,
        download_source,
        &custom_mirrors,
    )
    .await?;
    let asset = select_release_asset(&release, &platform)?;
    let download_candidates = core_download_candidates(
        &release.tag_name,
        asset,
        resolved_source,
        configured_gitcode_core_repository(),
        &custom_mirrors,
    );

    let install_dir = core_install_dir()?;
    let base_dir = core_base_dir()?;
    let staging_dir = base_dir.join("cpa-core.staging");
    let download_dir = base_dir.join("cpa-core.download");

    reset_dir(&staging_dir)?;
    reset_dir(&download_dir)?;

    let archive_file_name = Path::new(&asset.name)
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .ok_or_else(|| format!("Invalid asset filename: {}", asset.name))?;
    let archive_path = download_dir.join(archive_file_name);

    let (downloaded, successful_source) = download_asset(
        &client,
        asset,
        &download_candidates,
        &archive_path,
        window,
        state,
        &token,
    )
    .await?;
    validate_downloaded_asset(asset, &downloaded)?;
    persist_automatic_download_source_switch(
        app,
        gui_config_state,
        &requested_source,
        &successful_source,
    )?;

    ensure_not_cancelled(&token, Some(&archive_path))?;
    state.progress(
        window,
        "Extracting",
        downloaded.size,
        Some(downloaded.size),
        false,
    );
    match platform.archive_kind.as_str() {
        "tar.gz" => extract_tar_gz(&archive_path, &staging_dir)?,
        "zip" => extract_zip(&archive_path, &staging_dir)?,
        other => return Err(format!("Unsupported archive type: {other}")),
    }
    ensure_not_cancelled(&token, Some(&archive_path))?;

    let binary_path = find_core_binary(&staging_dir)
        .ok_or_else(|| "CPA kernel binary was not found after extraction".to_string())?;
    let binary_size = fs::metadata(&binary_path)
        .map_err(|err| format!("Failed to inspect extracted kernel binary: {err}"))?
        .len();
    if binary_size == 0 {
        return Err("Extracted CPA kernel binary is empty".to_string());
    }
    let binary_relative_path = binary_path
        .strip_prefix(&staging_dir)
        .map_err(|err| format!("Failed to calculate relative path of kernel binary: {err}"))?
        .to_path_buf();
    migrate_core_config_for_update(&install_dir, &staging_dir)?;
    preserve_bundled_core_assets(&install_dir, &staging_dir)?;
    write_core_metadata(
        &staging_dir,
        &CoreMetadata {
            version: normalize_version(&release.tag_name),
            asset_name: asset.name.clone(),
            installed_at_unix: unix_now(),
        },
    )?;

    let _ = fs::remove_dir_all(&download_dir);

    Ok(StagedCoreInstall {
        version: normalize_version(&release.tag_name),
        asset_name: asset.name.clone(),
        install_dir,
        staging_dir,
        binary_relative_path,
    })
}

pub(crate) fn install_bundled_core_inner(
    window: &tauri::Window,
    state: &CoreDownloadState,
    info: &BundledCoreInfo,
    archive_path: &Path,
) -> Result<CoreInstallResult, String> {
    let platform = current_core_platform()?;
    let install_dir = core_install_dir()?;
    let base_dir = core_base_dir()?;
    let staging_dir = base_dir.join("cpa-core.staging");

    if current_core_status(None, None)?.running {
        return Err("CPA kernel is running. Stop it before using the bundled kernel".to_string());
    }

    let archive_size = fs::metadata(archive_path)
        .map_err(|error| format!("Failed to read bundled kernel archive: {error}"))?
        .len();
    state.progress(window, "Verify bundled kernel", 0, Some(archive_size), false);
    validate_bundled_core_checksum(archive_path)?;
    reset_dir(&staging_dir)?;
    state.progress(
        window,
        "Extract bundled kernel",
        archive_size,
        Some(archive_size),
        false,
    );
    match platform.archive_kind.as_str() {
        "tar.gz" => extract_tar_gz(archive_path, &staging_dir)?,
        "zip" => extract_zip(archive_path, &staging_dir)?,
        other => return Err(format!("Unsupported bundled archive type: {other}")),
    }

    let binary_path = find_core_binary(&staging_dir)
        .ok_or_else(|| "Bundled archive does not contain a CPA kernel binary".to_string())?;
    let binary_relative_path = binary_path
        .strip_prefix(&staging_dir)
        .map_err(|error| format!("Failed to calculate bundled kernel binary path: {error}"))?
        .to_path_buf();
    migrate_core_config_for_update(&install_dir, &staging_dir)?;
    preserve_bundled_core_assets(&install_dir, &staging_dir)?;
    preserve_selected_bundled_core_asset(archive_path, &staging_dir)?;
    write_core_metadata(
        &staging_dir,
        &CoreMetadata {
            version: info.version.clone(),
            asset_name: info.asset_name.clone(),
            installed_at_unix: unix_now(),
        },
    )?;
    overlay_install_dir(&install_dir, &staging_dir)?;
    mark_bundled_core_version_handled(&install_dir, &info.version)?;

    Ok(CoreInstallResult {
        version: info.version.clone(),
        asset_name: info.asset_name.clone(),
        install_dir: path_to_string(&install_dir),
        binary_path: Some(path_to_string(&install_dir.join(binary_relative_path))),
    })
}
