use crate::ids::{HeroId, LaneKey, ObjectiveKey, OrderKey, RecordId};
use serde::{Deserialize, Serialize};

pub const SLOTS_PER_TEAM: u8 = 6;

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Team {
    Amber,
    Sapphire,
}

/// A position in game world units, rounded to integers. Integers keep equality exact (so
/// `SetIf` comparisons are well defined) and identical across native and WASM.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorldPos {
    pub x: i32,
    pub y: i32,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ObjectiveStatus {
    Active,
    Destroyed,
    Hidden,
    /// A two-stage objective (the Patron) with its first stage down: the shield is gone and
    /// the core fights on. Other objectives never take it.
    Stage2,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoardMeta {
    pub title: String,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RosterSlot {
    pub team: Team,
    pub slot: u8,
    pub name: String,
    pub hero: Option<HeroId>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scene {
    pub name: String,
    pub order: OrderKey,
    /// The match clock this scene shows, in seconds (the HUD's top-bar timer).
    #[serde(default)]
    pub clock: Option<u32>,
    /// Where a scene saved from Player came from (spec §6b), so a later "resume from here" can
    /// open Player at that moment. Older scenes load without one.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub source: Option<SceneSource>,
    /// Player's live annotation layer (spec §6b): ink, arrows and comments drawn over playback
    /// live here until a scene is saved, and it's never listed among the scenes.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub live: bool,
    /// The scene this one nests under: scenes form a tree, and `order` orders siblings. `None`:
    /// top level. Must be a live scene and not this one or a descendant (checked on write); a
    /// parent deleted later resolves through its own parent. Older scenes load without one.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub parent: Option<RecordId>,
}

/// A scene's match moment (spec §6b).
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SceneSource {
    pub match_id: u64,
    /// Match seconds.
    pub t: u32,
    /// "replay" or "metadata".
    pub tier: String,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayerState {
    pub scene: RecordId,
    pub slot: RecordId,
    pub pos: WorldPos,
    pub alive: bool,
    pub placed: bool,
    /// Souls (net worth) shown under the portrait in the top bar. Team totals are summed, never
    /// stored, so they can't disagree with the players.
    #[serde(default)]
    pub souls: Option<u32>,
    /// Ultimate cooldown remaining, in percent (0 = ready, 100 = just used), drawn as the HUD's
    /// little circle under the portrait. `None`: not tracked in this scene.
    #[serde(default)]
    pub ult_cooldown: Option<u8>,
    /// Whether the team has vision on this hero. Without it the board shows a ghost at the
    /// last known position. Older records load as visible.
    #[serde(default = "visible_by_default")]
    pub visible: bool,
    /// Seconds until a dead hero respawns, as the coach sets it by hand (the game's timer
    /// depends on too much to compute). `None`: no timer shown. Older records load without one.
    /// Optional in TypeScript, so clients that never set it can leave it out.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub respawn: Option<u16>,
}

fn visible_by_default() -> bool {
    true
}

impl PlayerState {
    /// Default spread: a row near each team's base.
    pub fn starting(scene: RecordId, slot: RecordId, team: Team, index: u8) -> Self {
        let x = -3000 + i32::from(index) * 1200;
        let y = match team {
            Team::Amber => -8000,
            Team::Sapphire => 8000,
        };
        PlayerState { scene, slot, pos: WorldPos { x, y }, alive: true, placed: true, souls: None, ult_cooldown: None, visible: true, respawn: None }
    }
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectiveState {
    pub scene: RecordId,
    pub key: ObjectiveKey,
    pub status: ObjectiveStatus,
}

/// Where a lane's creep waves meet (the lane equilibrium), at most one per lane per scene.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Wave {
    pub scene: RecordId,
    pub lane: LaneKey,
    /// Position along the lane's zipline by arc length: 0 at the Amber end, 1000 at the
    /// Sapphire end. Independent of viewpoint and of small changes to the map's geometry.
    pub t: u16,
}

/// The largest `Wave::t`: the Sapphire end of the lane.
pub const WAVE_T_MAX: u16 = 1000;

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Arrow {
    pub scene: RecordId,
    pub from: WorldPos,
    pub to: WorldPos,
    pub team: Option<Team>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Callout {
    pub scene: RecordId,
    pub pos: WorldPos,
    pub text: String,
}

/// Freehand ink (the Draw tool). Drawn once and erased whole; never edited point by point, but
/// moved whole by `offset`.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stroke {
    pub scene: RecordId,
    /// World points, in drawing order (simplified by the client before sending).
    pub points: Vec<WorldPos>,
    /// Index into the presence palette.
    pub color: u8,
    /// Line width in tenths of a screen pixel at fit zoom.
    pub width: u8,
    /// Where the stroke has been moved to: added to every point when drawn. A move is one small
    /// last-writer-wins write, skipped if the stroke was deleted (not a delete and re-create,
    /// which brought deleted strokes back). Older strokes load unmoved.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<WorldPos>", optional))]
    pub offset: WorldPos,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub scene: RecordId,
    pub text: String,
}

/// Every record a board can hold.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Record {
    BoardMeta(BoardMeta),
    RosterSlot(RosterSlot),
    Scene(Scene),
    PlayerState(PlayerState),
    ObjectiveState(ObjectiveState),
    Arrow(Arrow),
    Callout(Callout),
    Note(Note),
    Stroke(Stroke),
    Wave(Wave),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RecordKind {
    BoardMeta,
    RosterSlot,
    Scene,
    PlayerState,
    ObjectiveState,
    Arrow,
    Callout,
    Note,
    Stroke,
    Wave,
}

/// A value for one mutable field. Each variant names its field, so a `Set` can never write a
/// field of the wrong type. Identity fields (a player state's scene and slot, a record's kind)
/// have no variant: they are immutable by construction.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FieldValue {
    Title(String),
    RosterName(String),
    RosterHero(Option<HeroId>),
    SceneName(String),
    SceneOrder(OrderKey),
    SceneClock(Option<u32>),
    SceneParent(Option<RecordId>),
    PlayerPos(WorldPos),
    PlayerAlive(bool),
    PlayerPlaced(bool),
    PlayerSouls(Option<u32>),
    PlayerUltCooldown(Option<u8>),
    PlayerVisible(bool),
    PlayerRespawn(Option<u16>),
    ObjectiveStatus(ObjectiveStatus),
    ArrowFrom(WorldPos),
    ArrowTo(WorldPos),
    ArrowTeam(Option<Team>),
    CalloutPos(WorldPos),
    CalloutText(String),
    NoteText(String),
    WavePos(u16),
    StrokeOffset(WorldPos),
}

/// The field a [`FieldValue`] writes, without its value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Field {
    Title,
    RosterName,
    RosterHero,
    SceneName,
    SceneOrder,
    SceneClock,
    SceneParent,
    PlayerPos,
    PlayerAlive,
    PlayerPlaced,
    PlayerSouls,
    PlayerUltCooldown,
    PlayerVisible,
    PlayerRespawn,
    ObjectiveStatus,
    ArrowFrom,
    ArrowTo,
    ArrowTeam,
    CalloutPos,
    CalloutText,
    NoteText,
    WavePos,
    StrokeOffset,
}

impl Field {
    pub const ALL: [Field; 23] = [
        Field::Title,
        Field::RosterName,
        Field::RosterHero,
        Field::SceneName,
        Field::SceneOrder,
        Field::SceneClock,
        Field::SceneParent,
        Field::PlayerPos,
        Field::PlayerAlive,
        Field::PlayerPlaced,
        Field::PlayerSouls,
        Field::PlayerUltCooldown,
        Field::PlayerVisible,
        Field::PlayerRespawn,
        Field::ObjectiveStatus,
        Field::ArrowFrom,
        Field::ArrowTo,
        Field::ArrowTeam,
        Field::CalloutPos,
        Field::CalloutText,
        Field::NoteText,
        Field::WavePos,
        Field::StrokeOffset,
    ];
}

impl FieldValue {
    pub fn field(&self) -> Field {
        match self {
            FieldValue::Title(_) => Field::Title,
            FieldValue::RosterName(_) => Field::RosterName,
            FieldValue::RosterHero(_) => Field::RosterHero,
            FieldValue::SceneName(_) => Field::SceneName,
            FieldValue::SceneOrder(_) => Field::SceneOrder,
            FieldValue::SceneClock(_) => Field::SceneClock,
            FieldValue::SceneParent(_) => Field::SceneParent,
            FieldValue::PlayerPos(_) => Field::PlayerPos,
            FieldValue::PlayerAlive(_) => Field::PlayerAlive,
            FieldValue::PlayerPlaced(_) => Field::PlayerPlaced,
            FieldValue::PlayerSouls(_) => Field::PlayerSouls,
            FieldValue::PlayerUltCooldown(_) => Field::PlayerUltCooldown,
            FieldValue::PlayerVisible(_) => Field::PlayerVisible,
            FieldValue::PlayerRespawn(_) => Field::PlayerRespawn,
            FieldValue::ObjectiveStatus(_) => Field::ObjectiveStatus,
            FieldValue::ArrowFrom(_) => Field::ArrowFrom,
            FieldValue::ArrowTo(_) => Field::ArrowTo,
            FieldValue::ArrowTeam(_) => Field::ArrowTeam,
            FieldValue::CalloutPos(_) => Field::CalloutPos,
            FieldValue::CalloutText(_) => Field::CalloutText,
            FieldValue::NoteText(_) => Field::NoteText,
            FieldValue::WavePos(_) => Field::WavePos,
            FieldValue::StrokeOffset(_) => Field::StrokeOffset,
        }
    }
}

impl Record {
    pub fn kind(&self) -> RecordKind {
        match self {
            Record::BoardMeta(_) => RecordKind::BoardMeta,
            Record::RosterSlot(_) => RecordKind::RosterSlot,
            Record::Scene(_) => RecordKind::Scene,
            Record::PlayerState(_) => RecordKind::PlayerState,
            Record::ObjectiveState(_) => RecordKind::ObjectiveState,
            Record::Arrow(_) => RecordKind::Arrow,
            Record::Callout(_) => RecordKind::Callout,
            Record::Note(_) => RecordKind::Note,
            Record::Stroke(_) => RecordKind::Stroke,
            Record::Wave(_) => RecordKind::Wave,
        }
    }

    /// The scene this record belongs to, for scene-scoped kinds.
    pub fn scene(&self) -> Option<RecordId> {
        match self {
            Record::PlayerState(r) => Some(r.scene),
            Record::ObjectiveState(r) => Some(r.scene),
            Record::Arrow(r) => Some(r.scene),
            Record::Callout(r) => Some(r.scene),
            Record::Note(r) => Some(r.scene),
            Record::Stroke(r) => Some(r.scene),
            Record::Wave(r) => Some(r.scene),
            Record::BoardMeta(_) | Record::RosterSlot(_) | Record::Scene(_) => None,
        }
    }

    /// Current value of `field`, or `None` if this kind has no such field.
    pub fn get(&self, field: Field) -> Option<FieldValue> {
        use FieldValue as V;
        Some(match (self, field) {
            (Record::BoardMeta(r), Field::Title) => V::Title(r.title.clone()),
            (Record::RosterSlot(r), Field::RosterName) => V::RosterName(r.name.clone()),
            (Record::RosterSlot(r), Field::RosterHero) => V::RosterHero(r.hero),
            (Record::Scene(r), Field::SceneName) => V::SceneName(r.name.clone()),
            (Record::Scene(r), Field::SceneOrder) => V::SceneOrder(r.order.clone()),
            (Record::Scene(r), Field::SceneClock) => V::SceneClock(r.clock),
            (Record::Scene(r), Field::SceneParent) => V::SceneParent(r.parent),
            (Record::PlayerState(r), Field::PlayerPos) => V::PlayerPos(r.pos),
            (Record::PlayerState(r), Field::PlayerAlive) => V::PlayerAlive(r.alive),
            (Record::PlayerState(r), Field::PlayerPlaced) => V::PlayerPlaced(r.placed),
            (Record::PlayerState(r), Field::PlayerSouls) => V::PlayerSouls(r.souls),
            (Record::PlayerState(r), Field::PlayerUltCooldown) => V::PlayerUltCooldown(r.ult_cooldown),
            (Record::PlayerState(r), Field::PlayerVisible) => V::PlayerVisible(r.visible),
            (Record::PlayerState(r), Field::PlayerRespawn) => V::PlayerRespawn(r.respawn),
            (Record::ObjectiveState(r), Field::ObjectiveStatus) => V::ObjectiveStatus(r.status),
            (Record::Arrow(r), Field::ArrowFrom) => V::ArrowFrom(r.from),
            (Record::Arrow(r), Field::ArrowTo) => V::ArrowTo(r.to),
            (Record::Arrow(r), Field::ArrowTeam) => V::ArrowTeam(r.team),
            (Record::Callout(r), Field::CalloutPos) => V::CalloutPos(r.pos),
            (Record::Callout(r), Field::CalloutText) => V::CalloutText(r.text.clone()),
            (Record::Note(r), Field::NoteText) => V::NoteText(r.text.clone()),
            (Record::Wave(r), Field::WavePos) => V::WavePos(r.t),
            (Record::Stroke(r), Field::StrokeOffset) => V::StrokeOffset(r.offset),
            _ => return None,
        })
    }

    /// Write one field. Returns `false` (and changes nothing) if this kind has no such field.
    pub fn set(&mut self, value: FieldValue) -> bool {
        use FieldValue as V;
        match (self, value) {
            (Record::BoardMeta(r), V::Title(v)) => r.title = v,
            (Record::RosterSlot(r), V::RosterName(v)) => r.name = v,
            (Record::RosterSlot(r), V::RosterHero(v)) => r.hero = v,
            (Record::Scene(r), V::SceneName(v)) => r.name = v,
            (Record::Scene(r), V::SceneOrder(v)) => r.order = v,
            (Record::Scene(r), V::SceneClock(v)) => r.clock = v,
            (Record::Scene(r), V::SceneParent(v)) => r.parent = v,
            (Record::PlayerState(r), V::PlayerPos(v)) => r.pos = v,
            (Record::PlayerState(r), V::PlayerAlive(v)) => r.alive = v,
            (Record::PlayerState(r), V::PlayerPlaced(v)) => r.placed = v,
            (Record::PlayerState(r), V::PlayerSouls(v)) => r.souls = v,
            (Record::PlayerState(r), V::PlayerUltCooldown(v)) => r.ult_cooldown = v,
            (Record::PlayerState(r), V::PlayerVisible(v)) => r.visible = v,
            (Record::PlayerState(r), V::PlayerRespawn(v)) => r.respawn = v,
            (Record::ObjectiveState(r), V::ObjectiveStatus(v)) => r.status = v,
            (Record::Arrow(r), V::ArrowFrom(v)) => r.from = v,
            (Record::Arrow(r), V::ArrowTo(v)) => r.to = v,
            (Record::Arrow(r), V::ArrowTeam(v)) => r.team = v,
            (Record::Callout(r), V::CalloutPos(v)) => r.pos = v,
            (Record::Callout(r), V::CalloutText(v)) => r.text = v,
            (Record::Note(r), V::NoteText(v)) => r.text = v,
            (Record::Wave(r), V::WavePos(v)) => r.t = v,
            (Record::Stroke(r), V::StrokeOffset(v)) => r.offset = v,
            _ => return false,
        }
        true
    }
}
