// What the minimap draws, derived from an asset pack's entities (or the built-in fallback):
// markers with their size, layer and tint, and lane lines. Pure, no DOM. The numbers come from
// design/parity/README.md, "Renderer spec".

import { FALLBACK } from "./fallback-data";
import { type LaneLine, laneLine, samplePath } from "./lanes";
import { type Pt, type Transform, type Viewpoint, DEFAULT_TRANSFORM, worldToMap } from "./transform";

/** One entity as the extractor writes it into `pack.json` (schema 4; entities since 2). */
export interface PackEntity {
  key: string;
  kind: string;
  team: string;
  lane: string;
  world: number[];
  src?: { classname: string; hammeruniqueid: string; targetname: string };
  /** Zipline path nodes, world units, in path order. */
  nodes?: number[][];
  /** Camp strength (weak / medium / strong / vaults, or the mid boss's own `midboss`), from the
   * camp's `subclass_name`; packs extracted before 2026-11-09 don't carry it. */
  tier?: string;
  /** Teleporters: where this end lets out (world units), beside the other end of its pair. */
  exit?: number[];
}

export interface FallbackData {
  entities: PackEntity[];
  /** Lane curves already in map units (SVG path data). */
  lanes: Array<{ lane: string; d: string }>;
}

export type Team = "amber" | "sapphire" | "neutral";
export type LaneColor = "yellow" | "blue" | "purple";
export type MarkerKind = "t1" | "t2" | "t3" | "barracks" | "shrine" | "midboss" | "camp" | "koth" | "powerup" | "urn" | "shop" | "teleporter" | "heal" | "crate";

/** The map's furniture (docs/research/map-objectives-audit.md): drawn, but not objectives, so a
 * click doesn't toggle them, a selection doesn't pick them, and a scene has no state for them. */
export const FURNITURE_KINDS = ["shop", "teleporter", "heal", "tough_crate"] as const;
export const isFurniture = (k: MarkerKind) => k === "shop" || k === "teleporter" || k === "heal" || k === "crate";

/** The furniture each browser chooses to draw (the Heals and Heavy boxes toggles, spec §6b). */
export interface OptionalFurniture {
  heals?: boolean | undefined;
  crates?: boolean | undefined;
}

/** Whether a marker is drawn given this browser's toggles: the healing pickups and the heavy
 * boxes only when theirs is on; everything else always. */
export const optionalShown = (k: MarkerKind, on: OptionalFurniture) => (k === "heal" ? !!on.heals : k === "crate" ? !!on.crates : true);

export interface Marker {
  /** Semantic key, e.g. `walker:amber:lane1:1`; base guardians drop the index (one per pair). */
  key: string;
  kind: MarkerKind;
  team: Team;
  lane: LaneColor | null;
  /** Centre, in map units (Amber at the bottom; the view rotates it). */
  at: Pt;
  /** Width = height, in Panorama px on the 360 px HUD map. */
  px: number;
  /** HUD z-index. */
  z: number;
  /** Camps: which neutral icon. */
  tier?: "weak" | "medium" | "strong" | "vaults" | undefined;
  /** Teleporters: the key of the other end of its pair. */
  link?: string | undefined;
  title: string;
}

export interface LanePath {
  lane: LaneColor;
  /** The lane's key on the board (`Wave.lane`): `lane1`, `lane4` or `lane6`. */
  key: string;
  d: string;
  /** The path measured from its Amber end, for the lane equilibrium split. */
  line: LaneLine;
}

export interface MapModel {
  markers: Marker[];
  lanes: LanePath[];
}

export const HUD_MAP_PX = 360;
/** One HUD px in map units. */
export const HUD_PX = 1000 / HUD_MAP_PX;

const LANE_BY_ID: Record<string, LaneColor> = { lane1: "yellow", lane4: "blue", lane6: "purple" };
const LANE_NAME: Record<LaneColor, string> = { yellow: "west", blue: "mid", purple: "east" };
const LANE_KEY: Record<LaneColor, string> = { yellow: "lane1", blue: "lane4", purple: "lane6" };

