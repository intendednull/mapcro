# Doorman doorway indicators — UI/UX & visual design (Player + Scenes)

Status: Stage 1 design spec, 2026-11-24 (branch `doorman-doors-design`).
Ground-truth probe: `docs/research/doorman-doors.md` (match `142815246`, build `6865`).
Architecture references: `docs/specs/architecture-design.md` (§4a easing, §4b labels, §6b Player, §8 view state), `docs/specs/map-state.md` (§2 D3/D5, §4.2–§4.5 registry & storage), `docs/specs/map-state-phase5-plan.md`.

---

## 1. Minimap Little-Door Visual Design (Player + Scenes)

### 1.1 Icon, Asset Pack Binding & Inline SVG Fallback

- **Pack asset (`icons/doorman_doorway_psd`):**
  - Already extracted in all deployed asset packs (`6860-*`, `6861-*`, `6864-upgrades`) at `icons/doorman_doorway_psd.png` (`137 × 137 px`, pure white `#FFFFFF` alpha silhouette).
  - Register in `IMAGE_BLOBS` (`web/src/map/pack.ts`):
    ```ts
    "doorman-door": "icons/doorman_doorway_psd",
    ```
  - **Silhouette anatomy (`137 × 137` source canvas):**
    1. **Entry arrow (`▸`, left):** right-pointing triangle (`x = 19..32, y = 59..82`).
    2. **Open doorframe (`[`, middle-left):** left jamb (`x = 36..42, y = 23..117`) with top lintel and bottom threshold stubs (`x = 36..55`, thickness `6 px`).
    3. **Ajar door leaf (right):** perspective trapezoid swung open to the right (`x = 61, y = 7..132` front edge to `x = 103, y = 24..116` hinge edge) with a circular transparent doorknob cutout (`cx = 69, cy = 70, r = 5.5`).
- **Exact inline SVG / data-URI fallback (`DOOR_PATH` / `DOOR_FB`):**
  - When running without an asset pack (`!art.images.get("doorman-door")`), render the exact single-path `fill-rule="evenodd"` vector silhouette in `viewBox="0 0 137 137"`:
    ```svg
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 137 137">
      <path
        fill="#FFEFD7"
        fill-rule="evenodd"
        d="M19 59L32 70.5L19 82ZM36 23H55V29H42V111H55V117H36ZM61 7L103 24V116L61 132ZM69 64.5A5.5 5.5 0 1 0 69 75.5A5.5 5.5 0 1 0 69 64.5Z"
      />
    </svg>
    ```
- **Contrast, backing badge & shadow:**
  - The raw white door icon alone can blend into bright lane lines (`#FFDF40`, `#2EC7E6`), neutral camp triangles, or adjacent hero tokens.
  - Each door renders inside `<g class="pl-door">` as a compact circular badge centred at `worldToView(door.at, vp)`:
    1. **Outer shadow halo:** `filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.88))` on the badge group so it separates cleanly from lane lines, camp markers, and objective icons.
    2. **Dark backing disc (`.pl-door-bg`):** `<circle r={DOOR_R * k} />` filled with `#0b1714` (`fill-opacity: 0.92` when linked, `0.78` when unpaired).
    3. **Team-colored rim (`.pl-door-rim`):** stroke in the owning team's colour (`--team-c`, solid when linked, dashed when unpaired).
    4. **Little-door glyph (`.pl-door-art`):** `<image href={art.images.get("doorman-door") ?? DOOR_FB} />` (or inline `<path d={DOOR_PATH} />` fallback) centred at `x = -DOOR_GLYPH * k / 2, y = -DOOR_GLYPH * k / 2, width = DOOR_GLYPH * k, height = DOOR_GLYPH * k`, keeping the door silhouette crisp off-white/parchment (`#FFEFD7` / pack white) against the `#0b1714` disc for maximum luminance contrast.

### 1.2 Sizing & Responsive Scaling

In Deadlock's `hud_minimap.vcss`, `.map_button.doorman_doorway` sets `width: 50%; height: 50%` (`180 × 180` HUD px container for `#CastRange`) with `background-size: 10% 10%`, which equals **`18 × 18` HUD px** (`5%` of the `360 px` HUD minimap). Because `doorman_doorway_psd.png`'s opaque door leaf spans `91.2%` of its `137 × 137` canvas height (`y = 7..132`), drawing the raw glyph at `50` view units (`18 * HUD_PX`) would make the door leaf `45.6` view units tall — identical to a hero token (`2 * TOKEN_R = 46` view units).

To read as a **little door** subordinate to hero tokens while remaining crisp across desktop, tablet, and phone:

- **Scale factor:** Use `k = Math.min(1, view().w / 1000) * (phone ? 1.4 : 1)` (the same zoom-invariant, phone-boosted scale factor used by `Tokens`, `DeathSkulls`, `TeleporterLink`, `MarkerTips`, and `HoverLabels` in `Board.tsx`).
- **View-unit constants (at `k = 1`, `1000 × 1000` overlay viewBox):**
  - `DOOR_R = 14` view units (backing badge diameter `28 * k` view units = **`61%` of a hero token's `46 * k` diameter**, matching a camp/teleporter's visual weight).
  - `DOOR_GLYPH = 21` view units (door icon box `21 * k × 21 * k` view units inside the `28 * k` disc; the opaque door leaf is `~19.1 * k` view units tall).
  - `DOOR_HIT_MIN_PX = 22` screen CSS px radius (`44 × 44 CSS px` minimum touch target on coarse pointers via `<circle class="pl-hit" r={Math.max(DOOR_R * k, 22 * unitsPerPx())} />`).

