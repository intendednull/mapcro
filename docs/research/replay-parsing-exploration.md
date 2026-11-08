<!-- 2026-11-08: DeepSeek exploration of three local replays with boon 0.19 (Rust core). Scratch code lived in /tmp, not in the repo. -->

# Deadlock `.dem` extraction with boon 0.19 — probe report
**Date:** 2026-11-07 · **Scope:** read-only exploration, no repo changes · **Crate:** `boon-deadlock 0.19.0` (crates.io, MIT) · **Toolchain:** repo `nix develop`, rustc 1.99.1.

## Summary
1. One `Parser::run_to_end` pass yields header, clock, heroes, objectives, troopers, rifts and powerups. All 1 Hz outputs total 2.0 MB for the 97 MB demo.
2. On the current map, decoded positions land **exactly** on our pack: 17/17 observed objectives at 0.0 units, hero spawns 0–540 units from our spawns, east rift 0.0.
3. The Rust crate is **low-level only** (`Parser` + entities); the high-level datasets exist only in boon's Python bindings, so field keys and state machines were written by hand.
4. Pre-6712 demos decode **16384 units low on x, y and z** with boon 0.19 (hard-coded `WORLD_HALF = 32768`). Add +16384; the median implied shift to our pack is exactly `(16384, 16384, 16384)`.
5. Main caveat: **PVS**. A demo only contains entities near players, so objective/trooper/powerup coverage is incomplete and varies by match.

## 1. Header
| Field | 122134063 | 108440637 | 100747544 |
|---|---|---|---|
| `CDemoFileHeader.build_num` | 10932 | 10854 | 10854 |
| `game_directory` content build | **6813** | **6701** | **6683** |
| `map_name` | `"start"` | `"start"` | `"start"` |
| `patch_version` / demo version | 48 / `valve_demo_2` | 48 / `valve_demo_2` | 48 / `valve_demo_2` |
| `server_start_tick` | 3121 | 2460 | 1031 |
| `playback_time` / `playback_ticks` | 900.234 s / 57615 | 1933.422 s / 123739 | 2071.594 s / 132582 |
| tick interval / rate | 0.015625 s / **64 Hz** | same | same |

- `build_num` is **not** the game content build (all demos 10854/10932); use `game_directory` (`citadel_v6813/v6701/v6683`) for map era.
- `map_name` is `"start"` for every server demo; map inferred as `dl_midtown` from `EntityNames` (`dl_midtown_pulse`).
- No match-id field in `CDemoFileHeader`/`CDemoFileInfo`; the local filename is the match id.

## 2. Game clock
`CCitadelGameRulesProxy`: `m_pGameRules.m_flGameStartTime`, `m_bGamePaused`, `m_nTotalPausedTicks`, `m_tNextMidBossSpawnTime`.
`game_time_s = tick × 0.015625 − total_paused_ticks × 0.015625 − game_start_time`; output `clock.csv` at 1 Hz.

> **Correction (2026-11-07, replay tier).** This formula runs early by the header's
> `server_start_tick` × 0.015625 (48.8 s for 122134063): `GameTime_t` values, the game start
> included, count server ticks, and the recording starts that far into the server's life. The
> right clock is `(tick + server_start_tick − total_paused_ticks) × 0.015625 − game_start_time`,
> checked against deadlock-api's metadata for 122134063 (deaths and objectives within 1 s, the
> same 890 s duration; ult cooldown starts sit 48.7 s after `tick × 0.015625`). The game ends
> when `m_iWinningTeam` is set; the recording runs ~40 s past it. Times below use the old clock:
> add 48.8 s for 122134063 (so its "last ~40 s" rift spawner is post-game).

- 122134063: ends **881.234 s**, 0 paused ticks. 108440637: ends **1855.391 s**, **586 paused ticks (~9.16 s)**. 100747544: ends **2024.875 s**, 0 pauses. `m_bGamePaused` was never true at a 1 Hz sample; use `m_nTotalPausedTicks`.

## 3. Per hero, 1 Hz
`heroes.csv`: 8 players in 122134063 (4v4), 12 (6v6) in both older demos.

| Want | Entity class and field |
|---|---|
| x/y/z | `CCitadelPlayerPawn`, `CBodyComponent.m_skeletonInstance.m_vecOrigin.m_cellX/Y/Z` + `.m_vecX/Y/Z`, via `boon::world_position` |
| hero / team / steam | `CCitadelPlayerPawn.m_CCitadelHeroComponent.m_spawnedHero.m_nHeroID`; `CCitadelPlayerController.m_iTeamNum` (2=amber, 3=sapphire); `.m_steamID` |
| alive | `CCitadelPlayerPawn.m_lifeState == 0 && m_iHealth > 0` |
| health / souls | `m_iHealth`, `m_iMaxHealth`; `m_nCurrencies.m_nCurrencies` (element 0); `m_nSpentCurrencies.m_nSpentCurrencies` |
| ult / level / net worth | `CCitadelPlayerController.m_PlayerDataGlobal.m_bUltimateTrained`, `…m_flUltimateCooldownStart`, `…m_flUltimateCooldownEnd` (GameTime_t), `…m_iLevel`, `…m_iGoldNetWorth` |

- **`m_PlayerDataGlobal.m_bAlive` is constant 0 in all three demos.** Use pawn `m_lifeState`/health instead.
- Souls range 0–48,000 in 122134063; ult cooldowns are nonzero on 5,359/6,727 primary rows.

## 4. Objectives over time
| Kind | Entity class | Key fields |
|---|---|---|
| guardian / walker | `CNPC_TrooperBoss` / `CNPC_Boss_Tier2` | `m_iHealth`, `m_iMaxHealth`, `m_iTeamNum`, `m_iLane` |
| base guardian / patron / mid boss | `CNPC_BarrackBoss` / `CNPC_Boss_Tier3` / `CNPC_MidBoss` | same; patron adds `m_ePhase`; mid boss team neutral |
| shrine | `CCitadel_Destroyable_Building` | `m_iHealth`, `m_iMaxHealth`, `m_iTeamNum` |

Positions use the same `CBodyComponent.m_skeletonInstance.m_vecOrigin` path. `objectives.csv` = one row per lifetime (first/destroyed tick, health, position); `objectives_timeseries.csv` = 1 Hz health.

