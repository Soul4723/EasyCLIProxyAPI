//! Recovery status for the managed-child supervisor in `core_runtime`.
//! This module never starts processes or runs a second retry loop.
use super::*;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryStatus {
    pub phase: &'static str,
    pub attempt: usize,
    pub delay_seconds: u64,
    pub detail: String,
}

#[derive(Default)]
struct RecoveryState {
    armed: bool,
    status: Option<RecoveryStatus>,
}

#[derive(Default)]
pub(crate) struct CoreRecovery {
    state: Mutex<RecoveryState>,
    // Healthy status reads do not need to take the state lock.
    attention: AtomicBool,
}

impl CoreRecovery {
    pub fn wants_running(&self) -> bool {
        self.state.lock().map(|state| state.armed).unwrap_or(false)
    }

    pub fn running(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.armed = true;
            state.status = None;
            self.attention.store(false, Ordering::Release);
        }
    }

    pub fn cancel(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.armed = false;
            state.status = None;
            self.attention.store(false, Ordering::Release);
        }
    }

    pub fn exited(&self, detail: String) {
        if let Ok(mut state) = self.state.lock() {
            if !state.armed || state.status.is_some() {
                return;
            }
            eprintln!("CPA kernel exited unexpectedly: {detail}");
            state.status = Some(RecoveryStatus {
                phase: "waiting",
                attempt: 1,
                delay_seconds: 1,
                detail,
            });
            self.attention.store(true, Ordering::Release);
        }
    }

    pub fn waiting(&self, attempt: u32, delay: Duration) {
        if let Ok(mut state) = self.state.lock() {
            if !state.armed {
                return;
            }
            let detail = state
                .status
                .as_ref()
                .map(|status| status.detail.clone())
                .unwrap_or_else(|| "Managed kernel exited unexpectedly".into());
            state.status = Some(RecoveryStatus {
                phase: "waiting",
                attempt: attempt as usize,
                delay_seconds: delay.as_secs(),
                detail,
            });
            self.attention.store(true, Ordering::Release);
        }
    }

    pub fn restarting(&self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(status) = &mut state.status {
                status.phase = "restarting";
                status.delay_seconds = 0;
            }
        }
    }

    pub fn attempt_failed(&self, detail: String) {
        if let Ok(mut state) = self.state.lock() {
            if state.armed {
                if let Some(status) = &mut state.status {
                    status.phase = "waiting";
                    status.detail = detail;
                }
            }
        }
    }

    pub fn halt(&self, detail: String) {
        if let Ok(mut state) = self.state.lock() {
            let attempt = state
                .status
                .as_ref()
                .map(|status| status.attempt)
                .unwrap_or(0);
            state.armed = false;
            state.status = Some(RecoveryStatus {
                phase: "failed",
                attempt,
                delay_seconds: 0,
                detail,
            });
            self.attention.store(true, Ordering::Release);
        }
    }

    pub fn status(&self) -> Option<RecoveryStatus> {
        if !self.attention.load(Ordering::Acquire) {
            return None;
        }
        self.state.lock().ok()?.status.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_status_tracks_supervisor_and_cancellation() {
        let recovery = CoreRecovery::default();
        recovery.exited("initial startup failed".into());
        assert!(recovery.status().is_none());
        recovery.running();
        recovery.exited("PID 123 exited".into());
        recovery.exited("duplicate observation".into());
        assert_eq!(recovery.status().unwrap().detail, "PID 123 exited");
        recovery.waiting(2, Duration::from_secs(2));
        assert_eq!(recovery.status().unwrap().attempt, 2);
        recovery.restarting();
        assert_eq!(recovery.status().unwrap().phase, "restarting");
        recovery.attempt_failed("occupied port".into());
        assert_eq!(recovery.status().unwrap().detail, "occupied port");
        recovery.halt("budget exhausted".into());
        assert!(!recovery.wants_running());
        assert_eq!(recovery.status().unwrap().phase, "failed");
        recovery.cancel();
        recovery.exited("intentional stop".into());
        assert!(recovery.status().is_none());
        recovery.running();
        assert!(recovery.wants_running());
        assert!(recovery.status().is_none());
    }
}
