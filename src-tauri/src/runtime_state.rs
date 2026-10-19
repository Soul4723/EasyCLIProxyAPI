use super::*;

#[derive(Default)]
pub(crate) struct CoreDownloadState {
    pub(crate) inner: Mutex<CoreDownloadInner>,
}

#[derive(Default)]
pub(crate) struct CoreDownloadInner {
    pub(crate) running: bool,
    pub(crate) token: Option<CancellationToken>,
    pub(crate) task: CoreInstallTask,
}

#[derive(Default)]
pub(crate) struct AppUpdateState {
    pub(crate) inner: Mutex<AppUpdateInner>,
}

#[derive(Default)]
pub(crate) struct AppUpdateInner {
    pub(crate) task: AppUpdateTask,
    pub(crate) token: Option<CancellationToken>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ChildSupervision {
    #[default]
    Idle,
    Running {
        started_at: Instant,
    },
    Recovering,
}

#[derive(Default)]
pub(crate) struct CoreProcessState {
    pub(crate) recovery: core_recovery::CoreRecovery,
    pub(crate) child: Mutex<Option<CoreChild>>,
    pub(crate) adopted_processes: Mutex<Vec<AdoptedCoreProcess>>,
    pub(crate) starting: AtomicBool,
    pub(crate) shutting_down: AtomicBool,
    pub(crate) shutdown_complete: AtomicBool,
    pub(crate) supervisor_started: AtomicBool,
    pub(crate) supervision_generation: AtomicU64,
    pub(crate) supervision: Mutex<ChildSupervision>,
    pub(crate) crash_restart_attempts: AtomicU32,
}

#[derive(Default)]
pub(crate) struct DeepSeekHarnessProcessState {
    pub(crate) process: Mutex<Option<ManagedDeepSeekHarnessProcess>>,
}

pub(crate) struct ManagedDeepSeekHarnessProcess {
    pub(crate) child: Child,
    pub(crate) mode: String,
    pub(crate) launch: DeepSeekHarnessLaunchSnapshot,
}

#[derive(Clone)]
pub(crate) struct DeepSeekHarnessLaunchSnapshot {
    pub(crate) executable: PathBuf,
    pub(crate) working_directory: PathBuf,
    pub(crate) arguments: Vec<String>,
    pub(crate) options: Option<DeepSeekHarnessLaunchOptions>,
}

#[derive(Clone)]
pub(crate) struct AdoptedCoreProcess {
    pub(crate) process_id: u32,
    pub(crate) binary_path: PathBuf,
}

#[derive(Default)]
pub(crate) struct AgentConfigStatusCache {
    pub(crate) refresh_lock: Mutex<()>,
    pub(crate) entry: Mutex<Option<AgentConfigStatusCacheEntry>>,
}

pub(crate) struct AgentConfigStatusCacheEntry {
    pub(crate) origin: String,
    pub(crate) api_key_sha256: String,
    pub(crate) statuses: Vec<AgentConfigStatus>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigFilesChangedPayload {
    pub(crate) paths: Vec<String>,
    pub(crate) errors: Vec<String>,
}

impl AgentConfigStatusCache {
    pub(crate) fn get(&self, port: impl AgentClientOrigin, api_key: &str) -> Result<Option<Vec<AgentConfigStatus>>, String> {
        let api_key_sha256 = sha256_bytes(api_key.as_bytes());
        self.entry
            .lock()
            .map(|entry| {
                entry
                    .as_ref()
                    .filter(|entry| entry.origin == port.client_origin() && entry.api_key_sha256 == api_key_sha256)
                    .map(|entry| entry.statuses.clone())
            })
            .map_err(|_| "Agent configuration status cache lock is poisoned".to_string())
    }

    pub(crate) fn replace(
        &self,
        port: impl AgentClientOrigin,
        api_key: &str,
        statuses: Vec<AgentConfigStatus>,
    ) -> Result<(), String> {
        let mut current = self
            .entry
            .lock()
            .map_err(|_| "Agent configuration status cache lock is poisoned".to_string())?;
        *current = Some(AgentConfigStatusCacheEntry {
            origin: port.client_origin(),
            api_key_sha256: sha256_bytes(api_key.as_bytes()),
            statuses,
        });
        Ok(())
    }

