//! The protocol build id: a hash of the schema's and the engine's sources. The server and the
//! browser's WASM are built from them, so a tab whose WASM is from another build than the
//! server's can be told to reload (review 2026-11-07: tabs open across a deploy got stuck on
//! records they couldn't read).

use std::fs;
use std::path::{Path, PathBuf};

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

fn main() {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let dirs = [root.join("src"), root.join("../engine/src")];
    let mut all = Vec::new();
    for d in &dirs {
        println!("cargo:rerun-if-changed={}", d.display());
        files(d, &mut all);
    }
    all.sort();
    // FNV-1a, 64 bits, over each file's path (relative) and bytes.
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |b: &[u8]| {
        for x in b {
            h ^= u64::from(*x);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    for f in &all {
        eat(f.strip_prefix(&root).unwrap_or(f).to_string_lossy().as_bytes());
        eat(&fs::read(f).unwrap_or_default());
    }
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("out dir")).join("build_id.rs");
    fs::write(out, format!("/// The protocol build: see build.rs.\npub const BUILD_ID: &str = \"{h:016x}\";\n")).expect("write build id");
}
