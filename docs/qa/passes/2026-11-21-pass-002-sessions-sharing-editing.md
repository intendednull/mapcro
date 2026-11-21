# QA Pass 002: Sessions, Sharing/Roles, Board Files, Scenes & Drawing, and Multi-User Undo/Redo (2026-11-21)

- **Explorer:** Gemini 4 Neon (medium)
- **Commit / Build:** `8c6ec5e` (TD-145 prebuilt `/tmp/lead-gate/target/debug/mapcro-server` + `/tmp/lead-gate/web/dist`; local asset packs present: yes; `tools/qa-browser/` v1.1 on `81f10dc`)
- **Charter:** Exercise the major un-exercised domains of mapcro interactively across isolated users (`coachA`, `coachB`, `viewer`, `phone`): Landing & Boards list (`FM-001`–`FM-005`), Scenes, Roster & Drawing tools (`FM-012`, `FM-020`–`FM-025`, `FM-030`–`FM-038`, `FM-040`–`FM-042`, `FM-050`), Sharing, Viewer role & live revocation (`FM-120`–`FM-121`), `.mapcro` export/import round-trip (`FM-122`), Sessions & Multi-Tab Follow (`FM-100`–`FM-102`, narrow desktop + phone), Two-user simultaneous editing & per-user Undo/Redo (`FM-111`, `FM-113`), plus a spec §4b label/hover audit and v1.1 driver evaluation.
- **Feature Map Rows Touched:** `FM-001`, `FM-002`, `FM-003`, `FM-004`, `FM-005`, `FM-012`, `FM-013`, `FM-015`, `FM-020`, `FM-021`, `FM-022`, `FM-025`, `FM-030`, `FM-032`, `FM-033`, `FM-034`, `FM-035`, `FM-036`, `FM-037`, `FM-040`, `FM-042`, `FM-050`, `FM-100`, `FM-101`, `FM-102`, `FM-111`, `FM-113`, `FM-120`, `FM-121`, `FM-122`, `FM-130`, `FM-132` (32 rows touched; 20 newly moved out of `auto-only`)
- **Viewports Tested:** `1440×900` (desktop, 3 isolated contexts `coachA`/`coachB`/`viewer`), `1024×600` (narrow desktop Session strip), `390×844 --touch` (phone Session + Games sheet)
- **Console / Network Errors:** Zero uncaught `pageerror`s and zero app console errors across all flows. One expected `502 Bad Gateway` on `GET /api/matches/129738985` during Session `Add game → Load a game` because `qa-browser --mock-replay-129738985` seeds the replay cache without mocking the external Deadlock metadata API (see Meta-Notes); one expected `net::ERR_ABORTED` when clicking `Get the Linux app` (direct GitHub AppImage download aborted by headless Playwright).

## What Was Explored

1. **Landing, Recent Boards & Dead Links (`FM-001`–`FM-004`):**
   - Opened `/` (`1440×900`), inspected `AppDownload` (`Get the Linux app`), created two boards (`Pass 2 Alpha`, `Pass 2 Beta`), joined as `Coach A`, returned via wordmark.
   - Tested inline board rename (`known-rename`) + `Enter` → **caught Finding #1** (navigates into the board on `Enter`).
   - Tested `known-remove` → verified `Removed Pass 2 Beta V2 · Undo` toast and confirmed `Undo` restores the board to "Your boards".
   - Opened malformed/dead URLs `/b/nonexistent#badtok` and `/s/nonexistent#badtok` → both rendered clean `Invalid link` alert with `New board` CTA and zero errors.
