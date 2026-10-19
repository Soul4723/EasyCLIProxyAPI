use super::*;

pub(crate) fn core_install_dir() -> Result<PathBuf, String> {
    Ok(core_base_dir()?.join("cpa-core"))
}

pub(crate) fn executable_dir() -> Result<PathBuf, String> {
    let exe_path = env::current_exe().map_err(|err| format!("Failed to read current executable path: {err}"))?;
    exe_path
        .parent()
        .map(|path| path.to_path_buf())
        .ok_or_else(|| format!("Current executable path has no parent directory: {}", path_to_string(&exe_path)))
}

pub(crate) fn macos_app_resources_dir(executable_dir: &Path) -> Option<PathBuf> {
    if executable_dir.file_name().and_then(|name| name.to_str()) != Some("MacOS") {
        return None;
    }
    let contents_dir = executable_dir.parent()?;
    if contents_dir.file_name().and_then(|name| name.to_str()) != Some("Contents") {
        return None;
    }
    let app_dir = contents_dir.parent()?;
    if app_dir.extension().and_then(|extension| extension.to_str()) != Some("app") {
        return None;
    }
    Some(contents_dir.join("Resources"))
}

pub(crate) fn core_base_dir() -> Result<PathBuf, String> {
    let executable_dir = executable_dir()?;
    #[cfg(target_os = "macos")]
    if macos_app_resources_dir(&executable_dir).is_some() {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to determine macOS user directory".to_string())?;
        return Ok(home_dir
            .join("Library")
            .join("Application Support")
            .join("com.cpa.gui"));
    }
    Ok(executable_dir)
}

pub(crate) fn bundled_core_locations(
    base_dir: &Path,
    executable_dir: &Path,
) -> Vec<(PathBuf, PathBuf)> {
    let mut locations = Vec::new();
    if let Some(resources_dir) = macos_app_resources_dir(executable_dir) {
        locations.push((
            resources_dir.join(CORE_VERSION_FILE),
            resources_dir.join("cpa-core"),
        ));
    }
    locations.push((base_dir.join(CORE_VERSION_FILE), base_dir.join("cpa-core")));
    if let Some(project_root) = source_project_root(executable_dir) {
        if project_root != base_dir {
            locations.push((
                project_root.join(CORE_VERSION_FILE),
                project_root.join("cpa-core"),
            ));
        }
    }
    locations
}

pub(crate) fn bundled_core_archive() -> Result<Option<(BundledCoreInfo, PathBuf)>, String> {
    let platform = current_core_platform()?;
    let base_dir = core_base_dir()?;
    let executable_dir = executable_dir()?;
    let locations = bundled_core_locations(&base_dir, &executable_dir);

    let configured_version = locations.iter().find_map(|(version_path, _)| {
        fs::read_to_string(version_path)
            .ok()
            .map(|value| normalize_version(value.trim()))
            .filter(|value| value != "v")
    });
    if let Some(version) = configured_version {
        let asset_name = core_release_asset_name(&version, &platform);
        for (_, archive_dir) in &locations {
            let archive_path = archive_dir.join(&asset_name);
            if !archive_path.is_file() {
                continue;
            }
            let size_bytes = fs::metadata(&archive_path)
                .map_err(|error| format!("Failed to read bundled kernel information: {error}"))?
                .len();
            return Ok(Some((
                BundledCoreInfo {
                    version,
                    asset_name,
                    size_bytes,
                },
                archive_path,
            )));
        }
        return Ok(None);
    }

    let suffix = format!(
        "_{}_{}.{}",
        platform.asset_os, platform.asset_arch, platform.archive_kind
    );
    let mut matches = Vec::new();
    for (_, archive_dir) in &locations {
        if !archive_dir.is_dir() {
            continue;
        }
        for entry in fs::read_dir(archive_dir)
            .map_err(|error| format!("Failed to read bundled kernel directory: {error}"))?
            .filter_map(Result::ok)
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.path().is_file()
                || !name.starts_with("CLIProxyAPI_")
                || !name.ends_with(&suffix)
                || name.contains("_no-plugin")
            {
                continue;
            }
            let Some(version) = name
                .strip_prefix("CLIProxyAPI_")
                .and_then(|value| value.strip_suffix(&suffix))
            else {
                continue;
            };
            let version = normalize_version(version);
            if matches.iter().any(|(existing, _, _)| existing == &version) {
                continue;
            }
            matches.push((version, name, entry.path()));
        }
    }
    matches.sort_by(|left, right| left.0.cmp(&right.0));
    if matches.len() > 1 {
        return Err(format!(
            "Multiple bundled kernels match the current platform. Specify a release version in {}",
            CORE_VERSION_FILE
        ));
    }
    let Some((version, asset_name, archive_path)) = matches.pop() else {
        return Ok(None);
    };
    let size_bytes = fs::metadata(&archive_path)
        .map_err(|error| format!("Failed to read bundled kernel information: {error}"))?
        .len();
    Ok(Some((
        BundledCoreInfo {
            version,
            asset_name,
            size_bytes,
        },
        archive_path,
    )))
}

