# Objective Health Editing in Scenes (`#55`)

**Status:** Design specification · **Issue:** `#55` ("Set health of objectives")  
**Scope:** Web client only (`web/src/mapstate/edit.ts`, `web/src/board/Layers.tsx`, `web/src/board/Board.tsx`, `web/src/board/objectives.ts`, `web/src/player/Player.tsx`, `web/src/styles/minimap.css`). **Zero schema or store version bump.**

> **User request (`#55`):** *"Scene editor should be able to set the health of objectives, the ult cooldowns UX is nice, click and drag maybe?"*

---

## 0. Open Decisions for Operator

| # | Decision | Recommended default | 1-line alternative |
|---|---|---|---|
| **D1** | **Dragging all the way down to `0%`** | **Releasing at `0%` marks the objective `"Destroyed"`** (and drops its `obj_health` triple so a subsequent 1-click toggle revives it cleanly at `100%`). Dragging upward on a `"Destroyed"` objective revives it live at the dragged `1..100%`. | Clamp drag range to `1..100%` and keep `"Destroyed"` strictly on 1-click toggle or context menu. |

---

## 1. Zero-Schema-Bump Storage Contract

### 1.1 Existing Live Schema (`crates/schema/src/map_state.rs`)

Both `has_obj_health` and `obj_health` are already `Status::Live` on `Entity::Scene` (`SceneState.more`), promoted in Phase 5 R3 (`store v17`, board-file `version: 6, rows: 40`; current store is `v19`, `WRITTEN = 42`):

| Row index | Field | Entity | Kind | Bounds / Format |
|---|---|---|---|---|
| `31` | `has_obj_health` | `Scene` (`SceneState.more`) | `Kind::Bool` | Authoritative presence flag for objective health data on the scene |
| `32` | `obj_health` | `Scene` (`SceneState.more`) | `Kind::Ints { len: 120, min: -1, max: ID }` | Up to `40` stride-3 triples (`[fnv1a32(key), pct, stage]`) |

No changes to `crates/schema`, `crates/engine`, `crates/server`, or `.mapcro` file version are required.

### 1.2 Codec Semantics (`web/src/mapstate/codec.ts`)

`web/src/mapstate/codec.ts:59-60, 155, 249-305` already defines:
- `MAX_OBJ_HEALTH = 40` (standard 6v6 map has 25 health-capable markers: 6 Guardians `t1`, 6 Walkers `t2`, 6 Base guardians `barracks`, 4 Shrines `shrine`, 2 Patrons `t3`, 1 Mid-Boss `midboss`).
- `isHealthKind(kind)`: returns `true` for `"t1" | "t2" | "barracks" | "shrine" | "t3" | "midboss"`.
- `encodeObjHealth(entries)` / `decodeObjHealth(raw, markers)`:
  - Each entry is encoded as `[fnv1a32(key), pct, stage]`, sorted deterministically by `keyHash`.
  - `pct`: integer `0..100`, or `-1` when saved from a partial match timeline without health data (`!hasObjHealth`).
  - `stage`: `1` (Patron Stage 1 / Hidden King or Archmother shield), `2` (Patron Stage 2 / weakened core), or `-1` (non-Patron default).
  - **Default elision:** An entry with `pct === 100 && stage === undefined` (i.e. `100%` and no Patron stage override) is omitted from the wire array (`codec.ts:261`).

### 1.3 Writer Implementation (`writeObjHealthOps` & `setObjectiveHealthOps` in `web/src/mapstate/edit.ts`)

Add `writeObjHealthOps` and `setObjectiveHealthOps` to `web/src/mapstate/edit.ts`, mirroring `writeDoorsOps` (`edit.ts:135-205`):

```ts
const OBJ_HEALTH_ROWS = ROWS.obj_health.index + 1; // 33
```

1. **Preserve untouched entries (including `-1` unknown markers on replay-saved scenes):**
   - Decode the current map via `decodeObjHealth(ctx.state?.more?.obj_health, ctx.markers)` (do **not** run the `down`-based `-1` synthesizer from `scene.ts:136` when mutating, because `encodeObjHealth` encodes stored entries while `scene.ts` derives `-1` on read only when `!more?.has_obj_health`).
   - Apply the update for `marker.key`:
     - If `pct === 0` or `pct === null`: delete `marker.key` from the `obj_health` map.
     - If `1 <= pct <= 100`:
       - For Patron (`marker.kind === "t3"`): determine `stage: 1 | 2` (`explicitStage ?? (curStatus === "Stage2" ? 2 : 1)`). If `pct === 100 && stage === 1`, delete `marker.key` from the map (since `Active` + `100%` is the default); otherwise set `{ pct, stage }`.
       - For non-Patron (`t1`, `t2`, `barracks`, `shrine`, `midboss`): if `pct === 100`, delete `marker.key` from the map (returning it to the default `100%`); otherwise set `{ pct }`.
   - Re-encode via `encodeObjHealth(map)`.

