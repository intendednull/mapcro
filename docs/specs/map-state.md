# Map state: one shape, computed by Player, stored by a scene

Status: design, 2026-11-13 (branch `scene-state`), revised the same day after the operator's
review. Replaces the §6b rule "Player draws only the timeline at t; Sandbox only the scene's
records" (`architecture-design.md`). Supersedes the narrow fix for feedback #49 ("Build info
dropdown does not work in the scene viewer").

Operator's ask: saving a scene snapshots the Player frame. The scene viewer shows that snapshot
with every feature Player has, and edits change the snapshot, for that scene only. The clock and
the link to the match only record when it was taken. Today the two are separate and costly to
keep in step; the design must make a new feature cheap to carry through both.

## 1. The problem today

The views were unified on 2026-11-10 (`docs/journal/2026-11-10-scene-parity.md`): the top bar's
parts live in `web/src/board/TopBarParts.tsx`, and the map controls, toolbar, side panel, scene
list and dock bar are one render in `Board.tsx`. **The data is still two things.**

- **Player** reads `host.preview(markers)` (`web/src/player/host.ts`, ~984): a `MatchPreview`
  (`web/src/match/preview.tsx`) built from the timeline at `t`, new on every frame.
- **A scene** reads its own records: `PlayerState`, `ObjectiveState`, `Wave`
  (`crates/schema/src/records.rs`), through `state.playersIn(scene)` and `state.inScene(...)`.
- **`Board.tsx` picks between them by hand**, about 40 `inPlayer()` branches:
  `matchPreview = inPlayer() ? player.preview(...) : undefined` (196), token positions (390),
  `markerStates(matchPreview, keys, own)` whose `own` is the scene's state "outside Player"
  (1124, `player/markerStates.ts`), `PlayerTopBar` or `TopBar` (976, 1436), and
  `<Show when={inPlayer()}>` around `RiftRings`, `UrnMark`, `DeathSkulls`, the skull recap,
  `Highlight` and the hero panels (1136–1242).
- **Save as scene copies** (`web/src/match/save.ts` `matchSceneOps`): the match at `t` is written
  out as twelve `PlayerState` records, `ObjectiveState` for what is down, and one `Wave` per lane.
  The copy is lossy: the lane colours' gap becomes its midpoint, a dead hero's place becomes its
  last one, and health, builds, items, camp and powerup timers, the urn, the Rejuvenator, vision
  and skulls are dropped. `Scene.source` (`{match_id, t, tier}`) is stored but nothing draws from it.

What this costs:

