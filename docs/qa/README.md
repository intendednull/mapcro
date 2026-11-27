# Exploratory QA Loop Playbook

The Exploratory QA Loop is a recurring, agent-driven QA process for mapcro. Instead of only running
canned Playwright assertions, an explorer agent drives the live app interactively in a real browser
via `tools/qa-browser/` — clicking, hovering, dragging, resizing viewports, opening two isolated
users at once, visually inspecting screenshots, and checking console/network logs.

Each pass:
1. Deepens the living feature map ([`feature-map.md`](feature-map.md)).
2. Feeds real bugs and gaps back into automated tests, [`../backlog.md`](../backlog.md), and
   [`../tech-debt.md`](../tech-debt.md).
3. Improves the QA process and driver itself via [`process-log.md`](process-log.md).

---

## The 5-Step Loop

1. **Charter:** Pick a focused, time-boxed charter (1–2 domains or cross-cutting flows from
   [`feature-map.md`](feature-map.md), prioritizing `unmapped` or `auto-only` rows, recent changes,
   or high-risk viewports/multi-user interactions).
2. **Interactive Exploration:** Drive the live app with `tools/qa-browser/qa-browser.mjs` inside
   `nix develop` (wrapping heavy steps in `/storage/projects/mapcro/tools/heavy.sh`). Follow your
   curiosity: try unexpected sequences, edge viewports, rapid clicks, two-user races, keyboard
   shortcuts, undo/redo, and visual inspection of screenshots via `read_file`.
3. **Pass Report + Feature Map Update:** Write a pass report in
   `docs/qa/passes/YYYY-MM-DD-pass-NNN-<slug>.md` (template below), update
   [`feature-map.md`](feature-map.md) (`Interactive Depth`, `Last Pass`, `Issues / Notes`), and
   include mandatory **Process Meta-Notes**.
4. **Automated Test & Backlog Feedback:** Turn findings into action using the triage rules below:
   - Confirmed bugs → fix + regression test **proven to fail before the fix**, linked in the feature
     map.
   - Missing automated coverage (`test-gap`) → add an e2e/unit spec or log a scoped item in
     [`../backlog.md`](../backlog.md) / [`../tech-debt.md`](../tech-debt.md) linked back to the
     feature map row.
   - UI/UX design issues → log and route to an approved design model (see Guardrails).
5. **Process Retro & Tooling Upgrade:** After each pass, review the explorer's Process Meta-Notes,
   append a dated entry to [`process-log.md`](process-log.md), and upgrade `tools/qa-browser/` or
   this playbook when friction recurs.

---

## Driving the App with `tools/qa-browser/`

