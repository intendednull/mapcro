//! Deterministic simulation of the mapcro sync engine (spec §14, layer 1).
//!
//! One [`Authority`] and several [`Replica`]s talk over simulated connections: FIFO while up, and
//! a disconnect loses everything in flight, as WebSockets do (and as the Quint model assumes).
//! Every source of nondeterminism comes from one seeded RNG, so a failing seed replays exactly.
//!
//! The checks deliberately do not reuse engine logic where an independent statement exists:
//! the oracle replays the log from scratch, and the undo check compares raw field values instead
//! of trusting `SetIf`.

mod behaviour;
mod checks;

use behaviour::Behaviour;
use mapcro_engine::{Authority, ClientMsg, ConnId, Effect, Outgoing, Replica, Role, ServerMsg};
use mapcro_schema::{ClientId, Doc, RecordId, Reject, Tx, genesis};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use std::collections::VecDeque;
use std::fmt::Write as _;

#[derive(Clone, Debug)]
pub struct Config {
    /// Honest editing clients (each with a behaviour).
    pub editors: usize,
    /// Clients holding a view-only link. Honest ones only watch.
    pub viewers: usize,
    /// Raw clients that send hand-crafted, mostly invalid transactions.
    pub attackers: usize,
    pub steps: usize,
    /// Percent chance per step of a connection fault on some client.
    pub fault_rate: u32,
}

impl Default for Config {
    fn default() -> Self {
        Config { editors: 6, viewers: 1, attackers: 2, steps: 400, fault_rate: 4 }
    }
}

#[derive(Debug, Default, Clone)]
pub struct Stats {
    pub log_len: usize,
    pub edits: usize,
    pub undos: usize,
    pub rejected: usize,
    /// Rejections of honest editors' work: concurrent conflicts, not view-only refusals.
    pub editor_rejected: usize,
    pub disconnects: usize,
    pub server_restarts: usize,
    pub reloads: usize,
    /// Clients that cleared their storage and joined again from a snapshot.
    pub fresh_joins: usize,
    pub undo_fields_checked: usize,
}

#[derive(Debug)]
pub struct Failure {
    pub seed: u64,
    pub step: usize,
    pub message: String,
    pub trace: Vec<String>,
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "seed {:#x} failed at step {}: {}", self.seed, self.step, self.message)?;
        writeln!(f, "last steps:")?;
        for line in self.trace.iter().rev().take(40).rev() {
            writeln!(f, "  {line}")?;
        }
        write!(f, "replay: just sim --seed {:#x}", self.seed)
    }
}

pub(crate) enum Driver {
    Replica { replica: Box<Replica>, behaviour: Behaviour },
    /// No replica: tracks its own cseq so it can send anything at all.
    Attacker { client: ClientId, next_cseq: u64, secret: String },
}

pub(crate) struct SimClient {
    pub name: String,
    pub role: Role,
    pub driver: Driver,
    pub conn: Option<ConnId>,
    pub up: VecDeque<ClientMsg>,
    pub down: VecDeque<ServerMsg>,
}

pub struct World {
    pub(crate) seed: u64,
    pub(crate) rng: ChaCha8Rng,
    pub(crate) authority: Authority,
    pub(crate) clients: Vec<SimClient>,
    pub(crate) next_conn: u64,
    pub(crate) step: usize,
    pub(crate) trace: Vec<String>,
    pub(crate) oracle: checks::Oracle,
    pub(crate) stats: Stats,
    /// What the real server would have on disk: genesis plus durable effects.
    pub(crate) genesis: Doc,
    pub(crate) stored_rejections: Vec<(ClientId, u64, Reject)>,
    pub(crate) stored_clients: Vec<(ClientId, [u8; 32])>,
    /// The log as the server stores it: every `Effect::Logged`, in order. The authority keeps
    /// none of it, so this is also what catch-up is served from.
    pub(crate) stored_log: Vec<Tx>,
}

pub fn run(seed: u64, config: &Config) -> Result<Stats, Failure> {
    run_logged(seed, config).map(|(stats, _, _)| stats)
}

/// Like [`run`], also returning the board's genesis document and its log: realistic stored
/// data, for example to train the storage codec's dictionary (`just zdict`).
pub fn run_logged(seed: u64, config: &Config) -> Result<(Stats, Doc, Vec<Tx>), Failure> {
    let mut world = World::new(seed, config);
    for step in 0..config.steps {
        world.step = step;
        world.random_step(config).map_err(|m| world.fail(m))?;
        world.check_step().map_err(|m| world.fail(m))?;
    }
    world.step = config.steps;
    world.quiesce().map_err(|m| world.fail(m))?;
    world.check_quiescent().map_err(|m| world.fail(m))?;
    world.stats.log_len = world.stored_log.len();
    Ok((world.stats, world.genesis, world.stored_log))
}

