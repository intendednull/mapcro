use crate::ids::{HeroId, ObjectiveKey, OrderKey, RecordId};
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayerState {
    pub scene: RecordId,
    pub slot: RecordId,
    pub pos: WorldPos,
    pub alive: bool,
    pub placed: bool,
}

impl PlayerState {
    /// Default spread: a row near each team's base.
    pub fn starting(scene: RecordId, slot: RecordId, team: Team, index: u8) -> Self {
        let x = -3000 + i32::from(index) * 1200;
        let y = match team {
            Team::Amber => -8000,
            Team::Sapphire => 8000,
        };
        PlayerState { scene, slot, pos: WorldPos { x, y }, alive: true, placed: true }
    }
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectiveState {
    pub scene: RecordId,
    pub key: ObjectiveKey,
    pub status: ObjectiveStatus,
}

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
    PlayerPos(WorldPos),
    PlayerAlive(bool),
    PlayerPlaced(bool),
    ObjectiveStatus(ObjectiveStatus),
    ArrowFrom(WorldPos),
    ArrowTo(WorldPos),
    ArrowTeam(Option<Team>),
    CalloutPos(WorldPos),
    CalloutText(String),
    NoteText(String),
}

/// The field a [`FieldValue`] writes, without its value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Field {
    Title,
    RosterName,
    RosterHero,
    SceneName,
    SceneOrder,
    PlayerPos,
    PlayerAlive,
    PlayerPlaced,
    ObjectiveStatus,
    ArrowFrom,
    ArrowTo,
    ArrowTeam,
    CalloutPos,
    CalloutText,
    NoteText,
}

impl Field {
    pub const ALL: [Field; 15] = [
        Field::Title,
        Field::RosterName,
        Field::RosterHero,
        Field::SceneName,
        Field::SceneOrder,
        Field::PlayerPos,
        Field::PlayerAlive,
        Field::PlayerPlaced,
        Field::ObjectiveStatus,
        Field::ArrowFrom,
        Field::ArrowTo,
        Field::ArrowTeam,
        Field::CalloutPos,
        Field::CalloutText,
        Field::NoteText,
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
            FieldValue::PlayerPos(_) => Field::PlayerPos,
            FieldValue::PlayerAlive(_) => Field::PlayerAlive,
            FieldValue::PlayerPlaced(_) => Field::PlayerPlaced,
            FieldValue::ObjectiveStatus(_) => Field::ObjectiveStatus,
            FieldValue::ArrowFrom(_) => Field::ArrowFrom,
            FieldValue::ArrowTo(_) => Field::ArrowTo,
            FieldValue::ArrowTeam(_) => Field::ArrowTeam,
            FieldValue::CalloutPos(_) => Field::CalloutPos,
            FieldValue::CalloutText(_) => Field::CalloutText,
            FieldValue::NoteText(_) => Field::NoteText,
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
            (Record::PlayerState(r), Field::PlayerPos) => V::PlayerPos(r.pos),
            (Record::PlayerState(r), Field::PlayerAlive) => V::PlayerAlive(r.alive),
            (Record::PlayerState(r), Field::PlayerPlaced) => V::PlayerPlaced(r.placed),
            (Record::ObjectiveState(r), Field::ObjectiveStatus) => V::ObjectiveStatus(r.status),
            (Record::Arrow(r), Field::ArrowFrom) => V::ArrowFrom(r.from),
            (Record::Arrow(r), Field::ArrowTo) => V::ArrowTo(r.to),
            (Record::Arrow(r), Field::ArrowTeam) => V::ArrowTeam(r.team),
            (Record::Callout(r), Field::CalloutPos) => V::CalloutPos(r.pos),
            (Record::Callout(r), Field::CalloutText) => V::CalloutText(r.text.clone()),
            (Record::Note(r), Field::NoteText) => V::NoteText(r.text.clone()),
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
            (Record::PlayerState(r), V::PlayerPos(v)) => r.pos = v,
            (Record::PlayerState(r), V::PlayerAlive(v)) => r.alive = v,
            (Record::PlayerState(r), V::PlayerPlaced(v)) => r.placed = v,
            (Record::ObjectiveState(r), V::ObjectiveStatus(v)) => r.status = v,
            (Record::Arrow(r), V::ArrowFrom(v)) => r.from = v,
            (Record::Arrow(r), V::ArrowTo(v)) => r.to = v,
            (Record::Arrow(r), V::ArrowTeam(v)) => r.team = v,
            (Record::Callout(r), V::CalloutPos(v)) => r.pos = v,
            (Record::Callout(r), V::CalloutText(v)) => r.text = v,
            (Record::Note(r), V::NoteText(v)) => r.text = v,
            _ => return false,
        }
        true
    }
}
