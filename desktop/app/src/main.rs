//! mapcro for Windows (desktop/README.md): one window on the live site, and the replay picker's
//! native side: the replays folder, looked up when the picker asks (no watch), each card's preview
//! read from its demo, and the parse of the one replay the user picks. The site reaches it through
//! six commands only
//! (capabilities/site.json); it never passes a path, only a match id.
//!
//! Logs carry reason codes and match ids, never a path, a player name or an account id.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mapcro_desktop_core::mode::{self, Mode, OnUpdate};
use mapcro_desktop_core::{folder, parse, preview, replays, steam};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

mod links;

/// The site the window loads. A debug build takes `MAPCRO_URL` instead (a local dev server).
const SITE: &str = "https://mapcro.dmgdeadlock.com";
const WINDOW: &str = "main";
/// The app's own commands: the only IPC the site gets.
const COMMANDS: [&str; 6] = ["allow-replays-list", "allow-replay-read", "allow-replay-timeline", "allow-replay-preview", "allow-replays-choose-folder", "allow-app-update"];
/// Installed or portable (the `portable` feature; desktop/README.md, Installer or portable).
const MODE: Mode = Mode::of_build(cfg!(feature = "portable"));
/// Timelines kept parsed (each ~0.6 MB gzip for a 44 min match).
const CACHED: usize = 8;

fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if let Some(code) = parse::child_main(&args).or_else(|| preview::child_main(&args)) {
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
    /// The folder the user chose (Change folder), kept in the app's config folder.
    chosen: Mutex<Option<PathBuf>>,
    /// Recent parses, by match id, newest last.
    parsed: Mutex<Vec<(String, Parsed)>>,
    /// One parse at a time.
    parsing: Mutex<()>,
    /// The previews read so far, by file size and time (`None` until first asked: loaded from the
    /// app's cache folder then).
    previews: Mutex<Option<preview::Cache>>,
    /// One preview read at a time (the cards ask as they come into view).
    previewing: Mutex<()>,
    /// Portable: the feed's answer, once asked (`Some(None)`: up to date).
    update: Mutex<Option<Option<String>>>,
}

impl Shared {
    /// The folder to list, looked up now: the chosen one while it's there, else Deadlock's own
    /// (`folder::resolve`). Blocking (it reads two small Steam files).
    fn dir(&self) -> Result<PathBuf, String> {
        let chosen = self.chosen.lock().map_err(|_| "busy".to_string())?.clone();
        folder::resolve(chosen.as_deref(), steam::locate, steam::Missing::code).map_err(|e| {
            eprintln!("mapcro: replays folder not found: {}", e.reason());
            e.code().to_string()
        })
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

impl Shared {
    /// Match `id`'s preview: from the cache while the file is unchanged, else read from the demo
    /// now, in a child, and kept.
    fn preview(&self, app: &AppHandle, id: &str) -> Result<preview::Preview, String> {
        let dir = self.dir().map_err(|_| "not_found".to_string())?;
        let demo = replays::demo_path(&dir, id).ok_or("bad_id")?;
        let cache_dir = app.path().app_cache_dir().map_err(|_| "failed".to_string())?;
        let _one = self.previewing.lock().map_err(|_| "busy".to_string())?;
        let meta = std::fs::metadata(&demo).map_err(|_| "not_found".to_string())?;
        let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
        {
            let mut cache = self.previews.lock().map_err(|_| "busy".to_string())?;
            if let Some(hit) = cache.get_or_insert_with(|| preview::Cache::load(&cache_dir)).get(id, meta.len(), modified) {
                return hit.clone();
            }
        }
        let exe = std::env::current_exe().map_err(|_| "failed".to_string())?;
        let n: u64 = id.parse().map_err(|_| "bad_id".to_string())?;
        let result = preview::read(&exe, &demo, n, preview::TIMEOUT);
        if let Err(why) = &result {
            eprintln!("mapcro: replay {id} has no preview: {why}");
        }
        let mut cache = self.previews.lock().map_err(|_| "busy".to_string())?;
        let cache = cache.get_or_insert_with(preview::Cache::default);
        cache.put(id, meta.len(), modified, result.clone());
        if cache.save(&cache_dir).is_err() {
            eprintln!("mapcro: previews not kept");
        }
        result.map_err(str::to_owned)
    }
}

/// One replay's preview card, read from its demo (spec §6b): `{match_id, duration_s, game_mode,
/// winner, teams, build}`, the server's preview's shape, or a reason code. No names, no ids.
#[tauri::command]
async fn replay_preview(app: AppHandle, state: tauri::State<'_, Arc<Shared>>, id: String) -> Result<preview::Preview, String> {
    let shared = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || shared.preview(&app, &id)).await.map_err(|_| "failed".to_string())?
}

/// The folder's replays, newest first: `[{id, lastModified, size}]`. The folder is looked up on
/// each call (the picker calls it while it's open).
#[tauri::command]
async fn replays_list(state: tauri::State<'_, Arc<Shared>>) -> Result<Vec<replays::Replay>, String> {
    let shared = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || replays::list(&shared.dir()?).map_err(|_| "not_found".to_string())).await.map_err(|_| "failed".to_string())?
}

