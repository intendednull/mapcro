//! What simulated users do. Honest behaviours build edits from what their own view shows, the
//! way the UI would; attackers send whatever they like.

use crate::{Driver, World};
use mapcro_engine::{ClientMsg, Replica, UndoError};
use mapcro_schema::{
    Arrow, Callout, FieldValue, HeroId, Note, ObjectiveKey, ObjectiveState, ObjectiveStatus, Op, OrderKey,
    PlayerState, Record, RecordId, Scene, Team, Tx, TxKind, WorldPos,
};
use rand::Rng;
use rand::seq::IndexedRandom;
use rand_chacha::ChaCha8Rng;

#[derive(Clone, Copy, Debug)]
pub enum Behaviour {
    /// Drags heroes around: lots of concurrent writes to the same few fields.
    Dragger,
    /// Edits everything: names, objectives, arrows, callouts, notes.
    Editor,
    /// Adds, deletes and reorders scenes.
    SceneShuffler,
    /// Edits a little, undoes and redoes a lot.
    Undoer,
}

impl Behaviour {
    pub fn for_index(i: usize) -> Self {
        [Behaviour::Dragger, Behaviour::Undoer, Behaviour::Editor, Behaviour::SceneShuffler][i % 4]
    }
}

pub(crate) fn act(world: &mut World, i: usize) -> Result<(), String> {
    // Ids an attacker can learn: every entry carries its author's client id.
    let known_ids: Vec<mapcro_schema::ClientId> = world.authority.log().iter().map(|t| t.client).collect();
    let World { rng, clients, stats, .. } = world;
    let c = &mut clients[i];
    let line = match &mut c.driver {
        // An honest viewer's UI offers no editing.
        Driver::Replica { .. } if c.role == mapcro_engine::Role::View => return Ok(()),
        Driver::Replica { replica, behaviour } => {
            let undo_bias = match behaviour {
                Behaviour::Undoer => 50,
                _ => 8,
            };
            let roll = rng.random_range(0..100);
            if roll < undo_bias / 2 && replica.can_undo() {
                stats.undos += 1;
                describe("undo", replica.undo(), &mut c.up)
            } else if roll < undo_bias && replica.can_redo() {
                stats.undos += 1;
                describe("redo", replica.redo(), &mut c.up)
            } else {
                let ops = edit_ops(rng, replica, *behaviour);
                if ops.is_empty() {
                    return Ok(());
                }
                stats.edits += 1;
                match replica.edit(ops) {
                    Ok(msg) => {
                        c.up.extend(msg);
                        "edit".to_string()
                    }
                    // A generated edit can be invalid (e.g. deleting the last scene); the local
                    // check refuses it, exactly as the UI would.
                    Err(r) => format!("edit refused locally: {r}"),
                }
            }
        }
        Driver::Attacker { client, next_cseq, .. } => {
            if c.conn.is_none() {
                // Reconnect claiming an honest client's (public) id, with a wrong secret.
                if let Some(victim) = known_ids.choose(rng).copied()
                    && rng.random_range(0..4) == 0
                {
                    *client = victim;
                    *next_cseq = 0;
                }
                return Ok(());
            }
            let (tx, what) = attack(rng, *client, *next_cseq);
            if tx.cseq == *next_cseq {
                *next_cseq += 1;
            }
            c.up.push_back(ClientMsg::Submit(tx));
            format!("attack: {what}")
        }
    };
    let name = world.clients[i].name.clone();
    world.log(format!("{name}: {line}"));
    Ok(())
}

fn describe(what: &str, r: Result<Option<ClientMsg>, UndoError>, up: &mut std::collections::VecDeque<ClientMsg>) -> String {
    match r {
        Ok(msg) => {
            up.extend(msg);
            what.to_string()
        }
        Err(e) => format!("{what}: {e}"),
    }
}

fn pos(rng: &mut ChaCha8Rng) -> WorldPos {
    WorldPos { x: rng.random_range(-10_000..=10_000), y: rng.random_range(-10_000..=10_000) }
}

fn text(rng: &mut ChaCha8Rng, max: usize) -> String {
    const WORDS: &[&str] = &["mid", "push", "rotate", "east", "walker", "smoke", "bridge", "→", "ünder", "boss"];
    let n = rng.random_range(0..=3);
    let s: Vec<&str> = (0..n).map(|_| *WORDS.choose(rng).unwrap_or(&"x")).collect();
    s.join(" ").chars().take(max).collect()
}

