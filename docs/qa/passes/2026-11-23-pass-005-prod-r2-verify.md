# QA Pass 005: Cycle 2 Live Prod Verification of Phase 5 R2, TD-117 & Phone Feedback Fix (2026-11-23)

- **Explorer:** Gemini 4 Neon (Medium)
- **Commit / Build:** Live production `https://mapcro.dmgdeadlock.com` running `01e29a8` (Phase 5 R2 + TD-117 + Argon Phone Header Feedback Fix + Stage A `e5a5cff`; full asset packs present; GitHub Feedback enabled)
- **Charter:** Verify live on production against cached reference replay `129738985` using `tools/qa-browser/` v1.4: (1) Pass 004 Finding #1 phone header fix at `390×844 --touch` & `360×800 --touch` with live `Feedback` enabled, (2) TD-117 Session `Open in app` deep-link hrefs for owner vs guest, (3) Phase 5 R2 saved-scene invariants (`12:10` & `31:20`), `.mapcro` v5 export (`download`), and TD-162 matchless import, while deepening 8–10+ remaining `smoke` rows in `docs/qa/feature-map.md` to `deep`.
- **Feature Map Rows Touched:** `FM-013`, `FM-014`, `FM-015`, `FM-023`, `FM-024`, `FM-033`, `FM-035`, `FM-040`, `FM-042`, `FM-043`, `FM-054`, `FM-056`, `FM-062`, `FM-065`, `FM-080`, `FM-081`, `FM-082`, `FM-093`, `FM-101`, `FM-122`, `FM-130`, `FM-131` (22 rows touched; 13 deepened `smoke` → `deep`)
- **Viewports Tested:** `1440×900` desktop (owner + isolated guest), `390×844 --touch` phone, `360×800 --touch` phone
- **Console / Network Errors:** `0` console errors; `0` page errors; `0` unexpected network errors (only expected `net::ERR_ABORTED` on superseded/tab-switched summary fetches and benign font preload warnings)
- **Disposable Prod Boards Used:** 3 (`X6lho4hSGdWevqXK-r6MWQ` replay/Game 1 in Session `cX-ICkqu9h-UsPq4qy5IhA`, blank Game 2 tab in Session, and `_QGxTkEgp4Wy2Qtra704rA` matchless `.mapcro` v5 import)

---

## Verification Table: Goal 1 Live on Prod (`01e29a8`)

| # | Area / Fix | Feature ID | Live Prod Result | Evidence / Measurements |
|---|---|---|---|---|
| 1 | Phone `390×844 --touch` Session Scene WITH match loaded & live `Feedback` enabled | `FM-130`, `FM-014` | **PASS** | `.p-top` `scrollW: 390 === clientW: 390`; `games-open` `133×44` (`>= 44×44`); `role-chip` `60×25` unclipped (`"Can edit"`, `scrollW === clientW === 58`); `feedback-open` icon-only `44×44` (`right: 382 <= 390`); tapping opens `feedback-dialog` cleanly (cancelled, never submitted) |
| 2 | Phone `360×800 --touch` Session Scene WITH match loaded & live `Feedback` enabled | `FM-130`, `FM-014` | **PASS** | `.p-top` `scrollW: 360 === clientW: 360`; `games-open` `122×44`; `role-chip` `60×25` unclipped (`"Can edit"`); `feedback-open` icon-only `44×44` (`right: 352 <= 360`) |
| 3 | Phone `390×844 --touch` Session Player ↔ Scene switching + `More → Feedback` in Player | `FM-130`, `FM-131`, `FM-014` | **PASS** | `.p-top` stays `390/390` across Player ↔ Scene switches; `phone-more` (`⋯`) in Player exposes `Match`, `Scenes`, `Laser`, `Edit`, and `Feedback` cleanly |
| 4 | TD-117 Session `More → Open in app` (Owner vs Guest token isolation) | `FM-013`, `FM-100` | **PASS** | Owner: `mapcro://s/cX-ICkqu9h-UsPq4qy5IhA?tab=<tab>#<owner-tok>` (NOT `mapcro://b/`); Guest edit-link context: `mapcro://s/cX-ICkqu9h-UsPq4qy5IhA?tab=<tab>#<guest-tok>` (`hasOwnerToken: false, hasGuestToken: true`) |
| 5 | Phase 5 R2 Q3 hero health arcs on saved scenes (`12:10` & `31:20`) | `FM-043`, `FM-065`, `FM-081` | **PASS** | `[data-testid=tok-health]` renders on all 10 living heroes in both `12:10` and `31:20` saved scenes; `Map layers → Health bars & arcs` toggles `10 → 0 → 10` |
| 6 | Phase 5 R2 Q7 two-edge lane splits & drag preserving gap width | `FM-065` | **PASS** | All 3 lanes carry `data-amber` + `data-sapphire` (`531/554` gap `23`, `574/663` gap `89`, `468/588` gap `120`); dragging `wave-gap-lane4` shifted lane 4 to `764/853` — both colours followed, preserving exact `89` gap |
| 7 | Phase 5 R2 Q5 static death skull (`12:10` saved scene) | `FM-093`, `FM-065` | **PASS** | Static `.pl-skull.sapphire` renders at `12:10` with `role: null`, `data-recap: null`; clicking opens `0` death/skull recaps |
| 8 | Phase 5 R2 Q2 sight & Vision (`1`/`2`/`3`) × `Last seen` + `Mark not seen` / `Mark in vision` | `FM-080`, `FM-043` | **PASS** | Keys `1`/`2`/`3` switch Vision cleanly; unseen enemies fade (`opacity: 0.42`, never separate ghost) with `Last seen` ON or OFF; `Mark not seen` under All Vision (`3`) updates enemy sight without fading (`ghostsUnderAllAfterMark: 0`), fades under enemy Vision (`2`, `ghosts: 3`), and `Mark in vision` restores full opacity (`ghosts: 2`) |
| 9 | TD-161 no-op `Retake` absent on freshly saved R2 scenes | `FM-065` | **PASS** | `retakeBtns: []` on both `12:10` and `31:20` freshly saved R2 scenes |
| 10 | `.mapcro` v5 export via `qa-browser.mjs download` + TD-162 matchless import | `FM-122`, `FM-081`, `FM-080` | **PASS** | `download testid:download` exported `{ format: "mapcro-board", version: 5, rows: 27, matches: 1 }`; after `jq '.matches = []'` + `POST /api/boards/import`, blank `Scene 1` hides `Health`/`CC`/`Movement`/`Vision` (`matchTier: false`), while imported R2 `Scene 2` shows & runs all of them (`10 → 0 → 10` Health toggle, `1`/`2`/`3` Vision, `Mark not seen`) with **zero match open** |

