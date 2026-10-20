    use super::*;

    #[test]
    fn empty_remote_queue_polling_backs_off_to_a_cap() {
        let mut seconds = REMOTE_EMPTY_POLL_MIN_SECONDS;
        let mut waits = Vec::new();
        for _ in 0..7 {
            waits.push(seconds);
            seconds = next_empty_remote_poll_seconds(seconds);
        }
        assert_eq!(waits, [2, 4, 8, 16, 30, 30, 30]);
    }

    fn load_usage_events(
        connection: &Connection,
        query: &UsageQuery,
        config: &GuiConfigFile,
    ) -> Result<UsageEventPage, String> {
        load_usage_events_with_notes(connection, query, config, &HashMap::new())
    }

    #[test]
    fn agent_classification_uses_only_verified_product_tokens() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute("CREATE TABLE usage_events (user_agent TEXT)", []).unwrap();
        let cases = [
            (Some("codex_cli_rs/0.77.0 (Linux 6.8; x86_64) terminal/1.0"), "codex"),
            (Some("claude-cli/2.1.0 (external, cli)"), "claude-code"),
            (Some("GeminiCLI/0.1.0/gemini-2.5-pro (linux; x64; terminal)"), "gemini-cli"),
            (None, "unknown"), (Some(""), "unknown"),
            (Some("python-httpx/0.28.1"), "unknown"),
            (Some("my-codex-proxy/1.0"), "unknown"),
            (Some("Mozilla/5.0 codex_cli_rs/0.77.0 (Linux)"), "unknown"),
            (Some("codex_cli_rs/"), "unknown"),
            (Some("codex_cli_rs/not-a-version (Linux)"), "unknown"),
            (Some("codex_cli_rs/1abc (Linux)"), "unknown"),
            (Some("codex_cli_rs/1.2.3 (Linux) GeminiCLI/1.0/model (x)"), "unknown"),
            (Some("claude-cli/2.1.0 (external, cli) custom"), "unknown"),
            (Some("GeminiCLI/1abc/model (linux)"), "unknown"),
            (Some("Codex/1.0"), "unknown"),
            (Some("claude-cli/2.1.0 (external, sdk-ts, agent-sdk/0.1)"), "unknown"),
            (Some("GeminiCLI-custom/1.0/model (linux; x64; terminal)"), "unknown"),
            (Some("OpenAI/JS 4.0"), "unknown"),
        ];
        for (ua, expected) in cases {
            connection.execute("DELETE FROM usage_events", []).unwrap();
            connection.execute("INSERT INTO usage_events VALUES (?1)", [ua]).unwrap();
            let actual: String = connection.query_row(
                &format!("SELECT {USAGE_AGENT_SQL} FROM usage_events"), [], |row| row.get(0),
            ).unwrap();
            assert_eq!(actual, expected, "User-Agent: {ua:?}");
        }
    }

    #[test]
    fn agent_filter_precedes_counts_pagination_export_and_aggregates() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_usage_schema(&connection).unwrap();
        let identities = [Some("codex_cli_rs/0.77.0 (Linux; x86_64)"),
            Some("claude-cli/2.1.0 (external, cli)"),
            Some("GeminiCLI/0.1.0/model (linux; x64; terminal)"), None,
            Some("custom-codex/1"), Some("claude-cli/2.1.0 (external, cli)"), None];
        let records: Vec<_> = identities.iter().enumerate().map(|(index, ua)| {
            let mut record = sample_record(&format!("agent-{index}"), "2026-08-28T00:00:00Z", "same-model");
            record.provider = "codex".to_string();
            record.endpoint = "/v1/responses".to_string();
            record.user_agent = ua.map(str::to_string);
            record
        }).collect();
        insert_usage_records(&mut connection, &records).unwrap();
        let config = GuiConfigFile::default();
        for (agent, expected) in [("codex", 1), ("claude-code", 2), ("gemini-cli", 1), ("unknown", 3), ("invalid", 0)] {
            let query = UsageQuery { agent: Some(agent.to_string()), page_size: Some(1), ..Default::default() };
            let first = load_usage_events(&connection, &query, &config).unwrap();
            assert_eq!(first.total, expected);
            assert_eq!(first.total_pages, expected.max(1));
            let mut ids = std::collections::HashSet::new();
            for page in 1..=first.total_pages {
                let result = load_usage_events(&connection, &UsageQuery { page: Some(page), ..query.clone() }, &config).unwrap();
                for item in result.items {
                    assert_eq!(item.agent, agent);
                    let json = serde_json::to_value(&item).unwrap();
                    assert_eq!(json["agent"], agent);
                    assert!(json.get("user_agent").is_none());
                    assert!(ids.insert(item.id));
                }
            }
            assert_eq!(ids.len(), expected);
            // CSV uses the same paged event command with a larger page size.
            let export = load_usage_events(&connection, &UsageQuery { page_size: Some(5000), ..query.clone() }, &config).unwrap();
            assert_eq!(export.items.len(), expected);
            assert_eq!(load_usage_overview(&connection, &query).unwrap().total_requests, expected as u64);
            assert_eq!(load_usage_pricing(&connection, &query).unwrap().total_requests, expected as u64);
            assert_eq!(load_usage_analysis(&connection, &query, &config).unwrap().models.iter().map(|item| item.requests).sum::<u64>(), expected as u64);
        }
        let imported: UsageRecord = serde_json::from_value(serde_json::json!({
            "id": "imported", "timestamp": "2026-08-28T00:00:00Z", "agent": "codex",
            "user_agent": "claude-cli/2.1.0 (external, cli)"
        })).unwrap();
        assert!(imported.agent.is_empty());
        insert_usage_records(&mut connection, &[imported]).unwrap();
        let page = load_usage_events(&connection, &UsageQuery { agent: Some("claude-code".into()), ..Default::default() }, &config).unwrap();
        assert_eq!(page.total, 3);
    }

    #[tokio::test]
    async fn redis_usage_queue_falls_back_to_legacy_key_and_reuses_selection() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let legacy_message = r#"{"request_id":"legacy"}"#;
        let expectations = vec![
            (
                USAGE_QUEUE_KEY.to_string(),
                "-ERR unsupported channel 'usage'\r\n".to_string(),
            ),
            (LEGACY_USAGE_QUEUE_KEY.to_string(), "*0\r\n".to_string()),
            (
                LEGACY_USAGE_QUEUE_KEY.to_string(),
                format!("*1\r\n${}\r\n{legacy_message}\r\n", legacy_message.len()),
            ),
        ];
        let server = tokio::spawn(async move {
            for (queue_key, response) in expectations {
                let (mut stream, _) = listener.accept().await.unwrap();
                let expected_auth = b"*2\r\n$4\r\nAUTH\r\n$6\r\nsecret\r\n";
                let mut auth = vec![0_u8; expected_auth.len()];
                stream.read_exact(&mut auth).await.unwrap();
                assert_eq!(auth, expected_auth);
                stream.write_all(b"+OK\r\n").await.unwrap();

                let batch_size = USAGE_QUEUE_BATCH_SIZE.to_string();
                let expected_pop = format!(
                    "*3\r\n$4\r\nLPOP\r\n${}\r\n{queue_key}\r\n${}\r\n{batch_size}\r\n",
                    queue_key.len(),
                    batch_size.len()
                );
                let mut pop = vec![0_u8; expected_pop.len()];
                stream.read_exact(&mut pop).await.unwrap();
                assert_eq!(pop, expected_pop.as_bytes());
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let config = GuiConfigFile {
            port,
            management_secret_key: "secret".to_string(),
            ..Default::default()
        };
        let mut source = RedisUsageQueueSource::default();

        let first = source.pull(&config).await.unwrap();
        assert_eq!(first.source, "redis_pull:queue");
        assert!(first.messages.is_empty());

        let second = source.pull(&config).await.unwrap();
        assert_eq!(second.source, "redis_pull:queue");
        assert_eq!(second.messages, vec![legacy_message]);
        server.await.unwrap();
    }

    #[test]
    fn redis_usage_queue_only_falls_back_for_unsupported_key_errors() {
        assert!(redis_pull_can_try_legacy_queue(
            "ERR unsupported channel 'usage'"
        ));
        assert!(redis_pull_can_try_legacy_queue(
            "ERR unsupported queue 'usage'"
        ));
        assert!(!redis_pull_can_try_legacy_queue("CPA usage subscription authentication failed"));
        assert!(!redis_pull_can_try_legacy_queue("connection refused"));
    }

    #[tokio::test]
    async fn background_usage_jobs_limit_database_concurrency() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut jobs = Vec::new();
        for index in 0..6 {
            let active = active.clone();
            let peak = peak.clone();
            jobs.push(tokio::spawn(run_usage_task(move || {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(10));
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(index)
            })));
        }
        for (index, job) in jobs.into_iter().enumerate() {
            assert_eq!(job.await.unwrap().unwrap(), index);
        }
        assert!(peak.load(Ordering::SeqCst) <= 2);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn single_scan_analysis_matches_independent_categories_for_mixed_data_and_filters() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_usage_schema(&connection).unwrap();
        let records: Vec<_> = (0..600)
            .map(|index| {
                let mut record = sample_record(
                    &format!("analysis-{index}"),
                    if index % 2 == 0 {
                        "2026-08-27T00:00:00Z"
                    } else {
                        "2026-08-28T00:00:00Z"
                    },
                    [" Model-A ", "model-a", "", "unknown", "Model-B"][index % 5],
                );
                record.alias = ["", " model-alias ", ""][index % 3].to_string();
                record.provider = ["openai", "claude", " "][index % 3].to_string();
                record.source =
                    ["source-a", " ", "source-b", "sk-secret-source"][index % 4].to_string();
                record.api_key_hash = ["hash-a", "hash-b", " "][index % 3].to_string();
                record.api_key_remark = ["", " alpha ", "zeta", "Test note"][index % 4].to_string();
                record.api_key_display = ["", "ab••••", "xy••••"][index % 3].to_string();
                record.failed = index % 3 == 0;
                record.canceled = index % 6 == 0;
                record.tokens.total_tokens = (index % 17) as u64;
                record
            })
            .collect();
        insert_usage_records(&mut connection, &records).unwrap();
        let config = GuiConfigFile::default();
        let queries = [
            UsageQuery::default(),
            UsageQuery {
                model: Some("MODEL-A".into()),
                ..UsageQuery::default()
            },
            UsageQuery {
                provider: Some("claude".into()),
                ..UsageQuery::default()
            },
            UsageQuery {
                source: Some("source-a".into()),
                ..UsageQuery::default()
            },
            UsageQuery {
                api_key_hash: Some("hash-a".into()),
                ..UsageQuery::default()
            },
            UsageQuery {
                failed: Some(true),
                canceled: Some(false),
                ..UsageQuery::default()
            },
            UsageQuery {
                canceled: Some(true),
                ..UsageQuery::default()
            },
            UsageQuery {
                start: Some("2026-08-28T00:00:00Z".into()),
                ..UsageQuery::default()
            },
            UsageQuery {
                model: Some("not-present".into()),
                ..UsageQuery::default()
            },
        ];
        let canonical = |mut categories: Vec<UsageCategory>| {
            categories.sort_by(|left, right| left.key.cmp(&right.key));
            serde_json::to_value(categories).unwrap()
        };
        for query in queries {
            let actual = load_usage_analysis(&connection, &query, &config).unwrap();
            assert_eq!(
                canonical(actual.models),
                canonical(
                    load_simple_categories(&connection, &query, USAGE_DISPLAY_MODEL_SQL, "unknown")
                        .unwrap()
                )
            );
            assert_eq!(
                canonical(actual.providers),
                canonical(
                    load_simple_categories(&connection, &query, "provider", "Unknown Provider")
                        .unwrap()
                )
            );
            assert_eq!(
                canonical(actual.sources),
                canonical(load_source_categories(&connection, &query, &config).unwrap())
            );
            assert_eq!(
                canonical(actual.api_keys),
                canonical(load_api_key_categories(&connection, &query).unwrap())
            );
        }
    }

    #[test]
    fn model_categories_and_filter_keep_aliases_separate() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_usage_schema(&connection).unwrap();
        let mut records = Vec::new();
        for (index, alias) in ["", "model-fast", "model-high", "model-fast"]
            .into_iter()
            .enumerate()
        {
            let mut record = sample_record(
                &format!("model-alias-{index}"),
                "2026-09-25T00:00:00Z",
                "base-model",
            );
            record.alias = alias.to_string();
            records.push(record);
        }
        insert_usage_records(&mut connection, &records).unwrap();
        let config = GuiConfigFile::default();
        let analysis = load_usage_analysis(&connection, &UsageQuery::default(), &config).unwrap();
        let counts = analysis
            .models
            .iter()
            .map(|category| (category.key.as_str(), category.requests))
            .collect::<HashMap<_, _>>();
        assert_eq!(counts.len(), 3);
        assert_eq!(counts["base-model"], 1);
        assert_eq!(counts["model-fast"], 2);
        assert_eq!(counts["model-high"], 1);
        let overview = load_usage_overview(&connection, &UsageQuery::default()).unwrap();
        let trend_models = overview
            .timeline
            .iter()
            .flat_map(|point| point.models.iter().map(|model| model.key.as_str()))
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(trend_models, ["base-model", "model-fast", "model-high"].into());

        for (model, expected) in [("base-model", 1), ("model-fast", 2), ("model-high", 1)] {
            let query = UsageQuery {
                model: Some(model.to_string()),
                ..UsageQuery::default()
            };
            let filtered = load_usage_analysis(&connection, &query, &config).unwrap();
            assert_eq!(filtered.models.len(), 1);
            assert_eq!(filtered.models[0].key, model);
            assert_eq!(filtered.models[0].requests, expected);
            assert_eq!(load_usage_events(&connection, &query, &config).unwrap().total, expected as usize);
        }
    }

    #[test]
    fn collector_total_records_apply_insertions_and_retention_deletions() {
        let state = UsageCollectorState::default();
        state.set_total_records(40);
        state.apply_record_changes(4, 2);

        assert_eq!(state.status().unwrap().total_records, 42);

        state.apply_record_changes(0, 100);
        assert_eq!(state.status().unwrap().total_records, 0);
    }

    #[tokio::test]
    async fn retained_remote_batch_retries_database_failure_in_original_store() {
        let root = test_root("retained-remote");
        let other_root = test_root("retained-remote-other");
        let blocked_root = root.join("blocked");
        fs::write(&blocked_root, b"not a directory").unwrap();
        let config = GuiConfigFile {
            connection_mode: CoreConnectionMode::Remote,
            remote_management_origin: "https://original.invalid".into(),
            ..Default::default()
        };
        let source = remote_usage_queue_source(&config);
        let messages = vec![serde_json::json!({
            "request_id": "retained-remote-request",
            "model": "gpt-test",
            "tokens": { "input_tokens": 10, "output_tokens": 20 }
        }).to_string()];
        let mut pending = Some(PendingRemoteUsageBatch::new(
            blocked_root.clone(), source.clone(), config.clone(), messages.clone(),
        ));
        // Repeated failures retain the entire batch rather than permitting a
        // new pop. A different selected target must not replace its identity.
        let mut selected = config.clone();
        selected.remote_management_origin = "https://new.invalid".into();
        selected.target_revision += 1;
        let fetches = std::cell::Cell::new(0);
        for _ in 0..2 {
            assert!(fetch_remote_usage_when_durable(&pending, || {
                fetches.set(fetches.get() + 1);
                std::future::ready(Ok(Vec::new()))
            }).await.is_none());
            assert!(PendingRemoteUsageBatch::persist(&mut pending).is_err());
            let batch = pending.as_ref().unwrap();
            assert_eq!(batch.messages, messages);
            assert_eq!(batch.config.remote_management_origin, config.remote_management_origin);
            assert_ne!(batch.config.target_revision, selected.target_revision);
        }
        fs::remove_file(&blocked_root).unwrap();
        initialize_usage_storage_at(&blocked_root).unwrap();
        initialize_usage_storage_at(&other_root).unwrap();
        let outcome = PendingRemoteUsageBatch::persist_with(
            &mut pending,
            |stored_root, stored_source, messages| {
                assert_eq!(stored_root, blocked_root);
                assert_eq!(stored_source, source);
                enqueue_usage_raw_messages(&mut open_usage_database_at(stored_root)?, stored_source, messages).map(|_| ())
            },
            |stored_root, stored_config| {
                assert_eq!(stored_config.remote_management_origin, config.remote_management_origin);
                process_usage_inbox(&mut open_usage_database_at(stored_root)?, stored_config)
            },
        ).unwrap();
        assert!(pending.is_none());
        assert_eq!(fetches.get(), 0);
        assert!(fetch_remote_usage_when_durable(&pending, || {
            fetches.set(fetches.get() + 1);
            std::future::ready(Ok(Vec::new()))
        }).await.unwrap().is_ok());
        assert_eq!(fetches.get(), 1);
        assert_eq!(outcome.inserted, 1);
        assert_eq!(total_usage_records_at(&blocked_root).unwrap(), 1);
        assert_eq!(total_usage_records_at(&other_root).unwrap(), 0);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(other_root).unwrap();
    }

    #[test]
    fn retained_batch_whose_processing_failed_is_not_enqueued_twice() {
        let root = test_root("retained-no-double-count");
        initialize_usage_storage_at(&root).unwrap();
        let config = GuiConfigFile {
            connection_mode: CoreConnectionMode::Remote,
            remote_management_origin: "https://original.invalid".into(),
            ..Default::default()
        };
        let source = remote_usage_queue_source(&config);
        let messages = vec![serde_json::json!({
            "request_id": "retained-once",
            "model": "gpt-test",
            "tokens": { "input_tokens": 10, "output_tokens": 20 }
        }).to_string()];
        let mut pending = Some(PendingRemoteUsageBatch::new(root.clone(), source, config, messages));
        let enqueue = |root: &Path, source: &str, messages: Vec<String>| {
            enqueue_usage_raw_messages(&mut open_usage_database_at(root)?, source, messages).map(|_| ())
        };
        // First attempt: the inbox write commits, then processing hits "database is locked".
        let first = PendingRemoteUsageBatch::persist_with(&mut pending, enqueue, |_, _| Err("database is locked".to_string()));
        assert!(first.is_err());
        assert!(pending.as_ref().unwrap().enqueued, "the batch is durable in the inbox");
        // Retry must not write the raw rows again.
        let outcome = PendingRemoteUsageBatch::persist_with(
            &mut pending,
            |_, _, _| panic!("a durable batch must not be enqueued again"),
            |root, config| process_usage_inbox(&mut open_usage_database_at(root)?, config),
        ).unwrap();
        assert!(pending.is_none());
        assert_eq!(outcome.inserted, 1);
        assert_eq!(total_usage_records_at(&root).unwrap(), 1);
        let inbox_rows: i64 = open_usage_database_at(&root).unwrap()
            .query_row("SELECT COUNT(*) FROM usage_inbox", [], |row| row.get(0)).unwrap();
        assert_eq!(inbox_rows, 1, "one raw row, not two");
        fs::remove_dir_all(root).unwrap();
    }

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "cpa-gui-usage-{name}-{}-{}",
            std::process::id(),
            unique_file_stamp()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn legacy_usage_storage_is_moved_with_nested_files() {
        let root = test_root("storage-location-migration");
        let source = root.join("legacy").join(USAGE_DIR_NAME);
        let target = root.join("application-support").join(USAGE_DIR_NAME);
        fs::create_dir_all(source.join(USAGE_BACKUP_DIR_NAME)).unwrap();
        fs::write(source.join(USAGE_DATABASE_FILE), b"database").unwrap();
        fs::write(
            source.join(USAGE_BACKUP_DIR_NAME).join("usage.db.backup"),
            b"backup",
        )
        .unwrap();

        migrate_usage_storage_directory(&source, &target).unwrap();

        assert!(!source.exists());
        assert_eq!(
            fs::read(target.join(USAGE_DATABASE_FILE)).unwrap(),
            b"database"
        );
        assert_eq!(
            fs::read(target.join(USAGE_BACKUP_DIR_NAME).join("usage.db.backup")).unwrap(),
            b"backup"
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn open_test_database(root: &Path) -> Connection {
        initialize_usage_storage_at(root).unwrap();
        open_usage_database_at(root).unwrap()
    }

    #[test]
    fn usage_database_limit_defaults_to_unlimited_and_persists() {
        let root = test_root("database-limit-persistence");
        let connection = open_test_database(&root);

        assert_eq!(load_usage_database_limit(&connection).unwrap(), 0);
        assert!(shrink_usage_database_to_mb(&connection, 0).is_err());
        save_usage_database_limit(&connection, 128).unwrap();
        drop(connection);

        let connection = open_usage_database_at(&root).unwrap();
        assert_eq!(load_usage_database_limit(&connection).unwrap(), 128);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn one_time_database_shrink_keeps_the_automatic_limit() {
        let root = test_root("one-time-database-shrink");
        let mut connection = open_test_database(&root);
        save_usage_database_limit(&connection, 128).unwrap();

        let payload = "x".repeat(8 * 1024);
        let transaction = connection.transaction().unwrap();
        for timestamp_ms in 0_i64..320 {
            transaction
                .execute(
                    r#"INSERT INTO usage_events (
                           event_key, timestamp, timestamp_ms, local_hour,
                           failure_body, created_at
                       ) VALUES (?1, ?2, ?3, '2026-01-01T00', ?4, ?2)"#,
                    params![
                        format!("one-time-shrink-{timestamp_ms}"),
                        format!("2026-01-01T00:00:{timestamp_ms:03}Z"),
                        timestamp_ms,
                        payload,
                    ],
                )
                .unwrap();
        }
        transaction.commit().unwrap();

        let deleted = shrink_usage_database_to_mb(&connection, 1).unwrap();

        assert!(deleted > 0);
        assert_eq!(load_usage_database_limit(&connection).unwrap(), 128);
        assert!(usage_database_disk_bytes(&root).unwrap() <= BYTES_PER_MB);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn usage_database_limit_removes_oldest_records_after_collection() {
        let root = test_root("database-limit-retention");
        let mut connection = open_test_database(&root);
        save_usage_database_limit(&connection, 1).unwrap();

        let payload = "x".repeat(8 * 1024);
        let transaction = connection.transaction().unwrap();
        for timestamp_ms in 0_i64..512 {
            transaction
                .execute(
                    r#"INSERT INTO usage_events (
                           event_key, timestamp, timestamp_ms, local_hour, model,
                           failure_body, created_at
                       ) VALUES (?1, ?2, ?3, '2026-01-01T00', 'retention-test', ?4, ?2)"#,
                    params![
                        format!("retention-{timestamp_ms}"),
                        format!("2026-01-01T00:00:{timestamp_ms:03}Z"),
                        timestamp_ms,
                        payload,
                    ],
                )
                .unwrap();
        }
        transaction.commit().unwrap();

        enqueue_usage_queue_items(
            &mut connection,
            "retention-test",
            vec![serde_json::json!({
                "timestamp": "2026-09-18T12:00:00+08:00",
                "request_id": "newest-retained-record",
                "model": "retention-test",
                "tokens": { "input_tokens": 1, "output_tokens": 1 }
            })],
        )
        .unwrap();
        let outcome = process_usage_inbox(&mut connection, &GuiConfigFile::default()).unwrap();

        assert_eq!(outcome.inserted, 1);
        assert!(outcome.deleted > 0);
        let (remaining, oldest_timestamp, newest_record): (u64, i64, u64) = connection
            .query_row(
                r#"SELECT COUNT(*), MIN(timestamp_ms),
                          SUM(CASE WHEN request_id = 'newest-retained-record' THEN 1 ELSE 0 END)
                   FROM usage_events"#,
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert!(remaining > 0);
        assert!(remaining < 513);
        assert!(oldest_timestamp > 0);
        assert_eq!(newest_record, 1);
        assert!(usage_database_active_bytes(&connection).unwrap() <= BYTES_PER_MB);
        assert!(usage_database_disk_bytes(&root).unwrap() <= BYTES_PER_MB);

        let settings = load_usage_storage_settings(&connection, &root, outcome.deleted).unwrap();
        assert_eq!(settings.max_database_size_mb, 1);
        assert_eq!(settings.total_records, remaining);
        assert_eq!(settings.deleted_records, outcome.deleted);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repairs_legacy_claude_input_tokens_on_demand() {
        let root = test_root("claude-input-migration");
        let connection = open_test_database(&root);
        connection
            .execute(
                r#"INSERT INTO usage_events (
                    event_key, timestamp, timestamp_ms, local_hour, provider,
                    executor_type, input_tokens, output_tokens, cache_read_tokens,
                    cache_creation_tokens, total_tokens, created_at
                ) VALUES ('legacy-claude', '2026-08-27T00:00:00Z', 1,
                          '2026-08-27T00', 'claude', 'ClaudeExecutor',
                          100, 20, 600, 20, 740, '2026-08-27T00:00:00Z')"#,
                [],
            )
            .unwrap();
        drop(connection);

        let result = repair_usage_cache_records_at(&root).unwrap();
        assert_eq!(result.scanned, 1);
        assert_eq!(result.repaired, 1);
        assert!(result.backup_path.is_some());
        let connection = open_usage_database_at(&root).unwrap();
        let row: (i64, i64, i64) = connection
            .query_row(
                "SELECT input_tokens, total_tokens, cached_tokens FROM usage_events WHERE event_key = 'legacy-claude'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, (720, 740, 620));
        drop(connection);

        let second = repair_usage_cache_records_at(&root).unwrap();
        assert_eq!(second.scanned, 0);
        assert_eq!(second.repaired, 0);
        let rerun_connection = open_usage_database_at(&root).unwrap();
        let rerun_input: i64 = rerun_connection
            .query_row(
                "SELECT input_tokens FROM usage_events WHERE event_key = 'legacy-claude'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(rerun_connection);
        assert_eq!(rerun_input, 720);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removes_historical_unknown_records_on_demand() {
        let root = test_root("unknown-repair");
        let connection = open_test_database(&root);
        for (key, index) in ["refresh-control", "support-refresh-control"]
            .iter()
            .zip([1_i64, 2_i64])
        {
            connection
                .execute(
                    "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, provider, model, request_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, latency_ms, failed, canceled, generate, created_at) VALUES (?1, '2026-08-27T00:00:00Z', ?2, '2026-08-27T00', '', 'unknown', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, '2026-08-27T00:00:00Z')",
                    params![key, index],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, provider, model, request_id, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, latency_ms, failed, canceled, generate, created_at) VALUES ('legitimate-unknown', '2026-08-27T00:00:00Z', 3, '2026-08-27T00', '', 'unknown', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, '2026-08-27T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);

        let result = repair_usage_cache_records_at(&root).unwrap();
        assert_eq!(result.scanned, 3);
        assert_eq!(result.repaired, 0);
        assert_eq!(result.deleted, 3);
        let connection = open_usage_database_at(&root).unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_events WHERE model = 'unknown'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    fn create_legacy_v2_database(root: &Path) -> Connection {
        fs::create_dir_all(root).unwrap();
        let connection = Connection::open(root.join(USAGE_DATABASE_FILE)).unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE usage_metadata (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                );
                CREATE TABLE usage_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_key TEXT NOT NULL UNIQUE,
                    timestamp TEXT NOT NULL,
                    timestamp_ms INTEGER NOT NULL,
                    local_hour TEXT NOT NULL,
                    latency_ms INTEGER NOT NULL DEFAULT 0,
                    ttft_ms INTEGER,
                    source TEXT NOT NULL DEFAULT '',
                    auth_index TEXT NOT NULL DEFAULT '',
                    failed INTEGER NOT NULL DEFAULT 0,
                    provider TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    alias TEXT NOT NULL DEFAULT '',
                    reasoning_effort TEXT NOT NULL DEFAULT '',
                    service_tier TEXT NOT NULL DEFAULT '',
                    response_service_tier TEXT NOT NULL DEFAULT '',
                    executor_type TEXT NOT NULL DEFAULT '',
                    endpoint TEXT NOT NULL DEFAULT '',
                    auth_type TEXT NOT NULL DEFAULT '',
                    api_key_hash TEXT NOT NULL DEFAULT '',
                    api_key_display TEXT NOT NULL DEFAULT '',
                    api_key_remark TEXT NOT NULL DEFAULT '',
                    request_id TEXT NOT NULL DEFAULT '',
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                    total_tokens INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                );
                PRAGMA user_version = 2;
                "#,
            )
            .unwrap();
        connection
    }

    pub(super) fn sample_record(id: &str, timestamp: &str, model: &str) -> UsageRecord {
        UsageRecord {
            id: id.to_string(),
            row_id: None,
            timestamp: timestamp.to_string(),
            latency_ms: 100,
            ttft_ms: Some(20),
            source: "source".to_string(),
            source_display: String::new(),
            auth_index: "auth".to_string(),
            failed: false,
            canceled: false,
            failure_status: 0,
            failure_body: String::new(),
            provider: "openai".to_string(),
            api_group_key: "hash".to_string(),
            model: model.to_string(),
            response_model: String::new(),
            cost: None,
            alias: String::new(),
            client_ip: None,
            x_forwarded_for: None,
            user_agent: None,
            agent: String::new(),
            reasoning_effort: "high".to_string(),
            service_tier: String::new(),
            response_service_tier: String::new(),
            executor_type: String::new(),
            endpoint: "POST /v1/responses".to_string(),
            auth_type: "oauth".to_string(),
            api_key_hash: "hash".to_string(),
            api_key_display: "12••••".to_string(),
            api_key_remark: "Built-in key".to_string(),
            request_id: id.to_string(),
            generate: true,
            cached_tokens: 2,
            collector_source: "test".to_string(),
            tokens: UsageTokenStats {
                input_tokens: 10,
                output_tokens: 20,
                reasoning_tokens: 5,
                cache_read_tokens: 2,
                cache_creation_tokens: 0,
                total_tokens: 30,
            },
        }
    }

    #[test]
    fn masks_api_keys_without_exposing_the_full_value() {
        assert_eq!(mask_api_key("123456"), "12••••");
        assert_eq!(mask_api_key("sk-1234567890"), "sk-1••••7890");
    }

    #[test]
    fn upstream_filter_uses_exact_identity_and_keeps_legacy_routes_separate() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_usage_schema(&connection).unwrap();
        let config = GuiConfigFile::default();
        let mut records = Vec::new();
        for (index, (auth, provider)) in [("AccountA", "codex"), ("accounta", "codex"), ("", "claude"), ("", "gemini")].into_iter().enumerate() {
            let mut record = sample_record(&format!("upstream-{index}"), "2026-10-11T00:00:00Z", "model");
            record.auth_index = auth.to_string();
            record.provider = provider.to_string();
            record.source = "sk-shared-upstream-secret-for-test".to_string();
            records.push(record);
        }
        insert_usage_records(&mut connection, &records).unwrap();
        let all = load_usage_analysis(&connection, &UsageQuery::default(), &config).unwrap();
        assert_eq!(all.upstreams.len(), 4);
        for upstream in all.upstreams {
            let query = UsageQuery { upstream: Some(upstream.category.key.clone()), ..Default::default() };
            let page = load_usage_events(&connection, &query, &config).unwrap();
            let overview = load_usage_overview(&connection, &query).unwrap();
            assert_eq!(page.total, 1);
            assert_eq!(overview.total_requests, 1);
            if !page.items[0].auth_index.is_empty() {
                assert_eq!(page.items[0].source_display, upstream.category.label);
            }
            assert!(!page.items[0].source_display.contains("secret"));
            assert!(!upstream.category.key.contains("secret"));
            assert!(!upstream.category.label.contains("secret"));
        }
        let missing = UsageQuery { upstream: Some("auth:unknown".to_string()), ..Default::default() };
        assert_eq!(load_usage_events(&connection, &missing, &config).unwrap().total, 0);
    }

    #[test]
    fn usage_key_labels_follow_current_remarks_without_changing_identity_or_totals() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_usage_schema(&connection).unwrap();
        let key = "test-client-key-for-usage-labels";
        let mut config = GuiConfigFile {
            api_keys: vec![crate::GuiApiKeyEntry {
                key: key.to_string(),
                remark: "Codex".to_string(),
            }],
            ..Default::default()
        };
        let mut old = sample_record("old-label", "2026-10-10T00:00:00Z", "model");
        old.api_key_hash = hash_text(key);
        old.api_key_remark = "ZCODE".to_string();
        let mut recent = old.clone();
        recent.id = "new-label".to_string();
        recent.request_id = "new-label".to_string();
        recent.timestamp = "2026-10-11T00:00:00Z".to_string();
        recent.api_key_remark = "Zcode".to_string();
        insert_usage_records(&mut connection, &[old, recent]).unwrap();
        let query = UsageQuery {
            api_key_hash: Some(hash_text(key)),
            ..Default::default()
        };
        for remark in ["Codex", "Renamed", ""] {
            config.api_keys[0].remark = remark.to_string();
            let analysis = load_usage_analysis(&connection, &query, &config).unwrap();
            let events = load_usage_events(&connection, &query, &config).unwrap();
            assert_eq!(analysis.api_keys.len(), 1);
            let category = &analysis.api_keys[0];
            assert_eq!(category.key, hash_text(key));
            assert_eq!(category.requests, 2);
            assert_eq!(
                category.label,
                if remark.is_empty() { mask_api_key(key) } else { remark.to_string() }
            );
            assert_eq!(events.total, 2);
            assert!(events.items.iter().all(|item|
                item.api_key_remark == remark && item.api_key_display == mask_api_key(key)
            ));
        }
        // Deleted keys keep historical labels; reading does not rewrite stored records.
        config.api_keys.clear();
        let analysis = load_usage_analysis(&connection, &query, &config).unwrap();
        assert_eq!(analysis.api_keys[0].label, "Zcode");
        let events = load_usage_events(&connection, &query, &config).unwrap();
        assert_eq!(events.items[0].api_key_remark, "Zcode");
        assert_eq!(events.items[1].api_key_remark, "ZCODE");
    }

    #[test]
    fn api_key_category_uses_either_remark_or_masked_key() {
        assert_eq!(
            api_key_category_label("Production".to_string(), "12••••".to_string()),
            "Production"
        );
        assert_eq!(
            api_key_category_label(String::new(), "123456".to_string()),
            "12••••"
        );
    }

    #[test]
    fn usage_source_notes_and_request_key_notes_stay_independent() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_usage_schema(&connection).unwrap();
        let mut config = GuiConfigFile {
            api_keys: vec![crate::GuiApiKeyEntry {
                key: "client-key".into(), remark: "Client note".into(),
            }],
            ..Default::default()
        };
        for (section, remark) in [("xai-api-key", "Grok API note"), ("codex-api-key", "Other API note")] {
            config.api_access_remarks.push(crate::GuiApiAccessRemark {
                provider_section: section.into(), api_key_hash: hash_text("sk-upstream-test"),
                record_hash: String::new(), remark: remark.into(),
            });
        }
        let notes = HashMap::from([("grok-file".into(), "Grok credential note".into())]);
        let mut oauth = sample_record("notes-oauth", "2026-08-27T00:00:00Z", "grok");
        oauth.provider = "grok".into();
        oauth.source = "account@example.com".into();
        oauth.auth_index = "grok-file".into();
        oauth.api_key_hash = hash_text("client-key");
        let mut api = oauth.clone();
        api.id = "notes-api".into();
        api.source = "sk-upstream-test".into();
        api.auth_index = "grok-api".into();
        let mut historical = oauth.clone();
        historical.id = "notes-historical".into();
        historical.auth_index = "retired-grok-file".into();
        insert_usage_records(&mut connection, &[oauth, api, historical]).unwrap();
        let query = UsageQuery::default();
        let analysis = load_usage_analysis_with_notes(&connection, &query, &config, &notes).unwrap();
        assert_eq!(analysis.sources.iter().find(|c| c.key == "account@example.com").unwrap().label, "Grok credential note");
        assert_eq!(analysis.sources.iter().find(|c| c.key == "sk-upstream-test").unwrap().label, "Grok API note");
        assert_eq!(analysis.api_keys[0].label, "Client note");
        assert_eq!(analysis.upstreams.iter().find(|c| c.category.key == "auth:grok-file").unwrap().category.label, "account@example.com");
        let events = load_usage_events_with_notes(&connection, &query, &config, &notes).unwrap();
        assert!(events.items.iter().all(|item| item.api_key_remark == "Client note"));
        assert_eq!(events.items.iter().find(|item| item.auth_index == "grok-file").unwrap().source_display, "account@example.com");
        let updated = HashMap::from([("grok-file".into(), "Updated note".into())]);
        let analysis = load_usage_analysis_with_notes(&connection, &query, &config, &updated).unwrap();
        assert_eq!(analysis.sources.iter().find(|c| c.key == "account@example.com").unwrap().label, "Updated note");
        assert_eq!(analysis.upstreams.iter().find(|c| c.category.key == "auth:grok-file").unwrap().category.label, "account@example.com");
        let conflicting = HashMap::from([
            ("grok-file".into(), "First note".into()),
            ("retired-grok-file".into(), "Different note".into()),
        ]);
        let analysis = load_usage_analysis_with_notes(&connection, &query, &config, &conflicting).unwrap();
        assert_eq!(analysis.sources.iter().find(|c| c.key == "account@example.com").unwrap().label, "account@example.com");
    }

    #[test]
    fn usage_accounts_survive_shared_notes_and_missing_auth_indexes() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_usage_schema(&connection).unwrap();
        let config = GuiConfigFile::default();
        let mut records = Vec::new();
        for (id, account, auth) in [
            ("first", "first@example.com", "auth-first"),
            ("second", "second@example.com", "auth-second"),
            ("legacy", "legacy@example.com", ""),
        ] {
            let mut record = sample_record(id, "2026-10-11T00:00:00Z", "model");
            record.source = account.into();
            record.auth_index = auth.into();
            record.provider = "codex".into();
            records.push(record);
        }
        insert_usage_records(&mut connection, &records).unwrap();
        let notes = HashMap::from([
            ("auth-first".into(), "Work".into()),
            ("auth-second".into(), "Work".into()),
        ]);
        let query = UsageQuery::default();
        let events = load_usage_events_with_notes(&connection, &query, &config, &notes).unwrap();
        for event in &events.items {
            assert!(event.source_display.contains(&event.source));
            if !event.auth_index.is_empty() {
                assert!(!event.source_display.contains("Work"));
            }
        }
        let analysis = load_usage_analysis_with_notes(&connection, &query, &config, &notes).unwrap();
        for event in events.items.iter().filter(|event| !event.auth_index.is_empty()) {
            let key = format!("auth:{}", event.auth_index);
            assert_eq!(analysis.upstreams.iter().find(|item| item.category.key == key).unwrap().category.label, event.source_display);
        }
        let mut fallback = sample_record("client-fallback", "2026-10-11T00:00:00Z", "model");
        fallback.source = "retired-client-key".into();
        fallback.api_key_hash = hash_text(&fallback.source);
        fallback.auth_index.clear();
        fallback.provider = "codex".into();
        insert_usage_records(&mut connection, &[fallback]).unwrap();
        let events = load_usage_events_with_notes(&connection, &query, &config, &notes).unwrap();
        assert_eq!(events.items.iter().find(|event| event.source == "retired-client-key").unwrap().source_display, "codex");
    }

    #[test]
    fn usage_source_prefers_api_access_remark_and_masks_secret_fallbacks() {
        let key = "sk-1234567890abcdefghijklmnopqrstuvwxyz";
        let mut config = GuiConfigFile::default();
        config.api_access_remarks.push(crate::GuiApiAccessRemark {
            provider_section: "codex-api-key".to_string(),
            api_key_hash: hash_text(key),
            record_hash: String::new(),
            remark: "Production".to_string(),
        });

        assert_eq!(usage_source_display(&config, "codex", key), "Production");
        assert_eq!(
            usage_source_display(&GuiConfigFile::default(), "codex", key),
            "sk-1••••wxyz"
        );
        assert_eq!(
            usage_source_display(&config, "codex", "account@example.com"),
            "account@example.com"
        );
    }

    #[test]
    fn usage_source_masks_shared_keys_with_different_record_remarks() {
        let key = "sk-1234567890abcdefghijklmnopqrstuvwxyz";
        let mut config = GuiConfigFile::default();
        for (record_hash, remark) in [
            ("a".repeat(64), "Production"),
            ("b".repeat(64), "Test"),
        ] {
            config.api_access_remarks.push(crate::GuiApiAccessRemark {
                provider_section: "codex-api-key".to_string(),
                api_key_hash: hash_text(key),
                record_hash,
                remark: remark.to_string(),
            });
        }

        assert_eq!(
            usage_source_display(&config, "codex", key),
            "sk-1••••wxyz"
        );
    }

    #[test]
    fn local_hour_key_uses_year_month_day_and_hour() {
        let record = sample_record("id", "2026-07-17T20:30:00+08:00", "model");
        assert_eq!(record_local_hour(&record).len(), "2026-07-17-20".len());
    }

    #[test]
    fn normalizes_queue_records_without_persisting_secrets_or_headers() {
        let config = GuiConfigFile {
            locale: "zh-CN".to_string(),
            port: 8317,
            allow_lan: false,
            host: "127.0.0.1".to_string(),
            run_on_startup: false,
            start_core_on_launch: true,
            silent_start: false,
            close_behavior: crate::WindowsCloseBehavior::Ask,
            default_terminal: crate::DEFAULT_AGENT_TERMINAL.to_string(),
            window_width: None,
            window_height: None,
            window_x: None,
            window_y: None,
            auth_dir: String::new(),
            auth_dir_user_selected: false,
            image_generation_user_selected: false,
            api_keys: Vec::new(),
            api_access_remarks: Vec::new(),
            management_secret_key: "123456".to_string(),
            debug: false,
            commercial_mode: false,
            logging_to_file: false,
            logs_max_total_size_mb: crate::DEFAULT_LOGS_MAX_TOTAL_SIZE_MB,
            error_logs_max_files: crate::DEFAULT_ERROR_LOGS_MAX_FILES,
            usage_statistics_enabled: true,
            usage_statistics_disabled: None,
            redis_usage_queue_retention_seconds: crate::DEFAULT_REDIS_USAGE_QUEUE_RETENTION_SECONDS,
            request_log: false,
            plugins_enabled: false,
            routing_strategy: "round-robin".to_string(),
            proxy_url: String::new(),
            proxy_override: false,
            download_source: VersionDownloadSource::Github,
            custom_download_mirrors: Vec::new(),
            active_custom_download_mirror: String::new(),
            prefer_gitcode_downloads: false,
            routing_session_affinity: false,
            routing_session_affinity_ttl: String::new(),
            disable_cooling: crate::DEFAULT_DISABLE_COOLING,
            request_retry: crate::DEFAULT_REQUEST_RETRY,
            max_retry_credentials: crate::DEFAULT_MAX_RETRY_CREDENTIALS,
            max_retry_interval: crate::DEFAULT_MAX_RETRY_INTERVAL,
            streaming_bootstrap_retries: crate::DEFAULT_STREAMING_BOOTSTRAP_RETRIES,
            ..GuiConfigFile::default()
        };
        let record = normalize_usage_record(
            serde_json::json!({
                "timestamp": "2026-07-17T20:30:00+08:00",
                "request_id": "request-1",
                "api_key": "secret-client-key",
                "response_headers": { "authorization": ["secret-upstream-token"] },
                "model": "gpt-test",
                "tokens": {
                    "input_tokens": 10,
                    "output_tokens": 20,
                    "cached_tokens": 7,
                    "cache_read_tokens": 5,
                    "cache_creation_tokens": 2
                }
            }),
            &config,
        )
        .unwrap();
        let rendered = serde_json::to_string(&record).unwrap();

        assert!(!rendered.contains("secret-client-key"));
        assert!(!rendered.contains("secret-upstream-token"));
        assert_eq!(record.tokens.total_tokens, 30);
        assert_eq!(record.tokens.cache_read_tokens, 5);
        assert!(!record.api_key_hash.is_empty());
    }

    #[test]
    fn normalizes_response_model_when_present_and_defaults_when_missing() {
        let config = GuiConfigFile::default();
        for (response_model, expected) in [
            (None, ""),
            (Some(serde_json::json!(null)), ""),
            (Some(serde_json::json!("  ")), ""),
            (
                Some(serde_json::json!(" gemini-3.8-flash ")),
                "gemini-3.8-flash",
            ),
        ] {
            let mut value = serde_json::json!({
                "request_id": "response-model-normalization",
                "model": "gemini-3.8-flash-high",
                "alias": "client-alias"
            });
            if let Some(response_model) = response_model {
                value["response_model"] = response_model;
            }
            let record = normalize_usage_record(value, &config).unwrap();

            assert_eq!(record.response_model, expected);
            assert_eq!(record.model, "gemini-3.8-flash-high");
            assert_eq!(record.alias, "client-alias");
            assert_eq!(
                serde_json::to_value(&record).unwrap()["response_model"],
                expected
            );
        }
    }

    #[test]
    fn response_model_json_roundtrip_accepts_legacy_records_without_the_field() {
        let mut record = sample_record("response-json", "2026-07-17T20:30:00+08:00", "gpt-a");
        record.response_model = "gpt-upstream".to_string();
        let mut encoded = serde_json::to_value(&record).unwrap();
        let decoded: UsageRecord = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(decoded.response_model, "gpt-upstream");

        encoded.as_object_mut().unwrap().remove("response_model");
        let legacy: UsageRecord = serde_json::from_value(encoded).unwrap();
        assert!(legacy.response_model.is_empty());
        assert_eq!(legacy.model, "gpt-a");
    }

    #[test]
    fn response_model_survives_sqlite_roundtrip() {
        let root = test_root("response-model-roundtrip");
        let mut connection = open_test_database(&root);
        let mut record = sample_record(
            "response-model-roundtrip",
            "2026-07-17T20:30:00+08:00",
            "gemini-alias",
        );
        record.response_model = "gemini-3.8-flash-high".to_string();
        insert_usage_records(&mut connection, &[record]).unwrap();
        let page = load_usage_events(
            &connection,
            &UsageQuery::default(),
            &GuiConfigFile::default(),
        )
        .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].response_model, "gemini-3.8-flash-high");
        assert_eq!(page.items[0].model, "gemini-alias");
        assert_eq!(page.items[0].tokens.total_tokens, 30);
        assert_eq!(
            serde_json::to_value(&page.items[0]).unwrap()["response_model"],
            "gemini-3.8-flash-high"
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn response_model_migration_preserves_v5_records_and_is_idempotent() {
        let root = test_root("response-model-v6-migration");
        let mut connection = open_test_database(&root);
        let record = sample_record("legacy-v5", "2026-07-17T20:30:00+08:00", "gpt-a");
        insert_usage_records(&mut connection, &[record]).unwrap();
        connection
            .execute_batch(
                "ALTER TABLE usage_events DROP COLUMN response_model; PRAGMA user_version = 5;",
            )
            .unwrap();
        assert!(!usage_table_columns(&connection, "usage_events")
            .unwrap()
            .contains("response_model"));
        drop(connection);

        initialize_usage_storage_at(&root).unwrap();
        let mut connection = open_usage_database_at(&root).unwrap();
        let config = GuiConfigFile::default();
        let legacy_page = load_usage_events(&connection, &UsageQuery::default(), &config).unwrap();
        assert_eq!(legacy_page.total, 1);
        assert!(legacy_page.items[0].response_model.is_empty());
        assert_eq!(legacy_page.items[0].tokens.total_tokens, 30);

        let mut record = sample_record("new-v6", "2026-07-17T20:31:00+08:00", "gpt-b");
        record.response_model = "gpt-upstream".to_string();
        insert_usage_records(&mut connection, &[record]).unwrap();
        drop(connection);

        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let page = load_usage_events(&connection, &UsageQuery::default(), &config).unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.items[0].response_model, "gpt-upstream");
        assert!(page.items[1].response_model.is_empty());
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            USAGE_DATABASE_SCHEMA_VERSION
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_explicit_cache_read_and_only_backfills_missing_alias() {
        let config = GuiConfigFile::default();
        let explicit = normalize_usage_record(
            serde_json::json!({
                "request_id": "explicit-cache-read",
                "tokens": {
                    "input_tokens": 100,
                    "cached_tokens": 10,
                    "cache_read_tokens": 5,
                    "cache_creation_tokens": 2,
                    "total_tokens": 100
                }
            }),
            &config,
        )
        .unwrap();
        assert_eq!(explicit.tokens.cache_read_tokens, 5);

        let legacy = normalize_usage_record(
            serde_json::json!({
                "request_id": "legacy-cache-alias",
                "tokens": {
                    "input_tokens": 100,
                    "cached_tokens": 10,
                    "cache_creation_tokens": 2,
                    "total_tokens": 100
                }
            }),
            &config,
        )
        .unwrap();
        assert_eq!(legacy.tokens.cache_read_tokens, 10);
    }

    #[test]
    fn normalizes_claude_input_to_include_cache_tokens() {
        let record = normalize_usage_record(
            serde_json::json!({
                "executor_type": "ClaudeExecutor",
                "provider": "anthropic",
                "request_id": "claude-cache-rate",
                "tokens": {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "cache_read_tokens": 600,
                    "cache_creation_tokens": 20,
                    "total_tokens": 120
                }
            }),
            &GuiConfigFile::default(),
        )
        .unwrap();

        assert_eq!(record.tokens.input_tokens, 720);
        assert_eq!(record.tokens.total_tokens, 740);
        assert_eq!(record.tokens.cache_read_tokens, 600);
    }

    #[test]
    fn legacy_claude_identity_uses_keeper_missing_cache_contract() {
        let record = normalize_usage_record(
            serde_json::json!({
                "provider": "anthropic",
                "auth_type": "oauth",
                "request_id": "claude-inclusive",
                "tokens": {
                    "input_tokens": 720,
                    "output_tokens": 20,
                    "cache_read_tokens": 600,
                    "cache_creation_tokens": 20,
                    "total_tokens": 740
                }
            }),
            &GuiConfigFile::default(),
        )
        .unwrap();
        assert_eq!(record.tokens.input_tokens, 1_340);
        assert_eq!(record.tokens.total_tokens, 1_360);
    }

    #[test]
    fn unresolved_executors_only_use_provider_for_oauth() {
        for executor in ["", "unknown", "FutureExecutor"] {
            for auth_type in ["", "apikey", "api_key", "unknown", " OAUTH "] {
                let record = normalize_usage_record(
                    serde_json::json!({
                        "request_id": "unresolved-executor",
                        "executor_type": executor,
                        "provider": "anthropic",
                        "auth_type": auth_type,
                        "auth_index": "missing-identity",
                        "tokens": {
                            "input_tokens": 100,
                            "output_tokens": 20,
                            "cache_read_tokens": 30,
                            "total_tokens": 120
                        }
                    }),
                    &GuiConfigFile::default(),
                )
                .unwrap();
                let expected_input = if auth_type.trim().eq_ignore_ascii_case("oauth") {
                    130
                } else {
                    100
                };
                assert_eq!(
                    record.tokens.input_tokens, expected_input,
                    "{executor}/{auth_type}"
                );
                assert_eq!(
                    record.tokens.total_tokens,
                    expected_input + 20,
                    "{executor}/{auth_type}"
                );
            }
        }
    }

    #[test]
    fn codex_cached_only_records_preserve_total_with_missing_or_zero_read() {
        for explicit_read in [false, true] {
            let mut tokens = serde_json::json!({
                "input_tokens": 0,
                "output_tokens": 0,
                "reasoning_tokens": 0,
                "cached_tokens": 30,
                "cache_creation_tokens": 0,
                "total_tokens": 30
            });
            if explicit_read {
                tokens["cache_read_tokens"] = serde_json::json!(0);
            }
            let record = normalize_usage_record(
                serde_json::json!({
                    "request_id": "codex-cached-only",
                    "executor_type": "CodexExecutor",
                    "tokens": tokens
                }),
                &GuiConfigFile::default(),
            )
            .unwrap();
            assert_eq!(
                record.tokens.total_tokens, 30,
                "explicit_read={explicit_read}"
            );
            assert_eq!(record.tokens.input_tokens, 0);
            assert_eq!(record.tokens.output_tokens, 0);
            assert_eq!(
                record.tokens.cache_read_tokens,
                if explicit_read { 0 } else { 30 }
            );
        }
    }

    #[test]
    fn clamped_contract_fields_do_not_rewrite_nonzero_total() {
        for executor in ["ClaudeExecutor", "GeminiExecutor", "CodexExecutor"] {
            for field in [
                "input_tokens",
                "output_tokens",
                "reasoning_tokens",
                "cache_read_tokens",
                "cache_creation_tokens",
            ] {
                let mut tokens = serde_json::json!({
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "total_tokens": 99
                });
                tokens[field] = serde_json::json!(-1);
                let record = normalize_usage_record(
                    serde_json::json!({
                        "request_id": "clamped-contract",
                        "executor_type": executor,
                        "tokens": tokens
                    }),
                    &GuiConfigFile::default(),
                )
                .unwrap();
                assert_eq!(record.tokens.total_tokens, 99, "{executor}/{field}");
            }
        }
    }

    #[test]
    fn zero_total_reconciliation_respects_keeper_clamped_field_dependencies() {
        for executor in [
            "ClaudeExecutor",
            "GeminiExecutor",
            "CodexExecutor",
            "OpenAICompatExecutor",
            "KimiExecutor",
            "unknown",
        ] {
            for field in [
                "input_tokens",
                "output_tokens",
                "total_tokens",
                "reasoning_tokens",
                "cache_read_tokens",
                "cache_creation_tokens",
                "cached_tokens",
            ] {
                let mut tokens = serde_json::json!({
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "total_tokens": 0
                });
                tokens[field] = serde_json::json!(-1);
                let record = normalize_usage_record(
                    serde_json::json!({
                        "request_id": "clamped-zero-fallback",
                        "executor_type": executor,
                        "tokens": tokens
                    }),
                    &GuiConfigFile::default(),
                )
                .unwrap();
                let expected = if matches!(field, "input_tokens" | "output_tokens" | "total_tokens")
                    || (executor == "ClaudeExecutor" && field == "reasoning_tokens")
                {
                    0
                } else {
                    15
                };
                assert_eq!(record.tokens.total_tokens, expected, "{executor}/{field}");
            }
        }
    }

    #[test]
    fn clamped_fields_cannot_trigger_dependent_token_folds() {
        let cases = [
            (
                "ClaudeExecutor",
                "anthropic",
                serde_json::json!({
                    "input_tokens": 10, "output_tokens": 5, "cache_read_tokens": -1,
                    "cache_creation_tokens": 30, "total_tokens": 99
                }),
                10,
                5,
            ),
            (
                "GeminiExecutor",
                "gemini",
                serde_json::json!({
                    "input_tokens": 10, "output_tokens": -1, "reasoning_tokens": 5,
                    "total_tokens": 99
                }),
                10,
                0,
            ),
            (
                "",
                "gemini",
                serde_json::json!({
                    "input_tokens": -1, "output_tokens": 5, "reasoning_tokens": 10,
                    "total_tokens": 15
                }),
                0,
                5,
            ),
            (
                "OpenAICompatExecutor",
                "openai",
                serde_json::json!({
                    "input_tokens": -1, "output_tokens": 5, "reasoning_tokens": 10,
                    "total_tokens": 15
                }),
                0,
                5,
            ),
        ];
        for (executor, provider, tokens, input, output) in cases {
            let record = normalize_usage_record(
                serde_json::json!({
                    "request_id": "clamped-fold",
                    "executor_type": executor,
                    "provider": provider,
                    "auth_type": "oauth",
                    "tokens": tokens
                }),
                &GuiConfigFile::default(),
            )
            .unwrap();
            assert_eq!(record.tokens.input_tokens, input, "{executor}/{provider}");
            assert_eq!(record.tokens.output_tokens, output, "{executor}/{provider}");
        }
    }

    #[test]
    fn clamped_cache_read_is_not_backfilled_from_cached_alias() {
        for executor in ["CodexExecutor", "KimiExecutor", "unknown"] {
            let record = normalize_usage_record(
                serde_json::json!({
                    "request_id": "clamped-cache-alias",
                    "executor_type": executor,
                    "tokens": {
                        "input_tokens": 100,
                        "output_tokens": 20,
                        "cache_read_tokens": -1,
                        "cached_tokens": 30,
                        "total_tokens": 120
                    }
                }),
                &GuiConfigFile::default(),
            )
            .unwrap();
            assert_eq!(record.tokens.cache_read_tokens, 0, "{executor}");
        }
    }

    #[test]
    fn unknown_producers_preserve_nonzero_parent_token_fields() {
        let record = normalize_usage_record(
            serde_json::json!({
                "provider": "custom",
                "request_id": "unknown-cache-shape",
                "tokens": {
                    "input_tokens": 100,
                    "output_tokens": 20,
                    "cache_read_tokens": 600,
                    "total_tokens": 120
                }
            }),
            &GuiConfigFile::default(),
        )
        .unwrap();
        assert_eq!(record.tokens.input_tokens, 100);
        assert_eq!(record.tokens.total_tokens, 120);
        assert_eq!(record.tokens.cache_read_tokens, 600);
    }

    #[test]
    fn filters_usage_control_messages_before_inbox() {
        assert!(is_ignorable_usage_message(""));
        assert!(is_ignorable_usage_message("  null\n"));
        assert!(is_ignorable_usage_message(r#"{"refresh":true}"#));
        assert!(is_ignorable_usage_message(
            r#"{ "support_refresh" : true }"#
        ));
        assert!(!is_ignorable_usage_message(r#"{"refresh":false}"#));
        assert!(!is_ignorable_usage_message(
            r#"{"refresh":true,"request_id":"usage"}"#
        ));
        assert!(!is_ignorable_usage_message(r#"{"request_id":"usage"}"#));
        assert!(!is_ignorable_usage_message("not-json"));

        let root = test_root("usage-control-messages");
        initialize_usage_storage_at(&root).unwrap();
        let config = GuiConfigFile::default();
        let inserted = persist_queue_items_from_source(
            &root,
            HTTP_USAGE_QUEUE_SOURCE,
            vec![
                serde_json::json!({"refresh": true}),
                serde_json::json!({"support_refresh": true}),
                serde_json::json!({
                    "request_id": "real-usage",
                    "provider": "codex",
                    "model": "gpt-test"
                }),
            ],
            &config,
        )
        .unwrap();
        assert_eq!(inserted.inserted, 1);
        let connection = open_usage_database_at(&root).unwrap();
        let inbox_count = connection
            .query_row("SELECT COUNT(*) FROM usage_inbox", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let event_count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(inbox_count, 1);
        assert_eq!(event_count, 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_usage_messages_without_request_id() {
        let root = test_root("usage-missing-request-id");
        initialize_usage_storage_at(&root).unwrap();
        let mut connection = open_usage_database_at(&root).unwrap();
        enqueue_usage_queue_items(
            &mut connection,
            "redis_subscribe:usage",
            vec![serde_json::json!({
                "provider": "codex",
                "model": "gpt-test"
            })],
        )
        .unwrap();
        let inserted = process_usage_inbox(&mut connection, &GuiConfigFile::default()).unwrap();
        let event_count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let status = connection
            .query_row("SELECT status FROM usage_inbox", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap();
        assert_eq!(inserted.inserted, 0);
        assert_eq!(event_count, 0);
        assert_eq!(status, "decode_failed");
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persists_successful_health_checks_and_zero_token_websocket_events() {
        let root = test_root("queue-events-without-generation");
        initialize_usage_storage_at(&root).unwrap();
        let config = GuiConfigFile::default();
        let inserted = persist_queue_items_from_source(
            &root,
            HTTP_USAGE_QUEUE_SOURCE,
            vec![
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:00+08:00",
                    "request_id": "cherry-health-check",
                    "generate": false,
                    "failed": false,
                    "provider": "openai",
                    "model": "gpt-test",
                    "endpoint": "POST /v1/chat/completions",
                    "tokens": {
                        "input_tokens": 1,
                        "output_tokens": 1,
                        "total_tokens": 2
                    }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:01+08:00",
                    "request_id": "websocket-zero-token",
                    "failed": false,
                    "provider": "codex",
                    "model": "gpt-test",
                    "executor_type": "CodexWebsocketsExecutor",
                    "tokens": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "total_tokens": 0
                    }
                }),
            ],
            &config,
        )
        .unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let events = load_usage_events(
            &connection,
            &UsageQuery {
                failed: Some(false),
                ..UsageQuery::default()
            },
            &config,
        )
        .unwrap();

        assert_eq!(inserted.inserted, 2);
        assert_eq!(events.total, 2);
        assert!(events.items.iter().all(|event| !event.failed));
        assert!(events
            .items
            .iter()
            .any(|event| event.request_id == "cherry-health-check"));
        assert!(events
            .items
            .iter()
            .any(|event| event.request_id == "websocket-zero-token"));
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persists_failure_details_and_excludes_client_cancellations_from_failures() {
        let root = test_root("usage-failure-details");
        initialize_usage_storage_at(&root).unwrap();
        let config = GuiConfigFile::default();
        persist_queue_items_from_source(
            &root,
            HTTP_USAGE_QUEUE_SOURCE,
            vec![
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:00+08:00",
                    "request_id": "success",
                    "failed": false,
                    "provider": "antigravity",
                    "model": "gemini-test"
                }),
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:01+08:00",
                    "request_id": "upstream-failure",
                    "failed": true,
                    "provider": "antigravity",
                    "model": "gemini-test",
                    "fail": {
                        "status_code": 429,
                        "body": { "error": { "message": "quota exhausted" } }
                    }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-29T10:00:02+08:00",
                    "request_id": "client-canceled",
                    "failed": true,
                    "provider": "antigravity",
                    "model": "gemini-test",
                    "fail": {
                        "status_code": 499,
                        "body": "context canceled"
                    }
                }),
            ],
            &config,
        )
        .unwrap();

        let connection = open_usage_database_at(&root).unwrap();
        let overview = load_usage_overview(&connection, &UsageQuery::default()).unwrap();
        let failures = load_usage_events(
            &connection,
            &UsageQuery {
                failed: Some(true),
                ..UsageQuery::default()
            },
            &config,
        )
        .unwrap();
        let cancellations = load_usage_events(
            &connection,
            &UsageQuery {
                canceled: Some(true),
                ..UsageQuery::default()
            },
            &config,
        )
        .unwrap();

        assert_eq!(overview.total_requests, 3);
        assert_eq!(overview.success_count, 1);
        assert_eq!(overview.failure_count, 1);
        assert_eq!(overview.canceled_count, 1);
        assert_eq!(overview.success_rate, 50.0);
        assert_eq!(failures.total, 1);
        assert_eq!(failures.items[0].request_id, "upstream-failure");
        assert_eq!(failures.items[0].failure_status, 429);
        assert!(failures.items[0].failure_body.contains("quota exhausted"));
        assert_eq!(cancellations.total, 1);
        assert_eq!(cancellations.items[0].request_id, "client-canceled");
        assert!(cancellations.items[0].canceled);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sqlite_storage_uses_wal_and_reference_busy_timeout() {
        let root = test_root("sqlite-pragmas");
        let connection = open_test_database(&root);
        let journal_mode = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap();
        let busy_timeout = connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get::<_, i64>(0))
            .unwrap();
        let foreign_keys = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
            .unwrap();

        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(busy_timeout, 5_000);
        assert_eq!(foreign_keys, 1);
        assert!(root.join(USAGE_DATABASE_FILE).is_file());
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_v2_database_is_backed_up_and_migrated_once() {
        let root = test_root("keeper-v3-migration");
        let connection = create_legacy_v2_database(&root);
        connection
            .execute(
                r#"
                INSERT INTO usage_events (
                    event_key, timestamp, timestamp_ms, local_hour, latency_ms, ttft_ms,
                    source, auth_index, failed, provider, model, alias, reasoning_effort,
                    service_tier, response_service_tier, executor_type, endpoint, auth_type,
                    api_key_hash, api_key_display, api_key_remark, request_id,
                    input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
                    cache_creation_tokens, total_tokens, created_at
                ) VALUES (
                    'request-1', '2026-07-17T20:30:00+08:00', 1784291400000,
                    '2026-07-17-20', 100, 20, 'source', 'auth', 0, 'openai',
                    'gpt-test', 'alias-test', 'high', '', '', '',
                    'POST /v1/responses', 'oauth', 'legacy-hash', '12••••',
                    'Legacy key', 'request-1', 10, 20, 5, 2, 3, 30,
                    '2026-07-17T20:30:01+08:00'
                )
                "#,
                [],
            )
            .unwrap();
        drop(connection);

        initialize_usage_storage_at(&root).unwrap();
        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let user_version = connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap();
        let response_model_column = usage_table_columns(&connection, "usage_events")
            .unwrap()
            .contains("response_model");
        let migrated = connection
            .query_row(
                r#"
                SELECT COUNT(*), SUM(total_tokens), api_group_key, model_alias,
                       cached_tokens, collector_source
                FROM usage_events
                "#,
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap();
        let marker = connection
            .query_row(
                "SELECT value FROM usage_metadata WHERE key = ?1",
                params![USAGE_DATABASE_MIGRATION_KEY],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let backups = fs::read_dir(root.join(USAGE_BACKUP_DIR_NAME))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(user_version, USAGE_DATABASE_SCHEMA_VERSION);
        assert!(response_model_column);
        assert_eq!(migrated.0, 1);
        assert_eq!(migrated.1, 30);
        assert_eq!(migrated.2, "legacy-hash");
        assert_eq!(migrated.3.as_deref(), Some("alias-test"));
        assert_eq!(migrated.4, 5);
        assert_eq!(migrated.5, "legacy_migration");
        assert!(!marker.is_empty());
        assert_eq!(backups.len(), 1);

        let duplicate_inserted = connection
            .execute(
                r#"
                INSERT INTO usage_events (
                    event_key, timestamp, timestamp_ms, local_hour, created_at
                ) VALUES (
                    'request-1', '2026-07-17T20:31:00+08:00', 1784291460000,
                    '2026-07-17-20', '2026-07-17T20:31:01+08:00'
                )
                "#,
                [],
            )
            .unwrap();
        assert_eq!(duplicate_inserted, 1);
        let duplicate_count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_events WHERE event_key = 'request-1'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(duplicate_count, 2);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failure_detail_migration_backfills_processed_inbox_rows_once() {
        let root = test_root("failure-detail-v4-migration");
        let mut connection = open_test_database(&root);
        let mut record = sample_record(
            "legacy-canceled",
            "2026-07-17T20:30:00+08:00",
            "gemini-test",
        );
        record.failed = true;
        insert_usage_records(&mut connection, &[record]).unwrap();
        connection
            .execute(
                r#"
                INSERT INTO usage_inbox (
                    source, message_hash, raw_message, status, attempt_count,
                    usage_event_key, received_at, processed_at, created_at, updated_at
                ) VALUES (
                    'test', 'legacy-canceled-hash', ?1, 'processed', 1,
                    'legacy-canceled', ?2, ?2, ?2, ?2
                )
                "#,
                params![
                    serde_json::json!({
                        "request_id": "legacy-canceled",
                        "failed": true,
                        "fail": {
                            "status_code": 499,
                            "body": "client closed request"
                        }
                    })
                    .to_string(),
                    Local::now().to_rfc3339(),
                ],
            )
            .unwrap();
        connection
            .execute(
                "DELETE FROM usage_metadata WHERE key = ?1",
                params![USAGE_FAILURE_MIGRATION_KEY],
            )
            .unwrap();
        drop(connection);

        initialize_usage_storage_at(&root).unwrap();
        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let migrated = connection
            .query_row(
                r#"
                SELECT canceled, failure_status, failure_body
                FROM usage_events
                WHERE event_key = 'legacy-canceled'
                "#,
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        let markers = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_metadata WHERE key = ?1",
                params![USAGE_FAILURE_MIGRATION_KEY],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();

        assert_eq!(migrated.0, 1);
        assert_eq!(migrated.1, 499);
        assert_eq!(migrated.2, "client closed request");
        assert_eq!(markers, 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_inbox_recovers_valid_rows_and_isolates_malformed_rows() {
        let root = test_root("durable-inbox");
        initialize_usage_storage_at(&root).unwrap();
        let mut connection = open_usage_database_at(&root).unwrap();
        enqueue_usage_queue_items(
            &mut connection,
            "http_pull",
            vec![
                serde_json::json!({
                    "timestamp": "2026-07-17T20:30:00+08:00",
                    "request_id": "request-1",
                    "model": "gpt-test",
                    "tokens": { "input_tokens": 10, "output_tokens": 20 }
                }),
                serde_json::json!("not-an-object"),
            ],
        )
        .unwrap();
        drop(connection);

        let mut connection = open_usage_database_at(&root).unwrap();
        let inserted = process_usage_inbox(&mut connection, &GuiConfigFile::default()).unwrap();
        let event_count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let processed_count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_inbox WHERE status = 'processed'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        let failed_count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_inbox WHERE status = 'decode_failed'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();

        assert_eq!(inserted.inserted, 1);
        assert_eq!(event_count, 1);
        assert_eq!(processed_count, 1);
        assert_eq!(failed_count, 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn durable_inbox_preserves_multiple_events_with_same_request_id() {
        let root = test_root("durable-inbox-duplicate-request-id");
        initialize_usage_storage_at(&root).unwrap();
        let mut connection = open_usage_database_at(&root).unwrap();
        enqueue_usage_queue_items(
            &mut connection,
            "redis_subscribe:usage",
            vec![
                serde_json::json!({
                    "timestamp": "2026-07-17T20:30:00+08:00",
                    "request_id": "persistent-connection",
                    "model": "gpt-first",
                    "tokens": { "input_tokens": 10, "output_tokens": 20, "total_tokens": 30 }
                }),
                serde_json::json!({
                    "timestamp": "2026-07-17T20:31:00+08:00",
                    "request_id": "persistent-connection",
                    "model": "gpt-second",
                    "tokens": { "input_tokens": 30, "output_tokens": 40, "total_tokens": 70 }
                }),
            ],
        )
        .unwrap();

        let inserted = process_usage_inbox(&mut connection, &GuiConfigFile::default()).unwrap();
        assert_eq!(inserted.inserted, 2);
        let event_count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(event_count, 2);

        let rows = {
            let mut statement = connection
                .prepare("SELECT event_key, model, total_tokens FROM usage_events ORDER BY id")
                .unwrap();
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(
            rows,
            vec![
                (
                    "persistent-connection".to_string(),
                    "gpt-first".to_string(),
                    30
                ),
                (
                    "persistent-connection".to_string(),
                    "gpt-second".to_string(),
                    70
                ),
            ]
        );

        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inbox_cleanup_preserves_pending_and_recent_failure_rows() {
        let root = test_root("inbox-cleanup");
        let connection = open_test_database(&root);
        let now = Local::now();
        let old_processed = (now - chrono::Duration::days(1)).to_rfc3339();
        let recent_failure = (now - chrono::Duration::days(1)).to_rfc3339();
        let old_failure = (now - chrono::Duration::days(8)).to_rfc3339();
        for (status, processed_at, updated_at) in [
            (
                "processed",
                Some(old_processed.as_str()),
                old_processed.as_str(),
            ),
            ("pending", None, old_failure.as_str()),
            (
                "decode_failed",
                Some(recent_failure.as_str()),
                recent_failure.as_str(),
            ),
            (
                "discarded",
                Some(old_failure.as_str()),
                old_failure.as_str(),
            ),
        ] {
            connection
                .execute(
                    r#"
                    INSERT INTO usage_inbox (
                        source, message_hash, raw_message, status, attempt_count,
                        received_at, processed_at, created_at, updated_at
                    ) VALUES ('test', 'hash', '{}', ?1, 0, ?3, ?2, ?3, ?3)
                    "#,
                    params![status, processed_at, updated_at],
                )
                .unwrap();
        }

        cleanup_usage_inbox(&connection, now).unwrap();
        let statuses = {
            let mut statement = connection
                .prepare("SELECT status FROM usage_inbox ORDER BY id")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };

        assert_eq!(statuses, vec!["pending", "decode_failed"]);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sqlite_storage_preserves_duplicate_event_keys_transactionally() {
        let root = test_root("sqlite-duplicate-event-keys");
        let mut connection = open_test_database(&root);
        let first = sample_record("request-1", "2026-07-17T20:30:00+08:00", "gpt-test");
        let second = sample_record("request-1", "2026-07-17T20:31:00+08:00", "gpt-test-updated");

        assert_eq!(
            insert_usage_records(&mut connection, std::slice::from_ref(&first)).unwrap(),
            1
        );
        assert_eq!(insert_usage_records(&mut connection, &[second]).unwrap(), 1);
        let count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();

        assert_eq!(count, 2);
        let events = load_usage_events(
            &connection,
            &UsageQuery::default(),
            &GuiConfigFile::default(),
        )
        .unwrap();
        assert_eq!(events.items.len(), 2);
        assert_eq!(events.items[0].id, events.items[1].id);
        assert_ne!(events.items[0].row_id, events.items[1].row_id);
        let serialized = serde_json::to_value(&events).unwrap();
        assert!(serialized["items"][0]["row_id"].as_str().is_some());
        assert_ne!(
            serialized["items"][0]["row_id"],
            serialized["items"][1]["row_id"]
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn current_v3_database_migrates_unique_event_key_without_losing_rows() {
        let root = test_root("event-key-v5-migration");
        let mut connection = open_test_database(&root);
        let table_sql = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let indexes = {
            let mut statement = connection
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_events'")
                .unwrap();
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        for index in indexes {
            connection
                .execute(
                    &format!("DROP INDEX {}", quote_sqlite_identifier(&index)),
                    [],
                )
                .unwrap();
        }
        connection
            .execute(
                "ALTER TABLE usage_events RENAME TO usage_events_previous",
                [],
            )
            .unwrap();
        let unique_table_sql = replace_sql_fragment_case_insensitive(
            &table_sql,
            "event_key TEXT NOT NULL,",
            "event_key TEXT NOT NULL UNIQUE,",
        )
        .unwrap();
        connection.execute_batch(&unique_table_sql).unwrap();
        connection
            .execute("DROP TABLE usage_events_previous", [])
            .unwrap();

        migrate_usage_database(&mut connection, &root).unwrap();
        connection
            .execute(
                "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, created_at) VALUES ('persistent', '2026-07-17T20:30:00+08:00', 1, '2026-07-17-20', '2026-07-17T20:30:00+08:00'), ('persistent', '2026-07-17T20:31:00+08:00', 2, '2026-07-17-20', '2026-07-17T20:31:00+08:00')",
                [],
            )
            .unwrap();
        let count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_events WHERE event_key = 'persistent'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM usage_metadata WHERE key = ?1",
                    params![USAGE_EVENT_KEY_MIGRATION_KEY],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_hour_and_inbox_json_are_migrated_once() {
        let root = test_root("legacy-migration");
        let events_dir = root.join(LEGACY_USAGE_EVENTS_DIR);
        let inbox_dir = root.join(LEGACY_USAGE_INBOX_DIR);
        fs::create_dir_all(&events_dir).unwrap();
        fs::create_dir_all(&inbox_dir).unwrap();
        let mut first = serde_json::to_value(sample_record(
            "request-1",
            "2026-07-17T20:30:00+08:00",
            "gpt-a",
        ))
        .unwrap();
        first.as_object_mut().unwrap().remove("response_model");
        let mut second = sample_record("request-2", "2026-07-17T20:31:00+08:00", "gpt-b");
        second.response_model = "gpt-b-upstream".to_string();
        fs::write(
            events_dir.join("2026-07-17-20.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": USAGE_SCHEMA_VERSION,
                "hour": "2026-07-17-20",
                "timezone": "+08:00",
                "records": [first]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            inbox_dir.join("pending.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": USAGE_SCHEMA_VERSION,
                "records": [second]
            }))
            .unwrap(),
        )
        .unwrap();

        initialize_usage_storage_at(&root).unwrap();
        initialize_usage_storage_at(&root).unwrap();
        let connection = open_usage_database_at(&root).unwrap();
        let count = connection
            .query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let marker = connection
            .query_row(
                "SELECT value FROM usage_metadata WHERE key = ?1",
                params![LEGACY_JSON_MIGRATION_KEY],
                |row| row.get::<_, String>(0),
            )
            .unwrap();

        assert_eq!(count, 2);
        assert_eq!(marker, "2");
        let page = load_usage_events(
            &connection,
            &UsageQuery::default(),
            &GuiConfigFile::default(),
        )
        .unwrap();
        assert_eq!(page.items[0].response_model, "gpt-b-upstream");
        assert!(page.items[1].response_model.is_empty());
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sqlite_queries_filter_aggregate_and_paginate() {
        let root = test_root("sqlite-query");
        let mut connection = open_test_database(&root);
        let success = sample_record("request-1", "2026-07-17T20:30:00+08:00", "gpt-a");
        let mut failed = sample_record("request-2", "2026-07-17T21:30:00+08:00", "gpt-5.6-terra");
        failed.failed = true;
        insert_usage_records(&mut connection, &[success, failed]).unwrap();
        let query = UsageQuery {
            model: Some("GPT-5.6-TERRA".to_string()),
            failed: Some(true),
            page_size: Some(20),
            ..UsageQuery::default()
        };

        let overview = load_usage_overview(&connection, &query).unwrap();
        let config = GuiConfigFile::default();
        let analysis = load_usage_analysis(&connection, &query, &config).unwrap();
        let events = load_usage_events(&connection, &query, &config).unwrap();

        assert_eq!(overview.total_requests, 1);
        assert_eq!(overview.failure_count, 1);
        assert_eq!(overview.tps, 0.0);
        assert_eq!(overview.tps_sample_count, 0);
        assert_eq!(overview.cache_hit_rate, 0.2);
        assert!((overview.estimated_cost - 0.0002564).abs() < 0.0000001);
        assert_eq!(overview.priced_requests, 1);
        assert_eq!(overview.timeline.len(), 1);
        assert_eq!(overview.timeline[0].models.len(), 1);
        assert_eq!(overview.timeline[0].models[0].key, "gpt-5.6-terra");
        assert!(overview.timeline[0].tokens > 0);
        assert_eq!(analysis.models[0].key, "gpt-5.6-terra");
        assert_eq!(events.total, 1);
        assert_eq!(events.items[0].id, "request-2");
        let exported = load_usage_events(
            &connection,
            &UsageQuery { page_size: Some(5_000), ..query },
            &config,
        ).unwrap();
        assert_eq!(exported.page_size, 5_000);
        assert_eq!(exported.items.len(), 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn timeline_groups_requests_into_half_hour_buckets() {
        let root = test_root("sqlite-half-hour");
        let mut connection = open_test_database(&root);
        let first = sample_record("half-1", "2026-07-17T20:10:00+08:00", "gpt-a");
        let second = sample_record("half-2", "2026-07-17T20:40:00+08:00", "gpt-a");
        insert_usage_records(&mut connection, &[first, second]).unwrap();

        let overview = load_usage_overview(&connection, &UsageQuery::default()).unwrap();
        assert_eq!(overview.timeline.len(), 2);
        assert_ne!(overview.timeline[0].hour, overview.timeline[1].hour);
        assert!(overview
            .timeline
            .iter()
            .all(|point| point.hour.ends_with("-00") || point.hour.ends_with("-30")));
        assert_eq!(overview.timeline.iter().map(|point| point.requests).sum::<u64>(), 2);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn overview_tps_averages_request_speeds_without_requiring_ttft() {
        let root = test_root("tps-overview");
        let mut connection = open_test_database(&root);

        let mut first = sample_record("tps-1", "2026-07-17T20:30:00+08:00", "gpt-a");
        first.latency_ms = 1_000;
        first.ttft_ms = Some(200);
        first.tokens.output_tokens = 80;

        let mut second = sample_record("tps-2", "2026-07-17T20:31:00+08:00", "gpt-a");
        second.latency_ms = 2_000;
        second.ttft_ms = Some(1_000);
        second.tokens.output_tokens = 20;

        let mut missing_ttft = sample_record("tps-3", "2026-07-17T20:32:00+08:00", "gpt-a");
        missing_ttft.latency_ms = 500;
        missing_ttft.ttft_ms = None;
        missing_ttft.tokens.output_tokens = 100;

        let mut equal_latency = sample_record("tps-4", "2026-07-17T20:33:00+08:00", "gpt-a");
        equal_latency.latency_ms = 500;
        equal_latency.ttft_ms = Some(500);
        equal_latency.tokens.output_tokens = 100;

        let mut failed = sample_record("tps-5", "2026-07-17T20:34:00+08:00", "gpt-a");
        failed.failed = true;
        failed.tokens.output_tokens = 100;

        let mut canceled = sample_record("tps-6", "2026-07-17T20:35:00+08:00", "gpt-a");
        canceled.canceled = true;
        canceled.tokens.output_tokens = 100;

        let mut non_generation = sample_record("tps-7", "2026-07-17T20:36:00+08:00", "gpt-a");
        non_generation.generate = false;
        non_generation.tokens.output_tokens = 100;

        let mut zero_latency = sample_record("tps-8", "2026-07-17T20:37:00+08:00", "gpt-a");
        zero_latency.latency_ms = 0;
        zero_latency.tokens.output_tokens = 100;

        let mut no_output = sample_record("tps-9", "2026-07-17T20:38:00+08:00", "gpt-a");
        no_output.tokens.output_tokens = 0;

        insert_usage_records(
            &mut connection,
            &[
                first,
                second,
                missing_ttft,
                equal_latency,
                failed,
                canceled,
                non_generation,
                zero_latency,
                no_output,
            ],
        )
        .unwrap();

        let overview = load_usage_overview(&connection, &UsageQuery::default()).unwrap();

        assert_eq!(overview.tps, (80.0 + 10.0 + 200.0 + 200.0) / 4.0);
        assert_eq!(overview.tps_sample_count, 4);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn response_model_accepts_manager_plus_field_names() {
        let record = normalize_usage_record(serde_json::json!({
            "request_id": "compatible-models", "requestedModel": "client-alias",
            "resolvedModel": "gpt-6-sol", "model": "display-model",
            "responseModel": " reported-model "
        }), &GuiConfigFile::default()).unwrap();
        assert_eq!(record.alias, "client-alias");
        assert_eq!(record.model, "gpt-6-sol");
        assert_eq!(record.response_model, "reported-model");
    }

    #[test]
    fn request_cost_matches_aggregate_and_recalculates_current_prices() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_usage_schema(&connection).unwrap();
        let mut records = Vec::new();
        for (index, model) in ["gpt-6-sol", "gpt-5.6-terra", "xai/grok-4.7"].iter().enumerate() {
            for input in [200_000, 250_000, 300_000] {
                let mut record = sample_record(&format!("{index}-{input}"), "2026-10-04T00:00:00Z", model);
                record.provider = if index < 2 { "codex" } else { "openai" }.into();
                record.service_tier = "fast".into();
                record.response_service_tier = "flex".into();
                record.tokens.input_tokens = input;
                record.tokens.output_tokens = 500;
                record.tokens.reasoning_tokens = 100;
                record.tokens.cache_read_tokens = 100_000;
                record.tokens.cache_creation_tokens = 1_000;
                record.tokens.total_tokens = input + 500;
                record.response_model = "unpriced-response-must-not-change-billing".into();
                records.push(record);
            }
        }
        records.push(sample_record("unknown-price", "2026-10-04T00:00:00Z", "unpriced-model"));
        insert_usage_records(&mut connection, &records).unwrap();
        let query = UsageQuery::default();
        let page = load_usage_events(&connection, &query, &GuiConfigFile::default()).unwrap();
        let (aggregate, priced) = load_estimated_cost(&connection, &build_usage_filter(&query)).unwrap();
        let total: f64 = page.items.iter().filter_map(|r| r.cost.as_ref().map(|c| c.total)).sum();
        assert!((aggregate - total).abs() < 1e-9);
        assert_eq!(priced, 9);
        assert!(page.items.iter().find(|r| r.id == "unknown-price").unwrap().cost.is_none());

        let free_price = ModelPrice { model: "unpriced-model".into(), prompt_configured: true,
            completion_configured: true, cache_read_configured: true, cache_creation_configured: true,
            source: "manual".into(), ..ModelPrice::default() };
        upsert_model_price(&connection, &free_price).unwrap();
        let updated = load_usage_events(&connection, &query, &GuiConfigFile::default()).unwrap();
        let free = updated.items.iter().find(|r| r.id == "unknown-price").unwrap();
        assert_eq!(free.cost.as_ref().unwrap().total, 0.0);
        let imported: UsageRecord = serde_json::from_value(serde_json::to_value(free).unwrap()).unwrap();
        assert!(imported.cost.is_none(), "Imported estimates must be recomputed");
    }

    #[test]
    fn estimates_gpt56_cost_with_cache_and_service_tier_rules() {
        let terra = official_model_price("openai/gpt-5.6-terra").unwrap();
        let standard_tokens = CostTokens {
            input: 1_000_000,
            output: 1_000_000,
            cache_read: 200_000,
            cache_creation: 100_000,
            ..CostTokens::default()
        };
        let standard = cost_for_price("openai/gpt-5.6-terra", "default", &standard_tokens, &terra);
        assert!((standard - 13.69).abs() < 0.000001);

        let long_tokens = CostTokens {
            input: 300_000,
            output: 200_000,
            cache_read: 100_000,
            long_input: 300_000,
            long_output: 200_000,
            long_cache_read: 100_000,
            ..CostTokens::default()
        };
        let long_priority = cost_for_price("gpt-5.6-terra", "priority", &long_tokens, &terra);
        assert!((long_priority - 4.44).abs() < 0.000001);
        assert!(official_model_price("unpriced-model").is_none());
    }

    #[test]
    fn estimates_gpt6_fast_mode_for_short_and_long_context() {
        let sol = official_model_price("gpt-6-sol").unwrap();
        let short_tokens = CostTokens {
            input: 1_000_000,
            output: 1_000_000,
            ..CostTokens::default()
        };
        assert!(
            (cost_for_price("gpt-6-sol", "fast", &short_tokens, &sol) - 24.0).abs() < 0.000001
        );

        let long_tokens = CostTokens {
            input: 300_000,
            output: 200_000,
            cache_read: 100_000,
            long_input: 300_000,
            long_output: 200_000,
            long_cache_read: 100_000,
            ..CostTokens::default()
        };
        assert!(
            (cost_for_price("gpt-6-sol", "fast", &long_tokens, &sol) - 7.68).abs() < 0.000001
        );
    }

    #[test]
    fn grok_47_uses_200k_threshold_and_doubles_long_context_output_price() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_usage_schema(&connection).unwrap();
        let mut short = sample_record("grok-short", "2026-09-25T00:00:00Z", "grok-4.7");
        short.tokens.input_tokens = 200_000;
        short.tokens.output_tokens = 100_000;
        short.tokens.cache_read_tokens = 0;
        short.tokens.total_tokens = 300_000;
        let mut long = sample_record("grok-long", "2026-09-25T00:00:00Z", "xai/grok-4.7");
        long.tokens.input_tokens = 250_000;
        long.tokens.output_tokens = 100_000;
        long.tokens.cache_read_tokens = 0;
        long.tokens.total_tokens = 350_000;
        insert_usage_records(&mut connection, &[short, long]).unwrap();

        let query = UsageQuery::default();
        let groups = load_usage_cost_groups(&connection, &build_usage_filter(&query)).unwrap();
        assert_eq!(groups.iter().find(|group| group.model == "grok-4.7").unwrap().tokens.long_input, 0);
        assert_eq!(groups.iter().find(|group| group.model == "xai/grok-4.7").unwrap().tokens.long_input, 250_000);
        let pricing = load_usage_pricing(&connection, &query).unwrap();
        assert!((pricing.total_cost - 3.2).abs() < 0.000001);
    }

    #[test]
    fn bundled_model_prices_are_available_offline_and_override_legacy_cloud_cache() {
        let root = test_root("bundled-pricing");
        let connection = open_test_database(&root);
        let bundled = bundled_model_prices().unwrap();
        assert!(bundled.len() >= 50);
        assert!(bundled.values().all(|price| price.source == "builtin"));
        assert_eq!(
            find_model_price(&bundled, "openai/gpt-5.6-terra-high")
                .unwrap()
                .prompt,
            2.0
        );

        upsert_model_price(
            &connection,
            &ModelPrice {
                model: "gpt-5.6-terra".to_string(),
                prompt: 999.0,
                completion: 999.0,
                prompt_configured: true,
                completion_configured: true,
                source: "litellm".to_string(),
                ..ModelPrice::default()
            },
        )
        .unwrap();
        let prices = load_model_prices(&connection).unwrap();
        assert_eq!(prices["gpt-5.6-terra"].prompt, 2.0);
        assert_eq!(prices["gpt-5.6-terra"].source, "builtin");
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn models_dev_sync_uses_first_party_prices_and_preserves_explicit_zero_cache() {
        let catalog = serde_json::json!({
            "openai": { "models": {
                "gpt-6-sol": { "cost": { "input": 2.25, "output": 10.0, "cache_read": 0.0 } },
                "missing-output": { "cost": { "input": 1.0 } }
            } },
            "anthropic": { "models": {} },
            "google": { "models": {} },
            "deepseek": { "models": {} },
            "xai": { "models": {} },
            "openrouter": { "models": {
                "gpt-6-sol": { "cost": { "input": 99.0, "output": 99.0 } }
            } }
        });
        let prices = parse_models_dev_prices(&catalog.to_string(), 123).unwrap();
        assert_eq!(prices.len(), 2);
        let price = prices.iter().find(|price| price.source_model_id == "openai/gpt-6-sol").unwrap();
        assert_eq!(price.model, "gpt-6-sol");
        assert_eq!(price.prompt, 2.25);
        assert_eq!(price.cache_read, 0.0);
        assert!(price.cache_read_configured);
        assert_eq!(price.source, "models.dev");
        assert_eq!(price.source_model_id, "openai/gpt-6-sol");

        let effective = enriched_model_price("gpt-6-sol", price);
        assert_eq!(effective.cache_read, 0.0);
        assert_eq!(effective.cache_creation, 0.0);
    }

    #[test]
    fn price_preview_matches_official_models_without_guessing_dynamic_aliases() {
        let catalog = serde_json::json!({
            "openai": { "models": { "gpt-6-sol": { "cost": { "input": 2.0, "output": 10.0 } } } },
            "google": { "models": { "gpt-6-sol": { "cost": { "input": 90.0, "output": 90.0 } } } }
        });
        let remote = parse_models_dev_prices(&catalog.to_string(), 1).unwrap();
        let models = vec![
            ("gpt-6-sol".to_string(), String::new()),
            ("gpt-daybreak-blue-latest".to_string(), String::new()),
            ("my-alias".to_string(), "gpt-6-sol".to_string()),
        ];
        let preview = build_model_price_preview(&models, &remote, "Models.dev", MODEL_PRICE_SYNC_URL);
        assert_eq!(preview.matches.len(), 2);
        assert_eq!(preview.matches[0].prompt, 2.0);
        assert_eq!(preview.matches[0].source_model_id, "openai/gpt-6-sol");
        assert_eq!(preview.matches[1].model, "my-alias");
        assert_eq!(preview.unmatched, ["gpt-daybreak-blue-latest"]);
    }

    #[test]
    fn price_preview_uses_usage_alias_for_models_with_existing_prices() {
        let root = test_root("price-preview-existing-alias");
        let connection = open_test_database(&root);
        upsert_model_price(
            &connection,
            &ModelPrice {
                model: "my-alias".to_string(),
                prompt: 1.0,
                completion: 2.0,
                source: "manual".to_string(),
                ..ModelPrice::default()
            },
        )
        .unwrap();
        connection
            .execute(
                "INSERT INTO usage_events (event_key, timestamp, timestamp_ms, local_hour, model, alias, created_at) VALUES ('preview-alias', '2026-09-24T00:00:00Z', 1, '2026-09-24T00', 'my-alias', 'gpt-6-sol', '2026-09-24T00:00:00Z')",
                [],
            )
            .unwrap();

        let models = collect_price_preview_models(&connection, &UsageQuery::default()).unwrap();
        let remote = parse_models_dev_prices(
            &serde_json::json!({
                "openai": { "models": { "gpt-6-sol": { "cost": { "input": 2.0, "output": 10.0 } } } }
            })
            .to_string(),
            1,
        )
        .unwrap();
        let preview =
            build_model_price_preview(&models, &remote, "Models.dev", MODEL_PRICE_SYNC_URL);
        let matched = preview
            .matches
            .iter()
            .find(|price| price.model == "my-alias")
            .unwrap();
        assert_eq!(matched.source_model_id, "openai/gpt-6-sol");
        assert!(!preview.unmatched.contains(&"my-alias".to_string()));

        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn litellm_preview_reads_only_base_text_token_prices() {
        let catalog = serde_json::json!({
            "openai/test": {
                "mode": "chat", "input_cost_per_token": 0.000002,
                "output_cost_per_token": 0.000010,
                "cache_read_input_token_cost": 0.0,
                "input_cost_per_token_above_200k_tokens": 0.000004
            },
            "audio/test": {
                "mode": "chat", "supported_output_modalities": ["audio"],
                "input_cost_per_token": 0.000002, "output_cost_per_token": 0.000010
            }
        });
        let prices = parse_litellm_prices(&catalog.to_string(), 1).unwrap();
        assert_eq!(prices.len(), 1);
        assert_eq!(prices[0].prompt, 2.0);
        assert_eq!(prices[0].completion, 10.0);
        assert!(prices[0].cache_read_configured);
        assert_eq!(prices[0].cache_read, 0.0);
    }

    #[tokio::test]
    async fn price_catalog_retries_after_truncated_body_and_decodes_gzip() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api.json", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            std::io::Write::write_all(&mut encoder, b"{}").unwrap();
            let compressed = encoder.finish().unwrap();
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 2048];
                let size = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..size]).to_ascii_lowercase();
                assert!(request.contains("accept-encoding: gzip"));
                if attempt == 0 {
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{}").await.unwrap();
                } else {
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Encoding: gzip\r\nConnection: close\r\n\r\n",
                        compressed.len()
                    );
                    stream.write_all(header.as_bytes()).await.unwrap();
                    stream.write_all(&compressed).await.unwrap();
                }
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let content = tokio::time::timeout(
            Duration::from_secs(5),
            fetch_model_price_catalog(&client, "test", &url),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(content, "{}");
        server.await.unwrap();
    }

    #[test]
    fn pricing_uses_original_model_then_manual_fallback_without_prefix_guessing() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_usage_schema(&connection).unwrap();
        for model in ["gpt-6-sol", "my-alias", "claude-sonnet-5-5"] {
            upsert_model_price(&connection, &ModelPrice {
                model: model.into(),
                prompt: 99.0,
                completion: 99.0,
                prompt_configured: true,
                completion_configured: true,
                source: "manual".into(),
                ..ModelPrice::default()
            }).unwrap();
        }
        let prices = load_model_prices(&connection).unwrap();
        let (_, original) = resolve_model_price("openai/GPT-6-SOL", "my-alias", &prices).unwrap();
        assert_eq!(original.source, "builtin");
        assert_eq!(original.prompt, 2.0);
        let (_, manual) = resolve_model_price("unknown-model", "my-alias", &prices).unwrap();
        assert_eq!(manual.source, "manual");
        assert_eq!(manual.model, "my-alias");
        let (_, manual_original) = resolve_model_price("claude-sonnet-5-5", "my-alias", &prices).unwrap();
        assert_eq!(manual_original.model, "claude-sonnet-5-5");
        assert_eq!(manual_original.prompt, 99.0);
        assert!(resolve_model_price("unknown-model", "gpt-6-astra", &prices).is_none());
        assert!(resolve_model_price("claude-sonnet-5-unknown", "", &prices).is_none());
        assert!(resolve_model_price("unknown-model", "my-alias-extra", &prices).is_none());

        let mut records = Vec::new();
        for (id, model, alias) in [
            ("original", "gpt-6-sol", "my-alias"),
            ("manual", "unknown-model", "my-alias"),
            ("unpriced", "unknown-model", "gpt-6-astra"),
        ] {
            let mut record = sample_record(id, "2026-10-04T00:00:00Z", model);
            record.alias = alias.into();
            records.push(record);
        }
        insert_usage_records(&mut connection, &records).unwrap();
        let query = UsageQuery::default();
        let page = load_usage_events(&connection, &query, &GuiConfigFile::default()).unwrap();
        assert_eq!(page.items.iter().find(|r| r.id == "original").unwrap().cost.as_ref().unwrap().pricing_model, "gpt-6-sol");
        assert_eq!(page.items.iter().find(|r| r.id == "manual").unwrap().cost.as_ref().unwrap().pricing_model, "my-alias");
        assert!(page.items.iter().find(|r| r.id == "unpriced").unwrap().cost.is_none());
        let total: f64 = page.items.iter().filter_map(|r| r.cost.as_ref().map(|c| c.total)).sum();
        let overview = load_usage_overview(&connection, &query).unwrap();
        let pricing = load_usage_pricing(&connection, &query).unwrap();
        assert_eq!(overview.priced_requests, 2);
        assert_eq!(pricing.priced_requests, 2);
        assert!((overview.estimated_cost - total).abs() < 1e-9);
        assert!((pricing.total_cost - total).abs() < 1e-9);
    }

    #[test]
    fn manual_model_prices_drive_pricing_and_overview_cost() {
        let root = test_root("manual-pricing");
        let mut connection = open_test_database(&root);
        let record = sample_record("request-1", "2026-07-17T20:30:00+08:00", "custom-model");
        insert_usage_records(&mut connection, &[record]).unwrap();
        upsert_model_price(
            &connection,
            &ModelPrice {
                model: "custom-model".to_string(),
                prompt: 1.0,
                completion: 2.0,
                cache_read: 0.1,
                cache_read_configured: true,
                prompt_configured: true,
                completion_configured: true,
                source: "manual".to_string(),
                ..ModelPrice::default()
            },
        )
        .unwrap();

        let query = UsageQuery::default();
        let overview = load_usage_overview(&connection, &query).unwrap();
        let pricing = load_usage_pricing(&connection, &query).unwrap();

        assert!((overview.estimated_cost - 0.0000482).abs() < 0.0000001);
        assert_eq!(overview.priced_requests, 1);
        assert!((pricing.total_cost - overview.estimated_cost).abs() < f64::EPSILON);
        assert_eq!(pricing.rows[0].model, "custom-model");
        assert_eq!(
            pricing.saved_prices,
            bundled_model_prices().unwrap().len() + 1
        );
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_cache_prices_stay_zero_even_with_builtin_and_legacy_prices() {
        let root = test_root("zero-cache-pricing");
        let connection = open_test_database(&root);
        upsert_model_price(
            &connection,
            &ModelPrice {
                model: "gpt-6-sol".to_string(),
                prompt: 2.0,
                completion: 10.0,
                prompt_configured: true,
                completion_configured: true,
                source: "manual".to_string(),
                ..ModelPrice::default()
            },
        )
        .unwrap();
        connection
            .execute("UPDATE model_prices SET cache_per_1m = 99 WHERE model = 'gpt-6-sol'", [])
            .unwrap();
        let price = load_model_prices(&connection).unwrap().remove("gpt-6-sol").unwrap();
        assert_eq!(price.cache_read, 0.0);
        assert_eq!(price.cache_creation, 0.0);
        let tokens = CostTokens {
            input: 200_000,
            cache_read: 100_000,
            cache_creation: 100_000,
            ..CostTokens::default()
        };
        assert_eq!(cost_for_price("gpt-6-sol", "", &tokens, &price), 0.0);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    fn remote_usage_test_config(origin: &str) -> GuiConfigFile {
        GuiConfigFile {
            connection_mode: CoreConnectionMode::Remote,
            remote_management_origin: origin.to_string(),
            remote_management_key: "fixture-management".to_string(),
            remote_client_origin: origin.to_string(),
            remote_client_key: "fixture-client".to_string(),
            ..GuiConfigFile::default()
        }
    }

    fn remote_usage_test_config_with_key(origin: &str, management_key: &str) -> GuiConfigFile {
        GuiConfigFile {
            remote_management_key: management_key.to_string(),
            ..remote_usage_test_config(origin)
        }
    }

    #[tokio::test]
    async fn remote_usage_pop_targets_management_queue_endpoint_with_management_key() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = [0; 8192];
            let count = stream.read(&mut data).unwrap();
            let request = String::from_utf8_lossy(&data[..count]);
            assert!(
                request.starts_with("GET /v8/management/observability/usage/queue?count="),
                "unexpected request line: {request}"
            );
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer fixture-management"));
            assert!(!request.contains("fixture-client"));
            let body = r#"[{"request_id":"remote-1","provider":"codex","model":"gpt-test"}]"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                )
                .unwrap();
        });
        let config = remote_usage_test_config(&origin);
        let messages = fetch_remote_usage_queue(&config).await.unwrap();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("remote-1"));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn remote_usage_pop_classifies_definite_and_uncertain_failures() {
        use std::io::{Read, Write};
        for (status, body, uncertain) in [
            (401, "denied", false),
            (403, "denied", false),
            (404, "missing", false),
            (500, "boom", true),
            (502, "boom", true),
            (200, "<html>not json</html>", true),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 8192];
                let _ = stream.read(&mut request).unwrap();
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .unwrap();
            });
            let config = remote_usage_test_config(&origin);
            let error = fetch_remote_usage_queue(&config).await.err().unwrap();
            match error {
                RemotePopError::Uncertain(message) => {
                    assert!(uncertain, "HTTP {status} should be definite, got {message}")
                }
                RemotePopError::Definite(message) => {
                    assert!(
                        !uncertain,
                        "HTTP {status} should be uncertain, got {message}"
                    )
                }
            }
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn remote_usage_pop_connect_failure_is_definite_and_safe_to_retry() {
        let config = remote_usage_test_config("http://127.0.0.1:1");
        match fetch_remote_usage_queue(&config).await.err().unwrap() {
            RemotePopError::Definite(_) => {}
            RemotePopError::Uncertain(message) => {
                panic!("an unreachable core never popped records; expected definite, got {message}")
            }
        }
    }

    #[tokio::test]
    async fn remote_usage_readiness_probes_management_config_with_management_key() {
        use std::io::{Read, Write};
        for (status, expected_ok) in [(200, true), (401, false), (500, false)] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut data = [0; 8192];
                let count = stream.read(&mut data).unwrap();
                let request = String::from_utf8_lossy(&data[..count]);
                assert!(request.starts_with("GET /v8/management/config "));
                assert!(request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer fixture-management"));
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 {status} Fixture\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                        )
                        .as_bytes(),
                    )
                    .unwrap();
            });
            let config = remote_usage_test_config(&origin);
            assert_eq!(remote_core_readiness(&config).await.is_ok(), expected_ok);
            server.join().unwrap();
        }
    }

    #[test]
    fn remote_and_local_usage_roots_never_share_a_namespace() {
        let base = test_root("usage-namespace");
        let local = GuiConfigFile::default();
        let remote_a = remote_usage_test_config("http://core-a.invalid:8317");
        let remote_a_rotated =
            remote_usage_test_config_with_key("http://core-a.invalid:8317", "rotated");
        let remote_b = remote_usage_test_config("http://core-b.invalid:8317");

        let local_root = usage_root_dir_for_at(&base, &local).unwrap();
        let root_a = usage_root_dir_for_at(&base, &remote_a).unwrap();
        let root_a_rotated = usage_root_dir_for_at(&base, &remote_a_rotated).unwrap();
        let root_b = usage_root_dir_for_at(&base, &remote_b).unwrap();

        assert_eq!(local_root, base.join(USAGE_DIR_NAME));
        assert_ne!(local_root, root_a);
        assert_ne!(root_a, root_b);
        // Rotating the management key keeps the same core's history.
        assert_eq!(root_a, root_a_rotated);
        assert!(root_a.starts_with(base.join(USAGE_DIR_NAME).join(REMOTE_USAGE_DIR_NAME)));

        initialize_usage_storage_at(&local_root).unwrap();
        initialize_usage_storage_at(&root_a).unwrap();
        initialize_usage_storage_at(&root_b).unwrap();
        let config = GuiConfigFile::default();
        let inserted_local = persist_queue_items_from_source(
            &local_root,
            HTTP_USAGE_QUEUE_SOURCE,
            vec![serde_json::json!({"request_id": "local-1", "provider": "codex", "model": "gpt-test"})],
            &config,
        )
        .unwrap();
        let inserted_remote = persist_queue_items_from_source(
            &root_a,
            HTTP_USAGE_QUEUE_SOURCE,
            vec![serde_json::json!({"request_id": "remote-1", "provider": "codex", "model": "gpt-test"})],
            &config,
        )
        .unwrap();
        assert_eq!(inserted_local.inserted, 1);
        assert_eq!(inserted_remote.inserted, 1);
        assert_eq!(total_usage_records_at(&local_root).unwrap(), 1);
        assert_eq!(total_usage_records_at(&root_a).unwrap(), 1);
        // A second remote core stays untouched by the first core's records.
        assert_eq!(total_usage_records_at(&root_b).unwrap(), 0);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn usage_connection_key_tracks_mode_revision_and_credentials() {
        let local = GuiConfigFile::default();
        let remote = remote_usage_test_config("http://core-a.invalid:8317");
        assert_ne!(usage_connection_key(&local), usage_connection_key(&remote));

        let mut bumped = remote.clone();
        bumped.target_revision += 1;
        assert_ne!(usage_connection_key(&remote), usage_connection_key(&bumped));

        let mut rotated = remote.clone();
        rotated.remote_management_key = "rotated".to_string();
        assert_ne!(
            usage_connection_key(&remote),
            usage_connection_key(&rotated)
        );

        let mut switched = remote.clone();
        switched.remote_management_origin = "http://core-b.invalid:8317".to_string();
        assert_ne!(
            usage_connection_key(&remote),
            usage_connection_key(&switched)
        );
    }

    #[test]
    fn collector_status_hides_unapplied_target_status_and_history() {
        let state = UsageCollectorState::default();
        let local = GuiConfigFile::default();
        state.set_connection(&usage_connection_key(&local), "local", None, 0);
        state.set_total_records(7);
        let mut with_history = state.status().unwrap();
        with_history.last_collected_at = Some("2020-01-01T00:00:00Z".to_string());
        with_history.message = "collected for the old target".to_string();
        state.set_status(with_history);

        let applied = state.status_for(&local).unwrap();
        assert_eq!(applied.connection_mode, "local");
        assert_eq!(applied.total_records, 7);
        assert!(!applied.paused);
        assert!(!applied.destructive_pop);

        // Switching to a remote target before the collector applies it must not
        // report the previous target's totals or history.
        let remote = remote_usage_test_config("http://core-a.invalid:8317");
        let switching = state.status_for(&remote).unwrap();
        assert_eq!(switching.connection_mode, "remote");
        assert_eq!(
            switching.remote_origin.as_deref(),
            Some("http://core-a.invalid:8317")
        );
        assert_eq!(switching.total_records, 0);
        assert_eq!(switching.last_collected_at, None);
        assert!(switching.destructive_pop);
        assert_eq!(switching.state, "waiting-core");

        state.set_total_records(0);
        state.set_connection(
            &usage_connection_key(&remote),
            "remote",
            Some(remote.remote_management_origin.clone()),
            remote.target_revision,
        );
        state.set_paused(true);
        let paused = state.status_for(&remote).unwrap();
        // Applying the new identity clears the old target's message/history too.
        assert_eq!(paused.last_collected_at, None);
        assert_eq!(paused.state, "waiting-core");
        assert!(paused.paused);
        assert!(paused.destructive_pop);
        assert_eq!(paused.target_revision, remote.target_revision);
    }

    #[test]
    fn resume_usage_collection_rejects_a_stale_target() {
        let remote = remote_usage_test_config("http://core-a.invalid:8317");
        let mut stale = remote.clone();
        stale.target_revision += 1;
        let app = tauri::test::mock_builder()
            .manage(GuiConfigState::new(stale))
            .manage(UsageCollectorState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let error = resume_usage_collection(
            app.state(),
            app.state(),
            remote.remote_management_origin.clone(),
            remote.target_revision,
        )
        .err()
        .unwrap();
        assert!(error.contains("changed"), "{error}");

        // A local target cannot be resumed at all.
        let local_app = tauri::test::mock_builder()
            .manage(GuiConfigState::new(GuiConfigFile::default()))
            .manage(UsageCollectorState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let local_error =
            resume_usage_collection(local_app.state(), local_app.state(), String::new(), 0)
                .err()
                .unwrap();
        assert!(local_error.contains("remote"), "{local_error}");
    }
