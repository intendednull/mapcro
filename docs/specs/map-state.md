# Map state: the match at t, plus the edits

Status: design, 2026-11-13 (branch `scene-state`). Replaces the §6b rule "Player draws only the
timeline at t; Sandbox only the scene's records" (`architecture-design.md`). Supersedes the narrow
fix for feedback #49 ("Build info dropdown does not work in the scene viewer").

Operator's ask: everything Player can show of the map should be available in a scene; the match's
state is the starting point and edits go on top; and a new feature should not have to be built
twice.

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
- "Resume a scene" (backlog) can't be built on a copy: the scene no longer knows which of its
  values are the match's and which the coach changed.

## 2. The model

**What's on the map is `compose(base(source, t), edits)`, then the viewer's view state.** Three
inputs, the same in every mode:

| | source | who owns `t` | edit layer |
|---|---|---|---|
| Player | the open match | the playback clock | the match's live scene (`Scene.live`) |
| A scene saved from a match | `scene.source.match_id` | the scene: `scene.clock`, frozen | the scene |
| A scene with no match | none | none | the scene |

"Player" and "a scene" stop being two renderers. They are one view given a different row of this
table; the only things that still ask "is the clock live?" are the transport controls and pings.

### 2.1 The match layer (the base)

`base(source, t)` is a pure function of a timeline and a time. It holds everything the match says
at `t`, by the board's keys: per slot the hero, name, position, alive, respawn, souls, ult, health,
level, build and items, effects, and what each team sees of it; per marker key the status, health
and stage, camp state and timer, powerup buff and spawn, rift, shop; per lane the two zipline
colours; the urn; the Rejuvenators; recent deaths (skulls); troopers; the events and their
recaps. It is today's `MatchPreview` plus what `PlayerTopBar`, `BuildColumn` and the events list
read from the timeline themselves.

With no source the base is **the board's defaults**: every hero at its starting place
(`PlayerState::starting`), alive and seen, no souls, ult or health; every objective up, rifts and
urn points off, powerups available; each lane's default split; nothing else. "You see only the
edits" means edits over this, which is what a blank scene draws today.

A base value can be missing (a metadata-tier match has no lanes, camps or builds). A missing
value falls through to the default, and a feature with nothing to show draws nothing; its
control is hidden, as in Player on the metadata tier today.

### 2.2 The edit layer

Edits are the scene's records, and each is one of three things:

| Kind | Edit | Record | Keyed by | Absent means |
|---|---|---|---|---|
| Hero token, top-bar values | **replace** per field: place, alive, respawn, souls, ult, seen | `PlayerState`, fields optional | scene + slot | the base's value for that field |
| Hero token | **hide**: off the map | `PlayerState.placed = false` | scene + slot | shown where the base has it |
| Objective, camp, powerup, rift, urn point, shop | **replace** the status; **hide** (`Hidden`) | `ObjectiveState` | scene + marker key | the base's status and detail |
| Lane | **replace** the colours with one split | `Wave` | scene + lane | the base's two colours |
| Clock | **replace**: the scene's `t` | `Scene.clock` | scene | none (a scene with no match: no clock) |
| Name | **replace**, board-wide | `RosterSlot.name` | slot | the base's player name |
| Drawings, callouts, the note | **add** | `Stroke`, `Arrow`, `Callout`, `Note` | scene | nothing drawn |
| Panels (hero panel, builds, All builds, recap, events) | none: view state (§5) | | | |

Rules:

- **An edit is per field.** Dragging a hero sets only its place; its souls, health and build stay
  the match's. So in Player a moved hero stays where it was put while the match plays on around
  it, and a retimed scene (below) keeps the coach's moves over the new moment.
- **An edited thing shows no base detail that contradicts the edit.** A status override drops the
  base's detail for that key (health bar, timer, buff, ring); a `Wave` replaces both colours; a
  hero set dead shows no health; a moved hero keeps its health and effects, but not its movement
  trail or its last-seen ghost.
- **Undoing an edit is deleting it.** Deleting the record (or the one field) gives the base back.
  The UI needs one action for it per token and marker, plus one for the whole scene.
- **The hero is the base's.** With a match it is the match's hero for that slot; `RosterSlot.hero`
  is the hero of the no-match base, so a board with scenes from two matches shows each one's
  heroes. Changing a hero in a scene that has a match isn't offered.
- **A typed name is an edit, so it wins** over the match's name, in Player and in scenes. This
  settles the backlog's "Player puts the match's name before a typed slot name".
- **Not editable in the first version:** health, level, builds, items, effects, camp timers,
  the urn's and Rejuvenator's state, skulls, troopers, events. They are the base's or absent. Each
  can become an edit later by adding a field or record and a row in the feature table (§4); nothing
  else changes.

### 2.3 Who owns t

- **Player:** `host.t`, the playback clock, as today.
- **A scene saved from a match:** `scene.clock`. It is already a synced field with an editor in
  the stage head. Editing it **retimes the scene**: the base moves to that second and the edits
  stay on top. `source.t` stays what it was: the moment the scene was saved from.
- **A scene with no match:** no `t`. `scene.clock` is only the number the top bar shows, as today.
- **A follower:** the presenter's row of the table. In Player it is the presenter's playback, by
  the existing clock sync; on a scene it is the scene's own clock, from the document, so it needs
  nothing on the wire (§5).

### 2.4 Composition order

`base(source, t)` → the edits → view state. View state is the viewer's own filter and never
changes the document: Vision (one team's view, last seen), the map layers (health, movement,
status, heals, crates, troopers, pings), names. It applies after the edits, so Vision treats an
edited hero like any other: a hero the coach marked unseen is a ghost in that team's view.