---

## What Was Explored
- **Phase 5 R2 & Matchless Import (`FM-043`, `FM-056`, `FM-065`, `FM-080`, `FM-081`, `FM-093`, `FM-122`):** Opened cached `129738985` from `/` (`Full replay`), saved R2 scenes at `12:10` (active Rift, static death skull, low health arcs, two-edge lane splits) and `31:20` (mid-fight low health arcs, CC/elevation layers toggled ON, downed Mid-Boss). Verified Q3 health arcs toggle, Q7 lane split drag preserving exact gap, Q5 static death skull non-interactivity, Q2 Vision `1`/`2`/`3` + `Last seen` + `Mark not seen`/`Mark in vision`, and TD-161 (`0` Retake buttons). Exported `.mapcro` v5 (`rows: 27`) via v1.4 `download`, stripped `matches`, imported via `POST /api/boards/import`, and verified TD-162 on blank `Scene 1` vs imported R2 `Scene 2` with zero match open.
- **Sessions, TD-117 & Phone Header Fix (`FM-013`, `FM-014`, `FM-101`, `FM-130`, `FM-131`):** Promoted Board 1 to a 2-game Session (`+ Add game → New board`), minted a Session edit link in `ShareDialog`, and verified `More → Open in app` on both owner and isolated `guest` desktop contexts (`mapcro://s/...` with strictly each user's own token). Tested Phone `390×844 --touch` and `360×800 --touch` Session Scene WITH match loaded, verifying `.p-top` zero-overflow, `games-open >= 44×44`, unclipped `"Can edit"` `role-chip`, icon-only `44×44` `feedback-open`, `feedback-dialog` open/cancel, and Player ↔ Scene switching + `More → Feedback` in Player. Visually inspecting the Phone `390×844` and `360×800` Session Scene screenshots uncovered Finding #1 (`ux-rough` vertical overflow of the stacked handoff bar + bottom `.p-bar`).
- **Deepening 13 `smoke` Rows → `deep` (`FM-014`, `FM-015`, `FM-023`, `FM-024`, `FM-033`, `FM-035`, `FM-040`, `FM-042`, `FM-043`, `FM-054`, `FM-062`, `FM-082`, `FM-101`):**
  - `FM-014` & `FM-015`: Verified `Feedback` dialog auto-focuses Title, shows match context checkbox (`"Includes: match 129738985 at 10:00 (Full replay)"`), and restores focus to `feedback-open` on `Escape` (never submitted); verified focus-in + `Escape` focus-restore across `Share` (`session-share`), `More → Clone` (`more`), and `HeroPicker` (`Change hero…`).
  - `FM-023` & `FM-024`: Verified Scene `Player names` toggle (`names-toggle`), single-hero saved build panel on `31:20` (K/D/A, calculated stats, ability pips, `▸ Build order · 14`, 11-item grid with tier badges, 32 images), `All builds` (12 columns), and inline `souls-banner` edit.
  - `FM-033`, `FM-035`, `FM-040`, `FM-042`: Verified Palette 7 swatches + Brass stroke draw, live fading laser trail (`W`, `laserPaths: 2`), hero token drag syncing live in real time to isolated `guest` peer (`translate(539.76, 451.08)` → `translate(655.37, 361.10)`), and §4b-clean `HoverLabel`s on tokens and world markers.
  - `FM-054`, `FM-062`, `FM-082`, `FM-101`: Verified lane shops open at `2:00` (`8`) vs closed at `12:10` (`4`); Player keyboard shortcuts (`Space`, `ArrowLeft`/`ArrowRight` ±5s, `Shift+ArrowLeft`/`Shift+ArrowRight` ±30s, `1`/`2`/`3` Vision, `Escape`); `K` kill/revive guard (no-op in Player, toggles dead `2 → 3 → 2` on hovered hero in Scene); and 8 rapid Session tab switches (`Game 1 ↔ Game 2` at 120 ms cadence) with zero console/page errors.

---

## Findings

| # | Severity | Feature ID | Summary & Repro | Action Taken / Link |
|---|---|---|---|---|
| 1 | `ux-rough` | `FM-130` | **Phone (`390×844 --touch` & `360×800 --touch`) Session Scene WITH match loaded overflows vertically by `+112 px` (`docScrollH: 956 / innerH: 844`), pushing the bottom `.p-bar` below the initial fold.** Repro: open a 2-game Session on a match-loaded tab (`129738985`) at `390×844 --touch`, switch Player → `More` → `Scenes` → `Scene 1`. While `.p-top` is completely fixed (`390/390`), stacking `.pl-bar.scene` (`101 px` handoff bar: `Scene “Scene 1” | ↩ Back to 10:00` + `Events | Map layers | ⋯`) above the Scene `.p-bar` pushes `.p-bar` below `844 px` (only its top rounded border peeks at `y=830..844`, and on `360×800` `Events | Map layers | ⋯` sits below `800 px`). Scrollable (`overflow-y: visible`), so non-blocking `ux-rough`. | Logged in `docs/backlog.md` & `docs/qa/feature-map.md`; route to approved design model |

---

## Automated Test & Backlog Feedback
- **Backlog updated:** Added `## Exploratory QA Pass 005 findings (2026-11-23)` to `docs/backlog.md` recording live-prod verification of all `01e29a8` items (Pass 004 Finding #1, TD-117, Phase 5 R2, TD-161, TD-162) and logging Pass 005 Finding #1 (`ux-rough` vertical stack overflow on Phone Scene with match loaded).
- **Feature map updated:** Updated 22 rows in `docs/qa/feature-map.md` to `Pass 005 (2026-11-23, 01e29a8)` and deepened 13 rows from `smoke` → `deep` (`FM-014`, `FM-015`, `FM-023`, `FM-024`, `FM-033`, `FM-035`, `FM-040`, `FM-042`, `FM-043`, `FM-054`, `FM-062`, `FM-082`, `FM-101`), bringing the map to **56 `deep` / 14 `smoke` / 2 `auto-only` / 0 `unmapped`**.

---

## Process Meta-Notes (Mandatory — Evaluating `tools/qa-browser/` v1.4)
- **What worked great in v1.4 (`vis()` scrollable-ancestor clip & `download`):**
  - **`download <tab> <selector> <out-file>` worked on the first try:** `download coachA testid:download /tmp/qa-pass-005/r2-prod.mapcro` cleanly captured `Match 129738985.mapcro.json` (`version: 5, rows: 27`) without any `URL.createObjectURL` hooking!
  - **Scrollable-ancestor `vis()` clipping dramatically improved Player `snapshot` signal:** Total visible candidates on a loaded Player screen dropped from **`1254` (v1.3)** down to **`515` (v1.4)**, and for the first time ALL bottom toolbar (`Select Q`..`Redo`) and Player transport controls (`speed-down`, `match-back`, `match-play`, `match-forward`, `speed-up`) appeared inside the default `--max 120` output!
- **Remaining friction noticed in v1.4:**
  1. **`scrub-tick` buttons still fill the tail of Player `snapshot` (`120/515`):** Because `[data-testid="scrub-tick"]` elements are rendered as `<button>` tags on the timeline scrubber, they still pass `snapshot`'s interactive button selector (~395 ticks on a 44-minute match) even though `IGNORE_TESTIDS` intended to exclude them.
  2. **`click` lacks `--force` for `.mk` map markers under `<svg class="mm-overlay map">`:** v1.3 added `--force` to `hover`, which solved map-marker hovering, but clicking a Scene objective marker (`[data-testid=map] .mk.t1`) hits the exact same `.notes-area` pointer-interception timeout because `click` (unlike `hover`) does not yet accept `--force` (or a coordinate `tap <tab> <x> <y>` command).
- **Suggested upgrades for v1.5:**
  1. Apply `IGNORE_TESTIDS` (including `scrub-tick`) **before** matching tag/role interactive selectors in `daemon.mjs` `snapshot`, bringing loaded Player `snapshot` well under 120 total items (`~110/110` with zero truncation).
  2. Support `--force` on `click` / `rclick` / `dblclick` (matching `hover --force`) or add `tap <tab> <x> <y>` so explorers can click map markers under `<svg class="mm-overlay">` without timing out.
