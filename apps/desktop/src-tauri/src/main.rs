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
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WebviewWindowBuilder,
};
use url::Url;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";
const STORE_KEY_APPLIANCE_URL: &str = "appliance_url";
const STORE_KEY_TRAY_HINT_SHOWN: &str = "tray_hint_shown";

/// Per-user log directory for panic/diagnostic output. On Windows this lives
/// at %LOCALAPPDATA%\Vibe Connect\ — same parent as the NSIS install path,
/// so users helping with support can find both binary + log next to each
/// other. Returns None when LOCALAPPDATA is unreadable (very rare; only on
/// stripped-down sandboxes).
fn panic_log_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(|s| {
            let mut p = PathBuf::from(s);
            p.push("Vibe Connect");
            p
        })
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(|s| {
            let mut p = PathBuf::from(s);
            p.push(".vibe-connect");
            p
        })
    }
}

/// Installs a panic hook that appends a timestamped panic record to
/// %LOCALAPPDATA%\Vibe Connect\panic.log before the runtime aborts (release
/// builds set `panic = "abort"` so the process dies immediately after this
/// hook returns — no chance to recover, but at least the cause is captured).
/// Without this, a panic anywhere in startup looks identical to the
/// Bitdefender BEX64 crash: silent fast-fail with no diagnostic anywhere.
fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(dir) = panic_log_dir() {
            let _ = std::fs::create_dir_all(&dir);
            let path = dir.join("panic.log");
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
                let ts = chrono_lite();
                let location = info
                    .location()
                    .map(|l| format!("{}:{}", l.file(), l.line()))
                    .unwrap_or_else(|| "<unknown>".to_string());
                let payload = info
                    .payload()
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| info.payload().downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "<non-string panic payload>".to_string());
                let _ = writeln!(
                    f,
                    "[{ts}] PANIC at {location}: {payload} (version {})",
                    env!("CARGO_PKG_VERSION"),
                );
                // Drop flushes File, but be explicit so abort can't race
                // the OS buffer flush.
                let _ = f.flush();
            }
        }
        default_hook(info);
    }));
}

/// Minimal ISO-8601-ish UTC timestamp without pulling in the `chrono` crate.
/// Format: `2026-05-10T13:24:07Z`. Resolution to the second is enough for
/// support-log triage.
fn chrono_lite() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Days since 1970-01-01.
    let days = (secs / 86_400) as i64;
    let time_of_day = secs % 86_400;
    let hour = (time_of_day / 3600) as u8;
    let minute = ((time_of_day % 3600) / 60) as u8;
    let second = (time_of_day % 60) as u8;
    // Civil-from-days (Howard Hinnant's algorithm — public-domain).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u8;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}Z")
}

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
///
/// If the captured URL is unset (rare race where the webview hadn't loaded
/// when setup() probed `win.url()`), fall back to Tauri's platform-default
/// custom-scheme origin. Without this fallback, the user clicks
/// "Change server…" and nothing happens — silent breakage.
fn navigate_window_to_onboarding(app: &AppHandle) -> Result<(), String> {
    let captured = {
        let saved = app.state::<OnboardingUrl>();
        let guard = saved
            .0
            .lock()
            .map_err(|e| format!("onboarding_url_lock_failed: {e}"))?;
        guard.clone()
    };
    let url = captured.unwrap_or_else(default_onboarding_url);
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "no_main_window".to_string())?;
    win.navigate(url)
        .map_err(|e| format!("navigate_failed: {e}"))?;
    Ok(())
}

/// Tauri 2's bundled-asset origin: `https://tauri.localhost/` on Windows,
/// `tauri://localhost/` everywhere else. Hardcoded as a last-resort fallback
/// for `navigate_window_to_onboarding` — the literal parses unconditionally,
/// so we don't expose a Result.
fn default_onboarding_url() -> Url {
    #[cfg(windows)]
    let raw = "https://tauri.localhost/";
    #[cfg(not(windows))]
    let raw = "tauri://localhost/";
    Url::parse(raw).expect("hardcoded onboarding URL is well-formed")
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
    install_panic_hook();

    // Build the global-shortcut plugin separately so a parse failure on the
    // shortcut string doesn't take the whole app down. `with_shortcuts` only
    // fails on malformed keybind strings — but if Tauri ever changes its
    // grammar, that's a recoverable startup error: log it, ship the app
    // without the hotkey, let the user resize-from-tray and Change Server
    // instead. Previously this was `.expect("register default shortcut")`
    // which panic-aborted to BEX64 with no diagnostic.
    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcuts(["CmdOrControl+Shift+V"])
        .map(|b| {
            b.with_handler(|app, _shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                if let Some(win) = app.get_webview_window("main") {
                    // Match the tray-icon click handler's default: assume
                    // hidden when visibility query fails, so the hotkey
                    // always tries to surface the window (the safer fallback
                    // — accidentally hiding a visible window is more
                    // annoying than re-showing one).
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            })
            .build()
        });

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        // Updater plugin stays registered so re-enabling auto-update later
        // doesn't require a rebuild path change, but the runtime check is
        // gated by `plugins.updater.active` in tauri.conf.json — currently
        // disabled because no signing keypair exists. See
        // docs/ops/UPDATE_SIGNING.md.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ));
    let builder = match shortcut_plugin {
        Ok(p) => builder.plugin(p),
        Err(e) => {
            eprintln!("startup: global-shortcut plugin disabled ({e})");
            builder
        }
    };
    builder
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
            //
            // Inline the `app.state::<OnboardingUrl>()` lookup into the lock
            // scrutinee so the State temporary's destructor runs at the end
            // of the if-let — *not* outliving a `let saved = …` local that
            // would drop in the same block. The borrow checker (E0597 on
            // 2021-edition crates) rejects the local-bound shape because
            // `Result<MutexGuard, PoisonError<MutexGuard>>` carries a borrow
            // back to `saved.0`, and that borrow is still live when `saved`
            // is reverse-dropped at the closing brace.
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(initial) = win.url() {
                    if let Ok(mut guard) = app.state::<OnboardingUrl>().0.lock() {
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
            // Minimize to tray on window close instead of quitting. Users
            // intuitively think clicking ✕ quits the app — on the first
            // close, show a one-shot notification so they understand the
            // tray icon is still there. We persist the dismissal via the
            // store so the hint never reappears for the same install.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = win.hide();
                show_tray_hint_once(win.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            // Funnel the run-failure through the panic hook so the cause
            // lands in panic.log alongside any startup panics. `panic!` here
            // is fine — panic = "abort" will still terminate, but our hook
            // captures the message first.
            panic!("tauri runtime failed to start: {e}")
        });
}

/// Show a tray-balloon notification on the first window-close-to-tray. We
/// stash a `tray_hint_shown: true` flag in the same store the appliance URL
/// lives in so the hint never reappears for this install. If the store
/// read/write fails we silently skip — the hint is convenience, not
/// load-bearing.
fn show_tray_hint_once(app: &AppHandle) {
    let store = match app.store(STORE_FILE) {
        Ok(s) => s,
        Err(_) => return,
    };
    if matches!(
        store.get(STORE_KEY_TRAY_HINT_SHOWN).and_then(|v| v.as_bool()),
        Some(true)
    ) {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title("Vibe Connect is still running")
        .body("The app keeps running in the system tray. Right-click the tray icon to quit.")
        .show();
    store.set(STORE_KEY_TRAY_HINT_SHOWN, json!(true));
    let _ = store.save();
}
