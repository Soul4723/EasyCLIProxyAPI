use super::*;

impl UsageCollectorState {
    pub(crate) fn request_readiness_check(&self) {
        self.readiness_requested.store(true, Ordering::Release);
    }

    pub(super) fn start(&self) -> Option<CancellationToken> {
        let mut inner = self.inner.lock().ok()?;
        if inner.token.is_some() {
            return None;
        }
        let token = CancellationToken::new();
        inner.token = Some(token.clone());
        Some(token)
    }

    pub(super) fn stop(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(token) = inner.token.take() {
                token.cancel();
            }
        }
    }

    pub(super) fn set_status(&self, status: UsageCollectorStatus) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = status;
        }
    }

    pub(super) fn set_connection(
        &self,
        connection_key: &str,
        connection_mode: &str,
        remote_origin: Option<String>,
        target_revision: u64,
    ) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.connection_key = Some(connection_key.to_string());
            inner.connection_mode = connection_mode.to_string();
            inner.remote_origin = remote_origin;
            inner.target_revision = target_revision;
            // Never carry the previous target's message or history into the new
            // target; the next status write fills in the real state.
            inner.status.state = "waiting-core".to_string();
            inner.status.message = if connection_mode == "remote" {
                "Waiting for remote core usage collection to start".to_string()
            } else {
                "Waiting for kernel to become ready".to_string()
            };
            inner.status.last_collected_at = None;
        }
    }

    pub(super) fn set_paused(&self, paused: bool) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.paused = paused;
        }
    }

    pub(super) fn is_paused(&self) -> bool {
        self.inner.lock().map(|inner| inner.paused).unwrap_or(false)
    }

    pub(super) fn set_total_records(&self, total_records: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status.total_records = total_records;
        }
    }

    pub(super) fn apply_record_changes(&self, inserted: usize, deleted: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status.total_records = inner
                .status
                .total_records
                .saturating_add(inserted as u64)
                .saturating_sub(deleted);
        }
    }

    pub(super) fn status(&self) -> Result<UsageCollectorStatus, String> {
        self.inner
            .lock()
            .map(|inner| {
                let mut status = inner.status.clone();
                status.connection_mode = inner.connection_mode.clone();
                status.remote_origin = inner.remote_origin.clone();
                status.target_revision = inner.target_revision;
                status.paused = inner.paused;
                status.destructive_pop = inner.connection_mode == "remote";
                status
            })
            .map_err(|_| "Usage collection status lock is poisoned".to_string())
    }

    /// Status for the target described by `config`.
    ///
    /// If the collector has not applied this target yet (e.g. immediately after
    /// the user switches connection), this never reports the previous target's
    /// status, totals, or history: it returns a fresh waiting status scoped to
    /// the new target instead.
    pub(super) fn status_for(&self, config: &GuiConfigFile) -> Result<UsageCollectorStatus, String> {
        let connection_key = usage_connection_key(config);
        let applied = self
            .inner
            .lock()
            .map_err(|_| "Usage collection status lock is poisoned".to_string())?
            .connection_key
            .clone();
        if applied.as_deref() == Some(connection_key.as_str()) {
            return self.status();
        }
        let remote = config.connection_mode == CoreConnectionMode::Remote;
        // The collector has not applied this target yet, so report no totals or
        // history rather than the previous target's. The next collector tick
        // applies the identity and the real totals.
        Ok(UsageCollectorStatus {
            state: "waiting-core".to_string(),
            message: if remote {
                "Waiting for remote core usage collection to start".to_string()
            } else {
                "Waiting for kernel to become ready".to_string()
            },
            last_collected_at: None,
            total_records: 0,
            connection_mode: config.connection_mode.as_str().to_string(),
            remote_origin: remote.then(|| config.remote_management_origin.clone()),
            target_revision: config.target_revision,
            paused: false,
            destructive_pop: remote,
        })
    }
}

#[derive(Default)]
pub(super) struct RedisUsageQueueSource {
    pub(super) selected_key: Option<&'static str>,
}

pub(super) struct RawUsageQueueBatch {
    pub(super) source: String,
    pub(super) messages: Vec<String>,
}

impl RedisUsageQueueSource {
    pub(super) async fn pull(&mut self, config: &GuiConfigFile) -> Result<RawUsageQueueBatch, String> {
        if let Some(queue_key) = self.selected_key {
            return Self::pull_key(config, queue_key).await;
        }

        match Self::pull_key(config, USAGE_QUEUE_KEY).await {
            Ok(batch) => {
                self.selected_key = Some(USAGE_QUEUE_KEY);
                Ok(batch)
            }
            Err(usage_error) if redis_pull_can_try_legacy_queue(&usage_error) => {
                match Self::pull_key(config, LEGACY_USAGE_QUEUE_KEY).await {
                    Ok(batch) => {
                        self.selected_key = Some(LEGACY_USAGE_QUEUE_KEY);
                        Ok(batch)
                    }
                    Err(legacy_error) => Err(format!(
                        "Failed to fetch Redis usage queue (usage: {usage_error}; queue: {legacy_error})"
                    )),
                }
            }
            Err(error) => Err(error),
        }
    }

