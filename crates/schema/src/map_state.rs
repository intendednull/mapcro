//! The map-state registry (docs/specs/map-state.md §4.2): one row per stored `MapState` field,
//! and the generic storage every row uses.
//!
//! A hero's, marker's, lane's or scene's record holds a `more` map from row key to value. One
//! field value, `FieldValue::More`, sets or clears one key, so a new field needs no new struct
//! member, `Field`, `FieldValue` or validation arm: only its row here.
//!
//! **Rows are append-only** (spec §4.3). A stored board, its log and its files outlive the build
//! that wrote them, and a cold load replays every logged transaction through these checks. So a
//! row is never removed or reordered, and its bounds only widen; a dead row becomes
//! [`Status::Retired`]. A new row lands as [`Status::Ahead`], so the build that reads it is
//! deployed before any build writes it. `rows.lock` (the rows of the last deployed build) and
//! the test below enforce both.
//!
//! **Reading and writing are checked apart.** Validation (`validate.rs`) reads every row there
//! has ever been, because a stored base and its log must always load. [`Admit`] is what a build
//! lets in from outside: a client's transaction or a board file that carries an `Ahead` row, or
//! a `SceneState` while that kind is `Ahead`, is refused there, so nothing reaches storage that
//! the build before this reader could not load after a rollback.

use crate::records::{FieldValue, Record, WorldPos};
use crate::validate::{LIMITS, Reject, check_line, check_pos};
use crate::{Op, Tx};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// What a row's value belongs to, and so which record holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Entity {
    /// A hero in a scene: `PlayerState`.
    Hero,
    /// A marker in a scene: `ObjectiveState`.
    Marker,
    /// A lane in a scene: `Wave`.
    Lane,
    /// The scene itself (match-wide values): `SceneState`.
    Scene,
}

