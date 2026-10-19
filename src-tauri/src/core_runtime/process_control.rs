use super::*;

pub(crate) fn is_core_running(binary_path: &Path) -> bool {
    !find_core_process_ids(binary_path).is_empty()
}

pub(crate) fn find_core_process_ids(binary_path: &Path) -> Vec<u32> {
    find_candidate_core_process_ids()
        .into_iter()
        .filter(|process_id| {
            process_executable_path(*process_id)
                .as_deref()
                .is_some_and(|path| executable_paths_match(binary_path, path))
        })
        .collect()
}

pub(crate) fn executable_paths_match(expected: &Path, actual: &Path) -> bool {
    let expected = fs::canonicalize(expected).unwrap_or_else(|_| expected.to_path_buf());
    let actual = fs::canonicalize(actual).unwrap_or_else(|_| actual.to_path_buf());

    #[cfg(windows)]
    {
        path_to_string(&expected).eq_ignore_ascii_case(&path_to_string(&actual))
    }

    #[cfg(not(windows))]
    {
        expected == actual
    }
}

#[cfg(all(not(target_os = "linux"), target_os = "windows"))]
pub(crate) fn find_candidate_core_process_ids() -> Vec<u32> {
    use std::{ffi::OsString, mem, os::windows::ffi::OsStringExt};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Vec::new();
    }

    let mut entry = unsafe { mem::zeroed::<PROCESSENTRY32W>() };
    entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut process_ids = Vec::new();
    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            let name_length = entry
                .szExeFile
                .iter()
                .position(|character| *character == 0)
                .unwrap_or(entry.szExeFile.len());
            let image_name = OsString::from_wide(&entry.szExeFile[..name_length]);
            if entry.th32ProcessID != 0
                && image_name
                    .to_string_lossy()
                    .eq_ignore_ascii_case(core_binary_name())
            {
                process_ids.push(entry.th32ProcessID);
            }
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }
    unsafe { CloseHandle(snapshot) };
    process_ids
}

#[cfg(all(not(target_os = "linux"), not(target_os = "windows")))]
pub(crate) fn find_candidate_core_process_ids() -> Vec<u32> {
    Command::new("pgrep")
        .args(["-x", core_binary_name()])
        .output()
        .ok()
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
pub(crate) fn find_candidate_core_process_ids() -> Vec<u32> {
    Command::new("pgrep")
        .args(["-x", core_binary_name()])
        .output()
        .ok()
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
pub(crate) fn process_executable_path(process_id: u32) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{process_id}/exe")).ok()
}

#[cfg(target_os = "macos")]
pub(crate) fn process_executable_path(process_id: u32) -> Option<PathBuf> {
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};

    extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, buffer_size: u32) -> i32;
    }

    let mut buffer = vec![0_u8; 4096];
    let length = unsafe {
        proc_pidpath(
            process_id.try_into().ok()?,
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
        )
    };
    if length <= 0 {
        return None;
    }
    buffer.truncate(length as usize);
    Some(PathBuf::from(OsString::from_vec(buffer)))
}

#[cfg(windows)]
pub(crate) fn process_executable_path(process_id: u32) -> Option<PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    if handle.is_null() {
        return None;
    }
    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    let success =
        unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe { CloseHandle(handle as HANDLE) };
    if success == 0 {
        return None;
    }
    buffer.truncate(length as usize);
    Some(PathBuf::from(OsString::from_wide(&buffer)))
}

pub(crate) fn adopt_existing_core_processes(
    process_state: &CoreProcessState,
) -> Result<Vec<u32>, String> {
    let install_dir = core_install_dir()?;
    let Some(binary_path) = find_core_binary(&install_dir) else {
        process_state.clear_adopted_processes()?;
        return Ok(Vec::new());
    };
    let process_ids = find_core_process_ids(&binary_path);
    process_state.adopt_process_ids(&binary_path, process_ids.clone())?;
    Ok(process_ids)
}

pub(crate) fn shutdown_managed_core(
    process_state: &CoreProcessState,
    gui_config_state: &GuiConfigState,
) {
    if !gui_config_state.snapshot().is_ok_and(|config| config.connection_mode == CoreConnectionMode::Local) {
        // Remote-only sessions must not discover or stop processes on this machine.
        // Selecting remote mode is rejected while a GUI-owned local child is alive.
        return;
    }
    let was_running = process_state.managed_pid().is_some()
        || core_install_dir()
            .ok()
            .and_then(|install_dir| find_core_binary(&install_dir))
            .is_some_and(|binary_path| is_core_running(&binary_path));
    if was_running {
        if let Err(error) = stop_core_process_inner(process_state) {
            eprintln!("Failed to stop CPA kernel on exit: {error}");
        }
    }
    if let Err(error) = gui_config_state.set_run_on_startup(was_running) {
        eprintln!("Failed to save kernel state before exit: {error}");
    }
}

