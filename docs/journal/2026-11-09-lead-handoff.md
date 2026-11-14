# Lead handoff (2026-11-09)

Written by the lead before compacting its session, for whoever leads next (including itself after
compaction). The newest state is at the top; the history is in git and the other journal entries.

## Paused for the Paseo daemon restart (2026-11-14 ~13:45 UTC, lead 9eb2516b)

The concierge asked for a safe checkpoint: the restart ends every agent process and background
job. Nothing is deployed or half-deployed. Prod is still **baddb20** (store v10).

- **Lead gate stopped mid-e2e.** `/tmp/lead-gate` at 5e966b0 (main + ad60722 mobile defaults +
  e1d7796 map-state release 2) passed clippy, test and web-test. It was stopped during `just e2e`
  with load ~53, mostly Adora's selftest e2e (`adora-scratch-*/selftest-A`, which `box-busy.sh`
  doesn't match yet). **Rerun the whole gate** (`bash /tmp/lead-gate.sh`), then the Firefox run,
  then browser QA, merge and deploy, as in the section below.
- **Queued heavy jobs cancelled** (none had started): feedback's full e2e (`/tmp/fb5660-e2e3.sh`)
  and then its mutation run; sessions' `/tmp/sp3-batch6.sh` (it grabbed the lock as the gate
  released it and was killed in its first seconds); map-state's vitest rerun
  (`/tmp/ms-p3-qa/jobB2.sh`) and calm-box perf rounds (`/tmp/ms-p4/jobE.sh`). Each implementer
  was told to commit (WIP is fine) and write a "Resume after restart" section in its branch
  journal. **All three checkpointed, worktrees clean, nothing queued.** Tips: map-state-p3
  **59efdec**, map-state-r2 **e1d7796**, sessions-p3 **958638b**, feedback-56-60 **bccfa8f**,
  mobile-defaults **ad60722**. Each branch journal's "Resume after restart" lists its reruns.
- **Per stream, after the restart:**
  - *map-state:* rerun `/tmp/ms-p3-qa/jobB2.sh` (cda86fb perf, still held, no worse so far)
    and `/tmp/ms-p4/jobE.sh` (full vitest on 674fca5+). Phase 4 sits at its release boundary D4
    (ca0b0f2, a dead hero's respawn time, no row, no store bump). Open for the operator: D2 must
    ship with its edit (the picker writes the roster), metadata-tier health on Save, a scene's
    last-seen ghost, and whether source-less scenes keep the open match's names.
  - *sessions:* run `/tmp/sp3-batch6.sh` alone and detached (~50 min; copy in
    `~/.cache/mapcro-sp3-scratch/`). Pool stays removed (66–80 ms drawn, bar ~80). Then a review
    and a security review before release.
  - *feedback:* release 1 (reader, store v11 floor 9, plus #57/#58) needs the full e2e, the
    mutation run, a walkthrough and a main merge. Lead calls owed: narrow phones keep the speed
    list under 390 px; a changed tick-hover test; v11/v12 belong to this stream, so others follow;
    the justfile `reader` stays e878c30 (baddb20 has no store change).
- **Resume order:** (1) the lead gate on 5e966b0, then QA, merge and deploy; (2) a fresh Fable high
  implementer per stream, briefed with its branch journal's resume section; each reruns its
  cancelled jobs through `tools/heavy.sh`.
- **Box-busy gap:** add Adora's selftest e2e to `tools/box-busy.sh` (or rely on the load ≥12 check,
  which caught it here only because load was high).

## State (2026-11-14 ~12:30 UTC, lead 9eb2516b, before compacting)

- **Prod:** `web` runs **baddb20** (infra a1a28bb), store v10. That's #54 (a scene copy keeps its
  ink and note; a copy too big for the board is refused whole). #49 and #54 are closed.
- **In the gate now:** `/tmp/lead-gate` at **5e966b0**, which is main 5ed22f5 + **ad60722**
  (mobile defaults) + **e1d7796** (map-state release 2: phase 3 step 1 and copies carry `source`).
  Both are client-only.
  - The full gate logs to `/tmp/lead-gate.log`; then `just e2e-firefox` logs to `/tmp/lead-ff.log`.
    It ends with "vm exit skipped".
  - Then: browser QA (phone 344×615, 615×344 and a 1024×768 tablet; a scene copy's ▶ chip; Player
    plays), merge both branches to main (`mobile-defaults`, `map-state-r2`), deploy, report.
  - No schema change, so no backup is needed.
