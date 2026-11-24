# Living Feature Map

Ground-truth map of mapcro's user-facing features, seeded by auditing `web/src/`, `web/e2e/`, and
`web/test/` on 2026-11-21 (commit `8ec46d1`).

- **Interactive Depth:** `unmapped` (no exploratory pass, no automated test) | `auto-only` (has
  automated tests, not yet explored interactively) | `smoke` (happy path explored interactively) |
  `deep` (edge cases, viewports, keyboard/touch, and/or multi-user explored interactively).
- Every exploratory pass updates `Interactive Depth`, `Last Pass`, and `Issues / Notes` for the rows
  it touches. See [`README.md`](README.md) for the loop and triage rules.

---

## 1. Landing & Boards

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-001 | Landing | Landing page (`/`): wordmark, New board creation, navigation to `/b/<id>#<tok>` | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/home.spec.ts` | Pass 006: verified wordmark, `New board` → `/b/<id>#<tok>`, Match ID `129738985` quick-open, and Phone `390×844 --touch` (`scrollW === clientW === 390`, `newBoardBtn: 107×46`) live on prod |
| FM-002 | Landing | Recent/known boards list, rename/remove with Undo toast | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/boards-list.spec.ts`, `test/known-boards.test.ts` | Duplicate toast markup (TD-38); Pass 002 #1 verified working-as-designed (`boards-list.spec.ts:130` opens `/b/<id>` to edit CRDT title); Remove + Undo toast verified |
| FM-003 | Landing | Open link dialog / keyboard shortcut (`OpenLinkKeys`) & dead/malformed `/b/` or `/s/` link (`DeadLink`) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/open-link.spec.ts`, `test/applink.test.ts` | Pass 006: verified `Ctrl+L` no-op in browser (desktop-app-only) & all 4 dead/malformed `/b/` and `/s/` URLs (with & without `#badtoken`) render clean `Invalid link` + `New board` recovery live on prod |
| FM-004 | Landing | Desktop app download link/dialog from web (`AppDownload`) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/app-download.spec.ts`, `test/desktop-release.test.ts` | Pass 006: verified all 3 Linux AppImage links (`app-get-home`, `app-get-landing`, `app-get-help` inside `Where's my replay?` disclosure, `download: true`, `target: null`), GitHub link, and Phone `390×844 --touch` layout live on prod |
| FM-005 | Landing | New session creation from landing / recent sessions list | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/sessions.spec.ts`, `e2e/sessions-polish.spec.ts` | Pass 006: verified board promotion via `+ Add game → New board`, inline Session rename, and return to `/` listing recent 2-game Session under `Your boards` live on prod |

## 2. Board Shell & Header

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-010 | Header | Board header: inline board title edit, mode switcher (Scenes / Player), status indicator | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/header.spec.ts`, `e2e/status.spec.ts`, `test/status.test.ts` | Pass 004: verified `800×600` header fits `800/800` live on prod with Presenting + Full replay + Feedback |
| FM-011 | Header | Top bar (`TopBar.tsx` / `TopBarParts.tsx`): 6v6 hero portraits, team names, Rejuvenator indicator, souls/clock | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/topbar.spec.ts`, `e2e/topbar-rejuv-builds.spec.ts`, `e2e/team-names.spec.ts` | Scene & Player top bars partially duplicated (TD-11); Pass 004: verified legible souls banners & Rejuvenator HUD across `1440×900`, `1024×600`, `800×600`, `1024×768` touch, and `390×844` touch |
| FM-012 | Header | Portrait context menu (`portrait-menu`): focus hero, toggle alive/dead, open build/stat panel | `deep` | Pass 003 (2026-11-21, 8c6ec5e) | `e2e/portrait-menu.spec.ts`, `e2e/hero-focus.spec.ts` | Pass 002: `Change hero…`; Pass 003: `Kill`, `Mark not seen`, `Rename…`, `Change hero…` & portrait build open verified |
| FM-013 | Header | More menu (`MoreMenu.tsx`): clone board, export/import board file, feedback, session promotion | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/board-file.spec.ts`, `e2e/clone-replay.spec.ts`, `e2e/feedback.spec.ts` | Pass 005: verified TD-117 `More → Open in app` carries `mapcro://s/<session>?tab=<tab>#<tok>` with strict owner vs guest token isolation live on prod |
| FM-014 | Header | Feedback button & GitHub issue submission dialog (`Feedback.tsx`) | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/feedback.spec.ts`, `test/feedback.test.ts` | Pass 005: verified Argon Phone `390×844` & `360×800` icon-only `44×44` `feedback-open` unclipped, Player `More → Feedback` accessible, and desktop dialog auto-focus, match context checkbox, and `Escape` focus-restore live on prod |
| FM-015 | Header | Dialog focus management & modal scrim (`ModalScrim.tsx`, Esc to close, focus trap) | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/dialog-focus.spec.ts` | Pass 005: verified focus-in and `Escape` focus-restore across `Feedback` (`feedback-open`), `Share` (`session-share`), `More → Clone` (`more`), and `HeroPicker` live on prod |

