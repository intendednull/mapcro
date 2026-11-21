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
| FM-001 | Landing | Landing page (`/`): wordmark, New board creation, navigation to `/b/<id>#<tok>` | `auto-only` | — | `e2e/home.spec.ts` | |
| FM-002 | Landing | Recent/known boards list, rename/remove with Undo toast | `auto-only` | — | `e2e/boards-list.spec.ts`, `test/known-boards.test.ts` | Duplicate toast markup (TD-38) |
| FM-003 | Landing | Open link dialog / keyboard shortcut (`OpenLinkKeys`) & dead/malformed `/b/` or `/s/` link (`DeadLink`) | `auto-only` | — | `e2e/open-link.spec.ts`, `test/applink.test.ts` | |
| FM-004 | Landing | Desktop app download link/dialog from web (`AppDownload`) | `auto-only` | — | `e2e/app-download.spec.ts`, `test/desktop-release.test.ts` | |
| FM-005 | Landing | New session creation from landing / recent sessions list | `auto-only` | — | `e2e/sessions.spec.ts`, `e2e/sessions-polish.spec.ts` | |

## 2. Board Shell & Header

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-010 | Header | Board header: inline board title edit, mode switcher (Scenes / Player), status indicator | `auto-only` | — | `e2e/header.spec.ts`, `e2e/status.spec.ts`, `test/status.test.ts` | |
| FM-011 | Header | Top bar (`TopBar.tsx` / `TopBarParts.tsx`): 6v6 hero portraits, team names, Rejuvenator indicator, souls/clock | `auto-only` | — | `e2e/topbar.spec.ts`, `e2e/topbar-rejuv-builds.spec.ts`, `e2e/team-names.spec.ts` | Scene & Player top bars partially duplicated (TD-11) |
| FM-012 | Header | Portrait context menu (`portrait-menu`): focus hero, toggle alive/dead, open build/stat panel | `auto-only` | — | `e2e/portrait-menu.spec.ts`, `e2e/hero-focus.spec.ts` | |
| FM-013 | Header | More menu (`MoreMenu.tsx`): clone board, export/import board file, feedback, session promotion | `auto-only` | — | `e2e/board-file.spec.ts`, `e2e/clone-replay.spec.ts`, `e2e/feedback.spec.ts` | |
| FM-014 | Header | Feedback button & GitHub issue submission dialog (`Feedback.tsx`) | `auto-only` | — | `e2e/feedback.spec.ts`, `test/feedback.test.ts` | |
| FM-015 | Header | Dialog focus management & modal scrim (`ModalScrim.tsx`, Esc to close, focus trap) | `auto-only` | — | `e2e/dialog-focus.spec.ts` | |

## 3. Scenes & Roster

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-020 | Scenes | Scene list / tree (`SceneTree.tsx`): create, rename, reorder, nest/group, delete scenes | `auto-only` | — | `e2e/scenes.spec.ts`, `e2e/scene-tree.spec.ts`, `test/scenes.test.ts`, `test/tree.test.ts` | |
| FM-021 | Scenes | Scene cloning (`CloneDialog.tsx` / duplicate scene with heroes, drawings, objectives) | `auto-only` | — | `e2e/scene-clone.spec.ts`, `test/scene-copy.test.ts` | |
| FM-022 | Scenes | Scene note editor (`note`): write, blur-save, sync across peers | `auto-only` | — | `e2e/note.spec.ts` | Unsaved draft cleared on scene flip (backlog 2026-11-14) |
| FM-023 | Scenes | Scene names & player names toggle on tokens | `auto-only` | — | `e2e/scene-names.spec.ts` | |
| FM-024 | Scenes | Scene builds (saved item/ability builds per hero on a scene, open/close build panels) | `auto-only` | — | `e2e/scene-builds.spec.ts`, `test/map-state-build.test.ts`, `test/map-state-save.test.ts` | Phone scene builds in backlog |
| FM-025 | Roster | Hero picker (`HeroPicker.tsx`): assign/swap/clear 6v6 roster slots, uniqueness constraint | `auto-only` | — | `e2e/scene-hero.spec.ts`, `e2e/hero-unique.spec.ts`, `test/roster.test.ts`, `test/scene-hero-pick.test.ts` | |

