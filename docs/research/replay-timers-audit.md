# Replay timers audit: every timer in a Deadlock replay, against what mapcro shows

**Date:** 2026-11-08 · **Scope:** read-only. One parse of 129738985 (6v6, build 6839, 2,640 s of
match) that walked all 892 classes and every numeric field, plus every user message and game
event. The game's vdata was cross-checked. · **Tool:**
`crates/replay/examples/timer_audit.rs` (see "Rerun" below) · **Output:** `/tmp/mapcro-timer-audit/`
(not committed: it holds entity handles).

Earlier rounds are in [replay-parsing-exploration.md](replay-parsing-exploration.md): camps in
round 3, respawns in round 5, the urn in round 6, buffs and rifts in round 7.

## Verdict

**The operator's question was whether a replay shows every objective timer. Mostly yes, and
mapcro already uses most of the ones on the map.** Camps, the mid boss's respawn, rift
spawn/open, bridge buff spawns, urn spawns, hero respawns and ult cooldowns are all read and
shown.

The parse flagged **185 distinct field paths across 1,042 class/field rows**, by name (time,
spawn, cooldown, end…), by type (`GameTime_t`) or by value (they sit on a clock):
- About 750 of those rows are the same ability fields repeated on 101 ability and item classes.
- Most of the rest is engine bookkeeping: `m_flCreateTime`, animation and simulation times,
  glow and fog times.
- The value-only hits are nearly all false positives. Quantised coordinates (0–1024) happen to
  fall in the match clock's range.

**About 30 fields and 8 message types carry coaching meaning.** They are in the table below.

**The real gap is the mid boss's reward.** Killing the mid boss drops the **Rejuvenator**:
- The team that picks it up gets **3 revives in place**, and the buff **expires 180 s after the
  pickup**.
- The game rules count the revives that are left, per team.
- A message marks each pickup, use and expiry.
- mapcro shows none of this. Nothing in the repo mentions "rejuv".

The rift's **give-up deadline** and **live capture progress** are the next gap. Third is
**who holds a bridge buff, and for how long**.

## Clocks

- **`GameTime_t` fields** are on the server clock, the parser's pause-corrected `now`. In this
  match the match clock = `GameTime_t` − 69.16 (`m_pGameRules.m_flGameStartTime`).
- **Match-clock fields:** camp times (round 3) and `m_tNextMidBossSpawnTime` are already in
  match-clock seconds, despite the `m_t` prefix.
- **Ticks:** 64 per second. Game second = (tick − paused ticks) / 64 − 0.03 here. The single
  pause is 1,706 ticks at 2:28.

## The inventory

"Shown" means shown in mapcro (format 3, 2026-11-09, which covered gaps 1, 2 and 7; it was
format 2 at the audit): **yes**, **partial** or **no**. Values are illustrative, from 129738985, in match-clock seconds unless marked GT
(`GameTime_t`).

