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
