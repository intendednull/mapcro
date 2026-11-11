# Calculated hero stats: spike (2026-11-10)

Question: can mapcro calculate a hero's Tab-panel stats at any replay moment, from the replay's
own build and the game data of the replay's patch, accurately enough to show them labelled
"calculated"? Stats: max health, spirit power, weapon damage %, bullet resist, spirit resist.
Builds on [stat-datamining.md](stat-datamining.md).

Code: `crates/replay/src/stat_calc.rs` (the rule table and the calculator, with tests) and
`crates/replay/examples/stat_calc_check.rs` (the validation run below). No UI.

## Outcome

| Stat | Ground truth | Exact | Within 1 | Show? |
|---|---|---|---|---|
| Max health | recorded `m_iMaxHealth` at each (re)spawn, 83 points | **96.4%** | 98.8% | yes |
| Max health | metadata snapshots, 132 | 72.0% | 74.2% | yes (misses are live buffs/debuffs) |
| Spirit power | metadata snapshots, 132 | **81.1%** | 81.1% | yes |
| Weapon damage % | metadata snapshots, 132 | 62.9% | 62.9% | yes, with replay health: **72.7%** |
| Bullet / spirit resist | no recorded value; sandbox screenshot only | sandbox 0% / 33% exact | - | yes, once a bullet-resist check exists |
| All five | operator's 6860 sandbox build (Mirage, level 0) | **5 of 5** | - | - |