## 3. Scenes & Roster

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-020 | Scenes | Scene list / tree (`SceneTree.tsx`): create, rename, reorder, nest/group, delete scenes | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/scenes.spec.ts`, `e2e/scene-tree.spec.ts`, `test/scenes.test.ts`, `test/tree.test.ts` | Pass 002: `+` & `T`, 48-char rename + tree ellipsis, drag-nesting verified |
| FM-021 | Scenes | Scene cloning (`CloneDialog.tsx` / duplicate scene with heroes, drawings, objectives) | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/scene-clone.spec.ts`, `test/scene-copy.test.ts` | Pass 004: verified inline `scene-clone` duplicates saved replay scene (`Match moment` → `Match moment copy`) on re-imported board |
| FM-022 | Scenes | Scene note editor (`note`): write, blur-save, sync across peers | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/note.spec.ts` | Pass 002: blur-save on scene flip verified cleanly |
| FM-023 | Scenes | Scene names & player names toggle on tokens | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/scene-names.spec.ts` | Pass 005: verified `Player names` (`names-toggle`) in Scene `Map layers` on saved R2 `31:20` scene toggles cleanly with TopBar & `HoverLabel` live on prod |
| FM-024 | Scenes | Scene builds (saved item/ability builds per hero on a scene, open/close build panels) | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/scene-builds.spec.ts`, `test/map-state-build.test.ts`, `test/map-state-save.test.ts` | Phone scene builds in backlog; Pass 005: verified saved R2 `31:20` scene single hero build panel (K/D/A, calculated stats, abilities, `Build order`, 11 items), `All builds` (12 cols), and inline `souls-banner` edit live on prod |
| FM-025 | Roster | Hero picker (`HeroPicker.tsx`): assign/swap/clear 6v6 roster slots, uniqueness constraint | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/scene-hero.spec.ts`, `e2e/hero-unique.spec.ts`, `test/roster.test.ts`, `test/scene-hero-pick.test.ts`, `test/labels.test.ts` | Pass 004: verified disabled tiles carry clean §4b `title="<Hero>"` live on prod |

