# Research map: replay data and game data

Start here before probing a demo or the game files. Each line says where the answer is; the
linked doc has the evidence. Code paths are the source of truth: where a doc and the code
disagree, the code wins (noted inline). Most measurements are from one standard 6v6 replay,
129738985 (build 6839, 2,640 s).

## Replay → timeline

The timeline format is `crates/replay/src/timeline.rs` (field docs, `FORMAT`, the server's
checks). Reads are in `parse.rs` (entities, rules, vision feed) and `parse_hero.rs` (format 7:
messages, ability entities, modifiers). `derive.rs` and `hero_data.rs` turn them into fields.
Ids are `CUtlStringToken`s: MurmurHash2 of the lower-cased name, seed `0x31415926`
(`timeline::token`).

| Field | Demo source | Derived in | Doc |
|---|---|---|---|
| `x`, `y` (null while dead) | `CCitadelPlayerPawn` body origin `m_cell*` + `m_vec*` | derive.rs | [exploration](replay-parsing-exploration.md) §3, §8 |
| `health` (percent) | pawn `m_iHealth` / `m_iMaxHealth` | derive.rs | exploration round 2 §2 |
| `deaths`, `respawn` | pawn `m_lifeState`; `m_flRespawnTime` (the controller's is always 0). A 3 s revive in place isn't a death | derive.rs `revived`, `respawns` | exploration round 5 |
| `souls` | controller `m_PlayerDataGlobal.m_iGoldNetWorth` | derive.rs | exploration §3 |
| `ult` | controller `m_bUltimateTrained`, `m_flUltimateCooldownStart/End` | derive.rs `ult_percent` | exploration round 2 §7 |
| `level`, `kills`, `assists` (format 8) | controller `m_PlayerDataGlobal.m_iLevel`, `m_iPlayerKills`, `m_iPlayerAssists` | derive.rs `scalar_change` | [scoreboard-values](scoreboard-values.md) |
| `max_health` (format 8) | active pawn `m_iMaxHealth`. **Refreshes only at (re)spawn** (see dead ends) | derive.rs | scoreboard-values; stat-calc-spike |
| `pickups` (format 9) | controller `m_PlayerDataGlobal.m_vecStatViewerModifierValues`: entries whose `m_SourceModifierID` is `<hp\|spirit\|wp\|bulletresist\|spiritresist>_permanent_pickup[_lv2\|_lv3]/modifier_permanent_pickup` and whose `m_eValType` is that stat (46, 169, 20, 36, 33); each entry is its source's running total | parse.rs `pickups`, derive.rs | [stat-calc-spike](stat-calc-spike.md) "Production plan"; scoreboard-values |
| `seen` | `CCitadelTeam.m_vecFOWEntities[].m_bVisibleOnMap` (the enemy team's feed) | parse.rs `vision_tick`, derive.rs `seen_intervals` | [replay-vision](replay-vision.md) |
| `height` | the hero's own team's FOW entry `m_eHeight` (0 level, 1 above, 2 below), held 2 s | hero_data.rs | [elevation](elevation.md) |
| `zipline` | pawn `m_eZipLineLaneColor` | parse_hero.rs, hero_data.rs | elevation |
| `items` | user msgs 309 `AbilitiesChanged` + 360 `ItemPurchaseNotification` (sells) | parse_hero.rs, hero_data.rs `item_kinds` | [abilities-and-items](abilities-and-items.md) §1 |
| `abilities` (tiers, not hero level) | controller `m_vecAbilityUpgradeState[].m_ItemID/m_nUpgradeInfo` | hero_data.rs `levels` | abilities-and-items §2 |
| `casts` | msg 365 `ImportantAbilityUsed`; cooldown from the ability entity's `m_flCooldownEnd` | parse_hero.rs | abilities-and-items §2 |
| `charges` | ability entity `m_iRemainingCharges` | parse_hero.rs | abilities-and-items §2 |
| `cc` | pawn `m_pModifierProp.m_bvEnabledStateMask`; cause from a same-tick enemy modifier | hero_data.rs `cc` | [status-effects](status-effects.md) §1–2 |
| `effects` | `ActiveModifiers` string table, filtered to icon-shown tokens (`modifiers.rs`, generated) | parse_hero.rs | status-effects §1, §3 |
| `recaps` | msg 300 `CCitadelUserMessageDamage` over `RECAP_S` (10 s) before death, plus `cc` | hero_data.rs `recaps` | status-effects §4 |
| `objectives`, `objective_health` | `CNPC_TrooperBoss`, `CNPC_Boss_Tier2/3`, `CNPC_BarrackBoss`, `CNPC_MidBoss`, `CCitadel_Destroyable_Building` health; patron `m_ePhase` | derive.rs | exploration §4 |
| `camps`, `mid_boss` respawn | rules `m_vecNeutralCampNextSpawnTimes/TimerOrigins/TimerIsMidBoss` | derive.rs `camps` | exploration round 3 |
| `rifts` | `CCitadelItemKothSpawner`; rules `m_timeKothCashInStarted`, `m_timeKothGiveUp`, `m_vecTeamKothStates[]` | derive.rs `rift_capture` | exploration §6, round 7; [timers audit](replay-timers-audit.md) |
| `powerups` | `CCitadel_PickupItemSpawner`; `CCitadel_Pickup_Modifier.m_nSubclassID/m_bActive` (buff type) | derive.rs `powerup_spawns` | exploration round 7 |
| `urn` | `CCitadelItemPickupIdol`, `CCitadelIdolReturnTrigger` | derive.rs `urn` | exploration round 6 |
| `rejuv` | msg `k_EUserMsg_RejuvStatus` (4 taken, 5 used, 6 expired); rules `m_iAmber/SapphireRejuvCount` | derive.rs `rejuvs` | timers audit gap 1 |
| `heals`, `crates` | `CCitadel_Pickup_Health`; `CCitadel_BreakableProp` with the tough-crate token | derive.rs `up_down_sites` | [map-objectives-audit](map-objectives-audit.md) |
| `zips` | `CCitadelZipLineNode.m_iTeamNum` | derive.rs `zips` | exploration round 4 |
| `troopers` | `CNPC_Trooper` | derive.rs `troopers_at` | exploration §5 |
| clock, mode, build | rules `m_flGameStartTime`, `m_bGamePaused`, `m_nTotalPausedTicks`, `m_iWinningTeam`, `m_eGameMode`; build from `game_directory` | parse.rs, lib.rs | exploration "Clock correction"; timers audit "Clocks" |

**Format history** (`timeline::FORMAT`, now 9): 0 unstamped; 1 respawns, urn; 2 buff types,
rift opening; 3 Rejuvenator, rift capture; 4 vision; 5 healing pickups; 6 clock holds through a
pause; 7 builds, abilities, casts, charges, CC, effects, recaps, height, zipline, tough crates;
8 level, max HP, kills, assists; 9 statue pickups (`pickups`). Format 7 runs about 41 KB per match minute.

**Cache re-fetch** (`crates/server/src/replays.rs` `stale`; spec §6a "Format stamp"; backlog
"Replay timeline format versions"): a cached fetched timeline whose `format` is below `FORMAT`,
for a match inside Valve's three weeks, is fetched and parsed again once when an editor opens
it. The old one is served meanwhile. "Once" is kept in memory, so a restart allows one more try.
Past three weeks, it stays. A stale upload stays (its demo is gone) and is marked `stale`;
Player offers "Upload replay file".

**Client-parsed timelines** (`replays.rs` `client_timeline`; spec §6a "Timelines parsed on the
user's machine"): a timeline sent by the desktop app is refused unless its `format` equals
`FORMAT` (`outdated_parser` / `newer_parser`), checked before the shape, so a parser change that
bumps `FORMAT` needs an app update before its users' timelines are taken again. Stored in the
board's scope with `source: "client"`; the stamp is the server's, not the client's.

## Game files → pack

`crates/extract` (`just extract <citadel dir> <out>`; output outside the repo). Spec §12 is the
design; `pack.rs` is the manifest (`SCHEMA` = 4).

- **Allow-list** (`allow.rs`): only `steam.inf`, `pak01_dir.vpk` and its chunks,
  `maps/dl_midtown.vpk`, and named loose localisation files. Inside the VPK: `TOPBAR_FIXED`
  (15 HUD images), `HUD_SOURCES` (11 panorama layouts/styles), `ABILITY_ICON_DIRS`
  (`panorama/images/{hud/abilities,upgrades,items,hud/modifiers}/`, one folder deep) and hero
  portraits under `panorama/images/heroes/`. Per-account files (`account_*.stats`,
  `cache_*.soc`, `cfg/`) are never opened.
- **vdata** (`lib.rs`): `scripts/heroes.vdata_c` → `heroes[]` (`heroes.rs`):
  `minimap_blob` (`m_strMinimapImage`), `topbar_blob` (`m_strTopBarVertical`), `card_blob`
  (`m_strIconHeroCard`), `critical_blob` (`m_strIconHeroCardCritical`), `abilities` (4 tokens,
  slot 4 the ult). `scripts/abilities.vdata_c`, `modifiers.vdata_c`, and modifiers nested in
  `misc.vdata_c` and `npc_units.vdata_c` → `data/abilities.json` names table (`abilities.rs`;
  prices from `generic_data.vdata_c` `m_nItemPricePerTier`).
- **Localisation** (`allow.rs` `ABILITY_NAMES`, loose KV1, `kv1.rs`): `citadel_gc_hero_names`,
  then for the names table, in order: `citadel_gc_mod_names`, `citadel_heroes`,
  `citadel_attributes`, `citadel_mods`, `citadel_main`. The VPK has only a stub `items_english.txt`.
- **Map** (`entities.rs`): `maps/dl_midtown/entities/default_ents.vents_c` → `entities[]` with
  semantic keys, camp `tier`, teleporter `exit`; minimap layers `minimap_midtown_*_psd`.
- **HUD** (`hud.rs`, `topbar.rs`, `panorama.rs`): panorama styles/layouts → `hud_sources[]`.
- **Formats** ported from ValveResourceFormat (MIT, credited): `vpk.rs`, `kv3.rs` (binary KV3 v5),
  `resource.rs`, `vtex.rs`, `panorama.rs`. [deadlock-assets-and-extraction](deadlock-assets-and-extraction.md) §3.
- **Stat tables** (`stats.rs`, crate `crates/stats`): the manifest's optional `stats` section
  (no schema bump) maps builds to per-patch `data/stats/<key>.json` tables, derived numbers only.
  The install's from its vdata (`heroes`, `abilities`, `generic_data`), older patches from
  boon-data (`just stat-data`, `--stat-data`). On 6860 both give identical tables
  (`examples/stat_table_check.rs`). vdata's `m_vecAutoRegisterModifierValueFromAbilityPropertyName`
  on a modifier is what boon-data's `modifier_keys` reads. The investment ladder
  `m_MapModCostBonuses` is per hero in **`heroes.vdata`** (not `generic_data`; deadbot
  `item_investment.py` reads it there and asserts every hero's is the same); each row has
  `nGoldThreshold`, `flBonus` and `flPercentOnGraph` (its share of the bar, summing to 100).
  [stat-calc-spike](stat-calc-spike.md) "Production plan".
- **Schema history:** 2 entities (web `map/model.ts`); 3 top-bar art (journal 2026-11-07-web-app);
  4 names table, `application/json` blob. Schema 5 (tooltips) is planned in
  `docs/plans/2026-11-10-game-tooltips.md`.
- **Deploy:** [deploy.md](../deploy.md) "Asset packs": copy into `PACKS_DIR`, restart (indexed
  once at start), schema 4 needs the server deployed first; keep old packs.

## External sources

- **deadlock-api** ([match-replay](match-replay.md) §2.2, [browser-side-replays](browser-side-replays.md),
  [deadlock-api-salts](deadlock-api-salts.md) "Results"): `/v1/matches/{id}/metadata` and
  `/salts`. A stored row is returned before the rate limiter, so reading a match it has is free
  with or without `disable_steam`. Only a match with no row reaches the Steam lookup, limited to
  3 per hour per IP (the 300/h key was declined 2026-11-08); that lookup is the one path that can
  create a replay salt for it. So the server reads salts free (`disable_steam=true`) first, and
  only a match with no row, past the ~2 h salts pass, gets the read that may ask Steam
  (replays.rs `salts`, counted as `salts_steam`); a 429 holds back only that read. A 400 "has
  metadata already" means no row and Steam won't be asked: `no_replay`. Metadata sends
  `disable_steam`. For a fresh match with a row, a free read is as
  good as a Steam one. About 10% have a `replay_salt` within 1 h, 42% at 2 h, then it levels
  off near 45–48%. For the rest, upload is the only path. Uploaded salts have always been correct.
  Metadata `match_info.winning_team` (lobby team, 0 Amber) and `players[].kills`, `deaths`,
  `net_worth` exist (129738985, read 2026-11-10, key names only): team kills 39/35 equal the other
  team's deaths, and each player's last `stats[]` `net_worth` equals the final one. The preview
  card reads them (spec §6a "Previews"; `matches.rs` `preview_of`).
- **Valve CDN:** `http://replay{cluster}.valve.net/1422450/{match_id}_{replay_salt}.dem.bz2`
  (and `.meta.bz2`). Since 2026-07-20 the `.bz2` files are zstd: sniff the magic bytes
  (`lib.rs` `ZSTD_MAGIC`; match-replay §1.1). Valid about three weeks after the match (§3.4).
- **boon** (`boon-deadlock` 0.19, MIT): the demo parser. The Rust API is low level; the
  higher-level datasets are Python-only. It hard-codes `max_coord` 32768, so pre-6712 demos come
  out 16384 low (exploration §10). **boon-data**: 44 releases, 6711–6860, as hashed JSON
  built from GameTracking. Its scripts are MIT; the data is Valve's. It is only published when
  content changes (6839 resolves to 6837). Don't use it at runtime (status-effects §3).
  `tools/modifier-tokens/gen.py` generates `modifiers.rs` from it. Its `versions.json` is on the
  `data-index` branch (not `main`): 44 builds mapped to 28 snapshots, with SHA-256 per artifact;
  `tools/stat-data/fetch.py` fetches the stat tables' inputs from it.
- **deadlock-api `/v1/assets/*?client_version=N`**: 875 versions, 5044–6860, structured heroes
  and items with tooltips resolved; `assets.deadlock-api.com` no longer resolves.
  **SteamTracking/GameTracking-Deadlock**: raw vdata, localisation, protobufs and schema dumps,
  one commit per build. Both: stat-datamining.md (on branch `stat-calc`, pending merge).
- **Desktop build** ([desktop-app](desktop-app.md)): Deadlock has no macOS client, so it runs in
  CrossOver or Whisky only. The replays folder is `<library>/steamapps/common/Deadlock/game/citadel/replays/<id>.dem`,
  about 11 MB per match minute. It can be missing, which breaks the in-game download until it is
  made. **Correction (desktop-app build, 2026-11-10):** `steamlocate` 2.1.1 `find_app` does
  list folders. It builds each `Library` with `read_dir` of that library's `steamapps`
  (`Library::from_dir`), which lists every installed game's manifest. Only its root lookup,
  `locate_all` (the registry key or fixed Linux roots, tested with `is_dir`), is safe. The app
  reads `libraryfolders.vdf` and Deadlock's manifest itself (`desktop/core/src/steam.rs`).
  Parsed locally (`mapcro-desktop-core` child, release), 129738985 took 14.5 s on a loaded box
  and came to 649 KB gzip (1.8 MB raw, format 8). The app is at `desktop/`; its privacy list
  and IPC allow-list are in `desktop/README.md`. Under our CSP (`connect-src 'self'`), Tauri's
  IPC falls back to `postMessage`, and raw answers come back as number arrays, not
  `ArrayBuffer`s (checked under Xvfb). Getting replay
  salts from a desktop app (Steamworks, the user's Steam session, game memory, Steam's HTTP
  cache) is a no-go under SSA §1.C, §4.B and §4.C (updated 2026-09-10).
- **WebKit, the Linux app's engine** (`just e2e-webkit`; desktop/README.md "Linux"; 2026-11-10,
  linux-desktop): Playwright's WebKit (nix `playwright-driver.browsers`, webkit-2272 for
  Playwright 1.59.1) is the stand-in for WebKitGTK. The first full run found no page bug; every
  failure was a test assumption. WebKit's `innerText` ends a block child with `\n`; it
  serializes a stored float (`stroke-dasharray` 91.67 → `91.669998px`); text widths differ, so
  wraps differ; Playwright's WebKit puts an SVG `<text>`'s quad at its `<svg>`'s origin (the
  page's own `elementFromPoint` is right), so locator clicks on SVG text miss; and there is no
  `navigator.storage.getDirectory`, `showDirectoryPicker` or CDP. **Speed:** headless WebKit
  drew a scene flip at one frame per ~100 ms against Chromium's ~30 ms (heroes-live glide spec,
  fixme on WebKit). The real WebKitGTK app's speed is unmeasured. WebKitGTK's blank window on
  NVIDIA: `WEBKIT_DISABLE_DMABUF_RENDERER=1` (Tauri's linux-graphics page, WebKit bug 261874).
  The app's WebDriver smoke test (WebKitWebDriver, Xvfb) passes: the bridge works under the live
  CSP, and every plugin is refused to the page.
- **Licensing:** Valve's SSA §2.G bars redistribution, so art is extracted by the operator and
  never committed (deadlock-assets-and-extraction "Risks"; spec §12). deadlock-api's code is MIT
  and the main API has no published terms; we credit it as a courtesy. deadlock-plus is GPL-3.0,
  so don't copy its code. deadlock-damage-lab has no licence: read it for ideas only.
  The wiki text licence is unverified (stat-datamining).

- **The replays folder** (`<Steam library>/steamapps/common/Deadlock/game/citadel/replays/`, files
  `<match id>.dem`; journal 2026-11-08-player-handoff). Chromium's File System Access blocklist
  (`chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc`
  `kBlockPaths`, read 2026-11-10) blocks Program Files, Program Files (x86) and `~/.local/share`
  with all children, after resolving symlinks, so a browser can link the folder only in a second
  Steam library. `<input type=file>` and drop aren't affected. Not checked: whether the game
  writes a download in place (a partial `.dem`) or renames it when done. Player waits until a
  file is 5 s old (spec §6b "Linked replays folder").

## Known dead ends and corrections

- **No recorded bullet/spirit resist total.** Checked: the schemas of all 929 classes, the
  controller's `m_vecStatViewerModifierValues` (only statue pickups and Spirit Snatch), the
  modifier table (no values), the user messages, and the `damage`/`pre_damage` ratio (rejected).
  The UI keeps "—". [scoreboard-values](scoreboard-values.md) "Bullet and spirit resistance";
  probes in `crates/replay/examples/{schema,statviewer,damage_ratio}_probe.rs`.
- **Recorded `max_health` refreshes only at (re)spawn.** It matched the live metadata value at
  10 of 132 snapshots, so it's stale between spawns. stat-calc-spike.md "Recorded max health" (branch
  `stat-calc`); lead handoff 2026-11-09; timeline.rs and scoreboard-values.md note it.
- **Stat formulas aren't Valve's.** Every rule set is community-derived (boon, deadlock-plus,
  damage-lab, wiki). The spike's calculated values: max HP 96.4% exact at respawn, spirit 81.1%,
  weapon 72.7%; resists match one sandbox screenshot only. The patch data must match the replay
  build: with 6821's data spirit falls to 73.5%, with 6711's health to 57.6% (`just stat-check`
  reproduces both). stat-datamining.md, stat-calc-spike.md.
- **How the Tab scoreboard's investment bars fill isn't documented anywhere we found** (wiki
  Souls page, deadbot, deadlock-api: data only). We fill along `flPercentOnGraph`; the backlog's
  in-game checks list it.
- **The mint `#90FFE3` souls tab is `.KillStreak`**, not a net-worth leader (the Argon note was
  wrong; `citadel_hud_top_bar.vcss`). The **kill-streak threshold** is set in native code and
  unknown: don't guess it. The **gloat card** `m_strIconHeroCardGloat` exists for 45 of 64 heroes,
  but it isn't extracted and no vcss uses it (code swaps it in). Backlog "Kill-streak mint souls
  tab" (branch `ux-batch-1`, pending merge).
- **Not in the demo:** msg 310 `RecentDamageSummary` (the game's death recap), 325/327 modifier
  applied, 367/368 combat log: all 0 (status-effects §1). No Weapon/Spirit/Vitality category
  field (exploration round 2 §4; scoreboard-values "Category progression"). There's no active-item
  flag in the pack, and a missing cast doesn't prove an item is passive.
- **Unreliable fields:** controller `m_bAlive` is always 0 (use the pawn's `m_lifeState`).
  Controller `m_flRespawnTime` is always 0. A modifier's `duration` isn't when it ends (use the
  removed delta). `m_nSpentCurrencies[0]` read 0 (on 122134063, a Brawl demo: unverified on
  6v6; exploration round 2 carries the warning). `build_num` isn't the map build.
- **Corrected:** "camp timers aren't exposed" (exploration round 2 §5) was wrong. The data came
  from Street Brawl 122134063 (round 2 warns inline); round 3 found the rules' timers. 6v6 recordings are full-world
  (HLTV), not PVS-limited for camps and heroes (round 3 §3). The timers audit's "no break shows"
  for breakables is superseded for tough crates (format 7; gap 6 says so); the statue lifecycle
  hasn't been probed.
- **deadlock-api:** a Steam lookup never produced a `replay_salt` that a free read lacked, so
  browser-side priming was dropped (browser-side-replays "Step 0"; salts "Results"). Its
  `MAP_RADIUS` 10752 has no in-game source (the pack fits the transform), and its
  `objectives_map.css` has been stale since 6711.
- **Unverified:** that the metadata `items[].item_id` is the demo token (backlog "Check the
  API's item ids"); what `m_tLastPlayerRevealTime` means; 3 engine modifier tokens are unnamed
  (backlog "Three modifiers").

## Gotchas

- **Standard 6v6 only** (`m_eGameMode == 1`; lib.rs `STANDARD_GAME_MODE`). Match **122134063
  is Street Brawl**: never use it as data. Early exploration rounds 1–2 used it, so recheck
  anything that rests on it. Pre-6712 demos are refused as `old_map`.
- **Test replay 129738985** (patch 6839) is the reference. Our pack and boon-data are at 6860,
  so build-dependent values need a matched snapshot.
- **Privacy:** never write player names or account ids to a probe output, doc, commit or log.
  Probes print aggregates keyed by hero id at most, and anything holding entity handles goes to
  `/tmp`. The worker never reads Steam ids; boon's `EnemyMinimap` does, so read the fields
  yourself. Never list Steam dirs or `/`. Open only allow-listed game files.
- **Game art is never committed:** not packs, screenshots or mocks drawn over pack art.
- **Playwright e2e serves the built `web/dist`** (`web/e2e/server.ts`). Rebuild first; `just e2e`
  does it.
- **Chrome's File System Access blocklist covers default Steam roots** (Chromium `main`,
  `chrome_file_system_access_permission_context.cc`): `Program Files (x86)` on Windows and
  `~/.local/share` on Linux are `kBlockAllChildren`. A browser folder picker can't open the
  default replays folder, only a secondary library's. Drop and `<input type=file>` still work.
  This is from the source and hasn't been tried in a real browser yet ([desktop-app](desktop-app.md) §2).
- **Heavy probes** (`timer_audit` took 754 s) run alone under the load gate: the box is shared.

## Keeping this current

Any agent that learns something about replay data, game files or an external source adds a line
here in the same change: a new field and where it comes from, a dead end and what was checked,
or a correction to a line above. Link the detailed doc. Delete or fix lines that go stale; don't
leave both versions.
