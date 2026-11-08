// A match timeline from our server and the board state it gives at a moment: where each hero is,
// who is dead, which objectives are down; and, from a replay (crates/replay), ult cooldowns,
// rifts, powerups, zipline colours and jungle camps. Two tiers, one shape: the metadata
// timeline (crates/server/src/matches.rs) lacks the replay's extra fields. Pure.

import type { Marker } from "../map/model";
import { FALLBACK } from "../map/fallback-data";
import { worldToMap } from "../map/transform";

export interface TimelinePlayer {
  team: "amber" | "sapphire";
  slot: number;
  hero_id: number;
  x: Array<number | null>;
  y: Array<number | null>;
  health: number[];
  deaths: number[];
  souls: Array<[number, number]>;
  /** Replay tier: the in-game name, if the demo carries one (never an id). */
  name?: string | null;
  /** Replay tier: ult cooldown left in percent each second (0 ready); `null` untrained. */
  ult?: Array<number | null>;
}

/** `[from, to)` seconds where a replay value is held through a gap in the recording. */
export type Stale = Array<[number, number]>;

export interface Timeline {
  match_id: number;
  start_time: number;
  duration_s: number;
  source: string;
  players: TimelinePlayer[];
  objectives: Array<{ key: string; kind: string; team: string; lane: number; destroyed_s: number }>;
  mid_boss: Array<{ destroyed_s: number; team_killed: string }>;
  reanchored: number;
  /** `"replay"` for the replay tier; absent for the metadata tier. */
  tier?: "replay";
  build?: number;
  rifts?: Array<{ key: string; start_s: number; end_s: number }>;
  powerups?: Array<{ key: string; available: number[]; stale: Stale }>;
  /** Replay tier: each lane's zipline colours, `[second, amber_t, sapphire_t]` where they move. */
  zips?: Array<{ lane: string; at: Array<[number, number, number]> }>;
  /** Replay tier: camps and the mid boss: first spawn, then `[cleared_s, respawn_s]` intervals. */
  camps?: Array<{ key: string; first_s: number; cleared: Array<[number, number]> }>;
  /** Both tiers, each with what it has (crates/replay/src/timeline.rs `Event`). */
  events?: MatchEvent[];
  /** Replay tier: lane troopers every `every_s` seconds, packed per team (player/troopers.ts). */
  troopers?: { every_s: number; amber: string[]; sapphire: string[] };
  /** Replay tier: each objective's health in percent where it changes, `[second, pct]`; the
   * patron's stage (1, 2) the same way. */
  objective_health?: Array<{ key: string; at: Array<[number, number]>; stage?: Array<[number, number]> }>;
}

export type EventKind = "death" | "objective" | "mid_boss" | "rift_up" | "rift_capture" | "powerup_spawn" | "powerup_taken" | "souls_swing" | "ult";

export interface MatchEvent {
  t: number;
  kind: EventKind;
  team?: string | null;
  slot?: number | null;
  hero_id?: number | null;
  by?: { team: string; slot: number; hero_id: number } | null;
  key?: string | null;
  x?: number | null;
  y?: number | null;
  amount?: number | null;
  /** For `ult`: the ability's internal name. */
  ability?: string | null;
}

export const tierOf = (tl: Timeline): "replay" | "metadata" => (tl.tier === "replay" ? "replay" : "metadata");

export interface PlayerAt {
  team: "amber" | "sapphire";
  slot: number;
  hero_id: number;
  /** World position at t; `null` while dead. */
  pos: { x: number; y: number } | null;
  /** Where the hero was last seen alive at or before t (for a dead hero's token). */
  last: { x: number; y: number } | null;
  souls: number | null;
  /** Ult cooldown left in percent; `null` when the tier doesn't know (or it's untrained). */
  ult: number | null;
  /** Replay tier: health in percent (0 dead); `null` on the metadata tier (its path health is
   * too coarse to show, operator 2026-11-08). */
  health: number | null;
}

/** Position at a fractional second: linear between the two samples when both are alive. */
export function positionAt(p: Pick<TimelinePlayer, "x" | "y">, t: number): { x: number; y: number } | null {
  const n = Math.min(p.x.length, p.y.length);
  if (n === 0) return null;
  const c = Math.max(0, Math.min(n - 1, t));
  const i = Math.floor(c);
  const x0 = p.x[i], y0 = p.y[i];
  if (x0 == null || y0 == null) return null;
  const j = Math.min(n - 1, i + 1);
  const x1 = p.x[j], y1 = p.y[j];
  const f = c - i;
  if (f === 0 || x1 == null || y1 == null) return { x: x0, y: y0 };
  return { x: Math.round(x0 + (x1 - x0) * f), y: Math.round(y0 + (y1 - y0) * f) };
}

