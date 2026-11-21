# Map state: one shape, computed by Player, stored by a scene

Status: design, 2026-11-13 (branch `scene-state`). Third revision: folds in the independent review
(`map-state-review.md`, findings H1–H5 and M1–M7, all accepted) and the decisions in §2. Replaces
the §6b rule "Player draws only the timeline at t; Sandbox only the scene's records"
(`architecture-design.md`). Supersedes the narrow fix for feedback #49.

Operator's ask: saving a scene snapshots the Player frame. The scene viewer shows that snapshot
with every feature Player has, and edits change the snapshot, for that scene only. The clock and
the link to the match only record when it was taken. Today the two are separate and costly to
keep in step; the design must make a new feature cheap to carry through both.

## 1. The problem today

The views were unified on 2026-11-10 (`docs/journal/2026-11-10-scene-parity.md`): one top bar's
parts, one map, toolbar, side panel and dock in `Board.tsx`. **The data is still two things.**

- **Player** reads `host.preview(markers)` (`web/src/player/host.ts`): a `MatchPreview` built from
  the timeline at `t`, new on every frame.
- **A scene** reads its own records: `PlayerState`, `ObjectiveState`, `Wave`.
- **`Board.tsx` picks between them by hand**, 34 `inPlayer()` branches.
- **Save as scene copies** (`web/src/match/save.ts`): twelve `PlayerState`, an `ObjectiveState`
  for what is down, one `Wave` per lane. Lossy: the lane colours' gap becomes its midpoint, and
  health, builds, items, timers, the urn, the Rejuvenator, sight and skulls are dropped.
  `Scene.source` is used only by the ▶ chip, the transport and scene names; nothing draws from it.

