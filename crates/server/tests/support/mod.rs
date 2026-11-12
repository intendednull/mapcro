//! Starting the real server binary for a test, on a port of its own.
//!
//! The server is given `PORT=0` (and `METRICS_ADDR=127.0.0.1:0` when it has metrics), binds a
//! free port itself, and says which on stderr (`mapcro-server: listening on …`). The test waits
//! for that line from its own child: then the port is the child's and connections queue.
//!
//! Picking a free port in the test and handing it over raced on a busy box: the port was free
//! when the test looked and taken by the time the child bound it (by another test's server, or
//! by any outbound connection's local port), so the child died of `cannot bind` while the health
//! poll waited it out ("server never became healthy") or, worse, was answered by the other
//! test's server, which then went away mid-test (backlog, 2026-11-09).

#![allow(dead_code)] // each test binary uses its own part of this

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

/// How long a spawned server may take to bind. It is a few milliseconds on a quiet box; this
/// only bounds a server that hangs. Waiting is on the child's own word, never a poll, so the
/// length costs nothing when the server is up.
pub const READY_WITHIN: Duration = Duration::from_secs(60);

pub struct Started {
    pub child: Child,
    pub port: u16,
    /// The `/metrics` listener's port, if the server was given `METRICS_ADDR`.
    pub metrics: Option<u16>,
    /// Everything the child has written to stderr (it is also echoed to the test's own).
    pub stderr: Arc<Mutex<String>>,
}

/// The child exited before it listened.
pub struct Exited {
    pub status: ExitStatus,
    pub stderr: String,
}

impl Exited {
    pub fn bind_failed(&self) -> bool {
        self.stderr.contains("cannot bind")
    }
}

/// The server binary, ready for its env. `PORT` is 0 unless the caller sets it again.
pub fn server() -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_mapcro-server"));
    cmd.env("PORT", "0");
    cmd
}

/// Spawn `cmd` (from [`server`]) with stderr piped, and wait until it says where it listens.
/// Panics if that takes longer than [`READY_WITHIN`].
pub fn start(mut cmd: Command) -> Result<Started, Exited> {
    let mut child = cmd.stderr(Stdio::piped()).spawn().expect("server starts");
    let pipe = child.stderr.take().expect("piped stderr");
    let stderr = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&stderr);
    let (tx, rx) = mpsc::channel();
    // Drains the pipe for the child's whole life, or a chatty server would block on it.
    std::thread::spawn(move || {
        let mut pipe = BufReader::new(pipe);
        let mut line = Vec::new();
        let mut metrics = None;
        while matches!(pipe.read_until(b'\n', &mut line), Ok(n) if n > 0) {
            let text = String::from_utf8_lossy(&line).into_owned();
            eprint!("{text}");
            sink.lock().unwrap_or_else(|e| e.into_inner()).push_str(&text);
            if let Some(p) = port_after(&text, "mapcro-server: metrics on ") {
                metrics = Some(p);
            }
            if let Some(p) = port_after(&text, "mapcro-server: listening on ") {
                let _ = tx.send((p, metrics));
            }
            line.clear();
        }
        // Dropping `tx` here tells the waiter the child is gone.
    });
    match rx.recv_timeout(READY_WITHIN) {
        Ok((port, metrics)) => Ok(Started { child, port, metrics, stderr }),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            // stderr closed: the child exited (or is about to).
            let status = child.wait().expect("wait");
            let stderr = stderr.lock().unwrap_or_else(|e| e.into_inner()).clone();
            Err(Exited { status, stderr })
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            let text = stderr.lock().unwrap_or_else(|e| e.into_inner()).clone();
            panic!("mapcro-server did not listen within {READY_WITHIN:?}: {}", text.trim_end());
        }
    }
}

/// [`start`], where any early exit is the test's failure.
pub fn start_or_panic(cmd: Command) -> Started {
    match start(cmd) {
        Ok(s) => s,
        Err(e) => panic!("mapcro-server exited before listening ({}): {}", e.status, e.stderr.trim_end()),
    }
}

fn port_after(line: &str, prefix: &str) -> Option<u16> {
    let addr: std::net::SocketAddr = line.trim_end().strip_prefix(prefix)?.parse().ok()?;
    Some(addr.port())
}

/// A port nothing listens on, for a dependency that should be unreachable. (Not for a server
/// to bind: that is [`start`]'s job.)
pub fn dead_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).expect("port")
}

/// The largest board a file may make (`boardfile::MAX_BYTES`, the snapshot cap).
pub const BOARD_FILE_MAX: usize = 8 * 1024 * 1024;

/// A stroke of the most points, all at a corner: the most JSON a stroke can be.
pub fn heavy_stroke(scene: mapcro_schema::RecordId) -> mapcro_schema::Record {
    let corner = mapcro_schema::WorldPos { x: -mapcro_schema::LIMITS.max_coord, y: -mapcro_schema::LIMITS.max_coord };
    mapcro_schema::Record::Stroke(mapcro_schema::Stroke { scene, points: vec![corner; mapcro_schema::LIMITS.max_stroke_points], color: 0, width: 10, offset: mapcro_schema::WorldPos::default() })
}

/// A board file whose board, as the server holds it (the document's JSON), is within one stroke
/// under `BOARD_FILE_MAX - margin`: genesis and heavy strokes in its scene.
pub fn large_board_file(margin: usize) -> serde_json::Value {
    use mapcro_schema::{Doc, Op, Record, RecordId, Tx, TxKind};
    let mut n = 0u128;
    let mut doc = mapcro_schema::genesis(
        || {
            n += 1;
            RecordId(n)
        },
        "Large",
    );
    let scene = doc.iter_live().find(|(_, r)| matches!(r, Record::Scene(_))).map(|(id, _)| id).expect("scene");
    let add = |doc: &mut Doc, i: u128| {
        let tx = Tx { client: mapcro_schema::ClientId(1), cseq: 0, kind: TxKind::Edit, ops: vec![Op::Create { id: RecordId(10_000 + i), record: heavy_stroke(scene) }] };
        mapcro_schema::apply_tx(doc, &tx).expect("a stroke");
    };
    let len = |doc: &Doc| serde_json::to_vec(doc).expect("json").len();
    add(&mut doc, 0);
    let one = len(&doc);
    add(&mut doc, 1);
    let each = len(&doc) - one;
    let target = BOARD_FILE_MAX - margin;
    for i in 2..(1 + (target - one) / each) as u128 {
        add(&mut doc, i);
    }
    assert!(len(&doc) <= target && len(&doc) + each > target, "{} of {target}", len(&doc));
    serde_json::json!({ "format": "mapcro-board", "version": 1, "build": "test", "exported_at": 0, "records": mapcro_schema::export_records(&doc), "matches": [] })
}