- A Player feature is absent from scenes until someone ports it. #49 is one; every `Show
  when={inPlayer()}` above is another.
- The two disagree where they overlap. From the backlog (scene-names, 2026-11-09): Player puts the
  match's name before a typed one and Scenes the reverse; a scene saved from another match shows
  no names, because names come from the open match (`sceneMatchName`, `board/roster.ts`); the
  hero picker's labels use neither.
- Performance fixes are per reader (TD-50): the equality memos in `player/barSlot.ts`,
  `markerStates.ts` and `buildState.ts` each guard one consumer of the per-frame `t`, and the next
  reader of `preview()` redraws every frame again.
- Every field a scene can hold is hand-written five times: the Rust record, its `Field` and
  `FieldValue`, the validation, the copy in `save.ts`, and the scene's reader. That cost is why
  the copy stayed small.

## 2. The model

**One shape, `MapState`: everything Player can show at one frame.** Two producers, one renderer.

- **Player computes it** from the timeline at `t`, every frame.
- **Save as scene stores it**, whole, in the scene's records.
- **The scene viewer reads it back** and draws it with the components Player uses.
- **Edits change the stored state**, for that scene only.

There is no match under a scene. `Scene.source` (`match_id`, `t`, `tier`) and `Scene.clock` are
metadata: where and when the snapshot was taken. Changing the clock changes the label on the bar
and nothing else; `source.t` is never edited and is where "Resume a scene" will start playback.
A scene never needs its match to draw.

`MapState` is four kinds of entity, each a flat set of fields:

| Entity | Keyed by | Fields (the full list is the registry, §3.2) |
|---|---|---|
| Hero | slot | hero, name, place, alive, placed, respawn, souls, ult, health, level, kills, build, items, effects, seen, last seen place and age, trail |
| Marker | marker key | status, health, stage, camp state, timer, buff, rift progress |
| Lane | lane key | Amber's and Sapphire's extent, troopers |
| Match | one per frame | urn, Rejuvenators, skulls and their recaps |

- **It holds the frame, not the match.** A timer is "seconds left at this frame", not a death
  time to subtract from a clock. So a stored frame needs no clock to draw, and the scene's clock
  can be a label.
- **It holds facts, not the viewer's choices.** Health is in it whether or not the Health layer
  was on at save; both teams' sight of each hero is in it whichever Vision was picked. Vision,
  the layers and names are view state, applied at render, in a scene as in Player (§5).
- **Not in it:** things that are a span of the match and not a frame: the events list, pings,
  the seek bar. They stay Player's (open question 2). Drawings, callouts and the note are the
  scene's own records, as today, and are not part of the snapshot.

## 3. Storage

### 3.1 Granularity: a record per entity, a field per value

**Chosen: keep today's record model.** One `PlayerState` per hero, one `ObjectiveState` per
marker, one `Wave` per lane, and one new `SceneState` per scene for the match-wide fields. Each
value is its own field, set by its own op.

- Two people editing different heroes, or one hero's place and its souls, both keep their edit:
  last writer wins per field, as now.
- Undo takes back one field, as now.
- The duplicate check (`Reject::Duplicate`, validate.rs), delete-with-the-scene, clone and
  `export_records` already work per record and need nothing new.

Rejected: **one snapshot blob per scene.** Simple to write, but any edit replaces the whole
frame, so a concurrent edit is lost and undo restores everything; it would also be one value of
tens of kilobytes rewritten on each drag. Rejected: **new record kinds per feature** (a
`BuildState`, a `CampState`…): that is the hand-written cost again, once per feature.

### 3.2 The registry: how a field gets stored without new schema code

The cost today is that each field is a Rust struct member, a `Field`, a `FieldValue`, a
validation arm and TypeScript on both ends. The fix is the view-state registry's pattern
(`crates/engine/src/view_state.rs`): **one table of rows, and generic code driven by it.**

`crates/schema/src/map_state.rs` holds one row per `MapState` field:

```rust
Row { key: "health", entity: Hero, kind: Int { min: 0, max: 100 },
      default: None, feature: "health", edit: Edit::None, rate: PerSecond }
```

- `kind`: a short closed list with bounds, as in the view-state registry: `Bool`, `Int`,
  `Choice`, `Text { max }`, `Pos`, `Ints { max }` (a packed list: a build, a trail, troopers).
  One codec and one validator per kind.
- `feature`: the group it is captured and drawn with ("builds", "camps", "troopers").
- `edit`: `None` (stored, view-only) or the control that edits it (§4).
- `rate`: per frame or per second, for Player's producer (§5).

Storage is generic:

- Each of the four entity records gets one new member, **`more`: a map from row key to value**
  (`#[serde(default)]`, empty in every existing record).
- One new op value, **`More { key, value: Option<Value> }`**, sets or clears one entry. It is
  one field for conflicts and undo, like any other. The schema validates it against the row:
  unknown key, wrong kind or out of bounds is refused.
- The fields that exist today (`pos`, `alive`, `placed`, `souls`, `ult_cooldown`, `visible`,
  `respawn`; `status`; `Wave.t`) keep their typed members and ops. Their rows say
  `stored: Typed(Field::PlayerPos)`, so the registry covers them and nothing about old data moves.
- `SceneState { scene, captured, more }`: `captured` lists the features this snapshot holds
  (§3.4); one per scene.
- `just ts` generates `web/src/gen/mapState.ts`: the row table and the four entity interfaces.

So sync, conflicts, undo, validation, clone, export and import are written once, for `more`,
and every later field gets them.

### 3.3 A new field, end to end

Say Player gains a hero's spirit power.

1. **Add the row** in `map_state.rs`: `key: "spirit", entity: Hero, kind: Int {..}, feature:
   "stats"`. Run `just ts`. The generated `HeroState` now has `spirit`.
