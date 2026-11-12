//! Who may do what in a room (docs/specs/sessions.md §3.4–§3.6). Every credential a route or
//! the WebSocket takes is resolved here, in one place: a board or session link
//! (`Authorization: Bearer <token>`), or a session's grant on a board
//! (`Authorization: Grant <session>.<grant>.<session token>`, or `Auth.via` on the socket).
//!
//! Errors never say which part of a credential failed, and nothing here logs a token, an id or
//! a hash.

use crate::AppState;
use crate::links;
pub use crate::store::RoomKind;
use axum::http::HeaderMap;
use mapcro_engine::wire::LinkRole;

/// A credential as presented. Shapes are checked when parsing; nothing else is.
pub enum Credential {
    /// A link token: the room's own link.
    Bearer(String),
    /// A session member opening one of the session's boards.
    Grant {
        session: String,
        grant: String,
        token: String,
    },
}

impl Credential {
    /// The request's credential, or `None` if it has none or a malformed one.
    pub fn from_headers(headers: &HeaderMap) -> Option<Credential> {
        let v = headers.get("authorization")?.to_str().ok()?;
        if let Some(t) = v.strip_prefix("Bearer ") {
            return links::plausible_token(t).then(|| Credential::Bearer(t.to_owned()));
        }
        let rest = v.strip_prefix("Grant ")?;
        let mut parts = rest.splitn(3, '.');
        let (s, g, t) = (parts.next()?, parts.next()?, parts.next()?);
        (links::plausible_board_id(s) && mapcro_schema::is_id22(g) && links::plausible_token(t))
            .then(|| Credential::Grant {
                session: s.to_owned(),
                grant: g.to_owned(),
                token: t.to_owned(),
            })
    }

    /// The socket's credential: the token alone, or the session's grant (`Auth.via`).
    pub fn from_auth(token: String, via: Option<mapcro_engine::wire::Via>) -> Option<Credential> {
        match via {
            None => links::plausible_token(&token).then_some(Credential::Bearer(token)),
            Some(v) => (links::plausible_board_id(&v.session)
                && mapcro_schema::is_id22(&v.grant)
                && links::plausible_token(&token))
            .then_some(Credential::Grant {
                session: v.session,
                grant: v.grant,
                token,
            }),
        }
    }
}

/// Access through a session (sessions spec §3.4).
#[derive(Clone, Debug)]
pub struct Via {
    /// The session link it came through, so revoking that link closes this access too (§3.7).
    pub session_hash: String,
}

/// What a resolved credential may do in its room.
#[derive(Clone, Debug)]
pub struct Access {
    pub role: LinkRole,
    /// The links row the room revokes this access by: the caller's own link, or the grant's.
    pub link_hash: String,
    pub via: Option<Via>,
}

impl Access {
    /// Mint, list, revoke and rotate: never through a session (§3.5). Minting would turn
    /// session-scoped access into a token that outlives the tab, the grant and the session link.
    pub fn can_share(&self) -> bool {
        self.via.is_none() && matches!(self.role, LinkRole::Owner | LinkRole::Edit)
    }

    pub fn can_edit(&self) -> bool {
        matches!(self.role, LinkRole::Owner | LinkRole::Edit)
    }
}

#[derive(Debug)]
pub enum Denied {
    /// No credential, or a malformed one.
    Missing,
    /// A credential that doesn't open this room: unknown, revoked, another room's, the wrong
    /// kind, or a grant that isn't live. All read the same.
    Refused,
    Storage(crate::store::StoreError),
    /// The session's room couldn't be opened to check its tab (the server is busy).
    Unavailable,
}

/// The lesser of two roles.
pub fn min_role(a: LinkRole, b: LinkRole) -> LinkRole {
    let rank = |r: LinkRole| match r {
        LinkRole::View => 0,
        LinkRole::Edit => 1,
        LinkRole::Owner => 2,
    };
    if rank(a) <= rank(b) { a } else { b }
}

