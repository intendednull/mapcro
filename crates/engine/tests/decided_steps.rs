//! TD-145: an undo or redo a client re-decided from its view goes on the wire as an ordinary
//! `Undo`/`Redo` transaction, but may carry plain `Set`s (a hero's record written whole), and a
//! step persisted by that client may carry an assertion (a `SetIf` of a value onto itself) that
//! a rolled-back client sends as it is. This file runs unchanged against this build and the
//! builds a rollback goes to: their server admits such transactions as it admits any, a replica
//! applies them as the server does, a log of them replays to the same bytes, and a replica's own
//! undo and redo stay sound around them. The transactions are JSON, as a client sends them.

use mapcro_engine::{Authority, ClientMsg, ConnId, Effect, Hello, Replica, Role, ServerMsg};
use mapcro_schema::{ClientId, Doc, RecordId, Tx, apply_tx, genesis, validate_doc};
use serde_json::{Value, json};

/// genesis: meta 1, slots 2..=13, the scene 14, then a hero record per slot.
const H: u128 = 18;

fn board() -> Doc {
    let mut n = 0u128;
    genesis(
        || {
            n += 1;
            RecordId(n)
        },
        "Scrim",
    )
}

fn more(key: &str, value: Value) -> Value {
    json!({ "More": { "key": key, "value": value } })
}
fn set(key: &str, value: Value) -> Value {
    json!({ "Set": { "id": RecordId(H), "value": more(key, value) } })
}
fn set_if(key: &str, from: Value, to: Value) -> Value {
    json!({ "SetIf": { "id": RecordId(H), "expect": more(key, from), "value": more(key, to) } })
}
const ROWS: [&str; 11] = ["items", "abilities", "build_order", "level", "health", "pickups", "kills", "deaths", "assists", "max_health", "hero"];
/// A hero's record written whole: its hero, every build row cleared, then its build.
fn whole(hero: u32, build: bool) -> Vec<Value> {
    let mut ops = vec![set("hero", json!(hero))];
    let held = [("items", json!([5, 0, -1, -1])), ("level", json!(4)), ("kills", json!(1))];
    for k in &ROWS[..10] {
        if !(build && held.iter().any(|(h, _)| h == k)) {
            ops.push(set(k, Value::Null));
        }
    }
    if build {
        ops.extend(held.iter().map(|(k, v)| set(k, v.clone())));
    }
    ops
}

struct Net {
    a: Authority,
    log: Vec<Tx>,
}

impl Net {
    fn new() -> Self {
        Net { a: Authority::new(board()), log: Vec::new() }
    }
    fn join(&mut self, conn: u64, client: ClientId) {
        self.a.connect(ConnId(conn), Role::Edit);
        let hello = Hello { client, secret: format!("s{}", client.0), last_seq: self.a.log_len(), pending_from: self.a.next_cseq(client) };
        self.a.handle(ConnId(conn), ClientMsg::Hello(hello));
    }
    /// Submit; every transaction here must be logged.
    fn submit(&mut self, conn: u64, msg: ClientMsg) {
        let (_, effects) = self.a.handle(ConnId(conn), msg);
        let logged: Vec<Tx> = effects
            .into_iter()
            .filter_map(|e| match e {
                Effect::Logged { tx, .. } => Some(tx),
                Effect::Rejected { reason, .. } => panic!("refused: {reason:?}"),
                _ => None,
            })
            .collect();
        assert_eq!(logged.len(), 1, "logged");
        self.log.extend(logged);
    }
    /// A raw client's transaction, as JSON.
    fn raw(&mut self, conn: u64, client: ClientId, cseq: u64, kind: Value, ops: Vec<Value>) {
        let tx: Tx = serde_json::from_value(json!({ "client": client, "cseq": cseq, "kind": kind, "ops": ops })).expect("a transaction as clients send it");
        self.submit(conn, ClientMsg::Submit(tx));
    }
    fn deliver(&self, r: &mut Replica) {
        for (i, tx) in self.log.iter().enumerate().skip(r.last_seq() as usize) {
            r.receive(ServerMsg::Entry { seq: i as u64 + 1, tx: tx.clone() }).expect("entry");
        }
        assert!(r.view_is_rebuilt());
    }
    /// The log replayed from the board it started on, as a restarted server loads it.
    fn replayed(&self) -> Doc {
        let mut doc = board();
        for tx in &self.log {
            apply_tx(&mut doc, tx).expect("replays");
        }
        doc
    }
}

fn hero(doc: &Doc) -> Value {
    serde_json::to_value(doc.get(RecordId(H)).expect("record")).expect("json")["record"]["PlayerState"]["more"].clone()
}

