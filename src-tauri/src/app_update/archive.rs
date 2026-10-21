use super::*;

#[cfg(windows)]
pub(crate) fn extract_portable_update_archive(
    archive_path: &Path,
    staging_dir: &Path,
) -> Result<PortablePackagePayload, String> {
    fs::create_dir_all(staging_dir)
        .map_err(|error| format!("Failed to create application update staging directory: {error}"))?;
    let file = File::open(archive_path).map_err(|error| format!("Failed to open application update package: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Failed to read application update ZIP: {error}"))?;
    let archive_names = archive
        .file_names()
        .map(|name| name.replace('\\', "/"))
        .collect::<Vec<_>>();
    let legacy_layout = archive_names.len() == 2
        && archive_names.iter().any(|name| name == PORTABLE_APP_BINARY)
        && archive_names
            .iter()
            .any(|name| name == PORTABLE_APP_MANIFEST_FILE);
    let mut package_root = None::<String>;
    let mut seen_binary = false;
    let mut seen_manifest = false;
    let mut seen_core_version = false;
    let mut core_archive_name = None::<String>;
    let mut regular_file_count = 0_u32;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read application update ZIP entry: {error}"))?;
        let name = entry.name().replace('\\', "/");
        if entry.enclosed_name().is_none() {
            return Err("Application update package contains an unsafe path".to_string());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Application update package cannot contain symbolic links".to_string());
        }
        if entry.is_dir() {
            continue;
        }
        regular_file_count = regular_file_count.saturating_add(1);
        let relative;
        let relative_name;
        if legacy_layout {
            relative = Vec::new();
            relative_name = name.clone();
        } else {
            let mut components = name.split('/');
            let root = components
                .next()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Application update package is missing a top-level directory".to_string())?;
            relative = components.collect::<Vec<_>>();
            if relative.is_empty() || relative.iter().any(|value| value.is_empty()) {
                return Err("Invalid application update package directory structure".to_string());
            }
            if package_root.as_deref().is_some_and(|value| value != root) {
                return Err("Application update package must contain exactly one top-level directory".to_string());
            }
            package_root.get_or_insert_with(|| root.to_string());
            relative_name = relative.join("/");
        }
        let destination = match relative_name.as_str() {
            PORTABLE_APP_BINARY if !seen_binary => {
                if entry.size() == 0 || entry.size() > 256 * 1024 * 1024 {
                    return Err("Invalid application updater size".to_string());
                }
                seen_binary = true;
                staging_dir.join(PORTABLE_APP_BINARY)
            }
            PORTABLE_APP_MANIFEST_FILE if !seen_manifest => {
                if entry.size() == 0 || entry.size() > 64 * 1024 {
                    return Err("Invalid application update marker size".to_string());
                }
                seen_manifest = true;
                staging_dir.join(PORTABLE_APP_MANIFEST_FILE)
            }
            CORE_VERSION_FILE if !seen_core_version => {
                if entry.size() == 0 || entry.size() > 1024 {
                    return Err("Invalid bundled kernel version file size in application update package".to_string());
                }
                seen_core_version = true;
                staging_dir.join(CORE_VERSION_FILE)
            }
            _ if relative.len() == 2
                && relative[0] == "cpa-core"
                && core_archive_name.is_none() =>
            {
                let filename = relative[1];
                if !filename.starts_with("CLIProxyAPI_")
                    || !filename.ends_with(".zip")
                    || filename.contains("_no-plugin")
                    || entry.size() == 0
                    || entry.size() > 512 * 1024 * 1024
                {
                    return Err("Invalid bundled kernel archive in application update package".to_string());
                }
                core_archive_name = Some(filename.to_string());
                let core_staging_dir = staging_dir.join("cpa-core");
                fs::create_dir_all(&core_staging_dir)
                    .map_err(|error| format!("Failed to create bundled kernel staging directory: {error}"))?;
                core_staging_dir.join(filename)
            }
            _ => return Err(format!("Application update package contains an unknown file: {name}")),
        };
        let mut output = File::create(&destination)
            .map_err(|error| format!("Failed to create application update staging file: {error}"))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Failed to extract application update file: {error}"))?;
        output
            .flush()
            .map_err(|error| format!("Failed to save application update staging file: {error}"))?;
    }
    let required_files_present = if legacy_layout {
        regular_file_count == 2 && seen_binary && seen_manifest
    } else {
        regular_file_count == 4 && seen_binary && seen_manifest && seen_core_version
    };
    if !required_files_present {
        return Err("Application update package is missing required files".to_string());
    }
    let manifest = fs::read_to_string(staging_dir.join(PORTABLE_APP_MANIFEST_FILE))
        .map_err(|error| format!("Failed to read application update marker: {error}"))?;
    let manifest = serde_json::from_str::<PortableAppManifest>(&manifest)
        .map_err(|error| format!("Failed to parse application update marker: {error}"))?;
    if manifest.schema_version != 1
        || manifest.application != "EasyCLIProxyAPI"
        || !manifest.auto_update
    {
        return Err("Invalid application update marker".to_string());
    }
    if !legacy_layout {
        let expected_root = format!(
            "EasyCLIProxyAPI-v{}-Windows-{}",
            manifest.version.trim().trim_start_matches('v'),
            manifest.arch
        );
        if package_root.as_deref() != Some(expected_root.as_str()) {
            return Err("Application update package top-level directory does not match the version or architecture".to_string());
        }
        let core_version = fs::read_to_string(staging_dir.join(CORE_VERSION_FILE))
            .map_err(|error| format!("Failed to read bundled kernel version: {error}"))?;
        let core_version = core_version.trim().trim_start_matches('v');
        if core_version.is_empty()
            || !core_version.split('.').all(|segment| {
                !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit())
            })
        {
            return Err("Invalid bundled kernel version in application update package".to_string());
        }
        let expected_core_archive =
            format!("CLIProxyAPI_{core_version}_windows_{}.zip", manifest.arch);
        if core_archive_name.as_deref() != Some(expected_core_archive.as_str()) {
            return Err("Bundled kernel version or architecture mismatch in application update package".to_string());
        }
    }
    Ok(PortablePackagePayload {
        manifest,
        core_archive_name,
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn extract_portable_update_tar_gz(
    archive_path: &Path,
    staging_dir: &Path,
) -> Result<PortablePackagePayload, String> {
    fs::create_dir_all(staging_dir)
        .map_err(|error| format!("Failed to create application update staging directory: {error}"))?;
    let file = File::open(archive_path).map_err(|error| format!("Failed to open application update package: {error}"))?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|error| format!("Failed to read application update TAR.GZ: {error}"))?;
    let mut package_root = None::<String>;
    let mut seen_binary = false;
    let mut seen_manifest = false;
    let mut seen_core_version = false;
    let mut core_archive_name = None::<String>;
    let mut regular_file_count = 0_u32;

    for entry in entries {
        let mut entry = entry.map_err(|error| format!("Failed to read application update entry: {error}"))?;
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            continue;
        }
        if !entry_type.is_file() {
            return Err("Application update package cannot contain links or special files".to_string());
        }
        let entry_path = entry
            .path()
            .map_err(|error| format!("Failed to read application update entry path: {error}"))?;
        let mut components = Vec::new();
        for component in entry_path.components() {
            match component {
                Component::Normal(value) => components.push(value.to_string_lossy().into_owned()),
                Component::CurDir => {}
                Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                    return Err("Application update package contains an unsafe path".to_string());
                }
            }
        }
        if components.len() < 2 || components.iter().any(String::is_empty) {
            return Err("Invalid application update package directory structure".to_string());
        }
        let root = &components[0];
        if package_root.as_deref().is_some_and(|value| value != root) {
            return Err("Application update package must contain exactly one top-level directory".to_string());
        }
        package_root.get_or_insert_with(|| root.clone());
        let relative = &components[1..];
        let relative_name = relative.join("/");
        regular_file_count = regular_file_count.saturating_add(1);
        let size = entry.size();
        let destination = match relative_name.as_str() {
            PORTABLE_APP_BINARY if !seen_binary => {
                if size == 0 || size > 256 * 1024 * 1024 {
                    return Err("Invalid application updater size".to_string());
                }
                seen_binary = true;
                staging_dir.join(PORTABLE_APP_BINARY)
            }
            PORTABLE_APP_MANIFEST_FILE if !seen_manifest => {
                if size == 0 || size > 64 * 1024 {
                    return Err("Invalid application update marker size".to_string());
                }
                seen_manifest = true;
                staging_dir.join(PORTABLE_APP_MANIFEST_FILE)
            }
            CORE_VERSION_FILE if !seen_core_version => {
                if size == 0 || size > 1024 {
                    return Err("Invalid bundled kernel version file size in application update package".to_string());
                }
                seen_core_version = true;
                staging_dir.join(CORE_VERSION_FILE)
            }
            _ if relative.len() == 2
                && relative[0] == "cpa-core"
                && core_archive_name.is_none() =>
            {
                let filename = &relative[1];
                if !filename.starts_with("CLIProxyAPI_")
                    || !filename.ends_with(".tar.gz")
                    || filename.contains("_no-plugin")
                    || size == 0
                    || size > 512 * 1024 * 1024
                {
                    return Err("Invalid bundled kernel archive in application update package".to_string());
                }
                core_archive_name = Some(filename.clone());
                let core_staging_dir = staging_dir.join("cpa-core");
                fs::create_dir_all(&core_staging_dir)
                    .map_err(|error| format!("Failed to create bundled kernel staging directory: {error}"))?;
                core_staging_dir.join(filename)
            }
            _ => return Err(format!("Application update package contains an unknown file: {relative_name}")),
        };
        let mut output = File::create(&destination)
            .map_err(|error| format!("Failed to create application update staging file: {error}"))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Failed to extract application update file: {error}"))?;
        output
            .flush()
            .map_err(|error| format!("Failed to save application update staging file: {error}"))?;
    }
    if regular_file_count != 4
        || !seen_binary
        || !seen_manifest
        || !seen_core_version
        || core_archive_name.is_none()
    {
        return Err("Application update package is missing required files".to_string());
    }
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        staging_dir.join(PORTABLE_APP_BINARY),
        fs::Permissions::from_mode(0o755),
    )
    .map_err(|error| format!("Failed to set application updater permissions: {error}"))?;
    let manifest = fs::read_to_string(staging_dir.join(PORTABLE_APP_MANIFEST_FILE))
        .map_err(|error| format!("Failed to read application update marker: {error}"))?;
    let manifest = serde_json::from_str::<PortableAppManifest>(&manifest)
        .map_err(|error| format!("Failed to parse application update marker: {error}"))?;
    if manifest.schema_version != 1
        || manifest.application != "EasyCLIProxyAPI"
        || manifest.platform != "linux"
        || !manifest.auto_update
    {
        return Err("Invalid application update marker".to_string());
    }
    let expected_root = format!(
        "EasyCLIProxyAPI-v{}-Linux-{}",
        manifest.version.trim().trim_start_matches('v'),
        manifest.arch
    );
    if package_root.as_deref() != Some(expected_root.as_str()) {
        return Err("Application update package top-level directory does not match the version or architecture".to_string());
    }
    let core_version = fs::read_to_string(staging_dir.join(CORE_VERSION_FILE))
        .map_err(|error| format!("Failed to read bundled kernel version: {error}"))?;
    let core_version = core_version.trim().trim_start_matches('v');
    if core_version.is_empty()
        || !core_version
            .split('.')
            .all(|segment| !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err("Invalid bundled kernel version in application update package".to_string());
    }
    let expected_core_archive =
        format!("CLIProxyAPI_{core_version}_linux_{}.tar.gz", manifest.arch);
    if core_archive_name.as_deref() != Some(expected_core_archive.as_str()) {
        return Err("Bundled kernel version or architecture mismatch in application update package".to_string());
    }
    Ok(PortablePackagePayload {
        manifest,
        core_archive_name,
    })
}

