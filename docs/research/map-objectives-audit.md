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
| Statues | **none on this map** | none (the 709 `CCitadel_BreakableProp` are the crates below) | — | — | — |
| `citadel_breakable_prop` | 672: 423 wooden crates, 168 item containers, 78 tough crates, 3 `citadel_breakable_bell_chinatown`; `breakable_spawn_group` 0 / 3 / 2 for 64 / 8 / 6 tough crates | 709, one entity each, `m_nSubclassID` the subclass token; inactive while broken (this row once said none break: health stays 1, the break is the entity going inactive) | **tough crates only, behind Heavy boxes** (branch `heavy-crates`) | none (our own box) | `active`, read every tick (format 7): up at 3:00 / 5:00 / 10:00 by spawn group, back 180 s after a break |
| `citadel_pickup_spawner` `citadel_pickup_floating_health` | 36 (`spawn_delay_override` 180) | 36 `CCitadel_PickupSpawner`; 36 `CCitadel_Pickup_Health` on them | **yes, behind Heals** (branch `map-layers`) | `health_pad_psd` | `m_bActive`, read every tick (format 5) |
| `trigger_item_shop` | 9: 3 lane shops a team, 2 secret (team 4), the King's base shop | 9 `CTriggerItemShop`, 8 `CCitadel_ShopProp` | **yes** (branch `map-layers`; not the base's) | `minimap_shop_psd` | — |
| `citadel_trigger_teleport` | 4, each with an `ExitPoint` | 4 `CCitadelTeleportTrigger` | **yes** (branch `map-layers`) | `minimap_teleporter_go_right` | — |
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

## Map furniture (branch `map-layers`, 2026-11-09)

**Operator:** "heal pickups should be maybe a toggleable thing because it might clutter the map …
adding the shops and the teleporters are also a good idea."

- **Shops** (`trigger_item_shop`): 8 on the map, 3 lane shops a team (`.tier1_shop`, 36 px, the
  art at half its box) and the 2 secret shops (team 4, `Music.Shop.Secret`, under the map at
  ±3920, ±1120). The 9th is the Hidden King's base shop (`LaneNum` 0, −752, −10714): the spawn
  room, under the frame, and the lump has no Archmother one, so it isn't drawn.
- **Teleporters** (`citadel_trigger_teleport`): 4 ends of 2 two-way tunnels, the King's side
  (−3584, −2784) ↔ (3904, −1792) and the Archmother's (−3904, 1792) ↔ (3584, 2784). Each trigger
  names an `info_target_server_only` `ExitPoint` 128 units from the other end; the pack carries
  it as `exit`, and hovering an end draws a faint dashed line to its pair. 16 px, the runner
  facing the map's middle (`.teleporter_onRight` mirrors it on the screen's right half).
- **Healing pickups** (`citadel_pickup_spawner` with `citadel_pickup_floating_health`): 36. The
  game's minimap doesn't draw them; it precaches `health_pad_psd`, a 16 px white cross, drawn at
  12 px washed green. Off unless this browser's **Heals** toggle is on (toolbar, beside
  Comments, in Sandbox and Player).
- **Timing.** Each map pickup is one `CCitadel_Pickup_Health` for the whole match, up at its
  spawner from 149.7 s and `m_bActive` false while taken; the class also drops elsewhere from a
  pool of reused entities (about 1,600 off-site changes in 129738985), so a site takes only the
  entities that only ever come up on it. 129738985 has **6 takes in 44 minutes** (two of them the
  pair 68 units apart at (−7912, 4000), together), each back 180.2 to 180.5 s later. Timeline
  format 5 adds `heals` in the camps' shape; on 129738985 that's 2,171 bytes of 1.53 MB (128
  gzipped). Player draws a taken pickup down with "Respawns in m:ss".
- **Fallback.** Prod's pack (build 6860) has the icons and none of these entities: a pack
  without a kind borrows the built-in map's (`withBuiltInFurniture`), keyed and placed as a new
  pack's are. They're kept out of the geometry hash.

## Shops (branch `shop-state`, 2026-11-09)

**Operator:** "do the lane shops disappear when the guardians go down?" and then: "when guardian
goes down the shop is no longer accessible, only the 2 secret shops are still up on the map
after all guardians are down."

**Answer: yes.** Each team's 3 lane shops are its guardians' (t1) shops. One closes as the
guardian beside it falls. The 2 secret shops and the Hidden King's base shop never change.
Walkers, base guardians, shrines and the patron change nothing.

