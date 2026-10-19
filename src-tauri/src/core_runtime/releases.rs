use super::*;

pub(crate) async fn fetch_release(
    client: &reqwest::Client,
    version: Option<&str>,
    source: VersionDownloadCandidate,
    custom_mirrors: &[String],
) -> Result<(GithubRelease, VersionDownloadCandidate), String> {
    if let Some(version) = version {
        return Ok((
            release_from_tag_for_repositories(
                version,
                configured_gitcode_core_repository(),
                &source,
            ),
            source,
        ));
    }
    let gitcode_repository = configured_gitcode_core_repository();
    let mut failures = Vec::new();
    for candidate in
        version_download_source_candidates(source, gitcode_repository.is_some(), custom_mirrors)
    {
        let result = match candidate.source {
            VersionDownloadSource::Gitcode => {
                fetch_release_from_gitcode(
                    client,
                    gitcode_repository.expect("GitCode candidate requires a configured repository"),
                )
                .await
            }
            VersionDownloadSource::Github
            | VersionDownloadSource::GhProxy
            | VersionDownloadSource::GhFast
            | VersionDownloadSource::Custom => fetch_release_from_github(client, &candidate).await,
        };
        match result {
            Ok(release) => return Ok((release, candidate)),
            Err(error) => failures.push(format!("{}: {error}", candidate.display_name())),
        }
    }
    Err(format!("All kernel version check sources failed: {}", failures.join("；")))
}

pub(crate) async fn fetch_release_from_github(
    client: &reqwest::Client,
    source: &VersionDownloadCandidate,
) -> Result<GithubRelease, String> {
    let atom_result = fetch_release_from_atom(client, source).await;
    match atom_result {
        Ok(release) => Ok(release),
        Err(atom_error) => fetch_release_from_page(client, source)
            .await
            .map_err(|page_error| {
                format!("GitHub release source request failed: {atom_error}; release page request failed: {page_error}")
            }),
    }
}

pub(crate) async fn fetch_release_from_gitcode(
    client: &reqwest::Client,
    repository: &str,
) -> Result<GithubRelease, String> {
    let release_url = format!("https://api.gitcode.com/api/v5/repos/{repository}/releases/latest");
    let release = client
        .get(release_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("Failed to query latest GitCode kernel release: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Failed to read latest GitCode kernel release: {error}"))?
        .json::<GitcodeRelease>()
        .await
        .map_err(|error| format!("Failed to parse latest GitCode kernel release: {error}"))?;
    validate_release_tag(&release.tag_name)?;
    Ok(release_from_gitcode_tag(&release.tag_name, repository))
}

pub(crate) async fn fetch_release_from_page(
    client: &reqwest::Client,
    source: &VersionDownloadCandidate,
) -> Result<GithubRelease, String> {
    let release_page_url = version_source_url(source, RELEASE_PAGE_URL);
    let response = client
        .get(release_page_url)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|err| format!("GitHub release page request failed: {err}"))?;
    let status = response.status();
    let final_url = response.url().clone();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .map_err(|err| format!("Failed to read GitHub release page: {err}"))?;
        return Err(format_github_error(status.as_u16(), &body));
    }

    let tag = release_tag_from_url(&final_url)
        .ok_or_else(|| "GitHub release page did not return a version tag".to_string())?;
    Ok(release_from_tag_for_repositories(
        &tag,
        configured_gitcode_core_repository(),
        source,
    ))
}

pub(crate) async fn fetch_release_from_atom(
    client: &reqwest::Client,
    source: &VersionDownloadCandidate,
) -> Result<GithubRelease, String> {
    let release_atom_url = version_source_url(source, RELEASE_ATOM_URL);
    let response = client
        .get(release_atom_url)
        .header(
            reqwest::header::ACCEPT,
            "application/atom+xml,application/xml,text/xml",
        )
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|err| format!("GitHub Atom feed request failed: {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Failed to read GitHub Atom feed: {err}"))?;
    if !status.is_success() {
        return Err(format_github_error(status.as_u16(), &body));
    }
    let tag = release_tag_from_atom(&body)
        .ok_or_else(|| "GitHub Atom feed did not return a version tag".to_string())?;
    Ok(release_from_tag_for_repositories(
        &tag,
        configured_gitcode_core_repository(),
        source,
    ))
}