#[cfg(windows)]
pub(crate) fn stage_current_portable_core_payload(
    app_dir: &Path,
    staging_dir: &Path,
    arch: &str,
) -> Result<String, String> {
    let current_core_version = app_dir.join(CORE_VERSION_FILE);
    let core_version = fs::read_to_string(&current_core_version)
        .map_err(|error| format!("Failed to read current bundled kernel version: {error}"))?;
    let core_version = core_version.trim().trim_start_matches('v');
    if core_version.is_empty()
        || !core_version
            .split('.')
            .all(|segment| !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err("Current bundled kernel version is invalid and cannot support legacy update packages".to_string());
    }
    let core_archive_name = format!("CLIProxyAPI_{core_version}_windows_{arch}.zip");
    let current_core_archive = app_dir.join("cpa-core").join(&core_archive_name);
    if !current_core_archive.is_file() {
        return Err(format!(
            "Current portable version is missing bundled kernel archive {core_archive_name} and cannot support legacy update packages"
        ));
    }
    let staged_core_dir = staging_dir.join("cpa-core");
    fs::create_dir_all(&staged_core_dir)
        .map_err(|error| format!("Failed to create legacy update compatibility staging directory: {error}"))?;
    fs::copy(&current_core_version, staging_dir.join(CORE_VERSION_FILE))
        .map_err(|error| format!("Failed to stage current kernel version file: {error}"))?;
    fs::copy(
        current_core_archive,
        staged_core_dir.join(&core_archive_name),
    )
    .map_err(|error| format!("Failed to stage current bundled kernel archive: {error}"))?;
    Ok(core_archive_name)
}
