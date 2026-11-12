//! Item and ability tooltips (docs/plans/2026-11-10-game-tooltips.md, part 1): what the game's
//! item and ability tooltips show, from `abilities.vdata` and the English localisation, as
//! structure the web client lays out (`web/src/match/tooltips.ts`).
//!
//! - An item's blocks are its `m_vecTooltipSectionInfo` (innate stats, then passive and active
//!   sections); a hero ability's are its `m_AbilityTooltipDetails` sections. Each block names its
//!   description (`m_strLocString`), its "important" property cards and its basic property rows.
//! - Properties are `m_mapAbilityProperties` entries: the label, prefix and postfix come from the
//!   localisation (`<key>_label`, `_prefix`, `_postfix`, where `key` is `m_strLocTokenOverride`
//!   or the property's name), the icon from its `m_strCSSClass` (the game's `prop_<class>` rules in
//!   `ability_property_icons.vcss`), and a spirit or weapon scale from `m_subclassScaleFunction`.
//! - Descriptions keep the game's markup (`<span class="highlight">`, `<br>`,
//!   `{g:citadel_inline_attribute:'X'}`, `{s:Prop}`): the client formats it, never as HTML, and
//!   substitutes `{s:Prop}` from [`Values`], so a patch's values ([`overlay`]) reach the text too.
//! - Values are kept apart from the layout ([`Values`]): the install's, plus per-patch differences
//!   from boon-data snapshots, keyed like the stat tables.
//!
//! Only derived structure and the game's own words go in: no Valve file is copied.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::Value;

/// `tooltips.json`'s format; the client ignores any other.
pub const TOOLTIP_FORMAT: u32 = 1;

/// The localisation keys of the tooltip and stat-panel chrome the client shows, all in
/// `citadel_main` / `citadel_attributes`.
pub const UI_STRINGS: [&str; 22] = [
    "Citadel_Mod_Tooltip_Active",
    "Citadel_Mod_Tooltip_Passive",
    "Citadel_Shop_Purchased",
    "Citadel_ComponentRequired",
    "Citadel_IsComponentOf",
    "CitadelHeroStats_Weapon",
    "CitadelHeroStats_Vitality",
    "CitadelHeroStats_Spirit",
    "CitadelHeroStats_SpiritPower_Impact",
    "CitadelHeroStats_SpiritPower_Desc",
    "Citadel_ModBonus_WeaponInvestment",
    "Citadel_ModBonus_WeaponInvestmentDesc",
    "Citadel_ModBonus_ArmorInvestment",
    "Citadel_ModBonus_ArmorInvestmentDesc",
    "Citadel_ModBonus_TechInvestment",
    "Citadel_ModBonus_TechInvestmentDesc",
    "StatDesc_MaxHealth",
    "StatDesc_BulletArmorDamageReduction",
    "StatDesc_TechArmorDamageReduction",
    "StatDesc_TechPower",
    "BaseAttackDamagePercent_label",
    "StatDesc_ClipSizeIncrease",
];

/// One property as a tooltip shows it. Its value is in [`Values`].
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Prop {
    /// The `m_mapAbilityProperties` key (what [`Values`] and `{s:…}` use).
    pub key: String,
    pub label: String,
    /// `{s:sign}` stays as is: the client puts "+" before a positive value.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub prefix: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub postfix: String,
    /// `m_strCSSClass`: the icon is the pack's `icons[class]` (`prop_<class>`).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub css: String,
    /// A scale function with a factor: the stat (`ETechPower`, `EWeaponPower`…) and the factor,
    /// shown as the game's "×0.35".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale: Option<(String, f64)>,
    /// `m_eStatsUsageFlags` says `ConditionallyApplied`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub conditional: bool,
    /// `m_bIsNegativeAttribute`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub negative: bool,
}

/// A block: a description with its property cards and rows.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Block {
    /// The description's localised markup (`{s:Prop}` unsubstituted).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The big cards (`m_vecImportantAbilityProperties` / `m_vecAbilityPropertiesBlock`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub important: Vec<Prop>,
    /// The rows (`m_vecAbilityProperties` / `m_vecBasicProperties`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub basic: Vec<Prop>,
    /// Shown only once an upgrade changes this property (`m_strAbilityPropertyUpgradeRequired`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires: Option<String>,
}

/// A section: an item's innate stats, passive or active part, or one of an ability's sections.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Section {
    /// `innate`, `passive`, `active` (items) or `info` (abilities, and items with no section type).
    pub kind: &'static str,
    /// The section header's cooldown: an item section's first `AbilityCooldown` or `ProcCooldown`
    /// row (Escalating Exposure's passive 0.7 s is a `ProcCooldown` with no CSS class).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooldown: Option<Prop>,
    pub blocks: Vec<Block>,
}

