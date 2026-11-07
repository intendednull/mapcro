// A match timeline from our server (crates/server/src/matches.rs) and the board state it gives
// at a moment: where each hero is, who is dead, which objectives are down. Pure.

import type { Marker } from "../map/model";

export interface TimelinePlayer {
  team: "amber" | "sapphire";
  slot: number;
  hero_id: number;
  x: Array<number | null>;
  y: Array<number | null>;
  health: number[];
  deaths: number[];
  souls: Array<[number, number]>;
}

export interface Timeline {
  match_id: number;
  start_time: number;
  duration_s: number;
  source: string;
  players: TimelinePlayer[];
  objectives: Array<{ key: string; kind: string; team: string; lane: number; destroyed_s: number }>;
  mid_boss: Array<{ destroyed_s: number; team_killed: string }>;
  reanchored: number;
}

export interface PlayerAt {
  team: "amber" | "sapphire";
  slot: number;
  hero_id: number;
  /** World position at t; `null` while dead. */
  pos: { x: number; y: number } | null;
  /** Where the hero was last seen alive at or before t (for a dead hero's token). */
  last: { x: number; y: number } | null;
  souls: number | null;
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
  }));
}

/**
 * Board objective keys down at t: everything destroyed at or before t, plus the mid boss
 * from a kill until the next one (its respawn time isn't in the match data).
 */
export function downAt(tl: Timeline, t: number, markers: Array<Pick<Marker, "key" | "kind" | "team" | "lane">>): Set<string> {
  const down = new Set<string>();
  const laneColour: Record<number, string> = { 1: "yellow", 4: "blue", 6: "purple" };
  const kind: Record<string, Marker["kind"]> = { guardian: "t1", walker: "t2", base_guardian: "barracks", shrine: "shrine", patron: "t3" };
  for (const o of tl.objectives) {
    if (o.destroyed_s > t) continue;
    // The pack's key when it has one; else the marker of the same kind, team and lane.
    const m =
      markers.find((x) => x.key === o.key) ??
      markers.find((x) => x.kind === kind[o.kind] && x.team === o.team && (o.kind === "patron" || x.lane === laneColour[o.lane]));
    if (m) down.add(m.key);
  }
  const kills = tl.mid_boss.map((b) => b.destroyed_s).sort((a, b) => a - b);
  const killed = kills.some((k, i) => k <= t && (kills[i + 1] === undefined || t < kills[i + 1]!));
  if (killed) for (const m of markers) if (m.kind === "midboss") down.add(m.key);
  return down;
}

export const clockLabel = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
