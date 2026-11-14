# Map-state build: state and handoff (2026-11-13)

Phase 1 was built on branch `scene-state`; phase 2 is on `map-state-p2`. Spec: `docs/specs/map-state.md`
(third revision). Review: `docs/specs/map-state-review.md`. Newest state at the top.

## State: phases 3 onward, branch `map-state-p3` (sixth implementer, 2026-11-13 late)

Off main `a0774c5` (prod `e878c30`, store v10). Newest first.

### D4's review fixes and the merge of main (2026-11-14, 09:00)

The D4 review (a fresh reviewer) found no blocker. On this branch since:

- **S2, fixed (`2063827`):** a field of Player's state is made on its first read. Before, every
  field's memo was made with its entity and ran each frame for nobody (the bar asks only
  `inSight`): 4,463 reads of the frame's series over 59 frames, now none
  (`frame-clocks.test.ts` holds the upper bound).
- **S3:** TD-97's trigger is "before `Tokens.tsx` reads `heroDraw`"; the lead accepted the gap
  for D4.
- **N2, N3 fixed (`95cf802`):** Save reads `savedPart` (the four things it stores), which the
  second's part is built on; the read-back expects literal respawn values. **N1, N4:** TD-99,
  TD-100. **N5** (old scenes' dead heroes keep the unset "respawn"; a team-wipe save shows up
  to six labels): no action.
- **S1** (a scene drawing the faded hero and its ghost reads as a second difference from
  Player): with the operator; the lead's earlier call stands until then.
- **Main `91e81c2` merged** (release 2 as cherry-picks of this branch, mobile defaults).
  Conflicts resolved as ours, with main's TD-92 row kept: main's copies of the conflicted
  files are this branch's own history.

### After the restart (2026-11-14, 06:35): the two reruns are in; this branch is the D4 release candidate

- **`npm test` whole at `59efdec`:** 72 files, 713 passed, 1 skipped; `tsc` clean. With the
  e2e at `a12eabe` (311 passed; after it only a local array in `scene.ts` and docs changed),
  **`map-state-p3` is the D4 release candidate**: client only, no row, no store version.
- **The `cda86fb` perf verdict: no worse than `b3c9223`.** Fifteen more runs, each started only
  with the load under 10. With the first job's, the runs at load under 13 are three to six a
  build in every cell (late in the match, playing; median, then the range):

  | Match, CPU | Step 1 (`b3c9223`): JS % | fps | The rest (`cda86fb`): JS % | fps |
  |---|---|---|---|---|
  | 134623152, 1x | 9.3 (9.2 to 11.8), n 5 | 60 | 9.1 (8.7 to 9.9), n 4 | 60 |
  | 134623152, 4x | 25.3 (22.0 to 26.9), n 6 | 43 (16 to 47) | 25.3 (24.7 to 25.9), n 5 | 47 (42 to 48) |
  | 129738985, 1x | 10.1 (9.5 to 11.0), n 4 | 60 | 10.7 (9.4 to 11.7), n 5 | 60 |
  | 129738985, 4x | 20.5 (19.3 to 20.9), n 5 | 31 (26 to 33) | 20.9 (20.6 to 24.3), n 3 | 29 (13 to 29) |

  Tab, hover and scrub medians are within each other's ranges too (playing at 1x: Tab 35 and
  39 ms against 37 and 36; hover 40 and 45 against 41 and 46; paused scrub 19.5 and 20.6
  against 19.0 and 21.4). Each build has one slow 4x run (16 fps at load 11.8 for step 1,
  13 fps at load 7.1 for the rest). The 12.4 %, 54 fps that read as worse was the load.
  `cda86fb` need not be held.
- **D2 is on its own branch, `map-state-d2`** (worktree `mapcro.worktrees/map-state-d2`, off
  `59efdec`), so this one stays the candidate. Its notes are at the top of this file there.

### Resume after restart (2026-11-14, 05:45; the seventh implementer stopped for a daemon restart)

Everything is committed on `map-state-p3`. No heavy job of this stream is queued or running.
Read this section first, then the handoff below it (written earlier the same night; its
"next steps" list is still right from step 2 on).

**Done and verified**

- **Release 2, `map-state-r2` at `e1d7796`** (off main `a2d69da`; `b3c9223` and `17c6c67`, not
  `cda86fb`): `just web-test` 70 files, 684 passed, 1 skipped, `tsc` clean; e2e at two workers,
  45 spec files (player*, topbar*, scene*, map-state-dom-pins, follow-matrix, phone-player,
  map-furniture), 267 passed, 0 failed. Reported to the lead. Not run there: cargo tests, the
  full e2e (no Rust differs from main).
- **The map-DOM control: settled, the map does not differ.** The walk on each build twice
  (`b3c9223` twice, `cda86fb` twice; 75 paused frames each, 31,877 map elements, 778 hero
  tokens). The whole-map hash differs on 75 of 75 frames between two runs of the SAME build,
  from two things only: the order of the hero tokens in the document, and each token's
  `data-player` (the hero record's id, new with every board). With the record id left out and
  the order ignored, every frame holds exactly the same elements with the same attributes and
  text, 75 of 75, in all six pairs (each build against itself, and step 1 against the rest
  four ways). The hero-token hash (slot, place, sight, class) is identical 75 of 75 in every
  pair, the top bar 75 of 75. So no map element differs between `b3c9223` and `cda86fb`.
- **TD-97** (`245696c`), the four missed e2e wiring mutants.
- **Phase 4, to its first release boundary** (commits below). At `a12eabe`: e2e at two
  workers, 58 spec files (every player*, scene*, topbar*, map-state-dom-pins, board,
  board-file, objectives, markers, map-furniture, follow-matrix, phone*, match, palette-player,
  playtest, replay, tools, hero*), 311 passed, 0 failed; `tsc` clean; the DOM pins rewritten
  with `--update-snapshots` gave no difference (old scenes and Player draw as they did).
  E2e mutants of the new wiring, 4 of 4 caught: a scene's split not read (dom pins, playtest's
  lane drag), a scene's marker status not read (dom pins, three objectives tests), no respawn
  time captured, and one captured a second short (both by the new D4 test).

**Not verified: rerun before anything here ships**