Recommendation: show all five as *calculated* values of the passive build (items owned, level,
ability upgrades, statue pickups), with the patch's data matched to the replay build. Weapon
damage should take the life-threshold rule (it needs the timeline's health percent, which it
already has). Label the value as excluding active and stacking effects. In this match, every
miss traces to a live state the calculation leaves out (an active item, a stack count, an
enemy's debuff, a hero mechanic), or to a purchase made just before a snapshot. No miss
contradicts a rule. Resists use the same item and stacking code that hit 33% exactly. Their
weak point is items whose resist property has no modifier binding, such as Bullet Resilience.
A screenshot that includes one of those items would close the gap (open question 2).

## Inputs and data

- **Match**: 129738985, standard 6v6, build 6839, 12 players, 44 min. Match metadata came from
  deadlock-api `/v1/matches/129738985/metadata?disable_steam=true`: one fetch, kept outside the
  repo in `/tmp`. The salts Steam path was not used. The metadata carries account ids; the check
  never reads or prints them, and output is keyed by hero id at most.
- **Timeline**: a format-8 timeline of the same replay (prototype branch). From it the check uses
  `level`, `max_health`, `items` (tenths of a second), `abilities` (tiers), `health` and `x`
  (alive).
- **Patch data**: boon-data snapshots, downloaded to `/tmp/mapcro-statcalc/boon-data/<ver>/`.
  Every artifact was checked against `versions.json` sha256 (all OK). Build 6839 resolves to the
  6837 artifacts: boon-data releases only on content change.
- **Sandbox**: the operator's screenshots (patch 6860, Mirage, level 0, 600 souls) of the
  Vitality, Spirit and Weapon panels and of four item tooltips. They were not copied into the repo.

## Method (the rule table)

Each rule is a `Rule` constant in `stat_calc.rs`, with its version, its source and the patches
it was checked against.

1. **passive.v1**: an item or ability property counts when boon-data binds it to the ability's
   own `m_AutoIntrinsicModifiers/N`, or binds it nowhere but flags it
   `IntrinsicallyProvidedInAbility` (boon's reading). It must also have no `apply_filter` and no
   `Conditionally*` usage. Evidence: Improved Spirit's unbound, unflagged 75 HP is not applied by
   the game (snapshots match without it). Rapid Recharge's 14 spirit (`OnlyIfHasCharges`),
   Infuser's active +30 spirit and Scourge's conditional 40% spirit resist are all absent from the
   sandbox panel.
2. **boons.v1**: a boon is a `m_mapLevelInfo` level at or below the hero level with
   `m_bUseStandardUpgrade`; for heroes in these patches, that's level - 1. Each boon adds the
   hero's `m_mapStandardLevelUpUpgrades` (health, spirit power, resists).
3. **investment.v1**: a slot's souls are the sum of `m_nItemPricePerTier[tier]` over the owned
   items in that slot. The bonus comes from the last `m_MapModCostBonuses` row whose threshold is
   reached: Armor gives base health %, Tech gives flat spirit, WeaponMod gives weapon %. Sandbox:
   12.8K vitality shows +50%, 35.2K spirit +100, 8K weapon +62%, each highlighted on the tooltip
   at the row this predicts.
4. **max_health.v1**:
   `((base + boons·per_boon)·(1 + vitality% + base_health%) + flat item, upgrade and pickup health)·Π(1 + max_health%)`,
   truncated to an integer.
5. **spirit_power.v1**: `(boons·per_boon + spirit investment + flat items, upgrades and pickups)·Π(1 + spirit%)`.
   Metadata truncates the result; the HUD rounds it.
6. **weapon_damage.v1**: weapon investment % plus the sum of item, upgrade and pickup weapon %.
7. **resist.v1**: innate = hero base + boons·per_boon + spirit scaling (`m_mapScalingStats`) +
   statue pickups, added together. The total is then `1 - Π(1 - r)` over innate and each item
   source. The hero's own negative sources stack the same way in a separate group, which is
   subtracted.
8. **life_threshold.v1** (state-aware, opt-in): when the caller passes health %, an item's
   conditional properties apply if the item has a `LifeThreshold` property and health is at or
   above it. Battle Vest and Hollow Point: 65%. A dead hero counts as 100%.

Also in the build: **ability upgrades**. A hero ability's `m_vecAbilityUpgrades` bonus counts
when its property passes passive.v1. In 6839 that is only Abrams' Infernal Resilience T1
(+200 HP). **Statue pickups** are the permanent `*_permanent_pickup*` buffs (hp, spirit, wp,
bulletresist, spiritresist). Without pickups, health falls from 72% to 25% exact at snapshots
and weapon from 63% to 29%, so pickups are not optional.

## Results

### Metadata snapshots (`PlayerStats`, every 180-300 s, 12 players, 132 snapshots)

`cargo run -p mapcro-replay --release --example stat_calc_check -- <boon-data/6839> <metadata.json> <timeline.json>`

| Stat | Exact | Within 1 |
|---|---|---|
| max_health | 95 (72.0%) | 98 (74.2%) |
| spirit_power (truncated) | 107 (81.1%) | 107 (81.1%) |
| weapon_damage | 83 (62.9%) | 83 (62.9%) |
| weapon_damage + life threshold (replay health) | 96 (72.7%) | 96 (72.7%) |

### Recorded max health (the timeline's `max_health`, non-null points)

This build uses only the timeline's items, levels and ability tiers, plus pickups from the
metadata (the timeline has no pickup series yet).

| | Exact | Within 1 |
|---|---|---|
| 83 points | 80 (96.4%) | 82 (98.8%) |

The 3 misses: two are 1 HP high at 3009/1964 (float truncation). The third is Rat King at 609 s,
98 HP low, which is Cultist Sacrifice's stacking health. The recorded value turns out to refresh
**only at (re)spawn**: it matched the live metadata value at 10 of 132 snapshots. Between spawns
it's stale, so it should not be shown as current health. A calculated value could replace it.

### Sandbox (patch 6860, Mirage level 0)

The 12 items were identified from the item grid, using the tooltips (Slowing Bullets, Escalating
Exposure, Infuser), the Spirit panel (+2 charges and 30% charge cooldown are Rapid Recharge's
exact values) and icon matching against the item pack:

- Weapon: Titanic Magazine, Slowing Bullets, Long Range, Hunter's Aura
- Spirit: Rapid Recharge, Escalating Exposure, Mercurial Magnum, Boundless Spirit, Arctic Blast, Scourge
- Vitality: Phantom Strike, Infuser

Arctic Blast and Scourge were identified by eye; the 100 HP from Scourge and the 10% resist
from Arctic Blast are both needed to reach the shown values. All five values match:

| Panel | Shown | Calculated |
|---|---|---|
| Max health | 1470 | 730·1.50 + (75 + 100 + 100 + 100) = 1470 |
| Spirit power | 176 | (100 + 30 + 7 + 8 + 8)·1.15 = 175.95, rounded |
| Weapon damage | 91% | 62 + 14 + 15 = 91 |
| Spirit resist | 33% | 1 - 0.90·0.83·0.90 = 32.77% (added up: 37%) |
| Bullet resist | 0% | no bullet-resist source |

Clip size (120% = Titanic 100 + Mercurial 20) and spirit lifesteal (15%, Infuser's passive) agree
too. The test `sandbox_build_matches_the_operators_screenshots` holds these values.

### Calculated resists, 129738985 at match end (no ground truth)

| Hero id | Bullet | Spirit |
|---|---|---|
| 78 | 43.5% | 21.0% |
| 52 | 24.1% | 25.9% |
| 1 | 10.5% | 28.8% |
| 35 | 33.1% | 49.9% |
| 77 | 30.8% | 58.3% |
| 81 | 8.5% | 48.3% |
| 65 | 30.2% | 44.1% |
| 87 | 19.9% | 13.2% |
| 84 | 22.6% | 27.7% |
| 13 | 20.2% | 23.4% |
| 7 | 20.5% | 35.7% |
| 6 | 35.4% | 39.5% |

These are plausible for a 44-minute game. All 12 players own resist items at the end
(scoreboard-values.md), and the replay's stat-viewer pickups (0.5-7 points) agree in size with
the metadata's pickup values.

## Disputes settled

| Dispute | Verdict | Evidence |
|---|---|---|
| Does vitality investment % apply to item health? | **No, base health only** | respawn 96.4% exact vs 26.5% with it; snapshots 72.0% vs 21.2%; sandbox 1470 vs 1657 |
| Do resist sources add or multiply? | **Multiply** (innate group added first) | sandbox 33% vs 37% |
| Do spirit % sources multiply or add? | **Not testable, and moot today** | the only buyable % source in 6839/6860 is Boundless Spirit (Haunting Scream is disabled), so no build has two and both rules agree. Kept multiplicative (wiki, boon). Re-test when a second source ships. |
| Rounding | health **truncates** (snapshots: floor 72.0% vs round 47.0%); metadata spirit **truncates** (81.1% vs 39.4%); the HUD **rounds** spirit (175.95 shown as 176, one observation) | |
| Health pickups: inside vitality % or flat? | **Flat, after the %** | 72.0% vs 25.8% |
| Spirit pickups: inside spirit % or after? | **Inside** (summed with flat spirit) | 81.1% vs 75.0% |

## Patch sensitivity

The same match checked against other patches' data:

| Data | HP snapshots | Spirit | Weapon (+ life threshold) | HP at respawn |
|---|---|---|---|---|
| 6839 (correct; 6837 artifacts) | 72.0% | **81.1%** | 62.9% (72.7%) | **96.4%** |
| 6860 | 72.0% | 81.1% | 62.9% (72.7%) | 96.4% |
| 6821 | 72.0% | 73.5% | 62.9% (63.6%) | 96.4% |
| 6801 | 72.0% | 73.5% | 62.9% (63.6%) | 96.4% |
| 6711 | 57.6% | 73.5% | 62.9% (63.6%) | 78.3% |

The patch matters. 6821→6837 changed Infuser, Spirit Lifesteal and Spiritual Overflow (+2
spirit each), Battle Vest (18→22% weapon) and Silence Wave (50→90 HP). Using 6821's data
costs 8 points on spirit and 9 on weapon with life thresholds. 6711 costs 18 points on health.
6837→6860 changed none of these values (only one hero's melee growth), which is why 6860
scores the same. Matching data to the replay's `build` (the nearest boon-data snapshot at or
below it) is required.

## Misses, explained

Live states the calculation leaves out:

- **Weapon %, 36 misses** after life thresholds:
  - Purchases in the 30 s before a snapshot, mostly at 180 s: investment not yet counted (5).
  - Stacking items: Berserker, Crushing Fists, Ballistic Enchantment, Cultist Sacrifice,
    Escalating Resilience.
  - Mirage's 900 s snapshot (-36): its investment doesn't yet count Heroic Aura, bought 28 s
    earlier (21 = 18 + a 3% pickup, the 3.2K row instead of 6.4K).
  - One Battle Vest snapshot at 58% health still counted the bonus.

  If investment is lagged 10-20 s, 2-4 more snapshots match per stat. That could be a clock
  offset between `items` and `stats`. Not adopted.
- **Spirit power, 25 misses**:
  - Nurse Harrow accounts for 10 (+32 to +130, growing; a hero mechanic).
  - Spirit Snatch steals (+25) and Spiritual Overflow (+30) are active effects.
  - The rest are recent purchases and a few low misses of 3-11.
- **Max health, 37 misses at snapshots**:
  - 26 are low, meaning the live value was reduced at that instant (enemy max-health debuffs).
    The same builds match at respawn, so the build is right.
  - 11 are high: Rat King's Cultist Sacrifice stacks (+53 to +456), and a few buffs.
  - 6 were dead at the snapshot.

At respawn, where no live state applies, health is 96.4% exact.

## What a production version needs

- **Pack**: a reduced per-patch stat table, derived numbers only (no Valve files), keyed by
  build:
  - heroes: base health, per-boon growth, boon levels, investment tables, spirit scaling of
    resist
  - items: slot, tier price, passive stats, conditional stats plus LifeThreshold
  - ability upgrade bonuses

  A few KB per patch; `stat_calc::Catalog::from_json` already reduces boon-data to this shape.
  Serve the table that matches the timeline's `build`.
- **Timeline**:
  - `level` and `abilities` tiers: in format 8 (prototype) and format 7.
  - `items`: in format 7.
  - health %: already there.
  - **New: statue pickups.** Required. They are in the demo (`m_vecStatViewerModifierValues`
    entries from `modifier_permanent_pickup`: type plus value plus time).
  - Optional: Spirit Snatch's stolen values from the same vector, and stack counts from
    `effects` for stacking items, which would be a later rule.
- **UI**: show as calculated, round as the HUD does, and say what's excluded. Don't present the
  recorded max_health as live.
- **Re-validation per patch**: run `stat_calc_check` on one fresh match's metadata after each
  patch. That's one cheap deadlock-api call.

## Open questions for the operator

1. Spirit rounding: one sandbox value (175.95 shown as 176) says the HUD rounds. A second
   screenshot with a fractional part near .3-.5 would confirm rounding rather than ceiling.
2. Bullet resist: Bullet Resilience and Spirit Resilience carry their resist with no modifier
   binding, only the `IntrinsicallyProvidedInAbility` flag. We count them, as boon does, but no
   screenshot has checked this. A sandbox shot with Bullet Resilience, or Battle Vest under and
   over 65% health, would settle it.
3. Show passive-only values, or state-aware ones (life thresholds now; stacks later)? The spike
   suggests passive values plus life thresholds for weapon %.
4. The Tab-scoreboard reference (22:30, another match) shows HP and both resists for 12
   players. If its replay is available, it is resist ground truth for 12 builds at once.