    pub(crate) fn clear(&self) -> Result<(), String> {
        let mut current = self
            .entry
            .lock()
            .map_err(|_| "Agent configuration status cache lock is poisoned".to_string())?;
        *current = None;
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CorePlatform {
    pub(crate) os: String,
    pub(crate) arch: String,
    pub(crate) asset_os: String,
    pub(crate) asset_arch: String,
    pub(crate) archive_kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreStatus {
    pub(crate) installed: bool,
    pub(crate) running: bool,
    pub(crate) ready: bool,
    pub(crate) starting: bool,
    pub(crate) managed: bool,
    pub(crate) process_id: Option<u32>,
    pub(crate) current_version: Option<String>,
    pub(crate) install_dir: String,
    pub(crate) binary_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) connection_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) remote_origin: Option<String>,
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) recovery: Option<core_recovery::RecoveryStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreLatest {
    pub(crate) version: String,
    pub(crate) asset_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUpdateInfo {
    pub(crate) current_version: String,
    pub(crate) latest_version: String,
    pub(crate) update_available: bool,
    pub(crate) release_url: String,
    pub(crate) release_notes: HashMap<String, String>,
    pub(crate) published_at: String,
    pub(crate) auto_update_supported: bool,
    pub(crate) download_size_bytes: Option<u64>,
    pub(crate) unsupported_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortableUpdateManifest {
    pub(crate) schema_version: u32,
    pub(crate) version: String,
    pub(crate) published_at: String,
    pub(crate) release_url: String,
    #[serde(default, deserialize_with = "deserialize_release_notes")]
    pub(crate) release_notes: HashMap<String, String>,
    pub(crate) assets: std::collections::HashMap<String, PortableUpdateAsset>,
    #[serde(default)]
    pub(crate) full_assets: Option<std::collections::HashMap<String, PortableUpdateAsset>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortableUpdateAsset {
    pub(crate) url: String,
    #[serde(default)]
    pub(crate) fallback_urls: Vec<String>,
    pub(crate) sha256: String,
    pub(crate) size_bytes: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitcodeRelease {
    pub(crate) tag_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortableAppManifest {
    pub(crate) schema_version: u32,
    pub(crate) application: String,
    pub(crate) version: String,
    pub(crate) platform: String,
    pub(crate) arch: String,
    #[serde(default)]
    pub(crate) auto_update: bool,
}

#[derive(Clone)]
pub(crate) struct PendingAppUpdate {
    pub(crate) version: String,
    pub(crate) asset: PortableUpdateAsset,
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) arch: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppUpdateTask {
    pub(crate) running: bool,
    pub(crate) cancellable: bool,
    pub(crate) phase: String,
    pub(crate) target_version: Option<String>,
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) percent: Option<f64>,
    pub(crate) message: Option<String>,
}

impl Default for AppUpdateTask {
    fn default() -> Self {
        Self {
            running: false,
            cancellable: false,
            phase: "idle".to_string(),
            target_version: None,
            downloaded_bytes: 0,
            total_bytes: None,
            percent: None,
            message: None,
        }
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub(crate) struct PortablePackagePayload {
    pub(crate) manifest: PortableAppManifest,
    pub(crate) core_archive_name: Option<String>,
}

#[cfg(any(windows, target_os = "linux"))]
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PortableUpdateDescriptor {
    pub(crate) parent_pid: u32,
    pub(crate) current_exe: PathBuf,
    pub(crate) staged_exe: PathBuf,
    pub(crate) current_manifest: PathBuf,
    pub(crate) staged_manifest: PathBuf,
    pub(crate) backup_exe: PathBuf,
    pub(crate) backup_manifest: PathBuf,
    pub(crate) current_core_version: PathBuf,
    pub(crate) staged_core_version: PathBuf,
    pub(crate) backup_core_version: PathBuf,
    pub(crate) staged_core_archive: PathBuf,
    pub(crate) target_core_archive: PathBuf,
    pub(crate) install_core_archive: bool,
    pub(crate) ack_path: PathBuf,
    pub(crate) work_dir: PathBuf,
    pub(crate) target_version: String,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MacosUpdateDescriptor {
    pub(crate) parent_pid: u32,
    pub(crate) current_app: PathBuf,
    pub(crate) staged_app: PathBuf,
    pub(crate) backup_app: PathBuf,
    pub(crate) executable_relative_path: PathBuf,
    pub(crate) ack_path: PathBuf,
    pub(crate) work_dir: PathBuf,
    pub(crate) target_version: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BundledCoreInfo {
    pub(crate) version: String,
    pub(crate) asset_name: String,
    pub(crate) size_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreInstallResult {
    pub(crate) version: String,
    pub(crate) asset_name: String,
    pub(crate) install_dir: String,
    pub(crate) binary_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreInstallTask {
    pub(crate) running: bool,
    pub(crate) cancellable: bool,
    pub(crate) phase: String,
    pub(crate) downloaded: u64,
    pub(crate) total: Option<u64>,
    pub(crate) percent: Option<f64>,
    pub(crate) message: Option<String>,
    pub(crate) result: Option<CoreInstallResult>,
}

impl Default for CoreInstallTask {
    fn default() -> Self {
        Self {
            running: false,
            cancellable: false,
            phase: "Idle".to_string(),
            downloaded: 0,
            total: None,
            percent: None,
            message: None,
            result: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreMetadata {
    pub(crate) version: String,
    pub(crate) asset_name: String,
    pub(crate) installed_at_unix: u64,
}

pub(crate) struct DownloadedArchive {
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

impl CoreDownloadState {
    pub(crate) fn start(&self, token: CancellationToken, version: Option<String>) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Kernel installation status lock is poisoned".to_string())?;

        if inner.running {
            return Err("A kernel installation task is already running".to_string());
        }

        inner.running = true;
        inner.token = Some(token);
        inner.task = CoreInstallTask {
            running: true,
            cancellable: true,
            phase: version
                .map(|version| format!("Preparing to install {version}"))
                .unwrap_or_else(|| "Preparing to install the latest version".to_string()),
            downloaded: 0,
            total: None,
            percent: None,
            message: None,
            result: None,
        };

        Ok(())
    }

    pub(crate) fn cancel(&self) {
        if let Ok(inner) = self.inner.lock() {
            if let Some(token) = &inner.token {
                token.cancel();
            }
        }
    }

    pub(crate) fn snapshot(&self) -> CoreInstallTask {
        self.inner
            .lock()
            .map(|inner| inner.task.clone())
            .unwrap_or_default()
    }

    pub(crate) fn progress(
        &self,
        window: &tauri::Window,
        phase: &str,
        downloaded: u64,
        total: Option<u64>,
        cancellable: bool,
    ) {
        let percent = total
            .filter(|total| *total > 0)
            .map(|total| downloaded as f64 * 100.0 / total as f64);

        let task = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };

            inner.task.running = inner.running;
            inner.task.cancellable = cancellable;
            inner.task.phase = phase.to_string();
            inner.task.downloaded = downloaded;
            inner.task.total = total;
            inner.task.percent = percent;
            inner.task.clone()
        };

        let _ = window.emit(CORE_INSTALL_PROGRESS_EVENT, task);
    }

    pub(crate) fn finish(&self, window: &tauri::Window, result: Result<CoreInstallResult, String>) {
        let task = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };

            inner.running = false;
            inner.token = None;
            inner.task.running = false;
            inner.task.cancellable = false;

            match result {
                Ok(result) => {
                    inner.task.phase = "Installation complete".to_string();
                    inner.task.downloaded = 1;
                    inner.task.total = Some(1);
                    inner.task.percent = Some(100.0);
                    inner.task.message = Some(format!("{} installation complete", result.version));
                    inner.task.result = Some(result);
                }
                Err(error) => {
                    inner.task.phase = if error.to_ascii_lowercase().contains("cancel") {
                        "Canceled".to_string()
                    } else {
                        "Installation failed".to_string()
                    };
                    inner.task.message = Some(error);
                    inner.task.result = None;
                }
            }

            inner.task.clone()
        };

        let _ = window.emit(CORE_INSTALL_PROGRESS_EVENT, task);
    }
}

impl AppUpdateState {
    pub(crate) fn snapshot(&self) -> AppUpdateTask {
        self.inner
            .lock()
            .map(|inner| inner.task.clone())
            .unwrap_or_default()
    }

    pub(crate) fn set_available(&self, task: AppUpdateTask) {
        if let Ok(mut inner) = self.inner.lock() {
            if !inner.task.running {
                inner.task = task;
            }
        }
    }

    pub(crate) fn start(&self, token: CancellationToken) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Application update status lock is poisoned".to_string())?;
        if inner.task.running {
            return Err("An application update task is already running".to_string());
        }
        inner.token = Some(token);
        inner.task = AppUpdateTask {
            running: true,
            cancellable: true,
            phase: "checking".to_string(),
            ..AppUpdateTask::default()
        };
        Ok(())
    }

    pub(crate) fn start_download(&self, pending: &PendingAppUpdate) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Application update status lock is poisoned".to_string())?;
        if !inner.task.running || inner.task.phase != "checking" {
            return Err("Application update is not in the checking stage".to_string());
        }
        if inner
            .token
            .as_ref()
            .is_none_or(CancellationToken::is_cancelled)
        {
            return Err("Application update download canceled".to_string());
        }
        inner.task = AppUpdateTask {
            running: true,
            cancellable: true,
            phase: "downloading".to_string(),
            target_version: Some(pending.version.clone()),
            downloaded_bytes: 0,
            total_bytes: Some(pending.asset.size_bytes),
            percent: Some(0.0),
            message: None,
        };
        Ok(())
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    pub(crate) fn update_task<F>(&self, update: F) -> AppUpdateTask
    where
        F: FnOnce(&mut AppUpdateTask),
    {
        let Ok(mut inner) = self.inner.lock() else {
            return AppUpdateTask::default();
        };
        update(&mut inner.task);
        inner.task.clone()
    }

    pub(crate) fn finish(&self, phase: &str, message: Option<String>) -> AppUpdateTask {
        let Ok(mut inner) = self.inner.lock() else {
            return AppUpdateTask::default();
        };
        inner.task.running = false;
        inner.task.cancellable = false;
        inner.task.phase = phase.to_string();
        inner.task.message = message;
        inner.token = None;
        inner.task.clone()
    }

    pub(crate) fn cancel(&self) {
        if let Ok(inner) = self.inner.lock() {
            if let Some(token) = &inner.token {
                token.cancel();
            }
        }
    }
}

impl CoreProcessState {
    pub(crate) fn new(starting: bool) -> Self {
        Self {
            recovery: core_recovery::CoreRecovery::default(),
            child: Mutex::new(None),
            adopted_processes: Mutex::new(Vec::new()),
            starting: AtomicBool::new(starting),
            shutting_down: AtomicBool::new(false),
            shutdown_complete: AtomicBool::new(false),
            supervisor_started: AtomicBool::new(false),
            supervision_generation: AtomicU64::new(0),
            supervision: Mutex::new(ChildSupervision::Idle),
            crash_restart_attempts: AtomicU32::new(0),
        }
    }

    pub(crate) fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }

    pub(crate) fn ensure_active(&self) -> Result<(), String> {
        if self.is_shutting_down() {
            Err("Application is exiting; kernel operation canceled".to_string())
        } else {
            Ok(())
        }
    }

    pub(crate) fn is_starting(&self) -> bool {
        self.starting.load(Ordering::Acquire)
    }

    pub(crate) fn set_starting(&self, starting: bool) {
        self.starting.store(starting, Ordering::Release);
    }

    pub(crate) fn reset_crash_restart_attempts(&self) {
        self.crash_restart_attempts.store(0, Ordering::Release);
    }

    pub(crate) fn record_crash_restart_attempt(&self) -> u32 {
        self.crash_restart_attempts.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub(crate) fn is_supervising(&self) -> bool {
        self.supervision
            .lock()
            .map(|supervision| !matches!(*supervision, ChildSupervision::Idle))
            .unwrap_or(false)
    }

    pub(crate) fn clear_supervision(&self) {
        if let Ok(mut supervision) = self.supervision.lock() {
            *supervision = ChildSupervision::Idle;
        }
    }

    pub(crate) fn disarm_supervision(&self) {
        self.recovery.cancel();
        self.supervision_generation.fetch_add(1, Ordering::AcqRel);
        self.clear_supervision();
        self.reset_crash_restart_attempts();
    }

    pub(crate) fn finish_recovery_pass(&self) {
        if let Ok(mut supervision) = self.supervision.lock() {
            if matches!(*supervision, ChildSupervision::Recovering) {
                *supervision = ChildSupervision::Idle;
            }
        }
    }

    pub(crate) fn complete_recovery_when_already_running(&self) {
        self.finish_recovery_pass();
        self.reset_crash_restart_attempts();
        if self.is_supervising() {
            self.recovery.running();
        } else {
            self.recovery.cancel();
        }
    }

    #[cfg(test)]
    pub(crate) fn set_supervision_started_at(&self, started_at: Instant) {
        if let Ok(mut supervision) = self.supervision.lock() {
            *supervision = ChildSupervision::Running { started_at };
        }
    }

    pub(crate) fn poll_unexpected_child_exit(&self, stable_uptime: Duration) -> bool {
        let Ok(mut child) = self.child.lock() else {
            return false;
        };
        let child_alive = if let Some(process) = child.as_mut() {
            if !core_child_has_exited(process.try_wait()) {
                true
            } else {
                self.recovery.exited(format!("PID {} exited unexpectedly", process.id()));
                *child = None;
                false
            }
        } else {
            false
        };

        let Ok(mut supervision) = self.supervision.lock() else {
            return false;
        };
        if child_alive {
            if let ChildSupervision::Running { started_at } = *supervision {
                if started_at.elapsed() >= stable_uptime {
                    self.reset_crash_restart_attempts();
                }
            }
            return false;
        }

        match *supervision {
            ChildSupervision::Idle => false,
            ChildSupervision::Running { started_at } => {
                if started_at.elapsed() >= stable_uptime {
                    self.reset_crash_restart_attempts();
                }
                *supervision = ChildSupervision::Recovering;
                true
            }
            ChildSupervision::Recovering => true,
        }
    }

    pub(crate) fn managed_pid(&self) -> Option<u32> {
        if let Ok(mut child) = self.child.lock() {
            if let Some(process) = child.as_mut() {
                match process.try_wait() {
                    Ok(None) | Err(_) => return Some(process.id()),
                    Ok(Some(exit)) => {
                        self.recovery.exited(format!("PID {}: {exit}", process.id()));
                        *child = None;
                    }
                }
            }
        }

        self.adopted_processes
            .lock()
            .ok()
            .and_then(|mut processes| {
                processes.retain(|process| {
                    process_executable_path(process.process_id)
                        .as_deref()
                        .is_some_and(|path| executable_paths_match(&process.binary_path, path))
                });
                processes.first().map(|process| process.process_id)
            })
    }

    pub(crate) fn take_child(&self) -> Option<CoreChild> {
        let taken = self.child.lock().ok().and_then(|mut child| child.take());
        self.disarm_supervision();
        taken
    }

    pub(crate) fn adopt_process_ids(&self, binary_path: &Path, process_ids: Vec<u32>) -> Result<(), String> {
        let mut adopted_list: Vec<AdoptedCoreProcess> = process_ids
            .into_iter()
            .filter(|process_id| is_process_alive(*process_id))
            .map(|process_id| AdoptedCoreProcess {
                process_id,
                binary_path: binary_path.to_path_buf(),
            })
            .collect();
        adopted_list.sort_unstable_by_key(|process| process.process_id);
        adopted_list.dedup_by_key(|process| process.process_id);
        let has_adopted = !adopted_list.is_empty();
        let mut child = self
            .child
            .lock()
            .map_err(|_| "Kernel process status lock is poisoned".to_string())?;
        let has_live_managed_child = if let Some(process) = child.as_mut() {
            if !core_child_has_exited(process.try_wait()) {
                true
            } else {
                *child = None;
                false
            }
        } else {
            false
        };
        {
            let mut adopted = self
                .adopted_processes
                .lock()
                .map_err(|_| "Adopted kernel process status lock is poisoned".to_string())?;
            *adopted = adopted_list;
        }
        if has_adopted && !has_live_managed_child {
            self.disarm_supervision();
        }
        Ok(())
    }

    pub(crate) fn clear_adopted_processes(&self) -> Result<(), String> {
        self.adopted_processes
            .lock()
            .map(|mut processes| processes.clear())
            .map_err(|_| "Adopted kernel process status lock is poisoned".to_string())
    }

    pub(crate) fn take_adopted_processes(&self) -> Vec<AdoptedCoreProcess> {
        self.adopted_processes
            .lock()
            .map(|mut processes| std::mem::take(&mut *processes))
            .unwrap_or_default()
    }

    pub(crate) fn store_child(&self, child: CoreChild) -> Result<u32, String> {
        self.ensure_active()?;
        let pid = child.id();
        let mut managed_child = self
            .child
            .lock()
            .map_err(|_| "Kernel process status lock is poisoned".to_string())?;
        let mut adopted = self
            .adopted_processes
            .lock()
            .map_err(|_| "Adopted kernel process status lock is poisoned".to_string())?;
        adopted.clear();
        self.supervision_generation.fetch_add(1, Ordering::AcqRel);
        *managed_child = Some(child);
        self.recovery.running();
        if let Ok(mut supervision) = self.supervision.lock() {
            *supervision = ChildSupervision::Running {
                started_at: Instant::now(),
            };
        }
        Ok(pid)
    }
}

#[derive(Deserialize)]
pub(crate) struct GithubRelease {
    pub(crate) tag_name: String,
    pub(crate) assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
pub(crate) struct GithubAsset {
    pub(crate) name: String,
    pub(crate) browser_download_url: String,
    #[serde(default)]
    pub(crate) fallback_download_urls: Vec<String>,
    pub(crate) size: Option<u64>,
    pub(crate) digest: Option<String>,
}
