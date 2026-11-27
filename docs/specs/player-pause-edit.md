# Full Scene Editing While Player Is Paused (`#61`)

**Status:** Design specification · **Issue:** `#61` ("Full scene editing while Player is paused")  
**Scope:** Web client (`web/src/player/live.ts`, `web/src/player/Player.tsx`, `web/src/player/PlayerTopBar.tsx`, `web/src/player/markerStates.ts`, `web/src/match/save.ts`, `web/src/board/Board.tsx`, `web/src/board/Layers.tsx`, `web/src/board/TopBar.tsx`, `web/src/styles/transport.css`, `web/test/view-state-ledger.ts`). **Zero schema or store version bump.**

> **User request (`#61`):** *"It would be nice to be able to fully edit the scene while the player is paused. Like you can in the scene editor. If changes are made, there is a visible button that lets you save that as a scene. Or you press pause, it clears all the changes and continues. Nice for when you want to make some quick adjustments, but don't really care if it saves."*

---

## 0. Open Decisions for Operator

| # | Decision | Recommended default | 1-line alternative |
|---|---|---|---|
| **D1** | **What happens to ink drawings (`Stroke`, `Arrow`, `Callout`) when pressing Play (`Space`) to resume?** | **Unpausing clears all *entity & map-state overrides* (moved heroes, killed/revived heroes, toggled objectives/health/camps/rifts, wave splits, doorways, souls/ults) while *keeping live ink/arrows/comments*.** Coaches frequently pause, draw a rotation arrow, and press Play to watch the replay run against their drawing (and `Play with scene plan` relies on live ink persisting during playback). A 1-click `Reset` button (or `C`) clears everything. | Unpausing clears both entity/map-state overrides and any ink/arrows/comments drawn while paused. |
| **D2** | **What happens when stepping/seeking on the timeline (`←`/`→` `±5 s`, scrubber drag, event jump) while paused with edits?** | **Any timeline seek/scrub clears entity & map-state overrides** (just like pressing Play) so stale hero positions or objective states from timestamp `t₁` never linger out-of-context at `t₂`. | Scrubbing/event-jumping clears overrides, while small `←`/`→` (`±5 s`) steps preserve non-positional overrides (objectives/doors). |

---

## 1. Grounded Architecture Analysis: Option A vs. Option B

### 1.1 How Player Works Today

Today in `web/src/player/live.ts` and `web/src/board/Board.tsx`:
- Every loaded match creates one hidden CRDT scene record `Scene { live: true }` (`idFrom("mapcro-live:${board}:${matchId}")`) plus 12 deterministic `PlayerState` records (`idFrom("mapcro-live:${board}:${matchId}:${slot.id}")`).
- While in Player (`inPlayer() === true`):
  - `activeMapState()` returns `matchState()` (`fromPlayer(match, sec, ...)`), where `canEdit()` is `false` (`web/src/mapstate/state.ts:289`).
  - `drawSceneId()` returns `liveScene()` (`Board.tsx:314`), so `Brush` (`W`), `Arrow` (`A`), `Comment` (`S`), and `Erase` (`D`) write `Stroke`, `Arrow`, and `Callout` records attached to `liveScene()`.
  - `Tokens.tsx` runs with `readOnly={inPlayer()}` (`Board.tsx:866`), and `Layers.tsx` disables hero drag, objective toggles, `#55` objective health drag, camp/rift toggles, lane wave split dragging, `K` kill/revive, and Doorman doorway editing whenever `inPlayer()` is `true`.

### 1.2 Comparing the Two Candidate Architectures

