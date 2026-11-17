//! Board links handed to the app (desktop/README.md, Deep links): a `mapcro://` link from the
//! system (a browser's "Open in app", a link clicked anywhere), mapped to the board's page on the
//! site. Strict: only a board id and a token of the site's own shapes get through; anything else
//! is `None`, and the app ignores it.
//!
//! The canonical form is `mapcro://b/<board>#<token>`: the site's share link
//! (`https://mapcro.dmgdeadlock.com/b/<board>#<token>`, spec §11) with the scheme and host
//! swapped for `mapcro://`. The token stays in the fragment. The site's own https link is taken
//! too (the same shape, that origin only). A [`Board`]'s `Debug` leaves the token out, so it can't
//! reach a log by accident.
//!
//! A session's link has the same two forms (docs/specs/sessions.md §7.1):
//! `mapcro://s/<session>#<token>`, or with the tab it names, `mapcro://s/<session>?tab=<tab>#<token>`
//! (a tab is a record id: 32 lowercase hex digits; `tab` is the only query taken), and the site's
//! `https://mapcro.dmgdeadlock.com/s/<session>?tab=<tab>#<token>`. It maps to the session's page,
//! `<site>/s/<session>?tab=<tab>#<token>`. A [`Session`]'s `Debug` leaves the token out too.

/// The app's URL scheme (`tauri.conf.json` `plugins.deep-link.desktop.schemes`).
pub const SCHEME: &str = "mapcro";
/// The live site's origin: the only https origin a link may name.
pub const SITE: &str = "https://mapcro.dmgdeadlock.com";
/// Longer input isn't a board link (the canonical form is 79 bytes).
const MAX_LEN: usize = 256;
/// A board id: 16 random bytes, base64url without padding (crates/server).
const BOARD_LEN: usize = 22;
/// A token: 32 random bytes, base64url without padding (spec §11).
const TOKEN_LEN: usize = 43;
/// A tab: a record id, 16 random bytes as lowercase hex.
const TAB_LEN: usize = 32;

/// A board and the token that opens it.
#[derive(Clone, PartialEq, Eq)]
pub struct Board {
    pub id: String,
    token: String,
}

impl std::fmt::Debug for Board {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Board").field("id", &self.id).field("token", &"<redacted>").finish()
    }
}

impl Board {
    /// The board's page on `origin` (`https://mapcro.dmgdeadlock.com`, or a debug build's dev
    /// server): `<origin>/b/<board>#<token>`. `origin` has no trailing slash.
    pub fn url(&self, origin: &str) -> String {
        format!("{}/b/{}#{}", origin.trim_end_matches('/'), self.id, self.token)
    }

    /// The token, for the URL only.
    pub fn token(&self) -> &str {
        &self.token
    }
}

/// A session, the tab its link names (if any) and the token that opens it.
#[derive(Clone, PartialEq, Eq)]
pub struct Session {
    pub id: String,
    pub tab: Option<String>,
    token: String,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session").field("id", &self.id).field("tab", &self.tab).field("token", &"<redacted>").finish()
    }
}

impl Session {
    /// The session's page on `origin`: `<origin>/s/<session>[?tab=<tab>]#<token>`.
    pub fn url(&self, origin: &str) -> String {
        let tab = self.tab.as_deref().map(|t| format!("?tab={t}")).unwrap_or_default();
        format!("{}/s/{}{tab}#{}", origin.trim_end_matches('/'), self.id, self.token)
    }

    /// The token, for the URL only.
    pub fn token(&self) -> &str {
        &self.token
    }
}

/// What a link names: a board, or a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    Board(Board),
    Session(Session),
}

impl Link {
    /// The page it names on `origin`.
    pub fn url(&self, origin: &str) -> String {
        match self {
            Link::Board(b) => b.url(origin),
            Link::Session(s) => s.url(origin),
        }
    }
}

