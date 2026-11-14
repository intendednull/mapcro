//! `load_stored <dir> [seeds]`: load what `dump_stored` wrote. `just reader-check` builds this
//! file in a checkout of the reader release (the build a rollback goes to), so it uses only
//! what that build has: every board's genesis parses and validates, every logged transaction
//! parses and replays, the board they give is byte for byte the writer's, and that board (a
//! compacted base) parses and validates. A stored shape the reader can't load fails here, not
//! on a rollback.
use mapcro_schema::{Doc, Tx, apply_tx, validate_doc};

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args.next().expect("usage: load_stored <dir> [seeds]");
    let seeds: u64 = args.next().map_or(40, |n| n.parse().expect("seeds"));
    let (mut boards, mut txs) = (0, 0);
    for seed in 0..seeds {
        let read = |what: &str| std::fs::read_to_string(format!("{dir}/{seed}.{what}")).expect("read");
        let mut doc: Doc = serde_json::from_str(&read("genesis.json")).expect("genesis parses");
        validate_doc(&doc).expect("genesis valid");
        for (i, line) in read("log.jsonl").lines().enumerate() {
            let tx: Tx = serde_json::from_str(line).unwrap_or_else(|e| panic!("seed {seed} entry {i} does not parse on the reader: {e}"));
            apply_tx(&mut doc, &tx).unwrap_or_else(|r| panic!("seed {seed} entry {i} does not replay on the reader: {r}"));
            txs += 1;
        }
        let last = read("final.json");
        assert_eq!(serde_json::to_string(&doc).expect("json"), last, "seed {seed}: the reader reads another board");
        let base: Doc = serde_json::from_str(&last).expect("the board as a base parses");
        validate_doc(&base).expect("the board as a base is valid");
        boards += 1;
    }
    println!("the reader loaded {boards} boards, {txs} logged transactions, byte for byte");
}
