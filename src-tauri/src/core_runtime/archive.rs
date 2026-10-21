use super::*;

pub(crate) fn extract_tar_gz(archive_path: &Path, install_dir: &Path) -> Result<(), String> {
    let archive_file =
        File::open(archive_path).map_err(|err| format!("Failed to open tar.gz: {err}"))?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|err| format!("Failed to read tar.gz entry: {err}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|err| format!("Failed to read tar.gz entry: {err}"))?;
        let entry_path = entry
            .path()
            .map_err(|err| format!("Failed to read tar.gz entry path: {err}"))?;
        let out_path = checked_archive_path(install_dir, entry_path.as_ref())?;
        let entry_type = entry.header().entry_type();

        if entry_type.is_dir() {
            fs::create_dir_all(&out_path).map_err(|err| format!("Failed to create directory: {err}"))?;
        } else if entry_type.is_file() {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|err| format!("Failed to create directory: {err}"))?;
            }
            entry
                .unpack(&out_path)
                .map_err(|err| format!("Failed to extract tar.gz file: {err}"))?;
        } else {
            return Err(format!(
                "tar.gz contains an unsupported entry type: {}",
                path_to_string(&out_path)
            ));
        }
    }

    Ok(())
}

pub(crate) fn extract_zip(archive_path: &Path, install_dir: &Path) -> Result<(), String> {
    let archive_file = File::open(archive_path).map_err(|err| format!("Failed to open zip: {err}"))?;
    let mut archive =
        ZipArchive::new(archive_file).map_err(|err| format!("Failed to read zip: {err}"))?;

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| format!("Failed to read zip entry: {err}"))?;
        let enclosed_name = file
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe zip entry path: {}", file.name()))?;
        let out_path = checked_archive_path(install_dir, &enclosed_name)?;

        if is_zip_symlink(&file) {
            return Err(format!("zip contains an unsupported symbolic link entry: {}", file.name()));
        }

        if file.is_dir() {
            fs::create_dir_all(&out_path).map_err(|err| format!("Failed to create directory: {err}"))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("Failed to create directory: {err}"))?;
        }

        let mut out_file = File::create(&out_path).map_err(|err| format!("Failed to create file: {err}"))?;
        io::copy(&mut file, &mut out_file).map_err(|err| format!("Failed to write file: {err}"))?;

        #[cfg(unix)]
        if let Some(mode) = file.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&out_path, fs::Permissions::from_mode(safe_extracted_file_mode(mode)))
                .map_err(|err| format!("Failed to set file permissions: {err}"))?;
        }
    }

    Ok(())
}

#[cfg(unix)]
fn safe_extracted_file_mode(mode: u32) -> u32 {
    if mode & 0o111 != 0 { 0o755 } else { 0o644 }
}

#[cfg(all(test, unix))]
mod tests {
    use super::safe_extracted_file_mode;

    #[test]
    fn extracted_zip_modes_never_preserve_special_or_writeable_bits() {
        assert_eq!(safe_extracted_file_mode(0o4755), 0o755);
        assert_eq!(safe_extracted_file_mode(0o7777), 0o755);
        assert_eq!(safe_extracted_file_mode(0o666), 0o644);
    }
}

pub(crate) fn checked_archive_path(base_dir: &Path, entry_path: &Path) -> Result<PathBuf, String> {
    if entry_path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!(
            "Unsafe archive entry path: {}",
            path_to_string(entry_path)
        ));
    }

    Ok(base_dir.join(entry_path))
}

pub(crate) fn is_zip_symlink(file: &zip::read::ZipFile<'_>) -> bool {
    file.unix_mode()
        .map(|mode| mode & 0o170000 == 0o120000)
        .unwrap_or(false)
}

pub(crate) fn find_core_binary(install_dir: &Path) -> Option<PathBuf> {
    let binary_path = install_dir.join(core_binary_name());
    if binary_path.is_file() {
        return Some(binary_path);
    }

    let mut dirs = vec![install_dir.to_path_buf()];

    while let Some(dir) = dirs.pop() {
        let entries = fs::read_dir(dir).ok()?;

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            } else if path
                .file_name()
                .and_then(|file_name| file_name.to_str())
                .map(|file_name| file_name == core_binary_name())
                .unwrap_or(false)
            {
                return Some(path);
            }
        }
    }

    None
}

pub(crate) fn core_binary_name() -> &'static str {
    if env::consts::OS == "windows" {
        "cli-proxy-api.exe"
    } else {
        "cli-proxy-api"
    }
}