## 4. Map Canvas & Drawing Tools

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-030 | Map | Map pan, zoom (wheel / pinch), fit-to-view, stencil edge clipping (`MapView.tsx`, `stencil.ts`) | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/fit.spec.ts`, `e2e/map-edge-clip.spec.ts`, `e2e/map-stencil-edge.spec.ts`, `test/stencil.test.ts` | Drag clamp disc vs stencil (TD-31); Pass 004: verified wheel zoom, drag pan, zoom reset, and stencil clipping on live prod |
| FM-031 | Map | Asset pack loading & fallback vector map (`pack.ts`, `fallback-data.ts`, `map-furniture`) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/pack.spec.ts`, `e2e/map-furniture.spec.ts`, `test/map-furniture.test.ts` | Pass 006: verified `/api/packs` lists `6864` (`62feb9ec...`) first and all `450` `<img>` + `15` `<svg image>` pack assets load with `brokenCount: 0` live on prod |
| FM-032 | Drawing | Toolbar & tool keyboard shortcuts (`Q`/`W`/`E`/`A`/`S`/`D`/`C`, select, laser, draw, arrow, comment, erase, clear) | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/tools.spec.ts`, `e2e/tool-keys.spec.ts`, `test/tool-keys.test.ts` | Pass 002: all hotkeys + §4b `title` labels verified |
| FM-033 | Drawing | Palette (`Palette.tsx`): stroke colours, line styles, palette in Player mode | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/palette.spec.ts`, `e2e/palette-player.spec.ts`, `test/recolour.test.ts` | Pass 005: verified all 7 Palette swatches (`Parchment`–`Cinnabar`), swatch switching (`Rose` → `Brass`), and Brass stroke draw on saved R2 Scene live on prod |
| FM-034 | Drawing | Freehand strokes, arrows, selection & move/delete, bulk clear (`clear-many`), selection colour | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/tools.spec.ts`, `e2e/clear-many.spec.ts`, `e2e/selection-colour.spec.ts`, `test/stroke-move.test.ts` | Pass 002: strokes, arrows, Clear menu counts, multi-user sync + undo/redo verified |
| FM-035 | Drawing | Laser pointer & ephemeral live ink gestures (`laser-gestures`, `fade.ts`) | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/laser-gestures.spec.ts`, `test/live-ink.test.ts` | Pass 005: verified live fading laser trail (`W`, `laserPaths: 2`) on saved R2 Scene alongside isolated `guest` peer live on prod |
| FM-036 | Drawing | Placeables & markers (wards/pings/callouts/icons), right-click context menu on placed items | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/placeables.spec.ts`, `e2e/markers.spec.ts`, `e2e/placed-menu.spec.ts`, `e2e/context-menu.spec.ts` | Pass 002: `placed-menu` on comment (side, 7 colours, `No colour`) & arrow recolour verified |
| FM-037 | Drawing | Map comments / annotations (`comments.spec.ts`, `commentLayout.ts`) | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/comments.spec.ts`, `e2e/comments-audit.spec.ts`, `test/comments.test.ts` | Pass 002: create, side placement, recolour, and `.mapcro` round-trip verified |
| FM-038 | Drawing | No accidental text selection while dragging on map (`no-select`) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/no-select.spec.ts` | Pass 006: verified `window.getSelection().toString() === ""` across map drag-pan, freehand stroke draw, hero token drag, and map double-click live on prod |

## 5. Heroes & Tokens

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-040 | Tokens | Dragging hero tokens on map, smooth interpolation, live drag preview across peers | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/board.spec.ts`, `e2e/heroes-live.spec.ts`, `test/smooth.test.ts` | Pass 005: verified hero token drag on saved R2 `31:20` Scene syncing live in real time to isolated `guest` peer live on prod |
| FM-041 | Tokens | Hero focus highlight & dimming other tokens (`hero-focus`) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/hero-focus.spec.ts` | Pass 006: verified portrait `focus-hero` flashes `.focus-ring` on target hero (`Amber-0` & `Sapphire-0`) while zoomed in live on prod |
| FM-042 | Tokens | Hover label (`HoverLabel.tsx`): instant/clean hero & marker hover, silent when hidden | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/hover-hidden.spec.ts`, `test/hover-label.test.ts`, `test/labels.test.ts` | Browser `title` lag outside hero panel (TD-46); hidden marker silence gap (TD-14); Pass 005: verified `HoverLabel` & objective `aria-label` §4b compliance on saved R2 Scene tokens & markers live on prod |
| FM-043 | Tokens | Hero state in scenes: alive/dead, out-of-sight fade | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/player-vision.spec.ts`, `test/shown.test.ts` | Pass 005: verified Phase 5 R2 Q3 `[data-testid=tok-health]` arcs (`10 → 0 → 10`), Q2 sight & `Mark not seen`/`Mark in vision` (no fade under All Vision), and `K` kill/revive live on prod |

## 6. Objectives, Camps & Lanes

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-050 | Objectives | Objective states on map (Guardians, Walkers, Base Guardians, Shrines, Patrons): toggle/click in scenes | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/objectives.spec.ts`, `test/objectives.test.ts` | Pass 006: verified click-toggle across all 5 objective types (Guardian, Walker, Base Guardian, Shrine, Patron → `Stage2`) + `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo + live sync to isolated `coachB` on prod |
| FM-051 | Objectives | Objective hover tooltips & respawn/health bars in Player | `deep` | Pass 003 (2026-11-21, 8c6ec5e) | `e2e/player-objective-tips.spec.ts`, `test/objective-tips.test.ts` | Pass 003: audited Guardian, Walker, Mid-Boss, Sinner's Sacrifice, Powerup, Urn SVG `hover-label` & `aria-label` — all §4b-clean |
| FM-052 | Lanes/Camps | Lanes, ziplines, jungle camps, Sinner's Sacrifice, Mid Boss, buffs, breakables/crates | `deep` | Pass 003 (2026-11-21, 8c6ec5e) | `e2e/player-lanes-camps.spec.ts`, `e2e/heavy-boxes.spec.ts`, `test/lanes.test.ts`, `test/heavy-boxes.test.ts` | Pass 003: toggled `Elevation & ziplines`, `Healing pickups`, `Heavy boxes` ON and verified all world layers & timers visually |
| FM-053 | Lanes/Camps | Troopers wave dots & performance under playback | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/player-troopers.spec.ts`, `test/player-troopers.test.ts` | Pass 006: verified `.pl-trooper` dots advance smoothly `2:00` (`8`) → `2:02` (`11`, `1×`) → `2:10` (`22`, `4×`) and `Map layers → Lane troopers` toggles `0 ↔ 22` live on prod |
| FM-054 | Objectives | Secret & lane shops on map (`player-shops`) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/player-shops.spec.ts` | Pass 006: verified Phase 5 R3 saved scenes preserve `8` open shops at `1:00` vs `4` open shops at `12:40` (and across TD-162 matchless import) live on prod |
| FM-055 | Objectives | Soul Urn (spawn, pickup, walk-back, drop-off) & respawn timers | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/player-urn-respawn.spec.ts` | Pass 006: verified Phase 5 R3 `10:30` saved scene carried Urn (`data-state="carried"`) + lit delivery point (`urn:neutral:lane6:1` `Active`) live on prod |
| FM-056 | Objectives | Rejuvenator & Rift capture (`Rift.tsx`) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/player-rejuv-rift.spec.ts`, `test/rejuv-rift.test.ts` | Pass 006: verified Phase 5 R3 `11:30` pre-live announced Rift (`"Rift opens in 0:46"`), `12:40` active Rift rings + 1-click Rift swap/toggle, and `31:20` Sapphire 3-revive Rejuv HUD + Mid-Boss respawn indicator (including TD-162 matchless import) live on prod |

## 7. Player Mode & Transport

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-060 | Player | Entering/leaving Player mode, dock layout, mode persistence (`Player.tsx`) | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/player-mode.spec.ts`, `e2e/player-dock.spec.ts`, `e2e/player.spec.ts` | Pass 004: verified Argon narrow-desktop (`1024×600`, `800×600`) stage breathing room & `1440×900` desktop clean live on prod |
| FM-061 | Transport | Play/pause, speed controls (−/+ and list), step/scrub bar drag, ease interpolation | `deep` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/player-scrub-drag.spec.ts`, `e2e/player-ease.spec.ts`, `e2e/player-sidebar-speed.spec.ts`, `e2e/player-transport-fit.spec.ts`, `test/player-clock.test.ts`, `test/scrub-drag.test.ts` | Scrubber squeezes to 36px near 820px width (backlog 2026-11-14); verified desktop + narrow + tablet in Pass 001 |
| FM-062 | Transport | Player keyboard shortcuts (Space, arrows, speed, layer/vision keys) | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/player-keys.spec.ts` | Pass 005: verified `Space` play/pause, `ArrowRight`/`ArrowLeft` (±5s), `Shift+ArrowRight`/`Shift+ArrowLeft` (±30s), `1`/`2`/`3` Vision, and `Escape` live on prod |
| FM-063 | Player | Events sidebar (`Events.tsx`): event list, category filters, search, search-by-names, click to jump | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/player-events-click.spec.ts`, `e2e/player-events-follow.spec.ts`, `e2e/player-events-cost.spec.ts`, `test/player-events.test.ts` | Pass 004: verified Events `Ults` localized ability names (110 ults, zero raw slugs, zero non-ult signature casts) live on prod |
| FM-064 | Player | Pings on minimap during replay playback (`player-pings`) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/player-pings.spec.ts` | Pass 006: verified `3` live `[data-testid="event-ping"]` rings render & fade to `0` playing across `17:58`, and `Map layers → Event pings` OFF suppresses all pings (`0`) live on prod |
| FM-065 | Player | Save/snapshot replay moment into a Scene ("Play from here" / handoff) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/player-handoff.spec.ts`, `e2e/player-review.spec.ts`, `test/from-scene.test.ts` | Ensure + copy op ordering edge case (TD-35); Pass 006: verified Phase 5 R3 Group B saved scenes (`1:00`, `10:30`, `11:30`, `12:40`, `31:20`), `0` Retake buttons, 1-click camp revive & Rift swap/toggle live on prod |
| FM-066 | Player | Player top bar health HUD, ult rings, death timers, names toggle | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/player-health.spec.ts`, `e2e/player-names.spec.ts`, `e2e/player-topbar-writes.spec.ts` | Pass 004: verified health arcs, ult rings, death countdown timers, and legible souls banners across `1440×900`, `1024×600`, `800×600`, `1024×768` touch, and `390×844` touch |
| FM-067 | Player | Frozen-board / viewer write guard in Player mode | `deep` | Pass 003 (2026-11-21, 8c6ec5e) | `e2e/frozen-write-guard.spec.ts` | Pass 003: View-only link hides `Save scene`, restricts toolbar to `Look [Q]` + `Laser [W]`, while allowing scrub/play/Vision/layers/builds |

