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
| Hero, name | **replace**, board-wide | `RosterSlot.hero`, `.name` | slot | the base's hero and player name |
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
