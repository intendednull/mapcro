# QA Pass 003: World Elements, Match Import/Clone, Phone Player & Resilience (2026-11-21)

- **Explorer:** Gemini 4 Neon (medium)
- **Commit / Build:** `8c6ec5e` (binaries `/tmp/lead-gate/target/debug/mapcro-server` + `/tmp/lead-gate/web/dist`; `qa-pass-003` off `60f26b0` with `tools/qa-browser/` v1.2; asset packs present: yes)
- **Charter:** Close out first-pass interactive coverage across the remaining 24 `auto-only` rows of `docs/qa/feature-map.md` — offline `Open match` / Session `Add game → Load a game` / `.dem` upload / replay clone, Player world elements & hover tooltips (`§4b`), `K` kill/revive guard, Scene builds/focus/states, Viewer write guard in Player, Phone (`390×844 --touch`) Player & Scene editing, and reload/persistence — while evaluating `tools/qa-browser/` v1.2.
- **Feature Map Rows Touched:** `FM-012`, `FM-014`, `FM-015`, `FM-023`, `FM-024`, `FM-031`, `FM-038`, `FM-041`, `FM-042`, `FM-043`, `FM-051`, `FM-052`, `FM-053`, `FM-054`, `FM-055`, `FM-056`, `FM-064`, `FM-065`, `FM-066`, `FM-067`, `FM-070`, `FM-071`, `FM-072`, `FM-073`, `FM-082`, `FM-130`, `FM-131`, `FM-140`, `FM-141` (29 rows touched; 22 advanced out of `auto-only`, 2 desktop/protocol-gated rows documented honestly as remaining `auto-only`).
- **Viewports Tested:** `1440×900` (desktop, 3 isolated contexts: `coachA`, `coachB`, `viewer`), `390×844 --touch` (phone portrait, isolated context `phone`).
- **Console / Network Errors:** 0 console errors, 0 `pageerror`s across all 4 tabs. (Only benign Chromium `Federo-Regular.woff2` preload warnings and aborted duplicate in-flight `/api/boards/.../matches/129738985` requests during immediate board navigation.)

## What Was Explored

