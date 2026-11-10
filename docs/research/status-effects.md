# Status effects: feasibility study

**Date:** 2026-11-09. **Status:** research only; nothing ships from this.
**Asked by the operator:** "can we look into grabbing the status effects? like debuffs, buffs, dots, etc?"
**Companion:** [abilities-and-items.md](abilities-and-items.md). The same demo and probe style are used, and its token hash is reused.

**Data:**
- The real standard 6v6 demo 129738985: build 6839, 2640 s, 12 players.
- A throwaway probe (`crates/replay/examples/status_probe.rs`, not committed). It decodes only the controller, pawn and rules classes. It reads:
  - the `ActiveModifiers` string table through boon's `modifier_state::ModifierState`;
  - the pawn's `m_pModifierProp` state bitmasks;
  - user messages 300, 310, 325, 327, 367 and 368.
- Names came from the public boon-data catalog, snapshot 6860 (`modifiers.json`, `abilities.json`, sha256-verified). It was fetched once into `/tmp` for this study only. The worker should not depend on it (see §3).

## Outcome

- **Feasible, on the full-replay tier only.** Every status effect on a hero is networked as a modifier. That covers buffs, debuffs, DoTs, stuns, slows, silences, sleeps, knockups, shields, heal-over-time, item procs and auras. Each one comes with:
  - its target;
  - its caster;
  - the ability or item that applied it;
  - explicit apply and remove events;
  - stacks.

  Hard CC is also a separate, clean per-pawn state bitmask. Per-hit damage, with attacker, victim and ability, is in the demo too (msg 300).
- **Names: 100% resolvable.** All 479 distinct modifiers seen on heroes (17,432 applications) hash to a known qualified name. The ability token on each application resolves to an ability or item name for all 182 distinct ids.
- **Cost is moderate, so filter.** All hero modifier intervals come to +497 KB raw (+32% on a 1.53 MB timeline). The set the game itself shows an icon for is +117 KB raw / 27 KB gz. Hard CC plus DoTs plus death recaps is about +42 KB raw. Parse time is at most +2.1 s on about 5.3 s, an upper bound that includes the probe's TSV writing.
- **API summary tier: none of this.** Match metadata has no modifiers. It does carry a damage matrix (`CMsgMatchPlayerDamageMatrix`, match totals per dealer → target), which this study did not test.
- **FORMAT bump: yes, join it.** Do it with a filtered set: hard CC, game-visible effects and death recaps. Leave per-hit damage out (§5).

## 1. Where it lives: what's networked (129738985)

