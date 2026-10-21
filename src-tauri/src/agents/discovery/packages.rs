use super::*;

pub(crate) fn agent_command_path(
    home: &Path,
    executable: &Path,
) -> Result<std::ffi::OsString, String> {
    let mut directories = agent_executable_directories(home);
    if let Some(executable_directory) = executable
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        directories.retain(|directory| directory != executable_directory);
        directories.insert(0, executable_directory.to_path_buf());
    }

    env::join_paths(directories).map_err(|error| format!("Failed to construct agent command PATH: {error}"))
}

pub(crate) fn configure_agent_command_environment(
    command: &mut Command,
    home: &Path,
    executable: &Path,
) -> Result<(), String> {
    command.env("PATH", agent_command_path(home, executable)?);
    Ok(())
}

pub(crate) fn install_pi_package(
    executable: &Path,
    home: &Path,
    proxy_url: &str,
) -> Result<(), String> {
    let mut command = command_for_executable(executable, &["install", PI_CLIPROXYAPI_PACKAGE])?;
    command
        .current_dir(home)
        .stdin(Stdio::null());
    configure_background_command(&mut command);
    configure_networked_command(&mut command, proxy_url);
    configure_agent_command_environment(&mut command, home, executable)?;
    let output = command
        .output()
        .map_err(|error| format!("Failed to run Pi plugin installation: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(format!(
        "Pi CLIProxyAPI provider plugin installation failed{}",
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    ))
}

pub(crate) fn update_pi_package(
    executable: &Path,
    home: &Path,
    proxy_url: &str,
) -> Result<(), String> {
    let mut command =
        command_for_executable(executable, &["update", "--extension", PI_CLIPROXYAPI_PACKAGE])?;
    command
        .current_dir(home)
        .stdin(Stdio::null());
    configure_background_command(&mut command);
    configure_networked_command(&mut command, proxy_url);
    configure_agent_command_environment(&mut command, home, executable)?;
    let output = command
        .output()
        .map_err(|error| format!("Failed to run Pi plugin update: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(format!(
        "Pi CLIProxyAPI provider plugin update failed{}",
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    ))
}

pub(crate) fn remove_pi_package(executable: &Path, home: &Path) -> Result<(), String> {
    let mut command = command_for_executable(executable, &["remove", PI_CLIPROXYAPI_PACKAGE])?;
    command
        .current_dir(home)
        .stdin(Stdio::null());
    configure_background_command(&mut command);
    configure_agent_command_environment(&mut command, home, executable)?;
    let output = command
        .output()
        .map_err(|error| format!("Failed to run Pi plugin uninstall: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    Err(format!(
        "Pi CLIProxyAPI provider plugin uninstall failed{}",
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    ))
}