2. **Blank scene without `SceneState` (`!ctx.state`):**
   - If `encoded.length === 0` and no `ObjectiveState` status change is needed, return `[]`.
   - Otherwise, construct `more: More = { rows: OBJ_HEALTH_ROWS, has_obj_health: true, ...(encoded.length > 0 ? { obj_health: encoded } : {}) }`.
   - Preflight `moreBytes(more) <= LIMITS.max_more_bytes`; emit `Op::Create { id: ctx.mint(), record: { SceneState: { scene: ctx.scene, more } } }`.

3. **Existing `SceneState` (`ctx.state`):**
   - Let `have = ctx.state.more ?? {}` and `curRows = have.rows ?? 0`.
   - **Dormant flag clearing (preventing `MoreRowOrder` / `MoreOrphanPayload` validation rejection):**
     - If `curRows < OBJ_HEALTH_ROWS`:
       - If `curRows === 0 && have.has_builds === true`, push `Set { value: { More: { key: "has_builds", value: null } } }`.
       - For every `[flag, last]` in `DORMANT_FLAG_ROWS` (`edit.ts:44-52`) where `flag !== "has_obj_health"`, if `have[flag] === true && ROWS[last].index >= curRows`, push `Set { value: { More: { key: flag, value: null } } }`.
   - **Compare-and-swap (`Op::SetIf`) on `obj_health`:**
     - Emit `Op::SetIf` on `ctx.state.id` with:
       - `value: { More: { key: "obj_health", value: encoded.length > 0 ? encoded : null } }`
       - `expect: { More: { key: "obj_health", value: have.obj_health ?? null } }`
   - **Presence flag & row watermark:**
     - If `have.has_obj_health !== true`, emit `Op::Set` setting `More: { key: "has_obj_health", value: true }`.
     - If `curRows < OBJ_HEALTH_ROWS`, emit `Op::Set` setting `More: { key: "rows", value: OBJ_HEALTH_ROWS }`.
   - **Byte-budget preflight:** Verify every intermediate `More` state satisfies `moreBytes(sim) <= LIMITS.max_more_bytes` (`6144` B); return `[]` if exceeded.

4. **Coordinated status + health transaction (`setObjectiveHealthOps`):**
   - **Standing objective (`pct` in `1..100`):**
     - For `t1 | t2 | barracks | shrine | t3`: if `curObjState?.status === "Destroyed"` (or if `t3`stage changes via context menu), emit `ObjectiveState` `Set` / `Create` (`"Active"` or `"Stage2"`) in the same `Op[]` transaction as `writeObjHealthOps`.
     - For `midboss`: if Mid-Boss is currently cleared (`down === true`, encoded in `SceneState.more.camps` hash list), remove `fnv1a32(marker.key)` from `SceneState.more.camps` in the same `Op[]` transaction so Mid-Boss becomes alive at `pct%`.
   - **Dragged to `0%` (`pct === 0`):**
     - For `t1 | t2 | barracks | shrine | t3`: emit `ObjectiveState` `Set` / `Create` with `status: "Destroyed"` and remove `marker.key` from `obj_health` in the same transaction.
     - For `midboss`: add `fnv1a32(marker.key)` to `SceneState.more.camps` (marking Mid-Boss cleared) and remove `marker.key` from `obj_health` in the same transaction.
   - **1-click toggle interaction (`clickObjective` / `toggleObjectivesOps` in `web/src/board/objectives.ts`):**
     - When an objective is 1-click toggled to `"Destroyed"`, or when a Patron (`t3`) 1-click cycles stage (`Active` → `Stage2` → `Destroyed` → `Active`), also clear that marker's entry from `SceneState.more.obj_health` in the same transaction so the next stage or revival starts cleanly at `100%`.

---

## 2. Which Objectives Support Health

