//! Where does a full parse's memory go? (docs/research/parser-memory.md). Per phase: the peak
//! resident memory (`VmHWM`, reset through `/proc/self/clear_refs`) and the largest anonymous and
//! file-backed resident memory a 20 ms sampler saw. (The workspace forbids `unsafe`, so there is
//! no counting allocator here; heap attribution is from `valgrind --tool=massif` on `full`.)
//! Prints sizes and counts only: never a name or an id.
//!
//! `cargo run --release --example memory_probe -- <mode> <demo> [out.json]`
//!
//! - `full`: the worker's job (`parse::observe`, `derive`, `serde_json::to_vec`), phase by phase,
//!   with the observations' size by field.
//! - `boon`: boon alone over the mmapped demo (`from_file`, its index, then the filtered run with
//!   events and the worker's classes, an empty callback): its own state and buffers.
//! - `bytes`: the same as `boon` from `std::fs::read` + `from_bytes` (what a wasm build without
//!   streaming would do).
//! - `census`: the command stream's shape: counts, the largest bodies, compressed and not.
//! - `spliced`: the full parse read forward in one-minute stretches, each played as a small demo
//!   (`from_bytes`): no mmap and no whole-file buffer, boon unchanged.
//! - `state` / `state-filtered`: entity state by class at its largest, without or with the
//!   worker's property filter, and boon's modifier table.
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};
use std::time::{Duration, Instant};

const MB: f64 = 1024.0 * 1024.0;

fn mb(b: usize) -> String {
    format!("{:.1} MB", b as f64 / MB)
}

/// kB fields of /proc/self/status, in bytes.
fn status(key: &str) -> usize {
    let s = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    s.lines().find_map(|l| l.strip_prefix(key)).and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<usize>().ok()).unwrap_or(0) * 1024
}

/// The largest RssAnon and RssFile seen (sampled every 20 ms), since the last `reset`.
static ANON: AtomicUsize = AtomicUsize::new(0);
static FILE: AtomicUsize = AtomicUsize::new(0);
static STOP: AtomicBool = AtomicBool::new(false);

fn sample() {
    ANON.fetch_max(status("RssAnon:"), Relaxed);
    FILE.fetch_max(status("RssFile:"), Relaxed);
}

fn reset() {
    ANON.store(0, Relaxed);
    FILE.store(0, Relaxed);
    // VmHWM back to the resident memory now (Linux 4.0+), so it is this phase's peak.
    let _ = std::fs::write("/proc/self/clear_refs", "5");
    sample();
}

/// Run `f` as a phase: its time, its peak resident memory (VmHWM), the largest anonymous and
/// file-backed resident memory sampled inside it, and the anonymous memory after.
fn phase<T>(name: &str, f: impl FnOnce() -> T) -> T {
    reset();
    let before = status("RssAnon:");
    let t = Instant::now();
    let out = f();
    sample();
    println!(
        "phase {name:<16} {:>6.2} s  anon before {:>9}  max anon {:>9}  max file {:>9}  VmHWM {:>9}  anon after {:>9}",
        t.elapsed().as_secs_f64(),
        mb(before),
        mb(ANON.load(Relaxed)),
        mb(FILE.load(Relaxed)),
        mb(status("VmHWM:")),
        mb(status("RssAnon:"))
    );
    out
}

fn v<T>(x: &Vec<T>) -> usize {
    x.capacity() * size_of::<T>()
}