/// Resolve `cred` for `room`. `kind` is what the route serves; `None` (the socket without
/// `via`) takes the link's own room, whatever its kind: a session's own connection.
pub async fn resolve(
    app: &AppState,
    room: &str,
    kind: Option<RoomKind>,
    cred: &Credential,
) -> Result<Access, Denied> {
    match cred {
        Credential::Bearer(token) => {
            let hash = links::hash(token);
            match app
                .store
                .link(hash.clone())
                .await
                .map_err(Denied::Storage)?
            {
                Some(l) if l.board == room && !l.revoked && kind.is_none_or(|k| k == l.kind) => {
                    Ok(Access {
                        role: l.role,
                        link_hash: hash,
                        via: None,
                    })
                }
                _ => Err(Denied::Refused),
            }
        }
        Credential::Grant {
            session,
            grant,
            token,
        } => {
            // A grant opens a board, never a session.
            if kind.is_some_and(|k| k != RoomKind::Board) {
                return Err(Denied::Refused);
            }
            // 1. The session link: live, a session's, this session's.
            let session_hash = links::hash(token);
            let s = match app
                .store
                .link(session_hash.clone())
                .await
                .map_err(Denied::Storage)?
            {
                Some(l) if l.board == *session && !l.revoked && l.kind == RoomKind::Session => l,
                _ => return Err(Denied::Refused),
            };
            // 2. The grant: this session's, for this board.
            let g = match app
                .store
                .grant(session.clone(), grant.clone())
                .await
                .map_err(Denied::Storage)?
            {
                Some(g) if g.board == room => g,
                _ => return Err(Denied::Refused),
            };
            // 3. The grant's links row: live (revocation up its chain marks it), on this board.
            let gl = match app
                .store
                .link(g.link_hash.clone())
                .await
                .map_err(Denied::Storage)?
            {
                Some(l) if l.board == room && !l.revoked && l.kind == RoomKind::Board => l,
                _ => return Err(Denied::Refused),
            };
            // 4. A live tab in the session with this grant and board.
            match app.rooms.tab_live(session, room, grant).await {
                Ok(true) => {}
                Ok(false) => return Err(Denied::Refused),
                Err(crate::room::RoomError::NotFound) => return Err(Denied::Refused),
                Err(_) => return Err(Denied::Unavailable),
            }
            // min(session role, grant role), and never more than edit.
            let role = min_role(min_role(s.role, gl.role), LinkRole::Edit);
            Ok(Access {
                role,
                link_hash: g.link_hash,
                via: Some(Via { session_hash }),
            })
        }
    }
}

/// [`resolve`] for an HTTP route on a board: the request's credential, either kind of it.
pub async fn board(app: &AppState, board: &str, headers: &HeaderMap) -> Result<Access, Denied> {
    let cred = Credential::from_headers(headers).ok_or(Denied::Missing)?;
    resolve(app, board, Some(RoomKind::Board), &cred).await
}

/// The room's own link from `Authorization: Bearer`, for the routes that manage links. A grant
/// is refused here as a link that can't share.
pub async fn own_link(
    app: &AppState,
    room: &str,
    kind: RoomKind,
    headers: &HeaderMap,
) -> Result<Access, Denied> {
    match Credential::from_headers(headers).ok_or(Denied::Missing)? {
        Credential::Grant { .. } => Err(Denied::Refused),
        cred => resolve(app, room, Some(kind), &cred).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn min_role_is_the_lesser() {
        use LinkRole::*;
        for (a, b, want) in [
            (Owner, Edit, Edit),
            (Edit, Owner, Edit),
            (View, Owner, View),
            (Edit, View, View),
            (Owner, Owner, Owner),
            (Edit, Edit, Edit),
        ] {
            assert_eq!(min_role(a, b), want, "{a:?} {b:?}");
        }
    }

    #[test]
    fn credentials_are_parsed_by_shape_only() {
        let t = links::new_token();
        let s = links::new_board_id();
        let g = links::new_board_id();
        let h = |v: &str| {
            let mut m = HeaderMap::new();
            m.insert("authorization", v.parse().expect("header"));
            m
        };
        assert!(matches!(
            Credential::from_headers(&h(&format!("Bearer {t}"))),
            Some(Credential::Bearer(_))
        ));
        assert!(matches!(
            Credential::from_headers(&h(&format!("Grant {s}.{g}.{t}"))),
            Some(Credential::Grant { .. })
        ));
        for bad in [
            format!("Grant {s}.{g}"),
            format!("Grant {s}.{g}.short"),
            format!("Grant {s}x.{g}.{t}"),
            format!("Grant {s}.{g}.{t}.x"),
            "Bearer short".into(),
            format!("Basic {t}"),
        ] {
            assert!(Credential::from_headers(&h(&bad)).is_none(), "{bad}");
        }
        assert!(Credential::from_headers(&HeaderMap::new()).is_none());
    }
}
