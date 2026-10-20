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

const USAGE: &str = "Usage: cpa-brief [--json] [--accounts] [--provider NAME] [--model TEXT] | --skill

Prints how much headroom each provider has and which models are routable now.
Reads cached data; reads the core's management API at most once a minute; never calls a provider.
  --json            structured output
  --accounts        add one line per account (masked ids)
  --provider NAME   only this provider (claude, codex, xai, ...)
  --model TEXT      only models whose id contains TEXT
  --skill           print the agent skill (SKILL.md) to install wherever you keep skills
";

const SKILL: &str = include_str!("../../../skills/cpa-brief/SKILL.md");

const START_HINT: &str = "Start EasyCLIProxyAPI and open Overview or Quota once so it can read the quota.";

const LOCK_FILE: &str = "refresh.lock";
const LOCK_STALE: Duration = Duration::from_secs(60);
const FUTURE_LOCK_SLACK: Duration = Duration::from_secs(5);
const LOCK_WAIT: Duration = Duration::from_secs(5);
const REFRESH_DEADLINE: Duration = Duration::from_secs(25);

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Debug, PartialEq)]
pub(crate) struct Args {
    pub(crate) json: bool,
    pub(crate) filters: Filters,
    pub(crate) help: bool,
    pub(crate) skill: bool,
}

pub(crate) fn parse_args(args: &[OsString]) -> Result<Args, String> {
    let mut parsed = Args { json: false, filters: Filters::default(), help: false, skill: false };
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
            "--provider" => parsed.filters.provider = Some(filter_value("--provider", value("--provider")?)?),
            "--model" => parsed.filters.model = Some(filter_value("--model", value("--model")?)?),
            "--help" | "-h" => parsed.help = true,
            "--skill" => parsed.skill = true,
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(parsed)
}

fn filter_value(flag: &str, value: String) -> Result<String, String> {
    if value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte)) {
        Ok(value)
    } else {
        Err(format!("{flag} value may contain only letters, digits, '.', '_', ':', '/', and '-'"))
    }
}

fn read_part<T: DeserializeOwned>(dir: &Path, file: &str) -> Option<T> {
    serde_json::from_slice(&std::fs::read(dir.join(file)).ok()?).ok()
}

/// One CLI refreshes at a time; the others wait briefly and then read the fresh file.
#[derive(Debug)]
pub(super) struct RefreshLock {
    path: PathBuf,
    owner: String,
}

impl RefreshLock {
    pub(super) fn acquire(dir: &Path) -> Result<Self, LockAcquireError> {
        let path = dir.join(LOCK_FILE);
        for _ in 0..2 {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
                    let owner = format!("{}-{nanos}", std::process::id());
                    if file.write_all(owner.as_bytes()).is_err() {
                        let _ = std::fs::remove_file(&path);
                        return Err(LockAcquireError::Unavailable);
                    }
                    return Ok(Self { path, owner });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(&path).and_then(|m| m.modified()).ok().is_some_and(|modified| {
                        match modified.duration_since(SystemTime::now()) {
                            Ok(ahead) => ahead > FUTURE_LOCK_SLACK,
                            Err(_) => modified.elapsed().is_ok_and(|age| age > LOCK_STALE),
                        }
                    });
                    if stale {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    return Err(LockAcquireError::Held);
                }
                Err(_) => return Err(LockAcquireError::Unavailable),
            }
        }
        Err(LockAcquireError::Unavailable)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum LockAcquireError { Held, Unavailable }

impl Drop for RefreshLock {
    fn drop(&mut self) {
        if std::fs::read(&self.path).ok().as_deref() == Some(self.owner.as_bytes()) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub(super) fn refresh_core(config: &GuiConfigFile, dir: &Path, origin: &str, cached: Option<CorePart>) -> Option<CorePart> {
    if std::fs::create_dir_all(dir).is_err() {
        return Some(refresh_without_cache(config, origin, cached.as_ref()));
    }
    match RefreshLock::acquire(dir) {
        Ok(_lock) => {
            // A caller that read the cache just before another finished its refresh must not ask the core again.
            if let Some(fresh) = read_part::<CorePart>(dir, CORE_FILE).filter(|p| p.origin == origin && is_fresh(p, now_ms())) {
                return Some(fresh);
            }
            let part = refresh_without_cache(config, origin, cached.as_ref());
            if let Ok(bytes) = serde_json::to_vec(&part) {
                // Failing to cache costs only the next caller a round trip.
                let _ = crate::write_private_bytes_atomically(&dir.join(CORE_FILE), &bytes);
            }
            Some(part)
        }
        Err(LockAcquireError::Held) => {
            // Someone else is refreshing: wait for their file instead of asking the core again.
            let started = std::time::Instant::now();
            while started.elapsed() < LOCK_WAIT && dir.join(LOCK_FILE).exists() {
                std::thread::sleep(Duration::from_millis(100));
            }
            read_part::<CorePart>(dir, CORE_FILE).filter(|part| part.origin == origin).or(cached)
        }
        Err(LockAcquireError::Unavailable) => {
            // A read-only or otherwise unwritable cache must not silently pin stale core state.
            Some(refresh_without_cache(config, origin, cached.as_ref()))
        }
    }
}

fn refresh_without_cache(config: &GuiConfigFile, origin: &str, cached: Option<&CorePart>) -> CorePart {
    let now = now_ms();
    tauri::async_runtime::block_on(tokio::time::timeout(REFRESH_DEADLINE, refresh::refresh(config, origin, cached, now)))
        .unwrap_or_else(|_| refresh::down(cached, origin, now, "core refresh timed out".to_string()))
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
    if args.help || args.skill {
        print(if args.skill { SKILL } else { USAGE });
        return 0;
    }
    // Read-only: unlike the app's own loader this never creates, migrates or rewrites the config.
    let (config, origin, mode) = match resolve_saved_target(crate::core_config::load_saved_gui_config_read_only()) {
        Ok(target) => target,
        Err(()) => {
            eprintln!("cpa-brief: no briefing data yet (saved settings are unavailable). {START_HINT}");
            return 1;
        }
    };
    let dir = match super::agent_dir() {
        Ok(dir) => dir,
        Err(_) => {
            eprintln!("cpa-brief: briefing cache is unavailable");
            return 1;
        }
    };
    let quota = read_part::<QuotaPart>(&dir, QUOTA_FILE).filter(|part| part.origin == origin);
    let mut core = read_part::<CorePart>(&dir, CORE_FILE).filter(|part| part.origin == origin);
    if !core.as_ref().is_some_and(|part| is_fresh(part, now_ms())) {
        core = refresh_core(&config, &dir, &origin, core);
    }
    if quota.is_none() && !core.as_ref().is_some_and(|part| part.ok_at_ms > 0) {
        eprintln!("cpa-brief: no briefing data yet (core could not be refreshed). {START_HINT}");
        return 1;
    }
    let briefing = render::build(&Inputs { mode, quota: quota.as_ref(), core: core.as_ref(), now_ms: now_ms() }, &args.filters);
    print(&if args.json { format!("{}\n", render::json(&briefing)) } else { render::text(&briefing) });
    0
}

pub(super) fn resolve_saved_target(config: Result<GuiConfigFile, String>) -> Result<(GuiConfigFile, String, &'static str), ()> {
    let config = config.map_err(|_| ())?;
    let connection = crate::core_connection::connection_from_config(&config).map_err(|_| ())?;
    let mode = match config.connection_mode {
        CoreConnectionMode::Remote => "remote",
        CoreConnectionMode::Local => "local",
    };
    Ok((config, connection.management_origin, mode))
}