    pub(super) async fn pull_key(
        config: &GuiConfigFile,
        queue_key: &'static str,
    ) -> Result<RawUsageQueueBatch, String> {
        let messages = pull_usage_queue(
            config.port,
            &config.management_secret_key,
            queue_key,
            USAGE_QUEUE_BATCH_SIZE,
        )
        .await?;
        Ok(RawUsageQueueBatch {
            source: format!("redis_pull:{queue_key}"),
            messages,
        })
    }
}

pub(super) fn redis_pull_can_try_legacy_queue(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("unsupported channel") || error.contains("unsupported queue")
}

pub(crate) fn start_usage_collector(app: tauri::AppHandle) {
    let state = app.state::<UsageCollectorState>();
    if let Ok(config) = app.state::<GuiConfigState>().snapshot() {
        let root = usage_root_dir_for(&config)
            .unwrap_or_else(|_| usage_root_dir().unwrap_or_default());
        if let Ok(total_records) = total_usage_records_at(&root) {
            state.set_total_records(total_records);
        }
    }
    let Some(token) = state.start() else {
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(usage_collector_loop(app, token));
    });
}

pub(crate) fn stop_usage_collector(app: &tauri::AppHandle) {
    app.state::<UsageCollectorState>().stop();
}

// A successful HTTP pop cannot be repeated. Keep both the raw records and
// their normalization/storage identity until local persistence succeeds.
pub(super) struct PendingRemoteUsageBatch {
    pub(super) root: PathBuf,
    pub(super) source: String,
    pub(super) config: GuiConfigFile,
    pub(super) messages: Vec<String>,
    // The inbox write is the durable commit. The inbox has no unique key, so a retry that
    // wrote the same raw records again would be processed twice; once true, only processing retries.
    pub(super) enqueued: bool,
}

impl PendingRemoteUsageBatch {
    pub(super) fn new(root: PathBuf, source: String, config: GuiConfigFile, messages: Vec<String>) -> Self {
        Self { root, source, config, messages, enqueued: false }
    }

    pub(super) fn persist(pending: &mut Option<Self>) -> Result<UsagePersistOutcome, String> {
        Self::persist_with(
            pending,
            |root, source, messages| enqueue_usage_raw_messages(&mut open_usage_database_at(root)?, source, messages).map(|_| ()),
            |root, config| process_usage_inbox(&mut open_usage_database_at(root)?, config),
        )
    }

    pub(super) fn persist_with(
        pending: &mut Option<Self>,
        enqueue: impl FnOnce(&Path, &str, Vec<String>) -> Result<(), String>,
        process: impl FnOnce(&Path, &GuiConfigFile) -> Result<UsagePersistOutcome, String>,
    ) -> Result<UsagePersistOutcome, String> {
        let batch = pending.as_mut().expect("remote batch must be pending");
        if !batch.enqueued {
            enqueue(&batch.root, &batch.source, batch.messages.clone())?;
            batch.enqueued = true;
        }
        let outcome = process(&batch.root, &batch.config)?;
        *pending = None;
        Ok(outcome)
    }
}

pub(super) async fn fetch_remote_usage_when_durable<F, Fut>(
    pending: &Option<PendingRemoteUsageBatch>,
    fetch: F,
) -> Option<Result<Vec<String>, RemotePopError>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Vec<String>, RemotePopError>>,
{
    if pending.is_some() {
        return None;
    }
    Some(fetch().await)
}

pub(super) fn next_empty_remote_poll_seconds(current: u64) -> u64 {
    (current * 2).min(REMOTE_EMPTY_POLL_MAX_SECONDS)
}

// Keep outage probes bounded but frequent enough to notice an externally started
// core within a few seconds. Lifecycle notifications still trigger an immediate
// probe, while a healthy collector only needs an occasional safety re-check.
const READINESS_RETRY_MAX_SECONDS: u64 = 4;
const READINESS_HEALTHY_RECHECK_SECONDS: u64 = 30;

// Readiness failures are not queue failures: keep their retry budget independent
// of successful inbox processing and the healthy empty-queue polling schedule.
pub(super) struct ReadinessBackoff {
    pub(super) retry_seconds: u64,
}

impl ReadinessBackoff {
    pub(super) fn new() -> Self {
        Self { retry_seconds: 2 }
    }

    pub(super) fn reset(&mut self) {
        *self = Self::new();
    }