1. **Offline Match Import, Session Load, `.dem` Upload & Replay Clone (`FM-070`, `FM-071`, `FM-073`, `FM-014`, `FM-015`, `FM-031`):**
   - On `/` (`coachA`, `1440×900`), entered `129738985` into `[data-testid="open-match-id"]` and clicked `Open match`. Verified offline match metadata seeding (`seededMatch: true`) created the board (`Match 129738985`), loaded the Full replay (`10:00`), and opened the join dialog cleanly.
   - Tested modal focus management & `Escape` (`FM-015`) on `Share` dialog and `More` menu (`⋯`): both focused their first control on open and returned focus cleanly to `[data-testid="share"]` / `[data-testid="more"]` on `Escape`.
   - Verified `Feedback` button (`FM-014`) is intentionally omitted when server GitHub feedback config is absent (§11a), and asset pack (`/packs/...`) heroes, icons, and minimap furniture (`FM-031`) rendered cleanly.
   - Cloned the replay-loaded board via `More → Clone` (`FM-073`): new board (`Match 129738985 (copy)`) opened with `Full replay`, `10:00`, and `▶ Replay Match 129738985` intact.
   - Promoted to a Session via `+ Add game → Load a game` (`129738985`): promoted cleanly to `/s/<id>` with both game tabs showing `Amber · 44:00` and `Full replay`.
   - Tested `.dem` upload UX (`FM-071`) on a fresh board (`coachB`) and on Landing `/`:
     - Invalid file (`bad.dem`) on Player `[data-testid="match-file"]` showed `"Not a replay. Pick the match's .dem file."`.
     - Valid-header `129738985.dem` (`PBDEMS2\0` + 64 KiB) on Landing `[data-testid="open-match-file"]` + `Open match` created the board and opened `Full replay` cleanly.
     - Discovered two upload edge cases: Landing `bad.dem` + `Open match` reports `"Invalid id"` instead of `"Not a replay"` (#2), and Player `host.ts` `take()` silently returns on `!matchId()` without clearing stale error state (#4).

2. **Player World Elements, Hover Tooltips, `K` Guard, Scene Builds & Viewer Write Guard (`FM-012`, `FM-023`, `FM-024`, `FM-038`, `FM-041`, `FM-042`, `FM-043`, `FM-051`–`FM-056`, `FM-064`, `FM-066`, `FM-067`, `FM-082`):**
   - Enabled `Elevation & ziplines`, `Healing pickups`, and `Heavy boxes` in `Map layers ▾` and visually verified all world layers (`10:00`).
   - Audited SVG `<g data-testid="hover-label">` tooltips and `aria-label` / `title` attributes across Guardians, Walkers, Mid-Boss, Sinner's Sacrifice, Powerups, Healing pickups, Heavy boxes, Shops, and Soul Urn: all concise, game-terminology tags (`Walker 100%`, `Mid-Boss 100%`, `Respawns in 3:13`, `Casting buff`, `Urn`), compliant with spec §4b.
   - Scrubbed to `2:00`, pressed Play for 2 s, and confirmed troopers move smoothly (`FM-053`); compared `2:00` vs `12:00` lane shops (`FM-054`) and verified Archmother's 3 lane shops disappear once her 3 Guardians fall; confirmed minimap pings render at `12:00` (`FM-064`).
   - Scrubbed to `10:30` (active Soul Urn carried on west + glowing drop-off altar on east, `FM-055`), `12:10` (active west Unstable Rift capture ring + death countdown timers on TopBar, `FM-056`, `FM-066`), and `31:20` (active Archmother Rejuvenator with 3 revive icons on TopBar + Mid-Boss pit respawn ring, `FM-056`).
   - Tested `K` kill/revive guard (`FM-082`): pressing `K` over a hero token in Player mode (match preview) was a clean no-op (`deadBefore=0, deadAfter=0`), while pressing `K` over an alive hero token in Scene mode killed it (`deadBefore=3, deadAfter=4`).
   - Saved a scene at `31:20` (`Match moment`) and verified Scene builds (`FM-024`: clicking portrait opens saved K/D/A, calculated stats, abilities, 12 items, `Build order · 18`), Hero focus dimming (`FM-041`), Portrait right-click menu (`FM-012`: `Kill`, `Mark not seen`, `Rename…`, `Change hero…`), Alive/Dead + Out-of-Sight icon (`FM-043`), `Player names` toggle (`FM-023`), and No-Select on map drag (`FM-038`: `window.getSelection().toString() === ""`).
   - Minted a View-only link on a replay-loaded board and opened `viewer` (`1440×900`, `FM-067`): confirmed `Save scene` is absent, toolbar is restricted to `Look [Q]`, `Laser [W]`, palette, and comments toggle, header main action is `Clone`, and viewer can still step/play (`10:00` → `10:10`), change Vision/Map layers, and open hero builds.

3. **Phone Portrait (`390×844 --touch`) Player & Scene Editing (`FM-131`, `FM-130`, `FM-065`):**
   - Opened replay-loaded board in isolated touch context `phone` (`390×844 --touch`).
   - Verified Phone Player layout (`FM-131`): zero horizontal overflow (`scrollWidth === 390`), `1x` speed list dropdown (`<=480px`), centered 48×48 Play button (`x=171..219`), 306 px scrubber, and visually inspected `Events`, `Map layers`, `Hero build` (portrait tap), `More`, and `Match` sheets.
   - Switched via `More → Scenes → Scene 1` to Phone Scene mode (`FM-130`), tapped `Edit → Draw`, drew a stroke across the map cleanly, and switched back to `Look`.
   - Caught two issues visually: the handoff bar at the bottom reads `Scene “”` (empty quotes) on unnamed `Scene 1` on both phone and desktop (#1), and the `Vision: All [3]` `<select>` displays desktop `[3]` shortcut brackets on touch phones (#3).

4. **Reload & Persistence / Desktop-Only Rows (`FM-140`, `FM-141`, `FM-072`):**
   - Drew a stroke and wrote `"Reload persistence test"` in Scene note on `coachA`, waited for `Saved`, reloaded the exact session URL, switched back to `Match moment`, and confirmed stroke count (`18`), scene note text, and dead/unseen hero states restored identically (`FM-140`).
   - Verified `FM-072` (`Link replays folder` visible in `Match source` on web; full replay picker & local folder parsing is desktop-app-only) and `FM-141` (`UpdateBanner` silent on matching web build; triggered by protocol `BUILD_ID` mismatch / desktop release feed).

## Findings

| # | Severity | Feature ID | Summary & Repro | Action Taken / Link |
|---|---|---|---|---|
| 1 | `bug-minor` | `FM-065`, `FM-130` | **Player→Scene handoff bar shows `Scene “”` (empty quotes) on unnamed scenes.** From Player mode on a replay-loaded board (both desktop `1440×900` and phone `390×844`), switch to the default unnamed `Scene 1`. The bottom handoff bar renders `Scene “”` next to `↩ Back to <time>` instead of falling back to `Scene “Scene 1”` (as the stage header and scene tree do). | Logged in `docs/backlog.md` & `feature-map.md` |
| 2 | `bug-minor` | `FM-071` | **Landing `.dem` upload reports `"Invalid id"` instead of `"Not a replay"` for corrupt non-numeric filenames.** On `/`, pick a corrupt `.dem` whose filename has no match ID (e.g. `bad.dem` containing `"not a demo"`) via `[data-testid="open-match-file"]` and click `Open match`. Because `Landing.tsx` validates `idFromName(f.name)` before `looksLikeDemo(f)`, the user sees `"Invalid id"` rather than `"Not a replay. Pick the match's .dem file."`. | Logged in `docs/backlog.md` & `feature-map.md` |
| 3 | `ux-rough` | `FM-131`, `FM-130` | **Phone (`390×844 --touch`) `Vision` `<select>` displays desktop keyboard-shortcut brackets (`Vision: All [3]`).** Visible in both Phone Player's `Map layers` sheet and Phone Scene mode, whereas other touch controls omit keyboard hints. | Logged in `docs/backlog.md` & `feature-map.md` |
| 4 | `bug-minor` | `FM-071` | **Player `host.ts` `take()` silently no-ops when `matchId()` is empty and leaves prior error notice visible.** On a board with no match loaded, `take()` runs `looksLikeDemo(f)` (setting `"Not a replay..."` on invalid input) then calls `upload(f)`, which early-returns on `!matchId()` without clearing `problem` or using `idFromName(f.name)`. | Logged in `docs/backlog.md` & `feature-map.md` |
| 5 | `test-gap` | `FM-065`, `FM-082` | **Automated coverage & map accuracy gaps.** (a) `web/e2e/player-handoff.spec.ts` does not assert non-empty scene label in the handoff bar for an unnamed scene (`#1`). (b) `feature-map.md` `FM-082` description inaccurately described `K` as a layer-preview hold; corrected to "`K` kill/revive guard (works on hovered hero in Scene mode, no-op under match preview)". | Updated `feature-map.md`; logged in `docs/backlog.md` |

## Automated Test & Backlog Feedback

- **Backlog entries added:** Appended `## Exploratory QA Pass 003 findings (2026-11-21)` to `docs/backlog.md` covering `#1`–`#5` (no duplicates of Pass 001/002 or `#62`).
- **Feature Map updated:** Updated 29 rows in `docs/qa/feature-map.md` — advancing 22 of the 24 remaining `auto-only` rows to `smoke`/`deep` (**70/72 rows interactively verified**: `34 deep`, `36 smoke`; only desktop-app/protocol-gated `FM-072` and `FM-141` remain `auto-only`, `0 unmapped`).

## Process Meta-Notes (Mandatory)

- **Evaluation of `tools/qa-browser/` v1.2 upgrades:**
  - **Offline match metadata seeding (`seededMatch: true`) — huge win:** Worked on the very first try for Landing `Open match`, Session `Add game → Load a game`, and Landing `.dem` upload with zero `502 Bad Gateway` errors. Completely unblocked offline match-import QA.
  - **Tighter `snapshot` visibility (`vis()`) — works as designed:** Closed `<details>` (like `Where's my replay?` on Landing) no longer leak hidden descendants into `snapshot`. However, on a dense Player screen (`1263`–`1484` DOM nodes with `[data-testid]` including hundreds of SVG `trooper` and `tok-health` elements), the default `--max 120` cap truncates UI controls further down the DOM (e.g. `map-layers` buttons), requiring `eval` or `--max` bumps.
- **Friction in `tools/qa-browser/`:**
  1. **`hover` fails on HTML map markers under `<svg class="mm-overlay map">`:** Playwright's `locator.hover()` times out (`<rect class="notes-area"> intercepts pointer events`) on `.mk` markers because the SVG overlay sits above them and hit-tests coordinates. Workaround was `wheel <tab> 0 0 --at x,y` to move the pointer without clicking.
  2. **Per-command `nix develop -c` startup overhead:** Running `nix develop -c tools/qa-browser/qa-browser.mjs` per step adds ~2–3 s per invocation; wrapping multi-step batches inside a single `nix develop -c bash -c '...'` cut step latency by ~5×.
  3. **SVG `HoverLabel` text vs `innerText`:** `[data-testid="hover-label"]` is an SVG `<g>`, so inspecting it requires `textContent` rather than `innerText`.
- **Blind spots / coverage gaps noticed:**
  - Desktop-app-only flows (`FM-072` local replays folder picker/reparse) and protocol-mismatch / release-feed updates (`FM-141` `UpdateBanner`), plus GitHub-configured `Feedback` submission (`FM-014`), cannot be driven end-to-end against an unconfigured headless web server without dedicated flags or desktop harness.
- **Suggested upgrade for next pass (v1.3):**
  1. Add `move <tab> <x> <y>` (or `--force` on `hover`) to `tools/qa-browser/` so hovering map markers under `<svg class="mm-overlay">` works directly without `wheel 0 0 --at`.
  2. Exclude non-interactive SVG visualization nodes (`[data-testid="trooper"]`, `[data-testid="tok-health"]`, `[data-testid="scrub-tick"]`) from `snapshot`'s interactive list so the default 120-item cap doesn't hide actual buttons and popovers in Player mode.