#[test]
fn an_undo_or_redo_with_whole_writes_is_admitted_applied_and_replayed_byte_for_byte() {
    let mut net = Net::new();
    let (raw, mine) = (ClientId(7), ClientId(8));
    net.join(1, raw);
    net.a.connect(ConnId(2), Role::Edit);
    // This build's replica, with steps of its own on the record.
    let mut r = Replica::new(mine, "s8".into(), board(), 0);
    for m in r.connect() {
        net.submit_if_tx(2, m);
    }
    // A save's record: the match's hero 13 with a build.
    net.raw(1, raw, 0, json!("Edit"), whole(13, true));
    net.deliver(&mut r);
    // This replica picks 77: hero set, every row cleared.
    let pick: Vec<mapcro_schema::Op> = serde_json::from_value(Value::Array(whole(77, false))).expect("ops");
    let m = r.edit(pick).expect("pick").expect("connected");
    net.submit(2, m);
    net.deliver(&mut r);
    assert_eq!(hero(r.view()), json!({ "hero": 77 }));
    // The raw client's undo written whole, then its redo, then a redo carrying an assertion as
    // a rolled-back client sends it, then a whole write of the same hero's build.
    net.raw(1, raw, 1, json!({ "Undo": { "of": 0 } }), whole(13, true));
    net.deliver(&mut r);
    assert_eq!(hero(r.view())["hero"], json!(13));
    assert_eq!(hero(r.view())["level"], json!(4));
    net.raw(1, raw, 2, json!({ "Redo": { "of": 1 } }), whole(78, false));
    net.raw(1, raw, 3, json!({ "Redo": { "of": 2 } }), vec![set_if("hero", json!(78), json!(78)), set_if("level", Value::Null, json!(4))]);
    net.deliver(&mut r);
    // The assertion changed nothing; the row's write applied.
    assert_eq!(hero(r.view()), json!({ "hero": 78, "level": 4 }));
    net.raw(1, raw, 4, json!({ "Undo": { "of": 3 } }), whole(78, false));
    net.deliver(&mut r);
    assert_eq!(hero(r.view()), json!({ "hero": 78 }));
    // This replica's own undo of its pick, after all of that: its `SetIf`s meet a record others
    // wrote since, and skip; nothing is refused and every copy agrees.
    let m = r.undo().expect("undo").expect("connected");
    net.submit(2, m);
    net.deliver(&mut r);
    if r.can_redo() {
        let m = r.redo().expect("redo").expect("connected");
        net.submit(2, m);
        net.deliver(&mut r);
    }
    assert!(r.pending().next().is_none());
    assert_eq!(r.confirmed(), net.a.doc());
    assert_eq!(r.view(), net.a.doc());
    // Replayed from scratch: the same board, byte for byte, and a valid one.
    let replayed = net.replayed();
    assert_eq!(serde_json::to_vec(&replayed).expect("json"), serde_json::to_vec(net.a.doc()).expect("json"));
    validate_doc(&replayed).expect("valid");
    // A fresh replica from the log agrees too.
    let mut fresh = Replica::new(ClientId(9), "s9".into(), board(), 0);
    net.deliver(&mut fresh);
    assert_eq!(fresh.view(), net.a.doc());
}

#[test]
fn a_persisted_step_carrying_an_assertion_is_restored_and_sent_as_it_is() {
    let mut net = Net::new();
    let mine = ClientId(8);
    net.a.connect(ConnId(2), Role::Edit);
    let mut r = Replica::new(mine, "s8".into(), board(), 0);
    for m in r.connect() {
        net.submit_if_tx(2, m);
    }
    // The record as this client's undo left it, and its redo as a TD-145 client stores it: the
    // hero it was made on asserted ahead of the rows' fill.
    let m = r.edit(serde_json::from_value(json!([set("hero", json!(13))])).expect("ops")).expect("edit").expect("connected");
    net.submit(2, m);
    net.deliver(&mut r);
    let mut state = serde_json::to_value(r.state()).expect("state");
    state["redo"] = json!([{ "cseq": 0, "inverse": [set_if("hero", json!(13), json!(13)), set_if("level", Value::Null, json!(4)), set_if("kills", Value::Null, json!(1))] }]);
    // Restored after a reload, on a connection of its own.
    let mut r = Replica::from_state(serde_json::from_value(state).expect("a stored state"));
    net.a.disconnect(ConnId(2));
    net.a.connect(ConnId(3), Role::Edit);
    for m in r.connect() {
        net.submit_if_tx(3, m);
    }
    assert!(r.can_redo());
    let m = r.redo().expect("redo").expect("connected");
    net.submit(3, m);
    net.deliver(&mut r);
    assert_eq!(hero(r.view()), json!({ "hero": 13, "level": 4, "kills": 1 }));
    // Its undo takes the rows back and leaves the hero; the assertion left no step of its own.
    let m = r.undo().expect("undo").expect("connected");
    net.submit(3, m);
    net.deliver(&mut r);
    assert_eq!(hero(r.view()), json!({ "hero": 13 }));
    assert_eq!(r.view(), net.a.doc());
    let replayed = net.replayed();
    assert_eq!(serde_json::to_vec(&replayed).expect("json"), serde_json::to_vec(net.a.doc()).expect("json"));
}

impl Net {
    /// A hello is the authority's to answer; a resent transaction is submitted.
    fn submit_if_tx(&mut self, conn: u64, m: ClientMsg) {
        match m {
            ClientMsg::Submit(_) => self.submit(conn, m),
            other => {
                self.a.handle(ConnId(conn), other);
            }
        }
    }
}
