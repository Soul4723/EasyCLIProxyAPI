use super::support::*;
use super::*;

const ASSET: &str = "CLIProxyAPI_8.0.35_linux_amd64.tar.gz";

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn official_checksums(genuine: &[u8]) -> String {
    // Shape of the published v8.0.35 checksums.txt, with the target entry replaced.
    format!(
        "570db8fcf5677cbfa2f32b35e117c4df9d91d5966057f7fe4604fd493033dd83  CLIProxyAPI_8.0.35_linux_aarch64.tar.gz\n\
         {}  {ASSET}\n\
         1c34168bd795a1bbb82d1852d007c772e7ef2b7387d8d408c451863e4175a208  CLIProxyAPI_8.0.35_linux_amd64_no-plugin.tar.gz\n",
        sha256_hex(genuine)
    )
}

fn listed_asset(digest: Option<String>) -> GithubAsset {
    GithubAsset {
        name: ASSET.to_string(),
        browser_download_url: format!("https://gh-proxy.com/https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.35/{ASSET}"),
        fallback_download_urls: vec![format!(
            "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.35/{ASSET}"
        )],
        size: None,
        digest,
    }
}

fn downloaded(bytes: &[u8]) -> DownloadedArchive {
    DownloadedArchive {
        size: bytes.len() as u64,
        sha256: sha256_hex(bytes),
    }
}

#[test]
fn tampered_core_archive_is_refused() {
    let genuine = b"genuine core archive";
    let asset = asset_with_official_digest(&listed_asset(None), &official_checksums(genuine)).unwrap();

    validate_downloaded_asset(&asset, &downloaded(genuine)).unwrap();
    let error = validate_downloaded_asset(&asset, &downloaded(b"tampered core archive")).unwrap_err();
    assert!(error.contains("does not match the official SHA-256"), "{error}");
}

#[test]
fn published_checksums_line_format_is_parsed() {
    let published = "1d9edde6973e8f15694debcd186b5ab693e0741bd6a4c5e551aa89e0a6b57e38  CLIProxyAPI_8.0.35_linux_amd64.tar.gz\n\
                     1c34168bd795a1bbb82d1852d007c772e7ef2b7387d8d408c451863e4175a208  CLIProxyAPI_8.0.35_linux_amd64_no-plugin.tar.gz\n";
    assert_eq!(
        expected_core_sha256(published, ASSET).unwrap(),
        "1d9edde6973e8f15694debcd186b5ab693e0741bd6a4c5e551aa89e0a6b57e38"
    );
    let binary_mode = "1D9EDDE6973E8F15694DEBCD186B5AB693E0741BD6A4C5E551AA89E0A6B57E38 *CLIProxyAPI_8.0.35_linux_amd64.tar.gz\n";
    assert_eq!(
        expected_core_sha256(binary_mode, ASSET).unwrap(),
        "1d9edde6973e8f15694debcd186b5ab693e0741bd6a4c5e551aa89e0a6b57e38"
    );
}

#[test]
fn missing_repeated_or_malformed_checksum_entries_refuse_the_install() {
    let digest = sha256_hex(b"x");
    let missing = format!("{digest}  CLIProxyAPI_8.0.35_linux_amd64_no-plugin.tar.gz\n");
    assert!(expected_core_sha256(&missing, ASSET).unwrap_err().contains("has no entry"));
    assert!(expected_core_sha256("", ASSET).unwrap_err().contains("has no entry"));

    let repeated = format!("{digest}  {ASSET}\n{digest}  {ASSET}\n");
    assert!(expected_core_sha256(&repeated, ASSET).unwrap_err().contains("more than once"));

    let short = format!("{}  {ASSET}\n", &digest[..40]);
    assert!(expected_core_sha256(&short, ASSET).unwrap_err().contains("invalid SHA-256"));
    let not_hex = format!("{}  {ASSET}\n", "z".repeat(64));
    assert!(expected_core_sha256(&not_hex, ASSET).unwrap_err().contains("invalid SHA-256"));

    assert!(asset_with_official_digest(&listed_asset(None), &missing).is_err());
}

#[test]
fn an_archive_without_an_official_digest_is_never_accepted() {
    let bytes = b"core archive";
    for digest in [None, Some(String::new()), Some("sha256:".to_string())] {
        let error = validate_downloaded_asset(&listed_asset(digest), &downloaded(bytes)).unwrap_err();
        assert!(error.contains("no official SHA-256"), "{error}");
    }
}

#[test]
fn checksum_from_a_mirror_is_ignored_and_the_github_one_is_used() {
    let genuine = b"genuine core archive";
    let tampered = b"tampered core archive";
    // A mirror's release page can carry its own digest that matches its tampered archive.
    let mirror_html = format!(
        r#"<li><a href="/router-for-me/CLIProxyAPI/releases/download/v8.0.35/{ASSET}">{ASSET}</a> sha256:{}</li>"#,
        sha256_hex(tampered)
    );
    let mirror_asset = parse_release_assets(&mirror_html).remove(0);
    assert_eq!(mirror_asset.digest, Some(format!("sha256:{}", sha256_hex(tampered))));

    let asset = asset_with_official_digest(&mirror_asset, &official_checksums(genuine)).unwrap();
    assert_eq!(asset.digest, Some(format!("sha256:{}", sha256_hex(genuine))));
    assert!(validate_downloaded_asset(&asset, &downloaded(tampered)).is_err());
    validate_downloaded_asset(&asset, &downloaded(genuine)).unwrap();
}