fn obs_sizes(o: &mapcro_replay::derive::Obs) {
    let s = &o.seconds;
    let heroes: usize = s.iter().map(|x| v(&x.heroes) + x.heroes.iter().map(|h| h.name.as_ref().map_or(0, String::capacity)).sum::<usize>()).sum();
    let objectives: usize = s.iter().map(|x| v(&x.objectives)).sum();
    let troopers: usize = s.iter().map(|x| v(&x.troopers)).sum();
    let powerups: usize = s.iter().map(|x| v(&x.powerups)).sum();
    let abilities: usize = s.iter().map(|x| v(&x.abilities) + x.abilities.iter().map(|a| a.name.capacity()).sum::<usize>()).sum();
    let zips: usize = s.iter().map(|x| v(&x.zip_teams)).sum();
    let tr_n: usize = s.iter().map(|x| x.troopers.len()).sum();
    println!("obs seconds {} (Sample {} B, HeroObs {} B, TrooperObs {} B, ObjObs {} B)", s.len(), size_of::<mapcro_replay::derive::Sample>(), size_of::<mapcro_replay::derive::HeroObs>(), size_of::<mapcro_replay::derive::TrooperObs>(), size_of::<mapcro_replay::derive::ObjObs>());
    println!("  seconds vec   {}", mb(v(s)));
    println!("  heroes        {}", mb(heroes));
    println!("  objectives    {}", mb(objectives));
    println!("  troopers      {} ({tr_n} rows, {:.0}/s)", mb(troopers), tr_n as f64 / s.len().max(1) as f64);
    println!("  powerups      {}", mb(powerups));
    println!("  abilities     {}", mb(abilities));
    println!("  zip_teams     {}", mb(zips));
    let cs: usize = o.camp_slots.iter().map(|c| v(&c.changes)).sum::<usize>() + v(&o.camp_slots);
    println!("  events: zip_nodes {} camps {} urn {} buffs {} heals {} crates {} rejuv {} koth {} vision {} ({} rows)", mb(v(&o.zip_nodes)), mb(cs), mb(v(&o.urn)), mb(v(&o.buffs)), mb(v(&o.heals)), mb(v(&o.crates)), mb(v(&o.rejuv) + v(&o.rejuv_counts)), mb(v(&o.koth)), mb(v(&o.vision)), o.vision.len());
    let d = &o.hero_data;
    println!(
        "  hero_data: items {} sells {} levels {} casts {} charges {} cc {} effects {} ({} rows) applied {} ({} rows) damage {} ({} rows) height {} zip {}",
        mb(v(&d.items)),
        mb(v(&d.sells)),
        mb(v(&d.levels)),
        mb(v(&d.casts)),
        mb(v(&d.charges)),
        mb(v(&d.cc)),
        mb(v(&d.effects)),
        d.effects.len(),
        mb(v(&d.applied)),
        d.applied.len(),
        mb(v(&d.damage)),
        d.damage.len(),
        mb(v(&d.height)),
        mb(v(&d.zip))
    );
}

/// The worker's classes (parse.rs `observe`), for boon-only runs.
fn classes(parser: &boon::Parser) -> Vec<String> {
    let mut c: Vec<String> = [
        "CCitadelPlayerController",
        "CCitadelPlayerPawn",
        "CCitadelGameRulesProxy",
        "CCitadelItemKothSpawner",
        "CCitadel_PickupItemSpawner",
        "CCitadel_Pickup_Modifier",
        "CNPC_Trooper",
        "CCitadelZipLineNode",
        "CCitadelItemPickupIdol",
        "CCitadelIdolReturnTrigger",
        "CCitadelTeam",
        "CCitadel_Pickup_Health",
        "CCitadel_BreakableProp",
        "CNPC_TrooperBoss",
        "CNPC_Boss_Tier2",
        "CNPC_BarrackBoss",
        "CNPC_Boss_Tier3",
        "CNPC_MidBoss",
        "CCitadel_Destroyable_Building",
    ]
    .map(String::from)
    .to_vec();
    c.extend(mapcro_replay::parse_hero::ability_classes(parser));
    c
}

