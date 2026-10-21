#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(debug_assertions)]
mod dev_observe;

mod app_constants;
use app_constants::*;
mod runtime_state;
use runtime_state::*;
mod gui_config;
use gui_config::*;
mod agent_types;
use agent_types::*;
mod window_state;
use window_state::*;

mod agents;
mod app_settings;
mod app_update;
mod claude_catalog;
mod codex_catalog;
mod codex_sessions;
mod configuration_watcher;
mod core_config;
mod core_runtime;
mod core_connection;
mod core_recovery;
mod desktop_theme;
mod instance_lock;
#[cfg(any(target_os = "linux", test))]
mod linux_graphics;
mod management_api;
mod lighting;
mod network_proxy;
#[cfg(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows"
))]
mod native_i18n;
mod oauth_browser;
mod plugin_webview;
mod plugins;
mod privacy_mode;
mod progress;
#[cfg(unix)]
mod process_signal;
mod process_spawn;
mod provider_health;
#[cfg(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows"
))]
mod tray;
mod usage;
#[cfg(target_os = "windows")]
mod windows_frame;
mod window_material;
mod window_activity;

#[cfg(test)]
use configuration_watcher::nearest_existing_watch_directory;
use management_api::{
    format_management_request_error, management_authorization, management_endpoint,
    read_management_text, read_management_value,
};
use oauth_browser::*;
#[cfg(test)]
use provider_health::{
    provider_health_content_type_is_streaming, provider_health_stream_has_terminal_success,
    provider_health_stream_has_text,
};

use agents::*;
use app_settings::*;
use app_update::*;
use core_config::*;
use core_runtime::*;
use flate2::read::GzDecoder;
use futures_util::StreamExt;
use instance_lock::*;
#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSEvent;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use std::sync::Arc;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    net::{IpAddr, SocketAddr, TcpStream},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{LazyLock, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tar::Archive;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use tauri::menu::PredefinedMenuItem;
#[cfg(target_os = "macos")]
use tauri::tray::{MouseButtonState, TrayIcon};
#[cfg(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows"
))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};
use tauri::{Emitter, Listener, LogicalSize, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;
#[cfg(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "windows"
))]
use tray::*;
use zip::ZipArchive;

const RELEASE_PAGE_URL: &str = "https://github.com/router-for-me/CLIProxyAPI/releases/latest";
const RELEASE_ATOM_URL: &str = "https://github.com/router-for-me/CLIProxyAPI/releases.atom";
const RELEASE_DOWNLOAD_PREFIX: &str =
    "https://github.com/router-for-me/CLIProxyAPI/releases/download/";
