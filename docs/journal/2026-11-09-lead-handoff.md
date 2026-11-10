# Lead handoff (2026-11-09)

Written by the lead before compacting its session, for whoever leads next (including itself after
compaction). The newest state is at the top; the history is in git and the other journal entries.

## Production

- `web` runs **c9815a4**, deployed 2026-11-09 ~16:25 UTC: shops (8) and teleporters (4) always shown, 36 heal pickups behind a "Heals" toggle, timeline FORMAT 5; acf9b44 before it fixed Sinner's Sacrifice/camp tiers. Earlier (c561062, 11:08 UTC): vision hides unseen
  enemies by default ("Show last seen location" brings ghosts back), the carried urn follows
  vision, and hero kill/vision moved to a right-click menu on the portrait. 
  The infra main pin is pushed.
- **Feedback form:** deployed off (8d6af34, `/api/feedback` → enabled:false); the `feedback` label
  exists on the repo. Waiting on the operator (away, 2026-11-09) to create the fine-grained token
  (intendednull/mapcro only, Issues read/write) and save it to
  `~/.config/mapcro-secrets/github-feedback-token`. Then: copy it by path to
  `/var/lib/secrets/mapcro-feedback-github-token` on `web` (root 600, never read or printed), set
  `services.mapcro.feedbackGithubTokenFile` in infra, deploy, and file one test issue then close
  it (the operator OK'd real test issues).
- **Held for the operator's review:** the GPT Sol UX pass. Its findings are on branch `ux-pass-2`
  (Paseo worktree `~/.paseo/worktrees/3mqv6wf1/ux-pass-2`, kept). Its one code fix, 11506df
  (keyboard-reachable replay picker), is reverted on main in c561062 until the review. Don't act on
  the findings before the operator says so.
- **Packs on prod:** `6860-rejuv` (c9c81b76…, newest, with the Rejuvenator HUD art), `6860-badges`,
  `6860p`. Its source is kept in `~/.local/share/mapcro-lead/packs/rejuv`.
- **Agents work in worktrees** (`/storage/projects/mapcro.worktrees/<name>`, operator and spawning.md
  item 13); the lead merges, gates, deploys and removes the worktree. None are running.
- The database is at schema **v6**, migrated 2026-11-09 01:12 UTC. Its backup is
  `/var/lib/mapcro-backup/pre-v6-20261109T0109.sqlite`, integrity ok, 20 boards. From v6 on,
  rollbacks are safe: a server older than the database opens it as long as it's at or above the
  database's compat floor. Rolling back *past* this deploy means restoring that backup.
- **Asset packs:** `6860-badges` is placed and is the newest, alongside the old `68d73323…`. It holds
  the card art, the critical portraits and the urn sites. It was built with `just extract
  ~/.local/share/Steam/steamapps/common/Deadlock/game/citadel /tmp/lead-pack` and placed as in
  docs/deploy.md "Asset packs".
- **Timeline format** is 2. Cached CDN timelines in an older format re-parse once, when an editor
  attaches the match or loads its timeline (491f6de).
- **Metrics:** `just stats summary|failures|funnel|limits|usage|series` runs over SSH; `just stats
  local …` reads the dev database.
- **Watcher:** the `mapcro-prod-watch` user timer (`just watch-install`, which must be re-run after a
  reboot) alerts the lead's Paseo id, kept in `~/.config/mapcro-watch/lead`. **A new lead session
  must write its own id there.**

## Running when this was written

- **Update 2026-11-09 07:35:** buffs-timers and timer-audit are done and deployed or committed
  (audit: docs/research/replay-timers-audit.md). **timer-gaps** (Claude agent) now builds the audit's
  gaps 1, 2 and 5: Rejuvenator, open-rift progress and give-up, statue and urn-return timers.
  Held for the operator: who holds a bridge buff (inferred), item and ability cooldowns.

- **buffs-timers** (Claude agent). It is adding:
  - each powerup's buff type, with the game's icons; its worker part, 814e697 (format 2), is
    already committed;
  - hover spawn timers for rifts, buffs, the urn and the mid boss;
  - one instant hover label for map icons and tokens, replacing the SVG `<title>`s;
  - the presenter's hover mirrored to followers, through a Presence `hover` field (a schema change,
    so BUILD_ID moves).
  Its uncommitted work is in web/src/player, web/src/map and the e2e specs.
- **timer-audit** (Claude agent). It audits every timer-like field in 129738985 and writes
  docs/research/replay-timers-audit.md plus a rerunnable tool. Hand its gaps to buffs-timers, or to
  the next agent.
- **The salt study.** The `mapcro-salt-study` user unit runs until about 2026-11-10 14:00 UTC, data
  in /tmp/salt-study/. Summarise it with `python3 -I /tmp/salt-study/summarise.py`. The design and
  part 1 are in docs/research/deadlock-api-salts.md: a stored salts row always wins, and the
  players' ingest tool writes rows with no replay salt, so the Steam lookup never fills one. Analyse
  the data when it's done and write the "Results" section.

## After the reboot (2026-11-09 ~00:50 PST)

