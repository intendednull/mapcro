# QA Pass 006: Live Prod Verification of Phase 5 R3 + `#62` Tooltips & 100% Deep Feature Map Coverage (2026-11-24)

- **Explorer:** Gemini 4 Neon (Medium)
- **Commit / Build:** Live production `https://mapcro.dmgdeadlock.com` running `c8d5782` (Phase 5 R3 `c94cdac` store v17 floor 16 + Feedback `#62` property-only ability upgrade tooltips + deployed `6864-upgrades` asset pack, `client_version: 6864`, 769 blobs)
- **Charter:** Two required goals on live production using cached reference 6v6 replay `129738985` and `tools/qa-browser/` v1.5: (1) verify Phase 5 R3 Group B (`1:00`, `10:30`, `11:30`, `12:40`, `31:20`), `.mapcro` v6 export + TD-162 matchless import, and Feedback `#62` property-only ability upgrade tooltips (`FM-091`) on pack `6864-upgrades`; (2) deepen ALL 14 remaining `smoke` rows in `docs/qa/feature-map.md` to `deep` (`70/70` web-testable rows = 100% `deep`).
- **Feature Map Rows Touched:** `FM-001`, `FM-003`, `FM-004`, `FM-005`, `FM-031`, `FM-038`, `FM-041`, `FM-050`, `FM-053`, `FM-054`, `FM-055`, `FM-056`, `FM-064`, `FM-065`, `FM-073`, `FM-091`, `FM-094`, `FM-110`, `FM-122` (19 rows touched; all 14 remaining `smoke` rows deepened → `deep`)
- **Viewports Tested:** `1440×900` desktop (isolated `coachA` + `coachB`), `800×600` narrow desktop, `390×844 --touch` phone
- **Console / Network Errors:** `0` console errors; `0` page errors; `0` unexpected network errors across all 3 tabs (`coachA`, `coachB`, `phone` — only expected `net::ERR_ABORTED` on superseded match summary fetches and benign font preload warnings)
- **Disposable Prod Boards Used:** 5 (`aS1HQiV9D2sPNcUxJ_0iIQ` landing/objectives/presence board promoted into Session `0BpdJF7GvsJKORNqwigtJg` with 1 new Game 2 tab; `ghtdpgoI5AuvdHjlSqoncw` replay `129738985` R3 + `#62` board; `U0fNzXrkYIGNFseo7bfPhA` TD-162 matchless `.mapcro` v6 import; `qsxAggqCk2e5wWj78U_ZFg` `FM-073` replay clone)

---

## Verification Table: Goal 1 Live on Prod (`c8d5782` + pack `6864-upgrades`)

