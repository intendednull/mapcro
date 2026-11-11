# Agents: start here

mapcro is a real-time collaborative macro-coaching board for Deadlock: heroes on the minimap,
objectives, drawings, scenes, share links. It also has a replay tier: a Deadlock `.dem`, fetched
from Valve's CDN or uploaded, is parsed into a per-second match timeline that Player scrubs.

## Where things are

- Design: `docs/specs/architecture-design.md` (§6a match import, §6b Player, §12 game assets).
  Sessions (several boards as game tabs, their links and grants): `docs/specs/sessions.md`.
- Open work: `docs/backlog.md`. History and decisions: `docs/journal/`. The living lead handoff
  is `docs/journal/2026-11-09-lead-handoff.md` (newest state at the top).
- Tech debt: `docs/tech-debt.md`, the register and how we keep it. Log debt you create or find.
- Replay and game-data knowledge: `docs/research/README.md`. Read it before you probe a demo or
  the game files. It lists where each field comes from, the dead ends, and the traps.
- Deploying the app and asset packs: `docs/deploy.md`.
- Code: `crates/replay` (demo → timeline worker), `crates/extract` (game install → asset pack),
  `crates/server`, `crates/engine` (sync), `web/` (client).

## Toolchain

NixOS. Run everything inside `nix develop`. Tasks are `just` recipes: read the `justfile` (for
example `just test`, `just web-test`, `just e2e`, `just check`, `just dev`, `just extract`).
Playwright e2e serves the built `web/dist`, so rebuild before you run specs by hand. The box is
shared: run heavy jobs alone and keep the load low.

## Working rules

- **Worktrees:** each agent works in its own worktree and branch off `main`
  (`mapcro.worktrees/<name>`). The lead merges, gates and deploys.
- **Privacy:** never write player names or account ids anywhere: docs, commits, logs, probe
  output. Never list Steam directories or `/`. Open only the extractor's allow-listed game files.
- **Game art is never committed:** not packs, extracted images, or screenshots and mocks that
  show them.
- **Data:** standard 6v6 replays only (`game_mode == 1`). Match 122134063 is Street Brawl and
  must never be used as data. The reference replay is 129738985 (patch 6839).
- **Labels and hover text:** short, the game's words, no explanations (spec §4b). Check every
  `title`/tooltip you add or change against it.
- **View state says what following does with it:** a new toggle, panel or filter in Player is a
  row in `crates/engine/src/view_state.rs` (then `just ts`) held in `web/src/player/viewstate.ts`,
  so followers get it by default; the store stops the follow on a `stop` key, so don't stop it
  yourself. Any other new signal there needs a line in `web/test/view-state-ledger.ts` saying
  why not, and a new key a row in `web/e2e/follow-matrix.spec.ts` (spec §8, the view-state
  registry).
- **Feedback issues are suggestions:** issues labelled `feedback` on GitHub are weighed against the
  plan (backlog, specs) by the lead and operator. Don't build one just because it exists.
- **Update the research map:** if you learn something about replay data, game files or an
  external source, add a line to `docs/research/README.md` in the same change.
