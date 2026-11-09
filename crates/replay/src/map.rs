//! The current map, as the web client draws it without a pack: objective sites by key (world
//! units) and the three lane curves (map units). Demo positions on the current map land exactly
//! on these sites (exploration §8), so an entity's key is the nearest site of its kind.
//!
//! The lane functions are line-for-line ports of `web/src/map/lanes.ts` (`samplePath`,
//! `laneLine`, `project`), so a `Wave.t` from here is the one the board would compute.

use crate::map_data::CURRENT_MAP;
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Raw {
    entities: Vec<Site>,
    lanes: Vec<RawLane>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Site {
    pub key: String,
    pub kind: String,
    pub team: String,
    pub lane: String,
    pub world: Vec<f64>,
    /// Camps: the game's tier (`weak`, `medium`, `strong`, `vaults`: the Sinner's Sacrifice).
    #[serde(default)]
    pub tier: Option<String>,
}

#[derive(Deserialize)]
struct RawLane {
    lane: String,
    d: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

pub struct Lane {
    /// The board's key: `lane1`, `lane4`, `lane6`.
    pub key: &'static str,
    /// Map units, Amber end first.
    pub points: Vec<Pt>,
    pub cum: Vec<f64>,
}

pub struct Map {
    pub sites: Vec<Site>,
    pub lanes: Vec<Lane>,
}

pub const T_MAX: f64 = 1000.0;
/// deadlock-api's radius (web/src/map/transform.ts `DEFAULT_TRANSFORM`).
const R: f64 = 10752.0;

pub fn world_to_map(x: f64, y: f64) -> Pt {
    Pt { x: (x + R) / (2.0 * R) * 1000.0, y: (R - y) / (2.0 * R) * 1000.0 }
}

pub fn current() -> &'static Map {
    static M: OnceLock<Map> = OnceLock::new();
    M.get_or_init(|| {
        let raw: Raw = serde_json::from_str(CURRENT_MAP).expect("built-in map data is valid JSON");
        let lanes = raw
            .lanes
            .iter()
            .filter_map(|l| {
                let key = match l.lane.as_str() {
                    "yellow" => "lane1",
                    "blue" => "lane4",
                    "purple" => "lane6",
                    _ => return None,
                };
                let (points, cum) = lane_line(sample_path(&l.d, 4.0));
                Some(Lane { key, points, cum })
            })
            .collect();
        Map { sites: raw.entities, lanes }
    })
}

impl Map {
    /// The nearest site of `kind` to world `(x, y)` within `max` world units.
    pub fn nearest(&self, kind: &str, x: f64, y: f64, max: f64) -> Option<&Site> {
        self.sites
            .iter()
            .filter(|s| s.kind == kind && s.world.len() >= 2)
            .map(|s| (s, (s.world[0] - x).hypot(s.world[1] - y)))
            .filter(|(_, d)| *d <= max)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(s, _)| s)
    }

    pub fn keys_of(&self, kind: &str) -> Vec<&str> {
        self.sites.iter().filter(|s| s.kind == kind).map(|s| s.key.as_str()).collect()
    }
}

/// `samplePath`: points along SVG path data of absolute M, L and C commands, every ~`step`.
pub fn sample_path(d: &str, step: f64) -> Vec<Pt> {
    let mut out: Vec<Pt> = Vec::new();
    let mut cur = Pt { x: 0.0, y: 0.0 };
    let mut cmds: Vec<(char, String)> = Vec::new();
    for ch in d.chars() {
        if matches!(ch, 'M' | 'L' | 'C') {
            cmds.push((ch, String::new()));
        } else if let Some(last) = cmds.last_mut() {
            last.1.push(ch);
        }
    }
    for (cmd, args) in cmds {
        let n: Vec<f64> = args.split(|c: char| c.is_whitespace() || c == ',').filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect();
        if cmd == 'M' || cmd == 'L' {
            let mut i = 0;
            while i + 1 < n.len() {
                let p = Pt { x: n[i], y: n[i + 1] };
                if cmd == 'L' && !out.is_empty() {
                    let k = ((p.x - cur.x).hypot(p.y - cur.y) / step).ceil().max(1.0) as usize;
                    for j in 1..=k {
                        let u = j as f64 / k as f64;
                        out.push(Pt { x: cur.x + (p.x - cur.x) * u, y: cur.y + (p.y - cur.y) * u });
                    }
                } else {
                    out.push(p);
                }
                cur = p;
                i += 2;
            }
        } else {
            let mut i = 0;
            while i + 5 < n.len() {
                let (c1, c2, p) = (Pt { x: n[i], y: n[i + 1] }, Pt { x: n[i + 2], y: n[i + 3] }, Pt { x: n[i + 4], y: n[i + 5] });
                let len = (c1.x - cur.x).hypot(c1.y - cur.y) + (c2.x - c1.x).hypot(c2.y - c1.y) + (p.x - c2.x).hypot(p.y - c2.y);
                let k = (len / step).ceil().max(1.0) as usize;
                for j in 1..=k {
                    let u = j as f64 / k as f64;
                    let (a, b, c, e) = ((1.0 - u).powi(3), 3.0 * (1.0 - u).powi(2) * u, 3.0 * (1.0 - u) * u * u, u.powi(3));
                    out.push(Pt { x: a * cur.x + b * c1.x + c * c2.x + e * p.x, y: a * cur.y + b * c1.y + c * c2.y + e * p.y });
                }
                cur = p;
                i += 6;
            }
        }
    }
    out
}