    pub(super) fn checked(&mut self, ready: bool) -> Duration {
        if ready {
            self.retry_seconds = 2;
            return Duration::from_secs(READINESS_HEALTHY_RECHECK_SECONDS);
        }
        let delay = Duration::from_secs(self.retry_seconds);
        self.retry_seconds = (self.retry_seconds * 2).min(READINESS_RETRY_MAX_SECONDS);
        delay
    }
}

#[test]
pub(super) fn readiness_backoff_grows_and_caps_prompt_recovery_delay() {
    let mut backoff = ReadinessBackoff::new();
    for seconds in [2, 4, 4, 4] {
        assert_eq!(backoff.checked(false), Duration::from_secs(seconds));
    }
    assert_eq!(backoff.checked(true), Duration::from_secs(30));
    assert_eq!(backoff.checked(false), Duration::from_secs(2));
}

#[test]
pub(super) fn readiness_request_is_consumed_once_and_restarts_retry_budget() {
    let mut backoff = ReadinessBackoff::new();
    for _ in 0..8 {
        backoff.checked(false);
    }
    let state = UsageCollectorState::default();
    state.request_readiness_check();
    assert!(state.readiness_requested.swap(false, Ordering::AcqRel));
    assert!(!state.readiness_requested.swap(false, Ordering::AcqRel));
    backoff.reset();
    assert_eq!(backoff.checked(false), Duration::from_secs(2));
    assert_eq!(backoff.checked(true), Duration::from_secs(30));
}

