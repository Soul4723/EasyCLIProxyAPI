use super::*;

pub(crate) fn validate_portable_update_manifest(
    manifest: &PortableUpdateManifest,
) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err(format!(
            "Unsupported application update manifest version: {}",
            manifest.schema_version
        ));
    }
    semver::Version::parse(manifest.version.trim().trim_start_matches('v'))
        .map_err(|error| format!("Invalid application update version: {error}"))?;
    chrono::DateTime::parse_from_rfc3339(manifest.published_at.trim())
        .map_err(|error| format!("Invalid application update release date: {error}"))?;
    let release_url = reqwest::Url::parse(&manifest.release_url)
        .map_err(|_| "Invalid application update release URL".to_string())?;
    if release_url.scheme() != "https"
        || release_url.host_str() != Some("github.com")
        || release_url.port().is_some()
        || !release_url.username().is_empty()
        || release_url.password().is_some()
        || release_url.query().is_some()
        || release_url.fragment().is_some()
        || !release_url
            .path()
            .starts_with("/router-for-me/EasyCLIProxyAPI/releases/tag/v")
    {
        return Err("Untrusted application update release URL".to_string());
    }
    let (platform, display_platform, suffix) = portable_update_asset_platform()?;
    validate_portable_update_asset_catalog(
        &manifest.assets,
        manifest,
        platform,
        display_platform,
        suffix,
        platform == "windows",
    )?;
    if let Some(full_assets) = &manifest.full_assets {
        validate_portable_update_asset_catalog(
            full_assets,
            manifest,
            platform,
            display_platform,
            suffix,
            false,
        )?;
    }
    Ok(())
}

pub(crate) fn portable_update_asset_platform(
) -> Result<(&'static str, &'static str, &'static str), String> {
    match portable_update_platform_key() {
        Some("windows") => Ok(("windows", "Windows", "zip")),
        Some("linux") => Ok(("linux", "Linux", "tar.gz")),
        Some("darwin") => Ok(("darwin", "Darwin", "dmg")),
        _ => Err("The current platform does not support in-app automatic upgrades".to_string()),
    }
}

fn validate_portable_update_asset_catalog(
    assets: &std::collections::HashMap<String, PortableUpdateAsset>,
    manifest: &PortableUpdateManifest,
    platform: &str,
    display_platform: &str,
    suffix: &str,
    allow_windows_legacy: bool,
) -> Result<(), String> {
    if assets.len() != 2 {
        return Err(format!("The application update manifest must include both {display_platform} architectures"));
    }
    let version = manifest.version.trim().trim_start_matches('v');
    let tag = format!("v{version}");
    for arch in ["amd64", "aarch64"] {
        let key = format!("{platform}-{arch}");
        let asset = assets
            .get(&key)
            .ok_or_else(|| format!("Application update manifest is missing {key}"))?;
        validate_portable_update_asset(asset)?;
        let full_package_name =
            format!("EasyCLIProxyAPI-v{version}-{display_platform}-{arch}.{suffix}");
        let full_package_url = format!("{APP_RELEASE_DOWNLOAD_PREFIX}{tag}/{full_package_name}");
        let legacy_package_name = format!("EasyCLIProxyAPI-update-v{version}-Windows-{arch}.zip");
        let legacy_package_url =
            format!("{APP_RELEASE_DOWNLOAD_PREFIX}{tag}/{legacy_package_name}");
        let is_expected = asset.url == full_package_url
            || (allow_windows_legacy && asset.url == legacy_package_url);
        if !is_expected {
            return Err(format!("Application update asset name does not match {key}"));
        }
        let mut expected_filenames = vec![full_package_name.as_str()];
        if allow_windows_legacy {
            expected_filenames.push(legacy_package_name.as_str());
        }
        validate_portable_update_asset_fallbacks(asset, &tag, &expected_filenames)?;
    }
    Ok(())
}

