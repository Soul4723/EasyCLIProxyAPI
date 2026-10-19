use super::*;

pub(crate) const MAX_CORE_CRASH_RESTART_ATTEMPTS: u32 = 5;
pub(crate) const CORE_CRASH_STABLE_UPTIME: Duration = Duration::from_secs(60);

pub(crate) fn core_supervision_allowed(config: &GuiConfigFile) -> bool {
    config.connection_mode == CoreConnectionMode::Local
}

pub(crate) fn core_crash_restart_backoff(attempt: u32) -> Option<Duration> {
    match attempt {
        1 => Some(Duration::from_secs(1)),
        2 => Some(Duration::from_secs(2)),
        3 => Some(Duration::from_secs(5)),
        4 => Some(Duration::from_secs(10)),
        5 => Some(Duration::from_secs(30)),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) fn check_and_recover_crashed_core<F>(
    process_state: &CoreProcessState,
    config: &GuiConfigFile,
    mut restart_fn: F,
) -> Result<bool, String>
where
    F: FnMut(Duration) -> Result<(), String>,
{
    if !core_supervision_allowed(config)
        || process_state.is_shutting_down()
        || process_state.is_starting()
    {
        return Ok(false);
    }
    if !process_state.poll_unexpected_child_exit(CORE_CRASH_STABLE_UPTIME) {
        return Ok(false);
    }
    let attempt = process_state.record_crash_restart_attempt();
    let Some(backoff) = core_crash_restart_backoff(attempt) else {
        return Err(pause_core_crash_recovery(process_state));
    };
    restart_fn(backoff)?;
    process_state.finish_recovery_pass();
    Ok(true)
}

pub(crate) fn pause_core_crash_recovery(process_state: &CoreProcessState) -> String {
    process_state.finish_recovery_pass();
    let detail = format!("CPA kernel crashed repeatedly ({MAX_CORE_CRASH_RESTART_ATTEMPTS} attempts); automatic restart paused");
    // A manual start may have replaced the child before the cutoff was applied.
    if !process_state.is_supervising() {
        process_state.recovery.halt(detail.clone());
    }
    detail
}

pub(crate) fn restart_crashed_core_locked(
    process_state: &CoreProcessState,
    config: &GuiConfigFile,
) -> Result<bool, String> {
    if !core_supervision_allowed(config) || process_state.is_shutting_down() || !process_state.is_supervising() {
        return Ok(false);
    }
    if current_core_status(Some(process_state), None)?.running {
        process_state.complete_recovery_when_already_running();
        return Ok(false);
    }
    start_core_process_inner(process_state, config)?;
    Ok(true)
}

pub(crate) fn start_core_crash_supervisor_if_needed(
    process_state: &CoreProcessState,
    start: impl FnOnce(),
) {
    if process_state.is_supervising() {
        start();
    }
}

pub(crate) fn start_core_crash_supervisor(app: tauri::AppHandle) {
    let process_state = app.state::<CoreProcessState>();
    if process_state
        .supervisor_started
        .swap(true, Ordering::AcqRel)
    {
        return;
    }
    let supervisor_app = app.clone();
    if thread::Builder::new()
        .name("cpa-core-crash-supervisor".to_string())
        .spawn(move || loop {
            thread::sleep(Duration::from_secs(2));
            let process_state = supervisor_app.state::<CoreProcessState>();
            if process_state.is_shutting_down() {
                break;
            }
            let gui_config_state = supervisor_app.state::<GuiConfigState>();
            // Match target-transition lock ordering. Never sleep while holding either lock.
            let recovery = (|| -> Result<Option<(Duration, u64, u64)>, String> {
                let _target = gui_config_state.target_operation.blocking_lock();
                let Some(_operation) = try_supervisor_operation(&CORE_OPERATION_LOCK)? else {
                    return Ok(None);
                };
                let config = gui_config_state.snapshot()?;
                if !core_supervision_allowed(&config) || process_state.is_starting()
                    || !process_state.poll_unexpected_child_exit(CORE_CRASH_STABLE_UPTIME) {
                    return Ok(None);
                }
                let attempt = process_state.record_crash_restart_attempt();
                let backoff = core_crash_restart_backoff(attempt)
                    .ok_or_else(|| pause_core_crash_recovery(process_state.inner()))?;
                process_state.recovery.waiting(attempt, backoff);
                emit_current_core_status(&supervisor_app, process_state.inner(), config.port);
                Ok(Some((backoff, config.target_revision,
                    process_state.supervision_generation.load(Ordering::Acquire))))
            })();
            let result = match recovery {
                Ok(Some((backoff, revision, generation))) => {
                    thread::sleep(backoff);
                    (|| -> Result<(), String> {
                        let _target = gui_config_state.target_operation.blocking_lock();
                        let Some(_operation) = try_supervisor_operation(&CORE_OPERATION_LOCK)? else {
                            return Ok(());
                        };
                        let config = gui_config_state.snapshot()?;
                        if config.target_revision != revision || !core_supervision_allowed(&config)
                            || process_state.supervision_generation.load(Ordering::Acquire) != generation {
                            return Ok(());
                        }
                        process_state.recovery.restarting();
                        emit_current_core_status(&supervisor_app, process_state.inner(), config.port);
                        if restart_crashed_core_locked(process_state.inner(), &config)? {
                            emit_current_core_status(&supervisor_app, process_state.inner(), config.port);
                        }
                        process_state.finish_recovery_pass();
                        Ok(())
                    })()
                }
                Ok(None) => Ok(()),
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                // Errors from acquiring the operation lock are not restart failures;
                // only an active recovery should expose a retry diagnostic.
                let _target = gui_config_state.target_operation.blocking_lock();
                process_state.recovery.attempt_failed(error.clone());
                if let Ok(config) = gui_config_state.snapshot() {
                    if core_supervision_allowed(&config) {
                        emit_current_core_status(&supervisor_app, process_state.inner(), config.port);
                    }
                }
                eprintln!("Core crash supervisor failed to recover CPA kernel: {error}");
            }
        })
        .is_err()
    {
        process_state
            .supervisor_started
            .store(false, Ordering::Release);
    }
}