/// A row's type and bounds. Closed: one validator per kind. No floats (records are `Eq`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Bool,
    /// An integer in `min..=max`. A choice is an `Int` with a small range.
    Int { min: i64, max: i64 },
    /// One line of at most `max` characters.
    Text { max: usize },
    /// A place on the map.
    Pos,
    /// A packed list of at most `len` integers, each in `min..=max`. What the integers mean is
    /// the client's (its pack and unpack for the row); the server checks length and range.
    Ints { len: usize, min: i64, max: i64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Read and validated, but nothing writes it yet: its reader is being deployed.
    Ahead,
    Live,
    /// No longer written. Still read and validated: stored boards hold it.
    Retired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Row {
    pub key: &'static str,
    pub entity: Entity,
    pub kind: Kind,
    pub status: Status,
}

/// JavaScript's largest exact integer: every bound stays within it, so a value survives the
/// browser's JSON.
pub const MAX_SAFE_INT: i64 = (1 << 53) - 1;

const ID: i64 = u32::MAX as i64;

/// A row whose reader is deployed (it is in `rows.lock`) and that this build writes.
const fn row(key: &'static str, entity: Entity, kind: Kind) -> Row {
    Row { key, entity, kind, status: Status::Live }
}

/// A new row: read by this build, written by none until this build is deployed and locked.
// Unused while every row is live: a new row lands with it (spec §4.3).
#[allow(dead_code)]
const fn ahead(key: &'static str, entity: Entity, kind: Kind) -> Row {
    Row { key, entity, kind, status: Status::Ahead }
}

/// Every row there has ever been, in the order they were added. Append only (see the module).
pub const ROWS: &[Row] = &[
    // Per-scene identity (spec §2, D2): the scene's own hero and name win over the roster's.
    row("hero", Entity::Hero, Kind::Int { min: 0, max: ID }),
    row("name", Entity::Hero, Kind::Text { max: LIMITS.max_name }),
    // What the snapshot holds (spec §4.5): the registry's length when it was taken, and one
    // flag per captured feature.
    row("rows", Entity::Scene, Kind::Int { min: 0, max: u16::MAX as i64 }),
    row("has_builds", Entity::Scene, Kind::Bool),
    // The match's patch (its build number): which stat table and tooltips the builds read.
    row("build", Entity::Scene, Kind::Int { min: 0, max: ID }),
    // Builds, the tracer (spec §8, phase 2). Packed lists; the client owns their layout.
    row("items", Entity::Hero, Kind::Ints { len: 128, min: -1, max: ID }),
    row("abilities", Entity::Hero, Kind::Ints { len: 48, min: -1, max: ID }),
    row("build_order", Entity::Hero, Kind::Ints { len: 600, min: -1, max: ID }),
    row("level", Entity::Hero, Kind::Int { min: 0, max: 1000 }),
    row("health", Entity::Hero, Kind::Int { min: 0, max: 100 }),
    row("pickups", Entity::Hero, Kind::Ints { len: 16, min: -1_000_000_000, max: 1_000_000_000 }),
    // The rest of the build column (phase 2 designed it after the rows above shipped): the
    // scoreboard's kills, deaths and assists, and the recorded max health. Their reader was
    // deployed as 1dcbd31 (store v9); written from store v10. A scene saved between the two
    // shows "—" for them until Retake.
    row("kills", Entity::Hero, Kind::Int { min: 0, max: 100_000 }),
    row("deaths", Entity::Hero, Kind::Int { min: 0, max: 100_000 }),
    row("assists", Entity::Hero, Kind::Int { min: 0, max: 100_000 }),
    row("max_health", Entity::Hero, Kind::Int { min: 0, max: 10_000_000 }),
];

/// `SceneState`'s own status: the record kind is gated as a row is. Its reader ships a release
/// before anything creates one; the writer release makes it `Live` (spec §4.3). A test holds it
/// `Ahead` until `rows.lock` shows a deployed build that reads it.
pub const SCENE_STATE: Status = Status::Live;

/// Whether a submitted `SetIf` on a registry value that the record has no room for is admitted
/// (and skipped: review F4) or refused (`Ahead`). Gated like a row, because it is one more
/// thing a log may hold: the reader deployed as store v8 refuses such a transaction when it
/// replays a log, so the board would not load after a rollback to it. The build deployed as
/// store v9 (1dcbd31) reads it (skips it on replay, `apply_tx`), so it is `Live` from store
/// v10, whose step sets the floor to 9 (docs/deploy.md).
pub const UNFIT_UNDO: Status = Status::Live;

/// What may come in from outside, as opposed to what is read (spec §4.3): the check at
/// admission, on a client's transaction (`Authority::submit`) and on a board file's records
/// (`import_records`). Never on a stored base or a log being replayed, which hold whatever was
/// once admitted and must load.
///
/// While a row is [`Status::Ahead`], nothing that carries it is let in: a `FieldValue::More`
/// naming it (a clear included: the value is in the log either way) or a record created with it
/// in its `more`. Nor is a `SceneState` while [`SCENE_STATE`] is `Ahead`. A build from before the
/// reader can't parse either, and drops a `more` it doesn't know, so storing one would break the
/// board on a rollback.
#[derive(Clone, Copy, Debug)]
pub struct Admit {
    /// A row's status.
    pub row: fn(RowId) -> Status,
    /// `SceneState`'s.
    pub scene_state: Status,
    /// [`UNFIT_UNDO`]'s: asked by `apply_tx_admitted`, not by [`Admit::tx`] (whether the value
    /// fits depends on the board).
    pub unfit_undo: Status,
}

impl Admit {
    /// This build's: each row by its own status, and [`SCENE_STATE`]. What the server uses.
    pub const DEPLOYED: Admit = Admit { row: |r| r.row().status, scene_state: SCENE_STATE, unfit_undo: UNFIT_UNDO };
    /// Everything this build reads, as the writer release will admit it. For the simulation and
    /// tests, which exercise sync and undo of the rows before anything may write them.
    pub const READS: Admit = Admit { row: |_| Status::Live, scene_state: Status::Live, unfit_undo: Status::Live };

    fn value(&self, v: &FieldValue) -> Result<(), Reject> {
        match v {
            FieldValue::More { key, .. } if (self.row)(*key) == Status::Ahead => Err(Reject::WrongField),
            _ => Ok(()),
        }
    }

    /// Whether `record` may be created or imported now.
    pub fn record(&self, record: &Record) -> Result<(), Reject> {
        if matches!(record, Record::SceneState(_)) && self.scene_state == Status::Ahead {
            return Err(Reject::Immutable);
        }
        match record.more() {
            Some((_, more)) if more.iter().any(|(key, _)| (self.row)(key) == Status::Ahead) => Err(Reject::WrongField),
            _ => Ok(()),
        }
    }

    /// Whether `tx` may be submitted now. Says nothing about whether it is valid.
    pub fn tx(&self, tx: &Tx) -> Result<(), Reject> {
        tx.ops.iter().try_for_each(|op| match op {
            Op::Create { record, .. } => self.record(record),
            Op::Set { value, .. } => self.value(value),
            Op::SetIf { expect, value, .. } => self.value(expect).and_then(|()| self.value(value)),
            Op::Delete { .. } | Op::Restore { .. } => Ok(()),
        })
    }
}

/// The registry as a TypeScript module, `web/src/gen/rows.ts` (`just ts` writes it): the
/// client's row table (spec §4.2). Capture writes the rows that are not `ahead`; the readers
/// and the round-trip property iterate it.
/// How many rows this build may write: the index of the first one still `Ahead` (rows go live
/// in order, which the lock test holds). A board file says this as its `rows`, and the client's
/// capture as a snapshot's watermark: the rows a reader must know to read what this build makes.
/// Not `ROWS.len()`, which counts rows this build only reads: the reader release a rollback
/// goes to has fewer, and would refuse every file as newer (review of 6a0d391, F1).
pub fn written_rows() -> usize {
    ROWS.iter().position(|r| r.status == Status::Ahead).unwrap_or(ROWS.len())
}

pub fn rows_ts() -> String {
    rows_ts_of(ROWS)
}

fn rows_ts_of(rows: &[Row]) -> String {
    use std::fmt::Write as _;
    let status = |s: Status| match s {
        Status::Ahead => "ahead",
        Status::Live => "live",
        Status::Retired => "retired",
    };
    let mut out = String::from(
        "// Generated from crates/schema/src/map_state.rs `ROWS` by `just ts`. Do not edit.\n\n/** A row is read by every build that knows it; `ahead`: nothing writes it yet. */\nexport type RowStatus = \"ahead\" | \"live\" | \"retired\";\n\n/** Every map-state row, in registry order (`index`): what it belongs to, its kind and bounds. */\nexport const ROWS = {\n",
    );
    for (index, r) in rows.iter().enumerate() {
        let entity = match r.entity {
            Entity::Hero => "hero",
            Entity::Marker => "marker",
            Entity::Lane => "lane",
            Entity::Scene => "scene",
        };
        let kind = match r.kind {
            Kind::Bool => "kind: \"bool\"".to_owned(),
            Kind::Int { min, max } => format!("kind: \"int\", min: {min}, max: {max}"),
            Kind::Text { max } => format!("kind: \"text\", max: {max}"),
            Kind::Pos => "kind: \"pos\"".to_owned(),
            Kind::Ints { len, min, max } => format!("kind: \"ints\", len: {len}, min: {min}, max: {max}"),
        };
        let _ = writeln!(out, "  {}: {{ index: {index}, entity: \"{entity}\", {kind}, status: \"{}\" as RowStatus }},", r.key, status(r.status));
    }
    let _ = write!(out, "}} as const;\n\nexport type RowKey = keyof typeof ROWS;\n\n/** Whether a scene's state (`SceneState`) may be created yet. */\nexport const SCENE_STATE: RowStatus = \"{}\";\n", status(SCENE_STATE));
    out
}

#[cfg(all(test, feature = "ts"))]
mod rows_ts {
    use super::*;

    const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/src/gen/rows.ts");

    #[test]
    fn export_bindings_rows() {
        std::fs::write(PATH, rows_ts()).expect("write rows.ts");
    }
}

/// A row, by its place in [`ROWS`]. Only made from a key that exists, so holding one means the
/// row is known: an unknown key cannot be represented, and fails to parse.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, type = "string"))]
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RowId(u16);

impl RowId {
    pub fn of(key: &str) -> Option<RowId> {
        ROWS.iter().position(|r| r.key == key).map(|i| RowId(i as u16))
    }

    pub fn all() -> impl Iterator<Item = RowId> {
        (0..ROWS.len()).map(|i| RowId(i as u16))
    }

    pub fn row(self) -> &'static Row {
        &ROWS[usize::from(self.0)]
    }

    pub fn key(self) -> &'static str {
        self.row().key
    }
}

impl std::fmt::Debug for RowId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.key())
    }
}

impl Serialize for RowId {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.key())
    }
}

impl<'de> Deserialize<'de> for RowId {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Key;
        impl serde::de::Visitor<'_> for Key {
            type Value = RowId;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a map-state row key")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<RowId, E> {
                RowId::of(v).ok_or_else(|| E::custom("unknown map-state row key"))
            }
        }
        d.deserialize_str(Key)
    }
}