## 8. Match Import & Replays

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-070 | Replays | Load match by ID (summary tier vs Full replay tier, auto-fetch, format refresh/upgrade) | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/match.spec.ts`, `e2e/player-tier.spec.ts`, `e2e/player-autofetch.spec.ts`, `e2e/player-format-refresh.spec.ts`, `e2e/player-format7.spec.ts`, `e2e/caddy-timeline.spec.ts`, `test/labels.test.ts` | Pass 004: verified cached `129738985` Landing `Open match` and clean §4b `match-tier` (`title: null`) live on prod |
| FM-071 | Replays | Upload `.dem` replay: drag-and-drop, file picker, reserve/queue wait UX, honest error messages | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/replay.spec.ts`, `e2e/upload-ux.spec.ts`, `e2e/replay-queue.spec.ts`, `e2e/replay-prompt.spec.ts`, `test/queue-label.test.ts`, `test/upload-validation.test.ts` | Pass 004: verified corrupt `bad.dem` upload reports `"Not a replay. Pick the match's .dem file."` live on prod |
| FM-072 | Replays | Replay picker & local replays folder (desktop app integration, preview cards, reparse) | `auto-only` | — | `e2e/replay-picker.spec.ts`, `e2e/replays-folder.spec.ts`, `e2e/desktop-reparse.spec.ts`, `test/picker.test.ts`, `test/folder.test.ts`, `test/reparse.test.ts` | Outdated app parser detected only after parse (TD-48); Pass 003: desktop-app-only flow (`Link replays folder` verified visible in `Match source` on web) |
| FM-073 | Replays | Board clone carrying over replay reference (`clone-replay`) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/clone-replay.spec.ts` | Pass 006: verified `More → Clone` carries `129738985` (`Full replay`) + all `6` saved R3 scenes, and adding scenes on the clone (`6 → 7`) does not mutate the original (`6`) live on prod |

## 9. Vision & Map Layers

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-080 | Vision | Vision team filter (Both / Amber / Sapphire) & Show last seen location ghost | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/player-vision.spec.ts`, `test/vision.test.ts`, `test/shown.test.ts` | Pass 005: verified Phase 5 R2 Q2 Vision `1`/`2`/`3` × `Last seen` (unseen enemies faded `0.42`, never ghost) + `Mark not seen`/`Mark in vision` on saved & matchless-imported R2 scenes live on prod |
| FM-081 | Layers | Map layers toggles (camps, lanes, troopers, shops, crates, pings, etc.) & visibility | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/player-visible.spec.ts`, `e2e/follow-matrix.spec.ts`, `test/follow-layers.test.ts` | Pass 005: verified Phase 5 R2 `Health bars & arcs` toggle (`10 → 0 → 10`) & TD-162 matchless import (`Health`/`CC`/`Movement`/`Vision` hidden on blank Scene 1, shown & working on imported R2 Scene 2) live on prod |
| FM-082 | Layers | `K` kill/revive guard (kills/revives hovered hero in Scene mode; no-op under match preview) | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/k-preview.spec.ts` | Pass 005: verified `K` is a no-op under Player match preview (`dead: 1`) and toggles kill + revive on hovered hero in saved R2 Scene (`dead: 2 → 3 → 2`) live on prod |

