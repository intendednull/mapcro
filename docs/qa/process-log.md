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
