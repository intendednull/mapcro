# Abilities and items: feasibility study

**Date:** 2026-11-09. **Status:** research only; nothing ships from this.
**Asked by the operator:** "I also wonder if we could get abilities and item info? also unsure on how
the UX would work, but also good info to have. Lets check feasibility and discuss where we can put it"

**Data:**
- The real standard 6v6 demo 129738985: build 6839, 2640 s, 12 players.
- A throwaway probe (`crates/replay/examples/items_probe.rs`, not committed). It decodes every class named `*Abilit*`, `*Item*`, `*Upgrade*` or `*Weapon*`, plus the controllers, and logs user messages 306/309/318/330/338/360/364/365.
- The API side comes from:
  - the trimmed fixture `match-130816395-trimmed.json`;
  - deadlock-api's public `openapi.json` (one GET);
  - the `CMsgMatchMetaDataContents` proto vendored in boon-proto 0.4.11152727;
  - the earlier full-response notes in [match-replay.md](match-replay.md).

## Outcome

- **Full replay tier: everything is there and it is cheap.** That covers:
  - purchases, sells and upgrade merges, with timestamps;
  - the build at any t;
  - ability unlock and tier-up times;
  - every ability and active-item cast;
  - cooldowns and charges at t.

  Items, levels and casts all come from fields and messages the worker already decodes, at well under a second of extra parse time. Items plus levels add about 10 KB raw (under 1%) to a 1.53 MB timeline.
- **API summary tier: builds only.** It has item buy and sell times, and (per the earlier full-response read) ability unlocks and upgrades as `items[]` entries. It has no casts, cooldowns, charges or active-item use.
- **Names and icons: not in today's pack, but a straightforward extractor addition.** Every id in both tiers is the MurmurHash2 token of the internal name, verified on all 57 cast names in the demo plus the passive `ability_afterburn`. One vdata file plus localisation plus icon textures map them, the same way hero portraits work.

## 1. Items

### Full replay

| Datum | Source | Measured on 129738985 | Reliability |
|---|---|---|---|
| Purchase, sell and upgrade-merge events with time | user msg **309** `CCitadelUserMsg_AbilitiesChanged`: `purchaser_player_slot`, `ability_id`, `change` | 335 events: 239 `EPurchased`, 96 `ESold`. 0 `EUpgraded` or `ELeveledUp`. 15–23 buys per player. | High. Every id also appears in `m_vecUpgrades`. |
| Upgrade path (component → upgraded item) | 309 `ESold` in the same tick as a same-slot `EPurchased` | 89 of 96 `ESold` coincide with a buy within 0.1 s (consumed components). 22 match a real sell in msg 360. 4 match neither. **Corrected 2026-11-09 (format 7):** matched by item and time rather than slot, all 25 msg-360 sells match an `ESold` in the same tick, and the other 71 are each a catalog component of the item bought in that tick: 25 sells, 71 merges, no strays. | High for "what consumed what". |
| Real sell vs consumed | user msg **360** `ItemPurchaseNotification`: `sell`, `quickbuy` | 264 events: 239 buys, 25 sells. Its `userid` matched 309's slot on only 203 of 239 buys. | Use 309 as canonical. 360 only flags sells and quickbuy. |
| Build at t (current inventory) | `CCitadelPlayerController.m_PlayerDataGlobal.m_vecUpgrades` (boon `UpgradeReader`) | Up to 12 tokens per player, 240 changes, 103 distinct tokens: the same set as the 309 and 360 ids. | High, and redundant with 309 replay. It's a good cross-check, or a cheap snapshot source. |
| Active item use | user msg **365** `ImportantAbilityUsed` (`ability_name`) | 12 active items cast (for example `upgrade_containment` 32, `upgrade_fleetfoot_boots` 31, `upgrade_reduce_debuff_duration` 46). These match the item entities' `m_flCooldownStart` increases (32 and 31). | High. |
| Item cooldown or charges at t | item entities (`CCitadel_Item_*`, `CCitadel_ArmorUpgrade_*`, `CCitadel_WeaponUpgrade_*`, and the generic `CCitadel_Item_Empty`, 166 entities): `m_flCooldownStart/End`, `m_iRemainingCharges` | Present and owner-resolved. | High, but it needs those classes decoded (cost in §4). |
| Imbues (which ability an item boosts) | `m_PlayerDataGlobal.m_vecImbuements` {`m_SourceItemID`, `m_vecImbuedAbilities`} | Field present. Not walked. | Untested. |
| Item slot or category (weapon, vitality, spirit), tier, cost | not in the demo | | Game data (the pack, §3). |

