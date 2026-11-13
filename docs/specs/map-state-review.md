# Map-state spec: independent adversarial review (2026-11-13)

A fresh Fable 5.2 agent at xhigh effort reviewed `map-state.md` at f5addeb. It was given the spec,
the operator's requirement and code pointers, not the author's conclusions. It read the code and ran
read-only probes and one `tsc` check (no cargo or e2e suites; the box was loaded). Probes:
`/tmp/mapstate-probe/`. Measured on 134623152 (42 min) and the reference 129738985. The report
follows as given.

## 1. Verdict

**Buildable with changes.** The storage core is sound: a keyed `more` field written through the
existing `Set`/`SetIf` gives per-key last-writer-wins and undo with no change to the sync protocol.
Five things must be fixed in the spec before phase 1:
- row compatibility on rollback;
- the record budget;
- the places where Player and scenes give one field two meanings;
- the `captured` marker;
- follow on scenes.

The spec's size estimates are about half the measured sizes.

## 2. Findings, most severe first

### High

**H1. Every new row is a compatibility event (§3.3, §3.6).**
- **Problem:** "three steps, nothing else" and "a removed row's values are ignored on read" are both
  false.
- **Evidence:**
  - Cold load replays each logged transaction through full validation and fails the board on any
    refusal (`crates/server/src/store.rs:606-635`, `crates/engine/src/authority.rs:218`). A server
    rolled back past a row's deploy can't load boards whose log holds that key.
  - The same happens going forward. Remove a row or narrow its bounds, and boards with that key in
    the uncompacted tail (up to 12,000 entries) stop loading. Old `.mapcro.json` files with the key
    are refused.
  - The store's `compat_floor` doesn't cover this: there is no SQL migration, so `SCHEMA_VERSION`
    stays 7.
  - A server without the reader silently drops `more` on existing records, because serde ignores
    unknown fields (`records.rs:107-133` has no `deny_unknown_fields`). The next compaction makes the
    loss permanent.
- **Fix:**
  - Rows are append-only: never removed, and their bounds only widen. A dead row is marked retired.
  - A row is readable one release before anything writes it. A committed lock file of the last
    deployed rows enforces this.
  - Bump the store version twice, with no-op steps: additive v8 with the reader, then non-additive
    v9 (floor 8) with the writer, so an older server refuses to start.

**H2. The record budget is wrong, and raising `max_records` to 8,000 is unsafe (§3.4).**

Sampled every 5 s over each match. Where a cell has two numbers, the first is 134623152 and the
second 129738985.

| Per saved scene | Spec says | Today's save | Spec's model, measured |
|---|---|---|---|
| Records, p50 | 30–50 | 51 / 72 | 60 / 82 |
| Records, p90 | | 86 / 96 | 95 / 106 |
| Records, max | | 181 | 189 |
| Bytes in the document, p50 | 15–20 KB | 10 / 14 KB | 26 / 36 KB |
| Bytes, max | | 34 KB | 46 / 48 KB |

- **Where the records go: markers.**
  - The map has 51 camps, 36 heals and 78 crates.
  - In the first two minutes, all 165 wait for their first spawn, and each is an `ObjectiveState`.
- **What the spec calls "the bulk" is small.**
  - Troopers peak at 65 on the map (about 0.6 KB), and a recap is at most 389 B.
  - Dropping recaps, trails and troopers frees only 1–2 KB.
- **The cap counts deleted records.**
  - `doc.len()` counts every entry (`validate.rs:365`, `doc.rs:59`).
  - Player states can't be deleted, and a board clone keeps tombstones (`lib.rs:171`).
  - So over its lifetime, a board holds about 60 replay scenes today, or 97 at 8,000. For
    early-game scenes, it's 26, or 42 at 8,000.
- **What 8,000 breaks:**
  - `DOC_DECODE_LIMIT` is 64 MiB (`store.rs:62`), which is 5,000 records of the largest stroke. At
    8,000, a legal board compacts into a base that can't be decoded.
  - The room-memory headroom in architecture §9 assumes a worst-case document of 20 MB.
  - Compaction and `Rebase` serialise the whole document (`room.rs:935`, `authority.rs:349`).
