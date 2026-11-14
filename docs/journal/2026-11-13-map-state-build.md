# Map-state build: state and handoff (2026-11-13)

Branch `scene-state`, worktree `mapcro.worktrees/scene-state`. Spec: `docs/specs/map-state.md`
(third revision). Review: `docs/specs/map-state-review.md`. Newest state at the top.

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
    TD-72's flaky test skipped: it failed the first baseline).
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

- `an_import_is_refused_before_its_body_is_read` is flaky under load (TD-72): 2 of 4 `just test`
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