| Source | What it is | Count over the match | Use? |
|---|---|---|---|
| **`ActiveModifiers` string table** (`CModifierTableEntry` protobuf per entry; boon `ModifierState` merges deltas) | Every modifier on every entity: `parent` (target ehandle), `caster`, `ability` (ehandle), `ability_subclass` (token), `modifier_subclass` (token), `stack_count`, `max_stack_count`, `duration`, `creation_time`, `last_applied_time`, aura fields, opaque `int1..4`, `float1..N`, `bool1..4` | 474,603 changes: 44,499 applied, 35,417 removed, 394,687 changed. **On heroes:** 17,432 applied, 13,513 removed (the other 3,919 stay open until match end: passives and item watchers), 265,073 changed. 479 distinct modifiers on heroes, 711 overall. | **Primary source** |
| **Pawn `m_pModifierProp.m_bvEnabledStateMask`** (8 × u32 bitmask; bit names from the `MODIFIER_STATE_*` enum) | The pawn's current states: STUNNED, SILENCED, IS_ASLEEP, MUTED (items disabled), SHOOTING_DISABLED, IMMOBILIZED, INVULNERABLE, VISCOUS_CUBED, SLOWED, BURNING… | 4,854 changes, 90 distinct bits. Intervals: STUNNED 125 (164 s total), SILENCED 62, SILENCED_HIDDEN 80, IS_ASLEEP 34, MUTED 49, SHOOTING_DISABLED 74, DASH_DISABLED_DEBUFF 72, INVULNERABLE 24, BURNING 43 | **CC truth.** The mask carries no source; attribute it from the modifier table (§2) |
| `m_bvEnabledPredictedStateMask`, `m_bvDisabledStateMask` | Client prediction; forced-off states | 62,003 and 38 changes | No (noise, or rare) |
| **msg 300 `CCitadelUserMessageDamage`** | One per damage instance: victim, attacker, inflictor, `ability_id`, `damage`, `pre_damage`, `damage_absorbed`, `victim_health_new`, shield, crit, flags, `hits` | 87,371 in all. 27,329 with a hero victim, 19,937 of them from a hero (160 self-damage), 566,740 hero → hero damage in total. 87 distinct ability ids, all named. | **Yes**, aggregated (§4) |
| msg 310 `RecentDamageSummary` (the death recap, with `modifier_records`) | It would have been ideal | **0**: not recorded in the demo | n/a |
| msg 325 `ModifierApplied`, 327 `AuraModifierApplied` | | **0** | n/a |
| msg 367 / 368 combat log | | **0** (a GC-side request, not in the demo) | n/a |
| particles | | not probed. The modifier table already gives what particles would. | No |
| Controller damage/heal totals | Only `m_iGuidedBotMatch*` fields, all 0 | | No (so msg 300 can't be cross-checked in-demo) |

## 2. Per effect: what we can know

| Field | Source | Reliability on 129738985 |
|---|---|---|
| Target hero (→ team, slot) | `parent` ehandle → pawn | **High.** It's a direct handle. |
| Source hero (→ slot) | `caster` ehandle → pawn | **High** when it's a hero: 14,363 of 17,432 applications. 7,349 are self-cast, 6,793 from an enemy hero. The rest come from troopers, neutrals, bosses or world zones; their caster is a non-pawn entity, kept as "not a hero". |
| Ability or item that caused it | `ability_subclass` token | **High.** Set on 12,559 of 17,432 applications (3,604 of 4,196 of the icon-shown ones), and all 182 ids resolve. Generic CC modifiers carry the real cause: `modifier_citadel_tossup` → `viscous_telepunch` (112), `modifier_citadel_knockdown` → `viscous_goo_bowling_ball` (20), `modifier_citadel_stunned_no_cc_diminish` → `citadel_ability_bull_charge` (22), `modifier_citadel_push` → melee. |
| Start | the "applied" delta | **High** (tick-exact). |
| End | the explicit "removed" delta | **High.** Do **not** use `duration`: of 7,649 finite-duration intervals, only 3,849 ended within ±0.1 s of it, 2,679 ended early (purge, death) and 1,121 late (refreshes; `last_applied_time` changed 239,075 times). |
| Stacks | `stack_count`, `max_stack_count` | **High** as a number: 5,361 stack changes, 571 applications already stacked. What a stack means varies per modifier. |
| CC state (stunned, silenced, asleep…) | pawn mask | **High**, but sourceless. A same-tick (≤ 0.07 s) enemy-hero modifier application explains 109 of 125 stuns, 61 of 62 silences, 33 of 34 sleeps, 73 of 74 disarms, 47 of 49 mutes and all 72 dash-disables. The rest have a non-hero cause (neutrals, bosses). Pick the modifier by name, preferring the generic `modifier_citadel_*` CC modifiers or one whose definition sets that state, rather than "first in tick". |
| DoT damage per tick | msg 300 with the DoT's `ability_id` | **High** (actual numbers). For example `ability_afterburn` dealt 394 hits for 15,441 damage, `upgrade_toxic_bullets` 645 for 19,137. |
| Magnitude (slow %, armour shred %, heal/s) | not on the wire in named form: `float1`/`float2` change about 30k times, meaning unknown | **Guessed.** Derivable from catalog ability properties × the ability tier ([abilities-and-items.md](abilities-and-items.md) §2), but that's interpretation. Leave it out of v1. |
| Visible to players? | definition `m_bIsHidden`, `m_strSmallIconCssClass` / `m_strHudIcon` (from game data, not the demo) | **Medium.** The game marks most modifiers hidden: zipline riding, shop zones, item watchers, `modifier_delayed_apply` (907, 0.02 s). Having an icon class is the game's own "show this on the health bar" signal. The probe's inheritance resolution was approximate (shared leaves like `modifier_citadel_base_buildup` collide), so the icon-set counts below are ±10%. |

Noise to drop: on heroes, the top modifiers by count are mostly plumbing:
- `modifier_delayed_apply`, zipline riding, cauldron proximity, jetpacking, `modifier_citadel_uihudmessage`;
- trooper-medic regen zones, shop/fountain/tunnel/interior zones, the rope-proximity check.

## 3. Mapping to names and icons

- **The id** is `modifier_subclass`, a `CUtlStringToken`: MurmurHash2, seed `0x31415926`, the same `token()` as `parse.rs`. It hashes the **qualified** name: the owning ability, then the chain of nested subclass names, joined by `/`. For example `upgrade_toxic_bullets/modifier_item_bleeding_bullets_active/modifier_item_bleeding_bullets_damageovertime`.
  - 470 of 479 hero modifiers matched as qualified names from `abilities.vdata`.
  - The rest are generic modifiers such as `modifier_citadel_knockdown`, `modifier_citadel_tossup` and `modifier_citadel_in_shop`. They hash by bare name and are defined in `modifiers.vdata` (boon-data also lists them from `client_strings.txt`).
  - The ability id is the plain token of the ability or item name, the same one the items study uses.
- **What the pack extractor needs** (extending the items/abilities extraction, which already plans to read `scripts/abilities.vdata_c`):
  1. Walk every ability record's nested `subclass` values (any KV3 object with `_class` / `_my_subclass_name`), building `ability/…/modifier`. Then hash it, and store `{token → qualified name, hidden, icon class, hud icon, localisation key, debuff type, enabled-state mask}`. Do the same for `scripts/modifiers.vdata_c` with bare names. Expect about 2,100 records; the 6860 catalog has 2,086.
  2. Read the `MODIFIER_STATE_*` index → name table, for the pawn mask. boon-data ships it as `modifier_states`. In the game files it's an engine enum, so **to confirm** where it lives, or vendor the roughly 15 CC bits we use as a constant list.
     - **Still open (2026-11-10):** none of the vdata files the extractor reads holds the index → name table. Masks there are written as names (`MODIFIER_STATE_SLOW_IMMUNE | …`), and the pack keeps those names per modifier (`states`), so the vendored `timeline::CC_STATES` indices stay.
  3. Display names: `m_sLocalizationName` is present on about 60% of the icon-shown intervals (2,550 of 4,196). Otherwise use the causing ability's or item's display name, which the items extraction already provides. **To confirm:** the localisation file holding modifier strings. I did not open the VPK.
     - **Confirmed (2026-11-10, client 6860):** the strings are spread over loose files. Of the modifiers with an `m_sLocalizationName`, 108 are in `citadel_heroes`, 77 in `citadel_attributes` (`modifier_citadel_knockdown` "Stunned"), 54 in `citadel_gc_mod_names`, 21 in `citadel_mods` and 10 in `citadel_main`. Another 100 keys are in none of them. The pack reads all five files. Of the 2,067 modifier records, 315 have a localised name and 927 take their ability's; the other 825 fall back to the internal name.
     - **Built (2026-11-10):** the modifier records also come from `scripts/misc.vdata_c` (pickups and props, for example `wp_permanent_pickup/modifier_permanent_pickup`) and `scripts/npc_units.vdata_c` (auras, for example `npc_boss_tier2/friendly_aura/target_near_walker`). 60 of the 479 modifiers seen on heroes are defined only there. With them, 470 of the 479 resolve from vdata, as the study found. **Correction:** the other 9 aren't in `modifiers.vdata`. No vdata defines them, including `modifier_citadel_tossup` and `modifier_citadel_push`, which carry real causes (§2). The extractor lists 6 of them by name (`abilities::ENGINE_MODIFIERS`):
       - `modifier_citadel_tossup`, `modifier_citadel_push` and `modifier_player_pinged`;
       - `modifier_citadel_pre_match_wait`, `modifier_invis_fading` and `modifier_learning_hero_ability`, which are localisation keys only.

       That makes 476 of 479 on heroes, and 707 of the 711 seen on any entity. All 182 `ability_subclass` ids resolve: 104 items and 78 abilities.
  4. Icons: `m_strSmallIconCssClass` is a Panorama CSS class; this match uses 44 of them (`stunned`, `slowed`, `bleeding_dot`, `afterburn_dot`, `asleep`, `immobilize`, `silence_proc`…). Mapping a class to an image means parsing Panorama CSS, which isn't worth it. Recommended instead:
     - use the **causing ability's or item's icon**, which the items extraction already brings;
     - add about 8 hand-made state glyphs (stun, silence, sleep, disarm, immobilise, slow, burn/bleed, invulnerable) for the generic CC modifiers.
- **Do not use boon-data at runtime.** `boon::CatalogNames` and `EffectiveModifierState::with_catalog` download it from GitHub on first use. The worker should hash and look up against our own pack, the same way hero names work. boon's raw `ModifierState` needs no catalog.
- Legal posture: the same as the portraits. Names and icons are extracted by the operator from their own install, served from `PACKS_DIR` and never committed.

## 4. Combat data

- **Per-hit damage is there** (msg 300): attacker, victim, ability, final damage, absorbed, victim's new health, crit. It enables "damage taken from X", DoT totals and a real death recap.
- 100 lethal hits (`victim_health_new == 0`) over 79 distinct (hero, second) pairs, against 74 `HeroKilled` messages. The probe also kept post-game ticks. 98 of the 100 lethal hits had a hero attacker.
- **Not cross-checked:** the controller has no damage totals to compare against. The API's `player_damage` stats would be the check, on a match we've already fetched.

| Damage representation | Rows | Raw JSON | gzip -6 |
|---|---|---|---|
| (avoid) every hero → hero hit `[t, victim, attacker, ability, dmg]` | 19,937 | 413,630 B | 83,119 B |
| per second × (victim, attacker, ability), hero victims | 11,427 | 204,486 B | 48,335 B |
| **death recap**: damage per (attacker, ability) in the 10 s before each death | 79 deaths, about 9.7 sources each | **15,341 B** | 3,939 B |

## 5. Cost

**Size** on 129738985 (compact table `{names:[…], rows:[[t0, t1, name_idx, slot, src, stacks]]}`, times at 0.1 s). The baseline timeline is 1,530,499 B raw (577,725 B gz), served uncompressed.

| Set | Intervals | Distinct | Raw | gz |
|---|---|---|---|---|
| (avoid) every modifier interval on a hero | 17,432 | 479 | 496,908 B (+32%) | 113,606 B |
| visible: has an icon or isn't hidden, ≥ 0.25 s | 7,110 | 234 | 203,372 B | 48,132 B |
| **game-shown: has an icon class** | 4,196 | 99 | **116,840 B (+7.6%)** | 27,428 B |
| enemy-caused only | 6,793 | 110 | 187,301 B | 42,595 B |
| enemy-caused, with an icon | 3,279 | 48 | 89,723 B | 21,778 B |
| DoTs (enemy) | 617 | 10 | 16,247 B | 4,311 B |
| **hard CC from the pawn mask** `[t0, t1, state, slot, src, ability]` | 434 | 9 states | **10,948 B** | 2,825 B |
| **death recaps** (§4) | 79 | | **15,341 B** | 3,939 B |

- **Parse time** (release, `nice -n 10`, load 7–9): the probe takes 5.3 s with modifiers and masks skipped and 7.4–7.5 s with them, so **at most +2.1 s**. That includes writing about 630k TSV rows. Merging the string table is ~475k small protobuf decodes. Real code should:
  - resolve the mask keys once;
  - read masks only on pawn change;
  - keep only hero-parent entries.

  Expect about +1 s on the worker's 9.8 s. msg 300 is already delivered to the callback, so aggregating it is cheap.
- **Memory:** boon's raw `ModifierState` peaked at 9,147 live entries: non-hero entities, and entries never removed when their entity dies. That's small; the probe's RSS was 515 MB, as the worker's already is.
- **Privacy: none new.** Everything is keyed by entity handle → pawn → the hero, team and slot the timeline already uses. The probe read no Steam or account id: `CModifierTableEntry` and msg 300 carry none, and the probe didn't decode `m_steamID`. A modifier is gameplay state.
- **FORMAT:** fold it into the planned bump (6 → 7) as `#[serde(default)]` tables beside items, levels and casts: `cc`, `effects` (with a name table) and `recaps`. Recommended payload: hard CC + game-shown effects + recaps ≈ **+143 KB raw (+9%)**, or about +34 KB gz. A leaner option is CC + DoTs + recaps at about **+42 KB raw (+3%)**, which drops buff and debuff icons. With the items study's +53 KB (items, levels, casts), the whole bump is about +196 KB raw (+13%), or +95 KB lean. If size bites, `Content-Encoding: gzip` on the timeline route would cut it about 2.6×, independent of FORMAT.

## 6. UX sketch

All replay-tier; the API tier shows "untracked", as the ult ring does.

1. **CC badge on the hero token** (recommended first). While a hero is stunned, asleep, silenced, disarmed, muted, cubed or immobilised, draw one small glyph on the token (the strongest state wins). It's 434 intervals per match, high signal for coaching ("who got caught, by what") and cheap. Hover labels stay pure labels, so the tooltip doesn't change.
2. **Death recap** (recommended first). Clicking a death in the events list, or the existing death marker, opens "last 10 s": damage by attacker and ability as a bar (with DoTs included), plus the CC received in that window, using the same CC intervals. It answers "why did I die" and costs 15 KB.
3. **"Status now" row in the build card** (option B in [abilities-and-items.md](abilities-and-items.md)). Show icons of the game-shown effects on the hero at the playhead, with a remaining-time sweep and stacks, using the causing item's or ability's icon. Its data is the `effects` table.
4. **"CC" chip in the events log**, off by default: "X stunned Y (ability)", 434 rows. A DoT chip isn't worth it; DoTs belong in the recap.
5. **Not recommended now:** a ring of buff icons around every token on the map (clutter at 12 heroes), and per-hit damage tables.

**Minimal first step:** ship 1 and 2 (`cc` + `recaps`, about 26 KB raw). Carry `effects` in the same FORMAT bump so 3 can land later without another re-upload.

## 7. Questions for the operator

1. **Payload for the bump:** the full game-shown effects set (+117 KB raw, enables the build-card "status now" row), or lean CC + DoTs + recaps only (+42 KB)? Recommendation: full, because a later bump would mean re-uploads.
2. **CC badges on map tokens:** on by default, or behind a layer toggle?
3. **Death recap window:** is 10 s right? Should it include healing received?
4. **Icons:** OK to use the causing ability's or item's icon, plus about 8 hand-made state glyphs, instead of extracting the game's status-icon CSS?
5. **API tier:** worth checking the metadata damage matrix for an "overall damage taken from X" on API-only matches? That needs one untrimmed payload, which a match we've already fetched would provide.