fn live_ids(r: &Replica, pred: impl Fn(&Record) -> bool) -> Vec<RecordId> {
    r.view().iter_live().filter(|(_, rec)| pred(rec)).map(|(id, _)| id).collect()
}

fn pick(rng: &mut ChaCha8Rng, v: &[RecordId]) -> Option<RecordId> {
    v.choose(rng).copied()
}

fn edit_ops(rng: &mut ChaCha8Rng, r: &Replica, b: Behaviour) -> Vec<Op> {
    let scenes = live_ids(r, |x| matches!(x, Record::Scene(_)));
    let players = live_ids(r, |x| matches!(x, Record::PlayerState(_)));
    let Some(scene) = pick(rng, &scenes) else { return vec![] };
    let new_id = RecordId(rng.random());
    let choice = match b {
        Behaviour::Dragger | Behaviour::Undoer => rng.random_range(0..3),
        Behaviour::Editor => rng.random_range(0..12).max(if rng.random_range(0..6) == 0 { 15 } else { 0 }),
        Behaviour::SceneShuffler => [12, 13, 14, 16, 0].choose(rng).copied().unwrap_or(0),
    };
    let set = |id: Option<RecordId>, value: FieldValue| id.map(|id| vec![Op::Set { id, value }]).unwrap_or_default();
    match choice {
        0 | 1 => {
            let p = pick(rng, &players);
            set(p, FieldValue::PlayerPos(pos(rng)))
        }
        2 => {
            let p = pick(rng, &players);
            if rng.random() {
                set(p, FieldValue::PlayerAlive(rng.random()))
            } else {
                let ult = [None, Some(mapcro_schema::UltStatus::Ready), Some(mapcro_schema::UltStatus::Cooldown)];
                if rng.random() {
                    set(p, FieldValue::PlayerSouls(Some(rng.random_range(0..60_000))))
                } else {
                    set(p, FieldValue::PlayerUlt(*ult.choose(rng).unwrap_or(&None)))
                }
            }
        }
        3 => {
            let slots = live_ids(r, |x| matches!(x, Record::RosterSlot(_)));
            let s = pick(rng, &slots);
            set(s, FieldValue::RosterName(text(rng, 24)))
        }
        4 => {
            let slots = live_ids(r, |x| matches!(x, Record::RosterSlot(_)));
            let s = pick(rng, &slots);
            set(s, FieldValue::RosterHero(Some(HeroId(rng.random_range(1..60)))))
        }
        5 => {
            let key = ObjectiveKey(format!("walker:amber:lane{}", rng.random_range(1..4)));
            let existing = r.view().iter_live().find_map(|(id, rec)| match rec {
                Record::ObjectiveState(o) if o.scene == scene && o.key == key => Some(id),
                _ => None,
            });
            let status = *[ObjectiveStatus::Active, ObjectiveStatus::Destroyed, ObjectiveStatus::Hidden]
                .choose(rng)
                .unwrap_or(&ObjectiveStatus::Active);
            match existing {
                Some(id) => vec![Op::Set { id, value: FieldValue::ObjectiveStatus(status) }],
                None => vec![Op::Create { id: new_id, record: Record::ObjectiveState(ObjectiveState { scene, key, status }) }],
            }
        }
        6 => vec![Op::Create {
            id: new_id,
            record: Record::Arrow(Arrow { scene, from: pos(rng), to: pos(rng), team: Some(Team::Amber) }),
        }],
        7 => vec![Op::Create { id: new_id, record: Record::Callout(Callout { scene, pos: pos(rng), text: text(rng, 80) }) }],
        8 => {
            let deletable =
                live_ids(r, |x| matches!(x, Record::Arrow(_) | Record::Callout(_) | Record::ObjectiveState(_) | Record::Stroke(_)));
            pick(rng, &deletable).map(|id| vec![Op::Delete { id }]).unwrap_or_default()
        }
        9 => {
            let callouts = live_ids(r, |x| matches!(x, Record::Callout(_)));
            set(pick(rng, &callouts), FieldValue::CalloutText(text(rng, 80)))
        }
        10 => {
            let note = r.view().iter_live().find_map(|(id, rec)| match rec {
                Record::Note(n) if n.scene == scene => Some(id),
                _ => None,
            });
            match note {
                Some(id) => vec![Op::Set { id, value: FieldValue::NoteText(text(rng, 4000)) }],
                None => vec![Op::Create { id: new_id, record: Record::Note(Note { scene, text: text(rng, 4000) }) }],
            }
        }
        11 => {
            let meta = live_ids(r, |x| matches!(x, Record::BoardMeta(_)));
            set(pick(rng, &meta), FieldValue::Title(text(rng, 80)))
        }
        12 => {
            // New scene with its 12 player states, in one transaction.
            let id = new_id;
            let mut ops = vec![Op::Create {
                id,
                record: Record::Scene(Scene { name: text(rng, 24), order: OrderKey::between(last_order(r).as_ref(), None), clock: Some(rng.random_range(0..3600)) }),
            }];
            for (slot, rec) in r.view().iter_live() {
                if let Record::RosterSlot(s) = rec {
                    ops.push(Op::Create {
                        id: RecordId(rng.random()),
                        record: Record::PlayerState(PlayerState::starting(id, slot, s.team, s.slot)),
                    });
                }
            }
            ops
        }
        13 => vec![Op::Delete { id: scene }],
        16 => set(Some(scene), FieldValue::SceneClock(Some(rng.random_range(0..3600)))),
        15 => {
            let n = rng.random_range(2..40);
            let points = (0..n).map(|_| pos(rng)).collect();
            vec![Op::Create { id: new_id, record: Record::Stroke(mapcro_schema::Stroke { scene, points, color: rng.random_range(0..16), width: 20 }) }]
        }
        _ => {
            let order = OrderKey::between(None, first_order(r).as_ref());
            vec![Op::Set { id: scene, value: FieldValue::SceneOrder(order) }]
        }
    }
}