| Dimension | **Option A: Live-Scene CRDT Override Layer (`liveScene` + `fromPausedPlayer`) — RECOMMENDED** | **Option B: Ephemeral Local Signal Overlay + `Presence` Diff** |
|---|---|---|
| **How edits are stored** | Reuses `liveScene` (`Scene { live: true }`), its 12 existing deterministic `PlayerState` records, and deterministic `SceneState` / `Wave` / `ObjectiveState` records on `liveScene`. `fromPausedPlayer(base, live)` layers sparse overrides over `fromPlayer(...)`. | Holds a local Solid signal `pauseDiff` in `Player.tsx` and broadcasts serialized diff blobs inside 20 Hz `Presence` frames. |
| **Code reuse with Scene Editor** | **~100% reuse.** Every existing op generator (`edit.ts`, `objectives.ts`, `writeDoorsOps`, `#55` `setObjectiveHealthOps`, `Tokens.tsx`, `Layers.tsx`, `TopBar.tsx`) writes standard `BoardState` ops against `liveScene()`. | **Duplicates every mutation path.** Requires a parallel in-memory reducer for heroes, objectives, health, camps, waves, doors, souls, ults, and sight. |
| **Multi-editor & Follower sync** | **Native CRDT sync.** Two coaches paused together can both drag tokens (`Presence.drag` already keys by `slot`!) and toggle objectives/doors with automatic `SetIf` conflict resolution. Followers see every edit immediately. | Breaks when two coaches edit simultaneously (last writer overwrites the entire `Presence` diff); bloats every cursor `Presence` packet (`max 60 Hz`). |
| **Undo / Redo (`Ctrl+Z` / `Ctrl+Y`)** | **Works out of the box** via `BoardState.undo()` / `redo()` (`crates/engine/src/replica.rs` per-author `SetIf` undo stack). Resuming playback clears overrides via `state.editSilent(...)` so no dead undo entries remain. | Requires building a separate client-only undo/redo stack and coordinating it with `BoardState.undo()` for strokes/arrows/callouts drawn in the same pause session. |
| **`Save as scene` conversion** | `matchSceneOps` (`web/src/match/save.ts`) reads the composite `fromPausedPlayer` `MapState` (plus `liveScene`'s `SceneState.more` doors/health/camps/rifts), moves annotations via `takeAnnotationsOps`, and silently resets `liveScene` overrides in **one atomic transaction**. | Must translate custom diff structs back into schema records at save time. |
| **Record & Tombstone Budget (`LIMITS.max_records = 5000`)** | **Zero tombstone accumulation** by using deterministic `RecordId`s (`idFrom(...)`) and the schema's built-in `[Op::Restore, Op::Set]` pattern (`crates/schema/src/validate.rs:475`) when re-creating `SceneState` / `Wave` / `ObjectiveState` on `liveScene`. | Zero store records, at the cost of no CRDT or undo integration. |

**Decision:** Adopt **Option A**.

---

## 2. Option A Detailed Design: Sparse Override Encoding & Zero-Tombstone Lifecycle

### 2.1 Deterministic Record IDs on `liveScene` (`web/src/player/live.ts`)

Extend `web/src/player/live.ts` with deterministic ID helpers for `liveScene`:
```ts
export const liveSceneStateId = (board: string, match: number): RecordId =>
  idFrom(`mapcro-live:${board}:${match}:state`);
export const liveWaveId = (board: string, match: number, lane: number): RecordId =>
  idFrom(`mapcro-live:${board}:${match}:wave:${lane}`);
export const liveObjId = (board: string, match: number, key: string): RecordId =>
  idFrom(`mapcro-live:${board}:${match}:obj:${key}`);
```

**Why deterministic IDs + `Op::Restore` matter:**
- In `crates/schema/src/validate.rs:475` and `crates/schema/src/lib.rs:194`, deleting a record (`Op::Delete`) turns it into a `Record::Tombstone` at that `RecordId`, which counts toward `LIMITS.max_records = 5000`.
- When a record uses a deterministic `RecordId` (already proven by `ensureLiveSceneOps` in `web/src/player/live.ts:46-54`!), re-creating it when `state.isTombstone(id)` emits `[Op::Restore { id }, ...setOps]` instead of `Op::Create` with a random UUID!
- Therefore, across 1,000 pause → edit → unpause cycles in a long coaching session, `liveScene` creates **at most** 1 `SceneState`, 4 `Wave`s, and 25 `ObjectiveState`s total — **zero unbounded tombstone growth**.

### 2.2 Sparse Field Overrides on the 12 `liveScene` `PlayerState` Records

The 12 `PlayerState` records on `liveScene` are created in a neutral baseline state (`placed: false, pos: { x: 0, y: 0 }, alive: true, ult_cooldown: null, souls: null, respawn: null, more: undefined`). While paused, each field acts as a **sparse override** over the underlying `fromPlayer` match timeline hero state (`baseHero`):

| Hero Property | Baseline (Unedited on `liveScene`) | Override Active Condition | How `fromPausedPlayer` Resolves Value | How Editor Mutates It |
|---|---|---|---|---|
| **Position (`pos` / `last`)** | `rec.placed === false` | `rec.placed === true` | When `rec.placed === true`, use `rec.pos` (and hero is placed on map); else `baseHero.pos()` / `baseHero.last()`. | Dragging a hero token on the minimap sets `PlayerPlaced: true, PlayerPos: pt`. |
| **Life (`alive`)** | `rec.alive === true && rec.more?.health === undefined` | `rec.alive === false` (killed override) **or** `rec.more?.health === 100` (revived override) | If `rec.alive === false` → `false`; if `rec.more?.health === 100` → `true`; else `baseHero.alive()`. | Pressing `K` or `Kill`/`Revive`: killing sets `PlayerAlive: false` (and `PlayerPlaced: true, PlayerPos: curPos` so their dead token stays editable at their spot); reviving a dead replay hero sets `PlayerAlive: true, More.health: 100, PlayerPlaced: true, PlayerPos: baseHero.last(), PlayerRespawn: null`. |
| **Respawn timer (`respawn`)** | `rec.respawn == null` | `rec.respawn != null` (or cleared to `0` on revive) | If `rec.alive === false` and `rec.respawn == null` on a hero killed while paused, default to `null` (or dragged `rec.respawn`); else `rec.respawn ?? baseHero.respawn()`. | Dragging the `.respawn-badge` on a dead hero token writes `PlayerRespawn: sec`. |
| **Sight (`unseen`)** | `rec.more?.unseen === undefined` | `typeof rec.more?.unseen === "boolean"` | If `rec.more?.unseen === true` → unseen (`true`); if `rec.more?.unseen === false` → in-vision (`false`, overriding a replay FOW unseen state!); else `baseHero.unseen()`. | Clicking `.tb-vis` eye button or `Mark not seen` / `Mark in vision` in `hero-menu` writes `More: { key: "unseen", value: nextUnseen }` (creating `More` with `rows: 42` if needed). |
| **Ult cooldown (`ultCooldown`)** | `rec.ult_cooldown == null` | `rec.ult_cooldown != null` | `rec.ult_cooldown ?? baseHero.ultCooldown()` | Dragging/scrolling/clicking `UltRing` in `PlayerTopBar` writes `PlayerUlt: sec`. |
| **Souls (`souls`)** | `rec.souls == null` | `rec.souls != null` | `rec.souls ?? baseHero.souls()` | `Set souls…` in `hero-menu` (or double-clicking `.tb-souls` while paused) writes `PlayerSouls: val`. |
| **Hero swap / Rename** | `rec.more?.hero === undefined`, `rec.more?.name === undefined` | Defined on `rec.more` | `rec.more?.hero ?? baseHero.heroId()`, `rec.more?.name ?? baseHero.name()` | `Change hero…` / `Rename…` in `hero-menu`. |

### 2.3 Map & Objective Overrides on `liveScene`

How each map-level feature layers overrides onto `base = fromPlayer(...)`:

1. **Objectives (`Guardian`, `Walker`, `Base guardian`, `Shrine`, `Patron`):**
   - When the user clicks an objective (or changes Patron stage in `obj-menu`) while paused:
     - Look up `liveObjId(board, matchId, m.key)`. If an `ObjectiveState` record exists on `liveScene`, its `status` (`"Active" | "Stage2" | "Destroyed"`) overrides `base.marker(m.key).status()`.
     - When first toggling an objective that has no `ObjectiveState` on `liveScene` yet, compute `nextStatus` from `base.marker(m.key).status()` (e.g., if `base` is `"Destroyed"`, clicking revives it by creating/restoring `ObjectiveState` on `liveScene` with `status: "Active"`!).
2. **Objective Health (`#55` drag-to-set-health & `obj-menu` presets):**
   - When the user drags health on an objective while paused, `setObjectiveHealthOps` writes to `liveScene`'s `SceneState.more.obj_health`.
   - To avoid losing other objectives' replay health values when only one objective is edited, seed `liveScene`'s `obj_health` map from `base` on the first health edit (or merge `liveScene`'s decoded `obj_health` entries over `base.marker(key).health()` in `fromPausedPlayer`, with an explicit sentinel `stage = 0` or `ObjectiveState` override when an objective is revived to `100%`).
3. **Mid-Boss, Neutral Camps, Sinner's Sacrifice (`camps`), Teleporters, Bridge Buffs, Soul Urn (`rifts`):**
   - `SceneState.more.camps` and `SceneState.more.rifts` store FNV-1a 32-bit hashes of toggled marker keys.
   - In `fromPausedPlayer`, treat `liveScene`'s `SceneState.more.camps` and `SceneState.more.rifts` as **XOR delta lists** against `base.marker(key).down()`!
   - Clicking a camp, vault, teleporter, bridge buff, or urn site while paused simply toggles `fnv1a32(key)` in `liveScene`'s `SceneState.more.camps` / `rifts` using the existing `toggleCampOps` / `toggleRiftOps` (`web/src/mapstate/edit.ts:62-122`) — zero changes to those functions!
4. **Lane Zipline / Wave Splits (`.wave-hit` in `Layers.tsx:664`):**
   - While playing, zipline edges come from `match.lanes` (`laneEdges` in `Player.tsx:241`).
   - When paused and a user drags `.wave-hit` on lane `L` (`0..3`), it creates/updates `liveWaveId(board, matchId, L)` (`Wave { scene: liveScene, lane: L, split }`) via `setWaveOps`.
   - While a `Wave` record exists for lane `L` on `liveScene`, `Player.tsx:241` substitutes `shiftEdges(matchEdges[L], wave.split, matchSplit(L))` for that lane so the zipline border moves smoothly with the dragged `.wave-hit` handle!
5. **Doorman Doorways (`SceneState.more.doors`):**
   - When a Doorman is in the match and the user places/drags/toggles sight/erases a doorway while paused, `writeDoorsOps` writes `has_doors: true, doors: [...]` to `liveScene`'s `SceneState.more`.
   - In `fromPausedPlayer`, when `liveScene`'s `SceneState.more?.has_doors === true`, `ms.doors()` returns `decodeDoors(liveState.more.doors)`; otherwise it returns `base.doors()` (the replay's live doorway state at `sec`).

### 2.4 Resetting Overrides (`clearPauseOverridesOps` in `web/src/player/live.ts`)

When the user presses **Play (`Space`)**, scrubs/seeks the timeline, or clicks **`Reset`**:
- `clearPauseOverridesOps(state, board, matchId)` inspects `liveScene`:
  1. For each of the 12 `PlayerState` records on `liveScene` that has any non-baseline field (`placed`, `!alive`, `ult_cooldown != null`, `souls != null`, `respawn != null`, `more != null`), emits `Op::Set` resetting only the dirty fields back to baseline (`PlayerPlaced: false, PlayerPos: { x: 0, y: 0 }, PlayerAlive: true, PlayerUlt: null, PlayerSouls: null, PlayerRespawn: null` and `More` keys to `null`).
  2. For `liveScene`'s `SceneState` (if present) and any `Wave` or `ObjectiveState` records belonging to `liveScene`, emits `Op::Delete { id }`. (Next time the user edits while paused, deterministic IDs resurrect them via `Op::Restore` with zero net tombstones).
- **Execution mode:**
  - On **Play (`Space`)** or **timeline seek/scrub**: execute via `state.editSilent(clearPauseOverridesOps(...))` (`web/src/board/state.ts:289`) so clearing ephemeral pause overrides does **not** push an undoable "clear" entry onto the user's `Ctrl+Z` stack, and also flush any undo entries that mutated `liveScene` entity records during that pause.
  - On explicit **`Reset`** button click while still paused: execute via `state.edit(clearPauseOverridesOps(...))` so an accidental click on `Reset` can be recovered immediately with `Ctrl+Z`!

---

## 3. UX & Layout Specification: Entering / Leaving Pause-Edit State

### 3.1 Mode Gating (`pausedEditable` in `Board.tsx`)

Define a single reactive memo in `Board.tsx`:
```ts
const pausedEditable = createMemo(() =>
  inPlayer() && !player.playback().playing && state.canEdit()
);
```

- **When `inPlayer() && player.playback().playing` (Playing):**
  - `Tokens.tsx` receives `readOnly={true}` (clicking a hero token opens `HeroCard`; double-clicking tracks the hero per `#16`).
  - `Layers.tsx` allows ink tools (`Brush` `W`, `Laser` `E`, `Arrow` `A`, `Comment` `S`, `Erase` `D` on annotations) and `Select` (`Q`) for dragging/editing annotations (`Callout`, `Arrow`, `Stroke`), while map entities (objectives, camps, waves, hero positions) remain locked to the running clock.
- **When `pausedEditable() === true` (Paused + Editor permissions):**
  - **Zero toolbar or layout jump:** The left toolbar (`Select` `Q`, `Brush` `W`, `Laser` `E`, `Arrow` `A`, `Comment` `S`, `Erase` `D`, `Clear` `C`) is *already* rendered in Player for editors (`Board.tsx:788`). No new toolbar chrome appears or disappears when pressing `Space` to pause/play!
  - **`Tokens.tsx` (`readOnly={!pausedEditable()}` while `inPlayer()`):**
    - Dragging a hero token (`distPx >= 6 px`) moves the hero on `liveScene` (emitting `Presence.drag` at 20 Hz so peers and followers see the smooth drag, then committing `PlayerPlaced: true, PlayerPos: pt` on release).
    - **Preserving 1-click `HeroCard` & 2-click Camera Track (`#16`) in paused Player:**
      - On a stationary click (`!d.moved`, `< 6 px`) on a hero token while paused in Player:
        - Click 1 still opens/raises `HeroCard` (`onOpen(team, slot)`)!
        - Click 2 within `400 ms` toggles camera tracking (`#16`).
        - `Shift+click` or marquee drag (`Layers.tsx:1005`) selects multiple hero tokens for group drag.
        - Right-click (`onContextMenu`) opens `hero-menu` (`Kill`/`Revive`, `Mark not seen`/`Mark in vision`, `Set souls…`, `Track hero`, Doorman `Place doorway`/`Clear doorways`).
  - **`Layers.tsx` (`canEditEntities = !inPlayer() || pausedEditable()`):**
    - Unlocks objective 1-click toggle (`clickObjective`), `#55` vertical drag-to-set-health (`setObjectiveHealthOps`), right-click `obj-menu`, camp/vault/teleporter/buff/urn toggles, lane wave split handle dragging (`.wave-hit`), `K` hotkey to kill/revive hovered hero, dead hero respawn badge dragging (`.respawn-badge`), and Doorman doorway placement/drag/sight/erase.
    - **Dead heroes in paused Player:**
      - When a hero is killed *while paused* (`livePlayer.alive === false`), render their full dead hero token (with `.dead-x` and draggable `.respawn-badge`) at their death position just like in Scene mode so the coach can drag them or press `K` to revive them.
      - For heroes who were *already dead in the replay timeline* at `sec` (rendered as `.pl-skull` on the map and `.dead` in `PlayerTopBar`), the coach can revive them onto the map by pressing `K` while hovering their `.pl-skull` / top-bar portrait, right-clicking their portrait/skull and choosing **`Revive`**, or dragging their portrait from `PlayerTopBar` onto the minimap!
  - **`PlayerTopBar.tsx` (`canEdit={pausedEditable()}`):**
    - Unlocks `UltRing` drag/scroll/click on `.tb-ult` (`writeUlt`), `.tb-vis` sight toggle (`toggleUnseen`), right-click `hero-menu` on `.tb-player`, and dragging a dead hero portrait onto the map to revive and place them at the drop point.
    - **Preserving `.tb-souls` (`data-testid="souls-banner"`) build drawer toggle:** Single-clicking `.tb-souls` in `PlayerTopBar` continues to toggle the hero's `BuildColumn` dropdown so existing Player muscle memory and E2E tests are never broken; editing souls while paused is available via **`Set souls…`** in `hero-menu` (or double-clicking `.tb-souls`).

### 3.2 Dirty State Detection (`hasPauseEdits`) & Visible `"Save as scene"` + `"Reset"` Controls

Define `hasPauseEntityOverrides` and `hasPauseEdits` in `Player.tsx` / `live.ts`:
- `hasPauseEntityOverrides()`: returns `true` iff any of the 12 `liveScene` `PlayerState` records has a non-baseline field (`placed`, `!alive`, `ult_cooldown != null`, `souls != null`, `respawn != null`, `more != null`), or `liveScene` has a live `SceneState`, `Wave`, or `ObjectiveState` record.
- `hasPauseEdits()`: returns `hasPauseEntityOverrides() || hasLiveAnnotations()` (where `hasLiveAnnotations` checks if `liveScene` has any `Stroke`, `Arrow`, or `Callout`).

#### Exact Placement Across Form Factors (Zero Layout Jump, Zero Phone Vertical Overflow)

1. **Desktop & Narrow Desktop (`.pl-bar` in `web/src/player/Player.tsx:601-630`):**
   - `.pl-tail` already renders `[data-testid="match-save"]` (`Save scene` / `Save N scenes`).
   - When `hasPauseEntityOverrides()` is `true`:
     - Update `[data-testid="match-save"]` label to **`Save as scene`** (when `markCount() === 0`) and add class `dirty` (`classList={{ dirty: hasPauseEntityOverrides() }}`), giving the button an accent border + a `6×6 px` live accent dot (`.save-dirty-dot`) so it stands out immediately.
     - Render a compact ghost **`Reset`** button (`data-testid="match-reset"`, `class="btn small ghost"`, `<Hover tip={() => <TagTip text="Reset changes" />}>`) immediately to the left of `[data-testid="match-save"]` inside `.pl-tail`. Clicking `Reset` reverts all pause overrides (and restores the pure replay frame at `sec`).
2. **Tablet & Phone (`.phone .pl-bar` in `Player.tsx:582-649` & `transport.css:202-275`):**
   - Today on phone, `.phone .pl-bar:has(.p-rail) .pl-tail` is `display: none` (`transport.css:270`), and `[data-testid="match-save"]` is hidden (`<Show when={!p.phone()}>` at `Player.tsx:603`), meaning phone editors had no button to save a scene from Player!
   - **While paused on phone with `state.canEdit()`:**
     - Inside `.p-rail` (`Player.tsx:635`, the bottom drawer row when `Draw` / `Edit` is active on phone) AND in `.pl-tail` when `!rail()` and `hasPauseEdits()` is `true`:
       - Render the compact **`Save as scene`** button (`data-testid="match-save"`, `class="btn small"`, `classList={{ dirty: hasPauseEntityOverrides() }}`) and, when `hasPauseEntityOverrides()` is `true`, a compact **`Reset`** icon/text button (`data-testid="match-reset"`).
     - Both buttons sit inline inside the existing 32px transport row / `.p-rail` row, keeping `.phone .pl-bar` strictly within its `104 px` portrait (`60 px` landscape) height budget with **zero vertical overflow**.

---

## 4. `Save as scene`, Resume (`Space`), Scrub, & Multi-User Edge Cases

### 4.1 `Save as scene` Fold (`web/src/match/save.ts` & `Player.tsx:113`)

When the user clicks **`Save as scene`** (`saveOne` in `Player.tsx:113`):
1. Pass the composite `pausedMapState()` (or `liveScene` overrides) into `matchSceneOps` (`web/src/match/save.ts:138`):
   - **Players:** For each of the 12 slots, write the composite `placed`, `pos`, `alive`, `ult_cooldown`, `souls`, `respawn`, and `more` (`hero`, `name`, `unseen`, `build`) from `fromPausedPlayer` into the newly created `PlayerState` records.
   - **Objectives & Health:** Write the composite objective statuses (`Active` / `Stage2` / `Destroyed`) into the new scene's `ObjectiveState` records, and the composite `obj_health` triples into `SceneState.more.obj_health` (`has_obj_health: true`).
   - **Camps & Rifts:** Write the XOR-merged `camps` and `rifts` arrays into the new scene's `SceneState.more`.
   - **Wave splits:** Write the composite `laneSplit` (`liveWave.split ?? matchSplit`) into the new scene's 4 `Wave` records.
   - **Doorman doorways:** Write the composite `doors` into `SceneState.more.doors` (`has_doors: true`).
2. Append `takeAnnotationsOps(state, liveSceneId, newSceneId)` (moving any live `Stroke`, `Arrow`, and `Callout` records to the new scene) and `clearPauseOverridesOps(state, boardId, matchId)` into the **same `Op[]` batch**.
3. Commit via `state.edit(ops)` and switch the board to the newly saved scene (or update the existing linked scene if `saveOne` updated `found` in place, while keeping the toast `"Saved <label>"` with `"View →"`).

### 4.2 Discard on Resume (`Space` / Play) & Scrub

1. **Pressing Play (`Space` or `.pl-play` button):**
   - In `Player.tsx` (`control.toggle` / `control.play`): before setting `playing: true`, if `hasPauseEntityOverrides()` is `true`:
     - Call `state.editSilent(clearPauseOverridesOps(state, boardId, matchId))` (and clear any open `obj-menu` / `hero-menu` / `placingDoor`).
     - Playback resumes immediately from the authoritative match timeline at `sec`.
     - per Decision **D1**, live ink (`Stroke`, `Arrow`, `Callout`) remains visible on the map until cleared with `C` or saved.
2. **Scrubbing / Seeking while paused (`control.seek` / `control.step`):**
   - When `sec` changes via timeline scrub, event pip click, or `←`/`→` step while `hasPauseEntityOverrides()` is `true`, call `state.editSilent(clearPauseOverridesOps(state, boardId, matchId))` so overrides made at `t₁` do not corrupt the view of `t₂`.

### 4.3 Multi-Editor, Presenter Follow, Viewers, & Reload/Leave

1. **Two editors in Player simultaneously:**
   - **Both paused at the same timestamp (e.g. Coach B is following Coach A, or both paused independently):**
     - Because `liveScene` is a shared CRDT entity in `BoardState`, both coaches see each other's token drags (`Presence.drag`), objective toggles, `#55` health scrubs, wave split drags, and doorway placements in real time.
     - What if Coach A is following Coach B and Coach A drags a hero token or toggles an objective? Mutating the shared board is a collaborative edit, **not** a camera/view-state divergence — so Coach A stays following Coach B while both collaborate on the paused frame!
   - **Coach A pauses and edits while Coach B is actively playing (not following Coach A):**
     - `fromPausedPlayer` is only layered when `!player.playback().playing`. While Coach B's local player is running (`playing === true`), Coach B's `activeMapState()` reads pure `fromPlayer(...)` so Coach A's paused scratch edits never cause Coach B's running replay tokens to teleport. The moment Coach A presses Play (or saves a scene), `clearPauseOverridesOps` resets `liveScene`.
2. **Viewers (read-only connections, `state.canEdit() === false`):**
   - `pausedEditable()` is `false` whenever `!state.canEdit()`. Viewers never get editing interactions when they pause locally, and the server rejects any write ops from read-only tokens (`crates/server`).
   - However, because `activeMapState()` layers `fromPausedPlayer` whenever `!player.playback().playing`, a viewer who is **following a paused presenter** automatically sees every token move, objective toggle, health adjustment, and doorway placement the presenter makes while paused!
3. **Reload / Leaving Player (switching to a Scene tab) while paused with unsaved edits:**
   - Switching from Player to a Scene tab (and back to Player at the same paused timestamp) preserves `liveScene` in `BoardState`, so the coach does not lose their paused adjustments just by peeking at a Scene tab.
   - Reloading the page starts Player paused at `0:00` (or the URL timestamp); if stale `liveScene` entity overrides exist from a disconnected session while `playing === false`, `Player.tsx` clears them on initial mount unless a peer is actively presenting in paused Player on that match.

---

## 5. View-State Registry (`AGENTS.md` §8)

- All new signals in `Player.tsx` / `Board.tsx` are computed memos (`pausedEditable`, `hasPauseEntityOverrides`, `hasPauseEdits`) derived from `player.playback().playing`, `state.canEdit()`, and `BoardState` store records — no new raw `createSignal` is needed in any scanned view-state file (`web/test/view-state-ledger.ts`).
- `player.playing` and `player.sec` are already registered in `crates/engine/src/view_state.rs` (`Follow::Mirror`), so when a presenter pauses (`playing: false`), followers automatically pause at the same `sec` and see the presenter's `liveScene` pause edits.

---

## 6. Test Plan

1. **Unit Tests (`web/test/pause-edit.test.ts`):**
   - `fromPausedPlayer` layers hero position, kill (`alive: false`), revive (`alive: true, more.health: 100`), sight (`more.unseen: true | false`), souls, ult cooldown, respawn, objective status, `#55` objective health, XOR camp/rift toggles, lane wave splits, and Doorman doorways over `fromPlayer`.
   - `clearPauseOverridesOps` resets dirty `PlayerState` fields to baseline and deletes `liveScene`'s `SceneState`/`Wave`/`ObjectiveState`.
   - Re-editing after `clearPauseOverridesOps` uses `[Op::Restore, Op::Set]` on deterministic IDs (`liveSceneStateId`, `liveWaveId`, `liveObjId`), verifying **zero net tombstone increase** across repeated pause → edit → unpause cycles.
   - `matchSceneOps` folds all active pause overrides into the saved scene and resets `liveScene` in one transaction.
2. **Playwright E2E (`web/e2e/player-pause-edit.spec.ts`):**
   - **Pause & edit entities:** Load reference match `129738985`, pause playback, drag a hero token, press `K` to kill a hero, click an objective to destroy it, drag another objective's health to `50%`, and drag a lane wave split handle.
   - **Visible `"Save as scene"` & `"Reset"`:** Verify `[data-testid="match-save"]` shows dirty state (`Save as scene`) and `[data-testid="match-reset"]` appears.
   - **Resume (`Space`) clears overrides:** Press `Space` to resume playback → verify all entity overrides clear immediately and heroes/objectives resume their true replay timeline states (while a live brush stroke drawn while paused remains visible).
   - **`Save as scene` preserves edits:** Pause again, move a hero and toggle an objective, click `[data-testid="match-save"]` → switch to the newly saved scene and verify the edited hero position and objective state persisted in the scene while `liveScene` was reset.
   - **Follower sync:** With User B following Presenter A in Player, Presenter A pauses and drags a hero token and toggles a Walker → User B's viewport shows both edits live; Presenter A presses `Space` to resume → User B's viewport clears the overrides and resumes playback in sync.
   - **Phone layout check:** On a phone viewport (`390×844`), pause Player, enter `Edit`, move a hero → verify `[data-testid="match-save"]` is reachable in `.p-rail` and `.phone .pl-bar` does not overflow `104 px`.