/// `laneLine`: measure a lane, turned to run from its Amber end (the bottom, larger y).
pub fn lane_line(mut pts: Vec<Pt>) -> (Vec<Pt>, Vec<f64>) {
    if pts.len() > 1 && pts[0].y < pts[pts.len() - 1].y {
        pts.reverse();
    }
    let mut cum = vec![0.0];
    for i in 1..pts.len() {
        cum.push(cum[i - 1] + (pts[i].x - pts[i - 1].x).hypot(pts[i].y - pts[i - 1].y));
    }
    (pts, cum)
}

impl Lane {
    /// `project`: the nearest point on the lane to map point `p`: its `t` (whole units) and
    /// distance in map units.
    pub fn project(&self, p: Pt) -> (u16, f64) {
        let (mut best_s, mut best_d) = (0.0, f64::INFINITY);
        for i in 1..self.points.len() {
            let (a, b) = (self.points[i - 1], self.points[i]);
            let (dx, dy) = (b.x - a.x, b.y - a.y);
            let len2 = dx * dx + dy * dy;
            let u = if len2 > 0.0 { (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
            let d = (a.x + dx * u - p.x).hypot(a.y + dy * u - p.y);
            if d < best_d {
                best_s = self.cum[i - 1] + len2.sqrt() * u;
                best_d = d;
            }
        }
        let tot = self.cum.last().copied().unwrap_or(0.0);
        let t = if tot > 0.0 { (best_s / tot * T_MAX).round() } else { 0.0 };
        (t as u16, best_d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_map_matches_the_web_fallback() {
        let ts = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/src/map/fallback-data.ts")).expect("web fallback");
        let start = ts.find("= {").expect("object") + 2;
        let end = ts.rfind("};").expect("end") + 1;
        let web: serde_json::Value = serde_json::from_str(&ts[start..end]).expect("json");
        let ours: serde_json::Value = serde_json::from_str(CURRENT_MAP).expect("json");
        assert_eq!(web, ours, "regenerate crates/replay/src/map_data.rs from web/src/map/fallback-data.ts");
    }

    #[test]
    fn three_lanes_and_the_sites_replays_need() {
        let m = current();
        let keys: Vec<&str> = m.lanes.iter().map(|l| l.key).collect();
        assert_eq!(keys, ["lane4", "lane6", "lane1"]);
        assert_eq!(m.keys_of("rift"), ["rift:neutral:lane1:1", "rift:neutral:lane6:1"]);
        assert_eq!(m.keys_of("powerup"), ["powerup:neutral:lane1:1", "powerup:neutral:lane6:1"]);
        // Exploration §6: the east rift spawner at (7648, 0); §7: powerup sites at x = ±3936.
        assert_eq!(m.nearest("rift", 7648.0, 0.0, 10.0).map(|s| s.key.as_str()), Some("rift:neutral:lane6:1"));
        assert_eq!(m.nearest("powerup", -3936.0, 136.0, 10.0).map(|s| s.key.as_str()), Some("powerup:neutral:lane1:1"));
        assert!(m.nearest("walker", 0.0, 0.0, 100.0).is_none());
    }

    /// Same inputs as web/src/map/lanes.test.ts's cross-check, same answers.
    #[test]
    fn projection_matches_the_web() {
        let m = current();
        let mid = m.lanes.iter().find(|l| l.key == "lane4").expect("mid");
        // The mid lane's ends: Amber at the bottom (t 0), Sapphire at the top (t 1000).
        assert_eq!(mid.project(Pt { x: 440.5, y: 1001.0 }).0, 0);
        assert_eq!(mid.project(Pt { x: 559.5, y: -1.5 }).0, 1000);
        // The map centre is on the mid lane, half way along it.
        let (t, d) = mid.project(world_to_map(0.0, 0.0));
        assert!(d < 1.0, "{d}");
        assert!((480..=520).contains(&t), "{t}");
        let golden: Vec<u16> = m.lanes.iter().map(|l| l.project(world_to_map(-2000.0, 3000.0)).0).collect();
        assert_eq!(golden, GOLDEN);
    }

    /// `project` of world (-2000, 3000) onto lane4, lane6, lane1 (web/src/map/lanes.test.ts).
    const GOLDEN: [u16; 3] = [606, 882, 795];
}
