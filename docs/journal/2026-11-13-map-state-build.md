# Map-state build: state and handoff (2026-11-13)

Branch `scene-state`, worktree `mapcro.worktrees/scene-state`. Spec: `docs/specs/map-state.md`
(third revision). Review: `docs/specs/map-state-review.md`. Newest state at the top.

## State: phases 0 and 1 done; stopped for the lead's gate and deploy

Phase 1 is the reader only. Nothing writes `more` or a `SceneState` yet, and no client code
changed (the generated types and limits did). Phase 2 must not start until the lead says so.

| Commit | What |
|---|---|
| `42a93ba` | Spec, third revision: the review and the decisions (its §2) folded in |
| `d010875` | Phase 0: characterisation tests and the 64-scene edit cost |
| `8d6ce9b` | Phase 1: `more`, `SceneState`, `FieldValue::More`, the registry, limits, store v8, file v2 read |
| `8235002` | Tests that kill the mutation survivors |

## What the lead does at the phase 1 deploy

1. Gate and deploy as usual. The store migrates v7 → v8 with no SQL; a v7 server still opens the
   database, so a rollback is safe.
2. **After the deploy is live, run `just rows-lock` and commit `crates/schema/rows.lock`.** Until
   it lists a row, the schema's test refuses that row being written (`Live`). Phase 2 can't flip
   its rows without this.

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
