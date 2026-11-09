//! Timer audit: walk every entity class and field of one replay, and every message, for state
//! that counts to (or from) a time. Read-only exploration (docs/research/replay-timers-audit.md);
//! rerun after a game patch to spot new timers.
//!
//! `cargo run -p mapcro-replay --release --example timer_audit -- <replay.dem> [out dir]`
//!
//! Writes, to the out dir (default `/tmp/mapcro-timer-audit`):
//! - `fields.tsv`: every numeric field (class, path with array indices as `#`, type), with its
//!   samples, changes and how its values sit against the clocks;
//! - `candidates.tsv`: the subset that looks like a timer, by name, by type or by value;
//! - `changes.tsv`: every change of a name- or type-flagged field, tick resolution (capped per
//!   field), as match-clock seconds;
//! - `grid.tsv`: those fields' non-zero values every 10 s of match clock;
//! - `messages.tsv`: every user message and game event type, its count, its field names, and
//!   timer-named numeric fields' sample values.
//!
//! `… -- <replay.dem> <out dir> --messages 347,349,350` instead dumps those message types'
//! decoded text by tick to `messages-detail.tsv` (events only: about a minute).
//!
//! Ids: U64 values (Steam ids) and any field named like steam / account / xuid are never read,
//! and strings are skipped; message examples keep only timer-named numbers.

use boon::entity::field_path::FieldPath;
use boon::{FieldValue, Parser, Serializer};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::{Path, PathBuf};

const RULES: &str = "CCitadelGameRulesProxy";
/// Changes logged per field (normalised path) at most.
const CHANGE_CAP: usize = 3000;
/// How far ahead (or back) of a clock a value may sit to count as "on that clock", seconds.
const HORIZON: f64 = 1800.0;

/// One field (class + normalised path) and what we've seen of it.
struct Field {
    class: String,
    path: String,
    ty: String,
    /// Named like a timer.
    name_hit: bool,
    /// Typed like one (`GameTime_t`, `GameTick_t`, a countdown timer).
    type_hit: bool,
    samples: u64,
    nonzero: u64,
    /// `now` < v ≤ `now` + horizon, on the server's `GameTime_t` clock.
    fut_gt: u64,
    /// `now` − horizon ≤ v ≤ `now`, on that clock.
    past_gt: u64,
    /// match clock < v ≤ match clock + horizon (and v > 60, so small constants don't count).
    fut_game: u64,
    /// For integers: tick < v ≤ tick + horizon in ticks (a `GameTick_t`).
    fut_tick: u64,
    changes: u64,
    logged: usize,
    instances: HashSet<i32>,
    min: f64,
    max: f64,
    /// The first distinct values, as (match clock, entity index, value).
    examples: Vec<(f32, i32, f64)>,
}

impl Field {
    fn flagged(&self) -> bool {
        self.name_hit || self.type_hit
    }

    /// Looks like a time by its values alone.
    fn clock_like(&self) -> Option<&'static str> {
        if self.nonzero < 3 || self.changes < 2 || self.max < 100.0 {
            return None;
        }
        let nz = self.nonzero as f64;
        if (self.fut_gt + self.past_gt) as f64 / nz > 0.8 {
            Some(if self.fut_gt > self.past_gt { "gametime-future" } else { "gametime-past" })
        } else if self.fut_tick as f64 / nz > 0.8 {
            Some("tick-future")
        } else if self.fut_game as f64 / nz > 0.8 {
            Some("matchclock-future")
        } else {
            None
        }
    }
}

const NAME_PREFIX: [&str; 8] = ["time", "respawn", "spawn", "cooldown", "duration", "delay", "tick", "expir"];
const NAME_EXACT: [&str; 9] = ["next", "end", "ends", "ended", "start", "starts", "started", "until", "t"];

