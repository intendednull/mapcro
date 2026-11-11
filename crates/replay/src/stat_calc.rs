//! Calculated hero stats (spike, docs/research/stat-calc-spike.md): max health, spirit power,
//! weapon damage, bullet resist and spirit resist from a hero, its level, the items it owns and
//! the game data of the replay's patch (a boon-data snapshot). The replay doesn't record these
//! totals (docs/research/stat-datamining.md), so anything shown from here is *calculated*.
//!
//! Each step is one [`Rule`] in [`RULES`], versioned and cited. Inputs are game ids (the
//! timeline's item and ability tokens), so the same code runs on a replay timeline or on match
//! metadata. Nothing here reads a player's identity.
//!
//! What's left out, on purpose: effects the game applies only in some states (an active item, a
//! stacking buff, an enemy's debuff), except life-threshold items when the caller passes the
//! hero's health ([`Build::health_pct`]). Those are the misses the spike measured.

use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

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
    version: 1,
    rule: "an item or ability property counts when boon-data binds it to the ability's own \
           m_AutoIntrinsicModifiers/N (or binds it nowhere but flags it IntrinsicallyProvidedInAbility), \
           it has no apply filter and its usage isn't Conditionally*",
    source: "boon-data stat_changes (modifier_keys, usage_flags, apply_filter); boon hero_stats",
    checked: "6839/6860: sandbox 12-item build exact; Battle Vest/Hollow Point/Rapid Recharge excluded",
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stat {
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
    fn from_modifier_value(name: &str) -> Option<Self> {
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

/// Shop slots, in [`Calculated::invested`] order.
const SLOTS: [&str; 3] = ["EItemSlotType_Armor", "EItemSlotType_Tech", "EItemSlotType_WeaponMod"];

#[derive(Debug, Default)]
struct Hero {
    max_health: f64,
    per_boon: HashMap<&'static str, f64>,
    /// Levels that grant a boon.
    boon_levels: Vec<u32>,
    /// Per slot: `(threshold, bonus)` rows in order.
    cost_bonuses: [Vec<(f64, f64)>; 3],
    bullet_resist: f64,
    spirit_resist: f64,
    /// Resist per point of spirit power (`m_mapScalingStats`).
    bullet_resist_per_spirit: f64,
    spirit_resist_per_spirit: f64,
}

#[derive(Debug, Default)]
struct Item {
    /// Index into [`SLOTS`] and the price, for shop items.
    slot: Option<usize>,
    price: f64,
    passive: Vec<(Stat, f64)>,
    conditional: Vec<(Stat, f64)>,
    life_threshold: Option<f64>,
    /// Per upgrade tier, the passive bonuses it adds (hero abilities).
    upgrades: Vec<Vec<(Stat, f64)>>,
}

/// One patch's game data, reduced to what the rules read.
#[derive(Debug, Default)]
pub struct Catalog {
    pub client_version: String,
    heroes: HashMap<u32, Hero>,
    items: HashMap<u32, Item>,
}

/// Statue pickups (permanent; the replay's stat viewer and the metadata's `power_up_buffs`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Pickups {
    pub max_health: f64,
    pub spirit_power: f64,
    pub weapon_damage: f64,
    pub bullet_resist: f64,
    pub spirit_resist: f64,
}

/// What the hero has at one moment.
#[derive(Debug, Clone, Default)]
pub struct Build<'a> {
    pub hero_id: u32,
    /// The scoreboard level (1-based, `m_iLevel`).
    pub level: u32,
    /// Owned items by id (the timeline's tokens); unknown ids are ignored.
    pub items: &'a [u32],
    /// `(ability id, upgrade tiers bought)` for the hero's abilities.
    pub ability_tiers: &'a [(u32, u8)],
    pub pickups: Pickups,
    /// Health percent, for [`LIFE_THRESHOLD`]; `None` leaves those items out.
    pub health_pct: Option<f64>,
}