- 122134063: 5 guardians, 6 walkers, 4 shrines, 2 patrons; 8 destroyed (5 guardians, 3 walkers). **No base guardians or mid boss**; `m_tNextMidBossSpawnTime` = 890.2 s, after the 881.2 s game end.
- 108440637: 12 base guardians, 6 walkers, 6 guardians, 4 shrines, 2 patrons, **2 mid bosses**; 6 base, 5 guardian, 4 walker, 2 shrine, 1 patron and both mid bosses destroyed.
- 100747544: 12 base, 6 walkers, 6 guardians, 4 shrines, 2 patrons, **1 mid boss**; 10 base, 6 walker, 6 guardian, 4 shrine, 1 patron, 1 mid boss destroyed.
- Destroyed time = first tick where health goes positive→0 (exact tick, not interpolated).
- **PVS gap:** some entities appear at tick 1 with health 0 and never return (two amber walkers in 122134063); they have no usable health/destroyed time. Missing base guardians/mid boss in 122134063 are likely the same effect plus no base push.

## 5. Troopers at 1 Hz
- Class `CNPC_Trooper`; `m_iHealth`, `m_iMaxHealth`, `m_iTeamNum`, `m_iLane`, `m_lifeState`, position as above.
- `troopers.csv` = one row per alive trooper per second; `trooper_fronts.csv` aggregates count/min/max/mean x,y per `(team, lane)` per second.
- 122134063: 12,017 rows, lanes 1/4/6, teams 2/3; only **750 of 901** seconds had any trooper in PVS. Lane-wave equilibrium is computable from the fronts, but gaps mean “not visible”, not “no troopers”.

## 6. Rifts
| Want | Entity class and field |
|---|---|
| spawner / announce | `CCitadelItemKothSpawner` (presence; position via body origin) |
| cash-in live | `CCitadelGameRulesProxy.m_pGameRules.m_timeKothCashInStarted` (0 = not live) |
| scoring team | `…m_nKothScoringTeam` (≤0 contested; >0 captured by that team) |
| cash-in location | `…m_vKothCashInCurrentLocation` (**VectorWS world coords — do not cell-decode or offset**) |

`rifts.csv` = 1 Hz state; `rift_events.csv` = one row per completed rift (announce/active/capture/expire, winner, position). Logic mirrors boon's `boon-dev rift`.

- 122134063: spawner at east site **(7648, 0, 420)** for the last ~40 s; cash-in never became live, so **no completed rift**.
- 108440637: **3 rifts**, all captured at (7612, 0, 444), winners 2, 3, 2.
- 100747544: **3 rifts**, captured at (-7560, 0, 424) and (7612, 0, 444), winners 3, 3, 2. Rift state is on the game rules, not the spawner (spawner showed only `m_iTeamNum = 4`, `m_iHealth = 0`).

## 7. Powerups
- Class `CCitadel_PickupItemSpawner`; `m_bPowerupActive` (bool), `m_tNextDropTime` (GameTime_t).
- 122134063: both spawners present all match at **(-3936, 136, 912)** and **(3936, -128, 912)**; `m_bPowerupActive` = **0 for all 901 samples**, `m_tNextDropTime` constant 318.562. No powerup spawn observed.
- 108440637 / 100747544: state toggles active at ~5-minute intervals; e.g. east active 262.5–263.5 s, 562.5–568.5 s, 862.5–870.5 s, with `m_tNextDropTime` advancing 300 s per cycle.
- Our pack has **no `powerup` entities**, so there is nothing to compare against; demo sites are x = ±3936, y = +136/−128, z = 912.

## 8. Coordinate check against `pack.json` (build 6860)
| Check | Result |
|---|---|
| 122134063 objective positions (17) | **0.0 units** from matching pack entity, every one |
| 122134063 hero spawns (8) | nearest pack team spawn 0.0–**540.2** units |
| 122134063 east rift | pack (7648,0,420) vs demo (7648,0,420): **0.0** |
| 122134063 powerup sites | x exact; y +136/−128; z 912 |
| old demos, raw boon output | 16384 low on x, y and z |
| old demos, median implied shift | **exactly (16384, 16384, 16384)** |
| old demos after +16384 | hero bounds x −9244…9117, y −10361…10667, z −768…2460 |
| old walkers / patrons / shrines vs pack | walkers 0–471 units; patrons and shrines ~1280 in x (old map layout, not encoding) |
| old mid boss / rift captures vs pack | mid boss (0,0,−768) vs (0,0,−832): 64 in z, x/y exact; rifts 43 units (east) / 88 (west) |

Formula: `world = cell × 512 − max_coord + offset`, with `max_coord = 32768` after build 6712 and `16384` before. boon 0.19 always uses 32768; add +16384 on every cell-decoded axis for pre-6712 demos. `m_vKothCashInCurrentLocation` is already world space.

## 9. Timings and sizes (single pass, `cargo build --release -j 4`)
| File | Size | Wall | Peak RSS | Output |
|---|---|---|---|---|
| 122134063.dem | 97 MB | **2.74 s** | 117 MB | 2.0 MB |
| 108440637.dem | 458 MB | **10.62 s** | 482 MB | 9.2 MB |
| 100747544.dem | 478 MB | **10.97 s** | 501 MB | 11 MB |

First release build of the probe: 1 m 14 s. Peak memory is dominated by the parser's entity state, not the downsampled rows; each output file is < 3 MB.

## 10. Blockers / caveats
1. **Rust API gap.** `boon-deadlock` exposes `Parser`, `Context`, `Entity`, serializers and `world_position`, but not the Python `Demo` datasets. All field-key resolution and state machines above were written by hand; budget for that in the server.
2. **PVS-limited demos.** Only entities near players are networked. Objectives, troopers and powerups disappear for long stretches; 122134063 has no base guardians or mid boss. A timeline must distinguish “not visible” from “destroyed”.
3. **`build_num` is not the map build.** Use `game_directory` (`citadel_v6813`) or a build timestamp map. `map_name` is `"start"`; match id is only the filename.
4. **Pre-6712 offset.** boon 0.19 silently decodes old demos 16384 low on all axes. Detect `game_directory` build < 6712 and add 16384. The old demos also use the pre-City-Never-Sleeps layout, so they need an era-appropriate pack; current-pack comparisons differ by up to ~1280 units even after the shift.
5. **`m_bAlive` is unusable** on the controller (constant 0); use pawn `m_lifeState` + health.
6. **Powerups** are only visible when the spawner is in PVS; the primary match never spawned one. Rifts are driven by `CCitadelGameRulesProxy`, and `m_vKothCashInCurrentLocation` must not be offset.