pub(crate) fn validate_portable_update_asset(asset: &PortableUpdateAsset) -> Result<(), String> {
    let url = reqwest::Url::parse(&asset.url).map_err(|_| "Invalid application update download URL".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !asset.url.starts_with(APP_RELEASE_DOWNLOAD_PREFIX)
    {
        return Err("Untrusted application update download URL".to_string());
    }
    if asset.size_bytes == 0 || asset.size_bytes > 512 * 1024 * 1024 {
        return Err("Invalid application update package size".to_string());
    }
    let digest = asset.sha256.trim().to_ascii_lowercase();
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid application update SHA-256".to_string());
    }
    Ok(())
}

pub(crate) fn validate_portable_update_asset_fallbacks(
    asset: &PortableUpdateAsset,
    tag: &str,
    expected_filenames: &[&str],
) -> Result<(), String> {
    validate_portable_update_asset_fallbacks_for_repository(
        asset,
        tag,
        expected_filenames,
        configured_gitcode_gui_repository(),
    )
}

pub(crate) fn validate_portable_update_asset_fallbacks_for_repository(
    asset: &PortableUpdateAsset,
    tag: &str,
    expected_filenames: &[&str],
    repository: Option<&str>,
) -> Result<(), String> {
    if asset.fallback_urls.is_empty() {
        return Ok(());
    }
    let repository = repository
        .ok_or_else(|| "GitCode fallback is not configured for this build".to_string())?;
    if asset.fallback_urls.len() != 1 {
        return Err("Software update assets may define only one fallback URL".to_string());
    }
    let fallback = &asset.fallback_urls[0];
    let trusted = expected_filenames
        .iter()
        .any(|filename| fallback == &gitcode_release_attachment_url(repository, tag, filename));
    if !trusted {
        return Err("Software update fallback URL is not trusted".to_string());
    }
    Ok(())
}

pub(crate) fn portable_update_target() -> Option<(&'static str, &'static str)> {
    let platform = portable_update_platform_key()?;
    let arch = match env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "aarch64",
        _ => return None,
    };
    match (platform, arch) {
        ("windows", "amd64") => Some(("windows-amd64", "amd64")),
        ("windows", "aarch64") => Some(("windows-aarch64", "aarch64")),
        ("linux", "amd64") => Some(("linux-amd64", "amd64")),
        ("linux", "aarch64") => Some(("linux-aarch64", "aarch64")),
        ("darwin", "amd64") => Some(("darwin-amd64", "amd64")),
        ("darwin", "aarch64") => Some(("darwin-aarch64", "aarch64")),
        _ => None,
    }
}

pub(crate) fn portable_update_platform_key() -> Option<&'static str> {
    match env::consts::OS {
        "windows" => Some("windows"),
        "linux" => Some("linux"),
        "macos" => Some("darwin"),
        _ => None,
    }
}

pub(crate) fn local_portable_app_manifest_path() -> Result<PathBuf, String> {
    let executable_dir = executable_dir()?;
    #[cfg(target_os = "macos")]
    if let Some(resources_dir) = macos_app_resources_dir(&executable_dir) {
        return Ok(resources_dir.join(PORTABLE_APP_MANIFEST_FILE));
    }
    Ok(executable_dir.join(PORTABLE_APP_MANIFEST_FILE))
}

pub(crate) fn validate_local_portable_app_manifest(expected_arch: &str) -> Result<bool, String> {
    let path = local_portable_app_manifest_path()?;
    if !path.is_file() {
        return Ok(false);
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("Failed to read portable version marker: {error}"))?;
    let manifest = serde_json::from_str::<PortableAppManifest>(&contents)
        .map_err(|error| format!("Failed to parse portable version marker: {error}"))?;
    Ok(manifest.schema_version == 1
        && manifest.application == "EasyCLIProxyAPI"
        && Some(manifest.platform.as_str()) == portable_update_platform_key()
        && manifest.arch == expected_arch
        && manifest.auto_update
        && normalize_version(&manifest.version) == normalize_version(env!("CARGO_PKG_VERSION")))
}

#[tauri::command]