/// The words of a field path: `m_flUltimateCooldownEnd` → m, fl, ultimate, cooldown, end.
fn words(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    for seg in path.split(['.', '_']) {
        let mut w = String::new();
        let mut prev_lower = false;
        for c in seg.chars() {
            if c.is_ascii_uppercase() && prev_lower && !w.is_empty() {
                out.push(std::mem::take(&mut w));
            }
            prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
            w.push(c.to_ascii_lowercase());
        }
        if !w.is_empty() {
            out.push(w);
        }
    }
    out
}

fn name_hit(path: &str) -> bool {
    // `m_t…` is the game's prefix for a GameTime_t; a bare "t" word elsewhere isn't.
    let ws = words(path);
    ws.iter().enumerate().any(|(i, w)| {
        NAME_PREFIX.iter().any(|p| w.starts_with(p)) || (NAME_EXACT.contains(&w.as_str()) && (w != "t" || (i > 0 && ws[i - 1] == "m")))
    })
}

fn private(path: &str) -> bool {
    let l = path.to_ascii_lowercase();
    ["steam", "account", "xuid"].iter().any(|s| l.contains(s))
}

/// The normalised path (array indices as `#`) and leaf type of a packed field key.
fn describe(ser: &Serializer, key: u64) -> Option<(String, String)> {
    let fp = FieldPath::unpack(key);
    let idx = fp.data.get(..=fp.last)?;
    let mut name = String::new();
    let mut f = ser.fields.get(usize::try_from(idx[0]).ok()?)?;
    let push = |name: &mut String, f: &boon::SerializerField| {
        if let Some(node) = f.send_node.as_deref().filter(|n| !n.is_empty()) {
            name.push_str(node);
            name.push('.');
        }
        name.push_str(&f.var_name);
    };
    push(&mut name, f);
    let mut ty = f.var_type.clone();
    for &i in &idx[1..] {
        if f.is_dynamic_array() {
            name.push_str(".#");
            match f.field_serializer.as_ref() {
                Some(fs) => f = fs.fields.first()?,
                None => break,
            }
        } else if let Some(fs) = f.field_serializer.as_ref() {
            f = fs.fields.get(usize::try_from(i).ok()?)?;
            name.push('.');
            push(&mut name, f);
            ty = f.var_type.clone();
        } else {
            name.push_str(".#");
            break;
        }
    }
    Some((name, ty))
}

fn num(v: &FieldValue) -> Option<f64> {
    match v {
        FieldValue::F32(x) => Some(f64::from(*x)),
        FieldValue::I32(x) => Some(f64::from(*x)),
        FieldValue::U32(x) => Some(f64::from(*x)),
        FieldValue::I64(x) => Some(*x as f64),
        // U64 is where Steam ids live; strings, vectors and bools aren't times.
        _ => None,
    }
}

#[derive(Default)]
struct Msg {
    name: String,
    count: u64,
    first: f32,
    last: f32,
    keys: BTreeMap<String, ()>,
    examples: Vec<String>,
}