impl World {
    fn new(seed: u64, config: &Config) -> World {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let doc: Doc = genesis(|| RecordId(rng.random()), "Sim board");
        let mut clients = Vec::new();
        for i in 0..config.editors {
            let behaviour = Behaviour::for_index(i);
            let replica = Replica::new(ClientId(rng.random()), format!("{:032x}", rng.random::<u128>()), doc.clone(), 0);
            clients.push(SimClient {
                name: format!("e{i}:{behaviour:?}"),
                role: Role::Edit,
                driver: Driver::Replica { replica: Box::new(replica), behaviour },
                conn: None,
                up: VecDeque::new(),
                down: VecDeque::new(),
            });
        }
        for i in 0..config.viewers {
            let replica = Replica::new(ClientId(rng.random()), format!("{:032x}", rng.random::<u128>()), doc.clone(), 0);
            clients.push(SimClient {
                name: format!("v{i}"),
                role: Role::View,
                driver: Driver::Replica { replica: Box::new(replica), behaviour: Behaviour::Editor },
                conn: None,
                up: VecDeque::new(),
                down: VecDeque::new(),
            });
        }
        for i in 0..config.attackers {
            // Odd attackers hold a view link, even ones an edit link.
            let role = if i % 2 == 1 { Role::View } else { Role::Edit };
            clients.push(SimClient {
                name: format!("x{i}:{role:?}"),
                role,
                driver: Driver::Attacker { client: ClientId(rng.random()), next_cseq: 0, secret: format!("{:032x}", rng.random::<u128>()) },
                conn: None,
                up: VecDeque::new(),
                down: VecDeque::new(),
            });
        }
        let mut world = World {
            seed,
            rng,
            oracle: checks::Oracle::new(doc.clone()),
            genesis: doc.clone(),
            stored_rejections: Vec::new(),
            stored_clients: Vec::new(),
            stored_log: Vec::new(),
            authority: Authority::new(doc),
            clients,
            next_conn: 0,
            step: 0,
            trace: Vec::new(),
            stats: Stats::default(),
        };
        for i in 0..world.clients.len() {
            world.reconnect(i);
        }
        world
    }

    fn fail(&self, message: String) -> Failure {
        Failure { seed: self.seed, step: self.step, message, trace: self.trace.clone() }
    }

    pub(crate) fn log(&mut self, line: impl AsRef<str>) {
        let mut s = String::new();
        let _ = write!(s, "{:>4} {}", self.step, line.as_ref());
        self.trace.push(s);
    }

    fn random_step(&mut self, config: &Config) -> Result<(), String> {
        let n = self.clients.len();
        let i = self.rng.random_range(0..n);
        if self.rng.random_range(0..1000) < 2 {
            self.restart_server();
            return Ok(());
        }
        if self.rng.random_range(0..1000) < 5 {
            return self.reload(i);
        }
        if self.rng.random_range(0..1000) < 3 {
            return self.fresh_join(i);
        }
        if self.rng.random_range(0..100) < config.fault_rate {
            if self.clients[i].conn.is_some() {
                self.disconnect(i);
            } else {
                self.reconnect(i);
            }
            return Ok(());
        }
        match self.rng.random_range(0..10) {
            0..=2 => self.act(i),
            3..=5 => self.deliver_up(i),
            _ => self.deliver_down(i),
        }
    }

    pub(crate) fn disconnect(&mut self, i: usize) {
        let c = &mut self.clients[i];
        if let Some(conn) = c.conn.take() {
            self.authority.disconnect(conn);
        }
        c.up.clear();
        c.down.clear();
        if let Driver::Replica { replica, .. } = &mut c.driver {
            replica.disconnect();
        }
        self.stats.disconnects += 1;
        let name = self.clients[i].name.clone();
        self.log(format!("{name}: disconnect"));
    }

    /// The server process dies and comes back: every connection drops, and the authority is
    /// rebuilt from storage alone (genesis, the log, stored rejections), as the real server does.
    fn restart_server(&mut self) {
        let mut fresh = Authority::new(self.genesis.clone());
        for (client, h) in self.stored_clients.clone() {
            fresh.replay_client(client, h);
        }
        for tx in self.stored_log.clone() {
            if let Err(r) = fresh.replay(&tx, mapcro_engine::encoded_len(&tx)) {
                // Surfaces as an oracle mismatch on the next check.
                self.log(format!("replay failed: {r}"));
            }
        }
        for (client, cseq, reason) in self.stored_rejections.clone() {
            fresh.replay_rejection(client, cseq, reason);
        }
        self.authority = fresh;
        for i in 0..self.clients.len() {
            let c = &mut self.clients[i];
            c.conn = None;
            c.up.clear();
            c.down.clear();
            if let Driver::Replica { replica, .. } = &mut c.driver {
                replica.disconnect();
            }
        }
        self.stats.server_restarts += 1;
        self.log("server restarted from storage");
    }

