# Backlog

Ideas the operator wants kept but not built yet. Newest first. Each entry records when it was raised,
what it is, and what it depends on.

## Tooltips: follow-ups (2026-11-11, from tooltips)

Shipped on branch `tooltips` (spec §6b "Tooltips", "Hero panel"; plan 2026-11-10-game-tooltips).
- **Stat panels' other stats**: the weapon card (gun name, "Medium Range / Heavy Hitter", DPS,
  falloff) and the panels' fire rate, ammo, reload, bullet velocity, regen, move speed, stamina,
  CDR, lifesteal and the Spirit Power Impact rows need calculator rules (and hero weapon data
  from `heroes.vdata` `m_mapStartingStats` / weapon info). The panels show only the five stats
  mapcro calculates.
- **Tier cards' ability-point cost**: hard-coded 1 / 2 / 5 (operator, 2026-11-11); if the game's
  own source turns up, read it instead (and see "To verify in the running game").
- **Pin a tooltip open**: not now (operator, 2026-11-11).
- **Live values in the tooltip**: the remaining cooldown and charges at t are on the icon only;
  the game's tooltip shows the static value.
- **Hero panel for followers**: the panel is local; a presenter opening one isn't followed.
- **Spirit-scaled values on items**: only abilities' cards take the calculated spirit power with
  "≈"; items' scaled properties show the base value.

## A macOS desktop app (2026-11-11, operator: only if users ask)

Parked. Deadlock has no macOS client, so the app's job (the local replays folder, previews, local
parse) has nothing to work on; Mac users get the full site in Safari/Chrome (the WebKit e2e pass
covers Safari's engine). If users ask: GitHub's macOS runners can build a `.dmg` and run unit tests
without a Mac, but `tauri-driver` doesn't support WKWebView (no smoke test), and unsigned apps are
blocked by Gatekeeper ("damaged" on Apple silicon), so a usable build needs the Apple Developer
Program ($99/yr) and notarization per release, plus a real Mac for the first check. Niche case:
CrossOver/Whisky players have replays inside the Wine bottle; the app could look there.
Research: docs/research/desktop-app.md.

## Follow a hero's token with the camera (2026-11-11, feedback #16; operator: after the tooltips)

Keep the map centred on a chosen hero while zooming freely: start from a double-click on the
hero's top-bar portrait or minimap token, or a hotkey over a hovered token/portrait; stop on pan
or Escape. Needs a camera model (the map doesn't pan to follow today) and a decision on how it
interacts with presenter follow (followers' cameras already mirror the presenter's).

## Demo previews: the rest (2026-11-11, from demo-preview)

The app reads each card's preview from the demo (spec §6a "Read from the demo first";
docs/research/demo-preview.md). Left over:

- **Drop the server preview?** The app falls back to `GET /api/matches/{id}/preview` only when its
  own read fails (a broken file, an older app). Once every app in the field has `replay_preview`,
  the route serves no one: retire it with its cache (TD-17), or keep it for a browser picker.
- **Old maps on cards:** a pre-6712 demo previews fine (6683 and 6701 read), but picking it fails
  as `old_map`. The card could say "Older map" from `build` before the pick.
- **The match's time on a card** (operator, 2026-11-11: "Played 2 d ago", not the file's time):
  the demo has no wall-clock start (research demo-preview, `start_time`), so a card read locally
  shows the file's time ("Downloaded" on hover). Options: ask the server for the time only where
  it's free (a cached summary), or estimate it from the match id (ids rise over time, a fit
  from known pairs). Needs the operator's call.
- **A Windows cold-cache timing**: measured on Linux only (0.05–0.56 s, page cache warm or not on a
  shared box). A first listing of ten 500 MB demos on a spinning disk is ~100–200 MB of reads.
- **Previews ahead of view:** cards read one at a time as they scroll in; the next page's could be
  read while the picker is idle.

## Follow: what a follower still doesn't share (2026-11-11, from follow-sync)

Following now carries the map layers and the open panels (death recaps, builds; spec §8). Held:
- **Effects and Build order inside a hero's build:** the follower opens the same hero's build,
  but which of the two popovers is open (or none) is its own. Small: two more bits in `playback`.
- **The events list's filters, search and scroll.** A follower pings from its own filters, so
  its pings can differ from the presenter's, and an events-row recap the presenter opens stays
  closed on a follower whose filters hide that row. Sharing filters changes what the follower's
  list shows; worth asking the operator whether that is wanted.
- **The events list doesn't scroll to a recap the presenter opens.** It opens in place; the list
  follows "Now" as before, so an older death's recap may open out of view.
- **The teleporter pair's line** (below, "A follower doesn't see the presenter's teleporter pair").
- **Sidebar tab (Events or Notes), the Layers popover being open, and the side panels on the
  phone:** layout, left each person's own.

## Previews of matches cached before acf63c3 have no winner (2026-11-11, lead, prod check)

## Previews of matches cached before acf63c3 have no winner (2026-11-11, lead, prod check): resolved

Resolved 2026-11-11 (branch `server-debt`, 6064363): the summary cache is stamped `summary_format`; an unstamped one without a winner is derived again from one metadata read, once a process, and a card with `winner: null` is made again from the summary (spec §6a, Previews).

`GET /api/matches/129738985/preview` on prod answers `"winner": null`: the summary was cached
before the summary kept the winner, and the preview is derived from that cache. Kills and souls
are there. Either re-derive the summary when a cached one lacks `winner` (one metadata read, the
same rate-limited path), or stamp the summary cache with a version like the timeline's `format`.

## To verify in the running game (2026-11-10, operator: "keep track of what needs to be verified")

The operator may later let an agent look at the running game. Until then, one list, in one place,
of claims only the game (or its client) can settle. Add to it; strike items once checked.

- **Stat calculator** (shipped on branch `stat-calc-prod`, docs/research/stat-calc-spike.md "Open questions"):
  - The Spirit panel rounds rather than ceils: a sandbox value with a fractional part near .3–.5.
  - Bullet and Spirit Resilience count toward resist (their property has no modifier binding).
  - Battle Vest's resist under and over 65% health.
  - The 22:30 Tab-scoreboard reference: if its match id or replay is known, it is resist ground
    truth for 12 builds.
- **Replays folder** (spec §6b; docs/research/desktop-app.md):
  - Whether watching a match in the client writes `<match id>.dem` without a separate download,
    and whether it is written in place (a partial file while downloading; the 5 s wait is a guess).
  - On Windows: the default folder path and that `steamlocate` finds it.
  - In real Chrome with a second Steam library: the folder picker, "Allow on every visit", and the
    blocklist refusal on the default folder.
- **Tab scoreboard investment bars:** how the game fills them (the scoreboard's HUD source isn't
  in the pack). The 22:30 reference shows partial fills at 16–24k net worth, which fits filling
  along the investment ladder's breakpoints; confirm with a hero near and past a breakpoint.
  Implemented rule (spec §6b "Calculated stats"): each ladder row takes its `flPercentOnGraph`
  share and fills linearly from the row below; full only at 28.8K. Also check what counts as
  spent: we count each owned item's tier price (not sold items, not components used up by an
  upgrade, not what was paid after an upgrade discount).
- **Ability tier costs:** the tooltip's tier cards show 1 / 2 / 5 ability points, hard-coded
  (`web/src/match/tooltips.ts` `TIER_COSTS`, from `item-djinns-mark.png`; no file holds them).
  Check after a patch that touches ability upgrades that the game still shows these.
- **HUD:** the kill-streak threshold that switches the souls tab to the mint `.KillStreak` style,
  and when the gloat card portrait appears (backlog "Kill-streak mint souls tab").

## Client-parsed timelines: follow-ups (2026-11-10, from client-timeline)

