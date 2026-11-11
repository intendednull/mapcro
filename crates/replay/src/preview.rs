//! A replay picker card's preview from the demo itself (spec §6a "Previews", §6b "The Windows
//! app"; docs/research/demo-preview.md): heroes per team, team kills and souls at the end, the
//! winner, the length, the mode and the build, without parsing the whole match.
//!
//! The demo's own summary (`CDemoFileInfo`, at the offset in its 16-byte header) holds only the
//! playback time, ticks and frames in Deadlock: no heroes, no score, no winner. So the read is a
//! short parse instead:
//!
//! 1. the signon (file header, send tables, class info, string tables: the first ~0.3 MB);
//! 2. the last `DEM_FullPacket` (every 3,840 ticks, a minute; found by scanning back from the end,
//!    each candidate checked by walking the command headers from it onto a known command and by
//!    its body decompressing);
//! 3. if the match already had its winner there, the full packet before the winning tick
//!    (`m_nMatchClockUpdateTick`), played forward to that tick: the souls keep growing after the
//!    win (129738985: +1,020 and +812), and the summary's and the timeline's are at the win.
//!
//! boon decodes only those bytes, spliced into one small buffer. On 129738985 (504 MB) that's
//! about 5 MB read. A demo the scan can't place falls back to boon's own index of the whole file.
//!
//! Like the timeline, it reads no names and no account ids.

use serde::{Deserialize, Serialize};

/// A match at a glance (the server's `GET /api/matches/{id}/preview` has this shape; `build` is
/// only in the local read).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Preview {
    pub match_id: u64,
    /// When the match started (unix seconds). The demo doesn't record it: 0 in the local read.
    pub start_time: u64,
    pub duration_s: u32,
    /// `ECitadelGameMode` (1 standard, 4 Street Brawl).
    pub game_mode: i64,
    /// "amber" or "sapphire"; `null` when the recording ends before a winner.
    pub winner: Option<String>,
    /// Amber, then Sapphire.
    pub teams: Vec<PreviewTeam>,
    /// The content build (`game_directory`'s `citadel_vNNNN`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PreviewTeam {
    pub team: String,
    /// `[slot, hero_id]`, in slot order.
    pub heroes: Vec<[u32; 2]>,
    /// The players' scoreboard kills summed.
    pub kills: u32,
    /// The players' net worth summed.
    pub souls: u32,
}

/// One player at the end, as the preview needs it: the controller's entity index (slots are in
/// that order within a team, as in the timeline), team, hero, kills, net worth.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EndPlayer {
    pub index: i32,
    pub team: i64,
    pub hero_id: u32,
    pub kills: u32,
    pub souls: u32,
}

/// The teams of a preview from the players at the end: Amber (2), then Sapphire (3); players
/// without a hero (spectators, the casters' controllers) are left out; slots by entity index.
pub fn teams(players: &[EndPlayer]) -> Vec<PreviewTeam> {
    [(2, "amber"), (3, "sapphire")]
        .iter()
        .map(|&(t, name)| {
            let mut mine: Vec<&EndPlayer> = players.iter().filter(|p| p.team == t && p.hero_id != 0).collect();
            mine.sort_by_key(|p| p.index);
            PreviewTeam {
                team: name.to_owned(),
                heroes: mine.iter().enumerate().map(|(slot, p)| [slot as u32, p.hero_id]).collect(),
                kills: mine.iter().map(|p| p.kills).sum(),
                souls: mine.iter().map(|p| p.souls).sum(),
            }
        })
        .collect()
}

/// The winner's name for `m_iWinningTeam` (−1 or 0 before the end).
pub fn winner_name(t: i64) -> Option<String> {
    match t {
        2 => Some("amber".into()),
        3 => Some("sapphire".into()),
        _ => None,
    }
}

// ---- the demo's command stream ----

/// `EDemoCommands`, the ones read here.
pub mod cmd {
    pub const STOP: u32 = 0;
    pub const FILE_HEADER: u32 = 1;
    pub const FILE_INFO: u32 = 2;
    pub const SYNC_TICK: u32 = 3;
    pub const FULL_PACKET: u32 = 13;
    /// The flag on a command whose body is snappy-compressed.
    pub const COMPRESSED: u32 = 64;
    /// Command numbers above this aren't Source 2's.
    pub const MAX: u32 = 32;
}