pub(crate) fn release_tag_from_atom(xml: &str) -> Option<String> {
    let entry = xml.split_once("<entry>")?.1;
    if let Some(tag_path) = entry.split_once("/releases/tag/").map(|(_, value)| value) {
        let tag = tag_path
            .split(['\"', '<', '?', '#'])
            .next()
            .unwrap_or_default()
            .trim_matches('/');
        if !tag.is_empty() {
            return Some(normalize_version(tag));
        }
    }
    let title = entry
        .split_once("<title>")?
        .1
        .split_once("</title>")?
        .0
        .trim();
    (!title.is_empty()).then(|| normalize_version(title))
}

#[cfg(test)]
pub(crate) fn release_from_tag(tag: &str) -> GithubRelease {
    release_from_tag_for_repositories(
        tag,
        configured_gitcode_core_repository(),
        &VersionDownloadCandidate::builtin(VersionDownloadSource::Github),
    )
}

pub(crate) fn release_from_gitcode_tag(tag: &str, repository: &str) -> GithubRelease {
    release_from_tag_for_repositories(
        tag,
        Some(repository),
        &VersionDownloadCandidate::builtin(VersionDownloadSource::Gitcode),
    )
}

pub(crate) fn release_from_tag_for_repositories(
    tag: &str,
    gitcode_repository: Option<&str>,
    source: &VersionDownloadCandidate,
) -> GithubRelease {
    let tag = normalize_version(tag);
    let version = tag.trim_start_matches('v');
    let assets = [
        ("linux", "amd64", "tar.gz"),
        ("linux", "aarch64", "tar.gz"),
        ("darwin", "amd64", "tar.gz"),
        ("darwin", "aarch64", "tar.gz"),
        ("windows", "amd64", "zip"),
        ("windows", "aarch64", "zip"),
    ]
    .into_iter()
    .map(|(os, arch, extension)| {
        let name = format!("CLIProxyAPI_{version}_{os}_{arch}.{extension}");
        let github_url = format!("{RELEASE_DOWNLOAD_PREFIX}{tag}/{name}");
        let gitcode_url = gitcode_repository
            .map(|repository| gitcode_release_attachment_url(repository, &tag, &name));
        let (browser_download_url, fallback_download_urls) = match source.source {
            VersionDownloadSource::Gitcode => match gitcode_url {
                Some(gitcode_url) => (gitcode_url, vec![github_url]),
                None => (github_url, Vec::new()),
            },
            VersionDownloadSource::GhProxy | VersionDownloadSource::GhFast => {
                let mirror_url = version_source_url(source, &github_url);
                let mut fallbacks = vec![github_url];
                fallbacks.extend(gitcode_url);
                (mirror_url, fallbacks)
            }
            VersionDownloadSource::Github => (github_url, gitcode_url.into_iter().collect()),
            VersionDownloadSource::Custom => {
                let mirror_url = version_source_url(source, &github_url);
                let mut fallbacks = vec![github_url];
                fallbacks.extend(gitcode_url);
                (mirror_url, fallbacks)
            }
        };
        GithubAsset {
            browser_download_url,
            fallback_download_urls,
            name,
            size: None,
            digest: None,
        }
    })
    .collect();
    GithubRelease {
        tag_name: tag,
        assets,
    }
}

