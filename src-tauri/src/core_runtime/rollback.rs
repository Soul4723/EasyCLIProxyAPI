use super::*;

pub(crate) fn reset_dir(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path)
            .map_err(|err| format!("Failed to clean up directory {}: {err}", path_to_string(path)))?;
    }

    fs::create_dir_all(path).map_err(|err| format!("Failed to create directory {}: {err}", path_to_string(path)))
}

pub(super) const ROLLBACK_FILES_DIR: &str = "files";
pub(super) const ROLLBACK_ADDED_FILES: &str = "added-files.txt";

/// Retain an interrupted update's backup before starting another transaction.
/// Never infer that a backup is disposable from the installed binary's presence:
/// it may be the broken replacement. History is deliberately not auto-deleted.
pub(crate) fn archive_previous_core_rollback(rollback_dir: &Path) -> Result<Option<PathBuf>, String> {
    match fs::symlink_metadata(rollback_dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!(
            "Failed to inspect kernel rollback backup {}: {error}",
            path_to_string(rollback_dir)
        )),
        Ok(_) => {}
    }
    let history = rollback_dir.with_file_name("cpa-core.rollback-history");
    let archive_error = |error: io::Error| format!(
        "Failed to archive previous kernel rollback backup {}: {error}. The backup has been preserved; move it to a safe location before retrying the update",
        path_to_string(rollback_dir)
    );
    fs::create_dir_all(&history).map_err(&archive_error)?;
    // Reserve a unique directory exclusively, so even retries in the same second
    // cannot overwrite any earlier backup. Rename stays on the same filesystem.
    let timestamp = unix_now();
    for sequence in 0..10000 {
        let slot = history.join(format!("{timestamp}-{sequence}"));
        match fs::create_dir(&slot) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(archive_error(error)),
            Ok(()) => {}
        }
        let archived = slot.join("backup");
        if let Err(error) = fs::rename(rollback_dir, &archived) {
            let _ = fs::remove_dir(&slot);
            return Err(archive_error(error));
        }
        eprintln!("Previous kernel rollback backup preserved at {}", path_to_string(&archived));
        return Ok(Some(archived));
    }
    Err(format!("Could not reserve a unique kernel backup directory in {}", path_to_string(&history)))
}

pub(super) fn ensure_core_rollback_available(rollback_dir: &Path) -> Result<(), String> {
    match fs::symlink_metadata(rollback_dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to inspect kernel rollback backup {}: {error}",
            path_to_string(rollback_dir)
        )),
        Ok(_) => Err(format!(
            "A previous kernel rollback backup is still present at {}. Restore it or move it to a safe location before retrying the update; it will not be overwritten",
            path_to_string(rollback_dir)
        )),
    }
}

pub(super) fn cleanup_completed_core_rollback(rollback_dir: &Path) {
    if let Err(error) = fs::remove_dir_all(rollback_dir) {
        if error.kind() != io::ErrorKind::NotFound {
            eprintln!(
                "Kernel transaction completed, but failed to clean up backup {}: {error}. A subsequent update will archive it before proceeding",
                path_to_string(rollback_dir)
            );
        }
    }
}

