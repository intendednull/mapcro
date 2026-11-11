//! mapcro for Windows (desktop/README.md): one window on the live site, a tray icon, and a watch
//! of Deadlock's replays folder. The site reaches the native side through three commands only
//! (capabilities/site.json); it never passes a path, only a match id.
//!
//! Logs carry reason codes and match ids, never a path, a player name or an account id.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mapcro_desktop_core::{parse, replays, settle::Settle, steam};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::Response;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// The site the window loads. A debug build takes `MAPCRO_URL` instead (a local dev server).
const SITE: &str = "https://mapcro.dmgdeadlock.com";
const WINDOW: &str = "main";
/// The app's own commands: the only IPC the site gets.
const COMMANDS: [&str; 3] = ["allow-replays-list", "allow-replay-read", "allow-replay-timeline"];
/// Timelines kept parsed (each ~0.6 MB gzip for a 44 min match).
const CACHED: usize = 8;
/// How long to wait between looks when nothing is settling, and how often to look for a folder
/// that isn't there yet.
const IDLE: Duration = Duration::from_secs(30);
const SETTLING: Duration = Duration::from_secs(1);

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if let Some(code) = parse::child_main(&args) {
        std::process::exit(code);
    }
    run();
}

/// The site's origin: the live one, or (a debug build only) `MAPCRO_URL`.
fn site() -> Url {
    #[cfg(debug_assertions)]
    if let Some(u) = std::env::var("MAPCRO_URL").ok().and_then(|s| Url::parse(&s).ok()).filter(|u| matches!(u.scheme(), "http" | "https")) {
        return u;
    }
    Url::parse(SITE).expect("SITE is a URL")
}

/// A parsed timeline, for the file as it was (size, time).
struct Parsed {
    size: u64,
    modified: u64,
    result: Result<Arc<Vec<u8>>, &'static str>,
}

#[derive(Default)]
struct Shared {
    /// The replays folder, once found.
    dir: Mutex<Option<PathBuf>>,
    /// Recent parses, by match id, newest last.
    parsed: Mutex<Vec<(String, Parsed)>>,
    /// One parse at a time.
    parsing: Mutex<()>,
}

impl Shared {
    fn dir(&self) -> Result<PathBuf, String> {
        self.dir.lock().map_err(|_| "busy".to_string())?.clone().ok_or_else(|| "not_found".to_string())
    }

    /// Match `id`'s timeline, gzipped: from the cache while the file is unchanged, else parsed
    /// now, in a child.
    fn timeline(&self, app: &AppHandle, id: &str) -> Result<Arc<Vec<u8>>, &'static str> {
        let dir = self.dir().map_err(|_| "not_found")?;
        let demo = replays::demo_path(&dir, id).ok_or("bad_id")?;
        let _one = self.parsing.lock().map_err(|_| "parse_failed")?;
        let meta = std::fs::metadata(&demo).map_err(|_| "not_found")?;
        let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
        if let Some((_, p)) = self.parsed.lock().map_err(|_| "parse_failed")?.iter().find(|(k, _)| k == id)
            && p.size == meta.len()
            && p.modified == modified
        {
            return p.result.clone();
        }
        if !replays::looks_like_demo(&demo) {
            return Err("not_a_replay");
        }
        let exe = std::env::current_exe().map_err(|_| "parse_failed")?;
        let scratch = app.path().app_cache_dir().map_err(|_| "parse_failed")?.join("parse");
        let n: u64 = id.parse().map_err(|_| "bad_id")?;
        let result = parse::parse(&exe, &demo, n, &scratch, parse::TIMEOUT).map(Arc::new);
        if let Err(why) = &result {
            eprintln!("mapcro: replay {id} not parsed: {why}");
        }
        let mut cache = self.parsed.lock().map_err(|_| "parse_failed")?;
        cache.retain(|(k, _)| k != id);
        cache.push((id.to_owned(), Parsed { size: meta.len(), modified, result: result.clone() }));
        if cache.len() > CACHED {
            cache.remove(0);
        }
        result
    }
}

/// The folder's replays, newest first: `[{id, lastModified, size}]`.
#[tauri::command]
async fn replays_list(state: tauri::State<'_, Arc<Shared>>) -> Result<Vec<replays::Replay>, String> {
    let dir = state.dir()?;
    tauri::async_runtime::spawn_blocking(move || replays::list(&dir).map_err(|_| "not_found".to_string())).await.map_err(|_| "failed".to_string())?
}

/// One replay's file, by match id (the fallback when the server takes no timelines yet).
#[tauri::command]
async fn replay_read(state: tauri::State<'_, Arc<Shared>>, id: String) -> Result<Response, String> {
    let dir = state.dir()?;
    let demo = replays::demo_path(&dir, &id).ok_or("bad_id")?;
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let len = std::fs::metadata(&demo).map_err(|_| "not_found")?.len();
        if len > parse::MAX_DEM_BYTES {
            return Err("too_large");
        }
        std::fs::read(&demo).map_err(|_| "not_found")
    })
    .await
    .map_err(|_| "failed".to_string())??;
    Ok(Response::new(bytes))
}

