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
  /** Format 8, replay tier: `[second, hero level]` changes; null marks unavailable data. */
  level?: Array<[number, number | null]>;
  /** Format 8, replay tier: `[second, maximum HP]` changes; null marks unavailable data. */
  max_health?: Array<[number, number | null]>;
  /** Format 9, replay tier: `[second, [max health, spirit power, weapon %, bullet resist %,
   * spirit resist %]]` statue-pickup totals where they change (zero before the first). */
  pickups?: Array<[number, [number, number, number, number, number]]>;
  /** Format 8, replay tier: authoritative player kills; zero known, null unavailable. */
  kills?: Array<[number, number | null]>;
  /** Format 8, replay tier: authoritative assists, never inferred from damage. */
  assists?: Array<[number, number | null]>;
  souls: Array<[number, number]>;
  /** Replay tier: the in-game name, if the demo carries one (never an id). */
  name?: string | null;
  /** Replay tier: ult cooldown left in percent each second (0 ready); `null` untrained. */
  ult?: Array<number | null>;
  /** Both tiers, when they have it: `[died_s, back_s]` per death. */
  respawn?: Array<[number, number]>;
  /** Replay tier, format 4: `[start_ds, end_ds)` tenths of a second the enemy team could see this
   * hero (crates/replay/src/timeline.rs `Player::seen`). */
  seen?: Array<[number, number]>;
  // Format 7 (crates/replay/src/timeline.rs `Player::items` to `Player::zipline`): stored, not
  // shown yet (operator, 2026-11-09). Ids are the game's tokens (numbers); `_ds` times are tenths
  // of a second; `src` is the causing hero's index in `players`, 255 when not a hero.
  /** Both tiers: `[t_ds, item_id, kind]`, kind 0 bought, 1 sold, 2 used up by an upgrade, 3 gone
   * otherwise. */
  items?: Array<[number, number, number]>;
  /** Both tiers: `[second, ability_id, level]`, level 1 unlocked, 2–4 tiers 1–3. */
  abilities?: Array<[number, number, number]>;
  /** Replay tier: `[t_ds, ability_id, cooldown_end_ds]` per cast (0: end unknown). */
  casts?: Array<[number, number, number]>;
  /** Replay tier: `[t_ds, ability_id, charges]` where charges left change. */
  charges?: Array<[number, number, number]>;
  /** Replay tier: `[start_ds, end_ds, state, src, ability_id]` hard CC (`MODIFIER_STATE_*`). */
  cc?: Array<[number, number, number, number, number]>;
  /** Replay tier: `[start_ds, end_ds, effect_id, src, ability_id, stacks]` icon-shown effects. */
  effects?: Array<[number, number, number, number, number, number]>;
  /** Replay tier: per death, damage `[src, ability_id, damage]` in the 10 s before, and the CC. */
  recaps?: Array<{ t: number; damage: Array<[number, number, number]>; cc?: Array<[number, number, number, number, number]> }>;
  /** Replay tier: `[second, level]` where height changes: 0 level, 1 above, 2 below. */
  height?: Array<[number, number]>;
  /** Replay tier: `[from_s, to_s)` riding a zipline. */
  zipline?: Array<[number, number]>;
}

/** The Soul Urn's state from a second on (replay tier; crates/replay/src/timeline.rs `UrnAt`). */
export interface UrnAt {
  t: number;
  state: "ground" | "carried" | "none";
  x?: number | null;
  y?: number | null;
  /** Carried: the carrier's team; on the ground after a drop, the dropper's. */
  team?: "amber" | "sapphire" | null;
  slot?: number | null;
  /** The urn site it's to be delivered to, while that point is open. */
  delivery?: string | null;
}

