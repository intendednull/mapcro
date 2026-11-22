# Exploratory QA Process Log

An append-only record of how mapcro's Exploratory QA Loop and `tools/qa-browser/` evolve over time.
After each pass (or batch of passes), review the explorer's Process Meta-Notes, record what held
or broke against our predictions, and log concrete upgrades here.

---

## 2026-11-21 — v1: Initial Launch

### What we built
- **Driver (`tools/qa-browser/`):** Zero-new-dependency Node.js CLI (`qa-browser.mjs`) + Unix-socket
  daemon (`daemon.mjs`) reusing Playwright from `web/node_modules` inside `nix develop`.
  - One isolated Playwright `BrowserContext` per named tab (`coachA`, `coachB`), so multi-user
    testing has separate `localStorage` and `IndexedDB`.
  - Auto-starts a throwaway local `mapcro-server` (reusing `target/debug/mapcro-server` or
    `/tmp/lead-gate/target/debug/mapcro-server`, local packs if present, temp `DATA_DIR` and
    `REPLAY_DIR`) with `--mock-replay-129738985` + `feed-replay` so real 6v6 replay `129738985`
    loads in <2s without burning 15s of CPU parsing every pass.
  - Compact `snapshot` command (URL, viewport, headings, overlays, interactive elements with
    `data-testid`, state flags, and bounding boxes, plus console/network error counts) to keep
    agent context lean.
  - Hard screenshot path guardrail: `shot` resolves symlinks and refuses any path inside the repo,
    worktrees, or any git directory (only `/tmp/` and `/home/intendednull/concierge/artifacts/`).
- **Playbook & Living Map (`docs/qa/`):**
  - `README.md`: 5-step loop, viewport matrix (`1440x900`, `1024x600`, `800x600`, `1024x768` touch,
    `390x844` touch), severity taxonomy, guardrails, and pass report template with mandatory
    Process Meta-Notes.
  - `feature-map.md`: Seeded with 72 rows across 15 user-facing domains grounded in `web/src/`,
    `web/e2e/`, and `web/test/` (71 `auto-only`, 1 `unmapped`).

### Design choices
- **Unix socket daemon over per-command browser launch:** Exploratory QA needs fast, stateful
  back-and-forth (click → snapshot → hover → screenshot → check logs). Cold-launching Chromium per
  command would burn ~2s per step and lose page state.
- **Reuse `web/node_modules` Playwright across worktrees:** Worktrees often don't run `npm ci`, so
  the daemon falls back to `<git-common-dir>/../web/node_modules/playwright` and
  `/tmp/lead-gate/web/node_modules/playwright`.
- **Both cache-seed and inbox-watch for `129738985`:** Seeding `DATA_DIR/replays/129738985-cdn.json`
  makes "enter match ID 129738985" instant, while watching `REPLAY_DIR/inbox/` makes `.dem` upload
  flows instant too.

### Predictions / hypotheses to evaluate after Passes 1–3
1. **Narrow desktop & visual overlap bugs:** Automated e2e mostly runs at `1440x900` and phone
   `390x844`. We predict Passes 1–3 will find real layout/overlap/clipping issues at `1024x600`,
   `800x600`, and `1024x768` (touch) that existing e2e never saw.
2. **State-transition & cross-feature interaction bugs:** Automated specs test one feature per file.
   We predict interactive exploration (e.g. Player → open builds → switch viewport → follow another
   peer → switch session tab) will uncover stale overlays, z-index clashes, or focus traps.
3. **Driver ergonomics:** We expect explorers to ask for at least one of:
   - a `touch-tap` / `long-press` command (for `touch-menu` / phone exploration),
   - a `upload` command (to set files on `<input type="file">` for `.dem` and `.mapcro` testing),
   - or a `network` / `ws` inspection helper for offline/reconnect exploration.
   We intentionally kept v1 small and will add these only when Pass Meta-Notes confirm the need.

---

## 2026-11-21 — v1.1: Pass 001 Retro & Driver Upgrades