fn boon_run(parser: boon::Parser) {
    let _ = phase("index", || parser.full_packet_offsets().map(|v| v.len()));
    let names = classes(&parser);
    let set: HashSet<&str> = names.iter().map(String::as_str).collect();
    let mut ents = 0usize;
    let mut events = 0usize;
    let mut max_tick_events = 0usize;
    let mut tables = 0usize;
    phase("boon run", || {
        parser
            .run_to_end_with_events_filtered(&set, |ctx, ev| {
                ents = ents.max(ctx.entities().iter().count());
                events += ev.len();
                max_tick_events = max_tick_events.max(ev.iter().map(|e| e.payload.len()).sum());
                tables = tables.max(ctx.string_tables().tables().iter().map(|t| t.entries().len()).sum());
            })
            .expect("run")
    });
    println!("entities max {ents}  events {events}  largest tick's event payloads {}  string-table entries max {tables}", mb(max_tick_events));
}

/// Entity state by class (fields held, at the tick with the most), and boon's modifier table
/// (`ModifierState`, which parse_hero keeps for the whole match).
fn state(path: &std::path::Path, filtered: bool) {
    let parser = boon::Parser::from_file(path).expect("open");
    let names = classes(&parser);
    let set: HashSet<&str> = names.iter().map(String::as_str).collect();
    let field = size_of::<(u64, boon::FieldValue)>() + 1;
    let mut best: (usize, std::collections::BTreeMap<String, (usize, usize)>) = Default::default();
    let mut mods = boon::modifier_state::ModifierState::default();
    let (mut mods_max, mut mods_cap, mut changes) = (0usize, 0usize, 0usize);
    let mut tick = 0;
    // `filtered`: the worker's property filter (parse.rs `observe`), else every field.
    let origin = ["CBodyComponent.m_skeletonInstance.m_vecOrigin", "CBodyComponent"].into_iter().flat_map(|o| ["m_cellX", "m_cellY", "m_cellZ", "m_vecX", "m_vecY", "m_vecZ"].map(|c| format!("{o}.{c}")));
    let origin: Vec<String> = origin.collect();
    let with = |f: &[&str]| -> Vec<String> { origin.iter().cloned().chain(f.iter().map(|x| (*x).to_owned())).collect() };
    let kept = [("CNPC_Trooper", with(&["m_iHealth", "m_iMaxHealth", "m_lifeState", "m_iTeamNum", "m_iLane"])), ("CCitadel_BreakableProp", with(&["m_nSubclassID"])), ("CCitadelZipLineNode", with(&["m_iTeamNum", "m_iPrimaryLane"]))];
    let kept: Vec<(&str, Vec<&str>)> = kept.iter().map(|(c, f)| (*c, f.iter().map(String::as_str).collect())).collect();
    let properties: Vec<(&str, &[&str])> = if filtered { kept.iter().map(|(c, f)| (*c, f.as_slice())).collect() } else { Vec::new() };
    parser
        .run_to_end_with_properties(&set, &properties, Some(&HashSet::from([300, 309, 350, 360, 365])), |ctx, _| {
            changes += mods.update(ctx).len();
            mods_max = mods_max.max(mods.entries().len());
            mods_cap = mods_cap.max(mods.entries().capacity());
            tick += 1;
            if tick % 640 != 0 {
                return;
            }
            let mut by: std::collections::BTreeMap<String, (usize, usize)> = Default::default();
            let mut total = 0;
            for (_, e) in ctx.entities().iter() {
                let b = e.fields.capacity() * field;
                total += b;
                let x = by.entry(e.class_name.to_string()).or_default();
                x.0 += 1;
                x.1 += b;
            }
            if total > best.0 {
                best = (total, by);
            }
        })
        .expect("run");
    println!("entity field maps at their largest: {} ((u64, FieldValue) slot {} B)", mb(best.0), field - 1);
    let mut rows: Vec<_> = best.1.into_iter().collect();
    rows.sort_by_key(|(_, (_, b))| std::cmp::Reverse(*b));
    for (c, (n, b)) in rows.iter().take(14) {
        println!("  {c:<36} {n:>5} entities  {:>8}", mb(*b));
    }
    let entry = size_of::<(u32, boon_proto::proto::CModifierTableEntry)>();
    println!("modifier state: {changes} changes, at most {mods_max} live entries, capacity {mods_cap} × {entry} B = {}", mb(mods_cap * (entry + 1)));
}

