# Sessions build, phases 3 onward: handoff

Branch `sessions-p3` (worktree `mapcro.worktrees/sessions-p3`), off main a0774c5. The spec is
`docs/specs/sessions.md`; what phase 3 built is written into its §4.1, §4.2, §4.3, §5 and §10.
Newest state at the top.

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
  state exists: TD-91); TD-60 (a revoked own link hiding a granted board) and TD-63 (undo marks
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