## 11. Artifacts
Probe crate: `/tmp/mapcro-demo-explore/probe`; raw outputs: `/tmp/mapcro-demo-explore/out/{122134063,108440637,100747544}/`; helper scripts: `coordcheck.py`, `oldcheck.py`, `summary.py`, `powercheck.py`.

## Follow-up (2026-11-08, second pass, partly static: the box was busy, so no new parse ran)


**Date:** 2026-11-07 · **Scope:** 122134063 + 108440637, read-only · **Output:** `/tmp/mapcro-demo-explore/out2/`.

**Status:** the shared box stayed busy for this whole pass (`/tmp/mapcro-busy.sh` returned 0; another project's verify ran, load 12–20). Per the rules I did **not** start a new build or parse. The lane-front numbers below are re-analysed from the earlier 1 Hz `out/122134063/troopers.csv`; items 3–7 are from boon 0.19 source, with the exact classes/fields named. The `explore2` binary is drafted but uncompiled.

## Clock correction

The corrected match clock is

`game_time_s = (tick + server_start_tick − total_paused_ticks) × 0.015625 − m_flGameStartTime`

- 122134063: `server_start_tick = 3121` → **+48.77 s**; recording end moves from 881.234 s to **930.0 s**. The game itself ends earlier when `m_pGameRules.m_iWinningTeam` is set (≈890 s); the recording runs ~40 s past it, so the east rift spawner is post-game.
- 108440637: `server_start_tick = 2460` → **+38.44 s**; add the same term, and subtract `m_nTotalPausedTicks` (586 ticks = 9.16 s).
- Use `m_iWinningTeam` for the real end; `playback_time` is the recording length, not the match length.

## 1. Lane creep detail

**Available.** Class `CNPC_Trooper`; fields `m_iHealth`, `m_iMaxHealth`, `m_iTeamNum`, `m_iLane`, `m_lifeState`, and position via `CBodyComponent.m_skeletonInstance.m_vecOrigin.m_cellX/Y/Z` + `.m_vecX/Y/Z`. Every tick (64 Hz); boon's Python `troopers` dataset emits alive troopers per tick (~5M+ rows for a full match, opt-in). `CNPC_TrooperBoss` is tracked separately as `trooper_boss`.

**Empirical (122134063, earlier 1 Hz pass):** 12,017 rows, lanes 1/4/6, teams 2/3; only **750 of 901 seconds** had any trooper in PVS.

**Lane front.** Method: project each trooper onto our pack zipline polyline for its lane (`pack.json` `zipline` nodes), take the closest cross-team pair in arc length, and use the midpoint. Results (1 Hz, only seconds where both teams are present):

| Lane | Seconds with front | Median cross-team gap | Raw p95 1 s jump | 5 s median p95 jump | Max jump |
|---|---|---|---|---|---|
| 1 | 362 | 706 units | 1129 units | 801 units | 5053 units |
| 4 | 301 | 553 units | 869 units | 710 units | 3821 units |
| 6 | 63 | 3444 units | 1689 units | 1023 units | 4629 units |

- The front is computable but **not robust raw**: wave deaths/spawns make the closest pair jump by 1–5k units. A 5 s median smooth helps, but lane 6 is too sparse (63 s).
- **Wave composition:** count rises are +3 troopers at ~1152-tick (**18 s**) cadence on lanes 1 and 4 (e.g. lane 1 at ticks 10305, 11457, 12609…). That is consistent with 3-trooper waves, but first-seen counts are PVS-limited and cannot prove true spawn composition.
- Files: `out2/122134063/lane_fronts_from_prior.csv`, `lane_fronts_arc.csv`.

## 2. Player health, max health, barrier

**Available:** `CCitadelPlayerPawn.m_iHealth` and `m_iMaxHealth`, every tick. Earlier 1 Hz output: 6,727 hero rows, health 0–5,872, max health 730–5,871, 101 dead rows. Health/max health are reliable.

**Barrier is not a direct pawn field.** boon derives it from the `ActiveModifiers` string table: entry `modifier_barrier_tracker` (modifier_subclass `4267845006`), `float1` = capacity, `float2` = remaining. The Rust route is `Parser::visit_modifier_changes`; boon Python exposes it as `player_ticks.barrier`. We did not implement it in this pass.

**Shields** appear only in damage events (`CCitadelUserMsgDamage` / `CMsgCitadelUserMsgDamage`): `victim_shield_new`, `victim_shield_max`, `damage_absorbed`. There is no continuous per-player shield field in `player_ticks`; the shield columns are per-hit snapshots.

## 3. Items

**Available.** Current inventory: `CCitadelPlayerController.m_PlayerDataGlobal.m_vecUpgrades` (`CNetworkUtlVectorBase<CUtlStringToken>`), readable with `boon::replay_inputs::UpgradeReader`. It returns the current item/ability tokens each tick.

**Purchase/sell events:** `KEUserMsgAbilitiesChanged` (msg_type **309**, `CCitadelUserMsgAbilitiesChanged`): `purchaser_player_slot`, `ability_id`, `change` (`purchased`, `upgraded`, `sold`, `swapped`, `leveled_up`, `failure`). Also `CCitadelUserMessageItemPurchaseNotification` (msg_type **360**): `userid`, `ability_id`, `sell`, `quickbuy`. boon's Python `item_purchases` dataset uses 309 and emits `tick, steam_id, hero_id, ability_id, change`.

**Names:** the demo gives **MurmurHash tokens / ability ids only**, not display names. Map them with the game's item data / boon-data catalog (`abilities.json`), keyed by client build. The demo does not carry the item names in a usable form.

## 4. Soul investments

**Partially available.** `CCitadelPlayerPawn.m_nCurrencies` and `m_nSpentCurrencies` are `int32[6]` arrays. boon exposes element 0 as `souls` and `spent_souls`; the earlier 122134063 pass read souls 0–48,000 but **`spent_souls` was 0 on all 6,727 rows**, so element 0 is not a reliable “spent” total in that demo.

Net worth split: `CCitadelPlayerController.m_PlayerDataGlobal.m_iGoldNetWorth` and `m_iAPNetWorth` are available. No weapon/vitality/spirit category field was found in boon source or docs. A category breakdown would have to be derived from `m_vecUpgrades` + item costs/classification from game data; the demo itself does not label the three categories.

## 5. Neutral camp state

**Class:** `CNPC_TrooperNeutral` (boon also mentions `CNPC_TrooperNeutralNodeMover`). Fields: `m_iHealth`, `m_iMaxHealth`, `m_iTeamNum`, `m_lifeState`, position via the same body-origin path. boon's Python `neutrals` dataset emits a row only when an alive neutral's state changes (health/position), not every tick.

**Camp spawner / respawn timers:** no camp-spawner class or respawn-time field was found in boon's neutral code. `m_flRespawnTime` exists on player pawns, not camps. So “camp cleared + next respawn” is not directly exposed; you can infer alive/cleared from neutral health/lifestate near the camp site, but not the timer.

**PVS caveat:** our earlier 4-tick class census of 122134063 showed `CNPC_Neutral_Bug` and `CNPC_Ratking_Rat`, but **not** `CNPC_TrooperNeutral`; camps out of player vision are absent. This needs a full-match census on a demo where players actually visit camps.

## 6. Vision

**Team minimap FOW is available.** `CCitadelTeam.m_vecFOWEntities` is an array of `FOWEntry` with:

| Field | Meaning |
|---|---|
| `m_nEntIndex` | source entity index |
| `m_nTeam` | target team |
| `m_eClass` | icon class; `1` = enemy hero |
| `m_bVisibleOnMap` | whether the icon is shown |
| `m_nPositionX`, `m_nPositionY` | minimap coordinates 0–255, only while shown |
| `m_nTickHidden` | recorded hidden-tick value; units not converted |

boon's `EnemyMinimap` / `enemy_minimap_ticks` reads these and emits `observer_team`, `target_team`, `target_hero_id`, `target_steam_id`, `visible_on_map`, `map_x/y`, `last_seen_tick/x/y`. This is **team-level enemy-hero minimap visibility**, not full FOV, line-of-sight, wards, or creep visibility. No per-entity `m_iTeamVisibility`-like field was found in boon's code.

## 7. Ability and item usage events

**Yes, ult casts are events on top of cooldown fields.** `KEUserMsgImportantAbilityUsed` (msg_type **365**, `CCitadelUserMessageImportantAbilityUsed`): `player` (handle), `caster` (handle), `ability_name` (string). boon's Python `abilities` dataset emits `tick, hero_id, ability`. The controller also has `m_PlayerDataGlobal.m_bUltimateTrained`, `m_flUltimateCooldownStart`, `m_flUltimateCooldownEnd`; `ability_ticks` tracks cooldown/charge changes, `ability_upgrades` tracks skill points.

Item events are the 309/360 messages above. All events are at their event tick; entity fields are 64 Hz, so 1 Hz downsampling is a choice, not a limit.

## Update frequency summary

| Data | Source | Rate |
|---|---|---|
| positions, health, souls, cooldowns | entity fields | every tick (64 Hz) |
| trooper/neutral state | entity fields | every tick; boon `troopers` per tick, `neutrals` on change |
| item inventory | `m_vecUpgrades` | every tick |
| purchases/sells, ability casts | user-message events | event tick |
| FOW icons | `CCitadelTeam.m_vecFOWEntities` | every tick |

## Blocked / next

- **Blocked by shared box:** `/tmp/mapcro-busy.sh` stayed 0 (another project's verify) with load 12–20; no new build or parse was allowed. The `explore2` binary (barrier timeline, item tokens, soul arrays, neutral/camp matching, FOW, event decode) is drafted but not compiled; build with `cargo build --release -j 2` and run on 122134063/108440637 once the box is free.
- Highest-value follow-ups: run `explore2` on both demos; full-match neutral class census; confirm whether `m_nSpentCurrencies` elements 1–5 are ever nonzero; map item tokens with boon-data.

## Files

`out2/122134063/lane_fronts_from_prior.csv`, `out2/122134063/lane_fronts_arc.csv`; analysis scripts `lane_prior.py`, `lane_arc.py`, `front_smooth.py`, `health_prior.py`; probe source `probe/src/bin/explore2.rs`.

## Round 3: jungle camps (2026-11-08)

**Date:** 2026-11-08 · **Scope:** read-only, every-tick probe of every entity class · **Probe:** `/tmp/camp-probe` (`src/main.rs`, `src/bin/mode.rs`, `py/*.py`) · **Output:** `/tmp/camp-probe/out/{129738985,108440637,122134063}/`.

### Verdict

**Camp state is fully available on current builds, with or without vision.**

The game rules carry one respawn timer per camp. These timers are networked every tick, whatever the players can see, and their origins match our pack's 51 camp sites **at 0.0 units**. The neutral entities are networked the whole match as well, so partial clears are visible too. On the older build 6701 the timer vector doesn't exist yet. There, the alive/cleared state still comes from the FOW camp icons and the entity lifecycle, but the respawn time has to be inferred.

**Correction to round 2 §5.** 122134063 is a **Street Brawl** demo (`m_pGameRules.m_eGameMode = 4`; boon's `game_modes.rs` gives 1 = `6v6`, 4 = `street_brawl`). Brawl has no camps: `CNPC_TrooperNeutral` is in the class table but never instantiated in any of its 57,615 ticks, and all 52 timers stay −1 until the post-game. The "missing" neutrals were the game mode, not PVS. Brawl demos must be excluded from camp, lane and trooper analysis, and probably from the 6v6-only tier altogether. The other demos checked are all 6v6 (`m_eGameMode = 1`): 129738985 (build 6839, current map), 108440637 (6701), 107550569 (6698) and 106114966 (6694).

### 1. Full-match class census (every tick)

**129738985** (6v6, build 6839, 173,229 ticks, game ends at 2640 s, recording ends at 2680 s). Columns: first and last seen as match-clock seconds, max simultaneous `active` count, distinct `(index, serial)`.

| Class | First | Last | Max active | Distinct | Note |
|---|---|---|---|---|---|
| `CNPC_TrooperNeutral` | 120.0 s | end | **138** (146 in container) | **146** | the camp creeps; the same entity respawns in place |
| `CNPC_Neutral_SinnersSacrifice` | 480.0 s | end | 15 | 15 | the `vaults` tier (first spawn and respawn match the vault timers) |
| `CCitadelItemPunchableNeutralGold` | 407.9 s | 2489 s | 2 | 29 | gold drop from vaults, transient |
| `CNPC_MidBoss` | start | 2388 s | 1 | 2 | also has timer slot 1 (below) |
| `CNPC_Neutral_Bug` | start | end | 60 | 76 | ambient critters, not camps |
| `CItemXP` | 32 s | end | 17 | 71 | soul orbs |

- Present in the schema but **never instantiated**: `CNPC_Neutral_Flying_Pigeon`, `CNPC_Neutral_Hideout_Cat`, `CNPC_Neutral_Hideout_Rabbit`, `CNPC_Neutral_SinnersSacrifice_Hideout`, `CTriggerNeutralShield`.
- `CNPC_TrooperNeutralNodeMover` is **not in the schema at all** (build 6839).
- No class has "Camp", "Jungle" or "Spawner" in a camp sense. The map's `info_neutral_trooper_camp` is server-only: its FOW entries point at entity indices that are never networked.
- **108440637** (6701): `CNPC_TrooperNeutral` 146 distinct, max 113 active, first at tick 9603; `SinnersSacrifice` 12; `PunchableNeutralGold` 17. The shapes match 129738985.

### 2. Camp state: `CCitadelGameRules` timers

Fields on `CCitadelGameRulesProxy`, all three of length 52:
- `m_pGameRules.m_vecNeutralCampTimerOrigins`: `VectorWS`, world coordinates, no cell decoding.
- `m_pGameRules.m_vecNeutralCampNextSpawnTimes`: `float32`.
- `m_pGameRules.m_vecNeutralCampTimerIsMidBoss`: `bool`.

Element paths are `<field>.<i>`.

**Index → pack key.**
- Slot 0 is `camp:neutral:lane0:1`.
- Slot 1 is the **mid boss**: origin (−2, −1, −832), `IsMidBoss = true`.
- Slot *i* ≥ 2 is `camp:neutral:lane0:<i>`.
- All 51 origins sit 0.0 units from our pack sites, in both 122134063 and 129738985.

**Semantics** (checked against the entities):
- `NextSpawnTimes[i] = −1` means the camp is alive.
- A value *T* > 0 means the camp was cleared and respawns at *T*.
- At tick 2 every slot is set to its first spawn time. It goes back to −1 on the spawn tick, and is set to *T* on the tick the last creep dies.
- *T* is already in match-clock seconds: camp 3 has *T* = 480.000 and spawns at 480.05 s on the corrected clock. It isn't `GameTime_t`, so don't subtract `m_flGameStartTime`, and pauses are already taken out: this match paused for about 26.6 s between 150 s and 273 s, and the 480 s spawn still lands on the pause-corrected clock.
- **Clear tick vs. the last member's death:** −1 tick in 112 cases, 0 in 57, of 186 that could be matched. The rest are entity-to-camp mismatches.

**Timings** from 129738985, constant per tier:

| Tier (pack) | First spawn | Respawn after clear |
|---|---|---|
| weak | 120 s | **85 s** (48/48) |
| medium | 300 s | **290 s** (89/89) |
| strong | 480 s | **335 s** (35/35) |
| vaults | 480 s | **300 s** (53/53) |
| mid boss (slot 1) | at start | 420 s, then 360 s (`k_EUserMsg_MidBossSpawned` at tick 147931 matches) |

**Counts (129738985):** 278 clears and 278 respawns over 52 slots, 2–16 clears per camp, about 5.4 per camp on average. Weak camps 45 and 50 are cleared 16 times each.

**Sample timeline.** Camp `camp:neutral:lane0:3` (strong, 3 creeps). The alive count comes from the entities, the timer from the rules.
```
   0.00 s  timer next_spawn=480.0          (not yet spawned)
 480.05 s  alive 3/3, timer -1             (spawned)
 665.28 s  alive 2/3
 673.22 s  alive 1/3
 677.44 s  alive 0/3, timer 1012.4         (cleared; respawn = clear + 335 s)
1012.45 s  alive 3/3, timer -1             (respawned)
1029.38 s  alive 2/3  ...  1048.03 s  alive 0/3, timer 1383.0
1383.05 s  alive 3/3, timer -1
```

**Partial clears** (member alive count between 0 and full):
- 961 intervals, median **0 s** (several creeps die on one tick), p90 2.2 s; only 12 last more than 30 s.
- **Members per camp:** usually 3 `CNPC_TrooperNeutral`; tiers vary. A creep's `m_iMaxHealth` grows with match time (camp 3's big creep goes 1455 → 2057 over the match).
- **Assignment method:** each creep is assigned to its camp by matching its (re)spawn tick to the camp's timer spawn tick, then taking the nearest origin. Nearest-site clustering alone is unreliable, because some sites are only about 550 units apart.

### 3. Visibility

**This 6v6 recording is not PVS-limited for camps (or heroes).**
- `Entity.active == false` on a neutral means **dead and dormant**, not out of view.
- **No out-of-view dormancies:** of 622 neutral dormancies in 129738985, **0** happened at full HP. 428 happened at 0 HP. The other 194 kept a stale positive HP, because the killing blow and the dormancy land on the same tick. Treat an inactive neutral as dead and ignore its `m_iHealth`.
- **Re-entries are respawns:** all 614 reactivations come back at full HP on the camp's respawn tick.
- **Distance from heroes doesn't matter:** in camp-seconds where the timer says alive, ≥1 alive creep was networked in 16,094/16,099 with the nearest hero under 2000 units, and in **8,499/8,550 with the nearest hero over 5000 units**.
- **Heroes:** all 12 `CCitadelPlayerPawn` are active in every second.
- **Lane troopers** are present in every second.
- The stream has `hltv_versioninfo`, so this is a full-world HLTV-style recording.
- 108440637 matches: 2 of 447 neutral dormancies at full HP, and 0 re-entries below full HP.
- **Caveat on earlier PVS claims:** §5 and §10's PVS caveats came from the Brawl demo and the two old demos, and should be rechecked against this result.

**FOW.**
- `CCitadelTeam.m_vecFOWEntities` holds **52 camp icons** in every team's list, with `m_eClass` by tier: 34 = weak (4), 35 = medium (24), 36 = strong (12), 37 = vaults (11), 38 = mid boss (1).
- Their `m_nEntIndex` points at the never-networked `info_neutral_trooper_camp` entities. `m_nPositionX/Y` are 0–255 minimap coordinates.
- **`m_bVisibleOnMap` is the camp-alive flag, not team vision:**
  - It toggles exactly 277 times for teams 1, 2 and 3 alike.
  - Each toggle lands within about one second **after** the matching timer transition (244 spawn and 199 clear toggles 1–64 ticks later, 27 more within ±1 tick).
- No FOW entry references a `CNPC_TrooperNeutral`.
- On 6701 the same icon classes exist and toggle (193 per team, identical across teams). That is the **only** camp-state signal on that build besides the entities.

### 4. Other signals

- **Who took the camp:** `k_EUserMsg_CurrencyChanged` (msg 345, `CCitadelUserMsg_CurrencyChanged`). `currency_source = 15` with a `victim` handle that resolves to `CNPC_TrooperNeutral`, plus `userid` (player slot), `delta` (souls), `victim_pos`. 632 such events per currency type (0 and 3) in 129738985. That gives the killer slot, and so the team, per creep. The team mapping isn't checked against every clear yet. This message isn't in 108440637.
- **Per-player neutral soul totals:** `CCitadelPlayerController.m_PlayerDataGlobal.m_iCreepGoldNeutral`, in both builds.
- **No dedicated event:** there is no camp-cleared or camp-spawned game event or user message. The only spawn-type message is `k_EUserMsg_MidBossSpawned` (349).
- **Soul drops:** `CItemXP` (soul orbs) and `k_EUserMsg_SoulBagPickup` show up near kills, but they aren't camp-specific.

### 5. Cost

- **Events:** per-camp state is about **5.4 clears per camp per match** (278 in a 44-minute game). Each clear's respawn time is known when it happens, so the respawn needn't be stored separately.
- **As JSON:** `camps: [{key, cleared: [[clear_s, respawn_s], …], by_team?: […]}]` is roughly **5–6 KB** per match uncompressed, about 1% of the current timeline.
- **Partial-clear alive counts** would add about 1,400 member changes (about 12 KB). Partials are brief (p90 2.2 s), so skip them.
- **Parse cost:** the full probe (every class, every tick) took 163–340 s under load. A production pass needs only `CCitadelGameRulesProxy`, which the parser already reads, so the timer vector costs almost nothing extra: 52 keys per tick, resolved once.

### Recommendation for the replay tier

1. **Builds with the timer vector (current: 6813 and 6839 have it, 6701 doesn't):** from `m_vecNeutralCampNextSpawnTimes` emit, per pack camp, the intervals (`cleared_s`, `respawn_s`), plus each camp's first spawn time. On the board, a camp is **alive** (−1 after its first spawn), **cleared, back at T** (show a countdown), or **not yet spawned, at T**. This is exact, applies to every camp all match, and doesn't depend on vision. Take the slot → key mapping from the origins, matched within a few units, rather than hard-coding the index order. Treat slot 1 (`IsMidBoss`) as the mid-boss respawn timer.
2. **Optional:** the clearing team, from `CurrencyChanged` source 15 → victim → userid slot → team.
3. **Older builds (< about 6813):** take alive/cleared from the FOW camp icons' `m_bVisibleOnMap` (up to about 1 s late) or from the entity lifecycle, and **infer** the respawn from the per-tier delays above. Mark it as inferred, because those delays may differ by patch.
4. **"Unknown" isn't needed on 6v6 recordings like these**, because every camp's state is known all match. Keep the mode check (`m_eGameMode`) in front: reject or tag Brawl, which has no camps.
5. Ignore partial clears and the stale `m_iHealth` on dormant neutrals.

## Round 4: ziplines and lane state (2026-11-08)

**Scope:** read-only probe of 129738985 (6v6, build 6839) · **Probe:** `/tmp/camp-probe/src/bin/{schema,zip}.rs`, `py/zip{1..5}.py` · **Output:** `/tmp/camp-probe/out4/129738985/`.

### Verdict

**The replay networks the actual zipline ownership state.** It lives on the zipline node entities: `CCitadelZipLineNode.m_iTeamNum`, with one entity per rope node.

Our trooper-front estimate measures something else. The front is where the waves meet. The zipline colour is **captured territory**:
- A node takes a team's colour when that team's trooper reaches it.
- It turns neutral when an enemy trooper reaches it.
- It keeps its colour after the troopers die.
- An uncoloured gap often separates the two teams.

That explains replay-tier's result: our split stays between the trooper fronts 100% of the time, yet doesn't match the game.

### 1. Candidates (full serializer dump, 99,060 field paths)

| Class / field | Type | Networked? | Behaviour |
|---|---|---|---|
| **`CCitadelZipLineNode.m_iTeamNum`** | uint8 | yes: 334 entities, every tick, all match | **2 amber, 3 sapphire, 0 neutral**; 4 for the middle nodes before the game. 6,591 changes in the match. |
| `CCitadelZipLineNode.m_iPrimaryLane` | int16 | yes, static | 1, 4 or 6, the same codes as troopers' `m_iLane`. `CMsgLaneColor` gives 1 yellow, 4 blue, 6 purple. |
| `CCitadelZipLineNode.m_flCumulativeDistance` | float32 | static | Distance along the rope from the amber end: lane 1 is 30,706 long, lane 4 23,954, lane 6 31,122. |
| `CCitadelZipLineNode.m_iNodeIndex`, `m_vecConnections` (handles), `m_vecConnectionDir`, `m_bCornerNode`, `m_bCapturable`, `m_vTangentIn/Out` | — | static | Each lane is one chain with 2 endpoints. `m_iNodeIndex` ≥ 0 marks the named nodes. |
| `CCitadelZipLineNode.m_hGuardingBosses` | vector of handles | changes on boss death | The guardian, walker or base guardian pair bound to a node. It empties on the `k_EUserMsg_BossKilled` tick. |
| `CCitadelZipLineNode.m_eCaptureState` | int16 | yes | **Always 0**, so not used. |
| `CCitadelZiplinePath` (`m_PathNodes_Color`, `m_PathNodes_Position`, …) | — | **not networked** (0 instances) | The client builds the rendered rope. |
| `CCitadelPlayerPawn.m_eZipLineLaneColor` | `CMsgLaneColor` | yes | The lane colour the hero is riding, 0 when off a rope. Riding only, not lane state. |
| `CCitadelPlayerPawn.m_nDeducedLane`, controller `m_nAssignedLane` / `m_nOriginalLaneAssignment` | int | yes | Player lane assignment. |
| `CAssignedLaneParticle` | `m_iLane`, `m_iTeamNum` | 6 static entities at the spawns | Cosmetic. |
| `CCitadelTeam.m_vecFOWEntities[].m_iLane` | int32 | yes | Objective icons' lane, not segments. |
| `CCitadelTeam.m_nBaseGuardianLanesCleared` | int32 | yes | A count only. |

Nothing named Push, Front, Progress or Territory exists for lanes. `m_flCaptureProgress` belongs to the rift (`CCitadelTriggerCapturePoint`, `TeamKothState_t`).

### 2. How the node state maps onto our lanes

- **Positions match our pack exactly.** Node world positions run through `map::world_to_map` and `Lane::project` sit **0.0 map units** from our pack lane polylines (max 0.1), and `t` runs monotonically from **0 at the amber end to 1000 at the sapphire end** on all three lanes. Our pack lanes are these node chains, so a node's `t` is exact.
- **Ownership is always contiguous.** In every one of 2,641 seconds × 3 lanes, the run along each lane is one amber block, then a neutral block (possibly empty), then one sapphire block. Each lane therefore reduces to two numbers:
  - **amber edge** = the max `t` of team-2 nodes
  - **sapphire edge** = the min `t` of team-3 nodes
- **No colour passes a living guardian.** Neither edge ever passes a node whose `m_hGuardingBosses` is still non-empty and that started on the other side (0 violations in 7,923 lane-seconds). Guardians and walkers hold the line until they die.
- **What flips a node** (nearest unit at the flip second, from 1 Hz trooper positions):
  - **To a team:** that team's trooper at a median 250 units (87% within 1000). The enemy is at a median 2,530.
  - **To neutral:** an enemy trooper at a median 233–241 units (87–91% within 1000).
  - Troopers capture nodes by walking over them. Heroes aren't the cause: the nearest own hero was within 1000 units in only 52% of flips.
- **A neutral gap wider than 60 `t`** is present in 807 (lane 4), 932 (lane 1) and 1,123 (lane 6) of 2,641 seconds.
- **At the start of the match**, the middle nodes are team 4 (neutral) until about 300–600 s, when the first waves reach and capture them.

**Sample, lane 4** (`t`, amber edge / sapphire edge):

| Time | Amber edge | Sapphire edge |
|---|---|---|
| 0 s | 425 | 574 |
| 600 s | 574 | 587 |
| 900 s | 532 | 543 |
| 1200 s | 574 | 663 |
| 1350 s | 631 | 671 |
| 1800 s | 425 | 435 |
| 1950 s | 291 | 311 |
| 2250 s | 247 | 280 |
| 2550 s | 740 | 753 |

The full series is in `out4/129738985/zip_edges_t_1hz.csv`.

### 3. Our trooper-front estimate against the real state (1 Hz, arc length in world units along the node chain)

| Lane | 5 s closest-pair median vs. the gap midpoint: median \|err\| | p90 \|err\| | Inside the true [amber edge, sapphire edge] ±200 |
|---|---|---|---|
| 1 | 882 | 5,185 | 52% |
| 4 | 585 | 4,301 | 53% |
| 6 | 1,018 | 4,779 | 56% |

The furthest trooper of each team, compared with that team's own edge, does no better: median 636–1,143, p90 4.1–6.5k. Trooper positions can't give the colour, because the colour remembers captures after the wave dies or retreats. Waves are gone from a lane for long stretches, and the colour still shows the last capture.

The per-second comparison is in `out4/129738985/lane_compare_1hz.csv`.

### 4. Cost

- **Change rate:** the pair (amber edge, sapphire edge) changes in about **1,200 of 2,641 s per lane**, roughly every 2 s.
- **As per-second arrays** (like `WaveTrack.t`): 2 × u16 per lane per second, about 16k numbers, about **60 KB** of JSON per match uncompressed.
- **As change events** `[s, amber_t, sapphire_t]`: about 3,600 entries, about **50 KB**.
- **Either way, it compresses well:** the values are small and change slowly.
- **Parse cost:** adding `CCitadelZipLineNode` to the class filter costs little. The whole probe (nodes, pawns, bosses, rules) ran in 17 s for the 504 MB demo. Each tick needs one `m_iTeamNum` read per node (334). Resolve `t` per node once, from its position at signon.

### 5. Older build

108440637 (build 6701) has the same mechanism, with coarser ropes: 136 nodes (46, 44 and 46 per lane), 1,867 `m_iTeamNum` changes, and the same contiguous amber / neutral / sapphire runs, with team 4 in the middle before the game.

Its positions need the pre-6712 +16384 offset. The lanes belong to the old layout, so projecting onto our current pack isn't valid there; the worker rejects those builds anyway.

### Recommendation for the worker

1. Add `CCitadelZipLineNode` to the class filter.
2. At the first tick, for each node, read its body-origin position, `m_iPrimaryLane` (1/4/6 → `lane1/4/6`) and `m_iTeamNum`. Compute its `t` once with `Lane::project(world_to_map(x, y))`.
3. Each second, for each lane, emit `amber_t` = the max `t` of nodes with team 2 (0 if none) and `sapphire_t` = the min `t` of nodes with team 3 (1000 if none). Nodes with team 0 or 4 are uncoloured.
4. Store this as a new per-lane track. It doesn't replace `WaveTrack`, which stays the wave position.
5. The board then colours each lane amber over [0, amber_t] and sapphire over [sapphire_t, 1000], and leaves the gap uncoloured. This is exact, needs no smoothing, and has no PVS caveat.
6. Drop the trooper-front estimate as the source of the zipline split.

## Round 5: respawn timers (2026-11-08)

**Scope:** read-only probe of 129738985 (6v6, build 6839) · **Probe:** `/tmp/camp-probe/src/bin/urn.rs` · **Output:** `/tmp/camp-probe/out5/129738985/respawn.csv` (no ids).

### Verdict

**The pawn carries the respawn time.** `CCitadelPlayerPawn.m_flRespawnTime` (`GameTime_t`) is set on the death tick and reads 0 while alive. It is on the same clock as the parser's `now` (pause-corrected `(tick + server_start_tick − paused) × interval`), so match second = death second + (`m_flRespawnTime` − `now`). `m_flDeathTime` is set on the same tick.

| Field | Behaviour |
|---|---|
| `CCitadelPlayerPawn.m_flRespawnTime` | the respawn time while dead, 0 alive |
| `CCitadelPlayerPawn.m_flDeathTime` | the death time; kept after the respawn |
| `CCitadelPlayerController.m_flRespawnTime` | **always 0**: unused |
| `CCitadelPlayerController.m_iDeaths` | the death count |
| `k_EUserMsg_PlayerRespawned` (353) | `player_pawn`, `respawn_reason`; 75 in the recording |
| game rules | no respawn array (`m_flHeroDiedTime` only) |

**Checks** (to the end of the recording, the four 3 s revives in place aside):
- The recording shows **71** respawns. **70** land within 0.1 s of the timer's last value.
- In one of those 70 the timer itself moved: it dropped by 20 s a tick after the death.
- The exception: a hero came back 20 s early with no change in the timer, in the last two
  minutes.
- **Explained (2026-11-08):** killing a Patron's first stage shortens the respawns of its
  team's dead (operator). On 129738985 Sapphire's Patron reached 0 at 2575 s (42:55;
  `objective_health` then shows stage 2 from 2588 s). Both odd respawns are Sapphire heroes dead
  at that moment: one died at 2557 s and came back at 2622 s (65 s, where its timer said 85 s;
  the timer didn't show the cut), and one died at 2575 s, whose timer dropped 20 s a tick later
  (2640 s, 65 s). Sapphire's hero who died at 2581 s, after it, waited the full 85 s, as did the
  Amber hero dead at the time. The worker's rule (next seen alive) already gets both right.
- The revives in place also set the timer.
- Wait lengths run 9.7–90 s.

**Rule used by the worker:** the second the hero is next seen alive, else (the recording ends first) the timer as last read while dead, rounded up. The timeline of 129738985 has 74 deaths, each with a respawn. Seven heroes are still dead when the game ends, and their respawns come from the timer.

### API-summary tier

**Available.** deadlock-api's match metadata (`CMsgMatchMetaDataContents.Deaths`) has `death_duration_s` next to `game_time_s`. On 130816395 every one of the 13 checked equals the length of the hero's zero-health run on its path, which starts one sample after the death (the server's `anchors` convention). The metadata timeline uses `[game_time_s, game_time_s + death_duration_s + 1]`.

## Round 6: the Soul Urn (2026-11-08)

**Scope:** the same probe and replay · **Output:** `/tmp/camp-probe/out5/129738985/{urn_entities,urn_pos,messages}.csv`.

### Verdict

**The urn's whole life is networked, at tick resolution.** The urn is the game's "idol".

| Class / field | Behaviour |
|---|---|
| `CCitadelItemPickupIdol` | the urn **on the ground**. Position via `CBodyComponent.m_skeletonInstance.m_vecOrigin`. A new entity on each spawn and each drop; deleted on pick-up. |
| `…PickupIdol.m_iTeamNum` | 4 on a spawn; on a drop, the dropper's team |
| `…PickupIdol.m_nCurrencyValue` | the reward: 950 at 10:00, then +350 a spawn (2,350 by 30:00) |
| `…PickupIdol.m_MoveType`, `m_flFallRate` | it spawns at z 1544 and falls at 112 u/s; `m_MoveType` 0 → 6 when it lands, 12.5 s later |
| `CCitadelIdolReturnTrigger` | the two **delivery points**, static, at (−6592, −8) and (6304, −96); no skeleton, so origin via `CBodyComponent.m_cell*`/`m_vec*` |
| `…ReturnTrigger.m_bDisabled` | false while that point is open. It opens as the urn lands, and closes on delivery. |
| `…ReturnTrigger.m_iTeamNum` | the **carrying team** while carried, 0 otherwise |
| map entity lump | `citadel_trigger_idol_return` × 2, at the same places; no separate spawn entity |
| `k_EUserMsg_ReturnIdol` (320) | in the proto (`location_index`, `return_location`, `location_enabled`), **never sent** in this demo |
| game rules | no urn fields: no next-spawn timer |

The spawn point is the point the urn isn't delivered to: it spawns over one trigger (11 units off) and the other one opens.

**State machine** (all 7 urns in 129738985):
- **Spawn:** a new idol, team 4, no point open: 10:00, then every 300 s, alternating west and east. Spawns kept to the 300 s grid whenever the last delivery was (one was delivered at 29:17, and the next still spawned at 30:00).
- **Landing:** the far point opens 12.5 s after the spawn.
- **Pick-up:** the idol is deleted, and the open point takes the carrier's team, on the same tick.
- **Drop:** the point's team goes to 0 and a new idol appears where it fell, team = the dropper's, on the same tick. The point stays open.
- **Delivery:** the point's team goes to 0, the point closes, and no idol appears.
- All seven urns were delivered, two of them after drops: 11 pick-ups, 4 drops and 7 deliveries.
- One urn drifted 700 units while nobody held it (28:13–28:28, with `m_nTeamBias` 3 then 4). The urn moves on its own after a while (operator, 2026-11-08); the drift is expected. The timeline records it as more `ground` places with no team, and Player glides between them; the carrier is only inferred at a pick-up, for the run to the next drop or delivery.

**Carrier.** No networked field names the carrier. boon's `urn.rs` follows the carrier's `m_HoldingIdolModifier` through the modifier table, but that needs boon-data's ability and modifier catalog, which we don't load. Instead the worker takes, at the pick-up tick, the carrying team's living hero nearest where the urn lay. Checked against what happened next:
- At all 11 drops and deliveries, that hero was 30–570 units from the event.
- At all 11 pick-ups, it was 78–490 units from where the urn lay.
- At deliveries, that hero was the nearest of its team every time.

**PVS:** none. The idol and triggers are present the whole match.

**Assets.** The pack already carries the urn's minimap art, because the extractor takes every `panorama/images/minimap/*`:
- `soul_jar_marker_psd`: the urn (`.idol_spawn`, `.held_idol_image`).
- `soul_jar_marker_return_psd`: the delivery point (`.idol_return`).
- `soul_jar_marker_return_enemy_psd` and `soul_jar_marker_return_pulse_psd` are also there.

The extractor now adds `citadel_trigger_idol_return` as kind `urn`. Its keys are `urn:neutral:lane1:1` (west) and `urn:neutral:lane6:1` (east).

**Cost:** about 60 state records a match, about 5 KB as JSON. Reading the idol and triggers every tick adds nothing measurable: the parse took 5.4 s, as before.

### API-summary tier

**Nothing.** `CMsgMatchMetaDataContents` has no idol or urn events. Only per-player `gold_sources` totals might include urn souls, and they carry no times. The metadata tier shows no urn.
