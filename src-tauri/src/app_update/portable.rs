use super::*;

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn preflight_portable_update_directory(app_dir: &Path) -> Result<(), String> {
    if !app_dir.join(CORE_VERSION_FILE).is_file() || !app_dir.join("cpa-core").is_dir() {
        return Err("The current portable directory is incomplete. Download the latest full package to upgrade".to_string());
    }
    let probe = app_dir.join(format!(
        ".easycliproxy-update-write-test-{}",
        std::process::id()
    ));
    fs::write(&probe, b"update-write-test")
        .map_err(|error| format!("Application directory is not writable; automatic upgrade is unavailable: {error}"))?;
    fs::remove_file(&probe).map_err(|error| format!("Failed to clean up application update write test: {error}"))?;
    let core_probe = app_dir.join("cpa-core").join(format!(
        ".easycliproxy-update-write-test-{}",
        std::process::id()
    ));
    fs::write(&core_probe, b"update-write-test")
        .map_err(|error| format!("Bundled kernel directory is not writable; automatic upgrade is unavailable: {error}"))?;
    fs::remove_file(&core_probe)
        .map_err(|error| format!("Failed to clean up bundled kernel update write test: {error}"))?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn wait_for_windows_process_exit(
    process_id: u32,
    timeout: Duration,
) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_FAILED, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, WaitForSingleObject},
    };

    const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
    let handle = unsafe { OpenProcess(SYNCHRONIZE_ACCESS, 0, process_id) };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(87) {
            return Ok(());
        }
        return Err(format!("Failed to open legacy application process: {error}"));
    }
    let timeout_ms = timeout.as_millis().min(u32::MAX as u128) as u32;
    let result = unsafe { WaitForSingleObject(handle, timeout_ms) };
    unsafe { CloseHandle(handle) };
    if result == WAIT_TIMEOUT {
        return Err("Timed out waiting for legacy application to exit".to_string());
    }
    if result == WAIT_FAILED {
        return Err(format!(
            "Failed while waiting for legacy application to exit: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn wait_for_portable_parent_exit(pid: u32, timeout: Duration) -> Result<(), String> {
    wait_for_windows_process_exit(pid, timeout)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn wait_for_portable_parent_exit(pid: u32, timeout: Duration) -> Result<(), String> {
    if crate::process_signal::process_id(pid).is_err() {
        return Err("Invalid application update parent process ID".to_string());
    }
    let deadline = Instant::now() + timeout;
    loop {
        if let Err(error) = crate::process_signal::signal_process(pid, 0) {
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            if error.raw_os_error() != Some(libc::EPERM) {
                return Err(format!("Failed to check legacy application process: {error}"));
            }
        }
        if Instant::now() >= deadline {
            return Err("Timed out waiting for legacy application to exit".to_string());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn validate_portable_update_descriptor(
    descriptor_path: &Path,
    descriptor: &PortableUpdateDescriptor,
) -> Result<(), String> {
    if descriptor.parent_pid == 0
        || semver::Version::parse(descriptor.target_version.trim().trim_start_matches('v')).is_err()
    {
        return Err("Invalid application update descriptor".to_string());
    }
    let app_dir = descriptor
        .current_exe
        .parent()
        .ok_or_else(|| "Invalid application update target path".to_string())?;
    if !descriptor.current_exe.is_absolute()
        || descriptor.current_exe != app_dir.join(PORTABLE_APP_BINARY)
        || descriptor.current_manifest != app_dir.join(PORTABLE_APP_MANIFEST_FILE)
        || descriptor.backup_exe != app_dir.join(portable_update_backup_executable_name())
        || descriptor.backup_manifest != app_dir.join(".portable-app.json.update-backup")
        || descriptor.current_core_version != app_dir.join(CORE_VERSION_FILE)
        || descriptor.backup_core_version != app_dir.join(".core-version.txt.update-backup")
    {
        return Err("Invalid application update target path".to_string());
    }
    let core_archive_name = descriptor
        .staged_core_archive
        .file_name()
        .ok_or_else(|| "Invalid application update bundled kernel filename".to_string())?;
    if descriptor.target_core_archive != app_dir.join("cpa-core").join(core_archive_name)
        || !core_archive_name
            .to_string_lossy()
            .starts_with("CLIProxyAPI_")
        || !core_archive_name
            .to_string_lossy()
            .ends_with(portable_update_core_archive_suffix())
        || descriptor.install_core_archive == descriptor.target_core_archive.is_file()
    {
        return Err("Invalid application update bundled kernel target path".to_string());
    }
    let canonical_work_dir = fs::canonicalize(&descriptor.work_dir)
        .map_err(|error| format!("Failed to read application update temporary directory: {error}"))?;
    let canonical_temp_dir = fs::canonicalize(env::temp_dir())
        .map_err(|error| format!("Failed to read system temporary directory: {error}"))?;
    if !canonical_work_dir.starts_with(&canonical_temp_dir)
        || !canonical_work_dir
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with("EasyCLIProxyAPI-update-"))
    {
        return Err("Invalid application update working directory".to_string());
    }
    let canonical_descriptor = fs::canonicalize(descriptor_path)
        .map_err(|error| format!("Failed to read application update descriptor path: {error}"))?;
    if canonical_descriptor.parent() != Some(canonical_work_dir.as_path())
        || canonical_descriptor
            .file_name()
            .and_then(|value| value.to_str())
            != Some("update-descriptor.json")
        || descriptor.ack_path != descriptor.work_dir.join("update-started.ack")
    {
        return Err("Application update descriptor path is out of bounds".to_string());
    }
    for staged in [
        &descriptor.staged_exe,
        &descriptor.staged_manifest,
        &descriptor.staged_core_version,
        &descriptor.staged_core_archive,
    ] {
        let canonical = fs::canonicalize(staged)
            .map_err(|error| format!("Failed to read application update staging file: {error}"))?;
        if !canonical.starts_with(&canonical_work_dir) {
            return Err("Application update staging path is out of bounds".to_string());
        }
    }
    if descriptor.staged_exe
        != descriptor
            .work_dir
            .join("staging")
            .join(PORTABLE_APP_BINARY)
        || descriptor.staged_manifest
            != descriptor
                .work_dir
                .join("staging")
                .join(PORTABLE_APP_MANIFEST_FILE)
        || descriptor.staged_core_version
            != descriptor.work_dir.join("staging").join(CORE_VERSION_FILE)
        || descriptor.staged_core_archive
            != descriptor
                .work_dir
                .join("staging")
                .join("cpa-core")
                .join(core_archive_name)
    {
        return Err("Invalid application update staging path".to_string());
    }
    Ok(())
}

#[cfg(any(windows, target_os = "linux"))]
fn portable_update_backup_executable_name() -> &'static str {
    if cfg!(windows) {
        ".EasyCLIProxyAPI.exe.update-backup"
    } else {
        ".EasyCLIProxyAPI.update-backup"
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn portable_update_replacement_executable_name() -> &'static str {
    if cfg!(windows) {
        ".EasyCLIProxyAPI.exe.update-new"
    } else {
        ".EasyCLIProxyAPI.update-new"
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn portable_update_core_archive_suffix() -> &'static str {
    if cfg!(windows) {
        ".zip"
    } else {
        ".tar.gz"
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn restore_portable_update_backup(
    descriptor: &PortableUpdateDescriptor,
) -> Result<(), String> {
    if !descriptor.backup_exe.is_file()
        || !descriptor.backup_manifest.is_file()
        || !descriptor.backup_core_version.is_file()
    {
        return Err("Application update backup is incomplete; cannot roll back".to_string());
    }
    if descriptor.current_exe.exists() {
        fs::remove_file(&descriptor.current_exe)
            .map_err(|error| format!("Failed to remove new application version: {error}"))?;
    }
    fs::rename(&descriptor.backup_exe, &descriptor.current_exe)
        .map_err(|error| format!("Failed to restore old application version: {error}"))?;
    if descriptor.current_manifest.exists() {
        fs::remove_file(&descriptor.current_manifest)
            .map_err(|error| format!("Failed to remove new portable version marker: {error}"))?;
    }
    fs::rename(&descriptor.backup_manifest, &descriptor.current_manifest)
        .map_err(|error| format!("Failed to restore old portable version marker: {error}"))?;
    if descriptor.current_core_version.exists() {
        fs::remove_file(&descriptor.current_core_version)
            .map_err(|error| format!("Failed to remove new kernel version file: {error}"))?;
    }
    fs::rename(
        &descriptor.backup_core_version,
        &descriptor.current_core_version,
    )
    .map_err(|error| format!("Failed to restore old kernel version file: {error}"))?;
    if descriptor.install_core_archive && descriptor.target_core_archive.exists() {
        fs::remove_file(&descriptor.target_core_archive)
            .map_err(|error| format!("Failed to remove new bundled kernel archive: {error}"))?;
    }
    Ok(())
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn replace_portable_update_files(
    descriptor: &PortableUpdateDescriptor,
) -> Result<(), String> {
    let app_dir = descriptor
        .current_exe
        .parent()
        .ok_or_else(|| "Invalid application update target path".to_string())?;
    let replacement_exe = app_dir.join(portable_update_replacement_executable_name());
    let replacement_manifest = app_dir.join(".portable-app.json.update-new");
    let replacement_core_version = app_dir.join(".core-version.txt.update-new");
    let replacement_core_archive = app_dir.join(".cpa-core-archive.update-new");
    let _ = fs::remove_file(&replacement_exe);
    let _ = fs::remove_file(&replacement_manifest);
    let _ = fs::remove_file(&replacement_core_version);
    let _ = fs::remove_file(&replacement_core_archive);
    fs::copy(&descriptor.staged_exe, &replacement_exe)
        .map_err(|error| format!("Failed to prepare new application executable: {error}"))?;
    if let Err(error) = fs::copy(&descriptor.staged_manifest, &replacement_manifest) {
        let _ = fs::remove_file(&replacement_exe);
        return Err(format!("Failed to prepare new portable version marker: {error}"));
    }
    if let Err(error) = fs::copy(&descriptor.staged_core_version, &replacement_core_version) {
        let _ = fs::remove_file(&replacement_exe);
        let _ = fs::remove_file(&replacement_manifest);
        return Err(format!("Failed to prepare new kernel version file: {error}"));
    }
    if descriptor.install_core_archive {
        if let Err(error) = fs::copy(&descriptor.staged_core_archive, &replacement_core_archive) {
            let _ = fs::remove_file(&replacement_exe);
            let _ = fs::remove_file(&replacement_manifest);
            let _ = fs::remove_file(&replacement_core_version);
            return Err(format!("Failed to prepare new bundled kernel archive: {error}"));
        }
    }

    let _ = fs::remove_file(&descriptor.backup_exe);
    let _ = fs::remove_file(&descriptor.backup_manifest);
    let _ = fs::remove_file(&descriptor.backup_core_version);
    if let Err(error) = fs::rename(&descriptor.current_exe, &descriptor.backup_exe) {
        let _ = fs::remove_file(&replacement_exe);
        let _ = fs::remove_file(&replacement_manifest);
        let _ = fs::remove_file(&replacement_core_version);
        let _ = fs::remove_file(&replacement_core_archive);
        return Err(format!("Failed to back up old application version: {error}"));
    }
    if let Err(error) = fs::rename(&descriptor.current_manifest, &descriptor.backup_manifest) {
        let _ = fs::rename(&descriptor.backup_exe, &descriptor.current_exe);
        let _ = fs::remove_file(&replacement_exe);
        let _ = fs::remove_file(&replacement_manifest);
        let _ = fs::remove_file(&replacement_core_version);
        let _ = fs::remove_file(&replacement_core_archive);
        return Err(format!("Failed to back up portable version marker: {error}"));
    }
    if let Err(error) = fs::rename(
        &descriptor.current_core_version,
        &descriptor.backup_core_version,
    ) {
        let _ = fs::rename(&descriptor.backup_manifest, &descriptor.current_manifest);
        let _ = fs::rename(&descriptor.backup_exe, &descriptor.current_exe);
        let _ = fs::remove_file(&replacement_exe);
        let _ = fs::remove_file(&replacement_manifest);
        let _ = fs::remove_file(&replacement_core_version);
        let _ = fs::remove_file(&replacement_core_archive);
        return Err(format!("Failed to back up old kernel version file: {error}"));
    }

    let replace_result = (|| -> Result<(), String> {
        fs::rename(&replacement_exe, &descriptor.current_exe)
            .map_err(|error| format!("Failed to replace application executable: {error}"))?;
        fs::rename(&replacement_manifest, &descriptor.current_manifest)
            .map_err(|error| format!("Failed to replace portable version marker: {error}"))?;
        fs::rename(&replacement_core_version, &descriptor.current_core_version)
            .map_err(|error| format!("Failed to replace kernel version file: {error}"))?;
        if descriptor.install_core_archive {
            fs::rename(&replacement_core_archive, &descriptor.target_core_archive)
                .map_err(|error| format!("Failed to install new bundled kernel archive: {error}"))?;
        }
        Ok(())
    })();
    if let Err(error) = replace_result {
        let _ = fs::remove_file(&replacement_exe);
        let _ = fs::remove_file(&replacement_manifest);
        let _ = fs::remove_file(&replacement_core_version);
        let _ = fs::remove_file(&replacement_core_archive);
        restore_portable_update_backup(descriptor)
            .map_err(|rollback| format!("{error}；{rollback}"))?;
        return Err(error);
    }
    Ok(())
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn cleanup_superseded_bundled_core_archives(descriptor: &PortableUpdateDescriptor) {
    let Some(core_dir) = descriptor.target_core_archive.parent() else {
        return;
    };
    let Some(current_name) = descriptor
        .target_core_archive
        .file_name()
        .and_then(|value| value.to_str())
    else {
        return;
    };
    let Ok(entries) = fs::read_dir(core_dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_file()
            && name != current_name
            && name.starts_with("CLIProxyAPI_")
            && name.ends_with(portable_update_core_archive_suffix())
            && !name.contains("_no-plugin")
        {
            if let Err(error) = fs::remove_file(&path) {
                eprintln!(
                    "Failed to clean up old bundled kernel archive {}: {error}",
                    path_to_string(&path)
                );
            }
        }
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn cleanup_portable_update_payload(
    descriptor_path: &Path,
    descriptor: &PortableUpdateDescriptor,
) {
    let _ = fs::remove_file(descriptor.work_dir.join(if cfg!(windows) {
        "update.zip"
    } else {
        "update.tar.gz"
    }));
    let _ = fs::remove_dir_all(descriptor.work_dir.join("staging"));
    let _ = fs::remove_file(&descriptor.ack_path);
    let _ = fs::remove_file(portable_update_helper_ack_path(&descriptor.work_dir));
    let _ = fs::remove_file(descriptor_path);
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn run_portable_update_helper(descriptor_path: &Path) -> Result<(), String> {
    let descriptor = serde_json::from_slice::<PortableUpdateDescriptor>(
        &fs::read(descriptor_path).map_err(|error| format!("Failed to read application update descriptor: {error}"))?,
    )
    .map_err(|error| format!("Failed to parse application update descriptor: {error}"))?;
    validate_portable_update_descriptor(descriptor_path, &descriptor)?;
    acknowledge_portable_update_helper_start(&descriptor.work_dir)?;
    if let Err(error) =
        wait_for_portable_parent_exit(descriptor.parent_pid, Duration::from_secs(120))
    {
        cleanup_portable_update_payload(descriptor_path, &descriptor);
        return Err(error);
    }

    if let Err(error) = replace_portable_update_files(&descriptor) {
        let mut rollback = Command::new(&descriptor.current_exe);
        configure_background_command(&mut rollback);
        let _ = rollback.spawn();
        cleanup_portable_update_payload(descriptor_path, &descriptor);
        return Err(error);
    }

    let _ = fs::remove_file(&descriptor.ack_path);
    let mut command = Command::new(&descriptor.current_exe);
    command
        .arg("--portable-update-ack")
        .arg(&descriptor.ack_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_background_command(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            restore_portable_update_backup(&descriptor)?;
            let mut rollback = Command::new(&descriptor.current_exe);
            configure_background_command(&mut rollback);
            let _ = rollback.spawn();
            cleanup_portable_update_payload(descriptor_path, &descriptor);
            return Err(format!("Failed to start new application version: {error}"));
        }
    };

    let deadline = Instant::now() + Duration::from_secs(60);
    let mut confirmed = false;
    while Instant::now() < deadline {
        if descriptor.ack_path.is_file() {
            confirmed = true;
            break;
        }
        if child
            .try_wait()
            .map_err(|error| format!("Failed to check new application version status: {error}"))?
            .is_some()
        {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }

    if confirmed {
        let _ = fs::remove_file(&descriptor.backup_exe);
        let _ = fs::remove_file(&descriptor.backup_manifest);
        let _ = fs::remove_file(&descriptor.backup_core_version);
        cleanup_superseded_bundled_core_archives(&descriptor);
        cleanup_portable_update_payload(descriptor_path, &descriptor);
        return Ok(());
    }

    let _ = child.kill();
    let _ = child.wait();
    restore_portable_update_backup(&descriptor)?;
    let mut rollback = Command::new(&descriptor.current_exe);
    configure_background_command(&mut rollback);
    let _ = rollback.spawn();
    cleanup_portable_update_payload(descriptor_path, &descriptor);
    Err(format!(
        "New application version {} did not confirm startup within 60 seconds; rolled back",
        descriptor.target_version
    ))
}
