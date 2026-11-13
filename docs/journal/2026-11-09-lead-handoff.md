# Lead handoff (2026-11-09)

Written by the lead before compacting its session, for whoever leads next (including itself after
compaction). The newest state is at the top; the history is in git and the other journal entries.

## State (2026-11-13 ~22:40 UTC, new lead 9eb2516b)

- **Prod:** `web` runs **0bb907d** (infra 8700e14), the former `ready-to-deploy` branch, now
  main. It holds sessions phase 2 and the grant cap, the phone/tablet/touch shell, event starts,
  the desktop header, and feedback #47, #48, #50 and #51. No schema bump (still v7). The VM test
  was green. Prod QA with Playwright on 129738985: the header at 1920/1180, the hero panel beside
  its token, the phone layout playing. Stats: 0 5xx, 0 failures, 0 OOM. Closed #48, #50 and #51.
- **#47 stays open** until desktop 0.2.3 ships (bump `desktop/app/{tauri.conf.json,Cargo.toml,
  Cargo.lock}`, tag `desktop-v0.2.3`). The tag push publishes a public release, so it waits on
  the operator's OK.
- **Map state:** the spec is `docs/specs/map-state.md` on `scene-state` (f5addeb). A fresh Fable
  xhigh adversarial review was rerun (the first one hit the weekly limit). Its verdict goes to the
  operator; **no Phase 0 until the operator decides.**
- **Open feedback:** #47 (above), #49 (superseded by map state), #16 (parked).

## State (2026-11-12 ~23:50 UTC, lead)

- **Prod:** `web` runs 074647d (infra a94edb7). **Schema v7** (sessions; additive, floor 5). The
  pre-v7 backup is at `/var/lib/mapcro/mapcro.sqlite.pre-v7`. Healthz ok, 0 5xx, 0 OOM.
- **Shipped 2026-11-12:**
  - Player perf (#39 closed): per-sample redraws, Tab keeps its columns, the events list skips
    off-screen rows, the buildAt index, map icons, top-bar guard. `just perf-player` measures it.
  - Laser seams (#46 closed).
  - The lead's match lookup (`just stats timelines`, `just pull-timeline`).
  - Sessions phase 1 (server, no UI). It passed a Fable adversarial review and a re-review.
- **Open feedback:** only #16 (parked).
- **Next:** sessions phase 2 (client UI, spec §10 item 2); TD-57 (the per-board grant cap can
  lock the owner out). Fly Sprite profiling is parked (backlog).
- **DeepSeek** (Paseo, opencode provider) handles mechanical perf/fix tasks well and cheaply
  (about $0.20 for the whole day). Review its output, as with the buildAt walk-back gap and the
  laser clip churn.

## State (2026-11-12 ~07:45 UTC, lead)

- **Prod:** `web` runs aa783fc (infra 1166f8a) + pack **6861-stacks** (game 6861, with `stack_label`).
  Healthz ok, 0 OOM, 0 5xx; `id_taken` 0 since the fix (last one 2026-11-11 08:12).
- **Desktop 0.2.2 published** (auto-publish): updates install only on a click (#43). The .deb offers
  no update (package manager). Apps on 0.2.1 or older self-install 0.2.2 once, at start.
- **Replay FORMAT is 10** (own hero stacks, #38). Old uploads show "Upload replay file", or in the
  app "Outdated · Reparse" when the demo is in the replays folder.
- **Feedback closed today:** #38, #40–45. Open: #39 (agent `lateperf`, worktree `late-perf`, profiling
  late-match sluggishness), #16 parked.
- **Next:** gate/QA/deploy late-perf; sessions phase 1 (server sessions + grants, then a security
  review) not started; TD-36 (follower wait vs reconnect backoff) still to consider.

## In flight at compaction (2026-11-11 ~14:00 UTC, lead mapcro-2d)

- **Prod:** `web` runs 4a5a384 + pack 6860-tooltips. **Main is 3cbc680** (+ handoff docs): adds the
  streamed parse (vendored boon/pbdems2) and desktop 0.2.0 bump/smoke fix. Gate on 3cbc680: clippy,
  test, web-test, model-sim green; e2e 226 passed / **1 failed** (`upload-ux.spec.ts:260` upload
  progress + Cancel; re-running with --repeat-each 2 → `/tmp/lead-upload-e2e.log`); **VM test failed
  only on a corrupt local nix store path** (`mapcro-replay-deps` checksum), deleted and rebuilding
  → `/tmp/lead-vm.log`. Deploy 3cbc680 once both are green (normal flow), then run the old-map and
  Brawl refusal tests (`MAPCRO_OLD_REPLAY`, `MAPCRO_BRAWL_REPLAY`; local demos by exact path, refusal
  only, never as data). Then lower the worker's `memoryMax`/`LimitFSIZE` once
  `stats series zstd_window_bytes` + `parse_peak_anon_bytes` have real fetches.
- **Desktop 0.2.0:** tag `desktop-v0.2.0` (d323e70) release run 43011973558 builds a **draft**.
  Check its assets (setup.exe, portable zip, stable-named copies, Linux AppImage/.deb, latest.json
  with windows + linux), then **ask the operator before publishing**. 0.1.0 installs (operator +
  a friend) self-update after publish. `WINDOWS_APP_RELEASED` (web) stays false until the operator
  says to show the download link.
- **Agents running** (worktrees under `mapcro.worktrees/`):
  - `view-state` (agent viewstateimpl): registry steps 1–3, test-first (characterisation matrix,
    mutation testing). Operator: extra vigilance; **after it reports, run an independent adversarial
    review (fresh Fable agent, medium effort, given the diff) before merging.**
  - `rift-troopers` (rifttroopers): flag rift troopers (kothtrooper modifier / scale ≥ 1.5, bit 15
    of the trooper id, no FORMAT bump), draw bigger + darker, filter 56 base phantom units. Merge →
    close feedback #5.
  - `sessions-spec` (sessionsspec): docs-only spec for **sessions of linked boards** (operator's
    reframe of multi-replay tabs: each tab a full board, switch = fresh mount, remove = unlink,
    undo = relink, existing boards addable, notes per board, no tab cap). Build only after view-state
    lands (active tab = a registry row).
  - `fix-batch-2` (fixbatch2): feedback #21 (map cutout clip + border over), #22 (All builds vs
    Rejuvenator overlap), #23 (desktop off-site links incl. target=_blank → system browser). Close
    those issues when merged.
- **Waiting on the operator:** the 4 mobile decisions in `mobile-ux` `team/proposal.md` (team done
  and stopped; argon quota resets 2026-11-17, not needed).
- **Rules learned today** (also in memory): follow the game's words/behaviour over suggestions;
  labels are tags (spec §4b); close feedback issues when their fix merges; feedback = suggestions
  weighed against the plan; state changes need characterisation tests + mutation testing +
  adversarial review; consult Fable when research stalls; tech-debt register reviewed each deploy.

## Mobile UX design team (throwaway branch `mobile-ux`, operator 2026-11-11)

Four Paseo designers in `/storage/projects/mapcro.worktrees/mobile-ux` (brief and roster:
`design/mobile/BRIEF.md`): sol (codex gpt-6.1-sol), astra (codex gpt-6-astra), argon (antigravity
gemini-4-argon-medium), flash (antigravity gemini-3.8-flash-high). Docs and static HTML only, no app
code. Operator: keep pushing and routing them; restart each when its quota resets, until a finished
proposal/prototype or the week's tokens run out. **argon resets 2026-11-17 06:48 UTC**: restart it
then with "read BRIEF.md and your NOTES.md, continue".
**Finished 2026-11-11:** `team/prototype/index.html` (+ `flows.html`) and `team/proposal.md` (52 features: 51 kept/moved, 1 deferred, 4 open decisions) on `mobile-ux` (unpushed). Team stopped; argon not needed unless the operator wants another round. Known nit: landscape tool rail overlaps the Layers button.

## Production

- **2026-11-11 ~12:00 UTC (lead mapcro-2d):** `web` runs **4a5a384** (infra bba10f9): tooltips +
  stat panels + minimap hero panel, web polish (feedback fixes), follow sync, local previews, salts
  fixes, 32% lighter parse, clippy gated. Pack **6860-tooltips** (40 MB, newest) at
  `~/.local/share/mapcro-lead/packs/6860-tooltips`. Desktop 0.1.0 published; 0.2.0 waits on the
  Windows smoke fix (agent winsmoke, branch `ci-windows-smoke`). Running: `stream-parse` (vendored
  streaming parser), `fix-batch-2` (#21 #22 #23). Open feedback: #5 (no data), #16 (backlog), #21–#23.
- **2026-11-11 ~05:45 UTC (lead mapcro-2d):** `web` runs **98a21ae** (infra e339ef9): calculated
  hero stats (`crates/stats`, WASM), timeline **format 9** (statue pickups), the client-timeline
  route, ≈ on calculated values. Pack **6860-stats** (c9c55048…, 689 files: 6860-items plus 28
  stat tables for 6711–6860) placed and newest; source `~/.local/share/mapcro-lead/packs/6860-stats`,
  boon-data snapshots in `/tmp/stat-calc-prod/boon`. Open: `desktop-app` (unmerged; needs the
  operator's updater key and a CSP decision), label sweep, fmt/clippy at a quiet point.
- **2026-11-11 ~04:25 UTC (lead mapcro-2d):** `web` runs **26b3016** (infra afad58e): UX batch 1
  (build order, skull recap, save-scene toast, dialog focus), the replays-folder link (Chromium,
  second Steam libraries only), feedback limits 100/h per client and 500/day, darkened unseen
  portraits, plus docs (research map, AGENTS.md, desktop-app research, tech-debt register). Same
  pack. Open branches: `client-timeline` (done, next deploy), `desktop-app`, `stat-calc-prod`
  (format 9: ship a desktop app update with any FORMAT bump once the app is out).
- **2026-11-11 ~02:50 UTC (lead mapcro-2d):** `web` runs **df638a0**, the UI prototype (layout
  regroup, Tab scoreboard, effects, death recaps, elevation/zipline layer, vision portraits,
  scene timeline, shared top-bar parts) and timeline **format 8** (level, kills, assists, max HP).
  Infra main 0a593e2. Pack **6860-items** (9290ecf6…, 649 files: shop item artwork from
  3978b87) placed and newest; its source is
  `~/.local/share/mapcro-lead/packs/6860-items`. Gate, VM test, unit diff
  (mapcro, mapcro-replay only), healthz and fleet probes green; used on prod. Open: an effect with
  only an internal name shows it (fall back to its item's label); the max HP the replay records
  updates only at respawn (calculated max HP from branch `stat-calc` should replace it).
- Earlier: `web` ran **5ea3e66**, deployed 2026-11-10 ~08:50 UTC. Packs now carry item, ability and
  modifier names and icons: `data/abilities.json` holds 2,876 records keyed by timeline token,
  plus 318 icons, at manifest schema 4. The server now serves `application/json` blobs. The pack
  **6860-abilities** (79435f56…) is placed and is now the newest. Its source is
  `~/.local/share/mapcro-lead/packs/abilities`. Verified on prod: the table, an icon and the
  hero tokens return 200, and 129738985 renders on the new pack. None of it is user-visible: the
  UI is held for the operator.
  - Gate note: the gate (`just test`) never runs `cargo fmt` or clippy, and both fail on main
    under rust 1.99.1. That is in the backlog, waiting on the operator.
- **The Argon UX pass is done and held for the operator.** Gemini 4 Argon ran it at High in
  `mapcro.worktrees/argon-ux`, as Paseo agent f31cee01. The artifact is at
  `concierge/artifacts/mapcro-ux-argon/` (git-ignored, because it embeds pack art; the pack copies
  are in the worktree's `design-input/`).
  - Its recommendations:
    1. map layers get their own bar;
    2. one stage for Player and scenes;
    3. the new data in three tiers: marks, then a hero card, then a scoreboard-style dropdown;
    4. the death recap on demand;
    5. the match source moves to the header.
  - It has 5 decisions, D1–D5, for the operator. Its 8 bugs are in the backlog as unverified.
  - Its session is about 645k tokens: after the icon swap it writes a handoff in NOTES.md, and the
    next session starts fresh.
  - The operator also has a `topbar-ux` worktree (38d8a5a), not made by the lead. Leave it alone.
- Before that, `web` ran **c02d230**, deployed 2026-11-09 ~22:10 UTC: timeline FORMAT 7 (hero builds, abilities,
  casts + cooldown ends, charges, CC, icon effects, death recaps, height, zipline: STORED ONLY, the
  operator holds the UI as too cluttered; plus Heavy boxes, tough crates broken/back in Player),
  zstd/gzip timelines, MAX_BYTES 6 MiB, test-harness port races fixed (server 442ebcd, web afcaa04).
  Verified on prod (129738985: format 7, counts match, zstd, 78 crates). Pack re-extract for the
  crates pending (built-in fallback positions match meanwhile).
- Before that, **f53127b** (~20:45 UTC): a fading team-coloured skull at a death
  (Vision rules; verified on prod). 111a40d (~20:25) before it: feedback issues carry the open match
  (checkbox, server-validated). Feedback issue #2 (pause bug) closed with a comment, operator OK'd.
  Studies on main, awaiting the operator: elevation.md, abilities-and-items.md (decisions section;
  chooser artifact in concierge/artifacts/mapcro-abilities-items), status-effects.md. Plan: ONE
  FORMAT bump for items/abilities/cooldowns/status effects (each bump forces upload re-uploads).
- Before that, **a3a35b5** (~20:05 UTC): the replay clock holds through in-game
  pauses (FORMAT 6; `m_nTotalPausedTicks` only grows at the unpause, so the running pause counts from
  `m_nPauseStartTick`); before, a pause froze its stretch and lost as much play after it, and an
  objective that fell in the lost stretch never fell (feedback issue #2, match 134570618, an upload
  Valve has no demo for: needs a re-upload). Verified on prod: 129738985 re-parsed to format 6, every
  second 149–175 moves. Also: scenes show the match's names, no side roster, portrait Rename….
- Before that, **f2aa2f1** (~19:35 UTC): a follower draws the presenter's Vision and
  Show last seen (new optional `Playback.vision` in presence; changing either stops following,
  operator OK'd); verified on prod with two browsers.
- Before that, **715421d** (~18:40 UTC): a clone keeps its board's matches and
  uploaded replay (hard-linked timeline, no re-parse); verified on prod (clone of 129738985 opens
  at Full replay). b3b5a80 before it added vision fades and lane shops closing with their guardian.
- Before that, **c9815a4** (~16:25 UTC): shops (8) and teleporters (4) always shown, 36 heal pickups behind a "Heals" toggle, timeline FORMAT 5; acf9b44 before it fixed Sinner's Sacrifice/camp tiers. Earlier (c561062, 11:08 UTC): vision hides unseen
  enemies by default ("Show last seen location" brings ghosts back), the carried urn follows
  vision, and hero kill/vision moved to a right-click menu on the portrait. 
  The infra main pin is pushed.
- **Feedback form: live** since 2026-11-09 ~18:10 UTC. The token is a fine-grained PAT (intendednull/mapcro
  only, Issues read/write); the operator's copy is in `~/.config/mapcro-secrets/github-feedback-token`, the server's
  in `/var/lib/secrets/mapcro-feedback-github-token` (root 600, out of band, not sops). Infra sets
  `services.mapcro.feedbackGithubTokenFile`. Tested end to end with issue #1, then closed. When the token
  expires the form fails with 502s (`stats failures`); nothing alerts yet (backlog).
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