| Kind (`MapMarker["kind"]`) | Game label (§4b) | Count | Stages | Health support |
|---|---|---|---|---|
| `t1` | `Guardian` | 6 | Single | `1..100%` + `Destroyed` (`0%`) |
| `t2` | `Walker` | 6 | Single | `1..100%` + `Destroyed` (`0%`) |
| `barracks` | `Base guardian` | 6 | Single | `1..100%` + `Destroyed` (`0%`) |
| `shrine` | `Shrine` | 4 | Single | `1..100%` + `Destroyed` (`0%`) |
| `t3` | `Patron` (`Hidden King` / `Archmother`) | 2 | Stage 1 (`Active`, shield) · Stage 2 (`Stage2`, weakened core) | `1..100%` per stage + `Destroyed` (`0%`) |
| `midboss` | `Mid-Boss` | 1 | Single (`camps` bit for alive/cleared) | `1..100%` when alive + `Cleared` (`0%`) |
| `camp` (`small`/`medium`/`large`/`vault`) | `Neutral camp` / `Sinner's Sacrifice` | 45 | Alive / Cleared only | **No health bar** (`isHealthKind` is `false`; 1-click toggle only) |
| `powerup` / `soul_urn` / `teleporter` | `Bridge buff` / `Soul Urn` / `Teleporter` | — | Active / Inactive | **No health bar** (1-click toggle only) |

---

## 3. Interaction & UX Specification

### 3.1 Why Direct Vertical Drag (and Not Mouse-Wheel) on the Minimap

In `TopBar.tsx:89-160`, `UltRing` supports click-and-drag, mouse-wheel (`onWheel`), and right-click reset. On the minimap (`svg.mm-overlay.map` in `Layers.tsx:1124`), **mouse-wheel is universally bound to map zoom (`onZoom`)**. Intercepting `wheel` over 25 map objective markers would cause erratic zoom blocks when scrolling across the map. Therefore:
- **Primary desktop & tablet/phone Edit-mode gesture:** Direct **click-and-drag vertically** on any `isHealthKind` objective marker in `Select` tool (`Q`).
- **Secondary desktop & touch gesture:** **Right-click** (desktop) or **long-press** (`500 ms`, touch) opens the objective context menu (`testid="obj-menu"`) with 1-tap presets and Patron stage controls.

### 3.2 Direct Click-and-Drag Mechanics (`web/src/board/Layers.tsx`)

Today in `Layers.tsx:972-984`, pressing primary button on `m = objectiveAt(start)` calls `track(e, () => {}, (pt, ok) => { if (ok && Math.hypot(pt.x - start.x, pt.y - start.y) < 8) clickObjective(m); })`. Dragging `>= 8` view units currently does nothing.

Replace that no-op drag branch for `isHealthKind(m.kind)` when `!e.shiftKey`:

1. **Click vs. Drag Threshold:**
   - Measure screen-space displacement `distPx = Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY)`.
   - **`distPx < 6` CSS px on `pointerup`:** Executes existing 1-click toggle (`clickObjective(m)`).
   - **`distPx >= 6` CSS px during `pointermove`:** Enters live health scrub mode (`dragObjHealth` signal: `{ key: string; pct: number; stage?: 1 | 2 }`).
   - **Touch pinch-zoom handoff (`web/src/board/touchGestures.ts`):** If `e.pointerType === "touch"` and a second finger touches down within `150 ms` / `10 px`, `touchGestures.ts` fires a synthetic `pointercancel` on the SVG (`touchGestures.ts:69-74`), which `track()` catches (`ok === false`), aborting `dragObjHealth` with zero ops committed.

2. **Direction, Baseline & Sensitivity:**
   - **Vertical delta:** `dyPx = startClientY - ev.clientY` (dragging **up** increases health, dragging **down** decreases health — matching the bottom-to-top `hpClip` fill direction inside every objective icon in `MapView.tsx:44-50`).
   - **Starting baseline `startPct`:**
     - If the objective is currently standing (`status !== "Destroyed"` and `!ms.marker(m.key).down()`): `startPct = ms.marker(m.key).health()?.pct ?? 100` (if `pct === -1` unknown, treat baseline as `100`).
     - If the objective is currently `"Destroyed"` (or Mid-Boss cleared): `startPct = 0`. Dragging upward immediately previews reviving the objective at `1..100%`!
   - **Scale:** `80 CSS px = 100%` (`1.25%` per CSS pixel), matching `UltRing`'s ergonomic short-throw feel:
     ```ts
     const raw = Math.max(0, Math.min(100, startPct + (dyPx / 80) * 100));
     const pct = ev.shiftKey ? Math.round(raw / 5) * 5 : Math.round(raw);
     ```
   - Holding `Shift` after starting the drag snaps `pct` to `5%` increments (`0%, 5%, 10%, …, 100%`).

