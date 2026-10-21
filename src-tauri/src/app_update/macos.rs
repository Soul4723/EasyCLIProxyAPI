use super::*;

#[cfg(any(target_os = "macos", test))]
pub(crate) fn macos_update_command_timeout(command: &Command) -> Duration {
    let program = command.get_program();
    if program == "diskutil" {
        return Duration::from_secs(10);
    }
    if program == "hdiutil"
        && command
            .get_args()
            .next()
            .is_some_and(|arg| arg == "detach")
    {
        return Duration::from_secs(15);
    }
    Duration::from_secs(120)
}

// Commands can leave descendants holding their output pipes after exiting. Read
// nonblocking pipes on the calling thread so the same deadline covers both the
// process and EOF, without leaving detached reader threads behind.
#[cfg(any(target_os = "macos", all(unix, test)))]
fn set_macos_update_pipe_nonblocking(pipe: &impl std::os::fd::AsRawFd) -> std::io::Result<()> {
    let fd = pipe.as_raw_fd();
    // SAFETY: the pipe owns a live descriptor for the duration of both calls.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn drain_macos_update_output(
    pipe: &mut impl std::io::Read,
    output: &mut Vec<u8>,
) -> std::io::Result<bool> {
    let mut buffer = [0; 4096];
    // Bound both retained diagnostics and work per poll. A continuously writing
    // process must not starve the other pipe or the deadline check.
    for _ in 0..16 {
        match pipe.read(&mut buffer) {
            Ok(0) => return Ok(true),
            Ok(count) => {
                let keep = count.min((64 * 1024usize).saturating_sub(output.len()));
                output.extend_from_slice(&buffer[..keep]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(false)
}

#[cfg(any(target_os = "macos", all(unix, test)))]
pub(crate) fn run_macos_update_command_with_timeout(
    command: &mut Command,
    action: &str,
    timeout: Duration,
) -> Result<(), String> {
    use std::os::unix::process::CommandExt;

    command
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to {action}: {error}"))?;
    let mut stdout = child.stdout.take().expect("stdout was piped");
    let mut stderr = child.stderr.take().expect("stderr was piped");
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let deadline = Instant::now() + timeout;
    let result = (|| -> Result<_, String> {
        set_macos_update_pipe_nonblocking(&stdout)
            .and_then(|_| set_macos_update_pipe_nonblocking(&stderr))
            .map_err(|error| format!("Failed to read {action} output: {error}"))?;
        let mut status = None;
        let mut stdout_eof = false;
        let mut stderr_eof = false;
        loop {
            if !stdout_eof {
                stdout_eof = drain_macos_update_output(&mut stdout, &mut stdout_bytes)
                    .map_err(|error| format!("Failed to read {action} output: {error}"))?;
            }
            if !stderr_eof {
                stderr_eof = drain_macos_update_output(&mut stderr, &mut stderr_bytes)
                    .map_err(|error| format!("Failed to read {action} output: {error}"))?;
            }
            if status.is_none() {
                status = child
                    .try_wait()
                    .map_err(|error| format!("Failed to {action}: {error}"))?;
            }
            if stdout_eof && stderr_eof {
                if let Some(status) = status {
                    return Ok(status);
                }
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "Failed to {action}: timed out after {}s",
                    timeout.as_secs_f64()
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    })();
    if result.is_err() {
        // The group is private to this command. Kill descendants too, including
        // when the direct child has already exited but a pipe is still open.
        // SAFETY: spawn succeeded with process_group(0), so this is its group ID.
        let _ = crate::process_signal::signal_group(child.id(), libc::SIGKILL);
        let _ = child.kill();
        let _ = child.wait();
    }
    let status = result?;
    if status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&stderr_bytes);
    let stdout = String::from_utf8_lossy(&stdout_bytes);
    let details = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    Err(format!("Failed to {action} ({status}): {details}"))
}

#[cfg(target_os = "macos")]
fn run_macos_update_command(command: &mut Command, action: &str) -> Result<(), String> {
    let timeout = macos_update_command_timeout(command);
    run_macos_update_command_with_timeout(command, action, timeout)
}

#[cfg(target_os = "macos")]
pub(crate) fn stage_macos_application_from_dmg(
    dmg_path: &Path,
    work_dir: &Path,
    staged_app: &Path,
) -> Result<(), String> {
    stage_macos_application_from_dmg_with_commands(
        dmg_path,
        work_dir,
        staged_app,
        run_macos_update_command,
        thread::sleep,
    )
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn stage_macos_application_from_dmg_with_commands(
    dmg_path: &Path,
    work_dir: &Path,
    staged_app: &Path,
    mut run: impl FnMut(&mut Command, &str) -> Result<(), String>,
    mut wait: impl FnMut(Duration),
) -> Result<(), String> {
    let mount_dir = work_dir.join("mount");
    fs::create_dir_all(&mount_dir).map_err(|error| format!("Failed to create DMG mount directory: {error}"))?;
    let mut attach = Command::new("hdiutil");
    attach
        .arg("attach")
        .arg(dmg_path)
        .args(["-nobrowse", "-readonly", "-mountpoint"])
        .arg(&mount_dir);
    run(&mut attach, "Mount application update DMG")?;

    let source_app = mount_dir.join(APP_BUNDLE_NAME);
    let stage_result = (|| -> Result<(), String> {
        if !source_app.is_dir() {
            return Err(format!("Application update DMG is missing {APP_BUNDLE_NAME}"));
        }
        let staging_parent = staged_app
            .parent()
            .ok_or_else(|| "Invalid application update staging path".to_string())?;
        fs::create_dir_all(staging_parent)
            .map_err(|error| format!("Failed to create application update staging directory: {error}"))?;
        let mut ditto = Command::new("ditto");
        ditto.arg(&source_app).arg(staged_app);
        run(&mut ditto, "Stage new macOS application")?;
        let mut codesign = Command::new("codesign");
        codesign
            .args(["--verify", "--deep", "--strict"])
            .arg(staged_app);
        run(&mut codesign, "Verify new macOS application signature")?;
        if require_macos_notarization() {
            let mut gatekeeper = Command::new("spctl");
            gatekeeper
                .args(["--assess", "--type", "execute", "--verbose=2"])
                .arg(staged_app);
            run(&mut gatekeeper, "Verify new macOS application system trust status")?;
        }
        Ok(())
    })();

    match eject_macos_update_dmg_with_commands(&mount_dir, &mut run, &mut wait) {
        Ok(()) => {
            let _ = fs::remove_dir(&mount_dir);
        }
        Err(error) => {
            // A successfully staged app no longer depends on the read-only DMG.
            // Preserve staging errors, but never fail an update just for cleanup.
            eprintln!("Application update DMG cleanup deferred: {error}");
        }
    }
    stage_result
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn eject_macos_update_dmg_with_commands(
    mount_dir: &Path,
    mut run: impl FnMut(&mut Command, &str) -> Result<(), String>,
    mut wait: impl FnMut(Duration),
) -> Result<(), String> {
    let mut last_error = String::new();
    // Spotlight or security scanning can briefly hold the newly mounted image busy.
    // However, if diskutil times out (e.g. wedged storagekitd XPC daemon), skip
    // remaining diskutil attempts and immediately fall back to hdiutil detach.
    for attempt in 0..3 {
        if attempt > 0 {
            wait(Duration::from_millis(500));
        }
        let mut eject = Command::new("diskutil");
        eject.arg("eject").arg(mount_dir);
        match run(&mut eject, "Eject application update DMG") {
            Ok(()) => return Ok(()),
            Err(error) => {
                if error.contains("Unable to find disk")
                    || error.contains("Failed to find disk")
                {
                    return Ok(());
                }
                let stop_retrying = error.contains("timed out");
                last_error = error;
                if stop_retrying {
                    break;
                }
            }
        }
    }

    // Compatibility fallback, limited to this updater's private read-only mount.
    let mut detach = Command::new("hdiutil");
    detach.args(["detach", "-force"]).arg(mount_dir);
    run(&mut detach, "Force unmount application update DMG")
        .map_err(|error| format!("{last_error}; {error}"))
}

#[cfg(target_os = "macos")]
pub(super) fn cleanup_macos_update_dmg(work_dir: &Path) {
    cleanup_macos_update_dmg_with_commands(work_dir, run_macos_update_command, thread::sleep);
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn cleanup_macos_update_dmg_with_commands(
    work_dir: &Path,
    run: impl FnMut(&mut Command, &str) -> Result<(), String>,
    wait: impl FnMut(Duration),
) {
    let mount_dir = work_dir.join("mount");
    if mount_dir.exists() {
        if let Err(error) = eject_macos_update_dmg_with_commands(&mount_dir, run, wait) {
            if fs::remove_dir(&mount_dir).is_err() {
                eprintln!("Application update DMG cleanup deferred: {error}");
                return;
            }
        } else {
            let _ = fs::remove_dir(&mount_dir);
        }
    }
    let _ = fs::remove_file(work_dir.join("update.dmg"));
}

#[cfg(target_os = "macos")]
pub(crate) fn validate_macos_staged_application(
    staged_app: &Path,
    pending: &PendingAppUpdate,
) -> Result<(), String> {
    let manifest_path = staged_app
        .join("Contents")
        .join("Resources")
        .join(PORTABLE_APP_MANIFEST_FILE);
    let contents = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Failed to read new macOS automatic update marker: {error}"))?;
    let manifest = serde_json::from_str::<PortableAppManifest>(&contents)
        .map_err(|error| format!("Failed to parse new macOS automatic update marker: {error}"))?;
    if manifest.schema_version != 1
        || manifest.application != "EasyCLIProxyAPI"
        || manifest.platform != "darwin"
        || manifest.arch != pending.arch
        || !manifest.auto_update
        || normalize_version(&manifest.version) != normalize_version(&pending.version)
    {
        return Err("New macOS application marker does not match the update target".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_application_bundle_from_executable(
    executable: &Path,
) -> Result<PathBuf, String> {
    let macos_dir = executable
        .parent()
        .filter(|path| path.file_name().and_then(|name| name.to_str()) == Some("MacOS"))
        .ok_or_else(|| "Current executable is not inside a standard macOS application bundle".to_string())?;
    let contents_dir = macos_dir
        .parent()
        .filter(|path| path.file_name().and_then(|name| name.to_str()) == Some("Contents"))
        .ok_or_else(|| "Current executable is not inside a standard macOS application bundle".to_string())?;
    let app = contents_dir
        .parent()
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
        .ok_or_else(|| "Current executable is not inside a standard macOS application bundle".to_string())?;
    Ok(app.to_path_buf())
}

#[cfg(target_os = "macos")]
pub(crate) fn preflight_macos_update_directory(current_app: &Path) -> Result<(), String> {
    if !current_app.is_dir() {
        return Err("Current macOS application bundle does not exist".to_string());
    }
    let app_parent = current_app
        .parent()
        .ok_or_else(|| "macOS application bundle has no parent directory".to_string())?;
    let probe = app_parent.join(format!(
        ".easycliproxy-update-write-test-{}",
        std::process::id()
    ));
    fs::write(&probe, b"update-write-test")
        .map_err(|error| format!("macOS application directory is not writable; automatic upgrade is unavailable: {error}"))?;
    fs::remove_file(&probe).map_err(|error| format!("Failed to clean up application update write test: {error}"))
}

#[cfg(target_os = "macos")]
pub(crate) fn validate_macos_update_descriptor(
    descriptor_path: &Path,
    descriptor: &MacosUpdateDescriptor,
) -> Result<(), String> {
    if descriptor.parent_pid == 0
        || semver::Version::parse(descriptor.target_version.trim().trim_start_matches('v')).is_err()
        || !descriptor.current_app.is_absolute()
        || descriptor
            .current_app
            .extension()
            .and_then(|value| value.to_str())
            != Some("app")
    {
        return Err("Invalid macOS application update descriptor".to_string());
    }
    let app_parent = descriptor
        .current_app
        .parent()
        .ok_or_else(|| "Invalid macOS application update target path".to_string())?;
    if descriptor.backup_app != app_parent.join(format!(".{APP_BUNDLE_NAME}.update-backup"))
        || descriptor.executable_relative_path.is_absolute()
        || descriptor
            .executable_relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || !descriptor
            .executable_relative_path
            .starts_with(Path::new("Contents").join("MacOS"))
    {
        return Err("Invalid macOS application update target path".to_string());
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
    let canonical_staged_app = fs::canonicalize(&descriptor.staged_app)
        .map_err(|error| format!("Failed to read new macOS application path: {error}"))?;
    if canonical_descriptor.parent() != Some(canonical_work_dir.as_path())
        || canonical_descriptor
            .file_name()
            .and_then(|value| value.to_str())
            != Some("update-descriptor.json")
        || descriptor.staged_app
            != descriptor
                .work_dir
                .join("staging")
                .join(APP_BUNDLE_NAME)
        || !canonical_staged_app.starts_with(&canonical_work_dir)
        || descriptor.ack_path != descriptor.work_dir.join("update-started.ack")
    {
        return Err("macOS application update staging path is out of bounds".to_string());
    }
    if !descriptor
        .current_app
        .join(&descriptor.executable_relative_path)
        .is_file()
        || !descriptor
            .staged_app
            .join(&descriptor.executable_relative_path)
            .is_file()
    {
        return Err("macOS application update executable is missing".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn restore_macos_update_backup(
    descriptor: &MacosUpdateDescriptor,
) -> Result<(), String> {
    if !descriptor.backup_app.is_dir() {
        return Err("macOS application update backup is incomplete; cannot roll back".to_string());
    }
    if descriptor.current_app.exists() {
        fs::remove_dir_all(&descriptor.current_app)
            .map_err(|error| format!("Failed to remove new macOS application: {error}"))?;
    }
    fs::rename(&descriptor.backup_app, &descriptor.current_app)
        .map_err(|error| format!("Failed to restore old macOS application: {error}"))
}

#[cfg(target_os = "macos")]
pub(crate) fn replace_macos_application(descriptor: &MacosUpdateDescriptor) -> Result<(), String> {
    let app_parent = descriptor
        .current_app
        .parent()
        .ok_or_else(|| "Invalid macOS application update target path".to_string())?;
    let replacement_app = app_parent.join(format!(".{}-update-new.app", APP_BUNDLE_NAME.trim_end_matches(".app")));
    let legacy_replacement_app = app_parent.join(format!(".{APP_BUNDLE_NAME}.update-new"));
    if legacy_replacement_app.exists() {
        fs::remove_dir_all(&legacy_replacement_app)
            .map_err(|error| format!("Failed to clean up legacy macOS update staging data: {error}"))?;
    }
    if replacement_app.exists() {
        fs::remove_dir_all(&replacement_app)
            .map_err(|error| format!("Failed to clean up old macOS update staging data: {error}"))?;
    }
    let mut ditto = Command::new("ditto");
    ditto.arg(&descriptor.staged_app).arg(&replacement_app);
    run_macos_update_command(&mut ditto, "Prepare new macOS application")?;
    let mut codesign = Command::new("codesign");
    codesign
        .args(["--verify", "--deep", "--strict"])
        .arg(&replacement_app);
    if let Err(error) = run_macos_update_command(&mut codesign, "Verify replacement macOS application signature")
    {
        let _ = fs::remove_dir_all(&replacement_app);
        return Err(error);
    }
    if require_macos_notarization() {
        let mut gatekeeper = Command::new("spctl");
        gatekeeper
            .args(["--assess", "--type", "execute", "--verbose=2"])
            .arg(&replacement_app);
        if let Err(error) =
            run_macos_update_command(&mut gatekeeper, "Verify replacement macOS application system trust status")
        {
            let _ = fs::remove_dir_all(&replacement_app);
            return Err(error);
        }
    }
    if descriptor.backup_app.exists() {
        fs::remove_dir_all(&descriptor.backup_app)
            .map_err(|error| format!("Failed to clean up old macOS application backup: {error}"))?;
    }
    fs::rename(&descriptor.current_app, &descriptor.backup_app)
        .map_err(|error| format!("Failed to back up old macOS application: {error}"))?;
    if let Err(error) = fs::rename(&replacement_app, &descriptor.current_app) {
        let _ = fs::rename(&descriptor.backup_app, &descriptor.current_app);
        let _ = fs::remove_dir_all(&replacement_app);
        return Err(format!("Failed to replace macOS application: {error}"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn cleanup_macos_update_payload(descriptor_path: &Path, descriptor: &MacosUpdateDescriptor) {
    cleanup_macos_update_dmg(&descriptor.work_dir);
    let _ = fs::remove_dir_all(descriptor.work_dir.join("staging"));
    let _ = fs::remove_file(&descriptor.ack_path);
    let _ = fs::remove_file(portable_update_helper_ack_path(&descriptor.work_dir));
    let _ = fs::remove_file(descriptor_path);
    let _ = fs::remove_dir(&descriptor.work_dir);
}

#[cfg(target_os = "macos")]
pub(crate) fn run_portable_update_helper(descriptor_path: &Path) -> Result<(), String> {
    let descriptor = serde_json::from_slice::<MacosUpdateDescriptor>(
        &fs::read(descriptor_path).map_err(|error| format!("Failed to read application update descriptor: {error}"))?,
    )
    .map_err(|error| format!("Failed to parse application update descriptor: {error}"))?;
    validate_macos_update_descriptor(descriptor_path, &descriptor)?;
    acknowledge_portable_update_helper_start(&descriptor.work_dir)?;
    if let Err(error) =
        wait_for_portable_parent_exit(descriptor.parent_pid, Duration::from_secs(120))
    {
        cleanup_macos_update_payload(descriptor_path, &descriptor);
        return Err(error);
    }
    if let Err(error) = replace_macos_application(&descriptor) {
        let rollback_exe = descriptor
            .current_app
            .join(&descriptor.executable_relative_path);
        let _ = crate::process_spawn::spawn(&mut Command::new(rollback_exe));
        cleanup_macos_update_payload(descriptor_path, &descriptor);
        return Err(error);
    }

    let current_exe = descriptor
        .current_app
        .join(&descriptor.executable_relative_path);
    let _ = fs::remove_file(&descriptor.ack_path);
    let mut command = Command::new(&current_exe);
    command
        .arg("--portable-update-ack")
        .arg(&descriptor.ack_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = match crate::process_spawn::spawn(&mut command) {
        Ok(child) => child,
        Err(error) => {
            restore_macos_update_backup(&descriptor)?;
            let rollback_exe = descriptor
                .current_app
                .join(&descriptor.executable_relative_path);
            let _ = crate::process_spawn::spawn(&mut Command::new(rollback_exe));
            cleanup_macos_update_payload(descriptor_path, &descriptor);
            return Err(format!("Failed to start new macOS application: {error}"));
        }
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if descriptor.ack_path.is_file() {
            let _ = fs::remove_dir_all(&descriptor.backup_app);
            cleanup_macos_update_payload(descriptor_path, &descriptor);
            return Ok(());
        }
        if child
            .try_wait()
            .map_err(|error| format!("Failed to check new macOS application status: {error}"))?
            .is_some()
        {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    let _ = child.kill();
    let _ = child.wait();
    restore_macos_update_backup(&descriptor)?;
    let rollback_exe = descriptor
        .current_app
        .join(&descriptor.executable_relative_path);
    let _ = crate::process_spawn::spawn(&mut Command::new(rollback_exe));
    cleanup_macos_update_payload(descriptor_path, &descriptor);
    Err(format!(
        "New application version {} did not confirm startup within 60 seconds; rolled back",
        descriptor.target_version
    ))
}