pub(super) async fn usage_collector_loop(app: tauri::AppHandle, token: CancellationToken) {
    let mut retry_seconds = 1_u64;
    // Idle remote cores are polled less often each time the queue comes back empty.
    let mut empty_poll_seconds = REMOTE_EMPTY_POLL_MIN_SECONDS;
    let mut subscription: Option<UsageSubscription> = None;
    let mut redis_queue = RedisUsageQueueSource::default();
    let mut subscribe_retry_at = tokio::time::Instant::now();
    let mut next_inbox_cleanup_at = tokio::time::Instant::now() + Duration::from_secs(60 * 60);
    let mut next_inbox_recovery_at = tokio::time::Instant::now();
    let mut readiness = ReadinessBackoff::new();
    let mut next_core_check_at = tokio::time::Instant::now();
    let mut core_ready = false;
    let mut remote_ready_error: Option<String> = None;
    let mut active_connection: Option<String> = None;
    let mut pending_remote_batch: Option<PendingRemoteUsageBatch> = None;
    loop {
        if token.is_cancelled() {
            return;
        }
        // Drain the captured batch before resolving another target or doing any
        // further destructive read, even when the user switched to Local mode.
        if let Some(batch) = pending_remote_batch.as_ref() {
            let config = batch.config.clone();
            match PendingRemoteUsageBatch::persist(&mut pending_remote_batch) {
                Ok(outcome) => {
                    if app.state::<GuiConfigState>().ensure_target(&config).is_ok() {
                        publish_collected_records(&app, outcome, "Saved retained remote usage batch");
                    }
                    retry_seconds = 1;
                }
                Err(error) => {
                    set_collector_error(&app, error);
                    retry_seconds = (retry_seconds * 2).min(10);
                }
            }
            wait_or_cancel(&token, retry_seconds).await;
            continue;
        }
        let config = match app.state::<GuiConfigState>().snapshot() {
            Ok(config) => config,
            Err(error) => {
                set_collector_error(&app, error);
                wait_or_cancel(&token, retry_seconds).await;
                retry_seconds = (retry_seconds * 2).min(10);
                continue;
            }
        };
        let remote = config.connection_mode == CoreConnectionMode::Remote;
        // Resolve the target-scoped storage root every iteration: a target
        // switch changes the namespace, and remote records must never land in
        // the local store (or the reverse).
        let root = match usage_root_dir_for(&config) {
            Ok(root) => root,
            Err(error) => {
                set_collector_error(&app, error);
                wait_or_cancel(&token, retry_seconds).await;
                retry_seconds = (retry_seconds * 2).min(10);
                continue;
            }
        };
        let connection_key = usage_connection_key(&config);
        if active_connection.as_deref() != Some(connection_key.as_str()) {
            subscription = None;
            redis_queue = RedisUsageQueueSource::default();
            subscribe_retry_at = tokio::time::Instant::now();
            readiness.reset();
            next_core_check_at = tokio::time::Instant::now();
            core_ready = false;
            remote_ready_error = None;
            let state = app.state::<UsageCollectorState>();
            if let Ok(total_records) = total_usage_records_at(&root) {
                state.set_total_records(total_records);
            }
            state.set_connection(
                &connection_key,
                config.connection_mode.as_str(),
                remote.then(|| config.remote_management_origin.clone()),
                config.target_revision,
            );
            // A target switch or revision bump is the explicit resume path: the
            // new identity always starts unpaused, then re-pauses on the next
            // uncertain destructive pop.
            state.set_paused(false);
            active_connection = Some(connection_key);
        }
        if tokio::time::Instant::now() >= next_inbox_cleanup_at {
            if let Err(error) = open_usage_database_at(&root)
                .and_then(|connection| cleanup_usage_inbox(&connection, Local::now()))
            {
                eprintln!("Failed to clean up usage records inbox: {error}");
            }
            next_inbox_cleanup_at = tokio::time::Instant::now() + Duration::from_secs(60 * 60);
        }
        if tokio::time::Instant::now() >= next_inbox_recovery_at {
            let recovered = open_usage_database_at(&root)
                .and_then(|mut connection| process_usage_inbox(&mut connection, &config));
            match recovered {
                Ok(outcome) if outcome.inserted > 0 || outcome.deleted > 0 => {
                    let saved = outcome.inserted;
                    let collected_at = Local::now().to_rfc3339();
                    app.state::<UsageCollectorState>()
                        .apply_record_changes(outcome.inserted, outcome.deleted);
                    set_collector_status(
                        &app,
                        "collecting",
                        &format!("Restored {saved} pending records"),
                        Some(collected_at.clone()),
                    );
                    let _ = app.emit(USAGE_UPDATED_EVENT, collected_at);
                    retry_seconds = 1;
                    continue;
                }
                Ok(_) => {
                    next_inbox_recovery_at = tokio::time::Instant::now() + Duration::from_secs(2);
                }
                Err(error) => {
                    set_collector_error(&app, error);
                    wait_or_cancel(&token, retry_seconds).await;
                    retry_seconds = (retry_seconds * 2).min(10);
                    continue;
                }
            }
        }
        // Lifecycle status is emitted by user actions, not by unchanged status
        // polls. While waiting we revisit this flag at least once per second.
        if app.state::<UsageCollectorState>().readiness_requested.swap(false, Ordering::AcqRel) {
            readiness.reset();
            next_core_check_at = tokio::time::Instant::now();
            empty_poll_seconds = REMOTE_EMPTY_POLL_MIN_SECONDS;
        }
        if tokio::time::Instant::now() >= next_core_check_at {
            if remote {
                // Remote readiness is authenticated management reachability,
                // never a local process check or a local RESP connect.
                match remote_core_readiness(&config).await {
                    Ok(()) => {
                        core_ready = true;
                        remote_ready_error = None;
                    }
                    Err(error) => {
                        core_ready = false;
                        remote_ready_error = Some(error);
                    }
                }
            } else {
                let process_state = app.state::<CoreProcessState>();
                core_ready = current_core_status(Some(process_state.inner()), Some(config.port))
                    .map(|status| status.ready)
                    .unwrap_or(false);
            }
            next_core_check_at = tokio::time::Instant::now() + readiness.checked(core_ready);
        }
        if !core_ready {
            subscription = None;
            redis_queue = RedisUsageQueueSource::default();
            subscribe_retry_at = tokio::time::Instant::now();
            let message = if remote {
                remote_ready_error
                    .as_deref()
                    .unwrap_or("Waiting for remote core to become reachable")
            } else {
                "Waiting for kernel to become ready"
            };
            set_collector_status(&app, "waiting-core", message, None);
            wait_or_cancel(&token, 1).await;
            continue;
        }

        if remote {
            // Remote cores have no cross-machine RESP/TLS subscriber here. Use
            // the explicit target-bound HTTP compatibility queue: the core pops
            // records, so a lost response is unrecoverable and no second
            // consumer (local RESP or another poller) may run against it.
            if app.state::<UsageCollectorState>().is_paused() {
                set_collector_status(&app, "paused", &remote_paused_message(&config), None);
                retry_seconds = 1;
                wait_or_cancel(&token, 2).await;
                continue;
            }
            let Some(result) = fetch_remote_usage_when_durable(
                &pending_remote_batch, || fetch_remote_usage_queue(&config),
            ).await else { continue; };
            match result {
                Ok(messages) if messages.is_empty() => {
                    set_collector_status(
                        &app,
                        "collecting",
                        &remote_collecting_message(&config),
                        None,
                    );
                    retry_seconds = 1;
                    wait_or_cancel(&token, empty_poll_seconds).await;
                    empty_poll_seconds = next_empty_remote_poll_seconds(empty_poll_seconds);
                }
                Ok(messages) => {
                    empty_poll_seconds = REMOTE_EMPTY_POLL_MIN_SECONDS;
                    pending_remote_batch = Some(PendingRemoteUsageBatch::new(
                        root,
                        remote_usage_queue_source(&config),
                        config,
                        messages,
                    ));
                }
                Err(RemotePopError::Definite(error)) => {
                    // The core rejected the request before popping, so a
                    // backoff retry cannot lose records. Readiness/auth is
                    // re-checked separately before the next pop.
                    set_collector_error(&app, error);
                    wait_or_cancel(&token, retry_seconds).await;
                    retry_seconds = (retry_seconds * 2).min(10);
                }
                Err(RemotePopError::Uncertain(error)) => {
                    // The outcome is unknown: records may already be popped.
                    // Pause this target and revision instead of dequeuing again.
                    app.state::<UsageCollectorState>().set_paused(true);
                    set_collector_status(
                        &app,
                        "paused",
                        &format!("{error}. {}", remote_paused_message(&config)),
                        None,
                    );
                    retry_seconds = 1;
                    wait_or_cancel(&token, 2).await;
                }
            }
            continue;
        }

        if subscription.is_none() && tokio::time::Instant::now() >= subscribe_retry_at {
            match UsageSubscription::connect(config.port, &config.management_secret_key).await {
                Ok(next_subscription) => {
                    subscription = Some(next_subscription);
                    set_collector_status(&app, "collecting", "Connected to CPA usage live subscription", None);
                    match backfill_usage_queue(&root, &config, &mut redis_queue).await {
                        Ok(outcome) => {
                            let saved = outcome.inserted;
                            publish_collected_records(
                                &app,
                                outcome,
                                &format!("Live subscription connected; imported {saved} queued records"),
                            );
                            retry_seconds = 1;
                        }
                        Err(error) => {
                            set_collector_status(
                                &app,
                                "collecting",
                                &format!("Live subscription connected, but historical queue import failed: {error}"),
                                None,
                            );
                        }
                    }
                    continue;
                }
                Err(error) => {
                    subscribe_retry_at = tokio::time::Instant::now()
                        + Duration::from_secs(USAGE_SUBSCRIBE_RETRY_SECONDS);
                    set_collector_status(
                        &app,
                        "collecting",
                        &format!("Collecting in HTTP compatibility mode; live subscription unavailable: {error}"),
                        None,
                    );
                }
            }
        }

        if let Some(active_subscription) = subscription.as_mut() {
            let message = tokio::select! {
                _ = token.cancelled() => return,
                result = tokio::time::timeout(
                    Duration::from_secs(2),
                    active_subscription.next_message(),
                ) => result,
            };
            match message {
                Ok(Ok(payload)) => {
                    match persist_raw_usage_message_from_source(
                        &root,
                        "redis_subscribe:usage",
                        payload,
                        &config,
                    ) {
                        Ok(outcome) => {
                            let saved = outcome.inserted;
                            publish_collected_records(
                                &app,
                                outcome,
                                &format!("Live subscription saved {saved} new records"),
                            );
                            retry_seconds = 1;
                        }
                        Err(error) => {
                            set_collector_error(&app, error);
                            wait_or_cancel(&token, retry_seconds).await;
                            retry_seconds = (retry_seconds * 2).min(10);
                        }
                    }
                    continue;
                }
                Err(_) => {
                    set_collector_status(&app, "collecting", "Collecting from CPA usage live subscription", None);
                    retry_seconds = 1;
                    continue;
                }
                Ok(Err(error)) => {
                    subscription = None;
                    subscribe_retry_at = tokio::time::Instant::now()
                        + Duration::from_secs(USAGE_SUBSCRIBE_RETRY_SECONDS);
                    set_collector_status(
                        &app,
                        "collecting",
                        &format!("Live subscription disconnected; switched to HTTP compatibility mode: {error}"),
                        None,
                    );
                    // A disconnect can be an explicit stop. Recheck readiness
                    // before attempting a compatibility pop with cached readiness.
                    next_core_check_at = tokio::time::Instant::now();
                    continue;
                }
            }
        }

        match pull_usage_queue_with_fallback(&mut redis_queue, &config).await {
            Ok(batch) if batch.messages.is_empty() => {
                set_collector_status(
                    &app,
                    "collecting",
                    &format!(
                        "Collecting usage records ({})",
                        collector_source_label(&batch.source)
                    ),
                    None,
                );
                retry_seconds = 1;
                wait_or_cancel(&token, 1).await;
            }
            Ok(batch) => {
                let source_label = collector_source_label(&batch.source);
                match persist_raw_usage_messages_from_source(
                    &root,
                    &batch.source,
                    batch.messages,
                    &config,
                ) {
                    Ok(outcome) => {
                        let saved = outcome.inserted;
                        publish_collected_records(
                            &app,
                            outcome,
                            &format!("{source_label} saved {saved} new records"),
                        );
                        retry_seconds = 1;
                    }
                    Err(error) => {
                        set_collector_error(&app, error);
                        wait_or_cancel(&token, retry_seconds).await;
                        retry_seconds = (retry_seconds * 2).min(10);
                    }
                }
            }
            Err(error) => {
                // The core may have stopped since the last readiness probe.
                // Only report a queue fault if it is still ready to collect.
                let process_state = app.state::<CoreProcessState>();
                let ready = current_core_status(Some(process_state.inner()), Some(config.port))
                    .map(|status| status.ready).unwrap_or(false);
                if ready {
                    set_collector_error(&app, error);
                    wait_or_cancel(&token, retry_seconds).await;
                    retry_seconds = (retry_seconds * 2).min(10);
                } else {
                    core_ready = false;
                    next_core_check_at = tokio::time::Instant::now();
                    set_collector_status(&app, "waiting-core", "Waiting for kernel to become ready", None);
                }
            }
        }
    }
}

