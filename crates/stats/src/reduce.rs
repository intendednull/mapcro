//! Game data → [`StatTable`]. Two readers of the same vdata fields: boon-data snapshots (vdata as
//! JSON plus boon's `stat_changes`, which say where each property is bound) and the game's own
//! vdata (where a modifier lists the properties it registers). Both feed one [`ability`] and one
//! [`hero`] reduction, so the rules can't tell the sources apart.

use crate::{Growth, Hero, Item, SLOTS, Stat, StatTable, TABLE_FORMAT, num};
use serde_json::Value;

/// One ability property that feeds a stat.
struct Property<'a> {
    name: &'a str,
    stat: Stat,
    value: Option<f64>,
    /// [`crate::PASSIVE`]'s test passed.
    intrinsic: bool,
}

/// [`crate::PASSIVE`]: no apply filter, usage not `Conditionally*`, and bound to an
/// `m_AutoIntrinsicModifiers/N` (not a modifier nested in one), or, for a shop item, bound
/// nowhere with the `IntrinsicallyProvidedInAbility` flag (boon's reading). A hero ability's
/// unbound property can be one the game applies from code in a state (Kelvin's Ice Path spirit:
/// boon-data binds it to the ice path's modifier, the vdata doesn't), so it needs the binding.
fn passive(item: bool, filtered: bool, flags: &str, bindings: &[&str]) -> bool {
    let intrinsic_path = |k: &&str| k.rsplit_once("/m_AutoIntrinsicModifiers/").is_some_and(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    let unconditional = !filtered && !flags.starts_with("Conditionally");
    unconditional && (bindings.iter().any(intrinsic_path) || (item && bindings.is_empty() && flags.contains("IntrinsicallyProvidedInAbility")))
}

fn hero(d: &Value) -> Hero {
    let start = &d["m_mapStartingStats"];
    let growth = &d["m_mapStandardLevelUpUpgrades"];
    let g = |k: &str| num(&growth[k]).unwrap_or(0.0);
    let mut hero = Hero {
        max_health: num(&start["EMaxHealth"]).unwrap_or(0.0),
        per_boon: Growth {
            max_health: g("MODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL"),
            spirit_power: g("MODIFIER_VALUE_TECH_POWER"),
            weapon_damage: g("MODIFIER_VALUE_WEAPON_DAMAGE_INCREASE"),
            bullet_resist: g("MODIFIER_VALUE_BULLET_ARMOR_DAMAGE_RESIST"),
            spirit_resist: g("MODIFIER_VALUE_TECH_RESIST"),
        },
        bullet_resist: num(&start["EBulletArmorDamageReduction"]).unwrap_or(0.0),
        spirit_resist: num(&start["ETechArmorDamageReduction"]).unwrap_or(0.0),
        ..Default::default()
    };
    if let Some(levels) = d["m_mapLevelInfo"].as_object() {
        hero.boon_levels = levels.iter().filter(|(_, v)| v["m_bUseStandardUpgrade"] == true).filter_map(|(k, _)| k.parse().ok()).collect();
        hero.boon_levels.sort_unstable();
    }
    for (i, slot) in SLOTS.iter().enumerate() {
        if let Some(rows) = d["m_MapModCostBonuses"][slot].as_array() {
            hero.cost_bonuses[i] = rows.iter().filter_map(|r| Some((num(&r["nGoldThreshold"])?, num(&r["flBonus"])?, num(&r["flPercentOnGraph"]).unwrap_or(0.0)))).collect();
            hero.cost_bonuses[i].sort_by(|a, b| a.0.total_cmp(&b.0));
        }
    }
    let scale = |key: &str| {
        let s = &d["m_mapScalingStats"][key];
        if s["eScalingStat"] == "ETechPower" { num(&s["flScale"]).unwrap_or(0.0) } else { 0.0 }
    };
    hero.bullet_resist_per_spirit = scale("EBulletArmorDamageReduction");
    hero.spirit_resist_per_spirit = scale("ETechArmorDamageReduction");
    hero
}

/// An item or ability; `None` when it feeds nothing the rules read.
fn ability(d: &Value, properties: &[Property], prices: &[f64]) -> Option<Item> {
    let mut item = Item::default();
    if d["m_eAbilityType"] == "EAbilityType_Item" {
        let tier = d["m_iItemTier"].as_str().and_then(|t| t.strip_prefix("EModTier_")).and_then(|t| t.parse::<usize>().ok());
        item.slot = d["m_eItemSlotType"].as_str().and_then(|s| SLOTS.iter().position(|x| *x == s)).and_then(|s| u8::try_from(s).ok());
        item.price = tier.and_then(|t| prices.get(t)).copied().unwrap_or(0.0);
    }
    item.life_threshold = num(&d["m_mapAbilityProperties"]["LifeThreshold"]["m_strValue"]);
    for p in properties {
        match p.value {
            Some(v) if v != 0.0 && p.intrinsic => item.passive.push((p.stat, v)),
            Some(v) if v != 0.0 => item.conditional.push((p.stat, v)),
            _ => {}
        }
    }
    if let Some(tiers) = d["m_vecAbilityUpgrades"].as_array() {
        for tier in tiers {
            let bonuses = tier["m_vecPropertyUpgrades"].as_array().map(|ups| {
                ups.iter()
                    .filter(|u| u["m_eUpgradeType"].is_null())
                    .filter_map(|u| {
                        let name = u["m_strPropertyName"].as_str()?;
                        // The last property of that name wins, as in a map.
                        let p = properties.iter().rev().find(|p| p.name == name)?;
                        p.intrinsic.then_some((p.stat, num(&u["m_strBonus"])?))
                    })
                    .collect()
            });
            item.upgrades.push(bonuses.unwrap_or_default());
        }
        if item.upgrades.iter().all(Vec::is_empty) {
            item.upgrades.clear();
        }
    }
    if item.life_threshold.is_some() && item.conditional.is_empty() {
        item.life_threshold = None;
    }
    let feeds = item.slot.is_some() || !item.passive.is_empty() || !item.conditional.is_empty() || !item.upgrades.is_empty();
    feeds.then_some(item)
}

fn records<'a>(doc: &'a Value, what: &str) -> Result<&'a Vec<Value>, String> {
    doc["records"].as_array().ok_or_else(|| format!("{what}: no records"))
}

