//! Train the server's storage dictionary (`just zdict`): `train_dict <out> [seeds]`.
//!
//! Samples are what the server stores, one row each: every logged transaction's JSON from a run
//! of simulation seeds, plus each run's genesis document. Deterministic: the same seeds give the
//! same simulation, and zstd's trainer is single-threaded, so the output is byte-for-byte
//! reproducible. A new dictionary is a new codec (`zstd-v2`), never a replacement for `v1`:
//! stored rows name the dictionary they were written with.

use mapcro_sim::{Config, run_logged};

/// The dictionary's size: small next to a board, big enough to hold every field name and the
/// common record shapes.
const DICT_BYTES: usize = 16 * 1024;

fn main() {
    let mut args = std::env::args().skip(1);
    let out = args.next().expect("usage: train_dict <out> [seeds]");
    let seeds: u64 = args.next().map(|s| s.parse().expect("seeds")).unwrap_or(300);
    let config = Config::default();
    let mut samples: Vec<Vec<u8>> = Vec::new();
    for seed in 0..seeds {
        let (_, genesis, log) = run_logged(seed, &config).unwrap_or_else(|f| panic!("seed {seed} failed: {f}"));
        samples.push(serde_json::to_vec(&genesis).expect("json"));
        samples.extend(log.iter().map(|tx| serde_json::to_vec(tx).expect("json")));
    }
    let dict = zstd::dict::from_samples(&samples, DICT_BYTES).expect("train");
    std::fs::write(&out, &dict).expect("write");
    let total: usize = samples.iter().map(Vec::len).sum();
    println!("{out}: {} bytes from {} samples ({total} bytes) over {seeds} seeds", dict.len(), samples.len());
}