/** The last alive position at or before t. */
export function lastSeen(p: Pick<TimelinePlayer, "x" | "y">, t: number): { x: number; y: number } | null {
  for (let i = Math.min(Math.floor(t), p.x.length - 1); i >= 0; i--) {
    const x = p.x[i], y = p.y[i];
    if (x != null && y != null) return { x, y };
  }
  return null;
}

/** Net worth from the nearest sample at or before t (`null` before the first sample). */
export function soulsAt(p: Pick<TimelinePlayer, "souls">, t: number): number | null {
  let v: number | null = null;
  for (const [s, n] of p.souls) if (s <= t) v = n;
  return v;
}

export function playersAt(tl: Timeline, t: number): PlayerAt[] {
  return tl.players.map((p) => ({
    team: p.team,
    slot: p.slot,
    hero_id: p.hero_id,
    pos: positionAt(p, t),
    last: lastSeen(p, t),
    souls: soulsAt(p, t),
    ult: p.ult?.[Math.max(0, Math.min(p.ult.length - 1, Math.floor(t)))] ?? null,
    health: tl.tier === "replay" ? (p.health[Math.max(0, Math.min(p.health.length - 1, Math.floor(t)))] ?? 0) : null,
  }));
}

/** The value of a `[second, v]` change list at t (`undefined` before its first change). */
function stepAt(list: Array<[number, number]>, t: number): number | undefined {
  let v: number | undefined;
  for (const [s, x] of list) {
    if (s > t) break;
    v = x;
  }
  return v;
}

/**
 * Objectives' health at t, by board key (replay tier; empty otherwise). A destroyed objective
 * has none; the patron carries its stage.
 */
export function objectiveHealthAt(tl: Timeline, t: number): Map<string, { pct: number; stage?: number }> {
  const out = new Map<string, { pct: number; stage?: number }>();
  for (const o of tl.objective_health ?? []) {
    const pct = stepAt(o.at, t);
    if (pct === undefined) continue;
    if (tl.objectives.some((d) => d.key === o.key && d.destroyed_s <= t)) continue;
    const stage = o.stage?.length ? stepAt(o.stage, t) : undefined;
    out.set(o.key, stage === undefined ? { pct } : { pct, stage });
  }
  return out;
}

/**
 * Rifts, powerups and camps at t as board statuses, by marker key (replay tier; empty
 * otherwise): the rift up at t is Active and the other rifts off (Destroyed); a powerup is
 * Active while available, else Destroyed (taken, or not spawned yet); a camp is Active while
 * up, else Destroyed (cleared, or not spawned yet). The mid boss is `downAt`'s.
 */
export function sitesAt(tl: Timeline, t: number, markers: Array<Pick<Marker, "key" | "kind" | "team" | "at">>): Map<string, "Active" | "Destroyed"> {
  const out = new Map<string, "Active" | "Destroyed">();
  if (!tl.rifts && !tl.powerups && !tl.camps) return out;
  const s = Math.floor(t);
  const known = new Set(markers.map((m) => m.key));
  for (const m of markers) if (m.kind === "koth") out.set(m.key, "Destroyed");
  for (const r of tl.rifts ?? []) if (known.has(r.key) && s >= r.start_s && s < r.end_s) out.set(r.key, "Active");
  for (const p of tl.powerups ?? []) {
    const v = p.available[Math.max(0, Math.min(p.available.length - 1, s))];
    if (v !== undefined && known.has(p.key)) out.set(p.key, v ? "Active" : "Destroyed");
  }
  for (const c of tl.camps ?? []) {
    if (!c.key.startsWith("camp:")) continue;
    const key = markerKey(c.key, markers);
    if (key) out.set(key, campAt(c, t).state === "alive" ? "Active" : "Destroyed");
  }
  return out;
}