| Viewport | Map container (`.mapbox` / `.p-map`) | Default `k` (`FIT_VIEW.w = 927.8`) | Badge diameter (`28 * k`) on screen | Door glyph (`21 * k`) on screen | Hero token (`46 * k`) reference | Touch / pointer hit diameter |
|---|---:|---:|---:|---:|---:|---:|
| **Desktop (`1920×1080`)** | `610 × 610 px` (clip `549 px`) | `0.928` | **`15.4 CSS px`** | **`11.5 CSS px`** | `25.3 CSS px` | `15.4 CSS px` |
| **Desktop with TopBar (`1280×800`)** | `480 × 480 px` (clip `432 px`) | `0.928` | **`12.1 CSS px`** | **`9.1 CSS px`** | `19.9 CSS px` | `12.1 CSS px` |
| **Narrow desktop (`800×600`)** | `300 × 300 px` (clip `270 px`) | `0.928` | **`7.6 CSS px`** | **`5.7 CSS px`** | `12.4 CSS px` | `12.0 CSS px` (min `8 * k` view units) |
| **Tablet (`1024×768`, coarse)** | `500 × 500 px` (clip `450 px`) | `1.299` (`1.4×`) | **`17.6 CSS px`** | **`13.2 CSS px`** | `28.9 CSS px` | **`44.0 CSS px`** |
| **Phone portrait (`390×844`)** | `374 × 374 px` (clip `337 px`) | `1.299` (`1.4×`) | **`13.2 CSS px`** | **`9.9 CSS px`** | `21.7 CSS px` | **`44.0 CSS px`** |
| **Phone short-landscape (`615×344`)** | `292 × 292 px` (clip `263 px`) | `1.299` (`1.4×`) | **`10.3 CSS px`** | **`7.7 CSS px`** | `16.9 CSS px` | **`44.0 CSS px`** |

### 1.3 Color & Team Encoding (Resolving the Amber/Sapphire Collision Hazard)

- **The In-World Color Collision Hazard:**
  - In Deadlock's 3D world, Valve renders the first door (`door1`) with a warm amber-gold rim (`m_ColorStart = #FFB433`) and the second door (`door2`) with a bright sky-blue rim (`m_ColorEnd = #4AADFF`).
  - On mapcro's 2D minimap, **Hidden King (Amber)** is `#f2a93b` (`var(--amber)`) and **Archmother (Sapphire)** is `#6d8cff` (`var(--sapphire)`). Using `#FFB433` for `door1` and `#4AADFF` for `door2` on the minimap creates a severe color collision: a linked pair looks like one Amber-owned door and one Sapphire-owned door, and an unpaired `door1` placed by a Sapphire Doorman renders in Amber's team colour.
- **Design Decision — Team-Tinted Rim + Crisp Off-White Door Glyph:**
  - Follow the exact convention of hero tokens (`.tok.amber`, `.tok.sapphire`), trooper dots (`.pl-trooper`), and rotation arrows (`.arw`) on `.mm-overlay.map`:
    - **Hidden King (`team === "amber"`):** `--team-c: var(--amber)` (`#f2a93b`) for the badge rim, subtle outer glow, and connecting link arc.
    - **Archmother (`team === "sapphire"`):** `--team-c: var(--sapphire)` (`#6d8cff`) for the badge rim, subtle outer glow, and connecting link arc.
    - **Door glyph inside the badge:** Always crisp off-white/parchment (`#FFEFD7` / raw white `doorman_doorway_psd.png`).
  - **Distinguishing `door1` vs `door2` without color collision:**
    - Once linked, Doorman's doorway is 100% bidirectional (`CCitadelPortalTrigger` on both ends) and both doors close on the exact same tick (`docs/research/doorman-doors.md` §2).
    - Every door element carries `data-role="unpaired" | "door1" | "door2"` in the DOM. Visually, both ends of a linked pair share their team's solid rim so team ownership is unambiguous at a glance, while **Unpaired Door 1** vs **Linked Pair (`door1 ↔ door2`)** have distinct visual states (§1.4).

### 1.4 Unpaired Door 1 vs Linked Pair (`door1 ↔ door2`)

Stage 0 confirmed that an unpaired Door 1 is a live `CCitadel_DoorwayPortal` (`m_hLinkedDoorway == 0x00FFFFFF`) that can sit staged on the map for up to **213.11 s** before linking or being cancelled (`4` unpaired doors in `142815246`), while a linked pair stays open for **8.12–35.02 s**.

