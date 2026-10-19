    use super::*;
    use crate::codex_sessions::tests::test_root;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn dynamic_session_id() -> String {
        format!(
            "019f1234-abcd-7000-8000-{:012x}",
            TEST_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed)
        )
    }
    #[test]
    fn legacy_message_copies_follow_edits_and_deletions_in_their_turn() {
        for canonical in [false, true] {
            for deleted in [false, true] {
                for role in ["user", "assistant"] {
                    let root = test_root("legacy-message-mirrors");
                    let session_id = dynamic_session_id();
                    let fixture = seed_context_edit_fixture(&root, &session_id);
                    let mut records =
                        vec![json!({"type":"session_meta","payload":{"id":session_id}})];
                    for turn in ["edited-turn", "untouched-turn"] {
                        records.push(json!({"type":"event_msg","payload":{"type":"task_started","turn_id":turn}}));
                        records.push(json!({"type":"event_msg","payload":{"type":"user_message","message":"Repeated user","images":[],"local_images":[]}}));
                        records.push(json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Repeated user"}]}}));
                        if canonical {
                            records.push(json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":turn,"item":{"type":"UserMessage","id":"user-id","content":[{"type":"text","text":"Repeated user"}]}}}));
                        }
                        records.push(json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Repeated answer"}]}}));
                        records.push(json!({"type":"event_msg","payload":{"type":"agent_message","message":"Repeated answer","phase":"final_answer"}}));
                        if canonical {
                            records.push(json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":turn,"item":{"type":"AgentMessage","id":"agent-id","content":[{"type":"Text","text":"Repeated answer"}]}}}));
                        }
                        records.push(json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":turn,"last_agent_message":"Repeated answer"}}));
                    }
                    let original = serialize_jsonl(&records, "\r\n").unwrap();
                    fs::write(&fixture.rollout, &original).unwrap();
                    let connection = Connection::open(&fixture.history_db).unwrap();
                    connection.execute("UPDATE thread_history_projection_state SET next_rollout_byte_offset=?1,next_rollout_ordinal=?2", rusqlite::params![original.len() as i64, records.len() as i64]).unwrap();
                    drop(connection);
                    let context = get_codex_session_context_from_home(&root, &session_id).unwrap();
                    let line = context
                        .messages
                        .iter()
                        .find(|message| message.role == role)
                        .unwrap()
                        .line_number;
                    let mut request = context_save_request(&context);
                    request.message_updates = Some(vec![CodexSessionMessageUpdate {
                        line_number: line,
                        role: None,
                        content: Some("Changed message".into()),
                        deleted: Some(deleted),
                    }]);
                    save_codex_session_context_from_home(&root, request).unwrap();
                    let saved = fs::read_to_string(&fixture.rollout).unwrap();
                    let parsed = validate_raw_jsonl(&saved, &session_id).unwrap();
                    let event_type = if role == "user" {
                        "user_message"
                    } else {
                        "agent_message"
                    };
                    let messages = parsed
                        .iter()
                        .filter(|(_, record)| record["payload"]["type"] == event_type)
                        .map(|(_, record)| record["payload"]["message"].as_str().unwrap())
                        .collect::<Vec<_>>();
                    let untouched = if role == "user" {
                        "Repeated user"
                    } else {
                        "Repeated answer"
                    };
                    assert_eq!(
                        messages,
                        if deleted {
                            vec![untouched]
                        } else {
                            vec!["Changed message", untouched]
                        }
                    );
                    assert!(saved.contains("\r\n"));
                    fs::remove_dir_all(root).unwrap();
                }
            }
        }
    }

    #[test]
    fn appending_to_an_empty_fork_creates_a_readable_turn_and_rolls_back_on_failure() {
        for fail_summary in [false, true] {
            let root = test_root("context-empty-fork-turn");
            let session_id = dynamic_session_id();
            let fixture = seed_context_edit_fixture(&root, &session_id);
            let original = serialize_jsonl(&[json!({"type":"session_meta","payload":{"id":session_id,"forked_from_id":"parent-thread"}})], "\n").unwrap();
            fs::write(&fixture.rollout, &original).unwrap();
            let connection = Connection::open(&fixture.history_db).unwrap();
            connection.execute_batch("DELETE FROM thread_items; ALTER TABLE thread_turns ADD COLUMN rollout_byte_offset INTEGER; ALTER TABLE thread_turns ADD COLUMN rollout_end_ordinal INTEGER; ALTER TABLE thread_turns ADD COLUMN rollout_end_byte_offset INTEGER; CREATE UNIQUE INDEX turns_page ON thread_turns(thread_id, rollout_ordinal);").unwrap();
            connection.execute("UPDATE thread_history_projection_state SET next_rollout_byte_offset=?1,next_rollout_ordinal=1", [original.len() as i64]).unwrap();
            if fail_summary {
                connection.execute_batch("CREATE TRIGGER fail_summary BEFORE UPDATE OF first_user_item_id ON thread_turns BEGIN SELECT RAISE(ABORT, 'summary failure'); END;").unwrap();
            }
            drop(connection);
            let context = get_codex_session_context_from_home(&root, &session_id).unwrap();
            let mut request = context_save_request(&context);
            request.new_messages = Some(vec![
                CodexSessionNewMessage {
                    role: "user".into(),
                    content: "New question".into(),
                },
                CodexSessionNewMessage {
                    role: "assistant".into(),
                    content: "New answer".into(),
                },
            ]);
            let result = save_codex_session_context_from_home(&root, request);
            let connection = Connection::open(&fixture.history_db).unwrap();
            if fail_summary {
                assert!(result.unwrap_err().contains("summary failure"));
                assert_eq!(fs::read(&fixture.rollout).unwrap(), original);
                let counts: (i64,i64) = connection.query_row("SELECT (SELECT COUNT(*) FROM thread_items), (SELECT COUNT(*) FROM thread_turns)", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
                assert_eq!(counts, (0, 0));
            } else {
                result.unwrap();
                let summary: (String, String, String, i64, i64) = connection.query_row(
                    "SELECT turns.status, user.item_json, agent.item_json, turns.rollout_ordinal, turns.rollout_end_byte_offset FROM thread_turns turns JOIN thread_items user ON user.thread_id=turns.thread_id AND user.turn_id=turns.turn_id AND user.item_id=turns.first_user_item_id JOIN thread_items agent ON agent.thread_id=turns.thread_id AND agent.turn_id=turns.turn_id AND agent.item_id=turns.final_agent_item_id WHERE turns.thread_id=?1",
                    [&session_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).unwrap();
                assert_eq!(summary.0, "completed");
                assert!(summary.1.contains("New question"));
                assert!(summary.2.contains("New answer"));
                assert_eq!(summary.3, 1);
                assert_eq!(
                    summary.4,
                    fs::metadata(&fixture.rollout).unwrap().len() as i64
                );
                let saved = fs::read_to_string(&fixture.rollout).unwrap();
                assert!(saved.contains("\"type\":\"task_started\""));
                assert!(saved.contains("\"last_agent_message\":\"New answer\""));
            }
            drop(connection);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn session_context_validation_rejects_path_traversal() {
        assert!(validate_session_id("../etc/passwd").is_err());
        assert!(validate_session_id("..\\windows\\system32").is_err());
        assert!(validate_session_id("test/session").is_err());
        assert!(validate_session_id("test:session").is_err());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id("   ").is_err());
        assert_eq!(
            validate_session_id("01a0ba19-e1ac-7d00-9136-563b25bbdb86").unwrap(),
            "01a0ba19-e1ac-7d00-9136-563b25bbdb86"
        );
    }

    #[test]
    fn structured_changes_reject_nonmessage_and_missing_lines() {
        let source = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"s\"}}\n{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[]}}\n";
        for line_number in [0, 2] {
            for deleted in [true, false] {
                let mut request = empty_context_request("s".to_string(), None);
                request.message_updates = Some(vec![CodexSessionMessageUpdate {
                    line_number,
                    role: None,
                    content: Some("invalid update".to_string()),
                    deleted: Some(deleted),
                }]);
                assert!(build_updated_rollout(source, "s", &request).is_err());
            }
        }
    }

    #[test]
    fn context_lookup_does_not_open_unrelated_rollouts() {
        let root = test_root("context-no-unrelated-read");
        fs::create_dir_all(root.join("sessions")).unwrap();
        let session_id = dynamic_session_id();
        let other_id = dynamic_session_id();
        let content = format!(
            "{}\n",
            json!({"type":"session_meta","payload":{"id":session_id}})
        );
        fs::write(
            root.join("sessions")
                .join(format!("rollout-{other_id}.jsonl")),
            content,
        )
        .unwrap();
        assert!(find_rollout_for_session(&root, &session_id)
            .unwrap()
            .is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn export_jsonl_limit_keeps_structured_messages_and_original_path() {
        let root = test_root("context-export-limit");
        fs::create_dir_all(root.join("sessions")).unwrap();
        let session_id = dynamic_session_id();
        let path = root
            .join("sessions")
            .join(format!("rollout-{session_id}.jsonl"));
        let record = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"still readable"}]}}).to_string();
        for size in [MAX_RAW_JSONL_BYTES, MAX_RAW_JSONL_BYTES + 1] {
            let mut bytes = format!("{record}\n").into_bytes();
            bytes.resize(size as usize, b' ');
            fs::write(&path, &bytes).unwrap();
            let detail = get_codex_session_context_from_home(&root, &session_id).unwrap();
            assert_eq!(detail.raw_jsonl_available, size <= MAX_RAW_JSONL_BYTES);
            assert_eq!(detail.raw_jsonl.is_some(), detail.raw_jsonl_available);
            assert_eq!(
                detail.rollout_sha256.as_deref(),
                Some(sha256_hex(&bytes).as_str())
            );
            assert_eq!(detail.stats.file_size_bytes, bytes.len() as u64);
            if let Some(raw) = detail.raw_jsonl.as_ref() {
                assert_eq!(raw.as_bytes(), bytes);
            }
            assert_eq!(detail.messages[0].content, "still readable");
            assert_eq!(
                find_rollout_for_session(&root, &session_id)
                    .unwrap()
                    .unwrap(),
                fs::canonicalize(&path).unwrap()
            );
        }
        fs::write(&path, [record.as_bytes(), b"\n\xff"].concat()).unwrap();
        let detail = get_codex_session_context_from_home(&root, &session_id).unwrap();
        assert!(!detail.raw_jsonl_available);
        assert_eq!(detail.messages[0].content, "still readable");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_get_and_save_workflow() {
        let root = test_root("context-workflow");
        let session_id = "019f1234-abcd-7000-8000-000000000001";
        let session_dir = root.join("sessions").join("2026").join("10").join("05");
        fs::create_dir_all(&session_dir).unwrap();

        let rollout_file =
            session_dir.join(format!("rollout-2026-10-05T12-00-00-{session_id}.jsonl"));
        let meta_line = json!({"type":"session_meta","payload":{"id":session_id,"title":"Initial Title","cwd":"C:\\Repo","model_provider":"openai"}}).to_string();
        let turn_line =
            json!({"type":"turn_context","payload":{"model":"gpt-5.4","cwd":"C:\\Repo"}})
                .to_string();
        let user_line = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"First prompt"}]}}).to_string();
        let asst_line = json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"First answer"}]}}).to_string();
        let initial_jsonl = format!("{meta_line}\n{turn_line}\n{user_line}\n{asst_line}\n");
        fs::write(&rollout_file, &initial_jsonl).unwrap();
        let database_path = root.join("state_5.sqlite");
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, title TEXT, cwd TEXT, model_provider TEXT, model TEXT, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, updated_at INTEGER, updated_at_ms INTEGER);\n\
                 CREATE TABLE local_thread_catalog (thread_id TEXT PRIMARY KEY, display_title TEXT, cwd TEXT, model_provider TEXT, source_updated_at REAL);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads (id, rollout_path, title, cwd, model_provider, model, archived, updated_at, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 1, 1000)",
                rusqlite::params![
                    session_id,
                    rollout_file.to_string_lossy().to_string(),
                    "Initial Title",
                    "C:\\Repo",
                    "openai",
                    "gpt-5.4"
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO local_thread_catalog VALUES (?1, ?2, ?3, ?4, 1)",
                rusqlite::params![session_id, "Initial Title", "C:\\Repo", "openai"],
            )
            .unwrap();
        drop(connection);

        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        assert_eq!(detail.id, session_id);
        assert_eq!(detail.title, "Initial Title");
        assert_eq!(detail.cwd, "C:\\Repo");
        assert_eq!(detail.model_provider, "openai");
        assert_eq!(detail.stats.user_message_count, 1);
        assert_eq!(detail.stats.assistant_message_count, 1);
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[0].content, "First prompt");
        assert_eq!(detail.messages[1].content, "First answer");
        assert!(detail.rollout_sha256.is_some());

        let save_req = SaveCodexSessionContextRequest {
            title: Some("Updated Title".to_string()),
            cwd: Some("C:\\NewRepo".to_string()),
            model_provider: Some("cpa-gui".to_string()),
            model: Some("deepseek-v4.1".to_string()),
            archived: Some(true),
            message_updates: Some(vec![
                CodexSessionMessageUpdate {
                    line_number: 2,
                    role: None,
                    content: Some("Modified prompt".to_string()),
                    deleted: None,
                },
                CodexSessionMessageUpdate {
                    line_number: 3,
                    role: None,
                    content: None,
                    deleted: Some(true),
                },
            ]),
            new_messages: Some(vec![CodexSessionNewMessage {
                role: "assistant".to_string(),
                content: "Brand new response".to_string(),
            }]),
            ..empty_context_request(session_id.to_string(), detail.rollout_sha256.clone())
        };
        let save_res = save_codex_session_context_from_home(&root, save_req).unwrap();
        assert!(save_res.success);
        assert!(save_res.backup_path.is_some());
        let backup = PathBuf::from(save_res.backup_path.as_ref().unwrap());
        assert!(backup.join("database-rows.json").is_file());
        let archived_rollout = root
            .join("archived_sessions")
            .join(rollout_file.file_name().unwrap());
        assert!(!rollout_file.exists());
        assert!(archived_rollout.is_file());
        let saved_jsonl = fs::read_to_string(&archived_rollout).unwrap();
        assert!(saved_jsonl.contains("\"model\":\"deepseek-v4.1\""));
        assert!(saved_jsonl.contains("\"type\":\"output_text\""));

        let connection = Connection::open(&database_path).unwrap();
        let database_state = connection
            .query_row(
                "SELECT archived, archived_at, rollout_path, model FROM threads WHERE id = ?1",
                [session_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(database_state.0, 1);
        assert!(database_state.1.is_some());
        assert_eq!(PathBuf::from(database_state.2), archived_rollout);
        assert_eq!(database_state.3, "deepseek-v4.1");
        drop(connection);

        let updated_detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        assert_eq!(updated_detail.title, "Updated Title");
        assert_eq!(updated_detail.cwd, "C:\\NewRepo");
        assert_eq!(updated_detail.model_provider, "cpa-gui");
        assert_eq!(updated_detail.messages.len(), 2);
        assert_eq!(updated_detail.messages[0].content, "Modified prompt");
        assert_eq!(updated_detail.messages[1].content, "Brand new response");

        let restore_detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        let restore_req = SaveCodexSessionContextRequest {
            archived: Some(false),
            ..empty_context_request(session_id.to_string(), restore_detail.rollout_sha256)
        };
        save_codex_session_context_from_home(&root, restore_req).unwrap();
        assert!(rollout_file.is_file());
        assert!(!archived_rollout.exists());
        let connection = Connection::open(&database_path).unwrap();
        let restored_state = connection
            .query_row(
                "SELECT archived, archived_at, rollout_path FROM threads WHERE id = ?1",
                [session_id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(restored_state.0, 0);
        assert!(restored_state.1.is_none());
        assert_eq!(PathBuf::from(restored_state.2), rollout_file);
        drop(connection);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_refuses_database_rollout_outside_codex_home() {
        let root = test_root("context-outside-rollout");
        let session_id = "019f1234-abcd-7000-8000-000000000010";
        let outside = root.parent().unwrap().join(format!(
            "{}-outside.jsonl",
            root.file_name().unwrap().to_string_lossy()
        ));
        let outside_contents = format!(
            "{}\n",
            json!({"type":"session_meta","payload":{"id":session_id}})
        );
        fs::write(&outside, &outside_contents).unwrap();
        let connection = Connection::open(root.join("state_5.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, 'Outside')",
                rusqlite::params![session_id, outside.to_string_lossy().to_string()],
            )
            .unwrap();
        drop(connection);

        assert!(find_rollout_for_session(&root, session_id)
            .unwrap()
            .is_none());
        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        assert!(detail.rollout_path.is_none());
        let request = SaveCodexSessionContextRequest {
            ..empty_context_request(session_id.to_string(), None)
        };
        assert!(save_codex_session_context_from_home(&root, request).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), outside_contents);

        fs::remove_file(outside).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_does_not_match_parent_id_inside_child_filename() {
        let root = test_root("context-parent-child");
        let parent_id = "019f1234-abcd-7000-8000-000000000020";
        let child_id = "019f1234-abcd-7000-8000-000000000021";
        let directory = root.join("sessions/2026/10/05");
        fs::create_dir_all(&directory).unwrap();
        let rollout = directory.join(format!(
            "rollout-2026-10-05T12-00-00-{parent_id}_{child_id}.jsonl"
        ));
        fs::write(
            &rollout,
            format!(
                "{}\n",
                json!({"type":"session_meta","payload":{"id":child_id}})
            ),
        )
        .unwrap();

        assert_eq!(
            find_rollout_for_session(&root, child_id).unwrap(),
            Some(fs::canonicalize(&rollout).unwrap())
        );
        assert!(find_rollout_for_session(&root, parent_id)
            .unwrap()
            .is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_supports_legacy_thread_schema_without_optional_columns() {
        let root = test_root("context-legacy-schema");
        let session_id = "019f1234-abcd-7000-8000-000000000002";
        let sessions = root.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        let rollout = sessions.join(format!("rollout-{session_id}.jsonl"));
        fs::write(
            &rollout,
            format!(
                "{}\n",
                json!({"type":"session_meta","payload":{"id":session_id,"title":"Legacy"}})
            ),
        )
        .unwrap();
        let database = root.join("state_5.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT, model_provider TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    session_id,
                    rollout.to_string_lossy().to_string(),
                    "Legacy",
                    "C:\\Repo",
                    "openai"
                ],
            )
            .unwrap();
        drop(connection);

        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        assert_eq!(detail.model, None);
        assert_eq!(detail.updated_at_ms, None);
        assert_eq!(detail.title, "Legacy");

        let request = SaveCodexSessionContextRequest {
            title: Some("Updated legacy".to_string()),
            ..empty_context_request(session_id.to_string(), detail.rollout_sha256)
        };
        save_codex_session_context_from_home(&root, request).unwrap();

        let connection = Connection::open(&database).unwrap();
        let title = connection
            .query_row(
                "SELECT title FROM threads WHERE id = ?1",
                [session_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(title, "Updated legacy");
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_updates_legacy_name_column() {
        let root = test_root("context-name-column");
        let session_id = "019f1234-abcd-7000-8000-000000000094";
        fs::create_dir_all(root.join("sessions")).unwrap();
        let rollout = root
            .join("sessions")
            .join(format!("rollout-{session_id}.jsonl"));
        fs::write(
            &rollout,
            format!(
                "{}\n",
                json!({"type":"session_meta","payload":{"id":session_id,"title":"Legacy"}})
            ),
        )
        .unwrap();
        let database = root.join("state_5.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, name TEXT);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, ?3)",
                rusqlite::params![session_id, rollout.to_string_lossy().to_string(), "Legacy"],
            )
            .unwrap();
        drop(connection);

        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        assert_eq!(detail.title, "Legacy");
        let mut request = context_save_request(&detail);
        request.title = Some("Updated legacy name".to_string());
        save_codex_session_context_from_home(&root, request).unwrap();
        let updated = get_codex_session_context_from_home(&root, session_id).unwrap();
        assert_eq!(updated.title, "Updated legacy name");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_uses_latest_model_and_retains_message_turn_models() {
        let root = test_root("context-latest-model");
        let session_id = "019f1234-abcd-7000-8000-000000000095";
        fs::create_dir_all(root.join("sessions")).unwrap();
        let rollout = root
            .join("sessions")
            .join(format!("rollout-{session_id}.jsonl"));
        let records = vec![
            json!({"type":"session_meta","payload":{"id":session_id}}),
            json!({"type":"turn_context","payload":{"model":"first-model"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"First turn"}]}}),
            json!({"type":"turn_context","payload":{"model":"latest-model"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Latest turn"}]}}),
        ];
        fs::write(&rollout, serialize_jsonl(&records, "\n").unwrap()).unwrap();
        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        assert_eq!(detail.model.as_deref(), Some("latest-model"));
        assert_eq!(detail.messages[0].model.as_deref(), Some("first-model"));
        assert_eq!(detail.messages[1].model.as_deref(), Some("latest-model"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_rejects_stale_rollout_snapshot() {
        let root = test_root("context-stale-snapshot");
        let session_id = "019f1234-abcd-7000-8000-000000000040";
        let directory = root.join("sessions");
        fs::create_dir_all(&directory).unwrap();
        let rollout = directory.join(format!("rollout-{session_id}.jsonl"));
        let initial = format!(
            "{}\n",
            json!({"type":"session_meta","payload":{"id":session_id,"title":"Initial"}})
        );
        fs::write(&rollout, &initial).unwrap();
        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        let changed = format!(
            "{initial}{}\n",
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Concurrent append"}]}})
        );
        fs::write(&rollout, &changed).unwrap();
        let request = SaveCodexSessionContextRequest {
            title: Some("Should not be written".to_string()),
            ..empty_context_request(session_id.to_string(), detail.rollout_sha256)
        };
        let error = save_codex_session_context_from_home(&root, request).unwrap_err();
        assert!(error.contains("changed after it was loaded"));
        assert_eq!(fs::read_to_string(&rollout).unwrap(), changed);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_rolls_back_rollout_when_database_update_fails() {
        let root = test_root("context-database-rollback");
        let session_id = "019f1234-abcd-7000-8000-000000000050";
        let directory = root.join("sessions");
        fs::create_dir_all(&directory).unwrap();
        let rollout = directory.join(format!("rollout-{session_id}.jsonl"));
        let initial = format!(
            "{}\n",
            json!({"type":"session_meta","payload":{"id":session_id,"title":"Initial"}})
        );
        fs::write(&rollout, &initial).unwrap();
        let database = root.join("state_5.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT);\n\
                 CREATE TRIGGER reject_context_update BEFORE UPDATE ON threads BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, 'Initial')",
                rusqlite::params![session_id, rollout.to_string_lossy().to_string()],
            )
            .unwrap();
        drop(connection);
        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        let request = SaveCodexSessionContextRequest {
            title: Some("Updated".to_string()),
            ..empty_context_request(session_id.to_string(), detail.rollout_sha256)
        };
        let error = save_codex_session_context_from_home(&root, request).unwrap_err();
        assert!(error.contains("rollout restored"));
        assert_eq!(fs::read_to_string(&rollout).unwrap(), initial);
        let connection = Connection::open(&database).unwrap();
        let title = connection
            .query_row(
                "SELECT title FROM threads WHERE id = ?1",
                [session_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        assert_eq!(title, "Initial");
        let backup_root = root
            .join("backups_state")
            .join("easy-cli-proxy-api")
            .join("session-context-edits");
        let backup = fs::read_dir(backup_root)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(backup.join("database-rows.json").is_file());
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_rolls_back_session_index_when_database_update_fails() {
        let root = test_root("context-index-database-rollback");
        let session_id = "019f1234-abcd-7000-8000-000000000051";
        let directory = root.join("sessions");
        fs::create_dir_all(&directory).unwrap();
        let rollout = directory.join(format!("rollout-{session_id}.jsonl"));
        let initial = format!(
            "{}\n",
            json!({"type":"session_meta","payload":{"id":session_id,"title":"Initial"}})
        );
        fs::write(&rollout, &initial).unwrap();
        let index_path = root.join("session_index.jsonl");
        let initial_index = format!(
            "{}\r\n",
            json!({"id":session_id,"thread_name":"Initial","updated_at":"2026-10-05T00:00:00Z"})
        );
        fs::write(&index_path, &initial_index).unwrap();

        let database = root.join("state_5.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT);\n\
                 CREATE TRIGGER reject_context_update BEFORE UPDATE ON threads BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, 'Initial')",
                rusqlite::params![session_id, rollout.to_string_lossy().to_string()],
            )
            .unwrap();
        drop(connection);

        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        let request = SaveCodexSessionContextRequest {
            title: Some("Updated".to_string()),
            ..empty_context_request(session_id.to_string(), detail.rollout_sha256)
        };
        let error = save_codex_session_context_from_home(&root, request).unwrap_err();
        assert!(error.contains("session index restored"));
        assert_eq!(fs::read_to_string(&rollout).unwrap(), initial);
        let saved_index = fs::read(&index_path).unwrap();
        assert!(saved_index.starts_with(initial_index.as_bytes()));
        assert_eq!(
            latest_session_index_entry(&saved_index, session_id)
                .unwrap()
                .unwrap()["thread_name"],
            "Initial"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_rejects_active_writer_lock() {
        let root = test_root("context-writer-lock");
        let session_id = "019f1234-abcd-7000-8000-000000000060";
        let directory = root.join("sessions");
        fs::create_dir_all(&directory).unwrap();
        let rollout = directory.join(format!("rollout-{session_id}.jsonl"));
        fs::write(
            &rollout,
            format!(
                "{}\n",
                json!({"type":"session_meta","payload":{"id":session_id}})
            ),
        )
        .unwrap();
        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        let lock_directory = root.join("thread-writer-locks");
        fs::create_dir_all(&lock_directory).unwrap();
        let lock_file =
            fs::File::create(lock_directory.join(format!("{session_id}.lock"))).unwrap();
        lock_file.lock().unwrap();
        let request = SaveCodexSessionContextRequest {
            title: Some("Blocked".to_string()),
            ..empty_context_request(session_id.to_string(), detail.rollout_sha256)
        };
        let error = save_codex_session_context_from_home(&root, request).unwrap_err();
        assert!(error.contains("currently active"));
        lock_file.unlock().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_honors_writer_coordination_lock() {
        let root = test_root("context-writer-coordination");
        let directory = root.join("thread-writer-locks");
        fs::create_dir_all(&directory).unwrap();
        let coordination = fs::File::create(directory.join(".coordination.lock")).unwrap();
        coordination.lock().unwrap();
        let session_id = dynamic_session_id();
        assert!(acquire_session_writer_lock(&root, &session_id).is_err());
        assert!(!directory.join(format!("{session_id}.lock")).exists());
        coordination.unlock().unwrap();
        drop(acquire_session_writer_lock(&root, &session_id).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_rejects_overlong_session_id() {
        let long_id = "a".repeat(129);
        assert!(validate_session_id(&long_id).is_err());
        let valid_id = "a".repeat(128);
        assert!(validate_session_id(&valid_id).is_ok());
    }

    #[test]
    fn session_context_syncs_session_index_title_and_preserves_crlf() {
        let root = test_root("context-sync-index");
        let session_id = "019f1234-abcd-7000-8000-000000000088";
        let directory = root.join("sessions");
        fs::create_dir_all(&directory).unwrap();
        let rollout = directory.join(format!("rollout-{session_id}.jsonl"));
        let meta = json!({"type":"session_meta","payload":{"id":session_id,"title":"Old Title"}})
            .to_string();
        let user = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hi"}]}}).to_string();
        let crlf_data = format!("{meta}\r\n{user}\r\n");
        fs::write(&rollout, crlf_data.as_bytes()).unwrap();

        let index_file = root.join("session_index.jsonl");
        let index_entry =
            json!({"id":session_id,"thread_name":"Old Title","updated_at":"2026-10-05T00:00:00Z"})
                .to_string();
        fs::write(&index_file, format!("{index_entry}\r\n")).unwrap();

        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        assert_eq!(detail.title, "Old Title");

        let request = SaveCodexSessionContextRequest {
            title: Some("Renamed Thread".to_string()),
            ..empty_context_request(session_id.to_string(), detail.rollout_sha256)
        };
        let save_res = save_codex_session_context_from_home(&root, request).unwrap();
        assert!(save_res.success);

        let saved_rollout = fs::read(&rollout).unwrap();
        assert!(saved_rollout.windows(2).any(|window| window == b"\r\n"));

        let updated_index = fs::read_to_string(&index_file).unwrap();
        assert!(updated_index.starts_with(&format!("{index_entry}\r\n")));
        assert!(updated_index.ends_with("\r\n"));
        assert_eq!(
            latest_session_index_entry(updated_index.as_bytes(), session_id)
                .unwrap()
                .unwrap()["thread_name"],
            "Renamed Thread"
        );

        let backup = PathBuf::from(save_res.backup_path.unwrap());
        assert!(backup.join("session_index.jsonl.bak").is_file());

        fs::remove_dir_all(root).unwrap();
    }

    fn empty_context_request(
        session_id: String,
        expected_rollout_sha256: Option<String>,
    ) -> SaveCodexSessionContextRequest {
        SaveCodexSessionContextRequest {
            session_id,
            expected_rollout_sha256,
            title: None,
            cwd: None,
            model_provider: None,
            model: None,
            archived: None,
            message_updates: None,
            new_messages: None,
        }
    }

    fn context_save_request(detail: &CodexSessionContextDetail) -> SaveCodexSessionContextRequest {
        SaveCodexSessionContextRequest {
            session_id: detail.id.clone(),
            expected_rollout_sha256: detail.rollout_sha256.clone(),
            title: None,
            cwd: None,
            model_provider: None,
            model: None,
            archived: None,
            message_updates: None,
            new_messages: None,
        }
    }

    #[test]
    fn session_context_replaces_all_text_parts_and_keeps_images() {
        let image = json!({"type":"input_image","image_url":"data:image/png;base64,fixture"});
        let mut content = json!([
            {"type":"input_text","text":"First part"},
            image.clone(),
            {"type":"input_text","text":"Second part"},
            "Third part"
        ]);
        update_content_text(&mut content, "Replacement", "output_text");
        assert_eq!(extract_content_text(&content), "Replacement");
        assert_eq!(
            content,
            json!([{"type":"output_text","text":"Replacement"}, image.clone()])
        );

        let mut image_only = json!([image.clone()]);
        update_content_text(&mut image_only, "New caption", "input_text");
        assert_eq!(
            image_only,
            json!([image, {"type":"input_text","text":"New caption"}])
        );
    }

    #[test]
    fn session_context_removes_tool_calls_and_outputs_together() {
        let root = test_root("context-tool-pairs");
        let session_id = "019f1234-abcd-7000-8000-000000000091";
        fs::create_dir_all(root.join("sessions")).unwrap();
        let rollout = root
            .join("sessions")
            .join(format!("rollout-{session_id}.jsonl"));
        let records = vec![
            json!({"type":"session_meta","payload":{"id":session_id}}),
            json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}","call_id":"call-1"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","output":"Output 1","call_id":"call-1"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"patch","call_id":"call-2"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call_output","output":"Output 2","call_id":"call-2"}}),
        ];
        fs::write(&rollout, serialize_jsonl(&records, "\n").unwrap()).unwrap();
        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        assert_eq!(detail.stats.tool_count, 4);
        assert_eq!(detail.messages[1].content, "Output 1");
        assert_eq!(detail.messages[1].call_id.as_deref(), Some("call-1"));
        assert_eq!(detail.messages[2].content, "apply_patch(patch)");

        let mut edit_request = context_save_request(&detail);
        edit_request.message_updates = Some(vec![CodexSessionMessageUpdate {
            line_number: 2,
            role: None,
            content: Some("Blocked edit".to_string()),
            deleted: None,
        }]);
        assert!(save_codex_session_context_from_home(&root, edit_request)
            .unwrap_err()
            .contains("only supports removal"));

        let mut remove_request = context_save_request(&detail);
        remove_request.message_updates = Some(vec![CodexSessionMessageUpdate {
            line_number: 2,
            role: None,
            content: None,
            deleted: Some(true),
        }]);
        save_codex_session_context_from_home(&root, remove_request).unwrap();
        let saved = fs::read_to_string(&rollout).unwrap();
        assert!(!saved.contains("call-1"));
        assert!(saved.contains("call-2"));
        assert_eq!(
            get_codex_session_context_from_home(&root, session_id)
                .unwrap()
                .stats
                .tool_count,
            2
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_preserves_externally_changed_index_during_rollback() {
        let root = test_root("context-index-external-change");
        let path = root.join("session_index.jsonl");
        let id = dynamic_session_id();
        let other = dynamic_session_id();
        let original = format!("{}\n", json!({"id":id,"thread_name":"original"}));
        fs::write(&path, &original).unwrap();
        let update = build_session_index_title_update(&root, &id, "updated")
            .unwrap()
            .unwrap();
        // Another thread can append before and after this save.
        let mut writer = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(writer, "{}", json!({"id":other,"thread_name":"other"})).unwrap();
        apply_session_index_title_update(&update).unwrap();
        writeln!(
            writer,
            "{}",
            json!({"id":other,"thread_name":"newer other"})
        )
        .unwrap();
        restore_session_index(&update).unwrap();
        let current = fs::read(&path).unwrap();
        assert!(current.starts_with(original.as_bytes()));
        assert_eq!(
            latest_session_index_entry(&current, &id).unwrap().unwrap()["thread_name"],
            "original"
        );
        assert_eq!(
            latest_session_index_entry(&current, &other)
                .unwrap()
                .unwrap()["thread_name"],
            "newer other"
        );
        let update = build_session_index_title_update(&root, &id, "updated again")
            .unwrap()
            .unwrap();
        apply_session_index_title_update(&update).unwrap();
        writeln!(writer, "{}", json!({"id":id,"thread_name":"external"})).unwrap();
        let externally_changed = fs::read(&path).unwrap();
        assert!(restore_session_index(&update)
            .unwrap_err()
            .contains("refusing to overwrite"));
        assert!(apply_session_index_title_update(&update).is_err());
        assert_eq!(fs::read(&path).unwrap(), externally_changed);
        drop(writer);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_rejects_incomplete_database_inspection_before_writing() {
        let root = test_root("context-corrupt-database");
        let session_id = "019f1234-abcd-7000-8000-000000000093";
        fs::create_dir_all(root.join("sessions")).unwrap();
        let rollout = root
            .join("sessions")
            .join(format!("rollout-{session_id}.jsonl"));
        let original = format!(
            "{}\n",
            json!({"type":"session_meta","payload":{"id":session_id}})
        );
        fs::write(&rollout, &original).unwrap();
        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        fs::write(root.join("state_5.sqlite"), b"not a database").unwrap();
        let mut request = context_save_request(&detail);
        request.title = Some("Blocked change".to_string());
        let error = save_codex_session_context_from_home(&root, request).unwrap_err();
        assert!(error.contains("saving aborted"));
        assert_eq!(fs::read_to_string(&rollout).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn session_context_syncs_thread_history_and_event_messages() {
        verify_context_projection_edit(false);
    }

    #[test]
    fn session_context_deletes_message_and_syncs_sqlite_and_events() {
        verify_context_projection_edit(true);
    }

    fn verify_context_projection_edit(deleted: bool) {
        for event_first in [false, true] {
            for retained_source in [false, true] {
                let root = test_root("context-projection-edit");
                let session_id = dynamic_session_id();
                let fixture = seed_context_edit_fixture(&root, &session_id);
                let mut records =
                    validate_raw_jsonl(&fs::read_to_string(&fixture.rollout).unwrap(), &session_id)
                        .unwrap()
                        .into_iter()
                        .map(|(_, record)| record)
                        .collect::<Vec<_>>();
                if !retained_source {
                    for record in &mut records {
                        record.as_object_mut().unwrap().remove("metadata");
                    }
                }
                if event_first {
                    records.swap(6, 7);
                }
                fs::write(&fixture.rollout, serialize_jsonl(&records, "\n").unwrap()).unwrap();
                let connection = Connection::open(&fixture.history_db).unwrap();
                connection.execute("UPDATE thread_history_projection_state SET next_rollout_byte_offset=?1 WHERE thread_id=?2", rusqlite::params![fs::metadata(&fixture.rollout).unwrap().len() as i64, session_id]).unwrap();
                connection.execute("INSERT INTO thread_items VALUES (?1,'turn-fixture','item-user-fixture',3,1,?2,'userMessage',0,1,1)",
                    rusqlite::params![session_id, json!({"type":"userMessage","content":[{"type":"text","text":"Question"}]}).to_string()]).unwrap();
                connection.execute("INSERT INTO thread_turns VALUES (?1,'turn-fixture',1,'completed',NULL,1,1,0,'item-user-fixture',?2)",
                    rusqlite::params![session_id,fixture.agent_item_id]).unwrap();
                drop(connection);
                let context = get_codex_session_context_from_home(&root, &session_id).unwrap();
                let mut request = context_save_request(&context);
                request.message_updates = Some(vec![CodexSessionMessageUpdate {
                    line_number: assistant_line_number(&context),
                    role: None,
                    content: Some("Edited answer".into()),
                    deleted: Some(deleted),
                }]);
                let result = save_codex_session_context_from_home(&root, request).unwrap();
                let saved = fs::read_to_string(&fixture.rollout).unwrap();
                let connection = Connection::open(&fixture.history_db).unwrap();
                let agent: Option<String> = connection
                    .query_row(
                        "SELECT item_json FROM thread_items WHERE item_id = ?1",
                        [fixture.agent_item_id],
                        |row| row.get(0),
                    )
                    .optional()
                    .unwrap();
                if deleted {
                    assert!(agent.is_none());
                    assert!(!saved.contains(fixture.agent_item_id));
                    let final_id: Option<String> = connection
                        .query_row("SELECT final_agent_item_id FROM thread_turns", [], |row| {
                            row.get(0)
                        })
                        .unwrap();
                    assert!(final_id.is_none());
                } else {
                    assert!(agent.unwrap().contains("Edited answer"));
                    assert_eq!(saved.matches("Edited answer").count(), 3);
                    let records = validate_raw_jsonl(&saved, &session_id).unwrap();
                    let event = records
                        .iter()
                        .find(|(_, record)| {
                            record["payload"]["item"]["id"] == fixture.agent_item_id
                        })
                        .unwrap();
                    assert_eq!(event.1["payload"]["item"]["content"][0]["type"], "Text");
                }
                let cursor: (i64,i64) = connection.query_row("SELECT next_rollout_byte_offset,next_rollout_ordinal FROM thread_history_projection_state", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
                assert_eq!(cursor, (saved.len() as i64, 9));
                let user: String = connection
                    .query_row(
                        "SELECT item_json FROM thread_items WHERE item_id = 'item-user-fixture'",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap();
                assert!(user.contains("Question"));
                assert!(PathBuf::from(result.backup_path.unwrap())
                    .join("thread-history-rows.json")
                    .is_file());
                drop(connection);
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn session_context_edits_reasoning_and_strips_signature() {
        let root = test_root("context-reasoning-strip");
        let session_id = dynamic_session_id();
        let fixture = seed_context_edit_fixture(&root, &session_id);
        let context = get_codex_session_context_from_home(&root, &session_id).unwrap();
        let mut request = context_save_request(&context);
        request.message_updates = Some(vec![CodexSessionMessageUpdate {
            line_number: context
                .messages
                .iter()
                .find(|message| message.role == "reasoning")
                .unwrap()
                .line_number,
            role: None,
            content: Some("New clean edited thoughts".to_string()),
            deleted: None,
        }]);
        save_codex_session_context_from_home(&root, request).unwrap();
        let rollout = fs::read_to_string(&fixture.rollout).unwrap();
        let projected =
            thread_item_json(&fixture.history_db, &session_id, fixture.reasoning_item_id);
        for copy in [rollout, projected] {
            assert!(copy.contains("New clean edited thoughts"));
            assert!(copy.contains("\"signature_stripped\":true"));
            assert!(!copy.contains("fake-signature"));
            assert!(!copy.contains("encrypted-blob"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    struct ContextEditFixture {
        rollout: PathBuf,
        state_db: PathBuf,
        history_db: PathBuf,
        agent_item_id: &'static str,
        reasoning_item_id: &'static str,
    }

    /// Seeds a rollout that carries both copies of every item (`response_item`
    /// and `item_completed`), a state database and a thread history projection,
    /// so the projection contract can be asserted end to end.
    fn seed_context_edit_fixture(root: &Path, session_id: &str) -> ContextEditFixture {
        let turn_id = "turn-fixture";
        let user_item_id = "item-user-fixture";
        let reasoning_item_id = "item-reasoning-fixture";
        let agent_item_id = "item-agent-fixture";

        let sessions_dir = root.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        let rollout = sessions_dir.join(format!("rollout-{session_id}.jsonl"));
        let lines = [
            json!({"ordinal": 0, "type": "session_meta", "payload": {"id": session_id, "title": "Original Title", "cwd": "/old", "model_provider": "openai"}}).to_string(),
            json!({"ordinal": 1, "type": "event_msg", "payload": {"type": "task_started", "turn_id": turn_id}}).to_string(),
            json!({"ordinal": 2, "type": "response_item", "metadata": {"retained_source": {"id": {"message_id": user_item_id, "role": "user", "turn_id": turn_id}}}, "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Question"}]}}).to_string(),
            json!({"ordinal": 3, "type": "event_msg", "payload": {"type": "item_completed", "thread_id": session_id, "turn_id": turn_id, "item": {"id": user_item_id, "type": "UserMessage", "content": [{"type": "text", "text": "Question", "text_elements": []}]}}}).to_string(),
            json!({"ordinal": 4, "type": "response_item", "payload": {"type": "reasoning", "id": reasoning_item_id, "summary": [{"type": "summary_text", "text": "Original thoughts"}], "content": [], "signature": "fake-signature", "encrypted_content": "encrypted-blob"}}).to_string(),
            json!({"ordinal": 5, "type": "event_msg", "payload": {"type": "item_completed", "thread_id": session_id, "turn_id": turn_id, "item": {"id": reasoning_item_id, "type": "Reasoning", "summary_text": ["Original thoughts"], "raw_content": ["Original raw thoughts"], "signature": "fake-signature"}}}).to_string(),
            json!({"ordinal": 6, "type": "response_item", "metadata": {"retained_source": {"id": {"message_id": agent_item_id, "role": "assistant", "turn_id": turn_id}}}, "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Answer"}]}}).to_string(),
            json!({"ordinal": 7, "type": "event_msg", "payload": {"type": "item_completed", "thread_id": session_id, "turn_id": turn_id, "item": {"id": agent_item_id, "type": "AgentMessage", "content": [{"type": "Text", "text": "Answer"}]}}}).to_string(),
            json!({"ordinal": 8, "type": "event_msg", "payload": {"type": "task_complete", "turn_id": turn_id, "last_agent_message": "Answer"}}).to_string(),
        ];
        fs::write(&rollout, format!("{}\n", lines.join("\n"))).unwrap();

        let state_db = root.join("state_5.sqlite");
        let connection = Connection::open(&state_db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT, model_provider TEXT, archived INTEGER, updated_at_ms INTEGER);\n\
                 CREATE TABLE local_thread_catalog (thread_id TEXT PRIMARY KEY, display_title TEXT, cwd TEXT, model_provider TEXT, source_updated_at REAL);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, 'Original Title', '/old', 'openai', 0, 100)",
                rusqlite::params![session_id, rollout.to_string_lossy().to_string()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO local_thread_catalog VALUES (?1, 'Original Title', '/old', 'openai', 1.0)",
                [session_id],
            )
            .unwrap();
        drop(connection);

        let history_db = root.join("thread_history_1.sqlite");
        let connection = Connection::open(&history_db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE thread_items (
                    thread_id TEXT NOT NULL,
                    turn_id TEXT NOT NULL,
                    item_id TEXT NOT NULL,
                    rollout_ordinal INTEGER NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    item_json TEXT NOT NULL,
                    item_type TEXT NOT NULL,
                    updated_at_ordinal INTEGER NOT NULL,
                    started_at_ms INTEGER,
                    completed_at_ms INTEGER,
                    PRIMARY KEY (thread_id, turn_id, item_id)
                );
                CREATE TABLE thread_turns (
                    thread_id TEXT NOT NULL,
                    turn_id TEXT NOT NULL,
                    rollout_ordinal INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    error_json TEXT,
                    started_at INTEGER,
                    completed_at INTEGER,
                    duration_ms INTEGER,
                    first_user_item_id TEXT,
                    final_agent_item_id TEXT,
                    PRIMARY KEY (thread_id, turn_id)
                );
                CREATE TABLE thread_history_projection_state (
                    thread_id TEXT PRIMARY KEY,
                    next_rollout_byte_offset INTEGER NOT NULL,
                    next_rollout_ordinal INTEGER NOT NULL
                );",
            )
            .unwrap();
        let agent_json =
            json!({"type": "agentMessage", "id": agent_item_id, "text": "Answer"}).to_string();
        connection
            .execute(
                "INSERT INTO thread_items VALUES (?1, ?2, ?3, 6, 1500, ?4, 'agentMessage', 0, 1500, 1500)",
                rusqlite::params![session_id, turn_id, agent_item_id, agent_json],
            )
            .unwrap();
        let reasoning_json = json!({
            "type": "reasoning",
            "id": reasoning_item_id,
            "summary": ["Original thoughts"],
            "content": ["Original raw thoughts"],
            "signature": "fake-signature",
            "encrypted_content": "encrypted-blob"
        })
        .to_string();
        connection
            .execute(
                "INSERT INTO thread_items VALUES (?1, ?2, ?3, 4, 1500, ?4, 'reasoning', 0, 1500, 1500)",
                rusqlite::params![session_id, turn_id, reasoning_item_id, reasoning_json],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO thread_history_projection_state VALUES (?1, ?2, 9)",
                rusqlite::params![session_id, fs::metadata(&rollout).unwrap().len() as i64],
            )
            .unwrap();
        drop(connection);

        ContextEditFixture {
            rollout,
            state_db,
            history_db,
            agent_item_id,
            reasoning_item_id,
        }
    }

    fn thread_item_json(history_db: &Path, session_id: &str, item_id: &str) -> String {
        let connection = Connection::open(history_db).unwrap();
        connection
            .query_row(
                "SELECT item_json FROM thread_items WHERE thread_id = ?1 AND item_id = ?2",
                rusqlite::params![session_id, item_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn thread_item_json_for_turn(
        history_db: &Path,
        session_id: &str,
        turn_id: &str,
        item_id: &str,
    ) -> String {
        let connection = Connection::open(history_db).unwrap();
        connection
            .query_row(
                "SELECT item_json FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 AND item_id = ?3",
                rusqlite::params![session_id, turn_id, item_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    fn assistant_line_number(context: &CodexSessionContextDetail) -> usize {
        context
            .messages
            .iter()
            .find(|message| message.role == "assistant")
            .unwrap()
            .line_number
    }

    #[test]
    fn context_save_restores_the_state_database_when_thread_history_sync_fails() {
        let root = test_root("context-state-db-rollback");
        let session_id = "019f1234-abcd-7000-8000-0000000000e1";
        let fixture = seed_context_edit_fixture(&root, session_id);

        let connection = Connection::open(&fixture.history_db).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER fail_thread_item_update BEFORE UPDATE ON thread_items BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
            )
            .unwrap();
        drop(connection);

        let context = get_codex_session_context_from_home(&root, session_id).unwrap();
        let mut request = context_save_request(&context);
        request.title = Some("Changed Title".to_string());
        request.message_updates = Some(vec![CodexSessionMessageUpdate {
            line_number: assistant_line_number(&context),
            role: None,
            content: Some("Answer edited".to_string()),
            deleted: None,
        }]);

        let error = save_codex_session_context_from_home(&root, request).unwrap_err();
        assert!(error.contains("Thread history sync failed"), "{error}");
        assert!(error.contains("session database restored"), "{error}");

        let connection = Connection::open(&fixture.state_db).unwrap();
        let title: String = connection
            .query_row(
                "SELECT title FROM threads WHERE id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .unwrap();
        let catalog: (String, f64) = connection
            .query_row(
                "SELECT display_title, source_updated_at FROM local_thread_catalog WHERE thread_id = ?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        drop(connection);
        assert_eq!(title, "Original Title");
        assert_eq!(catalog, ("Original Title".to_string(), 1.0));

        let rollout = fs::read_to_string(&fixture.rollout).unwrap();
        assert!(rollout.contains("Answer"));
        assert!(!rollout.contains("Answer edited"));
        assert!(rollout.contains("Original Title"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn context_save_fails_when_the_projection_cursor_cannot_be_updated() {
        let root = test_root("context-cursor-failure");
        let session_id = "019f1234-abcd-7000-8000-0000000000e5";
        let fixture = seed_context_edit_fixture(&root, session_id);

        let connection = Connection::open(&fixture.history_db).unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER fail_projection_state BEFORE UPDATE ON thread_history_projection_state BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
            )
            .unwrap();
        drop(connection);

        let context = get_codex_session_context_from_home(&root, session_id).unwrap();
        let mut request = context_save_request(&context);
        request.message_updates = Some(vec![CodexSessionMessageUpdate {
            line_number: assistant_line_number(&context),
            role: None,
            content: Some("Answer edited".to_string()),
            deleted: None,
        }]);

        let error = save_codex_session_context_from_home(&root, request).unwrap_err();
        assert!(error.contains("projection cursor"), "{error}");

        let rollout = fs::read_to_string(&fixture.rollout).unwrap();
        assert!(!rollout.contains("Answer edited"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn assistant_edit_preserves_untouched_reasoning_in_every_copy() {
        let root = test_root("context-signature-copies");
        let session_id = "019f1234-abcd-7000-8000-0000000000e4";
        let fixture = seed_context_edit_fixture(&root, session_id);
        let original_reasoning =
            thread_item_json(&fixture.history_db, session_id, fixture.reasoning_item_id);
        let original_records =
            validate_raw_jsonl(&fs::read_to_string(&fixture.rollout).unwrap(), session_id).unwrap();

        let context = get_codex_session_context_from_home(&root, session_id).unwrap();
        let mut request = context_save_request(&context);
        request.message_updates = Some(vec![CodexSessionMessageUpdate {
            line_number: assistant_line_number(&context),
            role: None,
            content: Some("Answer edited".to_string()),
            deleted: None,
        }]);
        save_codex_session_context_from_home(&root, request).unwrap();

        let rollout = fs::read_to_string(&fixture.rollout).unwrap();
        assert!(rollout.contains("Answer edited"));
        let saved_records = validate_raw_jsonl(&rollout, session_id).unwrap();
        for index in [4, 5] {
            assert_eq!(saved_records[index], original_records[index]);
        }

        let reasoning_json =
            thread_item_json(&fixture.history_db, session_id, fixture.reasoning_item_id);
        assert_eq!(reasoning_json, original_reasoning);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn thinking_edit_rewrites_the_original_thinking_field() {
        let root = test_root("context-thinking-field");
        let session_id = "019f1234-abcd-7000-8000-0000000000e6";
        let sessions_dir = root.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        let rollout = sessions_dir.join(format!("rollout-{session_id}.jsonl"));
        let lines = [
            json!({"type": "session_meta", "payload": {"id": session_id, "title": "Thinking"}}).to_string(),
            json!({"type": "response_item", "payload": {"type": "thinking", "id": "thinking-item", "thinking": "Original thinking", "signature": "thinking-signature"}}).to_string(),
        ];
        fs::write(&rollout, format!("{}\n", lines.join("\n"))).unwrap();

        let context = get_codex_session_context_from_home(&root, session_id).unwrap();
        let reasoning_line = context
            .messages
            .iter()
            .find(|message| message.role == "reasoning")
            .unwrap()
            .line_number;
        let mut request = context_save_request(&context);
        request.message_updates = Some(vec![CodexSessionMessageUpdate {
            line_number: reasoning_line,
            role: None,
            content: Some("Edited thinking".to_string()),
            deleted: None,
        }]);
        save_codex_session_context_from_home(&root, request).unwrap();

        let updated = get_codex_session_context_from_home(&root, session_id).unwrap();
        let reasoning = updated
            .messages
            .iter()
            .find(|message| message.role == "reasoning")
            .unwrap();
        assert_eq!(reasoning.content, "Edited thinking");
        assert!(reasoning.signature_stripped.unwrap_or(false));

        let saved = fs::read_to_string(&rollout).unwrap();
        assert!(
            saved.contains("\"thinking\":\"Edited thinking\""),
            "{saved}"
        );
        assert!(!saved.contains("Original thinking"));
        assert!(!saved.contains("thinking-signature"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn role_only_update_cannot_blank_the_projected_text() {
        let root = test_root("context-role-only");
        let session_id = "019f1234-abcd-7000-8000-0000000000e7";
        let fixture = seed_context_edit_fixture(&root, session_id);
        let before = fs::read_to_string(&fixture.rollout).unwrap();

        let context = get_codex_session_context_from_home(&root, session_id).unwrap();
        let mut request = context_save_request(&context);
        request.message_updates = Some(vec![CodexSessionMessageUpdate {
            line_number: assistant_line_number(&context),
            role: Some("user".to_string()),
            content: None,
            deleted: None,
        }]);
        let error = save_codex_session_context_from_home(&root, request).unwrap_err();
        assert!(error.contains("cannot change the message role"), "{error}");

        assert_eq!(fs::read_to_string(&fixture.rollout).unwrap(), before);
        let agent_json = thread_item_json(&fixture.history_db, session_id, fixture.agent_item_id);
        assert!(agent_json.contains("\"text\":\"Answer\""), "{agent_json}");

        fs::remove_dir_all(root).unwrap();
    }

    /// P1-3: a metadata-only save on a session without a rollout must leave the
    /// projection cursor untouched instead of resetting it to 0/0.
    #[test]
    fn metadata_save_without_a_rollout_keeps_the_projection_cursor() {
        let root = test_root("context-no-rollout-cursor");
        let session_id = "019f1234-abcd-7000-8000-0000000000f2";
        fs::create_dir_all(root.join("sessions")).unwrap();

        let state_db = root.join("state_5.sqlite");
        let connection = Connection::open(&state_db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT, model_provider TEXT, archived INTEGER, updated_at_ms INTEGER);\n\
                 CREATE TABLE local_thread_catalog (thread_id TEXT PRIMARY KEY, display_title TEXT, cwd TEXT, model_provider TEXT, source_updated_at REAL);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, 'Original Title', '/old', 'openai', 0, 100)",
                rusqlite::params![
                    session_id,
                    root.join("sessions")
                        .join("missing.jsonl")
                        .to_string_lossy()
                        .to_string()
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO local_thread_catalog VALUES (?1, 'Original Title', '/old', 'openai', 1.0)",
                [session_id],
            )
            .unwrap();
        drop(connection);

        let history_db = root.join("thread_history_no_rollout.sqlite");
        let connection = Connection::open(&history_db).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, item_type TEXT NOT NULL, item_json TEXT NOT NULL);\n\
                 CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, first_user_item_id TEXT, final_agent_item_id TEXT);\n\
                 CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO thread_history_projection_state VALUES (?1, 100, 9)",
                [session_id],
            )
            .unwrap();
        drop(connection);

        let detail = get_codex_session_context_from_home(&root, session_id).unwrap();
        let mut request = context_save_request(&detail);
        request.title = Some("Renamed Title".to_string());
        save_codex_session_context_from_home(&root, request).unwrap();

        let connection = Connection::open(&history_db).unwrap();
        let cursor: (i64, i64) = connection
            .query_row(
                "SELECT next_rollout_byte_offset, next_rollout_ordinal FROM thread_history_projection_state WHERE thread_id = ?1",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        drop(connection);
        assert_eq!(cursor, (100, 9));

        let connection = Connection::open(&state_db).unwrap();
        let title: String = connection
            .query_row(
                "SELECT title FROM threads WHERE id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        assert_eq!(title, "Renamed Title");

        fs::remove_dir_all(root).unwrap();
    }

    /// P1/P2-4: newly added messages must keep the turn summary ids in sync.
    #[test]
    fn added_messages_update_the_turn_summary_ids() {
        let root = test_root("context-added-turn-summary");
        let session_id = "019f1234-abcd-7000-8000-0000000000f3";
        let fixture = seed_context_edit_fixture(&root, session_id);
        let connection = Connection::open(&fixture.history_db).unwrap();
        connection
            .execute(
                "INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES (?1, 'turn-fixture', 1, 'completed')",
                [session_id],
            )
            .unwrap();
        drop(connection);

        let context = get_codex_session_context_from_home(&root, session_id).unwrap();
        let mut request = context_save_request(&context);
        request.new_messages = Some(vec![
            CodexSessionNewMessage {
                role: "user".to_string(),
                content: "Follow-up question".to_string(),
            },
            CodexSessionNewMessage {
                role: "assistant".to_string(),
                content: "Follow-up answer".to_string(),
            },
        ]);
        save_codex_session_context_from_home(&root, request).unwrap();

        let connection = Connection::open(&fixture.history_db).unwrap();
        let summary: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT first_user_item_id, final_agent_item_id FROM thread_turns WHERE thread_id = ?1 AND turn_id = 'turn-fixture'",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        drop(connection);
        let first_user_item_id = summary.0.expect("first user item id");
        let final_agent_item_id = summary.1.expect("final agent item id");

        let user_json = thread_item_json(&fixture.history_db, session_id, &first_user_item_id);
        assert!(user_json.contains("Follow-up question"), "{user_json}");
        let agent_json = thread_item_json(&fixture.history_db, session_id, &final_agent_item_id);
        assert!(agent_json.contains("Follow-up answer"), "{agent_json}");

        fs::remove_dir_all(root).unwrap();
    }

    /// P2-5: several assistant messages in one turn must resolve the turn's
    /// `last_agent_message` from the message order, not from hash iteration.
    #[test]
    fn same_turn_assistant_edits_resolve_last_agent_message_deterministically() {
        let root = test_root("context-last-agent-deterministic");
        let session_id = "019f1234-abcd-7000-8000-0000000000f4";
        let turn_id = "turn-double-answer";
        let sessions_dir = root.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        let rollout = sessions_dir.join(format!("rollout-{session_id}.jsonl"));
        let lines = [
            json!({"ordinal": 0, "type": "session_meta", "payload": {"id": session_id, "title": "Two answers"}}).to_string(),
            json!({"ordinal": 1, "type": "event_msg", "payload": {"type": "task_started", "turn_id": turn_id}}).to_string(),
            json!({"ordinal": 2, "type": "response_item", "metadata": {"retained_source": {"id": {"message_id": "item-answer-1", "role": "assistant", "turn_id": turn_id}}}, "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "First answer"}]}}).to_string(),
            json!({"ordinal": 3, "type": "event_msg", "payload": {"type": "item_completed", "thread_id": session_id, "turn_id": turn_id, "item": {"id": "item-answer-1", "type": "AgentMessage", "content": [{"type": "Text", "text": "First answer"}]}}}).to_string(),
            json!({"ordinal": 4, "type": "response_item", "metadata": {"retained_source": {"id": {"message_id": "item-answer-2", "role": "assistant", "turn_id": turn_id}}}, "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Second answer"}]}}).to_string(),
            json!({"ordinal": 5, "type": "event_msg", "payload": {"type": "item_completed", "thread_id": session_id, "turn_id": turn_id, "item": {"id": "item-answer-2", "type": "AgentMessage", "content": [{"type": "Text", "text": "Second answer"}]}}}).to_string(),
            json!({"ordinal": 6, "type": "event_msg", "payload": {"type": "task_complete", "turn_id": turn_id, "last_agent_message": "Second answer"}}).to_string(),
        ];
        fs::write(&rollout, format!("{}\n", lines.join("\n"))).unwrap();

        let context = get_codex_session_context_from_home(&root, session_id).unwrap();
        let assistant_lines = context
            .messages
            .iter()
            .filter(|message| message.role == "assistant")
            .map(|message| message.line_number)
            .collect::<Vec<_>>();
        assert_eq!(assistant_lines.len(), 2, "{assistant_lines:?}");

        let mut request = context_save_request(&context);
        request.message_updates = Some(vec![
            CodexSessionMessageUpdate {
                line_number: assistant_lines[0],
                role: None,
                content: Some("First edited".to_string()),
                deleted: None,
            },
            CodexSessionMessageUpdate {
                line_number: assistant_lines[1],
                role: None,
                content: Some("Second edited".to_string()),
                deleted: None,
            },
        ]);
        save_codex_session_context_from_home(&root, request).unwrap();

        let saved = fs::read_to_string(&rollout).unwrap();
        assert!(
            saved.contains("\"last_agent_message\":\"Second edited\""),
            "{saved}"
        );
        assert!(
            !saved.contains("\"last_agent_message\":\"First edited\""),
            "{saved}"
        );
        assert_eq!(saved.matches("Second edited").count(), 3, "{saved}");

        fs::remove_dir_all(root).unwrap();
    }

    /// A corrupt history database must abort before any durable edit.
    #[test]
    fn history_inspection_failure_aborts_before_writing() {
        let root = test_root("context-history-backup-failure");
        let session_id = "019f1234-abcd-7000-8000-0000000000f7";
        let fixture = seed_context_edit_fixture(&root, session_id);
        let before = fs::read_to_string(&fixture.rollout).unwrap();

        fs::write(
            root.join("thread_history_broken.sqlite"),
            b"not a sqlite database",
        )
        .unwrap();

        let context = get_codex_session_context_from_home(&root, session_id).unwrap();
        let mut request = context_save_request(&context);
        request.title = Some("Renamed Title".to_string());
        request.message_updates = Some(vec![CodexSessionMessageUpdate {
            line_number: assistant_line_number(&context),
            role: None,
            content: Some("Answer edited".to_string()),
            deleted: None,
        }]);

        let error = save_codex_session_context_from_home(&root, request).unwrap_err();
        assert!(
            error.contains("Failed to inspect thread history projection"),
            "{error}"
        );

        assert_eq!(fs::read_to_string(&fixture.rollout).unwrap(), before);
        let agent_json = thread_item_json(&fixture.history_db, session_id, fixture.agent_item_id);
        assert!(agent_json.contains("\"text\":\"Answer\""), "{agent_json}");

        let connection = Connection::open(&fixture.state_db).unwrap();
        let title: String = connection
            .query_row(
                "SELECT title FROM threads WHERE id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        assert_eq!(title, "Original Title");

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(test)]
    mod projection_regressions {
        use super::*;
        fn req() -> SaveCodexSessionContextRequest {
            SaveCodexSessionContextRequest {
                session_id: "s".into(),
                expected_rollout_sha256: None,
                title: None,
                cwd: None,
                model_provider: None,
                model: None,
                archived: None,
                message_updates: None,
                new_messages: None,
            }
        }
        fn meta() -> Value {
            json!({"ordinal":0,"type":"session_meta","payload":{"id":"s"}})
        }
        fn response(turn: &str, id: &str, text: &str, ordinal: i64) -> Value {
            json!({"ordinal":ordinal,"type":"response_item","metadata":{"retained_source":{"id":{"message_id":id,"turn_id":turn}}},"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}})
        }
        fn event(turn: &str, id: &str, text: &str, ordinal: i64) -> Value {
            json!({"ordinal":ordinal,"type":"event_msg","payload":{"type":"item_completed","thread_id":"s","turn_id":turn,"item":{"id":id,"type":"AgentMessage","content":[{"type":"Text","text":text}]}}})
        }
        fn start(turn: &str, ordinal: i64) -> Value {
            json!({"ordinal":ordinal,"type":"event_msg","payload":{"type":"task_started","turn_id":turn}})
        }
        fn complete(turn: &str, text: &str, ordinal: i64) -> Value {
            json!({"ordinal":ordinal,"type":"event_msg","payload":{"type":"task_complete","turn_id":turn,"last_agent_message":text}})
        }

        #[test]
        fn appending_messages_preserves_turn_terminal_and_timing() {
            for explicit in [false, true] {
                for line_ending in ["\n", "\r\n"] {
                    for terminal in [None, Some("task_complete"), Some("turn_aborted")] {
                        for started in [false, true] {
                            let mut original = vec![
                                meta(),
                                start("earlier", 10),
                                complete("earlier", "earlier", 20),
                            ];
                            if started {
                                original.push(start("t1", 30));
                            }
                            original.extend([
                                response("t1", "old", "old", 40),
                                event("t1", "old", "old", 50),
                            ]);
                            if let Some(kind) = terminal {
                                original.push(json!({"ordinal":60,"timestamp":"original-time","type":"event_msg","payload":{"type":kind,"turn_id":"t1","last_agent_message":"old","completed_at":123,"duration_ms":456,"reason":"interrupted"}}));
                            }
                            original.push(json!({"ordinal":70,"type":"event_msg","payload":{"type":"token_count","info":{"total_tokens":99}}}));
                            if !explicit {
                                for record in &mut original {
                                    record.as_object_mut().unwrap().remove("ordinal");
                                }
                            }
                            let old_terminal = original
                                .iter()
                                .find(|record| {
                                    record["payload"]["type"] == terminal.unwrap_or("absent")
                                        && record["payload"]["turn_id"] == "t1"
                                })
                                .cloned();
                            let mut request = req();
                            request.new_messages = Some(
                                [
                                    ("user", "question"),
                                    ("assistant", "first added"),
                                    ("assistant", "last added"),
                                ]
                                .into_iter()
                                .map(|(role, content)| CodexSessionNewMessage {
                                    role: role.into(),
                                    content: content.into(),
                                })
                                .collect(),
                            );
                            let (saved, plan) = build_updated_rollout(
                                &serialize_jsonl(&original, line_ending).unwrap(),
                                "s",
                                &request,
                            )
                            .unwrap();
                            let records =
                                validate_raw_jsonl(std::str::from_utf8(&saved).unwrap(), "s")
                                    .unwrap()
                                    .into_iter()
                                    .map(|(_, record)| record)
                                    .collect::<Vec<_>>();
                            let terminals = records
                                .iter()
                                .enumerate()
                                .filter(|(_, record)| {
                                    record["payload"]["turn_id"] == "t1"
                                        && matches!(
                                            record["payload"]["type"].as_str(),
                                            Some("task_complete" | "turn_aborted")
                                        )
                                })
                                .collect::<Vec<_>>();
                            assert_eq!(terminals.len(), usize::from(terminal.is_some()));
                            assert_eq!(
                                records[2], original[2],
                                "Earlier turns must stay unchanged"
                            );
                            if let Some(mut expected) = old_terminal {
                                if explicit {
                                    expected["ordinal"] = json!(66);
                                }
                                if terminal == Some("task_complete") {
                                    expected["payload"]["last_agent_message"] = json!("last added");
                                }
                                assert_eq!(*terminals[0].1, expected);
                                for item in &plan.new_items {
                                    let index = records
                                        .iter()
                                        .position(|record| {
                                            record["payload"]["item"]["id"] == item.item_id
                                        })
                                        .unwrap();
                                    assert!(index < terminals[0].0);
                                }
                            }
                            let ordinals = records
                                .iter()
                                .enumerate()
                                .map(|(index, record)| {
                                    record["ordinal"].as_i64().unwrap_or(index as i64)
                                })
                                .collect::<Vec<_>>();
                            assert!(ordinals.windows(2).all(|pair| pair[0] < pair[1]));
                            assert_eq!(
                                plan.projection_cursor.unwrap().next_ordinal,
                                ordinals.last().unwrap() + 1
                            );
                            let position = &plan.turn_positions["t1"];
                            assert_eq!(position.end_ordinal.is_some(), terminal.is_some());
                            if let Some((index, record)) = terminals.first() {
                                assert_eq!(
                                    position.end_ordinal,
                                    Some(record["ordinal"].as_i64().unwrap_or(*index as i64))
                                );
                                let end_offset = saved
                                    .split_inclusive(|byte| *byte == b'\n')
                                    .take(index + 1)
                                    .map(|line| line.len() as i64)
                                    .sum::<i64>();
                                assert_eq!(position.end_byte_offset, Some(end_offset));
                            }
                        }
                    }
                }
            }
        }

        #[test]
        fn tool_deletion_syncs_canonical_events_and_sqlite_without_task_started() {
            for started in [false, true] {
                for output_selected in [false, true] {
                    for tool_type in [
                        "CommandExecution",
                        "FileChange",
                        "DynamicToolCall",
                        "McpToolCall",
                    ] {
                        let mut original = vec![meta()];
                        if started {
                            original.push(start("t1", 1));
                        }
                        let selected = original.len() + usize::from(output_selected);
                        original.extend([
                            json!({"type":"response_item","payload":{"type":"function_call","name":"fixture_tool","arguments":"{}","call_id":"call-1"}}),
                            json!({"type":"response_item","payload":{"type":"function_call_output","output":"output","call_id":"call-1"}}),
                            json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":tool_type,"id":"call-1"}}}),
                            json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":tool_type,"id":"keep"}}}),
                        ]);
                        let mut request = req();
                        request.message_updates = Some(vec![CodexSessionMessageUpdate {
                            line_number: selected,
                            role: None,
                            content: None,
                            deleted: Some(true),
                        }]);
                        let (saved, plan) = build_updated_rollout(
                            &serialize_jsonl(&original, "\n").unwrap(),
                            "s",
                            &request,
                        )
                        .unwrap();
                        assert!(!String::from_utf8(saved).unwrap().contains("call-1"));
                        let path = db("tool-deletion-projection");
                        let connection = Connection::open(&path).unwrap();
                        for (thread, turn, id) in [
                            ("s", "t1", "call-1"),
                            ("s", "t1", "keep"),
                            ("s", "other-turn", "call-1"),
                            ("other-thread", "t1", "call-1"),
                        ] {
                            connection.execute("INSERT INTO thread_items VALUES (?1,?2,?3,1,1,'{}','commandExecution',0,1,1)", rusqlite::params![thread,turn,id]).unwrap();
                        }
                        drop(connection);
                        sync_thread_history_projection_databases(
                            std::slice::from_ref(&path),
                            "s",
                            &plan,
                        )
                        .unwrap();
                        let connection = Connection::open(&path).unwrap();
                        let count: i64 = connection
                            .query_row("SELECT COUNT(*) FROM thread_items", [], |row| row.get(0))
                            .unwrap();
                        assert_eq!(count, 3);
                        let deleted:i64 = connection.query_row("SELECT COUNT(*) FROM thread_items WHERE thread_id='s' AND turn_id='t1' AND item_id='call-1'", [], |row| row.get(0)).unwrap();
                        assert_eq!(deleted, 0);
                        drop(connection);
                        fs::remove_dir_all(path.parent().unwrap()).unwrap();
                    }
                }
            }
        }
        #[test]
        fn structured_partial_edit_must_keep_final_summary() {
            let original = vec![
                meta(),
                start("t1", 1),
                response("t1", "a1", "A", 2),
                event("t1", "a1", "A", 3),
                response("t1", "a2", "B", 4),
                event("t1", "a2", "B", 5),
                complete("t1", "B", 6),
            ];
            let mut request = req();
            request.message_updates = Some(vec![CodexSessionMessageUpdate {
                line_number: 2,
                role: None,
                content: Some("A edited".into()),
                deleted: None,
            }]);
            let (saved, _) =
                build_updated_rollout(&serialize_jsonl(&original, "\n").unwrap(), "s", &request)
                    .unwrap();
            let next = validate_raw_jsonl(std::str::from_utf8(&saved).unwrap(), "s").unwrap();
            assert_eq!(next[6].1["payload"]["last_agent_message"], json!("B"));
        }
        #[test]
        fn unmatched_context_does_not_modify_another_message_or_its_projection() {
            for context_first in [true, false] {
                for edit_context in [true, false] {
                    for deleted in [true, false] {
                        let response = |text: &str| json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}});
                        let mut original = vec![meta(), start("t1", 1)];
                        let texts = if context_first {
                            ["extra context", "actual message"]
                        } else {
                            ["actual message", "extra context"]
                        };
                        original.extend(texts.map(response));
                        original.push(json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"UserMessage","id":"real","content":[{"type":"text","text":"actual message"}]}}}));
                        let selected = if edit_context == context_first { 2 } else { 3 };
                        let untouched = original[if selected == 2 { 3 } else { 2 }].clone();
                        let mut request = req();
                        request.message_updates = Some(vec![CodexSessionMessageUpdate {
                            line_number: selected,
                            role: None,
                            content: (!deleted).then(|| "edited".into()),
                            deleted: Some(deleted),
                        }]);
                        let (saved, plan) = build_updated_rollout(
                            &serialize_jsonl(&original, "\n").unwrap(),
                            "s",
                            &request,
                        )
                        .unwrap();
                        let records =
                            validate_raw_jsonl(std::str::from_utf8(&saved).unwrap(), "s").unwrap();
                        assert!(records
                            .iter()
                            .any(|(_, record)| record["payload"] == untouched["payload"]));
                        let canonical = records
                            .iter()
                            .find(|(_, record)| record["payload"]["type"] == "item_completed");
                        if edit_context {
                            assert_eq!(canonical.unwrap().1["payload"], original[4]["payload"]);
                            assert!(plan.updated_items.is_empty());
                            assert!(plan.deleted_item_keys.is_empty());
                        } else if deleted {
                            assert!(canonical.is_none());
                            assert!(plan
                                .deleted_item_keys
                                .contains(&("real".into(), "t1".into())));
                        } else {
                            assert_eq!(
                                canonical.unwrap().1["payload"]["item"]["content"][0]["text"],
                                "edited"
                            );
                            assert_eq!(plan.updated_items.len(), 1);
                            assert_eq!(plan.updated_items[0].item_id, "real");
                        }
                        let path = db("unmatched-context-projection");
                        let connection = Connection::open(&path).unwrap();
                        let raw = json!({"id":"real","type":"userMessage","content":[{"type":"text","text":"actual message"}]}).to_string();
                        connection.execute("INSERT INTO thread_items VALUES ('s','t1','real',4,1,?1,'userMessage',0,1,1)", [&raw]).unwrap();
                        drop(connection);
                        sync_thread_history_projection_databases(std::slice::from_ref(&path), "s", &plan)
                            .unwrap();
                        let connection = Connection::open(&path).unwrap();
                        let projected: Option<String> = connection
                            .query_row(
                                "SELECT item_json FROM thread_items WHERE item_id='real'",
                                [],
                                |row| row.get(0),
                            )
                            .optional()
                            .unwrap();
                        if edit_context {
                            assert_eq!(projected.as_deref(), Some(raw.as_str()));
                        } else if deleted {
                            assert!(projected.is_none());
                        } else {
                            let item: Value = serde_json::from_str(&projected.unwrap()).unwrap();
                            assert_eq!(extract_content_text(&item["content"]), "edited");
                        }
                        drop(connection);
                        fs::remove_dir_all(path.parent().unwrap()).unwrap();
                    }
                }
            }
        }

        fn db(test_name: &str) -> PathBuf {
            let root = super::test_root(test_name);
            std::fs::create_dir_all(&root).unwrap();
            let path = root.join("history.sqlite");
            let c = Connection::open(&path).unwrap();
            c.execute_batch("CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL, updated_at_ordinal INTEGER NOT NULL, started_at_ms INTEGER, completed_at_ms INTEGER, PRIMARY KEY(thread_id,turn_id,item_id)); CREATE TABLE thread_turns (thread_id TEXT,turn_id TEXT,first_user_item_id TEXT,final_agent_item_id TEXT); ").unwrap();
            path
        }
        #[test]
        fn new_item_db_ordinal_must_match_rollout() {
            let original = vec![meta(), start("t1", 1), complete("t1", "", 2)];
            let mut request = req();
            request.new_messages = Some(vec![CodexSessionNewMessage {
                role: "user".into(),
                content: "new".into(),
            }]);
            let (saved, plan) =
                build_updated_rollout(&serialize_jsonl(&original, "\n").unwrap(), "s", &request)
                    .unwrap();
            let records = validate_raw_jsonl(std::str::from_utf8(&saved).unwrap(), "s").unwrap();
            let expected = records
                .iter()
                .find(|(_, r)| r["payload"]["type"] == "item_completed")
                .unwrap()
                .1["ordinal"]
                .as_i64()
                .unwrap();
            let path = db("ordinal");
            sync_thread_history_projection_databases(std::slice::from_ref(&path), "s", &plan)
                .unwrap();
            let c = Connection::open(&path).unwrap();
            let actual: i64 = c
                .query_row("SELECT rollout_ordinal FROM thread_items", [], |r| r.get(0))
                .unwrap();
            drop(c);
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
            assert_eq!(
                actual, expected,
                "SQLite ordinal must refer to canonical item_completed"
            );
        }

        #[test]
        fn duplicate_item_ids_are_scoped_to_their_turn() {
            {
                for deleted in [false, true] {
                    let session_id = dynamic_session_id();
                    let item_id = format!("item-{session_id}");
                    let mut original = vec![
                        meta(),
                        start("t1", 1),
                        response("t1", &item_id, "first", 2),
                        event("t1", &item_id, "first", 3),
                        complete("t1", "first", 4),
                        start("t2", 5),
                        response("t2", &item_id, "second", 6),
                        event("t2", &item_id, "second", 7),
                        complete("t2", "second", 8),
                    ];
                    original[0]["payload"]["id"] = json!(session_id);
                    for record in &mut original {
                        if record["payload"].get("thread_id").is_some() {
                            record["payload"]["thread_id"] = json!(session_id);
                        }
                    }
                    let mut request = req();
                    request.session_id = session_id.clone();
                    request.message_updates = Some(vec![CodexSessionMessageUpdate {
                        line_number: 6,
                        role: None,
                        content: Some("edited second".into()),
                        deleted: Some(deleted),
                    }]);
                    let (saved, plan) = build_updated_rollout(
                        &serialize_jsonl(&original, "\n").unwrap(),
                        &session_id,
                        &request,
                    )
                    .unwrap();
                    let path = db("duplicate-item-id");
                    let connection = Connection::open(&path).unwrap();
                    for (turn, text, ordinal) in [("t1", "first", 3), ("t2", "second", 7)] {
                        connection.execute(
                            "INSERT INTO thread_items VALUES (?1, ?2, ?3, ?4, 1, ?5, 'agentMessage', 0, 1, 1)",
                            rusqlite::params![session_id, turn, item_id, ordinal, json!({"type":"agentMessage","id":item_id,"text":text}).to_string()],
                        ).unwrap();
                        connection
                            .execute(
                                "INSERT INTO thread_turns VALUES (?1,?2,NULL,?3)",
                                rusqlite::params![session_id, turn, item_id],
                            )
                            .unwrap();
                    }
                    drop(connection);
                    sync_thread_history_projection_databases(
                        std::slice::from_ref(&path),
                        &session_id,
                        &plan,
                    )
                    .unwrap();
                    assert!(
                        thread_item_json_for_turn(&path, &session_id, "t1", &item_id)
                            .contains("first")
                    );
                    let connection = Connection::open(&path).unwrap();
                    let first_summary: String = connection
                        .query_row(
                            "SELECT final_agent_item_id FROM thread_turns WHERE turn_id = 't1'",
                            [],
                            |row| row.get(0),
                        )
                        .unwrap();
                    assert_eq!(first_summary, item_id);
                    if deleted {
                        let remaining: i64 = connection
                            .query_row(
                                "SELECT COUNT(*) FROM thread_items WHERE turn_id = 't2'",
                                [],
                                |row| row.get(0),
                            )
                            .unwrap();
                        assert_eq!(remaining, 0);
                    } else {
                        assert!(
                            thread_item_json_for_turn(&path, &session_id, "t2", &item_id)
                                .contains("edited second")
                        );
                        assert!(String::from_utf8(saved).unwrap().contains("edited second"));
                    }
                    drop(connection);
                    fs::remove_dir_all(path.parent().unwrap()).unwrap();
                }
            }
        }

        #[test]
        fn rewritten_rollouts_keep_all_projection_positions_in_sync() {
            {
                for explicit_ordinals in [false, true] {
                    for line_ending in ["\n", "\r\n"] {
                        for action in ["metadata", "edit", "delete", "append"] {
                            let session_id = dynamic_session_id();
                            let first_id = format!("first-{session_id}");
                            let second_id = format!("second-{session_id}");
                            let tool_id = format!("tool-{session_id}");
                            let mut original = vec![
                                meta(),
                                start("t1", 10),
                                response("t1", &first_id, "first", 20),
                                event("t1", &first_id, "first", 30),
                                complete("t1", "first", 40),
                                start("t2", 50),
                                response("t2", &second_id, "second", 60),
                                event("t2", &second_id, "second", 70),
                                complete("t2", "second", 80),
                            ];
                            original.insert(8, json!({"ordinal":75,"type":"event_msg","payload":{"type":"item_completed","turn_id":"t2","item":{"id":tool_id,"type":"ShellToolCall","status":"completed"}}}));
                            original[0]["payload"]["title"] = json!("old");
                            if !explicit_ordinals {
                                for record in &mut original {
                                    record.as_object_mut().unwrap().remove("ordinal");
                                }
                            }
                            original[0]["payload"]["id"] = json!(session_id);
                            for record in &mut original {
                                if record["payload"].get("thread_id").is_some() {
                                    record["payload"]["thread_id"] = json!(session_id);
                                }
                            }
                            let mut request = req();
                            request.session_id = session_id.clone();
                            match action {
                                "metadata" => {
                                    request.title = Some("元数据🙂: a longer title".into())
                                }
                                "edit" | "delete" => {
                                    request.message_updates =
                                        Some(vec![CodexSessionMessageUpdate {
                                            line_number: 2,
                                            role: None,
                                            content: Some("edited🙂 longer message".into()),
                                            deleted: Some(action == "delete"),
                                        }])
                                }
                                "append" => {
                                    request.new_messages = Some(vec![CodexSessionNewMessage {
                                        role: "assistant".into(),
                                        content: "added".into(),
                                    }])
                                }
                                _ => unreachable!(),
                            }
                            let (saved, plan) = build_updated_rollout(
                                &serialize_jsonl(&original, line_ending).unwrap(),
                                &session_id,
                                &request,
                            )
                            .unwrap();
                            let path = db("projection-positions");
                            let connection = Connection::open(&path).unwrap();
                            connection.execute_batch("ALTER TABLE thread_turns ADD COLUMN rollout_ordinal INTEGER; ALTER TABLE thread_turns ADD COLUMN rollout_byte_offset INTEGER; ALTER TABLE thread_turns ADD COLUMN rollout_end_ordinal INTEGER; ALTER TABLE thread_turns ADD COLUMN rollout_end_byte_offset INTEGER; CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);").unwrap();
                            connection.execute("INSERT INTO thread_history_projection_state VALUES (?1, ?2, ?3)", rusqlite::params![session_id, plan.original_projection_cursor.unwrap().byte_offset, plan.original_projection_cursor.unwrap().next_ordinal]).unwrap();
                            for (turn, id, ordinal) in
                                [("t1", &first_id, 30), ("t2", &second_id, 70)]
                            {
                                connection.execute("INSERT INTO thread_items VALUES (?1,?2,?3,?4,1,?5,'agentMessage',0,1,1)", rusqlite::params![session_id, turn, id, ordinal, json!({"type":"agentMessage","text":id}).to_string()]).unwrap();
                                connection.execute("INSERT INTO thread_turns (thread_id,turn_id,rollout_ordinal,rollout_byte_offset,rollout_end_ordinal,rollout_end_byte_offset) VALUES (?1,?2,999,999,999,999)", rusqlite::params![session_id, turn]).unwrap();
                            }
                            connection.execute("INSERT INTO thread_items VALUES (?1,'t2',?2,75,1,?3,'commandExecution',0,1,1)", rusqlite::params![session_id,tool_id,json!({"id":tool_id,"type":"commandExecution"}).to_string()]).unwrap();
                            drop(connection);
                            sync_thread_history_projection_databases(
                                std::slice::from_ref(&path),
                                &session_id,
                                &plan,
                            )
                            .unwrap();
                            let connection = Connection::open(&path).unwrap();
                            let mut last_completions = HashMap::new();
                            for (index, line) in
                                saved.split_inclusive(|byte| *byte == b'\n').enumerate()
                            {
                                let record: Value = serde_json::from_slice(line).unwrap();
                                if record["payload"]["type"] == "task_complete" {
                                    last_completions.insert(
                                        record["payload"]["turn_id"].as_str().unwrap().to_string(),
                                        index,
                                    );
                                }
                            }
                            let mut offset = 0;
                            let mut next_ordinal = 0;
                            let mut completed_items = 0;
                            for (index, line) in
                                saved.split_inclusive(|byte| *byte == b'\n').enumerate()
                            {
                                let record: Value = serde_json::from_slice(line).unwrap();
                                let ordinal = record
                                    .get("ordinal")
                                    .and_then(Value::as_i64)
                                    .unwrap_or(index as i64);
                                next_ordinal = next_ordinal.max(ordinal + 1);
                                let event_type =
                                    record["payload"]["type"].as_str().unwrap_or_default();
                                let turn =
                                    record["payload"]["turn_id"].as_str().unwrap_or_default();
                                if event_type == "task_started" {
                                    let position: (i64,i64) = connection.query_row("SELECT rollout_ordinal, rollout_byte_offset FROM thread_turns WHERE turn_id = ?1", [turn], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
                                    assert_eq!(
                                        position,
                                        (ordinal, offset),
                                        "explicit={explicit_ordinals}, action={action}"
                                    );
                                } else if event_type == "task_complete"
                                    && last_completions.get(turn) == Some(&index)
                                {
                                    let position: (i64,i64) = connection.query_row("SELECT rollout_end_ordinal, rollout_end_byte_offset FROM thread_turns WHERE turn_id = ?1", [turn], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
                                    assert_eq!(position, (ordinal, offset + line.len() as i64));
                                } else if event_type == "item_completed" {
                                    let item_id = record["payload"]["item"]["id"].as_str().unwrap();
                                    let actual: i64 = connection.query_row("SELECT rollout_ordinal FROM thread_items WHERE thread_id = ?1 AND turn_id = ?2 AND item_id = ?3", rusqlite::params![session_id, turn, item_id], |row| row.get(0)).unwrap();
                                    assert_eq!(actual, ordinal);
                                    completed_items += 1;
                                }
                                offset += line.len() as i64;
                            }
                            let cursor: (i64,i64) = connection.query_row("SELECT next_rollout_byte_offset, next_rollout_ordinal FROM thread_history_projection_state", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
                            assert_eq!(cursor, (saved.len() as i64, next_ordinal));
                            let count: i64 = connection
                                .query_row("SELECT COUNT(*) FROM thread_items", [], |row| {
                                    row.get(0)
                                })
                                .unwrap();
                            assert_eq!(count, completed_items);
                            drop(connection);
                            fs::remove_dir_all(path.parent().unwrap()).unwrap();
                        }
                    }
                }
            }
        }

        #[test]
        fn open_and_interrupted_turn_positions_are_synchronized() {
            for terminal in [None, Some("turn_aborted")] {
                let session_id = dynamic_session_id();
                let mut records = vec![
                    json!({"type":"session_meta","payload":{"id":session_id}}),
                    start("t1", 10),
                ];
                if let Some(event_type) = terminal {
                    records.push(json!({"ordinal":20,"type":"event_msg","payload":{"type":event_type,"turn_id":"t1"}}));
                }
                let mut request = req();
                request.title = Some("a longer title🙂".into());
                let (saved, plan) = build_updated_rollout(
                    &serialize_jsonl(&records, "\r\n").unwrap(),
                    &session_id,
                    &request,
                )
                .unwrap();
                let path = db("turn-terminal-positions");
                let connection = Connection::open(&path).unwrap();
                connection.execute_batch("ALTER TABLE thread_turns ADD COLUMN rollout_byte_offset INTEGER; ALTER TABLE thread_turns ADD COLUMN rollout_end_ordinal INTEGER; ALTER TABLE thread_turns ADD COLUMN rollout_end_byte_offset INTEGER;").unwrap();
                connection.execute("INSERT INTO thread_turns (thread_id,turn_id,rollout_byte_offset,rollout_end_ordinal,rollout_end_byte_offset) VALUES (?1,'t1',999,999,999)", [&session_id]).unwrap();
                drop(connection);
                sync_thread_history_projection_databases(
                    std::slice::from_ref(&path),
                    &session_id,
                    &plan,
                )
                .unwrap();
                let connection = Connection::open(&path).unwrap();
                let position: (i64,Option<i64>,Option<i64>) = connection.query_row("SELECT rollout_byte_offset,rollout_end_ordinal,rollout_end_byte_offset FROM thread_turns", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
                let first_line_len = saved
                    .split_inclusive(|byte| *byte == b'\n')
                    .next()
                    .unwrap()
                    .len() as i64;
                assert_eq!(position.0, first_line_len);
                assert_eq!(position.1, terminal.map(|_| 20));
                assert_eq!(position.2, terminal.map(|_| saved.len() as i64));
                drop(connection);
                fs::remove_dir_all(path.parent().unwrap()).unwrap();
            }
        }

        #[test]
        fn sqlite_user_edit_preserves_non_text_content_parts() {
            let image = json!({"type":"image","url":"fixture-image"});
            let audio = json!({"type":"audio","data":"fixture-audio"});
            for content in [
                json!([{"type":"text","text":"old"},image.clone(),audio.clone()]),
                json!([image.clone(),{"type":"text","text":"first"},{"type":"text","text":"second"},audio.clone()]),
                json!([image.clone(), audio.clone()]),
            ] {
                {
                    let session_id = dynamic_session_id();
                    let path = db("user-mixed-content");
                    let connection = Connection::open(&path).unwrap();
                    connection.execute("INSERT INTO thread_items VALUES (?1,'t1','user-1',2,1,?2,'userMessage',0,1,1)", rusqlite::params![session_id, json!({"type":"userMessage","id":"user-1","clientId":"keep","content":content}).to_string()]).unwrap();
                    drop(connection);
                    let plan = RolloutSyncPlan {
                        updated_items: vec![RolloutItemSync {
                            item_id: "user-1".into(),
                            turn_id: "t1".into(),
                            item_type: "userMessage".into(),
                            text: "new text🙂".into(),
                        }],
                        ..Default::default()
                    };
                    sync_thread_history_projection_databases(
                        std::slice::from_ref(&path),
                        &session_id,
                        &plan,
                    )
                    .unwrap();
                    let item: Value = serde_json::from_str(&thread_item_json_for_turn(
                        &path,
                        &session_id,
                        "t1",
                        "user-1",
                    ))
                    .unwrap();
                    assert_eq!(extract_content_text(&item["content"]), "new text🙂");
                    let non_text = item["content"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|part| part.get("text").is_none())
                        .cloned()
                        .collect::<Vec<_>>();
                    assert_eq!(non_text, vec![image.clone(), audio.clone()]);
                    assert_eq!(item["clientId"], "keep");
                    let text_part = item["content"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|part| part.get("text").is_some())
                        .unwrap();
                    assert_eq!(text_part["type"], "text");
                    fs::remove_dir_all(path.parent().unwrap()).unwrap();
                }
            }
        }

        #[test]
        fn partial_assistant_edits_and_deletions_recompute_retained_summaries() {
            let original = vec![
                meta(),
                start("t1", 1),
                response("t1", "a1", "A", 2),
                event("t1", "a1", "A", 3),
                response("t1", "a2", "B", 4),
                event("t1", "a2", "B", 5),
                complete("t1", "B", 6),
                start("t2", 7),
                response("t2", "a3", "C", 8),
                event("t2", "a3", "C", 9),
                complete("t2", "C", 10),
            ];
            for (lines, deleted, expected) in [
                (vec![2], false, json!("B")),
                (vec![4], false, json!("Edited")),
                (vec![2], true, json!("B")),
                (vec![4], true, json!("A")),
                (vec![2, 4], true, Value::Null),
            ] {
                {
                    let mut request = req();
                    request.message_updates = Some(
                        lines
                            .iter()
                            .map(|line| CodexSessionMessageUpdate {
                                line_number: *line,
                                role: None,
                                content: Some("Edited".into()),
                                deleted: Some(deleted),
                            })
                            .collect(),
                    );
                    let (saved, _) = build_updated_rollout(
                        &serialize_jsonl(&original, "\n").unwrap(),
                        "s",
                        &request,
                    )
                    .unwrap();
                    let records =
                        validate_raw_jsonl(std::str::from_utf8(&saved).unwrap(), "s").unwrap();
                    for (turn, text) in [("t1", expected.clone()), ("t2", json!("C"))] {
                        let completion = records
                            .iter()
                            .find(|(_, record)| {
                                record["payload"]["type"] == "task_complete"
                                    && record["payload"]["turn_id"] == turn
                            })
                            .unwrap();
                        assert_eq!(
                            completion.1["payload"]["last_agent_message"], text,
                            "deleted={deleted}, lines={lines:?}"
                        );
                    }
                }
            }
        }

        #[test]
        fn appended_item_ordinals_use_canonical_events_after_stamping() {
            for explicit_ordinals in [false, true] {
                {
                    let mut original = vec![meta(), start("t1", 1)];
                    if explicit_ordinals {
                        original[1]["ordinal"] = json!(40);
                    } else {
                        for record in &mut original {
                            record.as_object_mut().unwrap().remove("ordinal");
                        }
                    }
                    let mut request = req();
                    request.new_messages = Some(vec![
                        CodexSessionNewMessage {
                            role: "user".into(),
                            content: "new".into(),
                        },
                        CodexSessionNewMessage {
                            role: "assistant".into(),
                            content: "answer".into(),
                        },
                    ]);
                    let (saved, plan) = build_updated_rollout(
                        &serialize_jsonl(&original, "\n").unwrap(),
                        "s",
                        &request,
                    )
                    .unwrap();
                    let records =
                        validate_raw_jsonl(std::str::from_utf8(&saved).unwrap(), "s").unwrap();
                    let path = db("canonical-ordinals");
                    sync_thread_history_projection_databases(
                        std::slice::from_ref(&path),
                        "s",
                        &plan,
                    )
                    .unwrap();
                    let connection = Connection::open(&path).unwrap();
                    for item in &plan.new_items {
                        let (position, record) = records
                            .iter()
                            .find(|(_, record)| record["payload"]["item"]["id"] == item.item_id)
                            .unwrap();
                        let expected = record
                            .get("ordinal")
                            .and_then(Value::as_i64)
                            .unwrap_or(*position as i64);
                        let actual: i64 = connection
                            .query_row(
                                "SELECT rollout_ordinal FROM thread_items WHERE item_id = ?1",
                                [&item.item_id],
                                |row| row.get(0),
                            )
                            .unwrap();
                        assert_eq!(actual, expected, "explicit={explicit_ordinals}");
                        assert!(expected < plan.projection_cursor.unwrap().next_ordinal);
                    }
                    drop(connection);
                    std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
                }
            }
        }
        #[test]
        fn deleted_summary_items_follow_official_phase_and_status_rules() {
            for status in ["completed", "interrupted", "failed", "inProgress", "legacy"] {
                for phase in [
                    None,
                    Some("final_answer"),
                    Some("commentary"),
                    Some("absent"),
                ] {
                    for earlier_final in [false, true] {
                        let path = db("summary-selection");
                        let c = Connection::open(&path).unwrap();
                        if status != "legacy" {
                            c.execute_batch("ALTER TABLE thread_turns ADD COLUMN status TEXT")
                                .unwrap();
                        }
                        c.execute("INSERT INTO thread_turns (thread_id,turn_id,first_user_item_id,final_agent_item_id) VALUES ('s','t1','gone-user','gone-agent'),('s','other','sentinel','sentinel'),('other','t1','sentinel','sentinel')", []).unwrap();
                        if status != "legacy" {
                            c.execute("UPDATE thread_turns SET status=?1", [status])
                                .unwrap();
                        }
                        let mut items = vec![
                            ("gone-user", 0, "userMessage", None),
                            ("user-first", 10, "userMessage", None),
                            ("user-second", 20, "userMessage", None),
                            ("gone-agent", 50, "agentMessage", Some("final_answer")),
                        ];
                        if earlier_final {
                            items.push(("earlier-final", 30, "agentMessage", Some("final_answer")));
                        }
                        if phase != Some("absent") {
                            items.push(("retained-agent", 40, "agentMessage", phase));
                        }
                        for (id, ordinal, kind, phase) in items {
                            c.execute(
                                "INSERT INTO thread_items VALUES ('s','t1',?1,?2,1,?3,?4,0,1,1)",
                                rusqlite::params![
                                    id,
                                    ordinal,
                                    json!({"id":id,"type":kind,"phase":phase}).to_string(),
                                    kind
                                ],
                            )
                            .unwrap();
                        }
                        drop(c);
                        let plan = RolloutSyncPlan {
                            deleted_item_keys: vec![
                                ("gone-user".into(), "t1".into()),
                                ("gone-agent".into(), "t1".into()),
                            ]
                            .into_iter()
                            .collect(),
                            ..Default::default()
                        };
                        sync_thread_history_projection_databases(
                            std::slice::from_ref(&path),
                            "s",
                            &plan,
                        )
                        .unwrap();
                        let c = Connection::open(&path).unwrap();
                        let actual: (Option<String>,Option<String>) = c.query_row("SELECT first_user_item_id,final_agent_item_id FROM thread_turns WHERE thread_id='s' AND turn_id='t1'",[],|r| Ok((r.get(0)?,r.get(1)?))).unwrap();
                        let expected = if phase == Some("final_answer") {
                            Some("retained-agent")
                        } else if earlier_final {
                            Some("earlier-final")
                        } else if phase.is_none() && status != "inProgress" {
                            Some("retained-agent")
                        } else {
                            None
                        };
                        assert_eq!(actual.0.as_deref(), Some("user-first"));
                        assert_eq!(
                            actual.1.as_deref(),
                            expected,
                            "status={status}, phase={phase:?}, earlier_final={earlier_final}"
                        );
                        let untouched: i64 = c.query_row("SELECT COUNT(*) FROM thread_turns WHERE final_agent_item_id='sentinel' AND first_user_item_id='sentinel'",[],|r|r.get(0)).unwrap();
                        assert_eq!(untouched, 2);
                        drop(c);
                        fs::remove_dir_all(path.parent().unwrap()).unwrap();
                    }
                }
            }
        }
    }

    #[derive(Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    enum CanonicalUserInput {
        Text {
            text: String,
            #[serde(default)]
            text_elements: Vec<Value>,
        },
    }

    fn canonical_user_records(id: &str) -> Vec<Value> {
        vec![
            json!({"type":"session_meta","payload":{"id":id}}),
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"old"}]}}),
            json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"turn","item":{"type":"UserMessage","id":"user","content":[{"type":"text","text":"old","text_elements":[]}]}}}),
        ]
    }

    #[test]
    fn regression_user_edit_retains_official_event_schema() {
        for newline in ["\n", "\r\n"] {
            for text in ["edited", "中文🙂\nsecond line"] {
                let id = dynamic_session_id();
                let mut original = canonical_user_records(&id);
                // Different text representations require an explicit shared identity.
                original[2]["metadata"] = json!({"retained_source":{"id":{"message_id":"user","turn_id":"turn"}}});
                let image = json!({"type":"image","image_url":"https://example.invalid/image.png"});
                original[3]["payload"]["item"]["content"] = json!([
                    {"type":"text","text":"old","text_elements":[{"byte_range":{"start":0,"end":3}}]},
                    image,
                    {"type":"text","text":"other","text_elements":[]}
                ]);
                let mut request = empty_context_request(id.clone(), None);
                request.message_updates = Some(vec![CodexSessionMessageUpdate {
                    line_number: 2,
                    role: None,
                    content: Some(text.into()),
                    deleted: None,
                }]);
                let (saved, _) = build_updated_rollout(
                    &serialize_jsonl(&original, newline).unwrap(),
                    &id,
                    &request,
                )
                .unwrap();
                let records =
                    validate_raw_jsonl(std::str::from_utf8(&saved).unwrap(), &id).unwrap();
                let content = &records[3].1["payload"]["item"]["content"];
                let CanonicalUserInput::Text {
                    text: actual,
                    text_elements,
                } = serde_json::from_value(content[0].clone()).unwrap();
                assert_eq!(actual, text);
                assert!(text_elements.is_empty());
                assert_eq!(content[1], image);
                assert_eq!(content.as_array().unwrap().len(), 2);
                assert_eq!(records[2].1["payload"]["content"][0]["type"], "input_text");
                assert_eq!(records[2].1["payload"]["content"][0]["text"], text);
            }
        }
    }

    #[test]
    fn regression_appended_user_uses_official_event_schema() {
        for role in ["user", "assistant"] {
            let id = dynamic_session_id();
            let mut request = empty_context_request(id.clone(), None);
            request.new_messages = Some(vec![CodexSessionNewMessage {
                role: role.into(),
                content: "new🙂".into(),
            }]);
            let (saved, _) = build_updated_rollout(
                &serialize_jsonl(&canonical_user_records(&id), "\n").unwrap(),
                &id,
                &request,
            )
            .unwrap();
            let records = validate_raw_jsonl(std::str::from_utf8(&saved).unwrap(), &id).unwrap();
            let content = &records
                .iter()
                .rev()
                .find(|(_, record)| record["payload"]["type"] == "item_completed")
                .unwrap()
                .1["payload"]["item"]["content"];
            assert_eq!(content[0]["text"], "new🙂");
            if role == "user" {
                assert!(serde_json::from_value::<Vec<CanonicalUserInput>>(content.clone()).is_ok());
            } else {
                assert_eq!(content[0]["type"], "Text");
            }
        }
    }

    #[test]
    fn regression_reasoning_edit_updates_official_event_fields() {
        let root = test_root("audit-real-reasoning");
        let id = dynamic_session_id();
        let fixture = seed_context_edit_fixture(&root, &id);
        let context = get_codex_session_context_from_home(&root, &id).unwrap();
        let mut request = context_save_request(&context);
        request.message_updates = Some(vec![CodexSessionMessageUpdate {
            line_number: 4,
            role: None,
            content: Some("Edited thoughts".into()),
            deleted: None,
        }]);
        save_codex_session_context_from_home(&root, request).unwrap();
        let saved =
            validate_raw_jsonl(&fs::read_to_string(&fixture.rollout).unwrap(), &id).unwrap();
        let actual = saved[5].1["payload"]["item"]["summary_text"].clone();
        assert_eq!(saved[5].1["payload"]["item"]["raw_content"], json!([]));
        assert!(saved[5].1["payload"]["item"].get("signature").is_none());
        let projected: Value = serde_json::from_str(&thread_item_json(
            &fixture.history_db,
            &id,
            fixture.reasoning_item_id,
        ))
        .unwrap();
        assert_eq!(projected["summary"], json!(["Edited thoughts"]));
        assert_eq!(projected["content"], json!([]));
        fs::remove_dir_all(root).unwrap();
        assert_eq!(
            actual,
            json!(["Edited thoughts"]),
            "Canonical Reasoning retains stale summary_text"
        );
    }

    #[test]
    fn regression_metadata_save_does_not_skip_unmaterialized_history() {
        let root = test_root("audit-incomplete-projection");
        let id = dynamic_session_id();
        let fixture = seed_context_edit_fixture(&root, &id);
        let connection = Connection::open(&fixture.history_db).unwrap();
        connection
            .execute("DELETE FROM thread_items WHERE thread_id=?1", [&id])
            .unwrap();
        connection.execute("UPDATE thread_history_projection_state SET next_rollout_byte_offset=0,next_rollout_ordinal=0 WHERE thread_id=?1", [&id]).unwrap();
        drop(connection);
        let context = get_codex_session_context_from_home(&root, &id).unwrap();
        let mut request = context_save_request(&context);
        request.title = Some("Renamed".into());
        let original = fs::read(&fixture.rollout).unwrap();
        let original_state = fs::read(&fixture.state_db).unwrap();
        let result = save_codex_session_context_from_home(&root, request);
        assert_eq!(fs::read(&fixture.rollout).unwrap(), original);
        assert_eq!(fs::read(&fixture.state_db).unwrap(), original_state);
        let connection = Connection::open(&fixture.history_db).unwrap();
        let cursor:i64 = connection.query_row("SELECT next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id=?1", [&id], |row| row.get(0)).unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM thread_items WHERE thread_id=?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        fs::remove_dir_all(root).unwrap();
        assert!(result
            .unwrap_err()
            .contains("projection is incomplete or stale"));
        assert_eq!(cursor, 0);
        assert_eq!(count, 0);
    }

    #[test]
    fn regression_deleting_final_assistant_restores_previous_sqlite_summary() {
        let root = test_root("audit-final-agent-summary");
        let id = dynamic_session_id();
        let fixture = seed_context_edit_fixture(&root, &id);
        let mut records = validate_raw_jsonl(&fs::read_to_string(&fixture.rollout).unwrap(), &id)
            .unwrap()
            .into_iter()
            .map(|(_, r)| r)
            .collect::<Vec<_>>();
        let mut second_response = records[6].clone();
        second_response["ordinal"] = json!(8);
        second_response["metadata"]["retained_source"]["id"]["message_id"] = json!("second");
        second_response["payload"]["content"][0]["text"] = json!("Second answer");
        let mut second_event = records[7].clone();
        second_event["ordinal"] = json!(9);
        second_event["payload"]["item"]["id"] = json!("second");
        second_event["payload"]["item"]["content"][0]["text"] = json!("Second answer");
        records[8]["ordinal"] = json!(10);
        records[8]["payload"]["last_agent_message"] = json!("Second answer");
        records.splice(8..8, [second_response, second_event]);
        let original = serialize_jsonl(&records, "\n").unwrap();
        fs::write(&fixture.rollout, &original).unwrap();
        let connection = Connection::open(&fixture.history_db).unwrap();
        connection.execute("INSERT INTO thread_items VALUES (?1,'turn-fixture','second',9,1500,?2,'agentMessage',0,1500,1500)",rusqlite::params![id,json!({"type":"agentMessage","id":"second","text":"Second answer"}).to_string()]).unwrap();
        connection.execute("INSERT INTO thread_turns (thread_id,turn_id,rollout_ordinal,status,final_agent_item_id) VALUES (?1,'turn-fixture',1,'completed','second')",[&id]).unwrap();
        connection.execute("UPDATE thread_history_projection_state SET next_rollout_byte_offset=?1,next_rollout_ordinal=11 WHERE thread_id=?2",rusqlite::params![original.len() as i64,id]).unwrap();
        drop(connection);
        let context = get_codex_session_context_from_home(&root, &id).unwrap();
        let mut request = context_save_request(&context);
        request.message_updates = Some(vec![CodexSessionMessageUpdate {
            line_number: 8,
            role: None,
            content: None,
            deleted: Some(true),
        }]);
        save_codex_session_context_from_home(&root, request).unwrap();
        let connection = Connection::open(&fixture.history_db).unwrap();
        let final_id: Option<String> = connection
            .query_row(
                "SELECT final_agent_item_id FROM thread_turns WHERE thread_id=?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        drop(connection);
        fs::remove_dir_all(root).unwrap();
        assert_eq!(final_id.as_deref(),Some(fixture.agent_item_id),"SQLite drops final agent reference while rollout completion still summarizes the preceding answer");
    }

    #[test]
    fn regression_index_rewrite_preserves_other_thread_append_handle() {
        use std::io::Write;
        let root = test_root("audit-index-open-handle");
        fs::create_dir_all(&root).unwrap();
        let id = dynamic_session_id();
        let index = root.join("session_index.jsonl");
        fs::write(
            &index,
            format!("{}\n", json!({"id":id,"thread_name":"old"})),
        )
        .unwrap();
        let update = build_session_index_title_update(&root, &id, "renamed")
            .unwrap()
            .unwrap();
        // Official Codex opens an append handle before serializing and writing
        // a name update. Pause that writer across the editor's append.
        let mut other_writer = OpenOptions::new().append(true).open(&index).unwrap();
        let result = apply_session_index_title_update(&update);
        let other_id = dynamic_session_id();
        writeln!(
            other_writer,
            "{}",
            json!({"id":other_id,"thread_name":"other session"})
        )
        .unwrap();
        other_writer.flush().unwrap();
        drop(other_writer);
        let current = fs::read_to_string(&index).unwrap();
        fs::remove_dir_all(root).unwrap();
        result.unwrap();
        assert!(
            current.contains(&other_id),
            "Index loses another thread's successful append: {current}"
        );
        assert_eq!(
            latest_session_index_entry(current.as_bytes(), &id)
                .unwrap()
                .unwrap()["thread_name"],
            "renamed"
        );
    }
    #[test]
    fn reasoning_fields_read_and_rewrite_canonical_and_response_shapes() {
        for (value, expected) in [
            (
                json!({"summary_text":["a","b"],"raw_content":["raw"]}),
                "a\nb",
            ),
            (json!({"summary_text":[],"raw_content":["raw"]}), "raw"),
            (
                json!({"summary":[{"type":"summary_text","text":"summary"}],"content":[]}),
                "summary",
            ),
            (
                json!({"summary":[],"content":[{"type":"text","text":"content"}]}),
                "content",
            ),
        ] {
            assert_eq!(extract_reasoning_text(&value), expected);
            let mut item = value.as_object().unwrap().clone();
            item.insert("id".into(), json!("r"));
            rewrite_event_item_text(&mut item, TrackedItemKind::Reasoning, "edited🙂");
            assert_eq!(item["summary_text"], json!(["edited🙂"]));
            assert_eq!(item["raw_content"], json!([]));
            assert_eq!(item["id"], "r");
        }
    }

    #[test]
    fn projection_preflight_covers_save_actions_and_cursor_states() {
        for action in ["metadata", "edit", "delete", "append"] {
            for state in [
                "complete",
                "partial",
                "wrong-bytes",
                "wrong-ordinal",
                "past-eof",
                "missing",
            ] {
                let root = test_root("projection-preflight");
                let id = dynamic_session_id();
                let fixture = seed_context_edit_fixture(&root, &id);
                let original = fs::read(&fixture.rollout).unwrap();
                let c = Connection::open(&fixture.history_db).unwrap();
                match state {
                    "partial" => {
                        c.execute("UPDATE thread_history_projection_state SET next_rollout_byte_offset=0,next_rollout_ordinal=0",[]).unwrap();
                    }
                    "wrong-bytes" => {
                        c.execute(
                            "UPDATE thread_history_projection_state SET next_rollout_byte_offset=0",
                            [],
                        )
                        .unwrap();
                    }
                    "wrong-ordinal" => {
                        c.execute(
                            "UPDATE thread_history_projection_state SET next_rollout_ordinal=0",
                            [],
                        )
                        .unwrap();
                    }
                    "past-eof" => {
                        c.execute("UPDATE thread_history_projection_state SET next_rollout_byte_offset=next_rollout_byte_offset+1",[]).unwrap();
                    }
                    "missing" => {
                        c.execute("DELETE FROM thread_history_projection_state", [])
                            .unwrap();
                    }
                    _ => {}
                }
                drop(c);
                let before_history = fs::read(&fixture.history_db).unwrap();
                let before_state = fs::read(&fixture.state_db).unwrap();
                let context = get_codex_session_context_from_home(&root, &id).unwrap();
                let mut request = context_save_request(&context);
                match action {
                    "metadata" => request.title = Some("Renamed🙂".into()),
                    "append" => {
                        request.new_messages = Some(vec![CodexSessionNewMessage {
                            role: "user".into(),
                            content: "new🙂".into(),
                        }])
                    }
                    _ => {
                        request.message_updates = Some(vec![CodexSessionMessageUpdate {
                            line_number: assistant_line_number(&context),
                            role: None,
                            content: Some("edited🙂".into()),
                            deleted: Some(action == "delete"),
                        }])
                    }
                }
                let result = save_codex_session_context_from_home(&root, request);
                if state == "complete" || state == "missing" {
                    result.unwrap();
                    let c = Connection::open(&fixture.history_db).unwrap();
                    let cursor: Option<i64> = c
                        .query_row(
                            "SELECT next_rollout_byte_offset FROM thread_history_projection_state",
                            [],
                            |r| r.get(0),
                        )
                        .optional()
                        .unwrap();
                    assert_eq!(
                        cursor,
                        if state == "missing" {
                            None
                        } else {
                            Some(fs::metadata(&fixture.rollout).unwrap().len() as i64)
                        }
                    );
                } else {
                    assert!(result
                        .unwrap_err()
                        .contains("projection is incomplete or stale"));
                    assert_eq!(fs::read(&fixture.rollout).unwrap(), original);
                    assert_eq!(fs::read(&fixture.history_db).unwrap(), before_history);
                    assert_eq!(fs::read(&fixture.state_db).unwrap(), before_state);
                }
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn session_index_uses_latest_record_and_rejects_unterminated_append() {
        let root = test_root("index-latest");
        let id = dynamic_session_id();
        let path = root.join("session_index.jsonl");
        let original = format!(
            "{}\n{}\n",
            json!({"id":id,"thread_name":"first"}),
            json!({"id":id,"thread_name":"latest"})
        );
        fs::write(&path, &original).unwrap();
        assert!(build_session_index_title_update(&root, &id, "latest")
            .unwrap()
            .is_none());
        let update = build_session_index_title_update(&root, &id, "new")
            .unwrap()
            .unwrap();
        assert_eq!(update.previous["thread_name"], "latest");
        apply_session_index_title_update(&update).unwrap();
        restore_session_index(&update).unwrap();
        assert_eq!(
            latest_session_index_entry(&fs::read(&path).unwrap(), &id)
                .unwrap()
                .unwrap()["thread_name"],
            "latest"
        );
        fs::write(&path, original.trim_end()).unwrap();
        let update = build_session_index_title_update(&root, &id, "new")
            .unwrap()
            .unwrap();
        assert!(apply_session_index_title_update(&update)
            .unwrap_err()
            .contains("unterminated"));
        assert_eq!(fs::read_to_string(&path).unwrap(), original.trim_end());
        fs::remove_dir_all(root).unwrap();
    }