#[test]
fn official_checksums_always_come_from_github() {
    assert_eq!(
        official_core_checksums_url("8.0.35").unwrap(),
        "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.35/checksums.txt"
    );
    // The URL does not depend on the download source, and a tag from a mirror's
    // listing cannot steer it anywhere else.
    assert!(official_core_checksums_url("v8.0.35/../../evil").is_err());
    assert!(official_core_checksums_url("latest").is_err());
}

fn serve_once(response: &'static [u8]) -> (String, std::thread::JoinHandle<()>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut data = [0; 4096];
        let _ = stream.read(&mut data).unwrap();
        stream.write_all(response).unwrap();
    });
    (origin, server)
}

#[tokio::test]
async fn checksums_fetch_reads_a_github_response() {
    let (origin, server) = serve_once(
        b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nabc  x.zip\n",
    );
    let client = official_checksums_client("").unwrap();
    let body = fetch_core_checksums_from(&client, &format!("{origin}/checksums.txt"))
        .await
        .unwrap();
    assert_eq!(body, "abc  x.zip\n");
    server.join().unwrap();
}

#[tokio::test]
async fn checksums_fetch_refuses_a_redirect_to_a_mirror() {
    let (origin, server) = serve_once(
        b"HTTP/1.1 302 Found\r\nLocation: https://gh-proxy.com/https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.35/checksums.txt\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    let client = official_checksums_client("").unwrap();
    let error = fetch_core_checksums_from(&client, &format!("{origin}/checksums.txt"))
        .await
        .unwrap_err();
    assert!(error.contains("302"), "{error}");
    server.join().unwrap();
}

#[tokio::test]
async fn checksums_fetch_refuses_an_oversized_body() {
    let (origin, server) = serve_once(
        b"HTTP/1.1 200 OK\r\nContent-Length: 10000000\r\nConnection: close\r\n\r\n",
    );
    let client = official_checksums_client("").unwrap();
    let error = fetch_core_checksums_from(&client, &format!("{origin}/checksums.txt"))
        .await
        .unwrap_err();
    assert!(error.contains("too large"), "{error}");
    server.join().unwrap();
}

#[test]
fn mirrors_are_not_tried_without_opt_in() {
    let mirrors = vec!["https://mirror.example.com/".to_string()];
    assert_eq!(
        version_download_source_candidates(
            VersionDownloadCandidate::builtin(VersionDownloadSource::Github),
            true,
            &mirrors,
            false,
        ),
        [VersionDownloadCandidate::builtin(VersionDownloadSource::Github)]
    );
    // A mirror the user selected is used, with GitHub as the only fallback.
    assert_eq!(
        version_download_source_candidates(
            VersionDownloadCandidate::builtin(VersionDownloadSource::GhProxy),
            true,
            &mirrors,
            false,
        ),
        [
            VersionDownloadCandidate::builtin(VersionDownloadSource::GhProxy),
            VersionDownloadCandidate::builtin(VersionDownloadSource::Github),
        ]
    );

    let release = release_from_tag("v8.0.35");
    let asset = release.assets.iter().find(|asset| asset.name == ASSET).unwrap();
    let candidates = core_download_candidates(
        &release.tag_name,
        asset,
        VersionDownloadCandidate::builtin(VersionDownloadSource::Github),
        Some("example/CLIProxyAPI"),
        &mirrors,
        false,
    );
    assert_eq!(
        candidates
            .iter()
            .map(|(_, url)| core_download_source_name(url))
            .collect::<Vec<_>>(),
        ["GitHub"]
    );
}

#[test]
fn mirror_fallback_opt_in_is_off_by_default_and_persists_when_enabled() {
    assert!(!GuiConfigFile::default().allow_mirror_fallback);
    let directory = agent_test_home("mirror-fallback-opt-in");
    let path = directory.join("config.toml");
    let mut state = GuiConfigState::new(GuiConfigFile::default());
    state.persistence_path = Some(path.clone());

    let config = state.set_mirror_fallback(true).unwrap();
    assert!(config.allow_mirror_fallback);
    let saved = fs::read_to_string(&path).unwrap();
    assert!(saved.contains("allow-mirror-fallback = true"), "{saved}");
    assert!(toml::from_str::<GuiConfigFile>(&saved).unwrap().allow_mirror_fallback);
    // Opting in does not change the selected source.
    assert_eq!(config.download_source, VersionDownloadSource::Github);

    let config = state.set_mirror_fallback(false).unwrap();
    assert!(!config.allow_mirror_fallback);
    assert!(fs::read_to_string(&path).unwrap().contains("allow-mirror-fallback = false"));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn version_checks_and_downloads_never_save_a_fallback_source() {
    // The paths that try fallbacks must not write the download source.
    for (name, source) in [
        ("core_runtime/staging.rs", include_str!("../core_runtime/staging.rs")),
        ("core_runtime/install.rs", include_str!("../core_runtime/install.rs")),
        ("core_runtime/releases.rs", include_str!("../core_runtime/releases.rs")),
        ("app_update/releases.rs", include_str!("../app_update/releases.rs")),
        ("app_update/download.rs", include_str!("../app_update/download.rs")),
    ] {
        for forbidden in [
            "set_download_candidate",
            "switch_download_source",
            "download_source =",
            "active_custom_download_mirror =",
            "version-download-source-changed",
        ] {
            assert!(!source.contains(forbidden), "{name} contains {forbidden}");
        }
    }
}
