//! Item, ability and status-effect (modifier) records from `scripts/abilities.vdata_c` and
//! `scripts/modifiers.vdata_c`, keyed by the token the replay timeline uses
//! (docs/research/abilities-and-items.md §3, status-effects.md §3).
//!
//! - An item or ability is a top-level record of `abilities.vdata`, keyed by the token of its
//!   name. `_not_pickable` records are the base classes the others inherit from (the compiled
//!   vdata already carries every inherited field), so they're left out.
//! - A modifier is a nested subclass (any object with `_class` and `_my_subclass_name`) inside an
//!   ability record or a `modifiers.vdata` record. Its name is qualified by the chain of names
//!   above it, joined by `/` (`upgrade_toxic_bullets/modifier_a/modifier_b`); `modifiers.vdata`'s
//!   own records keep their bare names. Scale functions and projectiles add to the chain but
//!   aren't records.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::kv3::Value;

/// CUtlStringToken: MurmurHash2 of the lower-cased name, seed `0x31415926` (the game's ids for
/// items, abilities and modifiers; the same function as `mapcro_replay::timeline::token`).
pub fn token(name: &str) -> u32 {
    const M: u32 = 0x5bd1_e995;
    let key = name.to_ascii_lowercase();
    let key = key.as_bytes();
    let mut h = 0x3141_5926 ^ key.len() as u32;
    let (chunks, rest) = key.as_chunks::<4>();
    for chunk in chunks {
        let mut k = u32::from_le_bytes(*chunk).wrapping_mul(M);
        k ^= k >> 24;
        h = h.wrapping_mul(M) ^ k.wrapping_mul(M);
    }
    if rest.len() >= 3 {
        h ^= u32::from(rest[2]) << 16;
    }
    if rest.len() >= 2 {
        h ^= u32::from(rest[1]) << 8;
    }
    if let Some(&byte) = rest.first() {
        h = (h ^ u32::from(byte)).wrapping_mul(M);
    }
    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^ (h >> 15)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Item,
    Ability,
    Modifier,
}

/// Where a record's display name came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NameFrom {
    /// The English localisation.
    Localisation,
    /// A modifier with no name of its own: the localised name of the ability or item it's under.
    Ability,
    /// No localised name: the internal name, prefix stripped ([`fallback_name`]).
    Internal,
}

/// One record of the names table (`data/abilities.json`).
#[derive(Clone, Debug, Serialize)]
pub struct Record {
    /// The internal name; for a nested modifier, qualified (`ability/…/modifier`).
    pub name: String,
    pub kind: Kind,
    /// The display name, always present ([`NameFrom`] says how it was found).
    pub label: String,
    pub label_from: NameFrom,
    /// Items and abilities: `m_eAbilityType` without its prefix (`item`, `signature`,
    /// `ultimate`, `innate`, `weapon`, `melee`…).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ability_type: Option<String>,
    /// Items: `weapon`, `vitality` or `spirit` (`m_eItemSlotType`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
    /// Items: the shop tier, 1 to 5 (`m_iItemTier`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<u8>,
    /// Items: the tier's price in souls (`generic_data.vdata`'s `m_nItemPricePerTier`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<u32>,
    /// Items: the component items' tokens (`m_vecComponentItems`), in the game's order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<u32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub disabled: bool,
    /// The icon's blob key in this pack. Modifiers: their own HUD icon (`m_strHudIcon`) where
    /// they have one; otherwise show [`Record::ability`]'s.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Modifiers: the token of the ability or item record they're nested in (none for
    /// `modifiers.vdata`'s own, and for those on pickups, props and NPCs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ability: Option<u32>,
    /// Modifiers: `m_bIsHidden`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    /// Modifiers: `m_strSmallIconCssClass`, the Panorama class of the game's small icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_class: Option<String>,
    /// Modifiers: `m_eDebuffType` without its prefix (`yes`, `no`, `enemy_team_only`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debuff: Option<String>,
    /// Modifiers: the `MODIFIER_STATE_*` names of `m_nEnabledStateMask`, prefix stripped.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub states: Vec<String>,
    /// The VPK entries the icon may come from, in preference order, before they're checked and
    /// decoded.
    #[serde(skip)]
    pub icon_entries: Vec<String>,
}

/// The parsed table, and what didn't fit in it.
#[derive(Debug, Default)]
pub struct Table {
    pub records: BTreeMap<u32, Record>,
    /// Names whose token another name already took (kept: the first).
    pub collisions: Vec<[String; 2]>,
}

impl Table {
    pub fn count(&self, kind: Kind) -> usize {
        self.records.values().filter(|r| r.kind == kind).count()
    }
}