    /// The tab reloads: the replica is persisted as JSON (as to IndexedDB) and rebuilt from it.
    fn reload(&mut self, i: usize) -> Result<(), String> {
        if !matches!(self.clients[i].driver, Driver::Replica { .. }) {
            return Ok(());
        }
        self.disconnect(i);
        let Driver::Replica { replica, .. } = &mut self.clients[i].driver else { return Ok(()) };
        let json = serde_json::to_string(&replica.state()).map_err(|e| format!("persist: {e}"))?;
        let state = serde_json::from_str(&json).map_err(|e| format!("restore: {e}"))?;
        let restored = Replica::from_state(state);
        if restored.view() != replica.view() || restored.status() != replica.status() {
            return Err("reloaded replica differs from the one persisted".into());
        }
        **replica = restored;
        self.stats.reloads += 1;
        let name = self.clients[i].name.clone();
        self.log(format!("{name}: reload from persisted state"));
        Ok(())
    }

    /// The tab clears its storage (only with nothing pending: clearing unsynced work loses it, by
    /// the user's choice) and joins again as a new client, from a snapshot of the board, as the
    /// server sends one (spec §5): the board at a log position the room took it at, the current
    /// one or up to a few entries stale, and hello from there. Entries after it come as catch-up.
    fn fresh_join(&mut self, i: usize) -> Result<(), String> {
        let Driver::Replica { replica, .. } = &self.clients[i].driver else { return Ok(()) };
        if replica.pending().next().is_some() {
            return Ok(());
        }
        self.disconnect(i);
        let len = self.authority.log_len();
        let seq = len.saturating_sub(self.rng.random_range(0..=3));
        let doc = if seq == len { self.authority.doc().clone() } else { self.oracle.at(seq).cloned().ok_or("no oracle state")? };
        let id = ClientId(self.rng.random());
        let secret = format!("{:032x}", self.rng.random::<u128>());
        if let Driver::Replica { replica, .. } = &mut self.clients[i].driver {
            **replica = Replica::new(id, secret, doc, seq);
        }
        self.stats.fresh_joins += 1;
        let name = self.clients[i].name.clone();
        self.log(format!("{name}: cleared storage; joins fresh from a snapshot at {seq} of {len}"));
        self.reconnect(i);
        Ok(())
    }

    pub(crate) fn reconnect(&mut self, i: usize) {
        if self.clients[i].conn.is_some() {
            return;
        }
        let conn = ConnId(self.next_conn);
        self.next_conn += 1;
        let role = self.clients[i].role;
        self.authority.connect(conn, role);
        let c = &mut self.clients[i];
        c.conn = Some(conn);
        c.up.clear();
        c.down.clear();
        match &mut c.driver {
            Driver::Replica { replica, .. } => c.up.extend(replica.connect()),
            Driver::Attacker { client, next_cseq, secret } => {
                c.up.push_back(ClientMsg::Hello(mapcro_engine::Hello {
                    client: *client,
                    secret: secret.clone(),
                    last_seq: 0,
                    pending_from: *next_cseq,
                }));
            }
        }
        let name = self.clients[i].name.clone();
        self.log(format!("{name}: connect {conn:?}"));
    }

    /// The client does something locally (edit, undo, redo, or an attack).
    fn act(&mut self, i: usize) -> Result<(), String> {
        behaviour::act(self, i)
    }

