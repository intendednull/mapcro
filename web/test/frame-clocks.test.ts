// Player's frame on three clocks (map-state spec §6, TD-50; mapstate/frame.ts).
//
// 1. The definition (`previewAt`, everything computed at t) is what Player drew before the
//    clocks: `before` below is `host.preview` as it was at a0774c5, kept here as the oracle.
// 2. The clocked frame equals the definition at every t tried: what is asked once a second or
//    once a tenth gives the same as asking at t.
// 3. The clocks hold: the second's and the tenth's parts are not recomputed on every frame.
//
// The match is made up (no names, no ids; 6v6).
import { describe, expect, it, vi } from "vitest";

// The browser build: the reactive one (node resolves solid-js to the server's, which doesn't
// track). For this file's imports, the sources' too.
vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { readFileSync } from "node:fs";
import { createRoot, createSignal } from "solid-js";
import { FALLBACK } from "../src/map/fallback-data";
import { modelFromFallback } from "../src/map/model";
import { type FrameMarkers, type Shown, heroesAt, playerFrame, previewAt } from "../src/mapstate/frame";
import type { MatchPreview } from "../src/match/preview";
import { slotKey } from "../src/match/save";
import { type CampAt, type PowerupAt, type RiftAt, type Timeline, type TimelinePlayer, campsAt, downAt, lanesAt, markerKey, objectiveHealthAt, playersAt, powerupAt, rejuvAt, riftAt, shopsClosed, sitesAt, urnAt } from "../src/match/timeline";
import { crowdControlAt } from "../src/player/cc";
import { movementAt } from "../src/player/movement";
import { skullsAt } from "../src/player/skulls";
import { hasVision, seenAt } from "../src/player/vision";

const model = modelFromFallback(FALLBACK);
const markers: FrameMarkers = model.markers;
const keyOf = (kind: string, n = 0) => markers.filter((m) => m.kind === kind)[n]!.key;

/** `host.preview` as it was before the clocks (a0774c5), with the viewer's choices as `shown`. */
function before(m: Timeline, at: number, shown: Shown, fade: boolean): MatchPreview {
  const health = shown.health && m.tier === "replay";
  const view = shown.vision !== "all" && hasVision(m) ? shown.vision : null;
  const ghosts = shown.lastSeen;
  const players = new Map(
    playersAt(m, at).map((x, i) => {
      const base = { hero: x.hero_id, name: shown.names ? x.name : null, pos: x.pos, health: health ? x.health : null, respawn: x.respawn };
      const s = view && x.team !== view ? seenAt(m.players[i]!, at) : { seen: true as const };
      if (s?.seen) return [slotKey(x.team, x.slot), { ...base, ...(shown.movement && m.tier === "replay" && x.pos ? movementAt(m.players[i]!, at) : {}), ...(shown.cc && m.tier === "replay" && x.pos ? { cc: crowdControlAt(m.players[i]!, at) } : {}) }];
      return [slotKey(x.team, x.slot), ghosts && s ? { ...base, pos: s.at, health: null, ghost: s.ago } : { ...base, pos: null, health: null, ghost: null, unseen: true }];
    }),
  );
  const byMarker = <V,>(src: Map<string, V>) => {
    const out = new Map<string, V>();
    for (const [k, v] of src) {
      const key = markerKey(k, markers);
      if (key) out.set(key, v);
    }
    return out;
  };
  const camps: Map<string, CampAt> = byMarker(campsAt(m, at));
  const u = urnAt(m, at);
  const site = (k: string | null | undefined) => (k ? (markerKey(k, markers) ?? null) : null);
  const carrier = u?.state === "carried" && view && u.team !== view ? m.players.findIndex((q) => q.team === u.team && q.slot === u.slot) : -1;
  const unseen = carrier >= 0 && !seenAt(m.players[carrier]!, at)?.seen;
  const urn = u ? { ...u, ...(unseen ? { at: null, unseen: true } : {}), delivery: site(u.delivery), next: u.next ? { t: u.next.t, key: site(u.next.key) ?? u.next.key } : null } : undefined;
  const rifts = new Map<string, RiftAt>();
  if (m.rifts) for (const mk of markers) if (mk.kind === "koth") rifts.set(mk.key, riftAt(m, mk.key, at, markers)!);
  const powerups = new Map<string, PowerupAt>();
  for (const p of m.powerups ?? []) {
    const v = powerupAt(p, at);
    const key = markerKey(p.key, markers);
    if (v && key) powerups.set(key, v);
  }
  const down = downAt(m, at, markers);
  const skulls = skullsAt(m.players, at, view);
  return { fade, skulls, players, down, shops: shopsClosed(down, markers), sites: sitesAt(m, at, markers), lanes: lanesAt(m, at), camps, rifts, powerups, ...(health ? { health: byMarker(objectiveHealthAt(m, at)) } : {}), ...(urn ? { urn } : {}), ...(m.rejuv ? { rejuv: rejuvAt(m, at) } : {}) } as MatchPreview;
}

