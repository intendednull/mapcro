// A scene's MapState (map-state spec §3, §6; phase 4): `fromScene` reads the scene's records
// behind the interface Player's state has. Every field against the records; what a scene
// doesn't hold reads as not captured; and the property the design rests on: what Save captures
// of Player's frame reads back as that frame, after capture's rounding.

import { describe, expect, it, vi } from "vitest";

// The browser build: the reactive one (node resolves solid-js to the server's, which doesn't
// track). For this file's imports, the sources' too.
vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { createComputed, createRoot, createSignal } from "solid-js";
import type { More } from "../src/gen/More";
import type { ObjectiveStatus } from "../src/gen/ObjectiveStatus";
import type { Op } from "../src/gen/Op";
import type { PlayerState as HeroRecord } from "../src/gen/PlayerState";
import { ROWS } from "../src/gen/rows";
import { offByDefault } from "../src/map/model";
import { clampToMap } from "../src/map/transform";
import { WRITTEN } from "../src/mapstate/build";
import { type SceneRecords, fromScene, sceneRecords } from "../src/mapstate/scene";
import { FEATURES, type MapState, fromTimeline } from "../src/mapstate/state";
import { MAX_RESPAWN, matchSceneOps, sourceOf } from "../src/match/save";
import type { Timeline } from "../src/match/timeline";
import { N, markers, metadata, model, replay } from "./support/synthetic-match";

const SLOTS = (["amber", "sapphire"] as const).flatMap((team) => [0, 1, 2, 3, 4, 5].map((n) => `${team}-${n}`));
const roster = () => replay().players.map((p, i) => ({ id: `slot-${i}`, slot: { team: p.team === "amber" ? ("Amber" as const) : ("Sapphire" as const), slot: p.slot, hero: p.hero_id as number | null, name: "" } }));
const rec = (i: number, over: Partial<HeroRecord> = {}) => ({ state: { scene: "s", slot: `slot-${i}`, pos: { x: 100 + i, y: -40 * i }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true, ...over } as HeroRecord });
const STATE: More = { rows: WRITTEN, has_builds: true, build: 6839 };
/** A snapshot that holds its heroes (D2), as a build that writes `has_heroes` stores it. */
const OWN: More = { rows: ROWS.has_heroes.index + 1, has_builds: true, has_heroes: true };
const values = (e: object) => Object.fromEntries(Object.entries(e).map(([k, f]) => [k, (f as () => unknown)()]));

/** A scene held in signals, and its state. */
function scene(init: { heroes?: Array<{ state: HeroRecord }>; state?: More; objectives?: Array<[string, ObjectiveStatus]>; waves?: Array<[string, number]>; names?: (slot: string) => string | null | undefined; tier?: string } = {}) {
  return createRoot((dispose) => {
    const [heroes, setHeroes] = createSignal(init.heroes ?? []);
    const [slots, setRoster] = createSignal(roster());
    const [objectives, setObjectives] = createSignal(new Map((init.objectives ?? []).map(([k, status]) => [k, { status }])));
    const [waves, setWaves] = createSignal(new Map((init.waves ?? []).map(([k, t]) => [k, { t }])));
    const [state, setState] = createSignal(init.state);
    const [names, setNames] = createSignal(init.names);
    const [tier, setTier] = createSignal<string | undefined>("tier" in init ? init.tier : "replay");
    const src: SceneRecords = { heroes, roster: slots, objectives, waves, state, names, tier };
    return { ms: fromScene(src), setHeroes, setRoster, setObjectives, setWaves, setState, setNames, setTier, dispose };
  });
}

const EMPTY_HERO = { present: false, hero: null, name: null, alive: false, pos: null, last: null, respawn: null, souls: null, ult: null, health: null, inSight: true, lastSeen: null, cc: undefined, height: undefined, zipline: false };

