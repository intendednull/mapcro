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