pub(super) async fn backfill_usage_queue(
    root: &Path,
    config: &GuiConfigFile,
    redis_queue: &mut RedisUsageQueueSource,
) -> Result<UsagePersistOutcome, String> {
    let mut outcome = UsagePersistOutcome::default();
    loop {
        match redis_queue.pull(config).await {
            Ok(batch) => {
                let fetched = batch.messages.len();
                if fetched == 0 {
                    return Ok(outcome);
                }
                outcome.add(persist_raw_usage_messages_from_source(
                    root,
                    &batch.source,
                    batch.messages,
                    config,
                )?);
                if fetched < USAGE_QUEUE_BATCH_SIZE {
                    return Ok(outcome);
                }
            }
            Err(redis_error) => {
                return backfill_http_usage_queue(root, config, outcome)
                    .await
                    .map_err(|http_error| {
                        format!("Failed to import queue (Redis: {redis_error}; HTTP: {http_error})")
                    });
            }
        }
    }
}

pub(super) async fn backfill_http_usage_queue(
    root: &Path,
    config: &GuiConfigFile,
    mut outcome: UsagePersistOutcome,
) -> Result<UsagePersistOutcome, String> {
    loop {
        let messages = fetch_usage_queue_raw(config).await?;
        let fetched = messages.len();
        if fetched == 0 {
            return Ok(outcome);
        }
        outcome.add(persist_raw_usage_messages_from_source(
            root,
            HTTP_USAGE_QUEUE_SOURCE,
            messages,
            config,
        )?);
        if fetched < USAGE_QUEUE_BATCH_SIZE {
            return Ok(outcome);
        }
    }
}