fn orders(r: &Replica) -> Vec<OrderKey> {
    let mut v: Vec<OrderKey> = r
        .view()
        .iter_live()
        .filter_map(|(_, rec)| match rec {
            Record::Scene(s) => Some(s.order.clone()),
            _ => None,
        })
        .collect();
    v.sort();
    v
}
fn last_order(r: &Replica) -> Option<OrderKey> {
    orders(r).pop()
}
fn first_order(r: &Replica) -> Option<OrderKey> {
    orders(r).into_iter().next()
}

/// A hand-crafted transaction. Mostly invalid; occasionally protocol-breaking (wrong client id,
/// sequence gap), which must get the attacker disconnected and nobody else.
fn attack(rng: &mut ChaCha8Rng, client: mapcro_schema::ClientId, cseq: u64) -> (Tx, &'static str) {
    let id = RecordId(rng.random());
    let scene = RecordId(rng.random());
    let (ops, what) = match rng.random_range(0..10) {
        0 => (vec![Op::Set { id, value: FieldValue::PlayerPos(WorldPos { x: i32::MAX, y: 0 }) }], "out-of-bounds write"),
        1 => (vec![Op::Create { id, record: Record::Callout(Callout { scene, pos: WorldPos { x: 0, y: 0 }, text: "x".repeat(500) }) }], "huge text"),
        2 => (vec![Op::Create { id, record: Record::Scene(Scene { name: "bad\u{7}".into(), order: OrderKey::first(), clock: None }) }], "control chars / incomplete scene"),
        3 => (vec![Op::SetIf { id, expect: FieldValue::Title("a".into()), value: FieldValue::NoteText("b".into()) }], "mismatched set_if"),
        4 => (vec![Op::Delete { id }], "delete unknown"),
        5 => (vec![], "empty transaction"),
        6 => ((0..300).map(|_| Op::Restore { id }).collect(), "too many ops"),
        7 => (vec![Op::Create { id, record: Record::BoardMeta(mapcro_schema::BoardMeta { title: "pwned".into() }) }], "second board meta"),
        8 => {
            let other = mapcro_schema::ClientId(rng.random());
            return (Tx { client: other, cseq, kind: TxKind::Edit, ops: vec![Op::Delete { id }] }, "impersonate another client");
        }
        _ => return (Tx { client, cseq: cseq + 5, kind: TxKind::Edit, ops: vec![Op::Delete { id }] }, "sequence gap"),
    };
    (Tx { client, cseq, kind: TxKind::Edit, ops }, what)
}
