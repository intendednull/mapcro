//! Calculated hero stats (docs/research/stat-calc-spike.md): max health, spirit power, weapon
//! damage, bullet resist and spirit resist from a hero, its level, the items it owns, its ability
//! tiers and its statue pickups, with the game data of the replay's patch. The replay doesn't
//! record these totals (docs/research/stat-datamining.md), so anything shown from here is
//! *calculated*.
//!
//! - [`StatTable`]: one patch's game data, reduced to the numbers the rules read (no Valve
//!   files). It's built from a boon-data snapshot ([`StatTable::from_boon_data`]) or from the
//!   game's own vdata ([`StatTable::from_vdata`]); the asset pack carries one per patch.
//! - [`StatTable::calculate`]: the rules, each one a [`Rule`] in [`RULES`], versioned and cited.
//!
//! Inputs are game ids (the timeline's item and ability tokens), so the same code runs on a
//! replay timeline or on match metadata. Nothing here reads a player's identity.
//!
//! Left out on purpose: effects the game applies only in some states (an active item, a stacking
//! buff, an enemy's debuff), except life-threshold items when the caller passes the hero's health
//! ([`Build::health_pct`]). Those are the misses the spike measured.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

mod reduce;

/// The stat table's own format, stamped in every table. Bump it when the table's shape or the
/// meaning of a field changes; readers refuse a format they don't know.
pub const TABLE_FORMAT: u32 = 1;

/// One calculation step: what it does and where the rule comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    pub id: &'static str,
    pub version: u32,
    pub rule: &'static str,
    pub source: &'static str,
    /// The patches whose data the rule was checked against, and how.
    pub checked: &'static str,
}

pub const PASSIVE: Rule = Rule {
    id: "passive",
    version: 2,
    rule: "an item or ability property counts when it is bound to the ability's own \
           m_AutoIntrinsicModifiers/N (or, for a shop item, bound nowhere but flagged \
           IntrinsicallyProvidedInAbility), it has no apply filter and its usage isn't Conditionally*. \
           v2: a hero ability's unbound property no longer counts (Kelvin's Ice Path T3 spirit)",
    source: "boon-data stat_changes (modifier_keys, usage_flags, apply_filter); boon hero_stats; \
             in vdata, a modifier's m_vecAutoRegisterModifierValueFromAbilityPropertyName",
    checked: "6839/6860: sandbox 12-item build exact; Battle Vest/Hollow Point/Rapid Recharge excluded; \
              6860: the install's vdata and boon-data give identical tables; 6839 rates unchanged by v2",
};
pub const BOONS: Rule = Rule {
    id: "boons",
    version: 1,
    rule: "boons = levels in m_mapLevelInfo at or below the hero's level with m_bUseStandardUpgrade; \
           each adds m_mapStandardLevelUpUpgrades (health, spirit power, resists)",
    source: "boon hero_stats level_bonus; deadlock-api standard_level_up_upgrades",
    checked: "6839: metadata snapshot level, 12 heroes",
};
pub const INVESTMENT: Rule = Rule {
    id: "investment",
    version: 1,
    rule: "souls per slot = sum of m_nItemPricePerTier[tier] over owned items of that slot; the bonus \
           is the last m_MapModCostBonuses row whose nGoldThreshold is reached (Armor: base health %, \
           Tech: flat spirit power, WeaponMod: weapon damage %)",
    source: "boon hero_stats purchase_bonus; deadbot item_investment; sandbox investment tooltips",
    checked: "6860 sandbox: +50% at 12.8K vitality, +100 at 35.2K spirit, +62% at 8K weapon",
};
pub const MAX_HEALTH: Rule = Rule {
    id: "max_health",
    version: 1,
    rule: "(base + boons * per_boon) * (1 + vitality% + base_health%) + flat item/upgrade/pickup \
           health, then * prod(1 + max_health%); the game truncates to an integer",
    source: "damage-lab fit (idea only); deadlock-plus basePercent vs percent split (idea only)",
    checked: "6839: 96.4% exact at respawn (recorded m_iMaxHealth); vitality% on item health: 21% \
              vs 67% at metadata snapshots, rejected. 6860 sandbox 1470 exact",
};
pub const SPIRIT_POWER: Rule = Rule {
    id: "spirit_power",
    version: 1,
    rule: "(boons * per_boon + spirit investment + flat items/upgrades/pickups) * prod(1 + spirit%); \
           metadata truncates, the HUD rounds (175.95 shows 176)",
    source: "deadlock wiki Spirit_Power; boon rulesets/spirit_power.rs (multiplicative)",
    checked: "6839: 81.1% exact at metadata snapshots; multiply-vs-add untested (one % item in the shop)",
};
pub const WEAPON_DAMAGE: Rule = Rule {
    id: "weapon_damage",
    version: 1,
    rule: "weapon investment % + sum of item/upgrade/pickup weapon damage %",
    source: "boon rulesets/weapon_damage.rs",
    checked: "6839: 62.9% exact (72.7% with life thresholds) at metadata snapshots; 6860 sandbox 91 exact",
};
pub const RESIST: Rule = Rule {
    id: "resist",
    version: 1,
    rule: "innate = base + boons * per_boon + spirit scaling + statue pickups (added); then \
           1 - prod(1 - r) over innate and each item source; own negative sources stack the same \
           way apart and are subtracted",
    source: "deadlock wiki Damage_Resistance; boon rulesets/resistance.rs",
    checked: "6860 sandbox: 10% + 17% + 10% shows 33% (additive would be 37%); bullet 0%",
};
pub const LIFE_THRESHOLD: Rule = Rule {
    id: "life_threshold",
    version: 1,
    rule: "when the caller passes health %, an item's conditional properties apply if it has a \
           LifeThreshold property and health % >= it (Battle Vest, Hollow Point: 65)",
    source: "boon-data ability properties; observed in 129738985 metadata vs replay health",
    checked: "6839: weapon exact 62.9% -> 72.7%",
};
pub const RULES: [Rule; 8] = [PASSIVE, BOONS, INVESTMENT, MAX_HEALTH, SPIRIT_POWER, WEAPON_DAMAGE, RESIST, LIFE_THRESHOLD];

