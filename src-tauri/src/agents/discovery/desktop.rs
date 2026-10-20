use super::*;

pub(crate) fn find_codex_app_installation(home: &Path) -> Option<DesktopAppTarget> {
    #[cfg(target_os = "macos")]
    {
        [PathBuf::from("/Applications"), home.join("Applications")]
            .into_iter()
            .flat_map(|directory| {
                [
                    "ChatGPT.app",
                    "Codex.app",
                    "OpenAI Codex.app",
                    "OpenAI.Codex.app",
                ]
                .into_iter()
                .map(move |name| directory.join(name))
            })
            .find(|path| path.is_dir())
            .map(DesktopAppTarget::Application)
    }

    #[cfg(target_os = "windows")]
    {
        find_windows_codex_app_installation(home)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = home;
        None
    }
}

pub(crate) fn find_opencode_desktop_application(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        [
            PathBuf::from("/Applications/OpenCode.app"),
            home.join("Applications/OpenCode.app"),
        ]
        .into_iter()
        .find(|path| path.is_dir())
    }

    #[cfg(target_os = "windows")]
    {
        let local = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| home.join("AppData/Local"));
        let program_files_roots = ["ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(env::var_os)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .collect::<Vec<_>>();
        find_windows_opencode_desktop_application_in_roots(&local, &program_files_roots)
    }

    #[cfg(target_os = "linux")]
    {
        let mut executable_directories = agent_executable_directories(home);
        for directory in ["/opt/OpenCode", "/opt/opencode-desktop"] {
            let directory = PathBuf::from(directory);
            if !executable_directories.contains(&directory) {
                executable_directories.push(directory);
            }
        }

        let data_home = env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".local/share"));
        let mut data_directories = vec![data_home];
        let system_data_directories = env::var_os("XDG_DATA_DIRS")
            .map(|value| env::split_paths(&value).collect::<Vec<_>>())
            .filter(|directories| !directories.is_empty())
            .unwrap_or_else(|| {
                vec![
                    PathBuf::from("/usr/local/share"),
                    PathBuf::from("/usr/share"),
                ]
            });
        for directory in system_data_directories {
            if directory.is_absolute() && !data_directories.contains(&directory) {
                data_directories.push(directory);
            }
        }

        let appimage_directories = [
            home.join("Applications"),
            home.join(".local/Applications"),
            home.join("Downloads"),
            home.join("Desktop"),
        ];
        find_linux_opencode_desktop_application_in_roots(
            home,
            &executable_directories,
            &data_directories,
            &appimage_directories,
        )
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = home;
        None
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn find_windows_opencode_desktop_application_in_roots(
    local_app_data: &Path,
    program_files_roots: &[PathBuf],
) -> Option<PathBuf> {
    let mut candidates = vec![
        local_app_data.join("Programs/@opencode-aidesktop/OpenCode.exe"),
        local_app_data.join("Programs/OpenCode/OpenCode.exe"),
        local_app_data.join("Programs/opencode/OpenCode.exe"),
        local_app_data.join("OpenCode/OpenCode.exe"),
        local_app_data.join("opencode/OpenCode.exe"),
    ];
    for root in program_files_roots {
        candidates.extend([
            root.join("@opencode-aidesktop/OpenCode.exe"),
            root.join("OpenCode/OpenCode.exe"),
            root.join("opencode/OpenCode.exe"),
        ]);
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn find_linux_opencode_desktop_application_in_roots(
    home: &Path,
    executable_directories: &[PathBuf],
    data_directories: &[PathBuf],
    appimage_directories: &[PathBuf],
) -> Option<PathBuf> {
    const EXECUTABLE_NAMES: &[&str] = &[
        "ai.opencode.desktop",
        "ai.opencode.desktop.beta",
        "ai.opencode.desktop.dev",
        "opencode-desktop",
        "@opencode-aidesktop",
        "OpenCode",
        "OpenCode Desktop",
    ];

    for directory in executable_directories {
        for name in EXECUTABLE_NAMES {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    find_linux_opencode_application_from_desktop_entries(
        home,
        executable_directories,
        data_directories,
    )
    .or_else(|| {
        appimage_directories.iter().find_map(|directory| {
            let mut candidates = fs::read_dir(directory)
                .ok()?
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_file() && is_opencode_desktop_appimage(path))
                .collect::<Vec<_>>();
            candidates.sort();
            candidates.into_iter().next()
        })
    })
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn find_linux_opencode_application_from_desktop_entries(
    home: &Path,
    executable_directories: &[PathBuf],
    data_directories: &[PathBuf],
) -> Option<PathBuf> {
    for data_directory in data_directories {
        let applications = data_directory.join("applications");
        let mut entries = fs::read_dir(applications)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("desktop"))
            })
            .collect::<Vec<_>>();
        entries.sort();

        for entry in entries {
            let Ok(content) = fs::read_to_string(&entry) else {
                continue;
            };
            if !is_opencode_desktop_entry(&entry, &content) {
                continue;
            }
            let Some(command) = linux_desktop_entry_command(&content) else {
                continue;
            };
            if let Some(application) =
                resolve_linux_desktop_command(home, executable_directories, command.as_str())
            {
                return Some(application);
            }
        }
    }
    None
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn is_opencode_desktop_entry(path: &Path, content: &str) -> bool {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if file_name.contains("opencode") {
        return true;
    }

    let mut in_desktop_entry = false;
    content.lines().any(|line| {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_desktop_entry = line.eq_ignore_ascii_case("[Desktop Entry]");
            return false;
        }
        if !in_desktop_entry {
            return false;
        }
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        let value = value.trim().to_ascii_lowercase();
        match key.trim() {
            "Name" => {
                value == "opencode"
                    || value.starts_with("opencode beta")
                    || value.starts_with("opencode dev")
            }
            "Icon" | "StartupWMClass" => {
                value.starts_with("ai.opencode.desktop")
                    || value == "@opencode-aidesktop"
                    || value == "opencode"
            }
            _ => false,
        }
    })
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn linux_desktop_entry_command(content: &str) -> Option<String> {
    let mut in_desktop_entry = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_desktop_entry = line.eq_ignore_ascii_case("[Desktop Entry]");
            continue;
        }
        if !in_desktop_entry {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("Exec") {
            continue;
        }
        let tokens = tokenize_linux_desktop_exec(value.trim());
        let mut index = 0;
        if tokens.first().is_some_and(|token| {
            Path::new(token)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "env")
        }) {
            index += 1;
            while tokens.get(index).is_some_and(|token| token.contains('=')) {
                index += 1;
            }
        }
        let command = tokens.get(index)?.trim();
        if command.is_empty()
            || command.starts_with('%')
            || ["flatpak", "snap", "gtk-launch", "sh", "bash"]
                .iter()
                .any(|wrapper| {
                    Path::new(command)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name == *wrapper)
                })
        {
            return None;
        }
        return Some(command.to_string());
    }
    None
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn tokenize_linux_desktop_exec(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;

    for character in value.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if let Some(delimiter) = quote {
            if character == delimiter {
                quote = None;
            } else {
                current.push(character);
            }
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
        } else if character.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn resolve_linux_desktop_command(
    home: &Path,
    executable_directories: &[PathBuf],
    command: &str,
) -> Option<PathBuf> {
    let candidate = if let Some(relative) = command.strip_prefix("~/") {
        home.join(relative)
    } else {
        PathBuf::from(command)
    };
    if candidate.is_absolute() || command.contains('/') {
        return candidate.is_file().then_some(candidate);
    }
    executable_directories
        .iter()
        .map(|directory| directory.join(&candidate))
        .find(|path| path.is_file())
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn is_opencode_desktop_appimage(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let file_name = file_name.to_ascii_lowercase();
    file_name.ends_with(".appimage")
        && (file_name.starts_with("opencode-desktop") || file_name.starts_with("opencode_"))
}

pub(crate) fn read_opencode_desktop_version(application: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        read_windows_executable_version(application)
    }

    #[cfg(target_os = "macos")]
    {
        read_macos_app_version(application)
    }

    #[cfg(target_os = "linux")]
    {
        read_linux_opencode_desktop_version(application)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = application;
        None
    }
}

#[cfg(target_os = "linux")]
pub(super) fn read_linux_opencode_desktop_version(application: &Path) -> Option<String> {
    let path_version = linux_opencode_desktop_version_from_path(application);
    if application
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("appimage"))
    {
        path_version
    } else {
        path_version.or_else(read_linux_opencode_package_version)
    }
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_opencode_desktop_version_from_path(application: &Path) -> Option<String> {
    application
        .components()
        .rev()
        .filter_map(|component| component.as_os_str().to_str())
        .find_map(|component| {
            let lower = component.to_ascii_lowercase();
            if !lower.contains("opencode") {
                return None;
            }
            let component = lower
                .strip_suffix(".appimage")
                .map(|_| &component[..component.len() - ".appimage".len()])
                .unwrap_or(component);
            component.split(['-', '_']).find_map(|token| {
                let version = token.strip_prefix('v').unwrap_or(token);
                (version.starts_with(|character: char| character.is_ascii_digit())
                    && version.contains('.')
                    && version.chars().all(|character| {
                        character.is_ascii_alphanumeric() || matches!(character, '.' | '+' | '~')
                    }))
                .then(|| version.to_string())
            })
        })
}

#[cfg(target_os = "linux")]
pub(super) fn read_linux_opencode_package_version() -> Option<String> {
    const PACKAGE_NAMES: &[&str] = &[
        "opencode",
        "opencode-desktop",
        "opencode-ai-desktop",
        "opencode-aidesktop",
    ];

    let mut dpkg = Command::new("dpkg-query");
    dpkg.args(["--show", "--showformat=${Package}\\t${Version}\\n"])
        .args(PACKAGE_NAMES);
    if let Some(version) = linux_package_version_from_output(&mut dpkg, '\t') {
        return Some(version);
    }

    let mut rpm = Command::new("rpm");
    rpm.args(["--query", "--queryformat", "%{NAME}\\t%{VERSION}\\n"])
        .args(PACKAGE_NAMES);
    if let Some(version) = linux_package_version_from_output(&mut rpm, '\t') {
        return Some(version);
    }

    let mut pacman = Command::new("pacman");
    pacman.arg("--query").args(PACKAGE_NAMES);
    linux_package_version_from_output(&mut pacman, ' ')
}

#[cfg(target_os = "linux")]
pub(super) fn linux_package_version_from_output(command: &mut Command, separator: char) -> Option<String> {
    configure_background_command(command);
    let output = match command_output_with_timeout(command, AGENT_VERSION_PROBE_TIMEOUT).ok()? {
        CommandOutputOutcome::Completed(output) => output,
        CommandOutputOutcome::TimedOut(timeout) => {
            log_probe_timeout("Agent package version", &timeout);
            return None;
        }
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            let (package, version) = line.trim().split_once(separator)?;
            let package = package.trim();
            let version = version.trim();
            ([
                "opencode",
                "opencode-desktop",
                "opencode-ai-desktop",
                "opencode-aidesktop",
            ]
            .contains(&package))
            .then(|| normalize_detected_agent_version(version))
            .flatten()
        })
}