| Visual property | Unpaired Door 1 (`.pl-door.unpaired`) | Active Linked Pair (`.pl-door.linked` + `.pl-door-link`) | Hovered / Selected Pair (`.pl-door.hot`, `.pl-door-link.hot`) |
|---|---|---|---|
| **Backing disc (`.pl-door-bg`)** | `#0b1714`, `fill-opacity: 0.78` | `#0b1714`, `fill-opacity: 0.92` | `#0b1714`, `fill-opacity: 0.96` |
| **Team rim (`.pl-door-rim`)** | Dashed (`stroke: var(--team-c)`, `stroke-width: 2 * k`, `stroke-dasharray: ${3.5 * k} ${2.5 * k}`) | Solid (`stroke: var(--team-c)`, `stroke-width: 2.4 * k`), subtle halo `drop-shadow(0 0 ${2.5 * k}px var(--team-c))` | Solid (`stroke: var(--text)`, `stroke-width: 2.6 * k`) + outer team ring `r = (DOOR_R + 3.5) * k` on **both** linked doors |
| **Door glyph (`.pl-door-art`)** | `opacity: 0.78` | `opacity: 1.0` | `opacity: 1.0`, `scale(1.08)` |
| **Connecting link line (`.pl-door-link`)** | None | Subtle quadratic Bézier arc between badge rims: dark casing (`#0b1714`, `stroke-width: 3`, `opacity: 0.35`) + team dashed thread (`stroke: var(--team-c)`, `stroke-width: 1.6`, `stroke-dasharray: 4 6`, `stroke-opacity: 0.52`, `vector-effect: non-scaling-stroke`) | Brightened team arc (`stroke: var(--team-c)`, `stroke-width: 2.2`, `stroke-dasharray: 5 5`, `stroke-opacity: 0.92`) |

- **Link arc geometry (short spans vs cross-map spans):**
  - Let `a = worldToView(door1.at, vp)` and `b = worldToView(door2.at, vp)`, with distance `d = Math.hypot(b.x - a.x, b.y - a.y)` and unit vector `u = ((b.x - a.x) / d, (b.y - a.y) / d)`.
  - **Trimmed endpoints:** Start at `a' = a + u * (DOOR_R * k)` and end at `b' = b - u * (DOOR_R * k)` so the line meets the outer edge of each badge and never crosses over the door glyphs.
  - **Short-span suppression (`d <= 2.4 * DOOR_R * k`):** When two doors are placed adjacent to each other (e.g. through a thin wall), the connecting line is omitted so the two badges sit cleanly side by side.
  - **Gentle curvature (`d > 2.4 * DOOR_R * k`):** Midpoint control point `c` is offset perpendicular to the chord by `bow = Math.min(26 * k, 0.12 * d)` toward the map centre `(500, 500)`, producing a subtle arc (`M a'.x a'.y Q c.x c.y b'.x b'.y`) that visually distinguishes a portal tunnel from straight coach rotation arrows (`.arw`) and lane ziplines.

### 1.5 Orientation

- **Decision:** Always render the little door icon **upright** (`0°` screen rotation in all viewpoints), ignoring `CCitadel_DoorwayPortal`'s `m_angRotation.yaw`.
- **Justification:**
  1. **In-game HUD parity:** Deadlock's `.map_button.doorman_doorway` in `hud_minimap.vcss` applies no yaw rotation and counter-scales under `.invert_map` so the door always stands upright.
  2. **Silhouette recognition:** `doorman_doorway_psd.png` is a perspective vertical door frame with a left-side entry arrow. Rotating it by world yaw (e.g. `102.9°` or `233.1°`) tips the door sideways or upside-down, destroying its instant readability at `12–15 CSS px`.
  3. **Wire efficiency:** Omitting `yaw` saves 1 integer per door in both `Timeline.doors` and `SceneState.more.doors`.

### 1.6 Z-Order & Hit-Testing

- **Stencil clipping:** Add `.mm-overlay.map > .pl-doors` to the map disc clip rule in `web/src/styles/minimap.css:29`:
  ```css
  .mm-overlay.map > .tokens, .mm-overlay.map > .pl-troopers, .mm-overlay.map > .picks, .mm-overlay.map > .pl-doors {
    clip-path: var(--mm-stencil-view);
  }
  ```
- **Exact SVG layer stack inside `svg.mm-overlay.map` (`Board.tsx` / `Layers.tsx`):**
  1. `<rect class="notes-area" />`
  2. `<TrooperDots />` (`.pl-troopers`)
  3. **`<DoormanDoors />` (`.pl-doors`: link arcs `.pl-door-link` first, then door badges `.pl-door`)**
  4. `<Layers />`:
     - `<g class="arrows">`
     - `<g class="inks">`
     - `<rect class="marquee">`
     - `<Tokens />` (`.tokens` + `.respawns`)
     - `<g class="picks">`
     - `<g class="callouts">`
     - `<g class="waves">`
     - `<g class="lasers">`
     - `<g class="pings">`
     - `<Cursors />`
  5. `<RiftRings />` (`.pl-rift-rings`)
  6. `<UrnMark />` (`.pl-urn`)
  7. `<DeathSkulls />` (`.pl-skulls`)
  8. `<TeleporterLink />` (`.tele-link`)
  9. `<MarkerTips />` (`.marker-tips`)
  10. `<Highlight />`, `<EventPings />`, `<HoverLabels />`
- **Why this Z-order:**
  - Doors sit **above** terrain, lane ziplines, static map markers (`.mm-objs`), and lane troopers so they are never buried under camp triangles or guardian diamonds.
  - Doors sit **below** hero `<Tokens />`, `<DeathSkulls />`, and coach annotations (`.arrows`, `.inks`, `.callouts`) so a hero standing inside a doorway always remains visible and clickable/draggable on top of the door, and rotation arrows drawn through a doorway remain unbroken.
