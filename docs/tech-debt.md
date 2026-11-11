# Tech debt register

A short, living list of what makes the code slower to change or likely to break later. It is
separate from `docs/backlog.md`, which holds features and bugs. Where a backlog entry already
describes an item, the row links to it and the detail stays there.

## How we keep it (proposed for the lead to adopt)

1. **Log it when you meet it.** Every agent brief ends with: "add any debt you created or found to
   `docs/tech-debt.md`", as a row: what, where, impact, effort, trigger. A shortcut taken on
   purpose is debt too. A row is one line; detail goes in the backlog or a journal entry, linked.
2. **Each work batch takes one item.** When the lead fans out a batch, one brief also carries the
   top open register item that doesn't collide with the other branches' files.
3. **The lead reviews the register at each deploy.** Check the triggers against the deploy: an
   item whose "fix before X" names this deploy blocks it until it's fixed or re-triggered with a
   reason. Mark done items `done (commit)`, and remove them at the next review.
4. **Clean, then gate.** Once a check is clean on main (clippy, fmt, `tsc --noUnusedLocals`), add
   it to `lead-gate.sh`, `just check` and CI in the same change, so it can't regress.
5. **Rank by impact over effort.** Re-rank at each review. Data loss or a production outage comes
   before speed, and speed before tidiness.

## Register

Effort: S = under an hour or so, M = a day, L = several days or one that touches many branches.
Status: `open` unless noted. Snapshot taken 2026-11-10 on main d8d00fc.