describe("a scene's MapState", () => {
  it("a hero is its record: place, alive, souls, ult, sight, respawn; what a scene doesn't hold is empty", () => {
    const s = scene({ heroes: [rec(0, { souls: 4200, ult_cooldown: 35 }), rec(7, { alive: false, respawn: 18, visible: false }), rec(8, { placed: false }), rec(9, { alive: false, placed: false })] });
    expect(values(s.ms.hero("amber-0"))).toEqual({ ...EMPTY_HERO, present: true, hero: 10, alive: true, pos: { x: 100, y: -0 }, last: { x: 100, y: -0 }, souls: 4200, ult: 35 });
    // Dead: no place of its own, but where it stood, and its respawn time (D4). Out of sight
    // by the record's one flag.
    expect(values(s.ms.hero("sapphire-1"))).toEqual({ ...EMPTY_HERO, present: true, hero: 17, pos: null, last: { x: 107, y: -280 }, respawn: 18, inSight: false });
    // Not placed yet: nowhere, alive or dead.
    expect(values(s.ms.hero("sapphire-2"))).toMatchObject({ present: true, alive: true, pos: null, last: null });
    expect(values(s.ms.hero("sapphire-3"))).toMatchObject({ present: true, alive: false, pos: null, last: null, respawn: null });
    // An alive hero has no respawn time, whatever its record still holds.
    s.setHeroes([rec(0, { respawn: 12 })]);
    expect(s.ms.hero("amber-0").respawn()).toBeNull();
    s.dispose();
  });

  it("a slot with no hero record is empty, and so is a record whose slot the roster doesn't have", () => {
    const s = scene({ heroes: [rec(0), { state: { ...rec(1).state, slot: "gone" } }] });
    expect(values(s.ms.hero("amber-1"))).toEqual(EMPTY_HERO);
    expect(values(s.ms.hero("amber-9"))).toEqual(EMPTY_HERO);
    // One entity a slot, kept.
    expect(s.ms.hero("amber-0")).toBe(s.ms.hero("amber-0"));
    expect(s.ms.marker("x")).toBe(s.ms.marker("x"));
    expect(s.ms.lane("lane1")).toBe(s.ms.lane("lane1"));
    // The record gone: empty again, with no roster hero left behind.
    s.setHeroes([]);
    expect(values(s.ms.hero("amber-0"))).toEqual(EMPTY_HERO);
    s.dispose();
  });

  it("the scene's own hero (when it holds its heroes) and name win over the roster's (D2); then the board's name; then the source match's (D1)", () => {
    const s = scene({ heroes: [rec(0, { more: { hero: 77, name: "own" } }), rec(1), rec(2, { more: { name: "" } })], names: (slot) => `match ${slot}`, state: OWN });
    expect([s.ms.hero("amber-0").hero(), s.ms.hero("amber-0").name()]).toEqual([77, "own"]);
    // A scene that doesn't say it holds its heroes (saved before, or made by hand) draws the
    // roster's, whatever its record holds: its name is its own all the same.
    for (const state of [undefined, STATE, { ...OWN, has_heroes: false }, { ...OWN, rows: ROWS.has_heroes.index }]) {
      s.setState(state);
      expect([s.ms.hero("amber-0").hero(), s.ms.hero("amber-0").name()]).toEqual([10, "own"]);
    }
    s.setState(OWN);
    expect(s.ms.hero("amber-0").hero()).toBe(77);
    // The flag alone changing is seen.
    s.setState({ ...OWN, has_heroes: false });
    expect(s.ms.hero("amber-0").hero()).toBe(10);
    s.setState(OWN);
    expect(s.ms.hero("amber-0").hero()).toBe(77);
    // None of its own: the roster's hero, and with no name typed on the board the match's.
    expect([s.ms.hero("amber-1").hero(), s.ms.hero("amber-1").name()]).toEqual([11, "match amber-1"]);
    expect(s.ms.hero("amber-2").name()).toBe("match amber-2");
    const named = roster();
    named[1]!.slot.name = "typed";
    named[1]!.slot.hero = null;
    named[0]!.slot.name = "board";
    // A name of spaces is no name (as board/roster.ts `slotName` has it).
    named[2]!.slot.name = "  ";
    s.setRoster(named);
    expect([s.ms.hero("amber-1").hero(), s.ms.hero("amber-1").name()]).toEqual([null, "typed"]);
    expect(s.ms.hero("amber-2").name()).toBe("match amber-2");
    expect(s.ms.hero("amber-0").name()).toBe("own");
    // The match not loaded: no name; a slot the match doesn't name: none either.
    s.setNames(undefined);
    expect(s.ms.hero("amber-2").name()).toBeNull();
    s.setNames(() => (slot: string) => (slot === "amber-2" ? null : "x"));
    expect(s.ms.hero("amber-2").name()).toBeNull();
    // A slot with no record has no name, whatever the match says.
    expect(s.ms.hero("sapphire-5").name()).toBeNull();
    s.dispose();
  });

  it("health is the snapshot's: absent without one or below its watermark; none when dead; full when revived", () => {
    const heroes = [rec(0, { more: { health: 37 } }), rec(1, { alive: false, more: { health: 37 } }), rec(2), rec(3, { more: { health: 0 } })];
    const s = scene({ heroes, state: STATE });
    expect(s.ms.has("health")).toBe(true);
    expect(["amber-0", "amber-1", "amber-2", "amber-3"].map((k) => s.ms.hero(k).health())).toEqual([37, 0, 100, 0]);
    expect(s.ms.hero("amber-4").health()).toBeNull();
    // No snapshot, one that holds no builds, and one taken before the row: not captured.
    for (const state of [undefined, {}, { rows: WRITTEN }, { rows: WRITTEN, has_builds: false }, { rows: ROWS.health.index, has_builds: true }]) {
      s.setState(state);
      expect(s.ms.has("health")).toBe(false);
      expect(s.ms.hero("amber-0").health()).toBeNull();
    }
    s.setState({ rows: ROWS.health.index + 1, has_builds: true });
    expect([s.ms.has("health"), s.ms.hero("amber-0").health()]).toEqual([true, 37]);
    // Only a scene saved from a replay holds it: the metadata tier's is not health to draw,
    // and a scene that doesn't say where it came from isn't taken at its word.
    for (const tier of ["metadata", undefined]) {
      s.setTier(tier);
      expect([s.ms.has("health"), s.ms.hero("amber-0").health(), s.ms.hero("amber-1").health()]).toEqual([false, null, null]);
    }
    s.setTier("replay");
    expect(s.ms.hero("amber-0").health()).toBe(37);
    s.dispose();
  });

  it("a marker is its stored status, a lane its split; the rest of the frame is not captured", () => {
    const s = scene({ objectives: [["a", "Destroyed"], ["b", "Stage2"], ["c", "Active"]], waves: [["lane1", 420]], state: STATE });
    const none = { status: undefined, down: false, site: undefined, shopClosed: false, camp: undefined, powerup: undefined, health: undefined, rift: undefined };
    expect(values(s.ms.marker("a"))).toEqual({ ...none, status: "Destroyed", down: true });
    expect(values(s.ms.marker("b"))).toEqual({ ...none, status: "Stage2" });
    expect(values(s.ms.marker("c"))).toEqual({ ...none, status: "Active" });
    expect(values(s.ms.marker("shop:x"))).toEqual(none);
    expect(values(s.ms.lane("lane1"))).toEqual({ split: 420, edges: undefined });
    expect(values(s.ms.lane("lane4"))).toEqual({ split: undefined, edges: undefined });
    expect(values(s.ms.scene())).toEqual({ urn: undefined, rejuv: undefined, deaths: [] });
    expect(FEATURES.filter((f) => s.ms.has(f))).toEqual(["health"]);
    s.setObjectives(new Map([["a", { status: "Active" as ObjectiveStatus }]]));
    s.setWaves(new Map([["lane4", { t: 7 }]]));
    expect([s.ms.marker("a").status(), s.ms.marker("a").down(), s.ms.marker("b").status()]).toEqual(["Active", false, undefined]);
    expect([s.ms.lane("lane1").split(), s.ms.lane("lane4").split()]).toEqual([undefined, 7]);
    s.dispose();
  });

  it("is static: a reader of one field runs again only when that value changes", () => {
    const s = scene({ heroes: [rec(0, { souls: 100 }), rec(1)], objectives: [["a", "Destroyed"]], waves: [["lane1", 420]] });
    const runs = { souls: 0, pos: 0, last: 0, other: 0, down: 0, split: 0 };
    const dispose = createRoot((d) => {
      createComputed(() => (s.ms.hero("amber-0").souls(), runs.souls++));
      createComputed(() => (s.ms.hero("amber-0").pos(), runs.pos++));
      createComputed(() => (s.ms.hero("amber-0").last(), runs.last++));
      createComputed(() => (s.ms.hero("amber-1").souls(), runs.other++));
      createComputed(() => (s.ms.marker("a").down(), runs.down++));
      createComputed(() => (s.ms.lane("lane1").split(), runs.split++));
      return d;
    });
    expect(runs).toEqual({ souls: 1, pos: 1, last: 1, other: 1, down: 1, split: 1 });
    // One hero's souls: its reader alone.
    s.setHeroes([rec(0, { souls: 250 }), rec(1)]);
    expect(runs).toEqual({ souls: 2, pos: 1, last: 1, other: 1, down: 1, split: 1 });
    // The same values in new records and maps: nobody.
    s.setHeroes([rec(0, { souls: 250 }), rec(1)]);
    s.setObjectives(new Map([["a", { status: "Destroyed" as ObjectiveStatus }], ["z", { status: "Active" as ObjectiveStatus }]]));
    s.setWaves(new Map([["lane1", { t: 420 }], ["lane4", { t: 1 }]]));
    expect(runs).toEqual({ souls: 2, pos: 1, last: 1, other: 1, down: 1, split: 1 });
    s.setHeroes([rec(0, { souls: 250, pos: { x: 5, y: 6 } }), rec(1)]);
    s.setObjectives(new Map());
    s.setWaves(new Map([["lane1", { t: 421 }]]));
    expect(runs).toEqual({ souls: 2, pos: 2, last: 2, other: 1, down: 2, split: 2 });
    dispose();
    s.dispose();
  });

  it("sceneRecords reads one scene's records out of the board's state", () => {
    const rows: Record<string, Array<[string, unknown]>> = {
      ObjectiveState: [["o1", { ObjectiveState: { scene: "s", key: "a", status: "Destroyed" } }], ["o2", { ObjectiveState: { scene: "s", key: "b", status: "Stage2" } }]],
      Wave: [["w1", { Wave: { scene: "s", lane: "lane4", t: 311 } }]],
      SceneState: [["st", { SceneState: { scene: "s", more: STATE } }]],
    };
    const asked: Array<[string, string | undefined]> = [];
    const board = {
      playersIn: (id: string | undefined) => (id === "s" ? [rec(0, { souls: 9 })] : []),
      roster,
      inScene: (kind: string, id: string | undefined) => (asked.push([kind, id]), id === "s" ? (rows[kind] ?? []) : []),
    };
    createRoot((dispose) => {
      const [id, setId] = createSignal<string | undefined>("s");
      const src = sceneRecords(board as never, id, undefined, () => "replay");
      const ms = fromScene(src);
      expect([ms.hero("amber-0").souls(), ms.marker("a").down(), ms.marker("b").status(), ms.lane("lane4").split(), ms.has("health")]).toEqual([9, true, "Stage2", 311, true]);
      expect(src.names).toBeUndefined();
      expect(new Set(asked.map(([k]) => k))).toEqual(new Set(["ObjectiveState", "Wave", "SceneState"]));
      expect(asked.every(([, s]) => s === "s")).toBe(true);
      // Another scene, and none: nothing of the first is left.
      for (const other of ["t", undefined]) {
        setId(other);
        expect([ms.hero("amber-0").present(), ms.marker("a").status(), ms.lane("lane4").split(), ms.has("health")]).toEqual([false, undefined, undefined, false]);
      }
      const names = () => (slot: string) => `n ${slot}`;
      expect(sceneRecords(board as never, () => "s", names).names).toBe(names);
      // Where the scene came from is handed through; none given, none said (and no health held).
      expect(src.tier?.()).toBe("replay");
      const plain = sceneRecords(board as never, () => "s");
      expect(["tier" in plain, fromScene(plain).has("health")]).toEqual([false, false]);
      dispose();
    });
  });
});

