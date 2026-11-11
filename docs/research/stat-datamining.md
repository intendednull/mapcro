# Deadlock hero-stat data-mining survey (2026-11-10)

Question: where can we get (a) stat formulas / stacking rules, (b) per-patch game data, (c) ground-truth
stat values, so mapcro can compute each hero's Tab-panel stats at any replay tick for the replay's patch?

## Outcome

- **Formulas.** No source is authoritative: Valve publishes nothing, and no one has reversed the server
  binary's stat code. Every public rule set comes from reading vdata enum names and checking them against
  in-game observation. Three independent open-source implementations exist. They mostly agree, and where
  they differ (spirit-power % stacking, CDR) a test is needed:
  1. **boon** (pnxenopoulos, MIT): 38 versioned rulesets. Most are cleanly specified, but its docs say
     several are unverified. It has no max-health, health-regen or bullet-damage ruleset.
  2. **deadlock-plus** (GPL-3.0): `hero-stats.ts` has a table mapping each `MODIFIER_VALUE_*` to a stacking
     kind (add / factor / percent / basePercent / stack), with in-game observations noted inline.
  3. **Ourokan/deadlock-damage-lab** (no license): `sim/deadsim/build.py` gives formulas for health, spirit
     power and weapon %, **fitted against 38,587 real in-game stat snapshots**.
  The Deadlock wiki (`Damage_Resistance`, `Spirit_Power`) is the shared human-written reference that all
  three cite or agree with.
- **Per-patch data.** Two good sources:
  - **boon-data**: 44 releases, 6711–6860, as hashed JSON built from GameTracking-Deadlock. MIT scripts;
    the data is Valve's.
  - **deadlock-api `/v1/assets/*?client_version=N`**: 875 client versions, 5044–6860. It serves structured
    heroes (starting_stats, level_info, standard_level_up_upgrades, scaling_stats, cost_bonuses) and items
    with tooltip templates resolved. It computes no stat totals. Note: `assets.deadlock-api.com` no longer
    resolves; the assets API now lives at `api.deadlock-api.com/v1/assets` (monorepo
    `deadlock-api/deadlock-api`, crate `crates/game-assets`, MIT).
  - The raw source of truth is **SteamTracking/GameTracking-Deadlock**: git history per build, with
    commits titled by client version, e.g. "6860 | 15 files". It also holds DumpSource2 schema dumps
    (`EStatsType.h`, etc.).
- **Validation data.** The best large-scale ground truth is **match metadata ("salts")
  `CMsgMatchMetaDataContents.Players.PlayerStats`**. Per player, about every 3 minutes, it records
  `max_health`, `weapon_power` (= weapon damage %), `tech_power` (= spirit power), `level`,
  `ability_points` and `net_worth`, next to the item purchase/sell timeline. That covers 3 of our panel
  stats for free across thousands of matches (deadlock-damage-lab used it). It does **not** cover resists,
  fire rate, CDR, lifesteal or move speed. For those, the options are sandbox screenshots like ours or a
  local server oracle: **Deadworks** (MIT, server-side modding framework, early development) can run a
  real dedicated server, where game code could be read directly. Deadworks runs the current build only.
