// A synthetic 6v6 match for the map-state tests: sight, CC, movement, an urn, two rifts with
// capture, powerups, camps, lanes, objectives' health, a Rejuvenator and two deaths, on the
// replay tier; and the same match as the metadata tier holds it. No names, no real ids.

import { FALLBACK } from "../../src/map/fallback-data";
import { modelFromFallback } from "../../src/map/model";
import type { FrameMarkers } from "../../src/mapstate/frame";
import type { Timeline, TimelinePlayer } from "../../src/match/timeline";

export const model = modelFromFallback(FALLBACK);
export const markers: FrameMarkers = model.markers;
export const keyOf = (kind: string, n = 0) => markers.filter((m) => m.kind === kind)[n]!.key;

export const N = 12; // seconds
export const hero = (team: "amber" | "sapphire", slot: number): TimelinePlayer => {
  const i = (team === "amber" ? 0 : 6) + slot;
  const dies = i === 3 || i === 9;
  const at = (k: number) => (dies && k >= 5 && k < 8 ? null : (team === "amber" ? -1 : 1) * (1000 + 700 * slot) + 150 * k);
  const secs = Array.from({ length: N + 1 }, (_, k) => k);
  return {
    team, slot, hero_id: 10 + i, name: "",
    x: secs.map(at), y: secs.map((k) => (at(k) === null ? null : 300 * slot - 80 * k)),
    health: secs.map((k) => (dies && k >= 5 && k < 8 ? 0 : 100 - 5 * k)), deaths: dies ? [5] : [],
    respawn: dies ? [[5, 7.5]] : [],
    souls: [[0, 400 + 10 * i], [2, 1250 + 100 * i], [9, 4000]],
    ult: secs.map((k) => (k === 0 ? null : Math.max(0, 100 - 20 * k))),
    // In the enemy's sight in bursts that start and end mid-second, off the tenth for one.
    seen: i % 2 ? [[5 + i, 23], [41, 67], [88, 120]] : [[0, 14], [30 + i, 52], [95, 101]],
    cc: [[12 + i, 19 + i, 20, 255, 0], [55, 58, 17, 255, 0], [71, 90, 14, 255, 0]],
    height: [[0, 0], [3, 1], [6, 2], [10, 0]],
    zipline: [[2, 4], [8, 11]],
  } as TimelinePlayer;
};

export const replay = (): Timeline =>
  ({
    match_id: 9, start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, format: 10, reanchored: 0,
    players: (["amber", "sapphire"] as const).flatMap((team) => [0, 1, 2, 3, 4, 5].map((slot) => hero(team, slot))),
    objectives: [
      { key: "walker:amber:lane1:1", kind: "walker", team: "amber", lane: 1, destroyed_s: 6 },
      { key: "guardian:sapphire:lane4", kind: "guardian", team: "sapphire", lane: 4, destroyed_s: 3 },
    ],
    mid_boss: [],
    rifts: [
      { key: keyOf("koth"), start_s: 1, live_s: 2, end_s: 5, give_up_s: 5, capture: [[20, 0, 0], [33, 40, 10], [47, 90, 35]] },
      { key: keyOf("koth", 1), start_s: 7, live_s: 8, end_s: 11, capture: [[80, 0, 0], [105, 20, 80]] },
    ],
    powerups: [
      { key: keyOf("powerup"), available: [0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1], stale: [], spawns: [{ t: 1, buff: "gun", taken_s: 3 }, { t: 6, buff: "spirit", taken_s: 9 }, { t: 12, buff: "gun" }] },
      { key: keyOf("powerup", 1), available: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], stale: [[2, 5]] },
    ],
    zips: [{ lane: "lane1", at: [[0, 500, 500]] }, { lane: "lane4", at: [[0, 425, 574], [2, 480, 520], [7, 300, 300]] }, { lane: "lane6", at: [[0, 0, 1000], [3, 640, 700]] }],
    camps: [
      { key: keyOf("camp", 3), first_s: 1, cleared: [[2, 4], [9, 400]] },
      { key: keyOf("midboss"), first_s: 0, cleared: [[3, 400]] },
    ],
    objective_health: [
      { key: "walker:amber:lane1:1", at: [[0, 100], [2, 80], [4, 35], [6, 0]] },
      { key: "patron:amber", at: [[0, 100], [8, 60]], stage: [[0, 1], [10, 2]] },
    ],
    urn: {
      spawns: [{ t: 1, key: keyOf("urn") }, { t: 10, key: keyOf("urn", 1) }],
      at: [
        { t: 1, state: "ground", x: 10, y: 20, delivery: keyOf("urn", 1) },
        { t: 3, state: "carried", team: "sapphire", slot: 1, delivery: keyOf("urn", 1) },
        { t: 6, state: "ground", x: 700, y: -30, team: "sapphire", slot: 1, delivery: keyOf("urn", 1) },
        { t: 8, state: "none" },
        { t: 10, state: "ground", x: -50, y: 60, delivery: keyOf("urn") },
      ],
    },
    rejuv: [{ team: "sapphire", taken_s: 4, ends_s: 9, left: [[4, 3], [6, 2], [8, 0]] }],
  }) as unknown as Timeline;

const { tier: _t, rifts: _r, powerups: _p, zips: _z, camps: _c, objective_health: _o, urn: _u, rejuv: _j, ...rest } = replay();
// The metadata tier: no replay fields, and no sight (so a team's Vision changes nothing).
export const metadata = { ...rest, source: "metadata", players: rest.players.map(({ seen: _s, cc: _cc, height: _h, zipline: _z, ...p }) => p) } as Timeline;
