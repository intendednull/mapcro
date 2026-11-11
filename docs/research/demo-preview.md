# A picker card's preview from the demo itself (2026-11-11, demo-preview)

Question (operator): can the Windows app build a replay picker card's preview (heroes per team,
team kills, team souls at the end, the winner, the length, the mode, the build) from the local
`.dem`, with a small read instead of the full ~14 s parse? Then every replay in the folder gets a
card, including fresh matches, old ones past deadlock-api's reach, and uploads, with no server call.

**Answer: yes.** `crates/replay/src/preview.rs` `read` takes 0.05 to 0.56 s and reads 5 to 23 MB
(1 to 5% of the file) on all four local demos, builds 6683 to 6839. On 129738985 its numbers are
the server preview's and the full parse's. The file-info block doesn't help: it holds only the
playback length.

Probe: `crates/replay/examples/preview_probe.rs <demo> [--explore]`. It prints field paths,
counts, timings and per-team aggregates keyed by hero id only. All numbers below are from this
box under load (shared, load 9 to 50).

## 1. The file's own summary: `CDemoFileInfo` and `CDemoFileHeader`

- The 16-byte header is `PBDEMS2\0`, then a u32 LE **file-info offset** and a u32 LE
  **spawn-groups offset** (pbdems2's name). In Deadlock the second one is the `DEM_Stop` command,
  5 bytes before the file info. On 129738985 the file info is 20 bytes from the end.
- **`CDemoFileInfo`** (cmd 2, 15 bytes) has only `playback_time` (2706.7 s), `playback_ticks`
  (173,229) and `playback_frames`. **`game_info` is absent**: no `dota` block (no players, heroes,
  winner, match id or mode) and no `cs` block. All 4 demos are the same (playback_frames is a few
  ticks short of playback_ticks on the two 67xx demos).
- **`CDemoFileHeader`** (cmd 1, the first command, 202 bytes): `map_name` "start", `build_num`
  (engine build, 10932), `game_directory` (`…citadel_v6839…`, the content build),
  `server_start_tick` (4424), no `game` string. No players.

So neither gives heroes or a score. Reading them costs ~65 KB and ~1 ms.

## 2. The stream, and the light read

Command census on 129738985 (504 MB): one `DEM_Packet` (7) per tick (173,229 of them, 492 MB,
~2.8 KB each); 46 `DEM_FullPacket`s (13), **every 3,840 ticks (60 s at 64 ticks/s)**, starting at
tick 1, 129 to 287 KB each, ~10 MB apart. Every full packet is compressed (cmd byte 77). The
signon runs from the file header to `DEM_SyncTick` (3) at byte 266,251: signon packets (8),
`SendTables` (4, 69 KB), `ClassInfo` (5, 15 KB) and `StringTables` (6, 72 KB). Then a packet at
tick 1 and the first full packet.

**boon 0.19** has `Parser::parse_to_tick` and `decode_segment(start, end_tick, classes, …)`, which
restore from a full packet. Both need its index (`prepare`), and the index walks every command
header in the file. On an mmap that touches every page (the packets are smaller than a page), so
it reads the whole 504 MB on a cold cache. The walk itself took 55 ms warm. `Parser::from_bytes`
takes any buffer, though, and its index accepts a header whose two offsets are 0 ("absent").

**The read** (`preview::read`):

1. Read the 16-byte header and the file info (playback ticks, a bound).
2. Read the signon, from byte 0 through `DEM_SyncTick` (~0.27 MB).
3. **Find the last full packet without an index.** Scan back from the file info for a byte 77
   (`FULL_PACKET | COMPRESSED`) that parses as a command header and walks forward, header by
   header, with ticks never going back, **exactly onto the file info's offset**. Its body must also
   decompress (snappy) and decode as a `CDemoFullPacket` with a string table and a packet. The
   tail is read back 1 MB at a time.
4. Splice the signon and the bytes from that full packet to the end into one buffer, zero the
   header's offsets, and let boon decode it (`from_bytes`, `decode_segment`) with only
   `CCitadelPlayerController`, `CCitadelPlayerPawn` and `CCitadelGameRulesProxy`.
5. If the match already had its winner at that full packet, the souls are past the win. The
   rules' **`m_nMatchClockUpdateTick`** is the server tick of the win: minus `server_start_tick`
   it gives the demo tick the winner was set on (129738985: 175,094 − 4,424 = 170,670, the first
   tick with `m_iWinningTeam` > 0). Find the full packet at or before it (the same scan, walking
   onto the last one's offset), splice it again, and play to the winning tick.
6. A demo whose tail the scan can't place (more than 96 MB back) falls back to boon's whole-file
   index (`Read.whole_file`). None of the four did.

**Fields read** (the same paths as the full parse, research README table):

| Preview field | Source at the end |
|---|---|
| heroes `[slot, hero_id]` | controller `m_PlayerDataGlobal.m_nHeroID` (else the pawn's `m_CCitadelHeroComponent.m_spawnedHero.m_nHeroID`), team `m_iTeamNum` 2/3; slots in controller entity-index order, as derive.rs numbers them. Two team-1 controllers without heroes (spectators) are left out |
| kills | controller `m_PlayerDataGlobal.m_iPlayerKills`, summed per team |
| souls | controller `m_PlayerDataGlobal.m_iGoldNetWorth`, summed, **at the winning tick** |
| winner | rules `m_pGameRules.m_iWinningTeam` (−1 until the end; 2 Amber, 3 Sapphire) |
| duration_s | the full parse's clock (`parse::server_clock`, pauses out) one tick before the win, minus `m_flGameStartTime`, floored. `m_flMatchClockAtLastUpdate` reads 2640.03 at the win, the same; it only updates at some events (148.1 a minute before the end), so it isn't used |
| game_mode | rules `m_pGameRules.m_eGameMode` |
| build | `game_directory`'s `citadel_vNNNN` |
| start_time | not in the demo: 0 (the card shows the file's time). Checked: `CDemoFileHeader` has no time field (stamp, names, directories, build, `server_start_tick`); `CDemoFileInfo` only the playback length; at the last full packet no field of any of 2,861 entities holds a unix-like value (seconds or ms, 2023–2028) except token hashes (`m_ItemID`, `m_SourceModifierID`, `m_vecUpgrades`, `m_nEntityId`); the rules' times are all server-clock (`m_fLevelStartTime`, `m_flGameStartTime`, `m_flRoundStartTime`). Probe `--clock`. String fields weren't looked at (names) |

Other rules fields at the end, for later: `m_eGameState` 7 in play, 8 for ~10 s from the win
(`m_flGameStateStartTime` 2709.19, `m_flGameStateEndTime` 2719.19), then 11 (post-game);
`m_flGGEndsAtTime` 0. There's no `m_flGameEndTime`.

**After the win** the souls keep growing: at the end of the recording 129738985 reads
353,196 / 332,882, against 352,176 / 332,070 at the win (+1,020 / +812). Kills don't change.
The recording runs on 2,559 ticks (40 s) past the win there, under one full-packet stride, so
the full packet before the last one is pre-win. The code doesn't count on that.

## 3. Results

Release build, the probe's two runs (the second has the tail in the page cache):

| Demo | Build | Size | Read | Time | Result |
|---|---|---|---|---|---|
| 129738985 | 6839 | 504 MB | 11.0 MB | 0.18 s / 0.15 s | 6+6 heroes, kills 39/35, souls 352,176/332,070, Amber, 2,640 s, mode 1 |
| 108440637 | 6701 | 458 MB | 14.2 MB | 0.27 s / 0.21 s | 6+6 heroes, Amber, 1,854 s, mode 1 |
| 100747544 | 6683 | 478 MB | 22.6 MB | 0.56 s / 0.40 s | 6+6 heroes, Amber, 2,001 s, mode 1 |
| 122134063 | 6813 | 97 MB | 5.5 MB | 0.08 s / 0.05 s | 4+4 heroes, mode 4 (the Brawl case: the card says "Street Brawl") |

In the app, through its child process (`desktop/core` `preview::read`), 129738985 took 0.19 s.

**Against the server** (prod `GET /api/matches/129738985/preview`): kills 39/35, souls
352,176/332,070, 6+6 heroes: all equal. Prod's winner is `null` there (an old cached summary,
backlog); the demo says Amber. **Against the full parse** (`mapcro-replay parse`, format 9):
the same heroes in the same slots, souls at the last second 352,176/332,070, `duration_s` 2,640,
each team's kills equal to the other's deaths (39/35).

Why this works: a 6v6 demo is a full-world (HLTV) recording, and each full packet re-keyframes
the controllers and the rules, so a restart from one gives exactly the state the full stream has
(checked: the values at the last full packet and after it equal the full stream's).

## Dead ends and traps

- **`CDemoFileInfo.game_info`** is empty in Deadlock (Dota's `CDotaGameInfo` would have had
  heroes and the winner).
- **boon's `Parser::from_file`** indexes the whole file before any seek: it is the whole-file
  read we avoid. The spliced `from_bytes` buffer avoids it.
- **pbdems2 checks the header's offsets** against the buffer ("file-info header offset … outside
  command stream"): zero them in a spliced buffer.
- **`m_flMatchClockAtLastUpdate`** isn't a running clock.
- **The end of the recording isn't the end of the match** for souls (above).
