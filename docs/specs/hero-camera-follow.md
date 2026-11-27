# Hero Minimap Token Camera Tracking (`#16`)

**Status:** Design specification · **Issue:** `#16` ("Follow hero minimap token with camera")  
**Scope:** Web client (`web/src/board/Board.tsx`, `web/src/board/follow.ts`, `web/src/board/TopBar.tsx`, `web/src/board/TopBarParts.tsx`, `web/src/board/Tokens.tsx`, `web/src/board/Layers.tsx`, `web/src/board/touchGestures.ts`, `web/src/player/PlayerTopBar.tsx`, `web/src/player/HeroCard.tsx`, `web/src/styles/minimap.css`, `web/src/styles/topbar.css`, `web/test/view-state-ledger.ts`). **Zero schema or wire changes.**

> **User request (`#16`):** *"There should be a way to follow a character's minimap icon (freely allowing zooming without breaking the tracking). I was thinking maybe double clicking on the hero's iicon in the top bar, or possibly their minimap token. Maybe there could be a hotkey to start following/tracking a hovered minimap character (would also work if the mouse was over their top portrait)"*

---

## 0. Open Decisions for Operator

| # | Decision | Recommended default | 1-line alternative |
|---|---|---|---|
| **D1** | **Hover hotkey binding** | **Context-sensitive `F`** (mirrors how `D` deletes a hovered item/doorway when over one and selects Erase tool otherwise: pressing `F` while hovering a hero token or top-bar portrait toggles camera tracking for that hero; pressing `F` elsewhere follows the active presenter). | Dedicated unbound key **`G`** (or **`R`**) for hero tracking so `F` exclusively follows a presenter regardless of pointer hover. |
| **D2** | **Enemy hero leaves Vision while tracked** | **Keep tracking armed and hold camera at the last-seen position** (the ghost token when `Last seen` is ON, or the fade-out viewport when `Last seen` is OFF); smoothly glide (`360 ms`) to the hero when they re-enter Vision. | Automatically cancel tracking (`setTrackedHero(undefined)`) the moment a tracked enemy leaves Vision. |

---

## 1. Terminology & §4b Copy (Avoiding Collision with Presenter Follow)

Mapcro already uses **"Follow"** / **"Following \<Name\>"** (`data-testid="follow-chip"` in `Board.tsx:969`) for following another user/presenter (`session/follow.ts`, `board/follow.ts`). To avoid ambiguity in UI labels, tooltips, and tests:
- User/presenter follow remains: **`Follow <User>`** / **`Following <User>`**.
- Camera lock on a hero uses: **`Track hero`** / **`Tracking <Hero>`** / **`Stop tracking`**.

---

## 2. Triggers & Zero-Conflict Gesture Resolution

### 2.1 Trigger 1 — Double-Click / Double-Tap Hero Portrait in Top Bar (`TopBar.tsx` & `PlayerTopBar.tsx`)

Let's audit all existing handlers on `.tb-player` / `.tb-focus` / `.phone-hero`:
- **Single click (`onClick` on `.tb-focus` / `.phone-hero`):**
  - In Scenes (`TopBar.tsx:318`): if `!justDragged && !e.shiftKey`, calls `p.onFocusHero?.(p.team, s.slot)` (`focusHero` in `Board.tsx:480`, which pans once *only if already zoomed in* `view().w < FIT_VIEW.w - 1`, emits a radar ping, and flashes `.focus-ring`), and if the hero has build items, toggles the per-hero `BuildColumn` dropdown (`toggleBuild(key)`).
  - In Player (`PlayerTopBar.tsx:161`): calls `p.onFocusHero?.(p.team, s.slot)` and `p.onToggleBuild(k)`.
- **Shift-click:** Selects/toggles the hero token in `selection()` (Scenes only).
- **Pointer drag (`pointerdown` + move `>= 6 px`):** Spawns an unplaced hero onto the map or re-drags a placed hero (`TopBar.tsx:249`).
- **Right-click (`onContextMenu`):** Opens `hero-menu` (Scenes).