pub(crate) fn read_claude_desktop_version(home: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        read_windows_claude_desktop_store_version().or_else(|| {
            find_claude_desktop_executable(home)
                .and_then(|path| read_windows_executable_version(&path))
        })
    }
    #[cfg(target_os = "macos")]
    {
        find_claude_desktop_executable(home).and_then(|path| {
            let application = path.ancestors().find(|candidate| {
                candidate.extension().and_then(|value| value.to_str()) == Some("app")
            })?;
            read_macos_app_version(application)
        })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = home;
        None
    }
}

pub(crate) fn read_codex_app_installation_version(
    installation: &DesktopAppTarget,
    _home: &Path,
) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        match installation {
            DesktopAppTarget::WindowsAppId(app_id) => read_windows_codex_store_version(app_id),
            DesktopAppTarget::Application(path) => read_windows_codex_desktop_version(path),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let DesktopAppTarget::Application(path) = installation;
        read_macos_app_version(path)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = installation;
        None
    }
}

pub(crate) fn read_zcode_app_version(executable: &Path) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        read_windows_executable_version(executable)
    }
    #[cfg(target_os = "macos")]
    {
        let application = executable
            .ancestors()
            .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))?;
        read_macos_app_version(application)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = executable;
        None
    }
}

pub(crate) fn find_zcode_desktop_executable(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| home.join("AppData/Local"));
        let mut candidates = vec![
            local.join("Programs/ZCode/ZCode.exe"),
            local.join("ZCode/ZCode.exe"),
        ];
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = env::var_os(variable)
                .map(PathBuf::from)
                .filter(|path| !path.as_os_str().is_empty())
            {
                candidates.push(root.join("ZCode/ZCode.exe"));
            }
        }
        candidates
            .into_iter()
            .find(|path| path.is_file())
            .or_else(|| find_named_agent_executable(home, &["zcode"]))
            .or_else(find_windows_registered_zcode_executable)
    }
    #[cfg(target_os = "macos")]
    {
        [
            PathBuf::from("/Applications/ZCode.app/Contents/MacOS/ZCode"),
            home.join("Applications/ZCode.app/Contents/MacOS/ZCode"),
        ]
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| find_named_agent_executable(home, &["zcode"]))
    }
    #[cfg(target_os = "linux")]
    {
        let mut candidates = agent_executable_directories(home)
            .into_iter()
            .flat_map(|directory| [directory.join("zcode"), directory.join("ZCode")])
            .collect::<Vec<_>>();
        candidates.extend([
            PathBuf::from("/opt/ZCode/zcode"),
            PathBuf::from("/opt/ZCode/ZCode"),
            PathBuf::from("/opt/zcode/zcode"),
        ]);
        candidates.into_iter().find(|path| path.is_file())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        find_named_agent_executable(home, &["zcode"])
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn read_macos_app_version(application: &Path) -> Option<String> {
    let info_plist = application.join("Contents/Info.plist");
    for key in ["CFBundleShortVersionString", "CFBundleVersion"] {
        let mut command = Command::new("/usr/bin/plutil");
        command
            .args(["-extract", key, "raw", "-o", "-"])
            .arg(&info_plist);
        let outcome = command_output_with_timeout(&mut command, AGENT_VERSION_PROBE_TIMEOUT).ok()?;
        let output = match outcome {
            CommandOutputOutcome::Completed(output) => output,
            CommandOutputOutcome::TimedOut(timeout) => {
                log_probe_timeout("macOS app version", &timeout);
                continue;
            }
        };
        if !output.status.success() {
            continue;
        }
        if let Some(version) =
            normalize_detected_agent_version(&String::from_utf8_lossy(&output.stdout))
        {
            return Some(version);
        }
    }
    None
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_system_root() -> PathBuf {
    env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_powershell_executable() -> PathBuf {
    let executable = windows_system_root().join("System32/WindowsPowerShell/v1.0/powershell.exe");
    if executable.is_file() {
        executable
    } else {
        PathBuf::from("powershell.exe")
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_explorer_executable() -> PathBuf {
    let executable = windows_system_root().join("explorer.exe");
    if executable.is_file() {
        executable
    } else {
        PathBuf::from("explorer.exe")
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_command_processor() -> PathBuf {
    env::var_os("ComSpec")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| windows_system_root().join("System32/cmd.exe"))
}

#[cfg(target_os = "windows")]
pub(crate) fn find_windows_codex_app_installation(home: &Path) -> Option<DesktopAppTarget> {
    find_windows_codex_app_executable(home)
        .map(DesktopAppTarget::Application)
        .or_else(find_windows_registered_codex_app_installation)
        .or_else(|| find_windows_codex_app_id_via_registry().map(DesktopAppTarget::WindowsAppId))
}

#[cfg(target_os = "windows")]
pub(crate) fn read_windows_codex_store_version(app_id: &str) -> Option<String> {
    find_windows_codex_store_executable(app_id)
        .and_then(|path| read_windows_codex_desktop_version(&path))
}

#[cfg(target_os = "windows")]
pub(crate) fn read_windows_codex_desktop_version(executable: &Path) -> Option<String> {
    let resources = executable.parent()?.join("resources");
    let owl_ini = resources.join("owl-app.ini");
    let asar = resources.join("app.asar");
    fs::read_to_string(&owl_ini)
        .ok()
        .and_then(|content| parse_codex_owl_app_version(&content))
        .or_else(|| read_codex_asar_version(&asar))
        .or_else(|| {
            if owl_ini.exists() || asar.exists() || resources.join("owl-electron-app.json").exists()
            {
                None
            } else {
                read_windows_executable_version(executable)
            }
        })
}

#[cfg(target_os = "windows")]
pub(crate) fn parse_codex_owl_app_version(content: &str) -> Option<String> {
    let mut in_owl_section = false;
    for line in content
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
    {
        if line.starts_with('[') && line.ends_with(']') {
            in_owl_section = line.eq_ignore_ascii_case("[Owl]");
        } else if in_owl_section {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim().eq_ignore_ascii_case("AppVersion") {
                    return normalize_detected_agent_version(value);
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
pub(crate) fn read_codex_asar_version(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = fs::File::open(path).ok()?;
    let mut prefix = [0_u8; 16];
    file.read_exact(&mut prefix).ok()?;
    let word = |offset| u32::from_le_bytes(prefix[offset..offset + 4].try_into().unwrap()) as u64;
    let header_size = word(4);
    let json_size = word(12);
    if word(0) != 4
        || !(8..=16 * 1024 * 1024).contains(&header_size)
        || word(8) != header_size - 4
        || json_size > header_size - 8
    {
        return None;
    }
    let mut header = vec![0; json_size as usize];
    file.read_exact(&mut header).ok()?;
    let header: serde_json::Value = serde_json::from_slice(&header).ok()?;
    let entry = header.get("files")?.get("package.json")?;
    if entry.get("unpacked").and_then(serde_json::Value::as_bool) == Some(true) {
        return None;
    }
    let size = entry.get("size")?.as_u64()?;
    if size > 1024 * 1024 {
        return None;
    }
    let offset = entry.get("offset")?.as_str()?.parse::<u64>().ok()?;
    let position = (8 + header_size).checked_add(offset)?;
    if position.checked_add(size)? > file.metadata().ok()?.len() {
        return None;
    }
    file.seek(SeekFrom::Start(position)).ok()?;
    let mut package = vec![0; size as usize];
    file.read_exact(&mut package).ok()?;
    let package: serde_json::Value = serde_json::from_slice(&package).ok()?;
    normalize_detected_agent_version(package.get("version")?.as_str()?)
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_powershell_single_quoted_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(target_os = "windows")]
pub(crate) fn find_windows_codex_app_executable(home: &Path) -> Option<PathBuf> {
    let local = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Local"));
    let mut candidates = vec![
        local.join("Programs/OpenAI/ChatGPT/ChatGPT.exe"),
        local.join("Programs/ChatGPT/ChatGPT.exe"),
        local.join("OpenAI/ChatGPT/ChatGPT.exe"),
        local.join("OpenAI/Codex/Codex.exe"),
        local.join("Programs/OpenAI/Codex/Codex.exe"),
        local.join("Programs/Codex/Codex.exe"),
        local.join("Microsoft/WindowsApps/ChatGPT.exe"),
    ];
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        let Some(root) = env::var_os(variable)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
        else {
            continue;
        };
        candidates.extend([
            root.join("OpenAI/ChatGPT/ChatGPT.exe"),
            root.join("ChatGPT/ChatGPT.exe"),
            root.join("OpenAI/Codex/Codex.exe"),
            root.join("Codex/Codex.exe"),
        ]);
    }
    candidates.into_iter().find(|path| path.is_file())
}