| # | Area / Feature | Feature ID | Live Prod Result | Evidence / Measurements |
|---|---|---|---|---|
| 1 | Phase 5 R3 `1:00` (`60s`) saved scene | `FM-054`, `FM-065` | **PASS** | `0` Retake buttons; `8` open shops (`shop[data-status="Active"]`); `51` unspawned camps down with hover countdown timer (`"Spawns in 7:00"`); Mid-Boss (`Active`, `"Mid-Boss 100%"`, matching Player mode at `1:00`) |
| 2 | Phase 5 R3 `10:30` (`630s`) saved scene | `FM-055`, `FM-065` | **PASS** | `0` Retake buttons; carried Urn (`.pl-urn.urn-carried[data-state="carried"]`, count `1`); lit delivery point (`urn:neutral:lane6:1` `Active` `.mk.urn.lit`, `6` `.urn-pulse` elements) |
| 3 | Phase 5 R3 `11:30` (`690s`) saved scene | `FM-056`, `FM-065` | **PASS** | `0` Retake buttons; pre-live announced Rift (`rift:neutral:lane1:1` `Active`, `lane6` `Destroyed`, `0` `rift-rings`, hover `"Rift opens in 0:46"`) |
| 4 | Phase 5 R3 `12:40` (`760s`) saved scene + 1-click toggles | `FM-054`, `FM-056`, `FM-065` | **PASS** | `0` Retake buttons; active Rift capture rings (`testid:rift-rings` = `1`); `4` open shops (lane shops closed); 1-click camp revive (`click --force` on `camp:neutral:lane1:10` flipped `Destroyed` `"Respawns in 0:21"` → `Active`, cleared timer); 1-click Rift swap (`lane1 Active` → `lane6 Active`, `rings: 1 → 0`) and toggle-off (`both Destroyed`) |
| 5 | Phase 5 R3 `31:20` (`1880s`) saved scene | `FM-056`, `FM-065` | **PASS** | `0` Retake buttons; Sapphire 3-revive Rejuvenator HUD (`[data-testid=tb-rejuv][data-team="sapphire"][data-left="3"]`) + Mid-Boss respawn ring icon on Scene TopBar (visually verified in screenshot) + `10` `[data-testid=tok-health]` hero health arcs |
| 6 | `.mapcro` v6 export + TD-162 matchless import | `FM-122`, `FM-056`, `FM-065` | **PASS** | `qa-browser.mjs download` exported `{ format: "mapcro-board", version: 6, rows: 40, matches: 1 }`; after `jq '.matches = []'` + `POST /api/boards/import` (`U0fNzXrkYIGNFseo7bfPhA`, `matchTier: null` / zero match open), `11:30` rendered `"Rift opens in 0:46"` (`lane1 Active`, `lane6 Destroyed`, `0` rings), `12:40` rendered `1` active Rift ring & `4` open shops, and `31:20` rendered Sapphire 3-revive Rejuv & `10` hero health arcs |
| 7 | Feedback `#62` property-only ability upgrade tooltips (`20:00`, pack `6864-upgrades`) | `FM-091`, `FM-031` | **PASS (with 1 minor finding)** | `/api/packs` lists `client_version: 6864` (`62feb9ec...`) first; `Napalm` T1 `.gt-tier-props` `"+1 Charges"`, `Flame Dash` T1 `"-12s Cooldown"`, `Itani Lo Sahn` all 3 tiers (`"+8m Dash Range"`, `"-35s Cooldown"`, `"+50% Bonus Damage"`), `Hex-Lined Snap Trap` T1/T2 (`"-11s Cooldown"`, `"+1s Immobilize Duration"`), `0` blank upgrade tiers across all 12 inspected abilities; items (`Improved Spirit`), spirit scaling (`×0.6`), and visually inspected tooltip screenshots clean. **Finding #1 (`bug-minor`):** Apollo's `Riposte` T3 displays literal `&amp;` in visible text (`"Bullet, Spirit &amp; Melee Lifesteal"`) |

---

## What Was Explored