/// One ability upgrade tier (the 1/2/5 cards): its localised text (`<name>_t<n>_desc`); its
/// bonuses are in [`Values::upgrades`].
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Upgrade {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The properties it changes, in the game's order.
    pub props: Vec<String>,
    /// A bonus that isn't added to the base value: `m_eUpgradeType` (`EAddToScale`,
    /// `EMultiplyBase`, `EMultiplyScale`) by property.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub kinds: BTreeMap<String, String>,
}

/// A record's tooltip, values apart.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Tip {
    /// Ability header properties: the cooldown, then `m_vecAdditionalHeaderProperties`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub header: Vec<Prop>,
    pub sections: Vec<Section>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub upgrades: Vec<Upgrade>,
    /// `{s:Name}` names that are another property's `m_strLocTokenOverride` (`DMarkMaxMarks` →
    /// `MaxStacks`): the text substitutes that property's value.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub aliases: BTreeMap<String, String>,
    /// The words before the stacks the hero holds on it (`m_sCustomStackLabel`): an ability's
    /// "Current Bonus:" ("Leeches Collected:" on Leech Therapy), an item's "Current Stacks:".
    /// The ability tooltip's bonus row, the item tooltip's stacks box.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack_label: Option<String>,
}

/// A record's numbers: every property's value, and each upgrade tier's bonuses, formatted as the
/// game writes them (`"2.75"`, `"-8"`).
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Values {
    pub props: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub upgrades: Vec<BTreeMap<String, String>>,
}

/// Where a tooltip icon comes from: the image's VPK entry and the game's wash colour.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct IconRule {
    /// `panorama/images/…` without the compiled suffix (`…_psd.vtex`, `….vsvg`), as the vcss says.
    #[serde(skip)]
    pub image: Option<String>,
    /// Filled in with the pack's blob key once exported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub img: Option<String>,
    /// `wash-color`, resolved to `#rrggbb[aa]`; none for `none`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wash: Option<String>,
    /// `color` (inline attribute names).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// The record types that get a tooltip: shop items and hero abilities (the Tab column's slots).
fn wants_tip(d: &Value) -> bool {
    matches!(
        d["m_eAbilityType"].as_str(),
        Some("EAbilityType_Item" | "EAbilityType_Signature" | "EAbilityType_Ultimate")
    )
}

/// Every tooltip record of `abilities` (vdata as JSON, by record name), keyed by token.
pub fn tips(abilities: &Value, names: &BTreeMap<String, String>) -> BTreeMap<u32, Tip> {
    let mut out = BTreeMap::new();
    for (name, d) in abilities.as_object().into_iter().flatten() {
        if d.get("_not_pickable").is_some() || !wants_tip(d) {
            continue;
        }
        out.insert(crate::token(name), tip(name, d, names));
    }
    out
}

/// Every tooltip record's [`Values`]; `records` is `(name, definition)` (the install's vdata, or a
/// boon-data snapshot's `records[].definition`).
pub fn values<'a>(records: impl IntoIterator<Item = (&'a str, &'a Value)>) -> BTreeMap<u32, Values> {
    let mut out = BTreeMap::new();
    for (name, d) in records {
        if d.get("_not_pickable").is_some() || !wants_tip(d) {
            continue;
        }
        let props = d["m_mapAbilityProperties"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(k, p)| Some((k.clone(), number(&p["m_strValue"])?)))
            .collect();
        let upgrades = d["m_vecAbilityUpgrades"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|u| {
                u["m_vecPropertyUpgrades"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|b| Some((b["m_strPropertyName"].as_str()?.to_owned(), number(&b["m_strBonus"])?)))
                    .collect()
            })
            .collect();
        out.insert(crate::token(name), Values { props, upgrades });
    }
    out
}

/// A boon-data `abilities.json`'s records as `(name, definition)`.
pub fn boon_records(abilities: &Value) -> Vec<(&str, &Value)> {
    abilities["records"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| Some((r["ability_name"].as_str()?, &r["definition"])))
        .collect()
}

