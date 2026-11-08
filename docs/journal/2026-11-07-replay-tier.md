# 2026-11-07: match import's replay tier

Match import v1 reads deadlock-api's metadata. The operator asked for the demo as the rich tier:
ults, exact life state, rifts, powerups and lane waves, parsed on the shared production box
without putting the board server at risk. Spec §6a and §11 hold the design; this is how it went.

## Decisions

- **A separate worker, not a thread.** The board server runs under `MemoryMax=256M`, and a
  480 MB demo's pages alone are more than that. `mapcro-replay` is its own crate, binary and
  systemd unit: its own user, no network, only the queue in view, one job at a time, each job
  in a child process under a wall clock so a hang or an OOM kill fails the job, not the worker.
- **A directory is the whole interface.** inbox, work, done, failed. The server and the worker
  share nothing else, so each side is tested alone: the server's system tests play the worker by
  moving files, and the worker's tests run its binary on a queue.
- **Uploads are scoped to their board.** A demo carries no match id, so "this is match N" can't
  be checked. A board sees only its own uploads; a demo fetched from Valve by match id is
  shared. (Low-stakes, recorded for the security review.)
- **The worker's output is untrusted.** The server deserialises it into the typed timeline,
  checks every length, range and key shape, and re-serialises it before caching.
- **Lane waves use the board's own projection,** ported from `web/src/map/lanes.ts` onto the
  fallback map's lane curves (copied verbatim, with a test that they match), and a golden value
  shared by a Rust and a TypeScript test.
- **UI defaults (low-stakes):** "Fetch replay" and "Upload .dem" sit in the panel's head while a
  match is open and no replay is done; ult rings sit beside the hero names in the panel; a
  "Waves held" label shows when any lane's split is held through a gap; the credit line names
  the replay's source.

## Predictions, before the first real parse

- The exploration's game clock is right. **Wrong:** it ran 48.8 s early.
- Parsing a 97 MB demo takes ~3 s, as in the exploration. **Wrong, pleasantly:** 0.9 s, because
  the worker asks boon to create only the dozen classes it reads.
- Peak memory is the parser's entity state. **Wrong:** it is almost all the memory-mapped demo.

## Surprises

- **The clock.** Death and objective times all came out 48 s before deadlock-api's for the same
  match (122134063), and ult cooldown starts sat ahead of the clock that was supposed to produce
  them. `GameTime_t` counts server ticks, and the recording starts `server_start_tick` (3121,
  48.8 s) into the server's life. With that added, deaths and objectives match the metadata to
  a second and the duration is the metadata's 890 s exactly, once the parse stops at
  `m_iWinningTeam`; the recording runs 40 s past the end. The exploration's one rift in this
  match was in that post-game tail. Correction noted in the exploration doc, §2.
- **Zero health that isn't a death.** Around a full packet, every guardian read health 0 for a
  sample, so the amber mid guardian "fell" at 2:36 instead of 9:40. An objective is now down
  only when nothing on its site is seen alive after its fall.
- **Ult cooldowns read 0/0 for tens of seconds** at the same moments, then resume mid-cooldown.
  Those gaps hold the last cooldown seen.
- **Souls are coarse in the demo too.** Both `m_iGoldNetWorth` and the pawn's currencies change
  a handful of times in 15 minutes, about the metadata's cadence. Left as is.
- **Old demos fail twice over.** The header's build (6683 < 6712) refuses them before parsing;
  forcing a parse anyway, the objectives sit off our sites and the map check refuses them too.

## Measurements (this machine, release build, one core)

| Demo | Size | Wall | Anonymous peak | Mapped demo | Timeline |
|---|---|---|---|---|---|
| 122134063 (current map, 15 min) | 97 MB | 0.9 s | 11 MB | 98 MB | 134 KB |
| 100747544 (old map, 34 min, forced past the header check) | 478 MB | 4.6 s | 19 MB | 470 MB | refused |

Mapped pages are clean and reclaimable under the cgroup cap, so `MemoryMax=1G` is generous: it
leaves room for the largest demos plus a decompression's page cache.

## Not done

- Pre-6712 demos (the 16,384-unit offset) and old-era packs.
- No success round trip on a real demo in CI: a real one can't be committed. The `#[ignore]`d
  test runs on a local replay (`MAPCRO_REPLAY`); the VM test round-trips a synthetic old-map demo.
- The mid boss's killer team isn't read from the demo ("unknown").

## 2026-11-08: 122134063 is Street Brawl; the checks again on a standard match

- **122134063 is a Street Brawl demo** (4v4, `m_pGameRules.m_eGameMode = 4`; the metadata says
  `game_mode: 4` and has 8 players). It must not serve as a standard fixture. What leaned on it,
  and where it stands now:
  - The game-clock correction (`server_start_tick`) and the stop at `m_iWinningTeam` were checked
    on it. Re-checked on the standard 129738985 below: still right to a second.
  - The exploration's lane fronts, its "PVS-limited demo" reading, and its "no base guardians or
    mid boss" and "powerups never active" notes all describe Brawl. Camp-probe corrected that in
    the exploration doc (round 3). 129738985 networks the whole world every second.
  - My 2026-11-08 split-vs-troopers numbers and the "large none counts" came from it. They're
    replaced below.
  - The measurement table above (97 MB, 0.9 s, 134 KB) is a Brawl match. The standard numbers
    are below.
  - The e2e specs use 122134063 only as a number, on synthetic timelines. `player-mode` uses it
    as the Brawl it is, and `shots-replay` now defaults to 129738985.
- **Non-standard modes are refused** at both tiers. The replay tier reads `m_eGameMode` and fails
  as `brawl` or `unsupported_mode`. The metadata tier reads `match_info.game_mode` and answers 422
  with the same codes, so a board never attaches the match (spec §6a).
- **Split vs troopers on 129738985** (44 min). The split lies within the two fronts ±30 map units
  every second both sides have troopers on the lane: lane1 2528/2528, lane4 2327/2327, lane6
  2511/2511. Seconds with one side only: 96 / 293 / 113. Seconds with none: 17 / 21 / 17 (before
  the first wave). Troopers sit within 34 map units of the lane curve at p99. Split decay was
  rejected (the operator's decision); a held split is drawn as stale instead.
- **Hero presence on 129738985.** Every hero has a position for exactly the seconds it's alive
  (81–96% of the match). The longest run alive without a position is 4 s, around respawns.
- **Metadata vs replay, same match (129738985).**
  - Duration: 2640 s for both.
  - Deaths: 74 in the metadata against 78 in the replay. Every metadata death is within 1 s of a
    replay death.
  - Objective falls: within 1 s. The replay misses the final patron, because the parse stops at
    the winner's tick before the patron reads 0.
  - Mid boss times: within 1 s. The replay doesn't know the killer team.
  - Positions: median 13 world units apart in the same second, p90 456, p99 1567. That spread is
    the metadata's re-anchoring and quantisation.
  - The replay adds 5 rifts, 2 powerups, 3 lane waves, ults and 268 events (the metadata has 99).
  - Size: 1.43 MB with troopers, 450 KB for the metadata.
- **Measurements, standard match:** 129738985.dem is 504 MB and parses to a 1.43 MB timeline in
  5.6 s (release build, one core).
- **The other local demos** (108440637, 107550569, 106114966) are all pre-6712, so they're
  refused as `old_map` before their mode is read.
