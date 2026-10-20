use super::support::*;
use super::*;
use std::os::unix::fs::PermissionsExt;

fn mode_of(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o7777
}

fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
fn new_core_config_is_created_private() {
    let home = agent_test_home("perm-core-config-new");
    let path = home.join("cpa-core").join(CORE_CONFIG_FILE);
    fs::create_dir_all(path.parent().unwrap()).unwrap();

    assert!(write_core_config_if_changed(&path, "secret-key: management\n").unwrap());

    assert_eq!(mode_of(&path), 0o600);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn existing_loose_core_config_is_repaired_on_the_next_write() {
    let home = agent_test_home("perm-core-config-loose");
    let path = home.join(CORE_CONFIG_FILE);
    fs::write(&path, "secret-key: old\n").unwrap();
    set_mode(&path, 0o644);

    assert!(write_core_config_if_changed(&path, "secret-key: new\n").unwrap());
    assert_eq!(mode_of(&path), 0o600);
    assert_eq!(fs::read_to_string(&path).unwrap(), "secret-key: new\n");

    set_mode(&path, 0o644);
    assert!(!write_core_config_if_changed(&path, "secret-key: new\n").unwrap());
    assert_eq!(mode_of(&path), 0o600, "an unchanged save repairs loose permissions");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn migrated_core_config_is_private() {
    let home = agent_test_home("perm-core-config-private-direct");
    let path = home.join(CORE_CONFIG_FILE);
    fs::write(&path, "secret-key: old\n").unwrap();
    set_mode(&path, 0o664);

    write_private_bytes_directly(&path, b"secret-key: migrated\n").unwrap();

    assert_eq!(mode_of(&path), 0o600);
    assert_eq!(fs::read_to_string(&path).unwrap(), "secret-key: migrated\n");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn agent_config_created_by_the_app_is_private() {
    let home = agent_test_home("perm-agent-new");
    let path = home.join(".claude").join("settings.json");

    write_agent_configuration_file(AgentClient::ClaudeCode, &path, b"{\"apiKey\":\"client-key\"}\n").unwrap();

    assert_eq!(mode_of(&path), 0o600);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn agent_config_created_by_the_user_keeps_its_mode() {
    let home = agent_test_home("perm-agent-user");
    let path = home.join("settings.json");
    fs::write(&path, "{}\n").unwrap();
    set_mode(&path, 0o644);

    write_agent_configuration_file(AgentClient::ClaudeCode, &path, b"{\"apiKey\":\"client-key\"}\n").unwrap();
    assert_eq!(mode_of(&path), 0o644);

    set_mode(&path, 0o640);
    write_agent_configuration_file(AgentClient::ClaudeCode, &path, b"{}\n").unwrap();
    assert_eq!(mode_of(&path), 0o640);
    assert_eq!(fs::read_to_string(&path).unwrap(), "{}\n");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn deepseek_harness_credentials_are_private_from_creation() {
    let home = agent_test_home("perm-deepseek");
    let path = home.join(DEEPSEEK_HARNESS_CREDENTIALS_FILE);
    write_deepseek_harness_file(&path, b"version: 1\n", true).unwrap();
    assert_eq!(mode_of(&path), 0o600);

    set_mode(&path, 0o644);
    write_deepseek_harness_file(&path, b"version: 2\n", true).unwrap();
    assert_eq!(mode_of(&path), 0o600);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn agent_backups_of_config_files_are_private() {
    let home = agent_test_home("perm-agent-backup");
    let path = home.join("backup.json");
    fs::write(&path, b"old").unwrap();
    set_mode(&path, 0o644);

    write_private_bytes_atomically(&path, b"{\"apiKey\":\"client-key\"}").unwrap();

    assert_eq!(mode_of(&path), 0o600);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn core_log_and_its_new_directory_are_private() {
    let home = agent_test_home("perm-core-log");
    let log_path = home.join("logs").join("core-start-output.log");

    drop(core_start_stdio(&log_path).unwrap());

    assert_eq!(mode_of(&log_path), 0o600);
    assert_eq!(mode_of(log_path.parent().unwrap()), 0o700);

    set_mode(&log_path, 0o644);
    drop(core_start_stdio(&log_path).unwrap());
    assert_eq!(mode_of(&log_path), 0o600, "a loose existing log is repaired");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn existing_core_log_directory_keeps_its_mode() {
    let home = agent_test_home("perm-core-log-existing-dir");
    let logs = home.join("logs");
    fs::create_dir_all(&logs).unwrap();
    set_mode(&logs, 0o755);

    drop(core_start_stdio(&logs.join("core-start-output.log")).unwrap());

    assert_eq!(mode_of(&logs), 0o755);
    assert_eq!(mode_of(&logs.join("core-start-output.log")), 0o600);
    fs::remove_dir_all(home).unwrap();
}