pub(super) fn publish_collected_records(app: &tauri::AppHandle, outcome: UsagePersistOutcome, message: &str) {
    let saved = outcome.inserted;
    let collected_at = Local::now().to_rfc3339();
    if saved > 0 || outcome.deleted > 0 {
        app.state::<UsageCollectorState>()
            .apply_record_changes(saved, outcome.deleted);
    }
    set_collector_status(
        app,
        "collecting",
        message,
        (saved > 0).then_some(collected_at.clone()),
    );
    if saved > 0 {
        let _ = app.emit(USAGE_UPDATED_EVENT, collected_at);
    }
}

pub(crate) fn persist_local_usage_event(
    app: &tauri::AppHandle,
    collector_source: &str,
    mut value: Value,
) -> Result<usize, String> {
    if let Some(object) = value.as_object_mut() {
        if string_field(object, "request_id").is_none() {
            object.insert(
                "request_id".to_string(),
                Value::String(format!("{collector_source}-{}", unique_file_stamp())),
            );
        }
    }
    let config = app.state::<GuiConfigState>().snapshot()?;
    // Desktop health checks are a local-core concept and always belong to the
    // local namespace; in remote mode they must not move the remote counters.
    let root = usage_root_dir()?;
    let outcome = persist_queue_items_from_source(&root, collector_source, vec![value], &config)?;
    if config.connection_mode == CoreConnectionMode::Local {
        publish_collected_records(app, outcome, "Saved desktop health check usage record");
    }
    Ok(outcome.inserted)
}

pub(super) async fn wait_or_cancel(token: &CancellationToken, seconds: u64) {
    tokio::select! {
        _ = token.cancelled() => {},
        _ = tokio::time::sleep(Duration::from_secs(seconds)) => {},
    }
}

pub(super) async fn fetch_usage_queue(config: &GuiConfigFile) -> Result<Vec<Value>, String> {
    let client = management_api::management_http_client_for(config)?;
    let response = client
        .get(management_endpoint(config, "observability/usage/queue")?)
        .header("Authorization", management_authorization(config)?)
        .query(&[("count", USAGE_QUEUE_BATCH_SIZE)])
        .send()
        .await
        .map_err(|error| format_management_request_error("Failed to read CPA usage records queue", &error))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format_management_request_error("Failed to read CPA usage records response", &error))?;
    if !status.is_success() {
        return Err(format!(
            "CPA usage records queue returned HTTP {}",
            status.as_u16()
        ));
    }
    serde_json::from_str::<Vec<Value>>(&text)
        .map_err(|error| format!("Failed to parse CPA usage records: {error}"))
}

