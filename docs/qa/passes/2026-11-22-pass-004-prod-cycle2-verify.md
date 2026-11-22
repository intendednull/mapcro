# QA Pass 004: Cycle 2 Live Prod Verification & Deepening (2026-11-22)

- **Explorer:** Gemini 4 Neon (Medium)
- **Commit / Build:** Live production `https://mapcro.dmgdeadlock.com` running `e2438b4` (Phase 5 R1 + all 16 Cycle 1 QA fixes + Argon responsive UI polish; full asset packs present; GitHub Feedback enabled)
- **Charter:** Interactively verify all 16 Cycle 1 QA fixes, Argon responsive UI polish, and Phase 5 R1 (store v15) zero-regression live on production against cached reference replay `129738985` using `tools/qa-browser/` v1.3, while deepening `smoke` rows in `docs/qa/feature-map.md` to `deep` and hunting for live-prod-only regressions.
- **Feature Map Rows Touched:** `FM-010`, `FM-011`, `FM-013`, `FM-014`, `FM-021`, `FM-025`, `FM-030`, `FM-055`, `FM-056`, `FM-060`, `FM-063`, `FM-065`, `FM-066`, `FM-070`, `FM-071`, `FM-081`, `FM-090`, `FM-092`, `FM-112`, `FM-120`, `FM-121`, `FM-122`, `FM-130`, `FM-131`, `FM-132`, `FM-140` (26 rows touched; 9 deepened `smoke` → `deep`)
- **Viewports Tested:** `1440×900` desktop, `1024×600` narrow desktop, `800×600` narrow desktop, `1024×768 --touch` tablet, `390×844 --touch` phone
- **Console / Network Errors:** `0` page errors; `0` unexpected console errors; `0` unexpected network errors (only expected `net::ERR_ABORTED` on in-flight summary fetches superseded by Full replay load, plus benign font preload warnings)
- **Disposable Prod Boards Used:** 3 (`BEFBz0mpfNPLcBpicZzlgA` replay/session board, promoted blank game tab, and `nCzyhYFflE1isvac1U5kdw` `.mapcro` re-import round-trip)

---

## Verification Table: All 16 Cycle 1 Fixes & Phase 5 R1 Live on Prod (`e2438b4`)