## 10. Builds, Tooltips, Stats & Recaps

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-090 | Builds | Tab / All builds overlay (`BuildColumn.tsx`, `BuildOrder.tsx`), hero inspect card (`HeroCard.tsx`) | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/player-inspect.spec.ts`, `e2e/panels.spec.ts`, `e2e/player-transport-fit.spec.ts`, `test/builds.test.ts`, `test/panels.test.ts` | Hidden columns stay mounted (TD-52); Pass 004: verified Argon `All builds` clean at `1440×900`, `1024×600`, and `800×600` (zero overlap with map controls) live on prod |
| FM-091 | Tooltips | Game tooltips (`GameTooltip.tsx`): item & ability stats, upgrades, imbues, active effects (`ActiveEffects.tsx`) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/player-tooltips.spec.ts`, `test/tooltips.test.ts`, `test/effects.test.ts`, `test/cc.test.ts` | Hand-ported HUD CSS (TD-27); peak stacks on target effects (TD-47); Pass 006: verified `#62` `.gt-tier-props` (`Napalm`, `Flame Dash`, `Itani Lo Sahn` 3/3, `Hex-Lined Snap Trap` T1/T2 — `0` blank tiers on pack `6864-upgrades`), items, mouse-out/`Escape` dismissal, and `800×600` edge-clamping/flipping live on prod; **new #1 (`bug-minor`)**: literal `&amp;` entity in Apollo `Riposte` T3 text |
| FM-092 | Stats | Calculated hero stat panel (`StatPanel.tsx`) at timestamp `t` | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/player-stats.spec.ts`, `test/stats.test.ts` | Pass 004: verified calculated HP, bullet/spirit resist, weapon damage, and spirit power at `10:00` and `31:20` (single build column & `All builds`) live on prod |
| FM-093 | Recaps | Death skulls on map (`Skulls.tsx`), Skull recap (`SkullRecap.tsx`) & Death recap (`DeathRecap.tsx`) | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/player-death-skull.spec.ts`, `test/skulls.test.ts`, `test/recap.test.ts` | Recap z-index fixed below hero panels (TD-37); Pass 005: verified Phase 5 R2 Q5 static death skull at `12:10` (`role: null`, `data-recap: null`, click opens `0` recaps) live on prod |
| FM-094 | Panels | Movable/draggable floating panels (`panelPlace.ts`), z-order front-bring, pane clearance | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/panels.spec.ts`, `test/panels.test.ts` | `.map-controls > *` DOM query clearance (TD-37); Pass 006: verified two floating `hero-card` panels drag, z-order front-bring (`8 ↔ 9`), viewport/stage clamping (`right: 1104 <= 1440`, zero `.map-controls` overlap), and `×` + `Escape` close live on prod |

## 11. Sessions & Multi-Tab Follow

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-100 | Sessions | Session view (`/s/<id>#<tok>?tab=...`): tab strip, add game (`AddGame.tsx`), rename/reorder/remove tabs | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/sessions.spec.ts`, `e2e/sessions-polish.spec.ts`, `e2e/sessions-review.spec.ts`, `test/sessions-client.test.ts`, `test/sessions-details.test.ts` | Pass 002: `+ Add game`, tab menu (`Rename`/`Move left`/`Remove`/`Remove and revoke`), `1024×600` strip & phone Games sheet verified |
| FM-101 | Sessions | Tab switching isolation (no leaked timers/WebSockets/state across tabs, fast switch) | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/session-isolation.spec.ts`, `e2e/board-unmount.spec.ts`, `e2e/perf-session-switch.spec.ts`, `test/module-state.test.ts` | Pass 005: verified 8 rapid Session tab switches (`Game 1 ↔ Game 2` at 120 ms cadence) live on prod with zero console/page errors and cleanly aborted superseded fetches |
| FM-102 | Sessions | Follow across tabs (`session.tab`), people list "Session" group, avatar dots on tabs, "No access" handling | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/session-follow.spec.ts`, `test/session-follow.test.ts` | Phone has no people list yet (backlog 2026-11-14); "Not sent" dot label needs §4b check; Pass 002: two-user cross-tab follow, `Session` group, tab avatar dots, own-pick `Follow again`, and live `Remove and revoke` fallback verified |