- **Fix:**
  - Don't raise the cap. Keep camps, heals and crates as one packed baseline on `SceneState`, with
    an `ObjectiveState` only for a marker someone edits. That gives about 45 records per scene.
  - Count `more` in `record_heap_bytes` (`doc.rs:136` returns 0 for a player state) and in
    `max_op_bytes` (`validate.rs:39`).
  - Decide how tombstones are counted.

**H3. "One renderer, nothing visible" can't hold: the modes give the same fields different meanings
(§3.5, §4, §5, phases 3–4).**
- **Sight:** in a scene, `PlayerState.visible` false draws a ghost for every viewer (`Tokens.tsx:288`).
  In Player, sight depends on the viewer's Vision. Mapped to one row, the eye toggle on a new scene
  does nothing under Vision All.
- **Dead heroes:** Player hides them (`Tokens.tsx:314`). A scene draws a dark token with a respawn
  label, which is also the handle for editing it. Today's save writes `alive: false, placed: true`
  (`save.ts:54`).
- **Names:** Player puts the match's name first, and scenes put the typed one first. The backlog
  says this "still needs the call"; the spec lists it as a cost but never decides it.
- **Hero and name per scene:** today both are board-wide `RosterSlot` fields.
  - "A slot's name", under "editable now (unchanged)", writes `RosterName` (`TopBar.tsx:247`).
  - Save rewrites the board's roster (`save.ts:68`).
  - Both contradict the operator's "no effect on anything but the current scene".
- **Lanes:** a new scene stores two extents, and "the split is drawn when they are absent". So a
  newly saved scene loses its draggable split, a regression against §4's own table.
- **Shops closed:** derived from guardians, this would change old scenes unless it is gated.
- **Fix:**
  - Add a table of these decisions for the operator.
  - State that the old meaning applies when a feature was not captured.
  - Store the lane as the split plus a gap.
  - Define, for a per-scene hero and name, which value wins and what an edit writes.

**H4. `captured` is too coarse and has no way to change (§3.2–3.5).**
- **Problem:**
  - A row added later to an already captured feature reads as "default" on older snapshots, not
    "unknown". §3.3's own example adds `spirit` to "stats".
  - There is no op to change `captured`, yet Retake and any hand edit of an uncaptured feature need
    one. Without it, a hand-made scene's editors stay hidden for good.
  - Whether a `SceneState` can be deleted is undefined.
  - §3.1's "clone needs nothing new" is wrong for Duplicate scene and New scene. `addSceneOps` copies
    three kinds by hand and would skip `SceneState` (`web/src/board/scenes.ts:54-62`), so the copied
    `more` would be stored and never drawn.
- **Fix:**
  - Store the registry length at save as a watermark.
  - Store per-feature flags as `more` keys, so they merge per key and undo.
  - Define the `SceneState` lifecycle, and add `addSceneOps` to the plan.

**H5. Follow on scenes doesn't work as §5 claims.**
- **Evidence:**
  - Vision, builds, panels and recap ride inside presence's `playback`, which isn't sent for a board
    without a match (`host.ts:736`). A cloned board has none.
  - When the presenter isn't in Player, a follower returns before it mirrors the panel group
    (`host.ts:792`, before `:804`).
  - The panel keys reset when the match changes (`host.ts:817`), and `recap.skull` names a death by
    match second.
- **Fix:**
  - Carry the keys outside the match gate.
  - Mirror panels in Sandbox.
  - Reset death-keyed keys when the scene changes.
  - This is wire and mirror work plus a new policy, so "rows unchanged" is not accurate.

### Medium

**M1. Privacy: storing names reverses a recorded decision (§8 Q1).**
- **Evidence:**
  - Architecture §6b (Names): "Display only: nothing writes the match's names into the board".
  - The security section says names are "never written to `RosterName`".
  - `boardfile.rs` says a file never holds match timeline data.
- **Consequences:**
  - Stored names persist in tombstones and compaction bases, and travel with clones and exports.
  - Names are up to 32 characters, against a `max_name` of 24.

**M2. #49 is not fixed by phase 5 for the scenes that exist.**
- **Old scenes:** by §3.5 an old scene gets nothing until Retake in phase 8, so the reporter's scenes
  would still have no dropdown.
