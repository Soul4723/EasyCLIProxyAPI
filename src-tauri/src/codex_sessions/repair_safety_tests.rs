//! Repair refuses to rewrite rollouts while Codex runs, and only updates database rows that match
//! the rollouts it actually left in their final state.

use super::process::FAKE_CODEX_PROCESSES;
use super::tests::test_root;
use super::*;

/// Makes the given named processes look like running Codex processes until dropped.
struct FakeCodexProcesses;

impl FakeCodexProcesses {
    fn running(processes: Vec<(&str, u32)>) -> Self {
        let fake = Self;
        fake.set(processes);
        fake
    }

    fn set(&self, processes: Vec<(&str, u32)>) {
        FAKE_CODEX_PROCESSES.with(|fake| {
            *fake.borrow_mut() = Some(
                processes
                    .into_iter()
                    .map(|(name, id)| (name.to_string(), id))
                    .collect(),
            )
        });
    }
}

impl Drop for FakeCodexProcesses {
    fn drop(&mut self) {
        FAKE_CODEX_PROCESSES.with(|fake| *fake.borrow_mut() = None);
    }
}

fn rollout_text(thread_id: &str, cwd: &str, provider: &str) -> String {
    format!(
        "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{thread_id}\",\"cwd\":\"{cwd}\",\"model_provider\":\"{provider}\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\"}}}}\n"
    )
}

fn write_rollout(root: &Path, name: &str, text: &str) -> PathBuf {
    let path = root.join("sessions").join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    path
}

fn create_database(root: &Path, rows: &[(&str, &str)]) {
    let connection = Connection::open(root.join("state_5.sqlite")).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT, model_provider TEXT, archived INTEGER, has_user_event INTEGER, updated_at_ms INTEGER);",
        )
        .unwrap();
    for (id, cwd) in rows {
        connection
            .execute(
                "INSERT INTO threads VALUES (?1, '', 'Title', ?2, 'openai', 0, 0, 200)",
                (id, cwd),
            )
            .unwrap();
    }
}