/** One bridge powerup spawn (crates/replay/src/timeline.rs `PowerupSpawn`). */
export interface PowerupSpawn {
  t: number;
  buff: string;
  taken_s?: number | null;
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
  /** Replay tier: the worker's output format (`timeline::FORMAT`). */
  format?: number;
  /** Replay tier: announced at `start_s`, its cash-in open from `live_s` (format 2) to `end_s`;
   * from format 3 when it gives up uncaptured and each team's capture progress. */
  rifts?: TimelineRift[];
  /** Replay tier: per site, up each second; from format 2 each spawn's buff and pick-up. */
  powerups?: Array<{ key: string; available: number[]; stale: Stale; spawns?: PowerupSpawn[] }>;
  /** Replay tier: each lane's zipline colours, `[second, amber_t, sapphire_t]` where they move. */
  zips?: Array<{ lane: string; at: Array<[number, number, number]> }>;
  /** Replay tier: camps and the mid boss: first spawn, then `[cleared_s, respawn_s]` intervals. */
  camps?: Array<{ key: string; first_s: number; cleared: Array<[number, number]> }>;
  /** Replay tier, format 5: the map's healing pickups in the camps' shape: first up, then
   * `[taken_s, back_s]` intervals. */
  heals?: Array<{ key: string; first_s: number; cleared: Array<[number, number]> }>;
  /** Replay tier, format 7: the map's tough crates (the Heavy boxes) in the camps' shape: first
   * up (3:00, 5:00 or 10:00 by spawn group), then `[broken_s, back_s]` intervals. */
  crates?: Array<{ key: string; first_s: number; cleared: Array<[number, number]> }>;
  /** Both tiers, each with what it has (crates/replay/src/timeline.rs `Event`). */
  events?: MatchEvent[];
  /** Replay tier: lane troopers every `every_s` seconds, packed per team (player/troopers.ts). */
  troopers?: { every_s: number; amber: string[]; sapphire: string[] };
  /** Replay tier: each objective's health in percent where it changes, `[second, pct]`; the
   * patron's stage (1, 2) the same way. */
  objective_health?: Array<{ key: string; at: Array<[number, number]>; stage?: Array<[number, number]> }>;
  /** Replay tier: the Soul Urn: each spawn (second, site) and its state where it changes. */
  urn?: { spawns: Array<{ t: number; key: string }>; at: UrnAt[] };
  /** Replay tier, format 3: each Rejuvenator a team held (crates/replay/src/timeline.rs `Rejuv`). */
  rejuv?: TimelineRejuv[];
}

export interface TimelineRift {
  key: string;
  start_s: number;
  end_s: number;
  live_s?: number | null;
  /** Format 3: the second its cash-in gives up if nobody captures it. */
  give_up_s?: number | null;
  /** Format 3: `[tenths of a second, amber %, sapphire %]` while open; a straight line between
   * rows. */
  capture?: Array<[number, number, number]>;
}

/** The mid boss's reward held by a team: from `taken_s` to `ends_s`, its revives left
 * `[second, n]` where they change. */
export interface TimelineRejuv {
  team: "amber" | "sapphire";
  taken_s: number;
  ends_s: number;
  left: Array<[number, number]>;
}

export type EventKind =
  | "item_buy" // Client-derived from recorded purchases and the selected pack.
  | "death"
  | "objective"
  | "mid_boss"
  | "rift_up"
  | "rift_capture"
  | "powerup_spawn"
  | "powerup_taken"
  | "souls_swing"
  | "ult"
  | "urn_pickup"
  | "urn_drop"
  | "urn_delivered"
  | "rejuv_taken"
  | "rejuv_revive"
  | "rejuv_expired";

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
  /** For powerup events (replay, format 2): the buff, `gun`, `survival`, `casting`, `movement`. */
  buff?: string | null;
}

export const tierOf = (tl: Timeline): "replay" | "metadata" => (tl.tier === "replay" ? "replay" : "metadata");

export interface PlayerAt {
  team: "amber" | "sapphire";
  slot: number;
  hero_id: number;
  /** The player's in-game name, when the timeline has one (never an id). */
  name: string | null;
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
  /** While dead: seconds until the hero respawns, when the timeline knows (else `null`). */
  respawn: number | null;
}