pub(super) async fn fetch_usage_queue_raw(config: &GuiConfigFile) -> Result<Vec<String>, String> {
    fetch_usage_queue(config)
        .await?
        .into_iter()
        .map(|item| {
            serde_json::to_string(&item)
                .map_err(|error| format!("Failed to serialize CPA usage records: {error}"))
        })
        .collect()
}

pub(super) async fn pull_usage_queue_with_fallback(
    redis_queue: &mut RedisUsageQueueSource,
    config: &GuiConfigFile,
) -> Result<RawUsageQueueBatch, String> {
    match redis_queue.pull(config).await {
        Ok(batch) => Ok(batch),
        Err(redis_error) => fetch_usage_queue_raw(config)
            .await
            .map(|messages| RawUsageQueueBatch {
                source: HTTP_USAGE_QUEUE_SOURCE.to_string(),
                messages,
            })
            .map_err(|http_error| {
                format!("Failed to read CPA usage records (Redis: {redis_error}; HTTP: {http_error})")
            }),
    }
}

pub(super) fn collector_source_label(source: &str) -> &'static str {
    if source.starts_with("redis_pull:") {
        "Redis queue"
    } else if source.contains(":remote-") {
        "Remote HTTP compatibility mode"
    } else {
        "HTTP compatibility mode"
    }
}

/// Collector state key that changes whenever the active core identity changes.
/// A change resets the live subscription, storage counters, target status, and
/// any remote pause. It carries the full active identity (mode, revision, and
/// credentials) so rotating a key or bumping the target revision is treated as
/// a switch, while the storage namespace below stays keyed on the origin only.
pub(super) fn usage_connection_key(config: &GuiConfigFile) -> String {
    match config.connection_mode {
        CoreConnectionMode::Local => format!(
            "local:{}:{}:{}",
            config.target_revision,
            config.port,
            hash_text(&config.management_secret_key)
        ),
        CoreConnectionMode::Remote => format!(
            "remote:{}:{}:{}:{}",
            config.target_revision,
            config.remote_management_origin.trim(),
            hash_text(&config.remote_management_key),
            hash_text(&config.remote_client_key)
        ),
    }
}

/// Authenticated remote management reachability. Uses the management API, not a
/// local process or listener check.
pub(super) async fn remote_core_readiness(config: &GuiConfigFile) -> Result<(), String> {
    let client = management_api::management_http_client_for(config)?;
    let response = client
        .get(management_endpoint(config, "config")?)
        .header("Authorization", management_authorization(config)?)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|error| format_management_request_error("Failed to reach remote core", &error))?;
    if response.status().is_success() {
        return Ok(());
    }
    Err(format!(
        "Remote core management request failed (HTTP {})",
        response.status().as_u16()
    ))
}

pub(super) fn remote_collecting_message(config: &GuiConfigFile) -> String {
    let origin = config.remote_management_origin.trim();
    if origin.is_empty() {
        "Collecting remote usage (HTTP compatibility mode)".to_string()
    } else {
        format!("Collecting remote usage from {origin} (HTTP compatibility mode)")
    }
}

pub(super) fn remote_usage_queue_source(config: &GuiConfigFile) -> String {
    match remote_usage_target_namespace(config) {
        Ok(namespace) => format!("{HTTP_USAGE_QUEUE_SOURCE}:{namespace}"),
        Err(_) => HTTP_USAGE_QUEUE_SOURCE.to_string(),
    }
}

pub(super) fn remote_paused_message(config: &GuiConfigFile) -> String {
    let origin = config.remote_management_origin.trim();
    let target = if origin.is_empty() {
        "the remote core"
    } else {
        origin
    };
    format!(
        "Remote usage collection for {target} is paused: the HTTP queue pop is destructive and \
         the last request outcome was unknown. No further records will be requested automatically; \
         save the connection settings (or use the resume command) to resume."
    )
}

/// Classification of a remote destructive queue pop.
#[derive(Debug)]
pub(super) enum RemotePopError {
    /// The request may have reached the core, so records may already be popped
    /// and cannot be replayed. The target must pause instead of retrying.
    Uncertain(String),
    /// The request was rejected before the core consumed anything, so backing
    /// off and retrying cannot lose records.
    Definite(String),
}

