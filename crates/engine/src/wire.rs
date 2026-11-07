//! The JSON frames on the WebSocket, shared by the server and the browser client.
//!
//! A connection opens with `Auth`. The server answers `Ready` (with a base document if the
//! client has none) and the engine protocol (`ClientMsg`/`ServerMsg`) runs from there.

use crate::protocol::{ClientMsg, ServerMsg};
use mapcro_schema::Doc;
use serde::{Deserialize, Serialize};

/// What a link lets you do. `Owner` can also mint and revoke links.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkRole {
    Owner,
    Edit,
    View,
}

impl LinkRole {
    pub fn engine_role(self) -> crate::Role {
        match self {
            LinkRole::Owner | LinkRole::Edit => crate::Role::Edit,
            LinkRole::View => crate::Role::View,
        }
    }
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum WireIn {
    /// First frame. The token travels here, never in the URL (spec §11).
    Auth {
        board: String,
        token: String,
        /// `None` if the client holds no copy of this board yet and needs a base document.
        known_seq: Option<u64>,
    },
    Msg { msg: ClientMsg },
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum WireOut {
    Ready { role: LinkRole, base: Option<Base> },
    Msg { msg: ServerMsg },
    /// The server is closing this connection.
    Closed { reason: CloseReason },
}

/// A document at a log position, from which a replica starts.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Base {
    pub doc: Doc,
    pub seq: u64,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    /// Bad or unknown link, or wrong board.
    Unauthorized,
    /// The owner revoked this link.
    Revoked,
    /// Malformed frame, oversize, or too many messages.
    Abuse,
    /// The client is too slow to keep up with the room.
    TooSlow,
    /// The server couldn't make an edit durable and stopped the room rather than lie.
    StorageFailure,
    /// The engine protocol was broken (see the preceding `Fatal`).
    Protocol,
    ShuttingDown,
}
