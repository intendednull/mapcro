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

/// The board a link names: `mapcro://b/<board>#<token>`, or the site's own
/// `https://mapcro.dmgdeadlock.com/b/<board>#<token>`. Surrounding whitespace is dropped (a
/// pasted link); the scheme and host are matched without case, the rest exactly.
pub fn parse(link: &str) -> Option<Board> {
    let link = link.trim();
    if link.len() > MAX_LEN || !link.is_ascii() {
        return None;
    }
    let scheme_end = link.find("://")?;
    let (scheme, rest) = (&link[..scheme_end], &link[scheme_end + 3..]);
    if scheme.eq_ignore_ascii_case(SCHEME) {
        let rest = rest.get(..2).filter(|p| p.eq_ignore_ascii_case("b/")).map(|_| &rest[2..])?;
        return board_and_token(rest, true);
    }
    let host = SITE.strip_prefix("https://").expect("SITE is https");
    if scheme.eq_ignore_ascii_case("https") {
        let path = rest.get(..host.len()).filter(|h| h.eq_ignore_ascii_case(host)).map(|_| &rest[host.len()..])?;
        return board_and_token(path.strip_prefix("/b/")?, false);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "AbCdEfGhIjKlMnOpQrSt-_";
    const TOKEN: &str = "0123456789abcdefghijklmnopqrstuvwxyzABCD-_Z";

    fn canonical() -> String {
        format!("mapcro://b/{ID}#{TOKEN}")
    }

    #[test]
    fn the_canonical_form_maps_to_the_board_on_the_site() {
        let b = parse(&canonical()).expect("a board link");
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
        let b = parse(&canonical()).expect("a board link");
        let shown = format!("{b:?}");
        assert!(shown.contains(ID));
        assert!(!shown.contains(TOKEN), "{shown}");
        assert_eq!(b.token(), TOKEN);
    }
}
