# Full Scene Editing While Player Is Paused (`#61`)

**Status:** Design specification (v2 — post-adversarial review) · **Issue:** `#61` ("Full scene editing while Player is paused")  
**Scope:** Local engine history helper (`crates/engine/src/replica.rs`, `crates/wasm/src/lib.rs`, `web/src/core/session.ts`, `web/src/board/state.ts`) + Web client (`web/src/player/live.ts`, `web/src/player/layer.ts`, `web/src/player/clock.ts`, `web/src/player/Player.tsx`, `web/src/player/PlayerTopBar.tsx`, `web/src/player/markerStates.ts`, `web/src/player/Doors.tsx`, `web/src/player/Camps.tsx`, `web/src/mapstate/paused.ts`, `web/src/mapstate/edit.ts`, `web/src/match/save.ts`, `web/src/board/Board.tsx`, `web/src/board/Layers.tsx`, `web/src/board/Tokens.tsx`, `web/src/board/TopBar.tsx`, `web/src/board/TopBarParts.tsx`, `web/src/board/objectives.ts`, `web/src/styles/transport.css`, `web/src/styles/board.css`, `web/test/view-state-ledger.ts`). **Zero schema, wire-protocol, or store version bump.**

> **User request (`#61`):** *"It would be nice to be able to fully edit the scene while the player is paused. Like you can in the scene editor. If changes are made, there is a visible button that lets you save that as a scene. Or you press pause, it clears all the changes and continues. Nice for when you want to make some quick adjustments, but don't really care if it saves."*

---

## 0. Open Decisions for Operator

| # | Decision | Recommended default | 1-line alternative |
|---|---|---|---|
| **D1** | **What happens to ink drawings (`Stroke`, `Arrow`, `Callout`) when pressing Play (`Space`) to resume?** | **Unpausing clears all *entity & map-state overrides* (moved heroes, killed/revived heroes, toggled objectives/camps/rifts/powerups/urns, `#55` objective health when present, wave splits, doorways, souls/ults/sight/hero swaps/renames) while *keeping live ink/arrows/comments*.** Coaches frequently pause, draw a rotation arrow, and press Play to watch the replay run against their drawing (and `Play with scene plan` relies on live ink persisting during playback). A 1-click `Reset` button (or `C` / `Shift+C` for ink) clears everything. | Unpausing clears both entity/map-state overrides and any ink/arrows/comments drawn while paused. |
| **D2** | **What happens when stepping/seeking on the timeline (`←`/`→` `±5 s`, scrubber drag, event jump) while paused with edits?** | **Any timeline seek/scrub clears entity & map-state overrides** (just like pressing Play) so stale hero positions or objective states from timestamp `t₁` never linger out-of-context at `t₂`. | Scrubbing/event-jumping clears overrides, while small `←`/`→` (`±5 s`) steps preserve non-positional overrides (objectives/doors). |