## 4. Map Canvas & Drawing Tools

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-030 | Map | Map pan, zoom (wheel / pinch), fit-to-view, stencil edge clipping (`MapView.tsx`, `stencil.ts`) | `auto-only` | — | `e2e/fit.spec.ts`, `e2e/map-edge-clip.spec.ts`, `e2e/map-stencil-edge.spec.ts`, `test/stencil.test.ts` | Drag clamp disc vs stencil (TD-31) |
| FM-031 | Map | Asset pack loading & fallback vector map (`pack.ts`, `fallback-data.ts`, `map-furniture`) | `auto-only` | — | `e2e/pack.spec.ts`, `e2e/map-furniture.spec.ts`, `test/map-furniture.test.ts` | |
| FM-032 | Drawing | Toolbar & tool keyboard shortcuts (`Q`/`E`/`R`/`T`, select, pen, arrow, laser, eraser, pings, callouts) | `auto-only` | — | `e2e/tools.spec.ts`, `e2e/tool-keys.spec.ts`, `test/tool-keys.test.ts` | |
| FM-033 | Drawing | Palette (`Palette.tsx`): stroke colours, line styles, palette in Player mode | `auto-only` | — | `e2e/palette.spec.ts`, `e2e/palette-player.spec.ts`, `test/recolour.test.ts` | |
| FM-034 | Drawing | Freehand strokes, arrows, selection & move/delete, bulk clear (`clear-many`), selection colour | `auto-only` | — | `e2e/tools.spec.ts`, `e2e/clear-many.spec.ts`, `e2e/selection-colour.spec.ts`, `test/stroke-move.test.ts` | |
| FM-035 | Drawing | Laser pointer & ephemeral live ink gestures (`laser-gestures`, `fade.ts`) | `auto-only` | — | `e2e/laser-gestures.spec.ts`, `test/live-ink.test.ts` | |
| FM-036 | Drawing | Placeables & markers (wards/pings/callouts/icons), right-click context menu on placed items | `auto-only` | — | `e2e/placeables.spec.ts`, `e2e/markers.spec.ts`, `e2e/placed-menu.spec.ts`, `e2e/context-menu.spec.ts` | |
| FM-037 | Drawing | Map comments / annotations (`comments.spec.ts`, `commentLayout.ts`) | `auto-only` | — | `e2e/comments.spec.ts`, `e2e/comments-audit.spec.ts`, `test/comments.test.ts` | |
| FM-038 | Drawing | No accidental text selection while dragging on map (`no-select`) | `auto-only` | — | `e2e/no-select.spec.ts` | |

## 5. Heroes & Tokens

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-040 | Tokens | Dragging hero tokens on map, smooth interpolation, live drag preview across peers | `auto-only` | — | `e2e/board.spec.ts`, `e2e/heroes-live.spec.ts`, `test/smooth.test.ts` | |
| FM-041 | Tokens | Hero focus highlight & dimming other tokens (`hero-focus`) | `auto-only` | — | `e2e/hero-focus.spec.ts` | |
| FM-042 | Tokens | Hover label (`HoverLabel.tsx`): instant/clean hero & marker hover, silent when hidden | `auto-only` | — | `e2e/hover-hidden.spec.ts`, `test/hover-label.test.ts`, `test/labels.test.ts` | Browser `title` lag outside hero panel (TD-46); hidden marker silence gap (TD-14) |
| FM-043 | Tokens | Hero state in scenes: alive/dead, out-of-sight fade | `auto-only` | — | `e2e/player-vision.spec.ts`, `test/shown.test.ts` | Map-state Phase 4/5 in flight |

