//! The replay timeline: what the worker writes and the server serves (spec §6a).
//!
//! It extends the metadata timeline (`crates/server/src/matches.rs`) field for field, so the
//! client reads both the same way, and adds what only a demo has: ult cooldowns, rifts,
//! powerups, zipline colours and jungle camps. One sample per game second, index = second, `0..=duration_s`.
//!
//! **Personal data:** a player is a team, a slot, a hero and, if the demo carries one, the
//! in-game name. Steam and account ids are never read from the demo, so they can't be written.

use serde::{Deserialize, Serialize};

pub const TIER: &str = "replay";

/// The worker's output format, stamped in every timeline it writes. Bump it when the worker's
/// output gains or changes a layer, so a cached timeline from an older worker can be told apart
/// (docs/backlog.md, "Replay timeline format versions"). 0: written before the stamp.
/// 1: respawn times and the urn (exploration rounds 5 and 6). 2: powerup types and spawns, and
/// when each rift's cash-in opens (exploration round 7). 3: the Rejuvenator, and each open rift's
/// capture progress and give-up deadline (timers audit, gaps 1 and 2). 4: when the enemy team
/// could see each hero (`Player::seen`; docs/research/replay-vision.md). 5: the healing pickups,
/// taken and back (`Timeline::heals`; docs/research/map-objectives-audit.md). 6: the match clock
/// holds through an in-game pause (older timelines froze on the paused frame and lost as much play
/// after it). 7: each hero's build, ability tiers, casts with their cooldowns, charges, hard CC,
/// the status effects the game shows, death recaps, height and zipline rides (`Player::items` to
/// `Player::zipline`; docs/research/abilities-and-items.md, status-effects.md, elevation.md), and
/// the tough crates, broken and back (`Timeline::crates`).
/// 8: authoritative scoreboard scalar changes (`Player::level`, `Player::max_health`, kills and assists).
/// 9: statue pickups, the permanent stat bonuses the calculated stats add (`Player::pickups`;
/// docs/research/stat-calc-spike.md).
pub const FORMAT: u32 = 9;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Timeline {
    pub match_id: u64,
    /// Unix start time. Demos don't carry one: 0 unless the server knows it from the metadata.
    pub start_time: u64,
    pub duration_s: u32,
    pub source: String,
    /// Always `"replay"`; the metadata timeline has none.
    pub tier: String,
    /// The content build from the demo header (`citadel_v6813` → 6813).
    pub build: u32,
    pub players: Vec<Player>,
    pub objectives: Vec<Objective>,
    pub mid_boss: Vec<MidBoss>,
    /// Always 0: the demo's clock is the game clock (kept for the metadata timeline's shape).
    pub reanchored: u32,
    /// Rift (`rift:` key) up from `start_s` to `end_s` (exclusive). At most one at a time.
    pub rifts: Vec<Rift>,
    pub powerups: Vec<Powerup>,
    /// Replay tier: each lane's zipline colours, the game's own (spec §6b, "Lanes").
    #[serde(default)]
    pub zips: Vec<ZipTrack>,
    /// Replay tier: jungle camps and the mid boss, alive or cleared (spec §6b, "Camps").
    #[serde(default)]
    pub camps: Vec<Camp>,
    /// Replay tier: the map's healing pickups (`heal:` keys), in the camps' shape: not up before
    /// `first_s`, then up except over each `[taken_s, back_s]` (format 5). Empty before it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub heals: Vec<Camp>,
    /// Replay tier: the map's tough crates (`tough_crate:` keys, the "Heavy boxes"), in the camps'
    /// shape: up from `first_s` except over each `[broken_s, back_s]` (format 7). Empty before it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub crates: Vec<Camp>,
    /// What happened when, for the events list (spec §6a, "Events").
    #[serde(default)]
    pub events: Vec<Event>,
    /// Lane troopers as seen in the recording (replay tier).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub troopers: Option<Troopers>,
    /// Replay tier: objectives' health over time.
    #[serde(default)]
    pub objective_health: Vec<ObjectiveHealth>,
    /// Replay tier: the Soul Urn (exploration round 6). Absent in timelines from before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub urn: Option<Urn>,
    /// Replay tier: each Rejuvenator a team held (format 3). Empty before it, or when no team
    /// took one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rejuv: Vec<Rejuv>,
    /// [`FORMAT`] of the worker that wrote it; 0 if it predates the stamp.
    #[serde(default)]
    pub format: u32,
}

/// The Soul Urn over the match (exploration round 6): where each one spawned, and its state
/// wherever it changes.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Urn {
    /// Each urn's spawn, in order: the second and the urn site (`urn:` key) it spawned over.
    pub spawns: Vec<UrnSpawn>,
    /// The urn's state from its first spawn, one entry per second it changes (the last state in
    /// that second).
    pub at: Vec<UrnAt>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct UrnSpawn {
    pub t: u32,
    pub key: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct UrnAt {
    pub t: u32,
    /// One of [`URN_STATES`]: on the ground (at `x`, `y`), carried (by `team`, `slot`), or none
    /// in the match (delivered, or not spawned yet).
    pub state: String,
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    /// Carried: the carrier's team. On the ground after a drop: the team that dropped it.
    #[serde(default)]
    pub team: Option<String>,
    /// Carried: the carrier's slot in `team`.
    #[serde(default)]
    pub slot: Option<u32>,
    /// The urn site (`urn:` key) it is to be delivered to, while that point is open.
    #[serde(default)]
    pub delivery: Option<String>,
}

pub const URN_STATES: [&str; 3] = ["ground", "carried", "none"];

/// The mid boss's reward held by a team (timers audit, gap 1): taken when its first shard is
/// picked up (`RejuvStatus` 4), over when the game says it expired (`RejuvStatus` 6), 180 s on.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Rejuv {
    /// "amber" or "sapphire".
    pub team: String,
    pub taken_s: u32,
    /// When it expires; past the end of the recording when that ends first.
    pub ends_s: u32,
    /// `[second, revives left]` from `taken_s`, where it changes (the game rules'
    /// `m_iAmberRejuvCount` / `m_iSapphireRejuvCount`: one per shard picked up, one less as a
    /// revive is used).
    pub left: Vec<[u32; 2]>,
}

/// How long a Rejuvenator lasts (generic_data.vdata `m_RejuvParams`; 180.0 s on 129738985).
pub const REJUV_S: u32 = 180;
/// The most revives a team can hold (`m_RejuvParams`: three drops).
pub const MAX_REJUV: u32 = 3;

/// One objective's health in percent: `[second, pct]` where it changes.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ObjectiveHealth {
    pub key: String,
    pub at: Vec<[u32; 2]>,
    /// Patrons only: `[second, stage]` (1, then 2 in the final phase) where it changes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stage: Vec<[u32; 2]>,
}

/// Every lane trooper alive in the recording, sampled every `every_s` seconds from 0. Sample
/// `k` per team is base64 of little-endian `[id: u16, x: i16, y: i16]` triples (world units,
/// the entity index's low 16 bits for following one trooper between samples). Gaps in the
/// recording are empty samples: nothing is invented.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Troopers {
    pub every_s: u32,
    pub amber: Vec<String>,
    pub sapphire: Vec<String>,
}

/// The most troopers one sample may carry per team.
pub const MAX_TROOPERS: usize = 256;

/// One sample's triples, or `None` if it isn't a well-formed sample.
pub fn decode_troopers(sample: &str) -> Option<Vec<(u16, i16, i16)>> {
    use base64::Engine as _;
    let b = base64::engine::general_purpose::STANDARD.decode(sample).ok()?;
    if b.len() % 6 != 0 || b.len() / 6 > MAX_TROOPERS {
        return None;
    }
    Some(b.chunks_exact(6).map(|c| (u16::from_le_bytes([c[0], c[1]]), i16::from_le_bytes([c[2], c[3]]), i16::from_le_bytes([c[4], c[5]]))).collect())
}