- **Implementers running** (harness subagents; they report to this session):
  - **map-state** (Fable high, worktree `map-state-p3`): the interleaved perf test of the held
    **cda86fb** (phase 3 rest), a map-DOM control walk, a TD row for 4 missed e2e mutants (TD-97+),
    then phase 4 to its first release boundary.
  - **sessions phase 3** (Fable high, `sessions-p3`): six items to finish phase 3.
    - The pool stays removed if a "left earlier" switch draws in ≤ ~80 ms with the paint-first
      change.
    - A tab remembers layers and Vision only once you set them there.
    - Kill the missed server mutant, run the browser mutant, the walkthrough and the full e2e.
    - Its TD rows are TD-93..96.
  - **feedback #56–#60** (Fable high, `feedback-56-60`): release 1 is the reader (a scene-name
    limit of 48, the callout side, recolour) plus #57 (no events list in scenes; scene notes
    hidden in Player) and #58 (−/+ speed). Release 2 is the writer.
  - **Done:** mobile defaults (ad60722, in the gate).
- **Process, all 2026-11-14:**
  - `tools/heavy.sh` queues mapcro heavy jobs, and `tools/box-busy.sh` waits for Adora. The
    lead's deploy builds skip the queue but wait for box-busy.
  - Implementers run to the end of a scoped task, with no context cutoff.
  - Fable implementers while the tokens last.
  - The vanished `target/` dirs were the operator's one-off cleanup; rebuild them.
  - A single rustc SIGSEGV gets one retry (ISS-013).
- **Waiting on the operator:** whether to set up the `mapcro-perf` Fly Sprite as an off-box e2e
  runner (the queue makes each heavy run wait 30–50 min).
- **Answered:** the home page shows "Get the Windows/Linux app" on those systems (checked on prod).

## Working rule: let agents finish (operator, 2026-11-14)

- **No context cutoff for implementers.** The operator: "I don't think we need to be cutting off
  sessions early ... let them complete their tasks before we handoff to a new agent ... we'll have
  to re-read a lot of the tokens anyway ... we control how big that context gets by just giving
  them reasonable tasks."
- **Scope each brief to one reviewable unit with a clear stop** (one release, or one phase up to
  its release boundary), and let the agent run to it. Hand off only when the task is done, or the
  agent truly can't continue.
- **Why:** on 2026-11-14 several agents stopped at ~250k mid-verification. Each fresh agent re-read
  the same context, and work was left half-checked.

## State (2026-11-14 ~06:00 UTC, lead 9eb2516b)

- **Prod:** `web` runs **e878c30** (infra 0deb3a3), **schema v10, floor 9**: map-state phase 2.
  Scenes keep every hero's build, and the scene viewer's build dropdowns, All builds and hold-Tab
  work as in Player. **#49 is closed.**
  - Old scenes get builds with Retake while their match is open.
  - There are no whole-board copies on the edit path any more (drag 5.09 → 0.05 ms at 3 KB per hero).
  - The pre-v10 backup is `/var/lib/mapcro/mapcro.sqlite.pre-v10`. The rollback target is 1dcbd31 only.
  - Checks:
    - an adversarial review said safe, with four can-follow findings, now in the backlog;
    - the gate (464/0), `reader-check`, the VM test;
    - a dev database copy (91 boards) on v10 and on 1dcbd31;
    - the lead's browser walk, locally and on prod: 12/12 builds match Player, also after a reload.
  - After the deploy: `rows.lock` is unchanged (15 rows), `reader` is e878c30, and reader-check
    builds per rev (433f6c9).
- **Map-state next:** phases 3+ (Player producers for the rest, one renderer, editing) when the
  operator wants them. The backlog has the review leftovers: duplicating a big scene after Retake
  fails silently (F1), follow with a no-match presenter (F4), phone scene builds.
- **Waiting on the operator:** the four mobile questions (defaults: fold the status strip on short
  landscape, keep the clock, add a Firefox e2e run, wrap All builds on a tablet).
- **Privacy:** a QA agent once printed two player names into its own transcript (build-column text
  holds names). The lead scrubbed them to `[name]`. Briefs now warn about it.

## State (2026-11-14 ~03:40 UTC, lead 9eb2516b)

