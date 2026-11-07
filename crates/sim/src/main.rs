//! `mapcro-sim [--seed N] [--seeds COUNT] [--steps N]`: run the sync simulation.

use mapcro_sim::{Config, run};
use std::process::ExitCode;

fn parse_u64(s: &str) -> Option<u64> {
    s.strip_prefix("0x").map_or_else(|| s.parse().ok(), |h| u64::from_str_radix(h, 16).ok())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut config = Config::default();
    let mut seeds: Vec<u64> = (0..1000).collect();
    let mut i = 0;
    while i < args.len() {
        let value = args.get(i + 1).and_then(|v| parse_u64(v));
        match (args[i].as_str(), value) {
            ("--seed", Some(s)) => seeds = vec![s],
            ("--seeds", Some(n)) => {
                let start = seeds.first().copied().unwrap_or(0);
                seeds = (start..start + n).collect();
            }
            ("--from", Some(s)) => {
                let n = seeds.len() as u64;
                seeds = (s..s + n).collect();
            }
            ("--steps", Some(n)) => config.steps = n as usize,
            _ => {
                eprintln!("usage: mapcro-sim [--seed N | --seeds COUNT [--from N]] [--steps N]");
                return ExitCode::from(2);
            }
        }
        i += 2;
    }

    let started = std::time::Instant::now();
    let (mut entries, mut undo_checks, mut rejected, mut editor_rejected, mut drops, mut restarts, mut reloads) = (0, 0, 0, 0, 0, 0, 0);
    for &seed in &seeds {
        match run(seed, &config) {
            Ok(s) => {
                entries += s.log_len;
                undo_checks += s.undo_fields_checked;
                rejected += s.rejected;
                editor_rejected += s.editor_rejected;
                drops += s.disconnects;
                restarts += s.server_restarts;
                reloads += s.reloads;
            }
            Err(f) => {
                eprintln!("{f}");
                return ExitCode::FAILURE;
            }
        }
    }
    println!(
        "ok: {} seeds × {} steps in {:.1?} ({entries} log entries, {undo_checks} undo field checks, {rejected} rejections of which {editor_rejected} editor conflicts, {drops} disconnects, {restarts} server restarts, {reloads} tab reloads)",
        seeds.len(),
        config.steps,
        started.elapsed()
    );
    ExitCode::SUCCESS
}