/// One command's header: its number (without the flag), whether its body is compressed, its tick
/// (−1 in the signon), its body's size, and how many bytes the header took.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub cmd: u32,
    pub compressed: bool,
    pub tick: i32,
    pub size: u32,
    pub len: usize,
}

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

/// The command header at the start of `b`, if there is a whole one.
pub fn header(b: &[u8]) -> Option<Header> {
    let mut at = 0;
    let raw = uvarint(b, &mut at)?;
    let tick = uvarint(b, &mut at)? as i32;
    let size = uvarint(b, &mut at)?;
    let cmd = raw & !cmd::COMPRESSED;
    (cmd <= cmd::MAX).then_some(Header { cmd, compressed: raw & cmd::COMPRESSED != 0, tick, size, len: at })
}

/// Does a walk over command headers from `from` land exactly on `target` (both offsets into `b`),
/// with ticks that never go back? A walk from a real command boundary does; from a byte that only
/// looks like a header, it almost never does.
pub fn walks_onto(b: &[u8], from: usize, target: usize) -> bool {
    let mut at = from;
    let mut last = i32::MIN;
    while at < target {
        let Some(h) = header(&b[at..]) else { return false };
        if h.tick < last && h.tick >= 0 {
            return false;
        }
        last = last.max(h.tick);
        at += h.len + h.size as usize;
    }
    at == target
}

/// The latest offset in `b[..target]` where a compressed full packet starts that walks onto
/// `target`, and its tick, if `body_ok` accepts its body (the caller checks it decompresses).
/// `floor` is where the search stops (the start of the bytes read so far that are new).
pub fn last_full_packet(b: &[u8], floor: usize, target: usize, body_ok: impl Fn(&[u8]) -> bool) -> Option<(usize, i32)> {
    let byte = (cmd::FULL_PACKET | cmd::COMPRESSED) as u8;
    (floor..target).rev().filter(|&p| b[p] == byte).find_map(|p| {
        let h = header(&b[p..])?;
        let end = p + h.len + h.size as usize;
        (h.cmd == cmd::FULL_PACKET && h.tick >= 0 && end <= target && walks_onto(b, p, target) && body_ok(&b[p + h.len..end])).then_some((p, h.tick))
    })
}

#[cfg(feature = "parse")]
pub use reader::{Read, read, read_counted};

#[cfg(feature = "parse")]
mod reader {
    use super::*;
    use crate::{content_build, reason};
    use boon::Parser;
    use boon_proto::proto::{CDemoFileHeader, CDemoFileInfo, CDemoFullPacket};
    use prost::Message;
    use std::collections::HashSet;
    use std::fs::File;
    use std::io::{Read as _, Seek, SeekFrom};
    use std::path::Path;

    const CONTROLLER: &str = "CCitadelPlayerController";
    const PAWN: &str = "CCitadelPlayerPawn";
    const RULES: &str = "CCitadelGameRulesProxy";
    /// The signon is ~0.3 MB; more than this isn't a demo we know.
    const MAX_SIGNON: usize = 16 << 20;
    /// Read back from the end this much at a time while looking for a full packet.
    const CHUNK: usize = 1 << 20;
    /// Full packets come a minute apart (~11 MB); past this the scan gives up.
    const MAX_BACK: usize = 96 << 20;

    pub type Failure = &'static str;