### API summary

`players[].items[]` is `{game_time_s, item_id, upgrade_id, sold_time_s, flags, imbued_ability_id, upgrade_info}`. The bulk endpoint gates it behind `include_player_items`; the single-match `/v1/matches/{id}/metadata` returns it. The fixture is trimmed and has no `items`, so these fields are known from the proto, not from a payload.
- Buy time and sell time come per entry. That gives the build at any t, but no "consumed by an upgrade" distinction unless `flags` encodes it (unknown).
- `item_id` is very likely the same MurmurHash token the demo uses. deadlock-api's assets keep `id` and `class_name` side by side. **Unverified:** it needs one untrimmed payload compared against a demo.
- No active-item use, cooldowns or charges.
- `matches.rs` deserialises none of this today. It would be new `#[serde(default)]` fields on `Player`. Account ids stay ignored.

## 2. Abilities

| Datum | Replay source | Measured | API summary |
|---|---|---|---|
| Unlock and tier-up times (level at t) | `m_PlayerDataGlobal.m_vecAbilityUpgradeState` {`m_ItemID`, `m_nUpgradeInfo`} on the **controller**, and the same `m_nUpgradeInfo` on each ability entity | 48 abilities (12 × 4), 190 changes, identical from both sources. The encoding is bit 16 = unlocked and bits 17–19 = tiers 1–3 (65536 → 196608 → 458752 → 983040), so tier = popcount(info >> 16) − 1. 47 of 48 reached T3. | Ability unlocks and upgrades appear as `items[]` entries ([match-replay.md](match-replay.md) row "Items", seen on the full 130816395 response), plus `ability_points` in `stats[]`. The fixture's `stats[]` samples are 180 s apart and hold only net worth. Item-entry reliability: medium until checked on a payload. |
| Casts: all abilities, not just ults | msg **365** | 2227 casts, 57 distinct names (hero abilities and active items). They match `m_flCooldownStart` increases to within 1 per ability (for example `viscous_telepunch` 158 vs 159, `ability_fencer_ultimate` 12 vs 13, `citadel_ability_card_toss` 93 vs 93). | none (`ability_stats` is totals and was empty in samples) |
| Ult casts | 365 filtered by the ult cooldown starting (already in `derive.rs`) | 114 `ult` events today. **The other ~2100 casts are parsed and discarded.** | none |
| Cooldown at t | ability entity `m_flCooldownStart/End` (absolute game clock: subtract `m_flGameStartTime`, as the ult does) | Present on every hero ability, owner-resolved all match long (no PVS gaps seen). | none |
| Ult cooldown at t | controller `m_flUltimateCooldownStart/End` | already shipped (`Player.ult`) | none |
| Charges at t | ability entity `m_iRemainingCharges`, `m_flChargeRechargeStart/End` | 1405 changes on charge abilities (for example `card_toss` 186, `beartrap` 96) | none |
| Channel, toggle | `m_bChanneling`, `m_flChannelStartTime`, `m_bToggleState` | present | none |

Noise to drop: the movement and generic abilities (`Dash` 4082 cooldown changes, `Jump` 4894, `HoldMelee` 2134, `Mantle`, `Slide`, `Sprint`, `ZipLine*`, `MeleeParry`, `PrimaryWeapon*`, `EatHalloweenCandy`). Counting raw `m_flCooldownStart` increases outside those still gives 4570, because passive item procs have cooldowns too. 365 is the right "cast" list.

## 3. Names and icons

