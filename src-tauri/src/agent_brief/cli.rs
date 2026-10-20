//! The `--brief` command line: runs before the instance lock and before any Tauri, GTK or webview
//! initialisation, so it is fast and can never start a second GUI.
use super::model::{CorePart, QuotaPart, CORE_FILE, QUOTA_FILE};
use super::refresh::{self, is_fresh};
use super::render::{self, Filters, Inputs};
use crate::{CoreConnectionMode, GuiConfigFile};
use serde::de::DeserializeOwned;
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const USAGE: &str = "Usage: cpa-brief [--json] [--accounts] [--provider NAME] [--model TEXT]

Prints how much headroom each provider has and which models are routable now.
Reads cached data; reads the core's management API at most once a minute; never calls a provider.
  --json            structured output
  --accounts        add one line per account (masked ids)
  --provider NAME   only this provider (claude, codex, xai, ...)
  --model TEXT      only models whose id contains TEXT
";

const LOCK_FILE: &str = "refresh.lock";
const LOCK_STALE: Duration = Duration::from_secs(20);
const LOCK_WAIT: Duration = Duration::from_secs(5);

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Debug, PartialEq)]
pub(crate) struct Args {
    pub(crate) json: bool,
    pub(crate) filters: Filters,
    pub(crate) help: bool,
}

pub(crate) fn parse_args(args: &[OsString]) -> Result<Args, String> {
    let mut parsed = Args { json: false, filters: Filters::default(), help: false };
    let mut iter = args.iter().map(|arg| arg.to_string_lossy().to_string());
    while let Some(arg) = iter.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag.to_string(), Some(value.to_string())),
            _ => (arg.clone(), None),
        };
        let mut value = |name: &str| {
            inline.clone().or_else(|| iter.next()).filter(|v| !v.is_empty()).ok_or_else(|| format!("{name} needs a value"))
        };
        match flag.as_str() {
            "--json" => parsed.json = true,
            "--accounts" => parsed.filters.accounts = true,
            "--provider" => parsed.filters.provider = Some(value("--provider")?),
            "--model" => parsed.filters.model = Some(value("--model")?),
            "--help" | "-h" => parsed.help = true,
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(parsed)
}

fn read_part<T: DeserializeOwned>(dir: &Path, file: &str) -> Option<T> {
    serde_json::from_slice(&std::fs::read(dir.join(file)).ok()?).ok()
}

/// Read-only: unlike the app's own loader this never creates, migrates or rewrites the config.
fn load_config() -> Result<GuiConfigFile, String> {
    crate::core_config::load_saved_gui_config_read_only()
}

/// One CLI refreshes at a time; the others wait briefly and then read the fresh file.
struct RefreshLock(PathBuf);

impl RefreshLock {
    fn acquire(dir: &Path) -> Option<Self> {
        let path = dir.join(LOCK_FILE);
        for _ in 0..2 {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Some(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let age = std::fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
                    if age.is_some_and(|age| age > LOCK_STALE) {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    return None;
                }
                Err(_) => return None,
            }
        }
        None
    }
}

impl Drop for RefreshLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn refresh_core(config: &GuiConfigFile, dir: &Path, origin: &str, cached: Option<CorePart>) -> Option<CorePart> {
    if std::fs::create_dir_all(dir).is_err() {
        return cached;
    }
    match RefreshLock::acquire(dir) {
        Some(_lock) => {
            let now = now_ms();
            let part = tauri::async_runtime::block_on(refresh::refresh(config, origin, cached.as_ref(), now));
            if let Ok(bytes) = serde_json::to_vec(&part) {
                // Failing to cache costs only the next caller a round trip.
                let _ = crate::write_private_bytes_atomically(&dir.join(CORE_FILE), &bytes);
            }
            Some(part)
        }
        None => {
            // Someone else is refreshing: wait for their file instead of asking the core again.
            let started = std::time::Instant::now();
            while started.elapsed() < LOCK_WAIT && dir.join(LOCK_FILE).exists() {
                std::thread::sleep(Duration::from_millis(100));
            }
            read_part::<CorePart>(dir, CORE_FILE).filter(|part| part.origin == origin).or(cached)
        }
    }
}

#[cfg(windows)]
fn attach_parent_console() {
    // Release builds use the GUI subsystem, which has no console of its own. When started from a
    // terminal, attach to it and point stdout/stderr there unless the caller redirected them.
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::Console::{
        AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };
    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return;
        }
        let name: Vec<u16> = "CONOUT$\0".encode_utf16().collect();
        for kind in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let current = GetStdHandle(kind);
            if current.is_null() || current == INVALID_HANDLE_VALUE {
                let handle = CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    0,
                    std::ptr::null_mut(),
                );
                if handle != INVALID_HANDLE_VALUE {
                    SetStdHandle(kind, handle);
                }
            }
        }
    }
}

fn print(text: &str) {
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(text.as_bytes());
    let _ = stdout.flush();
}

/// Entry point for `cpa-gui --brief ...`. Returns the process exit code.
pub(crate) fn run_cli(args: &[OsString]) -> i32 {
    #[cfg(windows)]
    attach_parent_console();
    let args = match parse_args(args) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("cpa-brief: {error}\n\n{USAGE}");
            return 2;
        }
    };
    if args.help {
        print(USAGE);
        return 0;
    }
    let dir = match super::agent_dir() {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("cpa-brief: {error}");
            return 1;
        }
    };
    let config = load_config();
    let origin = config
        .as_ref()
        .ok()
        .and_then(|config| crate::core_connection::connection_from_config(config).ok())
        .map(|connection| connection.management_origin);
    let mode = match config.as_ref().map(|config| config.connection_mode) {
        Ok(CoreConnectionMode::Remote) => "remote",
        _ => "local",
    };
    let for_origin = |part: Option<QuotaPart>| part.filter(|part| origin.as_ref().map_or(true, |o| *o == part.origin));
    let quota = for_origin(read_part::<QuotaPart>(&dir, QUOTA_FILE));
    let mut core = read_part::<CorePart>(&dir, CORE_FILE)
        .filter(|part| origin.as_ref().map_or(true, |o| *o == part.origin));
    if let (Ok(config), Some(origin)) = (&config, &origin) {
        if !core.as_ref().is_some_and(|part| is_fresh(part, now_ms())) {
            core = refresh_core(config, &dir, origin, core);
        }
    }
    if quota.is_none() && core.as_ref().map_or(true, |part| part.accounts.is_empty()) {
        let reason = match &config {
            Err(error) => error.clone(),
            Ok(_) => core.as_ref().map(|part| part.error.clone()).filter(|e| !e.is_empty()).unwrap_or_default(),
        };
        let detail = if reason.is_empty() { String::new() } else { format!(" ({reason})") };
        eprintln!(
            "cpa-brief: no briefing data yet{detail}. Start EasyCLIProxyAPI and open Overview or Quota once so it can read the quota."
        );
        return 1;
    }
    let briefing = render::build(&Inputs { mode, quota: quota.as_ref(), core: core.as_ref(), now_ms: now_ms() }, &args.filters);
    if args.json {
        print(&format!("{}\n", serde_json::to_string(&render::json(&briefing)).unwrap_or_default()));
    } else {
        print(&render::text(&briefing));
    }
    0
}
