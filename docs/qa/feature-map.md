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
| FM-001 | Landing | Landing page (`/`): wordmark, New board creation, navigation to `/b/<id>#<tok>` | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/home.spec.ts` | |
| FM-002 | Landing | Recent/known boards list, rename/remove with Undo toast | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/boards-list.spec.ts`, `test/known-boards.test.ts` | Duplicate toast markup (TD-38); Pass 002 #1: inline rename + `Enter` navigates into `/b/<id>` instead of staying on `/`; Remove + Undo toast verified |
| FM-003 | Landing | Open link dialog / keyboard shortcut (`OpenLinkKeys`) & dead/malformed `/b/` or `/s/` link (`DeadLink`) | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/open-link.spec.ts`, `test/applink.test.ts` | Pass 002: dead `/b/` and `/s/` URLs render clean `Invalid link` alert |
| FM-004 | Landing | Desktop app download link/dialog from web (`AppDownload`) | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/app-download.spec.ts`, `test/desktop-release.test.ts` | Pass 002: `Get the Linux app` triggers direct AppImage download |
| FM-005 | Landing | New session creation from landing / recent sessions list | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/sessions.spec.ts`, `e2e/sessions-polish.spec.ts` | Pass 002: board promotion via `+ Add game` verified |

## 2. Board Shell & Header

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-010 | Header | Board header: inline board title edit, mode switcher (Scenes / Player), status indicator | `deep` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/header.spec.ts`, `e2e/status.spec.ts`, `test/status.test.ts` | Pass 001 #1: overflows at `800×600` (`headerOverflow: true`), clipping `More` (`⋯`) off-screen |
| FM-011 | Header | Top bar (`TopBar.tsx` / `TopBarParts.tsx`): 6v6 hero portraits, team names, Rejuvenator indicator, souls/clock | `smoke` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/topbar.spec.ts`, `e2e/topbar-rejuv-builds.spec.ts`, `e2e/team-names.spec.ts` | Scene & Player top bars partially duplicated (TD-11); Pass 001 #6: souls banners illegible at `1024×600`/`800×600` |
| FM-012 | Header | Portrait context menu (`portrait-menu`): focus hero, toggle alive/dead, open build/stat panel | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/portrait-menu.spec.ts`, `e2e/hero-focus.spec.ts` | Pass 002: `hero-menu` right-click → `Change hero…` verified |
| FM-013 | Header | More menu (`MoreMenu.tsx`): clone board, export/import board file, feedback, session promotion | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/board-file.spec.ts`, `e2e/clone-replay.spec.ts`, `e2e/feedback.spec.ts` | Pass 001 #1: `More` button clipped off-screen at `800×600` when Presenting + Full replay shown; Pass 002: rows audited §4b clean (zero hover text) |
| FM-014 | Header | Feedback button & GitHub issue submission dialog (`Feedback.tsx`) | `auto-only` | — | `e2e/feedback.spec.ts`, `test/feedback.test.ts` | |
| FM-015 | Header | Dialog focus management & modal scrim (`ModalScrim.tsx`, Esc to close, focus trap) | `auto-only` | — | `e2e/dialog-focus.spec.ts` | |

## 3. Scenes & Roster

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-020 | Scenes | Scene list / tree (`SceneTree.tsx`): create, rename, reorder, nest/group, delete scenes | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/scenes.spec.ts`, `e2e/scene-tree.spec.ts`, `test/scenes.test.ts`, `test/tree.test.ts` | Pass 002: `+` & `T`, 48-char rename + tree ellipsis, drag-nesting verified |
| FM-021 | Scenes | Scene cloning (`CloneDialog.tsx` / duplicate scene with heroes, drawings, objectives) | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/scene-clone.spec.ts`, `test/scene-copy.test.ts` | Pass 002: `scene-clone` verified |
| FM-022 | Scenes | Scene note editor (`note`): write, blur-save, sync across peers | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/note.spec.ts` | Pass 002: blur-save on scene flip verified cleanly |
| FM-023 | Scenes | Scene names & player names toggle on tokens | `auto-only` | — | `e2e/scene-names.spec.ts` | |
| FM-024 | Scenes | Scene builds (saved item/ability builds per hero on a scene, open/close build panels) | `auto-only` | — | `e2e/scene-builds.spec.ts`, `test/map-state-build.test.ts`, `test/map-state-save.test.ts` | Phone scene builds in backlog |
| FM-025 | Roster | Hero picker (`HeroPicker.tsx`): assign/swap/clear 6v6 roster slots, uniqueness constraint | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/scene-hero.spec.ts`, `e2e/hero-unique.spec.ts`, `test/roster.test.ts`, `test/scene-hero-pick.test.ts` | Pass 002 #2: disabled hero tiles have sentence-style `title="<Hero>: <Slot> has this hero"` violating §4b |

## 4. Map Canvas & Drawing Tools

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-030 | Map | Map pan, zoom (wheel / pinch), fit-to-view, stencil edge clipping (`MapView.tsx`, `stencil.ts`) | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/fit.spec.ts`, `e2e/map-edge-clip.spec.ts`, `e2e/map-stencil-edge.spec.ts`, `test/stencil.test.ts` | Drag clamp disc vs stencil (TD-31); Pass 002: wheel zoom + stencil clipping verified |
| FM-031 | Map | Asset pack loading & fallback vector map (`pack.ts`, `fallback-data.ts`, `map-furniture`) | `auto-only` | — | `e2e/pack.spec.ts`, `e2e/map-furniture.spec.ts`, `test/map-furniture.test.ts` | |
| FM-032 | Drawing | Toolbar & tool keyboard shortcuts (`Q`/`W`/`E`/`A`/`S`/`D`/`C`, select, laser, draw, arrow, comment, erase, clear) | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/tools.spec.ts`, `e2e/tool-keys.spec.ts`, `test/tool-keys.test.ts` | Pass 002: all hotkeys + §4b `title` labels verified |
| FM-033 | Drawing | Palette (`Palette.tsx`): stroke colours, line styles, palette in Player mode | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/palette.spec.ts`, `e2e/palette-player.spec.ts`, `test/recolour.test.ts` | Pass 002: swatch switching + `No colour` verified |
| FM-034 | Drawing | Freehand strokes, arrows, selection & move/delete, bulk clear (`clear-many`), selection colour | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/tools.spec.ts`, `e2e/clear-many.spec.ts`, `e2e/selection-colour.spec.ts`, `test/stroke-move.test.ts` | Pass 002: strokes, arrows, Clear menu counts, multi-user sync + undo/redo verified |
| FM-035 | Drawing | Laser pointer & ephemeral live ink gestures (`laser-gestures`, `fade.ts`) | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/laser-gestures.spec.ts`, `test/live-ink.test.ts` | Pass 002: live fading laser trail verified visually |
| FM-036 | Drawing | Placeables & markers (wards/pings/callouts/icons), right-click context menu on placed items | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/placeables.spec.ts`, `e2e/markers.spec.ts`, `e2e/placed-menu.spec.ts`, `e2e/context-menu.spec.ts` | Pass 002: `placed-menu` on comment (side, 7 colours, `No colour`) & arrow recolour verified |
| FM-037 | Drawing | Map comments / annotations (`comments.spec.ts`, `commentLayout.ts`) | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/comments.spec.ts`, `e2e/comments-audit.spec.ts`, `test/comments.test.ts` | Pass 002: create, side placement, recolour, and `.mapcro` round-trip verified |
| FM-038 | Drawing | No accidental text selection while dragging on map (`no-select`) | `auto-only` | — | `e2e/no-select.spec.ts` | |

