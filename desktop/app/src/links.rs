//! `mapcro://` board links (desktop/README.md, Deep links). The installer registers the scheme
//! (`tauri.conf.json` `plugins.deep-link`); a link starts the app on that board, or, with the app
//! running, comes to it through the single-instance plugin (its `deep-link` feature) and opens
//! the board in the window. Only a link `mapcro_desktop_core::link::parse` takes is followed, and
//! only to the board's page on the window's own site; anything else is ignored.
//!
//! The token is in the URL's fragment and is never logged: not the link, not the URL.

use mapcro_desktop_core::link;
use mapcro_desktop_core::mode::Mode;
use tauri::{AppHandle, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

/// The board page `link` names, on `site`'s origin, if it's a board link.
fn target(link: &str, site: &Url) -> Option<Url> {
    let board = link::parse(link);
    if board.is_none() {
        eprintln!("mapcro: link ignored: not a board link");
    }
    Url::parse(&board?.url(&site.origin().ascii_serialization())).ok()
}

/// The page to open first: the board a link at start names (the app started by a link), else
/// `site`.
pub fn first_page(app: &AppHandle, site: &Url) -> Url {
    let start = app.deep_link().get_current().ok().flatten().unwrap_or_default();
    start.iter().find_map(|u| target(u.as_str(), site)).unwrap_or_else(|| site.clone())
}

/// Links that come while the app runs (a second launch, forwarded) open their board in `window`.
pub fn listen(app: &AppHandle, site: &Url, window: &'static str) {
    let (site, handle) = (site.clone(), app.clone());
    app.deep_link().on_open_url(move |event| {
        let Some(to) = event.urls().iter().find_map(|u| target(u.as_str(), &site)) else { return };
        let Some(w) = handle.get_webview_window(window) else { return };
        // The same page again is only focused (the single-instance callback shows the window).
        // A fragment-only change is the page's to act on (it reloads a board on `hashchange`).
        if w.url().ok().as_ref() != Some(&to) && w.navigate(to).is_err() {
            eprintln!("mapcro: board link not opened");
        }
    });
}

/// A copy nobody installed registers the scheme itself, on each start (so a moved copy is the
/// one links reach), as `Mode::registers_scheme` says:
/// - the portable build (Windows): `HKCU\Software\Classes\mapcro`, `"<this exe>" "%1"`;
/// - an AppImage: `~/.local/share/applications/<binary>-handler.desktop`, made the
///   `x-scheme-handler/mapcro` default (`xdg-mime`).
///
/// The NSIS installer, the .deb and the nix package register it at install, so they skip this.
pub fn register(app: &AppHandle, mode: Mode) {
    #[cfg(target_os = "linux")]
    let appimage = app.env().appimage.is_some();
    #[cfg(not(target_os = "linux"))]
    let appimage = false;
    if mode.registers_scheme(appimage) && app.deep_link().register_all().is_err() {
        eprintln!("mapcro: mapcro:// links not registered");
    }
}