#[cfg(windows)]
pub(crate) fn attach_child_to_windows_job(child: &Child) -> Result<isize, String> {
    use std::{mem, os::windows::io::AsRawHandle, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    unsafe {
        let job = CreateJobObjectW(ptr::null(), ptr::null());
        if job.is_null() {
            return Err(format!(
                "Failed to create CPA kernel process job: {}",
                io::Error::last_os_error()
            ));
        }

        let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &information as *const _ as *const _,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            let error = io::Error::last_os_error();
            CloseHandle(job);
            return Err(format!("Failed to configure CPA kernel process job: {error}"));
        }

        let process_handle = child.as_raw_handle() as HANDLE;
        if AssignProcessToJobObject(job, process_handle) == 0 {
            let error = io::Error::last_os_error();
            CloseHandle(job);
            return Err(format!("Failed to manage CPA kernel child process: {error}"));
        }

        Ok(job as isize)
    }
}

#[cfg(windows)]
pub(crate) fn close_windows_handle(handle: isize) {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};

    unsafe {
        CloseHandle(handle as HANDLE);
    }
}

pub(crate) fn terminate_child(child: &mut Child) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|error| format!("Failed to check CPA kernel process status: {error}"))?
        .is_some()
    {
        return Ok(());
    }
    #[cfg(windows)]
    {
        child
            .kill()
            .map_err(|err| format!("Failed to stop CPA kernel process: {err}"))?;
        child
            .wait()
            .map_err(|err| format!("Failed while waiting for CPA kernel process to exit: {err}"))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        let process_id = child.id();
        send_process_signal(process_id, "TERM")?;

        for _ in 0..20 {
            match child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => thread::sleep(Duration::from_millis(100)),
                Err(err) => return Err(format!("Failed to check CPA kernel process status: {err}")),
            }
        }

        child
            .kill()
            .map_err(|err| format!("Failed to force-stop CPA kernel process: {err}"))?;
        child
            .wait()
            .map_err(|err| format!("Failed while waiting for CPA kernel process to exit: {err}"))?;

        Ok(())
    }
}

pub(crate) fn terminate_process_id(process_id: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::{
            Foundation::{ERROR_INVALID_PARAMETER, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
        };

        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, process_id) };
        if handle.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                return Ok(());
            }
            return Err(format!("Failed to open CPA kernel process: PID {process_id}: {error}"));
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let raw_handle = handle.as_raw_handle();
        if unsafe { WaitForSingleObject(raw_handle, 0) } == WAIT_OBJECT_0 {
            return Ok(());
        }
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &process_id.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_command(&mut command);
        let status = command
            .status()
            .map_err(|err| format!("Failed to stop CPA kernel process: {err}"))?;
        let wait =
            unsafe { WaitForSingleObject(raw_handle, if status.success() { 10_000 } else { 0 }) };
        match wait {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err(format!("CPA kernel process did not exit: PID {process_id}")),
            _ => Err(format!(
                "Failed while waiting for CPA kernel process to exit: PID {process_id}: {}",
                io::Error::last_os_error()
            )),
        }
    }

    #[cfg(not(windows))]
    {
        send_process_signal(process_id, "TERM")?;

        for _ in 0..20 {
            if !is_process_alive(process_id) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }

        send_process_signal(process_id, "KILL")
    }
}

#[cfg(not(windows))]
pub(crate) fn send_process_signal(process_id: u32, signal: &str) -> Result<(), String> {
    let status = Command::new("kill")
        .args([format!("-{signal}"), process_id.to_string()])
        .status()
        .map_err(|err| format!("Failed to send process signal: {err}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Failed to send process signal: PID {process_id}"))
    }
}

#[cfg(windows)]
pub(crate) fn is_process_alive(process_id: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, WaitForSingleObject},
    };

    const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
    let handle = unsafe { OpenProcess(SYNCHRONIZE_ACCESS, 0, process_id) };
    if handle.is_null() {
        return false;
    }
    let result = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    result == WAIT_TIMEOUT
}

#[cfg(not(windows))]
pub(crate) fn is_process_alive(process_id: u32) -> bool {
    let process_id = process_id.to_string();
    Command::new("kill")
        .args(["-0", &process_id])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