/** Seconds left until the hero respawns at t, if t falls in one of its deaths. */
export function respawnAt(p: Pick<TimelinePlayer, "respawn">, t: number): number | null {
  for (const [died, back] of p.respawn ?? []) if (t >= died && t < back) return back - t;
  return null;
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

/** Recorded scoreboard value at or before t. Missing series and explicit gaps stay unknown. */
export function scoreboardValueAt(values: ReadonlyArray<readonly [number, number | null]> | undefined, t: number): number | null {
  let value: number | null = null;
  for (const [second, next] of values ?? []) {
    if (second > t) break;
    value = next;
  }
  return value;
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
    name: p.name ?? null,
    pos: positionAt(p, t),
    last: lastSeen(p, t),
    souls: soulsAt(p, t),
    ult: p.ult?.[Math.max(0, Math.min(p.ult.length - 1, Math.floor(t)))] ?? null,
    health: tl.tier === "replay" ? (p.health[Math.max(0, Math.min(p.health.length - 1, Math.floor(t)))] ?? 0) : null,
    respawn: respawnAt(p, t),
  }));
}

/** The Soul Urn at t: where it is (world units; a carried urn is where its carrier is), who
 * holds it, the open delivery point, and the next spawn after t (timeline keys). */
export interface UrnNow {
  state: "ground" | "carried" | "none";
  /** On the ground and settled (landed, or dropped): when it walks back if nobody picks it up
   * (`returns` ≤ t: walking back). `null` otherwise, and while it's still falling. */
  returns?: number | null;
  at: { x: number; y: number } | null;
  team: "amber" | "sapphire" | null;
  slot: number | null;
  delivery: string | null;
  next: { t: number; key: string } | null;
}

export function urnAt(tl: Timeline, t: number): UrnNow | undefined {
  const u = tl.urn;
  if (!u) return undefined;
  let cur: UrnAt | undefined;
  let after: UrnAt | undefined;
  // Since when it has lain still: the start of this stay on the ground, once it has landed (its
  // delivery point opens as it lands; a dropped urn's is open).
  let settled: number | null = null;
  for (const a of u.at) {
    if (a.t > t) {
      after = a;
      break;
    }
    if (a.state !== "ground") settled = null;
    else if (settled === null && a.delivery) settled = a.t;
    cur = a;
  }
  const next = u.spawns.find((s) => s.t > t) ?? null;
  const none: UrnNow = { state: "none", at: null, team: null, slot: null, delivery: null, next };
  if (!cur || cur.state === "none") return none;
  const delivery = cur.delivery ?? null;
  if (cur.state === "ground") return { ...none, state: "ground", at: groundAt(cur, after, t), team: cur.team ?? null, delivery, returns: settled === null ? null : settled + URN_WALK_BACK_S };
  const p = tl.players.find((q) => q.team === cur.team && q.slot === cur.slot);
  return { ...none, state: "carried", at: p ? (positionAt(p, t) ?? lastSeen(p, t)) : null, team: cur.team ?? null, slot: cur.slot ?? null, delivery };
}

/**
 * An urn left on the ground walks back after this long (misc.vdata
 * `citadel_item_pickup_idol.m_WalkBackModifier.m_flWaitTimeLimit`). On 129738985 the 25:00 urn
 * landed at 25:12.5 and set off at 28:13 (timers audit, gap 7).
 */
export const URN_WALK_BACK_S = 180;

/** How far apart (s) two places of the urn on the ground may be and still be one move. */
const URN_GLIDE_S = 2;

/**
 * Where an urn on the ground is at t. Nobody holds it, but after a while it moves on its own
 * (operator, 2026-11-08: the drift is the game's): the worker records it each second it has
 * moved, and it glides between those places as the heroes do. A place further on, or the
 * urn picked up, is a jump.
 */
