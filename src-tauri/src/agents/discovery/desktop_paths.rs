use super::*;

pub(crate) fn claude_desktop_config_paths(_home: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    let (normal, threep) = {
        let support = _home.join("Library/Application Support");
        (support.join("Claude"), support.join("Claude-3p"))
    };
    #[cfg(target_os = "windows")]
    {
        let local = agent_configuration_environment("LOCALAPPDATA")
            .unwrap_or_else(|| _home.join("AppData/Local"));
        claude_desktop_config_paths_from_local_app_data(&local)
    }
    #[cfg(target_os = "linux")]
    let (normal, threep) = {
        let config_home = agent_configuration_environment("XDG_CONFIG_HOME")
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| _home.join(".config"));
        (config_home.join("Claude"), config_home.join("Claude-3p"))
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    return Vec::new();

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        claude_desktop_config_paths_from_directories(normal, threep)
    }
}

pub(crate) fn claude_desktop_config_paths_from_directories(
    normal: PathBuf,
    threep: PathBuf,
) -> Vec<PathBuf> {
    let library = threep.join("configLibrary");
    vec![
        normal.join("claude_desktop_config.json"),
        threep.join("claude_desktop_config.json"),
        library.join(format!("{CLAUDE_DESKTOP_PROFILE_ID}.json")),
        library.join("_meta.json"),
    ]
}

#[cfg(target_os = "windows")]
pub(crate) fn claude_desktop_config_paths_from_local_app_data(
    local_app_data: &Path,
) -> Vec<PathBuf> {
    let normal = find_windows_claude_data_directory(local_app_data, false)
        .unwrap_or_else(|| local_app_data.join("Claude"));
    let threep = find_windows_claude_data_directory(local_app_data, true)
        .unwrap_or_else(|| local_app_data.join("Claude-3p"));
    claude_desktop_config_paths_from_directories(normal, threep)
}

#[cfg(target_os = "windows")]
pub(crate) fn find_windows_claude_data_directory(
    local_app_data: &Path,
    threep: bool,
) -> Option<PathBuf> {
    let exact_name = if threep { "Claude-3p" } else { "Claude" };
    let exact = local_app_data.join(exact_name);
    if exact.is_dir() {
        return Some(exact);
    }

    let mut candidates = fs::read_dir(local_app_data)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                return false;
            };
            let normalized = name.to_ascii_lowercase();
            normalized.starts_with("claude") && normalized.contains("-3p") == threep
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.into_iter().next()
}