- **The replay (129738985).** `heal_probe` with `CTriggerItemShop CCitadel_ShopProp`: each lane shop
  is a trigger and a prop (64 units apart). As it closes, the trigger entity is **deleted** and
  the prop's `m_bIsShopOpen` goes **false** (`m_flAnimTime` changes then, and once more 4 s
  later: the shutter). No team, health or `active` change. Against the timeline's guardians:

  | Shop (team, trigger x, y) | Closes (s) | Guardian | `destroyed_s` |
  |---|---|---|---|
  | sapphire (−910, 1248) | 473.9 | `guardian:sapphire:lane4:1` | 474 |
  | sapphire (8832, 1944) | 565.0 | `guardian:sapphire:lane6:1` | 565 |
  | sapphire (−6432, 1760) | 565.5 | `guardian:sapphire:lane1:1` | 566 |
  | amber (1024, −1248) | 683.8 | `guardian:amber:lane4:1` | 684 |
  | amber (−8832, −1944) | 790.2 | `guardian:amber:lane1:1` | 791 |
  | amber (6432, −1760) | 1077.3 | `guardian:amber:lane6:1` | 1078 |

  Each close comes before the guardian's timeline second, by less than 1 s. The secret shops
  ((±3920, ∓1120), team 4) and the base shop (−752, −10714) are open to the end (2,640 s).
- **The map data.** The lump names the lane shops `shop_{rebel|combine}_t1_{yellow|blue|purple}`:
  a t1 (guardian) shop, named for its lane's colour. No other record or key ties a shop to an objective.
  `LaneNum` agrees with the guardians on Amber's side, but **is mirrored on Sapphire's**:
  `shop_combine_t1_purple` (8832, 1944) is `LaneNum` 1, beside the lane 6 guardian (8128, 1856),
  and `shop_combine_t1_yellow` (−6432, 1760) is `LaneNum` 6, beside the lane 1 guardian. So the
  pack's `shop:sapphire:lane1:1` is the lane 6 shop, and the reverse. A shop pairs with its team's
  nearest guardian (each is 600 to 1,100 units from its own, at least 7,000 from the others).
- **vdata.** The extractor reads `heroes.vdata_c` and camp subclass names; neither says anything
  about shops. The rule is the game's code, seen in the replay.
- **The game's minimap.** The shop isn't accessible and isn't on the map any more (operator).
  The HUD's `.tier1_shop` panel is the trigger's, which is deleted. So mapcro **hides** a closed
  shop rather than dimming it.
- **Player.** `shopsClosed` (web/src/match/timeline.ts) derives the closed shops from the guardians
  down at t (`downAt`): the timeline is unchanged (format 5). A closed shop is "Hidden" and isn't
  drawn, even for an editor. A board, and a scene saved from Player, keep all 8.
- **Checks.** `match_129738985_closes_each_lane_shop_with_its_guardian`
  (crates/replay/tests/local_replay.rs, `MAPCRO_REPLAY_129738985`). `web/test/map-furniture.test.ts`
  replays these six deaths against the built-in map. `web/e2e/player-shops.spec.ts` covers a
  synthetic timeline, with screenshots `shots/shops-before-guardian.png` and `shots/shops-after-guardian.png`.

## Candidates

Other things in 129738985's entities and the lump a coach might want on the map or as a timer.
Report only; none is built. Value and cost are rough.

| Candidate | Evidence | Value | Cost |
|---|---|---|---|
| Secret-shop tunnel entrances | 13 `citadel_trigger_shop_tunnel` (team 2 and 3, around (±4352, ±2240), (±3008, …), and three at (0 / ±1360, 0, −320) under mid); the HUD's `.shop_tunnel_exit` draws `icon_stairs.vsvg` at 16 px | Medium: the way down to the secret shops and the mid rotations | Low: a fourth furniture kind, same path as shops |
| Underground layer | The pack already exports `minimap_midtown_mid_tunnels` and `minimap_midtown_rat_tunnels` (1024²); 77 `CCitadelTunnelNode`, 100 `CCitadelTunnelTrigger` in the replay | Medium: sewer rotations are hard to draw over the street map | Medium: a terrain swap and its control; markers stay |
| Teleporter uses | 4 `CCitadelTeleportTrigger` (`Delay` 4 s); a hero's position jumping ~7,500 units within a few seconds near an end. Not checked on a replay yet | Medium: who rotated through which tunnel, when | Low to medium: derived from positions the timeline has; an event kind |
| Who took a heal | `m_hVacuumTarget` is set on the pickup as it flies to the hero, just before `m_bActive` goes false | Low to medium: a "healed at" event in the list | Low: one handle per take |
| Soul dealer | 2 `citadel_trigger_corrupted_item_shop` (`souls_dealer_shop_trigger`, ±1056, ±3108); HUD `.corrupted_item_shop` with the broker icon, lit by `canPurchaseItem`. What it sells isn't checked | Unknown until checked | Low to draw; a timer needs its replay fields |
| Mid boss stairs | 2 `citadel_base_prop_stairs`; HUD `.mid_stairs` (`icon_stairs_mid`, 24 px, opacity 0 by default) | Low | Low |
| Wooden crates and item containers | Lump: 423 wooden crates, 168 item containers; their breaks show as the entity going inactive, like the tough crates' (built: Heavy boxes); 20 `CCitadel_Pickup_Gold` drops from 3:00 | Low: farm spots, and 591 icons | Medium: the Heavy boxes' path, at about 8 times their timeline bytes |

Not candidates: `CCitadel_Pickup_HalloweenCandy` (16, seasonal), the sewer critters
(`npc_neutral_bug`, ambient), and the base teleport spots (`info_teleport_location`).