| # | Area / Fix | Feature ID | Live Prod Result | Evidence / Measurements |
|---|---|---|---|---|
| 1 | `800×600` header fits (`scrollWidth <= 800`, `More` unclipped with Presenting + Full replay + Feedback + 4 peers) | `FM-010`, `FM-013`, `FM-132` | **PASS** | `hdrScrollW: 800`, `hdrClientW: 800`, `moreRight: 790` (unclipped) |
| 2 | `1024×600` `Map layers` popover stays inside viewport (`top >= 0`) and renders above TopBar portraits | `FM-081`, `FM-132` | **PASS** | `popTop: 62`, `popBottom: 384`, cleanly occludes TopBar portraits (`tbTop: 66`) |
| 3 | Argon narrow desktop (`1024×600` & `800×600`) stage breathing room & legible TopBar souls | `FM-011`, `FM-060`, `FM-132` | **PASS** | Crisp minimap breathing room, legible souls banners at `1440×900`, `1024×600`, `800×600` |
| 4 | Argon `All builds` (Tab) at `1024×600` & `800×600` (+ `1440×900` desktop clean) | `FM-090`, `FM-132` | **PASS** | `1024×600`: 12 clean columns (`maxColBottom: 368 < ctrlTop: 390`); `800×600`: 12 columns sit cleanly above `Map layers`/`Vision`/`Flip map` with zero control overlap; `1440×900` spotless |
| 5 | Tablet (`1024×768 --touch`) `.p-top` header fits & `Follow` unclipped while peer presents + Full replay | `FM-112`, `FM-132` | **PASS** | `topScrollW: 359 / topClientW: 359`, `Follow` pill `right: 977 <= 1024` |
| 6 | Tablet (`1024×768 --touch`) `Scenes` drawer rows breathing room & `▶` touch circle clearance | `FM-132` | **PASS** | Visual inspection confirmed clean row spacing; `▶` touch circle does not touch adjacent rows |
| 7 | Phone (`390×844 --touch`) Session Scene shell: `"Scene 1"` above portraits & `.p-tools` centered over `Player` | `FM-130` | **PASS** | `sceneTitle.bottom: 106 < topbar.top: 116`; `pToolsCenter: 195 === playerBtnCenter: 195 === 195` |
| 8 | Phone (`390×844 --touch`) Session Scene `role-chip` shows `"Can edit"` without ellipsis | `FM-130`, `FM-014` | **FAIL (prod-only regression)** | Live prod renders `[data-testid="feedback-open"]` (`109 px`), causing `.p-top` to overflow `468 / 390` (`+78 px`), crushing `role-chip` to `16 px` (`"C"`) and clipping `Feedback` off-screen (Finding #1) |
| 9 | Phone (`390×844 --touch`) `Vision` `<select>` omits `[1]`/`[2]`/`[3]` brackets while desktop keeps them | `FM-131`, `FM-130` | **PASS** | Phone: `Vision: Hidden King` / `Archmother` / `All` (`hasBrackets: false`); Desktop: `Vision: Hidden King [1]` / `Archmother [2]` / `All [3]` |
| 10 | Events `Ults` shows localized ability names & excludes non-ult signature casts | `FM-063` | **PASS** | 110 ults (`Shining Wonder`, `Bullet Dance`, `Rule, Ratannia!`, `Itani Lo Sahn`, `Telekinesis`, `Goo Ball`, etc.); `hasRawSlug: false`, `hasNonUlt: false` |
| 11 | `[data-testid="match-tier"]` has no provenance prose `title` (§4b clean) | `FM-070` | **PASS** | `matchTierText: "Full replay"`, `matchTierTitle: null` |
| 12 | Jumping to unnamed `Scene 1` shows `Scene “Scene 1”` (not `Scene “”`) on bottom handoff bar | `FM-065`, `FM-130` | **PASS** | Verified `Scene “Scene 1”` + `↩ Back to 31:20` visually and in DOM |
| 13 | Returning to Replay auto-dismisses `"Back to replay"` toast | `FM-065` | **PASS** | `Saved scene 2 · Back to replay` toast disappears immediately on `Back to 31:20` (`toastImmediate: []`, `toastAfter4500ms: []`) |
| 14 | Landing corrupt `bad.dem` upload + `Open match` reports `"Not a replay. Pick the match's .dem file."` | `FM-071` | **PASS** | Verified exact alert copy (not `"Invalid id"`) |
| 15 | `HeroPicker` disabled tiles carry clean `title="<Hero>"` (§4b, no prose) | `FM-025` | **PASS** | Disabled tiles carry exact hero names (`"Abrams"`, `"Apollo"`, `"Celeste"`, etc.); `hasProse: false` |
| 16 | Live View-only link revocation shows `"Link revoked"`, unmounts board DOM, and owner `ShareDialog` hides `Copy` on revoked row | `FM-120`, `FM-121` | **PASS** | Before revoke: `mapCount: 1, mainCount: 1`; after `DELETE` (`204`): `hasLinkRevoked: true`, `hasInvalidLink: false`, `mapCount: 0, mainCount: 0`; owner `ShareDialog` shows strikethrough row with no `Copy` button |
| R1-A | Phase 5 R1 world layers (`10:30` Urn, `12:10` Rift + deaths, `31:20` Rejuvenator + Mid-Boss) + v1.3 `hover --force` / `move` | `FM-055`, `FM-056`, `FM-066` | **PASS** | All world layers render accurately; `hover --force` on `.mk.urn.lit` → `"Urn delivery point"`, `.mk.midboss` & `move (677,471)` → `"Respawns in 6:45"` |
| R1-B | Save scene from `31:20`: scene hero health arcs stay OFF on R1 | `FM-065`, `FM-043` | **PASS** | `tokHealth: 0` in saved `31:20` scene (vs `10` in Player) |
| R1-C | `.mapcro` export (`version <= 4`, `rows == 16`) & re-import round-trip | `FM-122`, `FM-021` | **PASS** | Exported `{ format: "mapcro-board", version: 4, rows: 16, records: 117, matches: 1 }`; re-imported cleanly with both scenes + `Full replay`; inline Scene clone created `"Match moment copy"` |

---

## What Was Explored
- **Landing & Upload validation (`FM-071`, `FM-070`):** Uploaded `/tmp/qa-pass-004/bad.dem` on `/` and clicked `Open match`; confirmed honest `"Not a replay. Pick the match's .dem file."` alert. Reloaded `/` and opened cached reference match `129738985` into Board 1 (`Full replay`, `match-tier` `title: null`).
- **Desktop Player, Events, World Layers & Handoff (`FM-055`, `FM-056`, `FM-063`, `FM-065`, `FM-066`, `FM-030`, `FM-092`):** Filtered Events to `Ults` (110 localized ults, zero raw slugs or non-ult casts). Inspected hero build column + `StatPanel` at `10:00` and `31:20`. Exercised map wheel zoom, drag pan, and zoom reset. Scrubbed to `10:30` (Urn), `12:10` (active Unstable Rift + death skull + death timers), and `31:20` (3-revive Rejuvenator HUD + downed Mid-Boss), verifying map marker hover tips via v1.3 `hover --force` and `move`. Saved `31:20` scene (confirming `tokHealth: 0` on R1), switched to unnamed `Scene 1` (confirming `Scene “Scene 1”` handoff label), inspected `HeroPicker` disabled tiles (`title="<Hero>"`), and returned to Replay (confirming toast auto-dismiss).
- **Responsive Narrow Desktop, Tablet & Phone (`FM-010`, `FM-011`, `FM-013`, `FM-060`, `FM-081`, `FM-090`, `FM-112`, `FM-130`, `FM-131`, `FM-132`):** Tested `1440×900`, `1024×600`, and `800×600` with `Map layers` popover, `All builds`, and live `Presenting` state (triggered via a second desktop context `coachB` following `CoachA`). Verified Tablet `1024×768 --touch` `.p-top` header with `Follow` + `Full replay` and `Scenes` drawer spacing. Verified Phone `390×844 --touch` `Map layers` `Vision` `<select>` (no shortcut brackets). Promoted Board 1 to a Session (`+ Add game → Blank board`) and inspected Phone `390×844 --touch` Session Scene shell, catching Finding #1.
- **Sharing, Live Revocation, `.mapcro` Round-Trip & Reload Persistence (`FM-120`, `FM-121`, `FM-122`, `FM-021`, `FM-140`):** Minted a View-only link in `ShareDialog`, joined in isolated `viewer` context, revoked via `DELETE /api/boards/<id>/links/<link_id>` (`204`), and verified `"Link revoked"`, unmounted board DOM, and hidden `Copy` on owner's revoked row. Captured `.mapcro` export JSON (`version: 4`, `rows: 16`), verified full page reload persistence on Board 1, re-imported `.mapcro` into Board 3, and cloned `Match moment` into `Match moment copy`.

---

## Findings

| # | Severity | Feature ID | Summary & Repro | Action Taken / Link |
|---|---|---|---|---|
| 1 | `bug-minor` | `FM-130`, `FM-014` | **Phone (`390×844 --touch`) Session Scene `.p-top` header overflows by `+78 px` (`468 / 390`) on live prod when `Feedback` is enabled, crushing `role-chip` to `16 px` (`"C"`) and clipping `Feedback` off-screen.** Repro: on live prod (where GitHub feedback is configured), open a 2-game Session (`/s/<id>#<tok>`) at `390×844 --touch` on a Scene tab with a match-titled game (`"Match 129738985"`). Measured widths: `wordmark` `87 px` (`board.css:1091` only hides `.wordmark span` at `<= 360px`, not `<= 420px`) + `games-open` `145 px` + `save-status` `73 px` + `feedback-open` `109 px` (`flex: none`) leave `0 px` for `role-chip` (shrinking it to `16 px` `"C"`) and push `Feedback` to `right: 468`. (`"Scene 1"` portrait clearance and centered `.p-tools` over `Player` ARE fixed.) | Logged in `docs/backlog.md` & `docs/qa/feature-map.md`; route header compaction to approved design model |
| 2 | `test-gap` | `FM-130`, `FM-014` | **Phone header overflow regressions escape automated e2e because local/CI servers omit `[data-testid="feedback-open"]`.** `phone.spec.ts` and `phone-player.spec.ts` test `.p-top` fit without GitHub feedback configured, missing `109 px` of production header chrome. | Logged in `docs/backlog.md` & `docs/qa/feature-map.md` |

---

## Automated Test & Backlog Feedback
- **Backlog updated:** Added Pass 004 findings (`#1 bug-minor`, `#2 test-gap`) to `docs/backlog.md` and marked Cycle 1 Pass 001–003 fixes as verified live on prod `e2438b4` (except the prod-Feedback phone Session header case).
- **Feature map updated:** Updated 26 rows in `docs/qa/feature-map.md` to `Pass 004 (2026-11-22, e2438b4)` and deepened 9 rows from `smoke` → `deep` (`FM-011`, `FM-013`, `FM-021`, `FM-030`, `FM-055`, `FM-056`, `FM-066`, `FM-092`, `FM-140`), bringing the map to **43 `deep` / 27 `smoke` / 2 `auto-only` / 0 `unmapped`**.

---

## Process Meta-Notes (Mandatory — Evaluating `tools/qa-browser/` v1.3)
- **What worked great in v1.3 (`move` & `hover --force`):**
  - `hover <tab> <selector> --force` solved Pass 003's pointer-interception timeout under `<svg class="mm-overlay">` completely! Hovering `[data-testid=map] .mk.urn.lit`, `.mk.midboss`, and `.mk.koth` succeeded on the first try and triggered live `HoverLabel` tooltips (`"Urn delivery point"`, `"Respawns in 6:45"`).
  - `move <tab> <x> <y>` worked cleanly for direct coordinate hover (e.g. `move coachA 677 471` → `"Respawns in 6:45"`), making visual/canvas hover verification fast and reliable.
- **Friction / gap noticed in v1.3 filtered `snapshot`:**
  - Even with `trooper`, `tok-health`, `scrub-tick`, `lane-edge`, and `lane-path` filtered out, `snapshot coachA` on a loaded Player screen still reported **`1254 visible` candidates** (truncating at `--max 120` before reaching bottom transport/toolbar controls). Inspecting `[data-testid]` counts showed why: the scrollable Events list renders `recap-hit` (`716`), `recap-icon` (`442`), `event` (`291`), `event-pick` (`291`), `event-jump` (`291`), and `death-recap` (`74`) in the DOM even when scrolled out of the visible scroll container!
- **Blind spots / live-prod value:**
  - Testing against live production immediately caught Finding #1 (`Feedback` button overflowing the `390 px` phone Session header) — a class of config-dependent chrome bug that local dev/e2e servers never render.
- **Suggested upgrade for next pass (v1.4):**
  1. In `tools/qa-browser/daemon.mjs` `snapshot`, clip visibility checks against scrollable ancestor bounds (or exclude off-viewport/scrolled-out children of overflow-scroll containers like `[data-testid=events]`, plus filter non-interactive `recap-hit` / `recap-icon` / `death-recap` from `snapshot`) so a Player `snapshot` lists all real chrome/transport/toolbar controls without hitting the 120-item cap.
  2. Add a small `download <tab> <selector> <out-file>` helper (using Playwright's `waitForEvent('download')`) so `.mapcro` export testing doesn't require hooking `URL.createObjectURL` via `eval`.
