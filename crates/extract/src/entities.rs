//! Map entities from `maps/dl_midtown/entities/default_ents.vents_c`.
//!
//! Lanes come from the entity's own `lanenum`/`lane_number` when it has one. Entities without a
//! lane field (camps, rifts, sentries, the mid boss) are assigned the nearest zipline path. An
//! entity's ordinal is its distance along that lane's zipline polyline, so `walker:amber:lane1:1`
//! is the first walker from the start of amber's lane-1 zipline.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::kv3::Value;
use crate::{Error, Result};

/// One entity record written to `pack.json`.
#[derive(Clone, Debug)]
pub struct Entity {
    pub key: String,
    pub kind: String,
    pub team: String,
    pub lane: String,
    pub world: [f64; 3],
    pub src: EntitySource,
    pub nodes: Option<Vec<[f64; 3]>>,
}

#[derive(Clone, Debug)]
pub struct EntitySource {
    pub classname: String,
    pub hammeruniqueid: String,
    pub targetname: String,
}

/// Result of extracting the entity lump.
#[derive(Debug)]
pub struct Extraction {
    pub entities: Vec<Entity>,
    pub geometry_hash: String,
}

/// Extract the objective, camp, rift, sentry, spawn and zipline records.
pub fn extract(root: &Value) -> Result<Extraction> {
    let key_values = root
        .get("m_entityKeyValues")
        .and_then(Value::as_array)
        .ok_or(Error::MalformedKv3)?;
    let mut raw = Vec::new();
    for value in key_values {
        let entity_value = value
            .get("keyValues3Data")
            .and_then(|kv| kv.get("values"))
            .unwrap_or(value);
        if let Some(entity) = parse_raw(entity_value)? {
            raw.push(entity);
        }
    }

    // Zipline path nodes are separate entities, joined by `path_uniqueid` and ordered by
    // `path_index`.
    let mut node_map: BTreeMap<String, Vec<(u32, [f64; 3])>> = BTreeMap::new();
    for entity in &raw {
        if entity.classname != "citadel_zipline_path_node" {
            continue;
        }
        let (Some(path_id), Some(index)) = (entity.path_uniqueid.clone(), entity.path_index) else {
            continue;
        };
        node_map
            .entry(path_id)
            .or_default()
            .push((index, entity.origin));
    }
    for nodes in node_map.values_mut() {
        nodes.sort_by_key(|(index, _)| *index);
    }

    let mut ziplines = Vec::new();
    for entity in &raw {
        if entity.classname != "citadel_zipline_path" {
            continue;
        }
        let lane = entity.lane.unwrap_or(0);
        let nodes = node_map
            .get(&entity.hammeruniqueid)
            .map(|nodes| nodes.iter().map(|(_, origin)| *origin).collect())
            .unwrap_or_default();
        ziplines.push(Zipline {
            lane,
            origin: entity.origin,
            src: entity.source(),
            nodes,
        });
    }
    ziplines.sort_by(|left, right| left.src.hammeruniqueid.cmp(&right.src.hammeruniqueid));

    let mut lane_polylines: BTreeMap<u32, Vec<[f64; 3]>> = BTreeMap::new();
    for zipline in &ziplines {
        if zipline.nodes.is_empty() {
            continue;
        }
        lane_polylines
            .entry(zipline.lane)
            .or_default()
            .extend_from_slice(&zipline.nodes);
    }

    let mut candidates = Vec::new();

    for entity in &raw {
        let Some(kind) = entity_kind(entity) else {
            continue;
        };

        let (lane, arc) = match entity.lane {
            Some(lane) => {
                let arc = lane_polylines
                    .get(&lane)
                    .map(|polyline| project(polyline, entity.origin).1)
                    .unwrap_or(0.0);
                (lane, arc)
            }
            None => nearest_lane(&lane_polylines, entity.origin),
        };

        candidates.push(Candidate {
            kind,
            team: team_name(entity.team),
            lane,
            arc,
            world: entity.origin,
            src: entity.source(),
            nodes: None,
        });
    }

    for zipline in &ziplines {
        let arc = lane_polylines
            .get(&zipline.lane)
            .map(|polyline| project(polyline, zipline.origin).1)
            .unwrap_or(0.0);
        candidates.push(Candidate {
            kind: "zipline",
            team: "neutral",
            lane: zipline.lane,
            arc,
            world: zipline.origin,
            src: zipline.src.clone(),
            nodes: Some(zipline.nodes.clone()),
        });
    }

    candidates.sort_by(|left, right| {
        left.kind
            .cmp(right.kind)
            .then(left.team.cmp(right.team))
            .then(left.lane.cmp(&right.lane))
            .then(
                left.arc
                    .partial_cmp(&right.arc)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then(left.src.hammeruniqueid.cmp(&right.src.hammeruniqueid))
    });

    let mut ordinals: BTreeMap<(String, String, u32), u32> = BTreeMap::new();
    let mut entities = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let group = (
            candidate.kind.to_owned(),
            candidate.team.to_owned(),
            candidate.lane,
        );
        let ordinal = ordinals.entry(group).or_insert(0);
        *ordinal += 1;
        entities.push(Entity {
            key: format!(
                "{}:{}:lane{}:{}",
                candidate.kind, candidate.team, candidate.lane, *ordinal
            ),
            kind: candidate.kind.to_owned(),
            team: candidate.team.to_owned(),
            lane: format!("lane{}", candidate.lane),
            world: candidate.world,
            src: candidate.src,
            nodes: candidate.nodes,
        });
    }

    entities.sort_by(|left, right| left.key.cmp(&right.key));
    let geometry_hash = geometry_hash(&entities);

    Ok(Extraction {
        entities,
        geometry_hash,
    })
}