**Double-click / double-tap resolution (zero conflict with single-click):**
1. Track `wasBuildOpenBeforeClick1` on the first click (`e.detail === 1`).
2. When a second click/tap arrives on the same portrait within `350 ms` (`e.detail >= 2` or `performance.now() - lastPortraitTap.t < 350` for touch) without `e.shiftKey`:
   - Call `toggleTrackHero(slotKey(team, slot))`.
   - **Clean up click-1 side effects:**
     - If click 1 just opened the per-hero `BuildColumn` dropdown (`!wasBuildOpenBeforeClick1 && openBuilds().has(key)`), close it (`closeBuild(key)`) so the build column does not obscure the minimap while the camera tracks the hero!
     - Suppress the second duplicate radar ping in `focusHero`.

### 2.2 Trigger 2 — Double-Click / Double-Tap Hero Token on Minimap (`Tokens.tsx`)

Let's audit all existing handlers on `<g class="tok">` (`Tokens.tsx:157-325`):
- **In Scenes (`!p.readOnly`):** `down()` calls `capture(svg, e.pointerId)` on `pointerdown` (`Tokens.tsx:207`). Because pointer capture on the ancestor `<svg>` redirects `pointerup` target to `<svg>`, **the browser does not fire a native DOM `dblclick` event on `<g class="tok">`**.
  - On a stationary click (`!d.moved`, travel `< 4 px`): `up()` clears `drag()` and commits **0 ops** (unless `e.shiftKey` toggled `selection()`).
- **In Player (`p.readOnly === true`):** `down()` does not capture the pointer; `onClick` (`Tokens.tsx:314`) calls `p.onOpen(m.team, m.slot)` which opens or raises `HeroCard` (`Player.tsx:346`).
- **Erase tool (`D`):** `p.tool === "erase"` unplaces the token on `pointerdown`.

**Double-tap timestamp resolution (`lastTokTap`, mirroring `calloutDown` in `Layers.tsx:1230`):**
1. Maintain `let lastTokTap: { key: string; t: number; openedCard: boolean } | undefined` in `Tokens.tsx`.
2. Exclude `p.tool === "erase"`, `e.shiftKey`, `e.button !== 0`, and fading-out ghosts (`data-fading="out"`).
3. **In Scenes (`!p.readOnly`):**
   - Inside `up()` when `!d.moved` (pointer moved `< 6 CSS px` between `pointerdown` and `pointerup`):
     - If `lastTokTap && lastTokTap.key === k && now - lastTokTap.t < 400`:
       - Clear `lastTokTap = undefined` and call `p.onTrackHero?.(k)`.
       - Zero drag ops were emitted on tap 1 or tap 2, so undo history (`Ctrl+Z`) and token position are untouched.
     - Else record `lastTokTap = { key: k, t: now, openedCard: false }`.
4. **In Player (`p.readOnly`):**
   - Inside `<g class="tok">` `onClick`:
     - On tap 1: record whether `HeroCard` was already open for `k` (`wasOpen = p.isCardOpen?.(k) ?? false`), run `p.onOpen?.(m.team, m.slot)`, and set `lastTokTap = { key: k, t: now, openedCard: !wasOpen }`.
     - On tap 2 within `400 ms` (`lastTokTap && lastTokTap.key === k && now - lastTokTap.t < 400`):
       - Call `p.onTrackHero?.(k)`.
       - If tap 1 just opened `HeroCard` (`lastTokTap.openedCard === true`), close that `HeroCard` (`p.onCloseCard?.(k)`) so the floating card doesn't cover the map while tracking; if the user already had `HeroCard` open before tap 1, leave it open.
       - Clear `lastTokTap = undefined`.

### 2.3 Trigger 3 — Hover Hotkey Over Minimap Token OR Top-Bar Portrait

#### Full Codebase Hotkey Audit (`Board.tsx`, `Layers.tsx`, `Player.tsx`)