/// The stats a property can feed.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Stat {
    MaxHealth,
    BaseHealthPct,
    MaxHealthPct,
    SpiritPower,
    SpiritPowerPct,
    WeaponDamage,
    BulletResist,
    SpiritResist,
}

impl Stat {
    /// The game's `MODIFIER_VALUE_*` name (a property's `m_eProvidedPropertyType`).
    pub fn from_modifier_value(name: &str) -> Option<Self> {
        Some(match name {
            "MODIFIER_VALUE_HEALTH_MAX" => Self::MaxHealth,
            "MODIFIER_VALUE_BASE_HEALTH_PERCENT" => Self::BaseHealthPct,
            "MODIFIER_VALUE_HEALTH_MAX_PERCENT" => Self::MaxHealthPct,
            "MODIFIER_VALUE_TECH_POWER" => Self::SpiritPower,
            "MODIFIER_VALUE_TECH_POWER_PERCENT" => Self::SpiritPowerPct,
            "MODIFIER_VALUE_WEAPON_DAMAGE_INCREASE" => Self::WeaponDamage,
            "MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST" => Self::BulletResist,
            "MODIFIER_VALUE_TECH_RESIST" => Self::SpiritResist,
            _ => return None,
        })
    }
}

/// Shop slots, in [`Calculated::invested`] and [`Hero::cost_bonuses`] order.
pub const SLOTS: [&str; 3] = ["EItemSlotType_Armor", "EItemSlotType_Tech", "EItemSlotType_WeaponMod"];

/// What one boon adds (`m_mapStandardLevelUpUpgrades`).
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Growth {
    #[serde(default)]
    pub max_health: f64,
    #[serde(default)]
    pub spirit_power: f64,
    #[serde(default)]
    pub weapon_damage: f64,
    #[serde(default)]
    pub bullet_resist: f64,
    #[serde(default)]
    pub spirit_resist: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Hero {
    /// `m_mapStartingStats.EMaxHealth`.
    pub max_health: f64,
    pub per_boon: Growth,
    /// Levels that grant a boon, ascending.
    pub boon_levels: Vec<u32>,
    /// Per slot ([`SLOTS`]): `(souls threshold, bonus)` rows, ascending.
    pub cost_bonuses: [Vec<(f64, f64)>; 3],
    /// Innate resist, percent.
    pub bullet_resist: f64,
    pub spirit_resist: f64,
    /// Resist per point of spirit power (`m_mapScalingStats`).
    pub bullet_resist_per_spirit: f64,
    pub spirit_resist_per_spirit: f64,
}

/// An item or a hero ability, reduced to what the rules read.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Item {
    /// Index into [`SLOTS`], for shop items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<u8>,
    /// Souls (`m_nItemPricePerTier[tier]`), for shop items.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub price: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub passive: Vec<(Stat, f64)>,
    /// Properties that need a state; only [`LIFE_THRESHOLD`] turns them on.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conditional: Vec<(Stat, f64)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub life_threshold: Option<f64>,
    /// Per upgrade tier, the passive bonuses it adds (hero abilities).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub upgrades: Vec<Vec<(Stat, f64)>>,
}