| id | item | where | impact if left | effort | trigger | status |
|---|---|---|---|---|---|---|
| TD-1 | Clippy has 13 warnings, so `-D warnings` fails: `large_enum_variant` (2), `unwrap_used` (6), `collapsible_if` (2), `chunks_exact`→`as_chunks`, `manual_is_multiple_of`, `unnecessary_to_owned` ([backlog](backlog.md#clippy-fails-on-engine-and-server-under-rust-199-2026-11-10-from-pack-abilities), [packs.rs](backlog.md#clippy-unwrap-in-packsrs-2026-11-09-from-feedback-match), [derive.rs](backlog.md#clippy-collapsible_if-in-deriverss-buffs-2026-11-09-from-heavy-crates), [parse.rs](backlog.md#clippy-fails-on-cratesreplaysrcparsers-2026-11-09-from-shop-state)) | engine wire.rs (6), server room.rs, packs.rs (2), replay derive.rs, timeline.rs and 2 examples (4), sim lib.rs (1); extract, schema, wasm clean | Clippy can't be gated, so new warnings land unseen among the old ones | S | Fix before gating clippy (TD-3) | open |
| TD-2 | `cargo fmt --check` fails: 1,574 hunks in 78 files, every crate (server 27 files, replay 21, extract 13, schema 6, engine 5, sim 5, wasm 1). Worst: server tests/system.rs 179, replay derive.rs 122, server tests/replays.rs 111, server replays.rs 101 | workspace | fmt can't be gated, and every agent's editor or `cargo fmt` reformats files it didn't mean to touch, making noisy diffs and conflicts | S (mechanical), but it conflicts with every open Rust branch | At a quiet point: no Rust branches open (now: client-timeline, desktop-app, stat-calc-prod). Must land before TD-3 gates fmt | open |
| TD-3 | Gate gaps. `lead-gate.sh` runs test, web-test, e2e, model-sim and soak tsc, but no clippy, no fmt, no `just ts` freshness, no perf tsc. CI (`.github/workflows/ci.yml`) has no e2e, clippy or fmt. `just check` has no clippy or fmt | `~/.local/share/mapcro-lead/lead-gate.sh`, `justfile` check, ci.yml | Lint and format debt grows back; a stale `web/src/gen` gets past the lead's gate | S | Right after TD-1 (clippy), and after TD-2 (fmt) | open |
| TD-4 | Server memory peaked at 268.2 MB of its 268.4 MB cap, with no OOM kill (probably reclaimable page cache) ([backlog](backlog.md#build-the-data-retention-policy-raise-caps-cheap-storage-2026-11-10-operator-when-the-limits-call-for-it)). Also, rebase fan-out isn't bounded: 64 stale hellos on an 8 MB board could pass 256M ([backlog](backlog.md#server)) Checked 2026-11-10 20:10 (cgroup, since the 11-10 deploy): `memory.events` max 369, oom_kill 0; now anon 17 MB, file 4.5 MB. Hitting the cap and recovering with no kill points to reclaimable page cache, but the cgroup can't say what the peak was made of: next step is a server metric for anon peak (or sample `memory.stat` in the watcher). | server cgroup, room.rs rebase path | If it is anonymous memory, the next spike OOM-kills the board server for everyone | S to find out (`memory.stat` anon vs file); M to bound the fan-out | Before raising caps, and before the next deploy that adds memory per room | open |
| TD-5 | Modifier token lists go stale with patches: a modifier a patch adds isn't stored and can't be recovered without a re-parse ([backlog](backlog.md#the-modifier-token-lists-go-stale-with-patches-2026-11-09-from-match-data-v7)) | crates/replay/src/modifiers.rs, tools/modifier-tokens/gen.py | Timelines parsed after a patch silently lose effects. Fetched timelines can be re-parsed, but uploads can't | M | Fix before the next Deadlock patch that adds modifiers; until then, regenerate at every patch | open |
| TD-6 | The extractor's real-install test writes a fixed `/tmp/mapcro-extract2-real` ([backlog](backlog.md#the-extractors-real-install-test-writes-a-fixed-path-in-tmp-2026-11-09-from-map-layers)) | crates/extract/tests/extract.rs:1116 | Two agents running it at once clobber each other's pack and get false failures | S | Now, or the next time two branches touch extract | open |
| TD-7 | E2e fragility. A spec that uploads more than 6 times times out without saying why ([backlog](backlog.md#an-e2e-spec-that-uploads-over-6-times-fails-without-saying-why-2026-11-09-from-vision-fade)). The dev-warnings spec picks Vite's port with no `--strictPort` ([backlog](backlog.md#the-dev-warnings-e2e-picks-vites-port-the-old-way-2026-11-09-from-web-test-ports)) | web/e2e/server.ts, e2e/solid-dev-warnings.spec.ts | Gate runs fail for no real reason, mostly under load, and each one costs an hour to rule out a real bug | S each | Before the next Player e2e spec is written; the port fix when it flakes next | open |
| TD-8 | Format 7 added 3.4 s of parse time (8.7 → 12.1 s): each per-tick tracker walks every entity ([backlog](backlog.md#format-7-costs-34-s-of-parse-time-2026-11-09-from-match-data-v7)) | crates/replay/src/derive.rs (`urn_tick`, `heal_tick`, `buff_tick`, `vision_tick`) | Longer queue waits; worse as more trackers are added | M | When queue waits rise in stats, or before adding another per-tick tracker | open |
| TD-9 | The salts backoff is broader than deadlock-api's limiter: one 429 holds back free reads, a free 400 is cached as `upstream_down`, and a row with no salt is cached for 6 h ([backlog](backlog.md#the-salts-backoff-holds-back-free-reads-2026-11-10-from-salts-docs)) | crates/server/src/replays.rs (`back_off`, `NEGATIVE_FOR`) | Users wait for replays that a free lookup would already serve, under the 3/h cap | M | When stats show 429 backoffs or `no_replay` on matches less than 2 h old | open |
| TD-10 | Two very large files. derive.rs is 1,907 lines and holds every tracker. replays.rs is 1,736 lines and mixes fetching, salts, backoff, the upload limits, clone carry-over and the HTTP handlers. Over 800 lines as well: timeline.rs 1,167, Board.tsx 1,151, Layers.tsx 1,079, board.css 996, matches.rs 996, room.rs 948, store.rs 934, kv3.rs 873, host.ts 810, Player.tsx 806 | replay, server, web/board, web/player | Slow to review; most parallel branches conflict in these files | L | Split derive.rs together with TD-8; split replays.rs together with TD-9; only when no other branch has the file open | open |
| TD-11 | Duplicated UI logic. Three clock formatters: `core/clock.formatClock` (scenes; shows hours), `match/timeline.clockLabel` (Player; no hours, so 61 min reads `61:00`) and an inline one in `core/feedback.ts`. `Ico` is copied in 5 files. `sceneName` means two different things (match/save.ts and board/scenes.ts). The scene top bar and Player's top bar (board/TopBar.tsx 368 lines, player/PlayerTopBar.tsx 320) run side by side, with only TopBarParts.tsx shared | web/src core, match, board, player | The scene and replay views drift apart (time shown two ways, one fix applied in one bar only) | S for the clocks, Ico and naming; M for the top bars | Clocks: before Player shows a match over 60 min. Top bars: at the next change that touches both | open |
| TD-12 | Dead TypeScript. `tsc --noUnusedLocals --noUnusedParameters` finds 9 unused names (Board.tsx `Switch` and `Match`, Player.tsx `UltRing`, `mine` and `at`, save.ts `clockLabel`, CloneDialog `Ico`, 2 in e2e). `ICON_HEALS` and `ICON_CRATES` (board/tools.ts) are used nowhere. About 60 exports are used only in their own file | web/src | Noise; dead code reads as live when someone changes it | S | Any web batch; then turn on `noUnusedLocals` and gate it (rule 4) | open |
| TD-13 | Hover-label `part` is no longer used by any client ([backlog](backlog.md#hover-label-token-parts-are-unused-now-2026-11-09)) | web/src/map/HoverLabel.tsx | Dead protocol field and tests | S | Once no client in the field sends parts (one deploy after portrait-menu, so probably now) | open |
| TD-14 | Test gaps found while scanning: a hidden marker's silence has no test of its own ([backlog](backlog.md#a-hidden-markers-silence-has-no-test-of-its-own-2026-11-09)) | player/Camps.tsx `MarkerTips` | A regression ships unseen | S | The next change to Camps.tsx | open |
| TD-15 | heal_probe formats every field every tick, so it runs at about real time ([backlog](backlog.md#heal_probe-is-slow-on-the-breakable-props-2026-11-09-from-heavy-crates)) | crates/replay/examples/heal_probe.rs | Each probe of the props costs 30 min of a shared box | S | The next probe on breakable props | open |
| TD-16 | Dependencies. npm: patch and minor releases are out for @playwright/test (1.59.1 → 1.65.0; must match nix's `playwright-driver`, see flake.nix), vite 7.3.8, solid-js 1.9.19, fake-indexeddb, ws and vite-plugin-solid. Majors are out for vite 8, typescript 7 and @types/node 26. The main checkout's `web/node_modules` still has vitest 3.2.7 while the lockfile says 5.1.0 (the lead gate runs `npm ci`, so it isn't affected). Rust: `cargo outdated` isn't in the dev shell, so crates were not checked | web/package.json, flake.nix | Majors get harder the longer they wait; local test runs in the main checkout don't run the vitest CI runs | S (patches), M (majors) | Patches: any web batch. Playwright: together with a nixpkgs bump. Majors: at a quiet point | open |
| TD-17 | Match previews add `DATA_DIR/matches/<id>.preview.json` for every match a picker lists, opened or not, beside its summary (also fetched for previews). Neither is trimmed (replay-picker, 2026-11-10) | server matches.rs `preview` | The matches dir grows with every replay any app user has on disk, not only matches opened; each preview is under 1 KB, a summary ~1 MB | S (trim with the summaries) | With the data-retention work ([backlog](backlog.md#build-the-data-retention-policy-raise-caps-cheap-storage-2026-11-10-operator-when-the-limits-call-for-it)) | open |

No `TODO`, `FIXME`, `XXX` or `HACK` markers exist in crates/ or web/src. There are ten
`#[allow(clippy::…)]` or `allow(dead_code)` attributes, each with a stated reason or in test
support code.

## First three to fix, in order

1. **TD-1, then gate clippy (TD-3, clippy half).** 13 small warnings, at most an hour. The lines
   in derive.rs and timeline.rs are one-liners, so a conflict with client-timeline or
   stat-calc-prod is trivial to resolve. Add `cargo clippy --workspace --all-targets -- -D
   warnings` to `lead-gate.sh`, `just check` and CI in the same commit.
2. **TD-4, find out what the memory peak was.** One read of the cgroup's `memory.stat` (anon vs
   file) on prod. If it's page cache, record that and move on. If it's anonymous, bound the rebase
   fan-out before raising the cap. This is the one item that could take production down.
3. **TD-2, then gate fmt (TD-3, fmt half).** Run `cargo fmt --all` only at a quiet point, when
   client-timeline, desktop-app and stat-calc-prod have merged and no other Rust branch is open.
   Commit it alone (formatting only, so `git blame --ignore-rev` can skip it), and add
   `cargo fmt --all --check` to the gate in the same change.

TD-5 is next. Its trigger is a Deadlock patch, not our schedule, so if a patch lands first it
moves ahead of all three.