### Pass 001 evaluation against v1 predictions
Pass 001 (`passes/2026-11-21-pass-001-player-narrow-tablet.md`, Neon medium on `8c6ec5e`) moved 21 rows (`0 unmapped`, `10 deep`, `11 smoke`) and surfaced **10 findings** (`5 bug-minor`, `1 label-violation`, `3 ux-rough`, `1 test-gap`) with zero console/page errors:
1. **Prediction #1 (narrow desktop & tablet visual overlaps) — strongly confirmed:** 4 visual/overflow bugs missed by ~570 automated e2e tests (`800×600` header pushing `More` off-screen, `1024×768 --touch` `.p-top` 138 px overflow clipping `Follow`, `1024×600` `Map layers` popover clipping and rendering behind TopBar portraits, `1024×600`/`800×600` `All builds` column collision).
2. **Prediction #2 (cross-feature state transitions) — confirmed + bonus data bug:** Stale skull recap across large scrubs/Scene flips, stale `Back to replay` toast inside Replay, plus a high-visibility desktop Player data bug in Events `Ults` (raw internal ability slugs + non-ult abilities listed as ults) and a §4b label violation (`title="Parsed from the replay file"`).
3. **Visual screenshot inspection (`read_file` on `/tmp/qa-pass-001/*.png`)** proved essential — DOM metrics alone would have missed `Map layers` z-index occlusion behind TopBar portraits, `All builds` text collisions, and the tablet `Scenes` drawer overlap.

### Driver upgrades applied (`tools/qa-browser/` v1.1, from Pass 001 Meta-Notes)
1. **Visible-first locators:** `click`, `rclick`, `dblclick`, `hover`, and `fill` now default to `locator(sel).filter({ visible: true }).first()` (opt-out with `--any`), eliminating repeated 10 s timeouts on hidden desktop/phone duplicate elements.
2. **Accurate `snapshot` visibility + `<summary>`:** `vis()` now walks ancestors so elements inside closed popovers (`opacity: 0` / `visibility: hidden` on a parent) are no longer falsely listed as visible, and `<summary>` elements (e.g. `Match source ▲`) are included in the interactive list.
3. **`upload <tab> <selector> <file>` command:** Added ahead of Pass 002 to drive `<input type="file">` for `.mapcro` board file import and `.dem` upload flows without requiring visible inputs.

### Feedback loop triggered
- Spawned `qa-p1-fixes` (Neon medium) to fix the 5 non-design bugs (`.p-top` tablet overflow, `Map layers` z-index/max-height, `800×600` header overflow, Events `Ults` localization + non-ult filtering, `match-tier` §4b title, stale `Back to replay` toast) with automated e2e/unit regression tests proven to fail before each fix.
- Routed narrow-desktop sidebar auto-collapse and `All builds` narrow-width redesign (`#4`, `#6`) to approved design models per `ui-design-model.md`.
- Next: Pass 002 on Sessions, Multi-Tab Follow, Sharing/Roles, Board Files (`.mapcro` export/import), and Multi-User Undo/Redo using v1.1.

---

## 2026-11-21 — v1.2: Pass 002 Retro, Offline Match Metadata & Tighter Snapshot

### Pass 002 evaluation
Pass 002 (`passes/2026-11-21-pass-002-sessions-sharing-editing.md`, Neon medium on `8c6ec5e`) ran on v1.1, explored 32 rows (advancing 27 out of `auto-only` → **48/72 rows interactively verified**: `25 deep`, `23 smoke`, `24 auto-only`, `0 unmapped`), and surfaced **6 findings** (`2 bug-minor`, `1 label-violation`, `2 ux-rough`, `1 test-gap`) with zero console/page errors:
- **v1.1 upgrades validated:** Visible-first locators eliminated Pass 001's hidden-duplicate timeouts, and `upload` worked on the first try for `.mapcro` round-trip import (`testid:import-board-file`).
- **Notable catches:** Landing `known-rename` navigating into `/b/` on `Enter` (`FM-002`), `HeroPicker` disabled-tile §4b violation (`FM-025`), live-revoked viewer overlay displaying `"Invalid link"` while leaving the full board DOM behind the scrim (`FM-121`), active `Copy` button on revoked rows (`FM-120`; verified no Revoke UI button is intentional per spec §11), and phone Scene shell layout roughness (`FM-130`).