/// What `patch` changes from `base`, for the records and properties `tips` shows: each record's
/// differing property values (`props`) and upgrade bonuses (`upgrades`, by tier, only the
/// differing ones). A property the patch lacks reads `"0"` (hidden), a record it lacks isn't
/// listed (the install's stands in).
pub fn overlay(
    tips: &BTreeMap<u32, Tip>,
    base: &BTreeMap<u32, Values>,
    patch: &BTreeMap<u32, Values>,
) -> BTreeMap<u32, Values> {
    let mut out = BTreeMap::new();
    for (id, tip) in tips {
        let (Some(b), Some(p)) = (base.get(id), patch.get(id)) else {
            continue;
        };
        let shown = shown_props(tip);
        let mut diff = Values::default();
        for key in &shown {
            let old = b.props.get(key).map_or("0", String::as_str);
            let new = p.props.get(key).map_or("0", String::as_str);
            if old != new {
                diff.props.insert(key.clone(), new.to_owned());
            }
        }
        let tiers = b.upgrades.len().max(p.upgrades.len());
        let mut changed = false;
        for i in 0..tiers {
            let empty = BTreeMap::new();
            let (bt, pt) = (b.upgrades.get(i).unwrap_or(&empty), p.upgrades.get(i).unwrap_or(&empty));
            let mut tier = BTreeMap::new();
            for key in bt.keys().chain(pt.keys()).collect::<BTreeSet<_>>() {
                let new = pt.get(key).map_or("0", String::as_str);
                if bt.get(key).map_or("0", String::as_str) != new {
                    tier.insert(key.clone(), new.to_owned());
                }
            }
            changed |= !tier.is_empty();
            diff.upgrades.push(tier);
        }
        if !changed {
            diff.upgrades.clear();
        }
        if !diff.props.is_empty() || !diff.upgrades.is_empty() {
            out.insert(*id, diff);
        }
    }
    out
}

/// The property keys a tip shows or substitutes: its rows, cards, header and `{s:…}` tokens.
fn shown_props(tip: &Tip) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    let mut text = |t: &Option<String>| {
        if let Some(t) = t {
            keys.extend(substitutions(t));
        }
    };
    for s in &tip.sections {
        for b in &s.blocks {
            text(&b.text);
        }
    }
    for u in &tip.upgrades {
        text(&u.text);
    }
    let aliased: Vec<String> = keys.iter().filter_map(|k| tip.aliases.get(k).cloned()).collect();
    keys.extend(aliased);
    for p in tip.header.iter().chain(tip.sections.iter().flat_map(|s| s.cooldown.iter().chain(s.blocks.iter().flat_map(|b| b.important.iter().chain(&b.basic))))) {
        keys.insert(p.key.clone());
    }
    keys
}

/// The `{s:Prop}` names in a localised string (`{s:sign}` isn't one).
pub fn substitutions(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find("{s:") {
        rest = &rest[i + 3..];
        let Some(end) = rest.find('}') else { break };
        let key = &rest[..end];
        if key != "sign" && !key.is_empty() {
            out.push(key.to_owned());
        }
        rest = &rest[end + 1..];
    }
    out
}

fn tip(name: &str, d: &Value, names: &BTreeMap<String, String>) -> Tip {
    let props = &d["m_mapAbilityProperties"];
    let prop = |key: &str| property(key, &props[key], names);
    let loc = |key: &str| {
        let key = key.trim().trim_start_matches('#');
        (!key.is_empty()).then(|| names.get(&key.to_ascii_lowercase()).cloned()).flatten()
    };
    let item = d["m_eAbilityType"] == "EAbilityType_Item";
    let mut sections = Vec::new();
    let mut header = Vec::new();

    if item {
        for s in d["m_vecTooltipSectionInfo"].as_array().into_iter().flatten() {
            let kind = match s["m_eAbilitySectionType"].as_str() {
                Some("EArea_Innate") => "innate",
                Some("EArea_Passive") => "passive",
                Some("EArea_Active") => "active",
                _ => "info",
            };
            let mut cooldown = None;
            let mut blocks = Vec::new();
            for a in s["m_vecSectionAttributes"].as_array().into_iter().flatten() {
                let mut basic: Vec<Prop> = strings(&a["m_vecAbilityProperties"])
                    .chain(strings(&a["m_vecElevatedAbilityProperties"]))
                    .filter_map(&prop)
                    .collect();
                if kind != "innate"
                    && cooldown.is_none()
                    && let Some(i) = basic.iter().position(|p| matches!(p.key.as_str(), "AbilityCooldown" | "ProcCooldown"))
                {
                    cooldown = Some(basic.remove(i));
                }
                blocks.push(Block {
                    text: a["m_strLocString"].as_str().and_then(loc),
                    important: a["m_vecImportantAbilityProperties"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|i| prop(i["m_strImportantProperty"].as_str()?))
                        .collect(),
                    basic,
                    requires: None,
                });
            }
            sections.push(Section { kind, cooldown, blocks });
        }
    } else {
        let details = &d["m_AbilityTooltipDetails"];
        header.extend(prop("AbilityCooldown"));
        header.extend(strings(&details["m_vecAdditionalHeaderProperties"]).filter_map(&prop));
        for s in details["m_vecAbilityInfoSections"].as_array().into_iter().flatten() {
            let important = s["m_vecAbilityPropertiesBlock"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|b| b["m_vecAbilityProperties"].as_array().into_iter().flatten())
                .filter_map(|i| prop(i["m_strImportantProperty"].as_str()?))
                .collect();
            sections.push(Section {
                kind: "info",
                cooldown: None,
                blocks: vec![Block {
                    text: s["m_strLocString"].as_str().and_then(loc),
                    important,
                    basic: strings(&s["m_vecBasicProperties"]).filter_map(&prop).collect(),
                    requires: s["m_strAbilityPropertyUpgradeRequired"].as_str().filter(|r| !r.is_empty()).map(str::to_owned),
                }],
            });
        }
    }
    // A record with no section of its own: its plain description, as the shop shows it.
    if sections.iter().all(|s| s.blocks.iter().all(|b| b.text.is_none())) && let Some(text) = loc(&format!("{name}_desc")) {
        sections.push(Section { kind: "info", cooldown: None, blocks: vec![Block { text: Some(text), ..Block::default() }] });
    }

    let upgrades = d["m_vecAbilityUpgrades"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, u)| Upgrade {
            text: loc(&format!("{name}_t{}_desc", i + 1)),
            props: u["m_vecPropertyUpgrades"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|b| b["m_strPropertyName"].as_str().map(str::to_owned))
                .collect(),
            kinds: u["m_vecPropertyUpgrades"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|b| {
                    let kind = b["m_eUpgradeType"].as_str().filter(|k| *k != "EAddToBase")?;
                    Some((b["m_strPropertyName"].as_str()?.to_owned(), kind.to_owned()))
                })
                .collect(),
        })
        .collect();
    let aliases = props
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, p)| Some((p["m_strLocTokenOverride"].as_str().filter(|o| !o.is_empty() && o != k)?.to_owned(), k.clone())))
        .collect();
    let stack_label = d["m_sCustomStackLabel"].as_str().and_then(loc);
    Tip { header, sections, upgrades: if item { Vec::new() } else { upgrades }, aliases, stack_label }
}