    /// What the read cost: bytes read from the file, and whether it fell back to boon's index of
    /// the whole file.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub struct Read {
        pub bytes: u64,
        pub whole_file: bool,
    }

    /// The preview of the demo at `path`, for match `match_id` (its file name).
    pub fn read(path: &Path, match_id: u64) -> Result<Preview, Failure> {
        read_counted(path, match_id).map(|(p, _)| p)
    }

    /// [`read`], and what it cost.
    pub fn read_counted(path: &Path, match_id: u64) -> Result<(Preview, Read), Failure> {
        let mut d = Demo::open(path)?;
        let signon = d.signon()?;
        let h = decode_header(&signon)?;
        let dir = h.game_directory.unwrap_or_default();
        if !dir.contains("citadel") {
            return Err(reason::NOT_A_REPLAY);
        }
        let build = content_build(&dir);
        let server_start = h.server_start_tick.unwrap_or(0).max(0);
        let result = match d.light(&signon, server_start) {
            Ok(end) => end,
            Err(_) => {
                // Spliced reads failed on this demo: boon's own index over the whole file.
                d.read.whole_file = true;
                d.read.bytes = d.len;
                whole(path, server_start)?
            }
        };
        let preview = Preview { match_id, start_time: 0, duration_s: result.duration_s, game_mode: result.game_mode, winner: winner_name(result.winner), teams: teams(&result.players), build };
        Ok((preview, d.read))
    }

    fn decode_header(signon: &[u8]) -> Result<CDemoFileHeader, Failure> {
        let h = header(&signon[16..]).filter(|h| h.cmd == cmd::FILE_HEADER).ok_or(reason::NOT_A_REPLAY)?;
        let body = signon.get(16 + h.len..16 + h.len + h.size as usize).ok_or(reason::NOT_A_REPLAY)?;
        CDemoFileHeader::decode(&body_of(h, body).ok_or(reason::NOT_A_REPLAY)?[..]).map_err(|_| reason::NOT_A_REPLAY)
    }

    fn body_of(h: Header, raw: &[u8]) -> Option<Vec<u8>> {
        if h.compressed { snap::raw::Decoder::new().decompress_vec(raw).ok() } else { Some(raw.to_vec()) }
    }

    /// A full packet's body: it decompresses and decodes, with a string table and a packet.
    fn full_packet_ok(raw: &[u8]) -> bool {
        snap::raw::Decoder::new().decompress_vec(raw).ok().and_then(|b| CDemoFullPacket::decode(&b[..]).ok()).is_some_and(|f| f.string_table.is_some() && f.packet.is_some())
    }

    struct Demo {
        file: File,
        len: u64,
        /// Where the stream ends: the `DEM_FileInfo` command (from the file's header).
        info_at: u64,
        read: Read,
        /// The file's tail read so far: `tail` holds bytes `[tail_at, info_at)`.
        tail: Vec<u8>,
        tail_at: u64,
    }

    /// The match's end, from the entities.
    struct End {
        players: Vec<EndPlayer>,
        winner: i64,
        game_mode: i64,
        duration_s: u32,
    }

    impl Demo {
        fn open(path: &Path) -> Result<Demo, Failure> {
            let mut file = File::open(path).map_err(|_| reason::NOT_A_REPLAY)?;
            let len = file.metadata().map_err(|_| reason::NOT_A_REPLAY)?.len();
            let mut head = [0u8; 16];
            file.read_exact(&mut head).map_err(|_| reason::NOT_A_REPLAY)?;
            if &head[..8] != crate::DEM_MAGIC {
                return Err(reason::NOT_A_REPLAY);
            }
            let info_at = u64::from(u32::from_le_bytes([head[8], head[9], head[10], head[11]]));
            // A file still being written has no file info yet (0) or a short tail.
            if info_at < 16 || info_at >= len {
                return Err(reason::CORRUPT);
            }
            Ok(Demo { file, len, info_at, read: Read { bytes: 16, whole_file: false }, tail: Vec::new(), tail_at: info_at })
        }

        fn read_at(&mut self, at: u64, n: usize) -> Result<Vec<u8>, Failure> {
            let mut buf = vec![0u8; n];
            self.file.seek(SeekFrom::Start(at)).map_err(|_| reason::CORRUPT)?;
            self.file.read_exact(&mut buf).map_err(|_| reason::CORRUPT)?;
            self.read.bytes += n as u64;
            Ok(buf)
        }

        /// The playback ticks in `DEM_FileInfo` (the recording's length).
        fn playback_ticks(&mut self) -> Result<i32, Failure> {
            let n = (self.len - self.info_at).min(4096) as usize;
            let b = self.read_at(self.info_at, n)?;
            let h = header(&b).filter(|h| h.cmd == cmd::FILE_INFO).ok_or(reason::CORRUPT)?;
            let body = b.get(h.len..h.len + h.size as usize).ok_or(reason::CORRUPT)?;
            let info = CDemoFileInfo::decode(&body_of(h, body).ok_or(reason::CORRUPT)?[..]).map_err(|_| reason::CORRUPT)?;
            info.playback_ticks.filter(|t| *t > 0).ok_or(reason::CORRUPT)
        }

        /// The file from its start through `DEM_SyncTick`: header, signon packets, send tables,
        /// class info, string tables.
        fn signon(&mut self) -> Result<Vec<u8>, Failure> {
            let mut b = vec![0u8; 16];
            b.copy_from_slice(&self.read_at(0, 16)?);
            self.read.bytes -= 16;
            let mut at = 16usize;
            loop {
                if b.len() < at + 16 {
                    let more = (256 << 10).min((self.info_at as usize).saturating_sub(b.len()));
                    if more == 0 || b.len() > MAX_SIGNON {
                        return Err(reason::NOT_A_REPLAY);
                    }
                    let next = self.read_at(b.len() as u64, more)?;
                    b.extend_from_slice(&next);
                    continue;
                }
                let h = header(&b[at..]).ok_or(reason::NOT_A_REPLAY)?;
                let end = at + h.len + h.size as usize;
                if h.cmd == cmd::SYNC_TICK {
                    b.truncate(end);
                    return Ok(b);
                }
                if h.cmd == cmd::STOP || end > MAX_SIGNON {
                    return Err(reason::NOT_A_REPLAY);
                }
                if b.len() < end {
                    let next = self.read_at(b.len() as u64, end - b.len())?;
                    b.extend_from_slice(&next);
                }
                at = end;
            }
        }

        /// The latest full packet before `before` (an offset in the file that is a command
        /// boundary): its offset and tick. Reads the tail back a chunk at a time.
        fn full_packet_before(&mut self, before: u64) -> Result<(u64, i32), Failure> {
            loop {
                let target = (before - self.tail_at) as usize;
                // Only the bytes read since the last miss are new candidates, but a candidate's
                // walk runs to `before`, so the whole tail is searched (cheap: header walks).
                if let Some((p, tick)) = last_full_packet(&self.tail, 0, target, full_packet_ok) {
                    return Ok((self.tail_at + p as u64, tick));
                }
                if self.tail_at <= 16 || (self.info_at - self.tail_at) as usize > MAX_BACK {
                    return Err(reason::PARSE_FAILED);
                }
                let n = CHUNK.min((self.tail_at - 16) as usize);
                let mut more = self.read_at(self.tail_at - n as u64, n)?;
                more.extend_from_slice(&self.tail);
                self.tail = more;
                self.tail_at -= n as u64;
            }
        }

        /// The stream bytes `[from, to)` of the tail, reading back further if needed.
        fn tail_slice(&mut self, from: u64, to: u64) -> Result<&[u8], Failure> {
            if from < self.tail_at {
                let mut more = self.read_at(from, (self.tail_at - from) as usize)?;
                more.extend_from_slice(&self.tail);
                self.tail = more;
                self.tail_at = from;
            }
            Ok(&self.tail[(from - self.tail_at) as usize..(to - self.tail_at) as usize])
        }

        /// The spliced read (the module's doc).
        fn light(&mut self, signon: &[u8], server_start: i32) -> Result<End, Failure> {
            let ticks = self.playback_ticks()?;
            let (last, last_tick) = self.full_packet_before(self.info_at)?;
            let info_at = self.info_at;
            // The last full packet on to the end of the stream.
            let to_end = splice(signon, self.tail_slice(last, info_at)?);
            let at_last = decode(to_end, i32::MAX, server_start, true)?;
            if at_last.first_winner || at_last.end.winner <= 0 {
                // The winner came after the last full packet (or never): this is the end.
                return Ok(at_last.end);
            }
            // The win was before it: play forward from the full packet before the win.
            let won = at_last.update_tick - server_start;
            if won <= 0 || won > last_tick || won > ticks {
                return Err(reason::PARSE_FAILED);
            }
            let mut before = last;
            let (from, _) = loop {
                let (p, t) = self.full_packet_before(before)?;
                if t <= won {
                    break (p, t);
                }
                before = p;
            };
            let segment = splice(signon, self.tail_slice(from, last)?);
            let to_win = decode(segment, won + 1, server_start, true)?;
            if to_win.end.winner <= 0 {
                return Err(reason::PARSE_FAILED);
            }
            Ok(to_win.end)
        }
    }

    /// The signon, then stream bytes from a full packet on, as one demo for boon. The header's
    /// offsets (file info, spawn groups) don't hold in it: zero (absent).
    fn splice(signon: &[u8], stream: &[u8]) -> Vec<u8> {
        let mut b = Vec::with_capacity(signon.len() + stream.len());
        b.extend_from_slice(signon);
        b[8..16].fill(0);
        b.extend_from_slice(stream);
        b
    }

    struct Decoded {
        end: End,
        /// The first tick decoded (the full packet) had no winner and a later one did.
        first_winner: bool,
        /// The rules' `m_nMatchClockUpdateTick` at the end (the server tick of the win, once won).
        update_tick: i32,
    }

    /// Play the spliced demo from its full packet to `end_tick` (exclusive) or its end. With
    /// `stop_at_win`, the state is taken on the first tick with a winner.
    fn decode(demo: Vec<u8>, end_tick: i32, server_start: i32, stop_at_win: bool) -> Result<Decoded, Failure> {
        let parser = Parser::from_bytes(demo);
        let start = parser.full_packet_offsets().map_err(|_| reason::PARSE_FAILED)?.first().map(|o| o.0).ok_or(reason::PARSE_FAILED)?;
        let classes: HashSet<&str> = [CONTROLLER, PAWN, RULES].into_iter().collect();
        let mut out: Option<Decoded> = None;
        let mut first = true;
        let mut no_winner_first = false;
        let mut done = false;
        parser
            .decode_segment(Some(start), end_tick, &classes, |ctx| {
                if done {
                    return;
                }
                let (end, update_tick) = state(ctx, server_start);
                if first {
                    no_winner_first = end.winner <= 0;
                    first = false;
                }
                let won = end.winner > 0;
                let mode = end.game_mode;
                let prev_mode = out.as_ref().map_or(0, |o| o.end.game_mode);
                out = Some(Decoded { end: End { game_mode: if mode == 0 { prev_mode } else { mode }, ..end }, first_winner: no_winner_first && won, update_tick });
                if stop_at_win && won {
                    done = true;
                }
            })
            .map_err(|_| reason::PARSE_FAILED)?;
        let d = out.ok_or(reason::PARSE_FAILED)?;
        if d.end.players.is_empty() {
            return Err(reason::PARSE_FAILED);
        }
        Ok(d)
    }

    /// The players, the rules' winner, mode and clock on this tick.
    fn state(ctx: &boon::Context, server_start: i32) -> (End, i32) {
        let field = |class: &str, p: &str| ctx.serializers().get(class).and_then(|s| s.resolve_field_key(p));
        let (team, pawn_of, hero, pawn_hero, kills, souls) = (
            field(CONTROLLER, "m_iTeamNum"),
            field(CONTROLLER, "m_hPawn"),
            field(CONTROLLER, "m_PlayerDataGlobal.m_nHeroID"),
            field(PAWN, "m_CCitadelHeroComponent.m_spawnedHero.m_nHeroID"),
            field(CONTROLLER, "m_PlayerDataGlobal.m_iPlayerKills"),
            field(CONTROLLER, "m_PlayerDataGlobal.m_iGoldNetWorth"),
        );
        let g = |p: &str| field(RULES, &format!("m_pGameRules.{p}"));
        let ents = ctx.entities();
        let mut players = Vec::new();
        let mut end = End { players: Vec::new(), winner: 0, game_mode: 0, duration_s: 0 };
        let mut update_tick = 0;
        for (_, e) in ents.iter() {
            match e.class_name.as_ref() {
                CONTROLLER => {
                    let mut hero_id = e.get_i64(hero).max(0) as u32;
                    if hero_id == 0 {
                        hero_id = e.get_handle(pawn_of).and_then(|h| ents.get_by_handle(h)).filter(|p| p.class_name.as_ref() == PAWN).map_or(0, |p| p.get_i64(pawn_hero).max(0) as u32);
                    }
                    players.push(EndPlayer { index: e.index, team: e.get_i64(team), hero_id, kills: e.get_i64(kills).clamp(0, u32::MAX.into()) as u32, souls: e.get_i64(souls).clamp(0, u32::MAX.into()) as u32 });
                }
                RULES => {
                    end.winner = e.get_i64(g("m_iWinningTeam"));
                    end.game_mode = e.get_i64(g("m_eGameMode"));
                    update_tick = e.get_i64(g("m_nMatchClockUpdateTick")) as i32;
                    let pause = crate::parse::Pause { total: e.get_i64(g("m_nTotalPausedTicks")), running: e.get_bool(g("m_bGamePaused")), since: e.get_i64(g("m_nPauseStartTick")) };
                    let interval = f64::from(ctx.tick_interval());
                    let start = f64::from(e.get_f32(g("m_flGameStartTime")));
                    // As the timeline counts it: whole seconds before this tick, from the horn.
                    let now = crate::parse::server_clock(i64::from(ctx.tick() + server_start), pause, interval) - interval;
                    end.duration_s = if start > 0.0 { (now - start).max(0.0) as u32 } else { 0 };
                }
                _ => {}
            }
        }
        end.players = players;
        (end, update_tick)
    }

    /// boon's own index over the whole file, then the same reads: the fallback.
    fn whole(path: &Path, server_start: i32) -> Result<End, Failure> {
        let parser = Parser::from_file(path).map_err(|_| reason::NOT_A_REPLAY)?;
        let fps = parser.full_packet_offsets().map_err(|_| reason::PARSE_FAILED)?;
        let classes: HashSet<&str> = [CONTROLLER, PAWN, RULES].into_iter().collect();
        // From the second-last full packet (a minute before the last) to the end, stopping at a win.
        let start = fps.len().checked_sub(2).map(|i| fps[i].0).or(fps.first().map(|o| o.0));
        let mut out: Option<End> = None;
        let mut done = false;
        parser
            .decode_segment(start, i32::MAX, &classes, |ctx| {
                if done {
                    return;
                }
                let (end, _) = state(ctx, server_start);
                done = end.winner > 0;
                out = Some(end);
            })
            .map_err(|_| reason::PARSE_FAILED)?;
        out.filter(|e| !e.players.is_empty()).ok_or(reason::PARSE_FAILED)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varint(mut v: u32, out: &mut Vec<u8>) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return;
            }
            out.push(b | 0x80);
        }
    }

    fn command(cmd: u32, tick: i32, body: &[u8], out: &mut Vec<u8>) -> usize {
        let at = out.len();
        varint(cmd, out);
        varint(tick as u32, out);
        varint(body.len() as u32, out);
        out.extend_from_slice(body);
        at
    }

    #[test]
    fn teams_are_amber_then_sapphire_with_slots_by_entity_index() {
        let p = |index, team, hero_id, kills, souls| EndPlayer { index, team, hero_id, kills, souls };
        let players = [p(5, 3, 13, 4, 1000), p(2, 2, 7, 3, 900), p(1, 2, 65, 1, 500), p(9, 1, 0, 0, 0), p(4, 3, 0, 9, 9), p(3, 3, 6, 2, 700)];
        let t = teams(&players);
        assert_eq!(t[0], PreviewTeam { team: "amber".into(), heroes: vec![[0, 65], [1, 7]], kills: 4, souls: 1400 });
        // The heroless controller (index 4) isn't a player: not in the kills or souls either.
        assert_eq!(t[1], PreviewTeam { team: "sapphire".into(), heroes: vec![[0, 6], [1, 13]], kills: 6, souls: 1700 });
        assert_eq!(winner_name(2).as_deref(), Some("amber"));
        assert_eq!(winner_name(3).as_deref(), Some("sapphire"));
        assert_eq!(winner_name(-1), None);
    }

    #[test]
    fn the_shape_is_the_servers() {
        let p = Preview { match_id: 7, start_time: 0, duration_s: 60, game_mode: 1, winner: None, teams: teams(&[]), build: None };
        let json = serde_json::to_string(&p).expect("json");
        assert_eq!(json, r#"{"match_id":7,"start_time":0,"duration_s":60,"game_mode":1,"winner":null,"teams":[{"team":"amber","heroes":[],"kills":0,"souls":0},{"team":"sapphire","heroes":[],"kills":0,"souls":0}]}"#);
        let p = Preview { build: Some(6839), ..p };
        assert!(serde_json::to_string(&p).expect("json").ends_with(r#","build":6839}"#));
    }

    #[test]
    fn headers_read_as_the_demo_writes_them() {
        let mut b = Vec::new();
        command(cmd::FULL_PACKET | cmd::COMPRESSED, 172_801, &[1, 2, 3], &mut b);
        assert_eq!(header(&b), Some(Header { cmd: 13, compressed: true, tick: 172_801, size: 3, len: 5 }));
        assert_eq!(header(&[0x80, 0x80]), None);
        // −1 in the signon.
        let mut s = Vec::new();
        command(cmd::FILE_HEADER, -1, &[], &mut s);
        assert_eq!(header(&s).map(|h| h.tick), Some(-1));
        assert_eq!(header(&[60, 0, 0]), None, "not a Source 2 command");
    }

    /// A stream like a demo's tail: packets each tick, a full packet every 4 ticks, then Stop. A
    /// packet body holding the full packet's command byte mustn't be taken for one.
    #[test]
    fn the_last_full_packet_is_found_scanning_back_and_walking_forward() {
        let fp = (cmd::FULL_PACKET | cmd::COMPRESSED) as u8;
        let mut b = Vec::new();
        let mut fps = Vec::new();
        for tick in 0..20 {
            if tick % 4 == 1 {
                fps.push((command(cmd::FULL_PACKET | cmd::COMPRESSED, tick, b"FULL", &mut b), tick));
            }
            // A body that starts like a full packet header (77, tick, a small size).
            command(7 | cmd::COMPRESSED, tick, &[fp, tick as u8, 2, fp, 9, 1, 0, 0], &mut b);
        }
        let stop = command(cmd::STOP, 20, &[], &mut b);
        let ok = |body: &[u8]| body == b"FULL";
        assert_eq!(last_full_packet(&b, 0, stop, ok), Some(fps[4]));
        // The one before it: walking onto the last one's offset.
        assert_eq!(last_full_packet(&b, 0, fps[4].0, ok), Some(fps[3]));
        assert_eq!(last_full_packet(&b, 0, fps[0].0, ok), None);
        // A body check that refuses everything finds nothing.
        assert_eq!(last_full_packet(&b, 0, stop, |_| false), None);
        assert!(walks_onto(&b, fps[2].0, stop));
        assert!(!walks_onto(&b, fps[2].0 + 1, stop));
    }

    #[test]
    fn a_walk_whose_ticks_go_back_is_not_the_stream() {
        let mut b = Vec::new();
        let a = command(7, 10, &[0], &mut b);
        command(7, 4, &[0], &mut b);
        let end = command(cmd::STOP, 11, &[], &mut b);
        assert!(!walks_onto(&b, a, end));
    }
}

/// Against a real replay, never committed: `MAPCRO_REPLAY=/path/to/<id>.dem cargo test -p
/// mapcro-replay --release preview -- --ignored --nocapture`. On 129738985 it's the summary's
/// numbers (kills 39/35, souls 352,176/332,070) and the timeline's (2,640 s, the same heroes by slot).
#[cfg(all(test, feature = "parse"))]
mod real {
    #[test]
    #[ignore = "needs a local replay: MAPCRO_REPLAY"]
    fn a_real_replay_reads_from_its_signon_and_last_minute() {
        let dem = std::path::PathBuf::from(std::env::var_os("MAPCRO_REPLAY").expect("set MAPCRO_REPLAY"));
        let id: u64 = dem.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse().ok()).expect("<match id>.dem");
        let started = std::time::Instant::now();
        let (p, read) = super::read_counted(&dem, id).expect("reads");
        let len = std::fs::metadata(&dem).expect("meta").len();
        eprintln!("{:?}, {} of {} bytes: {}", started.elapsed(), read.bytes, len, serde_json::to_string(&p).expect("json"));
        assert!(!read.whole_file);
        assert!(read.bytes < len / 10);
        assert_eq!(p.teams.len(), 2);
        if id == 129_738_985 {
            assert_eq!((p.duration_s, p.winner.as_deref(), p.game_mode, p.build), (2640, Some("amber"), 1, Some(6839)));
            assert_eq!(p.teams.iter().map(|t| (t.kills, t.souls, t.heroes.len())).collect::<Vec<_>>(), [(39, 352_176, 6), (35, 332_070, 6)]);
        }
    }
}