function groundAt(cur: UrnAt, next: UrnAt | undefined, t: number): { x: number; y: number } | null {
  if (cur.x == null || cur.y == null) return null;
  if (!next || next.state !== "ground" || next.x == null || next.y == null || next.t - cur.t > URN_GLIDE_S) return { x: cur.x, y: cur.y };
  const f = (t - cur.t) / (next.t - cur.t);
  return { x: Math.round(cur.x + (next.x - cur.x) * f), y: Math.round(cur.y + (next.y - cur.y) * f) };
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
 * up, else Destroyed (cleared, or not spawned yet); an urn delivery point is Active while open,
 * else off (Destroyed). The mid boss is `downAt`'s.
 */
export function sitesAt(tl: Timeline, t: number, markers: Array<Pick<Marker, "key" | "kind" | "team" | "at">>): Map<string, "Active" | "Destroyed"> {
  const out = new Map<string, "Active" | "Destroyed">();
  if (!tl.rifts && !tl.powerups && !tl.camps && !tl.urn && !tl.heals && !tl.crates) return out;
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
  // A healing pickup is down while taken, and before it first comes up.
  // So is a heavy box while broken, and before its spawn group first comes up.
  for (const h of [...(tl.heals ?? []), ...(tl.crates ?? [])]) {
    const key = markerKey(h.key, markers);
    if (key) out.set(key, campAt(h, t).state === "alive" ? "Active" : "Destroyed");
  }
  if (tl.urn) {
    for (const m of markers) if (m.kind === "urn") out.set(m.key, "Destroyed");
    const open = urnAt(tl, t)?.delivery;
    const key = open ? markerKey(open, markers) : undefined;
    if (key) out.set(key, "Active");
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

/** Camps, and the healing pickups (same shape, same timers), at t by the timeline's keys (replay
 * tier; empty otherwise). */
export function campsAt(tl: Timeline, t: number): Map<string, CampAt> {
  return new Map([...(tl.camps ?? []), ...(tl.heals ?? []), ...(tl.crates ?? [])].map((c) => [c.key, campAt(c, t)]));
}

const MARKER_KIND: Record<string, Marker["kind"]> = { guardian: "t1", walker: "t2", base_guardian: "barracks", shrine: "shrine", patron: "t3", mid_boss: "midboss", camp: "camp", rift: "koth", powerup: "powerup", urn: "urn", shop: "shop", teleporter: "teleporter", heal: "heal", tough_crate: "crate" };

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

/**
 * Lane shops closed, given the objectives `down`: a team's lane shop closes as its lane's guardian
 * falls (129738985: each `CTriggerItemShop` is deleted and its prop's `m_bIsShopOpen` goes false
 * in the guardian's death second; docs/research/map-objectives-audit.md, "Shops"). A shop belongs
 * to its team's nearest guardian, not to its key's lane: the map's sapphire shops have their
 * `LaneNum` mirrored (`shop_combine_t1_purple` is `LaneNum` 1, beside the lane 6 guardian). The
 * secret shops stay open all match: they're neutral, and no guardian is.
 */
export function shopsClosed(down: Set<string>, markers: Array<Pick<Marker, "key" | "kind" | "team" | "at">>): Set<string> {
  const closed = new Set<string>();
  for (const s of markers) {
    if (s.kind !== "shop") continue;
    let best: { key: string; d: number } | undefined;
    for (const g of markers) {
      if (g.kind !== "t1" || g.team !== s.team) continue;
      const d = Math.hypot(g.at.x - s.at.x, g.at.y - s.at.y);
      if (!best || d < best.d) best = { key: g.key, d };
    }
    if (best && down.has(best.key)) closed.add(s.key);
  }
  return closed;
}

/** A rift site at t (replay tier): its cash-in open (`active`), the other site's open
 * (`elsewhere`), or waiting for the next rift to open, here or at the other site (`next`, by
 * marker key; `null`: none to come in this replay). A rift opens when its cash-in does
 * (`live_s`); before format 2 only the announcement (`start_s`) is known, so that stands in. */
export type RiftAt =
  | { state: "active"; giveUp?: number | null; capture?: RiftCapture | null }
  | { state: "elsewhere" }
  | { state: "waiting"; next: { t: number; key: string } | null };

/** Each team's capture progress (percent, between samples on their straight line), and the team
 * whose reached 100 (`null`: neither yet). */
export interface RiftCapture {
  amber: number;
  sapphire: number;
  captured: "amber" | "sapphire" | null;
}

/** An open rift's capture progress at t (format 3), `null` outside its samples. */
export function captureAt(r: Pick<TimelineRift, "capture">, t: number): RiftCapture | null {
  const rows = r.capture;
  if (!rows?.length) return null;
  const ds = t * 10;
  if (ds < rows[0]![0]) return null;
  let i = 0;
  while (i + 1 < rows.length && rows[i + 1]![0] <= ds) i++;
  const a = rows[i]!;
  const b = rows[i + 1];
  const f = b ? (ds - a[0]) / (b[0] - a[0]) : 0;
  const lerp = (k: 1 | 2) => a[k] + ((b?.[k] ?? a[k]) - a[k]) * f;
  // Captured: the first row where a team's reached 100, from then on.
  const done = rows.slice(0, i + 1).find((x) => x[1] >= 100 || x[2] >= 100);
  return { amber: lerp(1), sapphire: lerp(2), captured: done ? (done[1] >= 100 ? "amber" : "sapphire") : null };
}

export function riftAt(tl: Timeline, key: string, t: number, markers: Array<Pick<Marker, "key" | "kind" | "team" | "at">>): RiftAt | undefined {
  if (!tl.rifts) return undefined;
  const site = (k: string) => markerKey(k, markers) ?? k;
  const opens = (r: TimelineRift) => r.live_s ?? r.start_s;
  const open = tl.rifts.find((r) => t >= opens(r) && t < r.end_s);
  if (open) return site(open.key) === key ? { state: "active", giveUp: open.give_up_s ?? null, capture: captureAt(open, t) } : { state: "elsewhere" };
  const next = tl.rifts.find((r) => opens(r) > t);
  return { state: "waiting", next: next ? { t: opens(next), key: site(next.key) } : null };
}

/** A powerup site at t (replay tier, format 2): its buff up, or the next spawn and its buff
 * (`first`: none has spawned here yet). `undefined` without spawns (older timelines). */
export type PowerupAt = { state: "up"; buff: string } | { state: "down"; first: boolean; next: { t: number; buff: string } | null };

export function powerupAt(p: { spawns?: PowerupSpawn[] | undefined; available: number[] }, t: number): PowerupAt | undefined {
  const sp = p.spawns;
  if (!sp?.length) return undefined;
  const s = Math.floor(t);
  const up = (p.available[Math.max(0, Math.min(p.available.length - 1, s))] ?? 0) === 1;
  const last = [...sp].reverse().find((x) => x.t <= s);
  if (up && last) return { state: "up", buff: last.buff };
  const n = sp.find((x) => x.t > s);
  return { state: "down", first: !last, next: n ? { t: n.t, buff: n.buff } : null };
}

/** A team's Rejuvenator at t: revives left, and when it ends. */
export interface RejuvNow {
  team: "amber" | "sapphire";
  left: number;
  ends: number;
}

/** The Rejuvenators held at t (replay tier, format 3), Amber's first. */
export function rejuvAt(tl: Pick<Timeline, "rejuv">, t: number): RejuvNow[] {
  const out: RejuvNow[] = [];
  for (const r of tl.rejuv ?? []) {
    if (t < r.taken_s || t >= r.ends_s) continue;
    out.push({ team: r.team, left: stepAt(r.left, t) ?? 0, ends: r.ends_s });
  }
  return out.sort((a, b) => (a.team === b.team ? 0 : a.team === "amber" ? -1 : 1));
}

export const clockLabel = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