- **Recommendation.**
  - Use boon-data or deadlock-api for per-patch data. deadlock-api has finer version coverage; boon-data
    has hashed, pinned artifacts that are already in use.
  - Port the stacking rules as a versioned rule table (boon's design), cross-checked against
    deadlock-plus's MODIFIER_VALUE table.
  - Validate health, spirit power and weapon % against salts PlayerStats over many matches. This is cheap
    and covers many patches.
  - Validate resist, fire rate and CDR with targeted sandbox screenshots.
  - Treat Deadworks as an optional oracle for later.

## Stacking rules found (with agreement)

| Stat | Rule | Sources |
|---|---|---|
| Bullet / spirit resist | positives: `1-Π(1-r)`; reductions combined the same way separately, then subtracted; can go negative. Hero innate + boon growth + spirit-scaled growth are **additive** to each other, forming one "innate" term that then stacks multiplicatively | wiki Damage_Resistance; boon `resistance.rs`; damage-lab `combine_resist`; deadlock-plus `stack` (observed "55% and 18% make 63%", Enchanter's Emblem). Note: an older wiki revision / a SteamDB mirror subtract shred before stacking. |
| Weapon damage % | additive sum (items + weapon investment bonus) | boon `weapon_damage.v1`; damage-lab (fit 72% exact); deadlock-plus `add` |
| Spirit power | `(boons*per_boon + spirit investment flat + item flat) * (1+%)`; percent sources: **multiplicative** per wiki and boon, **summed** per deadlock-plus | wiki Spirit_Power; boon `spirit_power`; damage-lab (74% exact, displayed floored) |
| Max health | `(base + boons*hp_per_boon) * (1 + vitality invest% + base-health% items) + flat item health`, then `* (1 + max-health% items)` (e.g. Glass Cannon) | damage-lab (72% within 1 HP); deadlock-plus (basePercent vs percent split; investment-on-item-health "unconfirmed") |
| Fire rate | positive bonuses add; slows multiply; floor -50% | boon `fire_rate.v1` |
| Clip size | `ceil((base+flat)*(1+Σ%))` | boon `clip_size` |
| Lifesteal (bullet/spirit) | multiplicative `1-Π(1-x)` | boon `lifesteal` |
| Ability CDR | multiplicative (`stack`), observed in game (Emblem 20s→11.4s) | deadlock-plus; boon has `cooldown_reduction.v1` |
| Item CDR | additive | deadlock-plus |
| Move speed | `(base+Σflat)*(1+%)` | boon |
| Investment bonuses | `m_MapModCostBonuses` (in API: `cost_bonuses`): tiers by souls spent per slot. Weapon gives weapon %, vitality gives health %, spirit gives flat spirit. Same for all heroes (deadbot asserts this) | deadbot `item_investment.py`; damage-lab; deadlock-plus |
| Level scaling | `m_mapLevelInfo` + `m_mapStandardLevelUpUpgrades` per boon (e.g. Mirage 6860: +45 HP, +0.3 bullet dmg, +1.1 spirit, 0 resist per boon); `m_mapScalingStats` for spirit-scaled stats | deadlock-api heroes; wiki; damage-lab: boons = level-1, level from (net worth - 600) |
| Conditional / active items | no source models these as stats; all three exclude them (damage-lab handles some in its fight sim; boon resolves recorded modifiers) | - |

### Ground-truth check: 33% spirit resist (Mirage, 6860, level 0)

Mirage has no innate spirit resist and 0 growth per boon in 6860 (deadlock-api, `standard_level_up_upgrades`).

| Sources | Multiplicative | Additive |
|---|---|---|
| Infuser 10% + Escalating Exposure 17% | 25.3% | 27% |
| Plus a third 10% source | 32.8%, displays as **33%** | 37% |

So 33% is **consistent with multiplicative stacking only if the build has one more ~10% spirit-resist
source** (solve: 1 - 0.747·(1-x) = 0.33 gives x ≈ 10.3%). The two named items alone fit neither rule.
Check the full 12-item list for another spirit-resist source, such as a 10% vitality item or a conditional
buff. If none exists, our input set is incomplete. Weapon damage 91% (additive sum incl. investment) and
spirit lifesteal 15% (multiplicative) should be checked against item values from the 6860 pack.

## Source table

| Source | Provides | Authority | Patch coverage | License | Fresh | Covers |
|---|---|---|---|---|---|---|
| boon (crates.io `boon-deadlock` 0.19, github pnxenopoulos/boon) | 38 rulesets, replay-side stat queries | vdata reading + player observations (forum links for melee); `documented_on` 2026-09-27..10-02 = when written, not patch; docs say "unverified assumptions"; no in-repo validation dataset | rules unversioned per patch (v1 everywhere) | MIT | active | resists, lifesteal, fire rate, clip, CDR, move, spirit (ability-side). **Missing**: max HP, regen, bullet damage |
| boon-data | per-patch JSON (abilities/heroes/modifiers/misc) + manifest w/ SHA-256 | mechanical vdata→JSON from GameTracking; integrity-validated only | 44 releases 6711–6860 (hourly poll; misses intermediate commits) | scripts MIT; data © Valve, no license granted | hourly | raw data only |
| SteamTracking/GameTracking-Deadlock | raw decompiled vdata, localization, schema dumps, per-build commits | Valve's own files (ground truth for data) | every build since tracking began | none stated (Valve content) | same day (6860 on 2026-11-06) | - |
| deadlock-api `/v1/assets` (api.deadlock-api.com; repo deadlock-api/deadlock-api) | heroes/items/modifiers/generic_data per `client_version`, localized, tooltip templates resolved | built from Steam depot daily via DepotDownloader + VRF | 875 versions 5044–6860 | code MIT; data Valve | daily | raw + resolved tooltips; no totals |
| deadlock-api match metadata (salts) | PlayerStats snapshots: max_health, weapon_power, tech_power, level, net_worth + item timeline | **game server output** = ground truth | any match whose salts are retrievable | API ToS | live | validation for HP / spirit / weapon % |
| deadlock.wiki (+ deadlock-wiki/deadbot, deadlock-data) | mechanics pages w/ formulas, hero tables; deadbot parses vdata→wiki | formulas: community testing, no methodology cited; tables: vdata (deadbot) | current patch; history via page revisions + deadlock-data git | deadbot/deadlock-data MIT; wiki text license unverified (fetch failed; likely CC BY-NC-SA) | active | resists (additive innate, multiplicative sources), spirit scaling coefficients (rounded) |
| deadlock-plus (GPL-3.0) | MODIFIER_VALUE → stat/stacking table, investment, tooltip "Modifies" diffs | vdata + in-game observations noted inline | current | GPL-3.0 (copying code would make our code GPL) | 2026-11-02 | most panel stats; conditional excluded |
| Ourokan/deadlock-damage-lab | formulas fitted to 38,587 real stat snapshots; ~115 item effect handlers; resist combine | **empirically validated** (HP 72% within 1, spirit 74% exact, weapon% 72% exact; misses are conditional items) | current patch, reruns every 6h | **no license** (read for ideas only) | 2026-11-10 | HP, spirit, weapon %, resist stacking, level from net worth |
| Deadworks-net/deadworks | server-side mod framework | runs real game code; possible stat oracle | current build only (old builds require old depots) | MIT | early dev | anything, in principle |
| deadlock-numbers (mattiapearl) | hero growth/scaling explorer from deadlock-api | derived | current | none | 2025-12 | per-level growth |
| Mutex (alayton; PC Gamer coverage) | browser build calculator with stat panel | unknown, closed | unknown | n/a | unknown | items→stats |
| tracklock / statlocker / deadlocktracker / deadlocklabs / Mobalytics | win-rate and build sites, item pages | display vdata; no exposed stat formulas | current | proprietary | - | none useful |

## Open risks

- Spirit-power percent stacking is disputed (multiplicative per the wiki and boon, summed per
  deadlock-plus). A sandbox test with two % sources (e.g. Boundless Spirit plus another) would settle it.
- Whether the vitality investment % applies to item health or only to base health is unconfirmed
  (deadlock-plus). damage-lab's fit says base plus base-health% only, with flat item health added after.
- Bullet-resist stacking is assumed to match spirit; deadlock-plus says so explicitly.
- Display rounding: spirit power is floored; resist rounding was not checked.
- Formulas could change between patches with no vdata trace. Version the rules per patch (boon's design)
  and re-validate against salts after each patch.
- Valve data has no license. Serve derived numbers, not redistributed files. boon-data and deadlock-api
  both carry this same caveat.
- Salts PlayerStats covers only HP, spirit and weapon %. Resist, fire rate and CDR need hand-made
  screenshots or Deadworks.

## URLs

- https://github.com/pnxenopoulos/boon ; https://github.com/pnxenopoulos/boon/blob/main/crates/boon-python/docs/hero-stats.md
- https://github.com/pnxenopoulos/boon-data
- https://github.com/SteamTracking/GameTracking-Deadlock
- https://github.com/deadlock-api/deadlock-api (crates/game-assets, api/src/routes/v1/assets) ; https://api.deadlock-api.com/v1/assets/client-versions ; https://api.deadlock-api.com/v1/assets/heroes/by-name/mirage?client_version=6860
- https://deadlock.wiki/Damage_Resistance ; https://deadlock.wiki/Spirit_Power ; https://deadlock.wiki/Deadlock_Wiki:Tools ; https://deadlock.wiki/Hero_Comparison_Table
- https://github.com/deadlock-wiki/deadbot ; https://github.com/deadlock-wiki/deadlock-data
- https://github.com/deadlock-plus/deadlock-plus (apps/desktop/src/lib/features/builds/hero-stats.ts, crates/ring2/dp-gamedata/src/item_stats.rs)
- https://github.com/Ourokan/deadlock-damage-lab (sim/deadsim/build.py, sim/scripts/validate_stats.py, sim/validation/README.md) ; https://ourokan.github.io/deadlock-damage-lab/
- https://github.com/Deadworks-net/deadworks
- https://deadlock-numbers.vercel.app ; https://github.com/mattiapearl/deadlock-numbers
- https://www.pcgamer.com/games/moba/ive-been-learning-what-deadlocks-items-actually-do-thanks-to-this-player-made-build-calculator-that-i-can-keep-open-in-my-tabs/
- https://tracklock.gg ; https://deadlocktracker.gg ; https://deadlocklabs.gg ; https://mobalytics.gg/deadlock/build-stats
- Forum observations cited by boon: https://forums.playdeadlock.com/threads/misleading-calculation-for-melee-damage-in-the-shop-stats-breakdown-the-actual-damage-has-no-bug.80970/
- Local proto: boon-proto-0.4.11152727+6805/proto/citadel_gcmessages_common.proto (`PlayerStats`, line ~604)