What this costs: a Player feature is absent from scenes until someone ports it (#49); the two
disagree where they overlap (names); performance fixes are per reader (TD-50); and every field a
scene can hold is hand-written five times (record, `Field`, `FieldValue`, validation, the copy in
`save.ts`, the scene's reader).

## 2. Decisions

"Default" rows are the lead's defaults (2026-11-13), recommended to the operator, who may still
override them. "Operator" rows are the operator's own words.

| # | Question | Decision | Status |
|---|---|---|---|
| D1 | Match names in the snapshot? | **Not stored.** Architecture §6b's rule stands: nothing writes a match's names into a board. A scene shows match names by reading them from its `source` match when that loads; a name typed on the board still works. A scene with no `source` (made by hand) keeps taking the open match's names, as it does today (the lead, 2026-11-14). | decided (default) |
| D2 | Whose hero and name? | **Per scene.** A scene's own hero and name (rows `hero`, `name`) win over the board roster; editing them in a scene writes only that scene. Save as scene stores the match's hero per slot in the scene and no longer rewrites the roster. | decided (default) |
| D3 | Sight in a scene | **Player's Vision logic.** The viewer's Vision setting decides who is seen, as in Player. The one difference: a hero Player would hide as unseen is drawn **faded** in the scene editor, not removed, so it stays visible and editable. ("The only difference in vision in the scene editor is that the token appears faded, instead of completely gone.") | decided (operator, 2026-11-13) |
| D4 | Dead heroes in a new scene | A dark token with its respawn time, so it stays editable (Player hides it). | decided (default) |
| D5 | Old scenes | Keep their current look. A feature a scene didn't capture keeps its legacy meaning (§4.5). | decided (default) |
| D6 | Phase order | The review's (§8): builds end to end first, fixing #49 for old and new scenes. | decided (default) |
| D7 | `max_records` | Not raised. Camps, heals and crates are one packed baseline (§4.4). | decided (default) |
| D8 | Events list and pings in a scene | No: they are a span of the match. The build order up to the frame, and a recap for each hero dead at the frame, are stored. | decided (default) |
| D9 | Capture everything at save | Yes, from unfiltered producers, whatever layers and Vision were on. | decided (default) |
| D10 | Old scenes get more | By hand only: **Retake**, on a scene whose match is open (phase 2). | decided (default) |
| D11 | Troopers and recaps | Stored (1–2 KB together). The caps aim at effects and marker records. | decided (default) |
| D12 | Editable first | Per-scene hero and name, then health and level. Timers after the per-kind consistency rules. Builds and troopers stay view-only. | decided (default) |
| D13 | Lanes | Stored as the split (`Wave.t`, still draggable) plus the gap between the colours. | decided (default) |

## 3. The model

**One shape, `MapState`: everything Player can show at one frame.** Two producers, one renderer.

- **Player computes it** from the timeline at `t`, every frame.
- **Save as scene stores it**, whole, in the scene's records, in one transaction.
- **The scene viewer reads it back** and draws it with the components Player uses.
- **Edits change the stored state**, for that scene only.

`Scene.source` (`match_id`, `t`, `tier`) and `Scene.clock` are metadata. Changing the clock changes
the label on the bar and nothing else; `source.t` is never edited and is where Resume will start.
A scene needs no timeline to draw. Two things it reads from outside its records, and draws
without when they are missing: match names (D1, from the source match) and the patch's stat table
(by the build number stored in the snapshot, from the asset pack).

`MapState` is four kinds of entity, each a flat set of fields. The full list is the registry (§4.2).

| Entity | Keyed by | Record |
|---|---|---|
| Hero | slot | `PlayerState` |
| Marker | marker key (the pack's, at save time) | `ObjectiveState` |
| Lane | lane key | `Wave` |
| Scene (match-wide) | one per scene | `SceneState` |

- **It holds the frame, not the match.** A timer is "seconds left at this frame". Features that
  span the match are stored up to the frame (the build order) or are Player's alone (D8). Seek
  controls ("Watch lead-up", a build-order row) are absent in a scene.
- **It holds facts, not the viewer's choices** (D9). Health is in it whether or not Health was on;
  both teams' sight of each hero is in it whichever Vision was picked.
- **Capture time** is `floor(t)`, as Save does today. Stored values are integers (records are
  `Eq`): an interpolated value is rounded at capture, and the round-trip property (§9) compares
  after the same rounding.
- **Not in it:** the events list, pings, the seek bar; drawings, callouts and the note (the
  scene's own records, as today).

## 4. Storage

### 4.1 Granularity: a record per entity, a field per value

Today's record model stays: one `PlayerState` per hero, an `ObjectiveState` per marker someone
edited, a `Wave` per lane, and one new `SceneState` per scene. Each value is its own field, set by
its own op, so last-writer-wins and undo are per field, as now. Rejected: one snapshot blob per
scene (any edit replaces the frame); a new record kind per feature (the hand-written cost again).

### 4.2 The registry

`crates/schema/src/map_state.rs` holds one row per stored `MapState` field:

```rust
Row { key: "hero", entity: Entity::Hero, kind: Kind::Int { min: 0, max: u32::MAX as i64 }, status: Status::Ahead }
```

- **`kind`**, a closed list, each with bounds: `Bool`, `Int { min, max }`, `Text { max }`, `Pos`,
  `Ints { len, min, max }` (a packed list: a build, troopers). One validator per kind. No floats.
  A choice is an `Int` with a small range.
- **`status`**: `Ahead` (readable; nothing writes it yet), `Live`, `Retired`.
- Client-only attributes (the feature a row draws with, its editor, its producer's rate) are added
  with the client in phase 2 and never reach validation.

Storage is generic:

- Each of the four records has **`more`: a map from row key to value**. It is left out of the JSON
  when empty, so every record that exists today serialises byte for byte as before.
- One new field value, **`More { key, value }`** (`value: null` clears the key). It rides the
  existing `Set` and `SetIf`, so sync, conflicts and undo are per key with no change to the
  protocol or its Quint model. `Field::More(row)` names the key; the simulation's no-clobber check
  walks every row.
- In memory a key is the row's index, so an unknown key cannot be held: a transaction, record or
  file that names one fails to parse and is refused whole. A value of the wrong kind or out of
  bounds, or a key on the wrong entity, is a `Reject`.
- **`SceneState { scene, more }`**: at most one live per scene. Created with the scene (Save, New
  scene, Duplicate) or later (Retake). It can be deleted and restored like a note; with none, or an
  empty one, the scene has the legacy meaning (§4.5). Two clients creating one at once: the second
  is refused as `Duplicate`, as for a marker's first record.
- The typed fields that exist today (`pos`, `alive`, `placed`, `souls`, `ult_cooldown`, `visible`,
  `respawn`; `status`; `Wave.t`) keep their members and ops.
- `just ts` generates the row table for the client (phase 2).

### 4.3 Rows are append-only, and the reader ships first (H1)

Cold load replays every logged transaction through validation and fails the board on a refusal, and
a server without the reader would drop `more` silently. So:

- **Rows are never removed and never reordered; bounds only widen.** A dead row becomes `Retired`:
  still read and validated, no longer written.
- **A row is readable one release before anything writes it.** A new row lands as `Ahead`.
  `crates/schema/rows.lock` lists the rows of the last deployed build (`just rows-lock` at each
  deploy, `docs/deploy.md`). A test refuses: a locked row that changed or narrowed; a row that is
  not `Ahead` and not in the lock. `just rows-lock` makes the same check against the lock already
  there before it rewrites it.
- **`Ahead` is enforced at admission, not only by convention.** While a row is `Ahead` the server
  refuses anything from outside that carries it: a submitted transaction with a `More` naming
  the row (a clear included) or creating a record with it, and an imported file holding it, at
  either file version (`Reject::WrongField`). `SceneState` is gated the same way by one constant,
  `SCENE_STATE`, which the writer release flips (`Reject::Immutable` until then). The check is
  `Admit` (`map_state.rs`), asked by `Authority::submit` and `import_records` only: a stored base
  and a replayed log are never asked, so a board always loads. Until a row is `Live`, storage
  therefore holds nothing a server from before the reader can't parse, and the reader release
  can be rolled back. A `Retired` row is not refused.
- **A rule that lets more in is gated the same way.** A `SetIf` on a registry value that the
  record has no room for (an undo, after others filled the room it left) is skipped, not
  refused, with the rest of its transaction applied. The reader deployed as v8 refuses such a
  transaction on replay, so the build that first skips it (store v9) still refuses it at
  admission (`UNFIT_UNDO`, asked by `apply_tx_admitted`); the release after (store v10) admits
  it.
- **Rows go live in order.** The client's capture writes the rows before the first `Ahead` one,
  and that count is the snapshot's watermark (§4.5).
- **The store version moves with each step.** v8 (additive, no SQL) ships with the reader, so a
  v7 server still opens the database while nothing is written. v9 ships with the writer and sets
  the floor to 8, so a server older than the reader refuses to start. v10 writes `kills`,
  `deaths`, `assists` and `max_health` and admits the unfit undo, both read by v9 (deployed as
  `1dcbd31`): its floor is 9. v11 is the reader of feedback #56, #59 and #60's typed fields
  (additive, floor 9). The reader of `has_heroes` is v12, additive too (floor 9: the v9, v10 and
  v11 servers still open it). Its writer is v14 (feedback's writer took v13, floor 11), a
  `Step::NeedsReader { reader: 12 }`: the floor is the reader's version, 12, so the v12 and
  v13 servers open it and v11 doesn't.
- **Board files:** the reader accepts file version 2 (version 1 plus a `rows` header) and still
  writes version 1. The writer writes version 2. `rows` is the number of rows the exporting
  build writes: the index of its first `Ahead` row (`written_rows`), the same watermark a
  snapshot stores. Not the registry's length, which counts rows the build only reads: the
  reader release has fewer, and would refuse every export made after the writer's deploy. A
  file whose `rows` is above the importing build's registry is refused as "Newer file".
  `just reader-check` holds that the reader takes this build's `rows`. `rows` can't say a row
  the importing build knows but holds `Ahead`: such a file says a newer file version instead
  (version 3 for feedback's typed fields, version 4 for `has_heroes`: `docs/deploy.md`).

A new field therefore costs: the row (as `Ahead`), its producer in Player, its draw; then one
release later the row goes `Live` and Save writes it. Lists (`Ints`) also need a hand-written
pack, unpack and defensive decoder each, since the server checks only length and range.

**The lists' packing** (`web/src/mapstate/build.ts`; permanent once a release writes it, since
stored scenes hold it):

| Row | An entry | Holds | Cut when over |
|---|---|---|---|
| `items` | 4: id, cooldown in tenths, charges, stacks (-1: none) | 32 | the first 32 kept |
| `abilities` | 5: id, level, then as an item | 9 (48 integers; 3 unused) | the first 9 kept |
| `build_order` | 3: tenths of a second, id, kind | 200 | the latest 200 kept; the oldest also go first when the record or the save is over its bytes |
| `pickups` | the five statue values, **in hundredths** | 1 | |

- **Pickups are hundredths, not whole numbers.** The timeline's are f32 and the resists move in
  quarters: on match 134623152 bullet resist is fractional in 71 of its 103 pickup rows. Stored
  whole, 15,508 of its 30,576 hero-seconds gave the calculator a different input than Player
  (the largest error 0.5). In hundredths every one of them is exact, and the largest value is
  far inside the row's ±1e9.
- **Abilities have thin headroom:** 9 entries against a match maximum of 7 measured. A hero
  with more than 9 loses the rest in a scene; the row's `len` can only widen (48 → more), one
  release ahead of its writer.
- The caps and the cut order are tested in `web/test/map-state-build.test.ts`.

### 4.4 The record and byte budget (H2, M7)

Measured by the review on two matches, every 5 s: today's save is 51–72 records at the median, 96
at p90, 181 at most, because all 165 camps, heals and crates wait for their first spawn in the first
two minutes. `doc.len()` counts deleted records too, so a board holds about 60 replay scenes over
its life today.

- **`max_records` stays 5,000.** Raising it breaks `DOC_DECODE_LIMIT` and the room memory budget.
- **Markers are one packed baseline:** the state of every camp, heal and crate at the frame is
  `Ints` rows on `SceneState`. An `ObjectiveState` exists only for a marker someone edits (and,
  as today, for objectives that are down). About 45 records per scene.
- **Per record, `more` is at most 8 KiB of JSON** (`LIMITS.max_more_bytes`), counted exactly on
  every write. That is under a full stroke, so the largest document as JSON is unchanged.
  `max_op_bytes` covers it.
- **Per record, the lists hold at most 1,280 integers** (`LIMITS.max_more_ints`): each entity's
  `Ints` rows, all full, sum to no more (a test on the registry). It bounds a record's heap at
  about 10 KB, which `Doc::approx_heap_bytes` counts, so a room's memory budget holds.
- **A save is one transaction** (one undo step): the scene, its 12 heroes and its `SceneState`
  must be created together. It fits: the fullest frame measured 47 KB and 189 ops against 64 KiB
  and 256. The client checks the encoded size before sending and drops whole features in a fixed
  order when over (effects first), clearing their captured flag.
  Builds: the build orders lose their oldest rows first; if the builds still don't fit, the
  scene is saved without a snapshot and the save's toast says "Saved without builds" (Retake
  can add them, in transactions of its own).
- **New scene and Duplicate** copy the snapshot with the scene. One transaction when it fits;
  over the byte or op cap (twelve builds near a record's 8 KiB are 96 KiB) it is sent in
  several, and is then more than one undo step. The first makes the scene and all twelve
  heroes without their `more` (a scene with fewer is refused whole, `IncompleteScene`); each
  hero's `more` follows as `Set More`, then the other records, and the `SceneState` last. If
  the first is refused nothing is made and the view stays where it was.
- **Both carry the scene's `source`** (the match, moment and tier the snapshot was taken at): the
  copy has its ▶ chip, can be retaken, and reads its names from that match (D1).
- **A board with no room for the whole new scene gets none of it.** The client counts the
  board's records (deleted ones too) plus the copy's before sending: over `max_records`,
  nothing is sent, the view stays, and the page says "Board full". Without it a copy in
  several transactions stopped at the first refused one and left part of the scene.
- **Undo after a copy in several transactions** takes one transaction at a time, newest
  first: the scene's state goes first, then its ink and other records in the uneven groups
  they were packed in, then each hero's `more`, and the scene with its heroes last. Every
  step is a valid scene. One grouped undo is debt (TD-89).
- **Duplicate also copies what is drawn on the scene** (arrows, callouts, ink, the note: #54).
  New scene doesn't: it is the play's next frame.
- **Saving many scenes** sends one transaction per scene, chunked by bytes, not op count.
- **Retake** writes with `SetIf` on an absent value, so it never overwrites a value (in a scene that holds its heroes it also sets each filled record's `hero`: §4.5); it may take more than
  one transaction and is then more than one undo step.
- Tombstones still count toward the cap. "Board full" stays the answer; a copy starts fresh.
  Reclaiming them is logged as debt, not built here.

### 4.5 What is stored, what is derived, and what was captured (H4)

**Stored as it is at the frame:** every row. **Derived at render, never stored:** team soul totals,
a marker's look, a faded hero (from sight and the viewer's Vision), eased numbers, every label.
**A default is not stored:** Save writes a key only where it differs from the row's default.

So that an absent key can be told from an unknown one, `SceneState.more` holds:

- **`rows`**: the registry's length when the snapshot was taken (the watermark). A row with an
  index at or above it was not known then, and reads as "not captured", never as its default.
- **`has_<feature>`**, one `Bool` row per feature: the snapshot holds it. These are ordinary keys,
  so they merge per key and undo. Retake and a hand edit of an uncaptured feature set them.
- **`has_heroes`** (D2, as built; written from store v14): the scene holds its own heroes.
  Only a save sets it, never Retake. A save that has no room for its heroes and the flag is not
  made at all (it would draw the roster's heroes, which Save no longer sets).

  | | A scene that says `has_heroes` | Any other scene (made by hand, or saved before the row was written) |
  |---|---|---|
  | The hero a slot draws | The record's own `hero`; the roster's where it has none | The board roster's |
  | A pick in the scene | Sets the scene's `hero` and clears every build row of that record (`More { key, value: null }`), held locally or not, in one transaction: one undo step. "No hero" is not offered (the row can't say it) | Writes the roster, for every scene of the board |
  | The stored build is drawn | While the record still holds some of it | While its `hero` is the roster's hero |
  | Save from a match | Stores each slot's hero (with or without the builds) and leaves the roster alone | Sets the roster to the match's heroes |

  **A pick and a Retake at the same moment (TD-119):** between two clients of this build, the
  server's order decides the slot, whole. Retake sends a record's `hero` and its build in one
  transaction, the rows it already holds included (each on its being absent, so they change
  nothing unless a pick cleared them), and a pick clears every build row. The record ends as the
  later of the two left it: the picked hero with no build, or the match's hero with its own. A
  `SetIf` tests only the key it writes, so a build can't be made conditional on the record's
  `hero`; a Retake that lands after a pick therefore takes the slot back to the match's hero,
  and the coach picks again.

  **Undo and redo of a hero's record (TD-145):** the engine's step is a `SetIf` per key, so on
  its own it could leave one hero with another's build (an undo across someone else's pick, a
  redo across their Retake). The client re-decides the step from its view before sending it
  (`web/src/mapstate/undo.ts`, sent by the replica's `undo_as`/`redo_as`), record by record:
  the step expects a hero, the one its `hero` write expects or, where it doesn't change the
  hero, the one it was made on (carried with the step as `SetIf hero h -> h`). If the record
  holds another hero now, the step leaves that record's hero and build alone. A scene deleted
  since counts as it was: its hero records are not deleted with it, so the step still writes
  them, and restoring the scene shows what it wrote (and a step left
  with nothing is dropped, nothing sent). If it holds that hero, the record goes whole: a `Set`
  of its hero and of every build row, as the step leaves them; a step that only clears an
  unchanged hero's rows goes as recorded. A step with a build to give and no hero to expect (one
  stored before this build) can't say whose build it is, and leaves it out. Every other op of the
  step goes exactly as recorded. On the wire it is an ordinary undo or redo: no new op kind, and
  the server and older builds take it as any transaction.

  What the whole write costs, accepted like TD-146's outcomes: in a race, the later of the undo
  or redo and the other edit decides the slot. **An undo or redo that lands just after another
  editor's pick, which it never saw, takes the slot back** (their pick is to make again; queued
  offline, "just after" can be any length of time, as for a Retake), and
  **its `Set`s overwrite build rows another editor changed in the meantime** where a `SetIf`
  would have skipped them (spec §7's "skip rather than clobber" holds for every other field).
  A whole `Set` that would take the record over its byte cap is refused with its whole step,
  where a `SetIf` was skipped (unlikely: builds are trimmed to fit when captured).
  Nothing of the kind happens without a race: a step decided on a view that already holds
  the other edit leaves the record alone.

  The right-hand column is today's behaviour, kept exactly: where a stored `hero` and the
  roster's differ there, a coach picked another hero since, and that pick is never undone by
  reading. One rule gives the hero everywhere (`web/src/mapstate/build.ts` `sceneHero`; the
  pick is `edit.ts` `pickHeroOps`). The row landed `Ahead` (the reader, store v12), whose Save
  wrote neither the flag nor anything about heroes differently; the writer (store v14) makes it
  `Live`, and its Save is the left-hand column. **One thing the reader already stored
  differently, on the metadata tier only:** a hero's record no longer holds `health` there
  (`build.ts` `heroBuildAt`; the save pin lost its ten metadata-tier `health` values), so such
  a save stores fewer keys. The v9 to v11 builds read the missing key as a hero alive at full
  health; this build reads that tier's health as not captured. No scene draws a hero's health
  bar on any build (tokens draw health only in Player). The stat calculator does take it: in a
  metadata-tier scene saved by this build, an item with a life threshold (Battle Vest, Hollow
  Point: 65 %) counts at full health, where Player at that second uses the path's health. The
  replay tier's save is byte for byte as before (the pins hold it). The
  reader is store v12. The writer is store v14: `ahead(...)` to `row(...)`, its store step
  (floor 12), board files that hold the flag at version 4, and `just rows-lock` after it
  (`docs/deploy.md`).
- **Health is held by the scene's tier, one rule for all three** (`build.ts` `holdsHealth`):
  Save captures a hero's `health` only for a scene whose `source.tier` is the replay's, Retake
  by the scene's own `source.tier` (not the open timeline's), and the scene reads it by the
  same. A scene saved from the replay is retaken only with the replay open.

Reading a key that is absent:

- feature captured and the row below the watermark: the row's default;
- otherwise: not captured. Nothing is drawn for it, and the **legacy meaning** applies where there
  is one: `visible: false` fades the hero for every viewer; a dead hero is a dark token; the lane
  is one split; shops are never closed.

**An existing scene has no `SceneState`**, so nothing is captured and it draws exactly as today.
Nothing is rewritten. `addSceneOps` (New scene, Duplicate) copies `SceneState` and every `more`
with the records it already copies, so a new scene from a snapshot inherits it.

### 4.6 Sync, undo, clone, files

- **Sync and conflicts:** per field and per `more` key, last writer wins; a delete beats a set.
- **Undo:** an edit is one field; a save is one step.
- **Clone and export** work per record. A clone keeps tombstones, as today.
- **Older clients** are closed as `Outdated` (the build id hashes the schema sources, so a new row
  forces a reload). The desktop app loads the client from the server.
- **The compression dictionary** was trained without `more`; rows compress less well until a new
  codec is trained. Logged as debt.

## 5. Editing

An edit sets one field of the stored state through `mapstate/edit.ts` `set(scene, entity, key,
value)`, which picks the typed op or `More`. Player's state is computed and not editable.

- **It writes only the scene.** No edit in a scene writes the board roster (D2).
- **A marker with no record yet** is created by its first edit. Two people editing it at once:
  the second edit is refused and retried as a `Set`.
- **Generic editors by kind** (phase 6): `Int` an in-place number, `Bool` and a small `Int` an
  entry in the hero's or marker's menu, `Pos` a drag. Lists need a purpose-built editor each.
- **Labels** follow spec §4b: the game's words, one to three of them.

**Consistency is the renderer's, by these rules; an edit never rewrites other fields.**

| Edit | What is drawn |
|---|---|
| A hero set dead | No health, effects or cooldowns; the dark token and its respawn time (D4). |
| A hero revived that was captured dead | Full health, not the stored 0. |
| A hero's hero changed | The stored abilities, items and build order are not drawn (they are the old hero's). In a scene that holds its heroes the pick clears them, so there is nothing to draw; in a scene from before, the roster's hero differing from the build's says so (§4.5 `has_heroes`). |
| An unseen hero dragged | Writes its place (`pos`); the last seen place is not moved. |
| A marker set up | No timer. A camp, powerup or mid-boss timer shows only while the marker is down. |
| A timer at 0 | Drawn as up. |
| `status` against a row that repeats it (camp state, stage) | `status` wins; the row is detail under it. |
| One rift up at a time | The other rift's rows are not drawn while it is down. |

## 6. Rendering and performance

**One renderer.** `web/src/mapstate/` gives every component the same interface:

```ts
interface MapState {
  hero(slot): HeroState;  marker(key): MarkerState;  lane(key): LaneState;  scene(): SceneState;
  has(feature): boolean;  // captured, or computed by Player
}
fromTimeline(tl, t): MapState        // Player
fromScene(state, sceneId): MapState  // a scene: decodes records by the registry
```

Components take a `MapState`, never the host, the timeline or scene records. The producers object
is typed with every key required (`-?`), so a row with no producer doesn't compile. The merged
clicks keep each mode's meaning: in a scene a portrait click opens the edit menu and a token click
selects; the build opens from the portrait's build control in both. The phone layout
(`PlayerSheets`) moves with the desktop one.

**Performance** (TD-50, M5):

- **Three clocks in Player:** per frame (places, eased numbers), per tenth (sight, CC, effects,
  casts, which are tenth-of-a-second series), per second (the rest). Marker timers stay computed
  on hover.
  - **Built (phase 3, `web/src/mapstate/frame.ts`):** `previewAt` is the frame's definition,
    everything at t (since phase 4's step 4 only tests read it, TD-140; `playerFrame`, the same from the clocks, is in `web/test/support/player-frame.ts`), and `host.second` is the
    second's clock for other readers (the top bar's heroes and Rejuvenator).

    | Clock | What |
    |---|---|
    | Second | A hero's souls, ult, health, height and zipline; objectives down, shops, rifts' and powerups' sites, lanes, camps, powerups, objectives' health, the Rejuvenator |
    | Tenth | Who is in the enemy's sight (the scan of `seen`), CC |
    | Frame | Places, respawn times, how long ago a ghost was seen, the urn, a rift's capture, skulls |

  - **The rule for a new feature:** the slowest clock its data allows, with a line in
    `frame-clocks.test.ts`, which compares the clocked frame with the definition at every t it
    tries (and on a real timeline given by `MAPCRO_TIMELINE`). Measured on two real matches,
    computing the map's frame and the bar's heroes late in the match went from 0.69 and 1.04 ms
    a frame to 0.04 and 0.07 (node, unthrottled).
  - **`MapState` for Player (phase 3, `web/src/mapstate/state.ts`):** `fromTimeline` gives the
    interface above over those clocks. An entity's fields are memos made when the entity is
    first asked for and kept; a field reads the second's or the tenth's part, or t, so a reader
    of one field reruns when that value changes. It holds facts only: every hero's sight
    (`inSight`, `lastSeen`) whichever Vision is picked, objectives' health whether or not Health
    is on, every death with whether its enemies saw it. `has(feature)` says what the timeline
    holds. A field's memo is made when
    the field is first read, not with its entity (a memo runs whenever what it reads changes,
    read or not): the top bar asking only who is in sight computes no place, respawn time, urn
    or death (`frame-clocks.test.ts`: no read of those series over 59 frames). `previewAt` (the
    frame under the viewer's choices, as one `MatchPreview`) is the definition the clocks are
    checked against; nothing draws from it since phase 4's step 4.
  - **Who reads it today:** the lanes, the hero tokens, the map's markers and their hovers, the
    rift's rings, the urn, the skulls, both top bars and the hero panel's "out of sight". What
    the bars still read of the timeline, and why, is under "The markers and the bars" below.
  - **A build column** is on the clocks too (`player/buildState.ts`): `buildAt` once a tenth
    (asked at the tenth's middle; a cooldown is shown in whole seconds and ends on a whole
    tenth, so every t of a tenth shows the same), the stats' input, level, K/A and max health
    once a second. Deaths and kills counted from events stay the frame's.
  - **Save as scene captures from the same producer:** `secondPart` at the frame's whole
    second (`match/save.ts`), the unfiltered facts Player computes (D9).
  - **A scene's state (phase 4, step 1, `web/src/mapstate/scene.ts`):** `fromScene(records)`
    gives the same interface from a scene's records (`sceneRecords(board, sceneId)` takes them
    out of the board's state). **Built (phase 4, steps 2 and 3):** `Board.tsx` holds one
    `mapState()`, Player's state in Player and the scene's on a scene; the lanes (their split and
    colours) and the hero tokens read it in both modes. **Built (step 4):** so do the markers,
    `RiftRings`, `UrnMark`, `DeathSkulls`, `MarkerTips` and the two top bars (below).

    | Field | In a scene |
    |---|---|
    | `hero`, `name` | The scene's own (`more.hero`, `more.name`, D2); then the roster's hero, the name typed on the board, and the source match's name while that match is loaded (D1) |
    | `alive`, `pos`, `last`, `respawn` | The record's. Dead: `pos` is null, `last` is where it stands, `respawn` its time (D4). Not placed: nowhere |
    | `souls`, `ult` | The record's |
    | `health` | The build's `health` row when the snapshot holds it (by the watermark). Dead: 0. Alive with none stored (dead at the frame, revived since): 100 (§5) |
    | `inSight` | The record's `visible` (one flag, not each team's sight: `has("sight")` is false, the legacy meaning) |
    | `marker(key).status` | The stored status; it wins over the detail (§5). Always absent in Player |
    | `lane(key).split` | `Wave.t`. In Player: the middle of the colours' gap |
    | The rest (`lastSeen`, CC, movement, `edges`, camps, powerups, rifts, the urn, the Rejuvenator, deaths) | Not captured: empty, and `has` says no, until phase 5's rows (one line each in `CAPTURED`, which doesn't compile without a line per feature) |

    The property (§9) holds for what is stored today: Save's capture of Player's frame reads
    back as that frame at the save's whole second (`web/test/from-scene.test.ts`: heroes,
    each marker's shown status, lanes; both tiers). **The metadata tier's health** (the path's,
    too coarse for Player to hold) is not captured: a snapshot is the Player frame. A scene's
    state holds health only when it was saved from a replay (`source.tier`), so a scene saved
    while the build still stored it reads the same.
  - **The viewer's Vision (`web/src/mapstate/shown.ts`, D3):** `heroDraw(hero, viewer, sight,
    stored)` is Player's Vision logic for both producers: seen; a ghost where last seen, or
    not drawn (Player); faded where it stands (a scene). A scene with no sight data keeps the
    legacy meaning (D5). **With Show last seen location on, a scene draws only the faded hero,
    with no last-seen marker** (operator, 2026-11-14, over the lead's earlier "both"): built in
    phase 4, `{ as: "faded" }` carries no ghost (`web/test/shown.test.ts`). Player still draws
    the ghost where last seen.
  - **The hero tokens (phase 4, `board/Tokens.tsx`):** a token reads its slot's `HeroState` and
    `heroDraw` in both modes; the records only to edit them (a drag, K, the respawn time) and
    for which slots the scene has. In Player `playerHero` (`shown.ts`) is the token's hero under
    the viewer's choices, what `previewAt` gave the slot (`shown.test.ts` compares the two for
    every slot, the dead included, at 41 times on both tiers under every choice). In a scene:
    D2's hero (`more.hero` once the scene holds its heroes, else the roster's), D1's names (its
    own, the board's typed name, then the source match's while it is the open match, or the open
    match's for a scene with no source), D4's dark token and respawn time, and D3/D5's faded
    hero. What stays Player's: the health arc, elevation, ziplines and CC (a scene captures none
    of the last three yet; its health is held, but whether its token draws it is the lead's
    call, so it doesn't), the ghost, the vision fades and the echo.
  - **The markers and the bars (phase 4, step 4):** `markerStates` asks `marker(key)`: in a
    scene the stored `status` (never `down`, which there also means a rift or urn point that is
    off), in Player the detail (site, down, the patron's stage under Health). A lane shop keeps
    its one rule in both: closed with its guardian, whatever a scene stores. `RiftRings`,
    `UrnMark`, `DeathSkulls` and `MarkerTips` read the frame, with the viewer's rules in `shown.ts`
    (`shownUrn`: an urn on an enemy out of the view's sight isn't drawn; `shownDeaths`: a view sees
    its own deaths and the enemy's it saw; `playerPlace`: where a portrait's focus goes). A scene
    holds no rift, urn or death yet, so the rings, the urn and the skulls stay mounted in Player
    only and a scene's markers say nothing on hover; phase 5's rows reach them through `MapState`.
    The scene's top bar draws `HeroState` (name, hero, souls, ult, alive, sight), the records only
    to edit; Player's bar draws `HeroState` and `scene().rejuv`. Player's bar still reads the
    timeline for what the frame doesn't hold: a Rejuvenator's pickup time (its timer's drain),
    the Mid-Boss's respawn counted from t, and the build columns (`BuildView`).
  - **A slot's name in a scene (TD-120):** the bar and the token both read `HeroState.name`: the
    scene's own (`more.name`), the name typed on the board, then the open match's. Names off
    hides only the match's: a scene's own name is a typed name, shown whatever Names says.
- **The bound is on consumers:** a component reruns only when a value it reads changes. Each
  entity's fields are memos keyed by slot or marker with an equality check.
- **A scene is static:** its `MapState` changes only when a record does.
- **Edit cost:** the replica cloned the whole document on every edit and receive, twice (the
  engine's view, and the WASM wrapper's copy to diff for `changed`). Measured in Chromium on a
  64-scene board (3,869 records, 768 heroes; `just edit-cost`, 300 runs, medians in ms), by the
  bytes of `more` on each hero (a real build is about 3,000; the cap is 8,192):

  | `more` a hero | Board JSON | A drag frame (edit + its ack) | A peer's entry, nothing pending | A peer's entry under a pending edit | Whole-state save |
  |---|---|---|---|---|---|
  | 0 | 748 KiB | 1.88 → 0.02 | 0.94 → 0.01 | 0.94 → 0.26 | 5.3 → 5.5 |
  | 3,000 | 2,993 KiB | 5.09 → 0.05 | 2.96 → 0.03 | 3.18 → 1.11 | 12.3 → 14.2 |
  | 8,000 | 6,331 KiB | 18.35 → 0.06 | 9.06 → 0.05 | 6.10 → 2.31 | 20.1 → 20.0 |

  **Decided: both clones go from the edit path** (before → after above; 18 ms a drag frame is
  over a frame's budget). An edit and an undo apply in place (`apply_tx_with_inverse` rolls a
  refusal back); an ack of the oldest pending transaction as sent, and a peer's entry with
  nothing pending, leave or change the view directly; `changed` compares only the records the
  call can touch. **What still copies the board:** a peer's entry while this replica has
  pending work and a rejection (the view is rebuilt from the confirmed state), a `Rebase`, and
  the whole-state save, which is unchanged and debounced. The simulation checks at every step
  that the view is the confirmed state with the pending work applied.

## 7. Follow on scenes (H5)

Vision, builds, panels and the recap are view state that today rides inside presence's `playback`,
which is not sent for a board without a match, is not mirrored when the presenter is outside
Player, and resets when the match changes. For a scene to follow as Player does (phase 2 for the
panel keys, phase 4 for the rest):

- the keys are carried outside the match gate, so a board with no match sends them;
- a follower mirrors the panel group when the presenter is on a scene;
- keys that name a death by match second (`recap.skull`) reset when the scene changes;
- the store moves out of `player/`; the follow matrix gains a column (the presenter on a full
  scene) and each new policy its ledger line.

The stored state and its edits are the document, so they need nothing in presence. Editing doesn't
stop a follow, as drawing doesn't.

## 8. Phases

Each ships alone and leaves every board working.

| # | Built | Ships |
|---|---|---|
| 0 | Characterisation tests and measurements (§9). | Nothing. |
| 1 | Server and schema reader only: `more`, `SceneState`, `FieldValue::More`, the registry with the tracer's rows as `Ahead`, limits, the heap estimate, the simulation, store v8, file version 2 read. | Nothing; the reader is ahead. |
| 2 | Builds end to end as the tracer: components read a build interface in Player; Save captures; the scene shows it; the writer (store v9, rows `Live`, file version 2; then store v10 for the K/D/A and max health rows and the unfit undo); Retake for scenes whose match is open; panel follow on scenes. | #49, for old and new scenes. |
| 3 | Player producers for the rest, feature by feature, with the clocks. | TD-50. |
| 4 | One map and bar renderer, with decisions D1–D5 and D13. | Decided changes only. |
| 5 | The remaining rows, each a release behind its reader; the marker baseline. | Per feature. |
| 6 | Editing: per-scene hero and name, generic editors, the consistency rules. Supersedes the quick right-click of #53. | Editing. |
| 7 | Resume a scene; the last `inPlayer()` draw branches go. | |

## 9. Test plan

State and sync change, so: characterisation first, mutation testing on each diff, adversarial
review before each merge.

- **Stored bytes don't move** (phase 0, `crates/schema/tests/characterisation.rs`): a board with
  every record kind, old shapes included, and a log with every op and field value, as committed
  JSON. Each parses, validates and serialises back byte for byte, in every phase.
- **Old scenes look the same; Player looks the same:** the frame functions and Save's ops are
  pinned on a synthetic match (`web/test/map-state-pins.test.ts`); the DOM of map and bar on
  fixture scenes is pinned before phase 2 touches rendering. No names or ids in fixtures; 6v6
  only; no game art.
- **The property, over every row:** `fromScene(capture(fromTimeline(t)))` equals
  `fromTimeline(t)` after capture's rounding. It iterates the registry.
- **Schema (Rust):** every kind's bounds; a key on the wrong entity; an unknown key fails to parse;
  `apply_tx_with_inverse` restores the document for `More`, cleared included; a second
  `SceneState` refused; `max_more_bytes`; the largest legal ops fit a transaction; the heap
  estimate; the lock file.
- **Admission:** a transaction and a file carrying an `Ahead` row or a `SceneState` are refused;
  a base and a log already holding them load; a row made `Live` is admitted; the simulation as
  built logs none. `just rows-lock` refuses a reordered or narrowed row.
- **Store:** a v7 database in use opens on v8 unchanged; a v7 server opens a v8 database.
- **Sync and undo, two replicas (the simulation):** `More` writes by every honest behaviour, with
  the no-clobber check over every row.
- **Files:** version 1 and 2 import; a `rows` above this build's is "Newer file"; a full scene
  round-trips through a file and a clone.
- **Follow:** the matrix's new column; a presenter going Player → scene → another match's scene.
- **Performance:** the 64-scene edit cost (`cargo run --release -p mapcro-engine --example
  scene_cost`), the consumer-rerun budget and the two churn specs.

## 10. Still open

- The operator may override any "decided (default)" row in §2.
- ~~Whether the replica's whole-document clone per edit must be fixed before the writer
  ships.~~ Measured and removed in phase 2 (§6).