/// Unrounded totals; see [`Calculated::shown`] for the game's rounding.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// [`PASSIVE`]'s test: a direct `m_AutoIntrinsicModifiers/N` binding (not a nested modifier), or
/// no binding at all with the `IntrinsicallyProvidedInAbility` usage flag (boon's reading).
fn intrinsic(change: &Value) -> bool {
    let flags = change["usage_flags"].as_str().unwrap_or("");
    let unconditional = change["apply_filter"].is_null() && !flags.starts_with("Conditionally");
    let keys: Vec<&str> = change["modifier_keys"].as_array().map(|k| k.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let bound = keys.iter().any(|k| k.rsplit_once("/m_AutoIntrinsicModifiers/").is_some_and(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())));
    unconditional && (bound || (keys.is_empty() && flags.contains("IntrinsicallyProvidedInAbility")))
}

fn records(doc: &Value, what: &str) -> Result<Vec<Value>, String> {
    doc["records"].as_array().cloned().ok_or_else(|| format!("{what}: no records"))
}

impl Catalog {
    /// A boon-data snapshot directory (`heroes.json`, `abilities.json`, `misc.json`).
    pub fn load(dir: &Path) -> Result<Self, String> {
        let read = |f: &str| std::fs::read(dir.join(f)).map_err(|e| format!("{f}: {e}"));
        Self::from_json(&read("heroes.json")?, &read("abilities.json")?, &read("misc.json")?)
    }

    pub fn from_json(heroes: &[u8], abilities: &[u8], misc: &[u8]) -> Result<Self, String> {
        let parse = |b: &[u8], f: &str| serde_json::from_slice::<Value>(b).map_err(|e| format!("{f}: {e}"));
        let (heroes, abilities, misc) = (parse(heroes, "heroes")?, parse(abilities, "abilities")?, parse(misc, "misc")?);
        let prices: Vec<f64> = misc["generic_data"]["m_nItemPricePerTier"].as_array().ok_or("misc: no m_nItemPricePerTier")?.iter().map(|v| num(v).unwrap_or(0.0)).collect();
        let mut cat = Catalog { client_version: heroes["client_version"].as_str().unwrap_or("").to_owned(), ..Default::default() };
        for r in records(&heroes, "heroes")? {
            let (Some(id), d) = (r["hero_id"].as_u64(), &r["definition"]) else { continue };
            let start = &d["m_mapStartingStats"];
            let mut hero = Hero { max_health: num(&start["EMaxHealth"]).unwrap_or(0.0), ..Default::default() };
            hero.bullet_resist = num(&start["EBulletArmorDamageReduction"]).unwrap_or(0.0);
            hero.spirit_resist = num(&start["ETechArmorDamageReduction"]).unwrap_or(0.0);
            for key in ["MODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL", "MODIFIER_VALUE_TECH_POWER", "MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST", "MODIFIER_VALUE_TECH_RESIST", "MODIFIER_VALUE_WEAPON_DAMAGE_INCREASE"] {
                if let Some(v) = num(&d["m_mapStandardLevelUpUpgrades"][key]) {
                    hero.per_boon.insert(key, v);
                }
            }
            if let Some(levels) = d["m_mapLevelInfo"].as_object() {
                hero.boon_levels = levels.iter().filter(|(_, v)| v["m_bUseStandardUpgrade"] == true).filter_map(|(k, _)| k.parse().ok()).collect();
            }
            for (i, slot) in SLOTS.iter().enumerate() {
                if let Some(rows) = d["m_MapModCostBonuses"][slot].as_array() {
                    hero.cost_bonuses[i] = rows.iter().filter_map(|r| Some((num(&r["nGoldThreshold"])?, num(&r["flBonus"])?))).collect();
                    hero.cost_bonuses[i].sort_by(|a, b| a.0.total_cmp(&b.0));
                }
            }
            let scale = |key: &str| {
                let s = &d["m_mapScalingStats"][key];
                if s["eScalingStat"] == "ETechPower" { num(&s["flScale"]).unwrap_or(0.0) } else { 0.0 }
            };
            hero.bullet_resist_per_spirit = scale("EBulletArmorDamageReduction");
            hero.spirit_resist_per_spirit = scale("ETechArmorDamageReduction");
            cat.heroes.insert(id as u32, hero);
        }
        for r in records(&abilities, "abilities")? {
            let (Some(id), d) = (r["ability_id"].as_u64(), &r["definition"]) else { continue };
            let changes = r["stat_changes"].as_array().cloned().unwrap_or_default();
            let mut item = Item::default();
            if d["m_eAbilityType"] == "EAbilityType_Item" {
                let tier = d["m_iItemTier"].as_str().and_then(|t| t.strip_prefix("EModTier_")).and_then(|t| t.parse::<usize>().ok());
                item.slot = d["m_eItemSlotType"].as_str().and_then(|s| SLOTS.iter().position(|x| *x == s));
                item.price = tier.and_then(|t| prices.get(t)).copied().unwrap_or(0.0);
            }
            item.life_threshold = num(&d["m_mapAbilityProperties"]["LifeThreshold"]["m_strValue"]);
            let mut by_property: HashMap<&str, (Stat, bool)> = HashMap::new();
            for c in &changes {
                let Some(stat) = c["stat"].as_str().and_then(Stat::from_modifier_value) else { continue };
                let on = intrinsic(c);
                if let Some(p) = c["property_name"].as_str() {
                    by_property.insert(p, (stat, on));
                }
                match num(&c["value"]) {
                    Some(v) if v != 0.0 && on => item.passive.push((stat, v)),
                    Some(v) if v != 0.0 => item.conditional.push((stat, v)),
                    _ => {}
                }
            }
            if let Some(tiers) = d["m_vecAbilityUpgrades"].as_array() {
                for tier in tiers {
                    let bonuses = tier["m_vecPropertyUpgrades"].as_array().map(|ups| {
                        ups.iter()
                            .filter(|u| u["m_eUpgradeType"].is_null())
                            .filter_map(|u| {
                                let (stat, on) = *by_property.get(u["m_strPropertyName"].as_str()?)?;
                                on.then_some((stat, num(&u["m_strBonus"])?))
                            })
                            .collect()
                    });
                    item.upgrades.push(bonuses.unwrap_or_default());
                }
            }
            cat.items.insert(id as u32, item);
        }
        Ok(cat)
    }

