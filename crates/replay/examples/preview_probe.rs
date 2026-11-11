//! How cheaply can a picker card's preview come from the demo itself? (docs/research/
//! demo-preview.md). Prints field paths, counts, sizes and timings, and per-team aggregates keyed
//! by hero id only: never a name or an account id.
//!
//! `cargo run --release --example preview_probe -- <demo>`
use boon::Parser;
use boon_proto::proto::{CDemoFileHeader, CDemoFileInfo};
use prost::Message;
use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::time::Instant;

fn uvarint(b: &[u8], at: &mut usize) -> Option<u32> {
    let mut v: u32 = 0;
    for i in 0..5 {
        let byte = *b.get(*at)?;
        *at += 1;
        v |= u32::from(byte & 0x7f) << (7 * i);
        if byte & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

fn body(raw: u32, bytes: &[u8]) -> Vec<u8> {
    if raw & 64 != 0 { snap::raw::Decoder::new().decompress_vec(bytes).expect("snappy") } else { bytes.to_vec() }
}

fn main() {
    let path = std::path::PathBuf::from(std::env::args_os().nth(1).expect("demo path"));
    let mut f = std::fs::File::open(&path).expect("open");
    let len = f.metadata().expect("meta").len();
    println!("file bytes {len}");

    // ---- 1. the 16-byte header, CDemoFileInfo at its offset, CDemoFileHeader at the start ----
    let t = Instant::now();
    let mut head = [0u8; 16];
    f.read_exact(&mut head).expect("head");
    assert_eq!(&head[..8], b"PBDEMS2\0");
    let info_at = u64::from(u32::from_le_bytes(head[8..12].try_into().unwrap()));
    let spawn_at = u32::from_le_bytes(head[12..16].try_into().unwrap());
    println!("header: fileinfo offset {info_at} ({} bytes from the end), second u32 {spawn_at}", len - info_at);
    f.seek(SeekFrom::Start(info_at)).expect("seek");
    let mut tail = Vec::new();
    f.by_ref().take(64 * 1024).read_to_end(&mut tail).expect("tail");
    let mut at = 0;
    let raw = uvarint(&tail, &mut at).unwrap();
    let tick = uvarint(&tail, &mut at).unwrap();
    let size = uvarint(&tail, &mut at).unwrap() as usize;
    println!("fileinfo cmd {} tick {} size {size}", raw & !64, tick as i32);
    let fi = CDemoFileInfo::decode(&body(raw, &tail[at..at + size])[..]).expect("fileinfo");
    println!("  playback_time {:?} playback_ticks {:?} playback_frames {:?}", fi.playback_time, fi.playback_ticks, fi.playback_frames);
    match &fi.game_info {
        None => println!("  game_info: absent"),
        Some(g) => {
            println!("  game_info.cs present {}", g.cs.is_some());
            if let Some(d) = &g.dota {
                println!("  game_info.dota: match_id set {} game_mode {:?} game_winner {:?} player_info {} picks_bans {} end_time set {}", d.match_id.is_some(), d.game_mode, d.game_winner, d.player_info.len(), d.picks_bans.len(), d.end_time.is_some());
                let with_hero = d.player_info.iter().filter(|p| p.hero_name.as_deref().is_some_and(|h| !h.is_empty())).count();
                let teams: BTreeMap<i32, usize> = d.player_info.iter().fold(BTreeMap::new(), |mut m, p| { *m.entry(p.game_team.unwrap_or(-1)).or_default() += 1; m });
                println!("  player_info with hero_name {with_hero}; per game_team {teams:?}");
            } else {
                println!("  game_info.dota: absent");
            }
        }
    }
    f.seek(SeekFrom::Start(16)).expect("seek");
    let mut start = vec![0u8; 64 * 1024];
    let n = f.read(&mut start).expect("start");
    start.truncate(n);
    let mut at = 0;
    let raw = uvarint(&start, &mut at).unwrap();
    let _tick = uvarint(&start, &mut at).unwrap();
    let size = uvarint(&start, &mut at).unwrap() as usize;
    let h = CDemoFileHeader::decode(&body(raw, &start[at..at + size])[..]).expect("fileheader");
    println!("fileheader cmd {} size {size}: map {:?} build_num {:?} game_directory has citadel_v {} server_start_tick {:?} game {:?}", raw & !64, h.map_name, h.build_num, h.game_directory.as_deref().is_some_and(|d| d.contains("citadel_v")), h.server_start_tick, h.game);
    println!("  content build {:?}", mapcro_replay::content_build(h.game_directory.as_deref().unwrap_or("")));
    println!("step 1 took {:?}, read ~{} bytes", t.elapsed(), 16 + tail.len() + start.len());

    // ---- 2. the light read (preview.rs), cold and warm ----
    let id = path.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse().ok()).unwrap_or(0);
    for run in ["first", "second"] {
        let t = Instant::now();
        match mapcro_replay::preview::read_counted(&path, id) {
            Ok((p, read)) => println!("preview ({run} run) {:?}, {} bytes read, whole file {}: {}", t.elapsed(), read.bytes, read.whole_file, serde_json::to_string(&p).unwrap_or_default()),
            Err(why) => println!("preview ({run} run) failed: {why}"),
        }
    }
    if std::env::args().any(|a| a == "--explore") {
        explore(&path);
    }
    if std::env::args().any(|a| a == "--clock") {
        wall_clock(&path);
    }
}

/// Does any entity carry a wall-clock time (unix seconds 2024-2027, or ms)? Field paths and
/// counts only; strings aren't looked at (they hold names).
fn wall_clock(path: &std::path::Path) {
    let parser = Parser::from_file(path).expect("parser");
    let names: Vec<String> = parser.parse_class_info().expect("classes").classes().iter().map(|c| c.network_name.to_string()).collect();
    let classes: HashSet<&str> = names.iter().map(String::as_str).collect();
    let offs = parser.full_packet_offsets().expect("index");
    let &(off, tick) = offs.last().expect("fp");
    let mut hits: BTreeMap<String, usize> = BTreeMap::new();
    let mut entities = 0;
    let mut done = false;
    parser.decode_segment(Some(off), tick + 1, &classes, |ctx| {
        if done { return; }
        done = true;
        for (_, e) in ctx.entities().iter() {
            entities += 1;
            let Some(ser) = ctx.serializers().get(e.class_name.as_ref()) else { continue };
            for (&k, v) in &e.fields {
                let x = match v { boon::FieldValue::I32(n) => f64::from(*n), boon::FieldValue::U32(n) => f64::from(*n), boon::FieldValue::I64(n) => *n as f64, boon::FieldValue::U64(n) => *n as f64, boon::FieldValue::F32(n) => f64::from(*n), _ => continue };
                let unix = (1.70e9..1.85e9).contains(&x) || (1.70e12..1.85e12).contains(&x);
                let named = ser.field_name_for_key(k).unwrap_or_default();
                let l = named.to_ascii_lowercase();
                if unix || l.contains("date") || l.contains("rtime") || l.contains("unix") || l.contains("timestamp") || l.contains("starttime") {
                    *hits.entry(format!("{}.{}{}", e.class_name, named, if unix { " (unix-like value)" } else { "" })).or_default() += 1;
                }
            }
        }
    }).expect("segment");
    println!("wall clock scan at tick {tick}: {entities} entities, {} candidate fields", hits.len());
    for (k, n) in hits { println!("  {k} x{n}"); }
}

/// The exploration behind preview.rs: the command census, and boon's segments from the last two
/// full packets with the rules' end-of-match fields.
fn explore(path: &std::path::Path) {
    let data = std::fs::read(path).expect("read");
    let mut at = 16usize;
    let mut counts: BTreeMap<u32, (usize, u64)> = BTreeMap::new();
    while at < data.len() {
        let (Some(raw), Some(_tick), Some(size)) = (uvarint(&data, &mut at), uvarint(&data, &mut at), uvarint(&data, &mut at)) else { break };
        let e = counts.entry(raw & !64).or_default();
        e.0 += 1;
        e.1 += u64::from(size);
        at += size as usize;
        if raw & !64 == 2 { break }
    }
    println!("commands by type (count, body bytes) {counts:?}");
    drop(data);
    let classes: HashSet<&str> = ["CCitadelPlayerController", "CCitadelGameRulesProxy", "CCitadelPlayerPawn"].into_iter().collect();
    let parser = Parser::from_file(path).expect("parser");
    let offs = parser.full_packet_offsets().expect("index");
    let ticks: Vec<i32> = offs.iter().map(|o| o.1).collect();
    println!("full packets {} at ticks {:?} … {:?}", offs.len(), &ticks[..ticks.len().min(3)], &ticks[ticks.len().saturating_sub(2)..]);
    for back in [1usize, 2] {
        let Some(&(off, tick)) = offs.get(offs.len().saturating_sub(back)) else { continue };
        let mut first: Option<String> = None;
        let mut first_win: Option<String> = None;
        let mut last: Option<String> = None;
        parser
            .decode_segment(Some(off), i32::MAX, &classes, |ctx| {
                let s = summarise(ctx);
                if first.is_none() { first = Some(s.clone()); }
                if first_win.is_none() && (s.contains("m_iWinningTeam=2") || s.contains("m_iWinningTeam=3")) { first_win = Some(s.clone()); }
                last = Some(s);
            })
            .expect("segment");
        println!("from full packet -{back} (tick {tick}):\n at it:\n{}\n first with a winner:\n{}\n last:\n{}", first.unwrap_or_default(), first_win.unwrap_or_default(), last.unwrap_or_default());
    }
}

fn summarise(ctx: &boon::Context) -> String {
    let ser = |c: &str, p: &str| ctx.serializers().get(c).and_then(|s| s.resolve_field_key(p));
    let c = "CCitadelPlayerController";
    let r = "CCitadelGameRulesProxy";
    let (team, hero, nw, kills, deaths) = (ser(c, "m_iTeamNum"), ser(c, "m_PlayerDataGlobal.m_nHeroID"), ser(c, "m_PlayerDataGlobal.m_iGoldNetWorth"), ser(c, "m_PlayerDataGlobal.m_iPlayerKills"), ser(c, "m_PlayerDataGlobal.m_iDeaths"));
    let mut out = String::new();
    let mut teams: BTreeMap<i64, (Vec<(i32, i64)>, i64, i64, i64)> = BTreeMap::new();
    for (_, e) in ctx.entities().iter() {
        match e.class_name.as_ref() {
            x if x == c => {
                let t = teams.entry(e.get_i64(team)).or_default();
                t.0.push((e.index, e.get_i64(hero)));
                t.1 += e.get_i64(kills);
                t.2 += e.get_i64(nw);
                t.3 += e.get_i64(deaths);
            }
            x if x == r => {
                let g = |p: &str| e.get_i64(ser(r, &format!("m_pGameRules.{p}")));
                let gf = |p: &str| e.get_f32(ser(r, &format!("m_pGameRules.{p}")));
                if let Some(s) = ctx.serializers().get(r) {
                    let mut names: Vec<String> = e.fields.iter().filter_map(|(k, v)| {
                        let n = s.field_name_for_key(*k)?;
                        let l = n.to_ascii_lowercase();
                        (["end", "win", "over", "duration", "state", "matchclock", "gametime"].iter().any(|w| l.contains(w)) && !l.contains("koth") && !l.contains("neutral")).then(|| format!("{n}={v:?}"))
                    }).collect();
                    names.sort();
                    out += &format!("  rules fields: {names:?}\n");
                }
                out += &format!("  tick {} rules: winner {} mode {} start {} paused_ticks {} paused {} game_over_time? {:?}\n", ctx.tick(), g("m_iWinningTeam"), g("m_eGameMode"), gf("m_flGameStartTime"), g("m_nTotalPausedTicks"), g("m_bGamePaused"), ["m_flGameEndTime", "m_flMatchClockAtLastUpdate", "m_flGameStateEndTime"].map(|p| (p, ser(r, &format!("m_pGameRules.{p}")).map(|_| gf(p)))));
            }
            _ => {}
        }
    }
    for (t, (heroes, k, nw, d)) in teams {
        let mut h: Vec<i64> = heroes.iter().map(|x| x.1).collect();
        h.sort_unstable();
        out += &format!("  team {t}: {} controllers heroes {h:?} kills {k} deaths {d} souls {nw}\n", heroes.len());
    }
    out
}