2. **Scenes, Roster, Objectives & All Drawing Tools (`FM-012`, `FM-020`–`FM-022`, `FM-025`, `FM-030`, `FM-032`–`FM-037`, `FM-040`, `FM-042`, `FM-050`):**
   - Added scenes via `+` and hotkey `T`, renamed Scene 4 to a 48-character title (`Mid-game Urn Setup & Amber Walker Pressure 12345`, verified header + tree ellipsis + hover thumbnail), duplicated a scene (`scene-clone`), nested Scene 3 under Scene 2 via tree drag-and-drop.
   - Typed a scene note and clicked another scene in the tree without manually blurring first → blur-save preserved the note cleanly.
   - Right-clicked TopBar portrait (`hero-menu`) → opened `HeroPicker`, verified uniqueness enforcement on disabled slots (**caught Finding #2** §4b sentence `title` tooltips), swapped King 1 to `Dynamo`.
   - Dragged Sapphire hero token (`Rem`) on map (verified `[data-testid="hover-label"]` `"Archmother 4, Rem"`), toggled map objective, exercised all tools via hotkeys (`E` Draw, `A` Arrow, `S` Comment, `W` Laser, `Q` Select, `C` Clear menu), Palette colour switching (`Cinnabar` → `Lime`), right-click `placed-menu` on comment (bubble side `Above/Below/Left/Right`, `No colour`, recolour `Ice`) and arrow (recolour `Rose`), wheel zoom + stencil clipping + zoom reset.
3. **Sharing, Viewer Role & Live Revocation (`FM-120`, `FM-121`):**
   - Opened `ShareDialog`, minted `Spectator` (`View only`) and `Co-coach` (`Can edit`) links → **caught Finding #3** (`ShareDialog` has no Revoke button).
   - Opened `Spectator` in isolated `viewer` context (`1440×900`): verified read-only UI (`Look [Q]`, `Laser [W]`, `Colour`, `Comments`, `Clone` main action, no `Share`/`scene-add`/`scene-delete`/editable note), verified `viewer` can `Follow` `Coach A` (`Following Coach A · scene 4/4 · Stop`) and pan/zoom.
   - Revoked `Spectator` live via `DELETE /api/boards/<id>/links/<link_id>` while `viewer` was connected → server closed WS immediately (`Link revoked` in header), **caught Finding #4** (centered overlay says `"Invalid link"` and leaves full board DOM visible behind blurred scrim; reopened `ShareDialog` shows strikethrough revoked row still with active `Copy` button).
4. **Board File Export & Import Round-Trip (`FM-122`, `FM-013`):**
   - Audited `MoreMenu` (`Clone`, `Download`, `Open in app`, `Get the app` — zero hover text, §4b clean).
   - Exported `Pass 2 Alpha` (`GET /api/boards/<id>/export` → `/tmp/qa-pass-002/export.mapcro`, 15 KB) and imported it back via `/` using v1.1 `upload` on `testid:import-board-file`.
   - Visually and programmatically verified pixel-for-pixel survival of all 4 scenes, Scene 3 nesting, 48-char Scene 4 title + note, `Dynamo` roster swap, dragged `Rem` token, Cinnabar stroke, Rose arrow, and Ice comment `"Push Amber Walker here"`.
5. **Sessions, Multi-Tab Follow & Responsive Viewports (`FM-005`, `FM-100`–`FM-102`, `FM-130`, `FM-132`):**
   - Promoted board to Session via `+ Add game`, added `Game 3 Scrim` and `Pass 2 Beta V2`, inspected tab context menu (`Rename`, `Move left`, `Remove`, `Remove and revoke`), renamed Tab 3 to `Game 3 Finals`, rapid-switched tabs with zero errors/leaks.
   - Minted Session `Can edit` link via `session-share`, joined in isolated `coachB` (`1440×900`). Verified `Session` group in People list (`session-follow-Coach A`) and tab avatar dots (`title="Coach A"`).
   - Verified `coachB` follows `coachA` across tabs (`Pass 2 Alpha` → `Game 3 Scrim`), picking Tab 3 manually stops follow and shows `Stopped following Coach A · Follow again`, and `Remove and revoke` on Tab 3 while `coachB` was on it cleanly moved `coachB` to `Game 3 Scrim` with zero errors.
   - Checked Session strip at `1024×600` (zero header/strip/doc overflow) and `390×844 --touch` (`phone` context + Games bottom sheet) → **caught Finding #5** (phone Scene shell heading/portrait overlap, right-aligned bottom toolbar, truncated `role-chip`).
6. **Two-User Simultaneous Editing & Per-User Undo/Redo (`FM-111`, `FM-113`):**
   - With `coachA` and `coachB` both editing `Game 3 Scrim`, interleaved `coachA` stroke 1 → `coachB` arrow → `coachA` stroke 2.
   - `coachA` `Ctrl+Z` undid only `coachA`'s stroke 2 (preserving `coachB`'s arrow); `coachB` `Ctrl+Z` undid `coachB`'s arrow; both `Ctrl+Shift+Z` redid cleanly with exact convergence (`Saved`, zero errors).