## 12. Collaboration, Sync & Undo/Redo

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-110 | Collab | Join card (`JoinCard.tsx`): display name entry, seat persistence, presence list (`Presence.tsx`) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/presence.spec.ts`, `e2e/board.spec.ts` | Pass 006: verified empty/whitespace rejection, valid join, seat persistence across full reload, two-user presence (`coachA` + `coachB`, `"2 online"`), and live rename via `testid:rename` syncing avatars `CC → PC/CP` live on prod |
| FM-111 | Collab | Two-user real-time sync: tokens, strokes, objectives, scenes, notes converge across peers | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/board.spec.ts`, `e2e/playtest.spec.ts`, `test/session.test.ts`, `test/soak-regressions.test.ts` | Pass 002: interleaved two-user edits + live presence cursor converged cleanly |
| FM-112 | Collab | Follow mode: follow presenter across scene, viewport, playback clock, jumps, and every view-state key | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/follow-matrix.spec.ts`, `e2e/player-follow-view.spec.ts`, `e2e/player-follow-jump.spec.ts`, `e2e/phone-player.spec.ts`, `test/follow.test.ts`, `test/view-state.test.ts` | Fixed reconnect waits (TD-36); follow-matrix runtime (TD-34); Pass 004: verified Tablet `1024×768 --touch` `.p-top` fits `359/359` with `Follow` unclipped (`right: 977`) live on prod |
| FM-113 | Collab | Undo / Redo (`Ctrl+Z` / `Ctrl+Shift+Z`) in single-user and multi-user sessions | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/board.spec.ts`, `e2e/playtest.spec.ts`, `test/session.test.ts` | Pass 002: two-user interleaved per-user `Ctrl+Z` / `Ctrl+Shift+Z` converged cleanly with zero errors |

