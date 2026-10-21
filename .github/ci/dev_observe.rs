//! Opt-in hooks for observing the real embedded debug webview. Never built in release.
use std::{
    fs::OpenOptions,
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    ipc::{Invoke, InvokeBody},
    Manager,
};

fn trace() -> Option<&'static Mutex<std::fs::File>> {
    static TRACE: OnceLock<Option<Mutex<std::fs::File>>> = OnceLock::new();
    TRACE
        .get_or_init(|| {
            let path = std::env::var_os("CPA_GUI_IPC_TRACE")?;
            match OpenOptions::new().create(true).append(true).open(path) {
                Ok(file) => Some(Mutex::new(file)),
                Err(error) => {
                    eprintln!("Cannot open debug IPC trace: {error}");
                    None
                }
            }
        })
        .as_ref()
}

fn append(line: &str) {
    if let Some(file) = trace() {
        if let Ok(mut file) = file.lock() {
            let _ = writeln!(file, "{line}");
        }
    }
}

fn single_line(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

fn trace_line(timestamp: u128, command: &str, payload: &serde_json::Value) -> String {
    let mut line = format!("{timestamp} {}", single_line(command));
    if command == "management_request" {
        let request = &payload["request"];
        let method = request["method"]
            .as_str()
            .unwrap_or("")
            .to_ascii_uppercase();
        let method = match method.as_str() {
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" => &method,
            _ => "UNKNOWN",
        };
        let path = request["path"].as_str().unwrap_or("");
        // Only relative HTTP paths; never echo a URL's userinfo, query or fragment.
        let path = if path.starts_with('/') && !path.starts_with("//") {
            path.split(['?', '#']).next().unwrap_or("")
        } else {
            "[invalid-path]"
        };
        line.push_str(&format!(" {method} {}", single_line(path)));
    }
    line
}

pub(crate) fn wrap<R: tauri::Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if trace().is_some() {
            let payload = match invoke.message.payload() {
                InvokeBody::Json(value) => value,
                _ => &serde_json::Value::Null,
            };
            if invoke.message.command() == "dev_report" {
                append(&format!(
                    "REPORT {}",
                    single_line(payload["text"].as_str().unwrap_or(""))
                ));
                invoke.resolver.resolve(());
                return true;
            }
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            append(&trace_line(timestamp, invoke.message.command(), payload));
        }
        handler(invoke)
    }
}

pub(crate) fn on_page_load<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    static NAVIGATED: AtomicBool = AtomicBool::new(false);
    if webview.label() != "main" || payload.event() != tauri::webview::PageLoadEvent::Finished {
        return;
    }
    if let Ok(route) = std::env::var("CPA_GUI_START_ROUTE") {
        if route.starts_with('/') && !NAVIGATED.swap(true, Ordering::Relaxed) {
            let route = serde_json::to_string(&route).unwrap();
            let _ = webview.eval(format!("window.location.hash = {route};"));
        }
    }
}

pub(crate) fn start_control<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(unix)]
    {
        use std::{
            io::{BufRead, BufReader},
            os::unix::fs::FileTypeExt,
        };
        let Some(path) = std::env::var_os("CPA_GUI_DEV_CONTROL") else {
            return;
        };
        if !std::fs::metadata(&path).is_ok_and(|m| m.file_type().is_fifo()) {
            eprintln!("CPA_GUI_DEV_CONTROL must name an existing FIFO");
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            // RDWR keeps the reader alive across short-lived writers without spinning at EOF.
            let Ok(fifo) = OpenOptions::new().read(true).write(true).open(path) else {
                return;
            };
            for line in BufReader::new(fifo).lines() {
                let Ok(script) = line else {
                    break;
                };
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                    if let Err(error) = window.eval(script) {
                        eprintln!("Debug control eval failed: {error}");
                    }
                }
            }
        });
    }
    #[cfg(not(unix))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn trace_format_redacts_everything_except_method_and_path() {
        let payload = json!({"request": {"method": "get", "path": "/v0/management/config?key=secret#token", "body": {"key": "secret"}, "headers": {"Authorization": "secret"}}, "key": "secret"});
        assert_eq!(
            trace_line(123, "management_request", &payload),
            "123 management_request GET /v0/management/config"
        );
        assert_eq!(
            trace_line(123, "save_gui_settings", &payload),
            "123 save_gui_settings"
        );
        assert_eq!(
            trace_line(
                123,
                "management_request",
                &json!({"request": {"method": "secret", "path": "https://user:secret@host/"}})
            ),
            "123 management_request UNKNOWN [invalid-path]"
        );
        assert_eq!(single_line("one\ntwo\rthree"), "one two three");
    }
}
