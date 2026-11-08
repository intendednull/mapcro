# 2026-11-08: Player and the replay tier, a handoff

The agent that built the replay tier and Player is handing its queue to fresh agents. This note
covers how the parts fit together, what's queued with the decisions already taken, and the
traps. The spec is `docs/specs/architecture-design.md` (§6a replay tier, §6b Player). The
history is in `2026-11-07-replay-tier.md` and `2026-11-08-player.md`.

## Architecture map

**Worker** (`crates/replay`, its own sandboxed systemd service, `nix/module.nix`)

- `parse.rs`: boon reads a `.dem` into one `Sample` per game second (`derive::Obs`).
  - Field paths are resolved once, in `Keys::resolve`.
  - The clock is `(tick + server_start_tick − paused) × interval − m_flGameStartTime`. Sampling
    stops when `m_iWinningTeam` is set.
  - `Obs` also carries `game_mode` and `winner`.
- `derive.rs` turns `Obs` into a `Timeline`. It's pure, and the unit tests use synthetic `Obs`:
  - players: positions, health (0 when dead), deaths, souls, ult %
  - objectives: down only on a seen fall; the loser's patron falls at the end
  - rifts, powerups, waves (5 s median split)
  - events
  - troopers (base64 per team per second)
  - `objective_health` (pct where it changes, by board key; the patron also gets `stage`)
  - `Refused` covers `OldMap`, `Empty` and `UnsupportedMode(n)`. `reason()` maps them to job
    reason codes.
- `timeline.rs` holds the shared format and `validate()`, the server's bounds check on the
  worker's untrusted output. Every new field needs a bound there, plus a "bad" case in its test.
- `worker.rs` runs the on-disk queue:
  - `inbox` is server-owned. `outbox` gets `.parsing`, `.json` or `.failed`.
  - Each job runs in a child process, and SIGBUS means `corrupt`.
- `main.rs`: `mapcro-replay parse <dem> <out.json> <id>` runs one demo by hand.

**Server** (`crates/server`)

- `matches.rs` is the metadata tier: deadlock-api metadata, derived and cached in
  `DATA_DIR/matches/<id>.json`.
  - Names come from one profiles call. Account ids are never kept.
  - The mode check refuses non-standard modes with 422 and writes `<id>.refused`.
- `replays.rs`:
  - upload, CDN fetch, job status
  - the board's timeline route (replay cache first, else the metadata; `no-store`)
  - attach and attached matches
  - the collector, which takes `outbox` results for jobs it queued and validates them

**Web** (`web/src`)

- `match/timeline.ts`: the `Timeline` type and its pure readers at time t (`playersAt`,
  `downAt`, `sitesAt`, `wavesAt`, `objectiveHealthAt`).
- `player/host.ts` holds Player's state for one board:
  - mode (player or sandbox, with the held state), the open match, the timeline, the job, the
    status
  - the playback clock (`clock.ts`: `tAt` clamps, followers carry forward)
  - presence and follow (a mirror with receive-time stamps)
  - the toggles `showTroopers` and `showHealth`
  - `preview(markers)`, which builds the `MatchPreview` (`match/preview.tsx`) the board draws
- `player/live.ts` / `layer.ts`: the live annotation layer, a hidden `Scene.live` per match.
  - Ids are deterministic (FNV), written through `editSilent`.
  - Ink is cleared when the last viewer leaves, and kept only by Save scene.
- Rendering:
  - `board/Board.tsx` mounts the map overlays inside `MapView`: `TrooperDots`,
    `ObjectiveHealth` and `Highlight` from `player/Player.tsx`.
  - Tokens come from `board/Tokens.tsx`, which reads `preview().players`. That includes the
    health arc.
  - The top bar is `player/PlayerTopBar.tsx`.
  - Markers' statuses come from Board's `status` callback.
- `player/Player.tsx`: the transport bar (scrubber, speed, toggles, tier chip, Save scene),
  `PlayerSide` (the events list) and the map overlays. `player/Events.tsx` and `events.ts` hold
  the events list (labels, search, follow).
- Ownership: app-builder owns `board/*`, `MapView`, `transform` and the schema. Keep your hunks
  there small, tell app-builder, and commit only your own hunks (explicit pathspecs; a temporary
  index when a file mixes changes).

## Done in this stretch

