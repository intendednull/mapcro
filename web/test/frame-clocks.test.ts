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
import { createComputed, createRoot, createSignal } from "solid-js";
import { type FrameMarkers, type Shown, savedPart, secondPart, tenthPart } from "../src/mapstate/frame";
import { FEATURES, type PlayerState, featuresOf, fromTimeline, sameValue, urnOf } from "../src/mapstate/state";
import { buildAt } from "../src/match/builds";
import { statBuild } from "../src/match/stats";
import { sameBuild, sameStatBuild, tenthOf } from "../src/player/buildState";
import { type MatchPreview, previewAt } from "./support/player-frame";
import { matchSceneOps, slotKey } from "../src/match/save";
import { type CampAt, type PowerupAt, type RiftAt, type Timeline, type TimelinePlayer, campsAt, downAt, lanesAt, markerKey, objectiveHealthAt, playersAt, powerupAt, rejuvAt, riftAt, scoreboardValueAt, shopsClosed, sitesAt, urnAt } from "../src/match/timeline";
import { crowdControlAt } from "../src/player/cc";
import { markerStates } from "../src/player/markerStates";
import { movementAt } from "../src/player/movement";
import { deathSeen, skullsAt } from "../src/player/skulls";
import { hasVision, seenAt } from "../src/player/vision";

import { heroesAt, playerFrame } from "./support/player-frame";
import { N, keyOf, markers, metadata, model, replay } from "./support/synthetic-match";

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