/// `values` cut to what `tip` shows or substitutes (the rest of `m_mapAbilityProperties` is
/// internal tuning the tooltip never reads); upgrade bonuses stay whole.
pub fn trim(tip: &Tip, values: &Values) -> Values {
    let shown = shown_props(tip);
    Values {
        props: values.props.iter().filter(|(k, _)| shown.contains(*k)).map(|(k, v)| (k.clone(), v.clone())).collect(),
        upgrades: values.upgrades.clone(),
    }
}

fn strings(v: &Value) -> impl Iterator<Item = &str> {
    v.as_array().into_iter().flatten().filter_map(Value::as_str)
}

/// A property as shown, or `None` when the game wouldn't show it: absent, hidden, or without a
/// localised label.
fn property(key: &str, p: &Value, names: &BTreeMap<String, String>) -> Option<Prop> {
    if !p.is_object() || p["m_bIsHidden"] == true {
        return None;
    }
    let token = p["m_strLocTokenOverride"].as_str().filter(|s| !s.is_empty()).unwrap_or(key);
    let text = |suffix: &str| names.get(&format!("{token}_{suffix}").to_ascii_lowercase()).map(|s| s.trim().to_owned());
    let label = text("label").filter(|s| !s.is_empty())?;
    let scale = &p["m_subclassScaleFunction"];
    Some(Prop {
        key: key.to_owned(),
        label,
        prefix: text("prefix").unwrap_or_default(),
        postfix: text("postfix").unwrap_or_default(),
        css: p["m_strCSSClass"].as_str().unwrap_or("").to_owned(),
        scale: scale["m_flStatScale"]
            .as_f64()
            .filter(|f| *f != 0.0)
            .map(|f| (scale["m_eSpecificStatScaleType"].as_str().unwrap_or("").to_owned(), f)),
        conditional: p["m_eStatsUsageFlags"].as_str().is_some_and(|f| f.contains("ConditionallyApplied")),
        negative: p["m_bIsNegativeAttribute"] == true,
    })
}

/// A vdata value as the tooltip writes it: a number with at most two decimals and no trailing
/// zeros, from a number or a string that starts with one (`"40m"` → `"40"`); other strings as
/// they are; `None` for anything else.
pub fn number(v: &Value) -> Option<String> {
    let n = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => {
            let s = s.trim();
            let end = s
                .char_indices()
                .find(|&(i, c)| !(c.is_ascii_digit() || c == '.' || (i == 0 && (c == '-' || c == '+'))))
                .map_or(s.len(), |(i, _)| i);
            match s[..end].parse::<f64>() {
                Ok(n) => n,
                Err(_) if s.is_empty() => return None,
                Err(_) => return Some(s.to_owned()),
            }
        }
        _ => return None,
    };
    let s = format!("{:.2}", (n * 100.0).round() / 100.0);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    Some(if s == "-0" { "0".to_owned() } else { s.to_owned() })
}