1. **`npm test` whole, at the tip.** At `a12eabe` it was 71 of 72 files, 712 passed, 1 failed:
   the module-state guard, on a module-level empty array in `scene.ts`. Fixed in `674fca5`
   (the guard's file and `from-scene.test.ts` pass, `tsc` clean), but the whole suite has not
   run since. `/tmp/ms-p4/jobE.sh` does it (through `tools/heavy.sh nix develop <this tree> -c`).
2. **The `cda86fb` perf verdict is not final.** One interleaved job ran (4 rounds on
   134623152, 3 on 129738985, alternating, late in the match, playing), but rounds 2 and 3
   ran at load 30 to 67 (not this stream's jobs). The runs at load under 13, JS % of the main
   thread then fps:

   | Match, CPU | Step 1 (`b3c9223`) | The rest (`cda86fb`) |
   |---|---|---|
   | 134623152, 1x | 9.7 %, 60 (load 8.4); 11.8 %, 60 (7.3) | 8.7 %, 60 (9.2); 9.9 %, 60 (4.0) |
   | 134623152, 4x | 22.0 %, 16 (11.8); 25.1 %, 40 (6.0) | 25.9 %, 47 (8.5); 25.4 %, 47 (3.5) |
   | 129738985, 1x | 10.4 %, 60 (9.0) | 11.7 %, 60 (12.3); 10.1 %, 60 (5.4) |
   | 129738985, 4x | 20.6 %, 26 (11.0); 20.4 %, 31 (8.8) | 20.6 %, 29 (5.5) |

   **So far `cda86fb` is no worse:** at 1x both hold 60 fps with the script time inside each
   other's range (8.7 to 11.7 % against 9.7 to 11.8 %); Tab and hover medians are within the
   spread. At 4x on 134623152 its script share is 0.3 to 3.9 points higher while it draws
   more frames (47 fps against 16 and 40), which is the same work per frame or less. The one
   run that read as worse before (12.4 %, 54 fps) was load. **But that is two usable runs a
   build, one in two cells: the brief asks for three.** `/tmp/ms-p3-qa/jobB2.sh` runs four
   more rounds and waits for load under 10 before each (builds are in
   `/tmp/ms-p3-qa/dist-s1` and `dist-rest`, the checkout is `/tmp/ms-p3-perf`, the binary a
   copy in its own `target/`); `node /tmp/ms-p3-qa/perfsum.mjs 13` tabulates (add `perf4.log`
   to its file list). Keep `cda86fb` held until those are in.
3. **Scratch is not cleaned up**, because the reruns need it: `/tmp/ms-p3-perf` (a worktree),
   `/tmp/ms-p3-qa`, `/tmp/ms-p4`, `/tmp/ms-r2-gate`. Remove them once the perf is settled
   (`git worktree remove /tmp/ms-p3-perf`).

**Phase 4 commits on this branch (after `912272c`)**

| Commit | What | A coach sees |
|---|---|---|
| `be30918` | `fromScene`: a scene's records behind `MapState`; `marker.status`, `lane.split` | Nothing |
| `2c860f9` | `heroDraw`: the viewer's Vision, one rule for Player and a scene (D3, D5) | Nothing (nothing reads it yet) |
| `0e91064` | Spec §6: both as built | |
| `090eb2e` | `Board.tsx`: a scene's lane splits and marker statuses read its state | Nothing |
| `ca0b0f2` | **D4: Save writes a dead hero's respawn time** (`PlayerState.respawn`, whole seconds rounded up, at most 600) | A new scene's dead hero says "respawn 0:05", not the unset "respawn" |
| `a12eabe` | e2e for D4 (`scene-builds.spec.ts`) | |
| `674fca5` | The module-state guard's fix | |

**The release boundary is D4** (`ca0b0f2`): user-visible, no new row, no store version (the
field exists and every build reads it; old scenes are untouched). Hand mutants through vitest:
`scene.ts` 43 (40 at first, 2 after a test, 1 redundant guard removed), `shown.ts` 13 of 13,
the capture 9 (8 at first, the cap's value after a pin).

**Open decisions**

1. **D2 can't ship as reading alone.** `fromScene` gives the scene's own hero (`more.hero`)
   before the roster's, as D2 says; but the hero picker writes the roster. A scene saved from
   a match holds `more.hero`, so once tokens and bars read the state, picking another hero in
   that scene would change nothing there. D2's reading has to ship with its edit (the picker
   writes the scene's `hero` row; phase 6's first item) and with Save no longer rewriting the
   roster. Until then the tokens and bars keep reading the roster's hero, which is why they
   are not wired to `hero(slot).hero()` yet.
2. **D1 as built keeps one thing D1's words don't cover:** a scene with no `source` still
   takes the open match's names (`sceneMatchName`). Left as it is.
3. **The metadata tier's health** and **Show last seen location in a scene**: see the handoff
   below, "Open", 1 and 2.
4. **Retake could give an old scene's dead heroes their respawn time** (a `SetIf` on an
   absent `PlayerRespawn`). Not built.

**Next step:** the two reruns above; then, with the lead's answer on D2, `Tokens.tsx` reading
a token's view from `MapState` in both modes (the handoff's step 3; the oracle for Player is
`previewAt`'s `players` entry, as `shown.test.ts` already uses it).

### Handoff, eighth implementer (2026-11-14): release 2 cut, phase 4 started (seventh implementer's notes)

**Release 2 is branch `map-state-r2`** (worktree `mapcro.worktrees/map-state-r2`), off main
`a2d69da`: `b3c9223` (phase 3 step 1, as `ca3a51e`) and `17c6c67` (a copy carries `source`, as
`e1d7796`). Not `cda86fb`. Conflicts: this journal (theirs kept), and `17c6c67` against main's
RC1 F1 in the spec and two tests (both sides kept, as `1e4508b` did here: the test files are
byte for byte this branch's). Its gate, the perf comparison and the map-DOM control are
RESULTS below.

**A new rule (the lead, 2026-11-14): never link a `target/` across trees.** This worktree's
`target/` was deleted through such a link. Each tree gets its own (no Rust differs between
main, `b3c9223` and this branch, so a copy of the server binary serves all three; the gate
script copies it). Never `rm -rf` a path with a trailing slash that could be a link.

**TD-97** (`245696c`): the four e2e wiring mutants phase 3 missed, one row.

**Phase 4, two steps, nothing drawn from them yet (no change to what a coach sees or to what
is stored):**

- **`be30918`, `fromScene`** (`web/src/mapstate/scene.ts`): a scene's records behind
  `MapState`; `sceneRecords(board, sceneId)` takes them out of the board's state. The
  interface gained `marker(key).status` (the stored status; none in Player) and
  `lane(key).split` (Player: the middle of the colours' gap). The table of what each field
  means in a scene is in the spec, §6. Tests, `web/test/from-scene.test.ts` (11): every field
  against the records; the legacy meanings; a reader of one field reruns only when its value
  changes; and the round trip, Save's capture of Player's frame read back, at 15 times on both
  tiers (12 heroes, every marker's shown status, every lane). The synthetic match moved to
  `web/test/support/synthetic-match.ts`. Hand mutants: 43; 40 caught at first, 2 after a test
  was added (the board's name before the scene's own; `last` without its equality), 1 was a
  redundant guard, removed.
- **`2c860f9`, the viewer's Vision** (`web/src/mapstate/shown.ts`): `heroDraw`, one rule for
  both producers (D3, D5). Tested against what `previewAt` drew for every living hero at 121
  times on both tiers under six views (thousands of each of seen, ghost and not drawn). Hand
  mutants: 13 of 13.
- Run on both: the five map-state vitest files, 56 passed; `tsc` clean. The whole `just
  web-test` and the e2e wait for a heavy run (nothing reads the new code).

**Open, for the lead or the operator:**

1. **The metadata tier's health.** Save stores the path's coarse health with the build
   (`health` row); Player's state doesn't hold it there (not drawn on the map, operator
   2026-11-08). `from-scene.test.ts` pins the difference ("OPEN"). Before a scene's token
   draws health from its state: stop capturing it on that tier, or have the reader ask
   `source.tier`.
2. **Show last seen location in a scene (D3).** The rule gives the faded hero and its ghost
   (`faded.ghost`); whether a scene draws both is the renderer's choice, not decided.
3. **`down` for a rift that is off.** In a scene `marker(key).down` is "status is Destroyed",
   which is also a rift or urn point that is off. Renderers should read `status` in a scene.

**Next steps of phase 4, in the order that keeps each one small:**

1. **D4, capture:** Save writes a dead hero's respawn time (`PlayerState.respawn`, the typed
   field that exists; `Math.round(sample.respawn)`, at most 600). It changes a pin on purpose
   (`map-state-pins.test.ts`: `p.respawn === undefined`) and is user-visible (a new scene's
   dead hero says its time, not "respawn"): a release boundary of its own.
2. **Board.tsx:** `const sceneState = fromScene(sceneRecords(state, () => scene()?.id, names))`
   and one `mapState()` that picks by `inPlayer()`. First reader: `splitOf`
   (`lane(key).split()` in both modes; TD-97's e2e gap comes first).
3. **`Tokens.tsx`:** its fifteen `live()` branches become reads of `HeroState` plus
   `heroDraw`; D2's hero (`heroId` reads `slot().hero` today, never `more.hero`), D1's names
   (`names` from the source match: `player.tl()` when `scene.source.match_id` is the open
   match). `map-state-dom-pins.spec.ts` holds old scenes' DOM.
4. **Markers** (`markerStates` takes `marker(key)`; `status` first, then Player's detail), the
   two bars, then `RiftRings`, `UrnMark`, `DeathSkulls`, `MarkerTips`.

### Handoff, seventh implementer (2026-11-14): phase 3 is built; phase 4 is next

What waits for the lead, in this order (none changes what is stored):

| Commit | Branch | What | A coach sees |
|---|---|---|---|
| `4fa5f37` | `map-state-rc1` (off `dd00764`) | RC1 review F1: a copy the board has no room for makes nothing | "Board full", and no partial copy |
| `b3c9223` | `map-state-p3` | Phase 3 step 1: the frame on three clocks | Nothing |
| `17c6c67` | `map-state-p3` | A copy and a new scene carry the scene's `source` (the lead's answer 1) | The copy's ▶ chip; Retake on a copy |
| `cda86fb` | `map-state-p3` | Phase 3, the rest: `MapState` for Player, build columns and sight on the clocks | Nothing |
| `1e4508b` | `map-state-p3` | `4fa5f37` cherry-picked (three conflicts, both sides kept) | |
| `ffa74a9` | `map-state-p3` | e2e: Player's top bar says who is out of sight | |

RC1 is `dd00764` + `4fa5f37` and ships alone first, from `map-state-rc1` (its worktree is
`mapcro.worktrees/map-state-rc1`; `target` and `web/node_modules` there are symlinks). The
rest is the release after.

**`4fa5f37`, RC1 review F1.** The reviewer's case: a copy sent in several transactions on a
board with room for the first but not for all was left partial, and the page flipped to it.
`addSceneOps` now counts the board's records (deleted ones too) plus the new scene's; over
`max_records` it gives no transactions (`full`), `sendScene` makes nothing of none, the view
stays and the page toasts "Board full" (`SceneTree` `onFull`). Tests: `scenes.test.ts` (at
the cap and one over, tombstones counted), `scene-copy.test.ts` through the real replica and
server (a board 60 short of the cap with 40 tombstones, a 313-record copy: nothing sent; then
what it prevents, the first transaction taken and a later one refused, 40 of 300 strokes for
the other session), e2e `scene-clone.spec.ts` (the toast). Hand mutants 8 of 8 through
vitest, 1 of 1 through the e2e. Heavy run on `map-state-rc1`: vitest 17 of 17, `tsc` clean,
e2e `scene-clone scenes scene-builds scene-tree` 13 passed. Logged from the review: TD-89 (a
chunked copy is several undo steps), TD-90 (a peer's delete and undo mid flight), TD-91 (the
server's own refusals mid chain); spec §4.4 says what a partial undo shows.

**Heavy runs for phase 3** (a checkout of its own, `/tmp/ms-p3-perf`, so the worktree could
change while they waited; scripts in `/tmp/ms-p3-qa/`, not committed):

- **E2e, two workers.** At `17c6c67`: `scene-builds scene-clone scenes scene-tree
  palette-player player-handoff board-file scene-names`, 28 passed. At `cda86fb`: 28 specs
  (Player's vision, inspect, tooltips, lanes, rifts, health, shops, objectives, troopers,
  top bar, events cost, skulls, tier, ease, urn, stats; `topbar map-state-dom-pins
  follow-matrix phone-player scene-builds scene-clone map-furniture objectives player
  palette-player player-handoff scenes`), 229 passed, 3 skipped, 0 failed (12.9 min). At
  `ffa74a9`: `player-vision scene-builds scene-clone scenes scene-tree`, 28 passed. The full
  suite and the cargo tests were not run (no Rust changed).
- **E2e mutants of the wiring, 13:** 8 caught (the hero panel's sight; the markers outside
  Player; Health off; the bar's sight twice, after `player-vision.spec.ts` got its bar check:
  both were missed before it; the bar's level 30 s early; the full board's toast). **Missed,
  4, all gaps the specs had before:** the lanes' colours ungated from Player
  (`laneEdges`), `splitOf` ignoring the match's edges in Player, the bar's level 30 s late (the
  fixtures' levels don't change after 10 s), and the phone's all-builds rows asked at 0 s
  (`phone-player.spec.ts` doesn't read a row's items). The values behind them are held by
  vitest (`lane(key).edges`, `tenthOf`); what draws them in the page is not.
- **`just perf-player`, one run each, the box at load 2 to 8.** While playing, late in the
  match (t = 1735), JS % of the main thread, then fps:

  | Match, CPU | Before (`a4c3517`) | Step 1 (`b3c9223`) | The rest (`cda86fb`) |
  |---|---|---|---|
  | 134623152, 1x | 9.6 %, 60 | 8.5 %, 60 | 12.4 %, 54 |
  | 134623152, 4x | 29.1 %, 45 | 24.8 %, 35 | 24.7 %, 36 |
  | 129738985, 1x | 10.7 %, 60 | 9.5 %, 60 | 11.5 %, 60 |
  | 129738985, 4x | 22.8 %, 33 | 21.0 %, 31 | 21.1 %, 26 |

  Step 1 takes one to four points off the script time; fps, Tab, hover and scrub latency are
  within the runs' spread (Tab 32 → 32 ms and hover 38 → 35 ms at 1x on 134623152; scrub 20 →
  19 ms). The rest of phase 3 shows no gain here (no build column is open in this run), and
  its 1x rows are worse in this one run, at a higher load (5.5 to 6.4 against 4.0 to 4.7).
  **Not settled:** whether that is the load or the change. At 4x the script time is the same
  as step 1's (24.7 against 24.8 %, 21.1 against 21.0 %), which points at the load. An
  interleaved repeat (`/tmp/ms-p3-qa/perf2.sh`: step 1 and the rest, twice each) was queued
  and failed to start its server (below). Run it before `cda86fb` ships.
- **Browser check, Chromium, the real pack and server, match 129738985** (a Playwright walk,
  hashes and counts only): 15 times from 0:45 to 40:00 under five settings (All; All with
  Health, CC, movement and troopers; the King's view; the King's with Last seen; the
  Archmother's with Last seen), 75 paused frames, then five seconds of play.
  - On each of the three builds (before, step 1, the rest): the match loads on the replay
    tier, play advances 5 s, 11 of 11 tokens move, 0 page errors.
  - Between the builds: the top bar's DOM is identical on 75 of 75 frames; the tokens drawn
    (778 over the frames) and the ghosts (94) are the same count on 75 of 75.
  - **Not settled: the map's DOM.** Its hash differs on 75 of 75 frames between every pair of
    runs, step 1 against the rest included, with the same number of elements each time. That
    reads as something in the map that differs from run to run (the walk hashes, so it can't
    say what), not as a change; but it is not shown. The walk now leaves the server's port
    and the board's id out and hashes the hero tokens on their own, and runs the same build
    twice as a control (`/tmp/ms-p3-qa/walk.sh before:a4c3517 again:a4c3517 after:b3c9223
    rest:ffa74a9`). That run failed to start its server (below). What holds the frames
    equal meanwhile is vitest on this match's timeline: 14,272 frames and 2,379 states, 0
    differ.
- **`target/` of this worktree was gone** when the last two runs started (between about
  02:45 and 03:15 on 2026-11-14; nothing in this session removes it). The measuring
  checkout and `map-state-rc1` link to it, so neither has a server binary now: a
  `cargo build -p mapcro-server` and `just wasm` come first for whoever runs anything here.
  `web/src/wasm` is still there.

**`17c6c67`, the copy's `source`.** `addSceneOps` puts the scene's `source` (match, moment,
tier) on the new scene, for Duplicate and for Add scene: both copy the snapshot, and the
source is where the snapshot was taken. A scene with none makes a record with no `source`.
What follows from it: the copy has its ▶ chip and a mark on the scrubber, Retake works on it,
and with another match open it shows no names from that match (before, a new scene from a
saved one had no source and so took the open match's names, whichever match that was).
Tests: `scenes.test.ts` (copy, new scene, child; none stays none), `scene-copy.test.ts`
through the real server (two sessions), e2e in `scene-builds.spec.ts` (the chips for a second
person; the copy's chip plays the match from the moment). Hand mutants: 6 of 6 caught.

**`cda86fb`, phase 3, the rest.**

- **`web/src/mapstate/state.ts`.** `fromTimeline({ tl, t, markers })` gives the spec's §6
  interface: `hero(slot)`, `marker(key)`, `lane(key)`, `scene()`, `has(feature)`. An entity is
  made when first asked for and kept; each field is a memo over the second's part, the tenth's
  part or t (made under the owner `fromTimeline` was called in, so a reader's rerun doesn't
  dispose them). Facts only: `inSight` and `lastSeen` for every hero, objectives' health on the
  replay tier, every death with `seen`. `playerFrame(src, state)` is the adapter the old
  readers use (it moved here from `frame.ts`, which now holds only the pure parts and the
  definition); `markerFrame(state, health)` is the markers' part, new once a second.
- **Readers moved:** the lanes (`Board.tsx` `laneEdges`, `splitOf`), the top bar's and the
  hero panel's "out of sight" (`inSight`; `PlayerTopBar` and `HeroCard` take `ms`), the map's
  markers (`markerStates` takes the second's part).
- **A build column on the clocks:** `buildState` asks `buildAt` at `tenthOf(t)` (the tenth's
  middle) and `statBuild` at `floor(t)`; `playerBuildView`'s kills, assists, level and max
  health at the second. The phone's all-builds rows ask once a tenth.
- **Capture:** `matchSceneOps` reads `secondPart` (heroes, down, sites, lanes), the producer
  Player draws from. `slotKey` lives in `match/timeline.ts` now (`save.ts` re-exports it), so
  `frame.ts` no longer imports `save.ts` and there is no import cycle.
- **`(k / 10) * 10` is `k` for every whole k up to 2,000,000** (measured in node), so the
  tenth's middle is a margin against rounding, not a fix for a case that was seen. Step 1's
  note above says otherwise.
- **Tests:** `frame-clocks.test.ts`: every field against its definition at 809 times on each
  of four matches (replay; a death unseen; metadata; metadata carrying CC and movement rows);
  absent entities and no timeline; `has` feature by feature; a reader of one field reruns
  when its value changes (120 frames: souls once, ult twice, place every frame); the markers'
  part; capture's part. `late-perf.test.ts`: the tenth's build is the frame's as shown at
  1,547 times; over 120 frames `items` is read 19 times and `assists` once.
- **On real timelines** (counts only): 134623152, 13,768 frames and 2,295 states, 27,540
  hero builds, 0 differ; 129738985, 14,272 frames, 2,379 states, 28,548 hero builds, 0 differ.
- **Mutants, by hand, through vitest:** `state.ts` 38 (30 caught at first; 3 caught after a
  test was added: CC on the metadata tier, the urn's sites under a pack's keys twice; 2
  equivalent: the tenth asked at its start, since `tenthPart` floors again, and
  `seen && !seen.seen`, which the guard above already holds; 1 was redundant code, removed);
  `buildState.ts` 7 of 7; `buildView.ts` 7 (5 at first, 2 after the test ran through every
  change of the scoreboard's values); `save.ts` 6 of 6. Nine more on the wiring run through
  the e2e (see the heavy run).
- **Run on it:** `npm test` 70 files, 694 passed, 1 skipped; `tsc` clean. No Rust changed.

### What is next (for whoever continues)

1. **Phase 4.** `fromScene(state, sceneId)` giving the same interface, by the registry; then
   `Tokens.tsx`, `MapView`'s markers and both bars take a `MapState`. What phase 3 leaves for
   it: the tokens read `matchPreview` (the adapter) for places, ghosts, health, CC and
   movement; `RiftRings`, `UrnMark`, `DeathSkulls` and `MarkerTips` take the preview too. The
   viewer's choices (`Shown`) then apply in the renderer: `inSight` with Vision gives seen,
   ghost (`lastSeen`) or not drawn in Player, and faded in a scene (D3). D1: names from the
   scene's `source` match (every copy carries it now). D2, D4, D5, D13 as the table says.
2. **Phase 5.** Rows land `Ahead` and stop for a reader release. `HeroState`,
   `MarkerState`, `LaneState` and `SceneFacts` in `state.ts` are the candidates' list:
   hero `in_sight`, `last_seen` (Pos, and its age), `cc`, `height`, `zipline`, `health`,
   `respawn` already typed; lane `gap`; scene `urn`, `rejuv`; the marker baseline as `Ints`
   on `SceneState` (D7). `FEATURES` are the `has_<feature>` rows to add.
3. **Phases 6 and 7, and the backlog's F4, F5 and the phone's scene builds:** not started.

### Phase 3, first step: Player's frame on three clocks (TD-50). No stored change, nothing a coach sees

- **`web/src/mapstate/frame.ts`.** `previewAt(m, t, markers, shown, fade)` is the frame's
  definition (what `host.preview` was, with the viewer's choices passed in as `Shown`).
  `secondPart` and `tenthPart` are the unfiltered parts the timeline holds per second and per
  tenth; `playerFrame` holds them in memos on `floor(t)` and `floor(t * 10)` and builds the
  frame from them each frame. `Board.tsx` `matchPreview` reads `playerFrame`; `host.preview` is
  gone, `host.shown()`, `host.continuous` and `host.second` are new.
- **`vision.ts`:** `seenAt` = `seenFrom(p, t, sightAt(p, t * 10))`. The scan of `seen` is the
  tenth's; the death check, the last-seen place and "how long ago" are the frame's.
- **A tenth's part is asked at the middle of the tenth** (`(ds + 0.5) / 10`), because
  `k / 10 * 10` is not always `k` in floating point and the readers compare `t * 10` with whole
  tenths.
- **The top bar** (`PlayerTopBar.tsx`): the heroes' samples once a second (`playersAt` at
  `host.second()`), their place and respawn time each frame (`heroesAt`); the Rejuvenator at
  `host.second()`.
- **Tests, `web/test/frame-clocks.test.ts`:** `host.preview` as it was at `a0774c5` is kept
  there as the oracle (`before`). On a synthetic match with sight, CC, movement, an urn, two
  rifts with capture, a Rejuvenator and deaths: the definition and the clocked frame equal the
  oracle at 2,900 times (on, just before and after every tenth, and between), under four view
  settings, on both tiers. The clocks hold: over 120 frames of two seconds, one hero's `souls`
  is read twice and its `seen` scan runs twenty times.
- **On real timelines** (`MAPCRO_TIMELINE=<file> npx vitest run test/frame-clocks.test.ts -t
  "real match"`, counts only): 134623152, 13,768 frames at 0.37 s steps, 0 differ; 129738985,
  24,790 frames at 0.213 s steps, 0 differ (the frame, `heroesAt`, `rejuvAt`). Every time in
  the per-second series of both is a whole second (research map, Gotchas).
- **Cost** (node, late in the match, the map's frame plus the bar's heroes): 0.69 → 0.04 ms a
  frame on 134623152, 1.04 → 0.07 on 129738985.
- **Mutants, by hand:** 28 on `frame.ts` and `vision.ts`, 25 caught at first; the three missed
  (Health on the metadata tier twice, Vision on a timeline with no sight) are caught since the
  metadata fixture lost its sight and the test checks `health` is absent.

- **Run on it:** `just web-test` 70 files, 678 tests pass (1 skipped: the real-match check,
  which needs `MAPCRO_TIMELINE`), `tsc` clean. E2e at two workers, `player topbar
  map-state-dom-pins follow-matrix phone-player vision scene-builds map-furniture`: 258
  passed, 3 skipped, 0 failed (14.3 min). **Not done:** a walk in a real browser on a real
  match, `just perf-player` before and after, the full e2e suite and the cargo tests (no Rust
  changed).
- **The heavy queue is slow with four implementers:** this session's two runs each waited 30
  to 45 minutes for the lock. Start a run with `run_in_background` and a two-hour timeout, and
  change nothing under `web/` until it ends (commit or stash first: the queued job builds the
  tree as it is when its turn comes).

### What is next (for whoever continues; nothing below is started)

The order the spec gives, with what this session learned:

1. **Phase 3, the rest.** `MapState` as the spec's §6 interface (`hero(slot)`, `marker(key)`,
   `lane(key)`, `scene()`, `has(feature)`), each field a memo. Build it on `secondPart` and
   `tenthPart`: they are already unfiltered (D9), so they are also what capture should read.
   `previewAt` then becomes the adapter the old readers use until phase 4. Still each frame: an
   open build column's `buildAt`, `HeroCard`'s `seenAt` (move both to `sightAt` on the tenth).
2. **Phase 4.** `fromScene` giving the same interface; `Tokens.tsx`, `MapView`'s markers and
   both bars read `MapState`. D3 (an unseen hero faded, not gone, in a scene) is the one
   place the two renderers differ. A copy of a scene doesn't carry `source` (above): names
   from the source match (D1) need it.
3. **Phase 5.** New rows land `Ahead` and stop for a reader release. Candidates, from what
   `secondPart` and `tenthPart` hold and a scene doesn't: hero `seen_amber`/`seen_sapphire`,
   `last_seen` (Pos), `cc`, `height`, `zipline`; lane `gap`; scene `urn`, `rejuv`; the
   marker baseline as `Ints` on `SceneState` (D7).
4. **Phase 6, 7** and the backlog's F4, F5 and the phone's scene builds: not started.

### Release candidate 1: a scene's copy (#54, review F1), `dd00764`. No store change, no new rows

- **#54:** Duplicate (the row's copy button) now takes what is drawn on the scene: arrows,
  callouts, ink and the note, as new records in the copy. Add scene (the +, T) still starts
  without them. `addSceneOps(…, ink)`, `SceneTree.tsx` `clone`.
- **F1:** a copy over one transaction's caps is sent as: the scene and all twelve heroes without
  `more`; each hero's `more` as `Set More`; the other records; the `SceneState` last
  (`chunkByBytes` packs them, so the first transaction may also hold the first heroes' sets).
  One transaction, as before, when it fits. `sendScene` stops at a refused transaction and says
  whether the first was taken; `SceneTree` flips only then.
- **Tests:** `web/test/scenes.test.ts` (the split, the ink, `sendScene`); `scene-copy.test.ts`
  through the real replica and server (two sessions; the old first transaction is refused, the
  new ones are all taken, the copy equals the scene); e2e `scene-clone.spec.ts` (ink and note
  copied, for a second person too; a full board refuses the copy and the page stays on its
  scene) and `scene-builds.spec.ts` (a scene with twelve 600-integer build orders, 79 KB, is
  duplicated whole and survives a reload).
- **Mutants, by hand:** 21 on `scenes.ts` and `save.ts` through vitest, all caught (one, the
  state not last, was missed until the test got a split and an arrow after the state); 4
  through the e2e (the copy without ink, the old one-op split, a flip after a refused copy and
  after a refused Add scene), all caught. No Rust changed, so no cargo-mutants run.
- **Gotchas:** a flip to a scene id that doesn't exist falls back to the first scene
  (`Board.tsx` `scene`), so an e2e of "no flip" must stand on the second scene. A file's
  heroes need about 5.5 KB of `more` each before twelve are over a transaction: build-order
  rows with small ids stay under it.
- **Not copied by a copy, as before:** the scene's `source` (so its ▶ chip, and phase 4's names
  from the source match). Decide in phase 4.

## Earlier state: phase 2 done and run in a browser; #49 fixed on the desktop layout (fifth implementer)

Branch `map-state-p2`, with main merged at `61de6cb` (the writer deployed as `1dcbd31`, its lock
and reader). Fifth implementer, 2026-11-13 night. Everything is committed. **This branch is the
next release: store v10, floor 9.** The lead's gate, adversarial review, merge and deploy are next.

**#49 is fixed for the desktop layout, verified in Chromium on a real match.** On the phone's
compact bar a scene still shows no builds (backlog).

| Commit | What |
|---|---|
| `327b043` | F2: pickups stored in hundredths. F4: the list caps tested; the packing table in spec §4.3 |
| `2eef5d8` | F3: `addSceneOps` gives transactions chunked by bytes, the state last; a save with no room for its snapshot toasts "Saved without builds" |
| `6ffe8b7` | The `UNFIT_UNDO` deploy note |
| `41adf30` | The wasm `changed` pin corrected (it was written blind and wrong on the old code too) |
| `55a1475` | Step 1: the edit and its ack no longer clone the board |
| `d7c093e` | The four rows and `UNFIT_UNDO` `Live`; store v10 (`NeedsReader`, floor 9) |
| `f9cfd30` | The DOM pins' snapshots, from the rendering before `76dbad5` (see below) |
| `582b387`, `6b3bf74` | `scene-builds.spec.ts` takes a match the server accepts, and checks the scene after a reload; `statOf` for a revived hero |
| `2afd7d1` | `written_rows`' test; the no-match follow e2e; the edit-cost table in spec §6; TD-86 to TD-88 |

(`git log --oneline cd968ba..` has the exact list.)

### What was verified, and how

- **QA in real Chromium on match 134623152 at 25:00** (the real asset pack, the real server; a
  Playwright walk kept in `/tmp/qa-p2/`, not committed; it prints counts only). Player's twelve
  build columns were read (All builds, then each alone with its level badge and build order),
  the frame saved, and the scene's columns compared as text and ids:
  - the saved scene: 12 of 12 identical in All builds, 12 of 12 alone, 12 of 12 levels, 12 of 12
    build orders up to the frame; hold-Tab opens 12 and releases to 0; no "—" in any column
    (K/D/A, max health and the calculated stats are all there);
  - the same after a reload (12 of 12 each);
  - a follower sees one build, All builds and none as the presenter opens them;
  - an old scene of that match (no `SceneState`, nothing more on its heroes), after **Retake**:
    12 of 12 each; no page errors.
  The toast after the save read "Saved scene 2".
- **Found by it, fixed:** (1) a hero the match has dead at the scene's moment but the scene has
  alive read as unknown health, so a health-threshold item left its bonus out (116% against
  Player's 138%). `statOf` now counts it as full health, as the spec's §5 rule says. (2) A board
  with a match reopens in Player after a reload, so the e2e's "survives a reload" check was
  reading Player's column. It goes to the scene first now.
- **F2 on the real match:** capture → read → `statOf` equals Player's `statBuild` at all 30,576
  hero-seconds (0 differ), and K/D/A and max health read back equal at all of them. Stored whole
  (the old code), 15,508 differed, largest error 0.5.
- **DOM pins:** taken with `web/src` as it was at `acb6d62` plus main, nine runs in a row
  there; then on this branch's rendering **Player's four pins and the two old scenes' pass
  unchanged**. The spec as written never loaded its match (an objective without its fields,
  abilities in tenths instead of seconds: the server refused the timeline), and its outline
  held a person's random colour and tokens in record-id order; both fixed before the pins
  were taken.
- **Rollback check:** `just reader-check` against `1dcbd31`: 40 boards, 11,392 logged
  transactions, 4,801 holding registry values or a scene's state, 20 an undo that no longer
  fits, loaded byte for byte. The dump now refuses to run without such an undo in it.

### Step 1, the edit cost: measured, both clones removed from the edit path

Chromium, the real WASM replica, a 64-scene board (3,869 records, 768 heroes), 300 runs,
medians in ms, before → after (`just edit-cost`; the table is also in spec §6):

| `more` a hero | Board JSON | Local edit | Its ack | A drag frame | Peer's entry, nothing pending | Peer's entry under a pending edit | Whole-state save |
|---|---|---|---|---|---|---|---|
| 0 | 748 KiB | 0.94 → 0.01 | 0.94 → 0.01 | 1.88 → 0.02 | 0.94 → 0.01 | 0.94 → 0.26 | 5.33 → 5.48 |
| 3,000 | 2,993 KiB | 2.44 → 0.03 | 2.65 → 0.02 | 5.09 → 0.05 | 2.96 → 0.03 | 3.18 → 1.11 | 12.32 → 14.19 |
| 8,000 | 6,331 KiB | 9.05 → 0.04 | 9.30 → 0.02 | 18.35 → 0.06 | 9.06 → 0.05 | 6.10 → 2.31 | 20.06 → 19.98 |

**Decision: both clones are gone from the edit path** (the engine's copy of the view per edit,
and the WASM wrapper's copy to diff). What still copies the board: a peer's entry while this
replica has pending work, a rejection, a `Rebase`, and the whole-state save (TD-87).

The characterisation test of `acb6d62` for `changed` failed on the new code **and on the old**:
it expected a peer's write to be hidden under a pending redo, but a redo is `SetIf` on the value
it saw and skips the field. Corrected against the old code first (`41adf30`), then the change.

### Numbers

- `cargo test --workspace --no-fail-fast` on the v10 flip: every crate passes but TD-81's known
  flake (`an_import_is_refused_before_its_body_is_read`, 3 of 3 alone). `just clippy` clean.
  Simulation, 1,000 seeds × 400 steps, both admissions: 77,010 entries, 10,772 undo checks.
- `just web-test`: 68 files, 668 tests, `tsc` clean.
- E2e: `scene-builds` 4, `map-state-dom-pins` 2; the related set (`portrait-menu topbar
  topbar-rejuv-builds player-inspect player-keys follow-matrix phone-player scenes`) 146 passed
  before the last small changes; the full suite at `c6566f0`: 464 passed, 14 skipped, 0 failed (18.7 min at two workers).
- **Mutation testing.** cargo-mutants `--in-diff` against `6a0d391`, `-j 1`, engine + wasm +
  schema: 49 mutants, 34 caught, 8 unviable, 7 missed. The 7: four in `Replica::next_undo` /
  `next_redo`, which only the wasm tests hold and the tool doesn't run for an engine mutant
  (all four fail `changed_tests` by hand; TD-88); three in `written_rows`, which only the
  server's file tests held (a schema test now kills all three). `mapcro-server` (unit
  tests, `board_file`, `admission_gate`; TD-81's flake skipped): 5 mutants, 3 caught, 2
  unviable, 0 missed. By hand, one at a time, all
  caught: 6 on the replica and the wasm diff (the ack check dropped, `pending.is_empty()`
  dropped, vanished records missing from `changed`, a receive without the pending ops'
  targets, a rejection without them, a created record missing); 7 on the flip (`UNFIT_UNDO`
  back to `Ahead`, a row back to `Ahead` twice, the table's "ahead" word, `SCHEMA_VERSION` 9,
  step 9 additive, step 9 unknown); 8 on `build.ts` (the pickup scale twice, each list cap,
  the cut direction); 5 on `addSceneOps`; 3 on the save's `builds` flag; 2 on `statOf`; 3 on
  `host.ts`'s follow code, run through the e2e.

### For the lead at the deploy

- `SCHEMA_VERSION` moved (9 → 10): back the database up first. The rollback target is
  `1dcbd31` and nothing older (floor 9).
- After it is live: `just rows-lock` (the lock already lists all 15 rows, so no change is
  expected) and set the justfile's `reader` to the deployed commit: what is stored changed.
- Check the served client's build id changed (docs/deploy.md, the `UNFIT_UNDO` note).

### Left for later (backlog and register)

Scene builds on the phone; the follow matrix's scene column; an e2e for a changed hero hiding
its build; the last view after a reload; TD-86 (where `chunkByBytes` lives), TD-87 (the
whole-state save), TD-88 (cargo-mutants and the wasm tests).

### Gotchas (this session)

- A hand-written e2e timeline the server refuses loads as "API summary" with no error in the
  page: `abilities` are `[second, id, level]`, `items` `[tenths, id, kind]`, an objective needs
  `key, kind, team, lane, destroyed_s`.
- **A build column's text holds the player's name.** A QA script that diffed two columns
  printed two in-game names to the session's output once (never to a file or commit). Compare
  and count; never print a column's text.
- A board with a match reopens in Player: after `page.reload()` click the scene before
  asserting on it.
- `/tmp/mapcro-p2-heavy.sh '<cmd>'` still serialises heavy jobs for this worktree.

## Earlier state: phase 2 client written and type-checked; NOT yet run in a browser (handoff, fourth implementer)

Branch `map-state-p2`, on top of `6a0d391`. Fourth implementer, 2026-11-13 evening. The lead's
gate held the box for the whole session (`/tmp/lead-gate.log`, e2e at two workers), so **no
cargo, wasm or e2e job of this work has finished yet**; only `tsc` and single vitest files ran.
Stopped at the context limit. Everything is committed except the engine change of step 1, which
a queued job applies (below).

**#49 is not verified fixed.** The code for it is written and type-checks; no browser has run it.

| Commit | What | Verified by |
|---|---|---|
| `acb6d62` | Characterisation before the changes: the replica's view against its definition (`replica.rs` `view_tests`, `Replica::view_is_rebuilt`); `Update.changed` against a whole-document diff (`crates/wasm` `changed_tests`); the DOM pin spec (`web/e2e/map-state-dom-pins.spec.ts`, **no snapshots yet**); `just edit-cost` (`web/perf/edit-cost.mjs`, `scene_cost --dump`) | nothing run |
| `95c6aad` | Save stores the builds and a `SceneState`; Retake's ops; `chunkByBytes`; the build interface `mapstate/buildView.ts`; the Save pin moved by decision | `tsc`; `map-state-save` 9 tests, `map-state-build` 8, `map-state-pins` 5 |
| `76dbad5` | `BuildColumn`, `BuildOrder`, `HeroCard`, both bars on `BuildView`; the scene bar's builds, All builds, hold-Tab; the Retake button; panel follow on scenes (`host.ts`); `web/e2e/scene-builds.spec.ts` | `tsc` only |

### The review of `6a0d391`: F1 done, F2 to F4 NOT started (do F2 before anything else ships)

The lead relayed an adversarial review of the server-side release late in the session.

- **F1, done: `408a7bb` and `ec88816`, branch `map-state-f1` on top of `6a0d391`** (merged here). A board
  file's `rows` was `ROWS.len()` (15); the reader `13d2fd1` refuses a file above its 11 as
  Newer, so no export made after the writer's deploy imported after a rollback. Now
  `mapcro_schema::written_rows()` (the first `Ahead` row's index). A server test holds the
  header; `just reader-check` holds that the reader's registry covers it. Run on `ec88816`: schema 61 + 6, server `boardfile` 5, `board_file` 14, `just reader-check` (40 boards, 10,808 transactions), clippy on schema, server and sim, all pass; a full `just test` is the lead's gate. **`408a7bb` alone fails three tests that pinned the old header.** Committed before
  its tests could run** (the gate held the box); `/tmp/mapcro-p2-f1.log` has the run if it
  finished. It does not run the reader's own `boardfile::read` (the server has no library
  target).
- **F2, not started, must precede any release that calls `captureBuild`** (Save calls it since
  `95c6aad`; the layout is permanent once written). `mapstate/build.ts` stores `pickups` with
  `Math.round(n)`, but the timeline's pickups are f32 and the resists move in quarters: on match
  134623152, 15,508 frames differ from Player's `statBuild`, the largest error 0.5. **Store
  hundredths** (`Math.round(n * 100)` in `put`, `/ 100` in `get`; within the row's ±1e9 bound),
  give `map-state-build.test.ts`'s fixture fractional pickups, and say so in the spec's packing
  note. `statOf` then gives Player's exact input.
- **F3, not started:** no test covers `addSceneOps` copying `SceneState` (deleting the line in
  `board/scenes.ts` passes everything). Duplicate is one transaction with no byte check: twelve
  heroes near the 8 KiB cap exceed `max_tx_bytes`. Add the test; chunk with
  `match/save.ts` `chunkByBytes` (the scene and its heroes first, the state last) or note why not.
- **F4, not started:** the list caps in `build.ts` are untested (removing the 32-item cap passes
  the 8 tests). `abilities` holds 9 entries and the match maximum is 7: thin headroom, to note
  in the spec. `map-state-save.test.ts` does assert `items!.slice(0, 32)` on a save, which is a
  start, not the cap's own test.
- **Deploy note for the next release:** when `UNFIT_UNDO` goes `Live`, clients must be on a
  build that skips it (the build id forces the reload). Add the line to `docs/deploy.md`.

### The lead's decisions this follows

Release plan (the server side to `6a0d391` ships first; this client work ships in the release
that flips `kills`, `deaths`, `assists`, `max_health` and `UNFIT_UNDO` to `Live`, store v10 floor
9; **don't flip them until the lead confirms the lock lists them**). Save keeps the roster
rewrite and also writes the scene's `hero` row; a build draws only while the slot holds that
hero. A left click on a portrait opens its build, souls stay an edit, the right click keeps the
hero menu (#53). The view-state store stays in `player/` until phase 4.

### Step 1, the edit cost: written, queued, not measured

- **The change** (`/tmp/mapcro-p2-step1.keep.py`, applied by the queued job; if `/tmp` is gone,
  it is described here in full):
  - `replica.rs` `submit` and `edit_silent` apply in place (`apply_tx_with_inverse` rolls a
    refusal back itself). No clone of the view per edit.
  - `replica.rs` `receive`: an ack of the oldest pending transaction **as sent** (`pending.pop_front() == Some(&tx)`)
    leaves the view alone, since it applied to the confirmed state exactly as it had under the
    view; a peer's entry with nothing pending is applied to the view directly; anything else
    rebuilds as before. `next_undo()` / `next_redo()` give the ops the next undo would submit.
  - `crates/wasm` `Held`: before a call, the entries of the records the call can touch (the
    ops' targets; for `receive`, the entry's and every pending transaction's); after it, the
    ones that differ are `changed`. Exact, not a superset. Only `ServerMsg::Rebase` still
    clones the view and diffs it whole. `connect` and `disconnect` report nothing changed.
  - `mapcro_schema::op_target` is public. The simulation's step check asks `view_is_rebuilt`.
- **The queued job** (`/tmp/mapcro-p2-job2.sh`, log `/tmp/mapcro-p2-job2.log`; it waits for the
  gate and a load under 12): measures BEFORE with the wasm already in `web/src/wasm` (built
  before the change: **don't run `just wasm` first**), applies the change, runs the schema,
  engine, wasm and sim tests, the 1,000 seeds, clippy, then `just wasm` and measures AFTER, for
  `more` of 0, 3,000 and 8,000 bytes a hero.
- **To do with its log:** commit the change if green (`perf(engine): an edit and its ack cost
  what they touch`); put the before and after table in spec §6 and here; state the decision
  (expected: both clones removed, the remaining whole clone is a peer's entry under pending work
  and a rebase). Then mutation testing: `cargo mutants -j 1 --in-diff` against `6a0d391` for
  `mapcro-engine` and `mapcro-wasm` (the wasm tests are native: `changed_tests`), plus by hand:
  the `!= Some(&tx)` check dropped; `pending.is_empty()` dropped; `Held::changed` missing the
  vanished records; `receive` not adding the pending ops' targets.
- If the change is rejected for any reason, the characterisation tests of `acb6d62` pass on the
  old code too (they were written against it), so they stay.

### Step 2, DOM pins: the spec is committed, the snapshots are not taken

`map-state-dom-pins.spec.ts` outlines the bar and the map (an element a line, ids as `#n`,
inline images as their length) on two old scenes from a board file and on Player at a paused
frame (plain, one build open, all builds). **Its snapshots must come from the rendering before
`76dbad5`:**

1. With a clean tree, check out the old rendering into it: `git checkout acb6d62 -- web/src`
   (`git status` then shows the reverse of the two client commits; nothing is lost).
2. `just e2e map-state-dom-pins --update-snapshots`, run it a second time without the flag (it
   must pass twice: the outline may still hold something that differs from run to run; add it to
   `outline`'s left-out list if so), commit the `*-snapshots/` files alone.
3. `git checkout HEAD -- web/src`, `just e2e map-state-dom-pins`: **Player's four pins and the
   two old scenes' must pass unchanged.** Expected differences, to decide and then re-bless
   with a line in the commit: none in Player; in an old scene none (no `SceneState`: no All
   builds button, the portrait's title still "Show …").

### Steps 3 to 6: what was built, and what to check in the browser

- **The interface** (`mapstate/buildView.ts`): `BuildView` has `hero`, `build`, `statInput`,
  `kills`, `deaths`, `assists`, `level`, `maxHealth`, `patch`, `time`, `order(components)` and,
  in Player only, `live` (the timeline's hero, for Effects). `playerBuildView` wraps
  `buildState`'s memos (a hidden column still reads nothing per frame: the same `visible`
  accessor goes to the view and the column). `sceneBuildView` reads `readBuild` and `statOf`.
  **A view is made once, outside JSX** (a call in a prop would run on every read).
- **Not behind the interface yet:** the level badge and the ult tooltip's tiers in
  `PlayerTopBar`, and the phone's all-builds list, still read the timeline. Phase 4's bar.
- **K/D/A and max health in a scene read "—"** until their rows are `Live` (`WRITTEN` stops at
  the first `Ahead` row). Deaths can now be "—" in the column.
- **The scene bar** (`board/TopBar.tsx`): `hasBuilds` is the snapshot's `has_builds` with a
  watermark; a slot shows a build when its record's stored `hero` is the roster's
  (`holdsBuild`). Stat tables load by the snapshot's `build` row. **Not on the phone's compact
  bar** (`!p.compact`): logged in the backlog.
- **`board/buildPanels.ts`** is `PlayerTopBar`'s old listeners, shared. One addition: Tab held is
  released when the bar unmounts (a flip between Player and a scene while holding Tab).
- **Retake** (`match/save.ts` `canRetake`, `retakeOps`): offered to an editor on a scene whose
  `source.match_id` is the loaded match and whose snapshot has no builds or an older
  watermark. The button is where All builds is, or under it when the scene has both.
  Check in the browser that a `SetIf` expecting `{ More: { key, value: null } }` applies on an
  absent key (the e2e's Retake test is the check).
- **Follow** (`host.ts`): with no match, `presence()` sends a playback of match 0, `player:
  false`, only while a build key is set; `mirror()` reads no playback as "no builds open", and
  mirrors the panel group when the presenter is in sandbox. No registry row changed, so no
  ledger line. `PlayerSwitch`'s `peerMatch` skips match 0. **Not done: the follow matrix's new
  column** (`follow-matrix.spec.ts`); `scene-builds.spec.ts` has one follow test with the match
  open. A no-match follow test needs a board file holding a snapshot (file version 2).
  **Run the whole `follow-matrix` spec:** a follower now mirrors panels from a presenter in
  sandbox, which an existing row may contradict.
- **E2e to run:** `just e2e scene-builds map-state-dom-pins portrait-menu topbar
  topbar-rejuv-builds player-inspect player-keys follow-matrix phone-player --workers 2`.
  `scene-builds.spec.ts` was written blind: expect to fix selectors (the hero menu's right
  click position, the souls input, `tb-level` when the level is absent).
- **Then QA in a real browser** (the lead's rule): a new save, an old scene with Retake, a
  follower; and the spec's §8 table and `docs/backlog.md` (phone scene builds; the follow
  matrix column; the no-match follow test; health on a scene's bar).

### Gotchas (this session)

- `/tmp/mapcro-p2-heavy.sh '<cmd>'` runs one heavy job in this worktree inside `nix develop`
  under `nice`, after the lead's gate and with the load under 12, serialised by a lock.
- A single vitest file and `npx tsc --noEmit` are light enough to run beside the gate.
- `web/test/map-state-save.test.ts` builds its over-a-transaction case from 200 buys at six-digit
  tenths and seventy objectives down: with real row caps twelve builds alone stay under 64 KiB.

## State: phase 2, server side of the writer and the stored layout done; the interface is next

Branch `map-state-p2`, worktree `mapcro.worktrees/map-state-p2`, off main `6b9b4d1` (phase 1
deployed as `13d2fd1`, its 11 rows locked). Third implementer, 2026-11-13. Stopped at the context
limit with every step below committed; **the scene's build interface, Retake, panel follow and
the browser measurement are not started** (their plan is under "Next").

**Not deployable as #49's fix yet:** nothing in the client writes or draws a snapshot. The branch
as it stands is safe to deploy (it is the writer on the server and a reader for four new rows),
but the lead should wait for the interface and the browser numbers unless a reader release for
the new rows is wanted early (see "The release boundary").

| Commit | What |
|---|---|
| `feb95f4` | Reviews' F3, F4, re-review 1, 2, 4, and TD-80 (`just reader-check`) |
| `4488d5c` | The writer on the server: 11 rows `Live`, `SceneState` `Live`, store v9 (floor 8), file version 2 written; four new rows `Ahead`; the client's row table and the build's stored layout (`web/src/mapstate/build.ts`) with its round-trip property |

### What was built

- **F3.** `store.rs` `Step::{Additive, Breaking, NeedsReader}` replaces `additive_step`. The
  writer's 8 → 9 is `NeedsReader`: the floor becomes 8. `only_the_reader_opens_the_writers_database`
  and the v7 → v8 → v9 → v8 test hold it (a v7 server is refused; no stored byte moves).
- **F4, with a gate the review did not ask for.** A `SetIf` on a registry value that the record
  has no room for is now `Skipped`, with nothing to undo (`apply_op`, `apply_tx_with_inverse`).
  **But the deployed v8 reader refuses such a transaction on replay**, so a log holding one would
  not load after a rollback to it. So it is gated as a row is: `UNFIT_UNDO` (`map_state.rs`),
  `Admit::unfit_undo`, asked by `apply_tx_admitted` (the authority's `submit`). This build reads
  it (replay and replicas skip) and its own server still refuses it (`TxTooLarge`, as before).
  **Flip `UNFIT_UNDO` to `Live` in the release after this one is deployed, with a store step
  v9 → v10 that is `NeedsReader` (floor 9).** No honest client can meet it in this release: the
  lists have no editor, and Save and Retake size what they write.
- **The simulation.** A `Filler` behaviour (two of eight editors) keeps one hero's lists at the
  record's byte cap, so the unfit undo is met (`an_undo_that_no_longer_fits_is_met_and_the_server_as_built_logs_none`).
  `just test` runs the 1,000 seeds twice: admitting everything read, and `--admit deployed`.
  The second run found a gap in the simulation's model of storage, not in the server: the room
  stores a client's next cseq when its rejections are resolved (`Write::PruneRejections`), the
  simulation didn't, so a client whose every write was refused restarted at 0 after a server
  restart. Fixed in the simulation.
- **Re-review 1.** `crates/server/tests/admission_gate.rs` reads the server's sources: outside
  test modules it names no gate but `Admit::DEPLOYED` (`set_admit`, `Admit::READS`, an `Admit {`
  literal, `unfit_undo`, `apply_tx_admitted` are refused).
- **Re-review 4.** Lock mode needs `MAPCRO_ROWS_LOCK_COMMIT` to be the checked-out commit; the
  flag alone panics. `just rows-lock` passes it.
- **TD-80.** `just reader-check` (part of `just test`): `dump_stored` writes 40 simulated boards
  as the server as built stores them; `load_stored`, built in a `git archive` of the reader
  release (`reader := "13d2fd1"` in the justfile), loads each genesis, log and base and compares
  the board byte for byte. With the rows `Live` the dump holds registry values, and it refuses to
  run a check that holds none. It reads the JSON the store holds, not the SQLite file.
- **The writer on the server.** `row()` is `Live`, `ahead()` is `Ahead`; `SCENE_STATE` `Live`;
  `SCHEMA_VERSION` 9; a board file is version 2 with `rows`. The two reader-era tests are replaced
  by `a_file_with_map_state_imports_and_a_row_still_ahead_makes_no_board` and
  `a_client_writes_map_state_that_is_live_and_not_a_row_still_ahead`.
- **Four new rows, `Ahead`:** `kills`, `deaths`, `assists`, `max_health` (hero, `Int`). The build
  column shows them and the 11 rows had no place for them. This build is their reader.
- **The client's row table:** `web/src/gen/rows.ts` from `just ts` (`rows_ts()`), with each
  row's index, entity, kind, bounds and status. A schema test holds it current and that rows go
  live in order.
- **The build's stored layout, `web/src/mapstate/build.ts`:** `HeroBuild` (one plain value),
  `heroBuildAt(tl, player, t)` (Player's producer), `captureBuild` / `captureScene` (the rows a
  save writes), `captured` and `readBuild` (a scene's reader), `statOf` (the calculator's input).
  Nothing calls them yet. The packing: `items` 4 integers an item (id, cooldown in tenths, charges,
  stacks; -1 for none), `abilities` 5 (id, level, then the same), `build_order` 3 (tenths, id,
  kind: the timeline's `items` rows up to the frame, the latest 200), `pickups` the five values.
  A list that isn't whole strides reads as not captured. Capture writes only rows before the
  first `Ahead` one, and that count is the watermark (`rows`). Over the record's 8 KiB the build
  order loses its oldest rows.
- **`addSceneOps` copies `SceneState`** (New scene, Duplicate).

### Decided while building

- **The unfit undo is gated, not shipped** (above). The alternative, justifying the reject in
  the spec, would have kept an undo refused for what it would write.
- **K/D/A and max health are new rows, not packed into `pickups`.** A layout hack in stored data
  is for ever; a release behind is not. Scenes saved before those rows are written show "—" for
  them until Retake.
- **A scene's build is drawn only while the slot still holds the stored `hero`.** Save should
  write the `hero` row; whether Save stops rewriting the roster (D2) needs every reader of
  `slot.hero` to read the scene's `hero` first, which is phase 4's renderer. Not done.
- **`health` is stored only for a living hero**; a dead one counts as full for the calculator, as
  in Player.

### The release boundary

1. **This branch, once the interface is in, is the writer for the 11 locked rows** (store v9,
   floor 8): it may ship, since `13d2fd1` reads everything it stores (`just reader-check`).
2. **It is the reader for `kills`, `deaths`, `assists`, `max_health` and for the unfit undo.**
   After its deploy: `just rows-lock`, commit the lock, and set `reader` in the justfile to the
   deployed commit.
3. **The release after it** flips those four rows and `UNFIT_UNDO` to `Live`, with store v10
   (`NeedsReader`, floor 9). Nothing else is needed for the rows: capture writes by status.
   The lead may instead deploy `feb95f4` plus the row commit first as a reader-only release, so
   the writer ships with all fifteen rows.

### Numbers

- `just clippy` clean. `cargo test --workspace`: 509 passed at `feb95f4` (505 before). After
  the writer commit the crates were run one by one, not as one workspace run: schema 61 + 6,
  engine 26, sim 3, server unit 82, `admission_gate` 2, `board_file` 14, `system` 44, all pass.
  **A full `just test` and `just e2e` on the final commit are the lead's gate to run.**
- `just web-test` parts at the writer commit: 67 files, 654 tests, `tsc` clean.
  `web/test/map-state-build.test.ts`: 8 tests (the round trip at five seconds for twelve heroes,
  bounds, the byte cap, the watermark, damaged lists). No e2e was run: no rendering changed.
- Simulation, 1,000 seeds × 400 steps, 8 editors, rows `Live`: admitting everything read,
  77,010 entries, 10,772 undo field checks, 1,374 editor conflicts; `--admit deployed`, 73,208
  entries, 10,328 undo checks, 5,159 refusals (the four rows ahead and the unfit undo). Both pass.
- `just reader-check`, rows `Live`: 40 boards, 10,808 logged transactions, 4,218 of them holding
  registry values or a scene's state, loaded byte for byte by `13d2fd1`'s schema and engine.
- **Mutation testing, the tool** (cargo-mutants 27.1, `--in-diff` against `6b9b4d1`):
  - `mapcro-schema` and `mapcro-engine`: 21 mutants, 10 caught, 11 unviable, 0 missed.
  - `mapcro-server` (unit tests, `board_file`, `admission_gate`; TD-81's flaky test skipped): 10
    mutants, 8 caught, 2 unviable, 0 missed.
- **Mutation testing, by hand** (the tool makes none for a constant, a dropped branch or test
  code): 16, one at a time, all caught. The unfit `SetIf` always refused, always skipped; `submit`
  not asking the gate; `UNFIT_UNDO` `Live`; store step 8 breaking, additive; `NeedsReader` raising
  to `from + 1`, lowering the floor; a file without `rows`, at version 1; `SCENE_STATE` `Ahead`;
  the lock taking any commit, the flag alone; a row written after one still ahead; the server
  naming `Admit::READS`; the simulation's storage dropping a pruned client's cseq. The last was
  missed at first (with the rows `Live` the 1,000 seeds no longer meet it):
  `a_client_whose_every_write_was_refused_keeps_its_place_across_a_restart` kills it.
- **Not measured: the browser edit cost.** See "Next".

### Gotchas

- A worktree needs `web/node_modules` linked to the main checkout's (`ln -s
  /storage/projects/mapcro/web/node_modules web/node_modules`); this one has it.
- cargo-mutants copies the tree without `.git`: a test that needs the repository fails its
  baseline there. The server has no library target: pass `-- --bins --test … -- --skip …`.
- `cargo mutants -j 2` beside another cargo job took the box's load past 40. Run it alone.

### Next (in order)

1. **The browser edit cost, before the writer ships.** A 64-scene board with full snapshots
   (`captureBuild` output, ~3 KB a hero), timing `replica.edit` in the page. Two clones are in
   the path: `replica.rs` `submit` clones the view, which `apply_tx_with_inverse` makes
   unnecessary (it applies in place and rolls back on a refusal), and `crates/wasm/src/lib.rs`
   `edit` clones `before` to diff. Remove the first; measure; decide on the second.
2. **DOM pins** of map and bar on fixture scenes (spec §9), before rendering changes.
3. **`BuildColumn` reads a build interface**, not the timeline: in Player, accessors over the
   existing memos (`buildState.ts`: keep them, the column must not redraw per frame); in a
   scene, accessors over `readBuild` and `statOf`. It reads from the timeline today: `buildAt`,
   `statBuild`, kills, deaths, assists, `max_health`, `format >= PICKUPS_FORMAT`, `build`,
   `effectsAt`, `buildOrder`. Effects are not captured: no Effects popover in a scene. The build
   order has no seek in a scene. `PlayerTopBar`, `HeroCard` and the phone sheet use it.
4. **Save captures** (`match/save.ts` `matchSceneOps`): each `PlayerState` gets
   `more: captureBuild(heroBuildAt(tl, p, second))`, and one `SceneState` with `captureScene(tl)`,
   in the same transaction. Check the encoded size against `LIMITS.max_tx_bytes` and the op
   count; over, drop builds whole (no `has_builds`). `matchScenesOps` chunks by bytes.
   `test/map-state-pins.test.ts` pins Save's ops: its snapshot moves, by decision.
5. **The scene's bar** (`board/TopBar.tsx`): when `captured(...).builds`, the portrait opens the
   build (as Player's `focus-hero`), All builds and hold-Tab work, with the same view-state keys
   (`builds.inspect`, `builds.all`, `builds.popover`; `tabHeld` is the host's signal).
6. **Retake** on a scene whose `source.match_id` is the open match: `SetIf` on an absent value
   for each row, the `SceneState` created or its keys set the same way; chunk by bytes.
7. **Panel follow on scenes** (spec §7): `host.ts` `presence()` returns nothing without a match
   and `mirror()` returns before the panel group when the presenter is outside Player. Carry the
   panel keys outside both, add the follow matrix column and the ledger lines.
8. E2e for a saved scene's builds; QA in a browser; the spec's §8 table.

## State: phase 1 and its review fixes done; stopped for the lead's gate and deploy

Phase 1 is the reader only. Nothing writes `more` or a `SceneState` yet, and no client code
changed (the generated types and limits did). The independent review of phase 1 (8d6ce9b..5e29a65)
passed it and found two things to fix before the deploy; both are fixed (step 1 below). **Phase 2
(step 2) must not start until the lead says so.**

| Commit | What |
|---|---|
| `42a93ba` | Spec, third revision: the review and the decisions (its §2) folded in |
| `d010875` | Phase 0: characterisation tests and the 64-scene edit cost |
| `8d6ce9b` | Phase 1: `more`, `SceneState`, `FieldValue::More`, the registry, limits, store v8, file v2 read |
| `8235002` | Tests that kill the mutation survivors |
| `cdcbd15` | Review F1 (admission) and F2 (`just rows-lock`), with their tests and docs |

## Step 1: the review's F1 and F2 (2026-11-13, second implementer)

**F1: a client could write `more` and `SceneState`, and that board broke on a v7 rollback.**
`Status::Ahead` had no runtime meaning: `Authority::submit` and a file import took a `More` or a
`SceneState`, which main's v7 schema can't parse (the log) or drops silently (a record's `more`).

- **Fix: `Admit` (`crates/schema/src/map_state.rs`), asked at admission only.**
  - It refuses a transaction or a record that carries an `Ahead` row: a `FieldValue::More`
    naming it (in a `Set`, either side of a `SetIf`, a clear included) or a created record with
    it in its `more`. `Reject::WrongField`.
  - It refuses a `SceneState` while `SCENE_STATE` (a constant beside `ROWS`) is `Ahead`.
    `Reject::Immutable`. Both are existing variants: no new status text, and a stored rejection
    still parses on v7.
  - **Asked by** `Authority::submit` (before validity, with the size and quota checks) and
    `import_records` (so `boardfile::read`, at file version 1 and 2). **Never by** log replay
    (`Authority::replay`) or base load (`validate_doc`): a stored board always loads.
  - `Admit::DEPLOYED` is each row's own status and the server's default. `Admit::READS` admits
    everything read; the simulation uses it (`Config.admit`) so rows are still synced and undone
    there, and tests pass their own gate to flip a row.
- **Phase 2 flips it by:** a row's `status` to `Live` (in `ROWS`, after `just rows-lock`), and
  `SCENE_STATE` to `Live`. The lock test refuses `SCENE_STATE` being written before a lock lists
  a row of the scene's. Two tests name themselves the reader's and fail then on purpose:
  `a_file_with_map_state_makes_no_board_while_its_rows_are_ahead` (board_file.rs) and
  `a_client_cannot_write_a_map_state_row_or_kind_that_is_still_ahead` (system.rs); replace them
  with the writer's.
- **Tests added:** refusal of each carrier, by transaction and by file (schema, engine, the
  server's `boardfile`, the HTTP import, a WebSocket client with a restart); a base and a log
  already holding them still load (`Authority::replay`, `Store::load_board`); a row or the kind
  made `Live` is admitted; the simulation as built (`Admit::DEPLOYED`, 12 seeds) logs no JSON
  with a `More`, `SceneState` or `more` key, and the same seeds log them when admitted.
- **Not done, logged:** a `Retired` row is not refused (TD-79); no test runs main's real v7
  types against a v8-written database (TD-80). The replica does not ask `Admit` for its own
  optimistic edit: a refused one is rolled back by the rejection, as any other.

**F2: `just rows-lock` blessed anything.** Lock mode wrote the lock from `ROWS` and then checked
`ROWS` against what it had just written.

- **Fix:** lock mode (`relock`) reads the lock already there, runs `broken(old, ROWS)`, and
  writes only if nothing is broken; a missing lock is refused too. The recipe refuses a tree
  with uncommitted changes (tracked files) and a run in which the lock test didn't run.
- **Test:** `locking_refuses_a_build_that_breaks_the_deployed_rows_and_leaves_the_lock_alone`
  (reordered, narrowed, shortened, removed, a never-`Ahead` row; the file untouched each time;
  same, widened and new `Ahead` rows lock).

**Step 1 numbers** (commit `cdcbd15`):

- **Tests:** `just clippy` clean. `just test`: 505 passed, 0 failed (485 before; 20 new), and the
  simulation's 1,000 seeds pass with the same 7,934 undo field checks (it runs `Admit::READS`,
  so its behaviour did not move). `just web-test`: 66 files, 646 tests, `tsc` clean, and `just ts` left the generated types as they were. E2e (`board`, `scenes`, `board-file`, `scene-clone`, `match` on the rebuilt client): 15 passed.
- **Mutation testing, the tool** (cargo-mutants, `--in-diff` on the step 1 diff):
  - `mapcro-schema`: 12 mutants, 12 caught.
  - `mapcro-engine`: 4 mutants, 2 caught, 2 unviable.
  - `mapcro-server`: 4 mutants, 4 caught (run against the unit tests and `board_file`, with
    TD-81's flaky test skipped: it failed the first baseline).
- **Mutation testing, by hand:** the tool makes no mutant for a dropped `else if`, a constant or
  test-module code, so 15 were written and run one at a time; all 15 are caught. They are: the
  admission branch dropped from `submit`; `SetIf` checking only its value, only its expectation;
  `Create` not checked; `DEPLOYED` admitting every row, admitting `SceneState`; the authority
  defaulting to `READS`; `import_records` not asking; `boardfile::read` ignoring its gate; the
  import route passing `READS`; `relock` writing without checking, checking without writing,
  writing the real rows; `SCENE_STATE` `Live` with no lock; the simulation's restart forgetting
  its gate. The last was missed at first: the simulation now builds its authority in one place
  (`serve`), at the start and after each restart.
- **`just rows-lock`, run in a throwaway clone** (never in this worktree: the real lock is the
  lead's to write after the deploy): a clean tree locks 11 rows; a second run before the lock is
  committed is refused (uncommitted changes); a relock with nothing changed passes; with
  `health` narrowed to 0–99 and committed it fails ("health: kind changed or bounds narrowed")
  and leaves the lock as it was.
- **A masked check, until the rows are `Live`:** `bad_files_are_refused_with_a_code_and_make_no_board`
  sends `health: 101` and `has_builds` on a hero and expects `invalid`. Admission now refuses
  those first, with the same code, so that HTTP test no longer shows the bounds check; the
  schema's own tests still do.

## What the lead does at the phase 1 deploy

1. Gate and deploy as usual. The store migrates v7 → v8 with no SQL; a v7 server still opens the
   database, and with F1 nothing a v7 server can't parse is stored, so a rollback is safe.
2. **After the deploy is live, on the deployed commit with a clean tree, run `just rows-lock`
   and commit `crates/schema/rows.lock`** (it should list 11 rows). Until it lists a row, the
   schema's test refuses that row being written (`Live`). Phase 2 can't flip its rows without
   this. If the recipe refuses, don't edit the file by hand: see `docs/deploy.md`.

## Decided while building (the operator should know)

- **An unknown row key fails to parse; it is not a `Reject`.** A key is held as the row's index,
  so an unknown one can't be represented. A transaction, stored record or file naming one is
  refused whole. A known key with a bad value, or on the wrong kind of record, is a `Reject`
  (`WrongField`, `OutOfBounds`, `TextTooLong`, `BadText`). No new `Reject` variant, so no new
  status text.
- **`max_more_bytes` is 8 KiB, not the 16 KiB first drafted.** At 16 KiB a board of 5,000 full
  records would be 80 MB of JSON, past the store's 64 MiB decode limit (the trap the review named
  for `max_records`). 8 KiB keeps a record under a full stroke.
- **`max_more_ints` (1,280) bounds a record's heap.** A room is admitted alone whatever it weighs,
  so the worst-case document must stay well under the 128 MiB budget. Worst case is now ~55 MB
  (adversarial only), against ~20 MB before. Architecture §9's limits table says so.
- **A value's lists and text are boxed** (`Box<[i64]>`, `Box<str>`): no spare capacity, so the
  heap estimate is exact.
- **`SceneState` deletes and restores like a note** (one live per scene). An empty one means the
  same as none. The watermark (`rows`) and the per-feature flags (`has_builds`) are ordinary rows
  in it, so they merge per key and undo.
- **`Field::ALL` is gone**: `Field::all()` (typed fields, then every row) and `Field::TYPED`.
- **Kinds are `Bool`, `Int`, `Text`, `Pos`, `Ints`.** No `Choice`: it is an `Int` with a small range.
- **Board files:** this build reads version 2 (a `rows` header) and still writes version 1.

## The rows shipped (all `Ahead`), and the open point about them

`hero`, `name` (per-scene identity, D2); `rows`, `has_builds`, `build` (on `SceneState`); `items`,
`abilities`, `build_order`, `level`, `health`, `pickups` (the builds tracer).

**The list rows were sized from the timeline's types, before phase 2 designed the build
interface.** The server checks only a list's length and range, so the packing is still free. If
phase 2 needs another row, it adds it as `Ahead` and that row needs its own reader release before
Save writes it. A row that turns out unused is retired, never removed.

## Numbers

- **Tests:** `just clippy` clean. `just test`: 485 passed, 0 failed; the simulation's 1,000 seeds
  pass with 7,934 undo field checks (the no-clobber check now walks every row).
  `just web-test`: 66 files, 646 tests, `tsc` clean.
- **Stored bytes:** the phase 0 fixtures (a board, a session, their logs, a file's records) did
  not move a byte through phase 1.
- **Edit cost, 64 scenes, native release** (`cargo run --release -p mapcro-engine --example
  scene_cost -- --more N`; the browser is slower and clones once more per edit):

  | Each hero's `more` | JSON | Clone | Local edit | Received entry | To JSON |
  |---|---|---|---|---|---|
  | none (today) | 747 KiB | 0.3 ms | 0.3 ms | 0.3 ms | 4.5 ms |
  | ~3 KB (a measured snapshot) | 2.9 MiB | 2.3 ms | 0.7 ms | 0.9 ms | 10 ms |
  | ~8 KB (the cap) | 6.2 MiB | 4.3 ms | 1.0 ms | 1.7 ms | 16 ms |

  Phase 1 costs today's boards nothing. A board of 64 full snapshots makes every edit and every
  received entry 3 to 7 times dearer, before the browser's extra clone. **Open for phase 2:**
  decide whether the replica's whole-document clone (`replica.rs` `submit`, `crates/wasm`
  `edit`) must go, or `More` be shared (`Arc`), before the writer ships. Measure in the browser
  first; a drag sends an edit per frame.
- **E2e** (`board`, `scenes`, `board-file`, `scene-clone`, `match` specs on the rebuilt client):
  15 passed.
- **Mutation testing** (cargo-mutants, scoped to the phase 1 diff):
  - `mapcro-schema`: 130 mutants, 107 caught, 21 unviable, 2 missed. The first run missed 20;
    `8235002` adds the tests that kill 18 (7 of them predate this branch, in the heap estimate).
    The 2 left are `>` to `>=` in `max_op_bytes`' largest-of-three: equivalent (equal values give
    the same result either way).
  - `mapcro-server`: 17 mutants, 14 caught, 2 unviable, 1 missed: `v > READS` to `v >= READS` in
    `boardfile::upgrade`, equivalent (the arm above already takes `1..=READS`).
  - `mapcro-sim` was not mutated: it is the test harness. Its no-clobber check walks
    `Field::all()`, and the schema's test holds that every row is in it.

## Gotchas

- `an_import_is_refused_before_its_body_is_read` is flaky under load (TD-81): 2 of 4 `just test`
  runs failed on it, 0 of 11 alone. Not from this branch.
- `rustc` crashed once (SIGSEGV in LLVM) during `just test`; a rerun was clean.
- The worktree's `web/node_modules` is a link to the main checkout's, as other worktrees do.
- `MAPCRO_BLESS=1 cargo test -p mapcro-schema --test characterisation` rewrites the stored-bytes
  fixtures. Don't, unless the change is meant to move stored bytes.
- New vitest file snapshots are in `web/test/pins/`. They are written when missing.

## Next (phase 2, on the lead's word)

1. Pin the DOM of map and bar on fixture scenes before rendering changes (spec §9).
2. The build interface in Player; the client's row table from `just ts`; `fromScene`.
3. Save captures builds in one transaction (check the encoded size); `addSceneOps` copies
   `SceneState`; Save stops rewriting the roster (D2).
4. The writer release: rows `Live` (after `just rows-lock`), store v9 with floor 8, file version 2.
5. Retake for scenes whose match is open; panel follow on scenes (spec §7).

From the review of phase 1, folded into phase 2 (step 2):

- **F3. `compat_floor` can't express the writer's step.** `crates/server/src/store.rs`
  (`compat_floor`, `additive_step`) only keeps the floor or raises it to `from + 1`, so a
  non-additive 8 → 9 gives floor 9 and refuses the v8 reader as a rollback target. Item 4 needs
  a step that raises the floor to `from` (8), with a test.
- **F4. An undo can be refused for its size.** A clears `build_order`, B fills `items` and
  `abilities`, A undoes: the `SetIf`'s expectation holds, `check_more_fits` fails, and the whole
  undo is `Err(TxTooLarge)`, against the rule at `validate.rs` `apply_op` (an undo isn't refused
  for what it would have written). Return `Skipped` for a `SetIf` on `More` that doesn't fit, or
  justify the reject in the spec. The simulation needs a behaviour that fills lists to their
  caps: its lists are at most 24 entries today, so it never meets this.
- **Measure before the writer ships:** edit cost in the browser on a 64-scene board with full
  snapshots (the open point under Numbers), and decide whether the replica's whole-document
  clone must change.
- **Flip admission with the rows:** each written row's `status` and `SCENE_STATE` to `Live`,
  after `just rows-lock` has run on the deployed reader; replace the two reader-only tests
  (step 1 above); decide TD-79 if a row is retired.
