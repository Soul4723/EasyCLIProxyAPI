use super::*;

pub(crate) async fn download_and_stage_portable_app_update(
    app: &tauri::AppHandle,
    pending: &PendingAppUpdate,
    token: &CancellationToken,
    proxy_url: &str,
    download_source: VersionDownloadCandidate,
) -> Result<(), String> {
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (app, pending, token, proxy_url, download_source);
        Err("The current platform does not support in-app automatic upgrades".to_string())
    }

    #[cfg(windows)]
    {
        validate_portable_update_asset(&pending.asset)?;
        let work_dir = env::temp_dir().join(format!(
            "EasyCLIProxyAPI-update-{}-{}-{}",
            pending.version,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&work_dir)
            .map_err(|error| format!("Failed to create temporary application update directory: {error}"))?;
        let archive_path = work_dir.join("update.zip");
        let result = async {
            download_portable_update_archive(
                app,
                pending,
                token,
                &archive_path,
                proxy_url,
                &download_source,
            )
            .await?;
            if token.is_cancelled() {
                return Err("Application update download canceled".to_string());
            }

            update_app_task(app, |task| {
                task.cancellable = false;
                task.phase = "verifying".to_string();
                task.message = Some("Verifying application update package".to_string());
            });
            let actual_sha256 = sha256_file(&archive_path)?;
            if actual_sha256 != pending.asset.sha256.trim().to_ascii_lowercase() {
                return Err("Application update package SHA-256 verification failed".to_string());
            }

            update_app_task(app, |task| {
                task.phase = "staging".to_string();
                task.message = Some("Preparing application update".to_string());
            });
            let staging_dir = work_dir.join("staging");
            let package = extract_portable_update_archive(&archive_path, &staging_dir)?;
            if normalize_version(&package.manifest.version) != normalize_version(&pending.version)
                || package.manifest.platform != "windows"
                || package.manifest.arch != pending.arch
            {
                return Err("Application update package version or architecture mismatch".to_string());
            }

            let current_exe =
                env::current_exe().map_err(|error| format!("Failed to read current executable path: {error}"))?;
            let app_dir = current_exe
                .parent()
                .ok_or_else(|| "Current executable path has no parent directory".to_string())?;
            preflight_portable_update_directory(app_dir)?;
            let core_archive_name = match package.core_archive_name {
                Some(name) => name,
                None => stage_current_portable_core_payload(app_dir, &staging_dir, &pending.arch)?,
            };
            let helper_path = work_dir.join("EasyCLIProxyAPI-updater.exe");
            fs::copy(&current_exe, &helper_path)
                .map_err(|error| format!("Failed to prepare application update helper: {error}"))?;

            let descriptor = PortableUpdateDescriptor {
                parent_pid: std::process::id(),
                current_exe: current_exe.clone(),
                staged_exe: staging_dir.join(PORTABLE_APP_BINARY),
                current_manifest: app_dir.join(PORTABLE_APP_MANIFEST_FILE),
                staged_manifest: staging_dir.join(PORTABLE_APP_MANIFEST_FILE),
                backup_exe: app_dir.join(".EasyCLIProxyAPI.exe.update-backup"),
                backup_manifest: app_dir.join(".portable-app.json.update-backup"),
                current_core_version: app_dir.join(CORE_VERSION_FILE),
                staged_core_version: staging_dir.join(CORE_VERSION_FILE),
                backup_core_version: app_dir.join(".core-version.txt.update-backup"),
                staged_core_archive: staging_dir.join("cpa-core").join(&core_archive_name),
                target_core_archive: app_dir.join("cpa-core").join(&core_archive_name),
                install_core_archive: !app_dir.join("cpa-core").join(&core_archive_name).is_file(),
                ack_path: work_dir.join("update-started.ack"),
                work_dir: work_dir.clone(),
                target_version: pending.version.clone(),
            };
            launch_portable_update_helper(app, &helper_path, &work_dir, &descriptor).await
        }
        .await;

        if result.is_err() {
            let _ = fs::remove_dir_all(&work_dir);
        }
        result
    }

    #[cfg(target_os = "linux")]
    {
        validate_portable_update_asset(&pending.asset)?;
        let work_dir = portable_update_work_dir(&pending.version);
        fs::create_dir_all(&work_dir)
            .map_err(|error| format!("Failed to create temporary application update directory: {error}"))?;
        let archive_path = work_dir.join("update.tar.gz");
        let result = async {
            download_portable_update_archive(
                app,
                pending,
                token,
                &archive_path,
                proxy_url,
                &download_source,
            )
            .await?;
            ensure_portable_update_download(token, &archive_path, pending)?;
            update_app_task(app, |task| {
                task.cancellable = false;
                task.phase = "staging".to_string();
                task.message = Some("Preparing application update".to_string());
            });

            let staging_dir = work_dir.join("staging");
            let package = extract_portable_update_tar_gz(&archive_path, &staging_dir)?;
            if normalize_version(&package.manifest.version) != normalize_version(&pending.version)
                || package.manifest.platform != "linux"
                || package.manifest.arch != pending.arch
            {
                return Err("Application update package version or architecture mismatch".to_string());
            }
            let core_archive_name = package
                .core_archive_name
                .ok_or_else(|| "Linux application update package is missing the bundled kernel".to_string())?;
            let current_exe =
                env::current_exe().map_err(|error| format!("Failed to read current executable path: {error}"))?;
            let app_dir = current_exe
                .parent()
                .ok_or_else(|| "Current executable path has no parent directory".to_string())?;
            preflight_portable_update_directory(app_dir)?;
            let helper_path = work_dir.join("EasyCLIProxyAPI-updater");
            fs::copy(&current_exe, &helper_path)
                .map_err(|error| format!("Failed to prepare application update helper: {error}"))?;

            let descriptor = PortableUpdateDescriptor {
                parent_pid: std::process::id(),
                current_exe: current_exe.clone(),
                staged_exe: staging_dir.join(PORTABLE_APP_BINARY),
                current_manifest: app_dir.join(PORTABLE_APP_MANIFEST_FILE),
                staged_manifest: staging_dir.join(PORTABLE_APP_MANIFEST_FILE),
                backup_exe: app_dir.join(".EasyCLIProxyAPI.update-backup"),
                backup_manifest: app_dir.join(".portable-app.json.update-backup"),
                current_core_version: app_dir.join(CORE_VERSION_FILE),
                staged_core_version: staging_dir.join(CORE_VERSION_FILE),
                backup_core_version: app_dir.join(".core-version.txt.update-backup"),
                staged_core_archive: staging_dir.join("cpa-core").join(&core_archive_name),
                target_core_archive: app_dir.join("cpa-core").join(&core_archive_name),
                install_core_archive: !app_dir.join("cpa-core").join(&core_archive_name).is_file(),
                ack_path: work_dir.join("update-started.ack"),
                work_dir: work_dir.clone(),
                target_version: pending.version.clone(),
            };
            launch_portable_update_helper(app, &helper_path, &work_dir, &descriptor).await
        }
        .await;
        if result.is_err() {
            let _ = fs::remove_dir_all(&work_dir);
        }
        result
    }

    #[cfg(target_os = "macos")]
    {
        validate_portable_update_asset(&pending.asset)?;
        let work_dir = portable_update_work_dir(&pending.version);
        fs::create_dir_all(&work_dir)
            .map_err(|error| format!("Failed to create temporary application update directory: {error}"))?;
        let archive_path = work_dir.join("update.dmg");
        let result = async {
            download_portable_update_archive(
                app,
                pending,
                token,
                &archive_path,
                proxy_url,
                &download_source,
            )
            .await?;
            ensure_portable_update_download(token, &archive_path, pending)?;
            update_app_task(app, |task| {
                task.cancellable = false;
                task.phase = "staging".to_string();
                task.message = Some("Preparing application update".to_string());
            });

            let staged_app = work_dir.join("staging").join("EasyCLIProxyAPI.app");
            stage_macos_application_from_dmg(&archive_path, &work_dir, &staged_app)?;
            validate_macos_staged_application(&staged_app, pending)?;
            let current_exe =
                env::current_exe().map_err(|error| format!("Failed to read current executable path: {error}"))?;
            let current_app = macos_application_bundle_from_executable(&current_exe)?;
            preflight_macos_update_directory(&current_app)?;
            let executable_relative_path = current_exe
                .strip_prefix(&current_app)
                .map_err(|_| "Invalid macOS application path".to_string())?
                .to_path_buf();
            let backup_app = current_app
                .parent()
                .ok_or_else(|| "macOS application path has no parent directory".to_string())?
                .join(".EasyCLIProxyAPI.app.update-backup");
            let descriptor = MacosUpdateDescriptor {
                parent_pid: std::process::id(),
                current_app,
                staged_app,
                backup_app,
                executable_relative_path,
                ack_path: work_dir.join("update-started.ack"),
                work_dir: work_dir.clone(),
                target_version: pending.version.clone(),
            };
            let helper_path = macos_update_helper_path(&current_exe);
            launch_portable_update_helper(app, &helper_path, &work_dir, &descriptor).await
        }
        .await;
        // A busy DMG may still be mounted here. Never recursively clean its mount point.
        if result.is_err() {
            cleanup_macos_update_dmg(&work_dir);
            if !work_dir.join("mount").exists() {
                let _ = fs::remove_dir_all(&work_dir);
            }
        }
        result
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn portable_update_work_dir(version: &str) -> PathBuf {
    env::temp_dir().join(format!(
        "EasyCLIProxyAPI-update-{}-{}-{}",
        version,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn ensure_portable_update_download(
    token: &CancellationToken,
    archive_path: &Path,
    pending: &PendingAppUpdate,
) -> Result<(), String> {
    if token.is_cancelled() {
        return Err("Application update download canceled".to_string());
    }
    let actual_sha256 = sha256_file(archive_path)?;
    if actual_sha256 != pending.asset.sha256.trim().to_ascii_lowercase() {
        return Err("Application update package SHA-256 verification failed".to_string());
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn macos_update_helper_path(current_exe: &Path) -> PathBuf {
    current_exe.to_path_buf()
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
async fn launch_portable_update_helper<T: Serialize>(
    app: &tauri::AppHandle,
    helper_path: &Path,
    work_dir: &Path,
    descriptor: &T,
) -> Result<(), String> {
    let descriptor_path = work_dir.join("update-descriptor.json");
    fs::write(
        &descriptor_path,
        serde_json::to_vec_pretty(descriptor)
            .map_err(|error| format!("Failed to serialize application update descriptor: {error}"))?,
    )
    .map_err(|error| format!("Failed to write application update descriptor: {error}"))?;
    let helper_ack_path = portable_update_helper_ack_path(work_dir);
    let _ = fs::remove_file(&helper_ack_path);
    let mut command = Command::new(helper_path);
    command
        .arg("--portable-update-helper")
        .arg(&descriptor_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_background_command(&mut command);
    let mut child = crate::process_spawn::spawn(&mut command)
        .map_err(|error| format!("Failed to start application update helper: {error}"))?;
    wait_for_portable_update_helper_start(
        &mut child,
        &helper_ack_path,
        PORTABLE_UPDATE_HELPER_START_TIMEOUT,
    )
    .await?;
    update_app_task(app, |task| {
        task.cancellable = false;
        task.phase = "restarting".to_string();
        task.message = Some("Update is ready. The application will restart shortly".to_string());
    });
    app.exit(0);
    Ok(())
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
pub(crate) fn portable_update_helper_ack_path(work_dir: &Path) -> PathBuf {
    work_dir.join(PORTABLE_UPDATE_HELPER_ACK_FILE)
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
pub(crate) fn acknowledge_portable_update_helper_start(work_dir: &Path) -> Result<(), String> {
    fs::write(
        portable_update_helper_ack_path(work_dir),
        std::process::id().to_string(),
    )
    .map_err(|error| format!("Failed to write application update helper startup confirmation: {error}"))
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
async fn wait_for_portable_update_helper_start(
    child: &mut Child,
    ack_path: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if ack_path.is_file() {
            return Ok(());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Failed to check application update helper status: {error}"))?
        {
            return Err(format!("Application update helper failed to start; exit status: {status}"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Application update helper did not confirm startup within {} seconds",
                timeout.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
pub(crate) async fn download_portable_update_archive(
    app: &tauri::AppHandle,
    pending: &PendingAppUpdate,
    token: &CancellationToken,
    destination: &Path,
    proxy_url: &str,
    download_source: &VersionDownloadCandidate,
) -> Result<(), String> {
    let client = build_http_client_with_proxy(
        reqwest::Client::builder()
            .redirect(release_https_redirect_policy_with_mirrors(
                &download_source
                    .custom_url
                    .clone()
                    .into_iter()
                    .collect::<Vec<_>>(),
            ))
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(15 * 60)),
        proxy_url,
        "Failed to create application update download client",
    )?;
    let urls = portable_update_download_urls(&pending.asset, download_source);
    let mut failures = Vec::new();
    for (index, url) in urls.iter().enumerate() {
        update_app_task(app, |task| {
            task.downloaded_bytes = 0;
            task.percent = Some(0.0);
            if index > 0 {
                task.message = Some(format!(
                    "Download failed; switching to {}",
                    update_download_source_name(url)
                ));
            }
        });
        match download_portable_update_archive_url(app, pending, token, destination, &client, url)
            .await
        {
            Ok(()) => return Ok(()),
            Err(error) if token.is_cancelled() => return Err(error),
            Err(error) => failures.push(error),
        }
    }
    Err(format!("All application update download sources failed: {}", failures.join("; ")))
}

pub(crate) fn portable_update_download_urls(
    asset: &PortableUpdateAsset,
    source: &VersionDownloadCandidate,
) -> Vec<String> {
    let mut urls = std::iter::once(asset.url.as_str())
        .chain(asset.fallback_urls.iter().map(String::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if source.source == VersionDownloadSource::Gitcode {
        urls.sort_by_key(|url| update_download_source_name(url) != "GitCode");
    } else if source.proxy_prefix().is_some() {
        if let Some(github_url) = urls
            .iter()
            .find(|url| update_download_source_name(url) == "GitHub")
            .cloned()
        {
            urls.insert(0, version_source_url(source, &github_url));
        }
    }
    urls.dedup();
    urls
}

pub(crate) fn update_download_source_name(url: &str) -> String {
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

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
pub(crate) async fn download_portable_update_archive_url(
    app: &tauri::AppHandle,
    pending: &PendingAppUpdate,
    token: &CancellationToken,
    destination: &Path,
    client: &reqwest::Client,
    url: &str,
) -> Result<(), String> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/octet-stream")
        .header(reqwest::header::USER_AGENT, APP_USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("Failed to download application update: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Failed to download application update: {error}"))?;
    let mut stream = response.bytes_stream();
    let mut file =
        File::create(destination).map_err(|error| format!("Failed to create temporary application update file: {error}"))?;
    let mut downloaded = 0_u64;
    let mut progress = crate::progress::ProgressThrottle::default();
    while let Some(chunk) = stream.next().await {
        if token.is_cancelled() {
            return Err("Application update download canceled".to_string());
        }
        let chunk = chunk.map_err(|error| format!("Failed to read application update download data: {error}"))?;
        file.write_all(&chunk)
            .map_err(|error| format!("Failed to write temporary application update file: {error}"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > pending.asset.size_bytes {
            return Err("Application update package exceeds the size declared in the manifest".to_string());
        }
        if progress.ready(Instant::now(), downloaded == pending.asset.size_bytes) {
            update_app_task(app, |task| {
                task.downloaded_bytes = downloaded;
                task.total_bytes = Some(pending.asset.size_bytes);
                task.percent = Some((downloaded as f64 / pending.asset.size_bytes as f64) * 100.0);
                task.message = Some(format!(
                    "{} / {}",
                    format_byte_count(downloaded),
                    format_byte_count(pending.asset.size_bytes)
                ));
            });
        }
    }
    file.flush()
        .map_err(|error| format!("Failed to save temporary application update file: {error}"))?;
    if downloaded != pending.asset.size_bytes {
        return Err(format!(
            "Application update package size mismatch: expected {}, got {}",
            pending.asset.size_bytes, downloaded
        ));
    }
    Ok(())
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
pub(crate) fn update_app_task<F>(app: &tauri::AppHandle, update: F)
where
    F: FnOnce(&mut AppUpdateTask),
{
    let state = app.state::<AppUpdateState>();
    let task = state.update_task(update);
    let _ = app.emit(APP_UPDATE_PROGRESS_EVENT, task);
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
pub(crate) fn format_byte_count(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0_usize;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}