## 6. Objectives, Camps & Lanes

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-050 | Objectives | Objective states on map (Guardians, Walkers, Base Guardians, Shrines, Patrons): toggle/click in scenes | `auto-only` | — | `e2e/objectives.spec.ts`, `test/objectives.test.ts` | |
| FM-051 | Objectives | Objective hover tooltips & respawn/health bars in Player | `auto-only` | — | `e2e/player-objective-tips.spec.ts`, `test/objective-tips.test.ts` | |
| FM-052 | Lanes/Camps | Lanes, ziplines, jungle camps, Sinner's Sacrifice, Mid Boss, buffs, breakables/crates | `auto-only` | — | `e2e/player-lanes-camps.spec.ts`, `e2e/heavy-boxes.spec.ts`, `test/lanes.test.ts`, `test/heavy-boxes.test.ts` | |
| FM-053 | Lanes/Camps | Troopers wave dots & performance under playback | `auto-only` | — | `e2e/player-troopers.spec.ts`, `test/player-troopers.test.ts` | |
| FM-054 | Objectives | Secret & lane shops on map (`player-shops`) | `auto-only` | — | `e2e/player-shops.spec.ts` | |
| FM-055 | Objectives | Soul Urn (spawn, pickup, walk-back, drop-off) & respawn timers | `auto-only` | — | `e2e/player-urn-respawn.spec.ts` | |
| FM-056 | Objectives | Rejuvenator & Rift capture (`Rift.tsx`) | `auto-only` | — | `e2e/player-rejuv-rift.spec.ts`, `test/rejuv-rift.test.ts` | |

## 7. Player Mode & Transport

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-060 | Player | Entering/leaving Player mode, dock layout, mode persistence (`Player.tsx`) | `auto-only` | — | `e2e/player-mode.spec.ts`, `e2e/player-dock.spec.ts`, `e2e/player.spec.ts` | |
| FM-061 | Transport | Play/pause, speed controls (−/+ and list), step/scrub bar drag, ease interpolation | `auto-only` | — | `e2e/player-scrub-drag.spec.ts`, `e2e/player-ease.spec.ts`, `e2e/player-sidebar-speed.spec.ts`, `e2e/player-transport-fit.spec.ts`, `test/player-clock.test.ts`, `test/scrub-drag.test.ts` | Scrubber squeezes to 36px near 820px width (backlog 2026-11-14) |
| FM-062 | Transport | Player keyboard shortcuts (Space, arrows, speed, layer/vision keys) | `auto-only` | — | `e2e/player-keys.spec.ts` | |
| FM-063 | Player | Events sidebar (`Events.tsx`): event list, category filters, search, search-by-names, click to jump | `auto-only` | — | `e2e/player-events-click.spec.ts`, `e2e/player-events-follow.spec.ts`, `e2e/player-events-cost.spec.ts`, `test/player-events.test.ts` | |
| FM-064 | Player | Pings on minimap during replay playback (`player-pings`) | `auto-only` | — | `e2e/player-pings.spec.ts` | |
| FM-065 | Player | Save/snapshot replay moment into a Scene ("Play from here" / handoff) | `auto-only` | — | `e2e/player-handoff.spec.ts`, `e2e/player-review.spec.ts`, `test/from-scene.test.ts` | Ensure + copy op ordering edge case (TD-35) |
| FM-066 | Player | Player top bar health HUD, ult rings, death timers, names toggle | `auto-only` | — | `e2e/player-health.spec.ts`, `e2e/player-names.spec.ts`, `e2e/player-topbar-writes.spec.ts` | |
| FM-067 | Player | Frozen-board / viewer write guard in Player mode | `auto-only` | — | `e2e/frozen-write-guard.spec.ts` | |

