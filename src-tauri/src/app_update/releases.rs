use super::*;

#[tauri::command]
pub(crate) async fn check_app_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppUpdateState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<AppUpdateInfo, String> {
    // Startup and manual version checks also refresh model defaults. Keep this
    // independent so a catalog download failure does not fail the version check.
    let catalog_app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = update_codex_model_catalog_inner(&catalog_app).await {
            eprintln!("Failed to update Codex model catalog during version check; continuing with current catalog: {error}");
        }
    });
    let (info, _) = resolve_app_update(&app, gui_config_state.inner()).await?;
    state.set_available(AppUpdateTask {
        phase: if info.update_available {
            "available".to_string()
        } else {
            "idle".to_string()
        },
        target_version: info.update_available.then(|| info.latest_version.clone()),
        total_bytes: info.download_size_bytes,
        ..AppUpdateTask::default()
    });
    Ok(info)
}

pub(super) async fn resolve_app_update(
    app: &tauri::AppHandle,
    gui_config_state: &GuiConfigState,
) -> Result<(AppUpdateInfo, Option<PendingAppUpdate>), String> {
    let _detection_guard = VERSION_SOURCE_DETECTION_LOCK.lock().await;
    let config = gui_config_state.snapshot()?;
    let proxy_url = config.proxy_url.clone();
    let client = build_http_client_with_proxy(
        reqwest::Client::builder()
            .redirect(release_https_redirect_policy_with_mirrors(
                &config.custom_download_mirrors,
            ))
            .connect_timeout(Duration::from_secs(8))
            .read_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(20)),
        &proxy_url,
        "Failed to create version check client",
    )?;
    let requested_source = config.selected_download_candidate();
    let (manifest, resolved_source) = fetch_portable_update_manifest(
        &client,
        requested_source.clone(),
        &config.custom_download_mirrors,
    )
    .await?;
    persist_automatic_download_source_switch(
        app,
        gui_config_state,
        &requested_source,
        &resolved_source,
    )?;
    let latest_version = normalize_version(&manifest.version);
    let current_version = normalize_version(env!("CARGO_PKG_VERSION"));
    let update_available = is_app_update_available(&current_version, &latest_version)?;
    let target = portable_update_target();
    let asset_catalog = manifest.full_assets.as_ref().unwrap_or(&manifest.assets);
    let asset = target.and_then(|(key, _)| asset_catalog.get(key)).cloned();
    let portable_support = target
        .map(|(_, arch)| validate_local_portable_app_manifest(arch))
        .transpose()?;
    let auto_update_supported = portable_support == Some(true) && asset.is_some();
    let unsupported_reason = if auto_update_supported {
        None
    } else if portable_support != Some(true) {
        Some("This application is not a portable version that supports automatic upgrades. Manually download the first supported version".to_string())
    } else {
        Some("The update manifest does not include the current platform or architecture".to_string())
    };

    let pending = if update_available && auto_update_supported {
        let (_, arch) = target.expect("portable target checked above");
        Some(PendingAppUpdate {
            version: latest_version.clone(),
            asset: asset.clone().expect("portable asset checked above"),
            arch: arch.to_string(),
        })
    } else {
        None
    };
    let info = AppUpdateInfo {
        current_version,
        latest_version,
        update_available,
        release_url: manifest.release_url,
        release_notes: manifest.release_notes,
        published_at: manifest.published_at,
        auto_update_supported,
        download_size_bytes: asset.map(|value| value.size_bytes),
        unsupported_reason,
    };
    Ok((info, pending))
}

pub(crate) async fn fetch_portable_update_manifest(
    client: &reqwest::Client,
    source: VersionDownloadCandidate,
    custom_mirrors: &[String],
) -> Result<(PortableUpdateManifest, VersionDownloadCandidate), String> {
    if source.source == VersionDownloadSource::Gitcode && !gitcode_version_source_available() {
        return Err("GitCode application update source is not configured for this build".to_string());
    }
    let gitcode_repository = configured_gitcode_gui_repository();
    let mut failures = Vec::new();
    for candidate in
        version_download_source_candidates(source, gitcode_repository.is_some(), custom_mirrors)
    {
        let result = match candidate.source {
            VersionDownloadSource::Gitcode => {
                fetch_portable_update_manifest_from_gitcode(
                    client,
                    gitcode_repository.expect("GitCode candidate requires a configured repository"),
                )
                .await
            }
            VersionDownloadSource::Github
            | VersionDownloadSource::GhProxy
            | VersionDownloadSource::GhFast => {
                let url = version_source_url(&candidate, APP_UPDATE_MANIFEST_URL);
                fetch_portable_update_manifest_url(client, &url).await
            }
            VersionDownloadSource::Custom => {
                let url = version_source_url(&candidate, APP_UPDATE_MANIFEST_URL);
                fetch_portable_update_manifest_url(client, &url).await
            }
        };
        match result {
            Ok(manifest) => return Ok((manifest, candidate)),
            Err(error) => failures.push(format!("{}: {error}", candidate.display_name())),
        }
    }
    Err(format!("All application version check sources failed: {}", failures.join("; ")))
}

