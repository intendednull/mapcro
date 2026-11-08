//! The JSON frames on the WebSocket, shared by the server and the browser client.
//!
//! A connection opens with `Auth`. The server answers `Ready` (with a base document if the
//! client has none) and the engine protocol (`ClientMsg`/`ServerMsg`) runs from there.

use crate::protocol::{ClientMsg, ServerMsg};
use mapcro_schema::{Doc, RecordId, WorldPos};
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
    /// This client's presence, replacing its previous one. Ephemeral: never stored.
    Presence { state: Presence },
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum WireOut {
    /// `peer` is this connection's id in presence batches (so the UI can tell "following you").
    Ready { role: LinkRole, base: Option<Base>, peer: u64 },
    Msg { msg: ServerMsg },
    /// Presence changes since the last batch; `state: null` means the peer left.
    Presence { peers: Vec<PeerPresence> },
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
    /// The room already has as many sessions as it allows.
    Full,
    /// Too many connections from this address.
    TooMany,
    /// The server has as many boards open as it allows, all in use. Try again later.
    Busy,
}

/// What one person is doing right now (spec §8). Sent by its owner at up to ~20 Hz; relayed to
/// everyone in the room; never stored.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Presence {
    pub name: String,
    /// Index into the UI's presence palette.
    pub color: u8,
    pub scene: Option<RecordId>,
    pub floor: Floor,
    /// Map centre (world units) and zoom, so followers can mirror the view.
    pub view: Option<Viewport>,
    pub cursor: Option<WorldPos>,
    /// The laser pointer's recent trail, oldest first.
    pub laser: Vec<WorldPos>,
    /// A drag in progress: which record, and where it is now (spec §4a: preview, then one op).
    pub drag: Option<DragPreview>,
    /// Other records moving with `drag` by the same offset: a group move of selected heroes.
    /// Meaningless without `drag`.
    #[serde(default)]
    pub drag_group: Vec<RecordId>,
    /// Objectives this person has selected as a group (by key: an objective at its default
    /// state has no record), so others see whose selection it is.
    /// Optional in TypeScript: clients that never select objectives can leave it out.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<Vec<mapcro_schema::ObjectiveKey>>", optional))]
    pub picked: Vec<mapcro_schema::ObjectiveKey>,
    /// The element this person is interacting with (selected, editing its text). Others see
    /// this person's name tag beside it, like collaborators' names in a shared document.
    pub focus: Option<RecordId>,
    /// The peer this person is following, if any.
    pub following: Option<u64>,
    /// A stroke being drawn right now, so others see it as it's drawn. It becomes a Stroke
    /// record on release. Optional in TypeScript, like `picked`.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub ink: Option<LiveInk>,
    /// The latest ping (a middle click): where, and a counter so the same spot can ping again.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub ping: Option<Ping>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveInk {
    /// The stroke's colour (the ink palette index it will be saved with).
    pub color: u8,
    /// Oldest point first.
    pub points: Vec<WorldPos>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ping {
    pub at: WorldPos,
    pub n: u32,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Floor {
    #[default]
    Surface,
    Tunnels,
    Rat,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub center: WorldPos,
    /// Thousandths: 1000 = fit the map.
    pub zoom: u32,
    /// Whose side is at the bottom (the viewpoint), so followers see the map turned the same
    /// way. Older peers don't send it: Amber.
    #[serde(default = "amber_side")]
    pub side: mapcro_schema::Team,
}

fn amber_side() -> mapcro_schema::Team {
    mapcro_schema::Team::Amber
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DragPreview {
    pub id: RecordId,
    /// Where the record is now: its position, or for an arrow or stroke moved whole, where its
    /// first point is now; with `end`, where that end of the arrow is.
    pub pos: WorldPos,
    /// One end of an arrow dragged by itself. Absent for everything else.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub end: Option<ArrowEnd>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArrowEnd {
    From,
    To,
}

/// One peer in a presence batch. `peer` is per connection (not the client id), and `role` is
/// stamped by the server from the peer's link, so nobody can pose as an editor to be followed.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PeerPresence {
    pub peer: u64,
    pub role: LinkRole,
    pub state: Option<Presence>,
}

pub const MAX_LASER_POINTS: usize = 48;
/// A live stroke carries at most what a Stroke record may hold.
pub const MAX_INK_POINTS: usize = mapcro_schema::LIMITS.max_stroke_points;
/// A group move carries at most the whole roster.
pub const MAX_DRAG_GROUP: usize = 12;
/// More than every objective, camp and rift on the map.
pub const MAX_PICKED: usize = 128;

impl Presence {
    /// Bounds a presence update must satisfy before it is relayed.
    pub fn is_valid(&self) -> bool {
        let m = mapcro_schema::LIMITS.max_coord;
        let ok_pos = |p: &WorldPos| (-m..=m).contains(&p.x) && (-m..=m).contains(&p.y);
        self.name.chars().count() <= mapcro_schema::LIMITS.max_name
            && !self.name.chars().any(char::is_control)
            && self.color < 16
            && self.laser.len() <= MAX_LASER_POINTS
            && self.laser.iter().all(ok_pos)
            && self.ink.as_ref().is_none_or(|i| i.color < 16 && i.points.len() <= MAX_INK_POINTS && i.points.iter().all(ok_pos))
            && self.ping.as_ref().is_none_or(|p| ok_pos(&p.at))
            && self.cursor.as_ref().is_none_or(ok_pos)
            && self.drag.as_ref().is_none_or(|d| ok_pos(&d.pos))
            && self.drag_group.len() <= MAX_DRAG_GROUP
            && self.picked.len() <= MAX_PICKED
            && self.picked.iter().all(mapcro_schema::ObjectiveKey::is_valid)
            && self.view.as_ref().is_none_or(|v| ok_pos(&v.center) && (100..=20_000).contains(&v.zoom))
    }
}