## 8. Match Import & Replays

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-070 | Replays | Load match by ID (summary tier vs Full replay tier, auto-fetch, format refresh/upgrade) | `auto-only` | — | `e2e/match.spec.ts`, `e2e/player-tier.spec.ts`, `e2e/player-autofetch.spec.ts`, `e2e/player-format-refresh.spec.ts`, `e2e/player-format7.spec.ts`, `e2e/caddy-timeline.spec.ts` | |
| FM-071 | Replays | Upload `.dem` replay: drag-and-drop, file picker, reserve/queue wait UX, honest error messages | `auto-only` | — | `e2e/replay.spec.ts`, `e2e/upload-ux.spec.ts`, `e2e/replay-queue.spec.ts`, `e2e/replay-prompt.spec.ts`, `test/queue-label.test.ts` | |
| FM-072 | Replays | Replay picker & local replays folder (desktop app integration, preview cards, reparse) | `auto-only` | — | `e2e/replay-picker.spec.ts`, `e2e/replays-folder.spec.ts`, `e2e/desktop-reparse.spec.ts`, `test/picker.test.ts`, `test/folder.test.ts`, `test/reparse.test.ts` | Outdated app parser detected only after parse (TD-48) |
| FM-073 | Replays | Board clone carrying over replay reference (`clone-replay`) | `auto-only` | — | `e2e/clone-replay.spec.ts` | |

## 9. Vision & Map Layers

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-080 | Vision | Vision team filter (Both / Amber / Sapphire) & Show last seen location ghost | `auto-only` | — | `e2e/player-vision.spec.ts`, `test/vision.test.ts`, `test/shown.test.ts` | |
| FM-081 | Layers | Map layers toggles (camps, lanes, troopers, shops, crates, pings, etc.) & visibility | `auto-only` | — | `e2e/player-visible.spec.ts`, `e2e/follow-matrix.spec.ts`, `test/follow-layers.test.ts` | |
| FM-082 | Layers | K-preview (hold `K` to preview alternate layer/key state) | `auto-only` | — | `e2e/k-preview.spec.ts` | |

## 10. Builds, Tooltips, Stats & Recaps

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-090 | Builds | Tab / All builds overlay (`BuildColumn.tsx`, `BuildOrder.tsx`), hero inspect card (`HeroCard.tsx`) | `auto-only` | — | `e2e/player-inspect.spec.ts`, `e2e/panels.spec.ts`, `test/builds.test.ts`, `test/panels.test.ts` | Hidden columns stay mounted (TD-52) |
| FM-091 | Tooltips | Game tooltips (`GameTooltip.tsx`): item & ability stats, upgrades, imbues, active effects (`ActiveEffects.tsx`) | `auto-only` | — | `e2e/player-tooltips.spec.ts`, `test/tooltips.test.ts`, `test/effects.test.ts`, `test/cc.test.ts` | Hand-ported HUD CSS (TD-27); peak stacks on target effects (TD-47) |
| FM-092 | Stats | Calculated hero stat panel (`StatPanel.tsx`) at timestamp `t` | `auto-only` | — | `e2e/player-stats.spec.ts`, `test/stats.test.ts` | |
| FM-093 | Recaps | Death skulls on map (`Skulls.tsx`), Skull recap (`SkullRecap.tsx`) & Death recap (`DeathRecap.tsx`) | `auto-only` | — | `e2e/player-death-skull.spec.ts`, `test/skulls.test.ts`, `test/recap.test.ts` | Recap z-index fixed below hero panels (TD-37) |
| FM-094 | Panels | Movable/draggable floating panels (`panelPlace.ts`), z-order front-bring, pane clearance | `auto-only` | — | `e2e/panels.spec.ts`, `test/panels.test.ts` | `.map-controls > *` DOM query clearance (TD-37) |

## 11. Sessions & Multi-Tab Follow

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-100 | Sessions | Session view (`/s/<id>#<tok>?tab=...`): tab strip, add game (`AddGame.tsx`), rename/reorder/remove tabs | `auto-only` | — | `e2e/sessions.spec.ts`, `e2e/sessions-polish.spec.ts`, `e2e/sessions-review.spec.ts`, `test/sessions-client.test.ts`, `test/sessions-details.test.ts` | |
| FM-101 | Sessions | Tab switching isolation (no leaked timers/WebSockets/state across tabs, fast switch) | `auto-only` | — | `e2e/session-isolation.spec.ts`, `e2e/board-unmount.spec.ts`, `e2e/perf-session-switch.spec.ts`, `test/module-state.test.ts` | |
| FM-102 | Sessions | Follow across tabs (`session.tab`), people list "Session" group, avatar dots on tabs, "No access" handling | `auto-only` | — | `e2e/session-follow.spec.ts`, `test/session-follow.test.ts` | Phone has no people list yet (backlog 2026-11-14); "Not sent" dot label needs §4b check |

