//! Hero records from `scripts/heroes.vdata_c` and the English hero-name localisation.

use std::collections::BTreeMap;

use crate::kv3::Value;
use crate::{Error, Result};

/// One hero record as written to `pack.json`.
#[derive(Clone, Debug)]
pub struct Hero {
    pub hero_id: u64,
    pub class_name: String,
    pub name: Option<String>,
    pub dev_state: Option<String>,
    pub disabled: bool,
    pub minimap_entry: Option<String>,
    pub minimap_blob: Option<String>,
    pub topbar_entry: Option<String>,
    pub topbar_blob: Option<String>,
    /// `m_strIconHeroCard`: the hero card the top bar's hero badge shows.
    pub card_entry: Option<String>,
    pub card_blob: Option<String>,
    /// `m_strIconHeroCardCritical`: the hero card the HUD shows at low health.
    pub critical_entry: Option<String>,
    pub critical_blob: Option<String>,
}

impl Hero {
    /// A hero is "listed, playable" when it is released, enabled and has a minimap portrait.
    pub fn is_playable(&self) -> bool {
        !self.disabled
            && self.minimap_entry.is_some()
            && matches!(
                self.dev_state.as_deref(),
                Some("EHeroDevState_Release") | Some("player_selectable")
            )
    }
}

/// Parse the hero records. `names` is the flattened English localisation map.
pub fn parse(root: &Value, names: &BTreeMap<String, String>) -> Result<Vec<Hero>> {
    let entries = root.as_object().ok_or(Error::MalformedKv3)?;
    let mut heroes = Vec::new();

    for (class_name, value) in entries {
        if class_name == "hero_base" {
            continue;
        }
        let Some(record) = value.as_object() else {
            continue;
        };
        let Some(hero_id) = record_field(record, "m_HeroID").and_then(Value::as_u64) else {
            continue;
        };

        let dev_state = record_field(record, "m_eHeroDevelopmentState")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                record_field(record, "m_bPlayerSelectable")
                    .and_then(Value::as_bool)
                    .map(|selectable| {
                        if selectable {
                            "player_selectable".to_owned()
                        } else {
                            "not_player_selectable".to_owned()
                        }
                    })
            });

        let disabled = record_field(record, "m_bDisabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let minimap_entry = record_field(record, "m_strMinimapImage")
            .and_then(Value::as_str)
            .and_then(portrait_entry);

        let topbar_entry = record_field(record, "m_strTopBarVertical")
            .and_then(Value::as_str)
            .and_then(portrait_entry);

        let card_entry = record_field(record, "m_strIconHeroCard")
            .and_then(Value::as_str)
            .and_then(portrait_entry);

        let critical_entry = record_field(record, "m_strIconHeroCardCritical")
            .and_then(Value::as_str)
            .and_then(portrait_entry);

        let name = names.get(&format!("{class_name}:n")).cloned();

        heroes.push(Hero {
            hero_id,
            class_name: class_name.clone(),
            name,
            dev_state,
            disabled,
            minimap_entry,
            minimap_blob: None,
            topbar_entry,
            topbar_blob: None,
            card_entry,
            card_blob: None,
            critical_entry,
            critical_blob: None,
        });
    }

    heroes.sort_by_key(|hero| hero.hero_id);
    Ok(heroes)
}

fn record_field<'a>(record: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    record
        .iter()
        .find(|(entry_key, _)| entry_key == key)
        .map(|(_, value)| value)
}

/// Turn a `m_strMinimapImage` / `m_strTopBarVertical` value such as
/// `file://{images}/heroes/inferno_mm.psd` into the VPK entry
/// `panorama/images/heroes/inferno_mm_psd.vtex_c`.
fn portrait_entry(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_matches('"');
    let raw = raw.strip_prefix("panorama:").unwrap_or(raw);
    let relative = raw
        .strip_prefix("file://{images}/")
        .or_else(|| raw.strip_prefix("file://{images}"))
        .or_else(|| raw.split_once("{images}/").map(|(_, rest)| rest))?;

    let path = format!("panorama/images/{relative}");
    if let Some(stem) = path.strip_suffix(".psd") {
        Some(format!("{stem}_psd.vtex_c"))
    } else if let Some(stem) = path.strip_suffix(".vtex") {
        Some(format!("{stem}.vtex_c"))
    } else {
        Some(format!("{path}.vtex_c"))
    }
}

#[cfg(test)]
mod tests {
    use super::portrait_entry;

    #[test]
    fn portrait_paths_become_vpk_entries() {
        assert_eq!(
            portrait_entry("file://{images}/heroes/inferno_mm.psd").as_deref(),
            Some("panorama/images/heroes/inferno_mm_psd.vtex_c")
        );
        assert_eq!(
            portrait_entry("panorama:\"file://{images}/heroes/hornet_mm.psd\"").as_deref(),
            Some("panorama/images/heroes/hornet_mm_psd.vtex_c")
        );
        assert_eq!(
            portrait_entry("panorama:\"file://{images}/heroes/inferno_vertical.psd\"").as_deref(),
            Some("panorama/images/heroes/inferno_vertical_psd.vtex_c")
        );
    }
}