Always run inside `nix develop` (which provides Node 24 and Nix's Playwright Chromium). Wrap
`start` / builds / test runs in `/storage/projects/mapcro/tools/heavy.sh` when box load matters.

### 1. Start a throwaway session
```bash
# Local throwaway mapcro-server + web/dist + real 6v6 replay 129738985 ready in <2s:
nix develop -c tools/qa-browser/qa-browser.mjs start \
  --id pass1 \
  --mock-replay-129738985
```
Options:
- `--url <http://...>`: attach to an already-running server instead of launching one.
- `--server-bin <path>` / `--web-dir <path>` / `--packs-dir <path>`: override auto-discovery.
- `--mock-replay-129738985`: seeds `DATA_DIR/replays/129738985-cdn.json` from
  `~/.local/share/mapcro/data/replays/129738985-cdn.json` AND watches `REPLAY_DIR/inbox/` to answer
  `129738985-*.dem` uploads without burning CPU parsing.
- `feed-replay <matchId> [--source <path>]`: register another cached timeline mid-session.

### 2. Explore with one or two isolated users
Each `<tab>` gets its own Playwright `BrowserContext` (isolated `localStorage` and `IndexedDB`),
so `coachA` and `coachB` behave as two separate real users:
```bash
QA="nix develop -c tools/qa-browser/qa-browser.mjs --id pass1"

$QA open coachA / --viewport 1440x900
$QA snapshot coachA
$QA shot coachA /tmp/qa-pass1/landing.png   # then inspect with read_file!

# Create a board via UI or convenience API:
$QA new-board "QA Pass 1"
$QA open coachA "<owner-url>" --viewport 1440x900
$QA open coachB "<view-or-owner-url>" --viewport 1440x900

# Interact:
$QA click coachA 'testid:mode-player'        # shorthand for [data-testid="mode-player"]
$QA fill coachA 'testid:match-id' 129738985
$QA click coachA 'testid:match-load'
$QA hover coachA '[data-testid=map] .mk'
$QA drag coachA 400 400 520 460 --steps 12
$QA wheel coachA 0 -240 --at 500,450
$QA press coachA Space
$QA eval coachA 'document.querySelectorAll("[data-testid=hero-build]:not([hidden])").length'

# v1.7 helpers:
$QA click-at coachA 500 450                 # trusted left click at viewport (x, y)
$QA rclick-at coachA 500 450                # trusted right click (map-menu, comments)
$QA dblclick-at coachA 500 450              # trusted double click (tokens)
$QA scrub coachA 15:55                      # or 955 / 955.5; sets match-time
$QA audit-layout coachA                     # overflow + clipped interactive JSON
$QA offline coachA on                       # then exercise the durable edit queue
$QA offline coachA off
```

**v1.7 coordinate, scrub, layout & network helpers (from Pass 007 Meta-Notes):**
- `click-at | rclick-at | dblclick-at <tab> <x> <y>` uses real Playwright
  `page.mouse.click(x, y, { button, clickCount })`, so `svg.setPointerCapture()` works. Use it for
  2-step Doorman doorway placement, empty-map `map-menu`, comment placement, erasing at exact
  points, `#55` objective drag, and `#16` token double-click. Avoid synthetic
  `dispatchEvent(new PointerEvent(...))`.
- `scrub <tab> <seconds|mm:ss>` accepts `955`, `955.5`, or `15:55`, sets
  `[data-testid="match-time"]` through the native `HTMLInputElement` value setter, dispatches
  `input` + `change`, waits a rAF, and returns `{ seconds, clock }` from
  `[data-testid="match-clock"]`.
- `audit-layout <tab>` returns `{ vw, vh, docOverflowX, docOverflowY, containers,
  clippedInteractive }` in one call. It checks `.p-top`, `.pl-bar`, `.p-nav`, `.p-tools`,
  `header.top`, `.p-sheet`, and `.games-sheet`, and reports interactive elements outside
  `[0..vw, 0..vh]` while ignoring `.events-chips` and off-scroll `.p-sheet-body` / `.events-list`
  rows.
- `offline <tab> <on|off>` calls `context.setOffline()` for network-flake / offline durable edit
  queue charters.

**Selector notes:** `testid:` is a convenience shorthand only. Keep it simple — don't combine
`testid:` with comma-separated CSS fallbacks (e.g. `testid:foo, .fallback`); write the explicit
`[data-testid="foo"], .fallback` selector instead so the fallback is unambiguous.

### 3. Viewport & input checklist
Test every chartered flow across relevant viewports:
- **Desktop:** `1440x900`
- **Narrow desktop:** `1024x600` and `800x600` (catches toolbar/transport squeeze and scrubber collapse)
- **Tablet:** `1024x768` (use `--touch` on `open` for coarse-pointer / touch layout)
- **Phone:** `390x844` (use `--touch` on `open`)

### 4. Visual, log, and label checks
- **Screenshots:** Save only under `/tmp/qa-<pass>/...` (or `/home/intendednull/concierge/artifacts/...`)
  and inspect them directly with `read_file`. `shot` refuses any path inside the repo or worktrees.
- **Console & network logs:** Run `$QA logs coachA` (and `coachB`) after every major flow. Zero
  console errors, zero uncaught `pageerror`s, and zero unexpected 4xx/5xx responses is the baseline.
- **Labels & hover text (spec §4b):** Check visible labels, button text, and `title` attributes —
  short, the game's words, no explanatory sentences.
- **Avoid false positives:** Check `snapshot`'s URL immediately after clicks (some controls
  intentionally navigate — e.g. `known-rename` opens `/b/<id>` with the title editor focused), and
  cross-check suspected missing UI controls against specs (`docs/specs/`) before filing as bugs.
- **Scope main-map DOM queries under `[data-testid="map"]`:** Scene rows render `.mm-host.lite`
  hover thumbnails, so a bare `document.querySelector('[data-key=...]')` can match a thumbnail
  before the real `.mm-host.free` map and look like stale marker / sync divergence. Always scope
  main-map queries under the main map container so hover thumbnails never masquerade as markers.

### 5. Clean teardown (mandatory)
```bash
$QA stop
```
Verify no stray `mapcro-server` or Chromium processes remain for your session.

---

## Strict Guardrails

1. **No game art in git — ever.** Screenshots must stay in `/tmp/` (or concierge artifacts). Never
   copy screenshots or extracted art into the repository. `tools/qa-browser` enforces this in code.
2. **Privacy:** Never write account IDs anywhere (docs, reports, logs, commits). Never commit player
   names into `docs/qa/` or anywhere in git.
3. **Standard 6v6 data only:** Use reference replay `129738985` (patch 6839, `game_mode == 1`).
   **Never** use `122134063` (Street Brawl).
4. **UI/UX design changes:** Exploratory QA workers *report* `ux-rough` findings; any visual or
   UX redesign must be routed to approved design models (Argon / Astra / Sol-small / Fable / Opus)
   rather than ad-hoc restyling by a QA worker.