### Driver upgrades applied (`tools/qa-browser/` v1.2, from Pass 002 Meta-Notes)
1. **Offline match metadata seeding:** `registerReplayFeed` (`--mock-replay-129738985` / `feed-replay`) now also seeds `DATA_DIR/matches/<id>.json` and `<id>.preview.json` from `~/.local/share/mapcro/data/matches/` when present, so Landing `Open match` and Session `Add game → Load a game` work offline without `502 Bad Gateway`.
2. **Tighter `snapshot` visibility (`vis()`):** Skips non-`<summary>` descendants of closed `<details:not([open])>` and elements clipped inside zero-width/zero-height `overflow: hidden|clip` ancestors (such as collapsed pickup sub-toggles).

### Feedback loop triggered
- Spawned `qa-p2-fixes` (Neon medium) for the 4 non-design Pass 002 bugs (`known-rename` Enter, `HeroPicker` §4b title, hide `Copy` on revoked `ShareDialog` rows, live-revoked viewer `"Link revoked"` + clear board DOM behind scrim) with regression tests proven to fail before each fix.
- Spawned an approved design model (**Gemini 4 Argon high**, `qa-responsive-design`) for Pass 001 Findings #4/#6 (narrow desktop `1024×600`/`800×600` Player/All builds layout) and Pass 002 Finding #5 (phone `390×844` Scene shell `"Scene 1"` overlap & bottom toolbar alignment).
- Launched Pass 003 on the remaining 24 `auto-only` rows (Phone Player & touch gestures, Objectives/Camps/Lanes/Urn/Rift/Shops/Pings/Troopers, K-preview, `.dem` upload & `Open match` offline flow, Board clone carrying replay, Offline/Reconnect).

---

## 2026-11-21 — v1.3: Pass 003 Retro (70/72 Coverage), Pointer Hover & Snapshot Signal

### Pass 003 evaluation (end of Cycle 1 full-app sweep)
Pass 003 (`passes/2026-11-21-pass-003-world-import-phone-player.md`, Neon medium on `8c6ec5e`) ran on v1.2, explored 29 rows (advancing 22 of 24 remaining `auto-only` rows), bringing the Living Feature Map to **70/72 rows interactively verified** (`34 deep`, `36 smoke`, `2 auto-only` [`FM-072` desktop-app-only, `FM-141` release-feed gated], `0 unmapped`), with zero console/page errors and **5 new findings** (`3 bug-minor`, `1 ux-rough`, `1 test-gap`):
- **v1.2 upgrades validated:** Offline match metadata seeding (`seededMatch: true`) worked on the first try across Landing `Open match`, Session `Load a game`, and Landing `.dem` upload (zero `502`s). Tighter `snapshot` `vis()` cleanly skipped closed `<details>` children.
- **Pass 002 false-positive lesson applied:** During fix triage, `FM-002` (`known-rename` navigating to `/b/` on click) and `FM-120` (`ShareDialog` having no Revoke button) turned out to be intentional per `boards-list.spec.ts:130` and spec §11. Updated `docs/qa/README.md` so explorers verify URLs right after clicks and cross-check specs before filing missing controls.
- **Cycle 1 (Passes 001–003) totals against v1 predictions:**
  - **21 raw findings → 19 confirmed** (`10 bug-minor`, `2 label-violation`, `5 ux-rough`, `2 test-gap`), zero regressions missed, zero game art or player names ever committed.
  - All 3 v1 predictions held strongly: narrow/tablet/phone visual overlaps, cross-feature state bugs (`Scene ""` handoff, stale toasts, live-revoked viewer DOM leak, Events `Ults` slugs/misclassification, `.dem` upload validation order), and iterative driver upgrades (`v1.0 → v1.1 → v1.2 → v1.3`) driven directly by Pass Meta-Notes.

### Driver upgrades applied (`tools/qa-browser/` v1.3, from Pass 003 Meta-Notes)
1. **`move <tab> <x> <y>` and `hover --force`:** Map `.mk` markers sit under `<svg class="mm-overlay map">` (`.notes-area` intercepts pointer hit-testing), causing standard `locator.hover()` actionability checks to time out. Added `move` (direct `page.mouse.move(x, y)`) and `--force` on `hover`.
2. **Exclude dense non-interactive SVG visualization `data-testid`s in `snapshot`:** Filtered `trooper`, `tok-health`, `scrub-tick`, `lane-edge`, and `lane-path` out of `snapshot`'s interactive list so the 120-item default cap never truncates real controls on dense Player screens.