3. **Live Visual Feedback During Drag:**
   - **Zero-lag icon fill (`web/src/styles/minimap.css`):**
     - `marks.health(key)` in `Board.tsx` returns `dragObjHealth()?.key === key ? { pct: dragObjHealth()!.pct, stage: dragObjHealth()!.stage } : ms.marker(key).health()` (and `marks.objectives()` temporarily treats the dragged objective as `"Active"` / `"Stage2"` when `dragObjHealth().pct > 0` or `"Destroyed"` when `dragObjHealth().pct === 0`).
     - Per spec §4a (*"Never ease what the user is moving"*), set `data-adjusting="true"` on the active `<g class="obj-mark">` / `.mm-midboss` during drag and disable the `350 ms` CSS transition on `.obj-fill`, `.patron-ring`, and `.midboss-ring` while `[data-adjusting="true"]`.
   - **Radial Scrub Ring + `%` Readout Pill (`.obj-hp-dial`):**
     - While `dragObjHealth()` is active on marker `m`, render a crisp SVG progress ring (`r = 22` view units around `(m.x, m.y)`, team-colored stroke `stroke-dasharray: ${pct} 100`) plus the existing `HoverLabels` pill above the marker reading:
       - `pct > 0`: `"Guardian · 65%"` (or for Patron Stage 2: `"Patron (Weakened) · 40%"`)
       - `pct === 0`: `"Guardian · Destroyed"` (or for Mid-Boss: `"Mid-Boss · Cleared"`)
   - **Presence focus:** Call `st.presence({ focus: objStateRecordId ?? sceneId })` while scrubbing so peers see the editing ring on the objective.

4. **Commit on Release (`pointerup`):**
   - Clear `dragObjHealth(undefined)` and `st.presence({ focus: undefined })`.
   - If `pct` equals the initial state before the drag started, emit no ops.
   - Otherwise call `st.edit(setObjectiveHealthOps(ctx, m, pct))` — committing a single atomic transaction (1 undo step).

### 3.3 Context Menu & Touch / Phone Path (`testid="obj-menu"`)

On desktop, right-clicking (`e.button === 2`, stationary release `< 4 px`) on any `isHealthKind(m.kind)` marker in `Select` tool (`Q`), or on touch (`pointerType === "touch"`), holding a `500 ms` `longPress` (`Layers.tsx:788`) on the marker, opens `<ContextMenu label={HEALTH_NAME[m.kind]} testid="obj-menu">`:

- **For Guardian (`t1`), Walker (`t2`), Base guardian (`barracks`), Shrine (`shrine`):**
  - `100%` (`testid="obj-menu-hp-100"`)
  - `75%` (`testid="obj-menu-hp-75"`)
  - `50%` (`testid="obj-menu-hp-50"`)
  - `25%` (`testid="obj-menu-hp-25"`)
  - `Destroyed` (`testid="obj-menu-destroyed"`)
- **For Mid-Boss (`midboss`):**
  - `100%` (`testid="obj-menu-hp-100"`)
  - `75%` (`testid="obj-menu-hp-75"`)
  - `50%` (`testid="obj-menu-hp-50"`)
  - `25%` (`testid="obj-menu-hp-25"`)
  - `Cleared` (`testid="obj-menu-destroyed"`)
- **For Patron (`t3` — uses game patron name `Hidden King` or `Archmother` as menu header):**
  - `Stage 1 · 100%` (`testid="obj-menu-stage1"`)
  - `Stage 2 (Weakened) · 100%` (`testid="obj-menu-stage2"`)
  - `75%` (`testid="obj-menu-hp-75"` — applies to current stage, or Stage 1 if currently Destroyed)
  - `50%` (`testid="obj-menu-hp-50"`)
  - `25%` (`testid="obj-menu-hp-25"`)
  - `Destroyed` (`testid="obj-menu-destroyed"`)

*(In addition, on touch devices in `Edit` mode (`phoneMode() === "edit"`), 1-finger vertical drag directly on an `isHealthKind` objective also works because `Layers.tsx` receives pointer capture in `Select` tool before background `pan` runs.)*

---

## 4. `Health bars & arcs` (`showHealth`) Toggle & `TD-162`

- In `web/src/player/host.ts:141`, `showHealth` already defaults to `true`.
- In `web/src/player/Player.tsx:662-674` (`TD-162`), `mapControlFeatures` checks `ms.has("obj_health")`:
  - On a fresh blank scene, `ms.has("obj_health")` is initially `false`, keeping the `Map layers` popover uncluttered when all objectives are at `100%`.
  - The moment a user edits any objective's health (or during a live drag preview when `dragObjHealth() !== undefined`), `has_obj_health: true` is written to `SceneState.more`, so `ms.has("obj_health")` becomes `true`.
  - `markerStates.ts:61` (`showHealth: () => opts.showHealth() && opts.mapState().has("obj_health")`) and `MarkerTips` (`Camps.tsx:152`) immediately activate on the scene, rendering the partial health fill inside `MapView` and the hover/tap tag (`"Walker 62%"`).
  - **Auto-enable safeguard:** If the user had previously toggled `Health bars & arcs` OFF in `Map layers` (`player.showHealth() === false`) and then manually edits an objective's health, committing the edit calls `if (!player.showHealth()) player.setShowHealth(true)` so their edit is never hidden.