export const ENEMY = "#DC4C2F";
export const OFFWHITE = "#FFEFD7";
export const TEAM_TINT = { amber: "#E7B659", sapphire: "#5B79E6" } as const;
export const LANE_TINT: Record<LaneColor, string> = { yellow: "#FFDF40", blue: "#2EC7E6", purple: "#6BB247" };

const team = (t: string): Team => (t === "amber" || t === "sapphire" ? t : "neutral");
/** A team's display name: its patron since Old Gods, New Blood (the Amber Hand follows the Hidden
 *  King, the Sapphire Flame the Archmother). The wire, CSS and data keys stay `amber`/`sapphire`;
 *  every user-visible team name goes through here. */
export const teamName = (t: Team) => (t === "amber" ? "Hidden King" : t === "sapphire" ? "Archmother" : "neutral");
/** The same, short, where a label is tight (a roster slot tag, a top-bar heading). */
export const teamShort = (t: Team) => (t === "amber" ? "King" : t === "sapphire" ? "Archmother" : "neutral");
/** The display name for the roster's capitalised `"Amber"`/`"Sapphire"` (gen/Team). */
export const rosterTeamName = (t: string) => teamName(t === "Amber" || t === "amber" ? "amber" : t === "Sapphire" || t === "sapphire" ? "sapphire" : "neutral");
const rosterTeam = (t: string): Team => (t === "Amber" || t === "amber" ? "amber" : t === "Sapphire" || t === "sapphire" ? "sapphire" : "neutral");
/** The short name for a roster team, for placeholder player names ("King 2"). */
export const rosterTeamShort = (t: string) => teamShort(rosterTeam(t));
/** A roster slot's one-letter team tag ("K3", "A5"): the patron's initial. */
export const slotTag = (t: string) => (rosterTeam(t) === "amber" ? "K" : "A");

type CampTier = NonNullable<Marker["tier"]>;
const isTier = (t: string | undefined): t is CampTier => t === "weak" || t === "medium" || t === "strong" || t === "vaults";
/** World units within which two records are the same site (the built-in map's camps sit on the
 * lump's to the unit). */
const SAME_SITE = 64;
/** World units from a teleporter's exit to the other end of its pair (128 on the current map). */
const LINK_REACH = 256;
const near = (a: number[], b: number[], d = SAME_SITE) => Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0)) <= d;

/**
 * A camp's tier: the pack's, from the map's `subclass_name`. Older packs carry none: then the
 * built-in map's camp on the same spot (its tiers came from the same lump), else the name. The
 * name alone misses five of the eleven Sinner's Sacrifice camps (the bell tower's, the theater
 * balcony's…), which is why it's the last resort (docs/research/map-objectives-audit.md).
 */
export function campTier(e: PackEntity): CampTier {
  if (isTier(e.tier)) return e.tier;
  const builtIn = FALLBACK.entities.find((f) => f.kind === "camp" && near(f.world, e.world))?.tier;
  if (isTier(builtIn)) return builtIn;
  return /vault/i.test(e.src?.targetname ?? "") ? "vaults" : "medium";
}

/** The mid boss's own camp (`neutral_camp_midboss`): the mid boss marker already stands there. */
const isMidBossCamp = (e: PackEntity, all: PackEntity[]) =>
  e.tier === "midboss" || (e.tier === undefined && all.some((m) => m.kind === "mid_boss" && near(m.world, e.world)));

/** What a camp marker is called: the Sinner's Sacrifice by name, the others by tier. */
export const campTitle = (tier: CampTier) => (tier === "vaults" ? "Sinner's Sacrifice" : `Camp (${tier})`);

