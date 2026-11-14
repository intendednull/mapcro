// Player's frame: the match at playback time t as the board draws it (map-state spec §6).
//
// `previewAt` is the definition: everything computed at t. `playerFrame` gives the same value
// from three clocks (TD-50): what the timeline holds per second is computed once a second, what
// it holds per tenth once a tenth, and only places and what is counted from t on every frame.
// A new feature goes on the slowest clock its data allows; `frame-clocks.test.ts` holds that
// the clocked frame equals the definition at every t it tries.

import { type Accessor, createMemo } from "solid-js";
import type { Marker } from "../map/model";
import type { MatchPreview } from "../match/preview";
import { slotKey } from "../match/save";
import {
  type CampAt, type PlayerAt, type PowerupAt, type RejuvNow, type RiftAt, type Timeline,
  campsAt, downAt, lanesAt, markerKey, objectiveHealthAt, playersAt, positionAt, powerupAt, rejuvAt, respawnAt, riftAt, shopsClosed, sitesAt, urnAt,
} from "../match/timeline";
import { type CrowdControl, crowdControlAt } from "../player/cc";
import { movementAt } from "../player/movement";
import { skullsAt } from "../player/skulls";
import { type Vision, hasVision, seenFrom, sightAt } from "../player/vision";

export type FrameMarkers = Array<Pick<Marker, "key" | "kind" | "team" | "lane" | "at">>;

/** The viewer's choices (never part of the frame's facts: spec §3, D9). */
export interface Shown {
  health: boolean;
  names: boolean;
  vision: Vision;
  lastSeen: boolean;
  movement: boolean;
  cc: boolean;
}

/** What the timeline holds per whole second, unfiltered: the same at every t of that second. */
export interface SecondPart {
  /** Each hero's samples; its place and respawn time are the frame's. */
  heroes: PlayerAt[];
  movement: Array<ReturnType<typeof movementAt> | undefined>;
  down: Set<string>;
  shops: Set<string>;
  sites: Map<string, "Active" | "Destroyed">;
  lanes: Map<string, { amber: number; sapphire: number }>;
  camps: Map<string, CampAt>;
  powerups: Map<string, PowerupAt>;
  /** Replay tier only. */
  health: Map<string, { pct: number; stage?: number }> | undefined;
  rejuv: RejuvNow[] | undefined;
}

/** What the timeline holds per tenth of a second, unfiltered. */
export interface TenthPart {
  /** Each hero's `sightAt`. */
  sight: Array<true | number | null>;
  cc: Array<CrowdControl | undefined>;
}

/** Everything by the board's marker keys: a pack can key a site differently from the timeline
 * (match/timeline.ts `markerKey`). */
function byMarker<V>(src: Map<string, V>, markers: FrameMarkers): Map<string, V> {
  const out = new Map<string, V>();
  for (const [k, v] of src) {
    const key = markerKey(k, markers);
    if (key) out.set(key, v);
  }
  return out;
}

/** The second's part at `t` (any t of the second gives the same). */
export function secondPart(m: Timeline, t: number, markers: FrameMarkers): SecondPart {
  const replay = m.tier === "replay";
  const powerups = new Map<string, PowerupAt>();
  for (const p of m.powerups ?? []) {
    const v = powerupAt(p, t);
    const key = markerKey(p.key, markers);
    if (v && key) powerups.set(key, v);
  }
  const down = downAt(m, t, markers);
  return {
    heroes: playersAt(m, t),
    movement: m.players.map((p) => (replay ? movementAt(p, t) : undefined)),
    down,
    shops: shopsClosed(down, markers),
    sites: sitesAt(m, t, markers),
    lanes: lanesAt(m, t),
    camps: byMarker(campsAt(m, t), markers),
    powerups,
    health: replay ? byMarker(objectiveHealthAt(m, t), markers) : undefined,
    rejuv: m.rejuv ? rejuvAt(m, t) : undefined,
  };
}

/** The tenth's part at `t`. Asked at the middle of t's tenth, so every t of the tenth gives the
 * same whatever its rounding. */
export function tenthPart(m: Timeline, t: number): TenthPart {
  const ds = Math.floor(t * 10);
  const mid = (ds + 0.5) / 10;
  return { sight: m.players.map((p) => sightAt(p, ds + 0.5)), cc: m.players.map((p) => crowdControlAt(p, mid)) };
}

/** `playersAt(m, t)` from the samples of t's second (`playersAt(m, Math.floor(t))`): a hero's
 * samples are the second's; its place and its respawn time are counted from t. */
export function heroesAt(m: Timeline, t: number, samples: PlayerAt[]): PlayerAt[] {
  return samples.map((x, i) => ({ ...x, pos: positionAt(m.players[i]!, t), respawn: respawnAt(m.players[i]!, t) }));
}

