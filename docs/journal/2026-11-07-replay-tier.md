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