- **Sharing the box with Adora (operator, 2026-11-14):** "just take turns, share the box, or do
  work on fly if possible." No shared lock.
  - Before any heavy job (gates, Playwright, VM tests, cargo test, deploys), read the process list
    and wait while Adora runs `cargo xtask verify`/`android`, `land_unit.sh` or `adora-deploy`
    here. A `delegate.sh --where sprite` that only names them runs on Fly.
  - `tools/box-busy.sh` checks this (exit 0 = busy). Briefs run it before every heavy job.
  - Prefer the `mapcro-perf` Sprite for heavy checks, destroyed after each session. A dedicated Fly
    Machine needs the concierge's OK.

- **Prod:** `web` runs **1dcbd31** (infra c486ee6), **schema v9, floor 8**: the map-state writer
  on the server. The 11 rows and `SceneState` are live; kills, deaths, assists and max health are
  `Ahead`. No client writes them yet. The pre-v9 backup is `/var/lib/mapcro/mapcro.sqlite.pre-v9`.
  - The gate passed (458/0), with `reader-check` and the VM test.
  - A dev database copy (91 boards) loaded on v9, and on the v8 reader after the migration.
  - Review fix F1 is in: exported files say the rows this build writes (11), so the v8 reader
    reads them.
  - `rows.lock` has 15 rows, and the justfile's `reader` is 1dcbd31 (61de6cb).
- **Also deployed:** e9f9801 (the phone fixes from the operator's screenshot: portraits, the clock
  over Events, a square board map, the Events filters). The operator's phone is about 344×615 CSS
  px.
  - Four mobile design questions wait on the operator, with defaults: fold the status strip on
    short landscape; keep the clock; add a Firefox e2e run; wrap All builds on a tablet.
- **Running:** phase 2 client (Fable, high) on `map-state-p2`. It does F2 (pickups in hundredths)
  first, then F3/F4, the edit cost and browser verification. Its release flips the 4 rows and
  `UNFIT_UNDO` live (store v10, floor 9) and fixes #49.
- **Gate note:** the QA header script's `share=false` is a timing artifact. Share appears after
  the board syncs; wait for it.

## State (2026-11-14 ~01:30 UTC, lead 9eb2516b)

- **Prod:** `web` runs **13d2fd1** (infra 630daec), **schema v8**: the map-state reader (phase 1).
  Nothing writes the new data yet: 11 rows are `Ahead`, and admission refuses them and
  `SceneState`. The pre-v8 backup is `/var/lib/mapcro/mapcro.sqlite.pre-v8`.
  - Two independent Fable reviews passed it.
  - Before the deploy, a dev database copy (88 boards) loaded on v8, and again on the v7 server
    after the migration.
  - `rows.lock` (11 rows) is committed (6b9b4d1), so phase 2 may flip them `Live`.
- **Also deployed earlier:** 3d30bb8 (#52 Feedback beside Share, #53 right-click a token for its hero
  menu); both issues closed. Desktop 0.2.3 is published; #47 is closed.
- **Running:**
  - Phase 2 (Fable, high; the operator's exception for map state) in worktree `map-state-p2`.
    It builds builds end to end and fixes #49, plus review items F3, F4, TD-80 and the browser edit
    cost.
  - Mobile QA (Fable, medium) in worktree `mobile-qa`, from the operator's phone screenshot:
    empty roster portraits, names over souls, the clock over Events.
- **Copying the prod database off the box is blocked** (user data). Check against a dev database
  copy instead.

## State (2026-11-13 ~22:40 UTC, new lead 9eb2516b)

- **Prod:** `web` runs **0bb907d** (infra 8700e14), the former `ready-to-deploy` branch, now
  main. It holds sessions phase 2 and the grant cap, the phone/tablet/touch shell, event starts,
  the desktop header, and feedback #47, #48, #50 and #51. No schema bump (still v7). The VM test
  was green. Prod QA with Playwright on 129738985: the header at 1920/1180, the hero panel beside
  its token, the phone layout playing. Stats: 0 5xx, 0 failures, 0 OOM. Closed #48, #50 and #51.
- **Standing release permission** (operator, relayed by the concierge 2026-11-13): "you have my
  standing permission to release new versions as we need them." It covers version bumps and
  release tag pushes, including `desktop-v*` tags that auto-publish public releases. Report each
  release to the concierge.
- **Desktop 0.2.3** (3a19293, tag `desktop-v0.2.3`) is the app half of #47 (Save as through the
  app's dialog). Close #47 once it publishes.
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