- **Goal 1 — Phase 5 R3 Group B & TD-162 (`FM-054`, `FM-055`, `FM-056`, `FM-065`, `FM-122`):** Opened `129738985` from `/` (`Full replay`), saved all 5 R3 scenes (`1:00`, `10:30`, `11:30`, `12:40`, `31:20`), verified zero Retake buttons, open shop counts (`8` at `1:00` vs `4` at `12:40`), unspawned camp countdown hover (`"Spawns in 7:00"`), carried Urn + lit delivery point at `10:30`, pre-live announced Rift (`"Rift opens in 0:46"`) at `11:30`, active Rift capture rings + 1-click camp revive (`camp:neutral:lane1:10`) + 1-click Rift swap/toggle at `12:40`, and Sapphire 3-revive Rejuvenator HUD + Mid-Boss respawn indicator + `10` hero health arcs at `31:20`. Exported `.mapcro` v6 (`version: 6, rows: 40`) via `download`, stripped `matches`, imported via `POST /api/boards/import`, and verified `11:30`, `12:40`, and `31:20` render identically with zero match open.
- **Goal 1 & Goal 2 — Feedback `#62` & Game Tooltips (`FM-091`, `FM-031`):** Verified `/api/packs` lists `6864` first and all `450` `<img>` + `15` `<svg image>` pack elements loaded from `62feb9ec...` with `brokenCount: 0`. Inspected all 12 abilities across Infernus, Apollo, and Venator at `20:00` (all `#62` `.gt-tier-props` tiers rendered with `0` blank upgrade boxes), plus item tooltip (`Improved Spirit`), spirit scaling, mouse-out and `Escape` dismissal, and narrow-viewport `800×600` clamping/flipping on both left-side (`Amber-0`, `197..633 × 178..592`) and right-side (`Sapphire-5`, flipped left `62..499 × 202..563`) heroes — both `onScreen: true`. Caught Finding #1 (`&amp;` entity in Apollo `Riposte` T3).
- **Goal 2 — Deepening All Remaining `smoke` Rows → `deep` (100% Web Coverage):**
  - `FM-001` & `FM-004`: Verified `/` wordmark, desktop (`1440×900`) and phone (`390×844 --touch`, `scrollW: 390 === clientW: 390`, `newBoardBtn: 107×46`) layouts, `New board` creation & `/b/<id>#<tok>` navigation, Match ID `129738985` quick-open, `"Where's my replay?"` disclosure open/close, GitHub link (`target="_blank"`), and all 3 Linux AppImage download links (`app-get-home`, `app-get-landing`, `app-get-help`, `download: true`, `target: null`).
  - `FM-003`: Verified `Ctrl+L` in normal browser does not open desktop-only `open-link-dialog` (`0`), and all 4 dead/malformed links (`/b/nonexistent123#badtoken`, `/b/nonexistent123`, `/s/nonexistent123#badtoken`, `/s/nonexistent123`) render clean `"Invalid link"` with `"New board"` recovery and zero console/network errors.
  - `FM-005`: Promoted landing board to 2-game Session `0BpdJF7GvsJKORNqwigtJg` via `+ Add game → New board`, renamed Session inline (`"QA Pass 006 Session"`), returned to `/` via wordmark, and verified `"Your boards"` lists `"QA Pass 006 Session · 2 games"`.
  - `FM-038`: Verified `window.getSelection().toString() === ""` across map drag-pan, freehand stroke draw (`E`), hero token drag (`Q`), and double-click on map (`dblclick --force`).
  - `FM-041`: Verified portrait `focus-hero` click flashes `.focus-ring` on target hero token (`Amber-0` and `Sapphire-0`) while zoomed in.
  - `FM-050`: Click-toggled all 5 objective types (`guardian:amber:lane1:1`, `walker:amber:lane1:1`, `base_guardian:amber:lane1`, `shrine:amber:lane1:1`, `patron:amber:lane3:1` → `Stage2`) using v1.5 `click --force`, verified live real-time sync to isolated `coachB`, `2× Ctrl+Z` undo (`Patron` & `Shrine` → `Active` on both tabs), and `Ctrl+Shift+Z` redo (`Shrine` → `Destroyed` on both tabs).
  - `FM-053`: Verified `.pl-trooper` wave dots advance smoothly from `2:00` (`8` dots) → `2:02` (`11` dots at `1×`) → `2:10` (`22` dots at `4×`) and toggle cleanly `0 ↔ 22` via `Map layers → Lane troopers`.
  - `FM-064`: Played across `17:58` (`1077s → 1079s`) and verified `3` live `[data-testid="event-ping"]` (`.pl-ping amber/sapphire`) rings rendered and faded cleanly to `0`, and toggling `Map layers → Event pings` OFF suppressed all pings (`0`) across the same interval.
  - `FM-073`: Cloned Board `ghtdpgoI5AuvdHjlSqoncw` via `More → Clone` → `qsxAggqCk2e5wWj78U_ZFg`; verified clone carried over `Full replay` + all `6` scenes (`Scene 1` + 5 R3 scenes), and adding new scenes (`T`) on the clone (`6 → 7`) left the original board untouched (`6`).
  - `FM-094`: Opened two floating `[data-testid=hero-card]` panels (`z: 8` and `z: 9`), verified click-to-front z-order swap (`z: 9` vs `z: 8`), dragged header far toward `(1420, 880)` verifying stage/viewport clamping (`right: 1104 <= 1440`, `bottom: 685 <= 900`, `hcOverlapsControls: false`), and closed one via `×` (`2 → 1`) and the remaining panel via `Escape` (`1 → 0`).
  - `FM-110`: Verified `JoinCard` refuses empty `Enter` and whitespace `"   "`, accepts `"Coach Alpha"`, persists seat across `location.reload()`, syncs `"2 online"` presence (`avatars: "CC"`) with isolated `coachB` (`"Coach Beta"`), and live-renames via `testid:rename` (`"Prime Coach"`, updating avatars `PC`/`CP` live on both tabs).