/// The `@define name: value;` palette of a vcss text (`citadel_base_styles.vcss`).
pub fn defines(css: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for part in css.split("@define").skip(1) {
        let Some((name, rest)) = part.split_once(':') else { continue };
        let Some((value, _)) = rest.split_once(';') else { continue };
        out.insert(name.trim().to_owned(), value.trim().to_owned());
    }
    out
}

/// A Panorama colour (`#rgb[a]`, a palette name, `name&aa`), as `#rrggbb[aa]`; `None` for `none`
/// or what isn't a colour.
pub fn colour(raw: &str, palette: &BTreeMap<String, String>) -> Option<String> {
    let raw = raw.trim();
    let (name, alpha) = match raw.split_once('&') {
        Some((n, a)) if a.len() == 2 && a.bytes().all(|b| b.is_ascii_hexdigit()) => (n.trim(), Some(a)),
        _ => (raw, None),
    };
    let base = if name.starts_with('#') {
        name.to_owned()
    } else if name == "white" {
        "#FFFFFF".to_owned()
    } else if name == "black" {
        "#000000".to_owned()
    } else {
        // A define may name another define.
        let mut v = palette.get(name)?.clone();
        for _ in 0..4 {
            match palette.get(v.as_str()) {
                Some(next) => v = next.clone(),
                None => break,
            }
        }
        v
    };
    let hex = base.strip_prefix('#')?;
    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) || !matches!(hex.len(), 3 | 6 | 8) {
        return None;
    }
    let hex = if hex.len() == 3 { hex.chars().flat_map(|c| [c, c]).collect() } else { hex.to_owned() };
    Some(format!("#{}{}", hex.to_ascii_uppercase(), alpha.map(str::to_ascii_uppercase).unwrap_or_default()))
}

/// What a vcss text says for the selectors `pick` accepts: `pick(selector)` returns the name to
/// file the rule under (`healing` for `.prop_healing .ImportantStatImage`). Later rules override
/// earlier ones property by property, as CSS does.
pub fn icon_rules(css: &str, palette: &BTreeMap<String, String>, pick: impl Fn(&str) -> Option<String>) -> BTreeMap<String, IconRule> {
    let mut out: BTreeMap<String, IconRule> = BTreeMap::new();
    for rule in css.split('}') {
        let Some((selectors, body)) = rule.rsplit_once('{') else { continue };
        let names: Vec<String> = selectors.split(',').filter_map(|s| pick(s.trim())).collect();
        if names.is_empty() {
            continue;
        }
        for decl in body.split(';') {
            let Some((prop, value)) = decl.split_once(':') else { continue };
            let (prop, value) = (prop.trim(), value.trim());
            for name in &names {
                let r = out.entry(name.clone()).or_default();
                match prop {
                    "background-image" => {
                        if let Some(path) = value.strip_prefix("url(\"s2r://").and_then(|v| v.strip_suffix("\")")) {
                            r.image = Some(path.to_owned());
                        }
                    }
                    "wash-color" => r.wash = colour(value, palette),
                    "color" => r.color = colour(value, palette),
                    _ => {}
                }
            }
        }
    }
    out
}

/// `ability_property_icons.vcss`'s property icons: `.prop_<class>.AbilityPropertyIcon` and
/// `.prop_<class> .ImportantStatImage` (one rule names both).
pub fn prop_class(selector: &str) -> Option<String> {
    let rest = selector.strip_prefix(".prop_")?;
    let class = rest.split(['.', ' ', '#']).next()?;
    let tail = &rest[class.len()..];
    (!class.is_empty() && matches!(tail, ".AbilityPropertyIcon" | " .ImportantStatImage")).then(|| class.to_owned())
}

/// `citadel_base_styles.vcss`'s `.InlineAttributeIcon.<Name>` (the icon) and
/// `.InlineAttributeName.<Name>` (the word's colour), filed as `icon:<Name>` and `name:<Name>`.
pub fn inline_class(selector: &str) -> Option<String> {
    for (prefix, tag) in [(".InlineAttributeIcon.", "icon"), (".InlineAttributeName.", "name")] {
        if let Some(name) = selector.strip_prefix(prefix)
            && !name.is_empty()
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Some(format!("{tag}:{name}"));
        }
    }
    None
}