2. **Produce it in Player**: one entry in `web/src/mapstate/match.ts`, `spirit: (tl, slot, sec)
   => …`. The producers object is typed `satisfies` the generated interface, so a missing
   producer doesn't compile.
3. **Draw it**: read `ms.hero(slot).spirit` in the component. It shows in Player.

Nothing else is written. Save as scene walks the rows and stores it; the scene viewer decodes
it into the same `ms.hero(slot).spirit`; it syncs, undoes, clones, exports and imports through
`more`; the round-trip test (§7) covers it because it iterates the rows. To make it editable
later, change the row's `edit` (§4): no schema or storage change.

### 3.4 What is stored, what is derived, and the size

**Stored as it is at the frame:** every row. Timers as seconds left. Each hero's sight as two
facts: seen by the enemy or not, and where and how long ago it was last seen.

**Derived at render, never stored:** team soul totals (summed); shops closed (from the guardians
down); a marker's look from status, stage and health; a ghost or a hidden hero (from sight and
the viewer's Vision); the urn hidden with an unseen carrier; eased numbers and fades; every
label. If a value can be computed from stored fields, it is not a row.

**A default is not stored.** Save writes a field only where it differs from the row's default,
and a record only where it has a field to hold. `SceneState.captured` says which features the
snapshot holds, so the reader can tell the two absences apart:

- absent, feature captured: the default (a camp with no record is up);
- absent, feature not captured: not known, so nothing is drawn for it.

**Budget** (estimates; phase 0 measures them on the reference replay and sets the caps):

| Part | Size per scene |
|---|---|
| 12 heroes: typed fields, health, level, kills, sight | ~2 KB |
| Builds and items (item id and time, ≤ 64 per hero) | ~4 KB |
| Effects, trails (≤ 16 points per hero) | ~2 KB |
| Markers that aren't default: status, health, timers, buffs | ~2 KB, 15 to 30 records |
| Lanes: extents; troopers packed (≤ 100 per lane) | ~3 KB |
| Urn, Rejuvenators, skulls; recaps (≤ 6, capped each) | ~4 KB |
| **Total** | **~15 to 20 KB, 30 to 50 records** |

- Against the limits: a save is sent in chunks under `max_ops_per_tx` (256) and `max_tx_bytes`
  (64 KiB), as Save as scene does now. 64 scenes at 20 KB is about 1.3 MiB, well under the board
  file's 8 MiB (TD-43). 64 scenes at 50 records is 3,200 of `max_records` (5,000), which leaves
  too little for ink on a full board: raise `max_records` to 8,000 with phase 4.
- Each `Ints` row has its own `max`, and `SceneState` a total cap. Over it, save drops whole
  features in a fixed order (recaps, then trails, then troopers), leaves them out of `captured`,
  and the scene simply doesn't draw them.

### 3.5 Existing scenes

**An existing scene has no `SceneState`, so its captured features are exactly today's: hero
place, alive, placed, souls, ult, seen, respawn; marker status; the lane split. It draws those
from the records it has, by the code path it does now, and nothing for any other feature.**
Nothing is rewritten, and no default can change its look, because a default applies only to a
captured feature. A hand-made scene is the same case, and stays so.

A new scene differs only by having a `SceneState` and fuller records. Lanes: an old `Wave.t` is
one split; a new scene stores the two colours' extents, and the split is drawn when they are
absent.

Old scenes can get more, by hand: **Retake** (phase 8), on a scene whose `source` match still
loads. It captures the frame at `source.t` and fills only what the scene doesn't hold, never
overwriting a stored value, in one undoable step.

### 3.6 Sync, undo, clone, files, older clients

- **Sync and conflicts:** per field, last writer wins; a delete beats a set; a second record
  for the same scene and key is refused. All as today.
- **Undo:** an edit is one field; Save as scene and Retake are one step each.
- **Clone:** the document is copied; a scene needs no timeline, so nothing else has to come along.
- **`.mapcro.json`:** `export_records` writes the records as they are. Import validates each
  `more` entry against its row and drops none silently. File version +1; older files import
  unchanged; a newer file is refused by an older server, by the envelope's rule.
