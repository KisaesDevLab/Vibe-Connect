// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Tauri shell for Vibe Connect.
//
// Architecture: thin client. The bundle ships a single onboarding HTML page
// (apps/desktop/dist/index.html, built from apps/desktop/onboarding/) which
// asks the user for their firm's Vibe Connect appliance URL on first run.
// Once a URL is committed via the `set_appliance_url` IPC command, the Rust
// side navigates the main webview directly to the appliance and keeps it
// there. Subsequent launches read the stored URL and navigate immediately,
// skipping the onboarding screen entirely.
//
// The store key (`appliance_url`) lives in tauri-plugin-store's settings
// file, which on Windows lands in `%APPDATA%/app.vibeconnect.desktop/`.
// Clearing the URL ("Change server…" tray item) removes the key and reloads
// the onboarding bundle so the user can pick a new appliance.

use serde_json::json;
use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WebviewWindowBuilder,
};
use url::Url;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const STORE_KEY_APPLIANCE_URL: &str = "appliance_url";

/// The bundled onboarding URL captured at startup. Tauri's bundled-asset
/// scheme differs per platform (`https://tauri.localhost/` on Windows,
/// `tauri://localhost/` elsewhere), so we capture the actual URL once at
/// boot and re-use it for "Change server…" instead of hard-coding either.
struct OnboardingUrl(Mutex<Option<Url>>);

/// Build-time package version surfaced to the onboarding footer via IPC.
struct AppVersion(String);

/// Read the persisted appliance URL from the on-disk store, or `None` if the
/// user has never finished onboarding. Returning a Result-of-Option lets the
/// caller distinguish "store unreadable" (real failure to surface) from
/// "nothing stored yet" (expected, fall through to onboarding).
fn read_stored_url(app: &AppHandle) -> Result<Option<String>, String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("store_open_failed: {e}"))?;
    let value = store.get(STORE_KEY_APPLIANCE_URL);
    match value {
        Some(v) => match v.as_str() {
            Some(s) if !s.is_empty() => Ok(Some(s.to_string())),
            _ => Ok(None),
        },
        None => Ok(None),
    }
}

/// Write the appliance URL to the store and persist to disk. The flush
/// (`store.save()`) is critical: without it, a crash between set + save
/// would lose the URL on the next launch and force the user back through
/// onboarding for no reason.
fn write_stored_url(app: &AppHandle, url: &str) -> Result<(), String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("store_open_failed: {e}"))?;
    store.set(STORE_KEY_APPLIANCE_URL, json!(url));
    store
        .save()
        .map_err(|e| format!("store_save_failed: {e}"))?;
    Ok(())
}

fn delete_stored_url(app: &AppHandle) -> Result<(), String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| format!("store_open_failed: {e}"))?;
    store.delete(STORE_KEY_APPLIANCE_URL);
    store
        .save()
        .map_err(|e| format!("store_save_failed: {e}"))?;
    Ok(())
}

/// Navigate the main webview to the given URL. The URL must be a valid
/// absolute URL — the JS-side normalizeApplianceUrl() guarantees this, but
/// we re-parse here so a corrupted store value can't crash the shell.
fn navigate_window_to(app: &AppHandle, url_str: &str) -> Result<(), String> {
    let parsed = Url::parse(url_str).map_err(|e| format!("bad_url: {e}"))?;
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "no_main_window".to_string())?;
    win.navigate(parsed)
        .map_err(|e| format!("navigate_failed: {e}"))?;
    Ok(())
}

/// Navigate the main webview back to the bundled onboarding URL captured at
/// startup. Used by "Change server…".
fn navigate_window_to_onboarding(app: &AppHandle) -> Result<(), String> {
    let saved = app.state::<OnboardingUrl>();
    let url = saved
        .0
        .lock()
        .map_err(|e| format!("onboarding_url_lock_failed: {e}"))?
        .clone()
        .ok_or_else(|| "onboarding_url_unset".to_string())?;
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "no_main_window".to_string())?;
    win.navigate(url)
        .map_err(|e| format!("navigate_failed: {e}"))?;
    Ok(())
}

// ---------- IPC commands ----------

#[tauri::command]
fn get_appliance_url(app: AppHandle) -> Result<Option<String>, String> {
    read_stored_url(&app)
}