/// SHA-256 over the sorted `(key, kind, team, world rounded to one unit)` rows.
pub fn geometry_hash(entities: &[Entity]) -> String {
    let mut rows = entities
        .iter()
        .map(|entity| {
            format!(
                "{}\t{}\t{}\t{},{},{}",
                entity.key,
                entity.kind,
                entity.team,
                round(entity.world[0]),
                round(entity.world[1]),
                round(entity.world[2])
            )
        })
        .collect::<Vec<_>>();
    rows.sort();

    let mut hasher = Sha256::new();
    for row in rows {
        hasher.update(row.as_bytes());
        hasher.update(b"\n");
    }
    hex(&hasher.finalize())
}

fn round(value: f64) -> i64 {
    if value.is_finite() {
        value.round() as i64
    } else {
        0
    }
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

struct RawEntity {
    classname: String,
    origin: [f64; 3],
    team: Option<u32>,
    lane: Option<u32>,
    hammeruniqueid: String,
    targetname: String,
    model: Option<String>,
    neutralsubclass: Option<String>,
    path_uniqueid: Option<String>,
    path_index: Option<u32>,
}

impl RawEntity {
    fn source(&self) -> EntitySource {
        EntitySource {
            classname: self.classname.clone(),
            hammeruniqueid: self.hammeruniqueid.clone(),
            targetname: self.targetname.clone(),
        }
    }
}

struct Zipline {
    lane: u32,
    origin: [f64; 3],
    src: EntitySource,
    nodes: Vec<[f64; 3]>,
}

struct Candidate {
    kind: &'static str,
    team: &'static str,
    lane: u32,
    arc: f64,
    world: [f64; 3],
    src: EntitySource,
    nodes: Option<Vec<[f64; 3]>>,
}

fn parse_raw(value: &Value) -> Result<Option<RawEntity>> {
    let Some(record) = value.as_object() else {
        return Ok(None);
    };
    let Some(classname) = field_str(record, "classname") else {
        return Ok(None);
    };
    let Some(origin) = field_vec3(record, "origin") else {
        return Ok(None);
    };

    Ok(Some(RawEntity {
        classname: classname.to_owned(),
        origin,
        team: field_u32(record, "teamnumber"),
        lane: field_u32(record, "lanenum").or_else(|| field_u32(record, "lane_number")),
        hammeruniqueid: field_str(record, "hammeruniqueid")
            .unwrap_or_default()
            .to_owned(),
        targetname: field_str(record, "targetname").unwrap_or_default().to_owned(),
        model: field_str(record, "model").map(str::to_owned),
        neutralsubclass: field_str(record, "neutralsubclass").map(str::to_owned),
        path_uniqueid: field_str(record, "path_uniqueid").map(str::to_owned),
        path_index: field_u32(record, "path_index"),
    }))
}

fn entity_kind(entity: &RawEntity) -> Option<&'static str> {
    match entity.classname.as_str() {
        "npc_boss_tier3" => Some("patron"),
        "npc_boss_tier2" => Some("walker"),
        "info_super_trooper_spawn" if entity.origin[1].abs() < 5000.0 => Some("guardian"),
        "npc_barrack_boss" => Some("base_guardian"),
        "destroyable_building"
            if entity
                .model
                .as_deref()
                .is_some_and(|model| model.contains("shrine_")) =>
        {
            Some("shrine")
        }
        "info_neutral_trooper_spawn"
            if entity.neutralsubclass.as_deref() == Some("npc_super_neutral") =>
        {
            Some("mid_boss")
        }
        "info_neutral_trooper_camp" => Some("camp"),
        "info_koth_spawn_location" => Some("rift"),
        "citadel_item_powerup_spawner" => Some("powerup"),
        // The Soul Urn's two delivery points; the urn spawns over one and goes to the other.
        "citadel_trigger_idol_return" => Some("urn"),
        "npc_base_defense_sentry" => Some("sentry"),
        "info_team_spawn" => Some("team_spawn"),
        _ => None,
    }
}

