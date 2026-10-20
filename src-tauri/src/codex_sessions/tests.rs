    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_tasklist_parser_accepts_csv_rows_and_ignores_status_messages() {
        let output = b"\"ChatGPT.exe\",\"1234\",\"Console\",\"1\",\"10,000 K\"\r\nINFO: No tasks are running which match the specified criteria.\r\n\"ChatGPT.exe\",\"5678\",\"Console\",\"1\",\"20,000 K\"\r\n";
        assert_eq!(parse_windows_tasklist_process_ids(output), vec![1234, 5678]);
    }

    pub(super) fn test_root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "easy-cli-proxy-codex-sessions-{name}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn create_threads_db(path: &Path, rollout: &Path) {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT, model_provider TEXT, archived INTEGER, has_user_event INTEGER, updated_at_ms INTEGER);\n\
                 CREATE TABLE thread_dynamic_tools (thread_id TEXT, name TEXT);\n\
                 CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads VALUES ('thread-1', ?1, 'First', 'C:/old', 'openai', 0, 0, 200)",
                [rollout.to_string_lossy().as_ref()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO thread_dynamic_tools VALUES ('thread-1', 'tool')",
                [],
            )
            .unwrap();
    }

    #[test]
    fn list_merges_threads_and_automation_rows_in_update_order() {
        let root = test_root("list");
        let sqlite = root.join("sqlite");
        fs::create_dir_all(&sqlite).unwrap();
        let rollout = root.join("sessions/rollout.jsonl");
        fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        fs::write(&rollout, "{}\n").unwrap();
        create_threads_db(&root.join("state_5.sqlite"), &rollout);
        let automation = Connection::open(sqlite.join("codex-dev.db")).unwrap();
        automation
            .execute_batch(
                "CREATE TABLE automation_runs (thread_id TEXT PRIMARY KEY, status TEXT, thread_title TEXT, source_cwd TEXT, updated_at INTEGER);\n\
                 INSERT INTO automation_runs VALUES ('thread-1', 'running', 'First new', 'C:/newer', 4);\n\
                 INSERT INTO automation_runs VALUES ('thread-2', 'archived', 'Second', 'C:/new', 3);",
            )
            .unwrap();
        drop(automation);

        let page = list_codex_sessions_from_home(&root, 0, 50).unwrap();
        assert_eq!(page.sessions.len(), 2);
        assert_eq!(page.total_count, 2);
        assert_eq!(page.sessions[0].id, "thread-1");
        assert_eq!(page.sessions[0].title, "First new");
        assert_eq!(page.sessions[0].updated_at_ms, Some(4000));
        assert_eq!(page.sessions[1].id, "thread-2");
        assert!(page.sessions[1].archived);
        let second_page = list_codex_sessions_from_home(&root, 1, 1).unwrap();
        assert_eq!(second_page.sessions.len(), 1);
        assert_eq!(second_page.total_count, 2);
        assert_eq!(second_page.sessions[0].id, "thread-2");
        assert!(!second_page.has_more);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn list_includes_unindexed_sessions_without_rollout_metadata() {
        let root = test_root("list-all-providers");
        let api_id = "019f1234-abcd-7000-8000-000000000001";
        let oauth_id = "019f1234-abcd-7000-8000-000000000002";
        let api_rollout = root
            .join("sessions")
            .join(format!("rollout-2026-08-04T12-00-00-{api_id}.jsonl"));
        let oauth_rollout = root
            .join("archived_sessions")
            .join(format!("rollout-2026-08-03T12-00-00-{oauth_id}.jsonl"));
        fs::create_dir_all(api_rollout.parent().unwrap()).unwrap();
        fs::create_dir_all(oauth_rollout.parent().unwrap()).unwrap();
        fs::write(
            &api_rollout,
            "not parsed by the session list\n",
        )
        .unwrap();
        fs::write(
            &oauth_rollout,
            "not parsed by the session list\n",
        )
        .unwrap();
        fs::write(
            root.join("session_index.jsonl"),
            concat!(
                "{\"id\":\"019f1234-abcd-7000-8000-000000000001\",\"thread_name\":\"API session\",\"updated_at\":\"2026-08-04T12:00:00Z\"}\n",
                "{\"id\":\"019f1234-abcd-7000-8000-000000000002\",\"thread_name\":\"OAuth session\",\"updated_at\":\"2026-08-03T12:00:00Z\"}\n"
            ),
        )
        .unwrap();

        let page = list_codex_sessions_from_home(&root, 0, 50).unwrap();
        assert_eq!(page.sessions.len(), 2);
        assert_eq!(page.sessions[0].id, api_id);
        assert_eq!(page.sessions[0].title, "API session");
        assert!(!page.sessions[0].archived);
        assert_eq!(page.sessions[1].id, oauth_id);
        assert_eq!(page.sessions[1].title, "OAuth session");
        assert!(page.sessions[1].archived);
        assert!(page.sessions.iter().all(|session| session.cwd.is_empty() && session.model_provider.is_empty()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn listing_uses_filenames_and_index_without_parsing_rollouts() {
        let root = test_root("list-no-rollout-reads");
        fs::create_dir_all(root.join("sessions")).unwrap();
        fs::create_dir_all(root.join("archived_sessions")).unwrap();
        let mut index = String::new();
        for number in 0..6 {
            let id = format!("019f1234-abcd-7000-8000-{number:012}");
            let directory = if number % 2 == 0 {
                "sessions"
            } else {
                "archived_sessions"
            };
            let path = root
                .join(directory)
                .join(format!("rollout-2026-10-10T10-00-00-{id}.jsonl"));
            fs::write(
                path,
                b"not JSON; listing must not read or parse this file\xff",
            )
            .unwrap();
            index.push_str(&format!("{}\n", json!({"id":id,"thread_name":format!("Session {number}"),"updated_at":(1000 + number).to_string()})));
        }
        fs::write(root.join("session_index.jsonl"), index).unwrap();
        let page = list_codex_sessions_from_home(&root, 2, 2).unwrap();
        assert_eq!(page.total_count, 6);
        assert_eq!(page.sessions.len(), 2);
        assert!(page.has_more);
        assert!(page.warnings.is_empty(), "{:?}", page.warnings);
        assert_eq!(page.sessions[0].title, "Session 3");
        assert!(page.sessions[0].archived);
        assert_eq!(page.sessions[1].title, "Session 2");
        assert!(!page.sessions[1].archived);
        assert!(page
            .sessions
            .iter()
            .all(|session| session.cwd.is_empty() && session.model_provider.is_empty()));
        assert!(!root.join("backups_state").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn listing_succeeds_when_every_rollout_is_locked_against_reads() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = test_root("list-locked-rollouts");
        fs::create_dir_all(root.join("sessions")).unwrap();
        let mut guards = Vec::new();
        for number in 0..4 {
            let path = root.join("sessions").join(format!(
                "rollout-019f1234-abcd-7000-8000-{number:012}.jsonl"
            ));
            fs::write(&path, "secret message contents").unwrap();
            guards.push(
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0)
                    .open(&path)
                    .unwrap(),
            );
            assert!(fs::File::open(&path).is_err());
        }
        for offset in [0, 2] {
            let page = list_codex_sessions_from_home(&root, offset, 2).unwrap();
            assert_eq!(page.total_count, 4);
            assert_eq!(page.sessions.len(), 2);
            assert!(page.warnings.is_empty(), "{:?}", page.warnings);
        }
        drop(guards);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn list_accepts_optional_thread_columns_and_warns_about_a_broken_database() {
        let root = test_root("list-optional");
        let sqlite = root.join("sqlite");
        fs::create_dir_all(&sqlite).unwrap();
        let connection = Connection::open(sqlite.join("optional.sqlite3")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT);\n\
                 CREATE TABLE inbox_items (id TEXT PRIMARY KEY);\n\
                 INSERT INTO threads VALUES ('optional-thread', 'Optional');",
            )
            .unwrap();
        drop(connection);
        fs::write(sqlite.join("broken.db"), b"not a sqlite database").unwrap();

        let page = list_codex_sessions_from_home(&root, 0, 0).unwrap();
        assert_eq!(page.limit, 1);
        assert_eq!(page.sessions.len(), 1);
        assert_eq!(page.sessions[0].id, "optional-thread");
        assert_eq!(page.sessions[0].cwd, "");
        assert_eq!(page.sessions[0].updated_at_ms, None);
        assert!(page
            .warnings
            .iter()
            .any(|warning| warning.contains("broken.db")));
        assert_eq!(
            list_codex_sessions_from_home(&root, 0, usize::MAX)
                .unwrap()
                .limit,
            MAX_PAGE_SIZE
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn queued_deletion_rejects_target_revision_change_before_touching_history() {
        let root = test_root("queued-delete-target-change");
        let rollout = root.join("sessions/2026/rollout.jsonl");
        fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        fs::write(&rollout, "session\n").unwrap();
        create_threads_db(&root.join("state_5.sqlite"), &rollout);
        let state = std::sync::Arc::new(crate::GuiConfigState::new(
            crate::GuiConfigFile::default(),
        ));
        let expected = state.snapshot().unwrap();
        let fence = state.target_operation.blocking_lock();
        let worker_state = state.clone();
        let worker_root = root.clone();
        let worker_expected = expected.clone();
        let worker = std::thread::spawn(move || {
            let _target_operation =
                worker_state.blocking_local_target_operation(&worker_expected)?;
            delete_codex_sessions_from_home(&worker_root, vec!["thread-1".to_string()])
        });
        // Even switching away and back to Local must invalidate queued work.
        let mut remote = expected.clone();
        remote.connection_mode = crate::CoreConnectionMode::Remote;
        state.replace_external(remote).unwrap();
        state.replace_external(expected).unwrap();
        drop(fence);
        assert!(worker.join().unwrap().is_err());
        assert_eq!(fs::read_to_string(&rollout).unwrap(), "session\n");
        assert_eq!(
            list_codex_sessions_from_home(&root, 0, 10)
                .unwrap()
                .sessions
                .len(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deletion_backs_up_rows_and_removes_only_in_home_rollout() {
        let root = test_root("delete");
        let rollout = root.join("sessions/2026/rollout.jsonl");
        fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        fs::write(&rollout, "session\n").unwrap();
        create_threads_db(&root.join("state_5.sqlite"), &rollout);

        let result = delete_codex_sessions_from_home(&root, vec!["thread-1".to_string()]).unwrap();
        assert_eq!(result.deleted_count, 1);
        assert_eq!(result.results[0].status, "deleted");
        assert!(!rollout.exists());
        let backup = PathBuf::from(result.results[0].backup_path.as_ref().unwrap());
        assert!(backup.join("metadata.json").is_file());
        assert!(backup.join("database-0-rows.json").is_file());
        let connection = Connection::open(root.join("state_5.sqlite")).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM threads", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deletion_cleans_known_relations_and_preserves_outside_rollouts() {
        let root = test_root("delete-relations");
        let outside_rollout = root.with_extension("outside.jsonl");
        fs::write(&outside_rollout, "outside\n").unwrap();
        let database = root.join("state_5.sqlite");
        create_threads_db(&database, &outside_rollout);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE thread_goals (thread_id TEXT, goal TEXT);\n\
                 CREATE TABLE stage1_outputs (thread_id TEXT, output TEXT);\n\
                 CREATE TABLE local_thread_catalog (thread_id TEXT, value TEXT);\n\
                 CREATE TABLE thread_timeline_ledger (thread_id TEXT, value TEXT);\n\
                 CREATE TABLE automation_runs (thread_id TEXT, title TEXT);\n\
                 CREATE TABLE inbox_items (id TEXT, thread_id TEXT);\n\
                 CREATE TABLE agent_job_items (id TEXT, assigned_thread_id TEXT);\n\
                 INSERT INTO thread_goals VALUES ('thread-1', 'goal');\n\
                 INSERT INTO thread_spawn_edges VALUES ('thread-1', 'child');\n\
                 INSERT INTO stage1_outputs VALUES ('thread-1', 'output');\n\
                 INSERT INTO local_thread_catalog VALUES ('thread-1', 'catalog');\n\
                 INSERT INTO thread_timeline_ledger VALUES ('thread-1', 'timeline');\n\
                 INSERT INTO automation_runs VALUES ('thread-1', 'automation');\n\
                 INSERT INTO inbox_items VALUES ('inbox-1', 'thread-1');\n\
                 INSERT INTO agent_job_items VALUES ('job-1', 'thread-1');",
            )
            .unwrap();
        drop(connection);

        let result = delete_codex_sessions_from_home(&root, vec!["thread-1".to_string()]).unwrap();
        assert_eq!(result.results[0].status, "partial");
        assert!(outside_rollout.is_file());
        let backup = PathBuf::from(result.results[0].backup_path.as_ref().unwrap());
        let metadata = fs::read_to_string(backup.join("metadata.json")).unwrap();
        assert!(metadata.contains("outside Codex session directories"));

        let connection = Connection::open(&database).unwrap();
        for table in [
            "threads",
            "thread_dynamic_tools",
            "thread_goals",
            "thread_spawn_edges",
            "stage1_outputs",
            "local_thread_catalog",
            "thread_timeline_ledger",
            "automation_runs",
            "inbox_items",
        ] {
            let count = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} should be cleaned");
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM agent_job_items WHERE assigned_thread_id IS NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
        fs::remove_file(outside_rollout).unwrap();
    }

    #[test]
    fn deletion_skips_related_tables_that_lack_optional_thread_columns() {
        let root = test_root("delete-optional");
        let rollout = root.join("sessions/rollout.jsonl");
        fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        fs::write(&rollout, "session\n").unwrap();
        let database = root.join("state_5.sqlite");
        create_threads_db(&database, &rollout);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE thread_goals (id TEXT PRIMARY KEY);\n\
                 CREATE TABLE inbox_items (id TEXT PRIMARY KEY);\n\
                 INSERT INTO thread_goals VALUES ('goal-1');\n\
                 INSERT INTO inbox_items VALUES ('inbox-1');",
            )
            .unwrap();
        drop(connection);

        let result = delete_codex_sessions_from_home(&root, vec!["thread-1".to_string()]).unwrap();
        assert_eq!(result.results[0].status, "deleted");
        let connection = Connection::open(&database).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM thread_goals", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM inbox_items", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deletion_failure_keeps_transaction_rows_and_returns_the_backup() {
        let root = test_root("delete-failure");
        let rollout = root.join("sessions/rollout.jsonl");
        fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        fs::write(&rollout, "session\n").unwrap();
        let database = root.join("state_5.sqlite");
        create_threads_db(&database, &rollout);
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER block_thread_delete BEFORE DELETE ON threads\n\
                 BEGIN SELECT RAISE(ABORT, 'blocked by test'); END;",
            )
            .unwrap();
        drop(connection);

        let result = delete_codex_sessions_from_home(&root, vec!["thread-1".to_string()]).unwrap();
        assert_eq!(result.results[0].status, "failed");
        let backup = PathBuf::from(result.results[0].backup_path.as_ref().unwrap());
        assert!(backup.join("database-0-rows.json").is_file());
        assert!(rollout.is_file());
        let connection = Connection::open(&database).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM threads", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM thread_dynamic_tools", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deletion_reports_partial_when_an_earlier_database_transaction_committed() {
        let root = test_root("delete-partial-database");
        let rollout = root.join("sessions/rollout.jsonl");
        fs::create_dir_all(rollout.parent().unwrap()).unwrap();
        fs::write(&rollout, "session\n").unwrap();
        let legacy_path = root.join("state_5.sqlite");
        create_threads_db(&legacy_path, &rollout);
        let legacy = Connection::open(&legacy_path).unwrap();
        legacy
            .execute_batch(
                "CREATE TRIGGER block_thread_delete BEFORE DELETE ON threads\n\
                 BEGIN SELECT RAISE(ABORT, 'blocked by test'); END;",
            )
            .unwrap();
        drop(legacy);
        let sqlite = root.join("sqlite");
        fs::create_dir_all(&sqlite).unwrap();
        let automation_path = sqlite.join("codex-dev.db");
        let automation = Connection::open(&automation_path).unwrap();
        automation
            .execute_batch(
                "CREATE TABLE automation_runs (thread_id TEXT PRIMARY KEY);\n\
                 CREATE TABLE inbox_items (id TEXT PRIMARY KEY, thread_id TEXT);\n\
                 INSERT INTO automation_runs VALUES ('thread-1');\n\
                 INSERT INTO inbox_items VALUES ('inbox-1', 'thread-1');",
            )
            .unwrap();
        drop(automation);

        let result = delete_codex_sessions_from_home(&root, vec!["thread-1".to_string()]).unwrap();
        assert_eq!(result.results[0].status, "partial");
        assert_eq!(result.deleted_count, 1);
        assert!(result.results[0].backup_path.is_some());
        let automation = Connection::open(&automation_path).unwrap();
        assert_eq!(
            automation
                .query_row("SELECT COUNT(*) FROM automation_runs", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        let legacy = Connection::open(&legacy_path).unwrap();
        assert_eq!(
            legacy
                .query_row("SELECT COUNT(*) FROM threads", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(automation);
        drop(legacy);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn provider_repair_updates_rollout_and_sqlite_and_preserves_projectless_cwd() {
        let root = test_root("repair");
        fs::create_dir_all(root.join("sessions")).unwrap();
        fs::write(root.join("config.toml"), "model_provider = \"cpa-gui\"\n").unwrap();
        fs::write(
            root.join(".codex-global-state.json"),
            r#"{"projectless-thread-ids":["thread-1"]}"#,
        )
        .unwrap();
        let rollout = root.join("sessions/rollout.jsonl");
        fs::write(
            &rollout,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"cwd\":\"C:/new\",\"model_provider\":\"openai\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\"}}\n",
        )
        .unwrap();
        create_threads_db(&root.join("state_5.sqlite"), &rollout);

        let result = repair_codex_session_metadata_from_home(&root, "cpa-gui", |_| {}).unwrap();
        assert_eq!(result.changed_rollout_files, 1);
        assert_eq!(result.sqlite_rows_updated, 2);
        let backup = PathBuf::from(result.backup_path.as_ref().unwrap());
        assert!(backup.join("databases/state_5.sqlite").is_file());
        assert!(backup.join(".codex-global-state.json").is_file());
        assert!(fs::read_to_string(&rollout).unwrap().contains("cpa-gui"));
        let connection = Connection::open(root.join("state_5.sqlite")).unwrap();
        let row = connection
            .query_row(
                "SELECT model_provider, has_user_event, cwd FROM threads WHERE id = 'thread-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row, ("cpa-gui".to_string(), 1, "C:/old".to_string()));
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn provider_repair_no_change_does_not_create_a_backup() {
        let root = test_root("repair-no-change");
        fs::create_dir_all(root.join("sessions")).unwrap();
        let rollout = root.join("sessions/rollout.jsonl");
        fs::write(
            &rollout,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"model_provider\":\"cpa-gui\"}}\n",
        )
        .unwrap();

        let result = repair_codex_session_metadata_from_home(&root, "cpa-gui", |_| {}).unwrap();
        assert_eq!(result.changed_rollout_files, 0);
        assert_eq!(result.sqlite_rows_updated, 0);
        assert_eq!(result.backup_path, None);
        assert!(!root.join("backups_state").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn provider_repair_updates_all_metadata_lines_and_preserves_mtime_and_crlf() {
        let root = test_root("repair-multiple-meta");
        fs::create_dir_all(root.join("archived_sessions/2026/07")).unwrap();
        let rollout = root.join("archived_sessions/2026/07/rollout.jsonl");
        let original = concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"model_provider\":\"openai\"}}\r\n",
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\",\"model_provider\":\"legacy\"}}\r\n",
            "{\"type\":\"response_item\",\"payload\":{\"encrypted_content\":\"ciphertext\"}}\r\n"
        );
        fs::write(&rollout, original).unwrap();
        let expected_mtime = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        fs::File::options()
            .write(true)
            .open(&rollout)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(expected_mtime))
            .unwrap();
        let before_mtime = fs::metadata(&rollout).unwrap().modified().unwrap();

        let result = repair_codex_session_metadata_from_home(&root, "cpa-gui", |_| {}).unwrap();
        assert_eq!(result.changed_rollout_files, 1);
        assert!(result.encrypted_content_warning.is_some());
        let next = fs::read(&rollout).unwrap();
        let next_text = String::from_utf8(next.clone()).unwrap();
        assert_eq!(next_text.matches("cpa-gui").count(), 2);
        assert!(next
            .iter()
            .enumerate()
            .filter(|(_, byte)| **byte == b'\n')
            .all(|(index, _)| index > 0 && next[index - 1] == b'\r'));
        assert_eq!(
            fs::metadata(&rollout).unwrap().modified().unwrap(),
            before_mtime
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repair_backup_copies_sqlite_sidecars_and_global_state() {
        let root = test_root("repair-sidecars");
        let database = root.join("state_5.sqlite");
        fs::write(&database, b"database").unwrap();
        fs::write(format!("{}-wal", database.to_string_lossy()), b"wal").unwrap();
        fs::write(format!("{}-shm", database.to_string_lossy()), b"shm").unwrap();
        fs::write(root.join(".codex-global-state.json"), b"{}").unwrap();

        let backup = create_repair_backup(
            &root,
            std::slice::from_ref(&database),
            &mut [],
            "provider-repair",
            "cpa-gui",
        )
        .unwrap();
        for name in ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm"] {
            assert!(backup.join("databases").join(name).is_file());
        }
        assert!(backup.join(".codex-global-state.json").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repair_backup_rotation_keeps_only_the_latest_five_directories() {
        let root = test_root("repair-rotation");
        for index in 0..7 {
            let directory =
                create_operation_directory(&root, "session-repair", &format!("repair-{index}"))
                    .unwrap();
            fs::write(directory.join("marker"), index.to_string()).unwrap();
        }
        prune_repair_backups(&root).unwrap();
        let directories =
            fs::read_dir(root.join("backups_state/easy-cli-proxy-api/session-repair"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .count();
        assert_eq!(directories, REPAIR_BACKUP_KEEP_COUNT);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lock_error_detection_covers_rollout_and_sqlite_lock_messages() {
        assert!(is_locked_error_message("os error 32"));
        assert!(is_locked_error_message("database is locked"));
        assert!(is_locked_error_message(
            "The process cannot access the file because it is being used by another process"
        ));
        assert!(!is_locked_error_message("database disk image is malformed"));
    }

    #[test]
    fn session_index_cleanup_preserves_live_and_unknown_records_and_checks_snapshot() {
        let root = test_root("index");
        fs::create_dir_all(root.join("sessions")).unwrap();
        let live = "019f480d-bbc6-7b62-8a46-99597db8bde7";
        let database_live = "019f480d-bbc6-7b62-8a46-99597db8bde8";
        let stale = "019f4e36-490e-7ae0-8e78-a8b3ab33a428";
        fs::write(
            root.join("sessions")
                .join(format!("rollout-2026-{live}.jsonl")),
            "{}\n",
        )
        .unwrap();
        let database = Connection::open(root.join("state_5.sqlite")).unwrap();
        database
            .execute_batch(&format!(
                "CREATE TABLE threads (id TEXT PRIMARY KEY);\n\
                 INSERT INTO threads VALUES ('{database_live}');"
            ))
            .unwrap();
        drop(database);
        let line = |id: &str, title: &str| {
            json!({"id": id, "thread_name": title, "updated_at": "2026-07-25T00:00:00Z"})
                .to_string()
        };
        let original = format!(
            "{}\n{}\n{}\n{{\"id\":\"future-id\",\"thread_name\":\"Future\",\"updated_at\":\"now\",\"future\":true}}\n{{\"kind\":\"future\"}}\n",
            line(live, "Live"),
            line(database_live, "Database live"),
            line(stale, "Stale")
        );
        fs::write(root.join("session_index.jsonl"), &original).unwrap();

        let preview = preview_session_index_cleanup_from_home(&root).unwrap();
        assert_eq!(preview.candidates.len(), 1);
        assert_eq!(preview.candidates[0].id, stale);
        assert!(apply_session_index_cleanup_from_home(
            &root,
            "bad-snapshot",
            &[stale.to_string()],
            false
        )
        .is_err());
        let result = apply_session_index_cleanup_from_home(
            &root,
            &preview.snapshot_sha256,
            &[stale.to_string()],
            false,
        )
        .unwrap();
        assert_eq!(result.pruned_entries, 1);
        assert!(PathBuf::from(result.backup_path.as_ref().unwrap())
            .join("session_index.jsonl")
            .is_file());
        let next = fs::read_to_string(root.join("session_index.jsonl")).unwrap();
        assert!(next.contains(live));
        assert!(next.contains(database_live));
        assert!(!next.contains(stale));
        assert!(next.contains("future"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_index_preview_refuses_to_guess_when_a_database_is_corrupt() {
        let root = test_root("index-corrupt-database");
        fs::create_dir_all(root.join("sqlite")).unwrap();
        fs::write(root.join("sqlite/broken.db"), b"not sqlite").unwrap();
        fs::write(
            root.join("session_index.jsonl"),
            "{\"id\":\"thread-1\",\"thread_name\":\"Maybe live\",\"updated_at\":\"now\"}\n",
        )
        .unwrap();

        let error = preview_session_index_cleanup_from_home(&root).unwrap_err();
        assert!(error.contains("invalid session record check aborted"));
        assert!(root.join("session_index.jsonl").is_file());
        fs::remove_dir_all(root).unwrap();
    }
