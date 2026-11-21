# Exploratory QA Loop — 2026-11-21

Branch `qa-loop` (off `main` `8ec46d1`).

## Why we built this

mapcro already has a strong automated test suite (~100 Playwright e2e specs, ~70 unit tests, a
Rust sync simulator, and a soak harness) and a habit of validating changes by using the app.
What was missing was a **repeatable, continuous exploratory loop** where an agent drives the live
app like a curious user — clicking, hovering, dragging, resizing viewports, opening two users side
by side, looking at real screenshots, and checking console/network logs — and systematically feeds
what it learns back into both the feature map and automated tests.

Automated tests verify the assertions we already thought to write. Exploratory passes look for
everything between the assertions: narrow-viewport squeezes, cross-feature interactions, stale
overlays, hover/label drift against spec §4b, and multi-user edge cases.

## What v1 includes

1. **Interactive browser driver (`tools/qa-browser/`):** A zero-new-dependency Node.js CLI +
   Unix-socket daemon reusing Playwright from `web/node_modules` inside `nix develop`.
   - Launches a throwaway local `mapcro-server` (or attaches to `--url`), with isolated
     `BrowserContext`s per named tab (`coachA`, `coachB`) so two users don't share `localStorage`
     or `IndexedDB`.
   - Includes a fast reference-replay responder (`--mock-replay-129738985` and `feed-replay`) that
     seeds `DATA_DIR/replays/129738985-cdn.json` and watches `REPLAY_DIR/inbox/`, so exploratory
     passes can load the real 6v6 replay `129738985` into Player in ~2 seconds instead of spending
     15s of CPU parsing every time.
   - Enforces a hard screenshot path guardrail in code: `shot` resolves symlinks and refuses any
     path inside the repo, worktrees, or any git directory, so game art screenshots can never
     accidentally enter git.
2. **Playbook (`docs/qa/README.md`):** The 5-step loop (Charter → Interactive Exploration →
   Pass Report + Feature Map Update → Automated Test & Backlog Feedback → Process Retro), severity
   taxonomy, viewport matrix, and strict guardrails.
3. **Living feature map (`docs/qa/feature-map.md`):** Seeded with 72 rows across 15 user-facing
   domains, grounded in `web/src/`, `web/e2e/`, and `web/test/` (71 `auto-only`, 1 `unmapped`:
   tablet & narrow desktop layouts `FM-132`).
4. **Process log (`docs/qa/process-log.md`):** Append-only log of how the loop and driver evolve
   after each pass based on mandatory explorer Process Meta-Notes.

## Predictions (written before Pass 1)

1. **Automated e2e vs exploratory QA:** Automated e2e will remain better at deterministic
   invariants (sync convergence, view-state follow matrix, performance budgets), while exploratory
   passes will disproportionately catch:
   - Visual/layout overlap and clipping at intermediate viewports (`1024x600`, `800x600`,
     `1024x768` touch) where few specs run.
   - Cross-feature state leaks when combining flows that live in separate spec files (e.g. Player
     build overlays + follow mode + session tab switching).
   - Spec §4b label/hover drift in newly added or rarely visited menus.
2. **Feedback loop:** Expect at least 2–3 real findings in Pass 1–2 that turn into permanent
   regression tests (proven to fail before the fix) and 1–2 concrete upgrades to `tools/qa-browser/`
   (likely file-upload or touch-gesture helpers) driven by explorer Meta-Notes.
3. **Cost:** With `--mock-replay-129738985` and the compact `snapshot` summary, a focused 1–2
   domain exploratory pass should run cleanly in a single worker turn without saturating the shared
   box.

## How we'll iterate

Every pass report ends with **Process Meta-Notes** (driver friction, blind spots, one suggested
upgrade). After Passes 1–3 we will evaluate the predictions above in `docs/qa/process-log.md` and
refine `tools/qa-browser/` and `docs/qa/README.md` accordingly.
