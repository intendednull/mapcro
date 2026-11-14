//! The properties, mirroring `model/sync.qnt`: exactlyOnce, noLostEdits, confirmedIsLogPrefix,
//! quiescentConverges, noClobber. Plus what the abstract model leaves out: invariants on every
//! view, view-only enforcement, and rejection bookkeeping.

use crate::{Driver, World};
use mapcro_engine::{Role, SaveStatus};
use mapcro_schema::{Doc, Field, FieldValue, Op, Tx, TxKind, apply_tx, validate_doc};
use std::collections::BTreeSet;

/// Replays the authority's log from genesis, independently of the authority's own state.
pub(crate) struct Oracle {
    states: Vec<Doc>,
    seen: BTreeSet<(mapcro_schema::ClientId, u64)>,
}

impl Oracle {
    pub fn new(genesis: Doc) -> Self {
        Oracle { states: vec![genesis], seen: BTreeSet::new() }
    }

    pub fn append(&mut self, tx: &Tx) -> Result<(), String> {
        // exactlyOnce
        if !self.seen.insert((tx.client, tx.cseq)) {
            return Err(format!("transaction {:?}#{} is in the log twice", tx.client, tx.cseq));
        }
        let mut next = self.states.last().cloned().unwrap_or_default();
        apply_tx(&mut next, tx).map_err(|r| format!("logged transaction does not replay: {r}"))?;
        self.states.push(next);
        Ok(())
    }

    pub fn at(&self, seq: u64) -> Option<&Doc> {
        self.states.get(seq as usize)
    }

    pub fn head(&self) -> &Doc {
        // `states` always holds at least the genesis document.
        &self.states[self.states.len() - 1]
    }
}

impl World {
    pub(crate) fn check_step(&self) -> Result<(), String> {
        let log = &self.stored_log;
        for c in &self.clients {
            let Driver::Replica { replica, .. } = &c.driver else { continue };
            // confirmedIsLogPrefix
            let expected = self
                .oracle
                .at(replica.last_seq())
                .ok_or_else(|| format!("{} claims seq {} beyond the log", c.name, replica.last_seq()))?;
            if replica.confirmed() != expected {
                return Err(format!("{}: confirmed state is not the log prefix at {}", c.name, replica.last_seq()));
            }
            // Every view the UI could render satisfies the board invariants.
            validate_doc(replica.view()).map_err(|r| format!("{}: view breaks an invariant: {r}", c.name))?;
            // noLostEdits: every transaction this client made is pending, logged, or rejected.
            let pending: BTreeSet<u64> = replica.pending().map(|t| t.cseq).collect();
            let rejected: BTreeSet<u64> = replica.rejected().iter().map(|(k, _)| *k).collect();
            for cseq in 0..replica.next_cseq() {
                let logged = log.iter().any(|t| t.client == replica.client() && t.cseq == cseq);
                // Pending-and-logged is normal: applied, ack still in flight.
                match (pending.contains(&cseq), logged, rejected.contains(&cseq)) {
                    (_, true, false) | (true, false, false) | (false, false, true) => {}
                    (false, false, false) => return Err(format!("{}: transaction #{cseq} vanished", c.name)),
                    places => return Err(format!("{}: transaction #{cseq} both rejected and kept {places:?}", c.name)),
                }
            }
            // Honest save status.
            if !pending.is_empty() && replica.status() == SaveStatus::Saved {
                return Err(format!("{}: shows Saved with {} pending", c.name, pending.len()));
            }
            // View-only links never write.
            if c.role == Role::View && log.iter().any(|t| t.client == replica.client()) {
                return Err(format!("{}: a view-only client's transaction was applied", c.name));
            }
        }
        Ok(())
    }

    pub(crate) fn check_quiescent(&self) -> Result<(), String> {
        let head = self.authority.doc();
        let len = self.stored_log.len() as u64;
        for c in &self.clients {
            let Driver::Replica { replica, .. } = &c.driver else { continue };
            if replica.pending().next().is_some() {
                return Err(format!("{}: still has pending work after quiescence", c.name));
            }
            if replica.last_seq() != len {
                return Err(format!("{}: at seq {} of {len}", c.name, replica.last_seq()));
            }
            // quiescentConverges
            if replica.confirmed() != head || replica.view() != head {
                return Err(format!("{}: did not converge", c.name));
            }
        }
        Ok(())
    }
}

/// noClobber, stated without trusting `SetIf`: every field an undo or redo changes must hold,
/// just before it lands, exactly the value the transaction it reverses wrote there. Returns how
/// many field changes were checked.
pub(crate) fn check_undo_did_not_clobber(before: &Doc, after: &Doc, tx: &Tx, log: &[Tx]) -> Result<usize, String> {
    let of = match tx.kind {
        TxKind::Edit => return Ok(0),
        TxKind::Undo { of } | TxKind::Redo { of } => of,
    };
    let Some(original) = log.iter().find(|t| t.client == tx.client && t.cseq == of) else {
        return Ok(0); // the reversed transaction was rejected; nothing of it landed
    };
    let mut checked = 0;
    for (id, entry) in after.iter() {
        let Some(prev) = before.get(id) else { continue };
        for field in Field::all() {
            let (Some(old), Some(new)) = (prev.record.get(field), entry.record.get(field)) else { continue };
            if old == new {
                continue;
            }
            checked += 1;
            match written_by(original, id, field) {
                Some(v) if v == old => {}
                Some(v) => {
                    return Err(format!(
                        "{:?} #{} overwrote {id:?}.{field:?} = {old:?}, but the transaction it reverses wrote {v:?}",
                        tx.kind, tx.cseq
                    ));
                }
                None => {
                    return Err(format!(
                        "{:?} #{} changed {id:?}.{field:?}, which the transaction it reverses never wrote",
                        tx.kind, tx.cseq
                    ));
                }
            }
        }
    }
    Ok(checked)
}

/// The last value `tx` wrote to `id.field`, if it wrote one.
fn written_by(tx: &Tx, id: mapcro_schema::RecordId, field: Field) -> Option<FieldValue> {
    let mut v = None;
    for op in &tx.ops {
        match op {
            Op::Set { id: i, value } | Op::SetIf { id: i, value, .. } if *i == id && value.field() == field => {
                v = Some(value.clone());
            }
            Op::Create { id: i, record } if *i == id => {
                if let Some(x) = record.get(field) {
                    v = Some(x);
                }
            }
            _ => {}
        }
    }
    v
}
