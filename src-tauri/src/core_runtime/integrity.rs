use super::*;

// Every downloaded core archive is checked against the release's checksums.txt,
// fetched from github.com itself. A mirror (gh-proxy, ghfast, GitCode or a custom
// prefix) may serve the archive, but never the checksum it is checked against.
// CLIProxyAPI releases publish no signatures or attestations (checked for v8.0.35),
// so the GitHub-hosted checksums.txt is the trust anchor.

const MAX_CORE_CHECKSUMS_BYTES: usize = 64 * 1024;

pub(crate) fn official_core_checksums_url(tag: &str) -> Result<String, String> {
    let tag = normalize_version(tag);
    validate_release_tag(&tag)?;
    Ok(format!("{RELEASE_DOWNLOAD_PREFIX}{tag}/{CORE_CHECKSUMS_FILE}"))
}

/// A client that only talks to GitHub: redirects to any other host, including the
/// configured mirrors, are refused. The user's own network proxy still applies.
pub(crate) fn official_checksums_client(proxy_url: &str) -> Result<reqwest::Client, String> {
    build_http_client_with_proxy(
        reqwest::Client::builder()
            .redirect(github_https_redirect_policy())
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(60)),
        proxy_url,
        "Failed to create checksum client",
    )
}

pub(crate) async fn fetch_official_core_checksums(
    client: &reqwest::Client,
    tag: &str,
) -> Result<String, String> {
    let url = official_core_checksums_url(tag)?;
    fetch_core_checksums_from(client, &url).await.map_err(|error| {
        format!(
            "Could not get the official checksums.txt from GitHub, so the kernel was not installed. Checksums are never taken from mirrors: {error}"
        )
    })
}

pub(crate) async fn fetch_core_checksums_from(
    client: &reqwest::Client,
    url: &str,
) -> Result<String, String> {
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    // A refused redirect (for example to a mirror) arrives as a 3xx response.
    if !response.status().is_success() {
        return Err(format!("request returned status {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CORE_CHECKSUMS_BYTES as u64)
    {
        return Err("checksums.txt is too large".to_string());
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("failed to read checksums.txt: {error}"))?;
        if body.len() + chunk.len() > MAX_CORE_CHECKSUMS_BYTES {
            return Err("checksums.txt is too large".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "checksums.txt is not valid UTF-8".to_string())
}

/// The one SHA-256 that checksums.txt lists for `asset_name`. A missing, repeated
/// or malformed entry is an error: an archive is never installed unverified.
pub(crate) fn expected_core_sha256(checksums: &str, asset_name: &str) -> Result<String, String> {
    let mut entries = checksums.lines().filter_map(|line| {
        let mut fields = line.split_whitespace();
        let digest = fields.next()?;
        let name = fields.next()?.trim_start_matches('*');
        (name == asset_name && fields.next().is_none()).then_some(digest)
    });
    let digest = entries.next().ok_or_else(|| {
        format!("The official checksums.txt has no entry for {asset_name}, so the kernel was not installed")
    })?;
    if entries.next().is_some() {
        return Err(format!(
            "The official checksums.txt lists {asset_name} more than once, so the kernel was not installed"
        ));
    }
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "The official checksums.txt has an invalid SHA-256 for {asset_name}, so the kernel was not installed"
        ));
    }
    Ok(digest.to_ascii_lowercase())
}

/// The asset to download, with its expected digest taken only from the official
/// checksums. Any digest that came with the release listing (which may have been
/// served by a mirror) is discarded.
pub(crate) fn asset_with_official_digest(
    asset: &GithubAsset,
    official_checksums: &str,
) -> Result<GithubAsset, String> {
    let expected = expected_core_sha256(official_checksums, &asset.name)?;
    Ok(GithubAsset {
        name: asset.name.clone(),
        browser_download_url: asset.browser_download_url.clone(),
        fallback_download_urls: asset.fallback_download_urls.clone(),
        size: asset.size,
        digest: Some(format!("sha256:{expected}")),
    })
}
