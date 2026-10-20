use super::*;

pub(crate) async fn fetch_release_cancelable(
    client: &reqwest::Client,
    version: Option<&str>,
    token: &CancellationToken,
    source: VersionDownloadCandidate,
    custom_mirrors: &[String],
    allow_mirror_fallback: bool,
) -> Result<(GithubRelease, VersionDownloadCandidate), String> {
    tokio::select! {
        result = fetch_release(client, version, source, custom_mirrors, allow_mirror_fallback) => result,
        _ = token.cancelled() => Err("Download canceled".to_string()),
    }
}

pub(crate) fn apply_configured_proxy(
    builder: reqwest::ClientBuilder,
    proxy_url: &str,
) -> Result<reqwest::ClientBuilder, String> {
    let proxy_url = proxy_url.trim();
    let builder = builder.no_proxy();
    if proxy_url.is_empty() {
        return Ok(builder);
    }
    let proxy = reqwest::Proxy::all(proxy_url)
        .map_err(|_| "Invalid proxy URL".to_string())?
        .no_proxy(reqwest::NoProxy::from_string("localhost,127.0.0.1,::1"));
    Ok(builder.proxy(proxy))
}

pub(crate) fn build_http_client_with_proxy(
    builder: reqwest::ClientBuilder,
    proxy_url: &str,
    error_prefix: &str,
) -> Result<reqwest::Client, String> {
    apply_configured_proxy(builder, proxy_url)
        .map_err(|error| format!("{error_prefix}: {error}"))?
        .build()
        .map_err(|error| format!("{error_prefix}: {error}"))
}

pub(crate) fn http_client(
    proxy_url: &str,
    custom_mirrors: &[String],
) -> Result<reqwest::Client, String> {
    build_http_client_with_proxy(
        reqwest::Client::builder()
            .redirect(release_https_redirect_policy_with_mirrors(custom_mirrors))
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(600)),
        proxy_url,
        "Failed to create HTTP client",
    )
}

pub(crate) fn select_release_asset<'a>(
    release: &'a GithubRelease,
    platform: &CorePlatform,
) -> Result<&'a GithubAsset, String> {
    let expected_name = core_release_asset_name(&release.tag_name, platform);
    let mut matches = release
        .assets
        .iter()
        .filter(|asset| asset.name == expected_name && !asset.name.contains("_no-plugin"));
    let asset = matches
        .next()
        .ok_or_else(|| format!("No release asset matches the current platform: {expected_name}"))?;

    if matches.next().is_some() {
        return Err(format!("Multiple release assets match: {expected_name}"));
    }

    Ok(asset)
}

pub(crate) fn core_release_asset_name(version: &str, platform: &CorePlatform) -> String {
    let version = normalize_version(version);
    let version = version.trim_start_matches('v');
    format!(
        "CLIProxyAPI_{}_{}_{}.{}",
        version, platform.asset_os, platform.asset_arch, platform.archive_kind
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_asset(
    client: &reqwest::Client,
    asset: &GithubAsset,
    download_candidates: &[(VersionDownloadCandidate, String)],
    archive_path: &Path,
    window: &tauri::Window,
    state: &CoreDownloadState,
    token: &CancellationToken,
) -> Result<(DownloadedArchive, VersionDownloadCandidate), String> {
    let mut failures = Vec::new();
    for (index, (candidate, url)) in download_candidates.iter().enumerate() {
        if index > 0 {
            state.progress(
                window,
                &format!("Download failed; switching to {}", candidate.display_name()),
                0,
                asset.size,
                true,
            );
        }
        let result = download_asset_inner(
            client,
            url,
            archive_path,
            asset.size,
            asset.digest.as_deref(),
            window,
            state,
            token,
        )
        .await;
        match result {
            Ok(downloaded) => return Ok((downloaded, candidate.clone())),
            Err(error) if token.is_cancelled() => {
                let _ = fs::remove_file(archive_path);
                return Err(error);
            }
            Err(error) => {
                let _ = fs::remove_file(archive_path);
                failures.push(error);
            }
        }
    }
    if failures.is_empty() {
        let _ = fs::remove_file(archive_path);
        return Err("Kernel release has no available download URL".to_string());
    }
    Err(format!("All kernel download sources failed: {}", failures.join("；")))
}

pub(crate) fn core_download_source_name(url: &str) -> String {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string));
    match host.as_deref() {
        Some("gh-proxy.com") => "gh-proxy.com".to_string(),
        Some("ghfast.top") => "ghfast.top".to_string(),
        Some(host) if host == "api.gitcode.com" || host.ends_with(".gitcode.com") => {
            "GitCode".to_string()
        }
        Some(
            "github.com" | "objects.githubusercontent.com" | "release-assets.githubusercontent.com",
        ) => "GitHub".to_string(),
        Some(host) => host.to_string(),
        None => "GitHub".to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_asset_inner(
    client: &reqwest::Client,
    url: &str,
    archive_path: &Path,
    expected_total: Option<u64>,
    expected_digest: Option<&str>,
    window: &tauri::Window,
    state: &CoreDownloadState,
    token: &CancellationToken,
) -> Result<DownloadedArchive, String> {
    state.progress(window, "Preparing download", 0, expected_total, true);
    ensure_not_cancelled(token, Some(archive_path))?;

    let request = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send();
    let response = tokio::select! {
        response = request => response.map_err(|err| format!("Failed to download kernel archive: {err}"))?,
        _ = token.cancelled() => return Err("Download canceled".to_string()),
    }
    .error_for_status()
    .map_err(|err| format!("Download URL returned an error status: {err}"))?;
    let total = expected_total.or_else(|| response.content_length());
    let mut stream = response.bytes_stream();
    let mut file =
        File::create(archive_path).map_err(|err| format!("Failed to create kernel archive: {err}"))?;
    let mut downloaded = 0_u64;
    let mut hasher = Sha256::new();
    let mut progress = crate::progress::ProgressThrottle::default();

    while let Some(chunk) = tokio::select! {
        chunk = stream.next() => chunk,
        _ = token.cancelled() => return Err("Download canceled".to_string()),
    } {
        ensure_not_cancelled(token, Some(archive_path))?;

        let chunk = chunk.map_err(|err| format!("Failed to read download data: {err}"))?;
        file.write_all(&chunk)
            .map_err(|err| format!("Failed to save download data: {err}"))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if progress.ready(Instant::now(), total == Some(downloaded)) {
            state.progress(window, "Downloading", downloaded, total, true);
        }
    }

    state.progress(window, "Downloading", downloaded, total, true);
    file.flush()
        .map_err(|err| format!("Failed to flush kernel archive: {err}"))?;
    ensure_not_cancelled(token, Some(archive_path))?;

    let sha256 = format!("{:x}", hasher.finalize());
    validate_download_metadata(downloaded, expected_total, &sha256, expected_digest)?;

    Ok(DownloadedArchive {
        size: downloaded,
        sha256,
    })
}

pub(crate) fn ensure_not_cancelled(
    token: &CancellationToken,
    archive_path: Option<&Path>,
) -> Result<(), String> {
    if token.is_cancelled() {
        if let Some(archive_path) = archive_path {
            let _ = fs::remove_file(archive_path);
        }

        return Err("Download canceled".to_string());
    }

    Ok(())
}