- **Hit-testing rules:**
  - **In Player (`inPlayer() === true`):** `.pl-doors` has `pointer-events: none` so live drawing (`Draw`, `Arrow`, `Comment`, `Laser`, `Erase`) works over a door without interruption. Hover detection runs passively in `MarkerTips` (`Camps.tsx:204` `near(at)`):
    - In `HoverLabel.tsx`, `localHover()` checks `[token(), marker(), unit(), handle()]` in order, so a hero token over a door always wins hover.
    - Inside `MarkerTips` `near(at)`, visible doors are checked right after `urn()` (within radius `Math.max(8, DOOR_R * p.k)`) and before static `.mm-objs` markers, returning `door:<id>` (`kind: "marker", id: "door:<id>"`).
    - When `door:<id>` is hovered (locally or mirrored from a followed presenter via `Presence.hover`), `.pl-doors` highlights both the hovered door and its linked partner + link arc (`.hot`).
  - **In Scenes (`inPlayer() === false`):**
    - When `editor() && (tool === "select" || tool === "erase" || tool === "arrow")`, each `.pl-door` badge has `pointer-events: all` (link lines `.pl-door-link` always stay `pointer-events: none`).
    - Because `<Tokens />`, `.co`, `.wave-hit`, `.arrow`, and `[data-stroke]` sit above `<DoormanDoors />` in the SVG DOM, a hero token, comment, wave handle, or drawing on top of a door naturally receives pointer events first.
    - Starting an `Arrow` (`A`) drag on a `.pl-door` badge snaps `from` to the door's world position and adopts the door's `team` (`"Amber"` / `"Sapphire"`), just like starting an arrow on a hero token (`Layers.tsx:727-735`).

### 1.7 Vision / Fog-of-War Presentation

- **Player (`inPlayer() === true`):**
  - **All Vision (`vision === "all"`) & Own Team Vision (`vision === door.team`):** Drawn at full strength (`inSight = true` from spawn to deletion).
  - **Enemy Team Vision (`vision !== "all" && vision !== door.team`):**
    - Driven by real-time enemy line-of-sight (`door.inSight`, from `CCitadelTeam.m_vecFOWEntities` `m_eClass == 88` matched by entity index). As proven in Stage 0 (`docs/research/doorman-doors.md` §3), linked pairs flip `m_bVisibleOnMap` on the exact same tick, while an unpaired Door 1 flips independently.
    - Wrapped in `visionFade` (`web/src/board/fade.ts`, matching `UrnMark` in `Urn.tsx:53`): during continuous playback (`frame.smooth()`), a door or linked pair entering or leaving enemy sight fades in/out over `--value-ease-ms` (`350 ms` `easeOutExpo`; `0 ms` under `prefers-reduced-motion`). While fading out (`vf.leaving()`, `data-fading="out"`), its hover is immediately suppressed. On a seek, scrub, or Vision switch (`!frame.smooth()`), it snaps immediately.
    - **Never a last-seen ghost:** When unseen by the enemy team, the door is not drawn (`hidden`), regardless of `Show last seen location` (`vision.last_seen`).
- **Scenes (`inPlayer() === false`, `shown.ts` D3 rule):**
  - Follows map-state decision **D3** (`docs/specs/map-state.md` §2 D3):
  - Under `Vision: All`, `Vision: <door.team>`, or when `door.inSight === true`: drawn normally (`draw: "seen"`).
  - Under `Vision: <enemy team>` when `door.inSight === false` (captured unseen from replay or manually marked `Mark not seen`): drawn **faded in place** (`draw: "faded"`, class `.pl-door.faded`: `opacity: 0.42`, dashed rim, link arc dimmed to `stroke-opacity: 0.22`, plus a small `.vis.off` eye-slash badge at `translate(DOOR_R * 0.75 * k, -DOOR_R * 0.75 * k) scale(0.75 * k)` matching unseen hero tokens in `Tokens.tsx:530`).
  - Because unseen doors in a Scene are faded rather than hidden, an editor viewing under enemy Vision can still see, drag, toggle sight on, or remove them.

### 1.8 Hover Tooltips (Spec §4b Strict)

Per `docs/specs/architecture-design.md` §4b (*"Labels are tags, not prose. One to three words naming the thing... Use the game's word when the game has one"*), Deadlock's localized ability name for `ability_doorman_doorway` (`109766091` in `data/abilities.json`) is **`"Doorway"`**.

| Context | Door state | Hover label (`HoverLabel.tsx`) | `aria-label` on `<g class="pl-door">` |
|---|---|---|---|
| **Player** | Unpaired Door 1 (`role === "unpaired"`) | **`Doorway`** | `Hidden King Doorway` / `Archmother Doorway` |
| **Player** | Linked Door 1 or Door 2 (`role === "door1" \| "door2"`) | **`Doorway`** | `Hidden King Doorway` / `Archmother Doorway` |
| **Scenes** | Unpaired or Linked (seen or faded) | **`Doorway`** | `Hidden King Doorway` / `Archmother Doorway` |

- **Why no countdown timer (`"Closes in m:ss"`) in Player:**
  - Stage 0 (`docs/research/doorman-doors.md` §2) proved that 9 out of 10 linked pairs in `142815246` were closed early (`8.12–20.48 s`) before the `35.0 s` max modifier duration, and unpaired doors sat from `1.89 s` to `213.11 s` before linking or cancelling. Unlike deterministic server timers (Rift fade, camp respawn, Urn walk-back), `door.end_ds` is a player-chosen action; displaying `end_ds - t` leaks future player decisions, while displaying `35 - (t - link)` shows a false timer that vanishes early 90% of the time. Keeping the hover label **`"Doorway"`** matches carried `"Urn"` (`Urn.tsx:80`) and `"Wave"` (`Layers.tsx:1181`).

