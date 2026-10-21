use super::*;

pub(crate) fn find_agent_executable(client: AgentClient, home: &Path) -> Option<PathBuf> {
    if client == AgentClient::CopilotCli { return detect_copilot_cli(home, None).map(|(path, _)| path); }
    if client == AgentClient::AntigravityCli { return find_antigravity_cli(home); }
    if client == AgentClient::ClaudeDesktop {
        return find_claude_desktop_executable(home);
    }
    if client == AgentClient::ZCode {
        return find_zcode_desktop_executable(home);
    }
    if client == AgentClient::WorkBuddy {
        return find_workbuddy_desktop_executable(home);
    }
    if client == AgentClient::KimiCode {
        return find_kimi_code_executable(home);
    }
    if client == AgentClient::GrokBuild {
        return find_grok_build_executable(home);
    }
    if client == AgentClient::Omp {
        return find_omp_executable(home);
    }
    if client == AgentClient::OpenCode {
        return find_opencode_executable(home);
    }
    if client == AgentClient::DeepSeekHarness {
        return find_deepseek_harness_executable(home);
    }
    find_named_agent_executable(home, client.executable_names())
}

pub(crate) fn find_opencode_executable(home: &Path) -> Option<PathBuf> {
    find_named_agent_executable(home, &["opencode"])
        .or_else(|| find_opencode_managed_executable(home))
        .or_else(|| find_named_agent_executable(home, &["opencode-cli"]))
}

pub(crate) fn find_opencode_managed_executable(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        [
            home.join(".opencode/bin/opencode"),
            PathBuf::from("/Applications/OpenCode.app/Contents/MacOS/opencode-cli"),
            home.join("Applications/OpenCode.app/Contents/MacOS/opencode-cli"),
        ]
        .into_iter()
        .find(|path| agent_cli_executable(path))
    }
    #[cfg(not(target_os = "macos"))]
    {
        find_named_agent_executable_in_directories(&[home.join(".opencode/bin")], &["opencode"])
    }
}

pub(crate) fn find_deepseek_harness_executable(home: &Path) -> Option<PathBuf> {
    find_named_agent_executable(home, &["dsh"])
        .or_else(|| find_deepseek_harness_managed_executable(home))
}

pub(crate) fn find_deepseek_harness_managed_executable(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let roots = [home.join("Applications"), PathBuf::from("/Applications")];
        find_deepseek_harness_managed_executable_in_roots(home, &roots)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let dsh_home = deepseek_harness_home(home);
        find_named_agent_executable_in_directories(&[dsh_home.join("bin"), home.join(".dsh/bin")], &["dsh"])
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn find_deepseek_harness_managed_executable_in_roots(
    home: &Path,
    app_roots: &[PathBuf],
) -> Option<PathBuf> {
    let dsh_home_bin = deepseek_harness_home(home).join("bin/dsh");
    let mut candidates = vec![dsh_home_bin, home.join(".dsh/bin/dsh")];
    candidates.extend(
        app_roots
            .iter()
            .map(|root| root.join("DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh")),
    );
    candidates
        .into_iter()
        .find(|path| agent_cli_executable(path))
}

pub(crate) fn find_kimi_code_executable(home: &Path) -> Option<PathBuf> {
    let directory = kimi_code_home(home).join("bin");
    #[cfg(target_os = "windows")]
    let managed = [directory.join("kimi.exe"), directory.join("kimi.cmd")];
    #[cfg(not(target_os = "windows"))]
    let managed = [directory.join("kimi")];
    managed
        .into_iter()
        .find(|path| agent_cli_executable(path))
        .or_else(|| find_named_agent_executable(home, &["kimi"]))
}

pub(crate) fn find_grok_build_executable(home: &Path) -> Option<PathBuf> {
    let directory = grok_build_home(home).join("bin");
    #[cfg(target_os = "windows")]
    let managed = [directory.join("grok.exe"), directory.join("grok.cmd")];
    #[cfg(not(target_os = "windows"))]
    let managed = [directory.join("grok")];
    managed
        .into_iter()
        .find(|path| agent_cli_executable(path))
        .or_else(|| find_named_agent_executable(home, &["grok"]))
}

pub(crate) fn find_pi_executable(home: &Path) -> Option<PathBuf> {
    find_named_agent_executable(home, &["pi"])
}

pub(crate) fn find_named_agent_executable(home: &Path, names: &[&str]) -> Option<PathBuf> {
    find_named_agent_executable_in_directories(&agent_executable_directories(home), names)
}

pub(crate) fn agent_cli_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(target_os = "windows")]
    {
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                ["exe", "cmd", "bat", "com"]
                    .iter()
                    .any(|expected| extension.eq_ignore_ascii_case(expected))
            })
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    true
}

pub(crate) fn find_named_agent_executable_in_directories(
    directories: &[PathBuf],
    names: &[&str],
) -> Option<PathBuf> {
    for directory in directories {
        for name in names {
            #[cfg(target_os = "windows")]
            let candidates = [
                directory.join(format!("{name}.exe")),
                directory.join(format!("{name}.cmd")),
                directory.join(format!("{name}.bat")),
                directory.join(format!("{name}.com")),
            ];
            #[cfg(not(target_os = "windows"))]
            let candidates = [directory.join(name)];
            if let Some(candidate) = candidates
                .into_iter()
                .find(|path| agent_cli_executable(path))
            {
                return Some(candidate);
            }
        }
    }
    None
}