| Key(s) | Current binding | Location |
|---|---|---|
| `Q`, `W`, `E`, `A`, `S`, `D` | Tool selection (`Select`, `Brush`, `Laser`, `Arrow`, `Comment`, `Erase`); `D` also deletes hovered item/doorway | `Board.tsx:644`, `Layers.tsx:1129` |
| `C` / `Shift+C` | Clear my drawings / Clear all drawings | `Board.tsx:620` |
| `T` | Add scene (Scenes mode) | `Board.tsx:629` |
| `F` | Follow active presenter (only when `following() === undefined`) | `Board.tsx:651` |
| `K` | Kill / revive hovered hero token on minimap | `Layers.tsx:1138` |
| `1`, `2`, `3` | Vision filter (`Both`, `Hidden King`, `Archmother`) | `Board.tsx:662` |
| `Tab` | Hold to peek all builds | `Board.tsx:583` |
| `Space` | Play/Pause (in Player) or hold-to-pan (in Scenes) | `Player.tsx:271`, `Layers.tsx:1114` |
| `←` / `→` | Seek `±5 s` (or prev/next event) in Player; prev/next scene in Scenes | `Player.tsx:284`, `Board.tsx:605` |
| `Escape` | Close modal/menu/panel → clear selection → stop presenter follow | `Board.tsx:562` |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo | `Board.tsx:593` |
| `+`/`=` and `-` | Zoom in / out (when added or via buttons) | — |

#### Hover Hotkey Resolution (`F`)
Mirror the exact precedent of `D` (`Layers.tsx:1129-1137`) and `K` (`Layers.tsx:1138-1155`):
1. **Detecting hovered hero (`hoveredHeroSlot()`):**
   - Track last pointer client coordinates `mouseClient: { x: number; y: number } | undefined` on window/board `pointermove`.
   - Add `data-slot={slotKey(team, slot)}` to every `.tb-player` / `.phone-hero` portrait in `TopBar.tsx` and `PlayerTopBar.tsx` (minimap `<g class="tok">` already has `data-slot={slotKey(m.team, m.slot)}` at `Tokens.tsx:160`).
   - When `F` is pressed (with no modifier keys and not inside an input/editable element):
     - Query `document.elementsFromPoint(mouseClient.x, mouseClient.y)` (falling back to `document.querySelector(".tok[data-slot]:hover, .tb-player[data-slot]:hover, .phone-hero[data-slot]:hover")`).
     - Find the first element matching:
       - `.tok[data-slot]:not([data-fading="out"])` (a visible minimap hero token, excluding fading-out ghosts so hovering a disappearing ghost never leaks/tracks an unseen hero), **or**
       - `.tb-player[data-slot], .phone-hero[data-slot]` (a top-bar hero portrait).
2. **Dispatch on `F`:**
   - If a hovered hero `slot` is found and that hero is placed on the map (`ms().hero(slot).placed()`): call `toggleTrackHero(slot)` and `e.preventDefault()`.
   - Otherwise (pointer is not over any hero token or portrait): fall through to existing presenter follow (`if (following() === undefined) follow()`).

### 2.4 Trigger 4 — Context Menu & Touch / Phone Affordance

On touch phones/tablets (where there is no hover cursor and double-tapping a tiny moving token can be tricky):
1. **Top-Bar Hero Context Menu (`testid="hero-menu"` in `TopBar.tsx:458`):**
   - Whenever `menu().placed` is `true`, add a menu item:
     - Label: **`Track hero`** (or **`Stop tracking`** when `trackedHero() === key`)
     - `testid="hero-menu-track"`
2. **Player Hero Card Header (`web/src/player/HeroCard.tsx:90`):**
   - Tapping any hero token on phone/tablet/desktop in Player opens `HeroCard`.
   - In `.hero-panel-head` (right next to the `.hero-panel-close` `×` button), add a compact 24×24 camera-lock icon button:
     - `data-testid="hero-card-track"`
     - `class="btn icon small hero-panel-track"` (`classList={{ active: p.tracked }}`)
     - `aria-label={p.tracked ? "Stop tracking" : "Track hero"}`
     - `aria-pressed={p.tracked}`
     - Wrapped in `<Hover tip={() => <TagTip text={p.tracked ? "Stop tracking [F]" : "Track hero [F]"} />}>`
     - **Phone convenience:** On `.phone`, tapping `hero-card-track` to *start* tracking automatically closes `HeroCard` (`p.onClose()`) so the minimap is completely unobstructed while tracking.

---

## 3. Camera Mechanics & Exact Transform Math

### 3.1 Zoom-In on Start & Viewport Math (`web/src/map/transform.ts`, `web/src/board/follow.ts`)