// ---- the property: Save's capture of Player's frame reads back as that frame ----

const minter = () => {
  let n = 0;
  return () => `id${n++}`;
};
/** The scene Save makes of `tl` at `t`, as `fromScene` reads it. */
function saved(tl: Timeline, t: number): SceneRecords {
  const { ops } = matchSceneOps(roster() as never, [], undefined, tl, t, markers, minter(), [], { source: sourceOf(tl) });
  const made = <T,>(kind: string): T[] => ops.flatMap((o: Op) => ("Create" in o && kind in o.Create.record ? [(o.Create.record as unknown as Record<string, T>)[kind]!] : []));
  return {
    heroes: () => made<HeroRecord>("PlayerState").map((state) => ({ state })),
    roster,
    objectives: () => new Map(made<{ key: string; status: ObjectiveStatus }>("ObjectiveState").map((o) => [o.key, { status: o.status }])),
    waves: () => new Map(made<{ lane: string; t: number }>("Wave").map((w) => [w.lane, { t: w.t }])),
    state: () => made<{ more?: More }>("SceneState")[0]?.more,
    tier: () => made<{ source?: { tier: string } }>("Scene")[0]?.source?.tier,
  };
}
/** What a marker shows, from the state alone: the stored status, else the frame's site or an
 * objective down, else the board's default (rifts and urn points off, the rest up). */