/// One replay's file, by match id (the fallback when the server takes no timelines yet).
#[tauri::command]
async fn replay_read(state: tauri::State<'_, Arc<Shared>>, id: String) -> Result<Response, String> {
    let shared = Arc::clone(&state);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let demo = replays::demo_path(&shared.dir()?, &id).ok_or("bad_id")?;
        let len = std::fs::metadata(&demo).map_err(|_| "not_found")?.len();
        if len > parse::MAX_DEM_BYTES {
            return Err("too_large".to_string());
        }
        std::fs::read(&demo).map_err(|_| "not_found".to_string())
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

/// Change folder: the system's folder chooser (never a file chooser), opened at the folder listed
/// now. The choice is kept for later runs. `chosen`, or `cancelled`. The page gets no path.
#[tauri::command]
async fn replays_choose_folder(app: AppHandle, state: tauri::State<'_, Arc<Shared>>) -> Result<&'static str, String> {
    let shared = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("Replays folder");
        if let Ok(now) = shared.dir() {
            dialog = dialog.set_directory(now);
        }
        if let Some(w) = app.get_webview_window(WINDOW) {
            dialog = dialog.set_parent(&w);
        }
        let Some(picked) = dialog.blocking_pick_folder().and_then(|p| p.into_path().ok()) else { return Ok("cancelled") };
        let config = app.path().app_config_dir().map_err(|_| "failed".to_string())?;
        if folder::save(&config, &picked).is_err() {
            eprintln!("mapcro: replays folder choice not kept");
        }
        *shared.chosen.lock().map_err(|_| "busy".to_string())? = Some(picked);
        Ok("chosen")
    })
    .await
    .map_err(|_| "failed".to_string())?
}

