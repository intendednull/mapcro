//! Links from the page (desktop/README.md, Links off the site): the window's navigations and
//! new-window requests, each sent where `mapcro_desktop_core::nav::route` says. The site's own
//! pages stay in the window (a same-site new-window link opens in it); `http`, `https` and
//! `mailto` off the site go to the system's default handler through the opener, called from
//! Rust; anything else is dropped. No second window is ever opened.
//!
//! `on_new_window` takes `window.open` and, on Windows (WebView2's `NewWindowRequested`), a
//! `target="_blank"` link. Under WebKitGTK a `target="_blank"` link driven over WebDriver raised
//! neither wry's `create` nor a new-window `decide-policy` (2026-11-11, Xvfb), so on Linux that
//! case is unchecked (backlog, Windows app: follow-ups).

use mapcro_desktop_core::nav::{self, Route};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// Where `to`, asked for by the page on `site`, goes. `in_app`: a navigation, which the window
/// makes itself when this answers true; a new-window request is never made, so a same-site one
/// is navigated to here.
fn follow<R: Runtime>(app: &AppHandle<R>, window: &str, site: &Url, to: &Url, in_app: bool) -> bool {
    match nav::route(to, site) {
        Route::App if in_app => true,
        Route::App => {
            if let Some(w) = app.get_webview_window(window) {
                let _ = w.navigate(to.clone());
            }
            false
        }
        Route::Browser => {
            let _ = app.opener().open_url(to.as_str(), None::<&str>);
            false
        }
        Route::Drop => false,
    }
}

/// The window's navigation and new-window handlers.
pub fn handle<'a, R: Runtime, M: Manager<R>>(builder: WebviewWindowBuilder<'a, R, M>, app: &AppHandle<R>, window: &'static str, site: &Url) -> WebviewWindowBuilder<'a, R, M> {
    let (a, s) = (app.clone(), site.clone());
    let (b, t) = (app.clone(), site.clone());
    builder.on_navigation(move |u| follow(&a, window, &s, u, true)).on_new_window(move |u, _| {
        follow(&b, window, &t, &u, false);
        NewWindowResponse::Deny
    })
}