/** Each lane's zipline colours at t (replay tier): Amber owns `[0, amber]`, Sapphire `[sapphire, 1000]`. */
export function lanesAt(tl: Timeline, t: number): Map<string, { amber: number; sapphire: number }> {
  const out = new Map<string, { amber: number; sapphire: number }>();
  const s = Math.floor(t);
  for (const z of tl.zips ?? []) {
    let v: [number, number, number] | undefined;
    for (const e of z.at) {
      if (e[0] > s) break;
      v = e;
    }
    if (v) out.set(z.lane, { amber: v[1], sapphire: v[2] });
  }
  return out;
}

/** A camp (or the mid boss) at t: up, cleared until `at`, or waiting for its first spawn at `at`. */
export type CampAt = { state: "alive" } | { state: "cleared"; at: number } | { state: "unspawned"; at: number };

type TimelineCamp = NonNullable<Timeline["camps"]>[number];

export function campAt(c: TimelineCamp, t: number): CampAt {
  if (t < c.first_s) return { state: "unspawned", at: c.first_s };
  const down = c.cleared.find(([a, b]) => t >= a && t < b);
  return down ? { state: "cleared", at: down[1] } : { state: "alive" };
}

/** Camps at t by the timeline's keys (replay tier; empty otherwise). */
export function campsAt(tl: Timeline, t: number): Map<string, CampAt> {
  return new Map((tl.camps ?? []).map((c) => [c.key, campAt(c, t)]));
}

const MARKER_KIND: Record<string, Marker["kind"]> = { guardian: "t1", walker: "t2", base_guardian: "barracks", shrine: "shrine", patron: "t3", mid_boss: "midboss", camp: "camp", rift: "koth", powerup: "powerup" };

/**
 * The board marker a timeline key names. The worker keys sites by the built-in map
 * (map/fallback-data.ts) and the metadata by Valve's lanes, while a pack can key the same site
 * differently (`patron:sapphire:lane3:1` against `lane0`, camps by lane): the key itself, else
 * the marker of the same kind on the built-in site's spot, else, for the one-per-team patron
 * and the mid boss, the same kind and team.
 */
export function markerKey(key: string, markers: Array<Pick<Marker, "key" | "kind" | "team" | "at">>): string | undefined {
  if (markers.some((m) => m.key === key)) return key;
  const [k = "", team = ""] = key.split(":");
  const kind = MARKER_KIND[k];
  if (!kind) return undefined;
  const site = FALLBACK.entities.find((e) => e.key === key || e.key === `${key}:1`);
  if (site && site.world.length >= 2) {
    const at = worldToMap({ x: site.world[0]!, y: site.world[1]! });
    let best: { key: string; d: number } | undefined;
    for (const m of markers) {
      if (m.kind !== kind) continue;
      const d = Math.hypot(m.at.x - at.x, m.at.y - at.y);
      if (d < 3 && (!best || d < best.d)) best = { key: m.key, d };
    }
    if (best) return best.key;
  }
  if (kind === "t3" || kind === "midboss") return markers.find((m) => m.kind === kind && (kind === "midboss" || m.team === team))?.key;
  return undefined;
}

/**
 * Board objective keys down at t: everything destroyed at or before t, plus the mid boss
 * from a kill until the next one (its respawn time isn't in the match data).
 */
export function downAt(tl: Timeline, t: number, markers: Array<Pick<Marker, "key" | "kind" | "team" | "lane" | "at">>): Set<string> {
  const down = new Set<string>();
  const laneColour: Record<number, string> = { 1: "yellow", 4: "blue", 6: "purple" };
  for (const o of tl.objectives) {
    if (o.destroyed_s > t) continue;
    // The marker the key names; else the marker of the same kind, team and lane.
    const key =
      markerKey(o.key, markers) ?? markers.find((x) => x.kind === MARKER_KIND[o.kind] && x.team === o.team && x.lane === laneColour[o.lane])?.key;
    if (key) down.add(key);
  }
  // A replay knows the mid boss's respawn (its camp timer); the metadata only its kills.
  const boss = tl.camps?.find((c) => c.key.startsWith("mid_boss:"));
  if (boss) {
    if (campAt(boss, t).state !== "alive") for (const m of markers) if (m.kind === "midboss") down.add(m.key);
    return down;
  }
  const kills = tl.mid_boss.map((b) => b.destroyed_s).sort((a, b) => a - b);
  const killed = kills.some((k, i) => k <= t && (kills[i + 1] === undefined || t < kills[i + 1]!));
  if (killed) for (const m of markers) if (m.kind === "midboss") down.add(m.key);
  return down;
}

export const clockLabel = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
