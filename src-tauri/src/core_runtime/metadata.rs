use super::*;

pub(crate) fn read_core_metadata(install_dir: &Path) -> Option<CoreMetadata> {
    let metadata_path = install_dir.join(CORE_METADATA_FILE);
    let content = fs::read_to_string(metadata_path).ok()?;
    serde_json::from_str(&content).ok()
}

pub(crate) fn write_core_metadata(
    install_dir: &Path,
    metadata: &CoreMetadata,
) -> Result<(), String> {
    let metadata_path = install_dir.join(CORE_METADATA_FILE);
    let content = serde_json::to_string_pretty(metadata)
        .map_err(|err| format!("Failed to generate kernel metadata: {err}"))?;
    fs::write(metadata_path, content).map_err(|err| format!("Failed to write kernel metadata: {err}"))
}

pub(crate) fn validate_downloaded_asset(
    asset: &GithubAsset,
    downloaded: &DownloadedArchive,
) -> Result<(), String> {
    validate_download_metadata(
        downloaded.size,
        asset.size,
        &downloaded.sha256,
        asset.digest.as_deref(),
    )
}

pub(crate) fn validate_download_metadata(
    downloaded: u64,
    expected_total: Option<u64>,
    sha256: &str,
    expected_digest: Option<&str>,
) -> Result<(), String> {
    if let Some(expected_total) = expected_total {
        if downloaded != expected_total {
            return Err(format!(
                "Download size verification failed: got {downloaded} bytes, expected {expected_total} bytes"
            ));
        }
    }

    if let Some(expected_digest) = expected_digest {
        let expected = expected_digest
            .strip_prefix("sha256:")
            .unwrap_or(expected_digest)
            .to_ascii_lowercase();

        if !expected.is_empty() && sha256 != expected {
            return Err("Downloaded file SHA-256 verification failed".to_string());
        }
    }

    Ok(())
}

pub(crate) fn cleanup_core_work_dirs() -> Result<(), String> {
    let base_dir = core_base_dir()?;
    let mut last_error = None;

    for name in ["cpa-core.staging", "cpa-core.download"] {
        let path = base_dir.join(name);
        if path.exists() {
            if let Err(err) = fs::remove_dir_all(&path) {
                last_error = Some(format!("Failed to clean up temporary directory {}: {err}", path_to_string(&path)));
            }
        }
    }

    if let Some(error) = last_error {
        Err(error)
    } else {
        Ok(())
    }
}

pub(crate) fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Accepts only `[v]MAJOR.MINOR.PATCH[-prerelease]` and returns the canonical `vX.Y.Z` tag. The
/// version ends up in a download URL path, so nothing that could alter that path (`/`, `..`, `?`,
/// `#`, `%`, `:`, whitespace) may get through.
pub(crate) fn validate_core_version(version: &str) -> Result<String, String> {
    static SHAPE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let shape = SHAPE.get_or_init(|| {
        regex::Regex::new(r"^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$").expect("valid regex")
    });
    let bare = version.strip_prefix('v').unwrap_or(version);
    if !shape.is_match(version) || semver::Version::parse(bare).is_err() {
        return Err(format!(
            "Invalid kernel version {version:?}: expected a semantic version such as 8.0.35"
        ));
    }
    Ok(format!("v{bare}"))
}

pub(crate) fn normalize_version(version: &str) -> String {
    let version = version.trim();

    if version.starts_with('v') {
        version.to_string()
    } else {
        format!("v{version}")
    }
}