## 5. Heroes & Tokens

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-040 | Tokens | Dragging hero tokens on map, smooth interpolation, live drag preview across peers | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/board.spec.ts`, `e2e/heroes-live.spec.ts`, `test/smooth.test.ts` | Pass 002: Sapphire token drag + `.mapcro` round-trip verified |
| FM-041 | Tokens | Hero focus highlight & dimming other tokens (`hero-focus`) | `auto-only` | — | `e2e/hero-focus.spec.ts` | |
| FM-042 | Tokens | Hover label (`HoverLabel.tsx`): instant/clean hero & marker hover, silent when hidden | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/hover-hidden.spec.ts`, `test/hover-label.test.ts`, `test/labels.test.ts` | Browser `title` lag outside hero panel (TD-46); hidden marker silence gap (TD-14); Pass 002: `HoverLabel` verified on dragged token |
| FM-043 | Tokens | Hero state in scenes: alive/dead, out-of-sight fade | `auto-only` | — | `e2e/player-vision.spec.ts`, `test/shown.test.ts` | Map-state Phase 4/5 in flight |

## 6. Objectives, Camps & Lanes

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-050 | Objectives | Objective states on map (Guardians, Walkers, Base Guardians, Shrines, Patrons): toggle/click in scenes | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/objectives.spec.ts`, `test/objectives.test.ts` | Pass 002: objective click verified |
| FM-051 | Objectives | Objective hover tooltips & respawn/health bars in Player | `auto-only` | — | `e2e/player-objective-tips.spec.ts`, `test/objective-tips.test.ts` | |
| FM-052 | Lanes/Camps | Lanes, ziplines, jungle camps, Sinner's Sacrifice, Mid Boss, buffs, breakables/crates | `auto-only` | — | `e2e/player-lanes-camps.spec.ts`, `e2e/heavy-boxes.spec.ts`, `test/lanes.test.ts`, `test/heavy-boxes.test.ts` | |
| FM-053 | Lanes/Camps | Troopers wave dots & performance under playback | `auto-only` | — | `e2e/player-troopers.spec.ts`, `test/player-troopers.test.ts` | |
| FM-054 | Objectives | Secret & lane shops on map (`player-shops`) | `auto-only` | — | `e2e/player-shops.spec.ts` | |
| FM-055 | Objectives | Soul Urn (spawn, pickup, walk-back, drop-off) & respawn timers | `auto-only` | — | `e2e/player-urn-respawn.spec.ts` | |
| FM-056 | Objectives | Rejuvenator & Rift capture (`Rift.tsx`) | `auto-only` | — | `e2e/player-rejuv-rift.spec.ts`, `test/rejuv-rift.test.ts` | |

## 7. Player Mode & Transport

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-060 | Player | Entering/leaving Player mode, dock layout, mode persistence (`Player.tsx`) | `deep` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/player-mode.spec.ts`, `e2e/player-dock.spec.ts`, `e2e/player.spec.ts` | Pass 001 #6: narrow desktop (`1024×600`/`800×600`) wraps dock to 5 rows, crushing map to `170×170`/`164×164` |
| FM-061 | Transport | Play/pause, speed controls (−/+ and list), step/scrub bar drag, ease interpolation | `deep` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/player-scrub-drag.spec.ts`, `e2e/player-ease.spec.ts`, `e2e/player-sidebar-speed.spec.ts`, `e2e/player-transport-fit.spec.ts`, `test/player-clock.test.ts`, `test/scrub-drag.test.ts` | Scrubber squeezes to 36px near 820px width (backlog 2026-11-14); verified desktop + narrow + tablet in Pass 001 |
| FM-062 | Transport | Player keyboard shortcuts (Space, arrows, speed, layer/vision keys) | `smoke` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/player-keys.spec.ts` | Space, `1`/`2`/`3`, Escape verified in Pass 001 |
| FM-063 | Player | Events sidebar (`Events.tsx`): event list, category filters, search, search-by-names, click to jump | `deep` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/player-events-click.spec.ts`, `e2e/player-events-follow.spec.ts`, `e2e/player-events-cost.spec.ts`, `test/player-events.test.ts` | Pass 001 #5: `Ults` shows raw internal ability slugs (`unicorn dazzlingorb`, `fencer ultimate`, etc.) and includes non-ult abilities (`sleep dagger`, `ratking ratnibble`) |
| FM-064 | Player | Pings on minimap during replay playback (`player-pings`) | `auto-only` | — | `e2e/player-pings.spec.ts` | |
| FM-065 | Player | Save/snapshot replay moment into a Scene ("Play from here" / handoff) | `smoke` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/player-handoff.spec.ts`, `e2e/player-review.spec.ts`, `test/from-scene.test.ts` | Ensure + copy op ordering edge case (TD-35); Pass 001 #8: `Saved scene · Back to replay` toast stays visible after returning to Replay |
| FM-066 | Player | Player top bar health HUD, ult rings, death timers, names toggle | `auto-only` | — | `e2e/player-health.spec.ts`, `e2e/player-names.spec.ts`, `e2e/player-topbar-writes.spec.ts` | |
| FM-067 | Player | Frozen-board / viewer write guard in Player mode | `auto-only` | — | `e2e/frozen-write-guard.spec.ts` | |