`POST …/timeline` (spec §6a, "Timelines parsed on the user's machine") is server-only so far.
- Player's source line says "Replay: uploaded" for a client timeline; the status carries
  `client: true` (and the timeline `source: "client"`) for a "parsed on your machine" label.
- `matches_opened{path}` counts a client timeline as `uploaded`, and `just stats funnel --path`
  has no `client`; `replay_jobs{source=client}` is the only place it shows apart.
- A board's stale client timeline is marked `stale` like an upload's, so Player offers "Upload
  replay file"; for a desktop user, re-parsing locally would be the better offer.
- zstd bodies aren't accepted (gzip only); add one if the wasm parse prefers it.

## Label sweep (2026-11-10, from stat-calc-prod; spec §4b): resolved

Resolved 2026-11-11 (branch `web-polish`): the top bar's Rejuvenator ("Hidden King Rejuvenator";
aria "…, 2 revives"), portrait ("Abrams build"), vision mark ("Not seen"), focus button ("Inspect
Abrams"), respawn and health aria ("Amber 1 respawn, 12 s"), the transport's and Map layers'
explanatory hovers (dropped where they repeated the label), the Vision and Last seen hovers, the
build order rows, the replays-folder and landing hovers, "Play from here", the skull's recap and
the board top bar's aria-labels. `web/test/labels.test.ts` fails on any literal `title` or
`aria-label` in `web/src` over four words (a key hint in parentheses and a value after a comma
don't count) or written as a sentence. Left on purpose: the map markers' timer hovers ("Respawns
in 1:20 · …", spec §6b) and the tier chip's hint (it explains what the summary lacks; spec §6b
"tap or hover the summary"), which the operator may want shortened.

## Calculated stats: follow-ups (2026-11-10, from stat-calc-prod)

- **A quiet "≈" on calculated values** (spec §4b rule 5): approved and shipped (topbar.css).
- **Stat panels** (the tooltips plan's part 2): shipped with the ladder and the five calculated
  stats (branch `tooltips`); the other panel stats are in "Tooltips: follow-ups".
- **Stacking items** (Berserker, Cultist Sacrifice, Escalating Resilience …) from `effects`
  stack counts, and Spirit Snatch's stolen values from the stat viewer: later rules, the spike's
  largest remaining misses.
- **Refresh the pack's tables after each patch**: `just stat-data <dir>`, re-extract with
  `--stat-data`, then `just stat-check` on one fresh match's metadata (one free deadlock-api read).
- **Pickups in the metadata timeline**: the API tier has `power_up_buffs`; `matches.rs` doesn't
  pass them on, so API-tier timelines have no `level`/`pickups` and show "—".

## Windows app: follow-ups (2026-11-10, desktop-app)

These were left out of the first cut of `desktop/` (desktop/README.md), and are ordered by how
much they matter.
- **First Windows run.** Nothing has been built or run on Windows yet. The `desktop.yml` CI
  job is the first build. Then check by hand:
  - WebView2 renders Player as Chromium does;
  - the registry lookup works;
  - the replay picker: the folder is found, a download in progress is left out until it settles
    (whether the game writes the `.dem` in place or renames it in; the 5 s is a guess), and
    Change folder's chooser opens over the window and is kept across runs;
  - the passive update path works end to end.
- **Picker follow-ups (2026-11-10, replay-picker).** Held out of the first cut:
  - **Back to Steam's folder.** After Change folder there's no "use the default" action: the
    chosen folder wins while it exists (choose Steam's folder again, or delete
    `replays-folder.txt` in the app's config folder).
  - **The browser's linked folder in the picker** (Chromium, second Steam libraries): the seam
    is there (`ReplaySource`); the operator kept browsers unchanged for now.
  - **A file still downloading** isn't listed; a "Downloading" card could show it instead.
- **Memory cap for the parse child.** A Windows Job object (`JOB_OBJECT_LIMIT_PROCESS_MEMORY`)
  would be like the worker's 384M cgroup. Today the child has only a time limit and runs at low
  priority.
- **Big fallback reads.** `replay_read` hands the page the whole `.dem` over IPC (up to 1 GiB
  in memory). It matters only while the server lacks the timeline route; drop it once that's
  deployed everywhere.
- **Authenticode signing**, when SmartScreen warnings cost users (research §1: Azure Artifact
  Signing ~$10/month, US/Canada individuals).
- **Linux build:** built (branch `linux-desktop`: `just e2e-webkit`, `.#mapcro-desktop`, the
  AppImage and .deb in `desktop.yml`, the WebDriver smoke test). Left:
  - **First Linux run on a real desktop** (only Xvfb so far): GNOME and KDE, the folder chooser,
    a real Steam install, Wayland and X11, an NVIDIA machine (does the DMA-BUF blank window
    happen, and does `WEBKIT_DISABLE_DMABUF_RENDERER=1` fix it).
  - **NVIDIA workaround in the AppImage/.deb.** Only the nix wrapper sets it. In the app it is
    `std::env::set_var` before the webview, which is `unsafe` under edition 2024 and the crate
    forbids `unsafe`; a launcher script in the bundle is the other way. Decide after the real run.
  - **WebKit frame cost.** Headless WebKit drew a scene flip at ~10 fps (Chromium ~30), so the
    heroes-live glide spec is fixme on WebKit. Measure Player at 8× in the real app before calling
    it slow.
  - **Download link for Linux.** "Get the Windows app" shows on Windows only; a Linux link
    (AppImage) would need a label and a release flag like `WINDOWS_APP_RELEASED`.
  - **WebKit in CI.** `just e2e-webkit` is opt-in and local; the main CI runs no e2e at all.
- **Portable build (2026-11-11, deep-links; desktop/README.md, Installer or portable).** Left:
  - **First tagged release:** the release job's portable step (`cargo tauri build --no-bundle
    --features portable`, `gh release upload` into the draft) has not run yet; check the draft
    has `mapcro_<v>_x64-portable.zip`, `mapcro_x64-portable.zip` and `mapcro_x64-setup.exe`.
  - **By hand on Windows:** unzip and run; a board's Open in app reaches it; Update available
    shows against an older copy and opens the release page in the browser.
  - **A moved or deleted portable copy** leaves `HKCU\Software\Classes\mapcro` pointing at it
    until another copy or the installer runs.
- **Board links (2026-11-11, deep-links; desktop/README.md, Deep links).** Built: `mapcro://`
  registration, the hand-off to the running app, Open in app, Open link and Ctrl+L. Left:
  - **Check on Windows by hand:** a browser's "Open in app" asks to open mapcro and the app
    opens the board, cold and running; the NSIS uninstaller removes `HKCU\Software\Classes\mapcro`.
  - **Check on a real Linux desktop:** clicking a `mapcro://` link in Firefox and Chrome with
    the .deb installed, and with an AppImage (its self-registration writes a desktop file in
    `~/.local/share/applications` on every start).
  - **Open in app on Linux browsers,** with the Linux download link (above): the same gate.
  - **Open in app when the app isn't installed** does nothing visible (the browser drops an
    unknown scheme); a quiet "Get the app" sits beside it (operator, 2026-11-11). Detecting
    the missing handler (blur/visibility timing) isn't done.

## The salts backoff holds back free reads (2026-11-10, from salts-docs): resolved

Resolved 2026-11-11 (branch `server-debt`, aaf90b1; TD-9): the free read goes first and a 429 holds back only the Steam-capable read of a no-row match; the 400 is `no_replay`; a match before the ~2 h salts pass is held until it (spec §6a, Remembered failures and Pacing).

deadlock-api answers a stored salts row before its rate limiter, so only a lookup of a match with
no row spends its 3/h Steam budget (docs/research/deadlock-api-salts.md "When the backend asks the
GC"). Our handling is broader than that, in `crates/server/src/replays.rs`; logged, not changed:

- A 429 sets one backoff for every fetch (`back_off`, `limited`), though reads of matches it
  holds would still succeed for free. A per-match "no row, limited" mark would let those through.
- The free 400 "won't be fetched, as it has metadata already" falls into `upstream_down` and the
  6 h negative cache. It means Steam won't be asked for this match: `no_replay` says it better.
- A row without `replay_salt` is `no_replay` for 6 h (`NEGATIVE_FOR`), but the share with a salt
  grows from about 10% at 1 h to 42% at 2 h (salts "Results"), so a match opened at 30 min isn't
  tried on open again until well after its salt likely arrived. Fetch replay still goes past it.

## Replays folder: follow-ups (2026-11-10, replay-watch)

The linked replays folder (spec §6b) works only for a second Steam library (Chromium's blocklist).
- A desktop bridge for default installs would plug in as another `ReplaySource`
  (`web/src/player/folder.ts`).
- Check in a real Chrome with a real second library: the picker, the "Allow on every visit"
  prompt, and whether the game writes a partial `.dem` while downloading (the 5 s wait is a
  guess).
- The landing page has no folder offer; Player's "Recent replays" covers a board with no match.

## Build the data retention policy, raise caps, cheap storage (2026-11-10, operator: when the limits call for it)

The policy is agreed (architecture-design.md §9a): idle boards expire at 180 days, replay
timelines and metadata 90 days after last opened, journald 30 days, a privacy note. Build it, and
work out cheap bulk storage (e.g. object storage for timelines and board snapshots) so the caps
can rise, when the prod watcher opens a `plan:<limit>` alert (60% of a cap, or the cap within 30
days at the 7-day trend). Gaps found while wiring that alert:
- `stats limits` shows no cap for the replay cache (deploy.md says 1 GiB) or the match cache, so
  neither can alert. Report their caps.
- `memory, server` peaked at 268.2 MB of its 268.4 MB cap in the 7 days to 2026-11-11, with no
  OOM kill (likely reclaimable page cache counted in the cgroup). Confirm what it was before
  raising the limit.

## Several replays on one board, as game tabs (2026-11-10, operator)

A multi-game review (series, scrim block) on one board and one URL: a strip of game tabs under the
header selects the replay; its timeline, events and scenes follow. Design sketch (clickable):
`/home/intendednull/concierge/artifacts/mapcro-multi-replay/index.html`.
- Exists: the board's attached-match list (`web/src/player/host.ts` `matches`) and each scene's
  `source.match_id`, so scenes per game is a filter, not a migration.
- New: tab order and display names; `?game=<match>` deep link; per-game remembered UI state
  (time, paused, vision, layers); an LRU of loaded timelines (a long one is ~6 MiB); a
  Whiteboard tab for scenes with no match; follow/presence carries the presenter's game;
  per-tab replay-job status (fresh games queue behind the 3/hour lookup limit).
- Open: removing a game that has scenes (delete them, keep as frozen snapshots, or refuse);
  per-game notes; a cap (10?). Later: cross-game build comparison, series scoreline.

## UX follow-ups from the Argon and Sol passes (2026-11-10, operator approved the first batch)

First batch, one agent after the prototype deploys: (1) per-hero build-order list in the single-hero
dropdown, click a buy to seek; (2) open the death recap from the map skull; (4) souls-leader
highlight on the souls tab (the HUD's mint `#90FFE3`); (5) Save scene keeps drawings visible and
shows "Saved · Switch to scene" (check the Argon bug "Save scene makes live drawings vanish"
first); (9) dialog focus trapping, Escape, focus return (Share, Join, Clone, hero picker).

First batch done 2026-11-10 (branch `ux-batch-1`), except (4):
- (1) Build order: a popover beside Effects in the single-hero dropdown (`player/BuildOrder.tsx`,
  `match/builds.ts` `buildOrder`). It lists each buy, sale and upgrade with the pack's icon and
  time, folds an upgrade's used-up components into its buy, and dims rows after t. A row seeks
  there. Effects and Build order open one at a time.
- (2) With the Move tool, a skull whose death has a recap opens it in a card on the map
  (`player/SkullRecap.tsx`). Skulls follow the vision rules as before, and the card closes when
  the Vision's team didn't see the death (`skulls.ts` `deathShown`).
- (4) Dropped by the lead: the mint is the HUD's kill streak, not a leader. See "Kill-streak
  mint souls tab".
- (5) Saving still shows the new scene with the drawings in it, and a toast now says "Saved
  scene N" with a "Back to replay" action. The Argon bug didn't reproduce on main (below).
- (9) One modal contract for every dialog (`ui/modal.ts`, `ui/ModalScrim.tsx`).
- Also fixed: an effect with an internal name takes its parent ability's or item's name in the
  Effects list (`player/effects.ts`).
Later: (3) "ACTIVE" badge on active items (with the tooltip extraction, plan
`docs/plans/2026-11-10-game-tooltips.md`); (6) "Play with scene plan" (scene drawings over the
live replay); (7) remaining-time sweep on the CC label; (8) a Remove-replay action on the
open-match form; (10) tablet layout: sidebars as drawers below ~1024 px. Reproduce on the
prototype before fixing: the two-tab disconnect loop, Save scene clipped at 1280 px, scene save
ignoring team vision, scene hover preview over portraits, Feedback missing match info from a scene.
The passes' branches (`argon-ux`, `ux-pass-2`) are kept, not merged.

## Kill-streak mint souls tab (HUD .KillStreak) (2026-11-10, from ux-batch-1)

The mint souls tab is the game's kill-streak state, not a networth leader's. In the 6860 pack's
`hud/citadel_hud_top_bar.vcss`, `.KillStreak .SoulsValueContainer{background-color: #90FFE3;}`
and `.KillStreak .SoulsValue{wash-color: offBlack;}` (offBlack `#10130D`, citadel_base_styles);
`hud/hero_badge.vcss` washes the portrait the same mint (`CitadelHudTopBarPlayer.KillStreak
CitadelHeroBadge .HeroImageBackground`), and `.KillStreak #KillStreakContainer` shows the streak
particles and `#kill_hype_KillStreak_count` (citadel_hud_top_bar_player.vxml). The Argon pass
(`concierge/artifacts/mapcro-ux-argon/NOTES.md` §134) called it a "leader highlight", and the
first UX batch asked for a networth-leader rule with `#09221B` text. Neither comes from the
HUD: no rule mentions a leader, and `#09221B` appears nowhere in the pack. The lead dropped
the leader version (2026-11-10).

Still possible: a streak can be derived from the recorded `kills` series and `deaths` (kills
since the last death). What's missing is the game's threshold for the class. No panorama script
in the pack sets it (the top-bar layouts have no `<scripts>`; `CitadelHudTopBarPlayer` is a
native panel, so code sets the class). The extractor would need to look in `panorama/scripts`
and the `kill_hype_*` localisation (citadel_gc / hud english strings). Don't guess the threshold.

The whole streak look (the lead's check, 2026-11-10; backlog only, not built):
- **Gloat card.** heroes.vdata has `m_strIconHeroCardGloat` (`heroes/<name>_card_gloat.psd`) for
  45 of 64 heroes. The extractor takes only `m_strIconHeroCard` and `m_strIconHeroCardCritical`
  (`crates/extract/src/heroes.rs`), so the pack has no gloat card. No vcss references it, so code
  swaps it in. We don't know when.
- **While on a streak** (`CitadelHudTopBarPlayer.KillStreak`, citadel_hud_top_bar.vcss and
  citadel_hud_top_bar_player.vxml): `.HeroImageBackground` turns mint `#90FFE3`; the souls tab
  turns mint with offBlack text; `#KillStreakContainer` shows at 0.25 opacity with the particle
  `particles/ui/ui_topbar_killstreak_stylized.vpcf`.
- **At the trigger** (`.TriggerKillStreak`): the container goes to full opacity and
  `#KillStreakText` plays the 1 s `KillStreakTextIn` animation. It holds the count
  (`#kill_hype_KillStreak_count`, `.KillStreakNum` in `#25FFAF`) and the label
  (`#kill_hype_KillStreak`, localised), or First Blood (`#kill_hype_FirstBlood`, with
  `.IsFirstBlood`).
- **The threshold** is set in code and still unknown. An operator screenshot of a streak would
  confirm it.

## The death recap shows internal ability names (2026-11-10, from ux-batch-1): resolved

Resolved 2026-11-11 (branch `web-polish`): `player/recap.ts` `recapAbility` uses the parent's name, else "Weapon" or "Ability"; never the engine name.


The recap's hit rows (`player/DeathRecap.tsx`) print `record.label` as it is, so a record whose
`label_from` is `"internal"` reads as the engine name. In 129738985, Infernus's death at 6:45
lists "deadpack_primary_weapon_charge" under Deadman Danny. The Effects list now falls back to
the parent ability's or item's name (`player/effects.ts` `effectLabel`). The recap could share
that fallback.

## A death and its recap can be a second apart (2026-11-10, from ux-batch-1): resolved

Resolved 2026-11-11 (branch `web-polish`): `recapOf` takes the latest lethal hit up to 1.5 s before the death's second. Amber 1's recap at 2545 s with no death stays unpaired (a revive in place, or past the parse's end).


`recapOf` (player/recap.ts) pairs a death with the recap whose `ceil(t / 10)` equals the death's
second exactly. In 129738985, Amber 3's death at 521 s has a recap at 520 s, so neither the
events list nor its skull offers that recap. Amber 1 also has a recap at 2545 s with no death in
`deaths`. Pairing within a second, or the extractor writing both from one tick, would fix it.

## Sixteen e2e tests act on controls the prototype moved into disclosures (2026-11-10, from scene-parity): resolved

Resolved 2026-11-10 (branch `proto-e2e-fix`). The sixteen were a sample: 46 specs acted on the
match source's controls (`match-id`, `match-load`, `match-upload`, `mode-sandbox`…), the Map
layers toggles or the scene note while the prototype keeps them closed. `revealControls`
(e2e/helpers.ts) now knows each control's place (source disclosure, Map layers, Scene Notes tab),
throws for one it doesn't, and every spec reveals before it acts; each disclosure closes on a
press outside it, so a reveal goes before each use. player-visible's top-bar test and pack's
"terrain, markers and portraits" failed on the base for the same cause (`match-id`,
`crates-toggle` hidden), not another; both pass 4 of 4 repeated.

The specs also follow the prototype's deliberate changes (journal 2026-11-10-prototype-controls):
saving a replay scene shows it (a second save goes Back first), no scene is current in the tree
while watching, the heals toggle is "Healing pickups", the play title is static, and a format-7
timeline's death recap shows in the events list (player-format7 allows exactly that line).

App fixes the run turned up: the phone had lost the tier chip (moved to the desktop header only;
now in the phone header too, its role chip ellipsised so the page doesn't overflow); the source
popover opened under the replay prompt's map scrim, so Scenes, Load and Upload couldn't be
pressed while the prompt was up (now above it); the layer toggles' ○/✓ marks were read into
their accessible names (CSS alt text drops them).

Left for the operator: the phone's source summary clips "Match <id>" at its left edge; with no
match loaded an editor's Player shows a closed "Match source" rather than the id field, and the
Scenes button lives inside that disclosure.

## Scenes' stage head repeats what the bar and the list show (2026-11-10, from scene-parity)

In Scenes the stage head ("Scene 2 of 2 · 5:00 Match moment", Board.tsx `.stage-head`) sits above
the top bar, so the bar and map sit ~28 px lower than in replay, the one layout difference left
between the modes. Its clock editor repeats the bar's (`tb-clock`), its name editor the scene
list's, and the player bar's scene row says "Scene “…” · 5:00" again. Dropping it (or folding the
name editor into the scene row) would finish the parity, but `scene-name` / `scene-clock` are
used by six e2e specs (scenes, scene-names, scene-tree, topbar, phone, player-review) and the
phone layout. Needs the operator's call on where a scene's name is edited.

## The scene's Rename… editor opens empty for a match's name (2026-11-10, from scene-parity)

With no typed name, the slot's name editor opens empty: `InlineEdit` gives its input no
placeholder, so the match's name ("Coach") is not shown while typing. A `placeholder` on the input
would help here, but it changes every inline editor (scene names would show "Scene 2").

## Fill the in-game scoreboard's missing values (2026-11-10, operator)

The topbar UX worktree now follows the operator's in-game scoreboard reference. Keep the
remaining data work separate from visual refinement; unavailable values display as “—”.

- **Hero level over time.** The timeline's ability levels are unlock/upgrade tiers, not hero
  level. Capture the real level changes for the portrait's circular level badge.
- **Kills and assists over time.** Deaths are already recorded. Death-event killer attribution
  is optional and the current sample lacks it, so it cannot produce exact kill totals or the
  center team-kill counters. Capture authoritative killer and assist credit; damage recaps are
  not assist credit. Preserve a distinction between a true zero and unavailable data.
- **Maximum HP and bullet/spirit resistance over time.** Current health is only a percentage.
  Capture the actual scoreboard values, including changes due to items, upgrades and effects;
  do not reverse-engineer them from health percentage or today's shop stats.
- **Weapon / Spirit / Vitality bar progression.** Verify and capture the game's category
  progression/tier values. The current UI labels its bars as equipped-item value at current
  catalog prices; that is not verified as the game's progression formula.
- **Active-item designation.** The reference marks active items. Add authoritative item metadata
  to the pack; absence of a recorded cast does not establish that an item is passive.

**Update (2026-11-10, prototype-data; implementation authorized separately by operator):**
Format 8 now records actual controller hero level, player kills, assists, and pawn maximum HP
at 1 Hz as optional sparse changes with explicit unknown gaps. Standard replay 129738985
verified all 12 players: levels 1–45, maximum HP 690–4560, final totals 74 kills / 134 assists;
74 kills match 74 deaths. The API-summary tier remains unavailable. See
[scoreboard-values.md](research/scoreboard-values.md) for exact sources and cache policy.
Resistance totals, category progression and active-item designation remain open; no inferred
values were added. The bounded controller/pawn field census found no direct named resistance
or category progression values. A matching-build authoritative HUD/formula audit is still
needed, including temporary effects; modifier contributions alone do not establish totals.

**Update (2026-11-10, proto-resist):** No recorded source exists for bullet or spirit resistance.
Across replay 129738985's 929 networked classes, the only resist field is an item counter. The
controller's stat viewer holds just permanent statue pickups and Spirit Snatch stacks; item armor
and hero base values never appear there. Neither the modifier table nor any user message
carries a resist value. The HUD calculates resistance from modifiers and vdata. That calculation
needs a build-matched catalog (6839 for this replay; we hold 6860) and operator sign-off, because
it would be a calculated value, not a recorded one. The UI stays "—". Details in
[scoreboard-values.md](research/scoreboard-values.md#bullet-and-spirit-resistance-no-recorded-source-2026-11-10-proto-resist).

Audit the demo/controller properties and metadata payload before choosing sources. Keep times,
units, missing-data behavior and replay/API-summary coverage explicit. Any persisted timeline
addition needs the format/cache-upgrade policy, focused boundary tests, and verification on
standard 6v6 replay 129738985. No extraction implementation is authorized by this backlog entry.

## Bugs the Argon UX pass reported, unverified (2026-11-10, from argon-ux)

Gemini 4 Argon reported these while exploring prod for its design pass
(`concierge/artifacts/mapcro-ux-argon/NOTES.md` §5). None has been reproduced yet. Check each one
before fixing it.
1. **Two tabs in one browser evict each other.** Both tabs load the same `client` id from
   IndexedDB, and each reconnect kicks the other off, so they loop Offline ↔ Saved. Check whether
   this is real: the tabs may share the id by design.
2. **Save scene in Player makes the live drawings vanish.** `onSaved` moves the live scene's
   records into the new scene, and `setScene` marks it active in the tree, but the stage stays in
   Player and shows the now-empty live scene (`Board.tsx` `onSaved`, `Player.tsx` `saveOne`).
   *Not reproduced on main (2026-11-10, ux-batch-1).* `onSaved` is `pickScene`, which leaves
   Player for the new scene, so the moved drawing shows there. player-handoff's
   `boardWithScene` asserts it. A "Saved scene N · Back to replay" toast now says what happened.
3. **At 1280×800 with both sidebars open, Save scene is clipped** (`.pl-tail` doesn't wrap and
   `.stage` hides the overflow), and Redo wraps onto a row of its own. The UX pass proposes moving
   the map toggles to a Layers control, which would fix this.
4. **Names disappear in a scene saved from the match.** This may be stale: a3a35b5 made scenes take
   the match's names. Also, there is no Names toggle in a scene.
5. **A scene saved under a team Vision shows every hero.** `matchSceneOps` (`match/save.ts`) sets
   `visible: true` for all of them, so unseen enemies appear in the scene.
6. **The scene-row hover thumbnail covers the first two portraits** in the top bar
   (`SceneThumb`).
7. **The dialogs don't hold focus.** This is the same as "The other dialogs don't hold the focus",
   below. *Resolved 2026-11-10 (ux-batch-1).*
8. **Feedback offers no match while you're viewing a scene saved from a match.**
   `feedbackMatchOf` only reads Player; the scene's `source` has the match id and time.

## Three modifiers on heroes have no name in the pack (2026-11-10, from pack-abilities)

The names table resolves 476 of the 479 modifiers seen on heroes in 129738985, and 707 of the
711 on any entity. Six engine modifiers that no vdata defines are listed by name in
`abilities::ENGINE_MODIFIERS`, among them `modifier_citadel_tossup` and `modifier_player_pinged`.
The other 3 are engine modifiers too, and we don't know their names: tokens 2332482372,
2693099904 and 3959802243 (on any entity, 2072993276 as well). Hashing a candidate name list
against those tokens would find them; boon-data's catalog has them from `client_strings.txt`.
A patch that adds an engine modifier needs the list extended by hand.

## Icons the pack leaves out (2026-11-10, from pack-abilities)

The pack carries icons for items still in the shop, playable heroes' four signature abilities and
modifiers with a HUD icon (spec §12). It leaves out:
- disabled items (74 with an image);
- unreleased heroes' abilities;
- weapon, melee and innate abilities;
- NPC abilities;
- HUD images outside the allow-list's four folders (one is `hud/crosshair/…`).

A replay from an older patch that has a since-disabled item shows it without an icon. Widening
`abilities::wants_icon` is a one-line change; it adds about 1 MB.

## Fallback labels keep their underscores (2026-11-10, from pack-abilities)

A record with no localised name gets its internal name with the prefix stripped
(`label_from: internal`, for example `citadel_knockdown`), as abilities-and-items.md §3 says.
821 of the 2,061 modifiers end up there. Whether the UI shows those at all, or turns `_` into
spaces, waits on the build-card UX.

## Clippy fails on engine and server under rust 1.99 (2026-11-10, from pack-abilities): resolved

Resolved 2026-11-11 (branch `server-debt`, 749182e; TD-1): the workspace is clippy-clean and `just clippy` gates it in `just check` and CI.

`cargo clippy --workspace --all-targets -- -D warnings` (nix dev shell, rust 1.99.1) stops before
it reaches most crates:
- `large_enum_variant` on `WireIn` (crates/engine/src/wire.rs:32) and on `RoomCmd`
  (crates/server/src/room.rs:48);
- `unwrap_used` in wire.rs's tests (lines 377–385);
- the replay and packs.rs entries below.

All of these are on main 38d8a5a, untouched by pack-abilities. `mapcro-extract` is clippy-clean.
`cargo fmt --check` also reports about 1,500 diffs on main, so the gate's fmt step can't pass as
written either.

## The dev-warnings e2e picks Vite's port the old way (2026-11-09, from web-test-ports)

web/e2e/solid-dev-warnings.spec.ts listens on 0, closes, and starts Vite on that port with
`--port` (no `--strictPort`), then polls `${base}/healthz`. If the port is taken in between, Vite
quietly moves to the next free one, so `base` and the server's `PUBLIC_ORIGIN` name a port that is
not Vite's: the poll times out ("vite never came up") or reaches someone else's server. The
mapcro-server half of that spec now starts on a port of its own (web/test/support/server.ts);
Vite's half could pass `--strictPort` (fail rather than move) and retry on a fresh port, or start
Vite through its JS API and use the address it actually bound.

## Check the API's item ids against a demo (2026-11-09, from match-data-v7)

Format 7 reads the metadata's `items[]` into `items` and `abilities` (spec §6a) on the guess that
`item_id` is the demo's CUtlStringToken and that an entry carrying `upgrade_info` is an ability.
No untrimmed metadata payload is cached locally and the fixture is trimmed, so neither is
checked. One untrimmed response for a match we have the demo of (129738985) settles both; a
wrong guess means re-fetching the summary-tier matches cached since.

## The modifier token lists go stale with patches (2026-11-09, from match-data-v7)

`crates/replay/src/modifiers.rs` (the icon-shown modifiers and the CC modifiers) is generated from
boon-data's catalog for client 6860 by `tools/modifier-tokens/gen.py`. A modifier a later patch
adds isn't stored as an effect, and it can't be recovered without a re-parse. Regenerate per
patch, or have the worker read the list from the pack once the extractor reads
`modifiers.vdata` and `abilities.vdata` (the names-and-icons task).

**Update (2026-11-10, pack-abilities):** the pack's names table now has what gen.py reads from
boon-data, for 2,067 modifiers: `icon_class` and a HUD icon for `ICON_MODIFIERS`, and the
enabled-state mask's names (`states`) for `CC_MODIFIERS`. gen.py could read `data/abilities.json`
instead. The CC bits still need the state name → index map (boon-data's `modifier_states`), and no
vdata holds it, so the 9 `CC_STATES` would be vendored by name. The generic CC list by hand stays
as it is. Two caveats:
- The pack is only on the operator's machine, so regenerating stays a local step.
- The pack's `icon` is set only where the HUD icon file is under the allow-list. Read
  `icon_class`, and a non-empty `m_strHudIcon` if gen.py needs it exactly, which would mean
  keeping the raw path in the table.

## Format 7 costs 3.4 s of parse time (2026-11-09, from match-data-v7)

On 129738985 the worker went from 8.7 s to 12.1 s (release, `nice -n 10`, load 8–9). Most of it isn't
the new reads (`HeroTracker::tick` is ~7% of the profile): it's decoding the ~570 ability and
item classes, plus every per-tick walk over all entities (`urn_tick`, `heal_tick`, `buff_tick`,
`vision_tick`) now walking those entities too. Indexing each class's entities once per tick
would win most of it back.

## Casts without a cooldown end, and allies' CC (2026-11-09, from match-data-v7)

On 129738985, 120 of 2227 casts have no `cooldown_end` (the ability entity's cooldown didn't move
within 1.5 s: charge abilities with charges left, or items bought that second). Separately, CC
sources are inferred from enemy applications only, so Viscous's cube on a teammate (8 of 18
cube intervals attributed) has no source. Both are worth a look before cooldowns or CC are shown.

## Under Vision, a death ping marks a death the skull hides (2026-11-09, from death-skull)

Death skulls (spec §6b) follow Vision: in a team's view an enemy's death it didn't see draws no
skull. The event pings stay omniscient by the operator's call ("Vision leaves the rest of Player
omniscient", below), so while playing, that same unseen death still gets its team-coloured ping
ring on the spot, the very cue the skull withholds. Worth asking the operator whether death pings
(and the jump ring) should take the skull's rule (`player/skulls.ts` `deathSeen`) in a team's
view; the events list could stay as it is.

## A malformed feedback `match` gets the generic 400 (2026-11-09, from feedback-match)

`POST /api/feedback` refuses a `match` whose fields are the wrong JSON type (a numeric id, a
negative or fractional `t_s`, a missing `tier`) at deserialisation, so the answer is the generic
"expected a title and a description" rather than "the match details aren't valid", which only
well-typed but invalid values get. Only a client other than ours can send those shapes; parsing
`match` as a raw value and checking it by hand would give one message for both.

## clippy: `unwrap()` in packs.rs (2026-11-09, from feedback-match): resolved

Resolved 2026-11-11 (branch `server-debt`, 749182e; TD-1): the workspace is clippy-clean and `just clippy` gates it in `just check` and CI.

`cargo clippy -p mapcro-server --all-targets` warns `clippy::unwrap_used` at
crates/server/src/packs.rs:188 (`p.0.parse().unwrap()` in `newest_first`). Already on main; an
`expect` with a reason would quiet it.

## Why one tough crate took 300 s to come back (2026-11-09, from heavy-crates)

On 129738985, 231 of 232 tough crate breaks are back 180 s later; `tough_crate:neutral:lane1:18`
(-6033, -3520), broken at 815.9 s, was back at 1115.9 s. The timeline keeps the real back time,
so Player is right; only a break the recording ends inside is assumed back on 180 s. Worth a look
on a second replay: a hero standing on the spot, or a longer timer for some spots.

## Wooden crates and item containers (2026-11-09, from heavy-crates)

Their breaks are as observable as the tough crates' (the entity goes inactive; the subclass
token tells them apart). 591 more icons and about 8 times the Heavy boxes' timeline bytes, so a
toggle of their own at least. Not asked for; the audit's candidates list has the row.

## heal_probe is slow on the breakable props (2026-11-09, from heavy-crates)

`crates/replay/examples/heal_probe.rs` formats every field of every entity on every tick, so on
`CCitadel_BreakableProp` (709 entities) it runs at about real time (30 min for 129738985).
Comparing raw field values and formatting only the changes would make it a seconds-long probe.

## Clippy: collapsible_if in derive.rs's buffs (2026-11-09, from heavy-crates): resolved

Resolved 2026-11-11 (branch `server-debt`, 749182e; TD-1): the workspace is clippy-clean and `just clippy` gates it in `just check` and CI.

`cargo clippy -p mapcro-replay --all-targets` warns `collapsible_if` at
crates/replay/src/derive.rs:751 (`} else if !b.active && up { if let Some(l) = out.last_mut()`),
in the powerup code, not touched by heavy-crates. Likely one of the "two more errors in the lib"
in the clippy entry below.

## Mark in-game pauses on the scrubber (2026-11-09, from replay-pauses)

Since format 6 the replay timeline leaves pauses out: its clock holds through them, as the game's
does, so playback runs straight over a pause with no sign of it. deadlock-api's metadata lists
them (`match_pauses[]`: `game_time_s`, `pause_duration_s`, `player_slot`, one zero-length row
for the pause call and one for its length; 134570618 has four, 296 s in all), and the replay's
rules carry `m_bGamePaused`, `m_nPauseStartTick` and `m_iPauseTeam`. A tick on the scrubber, or a
"Paused (Sapphire), 1:57" event, would explain a sudden jump in positions. Needs a timeline field
or an event kind (a format bump) and a summary-tier counterpart.

## Does the API tier's path drift come from pauses? (2026-11-09, from replay-pauses)

docs/research/match-replay.md found deadlock-api's per-player path index drifting up to 59
samples from the death times in 130816395, which paused for 29 s at 538 s. If the API's paths
sample through a pause (the replay's own clock bug before format 6), each pause adds its length
of drift. `reanchored` in matches.rs re-anchors paths to deaths, which hides it between deaths.
Checking where the drift starts against `match_pauses` on a few paused matches would tell; if it
fits, cutting each pause's samples from the paths would fix the summary tier's clock.

## "Presenter left" has no test that the follower's own Vision comes back (2026-11-09, from follow-vision): resolved

Resolved 2026-11-11 (follow-sync): `player-follow-view.spec.ts` closes the presenter's context
mid-follow and checks the follower's own Vision and map layers come back.

## Player puts the match's name before a typed slot name (2026-11-09, from scene-names)

In Scenes a name typed into a slot (portrait menu, Rename…) wins over the open match's in-game
name. Player does the opposite on the tokens: Tokens.tsx `label` reads `pv()?.name ||
slot().name`, and PlayerTopBar's `tb-name` shows only the match's name while the portrait title
shows the typed one. So a renamed slot reads "Captain" in Scenes, "Coach" under Player's portrait
and on its token, and "Captain" in Player's portrait title. Needs a call on which wins in Player;
then one helper (`slotName` in board/roster.ts) for both.

**Update (2026-11-10, scene-parity):** Player's portrait title now follows its token and Tab
column (the match's name, then a typed one), and no bar shows names under it any more. The
Scenes/Player order difference itself is unchanged and still needs the call.

## A scene saved from another match shows no names (2026-11-09, from scene-names)

Scenes take names from the open match's timeline (`player.tl()`); a scene whose `source.match_id`
is a different match than the one open shows the slot labels (K1…) rather than the wrong
players' names. Showing its own match's names would mean loading that match's timeline (or
carrying the names on the scene). Rare: a board with several matches, switching between them.

## The hero picker and "taken" labels don't use the match's names (2026-11-09, from scene-names)

HeroPicker's heading (`who`) and Board's `takenBy` ("Hidden King Player 1 has this hero") use the
slot's typed name only, so on a match board they say "K 1" / "Player 1" where the top bar now
says the player's name. Passing Board's `matchName` through would fix both.

## A blank scene on a match board doesn't take the match's heroes (2026-11-09, from scene-names)

The roster's heroes are board state; Save as scene sets them to the match's ("Roster → match
heroes"), but a board opened from a match keeps an empty (or random) roster until then, so its
first scene shows K1…A6 discs. Left as is on purpose: a display-only hero fallback would disagree
with the picker, `takenBy` and every other reader of `slot.hero`. A possible follow-up: when a
match is attached and every slot is empty, offer (or do, once, as the owner) the same
"Roster → match heroes" transaction.

## Unplayable heroes can't be picked any more (2026-11-09, from scene-names)

The side roster's `<select>` listed every hero in the pack, unplayable ones (schema 3: no top-bar
portrait, e.g. work-in-progress heroes) included; the portrait's picker lists playable heroes
only, and the side roster is gone. Probably right; noted in case someone wanted a WIP hero.

## A clone made while an upload is still parsing doesn't get it (2026-11-09, from clone-replay)

Clone carries the board's matches and each uploaded timeline already cached
(`carry_to_clone`, replays.rs). An upload still queued or parsing has no timeline yet, so the clone
opens that match at the fetched or summary tier, and someone has to upload the file again there.
A fix would record the clone against the job and link the result to it when it lands.

## An e2e spec that uploads over 6 times fails without saying why (2026-11-09, from vision-fade)

Each Player e2e test opens its synthetic match by uploading a `.dem`, and the server allows one
client 6 uploads an hour (`REPLAY_PER_CLIENT_PER_HOUR`, replays.rs). The 7th test in a spec then
times out polling the replay inbox, with nothing on the page or in the error saying the limit
was hit. player-vision.spec.ts now raises the limit for its server; a shared default in
e2e/server.ts, or the helper reporting the refusal, would spare the next spec the hunt.

## Clippy fails on crates/replay/src/parse.rs (2026-11-09, from shop-state): resolved

Resolved 2026-11-11 (branch `server-debt`, 749182e; TD-1): the workspace is clippy-clean and `just clippy` gates it in `just check` and CI.

`cargo clippy -p mapcro-replay --tests -- -D warnings` (rust 1.99) stops on
`clippy::chunks_exact_to_as_chunks` at parse.rs:658 (`key.chunks_exact(4)`), and on two more
errors in the lib. Not touched by shop-state. `as_chunks::<4>()` is the suggested fix.

## The pack's sapphire shop keys name the wrong lane (2026-11-09, from shop-state)

The extractor keys a shop by the lump's `LaneNum`, which the map mirrors on Sapphire's side:
`shop:sapphire:lane1:1` is the shop beside the lane 6 guardian, and `shop:sapphire:lane6:1` the
lane 1 one (docs/research/map-objectives-audit.md, "Shops"). Nothing reads a shop's lane today:
Player pairs shops with guardians by place. A key fix would rekey the shops, so a board that
refers to one by key would need a migration.

## How many Sinner's Sacrifice machines are left (2026-11-09, from the map objectives audit)

Three Sinner's Sacrifice camps hold more than one machine: the bell tower has 3, and the theater
balcony and the slums garage roof have 2 each. The camp timer only says up or cleared. Each
machine is its own networked `CNPC_Neutral_SinnersSacrifice` the whole match
(docs/research/map-objectives-audit.md), so a partial clear could show on hover ("1 of 3 left").
That changes the timeline (`timeline::FORMAT`).

## A follower doesn't see the presenter's teleporter pair (2026-11-09, from map-layers)

Hovering a teleporter draws the line to its pair from this browser's own hover only
(`player/Camps.tsx` `TeleporterLink` reads `localHover()`). The presenter's hover reaches a
follower (spec §8) and its label shows, but a teleporter has no label, so the follower sees
nothing. `TeleporterLink` could take the remote hover too, as `HoverLabels` does.

## The extractor's real-install test writes a fixed path in /tmp (2026-11-09, from map-layers)

`crates/extract/tests/extract.rs` `real_install` removes and rewrites `/tmp/mapcro-extract2-real`.
Two agents running it at once (the box is shared) clobber each other's pack mid-run. A temp dir
of its own, or one under `CARGO_TARGET_TMPDIR`, would keep runs apart.

## The other dialogs don't hold the focus (2026-11-09, from the feedback form): resolved

Resolved 2026-11-10 (branch `ux-batch-1`). Share, Clone, the hero picker, the join card and
Feedback mount through `ModalScrim` (ui/ModalScrim.tsx). Each is `aria-modal`, makes the board
inert, wraps Tab and Shift+Tab, keeps its keys from the board (`dialogKeys`), closes on Escape
(the join card excepted: joining is how you enter) and gives focus back to its opener. Modals
stack: Clone opened from Share gives focus back to Share's opener. Spec: e2e/dialog-focus.


Share, Clone and the hero picker render inside the page and don't contain the keyboard: Tab
walks out of the dialog into the board behind it, which stays interactive (the known Share
focus-escape issue). `web/src/ui/modal.ts`, built for the feedback dialog, is the fix: render the
dialog through a `<Portal>`, call `useModal(() => scrimEl)`, and stop key presses at the dialog
so the board's window listeners (Escape's `leaveControl`, Space) don't act on them. The
feedback e2e spec's Tab, inert and focus-return checks can be copied.

## Feedback on phones (2026-11-09)

The phone board (`PhoneBoard`) has no Feedback button; the landing's footer link works there.
Add it to the phone top bar if phone users should reach it from a board.

## Alert when the feedback token stops working (2026-11-09)

A fine-grained token expires. When it does, every send is a 502 and `feedback_rejected
{reason=github_error}` rises, with `github issues refused` rows in `failures`. Nothing alerts on
it yet (observability spec §6); an alert on any `github_error` in a day would catch expiry.

## Vision for objectives, camps and troopers (2026-11-09)

Player's Vision (spec §6b) covers heroes only. The same feed (`CCitadelTeam.m_vecFOWEntities`,
docs/research/replay-vision.md) carries `m_bVisibleOnMap` for objectives by `m_eClass`: 5
guardian, 8 mid boss, 28 shrine, 29 walker, 30 base guardian, 31 patron; also 41 bridge buff,
43 rejuv/gold, 44 urn, 45 rift spawner, 92 rift cash-in. Classes 34–38 resolve to no entity
(probably camps, unconfirmed). A `seen` per objective key (like `Player.seen`) would let a team's
view hide an objective's health and state changes out of its sight. Troopers' entries weren't
probed.

## Vision leaves the rest of Player omniscient (2026-11-09): resolved, by design

Operator, 2026-11-09: "vision should only hide the hero on the map, everything else can stay
visible." So the behaviour below is intended. Keep it unless the operator asks again.


In a team's Vision only the enemy tokens on the map change. Still shown as SourceTV saw them:
the top bar's enemy health, ult, souls and respawn timers (`PlayerTopBar.tsx`); the events list
and its pings and jump rings (an enemy's death or ult where nobody on the team saw it; the jump
ring in `host.ts` `ring` follows the hero's true position); the trooper dots; objectives'
health. Some of that a player does know in game (the scoreboard has souls and respawns), so each
needs a call per item, not a blanket filter.

## Vision checked on one replay (2026-11-09)

`m_bVisibleOnMap`'s meaning was validated on 129738985 alone (build 6839). Worth re-checking on a
second standard 6v6 match and after patches: the first sighting near the laners' first contact,
almost every death seen, the FOW position matching the true one while visible. The spike's open
questions stand: hero 81's death while hidden for 2 s (stealth?), the spectator team's list, and
`m_nOwnerOnlyEntIndex`.

## The HUD's mid-boss timer circle and per-player Rejuvenator marks (2026-11-09)

Noticed by rejuv-icons while reading `citadel_hud_top_bar.vcss` for the Rejuvenator marks. Two
states the game draws that Player doesn't:
- `#RejuvenatorTimer.midboss_cooldown`: when no team holds one, the same centre circle shows
  greyed (`saturation: 0`, opacity 0.3) with `.midbossTimerLabel` (`{s:midboss_timer}`, 10 px,
  under it), the mid boss's respawn countdown. The timeline has the respawn (`camps` cleared
  pairs). `.midboss_available` hides it.
- Per player: `.HasRejuvenator .SoulsValueContainer { border-bottom: 3px solid gold }` and the
  `.Rejuvenator` / `.RebirthIcon` / `.RebirthAndRejuvenator` icons on a player's card
  (`citadel_hud_top_bar_player.vxml`). Who carries a pending revive isn't in the timeline yet.

## "0 revives" in the mid boss's label (2026-11-09)

`player/Camps.tsx` `rejuvLine` says "Archmother Rejuvenator: 0 revives, ends in …" if a
timeline's `left` reaches 0 before `ends_s`. The top bar drops its marks and timer then
(PlayerTopBar `RejuvTimer`), so the two disagree. 129738985 never reaches 0 early (both expire
at 180 s with 1 left). Only seen on a synthetic timeline. Whether the game ends the buff at 0 is
unconfirmed.

## Hover-label token parts are unused now (2026-11-09)

Left by portrait-menu: with the tokens' eye and skull buttons gone (kill and vision moved to the
top-bar portrait's right-click menu), nothing calls `hoverToken` with a `part` any more.
`map/HoverLabel.tsx` still carries the `part` field, its doc comment naming `vis` and `life`, and
`fromPresence` still accepts those two from peers (an older client may still send them for one
deploy). Once no client in the field sends parts, drop `part` from `HoverRef`, the resolver's
argument and the `data-part` attribute. Cleanup only; no behaviour change.

## Camp selection rings oversized on the fallback map (2026-11-09)

Noticed by board-ux while checking the selection-in-your-colour shots
(`web/e2e/selection-colour.spec.ts`, `shots/selection-colour-objectives.png`). On the fallback map
(no pack), a camp's `.mk` box is about 2.5x its drawn triangle or square. So the picked ring
(`.mk.picked::after`, `inset: -14%` of the box) circles far past the icon, and neighbouring camps'
rings overlap. With pack art the icon fills the box. Fix: size the fallback camp glyph to its box,
or size the ring from the glyph. Not checked against every real-art camp tier.

## Top-bar hover rings don't wear the viewer's colour (2026-11-09)

`--me` (my presence colour) is set on the map box only (`Board.tsx` mapBox), so the hover ring on a
top-bar portrait (`.tb-focus:hover`) and the roster chip's outline fall back to `--accent`. Moving
`--me` to the board's root (the `.app.board-app` and `.phone` divs) would colour them too.
Cosmetic.

## Rift capture rings under the hero tokens (2026-11-09)

Noticed by rejuv-rift while checking 129738985's screenshots: on a contested rift (12:20 to 12:59)
the heroes stand on the point, and `player/Rift.tsx`'s rings are drawn over their tokens
(Board.tsx puts `RiftRings` after `Layers`, beside `UrnMark`), so a ring crosses a portrait. It may
read better drawn under the tokens, or with radii that clear a token on the point. Screenshots of
that rift come from `e2e/shots-rejuv-rift.spec.ts` (set `MAPCRO_SHOT_REPLAY` to a format-3 parse).

## A hidden marker's silence has no test of its own (2026-11-09)

Since labels became timers-only (2026-11-09), `e2e/hover-hidden.spec.ts` hovers walkers in Sandbox,
which say nothing whether hidden or not. So `MarkerTips`' `p.hidden(m.key)` check
(player/Camps.tsx) is no longer pinned. A Player test that hides a timed marker (a cleared camp) and
expects no label would pin it.

## Parse replays in the browser (2026-11-08)

Build the replay parser to WebAssembly and parse an uploaded `.dem` in the user's browser, then send
the small timeline instead of a 500 MB upload. That removes our upload bandwidth and parse CPU for
uploads. A browser-parsed timeline is untrusted, so it applies only to the board that sent it,
never the shared per-match cache. Open questions: does boon build for wasm32 (it mmaps the file
today), and are the time and memory acceptable for a 500 MB demo on a phone. Also weigh
deadlock-api's `/v1/matches/demo/query` (they parse; 200 req/h per IP), though they're at capacity.
Notes: `docs/research/browser-side-replays.md`. Deferred by the operator in favour of moving the
deadlock-api calls to the browser first.

**2026-11-10 update (operator):** now more useful, as a fallback when the server's replay queue is
full or busy (`queue_full`, `busy`): Player offers "Parse in this browser" and the result goes up
through the client-timeline route that the Windows app uses (`POST
/api/boards/{board}/replays/{id}/timeline`, spec §6a), which already validates and board-scopes it.
Same code as the server and the app (`crates/replay` `worker::job`) built for wasm32. Run it in a
Web Worker so the page stays responsive, and read the `.dem` from the `File` in slices rather than
whole (the app's parse of 129738985 took 14.5 s and about 26 MB on the server's numbers; a 500 MB
file must not be loaded into memory at once). Blockers to check first: boon on wasm32 (mmap,
threads), the zstd/bzip2 crates on wasm, and phone memory. The format-9 lockstep applies: the
browser build ships with the server, so it never lags `FORMAT`.

## A settings page (2026-11-08)

As display preferences pile up, give them one home. Today they sit on Player's transport bar:
Troopers, Health, Pings, and the per-viewer Names toggle ("anonymous mode" for content creators).
A settings page or panel would hold the per-viewer ones, stored in the browser and never synced,
and could later hold board-wide ones for the owner. Decide which stay as quick toggles on the bar.

## The canvas fills the centre area (2026-11-09)

Operator: "can we make the canvas the entire center area? more space to draw … seemless". Today the
drawable area is the map's square box plus a notes margin of a quarter map each side
(`MARGIN`, web/src/map/transform.ts); the host clips at the square. Backlogged as too big for now,
because it moves the clip from `.mapbox` to `.mapfit`, and the clamps `clampToBoard`, `clampShift`,
`clampView` and `MAX_W` all have to widen. The follow view (centre plus zoom) then has to look right on
a follower whose centre area has a different shape. The dashed edge of the margin is gone already
(2026-11-09), so the canvas reads as one.

## "Resume a scene" (2026-11-08)

- **Playback is in progress**, as Player (spec §6b): it plays an imported match on the map, with
  annotation over it kept only by saving a scene (operator, decided).
- **Resume a scene:** start playback from a saved scene's moment, to show "here's what you should have
  done" (the scene, edited) next to "here's what you actually did" (the match playing on from that point).
  Enabled by Player's saved scenes storing their source (match id, t, tier); the action itself isn't
  built.
- **Open question:** resuming inside the game client itself, rather than in mapcro's playback, would
  need a way to load game state into Deadlock. No public mechanism for that is known.

## Board download and upload (2026-11-08)

Export and import a board as a file. The spec already plans a versioned `.mapcro.json` that goes through
the same migrations (spec §6).

## Data and storage decisions (deferred by the operator, 2026-11-08)

- **Idle boards:** whether to expire boards nobody has opened, for example after 180 days.
- **Backups:** a nightly off-box snapshot of the server database; the provider is undecided.
- **Cached match timelines:** whether to keep them forever. They're small, and they're the only copy
  once a replay expires.

## Older maps (2026-11-08)

Replays from before build 6712 are refused as "Old map". Supporting them needs the 16384 coordinate
correction (`docs/research/replay-parsing-exploration.md`) plus asset packs from that era.

## Replay timeline format versions (2026-11-08): resolved

Resolved 2026-11-08 (spec §6a, Format stamp; journal 2026-11-08-urn-polish): the server reads the
stamp (`mapcro_replay::timeline::FORMAT`). A stale fetched timeline inside Valve's three weeks is
fetched and parsed again once on open, served meanwhile and swapped in place; past them it stays.
A stale upload stays, and Player offers "Upload replay file". Open: "once a match" is kept in
memory, so a restart allows one more refetch per match.

## Server

- **A burst of 26 `ws_closes{reason=protocol}` in one minute on prod** (2026-11-09 08:14 UTC; `just
  stats series ws_closes`). It wasn't near a deploy (07:32 and 09:44 UTC) and there were none
  before or after. It looks like one client in a reconnect loop that sends something the server
  rejects as a protocol error: maybe a tab still on the pre-07:32 client against the new
  Presence (`hover`), or a malformed op. Check what the server logs on a protocol close (room.rs /
  wire.rs `is_valid`), whether a close for protocol makes the client retry at once, and whether an
  old-build client can trip it. Not a data-loss path: a rejected frame is never applied.

- Presence relay is O(n²) in bytes per room (perf report finding 4). It's fine at our scale.
- Base frames aren't chunked. A board over 8 MiB of JSON falls back to paged catch-up.
- **Rebase fan-out isn't bounded** (sync review 2026-11-08, finding 4): each stale hello clones the
  doc and builds its own JSON frame, and the outbox weight doesn't count it. 64 devices returning
  to an 8 MB board after a compaction could exceed the service's 256M memory. The fix is to serialize
  once per (doc, seq), splice in `decided_below`, and count it.
