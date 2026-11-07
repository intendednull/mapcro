use crate::ids::RecordId;
use crate::records::Record;
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
}

impl Doc {
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

    pub(crate) fn insert(&mut self, id: RecordId, record: Record) {
        self.entries.insert(id, Entry { record, deleted: false });
    }

    pub(crate) fn entry_mut(&mut self, id: RecordId) -> Option<&mut Entry> {
        self.entries.get_mut(&id)
    }
}

impl From<Vec<(RecordId, Entry)>> for Doc {
    fn from(v: Vec<(RecordId, Entry)>) -> Self {
        Doc { entries: v.into_iter().collect() }
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