## 8. Match Import & Replays

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-070 | Replays | Load match by ID (summary tier vs Full replay tier, auto-fetch, format refresh/upgrade) | `smoke` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/match.spec.ts`, `e2e/player-tier.spec.ts`, `e2e/player-autofetch.spec.ts`, `e2e/player-format-refresh.spec.ts`, `e2e/player-format7.spec.ts`, `e2e/caddy-timeline.spec.ts` | Pass 001 #7: `match-tier` `title="Parsed from the replay file"` violates §4b |
| FM-071 | Replays | Upload `.dem` replay: drag-and-drop, file picker, reserve/queue wait UX, honest error messages | `auto-only` | — | `e2e/replay.spec.ts`, `e2e/upload-ux.spec.ts`, `e2e/replay-queue.spec.ts`, `e2e/replay-prompt.spec.ts`, `test/queue-label.test.ts` | |
| FM-072 | Replays | Replay picker & local replays folder (desktop app integration, preview cards, reparse) | `auto-only` | — | `e2e/replay-picker.spec.ts`, `e2e/replays-folder.spec.ts`, `e2e/desktop-reparse.spec.ts`, `test/picker.test.ts`, `test/folder.test.ts`, `test/reparse.test.ts` | Outdated app parser detected only after parse (TD-48) |
| FM-073 | Replays | Board clone carrying over replay reference (`clone-replay`) | `auto-only` | — | `e2e/clone-replay.spec.ts` | |

## 9. Vision & Map Layers

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-080 | Vision | Vision team filter (Both / Amber / Sapphire) & Show last seen location ghost | `deep` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/player-vision.spec.ts`, `test/vision.test.ts`, `test/shown.test.ts` | Keys `1`/`2`/`3`, dropdown, and two-user Follow verified in Pass 001 |
| FM-081 | Layers | Map layers toggles (camps, lanes, troopers, shops, crates, pings, etc.) & visibility | `deep` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/player-visible.spec.ts`, `e2e/follow-matrix.spec.ts`, `test/follow-layers.test.ts` | Pass 001 #3: popover clips off top & renders behind TopBar portraits at `1024×600` |
| FM-082 | Layers | K-preview (hold `K` to preview alternate layer/key state) | `auto-only` | — | `e2e/k-preview.spec.ts` | |

## 10. Builds, Tooltips, Stats & Recaps

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-090 | Builds | Tab / All builds overlay (`BuildColumn.tsx`, `BuildOrder.tsx`), hero inspect card (`HeroCard.tsx`) | `deep` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/player-inspect.spec.ts`, `e2e/panels.spec.ts`, `test/builds.test.ts`, `test/panels.test.ts` | Hidden columns stay mounted (TD-52); Pass 001 #4: `All builds` collides horizontally & overlaps map controls at `1024×600`/`800×600` |
| FM-091 | Tooltips | Game tooltips (`GameTooltip.tsx`): item & ability stats, upgrades, imbues, active effects (`ActiveEffects.tsx`) | `smoke` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/player-tooltips.spec.ts`, `test/tooltips.test.ts`, `test/effects.test.ts`, `test/cc.test.ts` | Hand-ported HUD CSS (TD-27); peak stacks on target effects (TD-47); known `#62` blank tier-1 box observed in Pass 001 |
| FM-092 | Stats | Calculated hero stat panel (`StatPanel.tsx`) at timestamp `t` | `smoke` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/player-stats.spec.ts`, `test/stats.test.ts` | Verified in desktop build column & tablet Build panel in Pass 001 |
| FM-093 | Recaps | Death skulls on map (`Skulls.tsx`), Skull recap (`SkullRecap.tsx`) & Death recap (`DeathRecap.tsx`) | `deep` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/player-death-skull.spec.ts`, `test/skulls.test.ts`, `test/recap.test.ts` | Recap z-index fixed below hero panels (TD-37); Pass 001 #8: stays open across large scrubs & Scene↔Replay switch (and mirrors to follower) |
| FM-094 | Panels | Movable/draggable floating panels (`panelPlace.ts`), z-order front-bring, pane clearance | `smoke` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/panels.spec.ts`, `test/panels.test.ts` | `.map-controls > *` DOM query clearance (TD-37); `skull-recap` drag & clearance verified in Pass 001 |

## 11. Sessions & Multi-Tab Follow

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-100 | Sessions | Session view (`/s/<id>#<tok>?tab=...`): tab strip, add game (`AddGame.tsx`), rename/reorder/remove tabs | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/sessions.spec.ts`, `e2e/sessions-polish.spec.ts`, `e2e/sessions-review.spec.ts`, `test/sessions-client.test.ts`, `test/sessions-details.test.ts` | Pass 002: `+ Add game`, tab menu (`Rename`/`Move left`/`Remove`/`Remove and revoke`), `1024×600` strip & phone Games sheet verified |
| FM-101 | Sessions | Tab switching isolation (no leaked timers/WebSockets/state across tabs, fast switch) | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/session-isolation.spec.ts`, `e2e/board-unmount.spec.ts`, `e2e/perf-session-switch.spec.ts`, `test/module-state.test.ts` | Pass 002: rapid 3-tab switching verified with zero console/page errors |
| FM-102 | Sessions | Follow across tabs (`session.tab`), people list "Session" group, avatar dots on tabs, "No access" handling | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/session-follow.spec.ts`, `test/session-follow.test.ts` | Phone has no people list yet (backlog 2026-11-14); "Not sent" dot label needs §4b check; Pass 002: two-user cross-tab follow, `Session` group, tab avatar dots, own-pick `Follow again`, and live `Remove and revoke` fallback verified |