/** What the map showed for a marker from the frame, as `markerStates` did before it read `MapState`. */
function shownStatus(pv: MatchPreview, k: string) {
  if (k.startsWith("shop:")) return pv.shops?.has(k) ? "Hidden" : undefined;
  const site = pv.sites.get(k);
  if (site) return site;
  if (k.startsWith("rift:") || k.startsWith("urn:")) return "Destroyed";
  if (pv.down.has(k)) return "Destroyed";
  return pv.health?.get(k)?.stage === 2 ? "Stage2" : "Active";
}
const buffOf = (pv: MatchPreview, k: string) => {
  const b = pv.powerups?.get(k);
  return b?.state === "up" ? b.buff : undefined;
};

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

  // ---- MapState (spec §6): the same frame as fields, unfiltered, each on its clock ----

  /** Player's state driven by hand. */
  const stateOf = (m: Timeline | undefined, at = 0) =>
    createRoot((dispose) => {
      const [tl, setTl] = createSignal(m);
      const [t, setT] = createSignal(at);
      const state: PlayerState = fromTimeline({ tl, t, markers: () => markers });
      return { state, setT, setTl, dispose };
    });
  const SLOTS = (["amber", "sapphire"] as const).flatMap((team) => [0, 1, 2, 3, 4, 5].map((slot) => slotKey(team, slot)));
  const ALL: Shown = { health: true, names: true, vision: "all", lastSeen: false, movement: true, cc: true };
  /** Every field of the state at t, as plain values. */
  const fieldsOf = (state: PlayerState) => ({
    heroes: SLOTS.map((slot) => Object.fromEntries(Object.entries(state.hero(slot)).map(([k, f]) => [k, (f as () => unknown)()]))),
    markers: markers.map((mk) => Object.fromEntries(Object.entries(state.marker(mk.key)).map(([k, f]) => [k, (f as () => unknown)()]))),
    lanes: model.lanes.map((l) => state.lane(l.key).edges()),
    urn: state.scene().urn(),
    rejuv: state.scene().rejuv(),
    deaths: state.scene().deaths(),
  });
  /** The same from the timeline at t: each field's definition. */
  const definitionOf = (m: Timeline, t: number) => {
    const replayTier = m.tier === "replay";
    const sighted = hasVision(m);
    const all = before(m, t, ALL, true);
    const samples = playersAt(m, t);
    return {
      heroes: m.players.map((p, i) => {
        const x = samples[i]!;
        const s = sighted ? seenAt(p, t) : ({ seen: true } as const);
        const move = replayTier ? movementAt(p, t) : undefined;
        return {
          present: true, hero: p.hero_id, name: p.name ?? null, alive: x.pos !== null, pos: x.pos, last: x.last, respawn: x.respawn,
          souls: x.souls, ult: x.ult, health: x.health,
          inSight: s?.seen === true,
          lastSeen: s && !s.seen ? { at: s.at, ago: s.ago } : null,
          cc: replayTier ? crowdControlAt(p, t) : undefined,
          height: move?.height, zipline: move?.zipline ?? false,
        };
      }),
      markers: markers.map((mk) => ({
        down: all.down.has(mk.key), site: all.sites.get(mk.key), shopClosed: all.shops!.has(mk.key), camp: all.camps.get(mk.key), powerup: all.powerups!.get(mk.key),
        health: all.health?.get(mk.key), rift: all.rifts!.get(mk.key),
      })),
      lanes: model.lanes.map((l) => all.lanes.get(l.key)),
      urn: all.urn,
      rejuv: all.rejuv,
      deaths: skullsAt(m.players, t, null).map((d) => ({ ...d, seen: deathSeen(m.players.find((p) => slotKey(p.team, p.slot) === d.slot)!, d.t) })),
    };
  };

  /** The replay with one of its two deaths out of the enemy's sight. */
  const unseenDeath = () => {
    const m = replay();
    m.players[9]!.seen = [[0, 14]];
    return m;
  };
  /** The metadata tier carrying the replay's hero series: they are the replay tier's alone. */
  const metadataWithSeries = () => ({ ...metadata, players: metadata.players.map((p, i) => ({ ...p, cc: replay().players[i]!.cc, height: replay().players[i]!.height, zipline: replay().players[i]!.zipline })) }) as Timeline;
  for (const [name, make] of [["replay", replay], ["replay, a death unseen", unseenDeath], ["metadata", () => metadata], ["metadata with CC and movement rows", metadataWithSeries]] as const)
    it(`MapState: every field is its definition at t, whatever the viewer chose (${name} tier)`, () => {
      const m = make();
      const { state, setT, dispose } = stateOf(m);
      let n = 0;
      for (const t of times(N, 0.037)) {
        setT(t);
        expect(fieldsOf(state), `fields at ${t}`).toEqual(definitionOf(m, t));
        n++;
      }
      expect(n).toBeGreaterThan(500);
      dispose();
    });

  it("MapState: the synthetic match moves every field, so the comparison above holds something", () => {
    const m = replay();
    const all = times(N, 0.37).map((t) => definitionOf(m, t));
    const seen = <T,>(pick: (d: (typeof all)[number]) => T[]) => new Set(all.flatMap(pick).map((v) => JSON.stringify(v ?? null))).size;
    for (const k of ["alive", "pos", "last", "respawn", "souls", "ult", "health", "inSight", "lastSeen", "cc", "height", "zipline"] as const) expect(seen((d) => d.heroes.map((h) => h[k])), k).toBeGreaterThan(1);
    for (const k of ["down", "site", "shopClosed", "camp", "powerup", "health", "rift"] as const) expect(seen((d) => d.markers.map((mk) => mk[k])), k).toBeGreaterThan(1);
    expect(seen((d) => d.lanes)).toBeGreaterThan(1);
    expect(seen((d) => [d.urn])).toBeGreaterThan(1);
    expect(seen((d) => [d.rejuv])).toBeGreaterThan(1);
    expect(seen((d) => [d.deaths])).toBeGreaterThan(1);
    // A death its enemies saw, and one they didn't.
    expect(new Set(times(N, 0.37).flatMap((t) => definitionOf(unseenDeath(), t).deaths.map((x) => `${x.slot} ${x.seen}`)))).toEqual(new Set(["amber-3 true", "sapphire-3 false"]));
    expect(sameValue(0, -0)).toBe(false);
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true);
  });

  it("MapState: a slot, marker or lane the match doesn't have is empty; so is everything with no timeline", () => {
    const m = replay();
    const { state, setTl, dispose } = stateOf(m, 4.25);
    const none = { present: false, hero: null, name: null, alive: false, pos: null, last: null, respawn: null, souls: null, ult: null, health: null, inSight: true, lastSeen: null, cc: undefined, height: undefined, zipline: false };
    const noMarker = { down: false, site: undefined, shopClosed: false, camp: undefined, powerup: undefined, health: undefined, rift: undefined };
    const values = (o: object) => Object.fromEntries(Object.entries(o).map(([k, f]) => [k, (f as () => unknown)()]));
    expect(values(state.hero("amber-9"))).toEqual(none);
    expect(values(state.marker("nothing:here"))).toEqual(noMarker);
    expect(state.lane("lane9").edges()).toBeUndefined();
    // The same entity each time it is asked: its memos are made once.
    expect(state.hero("amber-0")).toBe(state.hero("amber-0"));
    expect(state.marker(keyOf("koth"))).toBe(state.marker(keyOf("koth")));
    expect(state.lane("lane1")).toBe(state.lane("lane1"));
    expect(state.hero("amber-0").present()).toBe(true);
    setTl(undefined);
    expect(values(state.hero("amber-0"))).toEqual(none);
    expect(values(state.marker(keyOf("koth")))).toEqual(noMarker);
    expect(state.lane("lane1").edges()).toBeUndefined();
    expect([state.scene().urn(), state.scene().rejuv(), state.scene().deaths()]).toEqual([undefined, undefined, []]);
    expect(FEATURES.map((f) => state.has(f))).toEqual(FEATURES.map(() => false));
    expect([state.second(), state.tenth()]).toEqual([undefined, undefined]);
    // The match back: the same entities read it.
    setTl(metadata);
    expect(state.hero("amber-0").hero()).toBe(metadata.players[0]!.hero_id);
    dispose();
  });

  it("MapState: says which features the match holds", () => {
    const full = stateOf(replay());
    expect(Object.fromEntries(FEATURES.map((f) => [f, full.state.has(f)]))).toEqual({ health: true, sight: true, cc: true, movement: true, lanes: true, skulls: true, camps: true, powerups: true, obj_health: true, rifts: true, urn: true, rejuv: true });
    full.dispose();
    const bare = stateOf(metadata);
    expect(FEATURES.filter((f) => bare.state.has(f))).toEqual(["skulls"]);
    bare.dispose();
    // Each alone: a replay with only that data.
    const only = (over: Partial<Timeline>, players?: (p: TimelinePlayer) => TimelinePlayer) => {
      const s = stateOf({ ...metadata, tier: "replay", ...over, players: metadata.players.map((p) => (players ? players(p) : p)) } as Timeline);
      const has = FEATURES.filter((f) => s.state.has(f));
      s.dispose();
      return has;
    };
    const full12 = replay();
    expect(only({})).toEqual(["health", "skulls"]);
    expect(only({}, (p) => ({ ...p, seen: [[0, 5]] }) as TimelinePlayer)).toEqual(["health", "sight", "skulls"]);
    expect(only({}, (p) => ({ ...p, cc: [[1, 2, 20, 255, 0]] }) as TimelinePlayer)).toEqual(["health", "cc", "skulls"]);
    expect(only({}, (p) => ({ ...p, height: [[0, 1]] }) as TimelinePlayer)).toEqual(["health", "movement", "skulls"]);
    expect(only({}, (p) => ({ ...p, zipline: [[0, 1]] }) as TimelinePlayer)).toEqual(["health", "movement", "skulls"]);
    expect(only({ zips: full12.zips! })).toEqual(["health", "lanes", "skulls"]);
    expect(only({ camps: full12.camps! })).toEqual(["health", "skulls", "camps"]);
    expect(only({ powerups: full12.powerups! })).toEqual(["health", "skulls", "powerups"]);
    expect(only({ objective_health: full12.objective_health! })).toEqual(["health", "skulls", "obj_health"]);
    expect(only({ rifts: full12.rifts! })).toEqual(["health", "skulls", "rifts"]);
    expect(only({ urn: full12.urn! })).toEqual(["health", "skulls", "urn"]);
    expect(only({ rejuv: full12.rejuv! })).toEqual(["health", "skulls", "rejuv"]);
    // The metadata tier holds none of the tier's own, whatever its heroes carry.
    expect(FEATURES.filter((f) => featuresOf({ ...full12, tier: undefined } as unknown as Timeline)[f])).toEqual(["sight", "lanes", "skulls", "camps", "powerups", "rifts", "urn", "rejuv"]);
  });

  it("MapState: a reader of one field runs when that value changes, not each frame", () => {
    const m = replay();
    const { state, setT, dispose } = stateOf(m, 3);
    createRoot((stop) => {
      const count = (read: () => unknown) => {
        let n = 0;
        createComputed(() => (read(), n++));
        return () => n;
      };
      const h = state.hero("sapphire-1"); // i = 7: souls move at 2 and 9, its place every frame
      const koth = state.marker(keyOf("koth"));
      const readers = {
        souls: count(h.souls), ult: count(h.ult), health: count(h.health), alive: count(h.alive), hero: count(h.hero), pos: count(h.pos), inSight: count(h.inSight), cc: count(h.cc),
        height: count(h.height), zipline: count(h.zipline),
        down: count(state.marker("walker:amber:lane1:1").down), camp: count(state.marker(keyOf("camp", 3)).camp), rift: count(koth.rift), site: count(koth.site),
        lane: count(state.lane("lane4").edges), rejuv: count(state.scene().rejuv), urn: count(state.scene().urn),
      };
      // 120 frames across two seconds (3.0 to just under 5.0).
      for (let f = 0; f < 120; f++) setT(3 + f / 60);
      const n = Object.fromEntries(Object.entries(readers).map(([k, r]) => [k, r()]));
      // Unchanged over the two seconds: read once.
      expect({ souls: n.souls, hero: n.hero, alive: n.alive, down: n.down, lane: n.lane, height: n.height }).toEqual({ souls: 1, hero: 1, alive: 1, down: 1, lane: 1, height: 1 });
      // The second's samples that moved at 4: twice.
      expect({ ult: n.ult, health: n.health, camp: n.camp, zipline: n.zipline, rejuv: n.rejuv }).toEqual({ ult: 2, health: 2, camp: 2, zipline: 2, rejuv: 2 });
      // The tenth's: at most once a tenth, and only when the value moves.
      expect(n.inSight).toBeLessThanOrEqual(3);
      expect(n.cc).toBeLessThanOrEqual(20);
      // The frame's: its place moves every frame; the rift's capture where it moves.
      expect(n.pos).toBeGreaterThanOrEqual(100);
      expect(n.rift).toBeGreaterThan(2);
      expect(n.rift).toBeLessThan(120);
      stop();
    });
    dispose();
  });

  it("MapState: a field nobody reads is never computed: asking who is in sight costs no place, respawn time, urn or death a frame (review S2)", () => {
    const m = replay();
    // Reads of what only the frame's fields read: each hero's places, respawn times and
    // deaths, and the urn.
    const x = m.players.map(() => 0);
    const reads = { respawn: 0, deaths: 0, urn: 0 };
    m.players.forEach((p, i) => {
      const [px, respawn, deaths] = [p.x, p.respawn, p.deaths];
      Object.defineProperty(p, "x", { get: () => (x[i]!++, px) });
      Object.defineProperty(p, "respawn", { get: () => (reads.respawn++, respawn) });
      Object.defineProperty(p, "deaths", { get: () => (reads.deaths++, deaths) });
    });
    const urn = m.urn;
    Object.defineProperty(m, "urn", { get: () => (reads.urn++, urn) });
    const { state, setT, dispose } = stateOf(m, 1);
    createRoot((stop) => {
      // As Player's top bar asks: every hero, and only whether its enemies see it. The entities
      // and the scene's facts are all made; no other field is read.
      for (const slot of SLOTS) createComputed(() => state.hero(slot).inSight());
      for (const mk of markers) state.marker(mk.key);
      state.scene();
      const total = () => x.reduce((a, b) => a + b, 0) + reads.respawn + reads.deaths + reads.urn;
      // 59 more frames of the same second, across six tenths: nothing of the frame's is read.
      const settled = total();
      for (let f = 1; f < 60; f++) setT(1 + f / 60);
      expect(total() - settled).toBe(0);
      // One hero's place read: its series alone, once a frame or so; nobody else's.
      createComputed(() => state.hero("sapphire-1").pos());
      const [mine, others] = [x[7]!, total() - x[7]!];
      for (let f = 1; f < 60; f++) setT(1 + (f + 0.5) / 60);
      expect(x[7]! - mine).toBeGreaterThanOrEqual(59);
      expect(x[7]! - mine).toBeLessThanOrEqual(59 * 4);
      expect(total() - x[7]! - others).toBe(0);
      // The urn read: the urn, and still no other hero's place.
      createComputed(() => state.scene().urn());
      const at = { urn: reads.urn, rest: total() - reads.urn - x[7]! };
      for (let f = 1; f < 60; f++) setT(1 + f / 60);
      expect(reads.urn - at.urn).toBeGreaterThanOrEqual(59);
      expect(total() - reads.urn - x[7]! - at.rest).toBe(0);
      stop();
    });
    dispose();
  });

  it("the map's markers change at most once a second, and with Health, and show the frame's", () => {
    const m = replay();
    createRoot((dispose) => {
      const [t, setT] = createSignal(3);
      const [health, setHealth] = createSignal(true);
      const state = fromTimeline({ tl: () => m, t, markers: () => markers });
      const marks = markerStates({ ms: () => state, player: () => true, health }, () => markers.map((k) => k.key));
      const read = () => markers.map(({ key }) => [marks.status(key), marks.health(key), marks.camp(key), marks.buff(key)]);
      let runs = 0;
      createComputed(() => (read(), runs++));
      const pick = (f: MatchPreview) => markers.map(({ key }) => [shownStatus(f, key), f.health?.get(key)?.pct, f.camps.get(key)?.state, buffOf(f, key)]);
      for (let f = 0; f < 120; f++) {
        setT(3 + f / 60);
        expect(read()).toEqual(pick(before(m, t(), ALL, true)));
      }
      // Across one second's boundary, and only at it.
      expect(runs).toBeLessThanOrEqual(2);
      // Health off: no health, and the patron's stage goes with it, as in the frame.
      setT(11);
      setHealth(false);
      expect(read()).toEqual(pick(before(m, 11, { ...ALL, health: false }, true)));
      expect(markers.every(({ key }) => marks.health(key) === undefined)).toBe(true);
      setHealth(true);
      expect(marks.status(markers.find((k) => k.kind === "t3" && k.team === "amber")!.key)).toBe("Stage2");
      dispose();
    });
    // No timeline: nothing down, rifts off, as the empty frame.
    createRoot((dispose) => {
      const state = fromTimeline({ tl: () => undefined, t: () => 0, markers: () => markers });
      const marks = markerStates({ ms: () => state, player: () => true, health: () => true }, () => markers.map((k) => k.key));
      expect([marks.status(keyOf("koth")), marks.status(keyOf("urn")), marks.status(keyOf("t1")), marks.status(keyOf("shop"))]).toEqual(["Destroyed", "Destroyed", "Active", undefined]);
      expect(markers.every(({ key }) => marks.health(key) === undefined && marks.camp(key) === undefined && marks.buff(key) === undefined)).toBe(true);
      dispose();
    });
    // The metadata tier: no objectives' health, Health on or not; what is down is the frame's.
    createRoot((dispose) => {
      const state = fromTimeline({ tl: () => metadata, t: () => 7, markers: () => markers });
      const marks = markerStates({ ms: () => state, player: () => true, health: () => true }, () => markers.map((k) => k.key));
      const frame = before(metadata, 7, ALL, true);
      expect(markers.every(({ key }) => marks.health(key) === undefined)).toBe(true);
      expect(markers.filter(({ key }) => marks.status(key) === "Destroyed" && !key.startsWith("rift:") && !key.startsWith("urn:")).map((k) => k.key).sort()).toEqual([...frame.down].sort());
      dispose();
    });
  });

  it("Save as scene captures from the second's part: the frame's facts at the whole second", () => {
    const m = replay();
    for (const s of [0, 3, 6, 9, 12]) {
      const part = secondPart(m, s, markers);
      expect(part.heroes).toEqual(playersAt(m, s));
      expect(part.down).toEqual(downAt(m, s, markers));
      expect(part.sites).toEqual(sitesAt(m, s, markers));
      expect(part.lanes).toEqual(lanesAt(m, s));
      // What a save reads is those four of it, the same values, and nothing else of the part.
      expect(savedPart(m, s, markers)).toEqual({ heroes: part.heroes, down: part.down, sites: part.sites, lanes: part.lanes });
      // The tenth's part at the second: each hero's sight as its enemies have it there.
      expect(tenthPart(m, s).sight.map((x) => x === true)).toEqual(m.players.map((p) => seenAt(p, s)?.seen === true));
    }
  });

  it("a save computes no more than it stores: no camp, powerup, objective's health, movement or Rejuvenator is read (review N2)", () => {
    const m = replay();
    const reads: Record<string, number> = {};
    for (const k of ["camps", "powerups", "objective_health", "rejuv", "urn", "rifts"] as const) {
      const v = m[k];
      Object.defineProperty(m, k, { get: () => ((reads[k] = (reads[k] ?? 0) + 1), v) });
    }
    for (const p of m.players) for (const k of ["height", "zipline", "cc", "seen"] as const) {
      const v = p[k];
      Object.defineProperty(p, k, { get: () => ((reads[k] = (reads[k] ?? 0) + 1), v) });
    }
    const roster = m.players.map((p, i) => ({ id: `slot-${i}`, slot: { team: p.team === "amber" ? "Amber" : "Sapphire", slot: p.slot, hero: p.hero_id, name: "" } }));
    let n = 0;
    matchSceneOps(roster as never, [], undefined, m, 6, markers, () => `id${n++}`, [], { builds: false });
    // `sitesAt` asks which of rifts, powerups, camps and the urn the match has, and reads the
    // sites' own series; nothing reads a hero's movement, CC or sight, objectives' health or
    // the Rejuvenator.
    expect(Object.keys(reads).filter((k) => ["height", "zipline", "cc", "seen", "objective_health", "rejuv"].includes(k))).toEqual([]);
    // The second's part reads them all.
    secondPart(m, 6, markers);
    expect(["height", "zipline", "objective_health", "rejuv"].every((k) => (reads[k] ?? 0) > 0)).toBe(true);
  });

  it("sameValue compares plain values through and through", () => {
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(undefined, undefined)).toBe(true);
    expect(sameValue(null, undefined)).toBe(false);
    expect(sameValue(0, null)).toBe(false);
    expect(sameValue({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(sameValue({ x: 1, y: 2 }, { x: 1, y: 3 })).toBe(false);
    expect(sameValue({ x: 1 }, { x: 1, y: undefined })).toBe(false);
    expect(sameValue({ x: 1, y: undefined }, { x: 1, z: undefined })).toBe(false);
    expect(sameValue({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } })).toBe(true);
    expect(sameValue({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 3 }] } })).toBe(false);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue([], {})).toBe(false);
    expect(sameValue({ state: "alive" }, null)).toBe(false);
    expect(sameValue("up", "up")).toBe(true);
  });

  it("the urn's sites are the board's marker keys", () => {
    const m = replay();
    for (const t of [0, 1, 3.5, 6, 8, 10.2]) expect(urnOf(m, t, markers)).toEqual(before(m, t, ALL, true).urn);
    expect(urnOf(metadata, 3, markers)).toBeUndefined();
    // A pack that keys the urn's sites its own way: the urn names the pack's keys.
    const pack = markers.map((mk) => (mk.kind === markers.find((x) => x.key === keyOf("urn"))!.kind ? { ...mk, key: `pack:${mk.key}` } : mk));
    expect(urnOf(m, 1, pack)).toMatchObject({ state: "ground", delivery: `pack:${keyOf("urn", 1)}`, next: { t: 10, key: `pack:${keyOf("urn", 1)}` } });
    expect(urnOf(m, 10.2, pack)).toMatchObject({ delivery: `pack:${keyOf("urn")}`, next: null });
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
    // MapState's fields against their definitions, and a build on the tenth's and the second's
    // clocks against the build and the stats' input at t.
    const real = stateOf(m);
    let fields = 0, fieldsDiffer = 0, builds = 0, buildsDiffer = 0;
    for (let t = 0; t <= m.duration_s; t += step * 3) {
      real.setT(t);
      fields++;
      try {
        expect(fieldsOf(real.state)).toEqual(definitionOf(m, t));
      } catch {
        fieldsDiffer++;
      }
      for (const p of m.players) {
        builds++;
        const at = buildAt(p, t);
        const tenth = buildAt(p, tenthOf(t));
        const same = sameBuild(tenth, at) && sameStatBuild(statBuild(p, Math.floor(t), tenth), statBuild(p, t, at));
        const board = [p.kills, p.assists, p.level, p.max_health].every((series) => scoreboardValueAt(series, Math.floor(t)) === scoreboardValueAt(series, t));
        if (!same || !board) buildsDiffer++;
      }
    }
    real.dispose();
    console.log(`states compared: ${fields}, differing: ${fieldsDiffer}; builds compared: ${builds}, differing: ${buildsDiffer}`);
    expect(fieldsDiffer).toBe(0);
    expect(buildsDiffer).toBe(0);
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