## 3. Storage

### 3.1 What a scene stores

A scene saved from a match stores **where it came from, its clock, and only what was changed**:

- `Scene.source = { match_id, t, tier, layer: true }` and `Scene.clock` (§2.3).
- Edit records only for what the coach touched (§2.2). A scene saved and never edited has none.
- One `MatchCopy` record: the match at the scene's clock, reduced to what a scene holds today
  (per slot: place, alive, souls, ult; the objectives down; rift, urn and powerup states; each
  lane's colours). It is **the base when the timeline can't be loaded**, and nothing else reads
  it. Timelines are not durable: a CDN replay expires and the server's cache is trimmed
  (`REPLAY_MAX_CACHE_BYTES`), and a board file carries none. Without the copy such a scene would
  fall back to the defaults under its edits. With it, the worst case is today's scene.

A scene with no match stores what it does today.

### 3.2 Schema changes (`crates/schema/src/records.rs`)

1. `SceneSource.layer: bool`, `#[serde(default)]`. True: the scene draws its match under its
   edits. A new field value `SceneLayer(bool)` sets it (used once, by 3.3's upgrade).
2. `PlayerState.pos`, `.alive`, `.placed`, `.visible` become `Option`, absent meaning the base's.
   `souls`, `ult_cooldown` and `respawn` are `Option` already; `None` now reads "the base's",
   which with no match is none, as today. The field values `PlayerPos`, `PlayerAlive`,
   `PlayerPlaced`, `PlayerVisible` take an `Option` too, so the inverse of a first edit can put
   "absent" back. A bare value still decodes as `Some`, so stored documents, journals and pending
   ops read unchanged.
3. A new record kind `MatchCopy { scene, players, down, sites, lanes }`, one per scene (a second is
   `Reject::Duplicate`, like the other per-scene records), with one field value that replaces it
   whole. Written with the scene and again on a retime, in the same transaction as the clock.
4. `ObjectiveState`, `Wave`, `Stroke`, `Arrow`, `Callout`, `Note`: unchanged. They are already
   sparse and keyed, which is the override shape.

No server database migration: documents are stored as records, and every change above reads old
data as it is. The board file's version goes up by one (3.5).

### 3.3 Existing scenes: the rule

**A scene draws a match under its edits only if `source.layer` is true. No existing scene has
it, so every existing scene keeps the no-match base, and nothing is rewritten.**

Why this is exact: an existing scene holds a full `PlayerState` for each of the twelve slots, so
every token field is an edit and the base shows through nowhere; its objectives, rifts, powerups
and lanes are records over the defaults, which is how they're drawn now. Same records, same
base, same picture, by construction rather than by a conversion that has to be right.

Rejected: **turning the layer on for old scenes that have a `source`**. Their records can't be
told from edits (the copy rounded, clamped and merged values; a coach may have moved a hero back
to where it was), and the match layer would add things the scene never showed: health, timers,
the urn, skulls, the lane gap. That is a visible change to saved work nobody asked for.

Offered instead, per scene and by hand (phase 8): an action on an old scene with a `source`
whose match loads and whose clock is still `source.t`. In one transaction it recomputes what
Save as scene wrote for that moment (`matchSceneOps` is deterministic), deletes each record or
field that still equals it, writes the `MatchCopy`, and sets `layer`. What's left is what the
coach changed. One undo takes it all back.

### 3.4 Sync, conflicts, undo

- **Edits are ordinary records**, so they sync, merge and undo as records do: last writer wins
  per field; a delete beats a concurrent field set.
- **First edit creates the record.** Two people editing the same untouched hero at once both
  send a `Create` for the same scene and slot; the server refuses the second (`Reject::Duplicate`,
  validate.rs). The client must turn a refused create into field sets on the record that won, so
  neither edit is lost. `ObjectiveState` and `Wave` are created this way already; the test plan
  pins the behaviour for all three (§7).
- **Undo** of a first edit deletes the record: the base comes back. Undo of a later edit restores
  the field, absent included. Reset (token, marker, scene) is a delete, and undoable.
- **A retime** is one transaction: `SceneClock` and the new `MatchCopy`. Edits are untouched.
- **Save as scene** in Player creates the scene (`layer: true`, clock `floor(t)`), its
  `MatchCopy`, and moves everything in the live scene into it: the ink, arrows and callouts as
  today (`takeAnnotationsOps`), and now the token, objective and lane edits too.
- **Limits:** a saved scene costs 2 records plus its edits, where it cost about 20 to 40. More
  scenes fit under `max_records`.

### 3.5 Clone, board files, older clients

- **Clone** copies the document, layered scenes included. It already carries the board's matches
  and cached uploads (`carry_to_clone`); where a timeline didn't come along, the `MatchCopy` draws.
- **`.mapcro.json`** writes the records as they are: `source` with `layer`, the edits, the
  `MatchCopy`; no timeline, as now. On import the scene draws from its match if this server can
  load it, else from the copy. File version +1; older files import as they are (no `layer`, so
  3.3 holds for them too); a newer file is refused by an older server, by the envelope's rule.
- **Older clients** can't edit a newer document: the server closes a socket from another build
  as `Outdated` and the page or app updates. Stored documents and a tab's pending ops decode
  (3.2). The one hazard is a **server rollback** after layered scenes exist, so the schema
  (reading) ships one deploy before anything writes `layer`, `MatchCopy` or an absent field.
- **The timeline for a scene** is loaded by `source.match_id`, not "the open match", through the
  client's existing timeline cache. This fixes "a scene saved from another match shows no names".
  While it loads, and if it can't, the copy draws; when it arrives the base swaps in.