/// Parse the vdata roots: `abilities.vdata`, `modifiers.vdata`, and `hosts`, files whose records
/// aren't abilities but carry modifiers (`misc.vdata`'s pickups and props, `npc_units.vdata`'s
/// auras). `names` is the merged English localisation, keys lower-cased; `prices` is
/// `m_nItemPricePerTier` (index = tier).
pub fn parse(
    abilities: &Value,
    modifiers: Option<&Value>,
    hosts: &[&Value],
    names: &BTreeMap<String, String>,
    prices: &[u32],
) -> Table {
    let mut table = Table::default();

    for (name, value) in abilities.as_object().unwrap_or_default() {
        let Some(record) = value.as_object() else {
            continue;
        };
        if field(record, "_not_pickable").is_some() {
            continue;
        }
        let ability_type = field(record, "m_eAbilityType")
            .and_then(Value::as_str)
            .map(|t| {
                t.strip_prefix("EAbilityType_")
                    .unwrap_or(t)
                    .to_ascii_lowercase()
            });
        let kind = if ability_type.as_deref() == Some("item") {
            Kind::Item
        } else {
            Kind::Ability
        };
        let tier = (kind == Kind::Item)
            .then(|| {
                field(record, "m_iItemTier")
                    .and_then(Value::as_str)
                    .and_then(tier_of)
            })
            .flatten();
        // The HUD image, else the shop's (an SVG HUD image the shop has as a texture, say).
        let icon_entries = ["m_strAbilityImage", "m_strShopIconLarge"]
            .into_iter()
            .filter_map(|key| field(record, key).and_then(Value::as_str))
            .filter_map(image_entry)
            .collect();
        let (label, label_from) = label(names, name, None);
        let own = token(name);
        insert(
            &mut table,
            Record {
                name: name.clone(),
                kind,
                label,
                label_from,
                ability_type,
                slot: (kind == Kind::Item)
                    .then(|| {
                        field(record, "m_eItemSlotType")
                            .and_then(Value::as_str)
                            .and_then(slot_of)
                    })
                    .flatten(),
                tier,
                cost: tier.and_then(|t| prices.get(usize::from(t)).copied()),
                components: field(record, "m_vecComponentItems")
                    .and_then(Value::as_array)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(Value::as_str)
                    .map(token)
                    .collect(),
                disabled: field(record, "m_bDisabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                icon: None,
                ability: None,
                hidden: None,
                icon_class: None,
                debuff: None,
                states: Vec::new(),
                icon_entries,
            },
        );
        for (_, child) in record {
            nested(&mut table, names, child, name, Some(own));
        }
    }

    if let Some(root) = modifiers {
        for (name, value) in root.as_object().unwrap_or_default() {
            let Some(record) = value.as_object() else {
                continue;
            };
            if field(record, "_not_pickable").is_some() {
                continue;
            }
            insert(&mut table, modifier(names, name, record, None));
            for (_, child) in record {
                nested(&mut table, names, child, name, None);
            }
        }
    }

    for root in hosts {
        for (name, value) in root.as_object().unwrap_or_default() {
            let Some(record) = value.as_object() else {
                continue;
            };
            if field(record, "_not_pickable").is_some() {
                continue;
            }
            for (_, child) in record {
                nested(&mut table, names, child, name, None);
            }
        }
    }

    // Engine modifiers no vdata defines, by their bare names (after the vdata, so a patch that
    // defines one there wins).
    for name in ENGINE_MODIFIERS {
        insert(&mut table, modifier(names, name, &[], None));
    }

    table
}

/// Modifiers the game applies to heroes that no vdata file defines, seen in 129738985's
/// modifier table (docs/research/status-effects.md §3). Internal names only; any display name
/// still comes from the localisation.
pub const ENGINE_MODIFIERS: [&str; 6] = [
    "modifier_citadel_tossup",
    "modifier_citadel_push",
    "modifier_player_pinged",
    "modifier_citadel_pre_match_wait",
    "modifier_invis_fading",
    "modifier_learning_hero_ability",
];

/// Walk `value` for nested subclasses under `path`, the qualified name of the record above;
/// `owner` is the item or ability record they're under, if any.
fn nested(
    table: &mut Table,
    names: &BTreeMap<String, String>,
    value: &Value,
    path: &str,
    owner: Option<u32>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                nested(table, names, item, path, owner);
            }
        }
        Value::Object(record) => {
            let class = field(record, "_class")
                .and_then(Value::as_str)
                .unwrap_or("");
            let sub = field(record, "_my_subclass_name")
                .and_then(Value::as_str)
                .unwrap_or("");
            let here = if sub.is_empty() || class.is_empty() {
                path.to_owned()
            } else {
                let qualified = format!("{path}/{sub}");
                if class.contains("modifier") {
                    insert(table, modifier(names, &qualified, record, owner));
                }
                qualified
            };
            for (_, child) in record {
                nested(table, names, child, &here, owner);
            }
        }
        _ => {}
    }
}

