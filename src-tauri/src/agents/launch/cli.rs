use super::*;

#[cfg(target_os = "macos")]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "macos")]
pub(super) fn launch_cli_agent(
    executable: &Path,
    label: &str,
    working_directory: &Path,
    arguments: &[String],
    environment_to_remove: &[&str],
    environment_to_set: &[(&str, &str)],
    terminal: &str,
) -> Result<(), String> {
    let removals = environment_to_remove
        .iter()
        .map(|key| format!("-u {}", shell_single_quote(key)))
        .collect::<Vec<_>>()
        .join(" ");
    let assignments = environment_to_set
        .iter()
        .map(|(key, value)| format!("{}={}", shell_single_quote(key), shell_single_quote(value)))
        .collect::<Vec<_>>()
        .join(" ");
    let invocation = std::iter::once(shell_single_quote(&path_to_string(executable)))
        .chain(
            arguments
                .iter()
                .map(|argument| shell_single_quote(argument)),
        )
        .collect::<Vec<_>>()
        .join(" ");
    let command_line = format!(
        "cd {} && exec env {} {} {}",
        shell_single_quote(&path_to_string(working_directory)),
        removals,
        assignments,
        invocation,
    );
    let script = if terminal == "iterm2" {
        format!(
            "tell application \"iTerm2\"\nactivate\nset newWindow to (create window with default profile)\ntell current session of newWindow\nwrite text \"{}\"\nend tell\nend tell",
            command_line.replace('\\', "\\\\").replace('"', "\\\"")
        )
    } else if terminal == "ghostty" {
        format!(
            "tell application \"Ghostty\"\nactivate\nset surfaceConfig to new surface configuration\nset initial input of surfaceConfig to \"{}\\n\"\nnew window with configuration surfaceConfig\nend tell",
            command_line.replace('\\', "\\\\").replace('"', "\\\"")
        )
    } else if matches!(terminal, "auto" | "terminal") {
        format!(
            "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
            command_line.replace('\\', "\\\\").replace('"', "\\\"")
        )
    } else {
        return Err(format!("Failed to start {label}: selected terminal is unsupported"));
    };
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("Failed to start {label} terminal: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("Failed to start {label} terminal: {detail}"))
    }
}