- **View-state registry (`AGENTS.md` §8):**
  - `player.health` is already registered in `crates/engine/src/view_state.rs` (`Follow::Mirror`, `Scope::Board`) and synced via `web/src/player/viewstate.ts`.
  - The ephemeral `dragObjHealth` signal in `Layers.tsx` lives outside the scanned view-state files (`Layers.tsx` is not in `SCANNED_FILES` in `web/test/view-state-ledger.ts`, matching `dragRespawn` in `Layers.tsx:266`).

---

## 5. Undo/Redo, Multi-User CAS, `.mapcro` Export/Import & §4b Labels

- **Undo / Redo (`Ctrl+Z` / `Ctrl+Y`):**
  - Each completed drag or context-menu preset commits a single `st.edit(...)` batch containing `Op::SetIf` on `SceneState.more.obj_health` (and any accompanying `ObjectiveState` status change).
  - Server-side `invert_op` in `crates/engine/src/replica.rs` automatically reverses both the `SetIf` on `More` and the `ObjectiveState` change in one `Ctrl+Z` step.
- **Multi-user CAS conflict handling:**
  - `writeObjHealthOps` uses `Op::SetIf` with `expect: { More: { key: "obj_health", value: have.obj_health ?? null } }`. If two coaches edit objective health simultaneously, the second op whose `expect` does not match the first's committed array is cleanly rejected by the server (`SetIf` mismatch) and rolled back on the losing client without corrupting the stride-3 array.
- **`.mapcro` export & import compatibility:**
  - `has_obj_health` (row `31`) and `obj_health` (row `32`) are well below `map_state::WRITTEN = 42` (`board-file version: 6`). Exported `.mapcro` files already serialize and validate `SceneState.more.obj_health` via `crates/schema/src/validate.rs`.
- **§4b Labels & Tooltips Compliance:**
  - All labels use exact game terms from `HEALTH_NAME` (`Camps.tsx:142`): `"Guardian"`, `"Walker"`, `"Base guardian"`, `"Shrine"`, `"Patron"` (`"Hidden King"` / `"Archmother"`), `"Mid-Boss"`.
  - Hover / scrub pills use short tags: `"Walker 65%"`, `"Patron (Weakened) 40%"`, `"Guardian · Destroyed"`. No prose explanations.

---

## 6. Test Plan

1. **Unit tests (`web/test/mapstate.test.ts`):**
   - `setObjectiveHealthOps` on a blank scene (no `SceneState` yet) creates `SceneState` with `rows: 33, has_obj_health: true, obj_health: [hash, pct, -1]`.
   - `setObjectiveHealthOps` on an existing `SceneState` with `rows < 33` clears any dormant flag rows (`DORMANT_FLAG_ROWS`), emits `Op::SetIf` on `obj_health`, and advances `rows` to `33`.
   - Setting `pct = 0` marks `ObjectiveState` `"Destroyed"` (or Mid-Boss in `camps`) and removes the triple from `obj_health`.
   - Setting `pct = 60` on a `"Destroyed"` objective sets `ObjectiveState` to `"Active"` and writes `60%` in one transaction.
   - Setting `pct = 100` on an `"Active"` objective elides its triple from `obj_health` while keeping `has_obj_health: true`.
   - Patron (`t3`) 1-click stage cycle (`Active` → `Stage2` → `Destroyed` → `Active`) clears any stale partial health triple for that Patron.
   - Preserves `-1` unknown triples for other objectives on partial-timeline scenes.
2. **Playwright E2E (`web/e2e/objective-health.spec.ts`):**
   - Drag vertically on a Walker in Scene mode → live `hpClip` and `"Walker · 55%"` readout update during drag; releasing persists `55%` across reload and `Ctrl+Z` / `Ctrl+Y`.
   - Short click (`< 6 px`) on the same Walker still toggles `"Destroyed"` ↔ `"Active"` (`100%`).
   - Drag upward on a `"Destroyed"` Guardian revives it at the dragged `%`.
   - Right-click objective opens `[data-testid="obj-menu"]`; selecting `50%` or `Stage 2 (Weakened) · 100%` on a Patron updates the map and `.mapcro` export round-trip.
