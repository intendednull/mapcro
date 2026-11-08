//! mapcro-replay: the replay worker (spec §6a). Runs as its own sandboxed service, never inside
//! the board server.
//!
//! - `mapcro-replay work <dir> [--once]`: serve the queue under `<dir>` (inbox, outbox, work).
//! - `mapcro-replay parse <demo> <out.json> [match id]`: one demo to a timeline, in-process.
//! - `mapcro-replay job …`: one queued job, in the child the worker spawns (internal).
//!
//! Environment for `work`: `REPLAY_JOB_TIMEOUT_S` (300), `REPLAY_MAX_DEM_BYTES` (1 GiB),
//! `REPLAY_WORKERS` (2: jobs parsed at once, each in its own child).

use mapcro_replay::worker;
use std::path::Path;
use std::time::Duration;

fn num(key: &str, default: u64) -> u64 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |i: usize| args.get(i).map(String::as_str);
    match arg(1) {
        Some("work") if args.len() >= 3 => {
            let d = worker::Limits::default();
            let limits = worker::Limits {
                timeout: Duration::from_secs(num("REPLAY_JOB_TIMEOUT_S", d.timeout.as_secs())),
                max_dem_bytes: num("REPLAY_MAX_DEM_BYTES", d.max_dem_bytes),
                workers: num("REPLAY_WORKERS", d.workers as u64).max(1) as usize,
            };
            if let Err(e) = worker::serve(Path::new(&args[2]), &limits, arg(3) == Some("--once")) {
                eprintln!("mapcro-replay: {e}");
                std::process::exit(2);
            }
        }
        Some("job") if args.len() == 6 => {
            let (Ok(id), Ok(max)) = (args[4].parse(), args[5].parse()) else { std::process::exit(2) };
            match worker::job(Path::new(&args[2]), Path::new(&args[3]), id, max) {
                Ok(()) => {}
                Err(why) => {
                    println!("{why}");
                    std::process::exit(1);
                }
            }
        }
        Some("parse") if args.len() >= 4 => {
            let id = arg(4).and_then(|s| s.parse().ok()).unwrap_or(0);
            match worker::job(Path::new(&args[2]), Path::new(&args[3]), id, worker::Limits::default().max_dem_bytes) {
                Ok(()) => {}
                Err(why) => {
                    eprintln!("mapcro-replay: {why}");
                    std::process::exit(1);
                }
            }
        }
        _ => {
            eprintln!("usage: mapcro-replay work <dir> [--once] | parse <demo> <out.json> [match id]");
            std::process::exit(2);
        }
    }
}
