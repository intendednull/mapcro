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
    /// This client's presence, replacing its previous one. Ephemeral: never stored. Boxed: it's
    /// several times the size of the other variants (clippy `large_enum_variant`).
    Presence { state: Box<Presence> },
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum WireOut {
    /// `peer` is this connection's id in presence batches (so the UI can tell "following you").
    /// `head` is the board's log length when the room took the join: once the client's copy is
    /// at it, the client has everything that was logged before it arrived (spec §5). A fresh
    /// client's base may be older (one snapshot serves a burst of joiners), so until then its
    /// view can lack records others made. Absent from older servers.
    Ready {
        role: LinkRole,
        base: Option<Base>,
        peer: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "ts", ts(optional))]
        head: Option<u64>,
    },
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
    /// Random per page load, kept across reconnects (spec §8, sessions.md §6.1): peer ids are
    /// per connection, so after a reconnect (a server restart: every deploy) a follower finds
    /// its presenter again by seat. Never derived from anything about the person. Not
    /// authority: copying a seat is as easy as copying a name. At most `MAX_SEAT`, so a
    /// JavaScript number holds it exactly. Absent: an older client.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub seat: Option<u64>,
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
    /// The map layers this person draws (spec §8 "Follow mode"), so a follower draws the same:
    /// one bit per toggle, wire.rs `LAYER_*`. Players' names are never in it: they stay each
    /// browser's own. Absent: an older client, and a follower keeps its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub layers: Option<u8>,
}

/// `Presence::layers` bits. Unknown bits are ignored, so a later toggle can take the next one.
pub const LAYER_TROOPERS: u8 = 1;
pub const LAYER_HEALTH: u8 = 1 << 1;
pub const LAYER_PINGS: u8 = 1 << 2;
pub const LAYER_CC: u8 = 1 << 3;
pub const LAYER_MOVEMENT: u8 = 1 << 4;
pub const LAYER_HEALS: u8 = 1 << 5;
pub const LAYER_CRATES: u8 = 1 << 6;

/// The largest seat: 2^53 - 1, JavaScript's largest exact integer.
pub const MAX_SEAT: u64 = (1 << 53) - 1;

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
    /// Whose vision this person's map draws and whether out-of-sight enemies show as ghosts,
    /// so a follower sees what the presenter sees (operator 2026-11-09: "when following, it
    /// should show the vision setting of the presenter"). Absent from older clients: a follower
    /// keeps its own.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub vision: Option<PlayerVision>,
    /// The death recap open on the map (a skull's card), so a follower opens the same one.
    /// Left out when none, as are the three below: presence is resent whole on every change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub skull_recap: Option<DeathRef>,
    /// The death recap last opened in the events list and still open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub event_recap: Option<DeathRef>,
    /// The hero whose build the top bar has open (the single-hero dropdown).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub inspect: Option<SlotRef>,
    /// Every build open: All builds, or Tab held.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub all_builds: bool,
    /// Which of Effects and Build order is open in the hero's build `inspect` names (operator
    /// 2026-11-11). Left out when neither.
    /// A variant this build doesn't know (a newer client's) reads as none.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_popover")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub build_popover: Option<BuildPopover>,
    /// The events list's filter chips that are on, a bit each in `view_state::EVENT_GROUPS`
    /// order (operator 2026-11-11). Left out when none. Unknown bits are ignored: past 16 they
    /// are dropped here, and anything but a whole number reads as none, so a newer client's
    /// presence still parses (an older server after a rollback).
    #[serde(default, skip_serializing_if = "is_zero", deserialize_with = "lenient_bits")]
    #[cfg_attr(feature = "ts", ts(as = "Option<u16>", optional))]
    pub event_filters: u16,
    /// The events list's search, at most `MAX_EVENT_SEARCH` bytes, no control characters.
    /// Left out when empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub event_search: Option<String>,
    /// Where the death recap on the map (`skull_recap`) sits, once moved (#35): left out while
    /// it is where it opens. A shape this build doesn't read (a newer client's) is none.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_place")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub skull_place: Option<PanelPlace>,
    /// The hero panels open from the map's tokens (#37), back to front, each with its place, at
    /// most `MAX_HERO_PANELS`. Sent whenever playback is, `[]` for none: left out means an
    /// older client, whose follower keeps its own. A list this build doesn't read is left out;
    /// entries past the bounds are dropped or clipped (`lenient_panels`), not the frame.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "lenient_panels")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub hero_panels: Option<Vec<HeroPanel>>,
}

