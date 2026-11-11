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
fn catalog() -> StatTable {
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
    StatTable::from_boon_data(&b(&heroes), &b(&abilities), &b(&misc)).expect("loads")
}

const SANDBOX: [u32; 12] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

#[test]
fn sandbox_build_matches_the_operators_screenshots() {
    // Patch 6860 sandbox, Mirage at level 0 (no boons): the Tab panel showed 1470 max health,
    // 0% bullet / 33% spirit resist, 176 spirit power and 91% weapon damage.
    let cat = catalog();
    let c = cat.calculate(&Build { hero_id: 52, level: 0, items: SANDBOX.to_vec(), ..Default::default() }).expect("known hero");
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
    let at = |level, items: &[u32]| cat.calculate(&Build { hero_id: 52, level, items: items.to_vec(), ..Default::default() }).expect("known hero");
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
    let c = cat.calculate(&Build { hero_id: 52, level: 1, items: vec![8], pickups, ..Default::default() }).expect("known hero");
    // Spirit pickups go inside Boundless Spirit's 15%; health pickups outside vitality's %.
    // Boundless Spirit is one T4 spirit item: 6400 souls, +45.
    assert!((c.spirit_power - (45.0 + 30.0 + 4.0) * 1.15).abs() < 1e-9);
    assert_eq!(c.max_health, 730.0 + 75.0 + 30.0);
    assert_eq!(c.weapon_damage, 6.0);
    assert!((c.bullet_resist - 1.0).abs() < 1e-9 && (c.spirit_resist - 0.5).abs() < 1e-9);
    // Abrams' Infernal Resilience tier 1: +200 health (the only passive panel stat an ability upgrade gives).
    let abrams = |tiers: u8| cat.calculate(&Build { hero_id: 6, level: 1, ability_tiers: vec![(30, tiers)], ..Default::default() }).expect("known hero").max_health;
    assert_eq!((abrams(0), abrams(1), abrams(2)), (800.0, 1000.0, 1000.0));
}

#[test]
fn conditionals_need_state_and_percent_health_multiplies_last() {
    let cat = catalog();
    let vest = |h| cat.calculate(&Build { hero_id: 52, level: 1, items: vec![20], health_pct: h, ..Default::default() }).expect("known hero").weapon_damage;
    assert_eq!((vest(None), vest(Some(64.0)), vest(Some(65.0))), (0.0, 0.0, 22.0));
    let c = cat.calculate(&Build { hero_id: 52, level: 1, items: vec![21, 4], ..Default::default() }).expect("known hero");
    assert!((c.max_health - (730.0 * 1.0 + 100.0) * 0.87).abs() < 1e-9, "{}", c.max_health);
    // Own negative resist stacks apart and is subtracted: 18 - 10.
    let r = cat.calculate(&Build { hero_id: 52, level: 1, items: vec![22], ..Default::default() }).expect("known hero");
    assert!((r.bullet_resist - 8.0).abs() < 1e-9);
    let c = cat.calculate(&Build { hero_id: 52, level: 1, items: vec![23, 24], ..Default::default() }).expect("known hero");
    assert_eq!((c.bullet_resist, c.max_health), (35.0, 730.0 * 1.2));
    assert!(cat.calculate(&Build { hero_id: 999, ..Default::default() }).is_none());
}

#[test]
fn shown_truncates_health_and_rounds_the_rest() {
    let c = Calculated { max_health: 3008.999, spirit_power: 175.95, weapon_damage: 90.5, bullet_resist: -0.4, spirit_resist: 32.77, ..Default::default() };
    assert_eq!(c.shown(), Shown { max_health: 3008, spirit_power: 176, weapon_damage: 91, bullet_resist: 0, spirit_resist: 33 });
    assert_eq!(Calculated { max_health: 1094.9999999, ..Default::default() }.shown().max_health, 1095);
}