- eeca3fa: the dock's Player switch is always shown for editors.
- 5b670ce: Brawl and unknown modes are refused at both tiers; real-data checks on 129738985.
- ac74ad6: hero and objective health, and the losing patron falls at the end.

## Queue (fresh agents take these)

Each item is replay tier only. The metadata tier lacks the data, and the tier chip's hover text
should name what's missing.

1. **Event pings during playback.**
   - When playback passes an event that's visible under the current filters and search, ping it
     at its place.
     - Deaths ping at the victim's position at that moment. Objectives ping at their icon. Reuse
       `placeOf` and `jumpTime` in `player/events.ts`.
     - Only forward crossings during play count. Seek and scrub must not burst. A jump keeps its
       existing ring (`host.ring`).
   - Rings:
     - About 1.5 s each, smaller and subtler than the jump ring, and shorter at 4× and 8×.
     - Each event gets its own element, so overlapping rings all show.
     - Followers ping the same way from their own clock.
   - Add a "Pings" toggle in the transport, on by default.
   - e2e: play across 2–3 events and assert a ring near each one's location, and none for a
     skipped event.
   - Screenshot a teamfight on 129738985.
   - Files: `host.ts` (crossing detection off the playback clock), `Player.tsx` (overlay and
     toggle), CSS in `styles/app.css`.