    fn deliver_up(&mut self, i: usize) -> Result<(), String> {
        let Some(conn) = self.clients[i].conn else { return Ok(()) };
        let Some(msg) = self.clients[i].up.pop_front() else { return Ok(()) };
        let before = self.authority.doc().clone();
        let log_before = self.stored_log.len();
        let label = describe_client_msg(&msg);
        let (out, effects) = self.authority.handle(conn, msg);
        for effect in effects {
            match effect {
                Effect::Rejected { client, cseq, reason } => self.stored_rejections.push((client, cseq, reason)),
                Effect::ClientRegistered { client, secret_hash } => self.stored_clients.push((client, secret_hash)),
                Effect::RejectionsResolved { client, below } => {
                    self.stored_rejections.retain(|(c, k, _)| *c != client || *k >= below);
                }
                Effect::Logged { seq, tx } => {
                    if seq != self.stored_log.len() as u64 + 1 {
                        return Err(format!("logged seq {seq} after {}", self.stored_log.len()));
                    }
                    self.stored_log.push(tx);
                }
            }
        }
        let name = self.clients[i].name.clone();
        self.log(format!("server <- {name}: {label}"));

        // New log entries: feed the oracle and run the undo check.
        if self.authority.log_len() != self.stored_log.len() as u64 {
            return Err("the authority's log length differs from what it reported logging".into());
        }
        let new: Vec<Tx> = self.stored_log[log_before..].to_vec();
        for tx in &new {
            self.oracle.append(tx)?;
            self.stats.undo_fields_checked += checks::check_undo_did_not_clobber(&before, self.authority.doc(), tx, &self.stored_log)?;
        }
        if self.oracle.head() != self.authority.doc() {
            return Err("authority state differs from replaying its own log".into());
        }

        // A catch-up range is the log entries it names, delivered in its place (the server
        // streams them; here the link is a queue, so expanding them is the same thing).
        let log = &self.stored_log;
        let out: Vec<(ConnId, ServerMsg)> = out
            .into_iter()
            .flat_map(|(to, o)| match o {
                Outgoing::Msg(m) => vec![(to, m)],
                Outgoing::CatchUp { from, to: last } => {
                    (from..=last).map(|seq| (to, ServerMsg::Entry { seq, tx: log[seq as usize - 1].clone() })).collect()
                }
            })
            .collect();
        for (to, msg) in out {
            let Some(j) = self.clients.iter().position(|c| c.conn == Some(to)) else { continue };
            if let ServerMsg::Fatal(why) = &msg {
                let is_attacker = matches!(self.clients[j].driver, Driver::Attacker { .. });
                if !is_attacker {
                    return Err(format!("server sent Fatal to honest client {}: {why}", self.clients[j].name));
                }
                // The authority already forgot the connection; mirror that.
                self.clients[j].conn = None;
                self.clients[j].up.clear();
                self.clients[j].down.clear();
                let n = self.clients[j].name.clone();
                self.log(format!("{n}: fatal ({why})"));
                continue;
            }
            self.clients[j].down.push_back(msg);
        }
        Ok(())
    }

    fn deliver_down(&mut self, i: usize) -> Result<(), String> {
        let Some(msg) = self.clients[i].down.pop_front() else { return Ok(()) };
        let label = describe_server_msg(&msg);
        let name = self.clients[i].name.clone();
        let is_editor = self.clients[i].role == Role::Edit;
        self.log(format!("{name} <- server: {label}"));
        match &mut self.clients[i].driver {
            Driver::Replica { replica, .. } => {
                if let ServerMsg::Rejected { .. } = msg {
                    self.stats.rejected += 1;
                    if is_editor {
                        self.stats.editor_rejected += 1;
                    }
                }
                replica.receive(msg).map_err(|e| format!("{name}: protocol error: {e}"))
            }
            Driver::Attacker { .. } => Ok(()),
        }
    }

    /// Reconnect everyone and deliver until nothing is in flight.
    fn quiesce(&mut self) -> Result<(), String> {
        self.log("--- quiesce ---");
        for i in 0..self.clients.len() {
            if matches!(self.clients[i].driver, Driver::Replica { .. }) {
                self.reconnect(i);
            }
        }
        for _round in 0..10_000 {
            let mut moved = false;
            for i in 0..self.clients.len() {
                if !self.clients[i].up.is_empty() {
                    self.deliver_up(i)?;
                    moved = true;
                }
                if !self.clients[i].down.is_empty() {
                    self.deliver_down(i)?;
                    moved = true;
                }
            }
            if !moved {
                return Ok(());
            }
            // Honest clients that were thrown off (e.g. superseded) come back; attackers that
            // were cut off stay off.
            for i in 0..self.clients.len() {
                if matches!(self.clients[i].driver, Driver::Replica { .. }) {
                    self.reconnect(i);
                }
            }
        }
        Err("did not quiesce".into())
    }
}

fn describe_client_msg(m: &ClientMsg) -> String {
    match m {
        ClientMsg::Hello(h) => format!("hello(last_seq {}, pending_from {})", h.last_seq, h.pending_from),
        ClientMsg::Submit(tx) => format!("submit #{} {:?} {} ops", tx.cseq, tx.kind, tx.ops.len()),
    }
}

fn describe_server_msg(m: &ServerMsg) -> String {
    match m {
        ServerMsg::Entry { seq, tx } => format!("entry [{seq}] {:?}#{} {:?}", tx.client, tx.cseq, tx.kind),
        ServerMsg::Rejected { cseq, reason } => format!("rejected #{cseq}: {reason}"),
        ServerMsg::Fatal(w) => format!("fatal: {w}"),
    }
}