- **Older clients:** the server closes a socket from another build as `Outdated`, so none edits
  a newer document. Old documents and pending ops decode (`more` defaults to empty). The hazard
  is a **server rollback** after `more` is written, so the schema that reads it ships one deploy
  before anything writes it. A row removed later leaves stored values that are ignored on read.

## 4. Editing

An edit sets a field of the stored state through one function, `mapstate/edit.ts`
`set(scene, entity, key, value)`, which picks the typed op or `More` from the row. Player's
state is computed and is not editable; the live scene keeps holding ink only.

| | Fields | How |
|---|---|---|
| **Editable now** (unchanged) | hero place, alive, placed, respawn, souls, ult, seen; marker status and hide; the lane split; the clock label; a slot's name | today's controls, now writing through `set` |
| **Stored, view-only at first** | health, level, kills, build, items, effects, sight detail, trail; marker health, stage, timers, buffs, rift progress; lane colours, troopers; urn, Rejuvenators, skulls, recaps | drawn as Player draws them |
| **Made editable later** | any of the above | change the row's `edit` |

- **Generic editors by kind:** `Int` an in-place number (as souls is now), `Bool` and `Choice` an
  entry in the hero's or marker's menu, `Pos` a drag. A row with one of these needs no editor
  code. Lists (`Ints`: builds, troopers) need a purpose-built editor each, and are the last to
  become editable, if ever.
- **An edit never rewrites other fields.** Consistency is the renderer's: a hero set dead shows
  no health or effects; a marker set down shows no timer or buff; a moved hero shows no trail.
  The stored values stay, so reviving the hero shows its health again.
- **Labels** for any new control follow spec §4b: the game's words, one to three of them.

## 5. Rendering, performance, follow

**One renderer.** `web/src/mapstate/` gives every component the same interface, whoever
produced the state:

```ts
interface MapState {
  hero(slot): HeroState;  marker(key): MarkerState;  lane(key): LaneState;  match(): MatchState;
  has(feature): boolean;  // captured, or computed by Player: hides a control with nothing behind it
}
fromTimeline(tl, t, sec): MapState   // Player
fromScene(state, sceneId): MapState  // a scene: decodes records by the registry
```

Components take a `MapState` and never the host, the timeline or scene records. `Board.tsx`
loses `matchPreview`, `markerStates`' `own` argument and its `inPlayer()` branches around what
is drawn; `PlayerTopBar` and `TopBar` become one bar. What still asks about the mode: the
transport, the events list, pings, and whether editing is on.

**Performance** (TD-50, made structural):

- **Two clocks in Player:** `t()` per frame, `sec() = floor(t)` as its own memo. A row's `rate`
  says which its producer reads; only places, eased numbers and fades are per frame.
- **No whole-state object per frame.** Each entity's fields are memos keyed by slot or marker
  with an equality check, which is what `barSlot.ts`, `markerStates.ts` and `buildState.ts` do
  by hand today; they fold into the producers.
- **A scene is static:** its `MapState` changes only when a record does, indexed once per scene
  by slot and key, not rescanned.
- **Budgets:** the existing churn specs (`player-troopers.spec.ts`, `player-topbar-writes.spec.ts`)
  plus one new: per-second rows run at most once per changed value while playing, and a scene at
  rest runs none. TD-51 and TD-53 still apply to components.

**Follow and view state:**

- The stored state and its edits are the document, so followers on a scene see the same map with
  nothing new in presence. Which scene is shown, and Player's playback, follow as today.
- The existing keys (Vision, last seen, the layers, names, hero panels and builds, All builds,
  the recap) keep their rows in `view_state.rs` unchanged. They now apply on any scene whose
  snapshot has the feature; on one that doesn't, the control is hidden and the key keeps its
  value. The store moves out of `player/`.
- No new key is needed by the model. The follow matrix gains a column: each key with the
  presenter on a full scene. Derived signals (`sec()`, the memos) get their ledger lines.
- Editing doesn't stop a follow, as drawing doesn't.

## 6. Phases

Each ships alone and leaves every board working.