## 12. Collaboration, Sync & Undo/Redo

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-110 | Collab | Join card (`JoinCard.tsx`): display name entry, seat persistence, presence list (`Presence.tsx`) | `auto-only` | — | `e2e/presence.spec.ts`, `e2e/board.spec.ts` | |
| FM-111 | Collab | Two-user real-time sync: tokens, strokes, objectives, scenes, notes converge across peers | `auto-only` | — | `e2e/board.spec.ts`, `e2e/playtest.spec.ts`, `test/session.test.ts`, `test/soak-regressions.test.ts` | |
| FM-112 | Collab | Follow mode: follow presenter across scene, viewport, playback clock, jumps, and every view-state key | `auto-only` | — | `e2e/follow-matrix.spec.ts`, `e2e/player-follow-view.spec.ts`, `e2e/player-follow-jump.spec.ts`, `test/follow.test.ts`, `test/view-state.test.ts` | Fixed reconnect waits (TD-36); follow-matrix runtime (TD-34) |
| FM-113 | Collab | Undo / Redo (`Ctrl+Z` / `Ctrl+Shift+Z`) in single-user and multi-user sessions | `auto-only` | — | `e2e/board.spec.ts`, `e2e/playtest.spec.ts`, `test/session.test.ts` | Needs deeper interactive multi-user undo testing |

## 13. Sharing, Roles & Board Files

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-120 | Sharing | Share dialog (`ShareDialog.tsx`): mint Edit & View links, copy link, list & revoke links | `auto-only` | — | `e2e/share.spec.ts`, `test/share.test.ts` | |
| FM-121 | Sharing | Viewer role enforcement (read-only UI, no mutation controls, can still follow & inspect) | `auto-only` | — | `e2e/share.spec.ts`, `e2e/frozen-write-guard.spec.ts` | |
| FM-122 | Files | Export & import `.mapcro` board files (`boardfile.ts`) | `auto-only` | — | `e2e/board-file.spec.ts`, `test/boardfile.test.ts` | 8 MiB cap (TD-43) |

## 14. Responsive, Touch, Phone & Tablet

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-130 | Phone | Phone portrait layout (`390x844` touch): board chrome, sheets, scene switching, map gestures | `auto-only` | — | `e2e/phone.spec.ts`, `e2e/touch.spec.ts`, `e2e/touch-menu.spec.ts`, `test/long-press.test.ts` | |
| FM-131 | Phone | Phone Player layout: transport grid, speed list (<=480px), events/builds sheets | `auto-only` | — | `e2e/phone-player.spec.ts`, `e2e/player-dock.spec.ts` | Upright phone speed list vs buttons (backlog 2026-11-14) |
| FM-132 | Tablet | Tablet & narrow desktop layouts (`1024x768` touch, `1024x600`, `800x600`) | `unmapped` | — | — | Narrow desktop `800x600`–`1024x600` has no dedicated e2e; prime candidate for Pass 1 |

## 15. Offline, Reconnect & Updates

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-140 | Resilience | Offline editing, IndexedDB persistence, reconnect & durable resend after server restart | `auto-only` | — | `e2e/board.spec.ts`, `e2e/follow-matrix.spec.ts`, `test/resend-durable.test.ts`, `test/soak-regressions.test.ts` | |
| FM-141 | Updates | App/client update banner (`UpdateBanner`, `update.ts`, `reload.ts`) | `auto-only` | — | `e2e/open-link.spec.ts`, `test/outdated.test.ts` | No install progress in desktop app (TD-45) |

---

## Summary Counts (2026-11-21 Seed)

- **Total rows:** 72 across 15 domains
- **`deep`:** 0
- **`smoke`:** 0
- **`auto-only`:** 71
- **`unmapped`:** 1 (`FM-132`: Tablet & narrow desktop layouts)
