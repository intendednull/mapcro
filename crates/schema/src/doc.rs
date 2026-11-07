use crate::ids::RecordId;
use crate::records::Record;
use std::collections::BTreeMap;

/// A record plus its tombstone flag. Deleted records keep their fields so `Restore` brings back
/// edits that others made in the meantime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub record: Record,
    pub deleted: bool,
}

/// The whole board. A `BTreeMap` keeps iteration order deterministic, so two replicas holding
/// the same records compare and hash identically.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
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
