// Player's frame parts: what the timeline holds per second and per tenth, unfiltered (map-state
// spec §6). Player's state (`state.ts` `fromTimeline`) rests on these three clocks (TD-50), and
// Save as scene captures from them too. The test-only reference definition (`previewAt`,
// `MatchPreview`) lives in `web/test/support/player-frame.ts` (TD-140).

import type { Marker } from "../map/model";
import {
  type CampAt, type DoorNow, type PlayerAt, type PowerupAt, type RejuvNow, type Timeline,
  campAt, campsAt, doorsAt, downAt, lanesAt, markerKey, objectiveHealthAt, playersAt, powerupAt, rejuvAt, shopsClosed, sitesAt,
} from "../match/timeline";
import { type CrowdControl, crowdControlAt } from "../player/cc";
import { movementAt } from "../player/movement";
import { type Vision, sightAt } from "../player/vision";

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
  /** The Mid-Boss's camp state from the timeline, independent of whether the pack has a midboss marker. */
  bossCamp: CampAt | undefined;
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
  doors: DoorNow[];
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

/** What Save as scene captures of the second's part (match/save.ts): the heroes' samples, what
 * is down, the sites and the lanes. The second's part is built on it, so the two can't differ;
 * a save computes no more than it stores. */
export type SavedPart = Pick<SecondPart, "heroes" | "down" | "sites" | "lanes">;
export function savedPart(m: Timeline, t: number, markers: FrameMarkers): SavedPart {
  return { heroes: playersAt(m, t), down: downAt(m, t, markers), sites: sitesAt(m, t, markers), lanes: lanesAt(m, t) };
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
  const saved = savedPart(m, t, markers);
  const boss = m.camps?.find((c) => c.key.startsWith("mid_boss:"));
  return {
    ...saved,
    movement: m.players.map((p) => (replay ? movementAt(p, t) : undefined)),
    shops: shopsClosed(saved.down, markers),
    camps: byMarker(campsAt(m, t), markers),
    bossCamp: boss ? campAt(boss, t) : undefined,
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
  return {
    sight: m.players.map((p) => sightAt(p, ds + 0.5)),
    cc: m.players.map((p) => crowdControlAt(p, mid)),
    doors: doorsAt(m, ds + 0.5),
  };
}