#[cfg(target_os = "linux")]
pub(super) fn launch_cli_agent(
    executable: &Path,
    label: &str,
    working_directory: &Path,
    command_arguments: &[String],
    environment_to_remove: &[&str],
    environment_to_set: &[(&str, &str)],
    terminal: &str,
) -> Result<(), String> {
    let definitions = linux_terminal_definitions();
    let mut last_error = None;
    for definition in definitions {
        let (id, program, arguments, _) = *definition;
        if terminal != "auto" && id != terminal {
            continue;
        }
        if program_on_path(program).is_none() {
            continue;
        }
        let mut command = Command::new(program);
        command
            .args(arguments)
            .arg(executable)
            .args(command_arguments)
            .current_dir(working_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for key in environment_to_remove {
            command.env_remove(key);
        }
        for (key, value) in environment_to_set {
            command.env(key, value);
        }
        match command.spawn() {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    if terminal != "auto" && last_error.is_none() {
        return Err(format!("Failed to start {label}: selected terminal not found"));
    }
    Err(match last_error {
        Some(error) => format!("Failed to start {label}: {error}"),
        None => format!("Failed to start {label}: no available terminal program found"),
    })
}

#[cfg(target_os = "windows")]
pub(super) fn windows_powershell_cli_script(
    executable: &Path,
    working_directory: &Path,
    arguments: &[String],
) -> Result<String, String> {
    let directory = windows_powershell_single_quoted_literal(&path_to_string(working_directory));
    let executable_literal = windows_powershell_single_quoted_literal(&path_to_string(executable));
    // PowerShell hands arguments to a native command with its own quoting, which breaks on
    // embedded quotes, and hands them to a batch file through cmd.exe, which then runs `&`
    // and `%VAR%` from the text. `ProcessStartInfo.Arguments` is the exact command line.
    let process_launch = if arguments
        .first()
        .is_some_and(|arg| matches!(arg.as_str(), "--cpa-antigravity-cli" | "--cpa-copilot-cli"))
    {
        let arguments = arguments
            .iter()
            .map(|argument| {
                let mut quoted = String::from("\"");
                let mut backslashes = 0;
                for ch in argument.chars() {
                    if ch == '\\' {
                        backslashes += 1;
                        continue;
                    }
                    quoted.push_str(&"\\".repeat(if ch == '"' {
                        backslashes * 2 + 1
                    } else {
                        backslashes
                    }));
                    backslashes = 0;
                    quoted.push(ch);
                }
                quoted.push_str(&"\\".repeat(backslashes * 2));
                quoted.push('"');
                quoted
            })
            .collect::<Vec<_>>()
            .join(" ");
        Some((executable_literal.clone(), arguments))
    } else if is_windows_batch_script(executable) && !arguments.is_empty() {
        Some((
            windows_powershell_single_quoted_literal(&path_to_string(&windows_command_processor())),
            windows_cmd_command_line(None, &path_to_string(executable), arguments, false)?,
        ))
    } else {
        None
    };
    if let Some((file_name, process_arguments)) = process_launch {
        return Ok(format!(
            "Set-Location -LiteralPath {directory}; \
             $cpaLaunchInfo = New-Object System.Diagnostics.ProcessStartInfo; \
             $cpaLaunchInfo.FileName = {file_name}; \
             $cpaLaunchInfo.WorkingDirectory = {directory}; \
             $cpaLaunchInfo.UseShellExecute = $false; \
             $cpaLaunchInfo.Arguments = {}; \
             $cpaLaunchProcess = [System.Diagnostics.Process]::Start($cpaLaunchInfo); \
             try {{ $cpaLaunchProcess.WaitForExit(); $global:LASTEXITCODE = $cpaLaunchProcess.ExitCode }} \
             finally {{ $cpaLaunchProcess.Dispose() }}",
            windows_powershell_single_quoted_literal(&process_arguments),
        ));
    }
    let arguments = arguments
        .iter()
        .map(|argument| windows_powershell_single_quoted_literal(argument))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!(
        "Set-Location -LiteralPath {directory}; & {executable_literal} {arguments}"
    ))
}

#[cfg(target_os = "windows")]
pub(super) fn windows_cli_launch_command(
    executable: &Path,
    label: &str,
    working_directory: &Path,
    arguments: &[String],
    terminal: &str,
) -> Result<Command, String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let is_batch_script = is_windows_batch_script(executable);

    let command = match terminal {
        "windows-terminal" => {
            let terminal_executable = program_on_path("wt.exe")
                .ok_or_else(|| format!("Failed to start {label}: Windows Terminal not found"))?;
            let directory = path_to_string(working_directory);
            let mut command = Command::new(terminal_executable);
            command.args(["-d", &directory, "--"]);
            if is_batch_script {
                // Windows Terminal re-quotes this text itself, so cmd.exe quoting cannot
                // be applied; refuse what it would run.
                validate_windows_terminal_batch_arguments(arguments)
                    .map_err(|error| format!("Failed to start {label}: {error}"))?;
                command
                    .arg(windows_command_processor())
                    .args(["/D", "/K", "call"])
                    .arg(format!("\"{}\"", path_to_string(executable)))
                    .args(arguments);
            } else {
                command.arg(executable).args(arguments);
            }
            command
        }
        // A native CLI launched directly by the GUI owns the console lifetime.
        // Use an interactive shell, as with a manual launch, so terminal setup
        // and the window lifetime do not depend on the CLI (notably on Win10).
        "auto" | "powershell" => {
            let mut command = Command::new(windows_powershell_executable());
            let script = windows_powershell_cli_script(executable, working_directory, arguments)
                .map_err(|error| format!("Failed to start {label}: {error}"))?;
            command.args(["-NoLogo", "-NoProfile", "-NoExit", "-Command", &script]);
            command.creation_flags(CREATE_NEW_CONSOLE);
            command
        }
        "cmd" => {
            let mut command = Command::new(windows_command_processor());
            let command_line = windows_cmd_command_line(
                Some(&path_to_string(working_directory)),
                &path_to_string(executable),
                arguments,
                true,
            )
            .map_err(|error| format!("Failed to start {label}: {error}"))?;
            command.raw_arg(command_line);
            command.creation_flags(CREATE_NEW_CONSOLE);
            command
        }
        _ => return Err(format!("Failed to start {label}: selected terminal is unsupported")),
    };
    Ok(command)
}

#[cfg(target_os = "windows")]
pub(super) fn launch_cli_agent(
    executable: &Path,
    label: &str,
    working_directory: &Path,
    arguments: &[String],
    environment_to_remove: &[&str],
    environment_to_set: &[(&str, &str)],
    terminal: &str,
) -> Result<(), String> {
    let mut command = windows_cli_launch_command(
        executable, label, working_directory, arguments, terminal,
    )?;
    command.current_dir(working_directory);
    for key in environment_to_remove {
        command.env_remove(key);
    }
    for (key, value) in environment_to_set {
        command.env(key, value);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to start {label}: {error}"))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub(super) fn launch_cli_agent(
    _executable: &Path,
    label: &str,
    _working_directory: &Path,
    _arguments: &[String],
    _environment_to_remove: &[&str],
    _environment_to_set: &[(&str, &str)],
    _terminal: &str,
) -> Result<(), String> {
    Err(format!("The current platform does not support launching {label}"))
}