2. **Jungle camps.** The research is in `docs/research/replay-parsing-exploration.md` round 3
   (camp-probe, 4d699f9).
   - Source: `CCitadelGameRulesProxy.m_pGameRules`:
     - `m_vecNeutralCampNextSpawnTimes`: 52 float slots. −1 means alive. T > 0 means cleared,
       respawning at T, already in match-clock seconds.
     - `m_vecNeutralCampTimerOrigins` and `m_vecNeutralCampTimerIsMidBoss`. Slot 1 is the mid
       boss.
   - Map slots to the pack's camp keys **by matching origins** (all 51 match to 0.0 units), not
     by index.
   - Timeline: per camp, the first spawn, then (cleared_at, respawn_at) intervals, about 5–6 KB.
     Bound it in `validate()`.
   - Player:
     - A camp shows only its state on the map: not yet spawned, alive, or cleared (dimmed like
       Sandbox's cleared look).
     - Hovering a cleared camp shows "Respawns in m:ss (at mm:ss)". Before its first spawn the
       tooltip says "Spawns at mm:ss". On a phone, a tap shows it. No countdown is ever
       visible without hovering.
     - The mid boss works the same way, from match data. It's not the Sandbox manual timer.
   - Optional: the clearing team, from user message 345 (CurrencyChanged) with
     `currency_source = 15`. Show it only once it's verified against clears.
   - Gate on `m_eGameMode == 1`. Pre-6712 builds are already refused.
   - Never read health from inactive entities. Dead neutrals keep a stale health.
   - e2e on a synthetic timeline: a camp goes alive, cleared, alive. Hover it and assert the
     tooltip text, and assert no countdown text shows without hover.
   - Screenshot camps mid-game on 129738985 and look at it.
3. **Troopers like the in-game minimap.**
   - Match the minimap's trooper markers: shape, size relative to the map, team colours, and the
     low or dying look if the minimap has one.
     - If the game files have the icon, extract it with `crates/extract` (exact VPK paths; the
       pack stays outside the repo).
     - Otherwise match by eye. Ask main for an in-game minimap screenshot.
   - On by default. Dots move smoothly and vanish on death. Guardians and walkers keep their
     icons plus health.
   - Performance: 100+ dots at 8×, plus followers. Profile it, keep frame time well under 16 ms
     on 129738985 at 8×, and report the number. `TrooperDots` in `Player.tsx` is a `<For>` of
     circles keyed by sample; per-trooper interpolation is in `player/troopers.ts`.
   - Screenshot a mid-game moment with all three lanes busy.
   - Lead from camp-probe, not yet asked for: the zipline split is networked directly.
     - `CCitadelZipLineNode.m_iTeamNum` is 2 (amber), 3 (sapphire) or 0 (neutral). The nodes
       sit exactly on our lane polylines, ordered by `m_flCumulativeDistance`.
     - The edges are amber = max t of team-2 nodes and sapphire = min t of team-3 nodes. Along
       a lane it's always one run: amber, neutral, sapphire.
     - Our 5 s trooper split lands inside the true neutral gap only 52–56% of the time.
     - Data: `/tmp/camp-probe/out4/129738985/`.
     - Ask main before replacing the wave split with it.
4. **Stale split.** Not done.
   - Draw a held split dimmed or hatched on the lane, with "last seen m:ss ago" on hover. Keep
     the "Waves held" chip.
   - Don't change the front calculation. Decay was rejected.
   - The split data is `waves[].stale` ranges. It's drawn in `MapView`'s `Lanes` (app-builder's
     file). Coordinate with app-builder.

## Gotchas

- **BUILD_ID:** `crates/schema/build.rs` hashes `crates/schema/src` and `crates/engine/src`. Any
  change there needs a fresh WASM (`just wasm`), or the server refuses the client's Auth. The
  operator's dev server also has to be rebuilt and restarted after such a change.
- **e2e runs against built artifacts:** the server binary and `web/dist`. `just e2e` builds both;
  running Playwright directly does not. Before `npx playwright test`, run
  `cargo build -p mapcro-server` and `npx vite build`.
- **Shared `test-results`:** several agents run Playwright at once, and they delete each other's
  traces, which shows up as ENOENT failures. Pass `--output /tmp/<yours>` and use
  `--workers ≤ 2`.
- **The box is shared with Adora.** Gate every heavy job (cargo, vite, tsc, Playwright, parses)
  on `/tmp/mapcro-busy.sh` being free **and** a 1-minute load under 12. Every gate needs a
  deadline that **aborts** ("box busy") rather than running anyway.
  `/tmp/mapcro-scripts/gate.sh <secs>` does that. Use `cargo -j 4`.
- **Fixtures:**
  - `crates/server/tests/fixtures/match-130816395-trimmed.json` is a trimmed real metadata with
    no account fields. It has no `game_mode`, and absence imports as standard.
  - Replay e2e specs write a synthetic timeline into `REPLAY_DIR/outbox` for the job the upload
    queued. That's the queue's contract, because real demos are never committed.
- **Real-replay shots:** `e2e/shots-replay.spec.ts` with
  `MAPCRO_SHOT_REPLAY=<timeline.json>`, `MAPCRO_SHOT_PACKS=~/.local/share/mapcro/packs` and
  optionally `MAPCRO_SHOT_REPLAY_ID` (default 129738985) and `MAPCRO_SHOT_TIMES`.
  - Make the timeline with
    `target/release/mapcro-replay parse <dem> /tmp/mapcro-real/129738985-replay.json 129738985`.
  - Shots are gitignored (`web/shots/`).
  - Reading a PNG with the Read tool needs `offset`/`limit`, or the size hook blocks it.
- **Demo paths:** open only exact paths, and never list or glob a Steam or Deadlock folder. The
  standard demo is
  `~/.local/share/Steam/steamapps/common/Deadlock/game/citadel/replays/129738985.dem`
  (504 MB, 6v6, build 6839, full-world recording).
  - 122134063.dem is **Street Brawl**: use it only as the Brawl case
    (`MAPCRO_BRAWL_REPLAY`).
  - 108440637, 107550569 and 106114966 are pre-6712 (`old_map`).
- **Standard mode only:** every new replay-tier feature assumes `m_eGameMode == 1`.
- **Privacy:** Steam and account ids are never stored, cached, logged or sent to the client.
  The in-game names in a demo are fine.
- **Stale entity values:** an inactive entity can keep its last health. Parse only active
  entities. Heroes' alive state requires `active`, life state 0 and health > 0.

## Open questions

- The metadata tier names the losing patron `patron:sapphire:lane3:1`, but the map's key is
  `patron:sapphire:lane0:1`. Check which one the board's markers use for the metadata tier.
- Patron stage mapping: `m_ePhase` 1 (final) is drawn as stage 2, and 0 (shielded) and 2
  (transforming) as stage 1. On 129738985, stage 2 starts at 43:08 and the patron falls at
  44:00, which looks right. Confirm it by eye against the game.
- Objective rings show at any health under 100%, so a guardian at 99% after regen gets a ring.
  The threshold might need raising.
- The token health arc is thin at the default zoom. It may need to be heavier.
- The replay records 78 deaths against the metadata's 74 for 129738985. The extra 4 aren't
  explained.
- The mid boss's killer team isn't read from the demo.

## Update (lane-data, later the same day)

Queue item 2, the zipline lead in item 3 and item 4 (now moot) are done, and the patron-key and
78-vs-74 questions are answered: see [the lane data entry](2026-11-08-lane-data.md).
