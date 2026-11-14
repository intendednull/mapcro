# Sessions build, phases 3 onward: handoff

Branch `sessions-p3` (worktree `mapcro.worktrees/sessions-p3`), off main a0774c5. The spec is
`docs/specs/sessions.md`; what phase 3 built is written into its §4.1, §4.2, §4.3, §5 and §10.
Newest state at the top.

## State when the third implementer finished (2026-11-14): phase 3 is ready for review

**Every check of phase 3 has run and is green on the branch's code (aae0a05; the commits after
it are documents). Nothing is merged; the lead reviews, gates and releases. Phase 4 is not
started.** Commits by the third implementer: ae3fbc6 (the server test), 5656abb (layers a tab
holds), 958638b, aae0a05 (the unsettled-layer row, phase 4's checks), b7a56f3, and the one
this note is in.

### The six items the second implementer left

1. **The queued job (batch 5)**, on 68e39a3: `tsc` clean; the switch measured three times;
   full e2e 474 passed, 3 failed (TD-92's three `laser-gestures` tests, under load), 8 skipped.
   Superseded by batch 6's full run below.
2. **The pool stays removed** (the lead's bar: a median `drawn` of about 80 ms without it).
   "Left earlier", no pool, the held timeline drawn after the document, four runs of 14
   switches, median (min–max), ms:

   | Run | mounted | drawn | timeline | live |
   |---|---|---|---|---|
   | 1 | 29 | 66 (54–94) | 156 | 172 |
   | 2 | 37 | 80 (55–179) | 177 | 209 |
   | 3 (the box at its busiest) | 55 | 112 (57–194) | 231 | 233 |
   | 4 (the box quiet) | 26 | 55 (50–80) | 131 | 146 |
   | 1 to 4, HTTP at 40 ms and 20 Mbit/s | 24–35 | 71, 55, 70, 51 | 139–191 | 169–239 |
   | 49 scenes (one run) | 35 | 93 (69–186) | 186 | 235 |

   Before this change, without the pool: 120. With the pool: 33. Before phase 3: 59. The
   numbers follow the box's load; the quiet run is under what it was before phase 3. In the
   spec, §10 phase 3.
3. **Layers and Vision: a tab holds only what its user set there** (5656abb;
   `session/tabview.ts` `tabOwn`, `withOwn`; `player/host.ts` `own`, fed by the view-state
   store's `onOwn`). A tab only opened and left shows this browser's choice, as a board alone
   does. A presenter's values aren't held, unless the user's own change stops the follow and
   keeps them. `remember` always answers now: for a tab left before its matches were known or
   its match confirmed, the mode and playback are what it remembered before, and a layer set
   meanwhile is kept (it was lost). Spec §4.1, §4.2, §9.1, §10 and §12 item 7.
4. **The missed server mutant** (`replays.rs:727`, `scope == "cdn"` to `!=` in `let tier`):
   not equivalent. The tier reaches the debug line "cached replay unreadable", which is what
   the lead reads to learn why a board got the summary. The test
   `an_unreadable_cached_replay_is_logged_by_its_tier` puts a directory where each cached file
   would be and reads the server's log. cargo-mutants again on the route's diff: **10 mutants,
   9 caught, 1 unviable, 0 missed.**
5. **The browser-row mutants** (`/tmp/sp3-e2e-mutants.py`; never in the repo). Its pattern for
   "the validators held are never sent" was already right. With four for the layers, nine in
   all, **9 killed**:

   | Mutant | Rows | Result |
   |---|---|---|
   | refused: what was drawn early stays | the timeline cache | killed |
   | the validators held are never sent | the timeline cache | killed |
   | nothing drawn before the server answers | the timeline cache | killed |
   | a 304 is asked again, plainly | the timeline cache | killed |
   | a remembered scene checked against the stored copy | a tab comes back as it was left | killed |
   | a layer set on a tab is never its own | Player: … map layers | killed |
   | a tab only passed through pins the Heals it showed | Player: … map layers | killed |
   | what a tab held before is dropped at its next leaving | Player: … map layers | killed |
   | a layer set before the match is confirmed is lost | Player: … map layers | killed |

   And 14 hand mutants over `tabOwn` and `withOwn`, all killed by the unit file (the first run
   missed one, a layer set dropping Vision: its assertion was added).
6. **The walkthrough** (a scratch Playwright spec on the e2e server, never committed: three
   boards with the reference replay, C holding the same match as A; counts and booleans only):
   - each tab given its own: A a time, 2x and Heals on; B a time, Troopers off, left on a
     second scene with its match behind it; C a time and a zoom, no layer set;
   - **nine switches, nine came back as left** (scene, scene count, mode, clock, play, speed,
     Heals, Troopers, Heavy boxes, viewport); A again after a reload;
   - B's match was where it was held; B kept Troopers off; A kept its Heals; C, only passed
     through, followed this browser's Heals both times it changed;
   - **the timeline:** A 14 requests, 2 sent (the first open, and the reload) and 12 answered
     304; B 12, 1 sent, 11 at 304; **C 10, none sent**, its first answer a 304 (the fetched
     replay is one file for every board). Every 304 had no body. Each open asks twice (the
     open, and its job's `done`), as the spec says;
   - **0 page errors, 0 console errors**, and the frozen-timeline guard stayed quiet.
   Its first run failed in the script, not the app: in Player no scene is current, so Add
   scene has nothing to copy. The script picks a scene first now.

### The runs (batches 6 and 7, through `tools/heavy.sh`)

- `cargo test -p mapcro-server --test replays`: 46 passed. `just clippy`: clean.
- `just web-test`: **69 files, 682 tests passed, `tsc` clean.** In batch 6 one test of
  `sessions-client.test.ts` timed out under load ("an edit made as its board is left still
  goes to that board"); alone it passed 23 of 23 twice, then the whole recipe passed. It isn't
  a loss: TD-101.
- Full e2e, 2 workers, `MAPCRO_SHOT_REPLAY` set: **477 passed, 0 failed, 8 skipped** (24.2 min),
  with the layers change and its rows in. `laser-gestures` and `session-isolation` alone after:
  18 passed.
- `git status` clean after the mutants.

### For the review, and for phase 4

- The spec's §10 item 4 carries two checks into phase 4: a follower moved off a tab keeps
  nothing of the presenter's layers (decision 7 as read); the unsettled path when a follow
  moves a person off a tab at that moment.
- The scratch scripts (the batches, the mutants, the walkthrough) are in `/tmp/sp3-*` and
  `/tmp/sp3-edit/`, with a copy in `~/.cache/mapcro-sp3-scratch/`. None is in the repo.
- A background job of the harness is stopped after two hours, queue time included: start a
  batch detached (`setsid nohup`), append to its log (`>>`), and wait on a done line.

## State when the second implementer stopped (2026-11-14, context budget)

**Phase 3 is verified except for the items under "Left to do" (each small). Nothing is merged;
phases 4 and 5 are not started.** Commits on `sessions-p3` after ddac12b: 9a59cb4 (main merged),
4341490, e26b7a5, d7ab947, and the one this note is in.

### What changed since the first handoff

- **The pool is removed** (d7ab947: `RoomPool`, `BoardSession.park`/`resume`,
  `BoardReplica.approxHeapBytes`; `core/session.ts`, `board/state.ts` and `crates/wasm` are as on
  main). The numbers and the reasoning are in the spec's §10 phase 3. To put it back: revert
  d7ab947 (its tests come back with it; its 26 hand mutants never ran).
- **Every timeline Player shows is frozen**, cached or not, and `e2e/fixtures.ts` fails any test
  whose page writes to a frozen object. No write to a timeline was found: none by reading the
  code that takes one, none in two full e2e runs with the guard on.
- **A remembered scene that's gone** was checked against the stored copy, which still held it:
  it's checked once the board has caught up (`state.current()`).
- **A held timeline draws after the board's document is on screen** (`Board.tsx`
  `documentDrawn`, `host.ts` `loadTimeline`): its first render takes 60 to 100 ms and was
  holding the document back.
- `DECODED_PER_CHAR` is 1.75 (four runs measured 1.59 to 1.60).
- The route's `ETag` passes Caddy's `encode` unchanged, 200 and 304 (2.11.3, 2.11.4, a debug
  server behind it): `docs/deploy.md`. **No deploy order is needed**, as the first handoff said.
- Debt rows are TD-93 to TD-96 (main took 89 to 92). TD-96 is new: a timeline's first draw.

### Results

- `just web-test`: 69 files, 681 tests passed, `tsc` clean (with the pool: 70 files, 694).
- `just clippy` clean; `just test` passed (run with the pool in; the server hasn't changed since).
- Full e2e, 2 workers, with `MAPCRO_SHOT_REPLAY` set so the perf and shots specs ran too: 477
  passed, 0 failed (21.2 min), on d7ab947 plus the 1.75. Note: the worktree's path holds
  "sessions", so an `e2e sessions` filter runs every spec.
- Hand mutants, `tabview.ts` and `timelineCache.ts`: 20 killed of 20 (the script is deleted;
  its pool and session mutants went with the pool).

  | Mutant | Result |
  |---|---|
  | parse: another board's view restored | killed |
  | save: the newest dropped; no cap | killed, killed |
  | withScenes: a dead scene kept; the viewport outlives its scene | killed, killed |
  | withMatches: never attached; playback outlives its match | killed, killed |
  | parse: any string is a scene; a view with a bad y | killed, killed |
  | playerPart: the map part goes to Player | killed |
  | cache: the fetched replay kept per board; an upload kept for every board | killed, killed |
  | confirm: another validator accepted; not marked used | killed, killed |
  | candidates: the fetched before the board's own | killed |
  | put: one over the cap pushes the rest out; everything else evicted; not frozen | killed ×3 |
  | freeze: shallow; remove: bytes not given back | killed, killed |

- Browser-row mutants (`/tmp/sp3-e2e-mutants.py`, not in the repo: one edit, a client build, the
  named rows of `session-isolation.spec.ts`): refused and still drawn, nothing drawn before the
  answer, a 304 asked again plainly, a remembered scene checked against the stored copy: 4
  killed. The fifth (the validators held are never sent) had a stale pattern and was queued
  again: see "Left to do".

### Left to do for phase 3

**The worktree's `target/` directory disappeared at about 03:10 on 2026-11-14, during the second
full e2e run** (not by this implementer; perhaps a disk clean-up). That run, the first with the
paint-first change in, passed 249 tests, then failed about 70 once the server binary was gone,
and 159 did not run: it says nothing about the change. Build the server again before any e2e
(`cargo build -q -p mapcro-server`, through `tools/heavy.sh`).

1. **The paint-first change (44f2fd5, `Board.tsx` `documentDrawn`) is unmeasured and has no
   full e2e run.** `/tmp/sp3-batch5.sh` does both (server build, client build, the switch
   measured three times with `MAPCRO_SHOT_REPLAY` and `MAPCRO_PERF_LABEL`, then
   `just e2e --workers 2`); it was queued to `/tmp/sp3-batch5.log` when this was written. If the
   log isn't there, run it again through `tools/heavy.sh nix develop -c bash /tmp/sp3-batch5.sh`,
   or the commands by hand.
2. **Decide on its numbers.** Expected: `drawn` near 60 ms without the pool on this box (it was
   120 before the change, 59 before phase 3). If it is still far over 80, either the change
   needs work (or goes: revert its three lines in `Board.tsx` to
   `createEffect(() => state.metaId() !== undefined && ok())`, which the first full run covered)
   or the pool goes back in (revert d7ab947).
3. **cargo-mutants on the route's diff: done** (`cargo mutants -j 1 --in-diff <(git diff a0774c5
   -- crates/server/src) -p mapcro-server -- --test replays`): 10 mutants, 8 caught, 1 unviable,
   1 missed. The missed one is `replays.rs:727`, `scope == "cdn"` to `!=` in `let tier = …`, a
   line phase 3 didn't change (it's context in the diff): no replays test reads `tier`. Clippy
   and the wasm tests passed after. (`mutants.out/` got into 68a8b4f by `git add -A` while the
   run was writing it; the next commit takes it out. It isn't ignored: worth a `.gitignore` line.)
4. **One browser-row mutant is unrun** (`host.ts`: `api.timeline(id, held.map(...))` to
   `api.timeline(id)`; the "timeline cache" rows must fail). The other four were killed before
   the paint-first change; `/tmp/sp3-e2e-mutants.py <worktree>` runs all five (it edits source
   in place: alone, through `tools/heavy.sh`, and `git status` after).
5. **Browser walkthrough** of switching tabs (counts and DOM only): not done. The debug server
   serving `web/dist` is enough; `just dev` isn't needed.
6. Put the paint-first row and the cargo-mutants table into the spec's §10 phase 3.

## State when the first implementer stopped (2026-11-13, context budget)

**Phase 3 (speed) is written and committed, with its unit tests passing as of the run noted
below. Its e2e run, the measurement after, and both mutation runs are still to do: see "Left to
do". It is not ready to release.** Nothing is
merged. Phases 4 and 5 are not started.

### What phase 3 is

- **`TabView`** (`web/src/session/tabview.ts`; Board reads it at mount, writes it on cleanup and
  `pagehide`; Player's part goes through `createPlayerHost(…, remembered)` and `host.remember()`).
  sessionStorage, `mapcro.tabview.<session>.<board>`, 200 at most.
- **The timeline cache** (`web/src/player/timelineCache.ts`, `host.ts` `loadTimeline`,
  `api.ts` `timeline(id, held)`), with a **server change**: `ETag` and `If-None-Match` on
  `GET /api/boards/{board}/matches/{id}` (`crates/server/src/replays.rs` `timeline_etag`, `holds`,
  `read_unless_held`). Compatible both ways: an old server sends no `ETag` (nothing is cached),
  an old client sends no `If-None-Match`. No deploy order is needed.
- **`RoomPool`** (`web/src/session/pool.ts`) and `BoardSession.park` / `resume`
  (`web/src/core/session.ts`); `BoardReplica.approxHeapBytes` in `crates/wasm`. `BUILD_ID` doesn't
  move (no schema or engine change).

### Decisions taken where the spec left a choice

- **Vision and the map layers are per tab once the tab was left** (§12 item 7, which §4.1's
  first line contradicted; §4.1 now says so). A tab never opened, and a board alone, take this
  browser's last choice, and every change is still written there. Player names stay device-wide.
- **The timeline cache asks the server every time** (a conditional request), rather than trusting
  a key of `(scope, match, tier, format)` the client can't know to be current. The route's side
  effects (the open is counted, a stale fetched timeline is refreshed) run on a 304 too.
- **The pool's limits count the boards parked beside the open one** (trimmed in a microtask after
  the switch): otherwise the board being switched to could be dropped by the park of the board
  being left.
- **One session per board in the page**: a parked session of the same board under another
  credential is ended, not kept beside the new one.
- **A parked session with pending edits** waits up to 2 s on its socket for acks, then flushes on
  quiet reconnects (no presence sent, so it's on nobody's people list).
- A remembered scene that's gone drops the scene, viewport and side only; a match no longer
  attached drops the match, playback and mode only.
- Not built: prefetch of the neighbour tab's timeline (§5 "may"); floor in `TabView` (no floor
  state exists: TD-95); TD-60 (a revoked own link hiding a granted board) and TD-63 (undo marks
  after a reload) are untouched.

### Measured (dev box under load, debug server, reference replay 129738985; ms, median (min–max))

Before (a0774c5), `web/e2e/perf-session-switch.spec.ts`, 14 switches each:

| Switch | mounted | drawn | timeline | live |
|---|---|---|---|---|
| to a board never opened here | 32 | 120 | 325 | 108 |
| to a board left earlier | 25 (22–42) | 59 (51–109) | 286 (235–347) | 71 (42–98) |
| the same, HTTP at 40 ms and 20 Mbit/s | 27 (23–44) | 59 (47–118) | 463 (412–565) | 98 (83–145) |
| left earlier, boards of 49 scenes | 25 (20–28) | 82 (62–93) | 285 (269–305) | 91 (68–100) |
| the same, HTTP at 40 ms and 20 Mbit/s | 30 (25–54) | 72 (55–107) | 465 (424–512) | 110 (94–197) |

A decoded timeline: 1.50 MiB of JSON is 1.5 to 2.2 MiB on the heap; parsing takes 4 to 7 ms,
freezing it all the way down 9 to 11 ms with no growth in heap.

**After: not measured yet.** Run the same spec on the branch and put both tables in the spec's
§10 phase 3 (the "Built" note there is still to write).

### Tests so far

- `cargo test -p mapcro-server --test replays`: 45 passed (2 new: the validator, and the same
  through a grant).
- `web/test/sessions-speed.test.ts` (TabView, RoomPool, the timeline cache: pure),
  `web/test/sessions-park.test.ts` (park and resume against the real server) and
  `module-state.test.ts`: 36 passed, `tsc` clean. **Not run since:** two tests added after that
  (the pool keeping a session of exactly its budget; a session parked before it finished
  loading), and the pool's trim moved to a microtask before that run, so it is covered.
- **The hand mutation run was written, queued behind the box's other jobs, and stopped
  unrun** when the context budget ran out: `web/scripts/sessions-p3-mutants.py <worktree>`, 46
  one-line mutants over `pool.ts`, `tabview.ts`, `timelineCache.ts` and `session.ts`'s park and
  resume, each of which the two test files must fail. It edits the source in place and puts it
  back after each mutant: run it alone, through `tools/heavy.sh`, with nothing else touching the
  tree, and check `git status` after. Delete the script once its table is in the phase report.

### Left to do for phase 3

0. The two unit files again, then the hand mutation run (above).
1. `just e2e session sessions board-unmount player --workers 2` through `tools/heavy.sh`. The
   new and changed rows are in `web/e2e/session-isolation.spec.ts` (the last four tests, and
   "scenes and the current scene"). They were written without a run: expect selector fixes.
   Player specs matter because cached timelines are now **frozen all the way down**: any code
   that writes to a timeline throws.
2. The measurement after: `MAPCRO_SHOT_REPLAY=~/.local/share/mapcro/data/replays/129738985-cdn.json
   MAPCRO_PERF_LABEL=p3 npx playwright test perf-session-switch`, again with
   `MAPCRO_PERF_SCENES=48`, and once with `MAPCRO_PERF_EVICT=1`. Never print a timeline.
3. `cargo mutants -j 1 --in-diff <(git diff a0774c5 -- crates/server/src)` for the route change
   (the wasm method is covered only by the web tests: TD-88).
4. `just web-test` whole, `just clippy`, then the spec's §10 phase 3 "Built" note with both
   tables, and say whether the pool pays (the spec makes it optional if cold switches are fast).
5. Browser walkthrough on `just dev` (free ports), counts only.

### For phase 4 (follow across tabs)

Merge main first: the map-state agent (`map-state-p3`) is in `web/src/player/host.ts`,
`view_state.rs` and `Board.tsx`. Phase 3 touched `host.ts` (`loadTimeline`, `open`, `init`,
`remember`) and `Board.tsx` (the remembered view near the top, the pool option), so expect
conflicts there. Session presence isn't sent yet (`session/state.ts`).
