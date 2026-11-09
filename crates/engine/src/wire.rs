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
        /// The client's protocol build (`mapcro_schema::BUILD_ID` of its WASM). Another build
        /// than the server's is closed as `Outdated`; absent (older clients, tools): no check.
        #[serde(default)]
        #[cfg_attr(feature = "ts", ts(optional))]
        build: Option<String>,
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
    /// The client is from another build than the server (a deploy happened): reload.
    Outdated,
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
    /// Where each laser gesture after the first starts: indices into `laser`, rising, each in
    /// `1..laser.len()`. One press-to-release is one trail: without this, a new press was drawn
    /// joined to the last one as it faded. Optional in TypeScript, like `picked`.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<Vec<u8>>", optional))]
    pub laser_starts: Vec<u8>,
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
    /// The laser's palette colour (index, < 16). Absent: the person's own colour.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub laser_color: Option<u8>,
    /// Player (spec §6b): the mode and, in Player, the match playback, so followers mirror
    /// it. Absent: an older client, or a board without a match.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub playback: Option<Playback>,
    /// What this person's pointer is over on the map, so a follower shows the same hover label
    /// (spec §8): `marker:<key>` or `token:<roster slot>[:part]`, never an id or a name. The
    /// follower words it from its own state. Absent: nothing, or an older client.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub hover: Option<String>,
}

/// A hover reference is at most this long: a marker key is under 64.
pub const MAX_HOVER: usize = 96;

/// One person's Player state, relayed in presence (spec §6b).
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Playback {
    /// In Player (true) or Sandbox (false).
    pub player: bool,
    pub match_id: u64,
    /// Match seconds when sent.
    pub t: f32,
    pub playing: bool,
    pub speed: f32,
    /// The event this person last jumped to, while it's still pinned: followers ring it and
    /// mark the same row (QA 2026-11-08). Absent from older clients.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub jump: Option<Jump>,
}

/// A jump to an event (spec §6b), as presence carries it.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Jump {
    /// The event's key in the client's events list (`eventKey`).
    pub key: String,
    /// Match seconds the jump landed at: a new jump to the same event lands again.
    pub at: f32,
}

/// An event key is a handful of short fields; 96 is several times the longest.
pub const MAX_JUMP_KEY: usize = 96;

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
            && self.laser_starts.len() < MAX_LASER_POINTS
            && self.laser_starts.windows(2).all(|w| w[0] < w[1])
            && self.laser_starts.iter().all(|&i| i >= 1 && usize::from(i) < self.laser.len())
            && self.ink.as_ref().is_none_or(|i| i.color < 16 && i.points.len() <= MAX_INK_POINTS && i.points.iter().all(ok_pos))
            && self.ping.as_ref().is_none_or(|p| ok_pos(&p.at))
            && self.laser_color.is_none_or(|c| c < 16)
            && self.hover.as_ref().is_none_or(|h| h.len() <= MAX_HOVER && h.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-')))
            && self.playback.as_ref().is_none_or(|b| {
                let clock = |t: f32| t.is_finite() && (0.0..=86_400.0).contains(&t);
                clock(b.t)
                    && b.speed.is_finite()
                    && (0.0..=16.0).contains(&b.speed)
                    && b.match_id < 1_000_000_000_000
                    && b.jump.as_ref().is_none_or(|j| clock(j.at) && j.key.len() <= MAX_JUMP_KEY && !j.key.chars().any(char::is_control))
            })
            && self.cursor.as_ref().is_none_or(ok_pos)
            && self.drag.as_ref().is_none_or(|d| ok_pos(&d.pos))
            && self.drag_group.len() <= MAX_DRAG_GROUP
            && self.picked.len() <= MAX_PICKED
            && self.picked.iter().all(mapcro_schema::ObjectiveKey::is_valid)
            && self.view.as_ref().is_none_or(|v| ok_pos(&v.center) && (100..=20_000).contains(&v.zoom))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn laser(n: usize, starts: Vec<u8>) -> Presence {
        Presence { laser: vec![WorldPos { x: 0, y: 0 }; n], laser_starts: starts, ..Default::default() }
    }

    #[test]
    fn laser_starts_are_rising_indices_inside_the_trail() {
        assert!(laser(0, vec![]).is_valid());
        assert!(laser(10, vec![3, 7]).is_valid());
        assert!(laser(MAX_LASER_POINTS, (1..MAX_LASER_POINTS as u8).collect()).is_valid());
        // Not rising, at the trail's start, past its end, or with no trail at all.
        assert!(!laser(10, vec![7, 3]).is_valid());
        assert!(!laser(10, vec![3, 3]).is_valid());
        assert!(!laser(10, vec![0]).is_valid());
        assert!(!laser(10, vec![10]).is_valid());
        assert!(!laser(0, vec![1]).is_valid());
    }

    #[test]
    fn a_hover_is_a_short_key() {
        let with = |h: &str| Presence { hover: Some(h.into()), ..Presence::default() };
        assert!(with("marker:camp:neutral:lane0:3").is_valid());
        assert!(with("token:Amber-2:vis").is_valid());
        assert!(!with(&"k".repeat(MAX_HOVER + 1)).is_valid());
        assert!(!with("token:<b>").is_valid());
        assert!(!with("marker:a b").is_valid());
    }

    #[test]
    fn a_jump_in_playback_is_bounded() {
        let with = |key: &str, at: f32| Presence {
            playback: Some(Playback { player: true, match_id: 1, t: 10.0, playing: false, speed: 1.0, jump: Some(Jump { key: key.to_owned(), at }) }),
            ..Default::default()
        };
        assert!(with("35:death:amber:2:::7", 30.0).is_valid());
        assert!(with(&"k".repeat(MAX_JUMP_KEY), 0.0).is_valid());
        assert!(!with(&"k".repeat(MAX_JUMP_KEY + 1), 30.0).is_valid());
        assert!(!with("a\nb", 30.0).is_valid());
        assert!(!with("k", f32::NAN).is_valid());
        assert!(!with("k", -1.0).is_valid());
        assert!(!with("k", 86_401.0).is_valid());
    }
}