pub(super) fn collect_relative_files(root: &Path, dir: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir)
        .map_err(|err| format!("Failed to read directory {}: {err}", path_to_string(dir)))?
    {
        let entry = entry.map_err(|err| format!("Failed to read directory entry: {err}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|err| format!("Failed to read directory entry type: {err}"))?;
        if file_type.is_dir() {
            collect_relative_files(root, &path, files)?;
        } else {
            let relative = path
                .strip_prefix(root)
                .map_err(|err| format!("Failed to compute relative path: {err}"))?;
            files.push(relative.to_path_buf());
        }
    }
    Ok(())
}

/// Backs up every installed file that the staged package is about to overwrite and records
/// the files it will add, so a rollback restores the previous installation exactly.
/// Returns `false` when there is no installed kernel to roll back to.
pub(crate) fn backup_core_for_rollback(
    install_dir: &Path,
    staging_dir: &Path,
    rollback_dir: &Path,
) -> Result<bool, String> {
    // Check even if the installed binary is missing: the retained backup may be
    // the only remaining copy of the previous working installation.
    ensure_core_rollback_available(rollback_dir)?;
    let Some(binary_path) = find_core_binary(install_dir) else {
        return Ok(false);
    };
    // Exclusive creation also protects a backup that appears after the check.
    fs::create_dir(rollback_dir).map_err(|error| format!(
        "Failed to create kernel rollback backup {} without overwriting existing files: {error}",
        path_to_string(rollback_dir)
    ))?;
    let files_dir = rollback_dir.join(ROLLBACK_FILES_DIR);

    let mut staged_files = Vec::new();
    collect_relative_files(staging_dir, staging_dir, &mut staged_files)?;
    let installed_binary = binary_path
        .strip_prefix(install_dir)
        .map_err(|err| format!("Failed to compute rollback binary relative path: {err}"))?
        .to_path_buf();
    if !staged_files.contains(&installed_binary) {
        staged_files.push(installed_binary);
    }

    let mut added_files = Vec::new();
    for relative in staged_files {
        let source = install_dir.join(&relative);
        if !source.is_file() {
            added_files.push(path_to_string(&relative));
            continue;
        }
        let target = files_dir.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create rollback directory: {err}"))?;
        }
        copy_core_file_replace(&source, &target)?;
    }
    fs::create_dir_all(&files_dir)
        .map_err(|err| format!("Failed to create rollback directory: {err}"))?;
    fs::write(rollback_dir.join(ROLLBACK_ADDED_FILES), added_files.join("\n"))
        .map_err(|err| format!("Failed to write rollback file list: {err}"))?;
    Ok(true)
}

pub(crate) fn restore_core_rollback(
    install_dir: &Path,
    rollback_dir: &Path,
) -> Result<(), String> {
    let files_dir = rollback_dir.join(ROLLBACK_FILES_DIR);
    if !files_dir.is_dir() {
        return Err(format!(
            "Kernel rollback directory does not exist: {}",
            path_to_string(rollback_dir)
        ));
    }
    overlay_directory(&files_dir, install_dir)?;
    let added_files = fs::read_to_string(rollback_dir.join(ROLLBACK_ADDED_FILES)).unwrap_or_default();
    for relative in added_files.lines().filter(|line| !line.is_empty()) {
        let added = install_dir.join(relative);
        match fs::remove_file(&added) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!(
                    "Failed to remove file added by the failed update {}: {err}",
                    path_to_string(&added)
                ));
            }
        }
        // Drop directories the update created; `remove_dir` refuses non-empty ones.
        let mut parent = added.parent();
        while let Some(dir) = parent.filter(|dir| *dir != install_dir) {
            if fs::remove_dir(dir).is_err() {
                break;
            }
            parent = dir.parent();
        }
    }
    cleanup_completed_core_rollback(rollback_dir);
    Ok(())
}

pub(crate) fn apply_staged_core_with_rollback<F>(
    install_dir: &Path,
    staging_dir: &Path,
    rollback_dir: &Path,
    verify_or_restart: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    let staged_binary = find_core_binary(staging_dir)
        .ok_or_else(|| "Staged kernel directory is missing a CPA kernel binary".to_string())?;
    let staged_size = fs::metadata(&staged_binary)
        .map_err(|err| format!("Failed to read staged kernel binary metadata: {err}"))?
        .len();
    if staged_size == 0 {
        return Err("Staged CPA kernel binary is empty".to_string());
    }

    let had_backup = backup_core_for_rollback(install_dir, staging_dir, rollback_dir)?;
    if let Err(overlay_error) = overlay_install_dir(install_dir, staging_dir) {
        if had_backup {
            if let Err(rollback_error) = restore_core_rollback(install_dir, rollback_dir) {
                return Err(format!(
                    "{overlay_error}; restoring the previous version also failed: {rollback_error}. The previous kernel files are kept in {}",
                    path_to_string(rollback_dir)
                ));
            }
        }
        return Err(overlay_error);
    }

    match verify_or_restart() {
        Ok(()) => {
            cleanup_completed_core_rollback(rollback_dir);
            Ok(())
        }
        Err(restart_error) if had_backup => match restore_core_rollback(install_dir, rollback_dir) {
            Ok(()) => Err(format!(
                "Kernel update failed to start and was rolled back to the previous version: {restart_error}"
            )),
            Err(rollback_error) => Err(format!(
                "Kernel update failed to start: {restart_error}; restoring the previous version also failed: {rollback_error}. The previous kernel files are kept in {}",
                path_to_string(rollback_dir)
            )),
        },
        Err(restart_error) => Err(format!(
            "Kernel installed, but failed to automatically resume operation: {restart_error}"
        )),
    }
}