/// A raw varint from a reader, with its bytes appended to `raw`.
fn read_varint(r: &mut impl std::io::Read, raw: &mut Vec<u8>) -> Option<u32> {
    let mut v: u32 = 0;
    for i in 0..5 {
        let mut b = [0u8];
        r.read_exact(&mut b).ok()?;
        raw.push(b[0]);
        v |= u32::from(b[0] & 0x7f) << (7 * i);
        if b[0] & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

/// The spliced read (no mmap, no whole-file buffer, no change to boon): the demo is read
/// forward once, and each stretch from one full packet to the next (one minute, ~10 MB) is played
/// as its own small demo, the signon in front, through `parse::observe_with`. A full packet at
/// tick T follows tick T's packet, so tick T's callback is held back at the end of a stretch (its
/// events kept) and given once, with the next stretch's restored state and both sets of events.
fn spliced(path: &std::path::Path) -> mapcro_replay::derive::Obs {
    use std::io::Read;
    let mut r = std::io::BufReader::with_capacity(1 << 20, std::fs::File::open(path).expect("open"));
    let mut head = [0u8; 16];
    r.read_exact(&mut head).expect("head");
    let mut signon = head.to_vec();
    signon[8..16].fill(0);
    // The signon, through DEM_SyncTick.
    loop {
        let mut raw = Vec::new();
        let cmd = read_varint(&mut r, &mut raw).expect("cmd") & !64;
        read_varint(&mut r, &mut raw).expect("tick");
        let size = read_varint(&mut r, &mut raw).expect("size") as usize;
        signon.extend_from_slice(&raw);
        let at = signon.len();
        signon.resize(at + size, 0);
        r.read_exact(&mut signon[at..]).expect("body");
        if cmd == 3 {
            break;
        }
    }
    let first = boon::Parser::from_bytes(signon.clone());
    let fh = first.file_header().expect("file header");
    let build = mapcro_replay::content_build(&fh.game_directory.unwrap_or_default()).expect("build");
    let server_start = fh.server_start_tick.unwrap_or(0).max(0);
    let ability = mapcro_replay::parse_hero::ability_classes(&first);
    drop(first);
    let mut largest = 0usize;
    let mut segments = 0usize;
    let obs = mapcro_replay::parse::observe_with(0, build, server_start, &ability, |classes, properties, events, on_tick| {
        let mut buf = signon.clone();
        let mut held: Option<(i32, Vec<boon::GameEvent>)> = None;
        let mut play = |buf: Vec<u8>, until: Option<i32>, held: &mut Option<(i32, Vec<boon::GameEvent>)>| {
            largest = largest.max(buf.len());
            segments += 1;
            let p = boon::Parser::from_bytes(buf);
            p.run_to_end_with_properties(classes, properties, Some(events), |ctx, ev| {
                if Some(ctx.tick()) == until {
                    *held = Some((ctx.tick(), ev.to_vec()));
                    return;
                }
                match held.take() {
                    Some((t, mut before)) if t == ctx.tick() => {
                        before.extend_from_slice(ev);
                        on_tick(ctx, &before);
                    }
                    Some((_, before)) => panic!("a held tick ({} events) wasn't resumed", before.len()),
                    None => on_tick(ctx, ev),
                }
            })
            .expect("segment");
        };
        loop {
            let mut raw = Vec::new();
            let Some(cmd) = read_varint(&mut r, &mut raw) else { break };
            let tick = read_varint(&mut r, &mut raw).expect("tick") as i32;
            let size = read_varint(&mut r, &mut raw).expect("size") as usize;
            let cmd = cmd & !64;
            if cmd == 13 && buf.len() > signon.len() {
                play(std::mem::replace(&mut buf, signon.clone()), Some(tick), &mut held);
            }
            buf.extend_from_slice(&raw);
            let at = buf.len();
            buf.resize(at + size, 0);
            r.read_exact(&mut buf[at..]).expect("body");
            if cmd == 0 {
                break;
            }
        }
        play(buf, None, &mut held);
        Ok(())
    })
    .expect("observe");
    println!("spliced: {segments} stretches, the largest {}", mb(largest));
    obs
}

fn census(path: &std::path::Path) {
    let parser = boon::Parser::from_file(path).expect("open");
    let msgs = parser.messages().expect("messages");
    let mut by: std::collections::BTreeMap<i32, (usize, u64, u32)> = Default::default();
    for m in &msgs {
        let e = by.entry(m.cmd).or_default();
        e.0 += 1;
        e.1 += u64::from(m.body_size);
        e.2 = e.2.max(m.body_size);
    }
    println!("commands {}", msgs.len());
    // What sits either side of a full packet (a segment boundary for a spliced read).
    for (i, m) in msgs.iter().enumerate().filter(|(_, m)| m.cmd == 13).skip(1).take(3) {
        let around: Vec<String> = msgs[i.saturating_sub(2)..(i + 3).min(msgs.len())].iter().map(|m| format!("{}@{}", m.cmd, m.tick)).collect();
        println!("  full packet at tick {}: {}", m.tick, around.join(" "));
    }
    for (cmd, (n, total, max)) in by {
        println!("  cmd {cmd:>2}: {n:>7}  {:>9}  largest {}", mb(total as usize), mb(max as usize));
    }
    // The largest decompressed body (boon's per-command scratch).
    let data = std::fs::read(path).expect("read");
    let mut max_out = 0usize;
    for m in msgs.iter().filter(|m| m.compressed) {
        let hdr = 1 + varint_len(m.tick as u32) + varint_len(m.body_size) + varint_len((m.cmd as u32) | 64) - 1;
        let at = m.offset + hdr;
        if let Ok(n) = snap::raw::decompress_len(&data[at..at + m.body_size as usize]) {
            max_out = max_out.max(n);
        }
    }
    println!("largest decompressed body {}", mb(max_out));
}

fn varint_len(mut v: u32) -> usize {
    let mut n = 1;
    while v >= 0x80 {
        v >>= 7;
        n += 1;
    }
    n
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).expect("mode").as_str();
    let path = std::path::PathBuf::from(args.get(2).expect("demo"));
    let sampler = std::thread::spawn(|| {
        while !STOP.load(Relaxed) {
            sample();
            std::thread::sleep(Duration::from_millis(20));
        }
    });
    let t = Instant::now();
    match mode {
        "full" => {
            let obs = phase("observe", || mapcro_replay::parse::observe(&path, 0).expect("observe"));
            obs_sizes(&obs);
            let tl = phase("derive", || mapcro_replay::derive::derive(&obs, mapcro_replay::map::current()).expect("derive"));
            let bytes = phase("serialise", || serde_json::to_vec(&tl).expect("json"));
            println!("timeline json {}", mb(bytes.len()));
            if let Some(out) = args.get(3) {
                std::fs::write(out, &bytes).expect("write");
            }
            drop(tl);
            drop(obs);
        }
        "boon" => boon_run(phase("from_file", || boon::Parser::from_file(&path).expect("open"))),
        "bytes" => boon_run(phase("read+from_bytes", || boon::Parser::from_bytes(std::fs::read(&path).expect("read")))),
        "census" => census(&path),
        "spliced" => {
            let obs = phase("spliced observe", || spliced(&path));
            let tl = mapcro_replay::derive::derive(&obs, mapcro_replay::map::current()).expect("derive");
            let bytes = serde_json::to_vec(&tl).expect("json");
            if let Some(out) = args.get(3) {
                std::fs::write(out, &bytes).expect("write");
            }
        }
        "state" => state(&path, false),
        "state-filtered" => state(&path, true),
        _ => panic!("mode: full | boon | bytes | census"),
    }
    STOP.store(true, Relaxed);
    let _ = sampler.join();
    println!("total {:.2} s", t.elapsed().as_secs_f64());
}