### Feedback loop triggered
- Spawned `qa-p3-fixes` (Neon medium) for Pass 003's 3 confirmed bugs (`Scene ""` handoff label on unnamed scenes, Landing `.dem` `looksLikeDemo` before `idFromName`, Player `host.ts` `take()` empty-`matchId` handling + stale error clear, and omitting `[1]`/`[2]`/`[3]` shortcut brackets on touch Vision `<select>`) with regression tests proven to fail before each fix.
- **Cycle 1 fixes shipped (2026-11-21):** Merged all 4 fix/polish branches (`qa-p1-fixes`, `qa-p2-fixes`, `qa-p3-fixes`, and Argon `qa-responsive-design` — 16 confirmed findings closed with fail-before-fix regression tests, zero conflicts), gated across `just web-test` (85 suites), full Chromium Playwright (`578 passed, 16 skipped`), and Firefox Android phone/tablet Playwright (`52 passed, 22 skipped`).
- Next QA cycle (Cycle 2, Pass 004+): run after Phase 5 R1 + Cycle 1 fixes land on prod, targeting live regression verification of all 16 fixes + deepening remaining `smoke` rows to `deep`.

---

## 2026-11-22 — v1.4: Pass 004 Retro (Live Prod Cycle 2, 15/16 Verified + Prod-Only Catch)

### Pass 004 evaluation
Pass 004 (`passes/2026-11-22-pass-004-prod-cycle2-verify.md`, Neon medium against live prod `e2438b4` with cached reference replay `129738985` — zero local stack/build!) verified **15/16 Cycle 1 fixes**, **all Phase 5 R1 zero-regression invariants** (`.mapcro` export `version: 4`, `rows: 16`, scene hero health arcs OFF, Urn/Rift/Rejuv/Mid-Boss), deepened **9 more `smoke` rows → `deep`** (**43 `deep` / 27 `smoke` / 2 `auto-only` / 0 `unmapped`**), and uncovered **1 genuine prod-only bug + 1 CI test gap**:
- **Prod-only layout bug (`FM-130`, `FM-014`):** On live prod (where GitHub `Feedback` is configured), Phone `390×844 --touch` Session Scene `.p-top` overflows by `+78 px` (`468 / 390`) because `[data-testid="feedback-open"]` (`109 px`, `flex: none`) + `wordmark` (`87 px`, hidden only at `<= 360px`) + `games-open` (`145 px`) + `save-status` (`73 px`) crush `role-chip` to `16 px` (`"C"`) and clip `Feedback` off-screen. Local/CI e2e missed it because local servers omit GitHub feedback config.
- **v1.3 upgrades validated:** `hover --force` and `move` worked on the first try for map markers under `<svg class="mm-overlay">` (`"Urn delivery point"`, `"Respawns in 6:45"`).

### Driver upgrades applied (`tools/qa-browser/` v1.4, from Pass 004 Meta-Notes)
1. **Viewport & scrollable-ancestor clipping in `snapshot` (`vis()`):** Skips elements scrolled outside the viewport or outside any scrollable/clipped ancestor (`overflow: auto|scroll|hidden|clip`), and excludes `recap-hit`/`recap-icon`/`death-recap` from `IGNORE_TESTIDS` so loaded Player `snapshot`s stay well under the 120-item cap without off-scroll Events DOM noise.
2. **`download <tab> <selector> <out-file>`:** Added Playwright `waitForEvent("download")` command gated by the same outside-repo path guardrail (`validateShotPath`) so `.mapcro` export tests need no `URL.createObjectURL` hooking.

### Feedback loop triggered
- Spawned an approved design model (**Gemini 4 Argon medium**, `qa-p4-phone-feedback`) to fix the Phone `390×844` Session Scene `.p-top` + `Feedback` header overflow and add Playwright e2e coverage with GitHub feedback configured so prod-only chrome is tested in CI.
- Next QA pass (Pass 005): run after Phase 5 R2 (Writer A + scene hero health arcs + TD-162) + `TD-117` + `qa-p4-phone-feedback` ship to prod, verifying live Group A features + remaining `smoke` rows.