fn team_name(team: Option<u32>) -> &'static str {
    match team {
        Some(2) => "amber",
        Some(3) => "sapphire",
        _ => "neutral",
    }
}

fn nearest_lane(lanes: &BTreeMap<u32, Vec<[f64; 3]>>, point: [f64; 3]) -> (u32, f64) {
    let mut best = (0u32, f64::INFINITY, 0.0);
    for (lane, polyline) in lanes {
        if polyline.is_empty() {
            continue;
        }
        let (distance, arc) = project(polyline, point);
        if distance < best.1 {
            best = (*lane, distance, arc);
        }
    }
    (best.0, best.2)
}

/// Nearest point on a polyline in the XY plane, returned as `(distance², arc length)`.
fn project(polyline: &[[f64; 3]], point: [f64; 3]) -> (f64, f64) {
    if polyline.is_empty() {
        return (f64::INFINITY, 0.0);
    }
    if polyline.len() == 1 {
        let dx = point[0] - polyline[0][0];
        let dy = point[1] - polyline[0][1];
        return (dx * dx + dy * dy, 0.0);
    }

    let mut best_distance = f64::INFINITY;
    let mut best_arc = 0.0;
    let mut arc = 0.0;

    for pair in polyline.windows(2) {
        let start = pair[0];
        let end = pair[1];
        let dx = end[0] - start[0];
        let dy = end[1] - start[1];
        let length_squared = dx * dx + dy * dy;

        let t = if length_squared > 0.0 {
            (((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_squared)
                .clamp(0.0, 1.0)
        } else {
            0.0
        };

        let nearest_x = start[0] + t * dx;
        let nearest_y = start[1] + t * dy;
        let distance =
            (point[0] - nearest_x) * (point[0] - nearest_x)
                + (point[1] - nearest_y) * (point[1] - nearest_y);

        if distance < best_distance {
            best_distance = distance;
            best_arc = arc + t * length_squared.sqrt();
        }

        arc += length_squared.sqrt();
    }

    (best_distance, best_arc)
}

fn field<'a>(record: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    record
        .iter()
        .find(|(entry_key, _)| entry_key.eq_ignore_ascii_case(key))
        .map(|(_, value)| value)
}

fn field_str<'a>(record: &'a [(String, Value)], key: &str) -> Option<&'a str> {
    field(record, key).and_then(Value::as_str)
}

fn field_u32(record: &[(String, Value)], key: &str) -> Option<u32> {
    let value = field(record, key)?;
    if let Some(number) = value.as_u64() {
        return u32::try_from(number).ok();
    }
    value.as_str()?.trim().parse().ok()
}

fn field_vec3(record: &[(String, Value)], key: &str) -> Option<[f64; 3]> {
    let values = field(record, key)?.as_array()?;
    if values.len() < 3 {
        return None;
    }
    Some([
        values[0].as_f64()?,
        values[1].as_f64()?,
        values[2].as_f64()?,
    ])
}