fn is_zero(v: &f64) -> bool {
    *v == 0.0
}

/// One patch's game data, reduced to what the rules read: derived numbers only, keyed by the
/// timeline's ids (hero id; item and ability token).
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct StatTable {
    /// [`TABLE_FORMAT`].
    pub format: u32,
    /// The game build the data is from.
    pub client_version: u32,
    /// Where it came from: `boon-data` or `vdata` (the operator's install).
    pub source: String,
    pub heroes: BTreeMap<u32, Hero>,
    pub items: BTreeMap<u32, Item>,
}

/// Statue pickups (permanent; the timeline's `pickups`, the metadata's `power_up_buffs`).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Pickups {
    #[serde(default)]
    pub max_health: f64,
    #[serde(default)]
    pub spirit_power: f64,
    #[serde(default)]
    pub weapon_damage: f64,
    #[serde(default)]
    pub bullet_resist: f64,
    #[serde(default)]
    pub spirit_resist: f64,
}

/// What the hero has at one moment.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
pub struct Build {
    pub hero_id: u32,
    /// The scoreboard level (1-based, `m_iLevel`).
    pub level: u32,
    /// Owned items by id (the timeline's tokens); unknown ids are ignored.
    #[serde(default)]
    pub items: Vec<u32>,
    /// `(ability id, upgrade tiers bought)` for the hero's abilities.
    #[serde(default)]
    pub ability_tiers: Vec<(u32, u8)>,
    #[serde(default)]
    pub pickups: Pickups,
    /// Health percent, for [`LIFE_THRESHOLD`]; `None` leaves those items out.
    #[serde(default)]
    pub health_pct: Option<f64>,
}

/// Unrounded totals; see [`Calculated::shown`] for the game's rounding.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, Default, PartialEq)]
pub struct Calculated {
    pub max_health: f64,
    pub spirit_power: f64,
    /// Percent.
    pub weapon_damage: f64,
    /// Percent; can be negative.
    pub bullet_resist: f64,
    pub spirit_resist: f64,
    /// Souls per slot: vitality, spirit, weapon.
    pub invested: [f64; 3],
    pub boons: u32,
}

/// Integers the way the game shows them.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shown {
    pub max_health: i64,
    pub spirit_power: i64,
    pub weapon_damage: i64,
    pub bullet_resist: i64,
    pub spirit_resist: i64,
}

/// Float noise allowance before truncating (e.g. 730 * 1.5 computed as 1094.9999).
const EPS: f64 = 1e-6;

impl Calculated {
    /// Health truncated (the game's integer `m_iMaxHealth`); the rest rounded as the HUD does.
    /// Metadata `tech_power` truncates instead: see [`SPIRIT_POWER`].
    pub fn shown(&self) -> Shown {
        let r = |v: f64| v.round() as i64;
        Shown {
            max_health: (self.max_health + EPS).floor() as i64,
            spirit_power: r(self.spirit_power),
            weapon_damage: r(self.weapon_damage),
            bullet_resist: r(self.bullet_resist),
            spirit_resist: r(self.spirit_resist),
        }
    }
}

pub(crate) fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

impl StatTable {
    /// Whether `id` is a shop item (as opposed to a hero ability or an unknown id).
    pub fn is_shop_item(&self, id: u32) -> bool {
        self.items.get(&id).is_some_and(|i| i.slot.is_some())
    }

