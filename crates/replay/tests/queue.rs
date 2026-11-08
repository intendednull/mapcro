//! The worker binary on its queue, with tiny synthetic demos (a real one can't be committed):
//! each job ends done or failed with a reason, and its demo is gone either way.

use std::io::Write;
use std::path::Path;
use std::process::Command;

fn queue() -> tempfile::TempDir {
    let d = tempfile::tempdir().expect("dir");
    for s in ["inbox", "outbox", "work"] {
        std::fs::create_dir(d.path().join(s)).expect("mkdir");
    }
    d
}

fn files(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).expect("dir").flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

fn varint(mut n: usize, out: &mut Vec<u8>) {
    while n >= 0x80 {
        out.push((n as u8) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

/// A demo that is only a header (`DEM_FileHeader` with a game directory) and a stop.
fn header_only(game_directory: &str) -> Vec<u8> {
    let mut msg = vec![0x0A, 1, b'x']; // demo_file_stamp
    msg.push(0x32); // game_directory, field 6
    varint(game_directory.len(), &mut msg);
    msg.extend_from_slice(game_directory.as_bytes());
    let mut out = mapcro_replay::DEM_MAGIC.to_vec();
    out.extend_from_slice(&[0; 8]);
    out.extend_from_slice(&[1, 0]); // DEM_FileHeader at tick 0
    varint(msg.len(), &mut out);
    out.extend_from_slice(&msg);
    out.extend_from_slice(&[0, 0, 0]); // DEM_Stop
    out
}

fn run(q: &Path, env: &[(&str, &str)]) {
    let ok = Command::new(env!("CARGO_BIN_EXE_mapcro-replay")).arg("work").arg(q).arg("--once").envs(env.iter().copied()).status().expect("runs").success();
    assert!(ok);
}

#[test]
fn jobs_fail_with_their_reason_and_their_demos_go() {
    let q = queue();
    let p = q.path();
    std::fs::write(p.join("inbox/100747544-cdn.dem"), header_only("/srv/citadel_v6683/game/citadel")).expect("old");
    std::fs::write(p.join("inbox/2-aaaaaaaaaaaaaaaa.dem"), header_only("/srv/citadel_v6813/game/citadel")).expect("current, but empty");
    std::fs::write(p.join("inbox/3-cdn.dem"), b"PBDEMS2\0garbage that is not a demo").expect("junk");
    std::fs::write(p.join("inbox/4-cdn.dem"), header_only("/srv/csgo/")).expect("another game");
    let mut bz = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
    bz.write_all(&header_only("citadel_v6700")).expect("bz2");
    std::fs::write(p.join("inbox/5-cdn.bz2"), bz.finish().expect("bz2")).expect("old, compressed");
    // Not a job name: left alone, never run.
    std::fs::write(p.join("inbox/.6-cdn.part"), b"partial").expect("partial");
    run(p, &[]);
    let reason = |job: &str| std::fs::read_to_string(p.join("outbox").join(format!("{job}.failed"))).unwrap_or_default();
    assert_eq!(reason("100747544-cdn"), "old_map");
    assert!(["parse_failed", "not_a_replay"].contains(&reason("2-aaaaaaaaaaaaaaaa").as_str()), "{}", reason("2-aaaaaaaaaaaaaaaa"));
    assert_eq!(reason("3-cdn"), "not_a_replay");
    assert_eq!(reason("4-cdn"), "not_a_replay");
    assert_eq!(reason("5-cdn"), "old_map");
    // The worker only reads the inbox (the server deletes a job's file when it collects it);
    // its own scratch is empty, and only results are in its outbox.
    assert_eq!(files(&p.join("inbox")).len(), 6);
    assert!(files(&p.join("work")).is_empty(), "every expanded demo is deleted when its parse ends");
    assert!(files(&p.join("outbox")).iter().all(|f| f.ends_with(".failed")), "{:?}", files(&p.join("outbox")));
    // A second run doesn't redo jobs whose results wait for the server.
    let before: Vec<_> = files(&p.join("outbox"));
    run(p, &[]);
    assert_eq!(files(&p.join("outbox")), before);
}

#[test]
fn a_job_over_its_limits_fails_and_a_crashed_run_is_recovered() {
    let q = queue();
    let p = q.path();
    let mut bz = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
    bz.write_all(&vec![7u8; 100_000]).expect("bz2");
    std::fs::write(p.join("inbox/1-cdn.bz2"), bz.finish().expect("bz2")).expect("bomb");
    // Left over from a worker that died mid-parse.
    std::fs::write(p.join("work/2-cdn.dem"), b"PBDEMS2\0").expect("left over");
    std::fs::write(p.join("outbox/2-cdn.parsing"), b"").expect("marker");
    run(p, &[("REPLAY_MAX_DEM_BYTES", "1000")]);
    assert_eq!(std::fs::read_to_string(p.join("outbox/1-cdn.failed")).expect("failed"), "too_large");
    assert_eq!(std::fs::read_to_string(p.join("outbox/2-cdn.failed")).expect("recovered"), "parse_failed");
    assert!(files(&p.join("work")).is_empty());
    assert!(!p.join("outbox/2-cdn.parsing").exists());
}

#[test]
fn a_job_past_its_wall_clock_is_killed() {
    let q = queue();
    let p = q.path();
    std::fs::write(p.join("inbox/1-cdn.dem"), header_only("citadel_v6813")).expect("job");
    run(p, &[("REPLAY_JOB_TIMEOUT_S", "0")]);
    assert_eq!(std::fs::read_to_string(p.join("outbox/1-cdn.failed")).expect("failed"), "timeout");
    assert!(files(&p.join("work")).is_empty());
}