fn modifier(
    names: &BTreeMap<String, String>,
    name: &str,
    record: &[(String, Value)],
    owner: Option<u32>,
) -> Record {
    let text = |key: &str| {
        field(record, key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let (label, label_from) = label(names, name, text("m_sLocalizationName"));
    Record {
        name: name.to_owned(),
        kind: Kind::Modifier,
        label,
        label_from,
        ability_type: None,
        slot: None,
        tier: None,
        cost: None,
        components: Vec::new(),
        disabled: false,
        icon: None,
        ability: owner,
        hidden: field(record, "m_bIsHidden").and_then(Value::as_bool),
        icon_class: text("m_strSmallIconCssClass").map(str::to_owned),
        debuff: text("m_eDebuffType").map(|d| {
            d.strip_prefix("MODIFIER_DEBUFF_")
                .unwrap_or(d)
                .to_ascii_lowercase()
        }),
        states: text("m_nEnabledStateMask")
            .map(|mask| {
                mask.split('|')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| {
                        s.strip_prefix("MODIFIER_STATE_")
                            .unwrap_or(s)
                            .to_ascii_lowercase()
                    })
                    .collect()
            })
            .unwrap_or_default(),
        icon_entries: text("m_strHudIcon")
            .and_then(image_entry)
            .into_iter()
            .collect(),
    }
}

fn insert(table: &mut Table, record: Record) {
    let id = token(&record.name);
    if let Some(first) = table.records.get(&id) {
        if first.name != record.name {
            table.collisions.push([first.name.clone(), record.name]);
        }
        return;
    }
    table.records.insert(id, record);
}

/// The display name for `name`: its localisation key (`key`, else the leaf of `name`), else the
/// internal name stripped. A nested modifier's ability label is filled in by [`fill_from_ability`].
fn label(names: &BTreeMap<String, String>, name: &str, key: Option<&str>) -> (String, NameFrom) {
    let leaf = name.rsplit('/').next().unwrap_or(name);
    let key = key.map(|k| k.trim_start_matches('#')).unwrap_or(leaf);
    match names
        .get(&key.to_ascii_lowercase())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        Some(text) => (text.to_owned(), NameFrom::Localisation),
        None => (fallback_name(leaf).to_owned(), NameFrom::Internal),
    }
}

/// A modifier with no localised name takes the localised name of the record it's nested in.
pub fn fill_from_ability(table: &mut Table) {
    let labels: BTreeMap<u32, String> = table
        .records
        .iter()
        .filter(|(_, r)| r.kind != Kind::Modifier && r.label_from == NameFrom::Localisation)
        .map(|(id, r)| (*id, r.label.clone()))
        .collect();
    for record in table.records.values_mut() {
        if record.label_from == NameFrom::Internal
            && let Some(text) = record.ability.and_then(|a| labels.get(&a))
        {
            record.label = text.clone();
            record.label_from = NameFrom::Ability;
        }
    }
}

/// The internal name with its `upgrade_`, `ability_` or `modifier_` prefix stripped (the UI's
/// fallback when there's no localised name, abilities-and-items.md §3).
pub fn fallback_name(name: &str) -> &str {
    for prefix in ["upgrade_", "ability_", "modifier_"] {
        if let Some(rest) = name.strip_prefix(prefix)
            && !rest.is_empty()
        {
            return rest;
        }
    }
    name
}

/// Turn an image value such as `file://{images}/upgrades/mods_weapon/fleetfoot_boots.psd` into
/// its VPK entry: `.psd` and `.png` sources compile to `_psd.vtex_c` / `_png.vtex_c` textures,
/// `.svg` to `.vsvg_c`. Anything else isn't an icon the pack reads.
pub fn image_entry(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_matches('"');
    let raw = raw
        .strip_prefix("panorama:")
        .unwrap_or(raw)
        .trim_matches('"');
    let relative = raw.strip_prefix("file://{images}/")?;
    let path = format!("panorama/images/{relative}");
    if let Some(stem) = path.strip_suffix(".psd") {
        Some(format!("{stem}_psd.vtex_c"))
    } else if let Some(stem) = path.strip_suffix(".png") {
        Some(format!("{stem}_png.vtex_c"))
    } else {
        path.strip_suffix(".svg")
            .map(|stem| format!("{stem}.vsvg_c"))
    }
}

fn tier_of(raw: &str) -> Option<u8> {
    raw.strip_prefix("EModTier_")?.parse().ok()
}