5. **Shared box load:** Wrap heavy jobs (Rust builds, `vite build`, Playwright runs) in
   `/storage/projects/mapcro/tools/heavy.sh <cmd>`.

---

## Severity Taxonomy & Feedback Rules

| Severity | Meaning | Required Feedback Action |
|---|---|---|
| `bug-blocker` | Crash, data loss, broken core flow, sync divergence, console/pageerror breaking interaction, or security/access leak. | File immediately with minimal repro. Must become a code fix + automated regression test **proven to fail before the fix**. |
| `bug-minor` | Incorrect state, clipped/overlapping UI, broken shortcut, non-fatal 4xx/5xx, or wrong hover/state sync that has a workaround. | Fix + regression test if small/scoped, otherwise log in [`../backlog.md`](../backlog.md) and link from `feature-map.md`. |
| `ux-rough` | Confusing flow, awkward layout/spacing, jarring transition, poor discoverability, or narrow-viewport squeeze without broken logic. | Log in pass report + [`../backlog.md`](../backlog.md); route visual/UX design decisions to approved design models. |
| `label-violation` | Copy or `title`/tooltip violates spec §4b (sentence-style explanation, non-game terminology, or verbose prose). | Log with exact selector/text; fix + ensure `web/test/labels.test.ts` catches it (or note TD-23). |
| `test-gap` | Working feature or edge case with no automated test coverage (or flaky/incomplete coverage) discovered during exploration. | Add to `feature-map.md` `Issues / Notes` and either add a targeted e2e/unit spec or log in [`../backlog.md`](../backlog.md) / [`../tech-debt.md`](../tech-debt.md). |

### Interactive Depth Scale (for `feature-map.md`)

- `unmapped`: Not yet explored interactively and no linked automated test.
- `auto-only`: Covered by automated unit/e2e tests, but not yet exercised interactively by an
  exploratory QA pass.
- `smoke`: Interactively opened and happy-path verified in a pass.
- `deep`: Explored across edge cases, error/empty states, keyboard/touch, viewports, and/or
  multi-user collaboration.

---

## Pass 008+ Charter Ideas (from Pass 007 Meta-Notes)

- **Touch dialog focus & `Escape` sweep:** Verify fixes for the Pass 007 touch findings
  (`615x344` Session `.p-top`, `games-sheet` focus/`Escape`/auto-close, `"F..."` tier pill,
  `FM-130` vertical fold) across all touch viewports, and check keyboard `Tab`/`Escape` focus
  management on every mobile sheet (`Games`, `Scenes`, `Map layers`, `Events`, `More`).
- **View-only doorways & session permissions:** Confirm view-only links cannot trigger
  `hero-menu-doorway`, `map-menu`, `door-menu`, drag, or `Erase`/`D` on doorways while still
  seeing live doorway updates, hover pair highlight, and Vision filtering from an editing
  presenter.
- **Offline edit queue + reconnect:** Use `offline <tab> on|off` to edit doorways, strokes, and
  notes offline, reconnect, and verify durable resend with zero lost ops against live prod.
- **Live verification of `#16` / `#55` / `#61` / `FM-130`:** Exercise token double-click (`#16`),
  objective drag (`#55`), the related UX/architecture specs (`#61`), and the remaining
  `FM-130` narrow-viewport fold fixes on live prod.

---

## Pass Report Template

Save each pass report as `docs/qa/passes/YYYY-MM-DD-pass-NNN-<slug>.md`:

```markdown
# QA Pass NNN: <Short Charter Title> (YYYY-MM-DD)

- **Explorer:** <model / worker>
- **Commit / Build:** `<git sha>` (server bin, web dist, packs present: yes/no)
- **Charter:** <1–3 sentences on what flows, viewports, and risks this pass targeted>
- **Feature Map Rows Touched:** <list of FM-xxx IDs>
- **Viewports Tested:** <e.g. 1440x900, 1024x600, 390x844 touch>
- **Console / Network Errors:** <0, or list>

## What Was Explored
- Concise bullet log of actual interactive paths driven (single-user, two-user, edge cases).

## Findings
| # | Severity | Feature ID | Summary & Repro | Action Taken / Link |
|---|---|---|---|---|
| 1 | `bug-minor` | FM-042 | ... | Backlog / Fix commit + test |

## Automated Test & Backlog Feedback
- Regression tests added (with fail-before-fix proof): ...
- Backlog / tech-debt entries added or updated: ...

## Process Meta-Notes (Mandatory)
- **Friction in `tools/qa-browser/`:** <what was slow, clumsy, or missing>
- **Blind spots / coverage gaps noticed:** <what was hard to observe or verify>
- **Suggested upgrade for next pass:** <one concrete improvement to driver, playbook, or feature map>
```