/// One stored value. Written bare in JSON (`true`, `12`, `"x"`, `[1,2]`, `{"x":1,"y":2}`): the
/// row says which it must be. `Ints` is tried before `Pos`, because a struct also reads from a
/// list, and `[1,2]` is a list.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MoreValue {
    Bool(bool),
    Int(#[cfg_attr(feature = "ts", ts(type = "number"))] i64),
    /// Boxed, like `Ints`: no spare capacity, so the heap estimate is what is held.
    Text(#[cfg_attr(feature = "ts", ts(type = "string"))] Box<str>),
    Ints(#[cfg_attr(feature = "ts", ts(type = "Array<number>"))] Box<[i64]>),
    Pos(WorldPos),
}

impl MoreValue {
    pub fn ints(v: impl Into<Box<[i64]>>) -> MoreValue {
        MoreValue::Ints(v.into())
    }

    /// Whether this value fits `row`: its kind, and within its bounds.
    pub(crate) fn check(&self, row: &Row) -> Result<(), Reject> {
        let within = |n: i64, min: i64, max: i64| if (min..=max).contains(&n) { Ok(()) } else { Err(Reject::OutOfBounds) };
        match (row.kind, self) {
            (Kind::Bool, MoreValue::Bool(_)) => Ok(()),
            (Kind::Int { min, max }, MoreValue::Int(n)) => within(*n, min, max),
            (Kind::Text { max }, MoreValue::Text(s)) => check_line(s, max),
            (Kind::Pos, MoreValue::Pos(p)) => check_pos(*p),
            (Kind::Ints { len, min, max }, MoreValue::Ints(v)) => {
                if v.len() > len {
                    return Err(Reject::OutOfBounds);
                }
                v.iter().try_for_each(|n| within(*n, min, max))
            }
            _ => Err(Reject::WrongField),
        }
    }

    /// The heap this value owns.
    fn heap_bytes(&self) -> usize {
        match self {
            MoreValue::Text(s) => s.len(),
            MoreValue::Ints(v) => std::mem::size_of_val::<[i64]>(v),
            MoreValue::Bool(_) | MoreValue::Int(_) | MoreValue::Pos(_) => 0,
        }
    }
}

/// A record's `more`: its registry values, by row. Kept in row order, so two replicas holding
/// the same values serialise the same bytes. An absent key is the row's default (or "not
/// captured": spec §4.5); a default is never stored.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct More(#[cfg_attr(feature = "ts", ts(as = "BTreeMap<String, MoreValue>"))] BTreeMap<RowId, MoreValue>);

impl More {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn get(&self, row: RowId) -> Option<&MoreValue> {
        self.0.get(&row)
    }

    pub fn iter(&self) -> impl Iterator<Item = (RowId, &MoreValue)> {
        self.0.iter().map(|(k, v)| (*k, v))
    }

    /// Set `row`, or clear it (`None`).
    pub fn put(&mut self, row: RowId, value: Option<MoreValue>) {
        match value {
            Some(v) => self.0.insert(row, v),
            None => self.0.remove(&row),
        };
    }

    /// This map's length as JSON, counted, not built.
    pub fn json_len(&self) -> usize {
        struct Count(usize);
        impl std::io::Write for Count {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0 += b.len();
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut n = Count(0);
        match serde_json::to_writer(&mut n, self) {
            Ok(()) => n.0,
            Err(_) => usize::MAX,
        }
    }

    /// Whether this map may be stored on a record of `entity`: every key is that entity's, every
    /// value fits its row, and the whole is within `LIMITS.max_more_bytes`.
    pub(crate) fn check(&self, entity: Entity) -> Result<(), Reject> {
        for (id, value) in self.iter() {
            if id.row().entity != entity {
                return Err(Reject::WrongField);
            }
            value.check(id.row())?;
        }
        self.check_size()
    }

    /// The size cap alone (the values are already checked): a transaction that creates a scene
    /// holds thirteen of these, and a record must always fit one op.
    pub(crate) fn check_size(&self) -> Result<(), Reject> {
        if !self.is_empty() && self.json_len() > LIMITS.max_more_bytes { Err(Reject::TxTooLarge) } else { Ok(()) }
    }

    /// The heap this map owns: its map nodes, counted whole (a node holds up to 11 entries and
    /// is allocated for the first), and each value's own.
    pub(crate) fn heap_bytes(&self) -> usize {
        const NODE: usize = 11 * std::mem::size_of::<(RowId, MoreValue)>() + 48;
        self.0.len().div_ceil(11) * NODE + self.0.values().map(MoreValue::heap_bytes).sum::<usize>()
    }
}

impl FromIterator<(RowId, MoreValue)> for More {
    fn from_iter<I: IntoIterator<Item = (RowId, MoreValue)>>(iter: I) -> Self {
        More(iter.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::{Callout, ObjectiveState, ObjectiveStatus, PlayerState, SceneState, Team, Wave};
    use crate::{ClientId, LaneKey, ObjectiveKey, RecordId, TxKind};
    use std::collections::BTreeSet;

    const LOCK: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/rows.lock");

    fn id(key: &str) -> RowId {
        RowId::of(key).unwrap_or_else(|| panic!("no row {key}"))
    }

    #[test]
    fn keys_are_unique_short_and_plain_and_bounds_survive_javascript() {
        let mut seen = BTreeSet::new();
        for r in ROWS {
            assert!(seen.insert(r.key), "{} twice", r.key);
            assert!((1..=24).contains(&r.key.len()) && r.key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'), "{}", r.key);
            match r.kind {
                Kind::Int { min, max } | Kind::Ints { min, max, .. } => {
                    assert!(min <= max && min >= -MAX_SAFE_INT && max <= MAX_SAFE_INT, "{}", r.key);
                }
                Kind::Text { max } => assert!(max > 0, "{}", r.key),
                Kind::Bool | Kind::Pos => {}
            }
        }
        // One record's lists, all full, stay within the heap a room budgets for it (`max_more_ints`).
        for entity in [Entity::Hero, Entity::Marker, Entity::Lane, Entity::Scene] {
            let ints: usize = ROWS.iter().filter(|r| r.entity == entity).map(|r| if let Kind::Ints { len, .. } = r.kind { len } else { 0 }).sum();
            assert!(ints <= LIMITS.max_more_ints, "{entity:?}: {ints} list entries");
        }
        assert!(ROWS.len() <= usize::from(u16::MAX));
        assert_eq!(RowId::all().count(), ROWS.len());
        assert!(RowId::all().all(|r| RowId::of(r.key()) == Some(r)));
        assert_eq!(RowId::of("no_such_row"), None);
    }

    /// The registry as `rows.lock` holds it: one line per row, `key entity kind bounds…`.
    fn lock_lines(rows: &[Row]) -> String {
        rows.iter()
            .map(|r| {
                let kind = match r.kind {
                    Kind::Bool => "bool".to_owned(),
                    Kind::Int { min, max } => format!("int {min} {max}"),
                    Kind::Text { max } => format!("text {max}"),
                    Kind::Pos => "pos".to_owned(),
                    Kind::Ints { len, min, max } => format!("ints {len} {min} {max}"),
                };
                format!("{} {:?} {kind}\n", r.key, r.entity).to_lowercase()
            })
            .collect()
    }

    /// Whether `now` reads everything `locked` allowed: the same kind, bounds no narrower.
    fn reads(now: Kind, locked: Kind) -> bool {
        match (now, locked) {
            (Kind::Bool, Kind::Bool) | (Kind::Pos, Kind::Pos) => true,
            (Kind::Int { min, max }, Kind::Int { min: lo, max: hi }) => min <= lo && max >= hi,
            (Kind::Text { max }, Kind::Text { max: m }) => max >= m,
            (Kind::Ints { len, min, max }, Kind::Ints { len: l, min: lo, max: hi }) => len >= l && min <= lo && max >= hi,
            _ => false,
        }
    }

    /// A line of `rows.lock`, as [`lock_lines`] writes it.
    fn parse(line: &str) -> (String, Entity, Kind) {
        let w: Vec<&str> = line.split(' ').collect();
        let n = |i: usize| -> i64 { w[i].parse().unwrap_or_else(|_| panic!("rows.lock: {line}")) };
        let entity = match w[1] {
            "hero" => Entity::Hero,
            "marker" => Entity::Marker,
            "lane" => Entity::Lane,
            "scene" => Entity::Scene,
            _ => panic!("rows.lock: {line}"),
        };
        let kind = match w[2] {
            "bool" => Kind::Bool,
            "pos" => Kind::Pos,
            "int" => Kind::Int { min: n(3), max: n(4) },
            "text" => Kind::Text { max: n(3) as usize },
            "ints" => Kind::Ints { len: n(3) as usize, min: n(4), max: n(5) },
            _ => panic!("rows.lock: {line}"),
        };
        (w[0].to_owned(), entity, kind)
    }

    /// What breaks the append-only rule between a deployed registry (`lock`) and `rows`.
    fn broken(lock: &str, rows: &[Row]) -> Vec<String> {
        let locked: Vec<_> = lock.lines().filter(|l| !l.starts_with('#') && !l.is_empty()).map(parse).collect();
        let mut out = Vec::new();
        for (i, (key, entity, kind)) in locked.iter().enumerate() {
            match rows.get(i) {
                None => out.push(format!("{key}: removed")),
                Some(r) if r.key != key => out.push(format!("{key}: moved or renamed (row {i} is {})", r.key)),
                Some(r) if r.entity != *entity => out.push(format!("{key}: entity changed")),
                Some(r) if !reads(r.kind, *kind) => out.push(format!("{key}: kind changed or bounds narrowed")),
                Some(_) => {}
            }
        }
        for r in rows.iter().skip(locked.len()) {
            if r.status != Status::Ahead {
                out.push(format!("{}: not deployed yet, so it must be Ahead", r.key));
            }
        }
        out
    }

    const LOCK_HEAD: &str = "# The map-state rows of the last deployed build (docs/specs/map-state.md §4.3).\n# Written by `just rows-lock` at each deploy; never by hand.\n";

    /// `just rows-lock`: record `rows` as deployed in the lock at `path`. The lock already
    /// there is the last deploy's, so `rows` must keep every promise it holds: checked first,
    /// and nothing is written if one is broken. (Writing first and checking the result against
    /// itself would bless a reordered or narrowed row: review of phase 1, F2.)
    fn relock(path: &std::path::Path, rows: &[Row]) -> Result<(), Vec<String>> {
        let deployed = std::fs::read_to_string(path).map_err(|e| vec![format!("{}: {e}", path.display())])?;
        let broken = broken(&deployed, rows);
        if !broken.is_empty() {
            return Err(broken);
        }
        std::fs::write(path, format!("{LOCK_HEAD}{}", lock_lines(rows))).map_err(|e| vec![format!("{}: {e}", path.display())])
    }

    /// Whether a deployed build reads `SceneState`, by its lock: one that knows a row of the
    /// scene's does (the record and its first rows shipped in one build).
    fn reads_scene_state(lock: &str) -> bool {
        lock.lines().filter(|l| !l.starts_with('#') && !l.is_empty()).any(|l| parse(l).1 == Entity::Scene)
    }

    /// Whether this run is `just rows-lock`'s, which rewrites the lock. The flag alone is not
    /// enough (a stray `MAPCRO_ROWS_LOCK=1 cargo test` would bless whatever tree it ran in):
    /// the recipe also names the commit it checked was clean, and that must be the commit this
    /// test finds checked out (`head`).
    fn lock_mode(flag: Option<&str>, commit: Option<&str>, head: impl FnOnce() -> Option<String>) -> Result<bool, String> {
        if flag.is_none() {
            return Ok(false);
        }
        let commit = commit.filter(|c| !c.is_empty()).ok_or("MAPCRO_ROWS_LOCK is set without MAPCRO_ROWS_LOCK_COMMIT: the lock is written by `just rows-lock` only")?;
        match head() {
            Some(head) if head == commit => Ok(true),
            Some(head) => Err(format!("MAPCRO_ROWS_LOCK_COMMIT is {commit}, and the tree is at {head}: run `just rows-lock`")),
            None => Err("can't read the checked-out commit (git rev-parse HEAD): run `just rows-lock` in the repository".into()),
        }
    }

    fn git_head() -> Option<String> {
        let out = std::process::Command::new("git").args(["rev-parse", "HEAD"]).current_dir(env!("CARGO_MANIFEST_DIR")).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned()).filter(|h| !h.is_empty())
    }

    #[test]
    fn the_clients_row_table_is_up_to_date_and_says_each_rows_status() {
        let ts = rows_ts();
        assert_eq!(std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/src/gen/rows.ts")).expect("web/src/gen/rows.ts"), ts, "stale: run `just ts`");
        assert!(ts.contains("  hero: { index: 0, entity: \"hero\", kind: \"int\", min: 0, max: 4294967295, status: \"live\" as RowStatus },"), "{ts}");
        assert!(ts.contains("  items: { index: 5, entity: \"hero\", kind: \"ints\", len: 128, min: -1, max: 4294967295, status: \"live\" as RowStatus },"));
        assert!(ts.contains("  name: { index: 1, entity: \"hero\", kind: \"text\", max: 24, status: \"live\" as RowStatus },"));
        assert!(ts.contains("  has_builds: { index: 3, entity: \"scene\", kind: \"bool\", status: \"live\" as RowStatus },"));
        assert!(ts.contains("  kills: { index: 11, entity: \"hero\", kind: \"int\", min: 0, max: 100000, status: \"live\" as RowStatus },"));
        // A row still ahead, or retired, says so: the client's capture stops at the first ahead one.
        let later = [Row { key: "a", entity: Entity::Lane, kind: Kind::Pos, status: Status::Ahead }, Row { key: "b", entity: Entity::Marker, kind: Kind::Bool, status: Status::Retired }];
        let ts_later = rows_ts_of(&later);
        assert!(ts_later.contains("  a: { index: 0, entity: \"lane\", kind: \"pos\", status: \"ahead\" as RowStatus },"), "{ts_later}");
        assert!(ts_later.contains("  b: { index: 1, entity: \"marker\", kind: \"bool\", status: \"retired\" as RowStatus },"), "{ts_later}");
        assert!(ts.ends_with("export const SCENE_STATE: RowStatus = \"live\";\n"));
        assert_eq!(ts.matches(" index: ").count(), ROWS.len());
        // Rows go live in order: the client's watermark is the first row still ahead, so a
        // written row after an ahead one would be captured and never read.
        let first_ahead = ROWS.iter().position(|r| r.status == Status::Ahead).unwrap_or(ROWS.len());
        assert!(ROWS[first_ahead..].iter().all(|r| r.status == Status::Ahead), "a row is written after one still ahead");
    }

    #[test]
    fn the_lock_is_rewritten_only_for_the_commit_the_recipe_checked() {
        let head = || Some("abc123".to_owned());
        assert_eq!(lock_mode(None, None, head), Ok(false));
        assert_eq!(lock_mode(None, Some("abc123"), head), Ok(false), "the commit alone asks for nothing");
        assert!(lock_mode(Some("1"), None, head).is_err(), "the flag alone is refused");
        assert!(lock_mode(Some("1"), Some(""), head).is_err());
        assert!(lock_mode(Some("1"), Some("def456"), head).is_err(), "another commit's token");
        assert!(lock_mode(Some("1"), Some("abc123"), || None).is_err(), "no repository to check it against");
        assert_eq!(lock_mode(Some("1"), Some("abc123"), head), Ok(true));
        // Outside a checkout (a copied tree, a tarball) there is no commit to name: nothing
        // locks there, and the tests still run.
        assert!(git_head().is_none_or(|h| h.len() >= 40 && h.chars().all(|c| c.is_ascii_hexdigit())));
    }

    #[test]
    fn rows_are_append_only_and_read_a_release_before_they_are_written() {
        let var = |name: &str| std::env::var(name).ok();
        let locking = lock_mode(var("MAPCRO_ROWS_LOCK").as_deref(), var("MAPCRO_ROWS_LOCK_COMMIT").as_deref(), git_head).unwrap_or_else(|why| panic!("rows.lock is not rewritten: {why}"));
        if locking {
            relock(std::path::Path::new(LOCK), ROWS).unwrap_or_else(|broken| panic!("rows.lock is not rewritten: this build breaks the last deployed one's rows: {broken:#?}"));
        }
        let lock = std::fs::read_to_string(LOCK).expect("crates/schema/rows.lock");
        assert_eq!(broken(&lock, ROWS), Vec::<String>::new(), "see map_state.rs: rows are append-only, and a new row is Ahead until `just rows-lock` has run at a deploy");
        assert!(SCENE_STATE == Status::Ahead || reads_scene_state(&lock), "SceneState's reader is not deployed yet (no row of the scene's is in rows.lock), so it must be Ahead");
    }

    /// A lock file of its own, holding `text`: `relock` is tried on it, never on the real one.
    fn scratch_lock(name: &str, text: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("mapcro-rows-lock-{}-{name}", std::process::id()));
        std::fs::write(&path, text).expect("scratch lock");
        path
    }

    #[test]
    fn locking_refuses_a_build_that_breaks_the_deployed_rows_and_leaves_the_lock_alone() {
        let rows = [
            Row { key: "a", entity: Entity::Hero, kind: Kind::Int { min: 0, max: 10 }, status: Status::Live },
            Row { key: "b", entity: Entity::Scene, kind: Kind::Ints { len: 4, min: -1, max: 9 }, status: Status::Ahead },
        ];
        let deployed = format!("{LOCK_HEAD}a hero int 0 10\nb scene ints 4 -1 9\n");
        let try_lock = |name: &str, rows: &[Row]| {
            let path = scratch_lock(name, &deployed);
            let result = relock(&path, rows);
            let after = std::fs::read_to_string(&path).expect("lock");
            std::fs::remove_file(&path).expect("remove");
            (result, after)
        };
        // Reordered, narrowed, removed, or another kind: refused, and the file is as it was.
        let reordered = [rows[1], rows[0]];
        assert_eq!(try_lock("reordered", &reordered), (Err(vec!["a: moved or renamed (row 0 is b)".to_owned(), "b: moved or renamed (row 1 is a)".to_owned()]), deployed.clone()));
        let mut narrowed = rows;
        narrowed[0].kind = Kind::Int { min: 0, max: 9 };
        assert_eq!(try_lock("narrowed", &narrowed), (Err(vec!["a: kind changed or bounds narrowed".to_owned()]), deployed.clone()));
        narrowed = rows;
        narrowed[1].kind = Kind::Ints { len: 3, min: -1, max: 9 };
        assert_eq!(try_lock("shorter", &narrowed), (Err(vec!["b: kind changed or bounds narrowed".to_owned()]), deployed.clone()));
        assert_eq!(try_lock("removed", &rows[..1]), (Err(vec!["b: removed".to_owned()]), deployed.clone()));
        // A row that was never deployed as Ahead can't be locked in as written.
        let mut skipped = rows.to_vec();
        skipped.push(Row { key: "c", entity: Entity::Hero, kind: Kind::Bool, status: Status::Live });
        assert_eq!(try_lock("skipped", &skipped), (Err(vec!["c: not deployed yet, so it must be Ahead".to_owned()]), deployed.clone()));
        // The same rows, widened rows and new Ahead rows lock: the file is rewritten to them.
        assert_eq!(try_lock("same", &rows), (Ok(()), deployed.clone()));
        let mut grown = rows.to_vec();
        grown[0].kind = Kind::Int { min: -1, max: 11 };
        grown.push(Row { key: "c", entity: Entity::Hero, kind: Kind::Bool, status: Status::Ahead });
        assert_eq!(try_lock("grown", &grown), (Ok(()), format!("{LOCK_HEAD}a hero int -1 11\nb scene ints 4 -1 9\nc hero bool\n")));
        // No lock to check against is not a licence: nothing is written.
        let missing = std::env::temp_dir().join(format!("mapcro-rows-lock-{}-missing", std::process::id()));
        assert!(relock(&missing, &rows).is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn a_lock_shows_whether_scene_state_is_read() {
        assert!(!reads_scene_state(LOCK_HEAD));
        assert!(!reads_scene_state("# header\na hero int 0 10\nd marker bool\ne lane pos\n"));
        assert!(reads_scene_state("# header\na hero int 0 10\nb scene ints 4 -1 9\n"));
    }

    #[test]
    fn the_lock_check_catches_each_way_to_break_a_deployed_row() {
        let rows = [
            Row { key: "a", entity: Entity::Hero, kind: Kind::Int { min: 0, max: 10 }, status: Status::Live },
            Row { key: "b", entity: Entity::Scene, kind: Kind::Ints { len: 4, min: -1, max: 9 }, status: Status::Retired },
            Row { key: "c", entity: Entity::Hero, kind: Kind::Text { max: 8 }, status: Status::Live },
            Row { key: "d", entity: Entity::Marker, kind: Kind::Bool, status: Status::Live },
            Row { key: "e", entity: Entity::Lane, kind: Kind::Pos, status: Status::Live },
        ];
        let lock = "# header\na hero int 0 10\nb scene ints 4 -1 9\nc hero text 8\nd marker bool\ne lane pos\n";
        assert_eq!(broken(lock, &rows), Vec::<String>::new());
        let with = |i: usize, change: &dyn Fn(&mut Row)| {
            let mut r = rows;
            change(&mut r[i]);
            broken(lock, &r)
        };
        // Widened bounds read everything the lock allowed.
        assert_eq!(with(0, &|r| r.kind = Kind::Int { min: -5, max: 11 }), Vec::<String>::new());
        assert_eq!(with(1, &|r| r.kind = Kind::Ints { len: 5, min: -2, max: 10 }), Vec::<String>::new());
        assert_eq!(with(2, &|r| r.kind = Kind::Text { max: 9 }), Vec::<String>::new());
        // Narrowed on any side, or another kind, entity or key: refused.
        for narrowed in [Kind::Int { min: 1, max: 10 }, Kind::Int { min: 0, max: 9 }, Kind::Bool] {
            assert_eq!(with(0, &|r| r.kind = narrowed), ["a: kind changed or bounds narrowed"]);
        }
        for narrowed in [Kind::Ints { len: 3, min: -1, max: 9 }, Kind::Ints { len: 4, min: 0, max: 9 }, Kind::Ints { len: 4, min: -1, max: 8 }] {
            assert_eq!(with(1, &|r| r.kind = narrowed), ["b: kind changed or bounds narrowed"]);
        }
        assert_eq!(with(2, &|r| r.kind = Kind::Text { max: 7 }), ["c: kind changed or bounds narrowed"]);
        assert_eq!(with(3, &|r| r.kind = Kind::Pos), ["d: kind changed or bounds narrowed"]);
        assert_eq!(with(4, &|r| r.kind = Kind::Bool), ["e: kind changed or bounds narrowed"]);
        assert_eq!(with(0, &|r| r.entity = Entity::Scene), ["a: entity changed"]);
        assert_eq!(with(0, &|r| r.key = "z"), ["a: moved or renamed (row 0 is z)"]);
        assert_eq!(broken(lock, &rows[..4]), ["e: removed"]);
        // A row past the lock has not been deployed: it may only be Ahead.
        let ahead = Row { key: "f", entity: Entity::Hero, kind: Kind::Bool, status: Status::Ahead };
        let mut more = rows.to_vec();
        more.push(ahead);
        assert_eq!(broken(lock, &more), Vec::<String>::new());
        more[5].status = Status::Live;
        assert_eq!(broken(lock, &more), ["f: not deployed yet, so it must be Ahead"]);
        more[5].status = Status::Retired;
        assert_eq!(broken(lock, &more), ["f: not deployed yet, so it must be Ahead"]);
    }

    /// The rows as first shipped (phase 1), spelled out, apart from the lock file: their keys,
    /// order and bounds. Later rows are the lock file's to hold.
    #[test]
    fn the_first_rows_are_as_they_shipped() {
        let shipped = "hero hero int 0 4294967295\nname hero text 24\nrows scene int 0 65535\nhas_builds scene bool\nbuild scene int 0 4294967295\n\
                       items hero ints 128 -1 4294967295\nabilities hero ints 48 -1 4294967295\nbuild_order hero ints 600 -1 4294967295\n\
                       level hero int 0 1000\nhealth hero int 0 100\npickups hero ints 16 -1000000000 1000000000\n";
        assert_eq!(broken(shipped, &ROWS[..11]), Vec::<String>::new());
        assert!(lock_lines(ROWS).starts_with(shipped), "{}", lock_lines(ROWS));
    }

    #[test]
    fn the_lock_file_format_round_trips_every_row() {
        let lines = lock_lines(ROWS);
        assert_eq!(lines.lines().count(), ROWS.len());
        for (line, r) in lines.lines().zip(ROWS) {
            assert_eq!(parse(line), (r.key.to_owned(), r.entity, r.kind));
        }
        assert_eq!(broken(&lines, ROWS).len(), 0);
    }

    #[test]
    fn a_value_is_written_bare_and_read_back_as_the_same_kind() {
        let cases = [
            (MoreValue::Bool(true), "true"),
            (MoreValue::Int(-7), "-7"),
            (MoreValue::Int(MAX_SAFE_INT), "9007199254740991"),
            (MoreValue::Text("mid \"x\"".into()), r#""mid \"x\"""#),
            (MoreValue::ints(vec![1, -2, 3]), "[1,-2,3]"),
            (MoreValue::ints(vec![1, 2]), "[1,2]"),
            (MoreValue::ints(vec![]), "[]"),
            (MoreValue::Pos(WorldPos { x: 1, y: -2 }), r#"{"x":1,"y":-2}"#),
        ];
        for (v, json) in cases {
            assert_eq!(serde_json::to_string(&v).expect("json"), json);
            assert_eq!(serde_json::from_str::<MoreValue>(json).expect("parses"), v, "{json}");
        }
        // Not a value at all: a fraction, null, a nested list, a list of fractions.
        for bad in ["1.5", "null", "[[1]]", "[1.5]", r#"{"x":1}"#, "18446744073709551616"] {
            assert!(serde_json::from_str::<MoreValue>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_map_is_written_in_row_order_and_an_unknown_key_does_not_parse() {
        let more: More = [(id("name"), MoreValue::Text("x".into())), (id("hero"), MoreValue::Int(7))].into_iter().collect();
        let json = r#"{"hero":7,"name":"x"}"#;
        assert_eq!(serde_json::to_string(&more).expect("json"), json);
        assert_eq!(more.json_len(), json.len());
        assert_eq!(serde_json::from_str::<More>(r#"{"name":"x","hero":7}"#).expect("any order"), more);
        assert_eq!(serde_json::to_string(&More::default()).expect("json"), "{}");
        assert!(serde_json::from_str::<More>(r#"{"no_such_row":1}"#).is_err());
        assert!(serde_json::from_str::<RowId>(r#""no_such_row""#).is_err());
        let not_a_name = serde_json::from_str::<RowId>("0").expect_err("a key is its name, never its index");
        assert!(not_a_name.to_string().contains("a map-state row key"), "{not_a_name}");
        assert!(serde_json::from_str::<RowId>(r#""no_such_row""#).expect_err("unknown").to_string().contains("unknown map-state row key"));
        assert_eq!(serde_json::to_string(&id("hero")).expect("json"), r#""hero""#);
        assert_eq!(format!("{:?}", id("hero")), "hero");
    }

    #[test]
    fn each_kind_checks_its_own_bounds() {
        let row = |kind| Row { key: "t", entity: Entity::Hero, kind, status: Status::Live };
        let int = row(Kind::Int { min: -2, max: 5 });
        assert_eq!(MoreValue::Int(-2).check(&int), Ok(()));
        assert_eq!(MoreValue::Int(5).check(&int), Ok(()));
        assert_eq!(MoreValue::Int(-3).check(&int), Err(Reject::OutOfBounds));
        assert_eq!(MoreValue::Int(6).check(&int), Err(Reject::OutOfBounds));
        let text = row(Kind::Text { max: 3 });
        assert_eq!(MoreValue::Text("äbc".into()).check(&text), Ok(()));
        assert_eq!(MoreValue::Text("abcd".into()).check(&text), Err(Reject::TextTooLong));
        assert_eq!(MoreValue::Text("a\nb".into()).check(&text), Err(Reject::BadText));
        assert_eq!(MoreValue::Text("a\u{7}".into()).check(&text), Err(Reject::BadText));
        let pos = row(Kind::Pos);
        assert_eq!(MoreValue::Pos(WorldPos { x: LIMITS.max_coord, y: -LIMITS.max_coord }).check(&pos), Ok(()));
        assert_eq!(MoreValue::Pos(WorldPos { x: LIMITS.max_coord + 1, y: 0 }).check(&pos), Err(Reject::OutOfBounds));
        let ints = row(Kind::Ints { len: 3, min: 0, max: 9 });
        assert_eq!(MoreValue::ints(vec![0, 9, 4]).check(&ints), Ok(()));
        assert_eq!(MoreValue::ints(vec![]).check(&ints), Ok(()));
        assert_eq!(MoreValue::ints(vec![0, 1, 2, 3]).check(&ints), Err(Reject::OutOfBounds));
        assert_eq!(MoreValue::ints(vec![0, 10]).check(&ints), Err(Reject::OutOfBounds));
        assert_eq!(MoreValue::ints(vec![-1]).check(&ints), Err(Reject::OutOfBounds));
        assert_eq!(MoreValue::Bool(false).check(&row(Kind::Bool)), Ok(()));
        // A value of another kind is not this field's, whatever it holds.
        let values = [MoreValue::Bool(true), MoreValue::Int(1), MoreValue::Text("1".into()), MoreValue::ints(vec![1]), MoreValue::Pos(WorldPos::default())];
        let kinds = [Kind::Bool, Kind::Int { min: 0, max: 9 }, Kind::Text { max: 9 }, Kind::Ints { len: 9, min: 0, max: 9 }, Kind::Pos];
        for (i, v) in values.iter().enumerate() {
            for (k, kind) in kinds.iter().enumerate() {
                assert_eq!(v.check(&row(*kind)), if i == k { Ok(()) } else { Err(Reject::WrongField) }, "{v:?} as {kind:?}");
            }
        }
    }

    #[test]
    fn a_map_is_checked_for_its_entity_its_values_and_its_size() {
        let hero: More = [(id("hero"), MoreValue::Int(7))].into_iter().collect();
        assert_eq!(hero.check(Entity::Hero), Ok(()));
        assert_eq!(hero.check(Entity::Scene), Err(Reject::WrongField));
        assert_eq!(More::default().check(Entity::Lane), Ok(()));
        let bad: More = [(id("hero"), MoreValue::Int(-1))].into_iter().collect();
        assert_eq!(bad.check(Entity::Hero), Err(Reject::OutOfBounds));
        // Full lists are each within their row's bounds and over the record's cap together.
        let full = |key: &str| {
            let Kind::Ints { len, max, .. } = id(key).row().kind else { panic!("{key} is a list") };
            (id(key), MoreValue::ints(vec![max; len]))
        };
        let big: More = [full("build_order"), full("items"), full("abilities")].into_iter().collect();
        assert!(big.json_len() > LIMITS.max_more_bytes);
        assert_eq!(big.check(Entity::Hero), Err(Reject::TxTooLarge));
        let one: More = [full("build_order")].into_iter().collect();
        assert!(one.json_len() <= LIMITS.max_more_bytes, "{}", one.json_len());
        assert_eq!(one.check(Entity::Hero), Ok(()));
        // The cap is on the encoding, to the byte.
        let at = |n: usize| -> More { [(id("build_order"), MoreValue::ints(vec![1; n]))].into_iter().collect() };
        let fits = (1..=600).rev().find(|n| at(*n).json_len() <= 2048).expect("some length fits 2 KiB");
        assert_eq!(at(fits).json_len(), serde_json::to_string(&at(fits)).expect("json").len());
        assert!(at(fits + 1).json_len() > at(fits).json_len());
    }

    #[test]
    fn put_sets_replaces_and_clears() {
        let mut m = More::default();
        m.put(id("hero"), Some(MoreValue::Int(1)));
        m.put(id("hero"), Some(MoreValue::Int(2)));
        assert_eq!(m.get(id("hero")), Some(&MoreValue::Int(2)));
        assert_eq!(m.iter().count(), 1);
        m.put(id("name"), None);
        m.put(id("hero"), None);
        assert!(m.is_empty() && m.get(id("hero")).is_none());
    }

    #[test]
    fn the_heap_estimate_counts_text_and_lists() {
        let empty = More::default();
        assert_eq!(empty.heap_bytes(), 0);
        let small: More = [(id("hero"), MoreValue::Int(7))].into_iter().collect();
        let node = small.heap_bytes();
        assert_eq!(node, 11 * std::mem::size_of::<(RowId, MoreValue)>() + 48, "the first entry allocates a whole node");
        let list: More = [(id("items"), MoreValue::ints(vec![1; 100]))].into_iter().collect();
        assert_eq!(list.heap_bytes(), node + 800);
        let text: More = [(id("name"), MoreValue::Text("abcdefgh".into()))].into_iter().collect();
        assert_eq!(text.heap_bytes(), node + 8);
        // Up to eleven entries share the node; the twelfth would start another.
        let both: More = [(id("items"), MoreValue::ints(vec![1; 100])), (id("name"), MoreValue::Text("abcdefgh".into()))].into_iter().collect();
        assert_eq!(both.heap_bytes(), node + 808);
        let hero: Vec<RowId> = RowId::all().filter(|r| r.row().kind == Kind::Bool || matches!(r.row().kind, Kind::Int { .. })).collect();
        let many: More = hero.iter().map(|r| (*r, MoreValue::Int(0))).collect();
        assert_eq!(many.heap_bytes(), hero.len().div_ceil(11) * node);
        assert_eq!(More(BTreeMap::from_iter((0..12).map(|i| (RowId(i), MoreValue::Int(0))))).heap_bytes(), 2 * node, "twelve entries: two nodes");
    }

    // ---- admission (`Admit`) ----

    fn tx(ops: Vec<Op>) -> Tx {
        Tx { client: ClientId(1), cseq: 0, kind: TxKind::Edit, ops }
    }

    fn more(key: &str, value: Option<MoreValue>) -> FieldValue {
        FieldValue::More { key: id(key), value }
    }

    fn set(value: FieldValue) -> Op {
        Op::Set { id: RecordId(5), value }
    }

    fn create(record: Record) -> Op {
        Op::Create { id: RecordId(9), record }
    }

    fn holding(keys: &[&str]) -> More {
        keys.iter().map(|k| (id(k), MoreValue::Int(1))).collect()
    }

    fn hero(more: More) -> Record {
        let mut p = PlayerState::starting(RecordId(1), RecordId(2), Team::Amber, 0);
        p.more = more;
        Record::PlayerState(p)
    }

    fn scene_state(more: More) -> Record {
        Record::SceneState(SceneState { scene: RecordId(1), more })
    }

    /// Every row and `SceneState` still ahead: the reader release.
    const AHEAD: Admit = Admit { row: |_| Status::Ahead, scene_state: Status::Ahead, unfit_undo: Status::Ahead };
    /// `hero` written, the rest and `SceneState` still ahead.
    const HERO_LIVE: Admit = Admit { row: |r| if r.key() == "hero" { Status::Live } else { Status::Ahead }, scene_state: Status::Ahead, unfit_undo: Status::Ahead };

    #[test]
    fn nothing_that_carries_an_ahead_row_or_kind_is_admitted() {
        let refused = |op: Op| AHEAD.tx(&tx(vec![op])).expect_err("refused");
        // A write of the row, a clear of it, and either side of a conditional write.
        assert_eq!(refused(set(more("hero", Some(MoreValue::Int(7))))), Reject::WrongField);
        assert_eq!(refused(set(more("hero", None))), Reject::WrongField);
        let pos = FieldValue::PlayerPos(WorldPos::default());
        assert_eq!(refused(Op::SetIf { id: RecordId(5), expect: more("hero", None), value: pos.clone() }), Reject::WrongField);
        assert_eq!(refused(Op::SetIf { id: RecordId(5), expect: pos.clone(), value: more("hero", None) }), Reject::WrongField);
        // A record created with it, whichever kind holds it.
        assert_eq!(refused(create(hero(holding(&["hero"])))), Reject::WrongField);
        let marker = ObjectiveState { scene: RecordId(1), key: ObjectiveKey("walker:amber:lane1:1".into()), status: ObjectiveStatus::Destroyed, more: holding(&["hero"]) };
        assert_eq!(refused(create(Record::ObjectiveState(marker.clone()))), Reject::WrongField);
        let lane = Wave { scene: RecordId(1), lane: LaneKey("lane1".into()), t: 0, more: holding(&["level"]) };
        assert_eq!(refused(create(Record::Wave(lane.clone()))), Reject::WrongField);
        // A scene's state at all, empty or not.
        assert_eq!(refused(create(scene_state(More::default()))), Reject::Immutable);
        assert_eq!(refused(create(scene_state(holding(&["rows"])))), Reject::Immutable);
        // Anywhere in the transaction.
        let fine = set(pos.clone());
        assert_eq!(AHEAD.tx(&tx(vec![fine.clone(), set(more("name", None))])), Err(Reject::WrongField));
        assert_eq!(AHEAD.tx(&tx(vec![set(more("name", None)), fine.clone()])), Err(Reject::WrongField));
        assert_eq!(AHEAD.tx(&tx(vec![fine.clone(), create(scene_state(More::default())), fine.clone()])), Err(Reject::Immutable));
        // Everything a board holds today comes in: typed fields, records with no registry
        // values, deletes and restores. (Whether it is valid is not admission's question.)
        let callout = Record::Callout(Callout { scene: RecordId(1), pos: WorldPos::default(), text: "x".into(), color: None });
        let today = vec![
            fine,
            Op::SetIf { id: RecordId(5), expect: pos.clone(), value: pos },
            create(hero(More::default())),
            create(Record::ObjectiveState(ObjectiveState { more: More::default(), ..marker })),
            create(Record::Wave(Wave { more: More::default(), ..lane })),
            create(callout),
            Op::Delete { id: RecordId(5) },
            Op::Restore { id: RecordId(5) },
        ];
        assert_eq!(AHEAD.tx(&tx(today)), Ok(()));
        assert_eq!(AHEAD.tx(&tx(vec![])), Ok(()));
    }

    #[test]
    fn a_live_row_is_admitted_and_the_rows_still_ahead_are_not() {
        let hero_is = |n: i64| more("hero", Some(MoreValue::Int(n)));
        assert_eq!(HERO_LIVE.tx(&tx(vec![set(hero_is(7)), set(more("hero", None))])), Ok(()));
        assert_eq!(HERO_LIVE.tx(&tx(vec![Op::SetIf { id: RecordId(5), expect: hero_is(7), value: hero_is(8) }])), Ok(()));
        assert_eq!(HERO_LIVE.tx(&tx(vec![create(hero(holding(&["hero"])))])), Ok(()));
        // Another row is still refused, alone or beside the live one.
        assert_eq!(HERO_LIVE.tx(&tx(vec![set(more("name", None))])), Err(Reject::WrongField));
        assert_eq!(HERO_LIVE.tx(&tx(vec![set(hero_is(7)), set(more("level", Some(MoreValue::Int(3))))])), Err(Reject::WrongField));
        assert_eq!(HERO_LIVE.tx(&tx(vec![Op::SetIf { id: RecordId(5), expect: hero_is(7), value: more("name", None) }])), Err(Reject::WrongField));
        assert_eq!(HERO_LIVE.tx(&tx(vec![Op::SetIf { id: RecordId(5), expect: more("name", None), value: hero_is(7) }])), Err(Reject::WrongField));
        assert_eq!(HERO_LIVE.tx(&tx(vec![create(hero(holding(&["hero", "level"])))])), Err(Reject::WrongField));
        assert_eq!(HERO_LIVE.tx(&tx(vec![create(hero(holding(&["level", "health"])))])), Err(Reject::WrongField));
        // And a live row does not make the scene's state live.
        assert_eq!(HERO_LIVE.tx(&tx(vec![create(scene_state(More::default()))])), Err(Reject::Immutable));
        // A retired row is no longer written by a client, but is not refused: boards hold it.
        let retired = Admit { row: |_| Status::Retired, scene_state: Status::Retired, unfit_undo: Status::Ahead };
        assert_eq!(retired.tx(&tx(vec![set(more("name", None)), create(scene_state(holding(&["rows"])))])), Ok(()));
    }

    #[test]
    fn a_live_kind_is_admitted_with_only_its_live_rows() {
        let kind_live = Admit { row: |r| if r.key() == "rows" { Status::Live } else { Status::Ahead }, scene_state: Status::Live, unfit_undo: Status::Ahead };
        assert_eq!(kind_live.record(&scene_state(More::default())), Ok(()));
        assert_eq!(kind_live.record(&scene_state(holding(&["rows"]))), Ok(()));
        assert_eq!(kind_live.record(&scene_state(holding(&["rows", "build"]))), Err(Reject::WrongField));
        assert_eq!(kind_live.record(&hero(holding(&["hero"]))), Err(Reject::WrongField));
    }

    /// The two gates a build is given: its own statuses, and everything it reads.
    #[test]
    fn the_deployed_gate_follows_each_row_s_status_and_the_reads_gate_admits_every_row() {
        assert!(Admit::DEPLOYED.scene_state == SCENE_STATE);
        assert_eq!(Admit::DEPLOYED.record(&scene_state(More::default())).is_err(), SCENE_STATE == Status::Ahead);
        for r in RowId::all() {
            let write = tx(vec![set(FieldValue::More { key: r, value: None })]);
            assert_eq!((Admit::DEPLOYED.row)(r), r.row().status, "{r:?}");
            assert_eq!(Admit::DEPLOYED.tx(&write).is_err(), r.row().status == Status::Ahead, "{r:?}");
            assert_eq!(Admit::READS.tx(&write), Ok(()), "{r:?}");
        }
        let all: More = RowId::all().filter(|r| r.row().entity == Entity::Scene).map(|r| (r, MoreValue::Int(1))).collect();
        assert_eq!(Admit::READS.record(&scene_state(all)), Ok(()));
    }
}