- **Unspecified:** how the merged clicks behave.
  - A portrait click opens the build in Player but the edit menu in a scene.
  - A token click opens a hero panel in Player but selects the token in a scene.
- **Hidden scope in phase 5:** `BuildColumn`, `HeroCard`, `ActiveEffects`, `BuildOrder` and
  `DeathRecap` all take the timeline directly. Moving them is a rewrite, not "one small change".

**M3. The editing rules are wrong or incomplete (§4).**
- **Timers:**
  - "A marker set down shows no timer" is backwards: camp, powerup and mid-boss timers show only
    while the marker is down (`Camps.tsx:25-48`).
  - A timer at 0 never flips to up.
- **Fields that can disagree:** "camp state" duplicates `status`, and "stage" duplicates `Stage2`.
  After an edit, each pair can disagree.
- **Heroes:**
  - Reviving a hero captured dead shows health 0.
  - Changing a hero leaves the old hero's abilities.
  - The spec doesn't say which place dragging a ghost writes.
- **Markers:**
  - The one-rift-at-a-time toggle (`objectives.ts:36`) leaves the rift's rows stale.
  - "Both keep their edit" fails on a marker that has no record yet: both clients send `Create`, and
    the second transaction is refused as `Duplicate`.

**M4. Some features aren't one frame, and the spec's field list doesn't match the code (§2).**
- **Build order** shows the whole match and dims later rows, and a row seeks the replay
  (`BuildOrder.tsx:28-29`).
- **Recaps:**
  - They are reachable only from skulls, which last 2.5 s (`skulls.ts:13`). At most 2 were up at
    once, usually none, so "≤ 6 recaps" would almost always be empty.
  - Store one per hero dead at the frame (at most 8).
  - `src` indexes `timeline.players`, not slots.
- **Skulls:** a captured skull freezes partly faded.
- **Seek controls:** "Watch lead-up" and the build-order rows have no target in a scene.
- **Patch data:** stats and tooltips load by the replay's `build` (`HeroCard.tsx:50-52`), so the
  match entity needs it.
- **Missing from the list:** assists, deaths, max health, statue pickups, ability tiers, cooldowns,
  charges, stacks, CC, height, zipline, heals and crates.
- **Not in the code:**
  - "Trail" is not a Player feature.
  - Troopers are stored per team, not per lane (`timeline.ts:121`).

**M5. Performance (§5).**
- **Two clocks aren't enough.**
  - Sight, CC, effects and casts are tenth-of-a-second series, so on `sec` Vision flips up to 0.9 s
    late.
  - Marker timers are computed only on hover today. As per-second rows, they become standing work.
- **The bound is on the wrong side:** "runs at most once per changed value" can't hold for a
  producer; it should bound the consumers.
- **Edit cost:** the replica clones the whole document on every edit and receive
  (`replica.rs:202`, `crates/wasm/src/lib.rs:109`). A player state owns no heap today, so a map per
  record changes that cost. Measure a 64-scene board in phase 0.

**M6. The registry guarantee holds only with care, and for lists it moves the cost (§3.2–3.3, §7).**
- **Optional properties:** with them, which this repo's generator emits, a missing producer compiles
  under `satisfies`. Checked with `tsc` 5.9.3 and `exactOptionalPropertyTypes`: the mapped type
  needs `-?`.
- **Lists:** an `Ints` row is `number[]`, and the server can check only its length and range. Each
  list feature needs a hand-written pack, unpack and defensive decoder.
- **No floats:** records derive `Eq`, so values can't be floats. The round-trip property fails for
  interpolated values unless equality is defined after rounding.
- **Capture time:** Save captures at `floor(t)` today (`save.ts:40`); the spec should say which time
  it captures.

**M7. One transaction per save has to be a rule (§3.4, §3.6).**
- **The spec is wrong about chunks:** "Sent in chunks, as Save as scene does now" doesn't match the
  code. A single save is one transaction (`Player.tsx:115`), and `chunks` splits by op count only
  (`live.ts:89`).
- **Undo is per transaction,** so a chunked save is not one step.
- **The binding cap is per hero:** the scene and its 12 player states must share a transaction
  (`validate.rs:498`), so the cap that binds is about 5 KB per hero, not a `SceneState` total.