/** Markers for every entity the minimap shows. Unknown kinds are skipped, never guessed. */
export function markersFrom(entities: PackEntity[], t: Transform = DEFAULT_TRANSFORM): Marker[] {
  const out: Marker[] = [];
  const pairs = new Map<string, PackEntity[]>();
  for (const e of entities) {
    const [x = 0, y = 0] = e.world;
    const at = worldToMap({ x, y }, t);
    const tm = team(e.team);
    const lane = LANE_BY_ID[e.lane] ?? null;
    const where = lane ? `, ${LANE_NAME[lane]} lane` : "";
    const base = { key: e.key, team: tm, lane, at };
    switch (e.kind) {
      case "guardian":
        out.push({ ...base, kind: "t1", px: 40, z: 15, title: `Guardian (${teamName(tm)}${where})` });
        break;
      case "walker":
        out.push({ ...base, kind: "t2", px: 64, z: 15, title: `Walker (${teamName(tm)}${where})` });
        break;
      case "patron":
        out.push({ ...base, kind: "t3", px: 80, z: 15, lane: null, title: `Patron (${teamName(tm)})` });
        break;
      case "shrine":
        out.push({ ...base, kind: "shrine", px: 32, z: 15, title: `Shrine (${teamName(tm)}${where})` });
        break;
      case "mid_boss":
        out.push({ ...base, kind: "midboss", px: 64, z: 4, lane: null, title: "Mid boss" });
        break;
      case "camp": {
        if (isMidBossCamp(e, entities)) break;
        const tier = campTier(e);
        out.push({ ...base, kind: "camp", px: 24, z: 2, lane: null, tier, title: campTitle(tier) });
        break;
      }
      case "powerup":
        // .powerup_survival / .powerup_casting: 20 px. The spawners are generic sites.
        out.push({ ...base, kind: "powerup", px: 20, z: 0, lane: null, title: "Powerup" });
        break;
      case "rift":
        out.push({ ...base, kind: "koth", px: 32, z: 0, lane: null, title: "Unstable Rift" });
        break;
      case "urn":
        // A Soul Urn delivery point (hud_minimap.vcss .idol_return_friendly: its art at 50% of
        // a 96 px box, i.e. 48 px, as are its three .idolReturnTarget pulses). The urn spawns
        // over one and is carried to the other.
        out.push({ ...base, kind: "urn", px: 48, z: 15, lane: null, title: "Soul Urn" });
        break;
      case "shop":
        // .tier1_shop: a 36 px box, its art at half of it, over the camps (ZIndexT1Shop 3).
        out.push({ ...base, kind: "shop", px: 36, z: 3, lane: null, title: tm === "neutral" ? "Shop" : `Shop (${teamName(tm)})` });
        break;
      case "teleporter":
        // .teleporter_nearby: 16 px, under everything (ZIndexTeleporter 1).
        out.push({ ...base, kind: "teleporter", px: 16, z: 1, lane: null, title: "Teleporter" });
        break;
      case "heal":
        // The game's minimap only precaches health_pad_psd (16 px), whose cross fills its box:
        // at 12 px it weighs about what a camp's icon does, so 36 of them don't drown the map.
        out.push({ ...base, kind: "heal", px: 12, z: 1, lane: null, title: "Healing pickup" });
        break;
      case "tough_crate":
        // The tough crates (the "Heavy boxes" toggle). The game's minimap doesn't draw them, so
        // our own small box, a little under a heal's size: 78 of them stay quiet on the map.
        out.push({ ...base, kind: "crate", px: 10, z: 1, lane: null, title: "Heavy box" });
        break;
      case "base_guardian": {
        // One marker per team and lane, at the midpoint of the pair (README, "Markers").
        const k = `base_guardian:${e.team}:${e.lane}`;
        pairs.set(k, [...(pairs.get(k) ?? []), e]);
        break;
      }
    }
  }
  // A teleporter's pair: the other end beside where it lets out.
  for (const e of entities) {
    if (e.kind !== "teleporter" || !e.exit) continue;
    const other = entities.find((o) => o.kind === "teleporter" && o.key !== e.key && near(o.world, e.exit!, LINK_REACH));
    const m = out.find((x) => x.key === e.key);
    if (m && other) m.link = other.key;
  }
  for (const [key, es] of pairs) {
    const first = es[0]!;
    const mid = {
      x: es.reduce((s, e) => s + (e.world[0] ?? 0), 0) / es.length,
      y: es.reduce((s, e) => s + (e.world[1] ?? 0), 0) / es.length,
    };
    const tm = team(first.team);
    const lane = LANE_BY_ID[first.lane] ?? null;
    out.push({
      key,
      kind: "barracks",
      team: tm,
      lane,
      at: worldToMap(mid, t),
      px: 40,
      z: 15,
      title: `Base guardian (${teamName(tm)}${lane ? `, ${LANE_NAME[lane]} lane` : ""})`,
    });
  }
  return out;
}