Recall `web/src/map/transform.ts`:
- The map viewBox is `VIEW_SIZE = 1000`.
- `FIT_VIEW` has `w ≈ 927.84` (`scale = 1000 / w ≈ 1.078×`).
- `MIN_W = 150` (`6.67×` max zoom), `MAX_W = 1000` (`1.0×` min zoom).
- A world coordinate `pos: Vec2` maps to view-space via `c = worldToView(pos, viewpoint())`.
- Centering the camera on `c` at view width `w` produces:
  ```ts
  export const TRACK_DEFAULT_W = 400; // 2.5x zoom (1000 / 400)
  export const TRACK_ZOOM_THRESHOLD_W = 480; // ~2.08x zoom

  export function centerViewOnWorld(pos: Vec2, w: number, vp: Team = "amber"): View {
    const c = worldToView(pos, vp);
    return clampView({ x: c.x - w / 2, y: c.y - w / 2, w });
  }
  ```

### 3.2 Starting Tracking (`startTrackHero(key)`)

1. If `following() !== undefined` (currently following a presenter), call `stopFollowing("tracked a hero")` (`Board.tsx:375`) first.
2. Determine target zoom width `targetW`:
   - If currently near fit view (`view().w > TRACK_ZOOM_THRESHOLD_W`, i.e. scale `< 2.08×`), set `targetW = TRACK_DEFAULT_W` (`400`, which is `2.5×` zoom).
   - If already zoomed in (`view().w <= TRACK_ZOOM_THRESHOLD_W`), keep the user's current zoom `targetW = view().w`.
3. Set `setTrackedHero(key)` and start an entry glide (`GLIDE_MS = 360`, cubic ease-out `1 - (1 - t)^3`).

### 3.3 Continuous Tracking & Dynamic Glide Target (No High-Speed Snap)

In Player at `1×`–`8×` playback (or when a peer drags a token in Scenes), the hero moves while the `360 ms` entry glide is still in flight. Instead of gliding toward a static snapshot of the hero's `t=0` coordinates:
- Store `trackGlide: { from: View; t0: number } | undefined`.
- Inside a reactive `createEffect` watching `trackedWorldPos()`, `viewpoint()`, and `view().w`:
  - Let `pos = trackedWorldPos()`. If `pos === undefined` (see §4 Vision & Death rules), hold `view()` at its current position without clearing `trackedHero()`.
  - Compute live target `goal = centerViewOnWorld(pos, currentW, viewpoint())`.
  - If `trackGlide` is active (`elapsed < GLIDE_MS`):
    - Interpolate `k = 1 - Math.pow(1 - elapsed / GLIDE_MS, 3)` between `trackGlide.from` and `goal` (using `view().w` so wheel/pinch zoom even mid-glide is respected!), scheduling a `requestAnimationFrame` tick until `k === 1`, then clear `trackGlide`.
  - Once `trackGlide` completes (`k === 1`):
    - Call `setView(goal)` synchronously whenever `trackedWorldPos()` or `viewpoint()` updates.
    - Because `.mm-tokens` and `MapView` derive their transform from `view()` in the same Solid reactive flush, the hero token remains pixel-locked at the center of the viewport (except when `clampView` hits the outer `1000×1000` map edge).

### 3.4 Free Zooming Without Breaking Tracking (Desktop Wheel + Touch Pinch Fix)

The issue explicitly requires: ***"freely allowing zooming without breaking the tracking"***.

1. **`onZoom(at, factor)` in `Board.tsx:741`:**
   - When `trackedHero()` is active, `onZoom` **must NOT clear `trackedHero()`** and must not call `cancelGlide()`.
   - Furthermore, zooming toward an arbitrary off-center cursor `at` would shift `x, y` away from the hero for 1 frame and then snap back on the next hero position tick.
   - Therefore, while `trackedHero()` is active:
     - Compute `nextW = Math.max(MIN_W, Math.min(MAX_W, view().w * factor))`.
     - If `trackedWorldPos()` is currently defined (`pos`), re-center immediately on `pos` at `nextW`: `setView(centerViewOnWorld(pos, nextW, viewpoint()))`.
     - If `trackedWorldPos()` is currently `undefined` (holding at death spot or last-seen FOW fade-out), zoom around the viewport center `(view().x + view().w / 2, view().y + view().w / 2)`.