/// Where a panel sits in the board pane (the map's box), so a screen of another size keeps the
/// layout: from the pane's nearer edge on each axis, to the panel's edge on that side, in
/// `PLACE_SCALE`ths of the pane's width (`x`) and height (`y`). Each screen clamps it so it
/// stays in the pane and off its own controls.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelPlace {
    pub x: u16,
    pub y: u16,
    /// From the right edge (else the left).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub right: bool,
    /// From the bottom edge (else the top).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub bottom: bool,
}

impl PanelPlace {
    pub fn is_valid(&self) -> bool {
        self.x <= PLACE_SCALE && self.y <= PLACE_SCALE
    }
    /// The place, at the pane's edge on an axis it is past.
    fn clipped(self) -> Self {
        Self { x: self.x.min(PLACE_SCALE), y: self.y.min(PLACE_SCALE), ..self }
    }
}

/// `PanelPlace` units in a pane's width or height.
pub const PLACE_SCALE: u16 = 10_000;

/// One hero panel open from the map (#37): whose, and where (none: where it opened).
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeroPanel {
    pub team: mapcro_schema::Team,
    pub slot: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub at: Option<PanelPlace>,
}

/// Hero panels presence carries: every hero's in a 6v6 match.
pub const MAX_HERO_PANELS: usize = 12;

/// `skull_place`: a place this build doesn't read is none; one past the pane is clipped to its
/// edge (a newer client's wider bound costs the place, not the whole presence).
fn lenient_place<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<PanelPlace>, D::Error> {
    Ok(match Option::<Lenient<PanelPlace>>::deserialize(d)? {
        Some(Lenient::Known(p)) => Some(p.clipped()),
        _ => None,
    })
}

/// `hero_panels`: a list this build doesn't read is none (left out: the follower keeps its own).
/// Within a list, an entry this build doesn't read, or whose slot is past `MAX_SLOT`, is dropped;
/// a place it doesn't read is none and one past the pane is clipped; a slot's second entry is
/// dropped; past `MAX_HERO_PANELS`, the back ones are (as the client's `heroPanelsToWire`). So a
/// newer client's presence is relayed, not refused, by an older server.
fn lenient_panels<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Vec<HeroPanel>>, D::Error> {
    #[derive(Deserialize)]
    struct Loose {
        team: mapcro_schema::Team,
        slot: u8,
        #[serde(default)]
        at: Option<Lenient<PanelPlace>>,
    }
    Ok(match Option::<Lenient<Vec<Lenient<Loose>>>>::deserialize(d)? {
        Some(Lenient::Known(list)) => {
            let mut out: Vec<HeroPanel> = Vec::new();
            for h in list {
                let Lenient::Known(h) = h else { continue };
                if h.slot >= MAX_SLOT || out.iter().any(|o| (o.team, o.slot) == (h.team, h.slot)) {
                    continue;
                }
                let at = match h.at {
                    Some(Lenient::Known(p)) => Some(p.clipped()),
                    _ => None,
                };
                out.push(HeroPanel { team: h.team, slot: h.slot, at });
            }
            let extra = out.len().saturating_sub(MAX_HERO_PANELS);
            out.drain(..extra);
            Some(out)
        }
        _ => None,
    })
}

fn is_zero(n: &u16) -> bool {
    *n == 0
}

/// A value read leniently: what this build knows, or anything else (ignored).
#[derive(Deserialize)]
#[serde(untagged)]
enum Lenient<T> {
    Known(T),
    Other(serde::de::IgnoredAny),
}

/// `event_filters`: the low 16 bits of a whole number; anything else is none.
fn lenient_bits<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    Ok(match Lenient::<u64>::deserialize(d)? {
        Lenient::Known(n) => (n & u64::from(u16::MAX)) as u16,
        Lenient::Other(_) => 0,
    })
}