| Entity class / field | Meaning (evidence) | Sample values | Shown? | Recommendation |
|---|---|---|---|---|
| `CCitadelGameRulesProxy` `m_pGameRules.m_vecNeutralCampNextSpawnTimes[52]` | Each camp's next spawn: −1 while alive, *T* once cleared (round 3). Per camp. | 480 at start (strong); 677.4 clear → 1012.4; 557 changes | **yes** (`Camp.cleared`, hover "Respawns in…") | Keep. |
| same, slot 1 (`m_vecNeutralCampTimerIsMidBoss`) | The mid boss's respawn | 1864.7 kill → 2284.7 | **yes** (mid boss hover) | Keep. |
| `m_pGameRules.m_tNextMidBossSpawnTime` | The same time again, match clock. vdata: 420 s, then −60 s per kill, never below 300 s. | 2284.72 (kill 1 + 420), 2746.2 (kill 2 + 360) | yes (via slot 1) | No need: duplicates slot 1. |
| `m_pGameRules.m_iMidbossKillCount` | Mid boss kills so far | 1 at 1865, 2 at 2387 | no | Not a timer. Derivable from kills. |
| **`m_pGameRules.m_iAmberRejuvCount` / `m_iSapphireRejuvCount`** | **Revives the team has left from the Rejuvenator.** 3 on pickup; −1 per revive in place (a 3 s respawn, vdata `m_flRespawnDelay`); 0 when the buff expires. | Sapphire 3 at 1873, 2 at 1928, 1 at 1953, 0 at 2053 (= pickup + 180) | **yes** (format 3: `rejuv[].left`; top-bar badge, mid boss label) | Done. The count rises one per shard (1, 2, 3 within a second) and drops at the death a revive covers, 3 s before the revive message. |
| **`CCitadelItemPickupRejuv`** | The Rejuvenator drop: **3 entities** created on the mid boss kill tick; they fall (`m_flFallRate` 66.7 u/s, vdata drop 7.5 s) and are picked up | created 1864.7 and 2386.2 (= the kills) | **no** | Optional: show the drop on the map until it's picked up. |
| `m_pGameRules.m_timeKothCashInStarted` (GT) | The rift's cash-in opened (round 7) | 804.25 GT = 735.1 | **yes** (`Rift.live_s`) | Keep. |
| **`m_pGameRules.m_timeKothGiveUp`** (GT) | **The deadline to capture.** It is cash-in open + 60 s (vdata `citadel_koth_cashin.m_flTimeToGiveUp` 60; warning at 50). FLT_MAX until it opens; 0 once captured. | 864.27 GT = 804.25 + 60 | **yes** (format 3: `Rift.give_up_s`; hover "Gives up in 0:41") | Done. Set a tick after the cash-in opens. |
| **`m_pGameRules.m_vecTeamKothStates[#].m_flCaptureProgressFrac`, `.m_nCapturerCount`** | Each team's capture progress, 0–1, and how many are on the point (vdata: 12 s to capture, 6 favoured, 18 unfavoured) | 0.05 → 1 over about 40 s; up to 5 capturers | **yes** (format 3: `Rift.capture` at 2 Hz; a ring per team) | Done; index 0 is Amber, 1 Sapphire. The cash-in's first tick still holds the last rift's progress. Capturer counts not kept. |
| `m_pGameRules.m_timeKothScoring` (GT) | When the capture completed. Matches `TeamMsg` event 3 to the tick. | 847.77 GT = 778.6 | partial (`Rift.end_s` ends the rift) | Optional: name the capturing team (`m_nKothScoringTeam`, read already) on the rift event. |
| `CCitadelItemKothSpawner` (entity created) | Rift announced: **80.09 s** before the cash-in opens (round 7) | 655.0 → 735.1 | **yes** (`Rift.start_s`) | Keep. |
| `m_pGameRules.m_nAmberGold` / `m_nSapphireGold` | The rift's reward (souls); not a timer | 1482, 2814, 4368, 6144, 7254 | no | Optional, for the rift tooltip. |
| `CCitadel_PickupItemSpawner.m_tNextDropTime` (GT) | Next bridge buff drop. Wrong across a pause (round 7). | 338.86 GT, pushed to 369.16 GT at 270 s | yes (observed spawns are used instead) | Keep ignoring it. |
| `CCitadel_Pickup_Modifier.m_bActive`, `m_nSubclassID` | Buff up / taken, and which buff (round 7) | 16 spawns, 300 s grid | **yes** (`Powerup.spawns`) | Keep. |
| *(vdata only)* `<buff>_powerup_pickup` modifier, 160 s | **How long the taker keeps the buff.** No networked field: the hero's `ActiveModifiers` doesn't show it (round 7). | taken at *t* → ends *t* + 160 | **no** | **Gap 3.** Infer the taker (nearest hero at `taken_s`, the urn's method) and show a 160 s badge. |
| `CCitadelItemPickupIdol` (entity lifecycle), `CCitadelIdolReturnTrigger.m_bDisabled/m_iTeamNum` | Urn spawn, landing, carry, drop, delivery (round 6). Created at 600, then every 300 s. | `m_flCreateTime` 669.16 GT = 600 | **yes** (`Urn`) | Keep. |
| *(vdata)* `citadel_item_pickup_idol.m_WalkBackModifier.m_flWaitTimeLimit` 180 | **Explains round 6's "drift".** An urn left on the ground walks back after waiting (speed 2.0). | the 28:13–28:28 drift | **yes** (client: "Urn returns in m:ss", 180 s from landing or a drop) | Done. The 25:00 urn landed at 25:12.5 and set off at 28:13. |
| `CCitadelItemPickupIdol.m_nCurrencyValue` | The urn's reward | 950 → 3050 | no | Optional (not a timer). |
| `CCitadelPlayerPawn.m_flRespawnTime` (GT) | Respawn time while dead; 0 alive (round 5). | 427.3 GT at a 349 s death | **yes** (top-bar countdown) | Keep. |
| `CCitadelPlayerController.m_PlayerDataGlobal.m_flRespawnTime` (GT) | **The same value, on the controller.** This corrects round 5, whose "always 0" was about the controller's top-level `m_flRespawnTime`. | identical to the pawn's | yes (via the pawn) | Keep the pawn's. |
| `CCitadelPlayerPawn.m_flDeathTime`, `m_flLastSpawnTime` (GT) | Last death and last spawn | — | yes (deaths/respawns) | Keep. |
| `CCitadelPlayerController.m_PlayerDataGlobal.m_flUltimateCooldownStart/End` (GT) | Ult cooldown | 416.8 → 576.8 GT | **yes** (ult rings) | Keep. |
| `CCitadel_Ability_*` / `CCitadel_Item_*` / `CItem_*` / `CCitadel_WeaponUpgrade_*` `.m_flCooldownStart/End` (GT) | **Every ability's and active item's cooldown**, on its own entity (80 classes, about 22k changes) | e.g. an active item: 651.2 → 667.2 GT | **no** (ult only) | **Gap 4.** Per hero, the active items' cooldowns on hover. The owner link (`m_hOwnerEntity`) isn't checked yet. |
| same `.m_flChargeRechargeStart/End`, `m_iRemainingCharges` | Charge-based abilities' recharge | 9 classes | no | With gap 4. |
| same `.m_flCastCompletedTime`, `m_flChannelStartTime`, `m_flCastDelayStartTime` | Cast moments | — | partial (ult casts via `ImportantAbilityUsed`) | Low. |
| `CCitadelPlayerPawn.m_vecFullSellPriceAbilityUpgrades[#].m_unGameTimePurchased` (GT) | When each item was bought | 119.2 GT … | no | An event (item timings), not a timer. Low for a minimap. |
| `CCitadelPlayerPawn.m_tLastPlayerRevealTime` (GT) | Updated about every tick while visible (345k changes). Likely "last revealed to the enemy". **Unverified.** | — | no | Probe before use (gap 9). |
| `CCitadelPlayerPawn.m_sInCombat.{m_flStartTime,m_flEndTime,m_flLastDamageTime}`; `m_sPlayerDamageDealt/Taken.*` | In-combat window (end = last damage + 3 s) | 89.4 → 92.4 GT | no | Low (out-of-combat regen). |
| `CCitadelPlayerPawn.m_flTimeSlowedStart/End[4]`, `m_flPredTimeSlowed*` | Slow debuffs | — | no | Low. |
| `m_pGameRules.m_nPauseStartTick`, `m_fUnpauseRawTime`, `m_iPauseTeam`, `m_nTotalPausedTicks` | The pause: who paused, start and end | team 3, 2:28 → 2:52 | partial (the clock is corrected; no mark) | Optional: a "Paused (Sapphire)" event. Skipped in format 3 (needs new fields; low value). |
| `m_pGameRules.m_flGameStateStartTime/EndTime`, `m_flMatchClockAtLastUpdate`, `m_nMatchClockUpdateTick` | Game state and clock bookkeeping | end 2719.19 GT (post-game) | n/a | None. |
| `CNPC_TrooperBoss` / `CNPC_Boss_Tier2` / `CNPC_BarrackBoss.m_flFadeOutStart/End` (GT) | The death fade, 2 s after the kill | — | n/a | None (kills are already shown). |
| `CItemXP.m_timeLaunch`, `m_flAttackableTime`, `m_flEndAttackableTime` | Soul orbs' deny window (0.7 s) | — | no | None for a minimap. |
| `CCitadel_BreakableProp` (709), `CCitadelItemPunchableNeutralGold` (29) | Crates, statues and vault gold drops. **No timer field.** All 709 props are created before the horn and never deleted or change health; going dormant is only visibility (about 40 s out of view). No break is visible. | gold drops 408–2489 | no | Gap 6: not placeable from the replay (checked 2026-11-09). The map has no statue sites either. |
| `CCitadelZipLineNode`, `CCitadelTeam` | No timer fields (`m_iScore`, `m_nBossesAlive`… are counts) | — | — | — |
| `CNPC_Trooper` | **No wave timer field.** Entity slots are reused, so create times don't give the cadence either. | — | — | Out of scope. |

**Messages that carry timing** (all 34 types seen are in `messages.tsv`):

| Message | Timing content | Shown? | Note |
|---|---|---|---|
| **`k_EUserMsg_RejuvStatus` (350)** | `event_type` 4 = picked up (one per shard, 3 per kill), 5 = a revive used, 6 = expired. Expiry is exactly 180 s after the pickup: 1872.4 → 2052.3, and 2394.0 → 2574.0. `user_team` gives the team. | **yes** (format 3: `rejuv_*` events; `player_pawn` names the revived hero) | Gap 1: the event stream for the Rejuvenator. |
| `k_EUserMsg_BossKilled` (347) | `gametime` (GT) of every guardian, walker, shrine, base guardian, patron stage and mid boss kill | yes (from health) | Agrees with the health-based times. |
| `k_EUserMsg_MidBossSpawned` (349) | At 0 and 2284.7 = the timer | yes (timer) | — |
| `k_EUserMsg_HudGameAnnouncement` (363) | `#Citadel_HUD_Koth_Warning` **20 s before** each cash-in opens (715.1 → 735.1) | partial | mapcro already counts to `live_s`. |
| `k_EUserMsg_MusicQueue` (358) | `IdolAnnounce` at each urn spawn (and its drops); `KothAnnounce` with the warning; `RejuvDrop` on the mid boss kill | n/a | Redundant with the fields. |
| `k_EUserMsg_TeamMsg` (352) | `event_type` 1 = urn picked up, 2 = urn delivered (`killfeed_gold` ≈ its value), 3 = rift captured (= `m_timeKothScoring`) | partial (urn/rift from entities) | A cross-check, no new timer. |
| `k_EUserMsg_PlayerRespawned` (353), `k_EUserMsg_HeroKilled` (319, `respawn_reason`) | Respawn moments | yes (from pawns) | — |
| `k_EUserMsg_FlexSlotUnlocked` (356) | Flex slots unlocked by objective kills | no | Not a timer. |
| `k_EUserMsg_MapPing` (303) `cooldown_time`; `KillStreak` `duration`; `PostProcessingAnim`, `CameraController`, `ParticipantStartSoundEvent` `start_time` | Empty, or cosmetic | n/a | None. |

**Fixed schedules in the game data.** These come from the vdata at exact VPK paths, through the
extractor's VPK reader (`/tmp/powerup-probe/src/bin/vdata.rs`):
- `scripts/misc.vdata`:
  - `neutral_camp_*`: weak 120 + 85, medium 300 + 290, strong 480 + 335, vaults 480 + 300.
  - `neutral_camp_midboss`: at 0, then 420, −60 per kill, min 300.
  - `neutral_camp_bug`: 120 + 120 (ambient).
  - `citadel_item_powerup_spawner`: 300 / 300.
  - `citadel_koth_cashin`: capture 12 s (6 favoured, 18 unfavoured), warn at 50 s, give up at 60 s.
  - The idol's walk-back wait: 180 s.
  - `citadel_breakable_prop_drop_powerups` and `citadel_breakable_lion_statue`: first spawn 180,
    respawn 180.
  - Other breakables: 180 (base 5).
- `scripts/generic_data.vdata`:
  - `m_IdolParams.m_flIdolDropDuration` 12.5.
  - `m_RejuvParams`: buff 180 s (warning at 30 s), drop 7.5 s, 3 drops; respawn multiplier
    0.5 / 0.4 / 0.3; trooper health ×1.7 / 2.0 / 2.3.
  - `m_BreakableSpawnTimeDesc`: four groups, 180 + 180, 300 + 300, 600 + 180, 300 + 180.
  - `m_KothParams`: radii, particles and sounds only, **no rift schedule** (round 7).

All the camp, mid boss, buff and urn values agree with what the replay shows.

## Gaps, by coaching value

Format 3 (2026-11-09, journal 2026-11-09-rejuv-rift) covered 1, 2 and 7; 6 isn't possible from the
replay; 8 is skipped.

1. **Rejuvenator (mid boss reward).** *Done.* Read the rules' `m_iAmberRejuvCount` /
   `m_iSapphireRejuvCount`, plus `RejuvStatus` for pickup, use and expiry. Show:
   - on the mid boss tooltip and the team's top bar, "Sapphire Rejuvenator: 2 revives, ends in
     1:40";
   - events: "Rejuvenator taken", "revived", "expired".

   The respawn multiplier also changes respawn waits; the pawn's timer already reflects that.
   A few KB per match.
2. **Rift: give-up deadline and capture.** *Done (2 Hz, not 1 Hz: smoother, 2.7 KB).* Read `m_timeKothGiveUp` and `m_vecTeamKothStates[]`
   (progress, capturers). Show a ring on the open rift with each team's progress, and "Gives up
   in 0:41" on hover. Progress changes many times a second, so sample it at 1 Hz.
3. **Bridge buff holder and duration.** Infer the taker at `taken_s` (the urn's nearest-hero
   method) and show a 160 s badge on that hero's token: "Gun buff, 1:12 left". This is an
   inference with no field behind it, so check it against the API's per-player
   `power_up_buffs` counts.
4. **Active item / ability cooldowns.** These are on each ability entity
   (`m_flCooldownStart/End`, charges). Show them on a hero's hover: key actives only (an
   allow-list), not all 80 classes. Linking each ability to its hero is unverified.
