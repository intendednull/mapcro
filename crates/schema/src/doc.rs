use crate::ids::RecordId;
use crate::records::{Record, WorldPos};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A record plus its tombstone flag. Deleted records keep their fields so `Restore` brings back
/// edits that others made in the meantime.
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub record: Record,
    pub deleted: bool,
}

/// The whole board. A `BTreeMap` keeps iteration order deterministic, so two replicas holding
/// the same records compare and hash identically.
/// Serialized as a list of `[id, entry]` pairs (ids aren't valid JSON object keys as numbers).
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, as = "Vec<DocPair>"))]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "Vec<(RecordId, Entry)>", into = "Vec<(RecordId, Entry)>")]
pub struct Doc {
    entries: BTreeMap<RecordId, Entry>,
    /// Whether this document is a session: it holds a `SessionMeta` (sessions spec §2.2). Kept
    /// as records go in, so the kind check on every op costs nothing.
    session: bool,
}

/// What a document is, by its genesis record (sessions spec §2.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DocKind {
    Board,
    Session,
}

impl Doc {
    /// A board, unless it holds a `SessionMeta`. A session's genesis is that record, which no
    /// edit can create or delete, so a document never changes kind.
    pub fn kind(&self) -> DocKind {
        if self.session { DocKind::Session } else { DocKind::Board }
    }

    pub fn get(&self, id: RecordId) -> Option<&Entry> {
        self.entries.get(&id)
    }

    /// A record that exists and is not deleted.
    pub fn live(&self, id: RecordId) -> Option<&Record> {
        self.entries.get(&id).filter(|e| !e.deleted).map(|e| &e.record)
    }

    pub fn iter(&self) -> impl Iterator<Item = (RecordId, &Entry)> {
        self.entries.iter().map(|(id, e)| (*id, e))
    }

    pub fn iter_live(&self) -> impl Iterator<Item = (RecordId, &Record)> {
        self.iter().filter(|(_, e)| !e.deleted).map(|(id, e)| (id, &e.record))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Roughly what the document occupies in memory, in bytes: each entry's map node and record,
    /// plus the text and points it owns. For a host's memory budget, so it's an estimate, not an
    /// accounting; a test checks it against the largest documents the limits allow.
    pub fn approx_heap_bytes(&self) -> usize {
        // A B-tree node holds up to 11 entries; count each entry's share plus slack.
        const PER_ENTRY: usize = std::mem::size_of::<(RecordId, Entry)>() + 32;
        self.entries.values().map(|e| PER_ENTRY + record_heap_bytes(&e.record)).sum()
    }

    pub(crate) fn insert(&mut self, id: RecordId, record: Record) {
        self.session |= matches!(record, Record::SessionMeta(_));
        self.entries.insert(id, Entry { record, deleted: false });
    }

    /// Put back an entry exactly as it was (`None`: it didn't exist). Rollback only.
    pub(crate) fn restore_entry(&mut self, id: RecordId, entry: Option<Entry>) {
        match entry {
            Some(e) => {
                self.session |= matches!(e.record, Record::SessionMeta(_));
                self.entries.insert(id, e);
            }
            None => {
                if let Some(e) = self.entries.remove(&id)
                    && matches!(e.record, Record::SessionMeta(_))
                {
                    self.session = self.entries.values().any(|e| matches!(e.record, Record::SessionMeta(_)));
                }
            }
        }
    }

    pub(crate) fn entry_mut(&mut self, id: RecordId) -> Option<&mut Entry> {
        self.entries.get_mut(&id)
    }
}

impl From<Vec<(RecordId, Entry)>> for Doc {
    fn from(v: Vec<(RecordId, Entry)>) -> Self {
        let entries: BTreeMap<RecordId, Entry> = v.into_iter().collect();
        let session = entries.values().any(|e| matches!(e.record, Record::SessionMeta(_)));
        Doc { entries, session }
    }
}

impl From<Doc> for Vec<(RecordId, Entry)> {
    fn from(d: Doc) -> Self {
        d.entries.into_iter().collect()
    }
}

/// TypeScript view of one serialized `Doc` element: `[id, entry]`.
#[cfg(feature = "ts")]
#[derive(ts_rs::TS)]
#[ts(export)]
pub struct DocPair(pub RecordId, pub Entry);

/// The heap a record owns beyond its own size: strings and points.
fn record_heap_bytes(r: &Record) -> usize {
    match r {
        Record::BoardMeta(m) => m.title.capacity(),
        Record::RosterSlot(s) => s.name.capacity(),
        Record::Scene(s) => s.name.capacity() + s.order.0.capacity(),
        Record::ObjectiveState(o) => o.key.0.capacity() + o.more.heap_bytes(),
        Record::Wave(w) => w.lane.0.capacity() + w.more.heap_bytes(),
        Record::PlayerState(p) => p.more.heap_bytes(),
        Record::SceneState(s) => s.more.heap_bytes(),
        Record::Callout(c) => c.text.capacity(),
        Record::Note(n) => n.text.capacity(),
        Record::Stroke(s) => s.points.capacity() * std::mem::size_of::<WorldPos>(),
        Record::SessionMeta(m) => m.title.capacity(),
        Record::Tab(t) => t.board.0.capacity() + t.grant.0.capacity() + t.name.capacity() + t.order.0.capacity(),
        Record::Arrow(_) => 0,
    }
}