const f1 = (v: number) => Math.round(v * 10) / 10;

/**
 * A smooth curve through the zipline's nodes (map units). Schema-2 packs carry node positions
 * without tangents, so the curve is a Catmull-Rom spline written as cubic Beziers.
 */
export function lanePathThrough(points: Pt[]): string {
  if (points.length === 0) return "";
  const p = points;
  let d = `M${f1(p[0]!.x)} ${f1(p[0]!.y)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i]!;
    const p1 = p[i]!;
    const p2 = p[i + 1]!;
    const p3 = p[i + 2] ?? p2;
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${f1(c1.x)} ${f1(c1.y)} ${f1(c2.x)} ${f1(c2.y)} ${f1(p2.x)} ${f1(p2.y)}`;
  }
  return d;
}

/** The three lane ziplines (`Lane1`, `Lane4`, `Lane6`), as curves in map units. */
export function lanesFrom(entities: PackEntity[], t: Transform = DEFAULT_TRANSFORM): LanePath[] {
  const out: LanePath[] = [];
  for (const e of entities) {
    if (e.kind !== "zipline" || !e.nodes || e.nodes.length < 2) continue;
    const lane = LANE_BY_ID[e.lane];
    if (!lane || !/Lane[146]$/.test(e.src?.targetname ?? "")) continue;
    const d = lanePathThrough(e.nodes.map(([x = 0, y = 0]) => worldToMap({ x, y }, t)));
    out.push({ lane, key: e.lane, d, line: laneLine(samplePath(d)) });
  }
  return out;
}

/**
 * A pack's entities with the map's furniture added from the built-in map where the pack has none
 * of a kind: packs extracted before 2026-11-09 carry no shops, teleporters or healing pickups, and
 * packs before the Heavy boxes no tough crates
 * (the same fallback as a camp's tier, `campTier`).
 */
export function withBuiltInFurniture(entities: PackEntity[]): PackEntity[] {
  const missing = FURNITURE_KINDS.filter((k) => !entities.some((e) => e.kind === k));
  return missing.length ? [...entities, ...FALLBACK.entities.filter((e) => (missing as readonly string[]).includes(e.kind))] : entities;
}

export function modelFromEntities(entities: PackEntity[], t: Transform = DEFAULT_TRANSFORM): MapModel {
  return { markers: markersFrom(entities, t), lanes: lanesFrom(entities, t) };
}

export function modelFromFallback(f: FallbackData): MapModel {
  return {
    markers: markersFrom(f.entities),
    lanes: f.lanes.flatMap((l) => {
      const lane = (["yellow", "blue", "purple"] as const).find((c) => c === l.lane);
      return lane ? [{ lane, key: LANE_KEY[lane], d: l.d, line: laneLine(samplePath(l.d)) }] : [];
    }),
  };
}

/** Sites that are off unless turned on, at most one of a kind at a time: the rifts, and the
 * urn's delivery points. */
export const offByDefault = (k: MarkerKind) => k === "koth" || k === "urn";

/** The objective's tint for a viewpoint ("Tints by viewpoint"). */
export function washFor(m: Pick<Marker, "kind" | "team" | "lane">, vp: Viewpoint): string {
  if (vp === "neutral") return m.team === "neutral" ? OFFWHITE : TEAM_TINT[m.team];
  if (m.team !== vp) return ENEMY;
  if ((m.kind === "t1" || m.kind === "t2" || m.kind === "barracks") && m.lane) return LANE_TINT[m.lane];
  return OFFWHITE;
}

/** Whether a marker belongs to the viewer's team (neutral view: Amber's, the team1 rule). */
export function isFriendly(m: Pick<Marker, "team">, vp: Viewpoint): boolean {
  return vp === "neutral" ? m.team === "amber" : m.team === vp;
}

/** Lane line colour for one half of the map: `half` is the team whose side it is. */
export function laneStroke(lane: LaneColor, half: "amber" | "sapphire", vp: Viewpoint): string {
  if (vp === "neutral") return TEAM_TINT[half];
  return half === vp ? LANE_TINT[lane] : ENEMY;
}