fn b64url(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `<board>#<token>`, from what follows `/b/`. A `/` after the board id is let through on the
/// `mapcro://` form only (some launchers add one); nothing else: no query, no more path.
fn board_and_token(rest: &str, trailing_slash: bool) -> Option<Board> {
    let (id, token) = rest.split_once('#')?;
    let id = if trailing_slash { id.strip_suffix('/').unwrap_or(id) } else { id };
    (b64url(id, BOARD_LEN) && b64url(token, TOKEN_LEN)).then(|| Board { id: id.to_owned(), token: token.to_owned() })
}

/// `<session>[?tab=<tab>]#<token>`, from what follows `/s/`. A `/` after the session id is let
/// through on the `mapcro://` form only; `tab` is the only query.
fn session_and_token(rest: &str, trailing_slash: bool) -> Option<Session> {
    let (head, token) = rest.split_once('#')?;
    let (id, tab) = match head.split_once('?') {
        Some((id, query)) => (id, Some(query.strip_prefix("tab=")?)),
        None => (head, None),
    };
    let id = if trailing_slash { id.strip_suffix('/').unwrap_or(id) } else { id };
    let tab_ok = tab.is_none_or(|t| t.len() == TAB_LEN && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    (b64url(id, BOARD_LEN) && b64url(token, TOKEN_LEN) && tab_ok).then(|| Session { id: id.to_owned(), tab: tab.map(str::to_owned), token: token.to_owned() })
}

/// The board or session a link names: `mapcro://b/<board>#<token>`, `mapcro://s/<session>[?tab=<tab>]#<token>`,
/// or the site's own `https://mapcro.dmgdeadlock.com/b/…` and `/s/…` links. Surrounding whitespace
/// is dropped (a pasted link); the scheme and host are matched without case, the rest exactly.
pub fn parse(link: &str) -> Option<Link> {
    let link = link.trim();
    if link.len() > MAX_LEN || !link.is_ascii() {
        return None;
    }
    let scheme_end = link.find("://")?;
    let (scheme, rest) = (&link[..scheme_end], &link[scheme_end + 3..]);
    if scheme.eq_ignore_ascii_case(SCHEME) {
        return routed(rest, true);
    }
    let host = SITE.strip_prefix("https://").expect("SITE is https");
    if scheme.eq_ignore_ascii_case("https") {
        let path = rest.get(..host.len()).filter(|h| h.eq_ignore_ascii_case(host)).map(|_| &rest[host.len()..])?;
        return routed(path.strip_prefix('/')?, false);
    }
    None
}

/// `b/…` or `s/…`: the route's letter has no case on the `mapcro://` form (it's the URL's host
/// there), and is lowercase on the site's.
fn routed(rest: &str, app: bool) -> Option<Link> {
    let route = rest.get(..2)?;
    let is = |r: &str| if app { route.eq_ignore_ascii_case(r) } else { route == r };
    if is("b/") {
        board_and_token(&rest[2..], app).map(Link::Board)
    } else if is("s/") {
        session_and_token(&rest[2..], app).map(Link::Session)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "AbCdEfGhIjKlMnOpQrSt-_";
    const TOKEN: &str = "0123456789abcdefghijklmnopqrstuvwxyzABCD-_Z";

    const TAB: &str = "0123456789abcdef0123456789abcdef";

    fn canonical() -> String {
        format!("mapcro://b/{ID}#{TOKEN}")
    }

    fn board(link: &str) -> Option<Board> {
        match parse(link)? {
            Link::Board(b) => Some(b),
            Link::Session(_) => None,
        }
    }

    fn session(link: &str) -> Option<Session> {
        match parse(link)? {
            Link::Session(s) => Some(s),
            Link::Board(_) => None,
        }
    }

    #[test]
    fn the_canonical_form_maps_to_the_board_on_the_site() {
        let b = board(&canonical()).expect("a board link");
        assert_eq!(b.id, ID);
        assert_eq!(b.url(SITE), format!("https://mapcro.dmgdeadlock.com/b/{ID}#{TOKEN}"));
        assert_eq!(b.url("http://127.0.0.1:5173/"), format!("http://127.0.0.1:5173/b/{ID}#{TOKEN}"));
    }

    #[test]
    fn the_sites_share_link_and_harmless_variants_are_taken() {
        let https = format!("https://mapcro.dmgdeadlock.com/b/{ID}#{TOKEN}");
        assert_eq!(parse(&https), parse(&canonical()));
        assert!(parse(&format!("  {}\n", canonical())).is_some(), "pasted with whitespace");
        assert!(parse(&format!("MAPCRO://B/{ID}#{TOKEN}")).is_some(), "scheme and host have no case");
        assert!(parse(&format!("HTTPS://Mapcro.DmgDeadlock.com/b/{ID}#{TOKEN}")).is_some());
        assert!(parse(&format!("mapcro://b/{ID}/#{TOKEN}")).is_some(), "a launcher's trailing slash");
    }

    #[test]
    fn hostile_or_broken_input_is_nothing() {
        let bad = [
            String::new(),
            "mapcro://".into(),
            format!("mapcro://b/{ID}"),                                   // no token
            format!("mapcro://b/{ID}#"),                                  // empty token
            format!("mapcro://b/{ID}#{TOKEN}x"),                          // token too long
            format!("mapcro://b/{ID}#{}", &TOKEN[1..]),                   // token too short
            format!("mapcro://b/{}#{TOKEN}", &ID[1..]),                   // id too short
            format!("mapcro://b/{ID}x#{TOKEN}"),                          // id too long
            format!("mapcro://b/{ID}#{}", TOKEN.replace('Z', "=")),       // padding
            format!("mapcro://b/{ID}#{}", TOKEN.replace('Z', "/")),       // not base64url
            format!("mapcro://b/{ID}?x=1#{TOKEN}"),                       // a query
            format!("mapcro://b/../{ID}#{TOKEN}"),                        // traversal
            format!("mapcro://b//{ID}#{TOKEN}"),
            format!("mapcro://b/{ID}//#{TOKEN}"),
            format!("mapcro://x/{ID}#{TOKEN}"),                           // another route
            format!("mapcro://evil.example/b/{ID}#{TOKEN}"),              // a host
            format!("mapcro://b/{ID}#{TOKEN}#{TOKEN}"),
            format!("mapcro:b/{ID}#{TOKEN}"),
            format!("mapcro:/b/{ID}#{TOKEN}"),
            format!("http://mapcro.dmgdeadlock.com/b/{ID}#{TOKEN}"),      // not https
            format!("https://mapcro.dmgdeadlock.com.evil.example/b/{ID}#{TOKEN}"),
            format!("https://evil.example/b/{ID}#{TOKEN}"),
            format!("https://user@mapcro.dmgdeadlock.com/b/{ID}#{TOKEN}"),
            format!("https://mapcro.dmgdeadlock.com:8443/b/{ID}#{TOKEN}"),
            format!("https://mapcro.dmgdeadlock.com/b/{ID}/#{TOKEN}"),    // the site's links have no slash
            format!("https://mapcro.dmgdeadlock.com/x/b/{ID}#{TOKEN}"),
            format!("javascript://b/{ID}#{TOKEN}"),
            format!("file://b/{ID}#{TOKEN}"),
            format!("mapcro://b/{ID}#{}", TOKEN.replace('Z', "%")),       // escapes
            format!("mapcro://b/{}#{TOKEN}", ID.replace('_', "\u{00e9}")), // not ASCII
            format!("mapcro://b/{ID}#{TOKEN}{}", " ".repeat(300)).trim_end().to_owned() + "\u{0}",
            format!("mapcro://b/{ID}#{TOKEN}\u{0}"),
            "x".repeat(10_000),
            format!("{}{}", "mapcro://b/".repeat(40), canonical()),
            format!("--mapcro-parse-replay {ID}"),
        ];
        for input in bad {
            assert!(parse(&input).is_none(), "{input:?}");
        }
    }

    #[test]
    fn debug_leaves_the_token_out() {
        let b = board(&canonical()).expect("a board link");
        let shown = format!("{b:?}");
        assert!(shown.contains(ID));
        assert!(!shown.contains(TOKEN), "{shown}");
        assert_eq!(b.token(), TOKEN);
        let s = parse(&format!("mapcro://s/{ID}?tab={TAB}#{TOKEN}")).expect("a session link");
        let shown = format!("{s:?}");
        assert!(shown.contains(ID) && shown.contains(TAB), "{shown}");
        assert!(!shown.contains(TOKEN), "{shown}");
        assert_eq!(session(&format!("mapcro://s/{ID}#{TOKEN}")).expect("a session link").token(), TOKEN);
    }

    #[test]
    fn a_sessions_link_maps_to_the_session_on_the_site_with_its_tab() {
        let s = session(&format!("mapcro://s/{ID}?tab={TAB}#{TOKEN}")).expect("a session link");
        assert_eq!((s.id.as_str(), s.tab.as_deref()), (ID, Some(TAB)));
        assert_eq!(s.url(SITE), format!("https://mapcro.dmgdeadlock.com/s/{ID}?tab={TAB}#{TOKEN}"));
        assert_eq!(s.url("http://127.0.0.1:5173/"), format!("http://127.0.0.1:5173/s/{ID}?tab={TAB}#{TOKEN}"));
        let bare = parse(&format!("mapcro://s/{ID}#{TOKEN}")).expect("a session link");
        assert_eq!(bare.url(SITE), format!("https://mapcro.dmgdeadlock.com/s/{ID}#{TOKEN}"));
        // The site's own, and the harmless variants a board's link has.
        for ok in [
            format!("https://mapcro.dmgdeadlock.com/s/{ID}?tab={TAB}#{TOKEN}"),
            format!("  MAPCRO://S/{ID}?tab={TAB}#{TOKEN}\n"),
            format!("HTTPS://Mapcro.DmgDeadlock.com/s/{ID}?tab={TAB}#{TOKEN}"),
            format!("mapcro://s/{ID}/?tab={TAB}#{TOKEN}"),
        ] {
            assert_eq!(parse(&ok), Some(Link::Session(s.clone())), "{ok:?}");
        }
        assert_eq!(parse(&format!("mapcro://s/{ID}/#{TOKEN}")), Some(bare));
    }

    #[test]
    fn a_broken_sessions_link_is_nothing() {
        let bad = [
            format!("mapcro://s/{ID}"),
            format!("mapcro://s/{ID}#"),
            format!("mapcro://s/{ID}#{TOKEN}x"),
            format!("mapcro://s/{}#{TOKEN}", &ID[1..]),
            format!("mapcro://s/{ID}?tab={}#{TOKEN}", TAB.to_uppercase()), // a record id is lowercase
            format!("mapcro://s/{ID}?tab={}#{TOKEN}", &TAB[1..]),
            format!("mapcro://s/{ID}?tab={TAB}0#{TOKEN}"),
            format!("mapcro://s/{ID}?tab=#{TOKEN}"),
            format!("mapcro://s/{ID}?x=1#{TOKEN}"), // tab is the only query
            format!("mapcro://s/{ID}?tab={TAB}&x=1#{TOKEN}"),
            format!("mapcro://s/{ID}?tab={TAB}/#{TOKEN}"),
            format!("mapcro://s/{ID}//#{TOKEN}"),
            format!("mapcro://s//{ID}#{TOKEN}"),
            format!("mapcro://s/../{ID}#{TOKEN}"),
            format!("mapcro://evil.example/s/{ID}#{TOKEN}"),
            format!("https://mapcro.dmgdeadlock.com/s/{ID}/#{TOKEN}"),
            format!("https://mapcro.dmgdeadlock.com/S/{ID}#{TOKEN}"),
            format!("https://mapcro.dmgdeadlock.com/B/{ID}#{TOKEN}"),
            format!("https://evil.example/s/{ID}#{TOKEN}"),
            format!("http://mapcro.dmgdeadlock.com/s/{ID}#{TOKEN}"),
            format!("mapcro://s/{ID}#{TOKEN}\u{0}"),
            format!("{}{ID}#{TOKEN}", "mapcro://s/".repeat(40)),
        ];
        for input in bad {
            assert!(parse(&input).is_none(), "{input:?}");
        }
    }
}