/// Portable only: the newer version the update feed offers, if any (the page shows "Update
/// available", a link to the release page). Asked once per run, when the page first asks. The
/// installed app installs updates itself (`check_for_update`), so it answers nothing here.
#[tauri::command]
async fn app_update(app: AppHandle, state: tauri::State<'_, Arc<Shared>>) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;
    if MODE.on_update() != OnUpdate::Notify || !mode::updates_on(&pubkey(&app)) {
        return Ok(None);
    }
    if let Some(known) = state.update.lock().map_err(|_| "busy".to_string())?.clone() {
        return Ok(known);
    }
    let found = match app.updater().map_err(|_| "failed".to_string())?.check().await {
        Ok(u) => u.map(|u| u.version),
        Err(e) => {
            eprintln!("mapcro: update check failed: {e}");
            return Err("failed".into());
        }
    };
    *state.update.lock().map_err(|_| "busy".to_string())? = Some(found.clone());
    Ok(found)
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
        // First: a second launch shows this one's window instead, and (its `deep-link` feature)
        // hands its mapcro:// link to the deep-link plugin first (links.rs).
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::clone(&shared))
        .invoke_handler(tauri::generate_handler![replays_list, replay_read, replay_timeline, replay_preview, replays_choose_folder, app_update])
        .setup(move |app| {
            let handle = app.handle().clone();
            if site.as_str().trim_end_matches('/') != SITE {
                dev_capability(&handle, &site)?;
            }
            if let Ok(config) = handle.path().app_config_dir()
                && let Ok(mut c) = shared.chosen.lock()
            {
                *c = folder::load(&config);
            }
            window(&handle, &links::first_page(&handle, &site))?;
            links::listen(&handle, &site, WINDOW);
            links::register(&handle, MODE);
            check_for_update(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("mapcro failed to start");
}

/// A debug build pointed at a dev server: the same six commands for its origin.
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

/// The one window: the site. A link off the site opens in the system browser. Closing it quits:
/// nothing runs in the background.
fn window(app: &AppHandle, site: &Url) -> tauri::Result<()> {
    let origin = site.origin();
    let opener = app.clone();
    let builder = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(site.clone()));
    #[cfg(debug_assertions)]
    let builder = match automation_browser_args() {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    };
    builder
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
    Ok(())
}

/// A debug build under WebDriver (the smoke test, Windows): the browser arguments msedgedriver
/// sets in `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (`--remote-debugging-port=0` among them), merged
/// with wry's defaults. WebView2 ignores that variable when the app passes arguments of its own,
/// as wry always does, so without this the driver never finds the DevTools port ("DevToolsActivePort
/// file doesn't exist"). Only with tauri-driver's `TAURI_WEBVIEW_AUTOMATION=true` set too; a
/// release build reads neither.
#[cfg(debug_assertions)]
fn automation_browser_args() -> Option<String> {
    if std::env::var("TAURI_WEBVIEW_AUTOMATION").as_deref() != Ok("true") {
        return None;
    }
    let driver = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok().filter(|a| !a.trim().is_empty())?;
    Some(merge_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required", &driver))
}

/// `base` then `extra`, with one `--disable-features=` holding both lists (Chromium reads only the
/// last of a repeated switch).
#[cfg(debug_assertions)]
fn merge_browser_args(base: &str, extra: &str) -> String {
    const DISABLE: &str = "--disable-features=";
    let (mut features, mut rest) = (Vec::new(), Vec::new());
    for arg in base.split_whitespace().chain(extra.split_whitespace()) {
        match arg.strip_prefix(DISABLE) {
            Some(list) => {
                for f in list.split(',') {
                    if !f.is_empty() && !features.contains(&f) {
                        features.push(f);
                    }
                }
            }
            None => rest.push(arg),
        }
    }
    let disable = format!("{DISABLE}{}", features.join(","));
    std::iter::once(disable.as_str()).chain(rest).collect::<Vec<_>>().join(" ")
}

#[cfg(all(test, debug_assertions))]
mod tests {
    #[test]
    fn merges_disable_features() {
        let merged = super::merge_browser_args("--disable-features=a,b --x", "--y --disable-features=b,c --remote-debugging-port=0");
        assert_eq!(merged, "--disable-features=a,b,c --x --y --remote-debugging-port=0");
    }
}

/// Check the update feed once at start, and install what it offers (Windows: the installer runs
/// passively and restarts the app). Off while the public key is the placeholder. Portable doesn't
/// install: the page asks `app_update` instead.
fn check_for_update(app: &AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    if !mode::updates_on(&pubkey(app)) {
        eprintln!("mapcro: updates off (no public key configured)");
        return;
    }
    if MODE.on_update() != OnUpdate::Install {
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

/// The updater's public key (`tauri.conf.json` `plugins.updater.pubkey`).
fn pubkey(app: &AppHandle) -> String {
    app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).unwrap_or("").to_owned()
}
