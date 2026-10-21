use super::*;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTerminalOption {
    pub(crate) id: String,
    pub(crate) label: String,
}

fn terminal_option(id: &str, label: &str) -> AgentTerminalOption {
    AgentTerminalOption {
        id: id.to_string(),
        label: label.to_string(),
    }
}

pub(super) fn program_on_path(program: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path).find_map(|directory| {
        let candidate = directory.join(program);
        candidate.is_file().then_some(candidate)
    })
}

#[cfg(target_os = "macos")]
fn macos_iterm2_installed() -> bool {
    Path::new("/Applications/iTerm.app").is_dir()
        || env::var_os("HOME")
            .map(PathBuf::from)
            .is_some_and(|home| home.join("Applications/iTerm.app").is_dir())
}

#[cfg(target_os = "macos")]
fn macos_ghostty_installed() -> bool {
    Path::new("/Applications/Ghostty.app").is_dir()
        || env::var_os("HOME")
            .map(PathBuf::from)
            .is_some_and(|home| home.join("Applications/Ghostty.app").is_dir())
}

#[cfg(target_os = "linux")]
pub(super) fn linux_terminal_definitions() -> &'static [(
    &'static str,
    &'static str,
    &'static [&'static str],
    &'static str,
)] {
    &[
        (
            "x-terminal-emulator",
            "x-terminal-emulator",
            &["-e"],
            "System terminal",
        ),
        (
            "gnome-terminal",
            "gnome-terminal",
            &["--"],
            "GNOME Terminal",
        ),
        ("konsole", "konsole", &["-e"], "Konsole"),
        ("xfce4-terminal", "xfce4-terminal", &["-e"], "Xfce Terminal"),
        ("mate-terminal", "mate-terminal", &["--"], "MATE Terminal"),
        ("kitty", "kitty", &["-e"], "Kitty"),
        ("alacritty", "alacritty", &["-e"], "Alacritty"),
        ("ghostty", "ghostty", &["-e"], "Ghostty"),
        ("xterm", "xterm", &["-e"], "XTerm"),
    ]
}

pub(crate) fn available_agent_terminals() -> Vec<AgentTerminalOption> {
    let mut options = vec![terminal_option("auto", "Automatic")];
    #[cfg(target_os = "macos")]
    {
        options.push(terminal_option("terminal", "Terminal"));
        if macos_iterm2_installed() {
            options.push(terminal_option("iterm2", "iTerm2"));
        }
        if macos_ghostty_installed() {
            options.push(terminal_option("ghostty", "Ghostty"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        if program_on_path("wt.exe").is_some() {
            options.push(terminal_option("windows-terminal", "Windows Terminal"));
        }
        let powershell = windows_powershell_executable();
        if powershell.is_file() {
            options.push(terminal_option("powershell", "PowerShell"));
        }
        let command_prompt = windows_command_processor();
        if command_prompt.is_file() {
            options.push(terminal_option("cmd", "Command Prompt"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        for (id, program, _, label) in linux_terminal_definitions() {
            if program_on_path(program).is_some() {
                options.push(terminal_option(id, label));
            }
        }
    }
    options
}

pub(crate) fn normalize_agent_terminal(value: &str) -> String {
    let value = value.trim();
    if available_agent_terminals()
        .iter()
        .any(|option| option.id == value)
    {
        value.to_string()
    } else {
        DEFAULT_AGENT_TERMINAL.to_string()
    }
}