### 1.9 Map Layers Toggle Decision

- **Recommendation:** **Always-on when present** (no `Map layers` toggle; do **not** allocate bit 7 `0x80` of `Presence.layers: u8` in `crates/engine/src/view_state.rs`).
- **Justification:**
  1. **Zero visual clutter:** Matches without The Doorman have 0 doors. Matches with The Doorman have at most **2 small badges (`12–15 CSS px`)** on the map for brief 8–35 s windows (~10 times a match).
  2. **Consistent with high-signal map objects:** The Soul Urn (`UrnMark`), Unstable Rift (`RiftRings`), bridge powerups, death skulls (`DeathSkulls`), and map teleporters are all always-on without a `Map layers` toggle.
  3. **Preserves the last bit of `Presence.layers` (`u8`):** Bits `0..=6` (`0x01..=0x40`) are already assigned (`troopers`, `health`, `pings`, `cc`, `movement`, `heals`, `crates`). Bit 7 (`0x80`) is the final remaining bit in `layers: u8` (`view_state.rs:533`) and should be reserved for a dense map-wide layer rather than a single hero's ability.
  4. **Direct manipulation in Scenes:** If a coach manually places a doorway on a tactical board, a turned-off `Map layers` toggle would hide the doorway they just placed.

---

## 2. Scene Interaction & Manual Placement UX (Release 2)

### 2.1 Replay-Saved Scenes (`Save scene` & `Retake`)

- **`Save scene` at playback time `t` (`web/src/match/save.ts`):**
  - Captures all active doors at `second = Math.floor(t)` from `secondPart(tl, second, markers).doors` (or `tenthPart` at `second * 10`), including each door's `team`, world `(x, y)`, `role` (`unpaired` / `door1` / `door2`), `partner` index, and enemy sight (`unseen = !inSight`).
  - Sets `has_doors: true` and `doors: [...]` (omitted when 0 doors are active) on `SceneState.more` in the single Save transaction.
- **`Retake` on an older scene (`canRetake` & `retakeOps`):**
  - When a scene saved from the open replay match lacks `has_doors` (`!captured(state).doors`), `canRetake` returns `true` and `retakeOps` backfills `has_doors: true` and `doors` at `scene.source.t` via `SetIf` on absent keys.
- **`New scene` (`+` / `T`) & `Duplicate`:**
  - Inherit `SceneState.more` (`has_doors` and `doors`) along with the scene's heroes, objectives, and waves, so a coach stepping a play across consecutive scenes keeps the placed doors ready to move or remove in the next frame.

### 2.2 Manual Placement Entry Points (Zero Toolbar Bloat, Zero Phone Height Added)

We evaluate the three candidate entry points against desktop discoverability, blank-board coaching (before or after picking Doorman), and the strict phone vertical height budget (Pass 005 `FM-130`):