- **One transaction fits:** a full save measured at most 47 KB and 189 ops. Check the encoded size
  on the client, since the replica doesn't.
- **Saving many:** it needs byte-aware chunks; four full scenes are about 120 KB.
- **Retake:** at 12 heroes × 20 fields it exceeds 256 ops. It needs `SetIf` on an absent value so
  it truly never overwrites.

### Low

- **The simulation:** `Field::ALL` drives the no-clobber check (`crates/sim/src/checks.rs:115`).
  `More` keys must be in it, or the check skips them silently.
- **§1:** `Scene.source` is in use, by the ▶ chip, the transport and scene names.
- **Nullable rows** need a `None` default, since clearing a key means "default".

## 3. Missing from the spec entirely

- The rollback story (H1), and the registry watermark in the file header.
- How tombstones are counted, and what "Board full" means for a coach.
- The patch `build` in the snapshot. A scene needs that patch's stat table in the pack, so "a scene
  never needs its match" has an exception.
- The phone layout: `Board.tsx:945-1045` has its own branches and `PlayerSheets`.
- Marker keys: the snapshot is keyed by the pack's keys at save time.
- Whether New scene from a snapshot inherits the snapshot.
- The compression dictionary for stored rows is trained on the simulation and won't know `more`.

## 4. The six open questions (the reviewer's answers)

1. **Names:** the operator's call, since it reverses a recorded rule.
   - If yes, make names their own droppable feature, hidden by the Names toggle, and update the
     file and privacy notes.
   - The alternative that keeps the rule: read the names from the scene's source match when it
     loads.
2. **Events and pings:** no, agreed. But store the build order up to the frame, and recaps for dead
   heroes.
3. **Capture everything:** yes. Capture must then come from unfiltered producers; today's preview
   filters by Health, Names and Vision (`host.ts:988-997`).
4. **Old scenes:** yes, Retake by hand only. Move Retake to right after builds, as it's the only fix
   for existing scenes.
5. **Troopers and recaps:** store both; together they're about 1–2 KB. Aim the caps at effects
   (up to 202 raw rows per hero, 57 distinct) and the marker records.
6. **Editable first:** per-scene hero and name, then health and level. Timers come after per-kind
   consistency rules. Builds and troopers stay view-only.

## 5. Corrected phase list

| # | Built | Ships |
|---|---|---|
| 0 | Characterisation and measurements; operator decisions on H3 and Q1 | Nothing |
| 1 | Server and schema reader only: `more`, `SceneState`, `FieldValue::More`, limits, heap estimate, simulation, store v8 | Nothing; the reader is ahead |
| 2 | Builds end to end as a tracer: components read a build interface in Player, Save captures, the scene shows it; writer deploy (v9); Retake for scenes whose match is open; panel follow on scenes | #49, for old and new scenes |
| 3 | Player producers for the rest, feature by feature, with the clocks | TD-50 |
| 4 | One map and bar renderer, with the H3 decisions | Decided changes only |
| 5 | Remaining rows, each a release behind its reader | Per feature |
| 6 | Editing: per-scene identity, generic editors, consistency rules | Editing |
| 7 | Resume; the last branches go | |

## 6. Checked and found sound

- **The op:** `More` as a `FieldValue` works with `apply_op` and `inverse_of` as written. It needs
  `Field::More(row)`, because `Field` is a payload-free `Copy` enum (`records.rs:310`).
- **The Quint model needs no change,** provided `More` is a field value and not a new `Op`.
- **Older clients:**
  - They are closed as `Outdated`. The build id hashes the schema sources, so a row forces a reload
    like any schema change.
  - The desktop app loads the web client from the server.
- **Bytes are fine:** 64 full scenes are 1.6–2.9 MiB, under the 8 MiB snapshot and file cap.
- **The clock** is only a label today.
- **Clone and export:** a board clone and export work per record once `Record::scene` gains its arm,
  which the compiler forces.
- **Sessions** need nothing new.
- **The pattern is real:** the view-state registry does give compile-time completeness.
- **§1's line references** into `Board.tsx` are accurate (34 `inPlayer()` branches).