pub(crate) fn overlay_install_dir(install_dir: &Path, staging_dir: &Path) -> Result<(), String> {
    if !staging_dir.is_dir() {
        return Err(format!(
            "Kernel staging directory does not exist: {}",
            path_to_string(staging_dir)
        ));
    }

    if !install_dir.exists() {
        return fs::rename(staging_dir, install_dir)
            .map_err(|err| format!("Failed to install new kernel directory: {err}"));
    }
    if !install_dir.is_dir() {
        return Err(format!(
            "Kernel installation path is not a directory: {}",
            path_to_string(install_dir)
        ));
    }

    overlay_directory(staging_dir, install_dir)?;
    fs::remove_dir_all(staging_dir).map_err(|err| format!("Failed to clean up kernel staging directory: {err}"))
}

pub(super) fn overlay_directory(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source_dir)
        .map_err(|err| format!("Failed to read kernel staging directory {}: {err}", path_to_string(source_dir)))?
    {
        let entry = entry.map_err(|err| format!("Failed to read kernel staging entry: {err}"))?;
        let source_path = entry.path();
        let target_path = target_dir.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|err| format!("Failed to read kernel staging entry type: {err}"))?;

        if file_type.is_dir() {
            if target_path.exists() && !target_path.is_dir() {
                return Err(format!(
                    "Cannot overwrite a same-named file with a kernel directory: {}",
                    path_to_string(&target_path)
                ));
            }
            fs::create_dir_all(&target_path).map_err(|err| {
                format!(
                    "Failed to create kernel installation subdirectory {}: {err}",
                    path_to_string(&target_path)
                )
            })?;
            overlay_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            if target_path.exists() && !target_path.is_file() {
                return Err(format!(
                    "Cannot overwrite a same-named directory with a kernel file: {}",
                    path_to_string(&target_path)
                ));
            }
            copy_core_file_replace(&source_path, &target_path)?;
        } else {
            return Err(format!(
                "Kernel staging directory contains an unsupported entry: {}",
                path_to_string(&source_path)
            ));
        }
    }

    Ok(())
}

pub(crate) fn copy_core_file_replace(source_path: &Path, target_path: &Path) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let parent = target_path.parent().ok_or_else(|| {
        format!(
            "Failed to overwrite kernel file {}: cannot determine parent directory",
            path_to_string(target_path)
        )
    })?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create kernel file directory {}: {error}", path_to_string(parent)))?;
    let file_name = target_path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "cpa-core".into());
    let temporary_path = parent.join(format!(
        ".{file_name}.replace.{}.{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));

    let replace_result = (|| -> io::Result<()> {
        fs::copy(source_path, &temporary_path)?;
        let temporary_file = File::options().write(true).open(&temporary_path)?;
        temporary_file.sync_all()?;
        drop(temporary_file);
        replace_file_atomically(&temporary_path, target_path)
    })();

    if let Err(error) = replace_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(format!(
            "Failed to overwrite kernel file {}: {error}",
            path_to_string(target_path)
        ));
    }

    Ok(())
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn rematerialize_core_binary(binary_path: &Path) -> Result<(), String> {
    copy_core_file_replace(binary_path, binary_path)
}