#[tauri::command]
fn set_appliance_url(app: AppHandle, url: String) -> Result<String, String> {
    // Re-validate server-side: the JS layer can be bypassed by a developer
    // poking at the IPC, and a malformed URL stored here would brick the
    // shell on next launch. We accept exactly what the JS produces:
    // https?://host[:port][/sub-path], no query/fragment. The path
    // component is optional because multi-app appliances live at a
    // sub-path (e.g. `https://shared.host/connect/`).
    let parsed = Url::parse(&url).map_err(|e| format!("bad_url: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("bad_scheme: {scheme}"));
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("no_hostname".to_string());
    }
    if parsed.query().is_some() {
        return Err("query_not_allowed".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("fragment_not_allowed".to_string());
    }
    write_stored_url(&app, &url)?;
    Ok(url)
}

#[tauri::command]
fn clear_appliance_url(app: AppHandle) -> Result<(), String> {
    delete_stored_url(&app)?;
    navigate_window_to_onboarding(&app)?;
    Ok(())
}

#[tauri::command]
fn navigate_to_appliance(app: AppHandle) -> Result<(), String> {
    let url = read_stored_url(&app)?
        .ok_or_else(|| "no_appliance_url_stored".to_string())?;
    navigate_window_to(&app, &url)
}

#[tauri::command]
fn get_desktop_version(version: State<'_, AppVersion>) -> String {
    version.0.clone()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["CmdOrControl+Shift+V"])
                .expect("register default shortcut")
                .with_handler(|app, _shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if let Some(win) = app.get_webview_window("main") {
                        if win.is_visible().unwrap_or(true) {
                            let _ = win.hide();
                        } else {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(),
        )
        .manage(AppVersion(env!("CARGO_PKG_VERSION").to_string()))
        .manage(OnboardingUrl(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            get_appliance_url,
            set_appliance_url,
            clear_appliance_url,
            navigate_to_appliance,
            get_desktop_version,
        ])
        .setup(|app| {
            let show = MenuItemBuilder::with_id("show", "Show").build(app)?;
            let hide = MenuItemBuilder::with_id("hide", "Hide to tray").build(app)?;
            let change_server =
                MenuItemBuilder::with_id("change_server", "Change server…").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .items(&[&show, &hide, &change_server, &quit])
                .build()?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Vibe Connect")
                .menu(&tray_menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                    "change_server" => {
                        // Wipe the stored URL and reload the onboarding page so
                        // the user can pick a different appliance. Surface the
                        // window first in case it was hidden to tray.
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                        if let Err(e) = delete_stored_url(app) {
                            eprintln!("change_server: clear failed: {e}");
                        }
                        if let Err(e) = navigate_window_to_onboarding(app) {
                            eprintln!("change_server: navigate failed: {e}");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Ensure main window exists on first run.
            if app.get_webview_window("main").is_none() {
                let _ = WebviewWindowBuilder::from_config(
                    app,
                    &app.config().app.windows[0],
                )?
                .build();
            }

            // Capture the bundled-onboarding URL ASAP — before we navigate
            // away from it. We need this for the "Change server…" path.
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(initial) = win.url() {
                    let saved = app.state::<OnboardingUrl>();
                    if let Ok(mut guard) = saved.0.lock() {
                        *guard = Some(initial);
                    }
                }
            }

            // If we already have an appliance URL stored, jump straight to it.
            // The bundled onboarding loaded by frontendDist will be replaced
            // with the appliance's web app before the user sees it. If reading
            // the store fails or no URL is set, leave the onboarding on screen.
            let app_handle = app.handle().clone();
            match read_stored_url(&app_handle) {
                Ok(Some(url)) => {
                    if let Err(e) = navigate_window_to(&app_handle, &url) {
                        eprintln!("startup: navigate to appliance failed: {e}");
                    }
                }
                Ok(None) => {
                    // First run — onboarding is already on screen.
                }
                Err(e) => {
                    eprintln!("startup: store read failed: {e}");
                }
            }

            Ok(())
        })
        .on_window_event(|win, event| {
            // Minimize to tray on window close instead of quitting.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = win.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Vibe Connect desktop");
}
