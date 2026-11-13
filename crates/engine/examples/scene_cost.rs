//! What one edit costs on a board full of saved scenes (map-state spec §6, review M5).
//!
//! The replica clones the whole document on every local edit (`Replica::submit`), and the
//! browser's wrapper clones it once more to diff (`crates/wasm`). This builds a board of 64
//! scenes shaped like Save as scene's, and times the clone, a local edit, a received entry and
//! the document's JSON, so a change to what a scene holds can be compared with today.
//!
//! `cargo run --release -p mapcro-engine --example scene_cost -- [--objectives N] [--more BYTES]`
//! `--objectives`: `ObjectiveState` records per scene (default 45: with 12 players and 3 waves,
//! the review's median of ~60 records). `--more`: bytes of packed lists in each hero's `more`
//! (default 0: today's records).

use mapcro_engine::{Replica, ServerMsg};
use mapcro_schema::{
    ClientId, Doc, FieldValue, LaneKey, ObjectiveKey, ObjectiveState, ObjectiveStatus, Op, OrderKey, PlayerState, Record, RecordId, Scene,
    SceneSource, Tx, TxKind, Wave, WorldPos, apply_tx, genesis, LIMITS,
};
use std::time::Instant;

fn arg(name: &str, default: usize) -> usize {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn board(objectives: usize, more: usize) -> Doc {
    let mut n = 0u128;
    let mut next = move || {
        n += 1;
        RecordId(n)
    };
    let mut doc = genesis(&mut next, "Scrim");
    let slots: Vec<_> = doc
        .iter_live()
        .filter_map(|(id, r)| match r {
            Record::RosterSlot(s) => Some((id, s.team, s.slot)),
            _ => None,
        })
        .collect();
    let mut order = OrderKey::first();
    for s in 1..LIMITS.max_scenes {
        let scene = next();
        order = OrderKey::between(Some(&order), None);
        let record = Scene {
            name: "Match moment".into(),
            order: order.clone(),
            clock: Some(60 * s as u32),
            source: Some(SceneSource { match_id: 129_738_985, t: 60 * s as u32, tier: "replay".into() }),
            live: false,
            parent: None,
        };
        let mut ops = vec![Op::Create { id: scene, record: Record::Scene(record) }];
        for (i, (slot, team, index)) in slots.iter().enumerate() {
            let mut p = PlayerState::starting(scene, *slot, *team, *index);
            p.souls = Some(1_000 * (s + i) as u32);
            p.ult_cooldown = Some(((s + i) % 100) as u8);
            fill(&mut p, more);
            ops.push(Op::Create { id: next(), record: Record::PlayerState(p) });
        }
        for k in 0..objectives {
            let key = ObjectiveKey(format!("camp:neutral:lane{}:{k}", 1 + k % 6));
            ops.push(Op::Create { id: next(), record: Record::ObjectiveState(ObjectiveState { scene, key, status: ObjectiveStatus::Destroyed }) });
        }
        for lane in ["lane1", "lane4", "lane6"] {
            ops.push(Op::Create { id: next(), record: Record::Wave(Wave { scene, lane: LaneKey(lane.into()), t: 500 }) });
        }
        // A save is one transaction; past the op cap this fixture splits, which a save never does.
        for (c, chunk) in ops.chunks(LIMITS.max_ops_per_tx).enumerate() {
            let tx = Tx { client: ClientId(1), cseq: (s * 8 + c) as u64, kind: TxKind::Edit, ops: chunk.to_vec() };
            if let Err(r) = apply_tx(&mut doc, &tx) {
                // The first chunk holds the scene and its players; a refusal there is the cap.
                eprintln!("scene {s}: {r}");
                return doc;
            }
        }
    }
    doc
}

/// What a snapshot adds to a hero, as `bytes` of packed lists. Today's records have no `more`.
fn fill(_p: &mut PlayerState, _bytes: usize) {}

fn time(runs: u32, mut f: impl FnMut()) -> f64 {
    let start = Instant::now();
    for _ in 0..runs {
        f();
    }
    start.elapsed().as_secs_f64() * 1e6 / f64::from(runs)
}

fn main() {
    let (objectives, more) = (arg("--objectives", 45), arg("--more", 0));
    let doc = board(objectives, more);
    let json = serde_json::to_string(&doc).expect("json");
    let scenes = doc.iter_live().filter(|(_, r)| matches!(r, Record::Scene(_))).count();
    let player = doc.iter_live().find(|(_, r)| matches!(r, Record::PlayerState(_))).map(|(id, _)| id).expect("player");
    println!("scenes {scenes}  records {}  json {} KiB  heap estimate {} KiB", doc.len(), json.len() / 1024, doc.approx_heap_bytes() / 1024);

    let clone = time(200, || {
        std::hint::black_box(doc.clone());
    });
    let to_json = time(20, || {
        std::hint::black_box(serde_json::to_string(&doc).expect("json"));
    });
    let mut replica = Replica::new(ClientId(2), "s".into(), doc.clone(), 0);
    let mut x = 0;
    let edit = time(200, || {
        x += 1;
        let op = Op::Set { id: player, value: FieldValue::PlayerPos(WorldPos { x, y: 0 }) };
        std::hint::black_box(replica.edit(vec![op]).expect("valid"));
    });
    // A peer's edit arriving: the replica applies it to its confirmed copy and rebuilds its view.
    let mut peer = Replica::new(ClientId(3), "s".into(), doc.clone(), 0);
    let mut seq = 0;
    let receive = time(200, || {
        seq += 1;
        let op = Op::Set { id: player, value: FieldValue::PlayerPos(WorldPos { x: seq as i32, y: 1 }) };
        let tx = Tx { client: ClientId(9), cseq: seq - 1, kind: TxKind::Edit, ops: vec![op] };
        peer.receive(ServerMsg::Entry { seq, tx }).expect("in order");
    });
    println!("clone {clone:.0} us  local edit {edit:.0} us  received entry {receive:.0} us  to JSON {to_json:.0} us");
    println!("(the browser's wrapper clones once more per edit and per receive, to diff)");
}