pub(crate) fn agent_executable_directories(home: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    let registered = windows_registered_path_directories();
    #[cfg(not(target_os = "windows"))]
    let registered = Vec::new();
    agent_executable_directories_from_environment(home, |name| env::var_os(name), &registered)
}

pub(crate) fn agent_executable_directories_from_environment(
    home: &Path,
    environment: impl Fn(&str) -> Option<std::ffi::OsString>,
    registered: &[PathBuf],
) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut push = |path: PathBuf| {
        if !path.as_os_str().is_empty() && !directories.iter().any(|item| item == &path) {
            directories.push(path);
        }
    };

    if let Some(path) = environment("PATH") {
        env::split_paths(&path).for_each(&mut push);
    }
    registered.iter().cloned().for_each(&mut push);
    [
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
        home.join(".cargo/bin"),
        home.join(".volta/bin"),
        home.join(".local/share/pnpm"),
        home.join(".pyenv/shims"),
        home.join("bin"),
    ]
    .into_iter()
    .for_each(&mut push);
    for variable in [
        "PNPM_HOME",
        "BUN_INSTALL",
        "NPM_CONFIG_PREFIX",
        "npm_config_prefix",
        "VOLTA_HOME",
        "UV_TOOL_BIN_DIR",
        "NVM_SYMLINK",
    ] {
        if let Some(path) = environment(variable).filter(|path| !path.is_empty()) {
            let path = PathBuf::from(path);
            if matches!(variable, "NPM_CONFIG_PREFIX" | "npm_config_prefix") {
                push(if cfg!(target_os = "windows") {
                    path
                } else {
                    path.join("bin")
                });
            } else {
                push(if matches!(variable, "BUN_INSTALL" | "VOLTA_HOME") {
                    path.join("bin")
                } else {
                    path
                });
            }
        }
    }
    for root in [
        home.join(".nvm/versions/node"),
        home.join(".local/state/fnm_multishells"),
    ] {
        if let Ok(entries) = fs::read_dir(root) {
            let mut entries = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect::<Vec<_>>();
            entries.sort();
            for entry in entries.into_iter().rev() {
                push(entry.join("bin"));
            }
        }
    }

    #[cfg(unix)]
    for path in ["/usr/local/bin", "/usr/bin", "/bin"] {
        push(PathBuf::from(path));
    }

    #[cfg(target_os = "macos")]
    push(PathBuf::from("/opt/homebrew/bin"));

    #[cfg(target_os = "windows")]
    {
        let app_data = environment("APPDATA")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"));
        let local = environment("LOCALAPPDATA")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"));
        push(app_data.join("npm"));
        push(home.join(".npm-global"));
        push(local.join("Microsoft/WindowsApps"));
        push(local.join("pnpm"));
        push(local.join("Volta/bin"));
        for root in [local.join("Programs/Python"), local.join("Python")] {
            if let Ok(entries) = fs::read_dir(root) {
                let mut entries = entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.is_dir())
                    .collect::<Vec<_>>();
                entries.sort();
                for entry in entries.into_iter().rev() {
                    push(entry.join("Scripts"));
                }
            }
        }
    }

    directories
}

pub(crate) fn find_claude_desktop_executable(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        [
            PathBuf::from("/Applications/Claude.app/Contents/MacOS/Claude"),
            home.join("Applications/Claude.app/Contents/MacOS/Claude"),
        ]
        .into_iter()
        .find(|path| path.is_file())
    }
    #[cfg(target_os = "windows")]
    {
        let local = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"));
        [
            local.join("Programs/Claude/Claude.exe"),
            local.join("Claude/Claude.exe"),
        ]
        .into_iter()
        .find(|path| path.is_file())
    }
    #[cfg(target_os = "linux")]
    {
        let mut candidates = agent_executable_directories(home)
            .into_iter()
            .map(|directory| directory.join("claude-desktop"))
            .collect::<Vec<_>>();
        candidates.extend([
            PathBuf::from("/opt/Claude/claude-desktop"),
            PathBuf::from("/opt/Claude/claude"),
            PathBuf::from("/opt/claude-desktop/claude-desktop"),
        ]);
        candidates.into_iter().find(|path| path.is_file())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = home;
        None
    }
}

/// A command that runs `executable` with `arguments`.
///
/// On Windows a `.cmd`/`.bat` file runs through `cmd.exe` with a line built by
/// `windows_cmd_command_line`, so `&`, `"` and `%` in an argument stay data. Fails when an
/// argument cannot be expressed on a `cmd.exe` command line (a line break).
pub(crate) fn command_for_executable<S: AsRef<str>>(
    executable: &Path,
    arguments: &[S],
) -> Result<Command, String> {
    #[cfg(target_os = "windows")]
    if is_windows_batch_script(executable) {
        use std::os::windows::process::CommandExt;

        let line = windows_cmd_command_line(None, &path_to_string(executable), arguments, false)?;
        let mut command = Command::new(windows_command_processor());
        command.raw_arg(line);
        return Ok(command);
    }
    let mut command = Command::new(executable);
    command.args(arguments.iter().map(<S as AsRef<str>>::as_ref));
    Ok(command)
}