const EMPTY = (): MatchPreview => ({ players: new Map(), down: new Set(), sites: new Map(), lanes: new Map(), camps: new Map(), rifts: new Map(), powerups: new Map() });

/**
 * The match at `at` as the board draws it under the viewer's choices. `sec` and `tenth`: the
 * parts for at's second and tenth, when the caller holds them (`playerFrame`); computed here
 * otherwise, which is the definition.
 */
export function previewAt(m: Timeline, at: number, markers: FrameMarkers, shown: Shown, fade: boolean, sec: SecondPart = secondPart(m, at, markers), tenth: TenthPart = tenthPart(m, at)): MatchPreview {
  const replay = m.tier === "replay";
  const health = shown.health && replay;
  // One team's view: its enemies as it saw them. Out of sight: not drawn, or, with Show last
  // seen location, a ghost where last seen; one not seen since it came into the match,
  // never drawn.
  const view = shown.vision !== "all" && hasVision(m) ? shown.vision : null;
  const seen = (i: number) => seenFrom(m.players[i]!, at, tenth.sight[i]!);
  const players: MatchPreview["players"] = new Map(
    sec.heroes.map((x, i) => {
      const p = m.players[i]!;
      const pos = positionAt(p, at);
      const base = { hero: x.hero_id, name: shown.names ? x.name : null, pos, health: health ? x.health : null, respawn: respawnAt(p, at) };
      const s = view && x.team !== view ? seen(i) : { seen: true as const };
      // Only living heroes currently in sight receive live status. Never attach it to
      // last-seen ghosts: that would reveal a new effect applied outside the team's view.
      if (s?.seen) return [slotKey(x.team, x.slot), { ...base, ...(shown.movement && replay && pos ? sec.movement[i] : {}), ...(shown.cc && replay && pos ? { cc: tenth.cc[i] } : {}) }];
      return [slotKey(x.team, x.slot), shown.lastSeen && s ? { ...base, pos: s.at, health: null, ghost: s.ago } : { ...base, pos: null, health: null, ghost: null, unseen: true }];
    }),
  );
  const u = urnAt(m, at);
  const site = (k: string | null | undefined) => (k ? (markerKey(k, markers) ?? null) : null);
  // In one team's view, an urn carried by an enemy out of its sight isn't drawn: where it is
  // would give the carrier away (operator 2026-11-09), ghost or undrawn alike: the urn never
  // follows a ghost. `at: null` draws nothing and can't be hovered (Urn.tsx, Camps.tsx).
  const carrier = u?.state === "carried" && view && u.team !== view ? m.players.findIndex((q) => q.team === u.team && q.slot === u.slot) : -1;
  const unseen = carrier >= 0 && !seen(carrier)?.seen;
  const urn = u ? { ...u, ...(unseen ? { at: null, unseen: true } : {}), delivery: site(u.delivery), next: u.next ? { t: u.next.t, key: site(u.next.key) ?? u.next.key } : null } : undefined;
  const rifts = new Map<string, RiftAt>();
  if (m.rifts) for (const mk of markers) if (mk.kind === "koth") rifts.set(mk.key, riftAt(m, mk.key, at, markers)!);
  // A death the view saw: a skull fading where it fell (spec §6b "Death skulls").
  const skulls = skullsAt(m.players, at, view);
  return {
    fade, skulls, players, down: sec.down, shops: sec.shops, sites: sec.sites, lanes: sec.lanes, camps: sec.camps, rifts, powerups: sec.powerups,
    ...(health ? { health: sec.health! } : {}), ...(urn ? { urn } : {}), ...(sec.rejuv ? { rejuv: sec.rejuv } : {}),
  };
}

export interface FrameSource {
  tl: Accessor<Timeline | undefined>;
  t: Accessor<number>;
  markers: Accessor<FrameMarkers>;
  shown: Accessor<Shown>;
  /** Whether this moment continues the last in playback (`MatchPreview.fade`). */
  fade: Accessor<boolean>;
}

/**
 * Player's frame on three clocks: the second's part is computed when t enters a new second, the
 * tenth's when it enters a new tenth, the rest every frame. Empty with no timeline. Call inside
 * a component or root.
 */
export function playerFrame(src: FrameSource): Accessor<MatchPreview> {
  const second = createMemo(() => Math.floor(src.t()));
  const tenth = createMemo(() => Math.floor(src.t() * 10));
  const sec = createMemo(() => {
    const m = src.tl();
    return m && secondPart(m, second(), src.markers());
  });
  const ten = createMemo(() => {
    const m = src.tl();
    return m && tenthPart(m, (tenth() + 0.5) / 10);
  });
  return () => {
    const m = src.tl();
    const [s, d] = [sec(), ten()];
    return m && s && d ? previewAt(m, src.t(), src.markers(), src.shown(), src.fade(), s, d) : EMPTY();
  };
}