    /// The build's stats, or `None` for a hero this patch doesn't know.
    pub fn calculate(&self, b: &Build) -> Option<Calculated> {
        let hero = self.heroes.get(&b.hero_id)?;
        let boons = hero.boon_levels.iter().filter(|l| **l <= b.level).count() as u32;
        let per_boon = |v: f64| v * f64::from(boons);
        let mut invested = [0.0; 3];
        let mut sources: Vec<(Stat, f64)> = Vec::new();
        for id in &b.items {
            let Some(item) = self.items.get(id) else { continue };
            if let Some(slot) = item.slot.and_then(|s| invested.get_mut(usize::from(s))) {
                *slot += item.price;
            }
            sources.extend(&item.passive);
            if let (Some(t), Some(h)) = (item.life_threshold, b.health_pct)
                && h >= t
            {
                sources.extend(&item.conditional);
            }
        }
        for (id, tiers) in &b.ability_tiers {
            if let Some(a) = self.items.get(id) {
                sources.extend(a.upgrades.iter().take(usize::from(*tiers)).flatten());
            }
        }
        let bonus = |slot: usize| hero.cost_bonuses[slot].iter().rev().find(|(t, _)| invested[slot] >= *t).map_or(0.0, |(_, b)| *b);
        let sum = |s: Stat| sources.iter().filter(|(x, _)| *x == s).map(|(_, v)| v).sum::<f64>();
        let prod = |s: Stat| sources.iter().filter(|(x, _)| *x == s).map(|(_, v)| 1.0 + v / 100.0).product::<f64>();
        let g = &hero.per_boon;

        let base = hero.max_health + per_boon(g.max_health);
        let max_health = (base * (1.0 + (bonus(0) + sum(Stat::BaseHealthPct)) / 100.0) + sum(Stat::MaxHealth) + b.pickups.max_health) * prod(Stat::MaxHealthPct);
        let spirit_power = (per_boon(g.spirit_power) + bonus(1) + sum(Stat::SpiritPower) + b.pickups.spirit_power) * prod(Stat::SpiritPowerPct);
        let weapon_damage = bonus(2) + per_boon(g.weapon_damage) + sum(Stat::WeaponDamage) + b.pickups.weapon_damage;
        let resist = |stat: Stat, innate: f64| {
            let stack = |vals: &mut dyn Iterator<Item = f64>| 100.0 * (1.0 - vals.map(|v| 1.0 - v / 100.0).product::<f64>());
            let mut pos = std::iter::once(innate).chain(sources.iter().filter(|(x, v)| *x == stat && *v > 0.0).map(|(_, v)| *v));
            let mut neg = sources.iter().filter(|(x, v)| *x == stat && *v < 0.0).map(|(_, v)| -v);
            stack(&mut pos) - stack(&mut neg)
        };
        let bullet_innate = hero.bullet_resist + per_boon(g.bullet_resist) + hero.bullet_resist_per_spirit * spirit_power + b.pickups.bullet_resist;
        let spirit_innate = hero.spirit_resist + per_boon(g.spirit_resist) + hero.spirit_resist_per_spirit * spirit_power + b.pickups.spirit_resist;
        Some(Calculated {
            max_health,
            spirit_power,
            weapon_damage,
            bullet_resist: resist(Stat::BulletResist, bullet_innate),
            spirit_resist: resist(Stat::SpiritResist, spirit_innate),
            invested,
            boons,
        })
    }

    /// A boon-data snapshot (`heroes.json`, `abilities.json`, `misc.json`).
    pub fn from_boon_data(heroes: &[u8], abilities: &[u8], misc: &[u8]) -> Result<Self, String> {
        let parse = |b: &[u8], f: &str| serde_json::from_slice::<Value>(b).map_err(|e| format!("{f}: {e}"));
        reduce::boon_data(&parse(heroes, "heroes")?, &parse(abilities, "abilities")?, &parse(misc, "misc")?)
    }

    /// A boon-data snapshot directory.
    pub fn load_boon_data(dir: &std::path::Path) -> Result<Self, String> {
        let read = |f: &str| std::fs::read(dir.join(f)).map_err(|e| format!("{f}: {e}"));
        Self::from_boon_data(&read("heroes.json")?, &read("abilities.json")?, &read("misc.json")?)
    }

    /// The game's own vdata decoded to JSON (the root objects of `scripts/heroes.vdata`,
    /// `abilities.vdata` and `generic_data.vdata`), for the install's `client_version`. `token`
    /// names an ability the way the timeline does (CUtlStringToken of its name).
    pub fn from_vdata(client_version: u32, heroes: &Value, abilities: &Value, generic: &Value, token: impl Fn(&str) -> u32) -> Self {
        reduce::vdata(client_version, heroes, abilities, generic, token)
    }

    /// Ids whose numbers differ from `other`'s: `(items, heroes)`, ascending (for comparing two
    /// sources of one patch).
    pub fn differences(&self, other: &StatTable) -> (Vec<u32>, Vec<u32>) {
        fn diff<T: PartialEq>(a: &BTreeMap<u32, T>, b: &BTreeMap<u32, T>) -> Vec<u32> {
            let mut ids: Vec<u32> = a.keys().chain(b.keys()).copied().filter(|id| a.get(id) != b.get(id)).collect();
            ids.sort_unstable();
            ids.dedup();
            ids
        }
        (diff(&self.items, &other.items), diff(&self.heroes, &other.heroes))
    }
}

#[cfg(test)]
mod tests;