## 12. Collaboration, Sync & Undo/Redo

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-110 | Collab | Join card (`JoinCard.tsx`): display name entry, seat persistence, presence list (`Presence.tsx`) | `smoke` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/presence.spec.ts`, `e2e/board.spec.ts` | 3 isolated contexts joined cleanly in Pass 001 |
| FM-111 | Collab | Two-user real-time sync: tokens, strokes, objectives, scenes, notes converge across peers | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/board.spec.ts`, `e2e/playtest.spec.ts`, `test/session.test.ts`, `test/soak-regressions.test.ts` | Pass 002: interleaved two-user edits + live presence cursor converged cleanly |
| FM-112 | Collab | Follow mode: follow presenter across scene, viewport, playback clock, jumps, and every view-state key | `deep` | Pass 001 (2026-11-21, 8c6ec5e) | `e2e/follow-matrix.spec.ts`, `e2e/player-follow-view.spec.ts`, `e2e/player-follow-jump.spec.ts`, `test/follow.test.ts`, `test/view-state.test.ts` | Fixed reconnect waits (TD-36); follow-matrix runtime (TD-34); Pass 001: scrub/vision/zoom/builds/Scene↔Replay mirrored cleanly; Pass 001 #2: tablet Follow button clipped |
| FM-113 | Collab | Undo / Redo (`Ctrl+Z` / `Ctrl+Shift+Z`) in single-user and multi-user sessions | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/board.spec.ts`, `e2e/playtest.spec.ts`, `test/session.test.ts` | Pass 002: two-user interleaved per-user `Ctrl+Z` / `Ctrl+Shift+Z` converged cleanly with zero errors |

## 13. Sharing, Roles & Board Files

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-120 | Sharing | Share dialog (`ShareDialog.tsx`): mint Edit & View links, copy link, list & revoke links | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/share.spec.ts`, `test/share.test.ts` | Pass 002 #3: no Revoke button in `ShareDialog.tsx` despite server `DELETE` API + `.revoked` CSS; revoked rows still show active `Copy` button |
| FM-121 | Sharing | Viewer role enforcement (read-only UI, no mutation controls, can still follow & inspect) | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/share.spec.ts`, `e2e/frozen-write-guard.spec.ts` | Pass 002 #4: live revocation closes WS (`Link revoked` in header) but centered alert says `"Invalid link"` and leaves board DOM visible behind scrim |
| FM-122 | Files | Export & import `.mapcro` board files (`boardfile.ts`) | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/board-file.spec.ts`, `test/boardfile.test.ts` | 8 MiB cap (TD-43); Pass 002: full export/import round-trip verified pixel-for-pixel |