| # | Built | The user gets |
|---|---|---|
| 0 | Characterisation tests (§7): old scenes and Player pinned as they are. Snapshot sizes measured on the reference replay. | Nothing visible. |
| 1 | The registry (`map_state.rs`) with rows for the fields both modes have now, generated TypeScript, the `MapState` interface. | Nothing visible. |
| 2 | Player produces `MapState` (`fromTimeline`); `host.preview` retired; the two clocks. | Nothing visible. TD-50 closed. |
| 3 | One renderer: scenes decode into `MapState` (`fromScene`); the map and one `TopBar` read only it; writes go through `set`. | Nothing visible: old scenes proven unchanged. |
| 4 | Storage: `more`, `SceneState`, the `More` op, validation, file version, `max_records`. Reader one deploy ahead of the writer. Save as scene captures by walking the rows. | A new scene holds lane colours with their gap and each slot's hero and name, so a scene from another match reads right. |
| 5 | Rows: build, items, hero panel, All builds. | Build dropdowns and hold-Tab work in a scene (#49). |
| 6 | Rows, in any order, one small change each: the bar (health, level, kills, respawn, Rejuvenator); objectives, camps, powerups, rifts, urn; troopers; skulls and recaps; sight (Vision), trails and effects. | Each shows on newly saved scenes as it lands. |
| 7 | Editing per kind: the generic editors, then rows switched to editable in the order asked for. | View-only values become editable. |
| 8 | Retake for old scenes. Resume a scene (backlog). The last `inPlayer()` draw branches go. | Old scenes can be filled in. Play on from a scene. |

Phases 0 to 5 answer #49 without building it twice. From phase 5 on, a feature costs the three
steps of §3.3.

## 7. Test plan

State and sync change, so: characterisation first, mutation testing on each diff, adversarial
review before each merge.

- **Old scenes look the same.** Real-shaped fixtures: a blank board; hand-made scenes; a scene
  saved from the replay tier, one from the metadata tier, one from another match than the open
  one, one edited after saving (moved, killed, souls and ult typed, objectives toggled, a wave
  dragged, a hero unseen); nested scenes; a document with none of the `serde(default)` fields.
  Their decoded state and the DOM of map and bar are recorded on the release candidate and must
  not change in any phase. No names or ids in fixtures; 6v6 only; no game art committed.
- **Player looks the same:** `fromTimeline` at a spread of times of the reference replay equals
  `host.preview`, `playersAt` and `buildAt` until each is retired.
- **The property, over every row:** capture Player's state at `t`, decode it, and get the same
  value (`fromScene(capture(fromTimeline(t)))` equals `fromTimeline(t)`). The test iterates the
  registry, so a new row is covered without a new test, and a row with no producer doesn't
  compile. One e2e per feature: its test id is present on a scene saved from the reference replay.
- **Boundaries:** a lint test that only `mapstate/` imports the timeline's `*At` functions or
  reads scene state records; a count of `inPlayer()` in `Board.tsx` that may only go down.
- **Schema (Rust):** old records round-trip byte for byte; every kind's bounds; an unknown key
  refused; `apply_tx_with_inverse` restores the document for `More`, cleared included; a second
  `SceneState` refused; old file imports; a newer file refused; the size caps and the drop order.
- **Sync and undo, two replicas:** edits to two fields of one hero both kept; edit against
  delete; undo and redo of a field edit, Save as scene and Retake.
- **Clone and file round trip** of a full scene, with no timeline on the target.
- **Follow:** the matrix's new column; a presenter going Player → scene → another match's scene.
- **Performance:** the memo-run budget and the two churn specs, every phase.

## 8. Open questions for the operator

1. **Store player names in the snapshot?** Recommended: yes. They are on screen in Player, and
   it is the only way a scene from another match keeps its names. They would then be in the
   board's document and its exported file.
2. **Events list and pings in a scene?** Recommended: no. They are a span of the match, not a
   frame. A scene with a `source` gets a way back into Player at that moment instead (Resume).
3. **Capture everything at save, whatever layers and Vision were on?** Recommended: yes; the
   viewer of the scene picks layers and Vision afterwards.
4. **Old scenes: leave as they are, with Retake by hand?** Recommended: yes; never automatic.
5. **Troopers and recaps are the bulk of a snapshot. Store them?** Recommended: yes, within the
   caps, dropped first when a scene is over budget.
6. **Which view-only values should become editable first (phase 7)?** Recommended: health and
   level, then camp and objective timers; builds and troopers stay view-only.
