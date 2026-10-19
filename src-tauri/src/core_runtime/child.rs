use super::*;

pub(crate) fn core_child_has_exited(status: io::Result<Option<std::process::ExitStatus>>) -> bool {
    matches!(status, Ok(Some(_)))
}

pub(crate) struct CoreChild {
    child: Child,
    #[cfg(windows)]
    job: isize,
}

impl std::ops::Deref for CoreChild {
    type Target = Child;

    fn deref(&self) -> &Child {
        &self.child
    }
}

impl std::ops::DerefMut for CoreChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

impl Drop for CoreChild {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            close_windows_handle(self.job);
            let _ = self.child.wait();
        }
        #[cfg(not(windows))]
        if !matches!(self.child.try_wait(), Ok(Some(_))) {
            let _ = terminate_child(&mut self.child);
        }
    }
}

#[cfg(any(target_os = "linux", test))]
pub(super) struct CoreSpawnRequest {
    command: Command,
    reply: std::sync::mpsc::SyncSender<io::Result<Child>>,
}

#[cfg(any(target_os = "linux", test))]
pub(super) static CORE_PROCESS_SPAWNER: LazyLock<Result<std::sync::mpsc::Sender<CoreSpawnRequest>, String>> =
    LazyLock::new(|| {
        let (sender, receiver) = std::sync::mpsc::channel::<CoreSpawnRequest>();
        thread::Builder::new()
            .name("cpa-core-spawner".to_string())
            .spawn(move || {
                for mut request in receiver {
                    configure_child_lifetime(&mut request.command);
                    let result = request.command.spawn();
                    if let Err(std::sync::mpsc::SendError(Ok(mut child))) =
                        request.reply.send(result)
                    {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            })
            .map_err(|error| format!("Failed to create CPA kernel startup thread: {error}"))?;
        Ok(sender)
    });

pub(crate) fn spawn_core_child(command: Command) -> Result<CoreChild, String> {
    #[cfg(target_os = "linux")]
    let child = spawn_core_child_on_lifetime_thread(command)?;

    #[cfg(not(target_os = "linux"))]
    let child = {
        let mut command = command;
        command
            .spawn()
            .map_err(|error| format!("Failed to start CPA kernel: {error}"))?
    };

    #[cfg(windows)]
    let job = match attach_child_to_windows_job(&child) {
        Ok(job) => job,
        Err(error) => {
            let mut child = child;
            return match terminate_child(&mut child) {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(format!(
                    "{error}; failed to clean up unmanaged kernel process: {cleanup_error}"
                )),
            };
        }
    };
    Ok(CoreChild {
        child,
            #[cfg(windows)]
        job,
    })
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn spawn_core_child_on_lifetime_thread(command: Command) -> Result<Child, String> {
    let sender = CORE_PROCESS_SPAWNER.as_ref().map_err(Clone::clone)?;
    let (reply, result) = std::sync::mpsc::sync_channel(1);
    sender
        .send(CoreSpawnRequest { command, reply })
        .map_err(|_| "CPA kernel startup thread exited".to_string())?;
    result
        .recv()
        .map_err(|_| "CPA kernel startup thread did not return a startup result".to_string())?
        .map_err(|error| format!("Failed to start CPA kernel: {error}"))
}

pub(super) async fn run_core_command(
    app: tauri::AppHandle,
    operation: fn(&CoreProcessState, &GuiConfigState) -> Result<CoreStatus, String>,
) -> Result<CoreStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_core_operation(app.state::<CoreProcessState>().inner())?;
        let status = operation(
            app.state::<CoreProcessState>().inner(),
            app.state::<GuiConfigState>().inner(),
        )?;
        start_core_crash_supervisor_if_needed(app.state::<CoreProcessState>().inner(), || {
            start_core_crash_supervisor(app.clone());
        });
        emit_core_status(&app, &status);
        Ok(status)
    })
    .await
    .map_err(|error| format!("Kernel background task failed: {error}"))?
}