pub(crate) fn core_download_candidates(
    tag: &str,
    asset: &GithubAsset,
    preferred: VersionDownloadCandidate,
    gitcode_repository: Option<&str>,
    custom_mirrors: &[String],
) -> Vec<(VersionDownloadCandidate, String)> {
    let tag = normalize_version(tag);
    let generated_github_url = format!("{RELEASE_DOWNLOAD_PREFIX}{tag}/{}", asset.name);
    let provided_urls = std::iter::once(&asset.browser_download_url)
        .chain(asset.fallback_download_urls.iter())
        .collect::<Vec<_>>();
    let github_url = provided_urls
        .iter()
        .find(|url| core_download_source_name(url) == "GitHub")
        .map(|url| (*url).clone())
        .unwrap_or(generated_github_url);
    let gitcode_url = provided_urls
        .iter()
        .find(|url| core_download_source_name(url) == "GitCode")
        .map(|url| (*url).clone())
        .or_else(|| {
            gitcode_repository
                .map(|repository| gitcode_release_attachment_url(repository, &tag, &asset.name))
        });
    version_download_source_candidates(preferred, gitcode_url.is_some(), custom_mirrors)
        .into_iter()
        .filter_map(|candidate| {
            let url = match candidate.source {
                VersionDownloadSource::Github => github_url.clone(),
                VersionDownloadSource::Gitcode => gitcode_url.clone()?,
                VersionDownloadSource::GhProxy
                | VersionDownloadSource::GhFast
                | VersionDownloadSource::Custom => version_source_url(&candidate, &github_url),
            };
            Some((candidate, url))
        })
        .collect()
}

pub(crate) fn release_tag_from_url(url: &reqwest::Url) -> Option<String> {
    let mut segments = url.path_segments()?;
    let tag = segments.next_back()?.trim();
    if tag.is_empty() || tag == "latest" {
        None
    } else {
        Some(tag.to_string())
    }
}

pub(crate) fn is_app_update_available(current: &str, latest: &str) -> Result<bool, String> {
    let parse = |value: &str| {
        semver::Version::parse(value.trim().trim_start_matches('v'))
            .map_err(|error| format!("Failed to parse version {value}: {error}"))
    };
    Ok(parse(latest)? > parse(current)?)
}

#[cfg(test)]
pub(crate) fn parse_release_assets(html: &str) -> Vec<GithubAsset> {
    let mut assets = Vec::new();
    let mut cursor = 0;

    while let Some(relative_start) = html[cursor..].find("releases/download/") {
        let download_start = cursor + relative_start;
        let Some(href_start) = html[..download_start].rfind("href=\"") else {
            cursor = download_start + "releases/download/".len();
            continue;
        };
        let href_start = href_start + "href=\"".len();
        let Some(relative_end) = html[download_start..].find('"') else {
            break;
        };
        let href_end = download_start + relative_end;
        let href = &html[href_start..href_end];
        let Some(name) = href.rsplit('/').next().filter(|name| !name.is_empty()) else {
            cursor = href_end + 1;
            continue;
        };
        let item_end = html[href_end..]
            .find("</li>")
            .map(|offset| href_end + offset)
            .unwrap_or(html.len());
        let item = &html[href_start..item_end];
        let digest = item.find("sha256:").and_then(|offset| {
            let value = &item[offset + "sha256:".len()..];
            let hash: String = value
                .chars()
                .take_while(|character| character.is_ascii_hexdigit())
                .collect();
            (hash.len() == 64).then(|| format!("sha256:{hash}"))
        });
        let browser_download_url = if href.starts_with("http://") || href.starts_with("https://") {
            href.to_string()
        } else {
            format!("https://github.com{href}")
        };

        if !assets.iter().any(|asset: &GithubAsset| asset.name == name) {
            assets.push(GithubAsset {
                name: name.to_string(),
                browser_download_url,
                fallback_download_urls: Vec::new(),
                size: None,
                digest,
            });
        }
        cursor = href_end + 1;
    }

    assets
}

pub(crate) fn format_github_error(status: u16, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = value.get("message").and_then(|item| item.as_str()) {
            return format!("GitHub returned an error ({status}): {}", message.trim());
        }
    }
    let body = body.trim();
    if body.is_empty() {
        format!("GitHub returned an error ({status})")
    } else {
        format!("GitHub returned an error ({status}): {}", truncate_for_error(body))
    }
}