    /// Whether `id` is a shop item (as opposed to a hero ability or an unknown id).
    pub fn is_shop_item(&self, id: u32) -> bool {
        self.items.get(&id).is_some_and(|i| i.slot.is_some())
    }

    /// The build's stats, or `None` for a hero this patch doesn't know.
    pub fn calculate(&self, b: &Build) -> Option<Calculated> {
        let hero = self.heroes.get(&b.hero_id)?;
        let boons = hero.boon_levels.iter().filter(|l| **l <= b.level).count() as u32;
        let per_boon = |k: &str| hero.per_boon.get(k).copied().unwrap_or(0.0) * f64::from(boons);
        let mut invested = [0.0; 3];
        let mut sources: Vec<(Stat, f64)> = Vec::new();
        for id in b.items {
            let Some(item) = self.items.get(id) else { continue };
            if let Some(slot) = item.slot {
                invested[slot] += item.price;
            }
            sources.extend(&item.passive);
            if let (Some(t), Some(h)) = (item.life_threshold, b.health_pct)
                && h >= t
            {
                sources.extend(&item.conditional);
            }
        }
        for (id, tiers) in b.ability_tiers {
            if let Some(a) = self.items.get(id) {
                sources.extend(a.upgrades.iter().take(usize::from(*tiers)).flatten());
            }
        }
        let bonus = |slot: usize| hero.cost_bonuses[slot].iter().rev().find(|(t, _)| invested[slot] >= *t).map_or(0.0, |(_, b)| *b);
        let sum = |s: Stat| sources.iter().filter(|(x, _)| *x == s).map(|(_, v)| v).sum::<f64>();
        let prod = |s: Stat| sources.iter().filter(|(x, _)| *x == s).map(|(_, v)| 1.0 + v / 100.0).product::<f64>();

        let base = hero.max_health + per_boon("MODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL");
        let max_health = (base * (1.0 + (bonus(0) + sum(Stat::BaseHealthPct)) / 100.0) + sum(Stat::MaxHealth) + b.pickups.max_health) * prod(Stat::MaxHealthPct);
        let spirit_power = (per_boon("MODIFIER_VALUE_TECH_POWER") + bonus(1) + sum(Stat::SpiritPower) + b.pickups.spirit_power) * prod(Stat::SpiritPowerPct);
        let weapon_damage = bonus(2) + per_boon("MODIFIER_VALUE_WEAPON_DAMAGE_INCREASE") + sum(Stat::WeaponDamage) + b.pickups.weapon_damage;
        let resist = |stat: Stat, innate: f64| {
            let stack = |vals: &mut dyn Iterator<Item = f64>| 100.0 * (1.0 - vals.map(|v| 1.0 - v / 100.0).product::<f64>());
            let mut pos = std::iter::once(innate).chain(sources.iter().filter(|(x, v)| *x == stat && *v > 0.0).map(|(_, v)| *v));
            let mut neg = sources.iter().filter(|(x, v)| *x == stat && *v < 0.0).map(|(_, v)| -v);
            stack(&mut pos) - stack(&mut neg)
        };
        let bullet_innate = hero.bullet_resist + per_boon("MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST") + hero.bullet_resist_per_spirit * spirit_power + b.pickups.bullet_resist;
        let spirit_innate = hero.spirit_resist + per_boon("MODIFIER_VALUE_TECH_RESIST") + hero.spirit_resist_per_spirit * spirit_power + b.pickups.spirit_resist;
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn change(property: &str, stat: &str, value: f64, key: &str, flags: Option<&str>) -> Value {
        json!({"property_name": property, "stat": stat, "value": value, "apply_filter": null, "usage_flags": flags,
               "modifier_keys": if key.is_empty() { vec![] } else { vec![format!("abilities.vdata#{key}")] }})
    }
    fn passive(property: &str, stat: &str, value: f64, name: &str) -> Value {
        change(property, stat, value, &format!("/{name}/m_AutoIntrinsicModifiers/0"), Some(""))
    }
    fn item(id: u32, name: &str, slot: &str, tier: u8, changes: Vec<Value>) -> Value {
        json!({"ability_id": id, "ability_name": name, "definition": {"m_eAbilityType": "EAbilityType_Item",
               "m_eItemSlotType": format!("EItemSlotType_{slot}"), "m_iItemTier": format!("EModTier_{tier}")}, "stat_changes": changes})
    }
    const HP: &str = "MODIFIER_VALUE_HEALTH_MAX";
    const SP: &str = "MODIFIER_VALUE_TECH_POWER";
    const WD: &str = "MODIFIER_VALUE_WEAPON_DAMAGE_INCREASE";
    const SR: &str = "MODIFIER_VALUE_TECH_RESIST";
    const BR: &str = "MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST";

    /// Patch 6860's numbers for Mirage and the operator's 12-item sandbox build (values from the
    /// boon-data 6860 snapshot, only the properties the rules read).
    fn catalog() -> Catalog {
        let table = |rows: &[(u32, u32)]| rows.iter().map(|(t, b)| json!({"nGoldThreshold": t, "flBonus": b})).collect::<Vec<_>>();
        let mut levels = serde_json::Map::new();
        levels.insert("1".into(), json!({}));
        for l in 2..=36 {
            levels.insert(l.to_string(), json!({"m_bUseStandardUpgrade": true}));
        }
        let heroes = json!({"client_version": "6860", "records": [
            {"hero_id": 52, "definition": {
                "m_mapStartingStats": {"EMaxHealth": 730.0},
                "m_mapStandardLevelUpUpgrades": {"MODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL": 45.0, "MODIFIER_VALUE_TECH_POWER": 1.1, "MODIFIER_VALUE_TECH_RESIST": 0.0, "MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST": 0.0},
                "m_mapLevelInfo": levels,
                "m_MapModCostBonuses": {
                    "EItemSlotType_Armor": table(&[(800, 9), (1600, 12), (2400, 15), (3200, 20), (4800, 38), (6400, 42), (8000, 46), (11200, 50), (16000, 54), (22400, 60), (28800, 66)]),
                    "EItemSlotType_Tech": table(&[(800, 7), (1600, 11), (2400, 15), (3200, 19), (4800, 38), (6400, 45), (8000, 52), (11200, 59), (16000, 66), (22400, 75), (28800, 100)]),
                    "EItemSlotType_WeaponMod": table(&[(800, 9), (1600, 12), (2400, 15), (3200, 18), (4800, 46), (6400, 54), (8000, 62), (11200, 74), (16000, 86), (22400, 100), (28800, 115)])},
                "m_mapScalingStats": {}}},
            {"hero_id": 6, "definition": {"m_mapStartingStats": {"EMaxHealth": 800.0}, "m_mapStandardLevelUpUpgrades": {}, "m_mapLevelInfo": {}, "m_MapModCostBonuses": {}}}]});
        let cond = |p: &str, s: &str, v: f64, key: &str| change(p, s, v, key, Some("ConditionallyApplied"));
        let mut battle_vest = item(20, "upgrade_battle_vest", "Armor", 2, vec![cond("BaseAttackDamagePercent", WD, 22.0, "")]);
        battle_vest["definition"]["m_mapAbilityProperties"] = json!({"LifeThreshold": {"m_strValue": "65"}});
        let abilities = json!({"records": [
            item(1, "upgrade_titan_round", "WeaponMod", 2, vec![passive("BaseAttackDamagePercent", WD, 14.0, "upgrade_titan_round")]),
            item(2, "upgrade_slowing_bullets", "WeaponMod", 2, vec![]),
            item(3, "upgrade_long_range", "WeaponMod", 2, vec![]),
            item(4, "upgrade_bullet_armor_reduction_aura", "WeaponMod", 3, vec![passive("BonusHealth", HP, 100.0, "upgrade_bullet_armor_reduction_aura")]),
            item(5, "upgrade_rapid_recharge", "Tech", 3, vec![{
                let mut c = passive("BonusSpiritForChargedAbilities", SP, 14.0, "upgrade_rapid_recharge");
                c["apply_filter"] = json!("EApplyFilter_OnlyIfHasCharges");
                c
            }]),
            item(6, "upgrade_escalating_exposure", "Tech", 4, vec![passive("TechResist", SR, 17.0, "upgrade_escalating_exposure"),
                cond("TechArmorDamageReduction", "MODIFIER_VALUE_TECH_RESIST_REDUCTION", -8.0, "/modifier_escalating_exposure_tech_armor_debuff")]),
            item(7, "upgrade_ethereal_bullets", "Tech", 4, vec![passive("TechPower", SP, 7.0, "upgrade_ethereal_bullets")]),
            item(8, "upgrade_boundless_spirit", "Tech", 4, vec![passive("BonusHealth", HP, 75.0, "upgrade_boundless_spirit"), passive("TechPower", SP, 30.0, "upgrade_boundless_spirit"),
                passive("TechPowerPercent", "MODIFIER_VALUE_TECH_POWER_PERCENT", 15.0, "upgrade_boundless_spirit")]),
            item(9, "upgrade_arctic_blast", "Tech", 4, vec![passive("TechResist", SR, 10.0, "upgrade_arctic_blast")]),
            item(10, "upgrade_discord", "Tech", 4, vec![passive("BonusHealth", HP, 100.0, "upgrade_discord"), cond("TechResist", SR, 40.0, "")]),
            item(11, "upgrade_phantom_strike", "Armor", 4, vec![passive("BaseAttackDamagePercent", WD, 15.0, "upgrade_phantom_strike"),
                change("TechPower", SP, 8.0, "/upgrade_phantom_strike/m_AutoIntrinsicModifiers/0", None)]),
            item(12, "upgrade_infuser", "Armor", 4, vec![passive("BonusHealth", HP, 100.0, "upgrade_infuser"), passive("TechPower", SP, 8.0, "upgrade_infuser"),
                change("TechResist", SR, 10.0, "/upgrade_infuser/m_AutoIntrinsicModifiers/0", Some("IntrinsicallyProvidedInAbility")),
                cond("BonusSpirit", SP, 30.0, "/upgrade_infuser/m_BuffModifier")]),
            battle_vest,
            item(21, "upgrade_glass_cannon", "WeaponMod", 4, vec![passive("MaxHealthLossPercent", "MODIFIER_VALUE_HEALTH_MAX_PERCENT", -13.0, "upgrade_glass_cannon")]),
            item(22, "upgrade_battle_vest_bullet", "Armor", 2, vec![passive("BulletResist", BR, 18.0, "x"), passive("BulletResistLoss", BR, -10.0, "x")]),
            // Bullet Resilience's 35% has no binding but the intrinsic flag; Improved Spirit's 75
            // health has neither and the game doesn't apply it (129738985 snapshots).
            item(23, "upgrade_bullet_resilience", "Armor", 3, vec![change("BulletResist", BR, 35.0, "", Some("IntrinsicallyProvidedInAbility"))]),
            item(24, "upgrade_improved_spirit", "Tech", 2, vec![change("BonusHealth", HP, 75.0, "", Some(""))]),
            {"ability_id": 30, "ability_name": "citadel_ability_passive_beefy", "definition": {"m_eAbilityType": "EAbilityType_Innate",
                "m_vecAbilityUpgrades": [{"m_vecPropertyUpgrades": [{"m_strPropertyName": "BonusMaxHealth", "m_strBonus": "200"}]},
                                         {"m_vecPropertyUpgrades": [{"m_strPropertyName": "MeleeLifesteal", "m_strBonus": "18"}]}]},
             "stat_changes": [change("BonusMaxHealth", HP, 0.0, "/citadel_ability_passive_beefy/m_AutoIntrinsicModifiers/1", Some("IntrinsicallyProvidedInAbility"))]},
        ]});
        let misc = json!({"generic_data": {"m_nItemPricePerTier": [0, 800, 1600, 3200, 6400, 9999]}});
        let b = |v: &Value| serde_json::to_vec(v).expect("serializes");
        Catalog::from_json(&b(&heroes), &b(&abilities), &b(&misc)).expect("loads")
    }

    const SANDBOX: [u32; 12] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    #[test]
    fn sandbox_build_matches_the_operators_screenshots() {
        // Patch 6860 sandbox, Mirage at level 0 (no boons): the Tab panel showed 1470 max health,
        // 0% bullet / 33% spirit resist, 176 spirit power and 91% weapon damage.
        let cat = catalog();
        let c = cat.calculate(&Build { hero_id: 52, level: 0, items: &SANDBOX, ..Default::default() }).expect("known hero");
        assert_eq!(c.invested, [12800.0, 35200.0, 8000.0]);
        assert_eq!(c.shown(), Shown { max_health: 1470, spirit_power: 176, weapon_damage: 91, bullet_resist: 0, spirit_resist: 33 });
        // 730 * 1.5 + (100 + 75 + 100 + 100): vitality's 50% doesn't touch item health.
        assert!((c.max_health - 1470.0).abs() < 1e-9);
        // (100 + 30 + 7 + 8 + 8) * 1.15; Rapid Recharge's 14 needs charges, Infuser's 30 is active.
        assert!((c.spirit_power - 175.95).abs() < 1e-9);
        // 1 - 0.83 * 0.9 * 0.9; Scourge's 40% is conditional. Added up it would be 37%.
        assert!((c.spirit_resist - 32.77).abs() < 1e-9);
    }

    #[test]
    fn level_adds_boons_and_investment_steps_at_thresholds() {
        let cat = catalog();
        let at = |level, items: &[u32]| cat.calculate(&Build { hero_id: 52, level, items, ..Default::default() }).expect("known hero");
        assert_eq!(at(1, &[]).boons, 0);
        let c = at(10, &[]);
        assert_eq!((c.boons, c.max_health), (9, 730.0 + 9.0 * 45.0));
        assert!((c.spirit_power - 9.9).abs() < 1e-9);
        // One T2 weapon item (1600) reaches the 1600 row, not 2400.
        assert_eq!(at(1, &[2]).weapon_damage, 12.0);
        assert_eq!(at(1, &[2, 3]).weapon_damage, 18.0);
    }

    #[test]
    fn pickups_and_ability_upgrades_add_flat_values() {
        let cat = catalog();
        let pickups = Pickups { max_health: 30.0, spirit_power: 4.0, weapon_damage: 6.0, bullet_resist: 1.0, spirit_resist: 0.5 };
        let c = cat.calculate(&Build { hero_id: 52, level: 1, items: &[8], pickups, ..Default::default() }).expect("known hero");
        // Spirit pickups go inside Boundless Spirit's 15%; health pickups outside vitality's %.
        // Boundless Spirit is one T4 spirit item: 6400 souls, +45.
        assert!((c.spirit_power - (45.0 + 30.0 + 4.0) * 1.15).abs() < 1e-9);
        assert_eq!(c.max_health, 730.0 + 75.0 + 30.0);
        assert_eq!(c.weapon_damage, 6.0);
        assert!((c.bullet_resist - 1.0).abs() < 1e-9 && (c.spirit_resist - 0.5).abs() < 1e-9);
        // Abrams' Infernal Resilience tier 1: +200 health (the only passive panel stat an ability upgrade gives).
        let abrams = |tiers: u8| cat.calculate(&Build { hero_id: 6, level: 1, ability_tiers: &[(30, tiers)], ..Default::default() }).expect("known hero").max_health;
        assert_eq!((abrams(0), abrams(1), abrams(2)), (800.0, 1000.0, 1000.0));
    }

    #[test]
    fn conditionals_need_state_and_percent_health_multiplies_last() {
        let cat = catalog();
        let vest = |h| cat.calculate(&Build { hero_id: 52, level: 1, items: &[20], health_pct: h, ..Default::default() }).expect("known hero").weapon_damage;
        assert_eq!((vest(None), vest(Some(64.0)), vest(Some(65.0))), (0.0, 0.0, 22.0));
        let c = cat.calculate(&Build { hero_id: 52, level: 1, items: &[21, 4], ..Default::default() }).expect("known hero");
        assert!((c.max_health - (730.0 * 1.0 + 100.0) * 0.87).abs() < 1e-9, "{}", c.max_health);
        // Own negative resist stacks apart and is subtracted: 18 - 10.
        let r = cat.calculate(&Build { hero_id: 52, level: 1, items: &[22], ..Default::default() }).expect("known hero");
        assert!((r.bullet_resist - 8.0).abs() < 1e-9);
        let c = cat.calculate(&Build { hero_id: 52, level: 1, items: &[23, 24], ..Default::default() }).expect("known hero");
        assert_eq!((c.bullet_resist, c.max_health), (35.0, 730.0 * 1.2));
        assert!(cat.calculate(&Build { hero_id: 999, ..Default::default() }).is_none());
    }

    #[test]
    fn shown_truncates_health_and_rounds_the_rest() {
        let c = Calculated { max_health: 3008.999, spirit_power: 175.95, weapon_damage: 90.5, bullet_resist: -0.4, spirit_resist: 32.77, ..Default::default() };
        assert_eq!(c.shown(), Shown { max_health: 3008, spirit_power: 176, weapon_damage: 91, bullet_resist: 0, spirit_resist: 33 });
        assert_eq!(Calculated { max_health: 1094.9999999, ..Default::default() }.shown().max_health, 1095);
    }
}