| Candidate | Desktop UX | Phone (`390×844` / `615×344`) UX | Blank board (no Doorman picked yet) | Verdict |
|---|---|---|---|---|
| **1. Doorman hero context menu** (`hero-menu` on portrait or token when `hero_id === 69`) | Right-click Doorman's top-bar portrait or map token → **`Place doorway`** / **`Clear doorways`** | Long-press Doorman's map token in `Edit` + `Select` → **`Place doorway`** / **`Clear doorways`** | Requires picking Doorman into a slot first | **Adopt (entry point A)** |
| **2. Empty-map context menu in `Select` tool** (stationary right-click `< 4 px` or touch long-press on empty map) | Right-click any empty map spot in `Select` (`Q`) → **`Place doorway`** places Door 1 right at the cursor | Long-press any empty map spot in `Edit` + `Select` → **`Place doorway`** places Door 1 right at the finger | Works immediately even before picking heroes (offers King / Archmother when Doorman isn't assigned to one team) | **Adopt (entry point B)** |
| **3. Toolbar button / tool mode** (`.toolbar` / `.p-tools`) | Adds a 7th hero-specific button to the 6 core tools (`Q W E A S D`), crowding `.toolbar` (`610 px`) | Risks wrapping `.p-tools` to a second row, stealing `~38 px` of vertical map height | Always visible, but disproportionate for 1 hero out of 38+ | **Reject** |

- **How Entry Point B (Empty-Map Context Menu in `Select` Tool) resolves team ownership:**
  - Today in `Layers.tsx:617-625`, a stationary right-click (`button === 2`, drag `< 4 px`) or touch long-press (`hold(e)`) in `Select` tool opens `hero-menu` on a `.tok` or `placed-menu` on a `[data-callout]` / `[data-arrow]` / `[data-stroke]`, and does **nothing** on empty map.
  - In a Scene (`!inPlayer() && editor() && tool === "select"`), a stationary right-click or touch long-press on empty map (inside the playable map disc, outside any objective marker) opens `<ContextMenu label="Map" testid="map-menu">`:
    - **Case 1 — Exactly one team has The Doorman (`hero_id === 69`) in the scene:**
      - Shows a single item: **`Place doorway`** (`testid="map-menu-doorway"`), bound to Doorman's team.
    - **Case 2 — Neither team (blank board / other heroes) or both teams have The Doorman:**
      - Shows two items, ordered with the viewer's friendly side (`vp === "sapphire" ? "sapphire" : "amber"`) first, using `teamShort` (`web/src/map/model.ts:103`):
        - **`Place King doorway`** (`testid="map-menu-doorway-amber"`)
        - **`Place Archmother doorway`** (`testid="map-menu-doorway-sapphire"`)
- **How Entry Point A (Doorman Hero Context Menu) works:**
  - In `TopBar.tsx` (`menuView`), when the right-clicked portrait or map token holds The Doorman (`heroIn(m) === 69`), append to `hero-menu`:
    - **`Place doorway`** (`testid="hero-menu-doorway"`):
      - If opened from Doorman's **portrait** in the top bar: arms `Select` tool into step-1 doorway placement (`placingDoor = { team }`), so the coach's next click/tap on the map places Door 1.
      - If opened from Doorman's **token on the map**: places Door 1 right beside Doorman's token (`clampToDisc({ x: pos.x + 280, y: pos.y })`) and immediately enters step-2 link preview for Door 2!
    - **`Clear doorways`** (`testid="hero-menu-clear-doors"`, shown when that team has `>= 1` door in the scene): removes all doors belonging to that team in one transaction.

### 2.3 Two-Step Placement Flow (Door 1 → Live Preview Link → Door 2 or Unpaired)

```
 [Entry: Map menu "Place doorway" at P1]       [Entry: Portrait menu "Place doorway"]
                 │                                              │
                 ▼                                              ▼
      ┌─────────────────────┐                        ┌─────────────────────┐
      │ Step 2: Door 1 @ P1 │◄─── Click/tap P1 ──────│ Step 1: Armed (team)│
      │ Live link arc to    │                        │ Crosshair cursor    │
      │ pointer / 2nd tap   │                        └─────────────────────┘
      └──────────┬──────────┘
                 │
     ┌───────────┴───────────────────────────────┬──────────────────────────┐
     │ Click/tap P2 (>= 12 view units from P1)   │ Click/tap P1 (< 12 u)    │ Escape / Right-click /
     │                                           │ or press Enter           │ Tool switch (W E A S D)
     ▼                                           ▼                          ▼
┌──────────────────────────┐        ┌──────────────────────────┐   ┌────────────────────┐
│ Commit Linked Pair       │        │ Commit Unpaired Door 1   │   │ Cancel preview     │
│ (Door 1 @ P1 ↔ Door 2 @P2│        │ (Door 1 @ P1, partner=-1)│   │ (0 ops written)    │
│  in 1 transaction)       │        │  in 1 transaction        │   └────────────────────┘
└──────────────────────────┘        └──────────────────────────┘
```

- **Ephemeral placement state (`placingDoor` signal in `Layers.tsx`):**
  - Holds `{ team: "amber" | "sapphire"; door1?: WorldPos; pointer?: Pt } | undefined`.
  - While `placingDoor` is active:
    - If `door1` is set (Step 2), the overlay renders a preview Door 1 badge at `door1`, a live dashed team link arc (`.pl-door-link.preview`) from `door1` to `pointer`, and (on mouse/pen) a ghost Door 2 badge at `pointer`.
    - **Commit linked pair (`door1 ↔ door2`):** Left-clicking or tapping any map spot `P2` at least `12` view units away from `door1` commits both doors (`role: "door1"` at `door1`, `role: "door2"` at `clampToDisc(world(P2))`, linked to each other, `inSight: true`) in **one atomic transaction** (1 undo step) and clears `placingDoor`.
    - **Commit unpaired Door 1:** Left-clicking or tapping on the preview Door 1 itself (`< 12` view units from `door1`) or pressing **`Enter`** commits Door 1 alone as an unpaired door (`role: "unpaired"`, `partner: null`, `inSight: true`) in **one atomic transaction** (1 undo step) and clears `placingDoor`.
    - **Cancel:** Pressing **`Escape`**, right-clicking, or switching tools (`W E A S D`) clears `placingDoor` with zero ops committed.
  - **Team replacement rule on placement:**
    - In Deadlock, a team's Doorman has one Doorway ability (`max 1 pair = 2 doors` per team). Placing a new doorway for team `T` in a Scene replaces any existing door(s) of team `T` in the same `Set More { key: "doors", ... }` op (while preserving the other team's doors, up to `MAX_DOORS = 4` total across both teams). One `Ctrl+Z` restores the previous doors.

### 2.4 Direct Manipulation (`Select` `Q`, `Erase` `D`, & Door Context Menu)

- **Dragging a door in `Select` tool (`Q`):**
  - Left-pressing (`button === 0`, `!spaceHeld()`) and dragging a `.pl-door` badge in `Select` moves that door live across the map (`clampToDisc`), updating its connecting `.pl-door-link` arc every frame.
  - While dragging, local state holds `dragDoor: { index: number; pos: WorldPos }` and broadcasts presence `st.presence({ drag: { id: doorDragId, pos }, focus: doorDragId })` so peers see the door and its link arc glide live with `<NameTag what="moving" />`.
  - On pointer release (`moved === true`), commits **one transaction** writing the updated `doors` array to `SceneState.more` (creating `SceneState` with `has_doors: true` if the scene is a fresh blank board that had no `SceneState` yet).
- **Door Context Menu (`door-menu`, Right-click or Touch Long-press on `.pl-door` in `Select`):**
  - Opens `<ContextMenu label="Doorway" testid="door-menu">` with spec §4b labels:

| Condition | Menu item label | `data-testid` | Action (1 transaction / 1 undo step) |
|---|---|---|---|
| Door is unpaired (`partner === null`) | **`Link second door`** | `door-menu-link` | Enters Step-2 live link preview anchored at this door's position; next map click/tap places & links Door 2 |
| Door is linked (`partner !== null`) | **`Unlink door`** | `door-menu-unlink` | Removes this door and converts its partner to an unpaired Door 1 (`role: "unpaired"`, `partner: null`) |
| Always (enemy sight toggle, matching `hero-menu-vision`) | **`Mark not seen`** (when `inSight`) / **`Mark in vision`** (when `!inSight`) | `door-menu-vision` | Toggles `unseen` (`0 ↔ 1`) on this door **and its linked partner in lockstep** (matching Deadlock's FOW lockstep rule); sets `has_sight: true` on `SceneState.more` if unset |
| Always | **`Remove doorway`** | `door-menu-remove` | Deletes the doorway (the unpaired door, or **both** doors of a linked pair) |

- **`Erase` Tool (`D`) and Hover + `D` Key:**
  - Each `.pl-door` badge carries `data-erase-door={index}`.
  - In `Erase` tool (`D`), hovering or scrubbing over a `.pl-door` dims the doorway (both doors and their link arc if linked, `.erasing`), and releasing commits **one transaction** removing the doorway (the unpaired door or the linked pair).
  - Pressing `D` while hovering a `.pl-door` in any tool (`Layers.tsx:792-805`) immediately deletes that doorway in one transaction.
- **Undo / Redo Atomicity:**
  - Every doorway operation (place pair, place unpaired, link second door, drag door, unlink door, toggle sight, remove doorway) writes a single transaction to `SceneState.more` (`doors`, plus `has_doors: true` / `has_sight: true` when first initialized), so every edit is **one atomic undo/redo step**.

### 2.5 `Clear` Menu (`ClearKind`) Boundary

- `Clear` (`C` / `Shift+C` in `Toolbar.tsx`: `Ink`, `Arrows`, `Comments`, `All`) clears **only** freehand annotations (`Stroke`, `Arrow`, `Callout`).
- Doorman doors are map-state entities (like heroes, objective statuses, lane waves, camps, rifts, and the Soul Urn) and are **never touched by `Clear`**. They are removed via `Erase` (`D`) on a door, `Remove doorway` in `door-menu`, `Clear doorways` in Doorman's `hero-menu`, or scene deletion.

### 2.6 Touch / Phone (`390×844 --touch` & `615×344 --touch`) Ergonomics

- **Zero vertical height added:** No new elements in `.p-top`, `.p-tools`, `.p-bar`, or `.pl-bar.scene`.
- **44×44 CSS px hit area:** Every `.pl-door` renders `<circle class="pl-hit" r={Math.max(DOOR_R * p.k, 22 * p.unitsPerPx())} />` so fingers easily grab or long-press a `13.2 CSS px` door badge on a `390×844` phone.
- **Touch gestures:**
  - **Player / View-only mode:** Tapping a door shows the `"Doorway"` hover label and highlights the linked pair; tapping again or away dismisses it (`MarkerTips` touch `pointerdown`).
  - **Scene `Edit` mode (`Select` tool):**
    - **1-finger drag** on a door moves it live with its connecting link arc.
    - **Long-press (`500 ms`, `longPress.ts`)** on a door opens `door-menu` (`min-height: 44px` buttons).
    - **Long-press (`500 ms`)** on empty map opens `map-menu` (`Place doorway`), placing Door 1 at the touch point; the coach then taps a second spot to link Door 2 (or taps Door 1 again to leave it unpaired).

---

## 3. Exact Data Contract for Technical Spec

### 3.1 Player Timeline Contract (`Timeline.doors`)

- **Rust (`crates/replay/src/timeline.rs`) & TypeScript (`web/src/match/timeline.ts`):**
  - Top-level field on `Timeline`:
    ```rust
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub doors: Vec<Doorway>,
    ```
  - Per-door record (`Doorway` / `TimelineDoor`):

| Field | Rust type | TS type | Description & bounds |
|---|---|---|---|
| `id` | `u16` | `number` | Dense sequential spawn index (`0..doors.len()`), independent of Source 2 entity slot reuse. |
| `team` | `Team` | `"amber" \| "sapphire"` | Owning team (`m_iTeamNum`: `2` = `"amber"`, `3` = `"sapphire"`). |
| `x` | `i32` | `number` | World X coordinate, rounded to integer world units (`-10752..=10752`). |
| `y` | `i32` | `number` | World Y coordinate, rounded to integer world units (`-10752..=10752`). |
| `start_ds` | `u32` | `number` | Spawn time in tenths of a second (`floor(t_spawn * 10)`). |
| `link_ds` | `Option<u32>` | `number \| null \| undefined` | Tenth of a second when linked (`None` if never linked; equals `Some(door2.start_ds)` for both doors of a pair). |
| `end_ds` | `u32` | `number` | Deletion (or match-end) time in tenths of a second (`ceil(t_delete * 10)`). |
| `partner` | `Option<u16>` | `number \| null \| undefined` | Partner dense sequential `Doorway::id` once linked (`None` if never linked). |
| `seen` | `Vec<[u32; 2]>` | `Array<[number, number]>` | Enemy FOW visibility intervals `[start_ds, end_ds)` in tenths of a second (`m_bVisibleOnMap == true` in enemy `CCitadelTeam.m_vecFOWEntities`). |

- **Derivation at playback time `t` (computed on `TenthPart` clock at `ds = Math.floor(t * 10) + 0.5`):**
  - A door is live at `ds` iff `door.start_ds <= ds && ds < door.end_ds`.
  - A live door is linked at `ds` iff `door.link_ds != null && ds >= door.link_ds && door.partner != null` and the partner door is also live at `ds`.
  - `role`:
    - If not linked at `ds`: `"unpaired"` (`partner: null`).
    - If linked at `ds`: `"door1"` if `door.start_ds < partner.start_ds || (door.start_ds === partner.start_ds && door.id < partner.id)`, else `"door2"`.
  - `inSight`: `true` if `!hasVision(tl)` or `door.seen.some(([a, b]) => ds >= a && ds < b)`, else `false`.

### 3.2 Unified `MapState` & `shown.ts` Contract

- **`FEATURES` (`web/src/mapstate/state.ts`):** Append `"doors"` (`featuresOf(m).doors = !!m.doors?.length`).
- **`SceneFacts.doors` (`web/src/mapstate/state.ts`):**
  ```ts
  export interface DoorNow {
    /** Dense door index (`0..3` in a scene, `0..doors.len()` in Player). */
    id: number;
    team: "amber" | "sapphire";
    at: { x: number; y: number };
    role: "unpaired" | "door1" | "door2";
    /** Partner door's `id` when currently linked; `null` when unpaired. */
    partner: number | null;
    /** Whether the enemy team has this door in sight (`true` when seen). */
    inSight: boolean;
  }
  ```
- **Viewer projection `shownDoors(ms: MapState, vision: Vision, stored: boolean)` (`web/src/mapstate/shown.ts`):**
  ```ts
  export interface ShownDoor extends DoorNow {
    draw: "seen" | "faded" | "hidden";
  }
  ```
  - When `!ms.has("sight") || vision === "all" || door.team === vision || door.inSight`: `draw = "seen"`.
  - Else when `stored` (Scene editor, D3): `draw = "faded"`.
  - Else (Player under enemy Vision when `!door.inSight`): `draw = "hidden"` (fed into `visionFade`).

### 3.3 Scene Storage Contract (`crates/schema/src/map_state.rs` & `web/src/mapstate/codec.ts`)

- **Registry rows (appended to `ROWS` at indices `40` and `41`):**
  - `Status::Ahead` in Release 1 (Reader); `Status::Live` in Release 2 (Writer, store `v18` floor `17`, board-file `version: 7, rows: 42`):
    ```rust
    // Row 40: whether the scene captured (or edited) Doorman doorways.
    ahead("has_doors", Entity::Scene, Kind::Bool),
    // Row 41: packed doorway list on SceneState, up to 4 doors × 6 ints = 24 ints.
    ahead("doors", Entity::Scene, Kind::Ints { len: 24, min: -16384, max: 16384 }),
    ```
- **Cap & stride (`MAX_DOORS = 4`, `DOOR_STRIDE = 6`, max `24` ints):**
  - Each door is packed as 6 consecutive integers `[teamCode, x, y, roleCode, partnerIdx, unseenInt]`:

| Offset | Field | Encoding | Valid range |
|---:|---|---|---|
| `0` | `teamCode` | `0` = `"amber"`, `1` = `"sapphire"` (`encodeTeam` / `decodeTeam`) | `0..=1` |
| `1` | `x` | World X in integer world units (`Math.round`, clamped to `[-10752, 10752]`) | `-16384..=16384` |
| `2` | `y` | World Y in integer world units (`Math.round`, clamped to `[-10752, 10752]`) | `-16384..=16384` |
| `3` | `roleCode` | `0` = `"unpaired"`, `1` = `"door1"`, `2` = `"door2"` | `0..=2` |
| `4` | `partnerIdx` | 0-based index (`0..3`) of partner door in `doors` (`-1` when `roleCode === 0`) | `-1..=3` |
| `5` | `unseenInt` | `1` when `!inSight` (hidden from enemy team), `0` when `inSight` | `0..=1` |

- **Defensive decoder invariants (`decodeDoors` in `web/src/mapstate/codec.ts`):**
  - Uses `strides(v, 6)`; returns `[]` if `v` is absent or not a multiple of 6 integers, or if `rows.length > MAX_DOORS` (`4`).
  - Each entry's `x, y` is clamped with `clampToMap({ x, y })`; invalid `teamCode` (`!== 0 && !== 1`) or `roleCode` (`< 0 || > 2`) drops the malformed entry.
  - Partner integrity check: if `roleCode !== 0`, `partnerIdx` must name a distinct valid entry `j !== i` (`0 <= j < rows.length`) of the **same `team`** whose own `partnerIdx === i`; otherwise the door degrades gracefully to `role: "unpaired", partner: null`.
  - Round-trip property (`docs/specs/map-state.md` §9): `decodeDoors(encodeDoors(doors))` equals `doors` identically for all valid frames.
- **Budget check:**
  - `Entity::Scene` total `Ints` length increases from `800` to **`824`** (`<= LIMITS.max_more_ints = 1,280`).
  - JSON size on `SceneState.more`: `0 B` when match has no Doorman; `~18 B` (`"has_doors":true`) when Doorman has 0 doors up at `t`; `~65 B` for 1 linked pair (2 doors); `~125 B` max for 4 doors.