## 13. Sharing, Roles & Board Files

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-120 | Sharing | Share dialog (`ShareDialog.tsx`): mint Edit & View links, copy link, list & revoke links | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/share.spec.ts`, `test/share.test.ts` | Pass 004: verified revoked rows hide `Copy` live on prod (no Revoke UI button is intentional per spec §11) |
| FM-121 | Sharing | Viewer role enforcement (read-only UI, no mutation controls, can still follow & inspect) | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/share.spec.ts`, `e2e/frozen-write-guard.spec.ts` | Pass 004: verified live revocation shows `"Link revoked"` & unmounts board DOM (`mapCount: 0, mainCount: 0`) live on prod |
| FM-122 | Files | Export & import `.mapcro` board files (`boardfile.ts`) | `deep` | Pass 006 (2026-11-24, c8d5782) | `e2e/board-file.spec.ts`, `test/boardfile.test.ts` | 8 MiB cap (TD-43); Pass 006: verified Phase 5 R3 `.mapcro` v6 export (`version: 6, rows: 40`) via `download` & TD-162 matchless import (`matches: []`) rendering `11:30` announced Rift, `12:40` Rift rings, and `31:20` Sapphire 3-revive Rejuv with zero match open live on prod |

## 14. Responsive, Touch, Phone & Tablet

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-130 | Phone | Phone portrait layout (`390x844` touch): board chrome, sheets, scene switching, map gestures | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/phone.spec.ts`, `e2e/touch.spec.ts`, `e2e/touch-menu.spec.ts`, `test/long-press.test.ts` | Pass 005: verified Pass 004 #1 Argon header fix live on prod (`390×844` & `360×800` `.p-top` zero-overflow, `games-open >= 44×44`, unclipped `"Can edit"`, icon-only `44×44` `feedback-open`); **new #1 (`ux-rough`)**: stacked `.pl-bar.scene` + `.p-bar` on match-loaded Session Scene overflows vertically (`956 / 844`, scrollable) |
| FM-131 | Phone | Phone Player layout: transport grid, speed list (<=480px), events/builds sheets | `deep` | Pass 005 (2026-11-23, 01e29a8) | `e2e/phone-player.spec.ts`, `e2e/player-dock.spec.ts` | Upright phone speed list vs buttons (backlog 2026-11-14); Pass 005: verified Phone `390×844` Session Player `.p-top` (`390/390`), `More → Feedback` accessible, and Player ↔ Scene switching live on prod |
| FM-132 | Tablet | Tablet & narrow desktop layouts (`1024x768` touch, `1024x600`, `800x600`) | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/header.spec.ts`, `e2e/phone-player.spec.ts`, `e2e/player-visible.spec.ts`, `e2e/player-transport-fit.spec.ts` | Pass 004: all Pass 001 narrow-desktop & tablet fixes (`800×600` header, `1024×600` `Map layers`, `All builds`, `1024×768` `.p-top` `Follow` & `Scenes` drawer) verified live on prod |

