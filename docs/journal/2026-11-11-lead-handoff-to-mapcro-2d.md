# Lead handoff: Opus lead → mapcro-2d (2026-11-11 ~01:00 UTC)

The outgoing lead is Paseo `b80fcb35-3ec8-462e-bfa1-2fd9408e02f2`, handing over at the
operator's request ("yes, handoff please"). From here on it takes no lead actions: no deploys, no
merges to main, no spawns. This file is untracked in the main checkout; commit it as you see fit.

**Read with it:**
- `docs/journal/2026-11-09-lead-handoff.md`, the living handoff. Its newest section is at the top.
- `/home/intendednull/concierge/notes/2026-11-10-mapcro-lead-to-sol-handoff.md`, the detailed
  version of everything below, including the exact gate, deploy and pack commands.
- The top of `docs/backlog.md`.

## What's live on infra `web`

- **mapcro 5ea3e66**, deployed 2026-11-10 ~08:50 UTC. The infra origin/main pin is cdc11fe, and
  `mapcro` and `mapcro-replay` are both active.
- **Timeline FORMAT 7.**
  - Per player: items, ability levels, casts with cooldown ends, charges, CC, effects, recaps,
    height and zipline.
  - Per match: crates.
  - **This is stored only.** The operator holds every UI for it.
- **Asset pack 6860-abilities** (79435f56…, manifest schema 4) is the newest pack. Its source is
  `~/.local/share/mapcro-lead/packs/abilities`.
  - It holds `data/abilities.json`: 2,876 item, ability and modifier records keyed by timeline
    token.
  - It holds 318 icons.
  - `pack.json` `heroes[].abilities` gives each hero's 4 signature ability tokens.
  - Files are served at `/packs/<id>/<file path with extension>`.
  - Schema-4 packs need a server at or after 5ea3e66.
- **Nothing is pending deploy.** origin/main and origin/dev are both ecab5cf, which is docs only
  on top of 5ea3e66.

## Branches and worktrees

**The lead's** (all merged or holding nothing to merge):
- `/tmp/lead-gate`: the gate worktree, detached at 5ea3e66. `/tmp/lead-gate.sh` runs in it.
  After a reboot, `~/.local/share/mapcro-lead/restore-tmp.sh` recreates it.
- `mapcro.worktrees/argon-ux` (branch `argon-ux` at 38d8a5a, no commits): the Argon design pass.
  `design-input/` and `design-output/` are git-excluded and hold extracted game art; never commit
  them.
- `mapcro.worktrees/elevation-study`, `items-study` and `status-study`: kept only for their
  untracked probes. Their findings are in `docs/research/`.

**Not the lead's.** The lead hasn't touched these:
- `ux-pass-2` (the GPT Sol pass, held for the operator).
- `topbar-ux`, `proto-resist`, `proto-scene-parity`.
- `/tmp/mapcro-{prototype,controls,data,deaths}` (the `prototype-*` branches).

## Running servers and agents

- **The lead runs no dev or e2e servers.** `/tmp/mapcro-dev.pgid` doesn't exist. The processes
  running at handoff look like yours or the operator's:
  - vite :5175 from `/tmp/mapcro-prototype`;
  - `/tmp/mapcro-topbar-dev/mapcro-server`;
  - a `mapcro-server` and a Playwright run in `proto-scene-parity`;
  - Playwright in `topbar-ux`.
- **The lead has no Claude subagents running.**
- **Argon** (Paseo `f31cee01-84be-4423-9d5c-e861ba484910`, antigravity-acp, Gemini 4 Argon High) is
  idle and done.
  - Its context is about 645k tokens. Start a fresh session for further rounds, briefed from its
    `design-output/NOTES.md` §6 and `design-input/BRIEF.md`.
  - ACP gotcha: never prompt it while it's `running`, because that cancels the turn.
  - The operator turned its Auto Accept on.
- **The operator's GPT Sol session** (`878b73dc`, codex) received the same handoff info.
- **The salt study has finished.** It stopped 2026-11-10 22:41 UTC after 1,432 calls; the data is
  in `~/.local/share/mapcro/salt-study/`. **Pending:** run
  `python3 -I ~/.local/share/mapcro/salt-study/summarise.py ~/.local/share/mapcro/salt-study` and
  write the "Results" section of `docs/research/deadlock-api-salts.md`.
- **The prod watcher** (`mapcro-prod-watch.timer`, a user unit) is active. It alerts whichever id
  is in `~/.config/mapcro-watch/lead`, which still holds the old lead's id. **Write your own id
  there.** Re-run `just watch-install` after a reboot.

## Open items

**Held for the operator:**
- **The Argon UX pass.** The artifact is at
  `/home/intendednull/concierge/artifacts/mapcro-ux-argon/index.html`. It's git-ignored because it
  embeds pack art.
  - Its D1–D5 decisions:
    - where the hero card opens;
    - the portrait cooldown dots;
    - Save scene switching into the new scene;
    - the scrubber in match scenes;
    - casts in Events.
  - Its 8 bugs are unverified and sit as the top entry of the backlog. Reproduce each before
    fixing.
- **The GPT Sol pass** (ux-pass-2).
- Elevation's 4 questions, death pings versus the skull's vision rule, and the map candidates.

**Extraction leftovers, for the operator to decide** (all in the backlog):
- the extra icons, about +1 MB;
- the fallback labels for the 825 modifiers that have only an internal name;
- whether `tools/modifier-tokens/gen.py` should read our pack instead of boon-data;
- the 3 unnamed engine modifiers.

**Gate gap:** `cargo fmt --check` and clippy both fail on main under rust 1.99.1, and the gate
(`just test` and friends) never runs them. A mechanical cleanup was offered and not started.

**Older backlog:**
- `ops_rejected{id_taken}`;
- the reload chip;
- the protocol-close burst;
- trooper styling;
- the feedback token expiry alert (nothing alerts yet; the form returns 502s once the token
  expires);
- checking the API's item ids against a demo;
- the 300 s crate respawn;
- the dev-warnings e2e Vite port.

## Gotchas

- **Gate.** Run `/tmp/lead-gate.sh` against a detached checkout. Add the VM test
  (`nix build .#checks.x86_64-linux.service`) whenever the server, worker or nix changes.
- **Playwright** needs `nix develop -c node …` so it gets the browsers path.
- **Flaky e2e failures** have repeatedly turned out to be real bugs. Investigate before dismissing
  one.
- **Deploy.** Use an infra temp worktree from origin/main and never touch the `feat/gsd-deploy`
  checkout.
  1. Run `nix flake update mapcro`, with retries.
  2. Build the toplevel.
  3. Diff the units and the Caddy config.
  4. Deploy.
  5. Run healthz-check.
  6. Probe canary, healinggrief24, willow and sandbox.
  7. Push infra main.
  8. Use the feature on prod.
  9. Run `just stats summary`.
  10. Report to the concierge (`89f02356-e7ef-4821-aeb5-eda251c387a0`).
- **Packs.** Use the tar-over-ssh procedure in `docs/deploy.md`, then restart mapcro. The newest
  pack wins by mtime. Keep the old packs.
- **The box.** Keep the 1-minute load under about 12, because Adora shares it.
- **Subagents** run at medium effort. Follow `concierge/guidelines/spawning.md`, and give each one
  its own worktree.
- **Privacy and rules.**
  - Never commit game assets or secrets.
  - Never list or glob the Steam dirs or `/`.
  - Never write down player names.
  - Use only standard 6v6 data, never Brawl 122134063.
  - No upstream issues or PRs.
  - The operator's shell is fish.