7. **Spec §4b Label & Hover Audit:**
   - Audited all `title` attributes across Landing, Board header, Session strip, SceneTree, TopBar, Toolbar, MoreMenu, ShareDialog, and HeroPicker. Everything passed §4b except `HeroPicker` disabled options (Finding #2).

## Findings

| # | Severity | Feature ID | Summary & Repro | Action Taken / Link |
|---|---|---|---|---|
| 1 | `bug-minor` | `FM-002` | **Landing inline board rename navigates into the board on `Enter`.** On `/`, click `[data-testid="known-rename"]` on a board in "Your boards", edit the title, press `Enter`. Observed: title saves AND the page immediately navigates to `/b/<id>#<tok>` (reproduced twice). Expected: commit rename and stay on `/`. Evidence: `/tmp/qa-pass-002/03-recent-boards.png` + `location.pathname` check. | Logged in `docs/backlog.md` + `feature-map.md` |
| 2 | `label-violation` | `FM-025` | **`HeroPicker` disabled tiles use sentence-style `title` tooltips violating spec §4b.** Right-click a TopBar portrait → `Change hero…`. Disabled tiles carry `title="Abrams: Archmother Player 2 has this hero"`, `title="Baba: Hidden King Player 4 has this hero"`, etc. — full sentence prose repeating text already shown on the tile. Evidence: `/tmp/qa-pass-002/09-hero-picker.png`. | Logged in `docs/backlog.md` + `feature-map.md` |
| 3 | `ux-rough` | `FM-120` | **`ShareDialog` has no Revoke button for minted links, and keeps `Copy` active on revoked rows.** Open `Share` as owner, mint a link, inspect `All links`: `ShareDialog.tsx` renders an empty `<span />` in column 3 (`line 144`) despite server `DELETE /api/{boards,sessions}/{id}/links/{link}`, `api.revoke()`, and `.link-row.revoked` CSS all existing. Once revoked via API, the strikethrough row still shows an active `Copy` button. Evidence: `/tmp/qa-pass-002/16b-share-minted.png`, `/tmp/qa-pass-002/17c-share-revoked-row.png`. | Logged in `docs/backlog.md` + `feature-map.md` |
| 4 | `bug-minor` | `FM-121` | **Live-revoked viewer overlay says `"Invalid link"` (contradicting `"Link revoked"` in header) and leaves board DOM visible behind scrim.** Revoke an active viewer's link while connected (`DELETE /api/boards/<id>/links/<link_id>`). Header `[data-testid="save-status"]` shows `"Link revoked"`, but centered `[data-testid="dead-link"]` alert says `"Invalid link"` and full board map/drawings/notes remain rendered behind the blurred scrim. Evidence: `/tmp/qa-pass-002/17b-viewer-revoked.png`. | Logged in `docs/backlog.md` + `feature-map.md` |
| 5 | `ux-rough` | `FM-130` | **Phone (`390×844 --touch`) Scene shell layout roughness.** In a Session on phone: `h1` `"Scene 1"` touches/overlaps the top of the first Amber portrait; bottom toolbar (`Look`/`Laser`/`Edit`/`Colour`) sits flush-right (`x=159..372`) while `Player` below is centered; header `role-chip` (`Can edit · Hidden King side`) truncates to `"Can edit..."`. Route visual fixes to approved design models per Playbook Guardrail #4. Evidence: `/tmp/qa-pass-002/28-session-phone.png`, `/tmp/qa-pass-002/29-session-phone-games.png`. | Logged in `docs/backlog.md` + `feature-map.md` |
| 6 | `test-gap` | `FM-002`, `FM-025`, `FM-120`, `FM-121` | **Automated coverage gaps surfaced by interactive flows.** Add: (a) `e2e/boards-list.spec.ts` assertion that `Enter` on `known-rename` keeps `pathname === "/"`; (b) `test/labels.test.ts` guard for `HeroPicker` `title` prose; (c) `e2e/share.spec.ts` live revocation test verifying `"Link revoked"` copy and cleared board view. | Logged in `docs/backlog.md` + `feature-map.md` |

## Automated Test & Backlog Feedback

- **Regression tests recommended (for fix worker, fail-before-fix):**
  - `web/e2e/boards-list.spec.ts`: inline rename + `Enter` stays on `/` and updates title.
  - `web/test/labels.test.ts`: ensure `HeroPicker` disabled tiles don't emit `"has this hero"` sentence titles.
  - `web/e2e/share.spec.ts`: live revocation of a View link shows `"Link revoked"` (not `"Invalid link"`) and hides `Copy` on revoked rows (plus UI Revoke button once decided/wired).
- **Backlog updated:** Added `## Exploratory QA Pass 002 findings (2026-11-21)` at the top of `docs/backlog.md`.
- **Feature map updated:** Deepened 20 previously `auto-only` rows (and 12 already-mapped rows) in `docs/qa/feature-map.md`.

## Process Meta-Notes (Mandatory)

- **v1.1 driver evaluation (what worked great):**
  - **Visible-first locators** completely eliminated the Pass 001 hidden-duplicate timeouts across desktop/phone/popover flows.
  - **`upload` command** worked cleanly on the first try (`upload coachA testid:import-board-file /tmp/qa-pass-002/export.mapcro`), making `.mapcro` round-trip verification effortless without needing a visible `<input type="file">`.
  - **`<summary>` + ancestor-opacity `snapshot`** was noticeably cleaner than v1.
- **Friction & remaining blind spots in `tools/qa-browser/` v1.1:**
  1. **`--mock-replay-129738985` does not mock `GET /api/matches/129738985`:** Entering `129738985` in Landing or Session `Add game → Load a game` hits the unmocked Deadlock metadata API and fails with `502 Bad Gateway`, preventing one-click creation of a Replay tab inside a Session without extra workarounds.
  2. **Two residual `snapshot` visibility leaks:** Elements inside closed `<details>` (`replay-help-steps`) and closed `Map layers` popovers (`heals-toggle`, `crates-toggle`) still appeared in `snapshot`'s visible list because they collapse via `<details>` closed state or `max-height`/`clip` rather than `display: none`/`opacity: 0`.
  3. **No `rclick` / `click` by coordinates:** Right-clicking SVG map items required inspecting DOM selectors first; a coordinate click/rclick option (`click --at x,y` / `rclick --at x,y`) would speed up canvas exploration.
- **Suggested v1.2 upgrade for next pass:**
  1. Extend `--mock-replay-129738985` to also spin up a tiny local mock match-metadata HTTP handler (passed via `--match-api-base`) for `129738985` so `Add game → Load a game` and Landing `Open match` work offline end-to-end.
  2. Tighten `snapshot`'s `vis()` to skip non-`<summary>` descendants of closed `<details:not([open])>` and elements clipped inside zero-height `overflow: hidden` ancestors.