const N = 12; // seconds
const hero = (team: "amber" | "sapphire", slot: number): TimelinePlayer => {
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

const replay = (): Timeline =>
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
const metadata = { ...rest, source: "metadata", players: rest.players.map(({ seen: _s, cc: _cc, height: _h, zipline: _z, ...p }) => p) } as Timeline;

/** Times that land on, just before and just after seconds and tenths, and between them. */
const times = (duration: number, step: number) => {
  const out: number[] = [];
  for (let k = 0; k * step <= duration; k++) out.push(k * step);
  for (let d = 0; d <= duration * 10; d++) out.push(d / 10, d * 0.1, d / 10 + 1e-9, Math.max(0, d / 10 - 1e-9));
  return out;
};
const SHOWN: Shown[] = [
  { health: true, names: true, vision: "all", lastSeen: false, movement: true, cc: true },
  { health: true, names: false, vision: "amber", lastSeen: true, movement: true, cc: true },
  { health: false, names: true, vision: "sapphire", lastSeen: false, movement: false, cc: false },
  { health: true, names: true, vision: "sapphire", lastSeen: true, movement: true, cc: true },
];
/** `playerFrame` driven by hand: set the time and the choices, read the frame. */
const clocks = (m: Timeline) =>
  createRoot((dispose) => {
    const [t, setT] = createSignal(0);
    const [shown, setShown] = createSignal(SHOWN[0]!);
    const frame = playerFrame({ tl: () => m, t, markers: () => markers, shown, fade: () => true });
    return { at: (time: number, view: Shown) => (setShown(view), setT(time), frame()), dispose };
  });

describe("Player's frame", () => {
  it("the synthetic match has what the clocks split: sight, CC, movement, an urn, rifts, a Rejuvenator", () => {
    const m = replay();
    expect(m.players).toHaveLength(12);
    expect(hasVision(m)).toBe(true);
    const all = SHOWN.flatMap((shown) => times(N, 0.037).map((t) => before(m, t, shown, true)));
    expect(all.some((f) => [...f.players.values()].some((p) => p.ghost != null))).toBe(true);
    expect(all.some((f) => [...f.players.values()].some((p) => p.unseen))).toBe(true);
    expect(all.some((f) => [...f.players.values()].some((p) => p.cc))).toBe(true);
    expect(all.some((f) => [...f.players.values()].some((p) => p.zipline))).toBe(true);
    expect(all.some((f) => f.urn?.unseen)).toBe(true);
    expect(all.some((f) => (f.skulls?.length ?? 0) > 0)).toBe(true);
    expect(all.some((f) => (f.rejuv?.length ?? 0) > 0)).toBe(true);
    expect(all.some((f) => [...(f.rifts ?? new Map()).values()].some((r: RiftAt) => r.state === "active" && r.capture))).toBe(true);
    expect(all.some((f) => f.down.size > 0 && (f.shops?.size ?? 0) > 0)).toBe(true);
  });

  for (const [name, make] of [["replay", replay], ["metadata", () => metadata]] as const)
    it(`the definition is what Player drew before the clocks, and the clocks give the definition (${name} tier)`, () => {
      const m = make();
      const clocked = clocks(m);
      let n = 0;
      for (const shown of SHOWN)
        for (const t of times(N, 0.037)) {
          const want = before(m, t, shown, true);
          expect(previewAt(m, t, markers, shown, true), `definition at ${t}`).toEqual(want);
          const got = clocked.at(t, shown);
          expect(got, `clocked at ${t}`).toEqual(want);
          // The top bar's heroes: the second's samples with the frame's place and respawn time.
          expect(heroesAt(m, t, playersAt(m, Math.floor(t)))).toEqual(playersAt(m, t));
          // Objectives' health is the replay tier's, under Health only: else not there at all.
          expect("health" in got).toBe(name === "replay" && shown.health);
          n++;
        }
      expect(n).toBeGreaterThan(2000);
      clocked.dispose();
    });

  it("is empty with no timeline, and follows the viewer's choices and the match", () => {
    createRoot((dispose) => {
      const [tl, setTl] = createSignal<Timeline | undefined>();
      const [t, setT] = createSignal(4.25);
      const [shown, setShown] = createSignal(SHOWN[0]!);
      const frame = playerFrame({ tl, t, markers: () => markers, shown, fade: () => false });
      expect(frame().players.size).toBe(0);
      expect(frame().down.size).toBe(0);
      const m = replay();
      setTl(m);
      expect(frame()).toEqual(before(m, 4.25, SHOWN[0]!, false));
      setShown(SHOWN[1]!);
      expect(frame()).toEqual(before(m, 4.25, SHOWN[1]!, false));
      setT(9.9);
      expect(frame()).toEqual(before(m, 9.9, SHOWN[1]!, false));
      setTl(metadata);
      expect(frame()).toEqual(before(metadata, 9.9, SHOWN[1]!, false));
      dispose();
    });
  });

  it("asks the timeline for a second's samples once a second and a tenth's once a tenth, not every frame", () => {
    createRoot((dispose) => {
      const m = replay();
      // Reads of one hero's per-second, per-tenth and per-frame series, counted.
      const reads = { souls: 0, cc: 0, seen: 0, x: 0 };
      const p = m.players[7]!;
      for (const k of Object.keys(reads) as (keyof typeof reads)[]) {
        const v = p[k];
        Object.defineProperty(p, k, { get: () => (reads[k]++, v) });
      }
      const [t, setT] = createSignal(3);
      const frame = playerFrame({ tl: () => m, t, markers: () => markers, shown: () => SHOWN[3]!, fade: () => true });
      // 120 frames across two seconds (3.0 to just under 5.0), read as the board reads it.
      const frames: Array<[number, MatchPreview]> = [];
      for (let f = 0; f < 120; f++) {
        setT(3 + f / 60);
        frames.push([t(), frame()]);
      }
      const read = { ...reads };
      // Each frame is the definition's.
      for (const [at, now] of frames) expect(now, `frame at ${at}`).toEqual(before(m, at, SHOWN[3]!, true));
      const parts = new Set(frames.map(([, now]) => now.down));
      // The second's part: two seconds, two computations (the same sets handed on between).
      expect(parts.size).toBe(2);
      expect(read.souls).toBe(2);
      // The tenth's part: twenty tenths. `crowdControlAt` reads `cc` once per state it tries (3).
      expect(read.cc).toBeLessThanOrEqual(20 * 3);
      expect(read.cc).toBeGreaterThanOrEqual(20);
      // `seen` is also read by `hasVision` (the first hero with any answers it), so only the scan
      // counts here: once a tenth.
      expect(read.seen).toBe(20);
      // Places are the frame's.
      expect(read.x).toBeGreaterThanOrEqual(120);
      dispose();
    });
  });

  // A real timeline, when one is given (it holds names: nothing of it is printed, only counts).
  it.skipIf(!process.env.MAPCRO_TIMELINE)("on a real match, the clocks give the definition at every tenth and between", () => {
    const m = JSON.parse(readFileSync(process.env.MAPCRO_TIMELINE!, "utf8")) as Timeline;
    let differ = 0;
    let n = 0;
    const step = Number(process.env.MAPCRO_TIMELINE_STEP ?? 0.37);
    const clocked = clocks(m);
    for (const shown of [SHOWN[1]!, SHOWN[3]!])
      for (let t = 0; t <= m.duration_s; t += step) {
        n++;
        try {
          expect(clocked.at(t, shown)).toEqual(before(m, t, shown, true));
          expect(heroesAt(m, t, playersAt(m, Math.floor(t)))).toEqual(playersAt(m, t));
          expect(rejuvAt(m, Math.floor(t))).toEqual(rejuvAt(m, t));
        } catch {
          differ++;
        }
      }
    console.log(`frames compared: ${n}, differing: ${differ}`);
    expect(differ).toBe(0);
    // What a frame costs to compute, late in the match (60 frames a second for ten seconds).
    const from = Math.max(0, m.duration_s - 120);
    const run = (f: (t: number) => unknown) => {
      const start = performance.now();
      for (let k = 0; k < 600; k++) f(from + k / 60);
      return (performance.now() - start) / 600;
    };
    const was = run((t) => (before(m, t, SHOWN[3]!, true), playersAt(m, t), rejuvAt(m, t)));
    let held = { s: -1, heroes: playersAt(m, 0) };
    const is = run((t) => {
      if (held.s !== Math.floor(t)) held = { s: Math.floor(t), heroes: playersAt(m, Math.floor(t)) };
      return [clocked.at(t, SHOWN[3]!), heroesAt(m, t, held.heroes)];
    });
    console.log(`ms a frame (the map's frame and the bar's heroes): before ${was.toFixed(3)}, on the clocks ${is.toFixed(3)}`);
    clocked.dispose();
  });
});