#[cfg(windows)]
const APP_UPDATE_MANIFEST_URL: &str = concat!(env!("APP_RELEASE_FEED"), "/portable-update-windows.json");
#[cfg(target_os = "linux")]
const APP_UPDATE_MANIFEST_URL: &str = concat!(env!("APP_RELEASE_FEED"), "/portable-update-linux.json");
#[cfg(target_os = "macos")]
const APP_UPDATE_MANIFEST_URL: &str = concat!(env!("APP_RELEASE_FEED"), "/portable-update-darwin-v2.json");
const APP_RELEASE_DOWNLOAD_PREFIX: &str = concat!("https://github.com/", env!("APP_RELEASE_REPOSITORY"), "/releases/download/");
#[cfg(windows)]
const APP_UPDATE_MANIFEST_NAME: &str = "portable-update-windows.json";
#[cfg(target_os = "linux")]
const APP_UPDATE_MANIFEST_NAME: &str = "portable-update-linux.json";
/// Fail-closed startup has no window to report in. Release builds on Windows have no console and a macOS bundle
/// logs to Console only, so without a native message box a refused start looks like the app silently not opening.
fn show_startup_failure(message: &str) {
    eprintln!("{message}");
    let _ = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("EasyCLIProxyAPI cannot start")
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

fn main() {
    let helper_args = env::args_os().collect::<Vec<_>>();
    if helper_args.get(1).is_some_and(|a| a == "--cpa-copilot-cli") {
        let code = run_copilot_helper(&helper_args).unwrap_or_else(|error| { eprintln!("{error}"); 1 });
        std::process::exit(code);
    }
    if antigravity_helper_requested(&helper_args) {
        let code = run_antigravity_helper(&helper_args).unwrap_or_else(|error| {
            eprintln!("{error}");
            1
        });
        std::process::exit(code);
    }
    let mut args = env::args_os();
    while let Some(argument) = args.next() {
        if argument == "--portable-update-helper" {
            let result = args
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| "Application update helper is missing its descriptor file".to_string())
                .and_then(|path| run_portable_update_helper(&path));
            if let Err(error) = result {
                eprintln!("{error}");
            }
            return;
        }
    }

    // SAFETY: no worker threads or GTK/WebKit runtime have started yet.
    #[cfg(target_os = "linux")]
    unsafe {
        linux_graphics::configure();
    }

    let _instance_guard = match acquire_app_instance_guard() {
        Ok(guard) => guard,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };

    let portable_update_ack = portable_update_ack_argument();
    let gui_config = match load_or_create_gui_config() {
        Ok(config) => config,
        Err(error) => {
            show_startup_failure(&format!("{error}\n\nStartup stopped without selecting Local. Repair the saved GUI config.toml (or legacy cpa-gui.yaml) and relaunch."));
            return;
        }
    };
    let initial_window_size = configured_window_size(&gui_config);
    let initial_window_position = configured_window_position(&gui_config);
    let start_hidden = should_start_hidden(&gui_config);

    let context = tauri::generate_context!();
    #[cfg(target_os = "linux")]
    let context = {
        let mut context = context;
        // Prevent #491's partial blank rendering on Linux (AMD and NVIDIA): disable native
        // transparency before build creates the window, not later in setup.
        linux_graphics::configure_main_window(context.config_mut());
        context
    };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(CoreDownloadState::default())
        .manage(AppUpdateState::default())
        .manage(window_activity::WindowActivity::default())
        .manage(CoreProcessState::new(gui_config.start_core_on_launch))
        .manage(DeepSeekHarnessProcessState::default())
        .manage(usage::UsageCollectorState::default())
        .manage(GuiConfigState::new(gui_config))
        .manage(plugin_webview::PluginWebviewState::default())
        .manage(MainWindowState::new(
            initial_window_size,
            initial_window_position,
        ))
        .manage(AgentConfigStatusCache::default());

    let app = app.on_window_event(|window, event| {
        if window.label() != "main" {
            return;
        }

        if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_)) {
            window_activity::sync(window.app_handle());
        }

        if let tauri::WindowEvent::Moved(position) = event {
            let state = window.state::<MainWindowState>();
            // Ignore startup placement and the OS's minimized/maximized coordinates.
            if state.position_tracking.load(Ordering::Acquire)
                && !window.is_minimized().unwrap_or(true)
                && !window.is_maximized().unwrap_or(true)
            {
                if let Err(error) = state.replace_position(*position) {
                    eprintln!("Failed to record main window position: {error}");
                }
            }
        }

        let observed_size = match event {
            tauri::WindowEvent::Resized(physical_size) => {
                window.scale_factor().ok().and_then(|scale_factor| {
                    logical_window_size_from_physical(physical_size, scale_factor)
                })
            }
            tauri::WindowEvent::ScaleFactorChanged {
                scale_factor,
                new_inner_size,
                ..
            } => logical_window_size_from_physical(new_inner_size, *scale_factor),
            _ => None,
        };

        if let Some(observed_size) = observed_size {
            let window_size_state = window.state::<MainWindowState>();
            if let Err(error) = window_size_state.replace(observed_size) {
                eprintln!("Failed to record main window size: {error}");
            }
        }
    });

    #[cfg(target_os = "macos")]
    let app = app.on_window_event(|window, event| {
        if window.label() == "main" {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                set_macos_dock_visible(window.app_handle(), false);
                if let Err(error) = window_activity::hide(window) {
                    eprintln!("Failed to hide main window: {error}");
                    set_macos_dock_visible(window.app_handle(), true);
                }
            }
        }
    });

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let app = app.on_window_event(|window, event| {
        if window.label() == "main" {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.emit(WINDOWS_CLOSE_REQUEST_EVENT, ()) {
                    eprintln!("Failed to show desktop close confirmation: {error}");
                }
            }
        }
    });

    #[cfg(debug_assertions)]
    let app = app.on_page_load(dev_observe::on_page_load);

    let app = app
        .setup(move |app| {
            #[cfg(debug_assertions)]
            dev_observe::start_control(app.handle());
            // Configure before showing the initially hidden window to avoid a native titlebar flash.
            // Other platforms retain their native window decorations. The frontend replacement
            // (src/components/WindowFrame.tsx) uses the same platform condition synchronously.
            // This stays a runtime call because tauri.windows.conf.json would replace the whole
            // `app.windows` array (JSON Merge Patch) and duplicate the main window config.
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                windows_frame::install(&window)?;
                window.set_decorations(false)?;
            }
            if let Some(window) = app.get_webview_window("main") {
                window.set_background_color(Some(tauri::window::Color(255, 255, 255, 255)))?;
            }
            if let Err(error) = network_proxy::refresh(app.state::<GuiConfigState>().inner()) {
                eprintln!("Failed to read startup proxy settings: {error}");
            }
            if let Err(error) = codex_catalog::validate_embedded_catalog() {
                eprintln!("Invalid bundled Codex model catalog: {error}");
            }
            if let Err(error) = load_codex_model_catalog_override(app.handle()) {
                eprintln!("Failed to load Codex model catalog update file; using bundled catalog: {error}");
            }
            if let Err(error) = load_codex_model_customizations(app.handle()) {
                eprintln!("Failed to load Codex custom model configuration: {error}");
            }
            if let Err(error) = restore_main_window_geometry(app.handle()) {
                eprintln!("{error}");
            }
            app.state::<MainWindowState>()
                .position_tracking
                .store(true, Ordering::Release);

            #[cfg(target_os = "macos")]
            setup_macos_tray(app)?;
            #[cfg(target_os = "linux")]
            if let Err(error) = setup_windows_tray(app) {
                eprintln!(
                    "Failed to set up Linux tray; keeping the main window available: {error}"
                );
            }
            #[cfg(target_os = "windows")]
            setup_windows_tray(app)?;

            if let Err(error) = configure_initial_main_window(app.handle(), start_hidden) {
                eprintln!("Failed to configure startup window state: {error}");
            }

            if let Err(error) =
                configuration_watcher::start_configuration_file_watcher(app.handle().clone())
            {
                eprintln!("Failed to start configuration file watcher: {error}");
            }

            lighting::start(app.handle())?;
            network_proxy::start_monitor(app.handle().clone());
            let connection_app = app.handle().clone();
            app.listen("core-connection-changed", move |_| {
                let app = connection_app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = get_core_status(app).await;
                });
            });
            start_codex_model_catalog_sync(app.handle().clone());

            let usage_app = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = usage::initialize_usage_storage() {
                    eprintln!("Failed to initialize usage records directory: {error}");
                }
                usage::start_usage_collector(usage_app);
            });

            let agent_status_app = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let gui_config_state = agent_status_app.state::<GuiConfigState>();
                let cache = agent_status_app.state::<AgentConfigStatusCache>();
                if let Err(error) = refresh_agent_config_status_cache(
                    &agent_status_app,
                    gui_config_state.inner(),
                    cache.inner(),
                ) {
                    eprintln!("Failed to refresh agent configuration status in the background: {error}");
                }
            });

            let core_app = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let Ok(_guard) = CORE_OPERATION_LOCK.lock() else {
                    return;
                };
                let gui_config_state = core_app.state::<GuiConfigState>();
                let process_state = core_app.state::<CoreProcessState>();
                if process_state.ensure_active().is_err() {
                    process_state.set_starting(false);
                    return;
                }
                let Ok(config) = gui_config_state.snapshot() else {
                    process_state.set_starting(false);
                    return;
                };

                if config.connection_mode == CoreConnectionMode::Remote {
                    process_state.set_starting(false);
                    return;
                }

                if config.connection_mode == CoreConnectionMode::Local && config.start_core_on_launch {
                    if let Ok(status) =
                        current_core_status(Some(process_state.inner()), Some(config.port))
                    {
                        emit_core_status(&core_app, &status);
                    }
                }

                match if config.connection_mode == CoreConnectionMode::Local {
                    auto_install_bundled_core_if_needed(&core_app)
                } else {
                    Ok(false)
                } {
                    Ok(true) => eprintln!("Automatically installed or upgraded to the CPA kernel version bundled with the application"),
                    Ok(false) => {}
                    Err(error) => eprintln!("Failed to automatically install CPA offline kernel: {error}"),
                }

                let adopted_process_ids = match if config.connection_mode == CoreConnectionMode::Local { adopt_existing_core_processes(process_state.inner()) } else { Ok(Vec::new()) }
                {
                    Ok(process_ids) => process_ids,
                    Err(error) => {
                        eprintln!("Failed to scan for and adopt the CPA kernel in the current directory: {error}");
                        Vec::new()
                    }
                };
                if !adopted_process_ids.is_empty() {
                    eprintln!(
                        "Adopted running CPA kernel in the current directory: PID {}",
                        adopted_process_ids
                            .iter()
                            .map(u32::to_string)
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                } else if config.connection_mode == CoreConnectionMode::Local && should_start_core_on_launch(&config) {
                    if let Err(error) = start_core_process_inner(process_state.inner(), &config) {
                        eprintln!("Failed to automatically start CPA kernel: {error}");
                    }
                }

                process_state.set_starting(false);

                if let Ok(status) =
                    current_core_status(Some(process_state.inner()), Some(config.port))
                {
                    emit_core_status(&core_app, &status);
                }
                start_core_crash_supervisor_if_needed(process_state.inner(), || {
                    start_core_crash_supervisor(core_app.clone());
                });
            });

            if let Some(ack_path) = portable_update_ack.as_ref() {
                fs::write(ack_path, env!("CARGO_PKG_VERSION").as_bytes())
                    .map_err(|error| format!("Failed to write application update startup confirmation: {error}"))?;
            }

            Ok(())
        })
        .invoke_handler({
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                window_activity::main_window_active,
                desktop_theme::get_linux_system_theme,
                desktop_theme::list_custom_themes,
                desktop_theme::open_custom_themes_directory,
                desktop_theme::get_theme_selection,
                desktop_theme::save_theme_selection,
                window_material::detect_window_material,
                window_material::set_window_material,
                privacy_mode::get_privacy_mode,
                privacy_mode::save_privacy_mode,
                lighting::lighting_list,
                lighting::lighting_get,
                lighting::lighting_save,
                lighting::lighting_delete,
                lighting::lighting_set_enabled,
                lighting::lighting_run_now,
                lighting::lighting_report_reset,
                lighting::lighting_history,
                lighting::lighting_capabilities,
                lighting::lighting_status,
                detect_core_platform,
                get_core_status,
                core_connection::get_core_connection,
                core_connection::export_core_connection,
                core_connection::import_core_connection,
                core_connection::save_core_connection,
                core_connection::test_core_connection,
                get_gui_settings,
                // Application preferences
                get_usage_view_preferences,
                save_usage_view_preferences,
                resolve_api_access_remarks,
                save_api_access_remark,
                set_app_locale,
                resolve_windows_close_request,
                get_software_settings,
                save_software_settings,
                // Agent integration
                get_agent_config_statuses,
                create_agent_config_backup,
                list_agent_config_backups,
                preview_agent_config_backup,
                restore_agent_config_backup,
                delete_agent_config_backup,
                preview_agent_config_template,
                apply_agent_config_template,
                refresh_agent_config_statuses,
                get_agent_models,
                check_pi_provider_update,
                install_pi_provider,
                update_pi_provider,
                repair_pi_provider,
                uninstall_pi_provider,
                check_codex_oauth_login,
                get_deepseek_harness_model_catalog_editor,
                save_deepseek_harness_model_catalog_editor,
                get_codex_model_catalog_editor,
                save_codex_model_catalog_editor,
                get_thinking_aliases,
                get_model_alias_sources,
                get_model_alias_edit_source,
                get_thinking_alias_sources,
                create_thinking_alias,
                delete_thinking_alias,
                get_speed_aliases,
                get_speed_alias_sources,
                create_speed_alias,
                delete_speed_alias,
                clear_codex_config,
                restore_codex_official_config,
                set_codex_openai_provider,
                set_codex_remote_compaction,
                close_codex_config_modification,
                set_agent_config_enabled,
                update_agent_config,
                launch_agent,
                get_deepseek_harness_process_status,
                stop_deepseek_harness_process,
                restart_deepseek_harness_process,
                restart_agent_app,
                get_codex_cli_daemon_running,
                restart_codex_cli_daemon,
                // GUI and core configuration
                save_gui_settings,
                save_network_routing_settings,
                save_network_endpoint_settings,
                save_retry_settings,
                save_session_routing_settings,
                get_core_tls_settings,
                save_core_tls_settings,
                get_core_sensitive_words_settings,
                save_core_sensitive_words_settings,
                get_core_config_settings,
                get_extended_core_config,
                save_extended_core_config,
                save_core_logging_settings,
                set_core_request_log,
                add_core_api_key,
                update_core_api_key,
                delete_core_api_key,
                set_core_management_secret_key,
                clear_core_management_secret_key,
                // Management API and plugins
                management_api::management_request,
                management_api::prepare_management_request,
                management_api::cancel_management_request,
                plugins::get_plugin_support,
                plugins::local_install::install_local_plugin,
                plugin_webview::show_plugin_webview,
                plugin_webview::set_plugin_webview_bounds,
                plugin_webview::hide_plugin_webview,
                plugin_webview::close_plugin_webview,
                plugins::get_plugin_latest_releases,
                provider_health::provider_health_probe,
                provider_health::get_core_models,
                provider_health::core_health_probe,
                management_api::get_management_target_revision,
                management_api::upload_auth_file,
                management_api::import_vertex_credential,
                management_api::open_auth_files_directory,
                management_api::open_core_logs_directory,
                set_core_plugins_enabled,
                set_core_routing_strategy,
                set_core_proxy_url,
                set_core_session_affinity,
                set_core_session_affinity_ttl,
                // OAuth and external links
                management_api::start_oauth_login,
                management_api::get_oauth_status,
                management_api::submit_oauth_callback,
                list_oauth_browsers,
                open_oauth_url,
                open_external_url,
                // Downloads and updates
                get_version_source_settings,
                set_download_source,
                add_custom_download_mirror,
                remove_custom_download_mirror,
                check_app_update,
                get_app_update_task,
                start_app_update,
                cancel_app_update,
                check_latest_core,
                detect_bundled_core,
                install_core_version,
                install_bundled_core,
                cancel_core_install,
                get_core_install_task,
                // Usage storage, collection, queries, and pricing
                usage::get_usage_collector_status,
                usage::resume_usage_collection,
                usage::get_usage_overview,
                usage::get_usage_analysis,
                usage::get_usage_events,
                usage::save_usage_events_export,
                usage::get_usage_pricing,
                usage::get_usage_storage_settings,
                usage::repair_usage_cache_records,
                usage::save_usage_storage_settings,
                usage::shrink_usage_database,
                usage::save_usage_model_price,
                usage::delete_usage_model_price,
                usage::preview_usage_model_prices,
                usage::apply_usage_model_prices,
                // Core process lifecycle
                start_core_process,
                stop_core_process,
                restart_core_process,
                // Codex sessions and context
                codex_sessions::list_codex_sessions,
                codex_sessions::delete_codex_sessions,
                codex_sessions::repair_codex_session_metadata,
                codex_sessions::preview_codex_session_index_cleanup,
                codex_sessions::apply_codex_session_index_cleanup,
                codex_sessions::context::get_codex_session_context,
                codex_sessions::context::save_codex_session_context,
                codex_sessions::context::open_codex_session_rollout
            ];
            #[cfg(debug_assertions)]
            let handler = dev_observe::wrap(handler);
            handler
        })
        .build(context)
        .expect("failed to build app");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => show_main_window(app_handle),
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            let process_state = app_handle.state::<CoreProcessState>();
            if process_state.shutdown_complete.load(Ordering::Acquire) {
                return;
            }
            api.prevent_exit();
            if process_state.shutting_down.swap(true, Ordering::AcqRel) {
                return;
            }
            process_state.recovery.cancel();
            if let Err(error) = persist_main_window_geometry(app_handle) {
                eprintln!("Failed to save main window geometry: {error}");
            }
            app_handle.state::<CoreDownloadState>().cancel();
            let app_handle = app_handle.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _guard = CORE_OPERATION_LOCK
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let process_state = app_handle.state::<CoreProcessState>();
                let gui_config_state = app_handle.state::<GuiConfigState>();
                shutdown_managed_core(process_state.inner(), gui_config_state.inner());
                process_state
                    .shutdown_complete
                    .store(true, Ordering::Release);
                app_handle.exit(code.unwrap_or(0));
            });
        }
        tauri::RunEvent::Exit => {
            usage::stop_usage_collector(app_handle);
            let deepseek_process_state = app_handle.state::<DeepSeekHarnessProcessState>();
            if let Err(error) = stop_managed_deepseek_harness(deepseek_process_state.inner()) {
                eprintln!("Failed to stop DeepSeek Harness: {error}");
            }
            let gui_config_state = app_handle.state::<GuiConfigState>();
            let process_state = app_handle.state::<CoreProcessState>();
            if !process_state.shutdown_complete.load(Ordering::Acquire) {
                process_state.shutting_down.store(true, Ordering::Release);
                shutdown_managed_core(process_state.inner(), gui_config_state.inner());
            }
        }
        _ => {}
    });
}

/// Returns a path under the system temporary directory that is unique for the
/// lifetime of the test process. The wall clock alone is not enough: parallel
/// tests that start within the clock's resolution would otherwise share a
/// directory and delete or overwrite each other's files.
#[cfg(test)]
pub(crate) fn unique_test_temp_path(prefix: &str) -> PathBuf {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}

#[cfg(test)]
mod tests;