The operator rebooted the dev box; /tmp was wiped and the salt study's first 8 h of data were lost
(the planned backup had not been made). Recovered 00:45 PST:
1. The lead's scripts now live in `~/.local/share/mapcro-lead/` (gate.sh, mapcro-busy.sh,
   lead-gate.sh), rebuilt from the session transcripts. **After any reboot run
   `~/.local/share/mapcro-lead/restore-tmp.sh`**: it relinks them into /tmp and recreates the
   /tmp/lead-gate worktree.
2. Re-arm the watcher: `just watch-install` (done 00:45).
3. The salt study restarted fresh at 00:41 PST with its data in `~/.local/share/mapcro/salt-study/`
   (probe.py, summarise.py, obs.jsonl, state.json); /tmp/salt-study links there. It runs 38 h, to
   about 2026-11-10 22:40 UTC. After a reboot, relaunch it with the same command and it resumes:
   `systemd-run --user --unit mapcro-salt-study -p RuntimeMaxSec=40h /run/current-system/sw/bin/python3 -I ~/.local/share/mapcro/salt-study/probe.py ~/.local/share/mapcro/salt-study`.
4. The live dev stack (vite :5173) is gone. Start it again only if the operator wants it.
5. **Agents stopped mid-work. Their WIP notes say where each left off:**
   - **timer-gaps:** Rejuvenator, rift progress, statue and urn timers, and the operator's
     hover-label rules. Note: docs/journal/2026-11-09-timer-gaps-wip.md.
   - **board-ux:** selection in the user's colour, the stencil at the map edge, Q E R T A S D F keys,
     team names Hidden King / Archmother (`teamName()` landed in d86b63d), hero focus on a portrait
     click. Note: docs/journal/2026-11-09-board-ux-wip.md.

   Their uncommitted edits are in the tree. Both were resumed at 00:47 PST.
6. **Next after timer-gaps:** build vision control from docs/research/replay-vision.md. The
   control is "Vision: All / Hidden King / Archmother"; enemies are ghosted at their last-seen spot
   (the lead's default, told to the operator).

## Open items

1. **Investigate `ops_rejected{id_taken}`.** It happened twice in 6 h on prod (stats, 2026-11-09).
   The guess is two tabs creating a match's live layer (fixed ids) at once, but it isn't checked.
   Find where the server rejects for `IdTaken` (engine) and which client path creates records
   with fixed ids.
2. **A "New version · Reload" chip.** Web-only deploys don't reload open tabs, because BUILD_ID only
   covers schema and engine. Proposed to the operator; no answer yet.
3. **Next deploy:** buffs-timers' batch. Gate it on a clean worktree, with the VM test, since it
   changes the schema.
4. **The `stats summary` "(-0%)" cosmetic**: a small DeepSeek job.
5. **Trooper styling** to match the in-game minimap, waiting on an operator screenshot.
6. **Backlog** (docs/backlog.md):
   - a settings page
   - browser parsing (wasm)
   - board export and import
   - data decisions
   - rebase fan-out
   - older maps
   - "Resume a scene"
7. **The browser-side deadlock-api lookup is dropped** (docs/research/browser-side-replays.md). The
   lever for more auto-fetches is getting replay salts into deadlock-api (a companion that submits
   them), which is on hold.

## Working notes, learned the hard way

- **Shared working tree.**
  - Commit only your own hunks. Use normal context patches (`git diff` → filter hunks → `git apply
    --cached`), **never `-U0` / `--unidiff-zero`**, which applied a hunk in the wrong place
    (ba78cae, fixed in 0be6ef2).
  - Then check the committed tree builds in a scratch worktree (/tmp/lead-gate).
  - Agents must never `git checkout --`, restore or stash shared files: ease-all wiped the lead's
    hunks that way.
- **Gate.**
  - `/tmp/lead-gate.sh` runs in the /tmp/lead-gate worktree; check out the commit first.
  - Add the VM test (`nix build .#checks.x86_64-linux.service`) when the server, worker or nix
    changes.
  - Every heavy run goes behind `/tmp/mapcro-scripts/gate.sh`, which aborts on timeout.
- **Flaky tests.** "Flaky" e2e tests have repeatedly been real bugs: a store object aliased, the
  stale-ink sweep, leaked browser contexts (fixtures.ts now closes them). Investigate before
  dismissing one.
- **Replay fixtures.** Synthetic replay timelines in e2e stamp `TIMELINE_FORMAT` (from
  e2e/server.ts), never a literal.
- **Unknown paths.** The public site answers any unknown path with 200 and the app's page, so a
  health or exposure check must look at the body.
- **Deploy routine.**
  1. Back up the database before a schema bump (`sqlite3 .backup` through `nix shell` on `web`).
  2. Diff the units and the Caddy config.
  3. Deploy.
  4. Run the healthz gate and probe the 5 sites.
  5. Use the feature on prod.
  6. Run `just stats summary`.
  7. Report to the concierge.
- **DeepSeek** (OpenCode, through Paseo) suits small, mechanical tasks. Review its diffs and check
  the balance afterwards (`/home/intendednull/concierge/bin/deepinfra-balance`). The operator says
  the balance is fine for now.