- **Ids.** Every id here is a `CUtlStringToken`: MurmurHash2 of the lower-cased internal name, seed `0x31415926`. That covers 309, 360, `m_vecUpgrades`, `m_ItemID` and each ability entity's `m_nSubclassID`. `parse.rs`'s test `token()` already implements it.
  - All 57 cast names hash to a subclass id.
  - 12 of them, the active `upgrade_*` items, also hash to inventory tokens.
  - The four Infernus ability tokens resolve to `ability_incendiary_projectile`, `ability_flame_dash`, `ability_afterburn` and `ability_fire_bomb`.
  - So one table, `internal name → {display name, icon, kind, slot, tier, components}` keyed by token, serves both tiers.
- **Today's pack.** The local dev pack (client 6860) has 67 heroes, entities, minimap icons, HUD sources and top-bar art (277 blobs). It has **no items or abilities**.
- **What the extractor needs** (`crates/extract`, which already has VPK, KV3, vtex and KV1 readers and an allow-list):
  1. Read `scripts/abilities.vdata_c` (KV3, like `heroes.vdata_c`). Per record: the key (the internal name, hashed to the token), `m_eAbilityType` (`EAbilityType_Item` vs ability; boon's `hero_stats` reads this field), slot type, tier, cost, component items, and the image path (`panorama:"file://{images}/…"`, already handled by `heroes.rs::portrait_entry`).
  2. Read each hero's ability list (`m_mapBoundAbilities` in `heroes.vdata_c`) to order the 4 signature abilities (slot 1–4, with 4 the ult).
  3. Read the English localisation for item and ability display names: loose KV1 files beside the hero-names file, already read for heroes. **To confirm:** the exact file names. I did not open the VPK or the install for this study.
  4. Decode the icons with the existing vtex path and add each file to the allow-list and the manifest. Expect a few hundred icons (about 200 shop items plus 4 per hero), roughly 5–10 MB of PNG. This is an estimate: item icons aren't sized yet.
- **Legal posture.** It's the same as the hero portraits: extracted by the operator from their own install, served from `PACKS_DIR`, never committed. Without a pack, the UI falls back to the internal name with `upgrade_` and `ability_` stripped.
- **Alternatives, not recommended:**
  - deadlock-api's `/v1/assets/items` has names and image URLs. That means hotlinking third-party-hosted game art, and I found no ToS for it.
  - boon-data's `abilities.json` from GitHub releases: names only, and a runtime download.

## 4. Cost

| | Raw JSON | gzip -6 | Note |
|---|---|---|---|
| Baseline timeline (FORMAT 5) | 1,530,499 B | 577,725 B | served uncompressed |
| + items (309 as `[t, token, kind]` per player) | +6,447 B | +1,902 B | 335 entries |
| + ability levels (`[t, token, tier]`) | +3,634 B | +1,129 B | 190 entries |
| + all casts (365 as `[t, slot, name_idx, cd_s]` + name table) | +43,316 B | +15,855 B | 2227 casts. Cooldown-at-t is computed client-side from cast and end. |
| (avoid) per-second cooldown % for 4 abilities × 12 players | ≈ +282 KB | ≈ +62 KB | upper bound (random fill); casts with an end time carry the same thing |
| (avoid) casts as `MatchEvent` objects in `events` | +191 KB | +12 KB | too verbose. Keep casts a table, as `troopers` and `seen` are. |

- **Parse time** (release, `nice -n 10`, wall clock):
  - The current worker takes **9.8 s** (load 7.7–12), 524 MB RSS.
  - A probe reading controllers plus 309, 360 and 365 takes 5.0 s. A probe also decoding every ability/item class takes 5.8 s, so decoding ability entities costs about **+0.8 s**.
  - Items, levels and casts need no new classes: controller fields and messages the worker already sees. Cooldowns and charges need the ability classes, about +8% on 9.8 s.
  - My first, naive probe took 97 s. That was per-tick string-keyed bookkeeping, not decoding. Real code should resolve keys once and read cooldowns only when a cast or level change says to.
- **FORMAT:** a bump to 6, additive, with `#[serde(default)]` on the new fields. `replays.rs::stale` already treats a lower format as stale, so old cached timelines show builds as "untracked" until they're re-parsed.
- **Privacy: none.** The new data is keyed by player slot (309 `purchaser_player_slot`, 360 `userid`) and the controllers we already read. No Steam or account id is read. The API side keeps not deserialising account ids. A hero's build is gameplay state that is already public in the match metadata.

## 5. UX options

The constraints:
- map hover labels stay pure labels, so builds don't go there;
- clicking a portrait focuses the hero;
- anything noisy defaults off.

**A. Minimal: "Build" entries in the events list.**
- What it shows: a new **Build** chip, off by default like Heals, for item buys ("bought X", "X → Y" for merges, "sold X") and ability tier-ups. It follows playback and lets you click to jump, like every other event.
- Tiers: both.
- Cost: small, but 335 + 190 = 525 rows against today's 295, which is why it starts off.
- Strength: answers "when did they get X".
- Weakness: doesn't answer "what do they have now".

**B. Recommended: a build card on a top-bar portrait.**
- How it opens: a small build button on the portrait, beside the existing focus button, or "Build" in the right-click menu. It doesn't take over click, which already focuses. It shows the state at the playhead and follows playback.
- What it shows:
  - the 4 abilities with tier pips (both tiers);
  - cooldown sweep and charges per ability (replay tier only; the summary tier shows "untracked", as the ult ring already does);
  - items owned at t, grouped by slot category from the pack, each with its buy time;
  - a thin strip of buys over the match, where clicking one jumps the playhead there.
- Tiers: items and levels on both; cooldowns and charges on the replay tier.
- Cost: items plus levels (+10 KB) for the card. Cooldowns add the cast table (+43 KB raw) and the ability-class decode (+0.8 s).
- Mock: [abilities-and-items-mock.html](abilities-and-items-mock.html) (static, placeholder art). It shows 129738985 at 12:00 for Infernus with the probe's real state: incendiary T1 with 2 charges, flame_dash T1, afterburn T3, fire_bomb unlocked with no upgrades, and 5 items with real buy times (3 of them upgrade merges).

**C. Rich: a selected-hero panel in the right sidebar, plus cooldown pips on portraits.**
- What it shows: the sidebar space freed by the roster removal holds a "selected hero" panel with:
  - the card's content;
  - a full build timeline;
  - a cast timeline (every 365 cast, with optional map markers at the cast position; `AbilityObs` already carries `pos`).

  Each top-bar portrait gets 4 tiny ready/cooldown pips under the ult ring.
- Tiers: the replay tier for most of it.
- Cost: the cast table, plus clutter on a bar that's already dense. The pips should sit behind a toggle that defaults off.

**Recommendation.** Start with **B** on both tiers: items and ability tiers first, then cooldowns and charges on the replay tier. Add **A**'s chip in the same change, since it's the same data and nearly free. Leave C until coaches ask for cast timing; the data will already be in the timeline.

## 6. Questions for the operator

1. **Card trigger:** a build button on the portrait, "Build" in the right-click menu, or both? Hover is out, because click already focuses.
2. **Names and icons:** OK to extend the pack extractor (`abilities.vdata_c`, localisation, icons) and re-extract? Until that lands, the card shows internal names.
3. **Casts:** all ~2200 per match (cooldowns at t, a later cast timeline), or only ults and active items for now?
4. **Summary tier:** should builds show for API-only matches too? That needs `items[]` deserialised, and one untrimmed metadata payload checked against the demo's ids. A match we've already fetched would do, without spending the fresh-match budget.
5. **Cooldown pips on portraits (option C):** wanted at all, or does the card cover it?

## Operator decisions (2026-11-09)

- Cooldowns for **every** ability and item: yes.
- Builds on API-summary matches too: yes.
- Casts in the events log: not every cast; at most an optional, off-by-default chip.
- Extend the pack extractor for item/ability names and icons: yes.
- Status effects (buffs, debuffs, DoTs): study requested (docs/research/status-effects.md). The data
  work waits for it, so items, abilities, cooldowns and any status effects share **one** timeline
  FORMAT bump (each bump makes uploaded replays need a re-upload).
- Still open: placement (A/B/B+A/C), how the card opens, portrait cooldown marks. The visual chooser
  is /home/intendednull/concierge/artifacts/mapcro-abilities-items/index.html.