/// One replay parsed here: its timeline JSON, gzipped, or a reason code (`old_map`, `brawl`, …).
#[tauri::command]
async fn replay_timeline(app: AppHandle, state: tauri::State<'_, Arc<Shared>>, id: String) -> Result<Response, String> {
    let shared = Arc::clone(&state);
    let gz = tauri::async_runtime::spawn_blocking(move || shared.timeline(&app, &id)).await.map_err(|_| "failed".to_string())??;
    Ok(Response::new(gz.as_ref().clone()))
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn run() {
    let shared = Arc::new(Shared::default());
    let site = site();
    tauri::Builder::default()
        // First: a second launch shows this one's window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::clone(&shared))
        .invoke_handler(tauri::generate_handler![replays_list, replay_read, replay_timeline])
        .setup(move |app| {
            let handle = app.handle().clone();
            if site.as_str().trim_end_matches('/') != SITE {
                dev_capability(&handle, &site)?;
            }
            window(&handle, &site)?;
            tray(&handle)?;
            let watch_shared = Arc::clone(&shared);
            let watch_app = handle.clone();
            std::thread::Builder::new().name("replays".into()).spawn(move || watch(&watch_app, &watch_shared))?;
            check_for_update(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("mapcro failed to start");
}

/// A debug build pointed at a dev server: the same three commands for its origin.
fn dev_capability(app: &AppHandle, site: &Url) -> tauri::Result<()> {
    let mut origin = site.clone();
    origin.set_path("/*");
    origin.set_query(None);
    origin.set_fragment(None);
    let mut cap = tauri::ipc::CapabilityBuilder::new("dev-site").remote(origin.to_string()).window(WINDOW);
    for p in COMMANDS {
        cap = cap.permission(p);
    }
    app.add_capability(cap)
}

/// The one window: the site. A link off the site opens in the system browser; closing hides it
/// to the tray (the watch keeps going).
fn window(app: &AppHandle, site: &Url) -> tauri::Result<()> {
    let origin = site.origin();
    let opener = app.clone();
    let w = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(site.clone()))
        .title("mapcro")
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 600.0)
        .on_navigation(move |u| {
            if u.origin() == origin {
                return true;
            }
            if matches!(u.scheme(), "http" | "https") {
                let _ = opener.opener().open_url(u.as_str(), None::<&str>);
            }
            false
        })
        .build()?;
    let hide = w.clone();
    w.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            let _ = hide.hide();
        }
    });
    Ok(())
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open mapcro", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("mapcro").tooltip("mapcro").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, e| match e.id().as_ref() {
        "open" => show(app),
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(|t, e| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            show(t.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Find the replays folder, watch it (that folder only, not its parents), and parse each new
/// replay once its size has settled; then a notification. Replays already there at start aren't
/// announced. A folder that isn't there (yet) is looked for again every `IDLE`.
fn watch(app: &AppHandle, shared: &Shared) {
    use notify::{RecursiveMode, Watcher};
    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher: Option<(PathBuf, notify::RecommendedWatcher)> = None;
    let mut settle = Settle::default();
    let mut primed = false;
    // Each reason is logged once.
    let mut said = HashSet::<&'static str>::new();
    loop {
        // Where the folder is: found once, kept while it's there.
        let dir = match shared.dir().ok().filter(|d| d.is_dir()) {
            Some(d) => Some(d),
            None => match steam::locate() {
                Ok(d) if d.is_dir() => Some(d),
                Ok(_) => {
                    if said.insert("no_folder") {
                        eprintln!("mapcro: replays folder not there yet");
                    }
                    None
                }
                Err(e) => {
                    if said.insert(e.code()) {
                        eprintln!("mapcro: replays folder not found: {}", e.code());
                    }
                    None
                }
            },
        };
        if let Ok(mut d) = shared.dir.lock() {
            d.clone_from(&dir);
        }
        let Some(dir) = dir else {
            watcher = None;
            primed = false;
            let _ = rx.recv_timeout(IDLE);
            continue;
        };
        if watcher.as_ref().is_none_or(|(p, _)| p != &dir) {
            let tx = tx.clone();
            watcher = notify::recommended_watcher(move |_: notify::Result<notify::Event>| {
                let _ = tx.send(());
            })
            .and_then(|mut w| w.watch(&dir, RecursiveMode::NonRecursive).map(|()| w))
            .ok()
            .map(|w| (dir.clone(), w));
        }
        let list = replays::list(&dir).unwrap_or_default();
        if !primed {
            settle.prime(&list, now_ms());
            primed = true;
        }
        for id in settle.observe(&list, now_ms()) {
            if shared.timeline(app, &id).is_ok() {
                let _ = app.notification().builder().title("mapcro").body(format!("Replay {id} ready: open board")).show();
            }
        }
        let wait = if settle.waiting() { SETTLING } else { IDLE };
        // Woken early by a change in the folder; several events at once are one look.
        let _ = rx.recv_timeout(wait);
        while rx.try_recv().is_ok() {}
    }
}

/// Check the update feed once at start, and install what it offers (Windows: the installer runs
/// passively and restarts the app). Off while the public key is the placeholder.
fn check_for_update(app: &AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    let key = app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).unwrap_or("");
    if key.is_empty() || key.starts_with("REPLACE_") {
        eprintln!("mapcro: updates off (no public key configured)");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else { return };
        match updater.check().await {
            Ok(Some(update)) => {
                if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                    eprintln!("mapcro: update failed: {e}");
                }
            }
            Ok(None) => {}
            Err(e) => eprintln!("mapcro: update check failed: {e}"),
        }
    });
}