2. **Critical Touch Pinch-Zoom Fix (`web/src/board/touchGestures.ts:100-101` & `Layers.tsx:435`):**
   - Look at `web/src/board/touchGestures.ts:100-101`: during a 2-finger pinch zoom, `move()` calls **both** `q.onPan(mid.x - pinch.x, mid.y - pinch.y, rect)` **and** `q.onZoom(pt, factor)` on every touchmove frame!
   - And look at `web/src/board/Layers.tsx:435`: `pan(e)` calls `p.onPan(dx, dy, rect)` on *every* `pointermove` even before travel exceeds click slop (`far >= slop`).
   - If `onPan` unconditionally cancelled `trackedHero()`, then:
     1. A 2-finger pinch zoom on tablet/phone would immediately cancel hero tracking on the first frame!
     2. A 1-pixel sub-slop mouse jitter during a click or double-click on the map background would cancel tracking!
   - **Fix:**
     - In `Layers.tsx:435` (`pan`): only begin invoking `p.onPan(...)` once `far >= slop` (`e.pointerType === "touch" ? 10 : 4` CSS px).
     - In `touchGestures.ts:100`: pass a 4th parameter `fromPinch?: boolean` to `onPan(dx, dy, rect, true)` (or when `trackedHero()` is active, ignore `onPan` calls where `fromPinch === true` since `onZoom` already centers on the tracked hero).

### 3.5 Complete Cancellation Matrix

