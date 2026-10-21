fn main() {
    println!("cargo:rerun-if-env-changed=GITCODE_GUI_REPOSITORY");
    println!("cargo:rerun-if-env-changed=GITCODE_CORE_REPOSITORY");
    for name in ["APP_RELEASE_REPOSITORY", "APP_RELEASE_CHANNEL", "APP_ALLOW_UNNOTARIZED_UPDATES"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let repository = std::env::var("APP_RELEASE_REPOSITORY")
        .unwrap_or_else(|_| "router-for-me/EasyCLIProxyAPI".into());
    let parts: Vec<_> = repository.split('/').collect();
    assert!(parts.len() == 2 && parts.iter().all(|part| !part.is_empty()
        && part.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))),
        "APP_RELEASE_REPOSITORY must be owner/repository");
    let channel = std::env::var("APP_RELEASE_CHANNEL").unwrap_or_default();
    assert!(matches!(channel.as_str(), "" | "main" | "beta" | "dev"),
        "APP_RELEASE_CHANNEL must be main, beta or dev");
    let (identifier, product) = match channel.as_str() {
        "dev" => ("com.cpa.gui.dev", "EasyCLIProxyAPI [DEV]"),
        "beta" => ("com.cpa.gui.beta", "EasyCLIProxyAPI [BETA]"),
        _ => ("com.cpa.gui", "EasyCLIProxyAPI"),
    };
    let allow_unnotarized = std::env::var("APP_ALLOW_UNNOTARIZED_UPDATES").unwrap_or_default();
    assert!(matches!(allow_unnotarized.as_str(), "" | "false" | "true"),
        "APP_ALLOW_UNNOTARIZED_UPDATES must be true or false");
    println!("cargo:rustc-env=APP_ALLOW_UNNOTARIZED_UPDATES={allow_unnotarized}");
    println!("cargo:rustc-env=APP_IDENTIFIER={identifier}");
    println!("cargo:rustc-env=APP_BUNDLE_NAME={product}.app");
    let feed = if channel.is_empty() { "latest/download".to_string() }
        else { format!("download/channel-{channel}") };
    println!("cargo:rustc-env=APP_RELEASE_REPOSITORY={repository}");
    println!("cargo:rustc-env=APP_RELEASE_CHANNEL={channel}");
    println!("cargo:rustc-env=APP_RELEASE_FEED=https://github.com/{repository}/releases/{feed}");
    tauri_build::build()
}