/// `build_popover`: a variant this build doesn't know is none.
fn lenient_popover<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<BuildPopover>, D::Error> {
    Ok(match Option::<Lenient<BuildPopover>>::deserialize(d)? {
        Some(Lenient::Known(p)) => Some(p),
        _ => None,
    })
}

/// The hero build's two popovers (BuildColumn.tsx); they are one `<details name>` group, so at
/// most one is open.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildPopover {
    Effects,
    Order,
}

/// The events search a presence may carry (bytes).
pub const MAX_EVENT_SEARCH: usize = 64;

/// Text a person typed that presence carries: short, and no control characters.
pub fn text_ok(s: &str, max: usize) -> bool {
    s.len() <= max && !s.chars().any(char::is_control)
}

/// A roster slot in the open match, as presence carries it.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotRef {
    pub team: mapcro_schema::Team,
    pub slot: u8,
}

/// One hero's death in the open match: its slot and the match second it died (a `deaths` entry).
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeathRef {
    pub team: mapcro_schema::Team,
    pub slot: u8,
    pub t: u32,
}

/// Slots in presence are under this (six a team; room to spare, as a bad one closes the socket).
pub const MAX_SLOT: u8 = 16;

/// Player's Vision control (spec §6b "Vision"), as presence carries it.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayerVision {
    /// The team whose view the map draws; none: every hero ("All").
    pub team: Option<mapcro_schema::Team>,
    /// "Show last seen location": an enemy out of sight is a ghost where last seen.
    pub last_seen: bool,
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
            && self.seat.is_none_or(|s| s <= MAX_SEAT)
            && self.hover.as_ref().is_none_or(|h| h.len() <= MAX_HOVER && h.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-')))
            && self.playback.as_ref().is_none_or(|b| {
                let clock = |t: f32| t.is_finite() && (0.0..=86_400.0).contains(&t);
                clock(b.t)
                    && b.speed.is_finite()
                    && (0.0..=16.0).contains(&b.speed)
                    && b.match_id < 1_000_000_000_000
                    && b.jump.as_ref().is_none_or(|j| clock(j.at) && j.key.len() <= MAX_JUMP_KEY && !j.key.chars().any(char::is_control))
                    && [b.skull_recap, b.event_recap].iter().flatten().all(|d| d.slot < MAX_SLOT && d.t <= 86_400)
                    && b.inspect.is_none_or(|s| s.slot < MAX_SLOT)
                    && b.event_search.as_deref().is_none_or(|q| text_ok(q, MAX_EVENT_SEARCH))
                    && b.skull_place.as_ref().is_none_or(PanelPlace::is_valid)
                    && b.hero_panels.as_deref().is_none_or(|list| {
                        list.len() <= MAX_HERO_PANELS
                            && list.iter().all(|h| h.slot < MAX_SLOT && h.at.as_ref().is_none_or(PanelPlace::is_valid))
                            && list.iter().enumerate().all(|(i, h)| list[..i].iter().all(|o| (o.team, o.slot) != (h.team, h.slot)))
                    })
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
    fn a_seat_is_optional_and_a_javascript_number() {
        // An older client sends none; it parses as none and is left out again.
        let old: Presence = serde_json::from_str(&serde_json::to_string(&Presence::default()).expect("json")).expect("old");
        assert_eq!(old.seat, None);
        assert!(!serde_json::to_string(&old).expect("json").contains("seat"));
        let with = |s: u64| Presence { seat: Some(s), ..Presence::default() };
        assert!(with(0).is_valid());
        assert!(with(MAX_SEAT).is_valid());
        assert!(!with(MAX_SEAT + 1).is_valid(), "a JavaScript number would read it as another");
        assert_eq!(MAX_SEAT, 9_007_199_254_740_991, "Number.MAX_SAFE_INTEGER; web/src/core/seat.ts says the same");
        let back: Presence = serde_json::from_str(&serde_json::to_string(&with(MAX_SEAT)).expect("json")).expect("parse");
        assert_eq!(back.seat, Some(MAX_SEAT));
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
            playback: Some(Playback { player: true, match_id: 1, t: 10.0, playing: false, speed: 1.0, jump: Some(Jump { key: key.to_owned(), at }), ..playback() }),
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

    fn playback() -> Playback {
        Playback { player: true, match_id: 1, t: 10.0, playing: false, speed: 1.0, jump: None, vision: None, skull_recap: None, event_recap: None, inspect: None, all_builds: false, build_popover: None, event_filters: 0, event_search: None, skull_place: None, hero_panels: None }
    }

    #[test]
    fn panels_in_playback_are_bounded_and_left_out_when_closed() {
        use mapcro_schema::Team::{Amber, Sapphire};
        let with = |pb: Playback| Presence { playback: Some(pb), ..Default::default() };
        let death = |slot: u8, t: u32| Some(DeathRef { team: Sapphire, slot, t });
        assert!(with(Playback { skull_recap: death(5, 40), event_recap: death(0, 0), inspect: Some(SlotRef { team: Amber, slot: 2 }), all_builds: true, ..playback() }).is_valid());
        assert!(!with(Playback { skull_recap: death(MAX_SLOT, 40), ..playback() }).is_valid());
        assert!(!with(Playback { event_recap: death(1, 86_401), ..playback() }).is_valid());
        assert!(!with(Playback { inspect: Some(SlotRef { team: Amber, slot: 200 }), ..playback() }).is_valid());
        // The events search: bounded, and no control characters.
        let search = |q: &str| with(Playback { event_search: Some(q.to_owned()), ..playback() }).is_valid();
        assert!(search("haze ult") && search(&"é".repeat(MAX_EVENT_SEARCH / 2)));
        assert!(!search(&"x".repeat(MAX_EVENT_SEARCH + 1)) && !search("a\nb") && !search("\u{7}"));
        assert!(with(Playback { build_popover: Some(BuildPopover::Order), event_filters: u16::MAX, ..playback() }).is_valid());
        // Closed panels and absent layers cost nothing on the wire; an older client parses.
        let json = serde_json::to_string(&with(playback())).expect("serialises");
        for k in ["skull_recap", "event_recap", "inspect", "all_builds", "layers", "build_popover", "event_filters", "event_search"] {
            assert!(!json.contains(k), "{k} in {json}");
        }
        let open = Playback { skull_recap: death(3, 12), all_builds: true, build_popover: Some(BuildPopover::Effects), event_filters: 5, event_search: Some("urn".into()), ..playback() };
        let back: Playback = serde_json::from_str(&serde_json::to_string(&open).expect("serialises")).expect("parses");
        assert_eq!(back, open);
        let p = Presence { layers: Some(LAYER_TROOPERS | LAYER_CRATES), ..Default::default() };
        assert_eq!(serde_json::from_str::<Presence>(&serde_json::to_string(&p).expect("serialises")).expect("parses").layers, Some(0b100_0001));
    }

    /// Every hero's panel, each moved, and the death recap moved (#35, #37).
    fn all_panels() -> Playback {
        use mapcro_schema::Team::{Amber, Sapphire};
        let at = |i: u16| Some(PanelPlace { x: PLACE_SCALE - i, y: PLACE_SCALE, right: true, bottom: true });
        let hero_panels = [Amber, Sapphire].into_iter().flat_map(|team| (0..6u8).map(move |slot| HeroPanel { team, slot: slot + 10, at: at(u16::from(slot)) })).collect();
        Playback { skull_recap: Some(DeathRef { team: Amber, slot: 1, t: 86_400 }), skull_place: at(0), hero_panels: Some(hero_panels), ..playback() }
    }

    #[test]
    fn moved_panels_are_bounded_and_left_out_where_they_opened() {
        use mapcro_schema::Team::{Amber, Sapphire};
        let with = |pb: Playback| Presence { playback: Some(pb), ..Default::default() };
        let panels = |v: Vec<HeroPanel>| Playback { hero_panels: Some(v), ..playback() };
        let full = all_panels();
        let list = full.hero_panels.clone().expect("panels");
        assert_eq!(list.len(), MAX_HERO_PANELS);
        assert!(with(full.clone()).is_valid());
        // Built here (not parsed): one more, a place past the pane, a slot out of range, the
        // same hero twice.
        let mut more = list.clone();
        more.push(HeroPanel { team: Amber, slot: 0, at: None });
        assert!(!with(panels(more)).is_valid());
        let far = PanelPlace { x: PLACE_SCALE + 1, y: 0, right: false, bottom: false };
        assert!(!with(Playback { skull_place: Some(far), ..playback() }).is_valid());
        assert!(!with(Playback { skull_place: Some(PanelPlace { x: 0, y: PLACE_SCALE + 1, ..far }), ..playback() }).is_valid());
        assert!(!with(panels(vec![HeroPanel { team: Sapphire, slot: 0, at: Some(far) }])).is_valid());
        assert!(!with(panels(vec![HeroPanel { team: Sapphire, slot: MAX_SLOT, at: None }])).is_valid());
        let twice = HeroPanel { team: Sapphire, slot: 2, at: None };
        assert!(!with(panels(vec![twice, HeroPanel { at: Some(PanelPlace { x: 1, ..far }), ..twice }])).is_valid());
        assert!(with(panels(vec![twice, HeroPanel { team: Amber, ..twice }])).is_valid());
        // Where they opened costs nothing; none open is `[]`, an older client's none is left out.
        let json = serde_json::to_string(&with(panels(vec![twice]))).expect("serialises");
        assert!(!json.contains("skull_place") && !json.contains(r#""at""#), "{json}");
        assert!(serde_json::to_string(&with(panels(Vec::new()))).expect("serialises").contains(r#""hero_panels":[]"#));
        assert!(!serde_json::to_string(&with(playback())).expect("serialises").contains("hero_panels"));
        let left = PanelPlace { x: 120, y: 400, right: false, bottom: false };
        assert_eq!(serde_json::to_string(&left).expect("serialises"), r#"{"x":120,"y":400}"#);
        let back: Playback = serde_json::from_str(&serde_json::to_string(&full).expect("serialises")).expect("parses");
        assert_eq!(back, full);
    }

    #[test]
    fn a_full_set_of_panels_fits_in_a_frame_beside_the_largest_presence() {
        // The largest presence is_valid lets through: a full laser trail, the longest stroke,
        // the whole roster dragged, every objective picked, every panel open and moved.
        let at = WorldPos { x: -16_384, y: -16_384 };
        let p = Presence {
            name: "n".repeat(mapcro_schema::LIMITS.max_name),
            laser: vec![at; MAX_LASER_POINTS],
            laser_starts: (1..MAX_LASER_POINTS as u8).collect(),
            ink: Some(LiveInk { color: 15, points: vec![at; MAX_INK_POINTS] }),
            drag_group: vec![RecordId(u128::MAX); MAX_DRAG_GROUP],
            hover: Some("k".repeat(MAX_HOVER)),
            playback: Some(Playback { jump: Some(Jump { key: "k".repeat(MAX_JUMP_KEY), at: 86_400.0 }), event_search: Some("x".repeat(MAX_EVENT_SEARCH)), ..all_panels() }),
            ..Default::default()
        };
        assert!(p.is_valid());
        let frame = serde_json::to_string(&WireIn::Presence { state: Box::new(p) }).expect("serialises");
        // The server takes frames up to max_tx_bytes + 1024 (ws.rs MAX_FRAME).
        assert!(frame.len() <= mapcro_schema::LIMITS.max_tx_bytes, "{} bytes", frame.len());
        let panels = serde_json::to_string(&all_panels().hero_panels.expect("panels")).expect("serialises").len();
        assert!(panels < 1024, "{panels} bytes for every hero panel");
    }

    #[test]
    fn panels_from_a_newer_client_that_this_build_cannot_read_are_none() {
        let pb = |extra: &str| parsed(&frame_with(extra)).unwrap_or_else(|| panic!("parses: {extra}")).playback.expect("playback");
        assert_eq!(pb(r#","skull_place":{"x":5,"y":6,"bottom":true}"#).skull_place, Some(PanelPlace { x: 5, y: 6, right: false, bottom: true }));
        assert_eq!(pb(r#","hero_panels":[{"team":"Amber","slot":2,"at":{"x":1,"y":2},"z":3}]"#).hero_panels.map(|v| v.len()), Some(1));
        for v in ["null", "3", r#""a""#, r#"{"x":-1,"y":0}"#, r#"{"x":1}"#, "[]"] {
            assert_eq!(pb(&format!(r#","skull_place":{v}"#)).skull_place, None, "{v}");
        }
        // Not a list: left out, as an older client's (the follower keeps its own).
        for v in ["null", "3", r#"{"team":"Amber"}"#] {
            assert_eq!(pb(&format!(r#","hero_panels":{v}"#)).hero_panels, None, "{v}");
        }
        assert_eq!(pb("").hero_panels, None);
        assert_eq!(pb(r#","hero_panels":[]"#).hero_panels, Some(Vec::new()));
        // Entries it can't read are dropped, the rest kept.
        for v in [r#"[{"team":"Purple","slot":1}]"#, r#"[{"team":"Amber","slot":300}]"#, "[7]"] {
            assert_eq!(pb(&format!(r#","hero_panels":{v}"#)).hero_panels, Some(Vec::new()), "{v}");
        }
    }

    #[test]
    fn panels_past_this_builds_bounds_are_dropped_or_clipped_not_the_presence() {
        use mapcro_schema::Team::{Amber, Sapphire};
        // A newer client against an older server: a 13th panel, a place past the pane, a slot
        // past MAX_SLOT, a hero twice. The presence is still relayed, within the bounds.
        let panel = |team: &str, slot: u32, at: &str| format!(r#"{{"team":"{team}","slot":{slot}{at}}}"#);
        let mut list: Vec<String> = (0..7).map(|s| panel("Amber", s, "")).collect();
        list.extend((0..6).map(|s| panel("Sapphire", s, "")));
        list.push(panel("Sapphire", MAX_SLOT.into(), ""));
        list.push(panel("Amber", 1, r#","at":{"x":0,"y":0}"#));
        list[3] = panel("Amber", 3, r#","at":{"x":12000,"y":40000,"right":true}"#);
        list[4] = panel("Amber", 4, r#","at":{"x":-1,"y":0}"#);
        let frame = frame_with(&format!(r#","hero_panels":[{}],"skull_place":{{"x":10001,"y":3,"bottom":true}}"#, list.join(",")));
        let p = parsed(&frame).expect("parses");
        assert!(p.is_valid(), "relayed");
        let pb = p.playback.expect("playback");
        let got = pb.hero_panels.expect("panels");
        assert_eq!(got.len(), MAX_HERO_PANELS);
        // The front ones (the back one, Amber 0, dropped); Amber 1 once, where it first was.
        assert_eq!(got[0], HeroPanel { team: Amber, slot: 1, at: None });
        assert_eq!(got[2], HeroPanel { team: Amber, slot: 3, at: Some(PanelPlace { x: PLACE_SCALE, y: PLACE_SCALE, right: true, bottom: false }) });
        assert_eq!(got[3], HeroPanel { team: Amber, slot: 4, at: None });
        assert_eq!(got.last(), Some(&HeroPanel { team: Sapphire, slot: 5, at: None }));
        assert_eq!(pb.skull_place, Some(PanelPlace { x: PLACE_SCALE, y: 3, right: false, bottom: true }));
    }

    /// A presence frame as a client sends it, its playback's JSON ending in `extra` (raw JSON
    /// text, so it can hold what `serde_json` would never write).
    fn frame_with(extra: &str) -> String {
        let state = serde_json::to_string(&Presence { playback: Some(playback()), ..Default::default() }).expect("serialises");
        let (head, tail) = state.split_once(r#""speed":1.0"#).expect("speed in playback");
        format!(r#"{{"t":"presence","state":{head}"speed":1.0{extra}{tail}}}"#)
    }
    fn parsed(frame: &str) -> Option<Presence> {
        match serde_json::from_str::<WireIn>(frame) {
            Ok(WireIn::Presence { state }) => Some(*state),
            _ => None,
        }
    }

    #[test]
    fn a_search_the_client_clipped_parses_and_is_valid() {
        // What viewstate.ts `clipText(s, 64)` gives (web/test/view-state.test.ts has the same
        // table): cut by code point, a lone surrogate as U+FFFD.
        let x = |n: usize| "x".repeat(n);
        let cases = [
            x(61),                        // 61 x then an emoji: the emoji doesn't fit
            format!("{}😀", x(60)),       // it fits exactly
            format!("{}é", x(62)),        // two bytes at the end
            format!("{}\u{FFFD}", x(61)), // a lone high surrogate
            "😀".repeat(16),
            "ж".repeat(32),
        ];
        assert!(parsed(&frame_with("")).is_some_and(|p| p.is_valid()));
        for q in &cases {
            assert!(q.len() <= MAX_EVENT_SEARCH, "{q}");
            let frame = frame_with(&format!(r#","event_search":{}"#, serde_json::to_string(q).expect("json")));
            let state = parsed(&frame).unwrap_or_else(|| panic!("parses: {frame}"));
            assert!(state.is_valid(), "{q}");
            assert_eq!(state.playback.and_then(|b| b.event_search).as_deref(), Some(q.as_str()));
        }
        // What the old cut sent: half a pair, as JSON.stringify writes it. Unparseable, so the
        // server closes the socket as abuse.
        assert!(parsed(&frame_with(&format!(r#","event_search":"{}\ud83d""#, x(61)))).is_none());
    }

    #[test]
    fn unknown_filter_bits_and_popovers_from_a_newer_client_are_ignored() {
        let pb = |extra: &str| parsed(&frame_with(extra)).unwrap_or_else(|| panic!("parses: {extra}")).playback.expect("playback");
        // Bits past 16 are dropped; the ones that fit are kept (a follower ignores unknown ones).
        assert_eq!(pb(r#","event_filters":65541"#).event_filters, 5);
        assert_eq!(pb(r#","event_filters":4294967295"#).event_filters, u16::MAX);
        assert_eq!(pb(r#","event_filters":18446744073709551615"#).event_filters, u16::MAX);
        // Anything but a whole number is none.
        for v in ["-1", "1.5", r#""5""#, "null", "[1]", "{}"] {
            assert_eq!(pb(&format!(r#","event_filters":{v}"#)).event_filters, 0, "{v}");
        }
        // A popover this build doesn't know is none; the known ones still read.
        assert_eq!(pb(r#","build_popover":"order""#).build_popover, Some(BuildPopover::Order));
        assert_eq!(pb(r#","build_popover":"effects""#).build_popover, Some(BuildPopover::Effects));
        for v in [r#""stats""#, "null", "3", r#"{"a":1}"#] {
            assert_eq!(pb(&format!(r#","build_popover":{v}"#)).build_popover, None, "{v}");
        }
        // Still valid, and the bounds is_valid checks still hold beside them.
        assert!(parsed(&frame_with(r#","event_filters":131071,"build_popover":"stats""#)).expect("parses").is_valid());
        let long = format!(r#","event_filters":131071,"build_popover":"stats","event_search":"{}""#, "x".repeat(MAX_EVENT_SEARCH + 1));
        assert!(!parsed(&frame_with(&long)).expect("parses").is_valid());
    }

    #[test]
    fn vision_in_playback_is_optional_both_ways() {
        // An older client's playback has no vision: it still parses, as none.
        let old = r#"{"player":true,"match_id":1,"t":10.0,"playing":false,"speed":1.0}"#;
        let pb: Playback = serde_json::from_str(old).expect("old playback");
        assert_eq!(pb.vision, None);
        // A new one round-trips it, All as a null team.
        let new = r#"{"player":true,"match_id":1,"t":10.0,"playing":false,"speed":1.0,"vision":{"team":"Sapphire","last_seen":true}}"#;
        let pb: Playback = serde_json::from_str(new).expect("new playback");
        assert_eq!(pb.vision, Some(PlayerVision { team: Some(mapcro_schema::Team::Sapphire), last_seen: true }));
        let all: Playback = serde_json::from_str(&new.replace(r#""Sapphire""#, "null")).expect("all teams");
        assert_eq!(all.vision, Some(PlayerVision { team: None, last_seen: true }));
        assert_eq!(serde_json::from_str::<Playback>(&serde_json::to_string(&pb).expect("json")).expect("round trip"), pb);
    }
}