| User Action | Effect on `trackedHero()` |
|---|---|
| Wheel zoom / 2-finger pinch zoom | **Keeps tracking** (`w` updates smoothly around tracked hero) |
| Play / Pause (`Space`), timeline scrub, `←`/`→` seek, speed change (`1×`–`8×`) | **Keeps tracking** |
| Flip map (`viewpoint` Amber ↔ Sapphire) | **Keeps tracking** (re-centers in new orientation) |
| Toggle Vision (`1`/`2`/`3` or pill) / `Last seen` | **Keeps tracking** (respects FOW anti-leak rules in §4) |
| Hero dies / respawns | **Keeps tracking** (holds at death skull, glides to base on respawn) |
| Dragging the tracked hero token itself (in Scenes or paused Player `#61`) | **Keeps tracking** (holds pan while local pointer is dragging so the token doesn't feedback-loop under the cursor, then re-centers smoothly on `pointerup`) |
| Manual 1-finger / mouse map pan (`far >= slop`, not pinch) | **Cancels tracking** |
| Clicking `Reset zoom` / `Fit` button (`.zoom-pill` in `Board.tsx:962`) | **Cancels tracking** and glides to `FIT_VIEW` |
| Pressing `Escape` (when no modal, menu, build drawer, or `HeroCard` is open) | **Cancels tracking** |
| Double-clicking / pressing `F` on the **same** tracked hero | **Cancels tracking** (toggles off) |
| Double-clicking / pressing `F` on a **different** hero | **Switches tracking** directly to the new hero (`360 ms` glide) |
| Starting presenter follow (`follow()` via `F` or avatar click) | **Cancels hero tracking** (presenter's viewport takes over) |
| Switching to a scene where `trackedHero` is unplaced (`!hero.placed()`) | **Cancels tracking** |

---

## 4. Vision Anti-Leak & Dead-Hero Rules (Player + Scenes)

### 4.1 Strict FOW Anti-Leak Contract in Player (`web/src/mapstate/shown.ts`)

In Player (and on scenes with unseen heroes), `web/src/mapstate/shown.ts:103` defines the single authoritative visibility resolver used by `Tokens.tsx`:

```ts
export function playerPlace(ms: MapState, key: string, sh: ShownContext): ShownPlace | undefined
```

**Rule:** In Player mode, the camera tracker MUST compute `trackedWorldPos()` exclusively from `playerPlace(ms(), key, player.shown())` — **never** from raw `ms().hero(key).pos()` or `ms().hero(key).last()`.

Let's trace all four states of `playerPlace(ms(), key, player.shown())`:

1. **Hero is alive and in Vision (`place.draw.as === "live"`):**
   - `trackedWorldPos()` returns `place.pos`. Camera locks continuously to `place.pos`.
2. **Enemy hero leaves Vision while `Last seen` is ON (`place.draw.as === "ghost"`):**
   - `playerPlace` returns `place.pos = draw.at` (the frozen world coordinates where the enemy was last seen).
   - Camera holds steady at the ghost token's last-seen position. Zero unseen movement is leaked.
3. **Enemy hero leaves Vision while `Last seen` is OFF (`place.draw === { as: "hidden" }`, so `playerPlace` returns `undefined`):**
   - `trackedWorldPos()` returns `undefined`.
   - The camera stays frozen at its last rendered `view()` (where the enemy faded out into fog). It does **not** move while the enemy is hidden.
4. **Enemy hero re-enters Vision (`place.draw.as === "live"` after being `"ghost"` or `"hidden"`):**
   - `trackedWorldPos()` transitions from `undefined` (or `ghost.at`) to the newly sighted `place.pos`.
   - Whenever the view-space jump `Math.hypot(newC.x - oldC.x, newC.y - oldC.y) > 40`, trigger a `360 ms` `trackGlide` so the camera glides smoothly to the newly sighted position instead of teleporting in 1 frame.
5. **Starting tracking on a hero currently hidden by Vision:**
   - If the user double-clicks a top-bar portrait of an enemy hero who is currently unseen:
     - If `Last seen` is ON (`ghost`), camera glides to their ghost (`draw.at`) and arms `trackedHero(key)`.
     - If `Last seen` is OFF (`hidden`, so `playerPlace` is `undefined`), `trackedHero(key)` arms without panning the camera away from the current view (never revealing where the hidden enemy is!).

### 4.2 Dead Hero & Respawn Behavior

- **In Player:** When a hero dies, a death skull (`.pl-skull` in `Camps.tsx`) is rendered at their death coordinates while `hero.alive()` is `false` and `playerPlace` returns `undefined`.
  - While `trackedHero` is dead, `trackedWorldPos()` returns `undefined`, so the camera **holds at their death location** while the respawn timer counts down.
  - The moment the hero respawns at base (`hero.alive()` becomes `true` and `playerPlace` returns their base spawn coordinates), the distance jump (`> 40` view units) triggers a smooth `360 ms` `trackGlide` back to base and resumes continuous tracking!
- **In Scenes:**
  - In Scenes mode, dead heroes remain placed on the map (`Tokens.tsx:129` renders dead heroes at `h.last()` with `.dead-x` and the respawn badge unless hidden by Vision).
  - Resolve `trackedWorldPos()` in Scenes from `shownPlace(ms(), key, sceneShown())` combined with remote peer drag `remoteDrag.get(key)`:
    - While the local user is actively dragging the tracked token itself (`localDraggingKey() === key`), suspend pan updates until `pointerup` so moving the mouse doesn't shift the map under the pointer; on `pointerup`, glide (`200 ms`) to re-center on the dropped position.
    - When a **peer** drags the tracked hero (`Presence.drag`), or when the user switches scenes (`FLIP_MS`), the camera tracks the hero smoothly in real time.

---

## 5. View-State Registry & Presenter Follow (`AGENTS.md` §8)

Per `AGENTS.md` and `docs/specs/architecture-design.md` §8:
- **Should `trackedHero` be a `crates/engine/src/view_state.rs` key or a `web/test/view-state-ledger.ts` entry?**
  - **Answer: `web/test/view-state-ledger.ts` (`["wired", "view: drives the presenter's viewport, which followers mirror through view"]`).**
  - **Rigorous justification:**
    1. The presenter's `view()` (`{ x, y, w }`) is *already* synced to followers at 20 Hz via `Presence.view` (`Board.tsx:459-462`) and smoothed by `followSpring` (`web/src/board/follow.ts:52`). When a presenter tracks a hero (and zooms in/out while tracking), every follower automatically receives the presenter's exact hero-centered camera trajectory and zoom with zero extra wire keys and zero risk of two independent tracking loops fighting over `view()`.
    2. What if a **follower** double-clicks a hero or presses `F` on a hero to track them? Looking away to track a hero of your own choice is a camera movement (`Follow::Stop` semantics, identical to manual panning or clicking `focusHero` when `following()`). Calling `stopFollowing("tracked a hero")` in `startTrackHero` cleanly detaches the follower from the presenter (showing the existing `"Stopped following <Name> — tracked a hero"` toast with a 1-click `Resume` button) while keeping the presenter's active scene, playback clock, Vision, and layers.
- **Required ledger entry (`web/test/view-state-ledger.ts`):**
  ```ts
  "board/Board.tsx": {
    // ...existing entries...
    trackedHero: ["wired", "view: drives the presenter's viewport, which followers mirror through view"],
  },
  ```

---

## 6. Visual Indicators & §4b Copy

1. **Minimap Token Ring (`.tok.tracked` in `Tokens.tsx` & `minimap.css`):**
   - When `p.trackedHero === slotKey(m.team, m.slot)`, add class `tracked` to `<g class="tok">` and render `<circle class="tok-track-ring" r={R + 5.5} />` — a thin, high-contrast team-colored dashed/concentric ring outside the token border (distinct from the solid white `.tok-sel` selection ring and the transient `.focus-ring` ping).
2. **Top-Bar Portrait Accent (`.tb-player.tracked` / `.phone-hero.tracked` in `TopBarParts.tsx` & `topbar.css`):**
   - Add `classList={{ tracked: p.tracked }}` to `.tb-player` and `.phone-hero`, styling a subtle `1.5px solid var(--accent)` outline on `.tb-portrait` so the user can see at a glance in the top bar which hero the camera is locked onto.
3. **Dismissible Map Pill (`data-testid="track-chip"` in `.map-controls`, `Board.tsx:961`):**
   - Inside `.map-controls` (right next to the `.zoom-pill` `2.5×` reset button and `FollowChip`), render a compact dismissible pill whenever `trackedHero()` is set:
     ```tsx
     <Show when={trackedHeroInfo()}>
       {(info) => (
         <button
           type="button"
           class="btn small track-chip"
           data-testid="track-chip"
           onClick={() => setTrackedHero(undefined)}
           aria-label={`Stop tracking ${info().label}`}
         >
           <span class="track-dot" data-team={info().team} />
           <span>Tracking {info().label}</span>
           <span aria-hidden="true">×</span>
         </button>
       )}
     </Show>
     ```
   - `info().label` uses the hero's display name (`heroName(id)`, e.g. `"Infernus"`).
   - Because `.map-controls` is an existing floating overlay in the corner of `.minimap-stage`, this adds **zero layout height** on desktop, tablet, or phone.

---

## 7. Test Plan

1. **Unit & Ledger Tests (`web/test/view-state.test.ts`, `web/test/transform.test.ts`):**
   - `just web-test` passes `view-state.test.ts` with `trackedHero` registered in `web/test/view-state-ledger.ts`.
   - `centerViewOnWorld` centers the hero in both Amber and Sapphire viewpoints and clamps cleanly at map edges.
2. **Playwright E2E (`web/e2e/hero-camera-follow.spec.ts`):**
   - **Top-bar double-click:** Double-clicking a hero portrait zooms from fit view (`~1.08×`) to `2.5×` (`w = 400`), centers on the hero, displays `[data-testid="track-chip"]`, and does **not** leave the build column dropdown open over the map.
   - **Minimap token double-click:** Double-clicking a hero token in both Scenes and Player locks the camera onto the hero without dirtying undo history (in Scenes) or leaving a newly opened `HeroCard` blocking the map (in Player).
   - **Hover hotkey `F`:** Hovering a minimap token or top-bar portrait and pressing `F` starts tracking; pressing `F` again while hovered stops tracking; pressing `F` over empty map follows the presenter when one is active.
   - **Free zooming while tracking:** Scrolling the mouse wheel (and 2-finger pinch zoom on touch) changes zoom level (`view().w`) while keeping `[data-testid="track-chip"]` active and the hero centered as the timeline plays.
   - **Vision anti-leak:** Switch Vision to `Hidden King` (`1`) while tracking a Sapphire enemy hero; when the enemy enters fog of war with `Last seen` OFF, the camera holds at the fade-out position and never leaks their unseen coordinates.
   - **Cancellation:** Manual map drag, pressing `Escape`, or clicking `[data-testid="track-chip"]` clears tracking.
   - **Follower detachment:** If user B is following presenter A and user B double-clicks a hero to track, user B stops following presenter A (`"Stopped following … — tracked a hero"`).