/// A vcss image path (`panorama/images/x_psd.vtex`, `….vsvg`) as its VPK entry (`…_c`), if it is
/// a texture or SVG under `panorama/images/`.
pub fn image_entry(path: &str) -> Option<String> {
    let path = path.strip_prefix("panorama/images/")?;
    if path.split('/').any(|p| p.is_empty() || p == "." || p == ".." || p.contains('\\')) {
        return None;
    }
    (path.ends_with(".vtex") || path.ends_with(".vsvg")).then(|| format!("panorama/images/{path}_c"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn names() -> BTreeMap<String, String> {
        [
            ("upgrade_test_desc", "Gain <span class=\"highlight\">Spirit Power</span>."),
            ("TechPower_label", "Spirit Power"),
            ("TechPower_prefix", "{s:sign}"),
            ("BonusSpirit_label", "Spirit Power"),
            ("AbilityCooldown_label", "Cooldown"),
            ("AbilityCooldown_postfix", "s"),
            ("AbilityDuration_label", "Duration"),
            ("AbilityDuration_postfix", "s"),
            ("TechResist_label", "Spirit Resist"),
            ("TechResist_postfix", "%"),
            ("ability_test_desc", "Deals {g:citadel_inline_attribute:'SpiritDamage'}."),
            ("ability_test_t1_desc", "+{s:MaxStacks} Max Marks"),
            ("DMarkMaxMarks_label", "Max Marks"),
            ("ProcDamageBase_label", "Base Damage"),
            ("CurrentStacks_label", "Current Stacks:"),
            ("nurse_leech_pickups_stacklabel", "Leeches Collected:"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.to_owned()))
        .collect()
    }

    fn item() -> Value {
        json!({
            "m_eAbilityType": "EAbilityType_Item",
            "m_mapAbilityProperties": {
                "TechPower": {"m_strValue": "8", "m_strCSSClass": "tech_damage"},
                "TechResist": {"m_strValue": "10", "m_strCSSClass": "tech_armor_up"},
                "BonusSpirit": {"m_strValue": "30", "m_eStatsUsageFlags": "ConditionallyApplied"},
                "AbilityCooldown": {"m_strValue": 30.0, "m_strCSSClass": "cooldown"},
                "AbilityDuration": {"m_strValue": "7", "m_strCSSClass": "duration"},
                "Unlabelled": {"m_strValue": "3"},
                "Hidden": {"m_strValue": "3", "m_bIsHidden": true}
            },
            "m_vecTooltipSectionInfo": [
                {"m_eAbilitySectionType": "EArea_Innate", "m_vecSectionAttributes": [{"m_vecAbilityProperties": ["TechResist", "TechPower", "Unlabelled", "Hidden"]}]},
                {"m_eAbilitySectionType": "EArea_Active", "m_vecSectionAttributes": [{"m_strLocString": "#upgrade_test_desc", "m_vecAbilityProperties": ["AbilityCooldown", "AbilityDuration"], "m_vecImportantAbilityProperties": [{"m_strImportantProperty": "BonusSpirit"}]}]}
            ]
        })
    }

    fn ability() -> Value {
        json!({
            "m_eAbilityType": "EAbilityType_Signature",
            "m_mapAbilityProperties": {
                "AbilityCooldown": {"m_strValue": 2.75, "m_strCSSClass": "cooldown"},
                "MaxStacks": {"m_strValue": "4", "m_strLocTokenOverride": "DMarkMaxMarks"},
                "ProcDamageBase": {"m_strValue": 11, "m_strCSSClass": "tech_damage", "m_subclassScaleFunction": {"_class": "scale_function_tech_damage", "m_eSpecificStatScaleType": "ETechPower", "m_flStatScale": 0.35}}
            },
            "m_AbilityTooltipDetails": {"m_vecAbilityInfoSections": [
                {"m_strLocString": "#ability_test_desc", "m_vecAbilityPropertiesBlock": [{"m_vecAbilityProperties": [{"m_strImportantProperty": "ProcDamageBase"}, {"m_strImportantProperty": "MaxStacks"}]}], "m_vecBasicProperties": []},
                {"m_strLocString": "#ability_test_desc", "m_strAbilityPropertyUpgradeRequired": "MaxStacks"}
            ]},
            "m_vecAbilityUpgrades": [
                {"m_vecPropertyUpgrades": [{"m_strPropertyName": "MaxStacks", "m_strBonus": "1"}]},
                {"m_vecPropertyUpgrades": [{"m_strPropertyName": "AbilityCooldown", "m_strBonus": "-0.75"}, {"m_strPropertyName": "ProcDamageBase", "m_strBonus": "0.2", "m_eUpgradeType": "EAddToScale"}, {"m_strPropertyName": "MaxStacks", "m_strBonus": "1", "m_eUpgradeType": "EAddToBase"}]}
            ]
        })
    }

    #[test]
    fn an_items_sections_follow_its_tooltip_section_info() {
        let t = tip("upgrade_test", &item(), &names());
        assert!(t.header.is_empty() && t.upgrades.is_empty());
        let [innate, active] = &t.sections[..] else { panic!("{:?}", t.sections) };
        assert_eq!(innate.kind, "innate");
        // Unlabelled and hidden properties aren't shown; the order is the game's.
        let keys: Vec<&str> = innate.blocks[0].basic.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, ["TechResist", "TechPower"]);
        assert_eq!(innate.blocks[0].basic[0].postfix, "%");
        assert_eq!(innate.blocks[0].basic[1].prefix, "{s:sign}");
        assert_eq!(innate.blocks[0].basic[1].css, "tech_damage");
        assert_eq!(active.kind, "active");
        // The section's cooldown row goes to its header.
        assert_eq!(active.cooldown.as_ref().map(|p| p.key.as_str()), Some("AbilityCooldown"));
        assert_eq!(active.blocks[0].basic.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(), ["AbilityDuration"]);
        assert_eq!(active.blocks[0].text.as_deref(), Some("Gain <span class=\"highlight\">Spirit Power</span>."));
        assert!(active.blocks[0].important[0].conditional);
    }

    #[test]
    fn an_ability_has_its_header_sections_and_upgrade_tiers() {
        let t = tip("ability_test", &ability(), &names());
        assert_eq!(t.header.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(), ["AbilityCooldown"]);
        let important = &t.sections[0].blocks[0].important;
        assert_eq!(important[0].scale, Some(("ETechPower".to_owned(), 0.35)));
        // m_strLocTokenOverride names the label.
        assert_eq!(important[1].label, "Max Marks");
        assert_eq!(t.sections[1].blocks[0].requires.as_deref(), Some("MaxStacks"));
        assert_eq!(t.upgrades.len(), 2);
        assert_eq!(t.upgrades[0].text.as_deref(), Some("+{s:MaxStacks} Max Marks"));
        assert_eq!(t.upgrades[1].props, ["AbilityCooldown", "ProcDamageBase", "MaxStacks"]);
        // Only a bonus that isn't added to the base carries its kind.
        assert_eq!(t.upgrades[1].kinds, BTreeMap::from([("ProcDamageBase".to_owned(), "EAddToScale".to_owned())]));
        assert_eq!(t.upgrades[1].text, None);
        assert_eq!(t.aliases, BTreeMap::from([("DMarkMaxMarks".to_owned(), "MaxStacks".to_owned())]));
        // Trimmed values keep what the tip shows, the aliased property included.
        let mut d = ability();
        d["m_mapAbilityProperties"]["Internal"] = json!({"m_strValue": "9"});
        let v = trim(&t, &values([("ability_test", &d)])[&crate::token("ability_test")]);
        assert_eq!(v.props.keys().map(String::as_str).collect::<Vec<_>>(), ["AbilityCooldown", "MaxStacks", "ProcDamageBase"]);
        assert_eq!(v.upgrades.len(), 2);
    }

    #[test]
    fn a_tip_carries_the_words_for_the_stacks_held_on_it() {
        let mut a = ability();
        a["m_sCustomStackLabel"] = json!("#nurse_leech_pickups_stacklabel");
        assert_eq!(tip("ability_test", &a, &names()).stack_label.as_deref(), Some("Leeches Collected:"));
        let mut i = item();
        i["m_sCustomStackLabel"] = json!("#CurrentStacks_label");
        assert_eq!(tip("upgrade_test", &i, &names()).stack_label.as_deref(), Some("Current Stacks:"));
        // None set, or a key with no words: no label.
        assert_eq!(tip("ability_test", &ability(), &names()).stack_label, None);
        a["m_sCustomStackLabel"] = json!("#no_such_label");
        assert_eq!(tip("ability_test", &a, &names()).stack_label, None);
    }

    #[test]
    fn values_are_written_as_the_game_writes_them() {
        assert_eq!(number(&json!(2.75)).as_deref(), Some("2.75"));
        assert_eq!(number(&json!(30.0)).as_deref(), Some("30"));
        assert_eq!(number(&json!("40m")).as_deref(), Some("40"));
        assert_eq!(number(&json!("-0.75")).as_deref(), Some("-0.75"));
        assert_eq!(number(&json!("0.333333")).as_deref(), Some("0.33"));
        assert_eq!(number(&json!("-0")).as_deref(), Some("0"));
        assert_eq!(number(&json!("abc")).as_deref(), Some("abc"));
        assert_eq!(number(&json!(null)), None);
        let v = values([("ability_test", &ability())]);
        let v = &v[&crate::token("ability_test")];
        assert_eq!(v.props["ProcDamageBase"], "11");
        assert_eq!(v.upgrades[1]["AbilityCooldown"], "-0.75");
    }

    #[test]
    fn an_overlay_holds_only_what_a_patch_changed_that_the_tip_shows() {
        let id = crate::token("ability_test");
        let tips = BTreeMap::from([(id, tip("ability_test", &ability(), &names()))]);
        let base = values([("ability_test", &ability())]);
        let mut older = ability();
        older["m_mapAbilityProperties"]["ProcDamageBase"]["m_strValue"] = json!(9);
        older["m_mapAbilityProperties"]["NotShown"] = json!({"m_strValue": "5"});
        older["m_vecAbilityUpgrades"][0]["m_vecPropertyUpgrades"][0]["m_strBonus"] = json!("2");
        let patch = values([("ability_test", &older)]);
        let o = overlay(&tips, &base, &patch);
        assert_eq!(o[&id].props, BTreeMap::from([("ProcDamageBase".to_owned(), "9".to_owned())]));
        assert_eq!(o[&id].upgrades.len(), 2);
        assert_eq!(o[&id].upgrades[0]["MaxStacks"], "2");
        assert!(o[&id].upgrades[1].is_empty());
        // The same data overlays nothing.
        assert!(overlay(&tips, &base, &base).is_empty());
    }

    #[test]
    fn a_record_with_no_sections_shows_its_description() {
        let d = json!({"m_eAbilityType": "EAbilityType_Ultimate", "m_mapAbilityProperties": {}});
        let t = tip("ability_test", &d, &names());
        assert_eq!(t.sections.len(), 1);
        assert_eq!(t.sections[0].blocks[0].text.as_deref(), Some("Deals {g:citadel_inline_attribute:'SpiritDamage'}."));
        // Weapons, melee and innates get no tip.
        assert!(tips(&json!({"w": {"m_eAbilityType": "EAbilityType_Weapon"}, "a": d}), &names()).contains_key(&crate::token("a")));
        assert_eq!(tips(&json!({"w": {"m_eAbilityType": "EAbilityType_Weapon"}}), &names()).len(), 0);
    }

    #[test]
    fn substitutions_name_properties_not_the_sign() {
        assert_eq!(substitutions("<span>{s:A}%</span> and {s:sign}{s:B_c}s {s:"), ["A", "B_c"]);
    }

    #[test]
    fn icon_rules_follow_the_cascade_and_resolve_the_palette() {
        let palette = defines("@define armorColor: #00FF99;\n@define alias: armorColor;");
        let css = ".x{color: red;}.prop_healing.AbilityPropertyIcon,.prop_healing .ImportantStatImage{background-image: url(\"s2r://panorama/images/icons/properties/heal.vsvg\");wash-color: armorColor;opacity: 1;}\
            .prop_health .ImportantStatImage{background-image: url(\"s2r://panorama/images/a_psd.vtex\");wash-color: none;}\
            .prop_health.AbilityPropertyIcon{wash-color: alias&80;}\
            .InlineAttributeIcon.SpiritDamage,.InlineAttributeIcon.Spirit{background-image: url(\"s2r://panorama/images/b.vsvg\");}\
            .InlineAttributeName.Spirit{color: #e1a0ff;}";
        let props = icon_rules(css, &palette, prop_class);
        assert_eq!(props.len(), 2);
        assert_eq!(props["healing"].image.as_deref(), Some("panorama/images/icons/properties/heal.vsvg"));
        assert_eq!(props["healing"].wash.as_deref(), Some("#00FF99"));
        assert_eq!(props["health"].image.as_deref(), Some("panorama/images/a_psd.vtex"));
        assert_eq!(props["health"].wash.as_deref(), Some("#00FF9980"), "the later rule wins");
        let inline = icon_rules(css, &palette, inline_class);
        assert_eq!(inline["icon:SpiritDamage"].image.as_deref(), Some("panorama/images/b.vsvg"));
        assert_eq!(inline["name:Spirit"].color.as_deref(), Some("#E1A0FF"));
        assert_eq!(colour("none", &palette), None);
        assert_eq!(colour("#abc", &palette).as_deref(), Some("#AABBCC"));
        assert_eq!(prop_class(".prop_health #StatImage"), None);
        assert_eq!(prop_class(".prop_x"), None);
    }

    #[test]
    fn image_paths_become_vpk_entries_under_panorama_images_only() {
        assert_eq!(image_entry("panorama/images/icons/properties/heal.vsvg").as_deref(), Some("panorama/images/icons/properties/heal.vsvg_c"));
        assert_eq!(image_entry("panorama/images/upgrades/property_cast_psd.vtex").as_deref(), Some("panorama/images/upgrades/property_cast_psd.vtex_c"));
        assert_eq!(image_entry("panorama/images/../scripts/x.vtex"), None);
        assert_eq!(image_entry("panorama/layout/x.vtex"), None);
        assert_eq!(image_entry("panorama/images/x.png"), None);
    }
}
