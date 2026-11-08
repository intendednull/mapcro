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
