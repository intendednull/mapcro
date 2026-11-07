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
use mapcro_engine::{Authority, ClientMsg, ConnId, Replica, Role, ServerMsg};
use mapcro_schema::{ClientId, Doc, RecordId, Tx, genesis};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use std::collections::VecDeque;
use std::fmt::Write as _;

#[derive(Clone, Debug)]
pub struct Config {
    /// Honest editing clients (each with a behaviour).
    pub editors: usize,
    /// Clients holding a view-only link who still try to edit (the server must refuse).
    pub viewers: usize,
    /// Raw clients that send hand-crafted, mostly invalid transactions.
    pub attackers: usize,
    pub steps: usize,
    /// Percent chance per step of a connection fault on some client.
    pub fault_rate: u32,
}

impl Default for Config {
    fn default() -> Self {
        Config { editors: 3, viewers: 1, attackers: 1, steps: 400, fault_rate: 4 }
    }
}

#[derive(Debug, Default, Clone)]
pub struct Stats {
    pub log_len: usize,
    pub edits: usize,
    pub undos: usize,
    pub rejected: usize,
    pub disconnects: usize,
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
    Attacker { client: ClientId, next_cseq: u64 },
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
}

pub fn run(seed: u64, config: &Config) -> Result<Stats, Failure> {
    let mut world = World::new(seed, config);
    for step in 0..config.steps {
        world.step = step;
        world.random_step(config).map_err(|m| world.fail(m))?;
        world.check_step().map_err(|m| world.fail(m))?;
    }
    world.step = config.steps;
    world.quiesce().map_err(|m| world.fail(m))?;
    world.check_quiescent().map_err(|m| world.fail(m))?;
    world.stats.log_len = world.authority.log().len();
    Ok(world.stats)
}

impl World {
    fn new(seed: u64, config: &Config) -> World {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let doc: Doc = genesis(|| RecordId(rng.random()), "Sim board");
        let mut clients = Vec::new();
        for i in 0..config.editors {
            let behaviour = Behaviour::for_index(i);
            let replica = Replica::new(ClientId(rng.random()), doc.clone(), 0);
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
            let replica = Replica::new(ClientId(rng.random()), doc.clone(), 0);
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
            clients.push(SimClient {
                name: format!("x{i}"),
                role: Role::Edit,
                driver: Driver::Attacker { client: ClientId(rng.random()), next_cseq: 0 },
                conn: None,
                up: VecDeque::new(),
                down: VecDeque::new(),
            });
        }
        let mut world = World {
            seed,
            rng,
            oracle: checks::Oracle::new(doc.clone()),
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
            Driver::Attacker { client, next_cseq } => {
                c.up.push_back(ClientMsg::Hello(mapcro_engine::Hello {
                    client: *client,
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
        let log_before = self.authority.log().len();
        let label = describe_client_msg(&msg);
        let out = self.authority.handle(conn, msg);
        let name = self.clients[i].name.clone();
        self.log(format!("server <- {name}: {label}"));

        // New log entries: feed the oracle and run the undo check.
        let new: Vec<Tx> = self.authority.log()[log_before..].to_vec();
        for tx in &new {
            self.oracle.append(tx)?;
            self.stats.undo_fields_checked += checks::check_undo_did_not_clobber(&before, self.authority.doc(), tx, self.authority.log())?;
        }
        if self.oracle.head() != self.authority.doc() {
            return Err("authority state differs from replaying its own log".into());
        }

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
        self.log(format!("{name} <- server: {label}"));
        match &mut self.clients[i].driver {
            Driver::Replica { replica, .. } => {
                if let ServerMsg::Rejected { .. } = msg {
                    self.stats.rejected += 1;
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
            self.reconnect(i);
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
            // An attacker that got itself disconnected comes back, so its queue drains too.
            for i in 0..self.clients.len() {
                self.reconnect(i);
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