pub(crate) async fn fetch_portable_update_manifest_from_gitcode(
    client: &reqwest::Client,
    repository: &str,
) -> Result<PortableUpdateManifest, String> {
    let release_url = format!("https://api.gitcode.com/api/v5/repos/{repository}/releases/latest");
    let release = app_update_metadata_request(client, &release_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, APP_USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("query GitCode latest release: {error}"))?
        .error_for_status()
        .map_err(|error| format!("read GitCode latest release: {error}"))?
        .json::<GitcodeRelease>()
        .await
        .map_err(|error| format!("parse GitCode latest release: {error}"))?;
    validate_release_tag(&release.tag_name)?;
    let manifest_url =
        gitcode_release_attachment_url(repository, &release.tag_name, APP_UPDATE_MANIFEST_NAME);
    fetch_portable_update_manifest_url(client, &manifest_url).await
}

pub(crate) async fn fetch_portable_update_manifest_url(
    client: &reqwest::Client,
    url: &str,
) -> Result<PortableUpdateManifest, String> {
    let manifest = app_update_metadata_request(client, url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, APP_USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("request update manifest: {error}"))?
        .error_for_status()
        .map_err(|error| format!("read update manifest: {error}"))?
        .json::<PortableUpdateManifest>()
        .await
        .map_err(|error| format!("parse update manifest: {error}"))?;
    prepare_portable_update_manifest(manifest, configured_gitcode_gui_repository())
}

pub(crate) fn prepare_portable_update_manifest(
    mut manifest: PortableUpdateManifest,
    gitcode_repository: Option<&str>,
) -> Result<PortableUpdateManifest, String> {
    // A manifest can advertise optional GitCode mirrors even in a GitHub-only
    // build. Discard unavailable mirrors before validation AND before retaining
    // download candidates; never download an unvalidated fallback.
    if gitcode_repository.is_none() {
        for asset in manifest.assets.values_mut() {
            asset.fallback_urls.clear();
        }
        if let Some(assets) = manifest.full_assets.as_mut() {
            for asset in assets.values_mut() {
                asset.fallback_urls.clear();
            }
        }
    }
    validate_portable_update_manifest(&manifest)?;
    Ok(manifest)
}

fn app_update_metadata_request(client: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string();
    client
        .get(url)
        .query(&[("_", nonce)])
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .header(reqwest::header::PRAGMA, "no-cache")
}

pub(crate) fn configured_gitcode_gui_repository() -> Option<&'static str> {
    configured_gitcode_repository(option_env!("GITCODE_GUI_REPOSITORY"))
}

pub(crate) fn configured_gitcode_core_repository() -> Option<&'static str> {
    configured_gitcode_repository(option_env!("GITCODE_CORE_REPOSITORY"))
}

pub(crate) fn configured_gitcode_repository(
    repository: Option<&'static str>,
) -> Option<&'static str> {
    let repository = repository?.trim();
    let mut parts = repository.split('/');
    let valid_part = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    };
    match (parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(repo), None) if valid_part(owner) && valid_part(repo) => {
            Some(repository)
        }
        _ => None,
    }
}

pub(crate) fn validate_release_tag(tag: &str) -> Result<(), String> {
    semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag))
        .map(|_| ())
        .map_err(|error| format!("invalid release tag {tag}: {error}"))
}

pub(crate) fn gitcode_release_attachment_url(
    repository: &str,
    tag: &str,
    filename: &str,
) -> String {
    format!(
        "https://api.gitcode.com/api/v5/repos/{repository}/releases/{tag}/attach_files/{filename}/download"
    )
}

pub(crate) fn release_https_redirect_policy_with_mirrors(
    custom_mirrors: &[String],
) -> reqwest::redirect::Policy {
    let custom_hosts = custom_mirrors
        .iter()
        .filter_map(|value| reqwest::Url::parse(value).ok())
        .filter_map(|url| url.host_str().map(str::to_string))
        .collect::<HashSet<_>>();
    reqwest::redirect::Policy::custom(move |attempt| {
        let url = attempt.url();
        let trusted_host = matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "objects.githubusercontent.com"
                    | "release-assets.githubusercontent.com"
                    | "api.gitcode.com"
                    | "gitcode.com"
                    | "file-cdn.gitcode.com"
                    | "gh-proxy.com"
                    | "ghfast.top"
            )
        ) || url
            .host_str()
            .is_some_and(|host| custom_hosts.contains(host));
        if url.scheme() == "https"
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && trusted_host
        {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

pub(crate) fn github_https_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let url = attempt.url();
        let trusted_host = matches!(
            url.host_str(),
            Some(
                "github.com"
                    | "raw.githubusercontent.com"
                    | "objects.githubusercontent.com"
                    | "release-assets.githubusercontent.com"
            )
        );
        if url.scheme() == "https"
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && trusted_host
        {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}
