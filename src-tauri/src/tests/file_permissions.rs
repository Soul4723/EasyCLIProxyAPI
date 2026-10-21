use super::support::*;
use super::*;
use std::os::unix::fs::PermissionsExt;

fn mode_of(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o7777
}

fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

/// The mode the direct writer saw right after opening the file, before it chmod-ed or wrote anything. A file created
/// 0600 reads back 0600 here; one created with the default mode and tightened afterwards does not.
fn mode_seen_at_direct_open(write: impl FnOnce()) -> Option<u32> {
    MODE_AFTER_DIRECT_OPEN.with(|recorded| recorded.set(None));
    write();
    MODE_AFTER_DIRECT_OPEN.with(|recorded| recorded.take())
}

fn permission_refusal() -> io::Error {
    io::Error::from(io::ErrorKind::PermissionDenied)
}

#[test]
fn new_core_config_is_created_private() {
    let home = agent_test_home("perm-core-config-new");
    let path = home.join("cpa-core").join(CORE_CONFIG_FILE);
    fs::create_dir_all(path.parent().unwrap()).unwrap();

    let seen = mode_seen_at_direct_open(|| {
        assert!(write_core_config_if_changed(&path, "secret-key: management\n").unwrap());
    });

    assert_eq!(seen, Some(0o600));
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
fn private_direct_writes_repair_a_loose_file() {
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

    let seen = mode_seen_at_direct_open(|| {
        write_agent_configuration_file(AgentClient::ClaudeCode, &path, b"{\"apiKey\":\"client-key\"}\n").unwrap();
    });

    assert_eq!(seen, Some(0o600));
    assert_eq!(mode_of(&path), 0o600);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn agent_config_written_by_the_app_drops_group_and_other_access() {
    let home = agent_test_home("perm-agent-user");
    let path = home.join("settings.json");
    // (mode the user's file had, mode after the app wrote the client key into it)
    for (before, after) in [
        (0o644, 0o600),
        (0o664, 0o600),
        (0o640, 0o600),
        (0o755, 0o700),
        (0o600, 0o600),
        (0o700, 0o700),
    ] {
        fs::write(&path, "{}\n").unwrap();
        set_mode(&path, before);

        write_agent_configuration_file(AgentClient::ClaudeCode, &path, b"{\"apiKey\":\"client-key\"}\n").unwrap();

        assert_eq!(mode_of(&path), after, "{before:o} should become {after:o}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"apiKey\":\"client-key\"}\n");
    }
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn deepseek_harness_credentials_are_private_from_creation() {
    let home = agent_test_home("perm-deepseek");
    let path = home.join(DEEPSEEK_HARNESS_CREDENTIALS_FILE);

    let seen = mode_seen_at_direct_open(|| write_deepseek_harness_file(&path, b"version: 1\n", true).unwrap());
    assert_eq!(seen, Some(0o600), "the file must already be 0600 when it is opened, before any chmod or write");
    assert_eq!(mode_of(&path), 0o600);

    set_mode(&path, 0o644);
    write_deepseek_harness_file(&path, b"version: 2\n", true).unwrap();
    assert_eq!(mode_of(&path), 0o600);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn migrated_core_config_is_private_for_new_and_existing_targets() {
    let root = agent_test_home("perm-core-config-migrate");
    let template = "# New template\nhost: \"\"\nport: 8317\n";
    for existing_target in [false, true] {
        let source = root.join(format!("source-{existing_target}"));
        let target = root.join(format!("target-{existing_target}"));
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join(CORE_CONFIG_FILE), "host: 127.0.0.1\nport: 9527\n").unwrap();
        fs::write(target.join(CORE_EXAMPLE_CONFIG_FILE), template).unwrap();
        if existing_target {
            fs::write(target.join(CORE_CONFIG_FILE), "port: 1\n").unwrap();
            set_mode(&target.join(CORE_CONFIG_FILE), 0o664);
        }

        migrate_core_config_for_update(&source, &target).unwrap();

        let migrated = target.join(CORE_CONFIG_FILE);
        assert!(fs::read_to_string(&migrated).unwrap().contains("9527"));
        assert_eq!(mode_of(&migrated), 0o600, "existing_target={existing_target}");
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_refused_chmod_does_not_fail_the_write() {
    // exFAT, vfat and drvfs refuse chmod with EPERM or ENOTSUP.
    let path = Path::new("config.yaml");
    tolerate_chmod_refusal(Err(permission_refusal()), path).unwrap();
    tolerate_chmod_refusal(Err(io::Error::from(io::ErrorKind::Unsupported)), path).unwrap();
    tolerate_chmod_refusal(Ok(()), path).unwrap();
    assert!(tolerate_chmod_refusal(Err(io::Error::from(io::ErrorKind::NotFound)), path).is_err());

    let home = agent_test_home("perm-refused-chmod");
    let file = home.join(CORE_CONFIG_FILE);
    fs::write(&file, "secret-key: old\n").unwrap();
    set_mode(&file, 0o644);
    for kind in [io::ErrorKind::PermissionDenied, io::ErrorKind::Unsupported] {
        assert!(!restrict_private_permissions_with(&file, |_, _| Err(io::Error::from(kind))).unwrap());
    }
    assert!(restrict_private_permissions_with(&file, |_, _| Err(io::Error::other("disk error"))).is_err());
    assert_eq!(mode_of(&file), 0o644, "a refused repair leaves the file untouched");
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn an_unchanged_core_config_save_succeeds_when_the_repair_fails() {
    let home = agent_test_home("perm-noop-save-repair-fails");
    let path = home.join(CORE_CONFIG_FILE);
    fs::write(&path, "secret-key: same\n").unwrap();
    set_mode(&path, 0o644);

    for error in [permission_refusal(), io::Error::other("disk error")] {
        let changed = write_core_config_if_changed_with(&path, "secret-key: same\n", |_, _| Err(error)).unwrap();
        assert!(!changed);
        assert_eq!(mode_of(&path), 0o644);
        assert_eq!(fs::read_to_string(&path).unwrap(), "secret-key: same\n");
    }
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn agent_record_backups_are_private() {
    let home = agent_test_home("perm-agent-record-backup");
    let first = home.join("first.json");
    let second = home.join("second.json");
    let updates = [&first, &second].map(|path| {
        fs::write(path, b"{\"original\":true}\n").unwrap();
        set_mode(path, 0o644);
        AgentFileUpdate {
            path: path.clone(),
            after: "{\"apiKey\":\"client-key\"}\n".to_string(),
        }
    });

    let record =
        prepare_agent_record(AgentClient::ClaudeDesktop, &[first.clone()], "claude-test", &updates[..1]).unwrap();
    assert_eq!(mode_of(&agent_backup_path(&first).unwrap()), 0o600);

    extend_agent_record_for_updates(&record, &updates).unwrap();
    assert_eq!(mode_of(&agent_backup_path(&second).unwrap()), 0o600);
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn private_atomic_writes_repair_a_loose_file() {
    let home = agent_test_home("perm-private-atomic");
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
