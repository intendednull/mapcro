# Map-state build: state and handoff (2026-11-13)

Phase 1 was built on branch `scene-state`; phase 2 is on `map-state-p2`. Spec: `docs/specs/map-state.md`
(third revision). Review: `docs/specs/map-state-review.md`. Newest state at the top.

## State: phase 2 done and run in a browser; #49 fixed on the desktop layout (fifth implementer)

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
  server's file tests held (a schema test now kills all three). By hand, one at a time, all
  caught: 6 on the replica and the wasm diff (the ack check dropped, `pending.is_empty()`
  dropped, vanished records missing from `changed`, a receive without the pending ops'
  targets, a rejection without them, a created record missing); 7 on the flip (`UNFIT_UNDO`
  back to `Ahead`, a row back to `Ahead` twice, the table's "ahead" word, `SCHEMA_VERSION` 9,
  step 9 additive, step 9 unknown); 8 on `build.ts` (the pickup scale twice, each list cap,
  the cut direction); 5 on `addSceneOps`; 3 on the save's `builds` flag; 2 on `statOf`; 3 on
  `host.ts`'s follow code, run through the e2e.

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
