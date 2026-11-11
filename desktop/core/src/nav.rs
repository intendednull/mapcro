//! Where a link from the page goes (desktop/README.md, Links off the site): the site's own pages
//! stay in the app's window; a web or mail link off the site opens in the system browser (or mail
//! app); anything else is dropped. The same rule for a navigation (a plain link, a redirect, a
//! script setting `location`) and a new-window request (`target="_blank"`, `window.open`): a
//! new window is never opened, since one would sit outside the IPC allow-list's `main` window and
//! have no way back.

use url::Url;

/// What the window does with a URL the page asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// The site's own origin: load it in the app's window.
    App,
    /// Off the site, `http`, `https` or `mailto`: hand it to the system's default handler.
    Browser,
    /// Anything else (`file:`, `javascript:`, `data:`, a custom scheme, an unparsable URL).
    Drop,
}

/// The route for `to`, from a page on `site`'s origin.
pub fn route(to: &Url, site: &Url) -> Route {
    if to.origin() == site.origin() && to.origin().is_tuple() {
        Route::App
    } else if matches!(to.scheme(), "http" | "https" | "mailto") {
        Route::Browser
    } else {
        Route::Drop
    }
}

/// [`route`] for a URL as text (a new-window request hands one over unparsed).
pub fn route_str(to: &str, site: &Url) -> Route {
    Url::parse(to).map_or(Route::Drop, |u| route(&u, site))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site() -> Url {
        Url::parse("https://mapcro.dmgdeadlock.com/").expect("url")
    }

    #[test]
    fn the_sites_own_pages_stay_in_the_window() {
        for u in ["https://mapcro.dmgdeadlock.com/", "https://mapcro.dmgdeadlock.com/b/abc#token", "https://mapcro.dmgdeadlock.com:443/x?y=1"] {
            assert_eq!(route_str(u, &site()), Route::App, "{u}");
        }
        // A debug build's dev server is its own site.
        let dev = Url::parse("http://127.0.0.1:5173/").expect("url");
        assert_eq!(route_str("http://127.0.0.1:5173/b/x", &dev), Route::App);
        assert_eq!(route_str("http://127.0.0.1:5174/b/x", &dev), Route::Browser);
    }

    #[test]
    fn links_off_the_site_go_to_the_system_browser() {
        for u in [
            "https://github.com/intendednull/mapcro/issues/1",
            "http://mapcro.dmgdeadlock.com/",
            "https://mapcro.dmgdeadlock.com.evil.example/",
            "https://sub.mapcro.dmgdeadlock.com/",
            "https://mapcro.dmgdeadlock.com:8443/",
            "mailto:someone@example.com",
        ] {
            assert_eq!(route_str(u, &site()), Route::Browser, "{u}");
        }
    }

    #[test]
    fn other_schemes_and_junk_are_dropped() {
        for u in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "about:blank", "mapcro://b/x#y", "ms-settings:", "", "not a url"] {
            assert_eq!(route_str(u, &site()), Route::Drop, "{u}");
        }
    }
}