/// `name: value` pairs out of a message's debug text (proto field names are snake_case).
fn pairs(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_alphabetic() || b[i] == b'_' {
            let s = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            if text[i..].starts_with(": ") {
                let key = text[s..i].to_string();
                // Pretty-printed: `Some(\n    1.5,\n)`.
                let mut v = text[i + 2..].trim_start().trim_start_matches("Some(").trim_start().to_string();
                v.truncate(v.find([',', ')', ' ', '}', ']', '\n']).unwrap_or(v.len()));
                out.push((key, v));
            }
        } else {
            i += 1;
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(dem) = args.get(1).map(PathBuf::from) else {
        eprintln!("usage: timer_audit <replay.dem> [out dir]");
        std::process::exit(2);
    };
    let out = args.get(2).map_or_else(|| PathBuf::from("/tmp/mapcro-timer-audit"), PathBuf::from);
    std::fs::create_dir_all(&out).expect("out dir");
    // `--messages 349,350`: only dump those message types' decoded text, by tick (no entities:
    // fast). Pick types whose text carries no player identity.
    if let Some(i) = args.iter().position(|a| a == "--messages") {
        let types: HashSet<u32> = args.get(i + 1).map(|l| l.split(',').filter_map(|t| t.parse().ok()).collect()).unwrap_or_default();
        dump_messages(&dem, &out, &types);
        return;
    }
    let (build, server_start) = mapcro_replay::parse::header(&dem).expect("a Deadlock replay");
    eprintln!("build {build}");
    let parser = Parser::from_file(&dem).expect("opens");
    let init = parser.parse_init().expect("signon");
    let all: Vec<String> = init.class_info().classes().iter().map(|c| c.network_name.to_string()).collect();
    let filter: HashSet<&str> = all.iter().map(String::as_str).collect();
    eprintln!("{} classes", all.len());

    let mut fields: Vec<Field> = Vec::new();
    // (class id, key) → field index, None when the field is skipped (private or not a number).
    let mut index: HashMap<(i32, u64), Option<usize>> = HashMap::new();
    // Per class id, the flagged keys, read every tick.
    let mut flagged: HashMap<i32, Vec<(u64, usize)>> = HashMap::new();
    let mut by_path: HashMap<(String, String), usize> = HashMap::new();
    let mut last: HashMap<(i32, u32, u64), f64> = HashMap::new();
    let mut msgs: BTreeMap<u32, Msg> = BTreeMap::new();
    let mut changes = std::io::BufWriter::new(std::fs::File::create(out.join("changes.tsv")).expect("changes"));
    let mut grid = std::io::BufWriter::new(std::fs::File::create(out.join("grid.tsv")).expect("grid"));
    writeln!(changes, "game_s\ttick\tclass\tent\tfield\tvalue\tvalue_minus_now").ok();
    writeln!(grid, "game_s\tclass\tent\tfield\tvalue\tvalue_minus_now").ok();
    let mut keys: Option<[Option<u64>; 3]> = None;
    let mut last_sec = i64::MIN;
    let mut game_mode = 0;
    let started = std::time::Instant::now();

    parser
        .run_to_end_with_events_filtered(&filter, |ctx, events| {
            let rk = *keys.get_or_insert_with(|| {
                let s = ctx.serializers().get(RULES);
                let k = |p: &str| s.and_then(|s| s.resolve_field_key(p));
                [k("m_pGameRules.m_nTotalPausedTicks"), k("m_pGameRules.m_flGameStartTime"), k("m_pGameRules.m_eGameMode")]
            });
            let ents = ctx.entities();
            let Some(rules) = ents.iter().find(|(_, e)| e.class_name.as_ref() == RULES).map(|(_, e)| e) else { return };
            if game_mode == 0 {
                game_mode = rules.get_i64(rk[2]);
            }
            let interval = f64::from(ctx.tick_interval());
            let now = (f64::from(ctx.tick() + server_start) - rules.get_i64(rk[0]) as f64) * interval;
            let start = f64::from(rules.get_f32(rk[1]));
            // Before the horn the match clock is negative (or unknown: then the server clock).
            let game = if start > 0.0 { now - start } else { now - 1e6 };
            let gs = game as f32;
            let tick = f64::from(ctx.tick() + server_start);

            for e in events {
                let m = msgs.entry(e.msg_type).or_insert_with(|| Msg { name: e.name.clone(), first: gs, ..Default::default() });
                m.count += 1;
                m.last = gs;
                let mut kv: Vec<(String, String)> = e.keys.clone();
                if let Some(text) = boon::decode_event_payload(e.msg_type, &e.payload) {
                    kv.extend(pairs(&text));
                }
                let mut ex = String::new();
                for (k, v) in kv {
                    if private(&k) {
                        continue;
                    }
                    if name_hit(&k) && v.parse::<f64>().is_ok() {
                        let _ = write!(ex, "{k}={v} ");
                    }
                    m.keys.insert(k, ());
                }
                if !ex.is_empty() && m.examples.len() < 6 {
                    m.examples.push(format!("@{gs:.1}: {}", ex.trim_end()));
                }
            }

            // Every tick: the flagged fields, for every change.
            for (_, e) in ents.iter().filter(|(_, e)| e.active) {
                let Some(list) = flagged.get(&e.class_id) else { continue };
                for &(key, fi) in list {
                    let Some(v) = e.fields.get(&key).and_then(num) else { continue };
                    let prev = last.insert((e.index, e.serial, key), v);
                    if prev.is_some_and(|p| p != v) || (prev.is_none() && v != 0.0) {
                        let f = &mut fields[fi];
                        f.changes += 1;
                        if f.examples.len() < 12 && !f.examples.iter().any(|x| x.2 == v) {
                            f.examples.push((gs, e.index, v));
                        }
                        if f.logged < CHANGE_CAP {
                            f.logged += 1;
                            let full = ctx.serializers().get(e.class_name.as_ref()).and_then(|s| s.field_name_for_key(key)).unwrap_or_default();
                            writeln!(changes, "{gs:.2}\t{}\t{}\t{}\t{full}\t{v}\t{:.2}", ctx.tick(), f.class, e.index, v - now).ok();
                        }
                    }
                }
            }

            // Once a second: every field of every entity.
            let sec = game.floor() as i64;
            if sec == last_sec {
                return;
            }
            last_sec = sec;
            let on_grid = start > 0.0 && sec >= 0 && sec % 10 == 0;
            for (_, e) in ents.iter() {
                let ser = ctx.serializers().get(e.class_name.as_ref());
                for (&key, value) in &e.fields {
                    let fi = *index.entry((e.class_id, key)).or_insert_with(|| {
                        let (path, ty) = ser.and_then(|s| describe(s, key))?;
                        if private(&path) || num(value).is_none() {
                            return None;
                        }
                        let t = ty.to_ascii_lowercase();
                        let f = Field {
                            class: e.class_name.to_string(),
                            name_hit: name_hit(&path),
                            type_hit: t.contains("gametime") || t.contains("gametick") || t.contains("timer"),
                            path,
                            ty,
                            samples: 0,
                            nonzero: 0,
                            fut_gt: 0,
                            past_gt: 0,
                            fut_game: 0,
                            fut_tick: 0,
                            changes: 0,
                            logged: 0,
                            instances: HashSet::new(),
                            min: f64::INFINITY,
                            max: f64::NEG_INFINITY,
                            examples: Vec::new(),
                        };
                        // Same (class, path) under another key (another array slot): one row.
                        let i = *by_path.entry((f.class.clone(), f.path.clone())).or_insert_with(|| {
                            fields.push(f);
                            fields.len() - 1
                        });
                        if fields[i].flagged() {
                            flagged.entry(e.class_id).or_default().push((key, i));
                        }
                        Some(i)
                    });
                    let Some(fi) = fi else { continue };
                    let Some(v) = num(value) else { continue };
                    let f = &mut fields[fi];
                    f.samples += 1;
                    f.instances.insert(e.index);
                    f.min = f.min.min(v);
                    f.max = f.max.max(v);
                    if v != 0.0 && v != -1.0 {
                        f.nonzero += 1;
                        if v > now && v <= now + HORIZON {
                            f.fut_gt += 1;
                        }
                        if v <= now && v >= now - HORIZON {
                            f.past_gt += 1;
                        }
                        if start > 0.0 && v > game.max(60.0) && v <= game + HORIZON {
                            f.fut_game += 1;
                        }
                        if v > tick && v <= tick + HORIZON / interval {
                            f.fut_tick += 1;
                        }
                    }
                    if !f.flagged() {
                        let prev = last.insert((e.index, e.serial, key), v);
                        if prev.is_some_and(|p| p != v) {
                            f.changes += 1;
                            if f.examples.len() < 12 && !f.examples.iter().any(|x| x.2 == v) {
                                f.examples.push((gs, e.index, v));
                            }
                        }
                    } else if on_grid && v != 0.0 && v != -1.0 && e.active {
                        let full = ser.and_then(|s| s.field_name_for_key(key)).unwrap_or_default();
                        writeln!(grid, "{sec}\t{}\t{}\t{full}\t{v}\t{:.2}", f.class, e.index, v - now).ok();
                    }
                }
            }
        })
        .expect("parses");
    eprintln!("game mode {game_mode}; parsed in {:.0} s", started.elapsed().as_secs_f64());
    write_fields(&out, &fields);
    write_messages(&out, &msgs);
    eprintln!("wrote {}", out.display());
}

fn dump_messages(dem: &Path, out: &Path, types: &HashSet<u32>) {
    let parser = Parser::from_file(dem).expect("opens");
    let mut s = String::from("tick\tmsg_type\tname\ttext\n");
    for e in parser.events_filtered(None, types).expect("events") {
        let text = boon::decode_event_payload(e.msg_type, &e.payload).unwrap_or_else(|| format!("{:?}", e.keys));
        let _ = writeln!(s, "{}\t{}\t{}\t{}", e.tick, e.msg_type, e.name, text.replace('\n', " "));
    }
    std::fs::write(out.join("messages-detail.tsv"), s).expect("detail");
    eprintln!("wrote {}", out.join("messages-detail.tsv").display());
}

fn row(f: &Field) -> String {
    let ex: Vec<String> = f.examples.iter().map(|(t, e, v)| format!("{v}@{t:.0}s#{e}")).collect();
    format!(
        "{}\t{}\t{}\t{}{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
        f.class,
        f.path,
        f.ty,
        if f.name_hit { "N" } else { "" },
        if f.type_hit { "T" } else { "" },
        f.clock_like().unwrap_or(""),
        f.instances.len(),
        f.samples,
        f.nonzero,
        f.changes,
        f.fut_gt,
        f.past_gt,
        f.fut_game,
        f.fut_tick,
        f.min,
        f.max,
        ex.join(" ")
    )
}

fn write_fields(out: &Path, fields: &[Field]) {
    let head = "class\tfield\ttype\thit\tclock_like\tinstances\tsamples\tnonzero\tchanges\tfut_gt\tpast_gt\tfut_game\tfut_tick\tmin\tmax\texamples(value@match_s#ent)\n";
    let mut sorted: Vec<&Field> = fields.iter().collect();
    sorted.sort_by(|a, b| (&a.class, &a.path).cmp(&(&b.class, &b.path)));
    let mut all = head.to_string();
    let mut cand = head.to_string();
    for f in sorted {
        let r = row(f);
        all.push_str(&r);
        all.push('\n');
        // A flagged field that never holds a value isn't a timer in this match.
        if (f.flagged() && f.nonzero > 0) || f.clock_like().is_some() {
            cand.push_str(&r);
            cand.push('\n');
        }
    }
    std::fs::write(out.join("fields.tsv"), all).expect("fields");
    std::fs::write(out.join("candidates.tsv"), cand).expect("candidates");
}

fn write_messages(out: &Path, msgs: &BTreeMap<u32, Msg>) {
    let mut s = String::from("msg_type\tname\tcount\tfirst_s\tlast_s\tkeys\ttimer_examples\n");
    for (t, m) in msgs {
        let keys: Vec<&str> = m.keys.keys().map(String::as_str).collect();
        let _ = writeln!(s, "{t}\t{}\t{}\t{:.1}\t{:.1}\t{}\t{}", m.name, m.count, m.first, m.last, keys.join(","), m.examples.join(" | "));
    }
    std::fs::write(out.join("messages.tsv"), s).expect("messages");
}