fn prices(generic: &Value) -> Result<Vec<f64>, String> {
    Ok(generic["m_nItemPricePerTier"].as_array().ok_or("no m_nItemPricePerTier")?.iter().map(|v| num(v).unwrap_or(0.0)).collect())
}

pub(crate) fn boon_data(heroes: &Value, abilities: &Value, misc: &Value) -> Result<StatTable, String> {
    let prices = prices(&misc["generic_data"]).map_err(|e| format!("misc: {e}"))?;
    let version = heroes["client_version"].as_str().and_then(|v| v.parse().ok()).or_else(|| heroes["client_version"].as_u64().and_then(|v| u32::try_from(v).ok()));
    let mut table = StatTable { format: TABLE_FORMAT, client_version: version.ok_or("heroes: no client_version")?, source: "boon-data".into(), ..Default::default() };
    for r in records(heroes, "heroes")? {
        if let Some(id) = r["hero_id"].as_u64().and_then(|i| u32::try_from(i).ok()).filter(|i| *i != 0) {
            table.heroes.insert(id, hero(&r["definition"]));
        }
    }
    for r in records(abilities, "abilities")? {
        let Some(id) = r["ability_id"].as_u64().and_then(|i| u32::try_from(i).ok()) else { continue };
        let item = r["definition"]["m_eAbilityType"] == "EAbilityType_Item";
        let changes = r["stat_changes"].as_array().map(Vec::as_slice).unwrap_or_default();
        let properties: Vec<Property> = changes
            .iter()
            .filter_map(|c| {
                let stat = c["stat"].as_str().and_then(Stat::from_modifier_value)?;
                let keys: Vec<&str> = c["modifier_keys"].as_array().map(|k| k.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
                let intrinsic = passive(item, !c["apply_filter"].is_null(), c["usage_flags"].as_str().unwrap_or(""), &keys);
                Some(Property { name: c["property_name"].as_str()?, stat, value: num(&c["value"]), intrinsic })
            })
            .collect();
        if let Some(item) = ability(&r["definition"], &properties, &prices) {
            table.items.insert(id, item);
        }
    }
    Ok(table)
}

/// Every modifier in `v` (an object with `_class`), by path below the record, with the property
/// names it registers.
fn registrations<'a>(v: &'a Value, path: &mut String, out: &mut Vec<(String, &'a str)>) {
    match v {
        Value::Object(o) => {
            if o.contains_key("_class")
                && let Some(names) = o.get("m_vecAutoRegisterModifierValueFromAbilityPropertyName").and_then(Value::as_array)
            {
                out.extend(names.iter().filter_map(Value::as_str).map(|n| (path.clone(), n)));
            }
            for (k, x) in o {
                let len = path.len();
                path.push('/');
                path.push_str(k);
                registrations(x, path, out);
                path.truncate(len);
            }
        }
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                let len = path.len();
                path.push('/');
                path.push_str(&i.to_string());
                registrations(x, path, out);
                path.truncate(len);
            }
        }
        _ => {}
    }
}

pub(crate) fn vdata(client_version: u32, heroes: &Value, abilities: &Value, generic: &Value, token: impl Fn(&str) -> u32) -> StatTable {
    let prices = prices(generic).unwrap_or_default();
    let mut table = StatTable { format: TABLE_FORMAT, client_version, source: "vdata".into(), ..Default::default() };
    for d in heroes.as_object().into_iter().flat_map(|o| o.values()) {
        if let Some(id) = d["m_HeroID"].as_u64().and_then(|i| u32::try_from(i).ok()).filter(|i| *i != 0) {
            table.heroes.insert(id, hero(d));
        }
    }
    for (name, d) in abilities.as_object().into_iter().flatten() {
        if !d.is_object() {
            continue;
        }
        let item = d["m_eAbilityType"] == "EAbilityType_Item";
        let mut regs = Vec::new();
        registrations(d, &mut format!("/{name}"), &mut regs);
        let properties: Vec<Property> = d["m_mapAbilityProperties"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(pname, p)| {
                let stat = p["m_eProvidedPropertyType"].as_str().and_then(Stat::from_modifier_value)?;
                let bound: Vec<&str> = regs.iter().filter(|(_, n)| n == pname).map(|(path, _)| path.as_str()).collect();
                let intrinsic = passive(item, !p["m_eApplyFilter"].is_null(), p["m_eStatsUsageFlags"].as_str().unwrap_or(""), &bound);
                Some(Property { name: pname, stat, value: num(&p["m_strValue"]), intrinsic })
            })
            .collect();
        if let Some(item) = ability(d, &properties, &prices) {
            table.items.insert(token(name), item);
        }
    }
    table
}