5. **Rift warning (−20 s).** Already covered by counting to `live_s`. Nothing to do unless the
   board wants the game's own warning moment.
6. **Statues and breakables.** *Not from the replay: no break shows (above).* There is no field; the vdata gives 180 / 180. A statue's
   lifecycle (break → respawn) isn't probed yet. Medium-low value: the statues drop permanent
   stat pickups.
7. **Urn walk-back.** *Done (client side, from the urn's states).* Show a tooltip "Urn returning" after 180 s idle. This explains round 6's
   drift.
8. **Pause mark.** An event "Paused (Sapphire) 2:28–2:52".
9. **`m_tLastPlayerRevealTime`.** If it means "last seen by the enemy", it would give a vision
   layer. Unverified.

## Rerun after a game patch

```
/tmp/mapcro-scripts/gate.sh 1800 || exit 3
nix develop -c nice -n 10 cargo run -p mapcro-replay --release --example timer_audit -- \
  <a current 6v6 replay .dem> /tmp/mapcro-timer-audit
# then, fast (events only): decoded text of chosen message types, by tick
… --example timer_audit -- <replay.dem> /tmp/mapcro-timer-audit --messages 347,349,350,352,363
```

- **Cost:** the full walk took 754 s single-threaded on build 6839, about 150 MB of output, mostly
  `grid.tsv`. Run it alone, behind the gate.
- **Spotting a new timer:** diff the `class`/`field` columns of the new `candidates.tsv`
  against an old run. `hit` = N (name) / T (type); `clock_like` = values on a clock.
- **Ids:** the tool never reads U64 values or fields named steam / account / xuid. The outputs
  still hold entity handles, so keep them out of the repo.

## Unexplained

- **`m_tLastPlayerRevealTime`'s exact meaning** (gap 9).
- **Rejuv `event_type` 6 goes to 4 pawns per team, not all 6.** Perhaps only living heroes get
  it. Not checked.
- **How an ability entity links to its hero** (gap 4) isn't verified.
- **Message examples in `messages.tsv`** came out empty on this run. The tool's parser expected
  one-line debug text, and boon prints it multi-line. That's fixed, but the fix hasn't been
  rerun. `--messages` shows the full text.