fn row(root: &Path, id: &str) -> (String, i64, String) {
    let connection = Connection::open(root.join("state_5.sqlite")).unwrap();
    connection
        .query_row(
            "SELECT model_provider, has_user_event, cwd FROM threads WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

fn row_of(provider: &str, has_user_event: i64, cwd: &str) -> (String, i64, String) {
    (provider.to_string(), has_user_event, cwd.to_string())
}

#[test]
fn repair_refuses_while_codex_is_running_and_changes_nothing() {
    let root = test_root("repair-safety-refuse");
    let original = rollout_text("thread-1", "/new", "openai");
    let rollout = write_rollout(&root, "rollout.jsonl", &original);
    create_database(&root, &[("thread-1", "/old")]);
    let _fake = FakeCodexProcesses::running(vec![("Codex", 4242)]);

    let error = repair_codex_session_metadata_from_home(&root, "cpa-gui", true, |_| {}).unwrap_err();
    assert!(error.contains("still running") && error.contains("4242"), "{error}");
    assert_eq!(fs::read_to_string(&rollout).unwrap(), original);
    assert_eq!(row(&root, "thread-1"), row_of("openai", 0, "/old"));
    assert!(!root.join("backups_state").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn repair_proceeds_once_codex_is_stopped() {
    let root = test_root("repair-safety-stopped");
    let rollout = write_rollout(&root, "rollout.jsonl", &rollout_text("thread-1", "/new", "openai"));
    create_database(&root, &[("thread-1", "/old")]);
    let fake = FakeCodexProcesses::running(vec![("Codex", 4242)]);
    assert!(repair_codex_session_metadata_from_home(&root, "cpa-gui", true, |_| {}).is_err());

    fake.set(Vec::new());
    let result = repair_codex_session_metadata_from_home(&root, "cpa-gui", true, |_| {}).unwrap();
    assert_eq!(result.changed_rollout_files, 1);
    assert!(fs::read_to_string(&rollout).unwrap().contains("\"cpa-gui\""));
    assert_eq!(row(&root, "thread-1"), row_of("cpa-gui", 1, "/new"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn repair_refuses_when_codex_starts_before_the_rewrite() {
    let root = test_root("repair-safety-started");
    let original = rollout_text("thread-1", "/new", "openai");
    let rollout = write_rollout(&root, "rollout.jsonl", &original);
    create_database(&root, &[("thread-1", "/old")]);
    let fake = FakeCodexProcesses::running(Vec::new());

    let error = repair_codex_session_metadata_from_home(&root, "cpa-gui", true, |progress| {
        if progress.phase == "backingUp" {
            fake.set(vec![("Codex", 999)]);
        }
    })
    .unwrap_err();
    assert!(error.contains("still running") && error.contains("999"), "{error}");
    assert_eq!(fs::read_to_string(&rollout).unwrap(), original);
    assert_eq!(row(&root, "thread-1"), row_of("openai", 0, "/old"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn index_cleanup_refuses_while_codex_is_running() {
    let root = test_root("repair-safety-index");
    let _fake = FakeCodexProcesses::running(vec![("Codex", 4242)]);
    let error = apply_session_index_cleanup_from_home(&root, "snapshot", &[], true).unwrap_err();
    assert!(error.contains("still running") && error.contains("4242"), "{error}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
#[cfg(not(target_os = "windows"))]
fn lowercase_codex_cli_blocks_repair_and_index_cleanup() {
    let root = test_root("repair-safety-lowercase-codex");
    let original = rollout_text("thread-1", "/new", "openai");
    let rollout = write_rollout(&root, "rollout.jsonl", &original);
    create_database(&root, &[("thread-1", "/old")]);
    let _fake = FakeCodexProcesses::running(vec![("codex", 4242)]);

    let repair_error =
        repair_codex_session_metadata_from_home(&root, "cpa-gui", true, |_| {}).unwrap_err();
    assert!(
        repair_error.contains("CLI or IDE extension") && repair_error.contains("sync conversations"),
        "{repair_error}"
    );
    assert_eq!(fs::read_to_string(&rollout).unwrap(), original);
    assert_eq!(row(&root, "thread-1"), row_of("openai", 0, "/old"));

    let cleanup_error =
        apply_session_index_cleanup_from_home(&root, "snapshot", &[], true).unwrap_err();
    assert!(
        cleanup_error.contains("process: 4242") && cleanup_error.contains("preview and clean"),
        "{cleanup_error}"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn skipped_rollouts_keep_their_rows_and_the_rest_are_updated() {
    let root = test_root("repair-safety-rows");
    let skipped = write_rollout(&root, "skipped.jsonl", &rollout_text("thread-skip", "/new/skip", "openai"));
    let written = write_rollout(&root, "written.jsonl", &rollout_text("thread-write", "/new/write", "openai"));
    let unchanged_text = rollout_text("thread-ok", "/new/ok", "cpa-gui");
    let unchanged = write_rollout(&root, "unchanged.jsonl", &unchanged_text);
    create_database(
        &root,
        &[
            ("thread-skip", "/old/skip"),
            ("thread-write", "/old/write"),
            ("thread-ok", "/old/ok"),
        ],
    );

    // The skipped rollout grows after the scan, so the rewrite sees it changed.
    let mut appended = None;
    let result = repair_codex_session_metadata_from_home(&root, "cpa-gui", false, |progress| {
        if progress.phase == "rewriting" && progress.processed == 0 && appended.is_none() {
            let text = format!("{}{{\"type\":\"event_msg\"}}\n", fs::read_to_string(&skipped).unwrap());
            fs::write(&skipped, &text).unwrap();
            appended = Some(text);
        }
    })
    .unwrap();

    assert_eq!(result.changed_rollout_files, 1);
    assert!(
        result.warnings.iter().any(|warning| warning.contains("changed during repair")),
        "{:?}",
        result.warnings
    );
    assert!(
        result.warnings.iter().any(|warning| warning.contains("1 skipped session")),
        "{:?}",
        result.warnings
    );
    assert_eq!(fs::read_to_string(&skipped).unwrap(), appended.unwrap());
    assert!(fs::read_to_string(&written).unwrap().contains("\"cpa-gui\""));
    assert_eq!(fs::read_to_string(&unchanged).unwrap(), unchanged_text);

    // Neither the provider, nor the user-event flag, nor the path of the skipped session moved.
    assert_eq!(row(&root, "thread-skip"), row_of("openai", 0, "/old/skip"));
    assert_eq!(row(&root, "thread-write"), row_of("cpa-gui", 1, "/new/write"));
    assert_eq!(row(&root, "thread-ok"), row_of("cpa-gui", 1, "/new/ok"));
    assert_eq!(result.sqlite_rows_updated, 6);
    fs::remove_dir_all(root).unwrap();
}
