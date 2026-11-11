# Recorded scoreboard values (2026-11-10)

Bounded audit of the standard 6v6 replay 129738985 using boon 0.19.0. The
`scoreboard_probe` example walks only player controller/pawn numeric fields and emits
aggregate field ranges. It never emits player names, account identifiers or entity identities.
No game assets or replay bytes are checked in.

Authoritative sources implemented in timeline format 8:

| Timeline field | Demo source | Verified match observations |
| --- | --- | --- |
| `level` | controller `m_PlayerDataGlobal.m_iLevel` | 476 changes, positive levels 1–45 |
| `kills` | controller `m_PlayerDataGlobal.m_iPlayerKills` | starts at zero for all 12; final sum 74, matching 74 deaths |
| `assists` | controller `m_PlayerDataGlobal.m_iPlayerAssists` | starts at zero for all 12; final sum 134 |
| `max_health` | active pawn `m_iMaxHealth` | 83 positive changes, 690–4560 HP |

The level is separate from ability upgrades and pawn `m_nLevel`; no conversion or
inference is applied. Pregame controller level zero is not treated as a hero level.
Maximum HP is the recorded integer, independent of health percent and catalog formulas.
**It refreshes only at (re)spawn,** so it's stale between spawns: it matched the live metadata value at 10 of 132 snapshots (research map "Known dead ends";
stat-calc-spike.md "Recorded max health", branch `stat-calc`).
Kills and assists are scoreboard counters, not damage attribution or inferred death credit.
They establish totals, not which individual death awarded which assistant.

All four fields are optional sparse `[game_second, value_or_null]` series, sampled on the
existing replay's 1 Hz game clock, including its pause correction. Entries take effect at
their integer second. The first available value is recorded at the time it is observed;
there is no backfill from future samples. A missing observation after an available value
emits null; it is not held through that gap. Kills/assists zero means recorded zero. Missing,
empty, before-first-entry and null mean unknown. Maximum HP requires an active pawn with a
positive max-health value, whether alive or dead. No derived health absolute value is added.

The summary/API tier remains unchanged and omits all four. Metadata `PlayerStats` protobuf
has kills/assists at coarse stat checkpoints, but the current server only decodes checkpoint
time and net worth. Death metadata has a killer slot but no assist-credit list. Neither is
silently promoted to exact counters here; no untrimmed metadata payload was fetched.

Format 8 preserves serde defaults for old timelines and optional TS fields. The existing
server policy re-fetches stale CDN caches on open when their stamp is below `FORMAT`;
uploaded old timelines remain readable and need re-upload/reparse for the new layer. No
cache contents were modified by this implementation.

## Remaining fields

### Bullet and spirit resistance: no recorded source (2026-11-10, proto-resist)

Not implemented; the UI keeps "—". Replay 129738985 (build 6839) doesn't record a hero's
bullet or spirit resist total anywhere we can read. The in-game HUD computes it client-side
from the active modifier list plus that build's ability/item vdata. Probes (aggregate
output only, keyed by hero id at most, never names or account ids) are in
`crates/replay/examples/`:

- **Every networked class's schema** (`schema_probe`, 929 classes, field paths matched
  recursively against resist/armor/bulletres/techres/spiritres/damagereduc/absorb/protect/
  mitig/reduc/shield/statview/modifiervalue). The only resist field is
  `CCitadel_ArmorUpgrade_AblativeCoat.m_iCurrentResistValue`, one item's own counter. The
  only stat vector is the controller's `m_vecStatViewerModifierValues`. Controller and pawn
  have no other resistance, armor or damage-reduction field.
- **`m_vecStatViewerModifierValues`, decoded** (`statviewer_probe`). Each entry is
  `{m_SourceModifierID, m_SourceAbilityID, m_eValType: EModifierValue, m_flValue}`. In the
  6860 boon-data enum, 33 is `MODIFIER_VALUE_TECH_RESIST` and 36 is
  `MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST`; reductions are 34/37. In 129738985 every
  resist entry (1813 entry-samples) comes from one of two sources:
  `modifier_permanent_pickup`, a breakable statue's permanent bonus (0.5–5 points per
  entry), or `modifier_spirit_snatch`, Spirit Snatch's stolen spirit resist (up to 60).
  None comes from a purchased item or from the hero's base. It's the stat viewer's
  breakdown of permanent stacking bonuses, not a total. Evidence: one player buys Battle
  Vest (bullet resist) at raw tick 20576 and their stat viewer gains no type-36 entry.
  Another's Weapon Shielding (tick 22084) and Spirit Shielding (tick 28198) add no
  type-36/33 entry; their one 0.5 type-36 entry is a statue pickup from tick 15382. At
  match end, all 12 players own at least one item that the 6860 vdata gives a `BulletResist`
  or `TechResist` property, such as Battle Vest, Weapon Shielding, Spirit Resilience or
  Witchmail; that catalog was used only as a cross-check. Yet per-player sums of type-33/36
  entries are 0.5–7.25 points (Spirit Snatch excepted).
- **Modifier table** (`CModifierTableEntry`, already decoded for buffs). It carries
  subclass, stacks, duration, caster and generic slots, not property values. A modifier's
  resist value lives in vdata.
- **User messages** (`citadel_usermessages.proto`). None carries a resist stat.
  `CCitadelUserMessage_Damage` has `damage` and `pre_damage`, so `damage_ratio_probe` tested
  their ratio on hero victims (87,371 messages). It mixes in attacker shred, falloff, crits
  and absorbs: for one hero and damage type, per-minute medians swing between 0.30 and 1.01,
  and single samples range 0–5. It describes one attacker's hit, not the HUD's resist, so it's rejected.

The one route to a value is calculation: modifiers and items from the replay, values from
vdata, and the game's stacking rule (boon 0.19 implements this in `hero_stats`, rules
`bullet_resist.v1`/`spirit_resist.v1`: sources stack multiplicatively, reductions in a separate
group). That is catalog-derived, and the only catalog on hand is build 6860 while this replay is
6839, so it would be today's shop stats applied to an older match. It would need operator
sign-off as a *calculated* (not recorded) value, a build-matched catalog, and validation against
in-game screenshots before it could replace "—".

### Category progression

The existing item pack defines category, shop tier and catalog cost. Those do not establish
the scoreboard's Weapon/Spirit/Vitality progression formula. The reference's active-item
marking also remains unavailable: the current extracted record lacks an active designation,
and a missing cast is not evidence of passivity. These remain backlog work.