fn slot_of(raw: &str) -> Option<String> {
    Some(
        match raw {
            "EItemSlotType_WeaponMod" => "weapon",
            "EItemSlotType_Armor" => "vitality",
            "EItemSlotType_Tech" => "spirit",
            _ => return None,
        }
        .to_owned(),
    )
}

/// `m_nItemPricePerTier` from `generic_data.vdata`.
pub fn prices(generic: &Value) -> Vec<u32> {
    generic
        .get("m_nItemPricePerTier")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .map(|v| v.as_u64().and_then(|n| u32::try_from(n).ok()).unwrap_or(0))
        .collect()
}

/// The records whose icon the pack carries: items still in the shop, the four signature
/// abilities of the given heroes, and modifiers with a HUD icon of their own.
pub fn wants_icon(record: &Record, signature: &BTreeSet<String>) -> bool {
    match record.kind {
        Kind::Item => !record.disabled,
        Kind::Ability => signature.contains(&record.name),
        Kind::Modifier => true,
    }
}

fn field<'a>(record: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    record.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_the_games_ids() {
        // boon's known pair and the catalog's generic stun, as `timeline::token`'s test has them.
        assert_eq!(token("modifier_player_pinged"), 1_215_616_703);
        assert_eq!(token("modifier_citadel_stunned"), 1_398_909_042);
        assert_eq!(
            token("Modifier_Citadel_Stunned"),
            1_398_909_042,
            "lower-cased first"
        );
        // Ids the game itself sent in 129738985 (an ability_subclass or modifier_subclass in
        // its modifier table), one for each remainder past the last 4-byte chunk: 1, 2, 3, 3.
        assert_eq!(token("ability_afterburn"), 1_593_133_799);
        assert_eq!(token("ability_flame_dash"), 3_516_947_824);
        assert_eq!(token("upgrade_fleetfoot_boots"), 3_403_085_434);
        assert_eq!(token("modifier_citadel_tossup"), 2_696_315_756);
        assert_eq!(token("modifier_citadel_push"), 1_823_209_505);
        // Every remainder length (0–3 bytes past the last 4-byte chunk) takes part.
        let ids: BTreeSet<u32> = ["abcd", "abcde", "abcdef", "abcdefg"].map(token).into();
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn fallback_strips_one_known_prefix() {
        assert_eq!(fallback_name("upgrade_fleetfoot_boots"), "fleetfoot_boots");
        assert_eq!(fallback_name("ability_afterburn"), "afterburn");
        assert_eq!(
            fallback_name("modifier_citadel_knockdown"),
            "citadel_knockdown"
        );
        assert_eq!(
            fallback_name("citadel_ability_dash"),
            "citadel_ability_dash"
        );
        assert_eq!(fallback_name("upgrade_"), "upgrade_", "never empty");
    }

    #[test]
    fn image_values_become_vpk_entries() {
        assert_eq!(
            image_entry("file://{images}/upgrades/mods_weapon/fleetfoot_boots.psd").as_deref(),
            Some("panorama/images/upgrades/mods_weapon/fleetfoot_boots_psd.vtex_c")
        );
        assert_eq!(
            image_entry("panorama:\"file://{images}/hud/abilities/inferno_molotov.psd\"")
                .as_deref(),
            Some("panorama/images/hud/abilities/inferno_molotov_psd.vtex_c")
        );
        assert_eq!(
            image_entry("file://{images}/upgrades/mods_armor/portable_rejuvenator.png").as_deref(),
            Some("panorama/images/upgrades/mods_armor/portable_rejuvenator_png.vtex_c")
        );
        assert_eq!(
            image_entry("file://{images}/hud/modifiers/icon_parry.svg").as_deref(),
            Some("panorama/images/hud/modifiers/icon_parry.vsvg_c")
        );
        assert_eq!(image_entry("file://{images}/hud/x.tga"), None);
        assert_eq!(image_entry("s2r://panorama/images/x.psd"), None);
        assert_eq!(image_entry(""), None);
    }

    #[test]
    fn tiers_and_slots_read_the_game_enums() {
        assert_eq!(tier_of("EModTier_3"), Some(3));
        assert_eq!(tier_of("EModTier_x"), None);
        assert_eq!(tier_of("3"), None);
        assert_eq!(
            slot_of("EItemSlotType_WeaponMod").as_deref(),
            Some("weapon")
        );
        assert_eq!(slot_of("EItemSlotType_Armor").as_deref(), Some("vitality"));
        assert_eq!(slot_of("EItemSlotType_Tech").as_deref(), Some("spirit"));
        assert_eq!(slot_of("EItemSlotType_Other"), None);
    }
}