const shownStatus = (ms: MapState, m: (typeof markers)[number]) => {
  const k = ms.marker(m.key);
  return k.status() ?? k.site() ?? (k.down() || offByDefault(m.kind as never) ? "Destroyed" : "Active");
};

describe("Save as scene, read back", () => {
  const cases: Array<[string, Timeline]> = [["replay", replay()], ["metadata", metadata]];
  for (const [name, tl] of cases) {
    it(`is Player's frame at the save's whole second, after capture's rounding (${name} tier)`, () => {
      const replayTier = tl.tier === "replay";
      const seen = { dead: 0, alive: 0, down: 0, on: 0, lanes: 0, moved: new Set<string>(), respawns: new Set<number>() };
      for (const t of [0, 0.4, 1, 2.5, 3, 4.99, 5, 5.5, 6, 7.2, 8, 9, 10.7, 11, N]) {
        createRoot((dispose) => {
          const player = fromTimeline({ tl: () => tl, t: () => Math.floor(t), markers: () => markers });
          const scene = fromScene(saved(tl, t));
          for (const slot of SLOTS) {
            const [p, s] = [player.hero(slot), scene.hero(slot)];
            const where = p.pos() ?? p.last();
            expect({ present: s.present(), hero: s.hero(), alive: s.alive(), souls: s.souls(), ult: s.ult() }, `${slot} at ${t}`).toEqual({ present: true, hero: p.hero(), alive: p.alive(), souls: p.souls(), ult: p.ult() });
            expect(s.pos() ?? s.last(), `${slot} at ${t}`).toEqual(where ? clampToMap(where) : null);
            expect(s.pos() === null, `${slot} at ${t}`).toBe(p.pos() === null);
            // A dead hero's respawn time, in whole seconds rounded up (D4): the two who die at
            // 5 are back at 7.5, so 2.5 s left at 5 is stored as 3, 1.5 at 6 as 2, 0.5 at 7 as 1.
            const left = slot === "amber-3" || slot === "sapphire-3" ? ({ 5: 3, 6: 2, 7: 1 } as Record<number, number>)[Math.floor(t)] ?? null : null;
            expect(s.respawn(), `${slot} at ${t}`).toBe(left);
            // And Player's own count at that second is what was rounded.
            expect(p.respawn() == null ? null : p.respawn()! > left! - 1 && p.respawn()! <= left!, `${slot} at ${t}`).toBe(left == null ? null : true);
            if (s.respawn() != null) seen.respawns.add(s.respawn()!);
            // Health is the replay tier's; the metadata tier holds none, in Player or in a scene.
            expect(s.health(), `${slot} at ${t}`).toBe(p.health());
            p.alive() ? seen.alive++ : seen.dead++;
            seen.moved.add(`${slot}:${JSON.stringify(where)}`);
          }
          for (const m of markers) {
            expect(shownStatus(scene, m), `${m.key} at ${t}`).toBe(shownStatus(player, m));
            if (scene.marker(m.key).down()) seen.down++;
            if (offByDefault(m.kind as never) && scene.marker(m.key).status() === "Active") seen.on++;
          }
          for (const l of model.lanes) {
            const split = player.lane(l.key).split();
            expect(scene.lane(l.key).split(), `${l.key} at ${t}`).toBe(split === undefined ? undefined : Math.round(split));
            // Player's split is the middle of the colours' gap.
            const edges = player.lane(l.key).edges();
            expect(split).toBe(edges ? (edges.amber + edges.sapphire) / 2 : undefined);
            if (split !== undefined) seen.lanes++;
          }
          // Player's state is computed: it stores no status.
          expect(markers.every((m) => player.marker(m.key).status() === undefined)).toBe(true);
          expect(scene.has("health")).toBe(replayTier);
          dispose();
        });
      }
      // The match moved what the comparison holds.
      expect(seen.dead).toBeGreaterThan(0);
      expect(seen.alive).toBeGreaterThan(100);
      expect(seen.down).toBeGreaterThan(0);
      expect(seen.moved.size).toBeGreaterThan(100);
      // 2.5 s left at 5 is stored as 3, 1.5 at 6 as 2, 0.5 at 7 as 1.
      expect([...seen.respawns].sort()).toEqual([1, 2, 3]);
      if (replayTier) expect([seen.on > 0, seen.lanes > 0]).toEqual([true, true]);
    });
  }

  it("a respawn time is at most what the record holds; a death the match gives no time for has none", () => {
    // The schema's bound on `PlayerRespawn` (crates/schema/src/validate.rs): over it a save is refused.
    expect(MAX_RESPAWN).toBe(600);
    const far = replay();
    far.players[3]!.respawn = [[5, 5 + MAX_RESPAWN + 30.2]];
    far.players[9]!.respawn = [];
    createRoot((dispose) => {
      const scene = fromScene(saved(far, 6));
      expect([scene.hero("amber-3").alive(), scene.hero("amber-3").respawn()]).toEqual([false, MAX_RESPAWN]);
      expect([scene.hero("sapphire-3").alive(), scene.hero("sapphire-3").respawn()]).toEqual([false, null]);
      // Under the cap: itself, rounded up (598.2 s left).
      far.players[3]!.respawn = [[5, 6 + MAX_RESPAWN - 1.8]];
      expect(fromScene(saved(far, 6)).hero("amber-3").respawn()).toBe(MAX_RESPAWN - 1);
      // A living hero's record holds none, whatever the match's rows say.
      far.players[0]!.respawn = [[0, 50]];
      const records = saved(far, 6).heroes();
      expect(records.filter((r) => r.state.respawn !== undefined).map((r) => r.state.slot)).toEqual(["slot-3"]);
      dispose();
    });
  });

  it("what a scene can't hold yet differs from Player's, and the state says so: sight, CC, movement, the colours' gap, camps, powerups, rifts, the urn, the Rejuvenator", () => {
    const tl = replay();
    createRoot((dispose) => {
      const player = fromTimeline({ tl: () => tl, t: () => 4, markers: () => markers });
      const scene = fromScene(saved(tl, 4));
      expect(FEATURES.filter((f) => player.has(f))).toEqual([...FEATURES]);
      expect(FEATURES.filter((f) => scene.has(f))).toEqual(["health"]);
      // Save writes every hero as in sight, whoever saw it.
      expect(SLOTS.some((k) => !player.hero(k).inSight())).toBe(true);
      expect(SLOTS.every((k) => scene.hero(k).inSight())).toBe(true);
      dispose();
    });
  });

  it("the metadata tier's coarse health is not captured: Player doesn't hold it, and neither does the scene", () => {
    createRoot((dispose) => {
      const player = fromTimeline({ tl: () => metadata, t: () => 4, markers: () => markers });
      const records = saved(metadata, 4);
      const scene = fromScene(records);
      expect([player.has("health"), player.hero("amber-0").health()]).toEqual([false, null]);
      expect([scene.has("health"), scene.hero("amber-0").health()]).toEqual([false, null]);
      // Nothing of it is stored; the rest of the build is.
      expect(records.heroes().every((h) => h.state.more !== undefined && !("health" in h.state.more))).toBe(true);
      // A scene saved before this held it: read the same, as not captured.
      const before = { ...records, heroes: () => records.heroes().map((h) => ({ state: { ...h.state, more: { ...h.state.more, health: 80 } } })) };
      expect([fromScene(before).has("health"), fromScene(before).hero("amber-0").health()]).toEqual([false, null]);
      // The replay tier's is stored.
      expect(saved(replay(), 4).heroes().every((h) => typeof h.state.more?.health === "number")).toBe(true);
      dispose();
    });
  });
});