---

## Findings

| # | Severity | Feature ID | Summary & Repro | Action Taken / Link |
|---|---|---|---|---|
| 1 | `bug-minor` | `FM-091` | **Raw HTML entity `&amp;` rendered in visible ability upgrade tooltip text on Apollo's `Riposte` Tier 3.** Repro: open `129738985` at `20:00` (pack `6864-upgrades`), open Apollo (`Amber-1`) build panel, hover `Riposte` (2nd ability) → Tier 3 (`5`) displays `"Gain 75% Bullet, Spirit &amp; Melee Lifesteal against the Riposte target for 13s"` with literal `&amp;` in DOM `textContent` (likely unescaped HTML entity in Valve's localization string not decoded during pack extraction or tooltip rendering). | Logged in `docs/backlog.md` & `docs/qa/feature-map.md` |

---

## Automated Test & Backlog Feedback
- **Backlog updated:** Added `## Exploratory QA Pass 006 findings (2026-11-24)` to `docs/backlog.md` recording live-prod verification of `c8d5782` + pack `6864-upgrades` (Phase 5 R3 Group B, `.mapcro` v6 + TD-162 matchless import, Feedback `#62`) and logging Pass 006 Finding #1 (`bug-minor`, `FM-091`: raw `&amp;` HTML entity in Apollo `Riposte` T3 tooltip).
- **Feature map updated:** Updated 19 rows in `docs/qa/feature-map.md` to `Pass 006 (2026-11-24, c8d5782)` and deepened all 14 remaining `smoke` rows → `deep`, reaching **70 `deep` / 0 `smoke` / 2 `auto-only` / 0 `unmapped`** (**100% of web-testable rows**).

---

## Process Meta-Notes (Mandatory — Evaluating `tools/qa-browser/` v1.5)
- **What worked great in v1.5 (`scrub-tick` filtering & `--force` on `click`/`rclick`/`dblclick`):**
  - **`scrub-tick` filtering in `snapshot` was a massive win:** Total visible interactive candidates on a loaded Player screen dropped from **`1254` (v1.3) → `515` (v1.4) → `191` (v1.5)** with **`0` `scrub-tick` entries** — an 85% total noise reduction since v1.3!
  - **`--force` on `click` / `rclick` / `dblclick` worked on the first try everywhere:** Every single SVG map-marker click (`guardian`, `walker`, `base_guardian`, `shrine`, `patron`, downed `camp:neutral:lane1:10`, `rift:neutral:lane6:1`), hero token click (`[data-testid=map] .tok`), floating panel click, and map double-click succeeded immediately with zero `.notes-area` pointer-interception timeouts!
- **Remaining friction noticed in v1.5:**
  1. **`testid:` shorthand does not support comma-separated fallback selectors:** Passing `testid:clone-go, [role=dialog] button:has-text("Clone")` expands into `[data-testid="clone-go, [role=dialog] ..."]` (invalid CSS selector). Using plain CSS `[data-testid=...]` avoids it, and a brief note in `--help` would prevent accidental misuse.
  2. **`resize` syntax mismatch vs `open --viewport`:** `open` uses `--viewport 1440x900` (`WxH`), whereas `resize` requires two separate args `resize <tab> 800 600` (passing `800x600` errors with `resize requires <tab> <width> <height>`). Accepting `WxH` in `resize` (in addition to `W H`) would make the CLI completely consistent.
- **Suggested upgrade for next pass (v1.6):**
  - Accept both `resize <tab> <W> <H>` and `resize <tab> <W>x<H>` (matching `open --viewport`), and optionally add a `scrub <tab> <seconds>` helper (or document the `input[type=range]` setter idiom) since replay passes scrub timestamps dozens of times.
