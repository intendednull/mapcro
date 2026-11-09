# Map objectives audit (2026-11-09)

**Question (operator):** "purple junk sinners, theater doubles, hidden king doubles and bell tower
sinners don't show on the map. Can we double check we got everything?"

**Answer.** Every neutral objective on the current map is in the pack and drawn. But the pack
carried no camp tier, and the client guessed "vaults" from a camp's name. Only 6 of the 11
Sinner's Sacrifice camps have "vault" in their names, so the other 5 were drawn as plain medium
camps. Those 5 include all four the operator named. The guess also drew every weak and strong
camp as medium, and the mid boss's own camp put an extra camp icon under the mid boss. Fixed
(branch `map-audit`): the extractor writes each camp's tier, and the client reads it. For packs
that predate the fix (prod's), the client takes the tier from the built-in map's camp on the
same spot.

## Sources

- **Map:** `maps/dl_midtown/entities/default_ents.vents_c` (build 6860, Nov 05 2026), read at the
  extractor's exact path. `crates/extract/examples/lump_census.rs` prints every classname with its
  count, and the records of the neutral-looking classes.
- **Replay:** 129738985 (6v6, build 6839, 44:00). `crates/replay/examples/objective_census.rs`
  decodes every neutral-looking class. For each class it prints the distinct entities, the first
  and last second each was seen, and their positions, then the game rules' camp-timer slots.
- **HUD:** `hud_minimap.vcss`, from the pack's HUD sources. The game's minimap draws one icon per
  camp, by tier: `.neutral_weak` uses `neutral_small_psd`, `.neutral_medium` uses
  `neutral_medium_psd`, `.neutral_large` (strong) uses `neutral_large_psd`, and `.neutral_vault`
  uses `neutral_vault_psd`. All four are 24 px, at z-index 2.

## What the operator's names are

The lump has 52 `info_neutral_trooper_camp` records. Each one's `subclass_name` gives its tier:
4 `neutral_camp_weak`, 24 `neutral_camp_medium`, 12 `neutral_camp_strong`, 11
`neutral_camp_vaults` and 1 `neutral_camp_midboss`. The vaults camps are the Sinner's Sacrifice
camps. They hold the map's 15 `info_neutral_trooper_spawn` records with
`NeutralSubclass=neutral_sinners_sacrifice`, joined to their camp by `CampName`. In the replay
these are the 15 `CNPC_Neutral_SinnersSacrifice` machines. All 15 first spawn at 480 s, and
each stands within 500 units of its camp's centre.

| Operator's name | Camp (`targetname`) | World x, y, z | Machines | Note |
|---|---|---|---|---|
| bell tower sinners | `1380394_chinatown_bell_1` | 3248, −1888, 2499 | 3 | On top of the Chinatown bell tower; Hidden King half |
| theater doubles | `theater_balcony_camp` | 4160, 2784, 1008 | 2 (+1 theater neutral) | Archmother half |
| hidden king doubles | `slums_garage_up_camp` | −3264, −1600, 564 | 2 (+1 drain creature) | Hidden King half, on the roof above `slums_garage_down_camp` (medium) |
| (other camps the bug hit) | `drug_store_camp` / `hotel_01_camp` | 2208, −960, 400 / −2220, 1024, 392 | 1 each (+2 neutrals) | A mirrored pair, drawn as medium before the fix |

**Purple junk** (operator, 2026-11-09) is not a game name: it is the area with purple mist that
mirrors the bell tower's Sinner's Sacrifice, with similar value. All 11 Sinner's Sacrifice camps now
draw with the vault icon on prod (checked at 15:00 in 129738985), so it shows whichever camp it is.
Which `targetname` it is hasn't been matched yet.

The other six Sinner's Sacrifice camps have one machine each, and their names say "vault":
`dock_authority_vault`, `york_radio_vault`, `park_club_vault`, `park_library_vault`,
`plaza_pit_vault1` and `plaza_pit_vault2`. Those six already drew correctly.

## Inventory and diff

"Shown" is what mapcro drew before this branch, with a real pack. "Timer" is where the hover
timer comes from.

| Game class / name | Lump | Replay 129738985 | Shown before | Icon | Timer source |
|---|---|---|---|---|---|
| `info_neutral_trooper_camp` `neutral_camp_weak` | 4 | 4 timer slots | yes, **as medium** | `neutral_small_psd` (was medium) | `m_vecNeutralCampNextSpawnTimes` (first 120, respawn 85) |
| … `neutral_camp_medium` | 24 | 24 slots | yes | `neutral_medium_psd` | same (300 + 290) |
| … `neutral_camp_strong` | 12 | 12 slots | yes, **as medium** | `neutral_large_psd` (was medium) | same (480 + 335) |
| … `neutral_camp_vaults` (Sinner's Sacrifice) | 11 camps, 15 machines | 11 slots; 15 `CNPC_Neutral_SinnersSacrifice` | 6 as vaults, **5 as medium** | `neutral_vault_psd` (5 were medium) | same (480 + 300) |
| … `neutral_camp_midboss` | 1 | 1 slot (`IsMidBoss`) | **a stray camp icon under the mid boss** | none (the mid boss marker) | — |
| `info_neutral_trooper_spawn` `npc_super_neutral` (mid boss) | 1 | `CNPC_MidBoss`, 2 spawns at 0, 0 | yes | `super_neutral_marker_psd` | the mid boss's timer slot |
| `destroyable_building` (shrines) | 4 | 4 `CCitadel_Destroyable_Building` | yes | `boss_health_t2_psd` | — (health, not respawning) |
| `citadel_item_powerup_spawner` (bridge buffs) | 2 | 2 `CCitadel_PickupItemSpawner` at ±3936 | yes | `powerup_*` | observed spawns, 300 s grid |
| `citadel_trigger_idol_return` (Soul Urn sites) | 2 | 2 `CCitadelIdolReturnTrigger`; 11 urns | yes | `soul_jar_marker_return_psd` | urn spawns and the 180 s walk-back |
| `info_koth_spawn_location` (Unstable Rift) | 2 | 5 `CCitadel_KothCashIn` at ±7648, 0 | yes | `minimap_icon_koth_png` | `m_timeKothCashInStarted`, give-up |
| `npc_neutral_bug` spawns (sewer critters) | 60 in 11 groups, no camp | 76 `CNPC_Neutral_Bug` | no | — | ambient, not an objective |
| Statues | **none on this map** | none (709 `CCitadel_BreakableProp`, none break) | — | — | — |
| `citadel_breakable_prop` | 672: 423 wooden crates, 168 item containers, 78 tough crates, 3 `citadel_breakable_bell_chinatown` | 709 | no | — | none in the replay |
| `citadel_pickup_spawner` `citadel_pickup_floating_health` | 36 (`spawn_delay_override` 180) | — | no | — | backlog |
| `item_crate_spawn` | 6 (0–1 are the urn sites; 4–7 look unused) | — | — | — | — |
| `citadel_breakable_prop_punchable_troll` | 1 (6224, −16, −192) | 1 | no | — | an easter egg |

Every one of the replay's 52 camp-timer slots sits on a lump camp, to the unit. So the
Sinner's Sacrifice camps always had their timers in the timeline. Only their icon was wrong.

Four medium camps have no `targetname` (at −8624, 4264; 5824, 3984; 8000, −4736; and −5504,
−3680). Their spawns are the groups named `nw_bank_camp`, `ne_theater_upstairs_camp`,
`sw_asylum_camp` and `sw_bodega_upstairs_camp`. They're drawn and timed like any other camp.

## The fix

- **Extractor:** each camp's `tier` (`weak` / `medium` / `strong` / `vaults` / `midboss`) now
  comes from `subclass_name` and is written to pack.json as an optional field. The schema stays
  3, and the keys and geometry hash are unchanged.
- **Client** (`web/src/map/model.ts`, `campTier`):
  - The tier is the pack's when it has one; else the built-in map's camp within 64 units; else
    the old name guess.
  - The mid boss's own camp isn't drawn. A new pack marks it `midboss`; in an older pack it's
    the tier-less camp on the mid boss.
  - Sinner's Sacrifice markers are titled so.
  - Hover is unchanged. While cleared, the camp shows "Respawns in m:ss"; while up, nothing (the
    label rule).
- **Prod:** no new pack is needed. The client fixes today's pack through the built-in map. A pack
  extracted from this branch carries the tiers itself, and keeps them right if the map changes.

## Checks

- `crates/replay/tests/local_replay.rs` `match_129738985_has_every_camp_and_sinners_sacrifice`
  checks that:
  - the camps come out as 4 / 24 / 12 / 11 plus the mid boss, each first spawning on its tier's
    schedule;
  - the 15 machines stand only in vaults camps, covering all 11 of them: 3 on the bell tower, 2
    on the theater balcony and 2 on the slums garage roof.
- `crates/extract/tests/extract.rs`: a fixture camp named like the bell tower's gets `vaults`
  from its subclass alone. The real-install test counts the tiers.
- `web/test/map.test.ts` (camp tiers) and `web/e2e/pack.spec.ts` (a pack's camps) cover the
  fallbacks, the mid boss camp and the icons.
- `web/e2e/shots-map-objectives.spec.ts` screenshots the real replay and pack. It is skipped
  unless both are set.