/// Explicit target-bound HTTP compatibility dequeue for a remote core.
///
/// The core Pops records: any response we fail to read may have already removed
/// them, so uncertain outcomes must never be retried automatically. This is the
/// only remote path; local RESP is never used against a remote target.
pub(super) async fn fetch_remote_usage_queue(config: &GuiConfigFile) -> Result<Vec<String>, RemotePopError> {
    let client =
        management_api::management_http_client_for(config).map_err(RemotePopError::Definite)?;
    let endpoint = management_endpoint(config, "observability/usage/queue")
        .map_err(RemotePopError::Definite)?;
    let authorization = management_authorization(config).map_err(RemotePopError::Definite)?;
    let response = client
        .get(endpoint)
        .header("Authorization", authorization)
        .query(&[("count", USAGE_QUEUE_BATCH_SIZE)])
        .send()
        .await
        .map_err(|error| {
            let message =
                format_management_request_error("Failed to pop remote CPA usage records", &error);
            if error.is_connect() && !error.is_timeout() {
                // The connection was never established, so nothing was popped.
                RemotePopError::Definite(message)
            } else {
                RemotePopError::Uncertain(message)
            }
        })?;
    let status = response.status();
    let text = response.text().await.map_err(|error| {
        RemotePopError::Uncertain(format_management_request_error(
            "Failed to read the remote CPA usage records response",
            &error,
        ))
    })?;
    if !status.is_success() {
        let message = format!(
            "Remote CPA usage records queue returned HTTP {}",
            status.as_u16()
        );
        // Rejections that happen before dequeue cannot have consumed records.
        return match status.as_u16() {
            400 | 401 | 403 | 404 | 405 | 422 => Err(RemotePopError::Definite(message)),
            _ => Err(RemotePopError::Uncertain(message)),
        };
    }
    let values = serde_json::from_str::<Vec<Value>>(&text).map_err(|error| {
        RemotePopError::Uncertain(format!("Failed to parse remote CPA usage records: {error}"))
    })?;
    values
        .into_iter()
        .map(|item| {
            serde_json::to_string(&item).map_err(|error| {
                RemotePopError::Uncertain(format!(
                    "Failed to serialize remote CPA usage records: {error}"
                ))
            })
        })
        .collect()
}

pub(super) fn set_collector_error(app: &tauri::AppHandle, error: String) {
    set_collector_status(app, "error", &error, None);
}

pub(super) fn set_collector_status(
    app: &tauri::AppHandle,
    state_name: &str,
    message: &str,
    last_collected_at: Option<String>,
) {
    let state = app.state::<UsageCollectorState>();
    let previous = state.status().ok();
    let total_records = previous
        .as_ref()
        .map(|value| value.total_records)
        .unwrap_or(0);
    let connection_mode = previous
        .as_ref()
        .map(|value| value.connection_mode.clone())
        .unwrap_or_else(|| "local".to_string());
    let remote_origin = previous
        .as_ref()
        .and_then(|value| value.remote_origin.clone());
    let target_revision = previous
        .as_ref()
        .map(|value| value.target_revision)
        .unwrap_or(0);
    let paused = previous.as_ref().map(|value| value.paused).unwrap_or(false);
    let destructive_pop = previous
        .as_ref()
        .map(|value| value.destructive_pop)
        .unwrap_or(false);
    state.set_status(UsageCollectorStatus {
        state: state_name.to_string(),
        message: message.to_string(),
        last_collected_at: last_collected_at
            .or_else(|| previous.and_then(|value| value.last_collected_at)),
        total_records,
        connection_mode,
        remote_origin,
        target_revision,
        paused,
        destructive_pop,
    });
}

#[tauri::command]
pub(crate) fn get_usage_collector_status(
    state: tauri::State<'_, UsageCollectorState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<UsageCollectorStatus, String> {
    let config = gui_config_state.snapshot()?;
    state.status_for(&config)
}

/// Explicitly resume remote usage collection after it paused on an uncertain
/// destructive queue pop.
///
/// Target-bound: the caller passes the origin and revision it saw in the status
/// it is acting on, so a stale UI can never resume a different target. Local
/// collection is never paused, so resuming a local target is rejected rather
/// than silently clearing an unrelated flag.
#[tauri::command]
pub(crate) fn resume_usage_collection(
    state: tauri::State<'_, UsageCollectorState>,
    gui_config_state: tauri::State<'_, GuiConfigState>,
    expected_origin: String,
    expected_revision: u64,
) -> Result<UsageCollectorStatus, String> {
    let config = gui_config_state.snapshot()?;
    if config.connection_mode != CoreConnectionMode::Remote {
        return Err("Usage collection is not running against a remote core".to_string());
    }
    if config.remote_management_origin.trim() != expected_origin.trim()
        || config.target_revision != expected_revision
    {
        return Err(
            "The remote connection changed; reload usage status before resuming".to_string(),
        );
    }
    state.set_paused(false);
    state.status_for(&config)
}