pub fn encode_troopers(list: &[(u16, i16, i16)]) -> String {
    use base64::Engine as _;
    let mut b = Vec::with_capacity(list.len() * 6);
    for (id, x, y) in list {
        b.extend_from_slice(&id.to_le_bytes());
        b.extend_from_slice(&x.to_le_bytes());
        b.extend_from_slice(&y.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(b)
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Player {
    /// "amber" or "sapphire".
    pub team: String,
    /// 0..5 within the team.
    pub slot: u32,
    pub hero_id: u32,
    /// The in-game name the demo carries, if any. Never an id.
    #[serde(default)]
    pub name: Option<String>,
    /// World units at each game second; `null` while dead (the pawn's life state, exactly).
    pub x: Vec<Option<i32>>,
    pub y: Vec<Option<i32>>,
    /// Health percent at each game second.
    pub health: Vec<u8>,
    pub deaths: Vec<u32>,
    /// Format 8, replay tier: `[second, hero level]` on observed changes. Before the first
    /// entry or at a null entry the value is unavailable; empty on older/API timelines.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub level: Vec<(u32, Option<u32>)>,
    /// `[second, maximum HP]` on observed changes, including while dead if the pawn has it.
    /// Null marks a missing pawn/value; never inferred from health percent or item stats.
    /// The recorded value refreshes only at (re)spawn, so it's stale between spawns (it matched
    /// live metadata at 10 of 132 snapshots; docs/research/README.md "Known dead ends").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub max_health: Vec<(u32, Option<u32>)>,
    /// Format 9, replay tier: `[second, [max health, spirit power, weapon damage %, bullet resist
    /// %, spirit resist %]]` where the hero's statue-pickup totals change ([`PICKUP_STATS`]; the
    /// controller's stat viewer, `m_vecStatViewerModifierValues`). Zero before the first entry;
    /// empty: no pickups, or a timeline from before format 9.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pickups: Vec<(u32, [f32; 5])>,
    /// Controller's authoritative player-kill total; zero is known, null unavailable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kills: Vec<(u32, Option<u32>)>,
    /// Controller's authoritative assist total; never inferred from damage recaps.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assists: Vec<(u32, Option<u32>)>,
    /// `[game second, net worth]` whenever it changed, at most once a second.
    pub souls: Vec<[u32; 2]>,
    /// Ult cooldown remaining in percent at each second (0 = ready); `null` while untrained.
    /// Maps to `PlayerState.ult_cooldown`.
    pub ult: Vec<Option<u8>>,
    /// `[died_s, back_s]` per death: when the hero respawns (exploration round 5). Absent in
    /// timelines from before it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub respawn: Vec<[u32; 2]>,
    /// `[start_ds, end_ds)` in tenths of a second: when the enemy team could see this hero on
    /// its minimap (the team's `m_bVisibleOnMap`, format 4). In order; gaps under
    /// [`SEEN_MERGE_DS`] are merged away. Empty: never seen, or a timeline from before it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub seen: Vec<[u32; 2]>,
    // ---- format 7: stored, not shown yet (operator 2026-11-09). Ids are the game's
    // CUtlStringToken of the internal name ([`token`]); names come from the pack. Times in
    // tenths of a second (`_ds`) unless said otherwise. `src` is the causing hero's index in
    // `Timeline::players`, [`NO_HERO`] when it wasn't a hero. Empty before format 7. ----
    /// `[t_ds, item_id, kind]` per shop event, in order: [`ITEM_BOUGHT`], [`ITEM_SOLD`],
    /// [`ITEM_MERGED`] (a component used up by an upgrade bought in the same instant) or
    /// [`ITEM_REMOVED`] (gone otherwise). The build at t is the bought minus the rest up to t.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<[u32; 3]>,
    /// `[second, ability_id, level]` where an ability's level changes: 1 unlocked, 2 to 4 its
    /// tiers 1 to 3 (`m_vecAbilityUpgradeState`), in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub abilities: Vec<[u32; 3]>,
    /// `[t_ds, ability_id, cooldown_end_ds]` per ability or active item cast (the game's
    /// `ImportantAbilityUsed`), in order. The cooldown end is the ability's own
    /// (`m_flCooldownEnd`), 0 when the recording didn't show it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub casts: Vec<[u32; 3]>,
    /// `[t_ds, ability_id, charges]` where a charged ability's or item's charges left change
    /// (`m_iRemainingCharges`), in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub charges: Vec<[u32; 3]>,
    /// `[start_ds, end_ds, state, src, ability_id]` per hard-CC interval on this hero (the pawn's
    /// enabled-state mask; `state` is one of [`CC_STATES`]), with the enemy hero and ability the
    /// game applied it with in the same instant, where there was one (ability 0: unknown).
    /// In order of start.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cc: Vec<[u32; 5]>,
    /// `[start_ds, end_ds, effect_id, src, ability_id, stacks]` per status effect on this hero
    /// that the game shows an icon for, in order of start. `effect_id` is the modifier's
    /// token; `stacks` the most it reached.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<[u32; 6]>,
    /// One per death: who hurt the hero with what in the [`RECAP_S`] before it, and the CC it
    /// took then.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recaps: Vec<Recap>,
    /// `[second, level]` where the hero's height changes, held [`HOLD_S`] seconds: 0 level
    /// ground, 1 above it, 2 below (its own team's minimap feed, `m_eHeight`). Level before the
    /// first entry.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub height: Vec<[u32; 2]>,
    /// `[from_s, to_s)` while riding a zipline (`m_eZipLineLaneColor`), held [`HOLD_S`] seconds.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub zipline: Vec<[u32; 2]>,
}

/// A death's recap (docs/research/status-effects.md §4).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Recap {
    /// The lethal hit, in tenths of a second.
    pub t: u32,
    /// `[src, ability_id, damage]` summed over the window, most damage first (ability 0: no
    /// ability, such as a trooper's shot). Here `src` may also be [`NPC_SRC`] + a
    /// [`NPC_KINDS`] index: not a hero, the attacker's class (added within format 9: older
    /// timelines have [`NO_HERO`] there).
    pub damage: Vec<[u32; 3]>,
    /// The hero's `cc` rows that overlap the window.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cc: Vec<[u32; 5]>,
}

/// The statue pickups each [`Player::pickups`] column sums: the stat-viewer source modifier
/// (`<kind>_permanent_pickup[_lv2|_lv3]/modifier_permanent_pickup`) and its `EModifierValue`
/// (6839/6860 enum: 46 health, 169 spirit power, 20 weapon damage, 36 bullet resist, 33 spirit
/// resist). Each stat-viewer entry is that source's running total.
pub const PICKUP_STATS: [(&str, u32); 5] = [("hp", 46), ("spirit", 169), ("wp", 20), ("bulletresist", 36), ("spiritresist", 33)];

/// [`PICKUP_STATS`] as `(source modifier token, value type, column)`.
pub fn pickup_sources() -> Vec<(u32, u32, usize)> {
    let mut out = Vec::new();
    for (column, (kind, value_type)) in PICKUP_STATS.iter().enumerate() {
        for level in ["", "_lv2", "_lv3"] {
            out.push((token(&format!("{kind}_permanent_pickup{level}/modifier_permanent_pickup")), *value_type, column));
        }
    }
    out
}

/// `Player::items` kinds.
pub const ITEM_BOUGHT: u32 = 0;
pub const ITEM_SOLD: u32 = 1;
pub const ITEM_MERGED: u32 = 2;
pub const ITEM_REMOVED: u32 = 3;
/// `src` when the cause wasn't a hero (a trooper, a neutral, the world) or isn't known.
pub const NO_HERO: u32 = 255;
/// A recap row's `src` for a non-hero attacker: `NPC_SRC + k`, `k` an index in [`NPC_KINDS`].
pub const NPC_SRC: u32 = 256;
/// The non-hero attackers a recap names, in index order (append only: an index is stored). From
/// msg 300's `attacker_class` and `attacker_subclass` (the token of the unit's vdata name), read
/// on 129738985 (examples/recap_source_probe.rs): class 4 a lane trooper (`trooper_normal`,
/// `trooper_medic`, `trooper_melee`), 5 a guardian, 6 a neutral camp or Sinner's Sacrifice
/// (`neutral_sinners_sacrifice`), 8 the mid boss (`npc_super_neutral`), 22 the base's sentry
/// turret, 29 a walker, 30 a base guardian, 31 a patron; 1 is a hero pawn. The web's names (the
/// game's, citadel_main) are in `player/recap.ts` `NPC_KINDS`, same order.
pub const NPC_KINDS: [&str; 11] = ["trooper", "medic_trooper", "melee_trooper", "guardian", "walker", "base_guardian", "patron", "mid_boss", "neutral", "sinners_sacrifice", "sentry"];

/// A non-hero attacker's [`NPC_KINDS`] index from msg 300's `attacker_class` and
/// `attacker_subclass`; `None` for a hero or a class not seen.
pub fn npc_kind(class: Option<u32>, subclass: Option<u32>) -> Option<u32> {
    let sub = subclass.unwrap_or(0);
    Some(match class? {
        4 if sub == token("trooper_medic") => 1,
        4 if sub == token("trooper_melee") => 2,
        4 => 0,
        5 => 3,
        29 => 4,
        30 => 5,
        31 => 6,
        8 => 7,
        6 if sub == token("neutral_sinners_sacrifice") => 9,
        6 => 8,
        22 => 10,
        _ => return None,
    })
}
/// The hard-CC states kept, as `MODIFIER_STATE_*` indices (the pawn mask's bit numbers; names
/// from boon-data's catalog, docs/research/status-effects.md §1): immobilized, disarmed, muted,
/// silenced, stunned, dash disabled, shooting disabled, asleep, Viscous's cube.
pub const CC_STATES: [u32; 9] = [13, 14, 15, 17, 20, 59, 68, 81, 129];
/// A death recap's window, in seconds.
pub const RECAP_S: u32 = 10;
/// How long a height or zipline state must hold, in seconds, to count (elevation.md §1).
pub const HOLD_S: usize = 2;

/// CUtlStringToken: MurmurHash2 of the lower-cased name, seed 0x31415926 (the game's ids for
/// items, abilities and modifiers).
pub fn token(name: &str) -> u32 {
    const M: u32 = 0x5bd1_e995;
    let key = name.to_ascii_lowercase();
    let key = key.as_bytes();
    let mut h = 0x3141_5926 ^ key.len() as u32;
    let (chunks, r) = key.as_chunks::<4>();
    for c in chunks {
        let mut k = u32::from_le_bytes(*c).wrapping_mul(M);
        k ^= k >> 24;
        h = h.wrapping_mul(M) ^ k.wrapping_mul(M);
    }
    if r.len() >= 3 {
        h ^= u32::from(r[2]) << 16;
    }
    if r.len() >= 2 {
        h ^= u32::from(r[1]) << 8;
    }
    if let Some(&b) = r.first() {
        h = (h ^ u32::from(b)).wrapping_mul(M);
    }
    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^ (h >> 15)
}

/// Hidden gaps shorter than this (tenths of a second) are merged into the intervals around them:
/// half of all gaps are under a second, flicker as a hero steps along a sight line
/// (docs/research/replay-vision.md, "Size").
pub const SEEN_MERGE_DS: u32 = 5;

/// A hero's `seen` intervals: each non-empty and within the match, in order, gaps at least
/// [`SEEN_MERGE_DS`] apart (which also bounds how many there can be).
pub fn seen_ok(r: &[[u32; 2]], duration_s: u32) -> bool {
    let end = duration_s.saturating_mul(10);
    r.iter().all(|[a, b]| a < b && *b <= end) && r.windows(2).all(|w| w[1][0] >= w[0][1].saturating_add(SEEN_MERGE_DS))
}

/// Format 7's per-player bounds: more than this isn't a hero we know (129738985, 44 minutes:
/// at most 23 shop events, 4 abilities × 4 levels, ~300 casts, ~250 effects per hero).
pub const MAX_ITEMS: usize = 512;
pub const MAX_ABILITY_CHANGES: usize = 256;
pub const MAX_CASTS: usize = 4096;
pub const MAX_CHARGES: usize = 8192;
pub const MAX_CC: usize = 2048;
pub const MAX_EFFECTS: usize = 8192;
pub const MAX_RECAPS: usize = 256;
/// Rows per recap: sources (hero × ability) in its window, and CC rows.
pub const MAX_RECAP_ROWS: usize = 64;
pub const MAX_STACKS: u32 = 1000;
/// A cast's cooldown may end at most this long after it (tenths; ults run ~2–3 minutes).
pub const MAX_COOLDOWN_DS: u32 = 12_000;
/// The most charges an ability holds.
pub const MAX_CHARGE_COUNT: u32 = 32;
/// Damage one source may deal in a recap's window.
pub const MAX_RECAP_DAMAGE: u32 = 1_000_000;

/// A hero's format-7 fields: within the match, in order, ids set, sources a hero of the match,
/// counts and sizes bounded.
pub fn extras_ok(p: &Player, duration_s: u32, players: usize) -> bool {
    let end = duration_s.saturating_mul(10);
    let src_ok = |s: u32| s == NO_HERO || (s as usize) < players;
    let rising = |a: u32, b: u32| a <= b;
    let cc_ok = |r: &[u32; 5]| r[0] < r[1] && r[1] <= end && CC_STATES.contains(&r[2]) && src_ok(r[3]);
    p.items.len() <= MAX_ITEMS
        && p.items.iter().all(|[t, id, k]| *t <= end && *id != 0 && *k <= ITEM_REMOVED)
        && p.items.windows(2).all(|w| rising(w[0][0], w[1][0]))
        && p.abilities.len() <= MAX_ABILITY_CHANGES
        && p.abilities.iter().all(|[s, id, l]| *s <= duration_s && *id != 0 && *l <= 4)
        && p.abilities.windows(2).all(|w| rising(w[0][0], w[1][0]))
        && p.casts.len() <= MAX_CASTS
        && p.casts.iter().all(|[t, id, cd]| *t <= end && *id != 0 && (*cd == 0 || (t < cd && *cd <= t.saturating_add(MAX_COOLDOWN_DS))))
        && p.casts.windows(2).all(|w| rising(w[0][0], w[1][0]))
        && p.charges.len() <= MAX_CHARGES
        && p.charges.iter().all(|[t, id, n]| *t <= end && *id != 0 && *n <= MAX_CHARGE_COUNT)
        && p.charges.windows(2).all(|w| rising(w[0][0], w[1][0]))
        && p.cc.len() <= MAX_CC
        && p.cc.iter().all(cc_ok)
        && p.cc.windows(2).all(|w| rising(w[0][0], w[1][0]))
        && p.effects.len() <= MAX_EFFECTS
        && p.effects.iter().all(|[a, b, id, src, _, st]| a <= b && *b <= end && *id != 0 && src_ok(*src) && *st <= MAX_STACKS)
        && p.effects.windows(2).all(|w| rising(w[0][0], w[1][0]))
        && p.recaps.len() <= MAX_RECAPS
        && p.recaps.windows(2).all(|w| w[0].t < w[1].t)
        && p.recaps.iter().all(|r| {
            r.t <= end
                && r.damage.len() <= MAX_RECAP_ROWS
                && r.damage.iter().all(|[src, _, d]| (src_ok(*src) || (NPC_SRC..NPC_SRC + NPC_KINDS.len() as u32).contains(src)) && *d > 0 && *d <= MAX_RECAP_DAMAGE)
                && r.cc.len() <= MAX_RECAP_ROWS
                && r.cc.iter().all(|c| cc_ok(c) && c[0] <= r.t && c[1] + RECAP_S * 10 >= r.t)
        })
        && p.height.len() <= duration_s as usize + 1
        && p.height.iter().all(|[s, l]| *s <= duration_s && *l <= 2)
        && p.height.windows(2).all(|w| w[0][0] < w[1][0] && w[0][1] != w[1][1])
        && p.zipline.len() <= duration_s as usize / 2 + 1
        && p.zipline.iter().all(|[a, b]| a < b && *b <= duration_s + 1)
        && p.zipline.windows(2).all(|w| w[0][1] < w[1][0])
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Objective {
    pub key: String,
    pub kind: String,
    pub team: String,
    pub lane: u32,
    pub destroyed_s: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct MidBoss {
    pub destroyed_s: u32,
    /// Not in the demo's entities: always "unknown" for the replay tier.
    pub team_killed: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Rift {
    pub key: String,
    /// Its spawner appears (the rift is announced).
    pub start_s: u32,
    pub end_s: u32,
    /// When its cash-in opened (`m_timeKothCashInStarted`, exploration round 7): it spawns then.
    /// Absent in timelines from before format 2, or if the recording ends first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_s: Option<u32>,
    /// The second its cash-in gives up if no team captures it (`m_timeKothGiveUp`, 60 s after
    /// it opens). Format 3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub give_up_s: Option<u32>,
    /// Each team's capture progress while its cash-in is open (`m_vecTeamKothStates[]`, 0 Amber,
    /// 1 Sapphire): `[tenths of a second, amber %, sapphire %]`, sampled every
    /// [`CAPTURE_EVERY_DS`] tenths. A run of equal samples keeps only its ends, so the values
    /// between two rows are their straight line. Format 3.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capture: Vec<[u32; 3]>,
}

/// How often an open rift's capture progress is sampled, in tenths of a second: 2 Hz. Progress
/// runs 0 to 100% in 6 to 40 s, so the straight line between samples is within about a percent
/// of it, and a match's rifts add a few KB.
pub const CAPTURE_EVERY_DS: u32 = 5;
/// How long after it opens a rift's cash-in may give up (60 s in misc.vdata), with room.
pub const MAX_GIVE_UP_S: u32 = 300;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Powerup {
    pub key: String,
    /// Per second: 1 available, 0 taken (or not yet spawned).
    pub available: Vec<u8>,
    /// `[from, to)` seconds where the spawner wasn't in the recording and the value is held.
    pub stale: Vec<[u32; 2]>,
    /// Each spawn and the buff it gave, from the site's `CCitadel_Pickup_Modifier`
    /// (`m_nSubclassID`, exploration round 7). Empty before format 2.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spawns: Vec<PowerupSpawn>,
}

/// One powerup spawn: the second, the buff (one of [`BUFFS`]) and when it was taken, if it was.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PowerupSpawn {
    pub t: u32,
    pub buff: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taken_s: Option<u32>,
}

/// The bridge buffs (misc.vdata `citadel_item_powerup_spawner.m_mapPickupChances`): the pickup
/// name without `_powerup_pickup`, as the minimap's `powerup_<buff>` class has it.
pub const BUFFS: [&str; 4] = ["gun", "survival", "casting", "movement"];

/// One lane's zipline colours as the game networks them (`CCitadelZipLineNode.m_iTeamNum`,
/// exploration round 4): Amber owns the rope over `[0, amber_t]`, Sapphire over
/// `[sapphire_t, 1000]`, and the gap between is uncoloured. `t` is `Wave.t`'s scale.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ZipTrack {
    /// `lane1`, `lane4` or `lane6`, as `Wave.lane`.
    pub lane: String,
    /// `[second, amber_t, sapphire_t]` from second 0, then wherever either edge moves. Amber's
    /// edge is 0 when it owns no node, Sapphire's 1000.
    pub at: Vec<[u32; 3]>,
}

/// A jungle camp (or the mid boss) from the game rules' respawn timers (exploration round 3):
/// not yet spawned before `first_s`, then alive except while cleared.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Camp {
    /// The camp's (`camp:`) or the mid boss's (`mid_boss:`) site key.
    pub key: String,
    /// The second it first spawns (0: up from the start).
    pub first_s: u32,
    /// `[cleared_s, respawn_s]`, in order. The respawn can fall after the match ends.
    pub cleared: Vec<[u32; 2]>,
}

/// One match event. The metadata timeline (crates/server/src/matches.rs) uses the same shape
/// with what it has: deaths (with killer and place when the match data has them), objectives
/// and mid boss kills. Only a replay has rifts and powerups.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Event {
    /// Game second.
    pub t: u32,
    /// One of [`EVENT_KINDS`].
    pub kind: String,
    /// The team the event belongs to: the hero's, the objective's owner's, the capturing
    /// team's, or the team that gained the souls lead.
    #[serde(default)]
    pub team: Option<String>,
    /// The player (`team`, `slot`), for deaths.
    #[serde(default)]
    pub slot: Option<u32>,
    #[serde(default)]
    pub hero_id: Option<u32>,
    /// Who killed them, when the data says.
    #[serde(default)]
    pub by: Option<Who>,
    /// The board key involved (objective, rift, powerup).
    #[serde(default)]
    pub key: Option<String>,
    /// Where, in world units, when known.
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    /// A size: the souls swing, for `souls_swing`.
    #[serde(default)]
    pub amount: Option<u32>,
    /// The ability's internal name, for `ult` (the game's `ImportantAbilityUsed`).
    #[serde(default)]
    pub ability: Option<String>,
    /// For `powerup_spawn` and `powerup_taken`: the buff, one of [`BUFFS`] (replay, format 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buff: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Who {
    pub team: String,
    pub slot: u32,
    pub hero_id: u32,
}

pub const EVENT_KINDS: [&str; 15] = [
    "death",
    "objective",
    "mid_boss",
    "rift_up",
    "rift_capture",
    "powerup_spawn",
    "powerup_taken",
    "souls_swing",
    "ult",
    "urn_pickup",
    "urn_drop",
    "urn_delivered",
    "rejuv_taken",
    "rejuv_revive",
    "rejuv_expired",
];

/// An ability's internal name as the timeline keeps it: `[a-z0-9_]`, at most 64.
pub fn plausible_ability(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// A team's souls lead moving by at least this much within [`SWING_WINDOW`] is an event.
pub const SWING_SOULS: i64 = 5000;
pub const SWING_WINDOW: u32 = 60;

/// Big souls swings from players' `[second, net worth]` samples (either tier): when the
/// Amber-minus-Sapphire lead has moved by [`SWING_SOULS`] within the last [`SWING_WINDOW`]
/// seconds, and still has ten seconds on, one event for the team it moved toward, then none for
/// a window.
pub fn souls_swings(players: &[(String, Vec<[u32; 2]>)], duration_s: u32) -> Vec<Event> {
    let worth = |souls: &[[u32; 2]], t: u32| souls.iter().take_while(|s| s[0] <= t).last().map_or(0, |s| i64::from(s[1]));
    let mut times: Vec<u32> = players.iter().flat_map(|(_, s)| s.iter().map(|x| x[0])).filter(|t| *t <= duration_s).collect();
    times.sort_unstable();
    times.dedup();
    let lead = |t: u32| players.iter().map(|(team, s)| if team == "amber" { worth(s, t) } else { -worth(s, t) }).sum::<i64>();
    let mut out = Vec::new();
    let mut quiet_until = 0;
    for &t in &times {
        // The first two minutes are starting souls arriving player by player, not swings.
        if t < quiet_until || t < 2 * SWING_WINDOW {
            continue;
        }
        let then = lead(t.saturating_sub(SWING_WINDOW));
        let moved = lead(t) - then;
        // Players' samples don't all land on the same second: a swing must still be there ten
        // seconds on, so one team's update arriving first isn't a swing.
        let held = lead((t + 10).min(duration_s)) - then;
        if moved.abs() >= SWING_SOULS && held.abs() >= SWING_SOULS && held.signum() == moved.signum() {
            out.push(Event {
                t,
                kind: "souls_swing".into(),
                team: Some(if moved > 0 { "amber" } else { "sapphire" }.into()),
                slot: None,
                hero_id: None,
                by: None,
                key: None,
                x: None,
                y: None,
                amount: Some(moved.unsigned_abs().min(u64::from(u32::MAX)) as u32),
                ability: None,
                buff: None,
            });
            quiet_until = t + SWING_WINDOW;
        }
    }
    out
}

/// A bare event of `kind` at `t`; callers fill in the rest.
pub fn event(t: u32, kind: &str) -> Event {
    Event { t, kind: kind.into(), team: None, slot: None, hero_id: None, by: None, key: None, x: None, y: None, amount: None, ability: None, buff: None }
}

/// What the server accepts from a worker (spec §11, replay limits).
/// Format 7 runs about 41 KB a match minute (129738985: 44 minutes, 1.83 MB), so 6 MiB holds
/// about 150 minutes, past any real match. The server parses it inside its 256M budget, so the
/// cap stays well short of that.
pub const MAX_BYTES: u64 = 6 * 1024 * 1024;
pub const MAX_DURATION_S: u32 = 4 * 3600;
const MAX_PLAYERS: usize = 16;
const MAX_LIST: usize = 256;
/// In-game names, in characters (Steam allows 32).
pub const MAX_NAME: usize = 32;

/// Characters a name may not carry (security review 2026-11-08, L3): control characters, bidi
/// overrides and isolates (which reorder text around them), and HTML's metacharacters, so the
/// server's output is safe on its own, not only because the client escapes it.
pub fn bad_name_char(c: char) -> bool {
    c.is_control() || matches!(c, '\u{200E}' | '\u{200F}' | '\u{061C}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '<' | '>' | '&' | '"')
}

/// A name as the timeline keeps it: those characters dropped, trimmed, at most [`MAX_NAME`].
pub fn clean_name(raw: &str) -> Option<String> {
    let s: String = raw.chars().filter(|c| !bad_name_char(*c)).collect();
    let s: String = s.trim().chars().take(MAX_NAME).collect();
    (!s.is_empty()).then_some(s)
}
const MAX_EVENTS: usize = 4096;
/// 51 camps and the mid boss on the current map.
const MAX_CAMPS: usize = 64;
/// More healing pickups than this isn't the map we know (36 on the current one).
const MAX_HEALS: usize = 64;
/// More tough crates than this isn't the map we know (78 on the current one).
const MAX_CRATES: usize = 128;
/// How far past the end a camp's next spawn may fall (the longest respawn is ~7 minutes).
const MAX_RESPAWN_S: u32 = 3600;

/// A healing pickup's or tough crate's record: its kind's key, first up within the match, and
/// each `[down, back]` in order, after it, down within the match and back no later than the
/// longest respawn past the end.
fn up_down_ok(c: &Camp, prefix: &str, duration_s: u32, n: usize) -> bool {
    plausible_key(&c.key)
        && c.key.starts_with(prefix)
        && c.first_s <= duration_s
        && c.cleared.len() <= n
        && c.cleared.iter().all(|[a, b]| c.first_s <= *a && a < b && *a <= duration_s && *b <= duration_s.saturating_add(MAX_RESPAWN_S))
        && c.cleared.windows(2).all(|w| w[0][1] <= w[1][0])
}

fn plausible_key(k: &str) -> bool {
    // `kind:team:laneN` with an optional `:index`, as the pack writes it.
    let parts: Vec<&str> = k.split(':').collect();
    (3..=4).contains(&parts.len())
        && k.len() <= 64
        && parts[0].bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        && parts[1].bytes().all(|b| b.is_ascii_lowercase())
        && parts[2].strip_prefix("lane").is_some_and(|n| !n.is_empty() && n.len() <= 2 && n.bytes().all(|b| b.is_ascii_digit()))
        && parts.get(3).is_none_or(|n| !n.is_empty() && n.len() <= 3 && n.bytes().all(|b| b.is_ascii_digit()))
}

/// A player's `[died_s, back_s]` list: in order, each death in the match and its respawn after
/// it, no later than the longest respawn past the end.
pub fn respawns_ok(r: &[[u32; 2]], duration_s: u32) -> bool {
    r.len() <= duration_s as usize + 1
        && r.iter().all(|[a, b]| a < b && *a <= duration_s && *b <= duration_s.saturating_add(MAX_RESPAWN_S))
        && r.windows(2).all(|w| w[0][0] < w[1][0])
}

fn ranges_ok(r: &[[u32; 2]], n: u32) -> bool {
    r.len() <= 4096 && r.iter().all(|[a, b]| a < b && *b <= n)
}

/// Bound sparse scoreboard samples on the same integer-second clock as player paths.
fn scalar_ok(values: &[(u32, Option<u32>)], duration: u32, min: u32, max: u32) -> bool {
    values.len() <= duration as usize + 1
        && values.windows(2).all(|w| w[0].0 < w[1].0)
        && values.iter().all(|(s, v)| *s <= duration && v.is_none_or(|v| v >= min && v <= max))
}

/// Parse and check a worker's output. Anything outside the shape the worker can produce is
/// refused, so a compromised worker can't hand the server something the client can't draw.
pub fn validate(bytes: &[u8]) -> Result<Timeline, &'static str> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("too large");
    }
    let t: Timeline = serde_json::from_slice(bytes).map_err(|_| "not a timeline")?;
    let n = t.duration_s as usize + 1;
    let ok = t.tier == TIER
        && t.duration_s <= MAX_DURATION_S
        && t.players.len() <= MAX_PLAYERS
        && t.players.iter().all(|p| {
            (p.team == "amber" || p.team == "sapphire")
                && p.slot < 8
                && p.x.len() == n
                && p.y.len() == n
                && p.health.len() == n
                && p.ult.len() == n
                && scalar_ok(&p.level, t.duration_s, 1, 255)
                && scalar_ok(&p.max_health, t.duration_s, 1, 1_000_000)
                && scalar_ok(&p.kills, t.duration_s, 0, 10_000)
                && scalar_ok(&p.assists, t.duration_s, 0, 10_000)
                && p.health.iter().all(|h| *h <= 100)
                && p.ult.iter().all(|u| u.is_none_or(|u| u <= 100))
                && p.x.iter().chain(&p.y).all(|v| v.is_none_or(|v| v.abs() <= 32768))
                && p.deaths.len() <= n
                && p.souls.len() <= n
                && p.name.as_ref().is_none_or(|s| s.chars().count() <= MAX_NAME && !s.chars().any(bad_name_char))
                && respawns_ok(&p.respawn, t.duration_s)
                && seen_ok(&p.seen, t.duration_s)
                && extras_ok(p, t.duration_s, t.players.len())
        })
        && t.objectives.len() <= MAX_LIST
        && t.objectives.iter().all(|o| plausible_key(&o.key) && o.kind.len() <= 32 && o.team.len() <= 16 && o.destroyed_s <= t.duration_s)
        && t.mid_boss.len() <= MAX_LIST
        && t.rifts.len() <= MAX_LIST
        && t.rifts.iter().all(|r| {
            plausible_key(&r.key)
                && r.key.starts_with("rift:")
                && r.start_s < r.end_s
                && r.end_s <= n as u32
                && r.live_s.is_none_or(|l| r.start_s <= l && l < r.end_s)
                && r.give_up_s.is_none_or(|g| r.live_s.is_some_and(|l| l <= g && g <= l + MAX_GIVE_UP_S))
                && r.capture.len() <= ((r.end_s - r.start_s) * 10 / CAPTURE_EVERY_DS + 2) as usize
                && r.capture.windows(2).all(|w| w[0][0] < w[1][0])
                && r.capture.iter().all(|[ds, a, s]| r.start_s * 10 <= *ds && *ds <= r.end_s * 10 && *a <= 100 && *s <= 100)
        })
        && t.powerups.len() <= 8
        && t.powerups.iter().all(|p| plausible_key(&p.key) && p.key.starts_with("powerup:") && p.available.len() == n && p.available.iter().all(|a| *a <= 1) && ranges_ok(&p.stale, n as u32)
            && p.spawns.len() <= n
            && p.spawns.windows(2).all(|w| w[0].t < w[1].t)
            && p.spawns.iter().all(|s| s.t <= t.duration_s && BUFFS.contains(&s.buff.as_str()) && s.taken_s.is_none_or(|x| s.t <= x && x <= t.duration_s)))
        && t.zips.len() <= 8
        && t.zips.iter().all(|z| {
            plausible_key(&format!("lane:x:{}", z.lane)) && z.at.len() <= n && z.at.windows(2).all(|w| w[0][0] < w[1][0]) && z.at.iter().all(|[s, a, b]| *s <= t.duration_s && a <= b && *b <= 1000)
        })
        && t.camps.len() <= MAX_CAMPS
        && t.camps.iter().all(|c| {
            plausible_key(&c.key)
                && (c.key.starts_with("camp:") || c.key.starts_with("mid_boss:"))
                && c.first_s <= t.duration_s.saturating_add(MAX_RESPAWN_S)
                && c.cleared.len() <= n
                && c.cleared.iter().all(|[a, b]| c.first_s <= *a && a < b && *a <= t.duration_s && *b <= t.duration_s.saturating_add(MAX_RESPAWN_S))
                && c.cleared.windows(2).all(|w| w[0][1] <= w[1][0])
        })
        && t.heals.len() <= MAX_HEALS
        && t.heals.iter().all(|h| up_down_ok(h, "heal:", t.duration_s, n))
        && t.crates.len() <= MAX_CRATES
        && t.crates.iter().all(|c| up_down_ok(c, "tough_crate:", t.duration_s, n))
        && t.troopers.as_ref().is_none_or(|tr| {
            let samples = (n as u32).div_ceil(tr.every_s.max(1)) as usize;
            (1..=4).contains(&tr.every_s)
                && tr.amber.len() == samples
                && tr.sapphire.len() == samples
                && tr.amber.iter().chain(&tr.sapphire).all(|x| decode_troopers(x).is_some_and(|v| v.iter().all(|(_, x, y)| x.unsigned_abs() <= 16384 && y.unsigned_abs() <= 16384)))
        })
        && t.objective_health.len() <= 64
        && t.objective_health.iter().all(|o| {
            let rising = |v: &[[u32; 2]]| v.windows(2).all(|w| w[0][0] < w[1][0]);
            plausible_key(&o.key)
                && o.at.len() <= n
                && rising(&o.at)
                && o.at.iter().all(|[s, p]| *s <= t.duration_s && *p <= 100)
                && o.stage.len() <= n
                && rising(&o.stage)
                && o.stage.iter().all(|[s, g]| *s <= t.duration_s && (1..=2).contains(g))
        })
        && t.urn.as_ref().is_none_or(|u| {
            let urn_key = |k: &str| plausible_key(k) && k.starts_with("urn:");
            u.spawns.len() <= MAX_LIST
                && u.spawns.iter().all(|s| s.t <= t.duration_s && urn_key(&s.key))
                && u.spawns.windows(2).all(|w| w[0].t < w[1].t)
                && u.at.len() <= MAX_EVENTS
                && u.at.windows(2).all(|w| w[0].t < w[1].t)
                && u.at.iter().all(|a| {
                    a.t <= t.duration_s
                        && URN_STATES.contains(&a.state.as_str())
                        && a.team.as_deref().is_none_or(|s| s == "amber" || s == "sapphire")
                        && a.slot.is_none_or(|s| s < 8)
                        && a.x.into_iter().chain(a.y).all(|v| v.abs() <= 32768)
                        && a.delivery.as_deref().is_none_or(urn_key)
                })
        })
        && t.rejuv.len() <= MAX_LIST
        && t.rejuv.iter().all(|r| {
            (r.team == "amber" || r.team == "sapphire")
                && r.taken_s <= t.duration_s
                && r.taken_s < r.ends_s
                && r.ends_s <= r.taken_s + REJUV_S + 1
                && r.left.len() <= (REJUV_S as usize + 1)
                && r.left.windows(2).all(|w| w[0][0] < w[1][0])
                && r.left.iter().all(|[s, n]| r.taken_s <= *s && *s < r.ends_s && *s <= t.duration_s && *n <= MAX_REJUV)
        })
        && t.rejuv.windows(2).all(|w| w[0].taken_s <= w[1].taken_s)
        && t.events.len() <= MAX_EVENTS
        && t.events.iter().all(|e| {
            let team_ok = |s: &str| s == "amber" || s == "sapphire" || s == "neutral";
            e.t <= t.duration_s
                && EVENT_KINDS.contains(&e.kind.as_str())
                && e.team.as_deref().is_none_or(team_ok)
                && e.slot.is_none_or(|s| s < 8)
                && e.by.as_ref().is_none_or(|b| team_ok(&b.team) && b.slot < 8)
                && e.key.as_deref().is_none_or(plausible_key)
                && e.x.into_iter().chain(e.y).all(|v| v.abs() <= 32768)
                && e.ability.as_deref().is_none_or(plausible_ability)
                && e.buff.as_deref().is_none_or(|b| BUFFS.contains(&b))
        });
    if ok { Ok(t) } else { Err("out of shape") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoreboard_samples_are_bounded_and_old_timelines_still_validate() {
        let bytes = |t: &Timeline| serde_json::to_vec(t).expect("serialize");
        let mut t = tiny();
        assert!(validate(&bytes(&t)).is_ok());
        for invalid in [vec![(0, Some(0))], vec![(3, Some(1))], vec![(1, Some(1)), (1, Some(2))], vec![(0, Some(256))]] {
            t.players[0].level = invalid;
            assert!(validate(&bytes(&t)).is_err());
        }
        t.players[0].level.clear();
        t.players[0].max_health = vec![(0, Some(1_000_001))];
        assert!(validate(&bytes(&t)).is_err());
        t.players[0].max_health.clear();
        t.players[0].kills = vec![(0, Some(10_001))];
        assert!(validate(&bytes(&t)).is_err());
        t.players[0].kills.clear();
        t.players[0].assists.clear();
        t.format = 7;
        let json = bytes(&t);
        assert!(!String::from_utf8_lossy(&json).contains("max_health"));
        assert!(validate(&json).is_ok());
    }

    pub fn tiny() -> Timeline {
        Timeline {
            match_id: 7,
            start_time: 0,
            duration_s: 2,
            source: "replay".into(),
            tier: TIER.into(),
            build: 6813,
            players: vec![Player {
                team: "amber".into(),
                slot: 0,
                hero_id: 1,
                name: Some("Coach".into()),
                x: vec![Some(1), None, Some(3)],
                y: vec![Some(1), None, Some(3)],
                health: vec![100, 0, 100],
                deaths: vec![1],
                kills: vec![(0, Some(0)), (2, Some(1))],
                assists: vec![(0, Some(0))],
                level: vec![(0, Some(1)), (2, Some(2))],
                max_health: vec![(0, Some(1000)), (1, None), (2, Some(1200))],
                pickups: vec![(1, [20.0, 0.0, 0.0, 0.0, 0.0])],
                souls: vec![[0, 500]],
                ult: vec![None, Some(50), Some(0)],
                respawn: vec![[1, 2]],
                seen: vec![[0, 4], [9, 20]],
                items: vec![[0, 11, ITEM_BOUGHT], [5, 12, ITEM_BOUGHT], [5, 11, ITEM_MERGED], [20, 12, ITEM_SOLD]],
                abilities: vec![[0, 21, 1], [2, 21, 2]],
                casts: vec![[3, 21, 300], [4, 22, 0]],
                charges: vec![[3, 21, 1], [9, 21, 2]],
                cc: vec![[1, 4, 20, NO_HERO, 0], [2, 6, 17, 0, 21]],
                effects: vec![[1, 9, 31, 0, 21, 2], [2, 2, 32, NO_HERO, 0, 0]],
                recaps: vec![Recap { t: 10, damage: vec![[NO_HERO, 0, 120], [0, 21, 40]], cc: vec![[1, 4, 20, NO_HERO, 0]] }],
                height: vec![[1, 2], [2, 0]],
                zipline: vec![[0, 1], [2, 3]],
            }],
            objectives: vec![Objective { key: "walker:amber:lane1:1".into(), kind: "walker".into(), team: "amber".into(), lane: 1, destroyed_s: 2 }],
            mid_boss: vec![],
            reanchored: 0,
            rifts: vec![Rift { key: "rift:neutral:lane6:1".into(), start_s: 1, end_s: 3, live_s: Some(2), give_up_s: Some(62), capture: vec![[20, 0, 0], [25, 4, 0], [30, 9, 1]] }],
            powerups: vec![Powerup { key: "powerup:neutral:lane1:1".into(), available: vec![0, 1, 0], stale: vec![[0, 1]], spawns: vec![PowerupSpawn { t: 1, buff: "gun".into(), taken_s: Some(2) }] }],
            zips: vec![ZipTrack { lane: "lane4".into(), at: vec![[0, 425, 574], [2, 500, 520]] }],
            camps: vec![Camp { key: "camp:neutral:lane0:3".into(), first_s: 1, cleared: vec![[1, 2], [2, 400]] }],
            heals: vec![Camp { key: "heal:neutral:lane1:7".into(), first_s: 1, cleared: vec![[1, 181]] }],
            crates: vec![Camp { key: "tough_crate:neutral:lane4:3".into(), first_s: 0, cleared: vec![[1, 181]] }],
            events: vec![Event { team: Some("amber".into()), slot: Some(0), hero_id: Some(1), x: Some(3), y: Some(3), ..event(1, "death") }],
            objective_health: vec![ObjectiveHealth { key: "walker:amber:lane1:1".into(), at: vec![[0, 100], [2, 40]], stage: vec![] }],
            troopers: Some(Troopers { every_s: 1, amber: vec![encode_troopers(&[(7, 100, -200)]), String::new(), String::new()], sapphire: vec![String::new(); 3] }),
            urn: Some(Urn {
                spawns: vec![UrnSpawn { t: 0, key: "urn:neutral:lane1:1".into() }],
                at: vec![
                    UrnAt { t: 0, state: "ground".into(), x: Some(-6584), y: Some(0), team: None, slot: None, delivery: Some("urn:neutral:lane6:1".into()) },
                    UrnAt { t: 1, state: "carried".into(), x: None, y: None, team: Some("amber".into()), slot: Some(0), delivery: Some("urn:neutral:lane6:1".into()) },
                    UrnAt { t: 2, state: "none".into(), x: None, y: None, team: None, slot: None, delivery: None },
                ],
            }),
            rejuv: vec![Rejuv { team: "sapphire".into(), taken_s: 1, ends_s: 181, left: vec![[1, 3], [2, 2]] }],
            format: FORMAT,
        }
    }

    #[test]
    fn a_worker_timeline_round_trips() {
        let t = tiny();
        let bytes = serde_json::to_vec(&t).expect("json");
        assert_eq!(validate(&bytes), Ok(t));
    }

    #[test]
    fn out_of_shape_output_is_refused() {
        type Breaks = Vec<Box<dyn Fn(&mut Timeline)>>;
        let bad: Breaks = vec![
            Box::new(|t| t.tier = "metadata".into()),
            Box::new(|t| t.players[0].x.push(Some(1))),
            Box::new(|t| t.players[0].health[0] = 101),
            Box::new(|t| t.players[0].ult[0] = Some(200)),
            Box::new(|t| t.players[0].name = Some("a\u{7}b".into())),
            Box::new(|t| t.players[0].name = Some("<img src=x>".into())),
            Box::new(|t| t.players[0].name = Some("ab\u{202E}cd".into())),
            Box::new(|t| t.players[0].name = Some("x".repeat(33))),
            Box::new(|t| t.players[0].team = "<b>".into()),
            Box::new(|t| t.objectives[0].key = "walker:amber:lane1:1<script>".into()),
            Box::new(|t| t.objectives[0].destroyed_s = 99),
            Box::new(|t| t.rifts[0].key = "walker:amber:lane1:1".into()),
            Box::new(|t| t.rifts[0].end_s = 9),
            Box::new(|t| t.powerups[0].available[1] = 2),
            Box::new(|t| t.rifts[0].live_s = Some(3)),
            Box::new(|t| t.powerups[0].spawns[0].buff = "<b>".into()),
            Box::new(|t| t.powerups[0].spawns[0].taken_s = Some(0)),
            Box::new(|t| t.events[0].buff = Some("speed".into())),
            Box::new(|t| t.zips[0].at[1] = [2, 500, 1001]),
            Box::new(|t| t.zips[0].at[1] = [2, 600, 520]),
            Box::new(|t| t.zips[0].at[1] = [0, 500, 520]),
            Box::new(|t| t.zips[0].at[1] = [9, 500, 520]),
            Box::new(|t| t.zips[0].lane = "../x".into()),
            Box::new(|t| t.camps[0].key = "walker:amber:lane1:1".into()),
            Box::new(|t| t.camps[0].key = "camp:<b>:lane0:3".into()),
            Box::new(|t| t.camps[0].cleared[0] = [2, 2]),
            Box::new(|t| t.camps[0].cleared[0] = [0, 2]),
            Box::new(|t| t.camps[0].cleared[1] = [9, 400]),
            Box::new(|t| t.camps[0].cleared[1] = [2, 2 + 3600 + 1]),
            Box::new(|t| t.camps[0].cleared = vec![[1, 3], [2, 4]]),
            Box::new(|t| t.camps = vec![t.camps[0].clone(); MAX_CAMPS + 1]),
            Box::new(|t| t.heals[0].key = "camp:neutral:lane0:3".into()),
            Box::new(|t| t.heals[0].key = "heal:<b>:lane1:7".into()),
            Box::new(|t| t.heals[0].first_s = 9),
            Box::new(|t| t.heals[0].cleared[0] = [0, 181]),
            Box::new(|t| t.heals[0].cleared[0] = [181, 181]),
            Box::new(|t| t.heals[0].cleared[0] = [9, 181]),
            Box::new(|t| t.heals[0].cleared[0] = [1, 2 + 3600 + 1]),
            Box::new(|t| t.heals[0].cleared = vec![[1, 3], [2, 4]]),
            Box::new(|t| t.heals = vec![t.heals[0].clone(); MAX_HEALS + 1]),
            Box::new(|t| t.crates[0].key = "heal:neutral:lane1:7".into()),
            Box::new(|t| t.crates[0].key = "tough_crate:<b>:lane4:3".into()),
            Box::new(|t| t.crates[0].first_s = 9),
            Box::new(|t| t.crates[0].cleared[0] = [181, 181]),
            Box::new(|t| t.crates[0].cleared[0] = [9, 181]),
            Box::new(|t| t.crates[0].cleared[0] = [1, 2 + 3600 + 1]),
            Box::new(|t| t.crates[0].cleared = vec![[1, 3], [2, 4]]),
            Box::new(|t| t.crates = vec![t.crates[0].clone(); MAX_CRATES + 1]),
            Box::new(|t| t.duration_s = MAX_DURATION_S + 1),
            Box::new(|t| t.events[0].kind = "<b>".into()),
            Box::new(|t| t.events[0].t = 9),
            Box::new(|t| t.events[0].team = Some("x".into())),
            Box::new(|t| t.events[0].key = Some("../x".into())),
            Box::new(|t| t.events[0].ability = Some("<b>".into())),
            Box::new(|t| t.objective_health[0].at[1] = [2, 101]),
            Box::new(|t| t.objective_health[0].at[1] = [9, 40]),
            Box::new(|t| t.objective_health[0].key = "x".into()),
            Box::new(|t| t.objective_health[0].at[0] = [2, 50]),
            Box::new(|t| t.objective_health[0].stage = vec![[0, 3]]),
            Box::new(|t| t.troopers.as_mut().map_or((), |x| x.amber.pop().map_or((), |_| ()))),
            Box::new(|t| t.troopers.as_mut().map_or((), |x| x.amber[1] = "not base64!".into())),
            Box::new(|t| t.troopers.as_mut().map_or((), |x| x.amber[1] = encode_troopers(&[(1, 20000, 0)]))),
            Box::new(|t| t.troopers.as_mut().map_or((), |x| x.sapphire[0] = encode_troopers(&vec![(1, 0, 0); MAX_TROOPERS + 1]))),
            Box::new(|t| t.players[0].respawn = vec![[1, 1]]),
            Box::new(|t| t.players[0].respawn = vec![[9, 10]]),
            Box::new(|t| t.players[0].respawn = vec![[1, 2 + 3600 + 1]]),
            Box::new(|t| t.players[0].respawn = vec![[1, 2], [0, 2]]),
            Box::new(|t| t.players[0].seen = vec![[4, 4]]),
            Box::new(|t| t.players[0].seen = vec![[5, 4]]),
            Box::new(|t| t.players[0].seen = vec![[0, 21]]),
            Box::new(|t| t.players[0].seen = vec![[0, 4], [8, 20]]),
            Box::new(|t| t.players[0].seen = vec![[9, 20], [0, 4]]),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.spawns[0].key = "rift:neutral:lane1:1".into())),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.spawns[0].t = 9)),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.at[1].state = "<b>".into())),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.at[1].team = Some("neutral".into()))),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.at[1].slot = Some(8))),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.at[1].t = 0)),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.at[0].x = Some(40000))),
            Box::new(|t| t.urn.as_mut().map_or((), |u| u.at[0].delivery = Some("camp:neutral:lane0:3".into()))),
            Box::new(|t| t.rifts[0].give_up_s = Some(1)),
            Box::new(|t| t.rifts[0].give_up_s = Some(2 + MAX_GIVE_UP_S + 1)),
            Box::new(|t| {
                t.rifts[0].live_s = None;
                t.rifts[0].give_up_s = Some(62);
            }),
            Box::new(|t| t.rifts[0].capture[1] = [25, 101, 0]),
            Box::new(|t| t.rifts[0].capture[1] = [20, 4, 0]),
            Box::new(|t| t.rifts[0].capture[0] = [9, 0, 0]),
            Box::new(|t| t.rifts[0].capture[2] = [31, 9, 1]),
            Box::new(|t| t.rifts[0].capture = (20..30).map(|d| [d, 0, 0]).collect()),
            Box::new(|t| t.rejuv[0].team = "neutral".into()),
            Box::new(|t| t.rejuv[0].taken_s = 9),
            Box::new(|t| t.rejuv[0].ends_s = 1),
            Box::new(|t| t.rejuv[0].ends_s = 1 + REJUV_S + 2),
            Box::new(|t| t.rejuv[0].left[1] = [2, 4]),
            Box::new(|t| t.rejuv[0].left[1] = [1, 2]),
            Box::new(|t| t.rejuv[0].left[0] = [0, 3]),
            Box::new(|t| t.events[0].kind = "rejuv".into()),
            // Format 7.
            Box::new(|t| t.players[0].items[1][0] = 21),
            Box::new(|t| t.players[0].items[1][1] = 0),
            Box::new(|t| t.players[0].items[1][2] = 4),
            Box::new(|t| t.players[0].items.swap(0, 3)),
            Box::new(|t| t.players[0].items = vec![[0, 1, 0]; MAX_ITEMS + 1]),
            Box::new(|t| t.players[0].abilities[1][0] = 3),
            Box::new(|t| t.players[0].abilities[1][1] = 0),
            Box::new(|t| t.players[0].abilities[1][2] = 5),
            Box::new(|t| t.players[0].abilities.swap(0, 1)),
            Box::new(|t| t.players[0].abilities = vec![[0, 1, 1]; MAX_ABILITY_CHANGES + 1]),
            Box::new(|t| t.players[0].casts[0][0] = 21),
            Box::new(|t| t.players[0].casts[0][1] = 0),
            Box::new(|t| t.players[0].casts[0][2] = 3),
            Box::new(|t| t.players[0].casts[0][2] = 3 + MAX_COOLDOWN_DS + 1),
            Box::new(|t| t.players[0].casts.swap(0, 1)),
            Box::new(|t| t.players[0].casts = vec![[0, 1, 0]; MAX_CASTS + 1]),
            Box::new(|t| t.players[0].charges[0][0] = 21),
            Box::new(|t| t.players[0].charges[0][1] = 0),
            Box::new(|t| t.players[0].charges[0][2] = MAX_CHARGE_COUNT + 1),
            Box::new(|t| t.players[0].charges.swap(0, 1)),
            Box::new(|t| t.players[0].charges = vec![[0, 1, 0]; MAX_CHARGES + 1]),
            Box::new(|t| t.players[0].cc[1] = [2, 2, 17, 0, 21]),
            Box::new(|t| t.players[0].cc[0][1] = 21),
            Box::new(|t| t.players[0].cc[0][2] = 21),
            Box::new(|t| t.players[0].cc[0][3] = 1),
            Box::new(|t| t.players[0].cc.swap(0, 1)),
            Box::new(|t| t.players[0].cc = vec![[0, 1, 20, NO_HERO, 0]; MAX_CC + 1]),
            Box::new(|t| t.players[0].effects[0] = [9, 8, 31, 0, 21, 2]),
            Box::new(|t| t.players[0].effects[0][1] = 21),
            Box::new(|t| t.players[0].effects[0][2] = 0),
            Box::new(|t| t.players[0].effects[0][3] = 1),
            Box::new(|t| t.players[0].effects[0][5] = MAX_STACKS + 1),
            Box::new(|t| t.players[0].effects.swap(0, 1)),
            Box::new(|t| t.players[0].effects = vec![[0, 0, 1, NO_HERO, 0, 0]; MAX_EFFECTS + 1]),
            Box::new(|t| t.players[0].recaps[0].t = 21),
            Box::new(|t| t.players[0].recaps[0].damage[0][0] = 1),
            Box::new(|t| t.players[0].recaps[0].damage[0][0] = NPC_SRC + NPC_KINDS.len() as u32),
            Box::new(|t| t.players[0].cc[0][3] = NPC_SRC),
            Box::new(|t| t.players[0].recaps[0].damage[0][2] = 0),
            Box::new(|t| t.players[0].recaps[0].damage[0][2] = MAX_RECAP_DAMAGE + 1),
            Box::new(|t| t.players[0].recaps[0].damage = vec![[NO_HERO, 0, 1]; MAX_RECAP_ROWS + 1]),
            Box::new(|t| t.players[0].recaps[0].cc[0][2] = 21),
            Box::new(|t| t.players[0].recaps[0].cc[0] = [11, 12, 20, NO_HERO, 0]),
            Box::new(|t| t.players[0].recaps[0].cc = vec![[1, 4, 20, NO_HERO, 0]; MAX_RECAP_ROWS + 1]),
            Box::new(|t| t.players[0].recaps = vec![t.players[0].recaps[0].clone(); 2]),
            Box::new(|t| t.players[0].recaps = vec![Recap { t: 1, damage: vec![], cc: vec![] }; MAX_RECAPS + 1]),
            Box::new(|t| t.players[0].height[1][0] = 1),
            Box::new(|t| t.players[0].height[1][1] = 2),
            Box::new(|t| t.players[0].height[1] = [2, 3]),
            Box::new(|t| t.players[0].height[1][0] = 3),
            Box::new(|t| t.players[0].zipline[1] = [3, 3]),
            Box::new(|t| t.players[0].zipline[1] = [2, 4]),
            Box::new(|t| t.players[0].zipline[1] = [1, 3]),
        ];
        for (i, f) in bad.iter().enumerate() {
            let mut t = tiny();
            f(&mut t);
            assert!(validate(&serde_json::to_vec(&t).expect("json")).is_err(), "case {i}");
        }
        assert!(validate(b"{").is_err());
    }

    #[test]
    fn a_timeline_from_before_the_urn_and_respawns_still_loads() {
        let mut v = serde_json::to_value(tiny()).expect("json");
        let o = v.as_object_mut().expect("object");
        o.remove("urn");
        o.remove("format");
        o["players"][0].as_object_mut().expect("player").remove("respawn");
        o["players"][0].as_object_mut().expect("player").remove("seen");
        o.remove("rejuv");
        o.remove("heals");
        o.remove("crates");
        for f in ["items", "abilities", "casts", "charges", "cc", "effects", "recaps", "height", "zipline"] {
            o["players"][0].as_object_mut().expect("player").remove(f);
        }
        let rift = o["rifts"][0].as_object_mut().expect("rift");
        rift.remove("live_s");
        rift.remove("give_up_s");
        rift.remove("capture");
        o["powerups"][0].as_object_mut().expect("powerup").remove("spawns");
        let t = validate(&serde_json::to_vec(&v).expect("json")).expect("an old timeline loads");
        assert_eq!((t.urn, t.format, t.players[0].respawn.len(), t.players[0].seen.len()), (None, 0, 0, 0));
        assert_eq!((t.rifts[0].live_s, t.powerups[0].spawns.len()), (None, 0));
        assert_eq!((t.rifts[0].give_up_s, t.rifts[0].capture.len(), t.rejuv.len(), t.heals.len(), t.crates.len()), (None, 0, 0, 0, 0));
        let p = &t.players[0];
        assert!(p.items.is_empty() && p.abilities.is_empty() && p.casts.is_empty() && p.charges.is_empty() && p.cc.is_empty());
        assert!(p.effects.is_empty() && p.recaps.is_empty() && p.height.is_empty() && p.zipline.is_empty());
    }

    #[test]
    fn souls_swings_mark_big_moves_of_the_lead_once_per_window() {
        let p = |team: &str, s: &[[u32; 2]]| (team.to_owned(), s.to_vec());
        // Amber gains 6,000 between 100 and 140 s; Sapphire claws 8,000 back by 400 s.
        let players = [p("amber", &[[0, 0], [100, 1000], [140, 7000], [150, 7500]]), p("sapphire", &[[0, 0], [100, 1000], [380, 3000], [400, 15000]])];
        let got: Vec<(u32, Option<String>, Option<u32>)> = souls_swings(&players, 500).into_iter().map(|e| (e.t, e.team, e.amount)).collect();
        assert_eq!(got, [(140, Some("amber".into()), Some(6000)), (400, Some("sapphire".into()), Some(14000))]);
        // One team's update a few seconds before the other's is no swing.
        let staggered = [p("amber", &[[0, 0], [180, 9000]]), p("sapphire", &[[0, 0], [184, 9000]])];
        assert_eq!(souls_swings(&staggered, 500), []);
    }

    #[test]
    fn names_lose_control_bidi_and_html_characters() {
        assert_eq!(clean_name(" Co\u{202E}a<b>ch&\"\u{7} "), Some("Coabch".into()));
        assert_eq!(clean_name("\u{2066}\u{2069}"), None);
        assert_eq!(clean_name(&"é".repeat(40)).map(|s| s.chars().count()), Some(32));
    }

    #[test]
    fn a_recap_may_name_a_non_hero_attacker_by_kind() {
        let p = |src: u32| Player { recaps: vec![Recap { t: 200, damage: vec![[src, 0, 1]], cc: vec![] }], ..Player::default() };
        assert!(extras_ok(&p(NPC_SRC), 30, 1));
        assert!(extras_ok(&p(NPC_SRC + NPC_KINDS.len() as u32 - 1), 30, 1));
        assert!(!extras_ok(&p(NPC_SRC + NPC_KINDS.len() as u32), 30, 1));
        assert!(!extras_ok(&p(254), 30, 1));
    }

    #[test]
    fn npc_kinds_follow_the_attacker_class_and_unit() {
        // Subclasses as 129738985 records them.
        assert_eq!(npc_kind(Some(4), Some(1_773_848_083)), Some(0));
        assert_eq!(npc_kind(Some(4), Some(1_003_135_509)), Some(1));
        assert_eq!(npc_kind(Some(4), Some(2_943_225_653)), Some(2));
        assert_eq!(npc_kind(Some(6), Some(855_199_377)), Some(9));
        assert_eq!(npc_kind(Some(6), Some(2_433_738_403)), Some(8));
        assert_eq!(npc_kind(Some(8), Some(1_166_266_048)), Some(7));
        assert_eq!(npc_kind(Some(29), None), Some(4));
        assert_eq!(npc_kind(Some(31), None), Some(6));
        assert_eq!(npc_kind(Some(1), None), None);
        assert_eq!(npc_kind(None, None), None);
        assert_eq!(NPC_KINDS[npc_kind(Some(22), None).unwrap_or(0) as usize], "sentry");
    }

    #[test]
    fn a_recap_keeps_only_the_cc_of_its_window() {
        let p = |cc: [u32; 5]| Player { recaps: vec![Recap { t: 200, damage: vec![[NO_HERO, 0, 1]], cc: vec![cc] }], ..Player::default() };
        assert!(extras_ok(&p([95, 110, 20, NO_HERO, 0]), 30, 1));
        assert!(!extras_ok(&p([10, 99, 20, NO_HERO, 0]), 30, 1), "over before the window opened");
        assert!(!extras_ok(&p([201, 210, 20, NO_HERO, 0]), 30, 1), "after the death");
    }

    #[test]
    fn tokens_are_the_games_ids() {
        // boon's known pair, and boon-data's catalog id for the generic stun.
        assert_eq!(token("modifier_player_pinged"), 1_215_616_703);
        assert_eq!(token("modifier_citadel_stunned"), 1_398_909_042);
        assert_eq!(token("Modifier_Citadel_Stunned"), 1_398_909_042, "lower-cased first");
        // Every remainder length (0–3 bytes past the last 4-byte chunk) takes part.
        let ids: std::collections::BTreeSet<u32> = ["abcd", "abcde", "abcdef", "abcdefg"].map(token).into();
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn keys_have_the_pack_shape() {
        for k in ["walker:amber:lane1:1", "base_guardian:sapphire:lane4", "rift:neutral:lane6:1"] {
            assert!(plausible_key(k), "{k}");
        }
        for k in ["walker", "Walker:amber:lane1:1", "walker:amber:lane:1", "walker:amber:lane1:1:2", "a:b:lane1:x"] {
            assert!(!plausible_key(k), "{k}");
        }
    }
}