## 14. Responsive, Touch, Phone & Tablet

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-130 | Phone | Phone portrait layout (`390x844` touch): board chrome, sheets, scene switching, map gestures | `smoke` | Pass 002 (2026-11-21, 8c6ec5e) | `e2e/phone.spec.ts`, `e2e/touch.spec.ts`, `e2e/touch-menu.spec.ts`, `test/long-press.test.ts` | Pass 002 #5: `"Scene 1"` overlaps top of first Amber portrait, bottom toolbar flush-right, `role-chip` truncates to `"Can edit..."`; Games sheet clean |
| FM-131 | Phone | Phone Player layout: transport grid, speed list (<=480px), events/builds sheets | `auto-only` | — | `e2e/phone-player.spec.ts`, `e2e/player-dock.spec.ts` | Upright phone speed list vs buttons (backlog 2026-11-14) |
| FM-132 | Tablet | Tablet & narrow desktop layouts (`1024x768` touch, `1024x600`, `800x600`) | `deep` | Pass 002 (2026-11-21, 8c6ec5e) | — (`test-gap` logged in Pass 001) | Pass 001 #1 (`800×600` header overflow clipping `More`), #2 (`1024×768` touch `.p-top` clipping `Follow`), #3 (`1024×600` `Map layers` clip & TopBar z-index clash), #4 (`All builds` collision), #6 (`170×170`/`164×164` squished map), #9 (tablet `Scenes` `▶` overlap); Pass 002: `1024×600` Session strip zero overflow |