## 15. Offline, Reconnect & Updates

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-140 | Resilience | Offline editing, IndexedDB persistence, reconnect & durable resend after server restart | `deep` | Pass 004 (2026-11-22, e2438b4) | `e2e/board.spec.ts`, `e2e/follow-matrix.spec.ts`, `test/resend-durable.test.ts`, `test/soak-regressions.test.ts` | Pass 004: verified full page reload on live prod preserves saved scenes (`Scene 1`, `Match moment`) and `Full replay` state cleanly |
| FM-141 | Updates | App/client update banner (`UpdateBanner`, `update.ts`, `reload.ts`) | `auto-only` | — | `e2e/open-link.spec.ts`, `test/outdated.test.ts` | No install progress in desktop app (TD-45); Pass 003: protocol `BUILD_ID` mismatch / desktop release feed gated (verified silent on matching web build) |

---

## Summary Counts (Updated 2026-11-24, Pass 006)

- **Total rows:** 72 across 15 domains (**70/70 web-testable rows `deep` = 100%**)
- **`deep`:** 70 (`FM-001`, `FM-002`, `FM-003`, `FM-004`, `FM-005`, `FM-010`, `FM-011`, `FM-012`, `FM-013`, `FM-014`, `FM-015`, `FM-020`, `FM-021`, `FM-022`, `FM-023`, `FM-024`, `FM-025`, `FM-030`, `FM-031`, `FM-032`, `FM-033`, `FM-034`, `FM-035`, `FM-036`, `FM-037`, `FM-038`, `FM-040`, `FM-041`, `FM-042`, `FM-043`, `FM-050`, `FM-051`, `FM-052`, `FM-053`, `FM-054`, `FM-055`, `FM-056`, `FM-060`, `FM-061`, `FM-062`, `FM-063`, `FM-064`, `FM-065`, `FM-066`, `FM-067`, `FM-070`, `FM-071`, `FM-073`, `FM-080`, `FM-081`, `FM-082`, `FM-090`, `FM-091`, `FM-092`, `FM-093`, `FM-094`, `FM-100`, `FM-101`, `FM-102`, `FM-110`, `FM-111`, `FM-112`, `FM-113`, `FM-120`, `FM-121`, `FM-122`, `FM-130`, `FM-131`, `FM-132`, `FM-140`)
- **`smoke`:** 0
- **`auto-only`:** 2 (`FM-072` desktop-app-only, `FM-141` protocol/release-feed gated)
- **`unmapped`:** 0
