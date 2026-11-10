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

The numeric-field census found no direct bullet/spirit resistance or category progression
fields in the observed controller/pawn data. It checked paths containing resistance, armor,
bullet, spirit, tier, item-bar and progression terms. This is a bounded name audit, not proof
that no packed or differently named field can encode them. Controller
`m_vecStatViewerModifierValues` carries modifier contributions; those are not the live
scoreboard totals. Do not sum them or use today's catalog to invent a result. Further work
needs a matching-build game HUD implementation or equivalent authoritative source, with
validation under timed buffs/debuffs, upgrades and item changes.

The existing item pack defines category, shop tier and catalog cost. Those do not establish
the scoreboard's Weapon/Spirit/Vitality progression formula. The reference's active-item
marking also remains unavailable: the current extracted record lacks an active designation,
and a missing cast is not evidence of passivity. These remain backlog work.