## 15. Offline, Reconnect & Updates

| ID | Area | Feature & Entry Flow | Interactive Depth | Last Pass | Automated Tests | Issues / Notes |
|---|---|---|---|---|---|---|
| FM-140 | Resilience | Offline editing, IndexedDB persistence, reconnect & durable resend after server restart | `auto-only` | — | `e2e/board.spec.ts`, `e2e/follow-matrix.spec.ts`, `test/resend-durable.test.ts`, `test/soak-regressions.test.ts` | |
| FM-141 | Updates | App/client update banner (`UpdateBanner`, `update.ts`, `reload.ts`) | `auto-only` | — | `e2e/open-link.spec.ts`, `test/outdated.test.ts` | No install progress in desktop app (TD-45) |

---

## Summary Counts (Updated 2026-11-21, Pass 002)

- **Total rows:** 72 across 15 domains
- **`deep`:** 25 (`FM-002`, `FM-010`, `FM-020`, `FM-022`, `FM-025`, `FM-032`, `FM-034`, `FM-036`, `FM-037`, `FM-060`, `FM-061`, `FM-063`, `FM-080`, `FM-081`, `FM-090`, `FM-093`, `FM-100`, `FM-102`, `FM-111`, `FM-112`, `FM-113`, `FM-120`, `FM-121`, `FM-122`, `FM-132`)
- **`smoke`:** 23 (`FM-001`, `FM-003`, `FM-004`, `FM-005`, `FM-011`, `FM-012`, `FM-013`, `FM-021`, `FM-030`, `FM-033`, `FM-035`, `FM-040`, `FM-042`, `FM-050`, `FM-062`, `FM-065`, `FM-070`, `FM-091`, `FM-092`, `FM-094`, `FM-101`, `FM-110`, `FM-130`)
- **`auto-only`:** 24
- **`unmapped`:** 0