pub(crate) fn source_project_root(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|directory| {
        (directory.join("package.json").is_file() && directory.join("src-tauri").is_dir())
            .then(|| directory.to_path_buf())
    })
}

pub(crate) fn preserve_bundled_core_assets(
    source_dir: &Path,
    target_dir: &Path,
) -> Result<(), String> {
    if !source_dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source_dir)
        .map_err(|error| format!("Failed to read bundled kernel file: {error}"))?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_archive = name.starts_with("CLIProxyAPI_")
            && (name.ends_with(".tar.gz") || name.ends_with(".zip"))
            && !name.contains("_no-plugin");
        if !is_archive && name != CORE_CHECKSUMS_FILE {
            continue;
        }
        fs::copy(&path, target_dir.join(&name))
            .map_err(|error| format!("Failed to preserve bundled kernel file {name}: {error}"))?;
    }
    Ok(())
}

pub(crate) fn preserve_selected_bundled_core_asset(
    archive_path: &Path,
    target_dir: &Path,
) -> Result<(), String> {
    let archive_name = archive_path
        .file_name()
        .ok_or_else(|| "Invalid bundled kernel archive filename".to_string())?;
    fs::copy(archive_path, target_dir.join(archive_name))
        .map_err(|error| format!("Failed to preserve selected bundled kernel archive: {error}"))?;
    if let Some(source_dir) = archive_path.parent() {
        let checksums = source_dir.join(CORE_CHECKSUMS_FILE);
        if checksums.is_file() {
            fs::copy(&checksums, target_dir.join(CORE_CHECKSUMS_FILE))
                .map_err(|error| format!("Failed to preserve bundled kernel checksum file: {error}"))?;
        }
    }
    Ok(())
}

pub(crate) fn migrate_core_config_for_update(
    source_dir: &Path,
    target_dir: &Path,
) -> Result<(), String> {
    if !source_dir.is_dir() {
        return Ok(());
    }
    let old_config_path = source_dir.join(CORE_CONFIG_FILE);
    let old_config = match fs::read_to_string(&old_config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to read legacy kernel configuration; update canceled to prevent configuration loss {}: {error}",
                path_to_string(&old_config_path)
            ));
        }
    };

    let template_path = target_dir.join(CORE_EXAMPLE_CONFIG_FILE);
    if !template_path.is_file() {
        return Err(format!(
            "New kernel is missing a configuration template; update canceled: {}",
            path_to_string(&template_path)
        ));
    }
    let template = fs::read_to_string(&template_path).map_err(|error| {
        format!(
            "Failed to read new kernel configuration template {}: {error}",
            path_to_string(&template_path)
        )
    })?;
    let old_document = serde_norway::from_str::<serde_norway::Value>(&old_config)
        .map_err(|error| format!("Failed to parse existing kernel configuration; update canceled to prevent configuration loss: {error}"))?;
    if !old_document.is_mapping() {
        return Err("Existing kernel configuration root must be a YAML mapping; update canceled".to_string());
    }
    let template_document = serde_norway::from_str::<serde_norway::Value>(&template)
        .map_err(|error| format!("Failed to parse new kernel configuration template: {error}"))?;
    let migrated = if (core_config_declares_v8(&template_document) || core_config_uses_v8(&template_document))
        && !core_config_declares_v8(&old_document)
    {
        migrate_legacy_core_config_to_v8(&template, &old_config)?
    } else if core_config_uses_v8(&template_document) {
        old_config
    } else {
        merge_core_config_fields(&template, Some(&old_config))?
    };
    let config_path = target_dir.join(CORE_CONFIG_FILE);
    fs::write(&config_path, migrated).map_err(|error| {
        format!(
            "Failed to write migrated new kernel configuration {}: {error}",
            path_to_string(&config_path)
        )
    })?;
    Ok(())
}

pub(crate) fn validate_bundled_core_checksum(archive_path: &Path) -> Result<(), String> {
    let Some(directory) = archive_path.parent() else {
        return Err("Bundled kernel archive has no parent directory".to_string());
    };
    let checksums_path = directory.join(CORE_CHECKSUMS_FILE);
    if !checksums_path.is_file() {
        return Ok(());
    }
    let archive_name = archive_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid bundled kernel archive filename".to_string())?;
    let checksums = fs::read_to_string(&checksums_path)
        .map_err(|error| format!("Failed to read bundled kernel checksum file: {error}"))?;
    let expected = checksums.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let digest = fields.next()?;
        let name = fields.next()?.trim_start_matches('*');
        (name == archive_name && digest.len() == 64).then(|| digest.to_ascii_lowercase())
    });
    let Some(expected) = expected else {
        return Ok(());
    };
    let actual = sha256_file(archive_path)?;
    if actual != expected {
        return Err("Bundled kernel archive SHA-256 verification failed".to_string());
    }
    Ok(())
}

pub(crate) fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("Failed to open checksum file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read checksum file: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