*(Note: Companion spec `#55` [`docs/specs/objective-health-edit.md`] is not yet implemented in `web/src/mapstate/edit.ts`. `#61` ships all existing Scene editor capabilities independently and shares the same frame-seeding `SceneState` contract so `#55`'s `setObjectiveHealthOps` plugs in with zero extra plumbing once `#55` lands.)*

---

## 1. Grounded Architecture Analysis: Option A vs. Option B

### 1.1 How Player Works Today

Today in `web/src/player/live.ts`, `web/src/player/layer.ts`, and `web/src/board/Board.tsx`:
- Every loaded match creates one hidden CRDT scene record `Scene { live: true, clock: null, ... }` (`idFrom("mapcro-live:${board}:${matchId}")`, `live.ts:50`) plus 12 deterministic `PlayerState` records (`idFrom("mapcro-live:${board}:${matchId}:${slot.id}")`, `live.ts:51-53`).
- While in Player (`inPlayer() === true`):
  - `mapState()` returns `matchState` (`fromTimeline(...)`, `Board.tsx:265, 625`), which has no stored entity mutations (`marker(key).status()` is always `undefined`, `state.ts:240`).
  - `annScene()` returns `liveScene()` (`Board.tsx:268`), so `Draw` (`E`), `Arrow` (`A`), `Comment` (`S`), and `Erase` (`D`) write `Stroke`, `Arrow`, and `Callout` records attached to `liveScene()`. (Toolbar keys in `web/src/board/tools.ts:9-16` are `Q` Select, `W` Laser, `E` Draw, `A` Arrow, `S` Comment, `D` Erase, `C` Clear menu, `Shift+C` Clear all.)
  - `Tokens.tsx` gates editing on `!live()` (`Tokens.tsx:154`, where `live() = p.frame.player()`) and receives `tokenScene={scene()?.id}` (`Board.tsx:1546`); `Layers.tsx`, `Board.tsx`, `Doors.tsx`, and `markerStates.ts` gate entity mutations and status overrides on `!inPlayer()` / `!p.frame.player()`.

### 1.2 Comparing the Two Candidate Architectures

| Dimension | **Option A: Timestamp-Scoped `liveScene` CRDT Override Layer (`fromPausedPlayer`) — RECOMMENDED** | **Option B: Ephemeral Local Signal Overlay + `Presence` Diff** |
|---|---|---|
| **How edits are stored** | Reuses `liveScene` (`Scene { live: true }`), its existing `Scene.clock` (`records.rs:78`) as the pause-timestamp scope, its 12 deterministic `PlayerState` records, and deterministic `SceneState` / `Wave` / `ObjectiveState` records on `liveScene`. `fromPausedPlayer(base, live)` layers overrides over `fromTimeline(...)` only while paused at `liveScene.clock`. | Holds a local Solid signal `pauseDiff` in `Player.tsx` and broadcasts serialized diff blobs inside presence frames (`PRESENCE_MS = 60 ms`). |
| **Code reuse with Scene Editor** | **~100% reuse.** Every existing op generator (`objectives.ts`, `edit.ts` `writeDoorsOps`, `#55` `setObjectiveHealthOps`, `Tokens.tsx`, `Layers.tsx`, `UltRing`) writes standard `BoardState` ops against `liveScene()`. | **Duplicates every mutation path.** Requires a parallel in-memory reducer for heroes, objectives, health, camps, rifts, waves, doors, souls, ults, and sight. |
| **Multi-editor & Follower sync** | **Native CRDT sync.** Two coaches paused at the same second collaborate live (`Presence.drag` + `Op::SetIf`), followers see every edit immediately, and `liveScene.clock` isolates coaches paused at *different* timestamps from each other. | Breaks when two coaches edit simultaneously (last writer overwrites the entire `Presence` diff); bloats every cursor `Presence` packet. |
| **Undo / Redo (`Ctrl+Z` / `Ctrl+Y`)** | **Works out of the box** via `Replica::undo()` / `redo()` (`crates/engine/src/replica.rs`). Resuming playback calls `editSilent(clearPauseOverridesOps(...))` **and** `dropHistoryFor(liveEntityIds)` so stale pause-entity steps are stripped from both `undo` and `redo` while live-ink undo (D1) and real-scene undo remain intact. | Requires building a separate client-only undo/redo stack and coordinating it with `BoardState.undo()` for strokes/arrows/callouts drawn in the same pause session. |
| **`Save as scene` conversion** | `matchSceneOps` (`web/src/match/save.ts`) accepts an optional `PauseOverrides` struct, composites overrides (including `PlayerState.more` merge and forced `has_*` flags), moves live annotations via chunked `takeAnnotationsOps`, and silently clears `liveScene` entity overrides — staying strictly under `LIMITS.max_ops_per_tx = 256` and `LIMITS.max_tx_bytes = 64 KiB`. | Must translate custom diff structs back into schema records at save time. |
| **Record & Tombstone Budget (`LIMITS.max_records = 5000`)** | **Zero unbounded tombstone growth** by using deterministic `RecordId`s (`idFrom(...)`) and tombstone-aware `[Op::Restore, Op::Set...]` (`crates/schema/src/validate.rs:476-483`) for `SceneState` / `Wave` / `ObjectiveState` on `liveScene`. | Zero store records, at the cost of no CRDT or undo integration. |

**Decision:** Adopt **Option A**.

---

## 2. Option A Detailed Design: Timestamp Scoping, Sparse Overrides, & Zero-Tombstone Lifecycle

### 2.1 `Scene.clock` Timestamp Scoping (`B6` — Multi-Editor Isolation)

`Scene` already carries `pub clock: Option<u32>` and `FieldValue::SceneClock(Option<u32>)` (`crates/schema/src/records.rs:78, 335`, bounded `0..=14400` in `crates/schema/src/validate.rs:252`), and `ensureLiveOps` already initializes `liveScene` with `clock: null` (`web/src/player/live.ts:50`).

Define the canonical pause clock key matching presence's 2-decimal `t` precision (`web/src/player/host.ts:900`):
```ts
/** Canonical integer second for pause-edit scoping, bounded to `SceneClock`'s schema limit (0..14400). */
export const pauseClock = (t: number): number =>
  Math.min(4 * 3600, Math.max(0, Math.round(Math.round(t * 100) / 100)));
```

**Scoping rules:**
1. **Stamping on write:** Every transaction that writes a pause-edit entity override onto `liveScene` stamps `{ Set: { id: liveSceneId, value: { SceneClock: pauseClock(sec) } } }` in the same transaction (when `liveScene.clock !== pauseClock(sec)`).
   - If another coach already left overrides on `liveScene` at a *different* timestamp (`liveScene.clock != null && liveScene.clock !== pauseClock(sec)`), the new editor's first pause edit silently clears the other timestamp's overrides first (`clearPauseOverridesOps`) before applying their edit and stamping `SceneClock: pauseClock(sec)`, so overrides from two different match moments never mix.
2. **Reading in `fromPausedPlayer`:** `fromPausedPlayer` layers `liveScene` entity overrides over `fromTimeline(...)` **if and only if**:
   ```ts
   !player.playback().playing && liveSceneRecord?.clock === pauseClock(player.t())
   ```
   - While playing (`playing === true`), or while paused at a different timestamp (`liveScene.clock !== pauseClock(sec)`), `fromPausedPlayer` passes through `fromTimeline(...)` untouched.
   - **Follower alignment (`web/src/player/clock.ts:48`):** Today `follow()` suppresses updates within `slack = 0.75 s` even when `!theirs.playing`, which could leave an already-paused follower `0.4 s` away on a different rounded second. Update `follow()` so that when `!theirs.playing`, updates snap whenever `Math.abs(here - there) >= 0.01`, guaranteeing every follower of a paused presenter shares the exact same `pauseClock(t)` and sees every pause edit live.
3. **Guarded clearing on Play / Scrub:** `clearPauseOverridesOps` always sets `SceneClock: null` on `liveScene`. Crucially, pressing **Play** or **scrubbing/seeking** only runs `clearPauseOverridesOps` when **`liveSceneRecord?.clock === pauseClock(prevSec)`**!
   - Thus, if Coach A is actively pause-editing at `10:00` (`liveScene.clock === 600`) and independent Coach B is paused at `25:00` (`1500`):
     - Coach B sees pure `25:00` timeline state (no bleeding and no false dirty indicator).
     - When Coach B presses Play or scrubs from `25:00`, `600 !== 1500` so Coach B does **not** wipe Coach A's active `10:00` pause edits.

---

### 2.2 `liveScene` `PlayerState` Baseline & Legacy Migration (`B1`)

Today `ensureLiveOps` (`web/src/player/live.ts:52`) creates `liveScene`'s 12 `PlayerState` records with **`placed: true, pos: { x: 0, y: 0 }`**, NOT `placed: false`:
```ts
// Current web/src/player/live.ts:52
{ PlayerState: { scene: ids.scene, slot, pos: { x: 0, y: 0 }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true } }
```

**Changes in `web/src/player/live.ts`:**
1. **Update `ensureLiveOps` (`live.ts:52`):** Create new `liveScene` `PlayerState` records with neutral baseline **`placed: false`** (`pos: { x: 0, y: 0 }, alive: true, placed: false, souls: null, ult_cooldown: null, visible: true`; `respawn` omitted/`null`, `more` omitted/`{}`).
   - Verified: `isLiveLayerCreate` (`live.ts:93-109`) checks only `scene.live`, `scene.source`, `sceneId`, and `PlayerState` `scene`/`id` — it does not depend on `placed`, so reload recovery (TD-35) stays intact.
2. **Legacy live scenes compatibility:** Existing boards already persisted on prod hold `liveScene` `PlayerState` records with `placed: true, pos: { x: 0, y: 0 }` and `liveScene.clock === null`.
   - Define `hasMoreKeys(more?: More): boolean => Object.keys(more ?? {}).length > 0` (never `more != null`, because clearing all keys from `More` leaves `{}`).
   - Define `isBaselinePlayerState(ps: PlayerState, liveClock: number | null): boolean`:
     - Standard baseline: `!ps.placed && ps.alive && ps.souls == null && ps.ult_cooldown == null && ps.visible && ps.respawn == null && !hasMoreKeys(ps.more)`.
     - Legacy untouched record: `liveClock === null && ps.placed && ps.pos.x === 0 && ps.pos.y === 0 && ps.alive && ps.souls == null && ps.ult_cooldown == null && ps.visible && ps.respawn == null && !hasMoreKeys(ps.more)`.
   - **One-time silent normalization (`normalizeLegacyLiveOps`):** Before applying the first pause-edit entity mutation on a `liveScene` where `liveClock === null` and any untouched legacy `PlayerState` still has `placed: true, pos: { x: 0, y: 0 }`, emit a silent `state.editSilent(...)` setting `PlayerPlaced: false` on those untouched legacy records (or include those resets inside `ensureLiveOps` when `liveClock === null`). Once normalized, even dragging a hero onto exact world `{ x: 0, y: 0 }` while paused (`liveClock != null`) is unambiguously distinguished as an active override.

---

### 2.3 Deterministic IDs, Tombstone-Aware `Op::Restore`, & Random-ID Writers (`B3`)

Schema facts verified against `crates/schema/src/`:
- `Entry` (`crates/schema/src/doc.rs:10-13`) is `{ record: Record, deleted: bool }` (there is no `Record::Tombstone` variant; on the client check `state.records[id]?.deleted === true`).
- `Wave` (`crates/schema/src/records.rs:178-189`) is `{ scene: RecordId, lane: LaneKey, t: u16, more: More }` where `LaneKey` is a string (`"lane1"`, `"lane4"`, `"lane6"`, `crates/schema/src/ids.rs:65-75`) and field write is `FieldValue::WavePos(u16)` (`records.rs:351`).
- Whole-board invariants (`crates/schema/src/validate.rs:546-560`) enforce at most **one live** `ObjectiveState` per `(scene, key)`, **one live** `Wave` per `(scene, lane)`, and **one live** `SceneState` per `scene` (`Reject::Duplicate`).
- `Op::Create` on an existing live or tombstoned ID is refused with `Reject::IdTaken` (`validate.rs:416-418`).
- `Op::Set` / `Op::SetIf` on a deleted record returns `OpOutcome::Skipped` (`validate.rs:433-435, 449-451`), while `Op::Restore` clears `deleted = false` (`validate.rs:476-483`) and **preserves the previous fields** stored on the tombstoned record (`doc.rs:6-7`). Therefore **`Op::Restore { id }` MUST strictly precede any `Op::Set` / `Op::SetIf` on that `id` in the same transaction**, and restored records must explicitly overwrite or clear stale fields!

#### Deterministic ID Helpers (`web/src/player/live.ts`)
```ts
export const liveSceneStateId = (board: string, match: number): RecordId =>
  idFrom(`mapcro-live:${board}:${match}:state`);
export const liveWaveId = (board: string, match: number, lane: string): RecordId =>
  idFrom(`mapcro-live:${board}:${match}:wave:${lane}`);
export const liveObjId = (board: string, match: number, key: string): RecordId =>
  idFrom(`mapcro-live:${board}:${match}:obj:${key}`);
```

#### Unified Upsert Strategy Across All Existing Entity Writers
Existing writers (`objectives.ts:39,76`, `Layers.tsx:401,428`, `edit.ts:146`, and `#55`'s `writeObjHealthOps`) currently call random `mint()` (`newRecordId()`). Mixing random live IDs with deterministic IDs would trigger `Reject::Duplicate` (`validate.rs:546-560`) or leak unbounded tombstones toward `LIMITS.max_records = 5000`.

Every entity writer targeting `liveScene` uses a shared deterministic resolver:
1. **Live legacy-record fallback first:** Check `state.inScene(kind, liveScene)` for any already-live record matching the key/lane/scene. If one exists (even with a random ID from an older build or peer), mutate it in place via `Op::Set` / `Op::SetIf`. (`clearPauseOverridesOps` deletes *all* live `SceneState`/`Wave`/`ObjectiveState` records on `liveScene` regardless of ID, so any legacy random-ID record is retired cleanly on the next clear.)
2. **Deterministic tombstone check (`records[detId]?.deleted === true`):** Emit `[Op::Restore { id: detId }, ...setOps]` (strictly `Restore` **before** `Set`/`SetIf`!).
   - For `ObjectiveState`: `[Op::Restore { id: detId }, Op::Set { id: detId, value: { ObjectiveStatus: status } }]`.
   - For `Wave`: `[Op::Restore { id: detId }, Op::Set { id: detId, value: { WavePos: t } }, ...edgesClearOrSet]`.
   - For `SceneState`: `[Op::Restore { id: detId }, ...clearStaleMoreKeys, ...writeNewMoreKeys]` (clears first, matching `validate.rs:436` per-op `max_more_bytes` enforcement).
3. **Absent record (`!records[detId]`):** Emit `Op::Create { id: detId, record: ... }`.

**Concrete writer wiring:**
- **`web/src/board/objectives.ts` (`toggleOps` `:27-48`, `groupToggleOps` `:58-93`):** Accept an optional `upsert?: (key: string, status: ObjectiveStatus) => Op[]` (defaulting to the existing random `mint()` `Create` for real scenes). When targeting `liveScene`, `Layers.tsx` passes a live-scene `upsert` using `liveObjId(board, matchId, key)` + tombstone check.
- **`web/src/board/Layers.tsx` (`dragWave` `:394-431`):** When targeting `liveScene`, resolve `id = existing?.id ?? liveWaveId(board, matchId, key)` (used for both `presence({ drag: { id, ... } })` and commit), emitting `[Op::Restore { id }, Op::Set { id, value: { WavePos: d.t } }]` if `records[id]?.deleted`, `Op::Set` if live, or `Op::Create` if absent (always accompanied by `SceneClock`).
- **`web/src/mapstate/edit.ts` (`SceneDoorContext` `:66-71`, `writeDoorsOps` `:135-205`, and `#55` `writeObjHealthOps`):** Support deterministic `liveSceneStateId` via `ensurePausedSceneStateOps` (see §2.5 below), which ensures/restores and frame-seeds `liveScene`'s `SceneState` before mutating it!

**Tombstone bound:** Across 1,000 pause → edit → unpause cycles on a match, `liveScene` allocates **at most** `1` `SceneState`, `≤4` `Wave`s (`lane1`/`lane4`/`lane6`), and `≤70` `ObjectiveState`s (bounded by static map markers) — **zero unbounded tombstone growth**.

---

### 2.4 Sparse Field Overrides on the 12 `liveScene` `PlayerState` Records (`B7`)

While paused (`!playing && liveScene.clock === pauseClock(sec)`), each field on `liveScene`'s 12 `PlayerState` records (`crates/schema/src/records.rs:110-139`) acts as a sparse override over `baseHero = fromTimeline(...).hero(slot)`:

| Hero Property | Baseline (Unedited on `liveScene`) | Override Active Condition | How `fromPausedPlayer` Resolves Value | Exact Ops Emitted by Editor (`+ SceneClock` if unset) |
|---|---|---|---|---|
| **Position (`pos` / `last`)** | `rec.placed === false` | `rec.placed === true` | When `rec.placed`: `rec.pos` (when alive: both `pos` and `last`; when dead: `pos = null`, `last = rec.pos`); else `baseHero.pos()` / `baseHero.last()`. | `Tokens.tsx` drag release: `PlayerPlaced: true`, `PlayerPos: clampToDisc(...)`. Drag starts from composite `h().pos() ?? h().last() ?? pl.state.pos`, never raw `{0,0}`! |
| **Life (`alive`)** | `rec.alive === true && rec.more?.health === undefined` | `rec.alive === false` (killed while paused) **or** `rec.more?.health === 100` (revived while paused) | If `!rec.alive` → `false`; else if `rec.more?.health === 100` → `true`; else `baseHero.alive()`. | **`pauseKillOps`:** `PlayerAlive: false`, `PlayerPlaced: true`, `PlayerPos: curPos`, `More: { key: "health", value: null }` (if set).<br>**`pauseReviveOps`:** `PlayerAlive: true` (if false), `PlayerPlaced: true`, `PlayerPos: atPos`, `PlayerRespawn: null` (if set), `More: { key: "health", value: 100 }`. |
| **Health (`health`)** | `rec.more?.health === undefined` | `!rec.alive` or `rec.more?.health === 100` | If killed while paused → `0`; if revived while paused → `100`; else `baseHero.health()`. | Written by `pauseKillOps` / `pauseReviveOps` above. *(Never writes `rows` on `PlayerState.more`: `rows` is `Entity::Scene` only — `validate.rs:312`, `map_state.rs:96`.)* |
| **Respawn (`respawn`)** | `rec.respawn == null` | `rec.respawn != null` (or cleared on revive) | If revived while paused → `null`; if killed while paused → `rec.respawn ?? null`; else `rec.respawn ?? baseHero.respawn()`. | Clicking `.respawn-label` on a dead token (`Tokens.tsx:546-579`) opens `.respawn-input` (`m:ss`) and commits `PlayerRespawn: s` (`0..=600`, `validate.rs:256`). |
| **Sight (`inSight`)** | `rec.more?.unseen === undefined` | `typeof rec.more?.unseen === "boolean"` | If `rec.more?.unseen === true` → `false` (unseen); if `rec.more?.unseen === false` → `true` (forced in-vision over replay FOW); else `baseHero.inSight()`. *(When overridden, `lastSeen()` returns `null`.)* | Clicking `.tb-vis` or `hero-menu` (`Mark not seen` / `Mark in vision`) writes `More: { key: "unseen", value: currentlyInSight }` (`Kind::Bool`, `map_state.rs:125`). |
| **Ult cooldown (`ult`)** | `rec.ult_cooldown == null` | `rec.ult_cooldown != null` | `rec.ult_cooldown ?? baseHero.ult()`. | `UltRing` drag/wheel/click in `PlayerTopBar` writes `PlayerUltCooldown: pct` (`0..=100` percent, `records.rs:341`, `validate.rs:254`). |
| **Souls (`souls`)** | `rec.souls == null` | `rec.souls != null` | `rec.souls ?? baseHero.souls()`. | `Set souls…` in `hero-menu` or double-clicking `.tb-souls` writes `PlayerSouls: val` (`0..=1_000_000`, `records.rs:340`, `validate.rs:253`). |
| **Hero swap / Rename** | `rec.more?.hero === undefined`, `rec.more?.name === undefined` | Defined on `rec.more` | `typeof rec.more?.hero === "number" ? rec.more.hero : baseHero.hero()`; `typeof rec.more?.name === "string" ? rec.more.name : baseHero.name()`. | `Change hero…` / `Rename…` in `hero-menu` write `More: { key: "hero", value: heroId }` / `More: { key: "name", value: text }` (`map_state.rs:92-93`) on `liveScene` — never mutating the board's `RosterSlot`! |

---

### 2.5 Map, Objective, Wave, & `SceneState` Frame-Seeding Overrides (`B4`, `B8`)

Schema facts verified against `crates/schema/src/map_state.rs:137-152` and `web/src/mapstate/codec.ts:157-546`:
- `camps` (row `28`, flag `has_camps` row `27`) is a **stride-3 absolute list** `[fnv1a32(key), code (1=cleared | 2=unspawned), secondsLeft]`.
- `obj_health` (row `32`, flag `has_obj_health` row `31`) is a **stride-3 absolute list** `[fnv1a32(key), pct, stage]`.
- `rift` (**singular**, row `34`, flag `has_rifts` row `33`) is a **fixed 8-int record** `[open, siteHash, giveUpIn, amberPct, sapphirePct, capturedCode, nextIn, nextSiteHash]`.
- `doors` (row `41`, flag `has_doors` row `40`) is a **stride-6 absolute list** `[teamCode, x, y, roleCode, partnerIdx, unseenInt]`.
- **None of these are XOR delta lists.** Attempting XOR encoding on `camps` or `rift` violates the codec and schema bounds.

#### How Every Map-Level Edit Works While Paused

1. **1-Click Toggles for Objectives, Mid-Boss, Camps, Rifts, Powerups, & Urn Sites (`ObjectiveState`):**
   - Just like in Scene mode (`web/src/board/objectives.ts:27-93` `toggleOps` / `groupToggleOps`, `web/src/board/Layers.tsx:362-380`), clicking any non-furniture marker (`t1`, `t2`, `t3`, `barracks`, `shrine`, `midboss`, `camp`, `koth`, `powerup`, `urn`) writes deterministic `ObjectiveState` records (`liveObjId(board, matchId, key)`) with `status: "Active" | "Stage2" | "Destroyed"`.
   - `toggleOps` / `groupToggleOps` already accept `shown?: ShownStatus` (`p.markerStatus`), so the first click computes the exact next state from the replay frame's effective status (e.g., clicking a destroyed Walker creates/restores `ObjectiveState: "Active"`; clicking a Stage 2 Patron cycles it to `"Destroyed"`; clicking an inactive Rift activates it and marks other active Rifts `"Destroyed"`).
   - In `fromPausedPlayer`, `marker(key).status()` returns `liveObjectives.get(key)?.status`, and `marker(key).down()` returns `own !== undefined ? own === "Destroyed" : base.marker(key).down()`.
   - **`markerStates.ts` (`B8`):** Today `web/src/player/markerStates.ts:28-51` ignores `m.status()` whenever `frame.player()` is `true`! Update `statusNow` so that **before** falling through to Player's computed `site()` / `down()` / `health()?.stage`, it checks `const own = m.status(); if (own !== undefined) return own;`. Because `fromTimeline` always returns `status: () => undefined` (`state.ts:240`), playing frames behave byte-for-byte identically, while paused `ObjectiveState` overrides immediately control `MapView` icons, `marks.health`, `marks.camp` (`effectiveCamp`), `marks.buff` (`effectivePowerup`), and `Camps.tsx` `tipFacts` (`effectiveCamp`/`effectiveRift`/`effectivePowerup`/`effectiveUrn`)!
   - When a Guardian (`t1`) is revived or destroyed via `ObjectiveState` while paused, `fromPausedPlayer` also recomputes `marker(key).shopClosed()` via `shopsClosed(effectiveDown, markers)` so lane shops open/close with their guardian.

2. **Frame-Seeding on First `SceneState.more` Edit (`doors`, `#55` `obj_health`, or direct `camps`/`rift` writes) (`B4`):**
   - When the user performs the **first** edit to a `SceneState.more` feature `F` (`doors`, `obj_health`, and if ever mutated directly on `SceneState`, `camps` or `rift`) during a pause at `sec`:
     1. Check `liveCap = captured(liveSceneState?.more)` (`web/src/mapstate/keys.ts:72-92`, which requires both `more[has_F] === true` **and** `ROWS[lastRow].index < more.rows`).
     2. If `!liveCap[F]` (feature `F` has not been seeded yet for this pause session), compute the current replay frame's encoded payload for `F` at `sec` using the **existing `web/src/mapstate/codec.ts` encoders** (exact same encoding as `captureFrameData` in `web/src/match/save.ts:128-243`):
        - `doors`: `encodeDoors(tenthPart(tl, sec).doors)` with `has_doors: true` and `rows >= ROWS.doors.index + 1` (`42`).
        - `obj_health` (for `#55`): `encodeObjHealth(secPart.health ?? new Map(), markers, secPart.down)` with `has_obj_health: true` and `rows >= ROWS.obj_health.index + 1` (`33`).
        - `camps` / `rift` (if mutated directly via `SceneState`): `encodeCamps(secPart.camps, sec, markers)` (`rows >= 29`) / `encodeRift(rifts, sec, markers, announcedKey)` (`rows >= 35`).
     3. Apply the user's mutation directly onto that seeded in-memory data (e.g., `placeDoorwayOps` / `moveDoorOps` / `removeDoorwayOps` / `toggleDoorSightOps` / `setObjectiveHealthOps`) and emit it against `liveSceneStateId(board, matchId)` in **one atomic transaction**:
        - If `!records[detStateId]`, first run `state.ensure([{ Create: { id: detStateId, record: { SceneState: { scene: liveId, more: {} } } } }])` (see §4.4 concurrent race safety).
        - Then emit `state.edit([SceneClock, Op::Restore { id: detStateId } (if deleted), ...dormantFlagAndStaleKeyClears, ...writeOps])`.
     4. After that single write, `liveScene`'s `SceneState.more` holds the complete authoritative array for feature `F` with `has_F: true` and `rows >= ROWS[lastRow].index + 1` — **identical to a real Scene**. Every subsequent doorway drag/link/unlink/sight/erase or `#55` health drag calls `writeDoorsOps` / `setObjectiveHealthOps` unmodified!
   - **Reading in `fromPausedPlayer`:**
     - `scene().doors()`: if `liveCap.doors` → `decodeDoors(liveState.more.doors)`; else `base.scene().doors()`.
     - `marker(key).health()`: if `liveCap.obj_health` → resolve from `decodeObjHealth(liveState.more.obj_health, markers)` (with `down()` check); else if `marker(key).status() === "Active"` revived a destroyed objective → `{ pct: 100 }`; else `base.marker(key).health()`.
     - `marker(key).camp()` / `marker(key).rift()`: if `liveCap.camps` / `liveCap.rifts` → decode from `liveState.more.camps` / `liveState.more.rift`; else pass through `base` (where `ObjectiveState.status` overrides via `effectiveCamp` / `effectiveRift` in `Camps.tsx` and `markerStates.ts`).
     - `has(feature)`: returns `base.has(feature) || liveCap[feature]` (and for `"sight"`, also `true` if any `liveScene` `PlayerState` has `typeof more?.unseen === "boolean"`), so `MapControls` (`Player.tsx:658-668`), `MapView`, and `DoormanDoors` activate edited features even on metadata-tier matches!

3. **Lane Zipline / Wave Splits (`Wave { scene, lane: LaneKey, t: u16 }`):**
   - While paused, dragging `.wave-hit` (`Layers.tsx:1551-1568`) or clicking a lane zipline (`Layers.tsx:986-990`) upserts `liveWaveId(board, matchId, laneKey)` (`Wave { scene: liveScene, lane: laneKey, t: d.t }`, `records.rs:178-189`) with `FieldValue::WavePos(d.t)` (`records.rs:351`) and `SceneClock`.
   - In `fromPausedPlayer`, `lane(key).split()` returns `liveWaves.get(key)?.t ?? base.lane(key).split()`, and `lane(key).edges()` shifts the timeline's edges with `shiftEdges(baseEdges, split)` (`web/src/map/lanes.ts:113-121`, 2-arg signature `shiftEdges(edges, split)`) whenever a `liveScene` `Wave` override exists!
   - In `Board.tsx:881-908`, `laneEdges` and `splitOf` check `waveDrag()`, `remoteSmooth()` (when paused), and `mapState().lane(key)` so local and remote wave drags move the zipline border smoothly while paused.

---

### 2.6 Resetting Overrides (`clearPauseOverridesOps`) & Stripping Undo/Redo History (`B2`)

#### Why `editSilent` Alone Is Broken (`B2`)
In `crates/engine/src/replica.rs:185-192`, `Replica::edit_silent` intentionally preserves **both** `self.undo` and `self.redo` (`HistoryEntry { cseq: u64, inverse: Vec<Op> }` at `replica.rs:38-41`). If Play/Scrub only calls `state.editSilent(clearPauseOverridesOps(...))`:
- Pressing `Ctrl+Z` after unpausing pops stale pause-edit entries off `self.undo` (silently skipping or resurrecting tombstoned `ObjectiveState`/`Wave`/`SceneState` records via `Op::Restore`!).
- Pressing `Ctrl+Y` after undoing a pause edit and then pressing Play resurrects cleared pause overrides!

#### Minimal Engine + WASM + Session History Pruner (Zero Wire / Schema Change)
1. **`crates/engine/src/replica.rs`:** Add one method to `Replica`:
   ```rust
   /// Remove local undo and redo entries whose inverse touches any record in `records`
   /// (e.g., ephemeral `liveScene` entity overrides cleared on Play or Scrub).
   /// Purely local to this replica's history stacks; sends nothing on the wire.
   pub fn drop_history_for(&mut self, records: &[RecordId]) {
       if records.is_empty() {
           return;
       }
       let targets: std::collections::BTreeSet<RecordId> = records.iter().copied().collect();
       let keep = |e: &HistoryEntry| !e.inverse.iter().any(|op| targets.contains(&op_target(op)));
       self.undo.retain(keep);
       self.redo.retain(keep);
   }
   ```
   - Uses existing `mapcro_schema::op_target` (`crates/schema/src/lib.rs:100-104`).
   - Preserves **all** undo/redo entries for live ink (`Stroke`, `Arrow`, `Callout`) on `liveScene` (matching **D1**) AND all undo/redo entries on real scenes!
   - Works seamlessly with session-wide `UndoHistory` (`web/src/session/history.ts:87-97`), whose `newest(..., prune: true)` automatically skips spent board marks once `canUndo()`/`canRedo()` reflects the pruned replica stacks.
2. **`crates/wasm/src/lib.rs`:** Expose on `BoardReplica`:
   ```rust
   #[wasm_bindgen(js_name = dropHistoryFor)]
   pub fn drop_history_for(&mut self, ids_json: &str) -> Result<String, JsError> {
       let ids: Vec<RecordId> = serde_json::from_str(ids_json).map_err(js_err)?;
       self.inner.drop_history_for(&ids);
       let u = self.changes(Vec::new(), Vec::new(), None);
       serde_json::to_string(&u).map_err(js_err)
   }
   ```
3. **`web/src/core/session.ts` & `web/src/board/state.ts`:**
   - Add `dropHistoryFor(ids: RecordId[]): void` on `BoardSession`: if `!this.replica || this.ended || !ids.length`, return; call `this.apply(this.replica.dropHistoryFor(JSON.stringify(ids)))` (updating `canUndo`/`canRedo` signals) and persist via `this.saveState().catch(...)` so pruned stacks stay pruned across reload (matching `step()` at `session.ts:468`).
   - Expose `dropHistoryFor: (ids: RecordId[]) => session.dropHistoryFor(ids)` on `BoardState`.

#### `clearPauseOverridesOps` & `liveEntityRecordIds` (`web/src/player/live.ts`)
- **`liveEntityRecordIds(records, liveSceneId): RecordId[]`** collects:
  - `liveSceneId` itself (for `SceneClock` writes),
  - every record in `records` (live **or** tombstoned, so redo entries for already-deleted `ObjectiveState`/`Wave`/`SceneState` are stripped too!) whose `scene === liveSceneId` and whose kind is `PlayerState`, `SceneState`, `Wave`, or `ObjectiveState` (explicitly **excluding** `Stroke`, `Arrow`, `Callout`).
- **`clearPauseOverridesOps(records, liveSceneId): Op[][]`** (chunked to `MAX_OPS_PER_TX = 256` defensively via `chunks(...)`, though worst-case is ~196 ops):
  1. If `liveScene.clock !== null`: emit `{ Set: { id: liveSceneId, value: { SceneClock: null } } }`.
  2. For each of the 12 `PlayerState` records on `liveScene` that has any non-baseline field (`placed`, `!alive`, `ult_cooldown != null`, `souls != null`, `respawn != null`, `!visible`, or `Object.keys(more ?? {}).length > 0`):
     - Emit `Op::Set` resetting only the dirty typed fields (`PlayerPlaced: false`, `PlayerPos: { x: 0, y: 0 }`, `PlayerAlive: true`, `PlayerUltCooldown: null`, `PlayerSouls: null`, `PlayerRespawn: null`, `PlayerVisible: true`) and `{ Set: { id, value: { More: { key, value: null } } } }` for every key present in `Object.keys(ps.more ?? {})`.
  3. For every **live** `SceneState`, `Wave`, or `ObjectiveState` record belonging to `liveScene`: emit `{ Delete: { id } }`.
- **Execution modes:**
  - **On Play (`Space` / `.pl-play`), timeline seek/scrub, or after `Save as scene`:** Execute each chunk via `state.editSilent(tx)` and immediately call `state.dropHistoryFor(liveEntityRecordIds(state.records, liveSceneId))`.
  - **On explicit `Reset` button click while still paused:** Execute via `state.edit(tx)` **without** calling `dropHistoryFor`, so an accidental click on `Reset` is immediately recoverable with `Ctrl+Z`!

---

## 3. UX, Component Wiring, & Layout Specification

### 3.1 Mode Gating & Scene Routing (`Board.tsx`, `Layers.tsx`, `Tokens.tsx`, `Doors.tsx`, `markerStates.ts`) (`B7`, `B8`)

Define two reactive memos in `web/src/board/Board.tsx`:
```ts
const pausedEditable = createMemo(() =>
  inPlayer() && !player.playback().playing && state.canEdit() && !!liveScene() && (!phone() || phoneEdit()),
);
/** The scene targeted by entity edits (tokens, objectives, waves, doorways): liveScene in Player, active scene in Sandbox. */
const activeEditScene = () => (inPlayer() ? liveScene() : scene()?.id);
```
*(On desktop, `phone()` is `false`, so `pausedEditable()` activates immediately on pause for editors; on phone, `phoneEdit()` gates editing gestures so viewing/panning on touch stays protected until the user enters `Edit` mode.)*

**Exact routing changes across Board & Map components:**
1. **`Board.tsx:625` (`mapState`):**
   - Create `pausedMapState = fromPausedPlayer(matchState, state, liveScene, () => !player.playback().playing, () => pauseClock(player.t()), () => p.art.model.markers)`.
   - `const mapState = (): MapState => (inPlayer() ? pausedMapState : sceneState);`
   - Update `heroAt` (`Board.tsx:530`), `<PlayerTopBar ms={mapState()} ... />` (`Board.tsx:1286, 1790`), and `<HeroCard ms={mapState()} ... />` (`Board.tsx:1472`) to read `mapState()` instead of raw `matchState`.
2. **`Board.tsx:744-749` (`objectives`) & `Board.tsx:844-865` (`waves`, `remoteWaves`):**
   - Route `objectives` and `waves` memos to `activeEditScene()` (`inPlayer() ? liveScene() : scene()?.id`) instead of `scene()?.id`.
   - Route `remoteWaves` (`Board.tsx:857`) to compare `x.state?.scene !== activeEditScene()`.
   - Update `laneEdges` (`Board.tsx:881-899`) and `splitOf` (`Board.tsx:900-908`) so when `inPlayer()` and paused (or when `waveDrag()` / `remoteSmooth()` / a `liveScene` `Wave` exists), `laneEdges` shifts the replay edges with `shiftEdges(raw, splitOf(l.key))`.
3. **`Board.tsx:1546` (`Layers` `tokenScene`) & `Tokens.tsx`:**
   - Pass **`tokenScene={activeEditScene()}`** (`inPlayer() ? liveScene() : scene()?.id`) to `<Layers>` (`Board.tsx:1546`) — NEVER `scene()?.id` while in Player, or dragging a token while paused would mutate the hidden regular scene!
   - Extend `TokenFrame` (`Tokens.tsx:88-97`) with `pausedEdit?: () => boolean`.
   - In `Tokens.tsx:154`, update `editable()` to:
     `p.tool === "select" && (p.state.canEdit() && p.editing !== false) && (!live() || !!p.frame.pausedEdit?.())`
     (retaining the real prop name `editing`, never `readOnly`).
   - **Dragging & 1-click `HeroCard` coexistence (`Tokens.tsx:157-223`):**
     - When `live() && p.frame.pausedEdit?.()`:
       - Do not run the separate `click()` window listener alongside drag; instead handle stationary click inside drag's `up`: if `ev.type === "pointerup" && !d.moved` (pointer moved `< 6 px`), call `p.onOpen?.(slot.team.toLowerCase(), slot.slot, tok)` to open/raise `HeroCard`! (Compatible with future `#16` double-click camera tracking.)
       - Initialize drag `from` from composite frame position (`h().pos() ?? h().last() ?? pl.state.pos`), and in `touching()` (`Tokens.tsx:126-151`) fall back to composite position when `!rec.placed` so peers see smooth `Presence.drag` trails from the hero's real replay location.
       - Commit drag via `pauseMoveOps` (`SceneClock` + `PlayerPlaced: true` + `PlayerPos`).
       - `Shift+click` and marquee selection (`Layers.tsx:581-598`, updated to read composite hero positions when `pausedEdit`) work for group drags.
   - **Dead tokens & `K` hotkey while paused (`Tokens.tsx:226-261, 311, 346, 544-582`):**
     - Enable `K` hotkey when `!live() || !!p.frame.pausedEdit?.()`, dispatching `pauseKillOps` (if `h().alive()`) or `pauseReviveOps` (if `!h().alive()`).
     - When a hero is killed *while paused* (`!h().alive() && pl().state.alive === false && pl().state.placed`), render their dead `.tok.dead` token (with `.dead-badge` and clickable `.respawn` / `.respawn-label` / `.respawn-input` at `Tokens.tsx:544-582`) at `h().last()`, so the coach can drag them, set a respawn timer (`m:ss` → `PlayerRespawn`), or press `K` to revive them.
     - For heroes *already dead in the replay timeline* at `sec` (shown as `.pl-skull` on the map when recent, and `.dead` in `PlayerTopBar`), coaches can revive them by hovering their `.pl-skull` or portrait and pressing `K`, right-clicking their portrait/skull and choosing **`Revive`**, or dragging their portrait from `PlayerTopBar` onto the minimap!
4. **`Board.tsx:755-779, 1015-1038, 1525-1538`, `Layers.tsx`, `Doors.tsx`, `Camps.tsx` (Doorways & Map Entities):**
   - Replace `!inPlayer()` / `!p.frame.player()` entity-editing gates in `Board.tsx` (`startPlaceDoorway`, `clearTeamDoorways`, `placingDoor`/`dragDoor` effects, `<DoormanDoors editable={...}>`) and `Layers.tsx` (`eraseTargetAtPoint` `:261`, `sceneDoors` `:273`, `doorCtx` `:276`, `doorNearView` `:288`, `doorNearClient` `:299`, `doorMenu`/`mapMenu` `:684, 687`, `hold` `:804`, `down` `:858, 866, 892, 966, 1048`, `del` `:1140, 1169`) with `canEditEntities = !inPlayer() || pausedEditable()`.
   - Update `Layers.tsx:1045-1047` (`arrow` tool snap-to-hero) to read the composite hero position (`h().pos() ?? h().last()`) when in Player so arrows started on an unedited hero anchor at the hero's real location rather than `{0, 0}`.
   - Update `Doors.tsx:203, 299` and `Camps.tsx:227`: when `p.frame.pausedEdit?.()`, emit `data-erase-door={String(d().id)}` and pass `stored = !p.frame.player() || !!p.frame.pausedEdit?.()` to `shownDoors(...)` so unseen enemy doors show faded (editable) while paused instead of disappearing.
   - Update `HeroPicker` (`Board.tsx:1935-1948`): when `inPlayer() && pausedEditable()`, read `current` / `takenBy` from `mapState()`, pass `clearable={false}` (cannot clear a match player to empty hero), and in `onPick` write `More: { key: "hero", value: hero }` (+ `SceneClock`) onto `liveScene`'s `PlayerState` (never touching `RosterSlot`).

### 3.2 `PlayerTopBar.tsx` Editability Wiring (`B7`)

Extend `PlayerTopBar` (`web/src/player/PlayerTopBar.tsx:43-55`) with optional pause-edit props:
- `pausedEdit?: () => boolean`
- `liveScene?: () => RecordId | undefined`
- `onPickHero?: (slot: RecordId) => void`
- `bindMenu?: (open: ((player: RecordId, at: { x: number; y: number }, fromToken?: boolean) => void) | undefined) => void`
- `onPlaceDoorway?: (team: "amber" | "sapphire", fromPos?: WorldPos) => void`
- `onClearDoorways?: (team: "amber" | "sapphire") => void`
- `onDropPortrait?: (slot: Slot, pos: WorldPos) => void`

Exact controls unlocked when `canPauseEdit() === true` (`!p.compact && !!p.pausedEdit?.() && !!p.liveScene?.()`):
1. **Editable `UltRing` (`PlayerTopBar.tsx:186-188`):** Extract `UltRing` from `TopBar.tsx:50-111` into `TopBarParts.tsx` with a generic `onCommit: (pct: number | null) => void` callback. In `PlayerTopBar`, render `<UltRing editable={canPauseEdit()} left={x()?.ult ?? null} ... />` inside `<Hover testid="ult-hover">` so dragging, scrolling, or clicking commits `PlayerUltCooldown: pct` (+ `SceneClock`) on `liveScene`'s `PlayerState`; while playing or for viewers, `editable={false}` behaves identically to read-only `UltDial`.
2. **Interactive `.tb-vis` (`PlayerTopBar.tsx:147-149`):** When `canPauseEdit()`, render a `<button class={cx("tb-vis", !h.inSight() && "off")} data-testid="tb-vision" ...>` (matching `TopBar.tsx:354-368`) that commits `pauseToggleSightOps` (`More: { key: "unseen", value: h.inSight() }`). Otherwise keep the existing read-only `<span class="tb-vis off">` when unseen.
3. **Right-click `hero-menu` (`PlayerTopBar.tsx:120` + `bindMenu`):** Attach `onContextMenu` on `PortraitSlot` and bind `heroMenu` (so right-clicking a map token opens the exact same menu, matching `TopBar.tsx:240-252`). Menu items (exact §4b game wording from `TopBar.tsx:458-502`):
   - `Kill` / `Revive` (`testid="hero-menu-life"`) → `pauseKillOps` / `pauseReviveOps`
   - `Mark not seen` / `Mark in vision` (`testid="hero-menu-vision"`) → `pauseToggleSightOps`
   - `Set souls…` (`testid="hero-menu-souls"`) → opens inline souls editor on `.tb-souls-value`
   - `Rename…` (`testid="hero-menu-rename"`) → opens inline name editor writing `More.name` on `liveScene`
   - `Change hero…` (`testid="hero-menu-hero"`) → opens `HeroPicker` writing `More.hero` on `liveScene`
   - Doorman (`h.hero() === DOORMAN_HERO_ID`): `Place doorway` (`testid="hero-menu-doorway"`) and `Clear doorways` (`testid="hero-menu-clear-doors"`).
4. **Preserving `.tb-souls` (`data-testid="souls-banner"`) click behavior:** Single-clicking `.tb-souls` (`PlayerTopBar.tsx:136-144`) continues toggling `BuildColumn` so existing Player muscle memory and E2E tests stay unbroken. Double-clicking `.tb-souls` (or choosing `Set souls…` in `hero-menu`) opens an inline `InlineEdit` committing `PlayerSouls` on `liveScene`.
5. **Portrait drag-to-place / revive:** While `canPauseEdit()`, dragging (`>= 6 px`) a dead portrait from `PlayerTopBar` onto the minimap SVG converts the drop point via `clampToDisc(viewToWorld(svgPoint(svg, ev), vp))` and commits `pauseReviveOps` at that position. Stationary clicks (`< 6 px`) continue to trigger `toggleBuild(key); p.onFocus?.(t, s.slot.slot)`.

---

### 3.3 Dirty State Detection & `"Save as scene"` + `"Reset"` Controls (`M3`, `M4`)

Define two pure helpers in `web/src/player/live.ts` (consumed as `createMemo`s in `Player.tsx` / `Board.tsx`):
- **`hasPauseEntityOverrides(records, liveSceneId, playing, t)`:**
  - Returns `false` if `playing` is `true`, `!liveSceneId`, or `liveSceneRecord.clock !== pauseClock(t)`.
  - Otherwise returns `true` iff ANY of:
    1. Any of `liveScene`'s 12 `PlayerState` records is not baseline (`!isBaselinePlayerState(ps, liveSceneRecord.clock)` — checking `Object.keys(ps.more ?? {}).length > 0`, **never** `ps.more != null`),
    2. `liveScene` has a live `SceneState` with `Object.keys(ss.more ?? {}).length > 0`,
    3. `liveScene` has any live `Wave` or `ObjectiveState` record.
- **`hasPauseEdits(...)`:** `hasPauseEntityOverrides(...) || hasLiveAnnotations(...)` (where `hasLiveAnnotations` checks for any live `Stroke`, `Arrow`, or `Callout` on `liveScene`).

#### Exact Placement Across Form Factors (Zero Layout Jump, Zero Overflow)

1. **Desktop & Narrow Desktop (`.pl-tail` in `web/src/player/Player.tsx:599-609`, `web/src/styles/transport.css:127, 146-177`):**
   - Wrap the save action(s) inside `<div class="pl-save-group">` in `.pl-tail`:
     - When `hasPauseEntityOverrides()` is `true`, render a compact ghost **`Reset`** button (`data-testid="match-reset"`, `class="btn small ghost"`, `title="Reset"`) immediately to the left of `[data-testid="match-save"]`.
     - Update `[data-testid="match-save"]` label to **`Save as scene`** (from `"Save scene"`) when `hasPauseEntityOverrides()` is `true` and add class `dirty` (`classList={{ dirty: hasPauseEntityOverrides() }}`) with an accent border and a `6×6 px` `.save-dirty-dot` indicator.
   - **Narrow desktop (`@container dock (width < 480px)`, `transport.css:146-177`):** Assign `grid-area: save; display: flex; gap: 6px;` to `.pl-save-group` (instead of assigning `grid-area: save` directly to `[data-testid="match-save"]` at `transport.css:172`) so `Reset` and `Save as scene` share the `"save"` grid row cleanly without breaking grid placement!
2. **Phone & Tablet (`.phone .pl-bar` in `Board.tsx:1168-1241`, `web/src/styles/board.css:1246`, `web/src/styles/transport.css:256, 270, 300-304`):**
   - **Real CSS constraints today:**
     - `web/src/styles/board.css:1246` sets `.phone-player [data-testid=match-save] { display: none; }` (there is no `<Show when={!p.phone()}>` in `Player.tsx`).
     - `web/src/styles/transport.css:256` places `.pl-tail` into the `60 px`-wide `--clock-w` cell beside the scrubber (no room for buttons inside `.pl-tail` on phone!).
     - `web/src/styles/transport.css:270` hides `.pl-tail` altogether whenever `.p-rail` (phone Edit/Laser tool rail) is open: `.phone .pl-bar:has(.p-rail) :is(..., .pl-tail) { display: none; }`.
     - Height budgets are **`104 px`** portrait (`board.css:1223, 1256`) and **`52 px`** short landscape (`transport.css:300-304`, `board.css:1284`).
   - **Exact phone solution (zero overflow, zero clock collision):**
     - Keep `.phone-player .pl-tail [data-testid=match-save] { display: none; }` so the `60 px` clock slot in `.pl-tail` is never crowded.
     - Inside **`.p-rail`** (`Board.tsx:1170-1185`, active while `phoneEdit()` is on): when `state.canEdit() && hasPauseEdits()`, render compact **`Reset`** (`data-testid="match-reset"`, only when `hasPauseEntityOverrides()`) and **`Save`** (`data-testid="match-save"`, `aria-label="Save as scene"`, `classList={{ dirty: hasPauseEntityOverrides() }}`) pinned inside `.p-rail` beside `Done` (all `44 px` touch targets, fitting inside the single rail row).
     - Inside **`.p-more`** (`Board.tsx:1228-1239`, the `⋯` More sheet when `!rail()`): when `state.canEdit() && hasPauseEdits()`, also render **`Save as scene`** (`data-testid="phone-match-save"`) and (if `hasPauseEntityOverrides()`) **`Reset`** (`data-testid="phone-match-reset"`), and show a small dirty accent dot on `[data-testid="phone-more"]` while `!rail() && hasPauseEntityOverrides()` so edits made before tapping `Done` stay discoverable!
     - **Explicit CSS overrides in `web/src/styles/board.css`:** Scope line `1246` to `.phone-player .pl-tail [data-testid=match-save] { display: none; }` (or explicitly add `.phone-player .p-rail [data-testid=match-save] { display: inline-flex; }`) so `board.css:1246` does not hide the `.p-rail` save button.
     - **Height budget invariant:** `.phone .pl-bar` remains strictly **`<= 104 px`** in portrait and **`<= 52 px`** in short landscape (`@media (orientation: landscape) and (max-height: 500px)`).

---

## 4. `Save as scene`, Resume (`Space`), Scrub, Concurrent Races, & Multi-User Edge Cases

### 4.1 `Save as scene` Fold (`web/src/match/save.ts` & `web/src/player/Player.tsx:113-128`) (`B5`)

Extend `SceneOpts` (`web/src/match/save.ts:1068-1084`) with an optional `overrides?: PauseOverrides`:
```ts
export interface PauseOverrides {
  /** Dirty `liveScene` `PlayerState` records, keyed by roster slot `RecordId`. */
  players: ReadonlyMap<RecordId, PlayerState>;
  /** Live `ObjectiveState` overrides on `liveScene`, keyed by marker key. */
  objectives: ReadonlyMap<string, ObjectiveStatus>;
  /** Live `Wave` overrides on `liveScene`, keyed by `LaneKey` string. */
  waves: ReadonlyMap<string, { t: number; more?: More }>;
  /** Live `SceneState.more` on `liveScene` (seeded + edited map-state rows). */
  state?: More;
}
```

**Inside `matchSceneOps` (`web/src/match/save.ts:294-541`):**
1. **Players (typed fields):** For each roster slot `s`, apply overrides from `opts.overrides?.players.get(s.id)` over the timeline sample `p`:
   - `placed` / `pos`: if `ov.placed`, use `clampToMap(ov.pos)` (`placed: true`); else timeline `where`.
   - `alive`: if `!ov.alive` → `false`; else if `ov.more?.health === 100` → `true`; else timeline `alive`.
   - `respawn`: if overridden dead → `ov.respawn ?? null`; if overridden revived → `null`; else timeline `respawn`.
   - `souls` / `ult_cooldown`: `ov.souls ?? timelineSouls`, `ov.ult_cooldown ?? timelineUlt`.
2. **Players (`PlayerState.more` merge — never blind overwrite!):**
   - Today `save.ts:454` and `494` assign `heroes[idx]!.PlayerState.more = more`, which would clobber pause overrides!
   - Instead, fold pause hero `more` overrides inside `sceneBuilds` (`save.ts:548-585`, via `extraOf`, which already deducts `extraBytes` before trimming `build_order` under `LIMITS.max_more_bytes = 8192`) **and** inside the heroes-only fallback (`save.ts:512-527`):
     - **Hero swap (`ov.more?.hero` differs from `p.hero_id`):** Omit the old hero's `BUILD_KEYS` (consistent with `pickHeroOps` at `edit.ts:33-41` and `holdsBuild`) and write `{ hero: ov.more.hero, ...nonBuildMore }`.
     - **Revive health (`ov.more?.health === 100`):** Merge `health: 100` after `captureBuild` (so a dead replay hero's `null` health never erases the revive).
     - **Sight (`ov.more?.unseen`):** If `true`, write `unseen: true` (and force `fd.available.add("sight")` even on metadata tier!). If `false`, omit `unseen` (clearing a replay FOW `unseen: true` so the saved scene shows the hero in vision).
     - **Rename (`ov.more?.name`):** Merge `name` into `more`.
3. **Objectives (`ObjectiveState`):**
   - Widen `ObjEntry.status` (`save.ts:350`) from `"Active" | "Destroyed"` to `ObjectiveStatus` (supporting `"Stage2"` for Patron overrides!).
   - Overlay `opts.overrides?.objectives` onto `splitObjectives` (`save.ts:377-398`):
     - `"Destroyed"` or `"Stage2"` → emit in `mandatory` (even if covered by `camps`/`rifts`, because `ObjectiveState` overrides baseline in `fromScene`).
     - `"Active"` → remove from `frame.down`; if the marker is `offByDefault` (`koth`, `urn`) or down in baseline `camps`/`powerups`/`rifts`/`urn`, emit `{ key, status: "Active" }` in `mandatory` so `fromScene` displays it revived/lit.
4. **Seeded `SceneState.more` features (`obj_health`, `doors`, `camps`, `rift`) — including metadata tier!**
   - Today `captureFrameData` (`save.ts:198, 240`) gates `obj_health` on `feat.obj_health && sec.health` and `doors` on `feat.doors`.
   - Inspect `liveCap = captured(opts.overrides?.state)`. For every feature where `liveCap[f]` is `true` (`obj_health`, `doors`, `camps`, `rifts`), substitute the encoded payload from `opts.overrides.state` directly into `fd` AND **force `fd.available.add(f)`** even when `featuresOf(tl)[f]` is `false` (e.g., metadata-tier match or replay without Doorman)!
   - Move any user-edited pause features to the very end of `DROP_ORDER` (`save.ts:94-106`) so unedited replay features drop before user edits under tight `txBudget`.
5. **Waves (`Wave`):**
   - For each lane in `opts.overrides?.waves`, overwrite `Wave.t = ovWave.t` (preserving `Wave.more.edges` if `frame.lanes` had replay edges, or adding a new `Wave` record if `frame.lanes` had none on metadata tier).

**Multi-transaction execution in `saveOne` (`web/src/player/Player.tsx:113-128`):**
- `saveOne` continues creating a **new** scene (never mutating an existing scene in place) and keeps transactions strictly within `LIMITS.max_ops_per_tx = 256` and `LIMITS.max_tx_bytes = 64 KiB`:
  1. **Tx 1 (`p.state.edit`):** Create the new scene via `matchSceneOps(..., { source: sourceOf(m), overrides })`.
  2. **Tx 2..k (`p.state.edit`):** Move live annotations (`Stroke`, `Arrow`, `Callout`) via the existing chunked `takeAnnotationsOps` loop (`Player.tsx:119-126`).
  3. **Final silent tx (`p.state.editSilent` + `p.state.dropHistoryFor`):** If `live && hasPauseEntityOverrides()`, clear `liveScene` entity overrides via `clearPauseOverridesOps` and prune `liveEntityRecordIds` from local undo/redo history.
  4. Call `p.onSaved(id, !builds)` (`Board.tsx:484-494` `savedScene` — flips to the new scene and shows `"Saved scene N"` / `"Saved without builds"` with `"Back to replay"`).

---

### 4.2 Discard on Resume (`Space` / Play) & Scrub, Plus `Space` Precedence (`M6`)

1. **Helper `clearPausedIfMine(prevSec)` in `Player.tsx`:**
   - Only runs when `canEdit()` and `liveScene` exists with `liveSceneRecord.clock === pauseClock(prevSec)` and `hasPauseEntityOverrides(...)`.
   - Dismisses any open `hero-menu` / `door-menu` / `map-menu` / `placingDoor` / `dragDoor` / `waveDrag` / `obj-menu`.
   - Runs `for (const tx of clearPauseOverridesOps(...)) p.state.editSilent(tx)` followed by `p.state.dropHistoryFor(liveEntityRecordIds(...))`.
2. **Pressing Play (`Space` tap or `.pl-play` click):**
   - In `toggleReplay` (`Player.tsx:143-148`) and `Space` `keyup` (`Player.tsx:304-311`), when transitioning `playing: false → true`, call `clearPausedIfMine(h.t())` before `h.control.play(true)`.
   - Per **D1**, live ink (`Stroke`, `Arrow`, `Callout`) stays on the map until cleared (`C` / `Shift+C`) or saved.
3. **Scrubbing / Seeking while paused (`seekReplay` `:137-142`, arrow-key seek `:285-288`, `jumpTo` `:326-333`, `PlayerSide` `jump` `:1052-1060`, `seekMatch` `Board.tsx:553-556`):**
   - Per **D2**, whenever `h.t()` changes while paused and `pauseClock(nextT) !== pauseClock(prevT)`, call `clearPausedIfMine(prevT)` before seeking so overrides from `t₁` never leak to `t₂`.
4. **`Space` Play/Pause vs. `Space + Drag` Pan Precedence (`Player.tsx:265-325` vs `Board.tsx:794, 828-837`):**
   - `Player.tsx` captures `Space` on `keydown` (`tap = space(e) && !e.repeat`), clears `tap = false` on any `pointerdown` (capture), and toggles play/pause on `keyup` only when `tap` is still `true`.
   - `Board.tsx` sets `spaceHeld(true)` on `keydown` (bubble) and `spaceHeld(false)` on `keyup` / `blur`, enabling `Space + left-drag` pan in `Layers.tsx:845`.
   - **Guaranteed behavior while paused with edits:**
     - **Short `Space` tap (no pointer press):** `up` fires in capture phase, clears pause overrides (`clearPausedIfMine`), resumes playback (`play(true)`), and `Board.tsx`'s `keyup` resets `spaceHeld(false)`. No pan starts.
     - **`Space + drag` pan:** `pointerdown` fires `cancel()` (`tap = false`) and `Layers.tsx:845` pans the map. Releasing `Space` does **not** resume playback and **preserves** all pause edits!
     - **Active pointer drag guard:** If a hero/wave/door drag is already in progress when `Space` is pressed, ignore `Space` (`tap = false`) so releasing `Space` mid-drag does not unexpectedly discard an in-flight edit.
     - **Inline text inputs (`respawn-input`, `callout-input`, souls/rename editors):** Already excluded by `boardKeys()` (`Player.tsx:276`) and `typing(e)` (`Board.tsx:822`).

---

### 4.3 Multi-Editor, Presenter Follow, Viewers, & Reload/Leave

1. **Two editors paused at the same timestamp (e.g., following or both paused at `10:00`):**
   - Both share `liveScene` (`liveScene.clock === 600`) via CRDT ops and `Presence.drag`.
   - Collaborative board edits by a follower do **not** stop following (they are document mutations, not camera/view-state overrides).
2. **Two editors at different states or timestamps (`B6`):**
   - Coach A paused at `10:00` (`liveScene.clock === 600`), Coach B playing or paused at `25:00` (`1500`):
     - Coach B's `fromPausedPlayer` sees `playing === true` or `600 !== 1500` → renders pure timeline state with zero interference and no dirty indicator.
     - Coach B pressing Play/scrubbing at `25:00` fails the `liveScene.clock === pauseClock(prevSec)` guard → does **not** clear Coach A's `10:00` edits.
3. **Viewers (`state.canEdit() === false`):**
   - `pausedEditable()` is always `false`; the server rejects any writes from view tokens.
   - Because `fromPausedPlayer` layers overrides whenever `!playing && liveScene.clock === pauseClock(sec)` (not gated on `canEdit()`), a **viewer following a paused presenter** automatically sees every hero drag, kill/revive, objective toggle, wave drag, and doorway edit live!
4. **Tab/Scene switching & Reload (`web/src/player/layer.ts:52-75`):**
   - Switching to a Scene tab and returning (`↩ Back to m:ss`) keeps `liveScene` intact at the held paused timestamp.
   - On initial entry into Player after a reload (`liveLayer`'s existing `SETTLE_MS = 1500` alone-check in `layer.ts:52-75`), if `alone()` is true, append `clearPauseOverridesOps` alongside `clearAnnotationsOps` (skipping anything edited during this visit) to clean up abandoned overrides from a disconnected session.

---

### 4.4 Concurrent `IdTaken` & `SetIf` `Skipped` Resilience (`M7`)

Deterministic IDs on `liveScene` introduce two narrow multi-editor race windows; both are handled cleanly without user-facing error banners:
1. **Concurrent first creation (`Reject::IdTaken`, `crates/schema/src/validate.rs:416-418`):**
   - **`liveSceneStateId`:** When `!state.records[detStateId]`, first create an empty `{ SceneState: { scene: liveId, more: {} } }` via `state.ensure(...)` (`session.ts:396-402`, which silently absorbs `IdTaken` at `session.ts:683`), then run `state.edit([SceneClock, Op::Restore { id: detStateId }, ...seedAndMutateOps])`. Because `Op::Restore` returns `OpOutcome::Skipped` when already live (`validate.rs:478-479`), both editors' edits succeed cleanly! And an empty `SceneState { more: {} }` is ignored by `hasPauseEntityOverrides` (`Object.keys(more ?? {}).length === 0`), so undoing the first edit leaves zero dirty state.
   - **`liveObjId` / `liveWaveId`:** Created directly in `state.edit(...)` (so `Ctrl+Z` cleanly deletes them via `inverse_of` `Op::Delete` at `crates/schema/src/lib.rs:183`). Add a pure helper `isLiveEntityCreate(board, ops)` in `live.ts` (matching deterministic `liveObjId`/`liveWaveId` `Create`s on `liveScene`) and record matching `cseq`s into `this.ensures` inside `BoardSession.edit(...)` and `BoardSession.connected(...)` (`session.ts:418`) so `session.ts:683` (`this.ensures.has(m.Rejected.cseq) && m.Rejected.reason === "IdTaken"`) absorbs a concurrent `IdTaken` without showing a red rejection pill and syncs to the server's winning record.
2. **Concurrent clear (`Op::Delete`) vs. edit (`Op::Set` / `Op::SetIf`):**
   - Any `Op::Set` or `Op::SetIf` that lands after a peer's `Op::Delete` returns `OpOutcome::Skipped` (`validate.rs:433-435, 449-451`) — never an error or rejection.
   - For packed `SceneState.more` arrays (`doors`, `#55` `obj_health`), `Op::SetIf` on the observed array value ensures a concurrent peer edit causes the stale write to be `Skipped` rather than silently overwriting the peer's changes.

---

## 5. View-State Registry (`AGENTS.md` §8) (`M5`)

- **Playback sync accuracy:** `playback.playing`, `playback.t`, `playback.player`, `playback.match_id`, `playback.speed`, and `playback.jump` are classified as **`Outside::Core`** in `crates/engine/src/view_state.rs:306-310, 315` (and `"wired"` in `web/test/view-state-ledger.ts:38`, mirrored through `host.ts` `mirror()` + `clock.ts` `follow()`). No new presence fields or registry rows are needed.
- **Memos vs. signals:** `pausedEditable`, `hasPauseEntityOverrides`, and `hasPauseEdits` are `createMemo`s derived from existing reactive state and store records — no ledger entry needed.
- **Scanned-file signal ledger (`web/test/view-state-ledger.ts:171`):** Because `web/src/player/` is scanned by `view-state.test.ts`, any new `createSignal` added to `web/src/player/PlayerTopBar.tsx` (e.g., `menu`, `renaming`, `soulsEdit`, `dragPortrait`) **must** be registered under `"player/PlayerTopBar.tsx"` in `web/test/view-state-ledger.ts` with policy `"local"` (menu / text being typed / gesture in progress).

---

## 6. Test Plan

1. **Rust Engine & WASM Unit Tests (`crates/engine/src/replica.rs`, `crates/wasm/src/lib.rs`):**
   - `Replica::drop_history_for` strips both `undo` and `redo` entries whose `inverse` touches any target `RecordId` (including `SceneClock`, `PlayerState`, `SceneState`, `Wave`, `ObjectiveState`), while preserving unrelated `undo`/`redo` entries (live `Stroke`/`Arrow`/`Callout` and real-scene edits) and updating `can_undo()` / `can_redo()`.
   - `BoardReplica::dropHistoryFor` returns a valid `Update` with updated `canUndo`/`canRedo` and persists across `state()`/`restore()`.
2. **Web Unit Tests (`web/test/pause-edit.test.ts`):**
   - **Baseline & legacy migration (`B1`):** `ensureLiveOps` creates `PlayerState` with `placed: false`; `isBaselinePlayerState` & `hasPauseEntityOverrides` treat legacy untouched `{ placed: true, pos: {0,0} }` records (when `clock === null`) as clean and detect empty `more: {}` as clean (`M3`).
   - **Deterministic upsert & zero tombstones (`B3`):** Repeated pause → edit → `clearPauseOverridesOps` → re-edit cycles reuse `liveSceneStateId`, `liveWaveId(board, match, "lane4")`, and `liveObjId(board, match, key)` via `[Op::Restore, Op::Set...]` (strictly `Restore` before `Set`), keeping total record count constant with zero net tombstone growth.
   - **Frame-seeding (`B4`):** First doorway (or `#55` `obj_health`) edit while paused seeds `liveScene`'s `SceneState.more` from the replay frame at `sec` via `codec.ts` (`encodeDoors` / `encodeObjHealth` + `has_*` + `rows` watermark bump), and subsequent edits mutate it identically to a real Scene.
   - **`fromPausedPlayer` & `Scene.clock` scoping (`B6`, `B7`, `B8`):** Layers hero move, kill (`alive: false`), revive (`alive: true, more.health: 100`), sight (`more.unseen: true | false`), souls, ult (`PlayerUltCooldown`), respawn (`PlayerRespawn`), hero swap/rename, `ObjectiveState` status, seeded `doors`/`obj_health`, and `Wave.t` ONLY when `!playing && liveScene.clock === pauseClock(t)`; passes through pure `fromTimeline` when playing or paused at a different timestamp.
   - **`matchSceneOps` with `PauseOverrides` (`B5`):** Merges hero `more` (preserving builds while applying revive `health: 100`, `unseen`, `name`, or dropping old build on hero swap), forces `has_doors`/`has_obj_health`/`has_sight` even on metadata-tier matches, keeps Tx 1 strictly under `LIMITS.max_ops_per_tx = 256` and `max_tx_bytes = 64 KiB`, and clears `liveScene` separately.
   - **`clock.ts` `follow()`:** Paused follower snaps within `0.01 s` so presenter and follower share the exact same `pauseClock(t)`.
3. **Playwright E2E (`web/e2e/player-pause-edit.spec.ts`):**
   - **Pause & edit entities:** Load reference match `129738985` (patch 6839), pause playback, drag a hero token, verify stationary click still opens `HeroCard`, press `K` to kill a hero and set respawn via `.respawn-input`, revive a dead hero via portrait drag / `hero-menu`, adjust `UltRing` + `.tb-vis`, toggle an objective, drag a lane wave split, and place/move a Doorman doorway.
   - **Visible `"Save as scene"` & `"Reset"` + undoable `Reset`:** Verify `[data-testid="match-save"]` updates to `Save as scene` (`.dirty`) and `[data-testid="match-reset"]` appears; click `Reset` → verify overrides revert; press `Ctrl+Z` → verify overrides return!
   - **Resume (`Space`) clears overrides & prunes history (`B2`, `M6`):** Draw a live stroke, verify `Space + drag` pans WITHOUT unpausing or clearing edits; then tap `Space` → verify entity overrides clear immediately while the live stroke remains (D1), and pressing `Ctrl+Z` undoes the live stroke (NOT a cleared hero drag) while `Ctrl+Y` does not resurrect cleared overrides.
   - **`Save as scene` preserves edits (`B5`):** Pause, move a hero, toggle an objective, click `[data-testid="match-save"]` → verify the newly created scene keeps the edited hero position, builds, and objective status while `liveScene` is reset.
   - **Multi-editor & follower sync (`B6`):**
     - Follower B following paused Presenter A sees hero drags, objective toggles, and doorway edits live, and sees them clear when Presenter A resumes.
     - Independent Editor C paused at a *different* timestamp does not see Editor A's overrides and pressing Play on C does not wipe A's edits.
   - **Phone layout (`390×844` portrait & `667×375` landscape) (`M4`):** Pause Player, enter `Edit`, move a hero → verify `[data-testid="match-save"]` and `[data-testid="match-reset"]` are visible and clickable (`>= 44 px`) in `.p-rail` and `.phone .pl-bar` stays within `<= 104 px` (portrait) and `<= 52 px` (landscape).
