// Whose hero a scene draws (map-state spec §2, D2). A scene whose snapshot says it holds its
// heroes (`has_heroes`) draws its own: Save stores each slot's hero and leaves the board's
// roster alone, and a pick in the scene writes that scene and drops the old hero's build. A
// scene without the flag (made by hand, or saved before the row was written) is as it always
// was: the roster's hero, a pick writes the roster, and a stored build whose hero differs from
// the roster's is hidden.
//
// The row is `live` from store v14 (its writer): this build's save is `LATER`'s. The tests of
// the save from before (store v12 and v13, the rollback targets) pass that build's row count
// (`BEFORE`).

import { describe, expect, it, vi } from "vitest";

vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { createRoot } from "solid-js";
import type { More } from "../src/gen/More";
import type { Op } from "../src/gen/Op";
import type { PlayerState as HeroRecord } from "../src/gen/PlayerState";
import { ROWS } from "../src/gen/rows";
import { BUILD_KEYS, WRITTEN, captureBuild, captureScene, captured, heroBuildAt, retakeRows, sceneHero, writesHeroes } from "../src/mapstate/build";
import { holdsBuild } from "../src/mapstate/buildView";
import { pickHeroOps } from "../src/mapstate/edit";
import { fromScene } from "../src/mapstate/scene";
import { LIMITS } from "../src/gen/limits";
import { canRetake, matchSceneOps, matchScenesOps, opsBytes, retakeOps, sourceOf } from "../src/match/save";
import { markers, replay } from "./support/synthetic-match";

/** The rows a build writes once `has_heroes` is live, and those of a build from before it. */
const LATER = ROWS.has_heroes.index + 1;
const BEFORE = ROWS.has_heroes.index;
const tl = replay();
/** A board whose roster holds other heroes than the match's (and one slot none). */
const roster = () => tl.players.map((p, i) => ({ id: `slot-${i}`, slot: { team: p.team === "amber" ? ("Amber" as const) : ("Sapphire" as const), slot: p.slot, hero: i === 5 ? null : 100 + i, name: "" } }));
const minter = () => {
  let n = 0;
  return () => `id${n++}`;
};
/** A save by a build from before the row, unless `written` says otherwise. */
const save = (opts: object = {}, t = 4) => matchSceneOps(roster() as never, [], undefined, tl, t, markers, minter(), [], { source: sourceOf(tl), written: BEFORE, ...opts });
const made = <T,>(ops: Op[], kind: string): Array<{ id: string; r: T }> => ops.flatMap((o) => ("Create" in o && kind in o.Create.record ? [{ id: o.Create.id, r: (o.Create.record as unknown as Record<string, T>)[kind]! }] : []));
const rosterWrites = (ops: Op[]) => ops.filter((o) => "Set" in o && "RosterHero" in o.Set.value);
/** A saved scene as `fromScene` reads it, on `slots`. */
const read = (ops: Op[], slots = roster()) => ({
  heroes: () => made<HeroRecord>(ops, "PlayerState").map((x) => ({ state: x.r })),
  roster: () => slots,
  objectives: () => new Map(),
  waves: () => new Map(),
  state: () => made<{ more?: More }>(ops, "SceneState")[0]?.r.more,
});
const SLOTS = tl.players.map((p) => `${p.team}-${p.slot}`);

describe("the row", () => {
  // The one test here that says what this build does: it changed on purpose with the release
  // that made the row `live` (store v14, docs/deploy.md).
  it("is written by this build: its save holds the scene's heroes", () => {
    expect(ROWS.has_heroes).toMatchObject({ entity: "scene", kind: "bool", status: "live" });
    expect(WRITTEN).toBe(LATER);
    expect(writesHeroes()).toBe(true);
    expect(captureScene(tl).has_heroes).toBe(true);
    expect(matchSceneOps(roster() as never, [], undefined, tl, 4, markers, minter(), [], { source: sourceOf(tl) }).ops).toEqual(save({ written: LATER }).ops);
  });

  it("a save from before sets the roster to the match's heroes, and says nothing of the scene's own", () => {
    expect([writesHeroes(LATER), writesHeroes(BEFORE)]).toEqual([true, false]);
    const { ops } = save();
    expect(rosterWrites(ops)).toHaveLength(12);
    expect(captured(made<{ more?: More }>(ops, "SceneState")[0]!.r.more)).toMatchObject({ builds: true, heroes: false, rows: BEFORE });
  });

  it("is read under the watermark: said, and known when the snapshot was taken", () => {
    expect(captured({ rows: LATER, has_heroes: true }).heroes).toBe(true);
    expect(captured({ rows: LATER + 7, has_heroes: true, has_builds: true })).toMatchObject({ heroes: true, builds: true });
    // Not said; said false; a watermark from before the row; none at all.
    expect(captured({ rows: LATER }).heroes).toBe(false);
    expect(captured({ rows: LATER, has_heroes: false }).heroes).toBe(false);
    expect(captured({ rows: LATER - 1, has_heroes: true }).heroes).toBe(false);
    expect(captured({ has_heroes: true }).heroes).toBe(false);
    expect(captured(undefined).heroes).toBe(false);
  });

  it("is in a save's state once written, with or without the builds; never in Retake's", () => {
    expect(captureScene(tl, { written: LATER })).toEqual({ rows: LATER, has_builds: true, build: 6839, has_heroes: true });
    expect(captureScene(tl, { written: LATER, builds: false })).toEqual({ rows: LATER, has_heroes: true });
    expect(captureScene(tl, { written: LATER, heroes: false })).toEqual({ rows: LATER, has_builds: true, build: 6839 });
    expect(captureScene(tl, { written: BEFORE, builds: false })).toEqual({ rows: BEFORE });
    expect(captureScene(tl, { written: BEFORE })).toEqual({ rows: BEFORE, has_builds: true, build: 6839 });
  });
});

describe("the hero a slot holds in a scene", () => {
  it("is the scene's own when it holds its heroes, else the roster's", () => {
    expect(sceneHero(true, { hero: 7 }, 3)).toBe(7);
    expect(sceneHero(false, { hero: 7 }, 3)).toBe(3);
    // No hero of its own: the roster's, and none when the roster has none.
    expect(sceneHero(true, {}, 3)).toBe(3);
    expect(sceneHero(true, undefined, 3)).toBe(3);
    expect(sceneHero(true, undefined, null)).toBeNull();
    expect(sceneHero(false, { hero: 7 }, null)).toBeNull();
    expect(sceneHero(false, { hero: 7 }, undefined)).toBeNull();
    // Hero 0 is a hero id like any other.
    expect(sceneHero(true, { hero: 0 }, 3)).toBe(0);
  });

  it("a scene saved before: the roster's hero is drawn, and a build whose hero differs from it is hidden (a coach's pick since)", () => {
    const { ops } = save();
    const heroes = made<HeroRecord>(ops, "PlayerState");
    const state = made<{ more?: More }>(ops, "SceneState")[0]!.r.more;
    const snap = captured(state);
    // The board as the save left it: the roster holds the match's heroes.
    const saved = roster().map((s, i) => ({ ...s, slot: { ...s.slot, hero: tl.players[i]!.hero_id } }));
    // Then a coach gave slot 2 another hero.
    const picked = saved.map((s, i) => (i === 2 ? { ...s, slot: { ...s.slot, hero: 77 } } : s));
    createRoot((dispose) => {
      const scene = fromScene(read(ops, picked));
      expect(SLOTS.map((k) => scene.hero(k).hero())).toEqual(tl.players.map((p, i) => (i === 2 ? 77 : p.hero_id)));
      dispose();
    });
    expect(heroes[2]!.r.more!.hero).toBe(tl.players[2]!.hero_id);
    expect(holdsBuild(heroes[2]!.r.more, snap.rows, sceneHero(snap.heroes, heroes[2]!.r.more, 77), snap.heroes)).toBe(false);
    expect(holdsBuild(heroes[1]!.r.more, snap.rows, sceneHero(snap.heroes, heroes[1]!.r.more, tl.players[1]!.hero_id), snap.heroes)).toBe(true);
    // And the pick there writes the roster, whatever the record holds.
    expect(pickHeroOps(snap.heroes, "slot-2", { id: heroes[2]!.id, more: heroes[2]!.r.more }, 77)).toEqual([{ Set: { id: "slot-2", value: { RosterHero: 77 } } }]);
    expect(pickHeroOps(false, "slot-2", { id: "p", more: { hero: 5 } }, null)).toEqual([{ Set: { id: "slot-2", value: { RosterHero: null } } }]);
    expect(pickHeroOps(false, "slot-2", undefined, 9)).toEqual([{ Set: { id: "slot-2", value: { RosterHero: 9 } } }]);
  });

  it("a build is its hero's: in a scene that holds its heroes while the record still holds some of it", () => {
    const build = captureBuild(heroBuildAt(tl, tl.players[0]!, 4));
    expect(holdsBuild(build, LATER, build.hero as number, true)).toBe(true);
    // The hero alone (a pick dropped the rest, or a save without builds): no build.
    expect(holdsBuild({ hero: 10 }, LATER, 10, true)).toBe(false);
    expect(holdsBuild({ hero: 10 }, LATER, 10, false)).toBe(true);
    // Any one of the build's rows is some of it.
    for (const k of BUILD_KEYS) expect(holdsBuild({ hero: 10, [k]: build[k] ?? 1 } as More, LATER, 10, true), k).toBe(true);
    expect(holdsBuild({ hero: 10, name: "x" }, LATER, 10, true)).toBe(false);
    // As before for the rest: no snapshot, no hero, another hero.
    expect(holdsBuild(build, 0, build.hero as number, true)).toBe(false);
    expect(holdsBuild(build, LATER, null, true)).toBe(false);
    expect(holdsBuild(build, LATER, 999, true)).toBe(false);
    expect(holdsBuild({ items: [1, 0, -1, -1] }, LATER, 10, true)).toBe(false);
    // The build's rows are every hero row but the two that say who it is.
    expect([...BUILD_KEYS].sort()).toEqual(Object.keys(ROWS).filter((k) => ROWS[k as keyof typeof ROWS].entity === "hero" && k !== "hero" && k !== "name").sort());
  });
});

describe("Save, once it writes the row", () => {
  it("stores each slot's hero in the scene and leaves the roster alone", () => {
    const { ops, builds } = save({ written: LATER });
    expect(builds).toBe(true);
    expect(rosterWrites(ops)).toEqual([]);
    const state = made<{ more?: More }>(ops, "SceneState");
    expect(state).toHaveLength(1);
    expect(state[0]!.r.more).toEqual(captureScene(tl, { written: LATER }));
    expect(captured(state[0]!.r.more)).toMatchObject({ builds: true, heroes: true, rows: LATER });
    // Read back on a board whose roster holds other heroes: the match's, slot by slot.
    createRoot((dispose) => {
      const scene = fromScene(read(ops));
      expect(SLOTS.map((k) => scene.hero(k).hero())).toEqual(tl.players.map((p) => p.hero_id));
      dispose();
    });
    // The same records under a state that doesn't say so draw the roster's.
    createRoot((dispose) => {
      const scene = fromScene({ ...read(ops), state: () => captureScene(tl, { written: LATER, heroes: false }) });
      expect(SLOTS.map((k) => scene.hero(k).hero())).toEqual(roster().map((s) => s.slot.hero));
      dispose();
    });
    // Everything else of the save is the save as it was.
    const strip = (all: Op[]) => all.filter((o) => !rosterWrites([o]).length && !("Create" in o && "SceneState" in o.Create.record));
    expect(strip(ops)).toEqual(strip(save().ops));
  });

  it("without the builds still holds the heroes: the hero alone on each record, and a state that says so", () => {
    const { ops, builds } = save({ written: LATER, builds: false });
    expect(builds).toBe(false);
    expect(rosterWrites(ops)).toEqual([]);
    expect(made<HeroRecord>(ops, "PlayerState").map((h) => h.r.more)).toEqual(tl.players.map((p) => ({ hero: p.hero_id })));
    const state = made<{ more?: More }>(ops, "SceneState");
    expect(state.map((s) => s.r.more)).toEqual([{ rows: LATER, has_heroes: true }]);
    expect(captured(state[0]!.r.more)).toMatchObject({ builds: false, heroes: true });
    // Before the row is written such a save has no state and no `more` at all, as it was.
    const before = save({ builds: false }).ops;
    expect(made(before, "SceneState")).toEqual([]);
    expect(made<HeroRecord>(before, "PlayerState").every((h) => h.r.more === undefined)).toBe(true);
    // A slot the match has no player for keeps the roster's hero: nothing of its own.
    const short = { ...tl, players: tl.players.slice(0, 11) };
    const eleven = matchSceneOps(roster() as never, [], undefined, short, 4, markers, minter(), [], { source: sourceOf(short), written: LATER, builds: false }).ops;
    expect(made<HeroRecord>(eleven, "PlayerState").map((h) => h.r.more?.hero)).toEqual([...tl.players.slice(0, 11).map((p) => p.hero_id), undefined]);
  });

  it("many scenes at once: none of them writes the roster, and each holds its heroes", () => {
    const now = matchScenesOps(roster() as never, [], undefined, tl, [{ t: 2, name: "a" }, { t: 6, name: "b" }], markers, minter());
    expect(now.groups.map((g) => rosterWrites(g).length)).toEqual([0, 0]);
    expect(now.groups.map((g) => captured(made<{ more?: More }>(g, "SceneState")[0]?.r.more).heroes)).toEqual([true, true]);
    expect(now.of).toEqual([0, 1]);
  });

  it("many scenes at once: a moment with no room for its heroes has no scene; the others keep their moments and order", () => {
    // An objective down from second 5 whose key alone is over a transaction.
    const key = `walker:amber:lane1:1:${"k".repeat(LIMITS.max_tx_bytes)}`;
    const full = { ...tl, objectives: [{ key, kind: "walker", team: "amber", lane: 1, destroyed_s: 5 }] } as never;
    const mk = [{ key, kind: "walker", team: "amber", lane: "yellow", at: { x: 0, y: 0 } }] as never[];
    const r = matchScenesOps(roster() as never, [], undefined, full, [{ t: 2, name: "a" }, { t: 6, name: "b" }, { t: 3, name: "c" }], mk, minter());
    expect(r.of).toEqual([0, 2]);
    expect([r.ids.length, r.groups.length, r.builds.length]).toEqual([2, 2, 2]);
    const scenes = r.groups.map((g) => made<{ name: string; order: string }>(g, "Scene")[0]!.r);
    expect(scenes.map((s) => s.name)).toEqual(["a", "c"]);
    expect(scenes[0]!.order < scenes[1]!.order).toBe(true);
    expect(r.ops).toEqual(r.groups.flat());
    expect(r.groups.every((g) => captured(made<{ more?: More }>(g, "SceneState")[0]?.r.more).heroes)).toBe(true);
    // The one at 6 alone is not made.
    expect(matchSceneOps(roster() as never, [], undefined, full, 6, mk, minter(), [], { source: sourceOf(tl) }).ops).toEqual([]);
  });

  it("with no room even for the heroes, saves nothing: no scene that draws the roster's heroes", () => {
    // One objective down whose key fills the transaction to within `spare` bytes of its cap.
    const filled = (spare: number, written: number, builds = false) => {
      const at = (pad: number) => {
        const key = `walker:amber:lane1:1:${"k".repeat(pad)}`;
        const full = { ...tl, objectives: [{ key, kind: "walker", team: "amber", lane: 1, destroyed_s: 0 }] } as never;
        const mk = [{ key, kind: "walker", team: "amber", lane: "yellow", at: { x: 0, y: 0 } }] as never[];
        return matchSceneOps(roster() as never, [], undefined, full, 4, mk, minter(), [], { source: sourceOf(tl), builds: pad > 0 && builds, written });
      };
      const bare = opsBytes(at(0).ops.filter((o) => !("Create" in o && "SceneState" in o.Create.record)).map((o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "more" ? undefined : v)))));
      return at(LIMITS.max_tx_bytes - 1024 - bare - spare).ops;
    };
    // Room for them: every record its hero, and the state.
    const roomy = filled(2000, LATER);
    expect(made<HeroRecord>(roomy, "PlayerState").every((h) => typeof h.r.more?.hero === "number")).toBe(true);
    expect(made<{ more?: More }>(roomy, "SceneState").map((s) => s.r.more)).toEqual([{ rows: LATER, has_heroes: true }]);
    expect(opsBytes(roomy)).toBeLessThanOrEqual(LIMITS.max_tx_bytes - 1024);
    // None: nothing is sent. Saved without its heroes or its flag, the scene would draw the
    // board roster's, which Save no longer sets (spec §4.5: a save holds its heroes).
    expect(filled(40, LATER)).toEqual([]);
    // To the byte: exactly what the heroes and the state add fits; one less does not.
    const strip = (ops: Op[]) => ops.filter((o) => !("Create" in o && "SceneState" in o.Create.record)).map((o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "more" ? undefined : v))));
    const need = opsBytes(roomy) - opsBytes(strip(roomy));
    expect(need).toBeGreaterThan(12 * 19);
    expect(made(filled(need, LATER), "SceneState")).toHaveLength(1);
    expect(opsBytes(filled(need, LATER))).toBe(LIMITS.max_tx_bytes - 1024);
    expect(filled(need - 1, LATER)).toEqual([]);
    // A build from before saves the scene either way, without a state: it sets the roster.
    const before = filled(40, BEFORE);
    expect([made(before, "Scene").length, made(before, "SceneState").length, rosterWrites(before).length]).toEqual([1, 0, 12]);
    expect(made(filled(2000, BEFORE), "SceneState")).toEqual([]);
    // Room for the heroes but not for their builds: the same save as one asked for without
    // builds, record for record and id for id.
    const spare = [300, 400, 500, 600, 700, 800].find((n) => {
      const ops = filled(n, LATER, true);
      return made(ops, "SceneState").length === 1 && made<HeroRecord>(ops, "PlayerState").every((h) => Object.keys(h.r.more ?? {}).join() === "hero");
    });
    expect(spare).toBeDefined();
    expect(filled(spare!, LATER, true)).toEqual(filled(spare!, LATER, false));
  });
});

describe("a pick in a scene that holds its heroes", () => {
  // A record with every row of a build.
  const build: More = { hero: 13, items: [5, 0, -1, -1], abilities: [9, 2, 0, -1, -1], build_order: [50, 5, 0], level: 4, health: 80, pickups: [0, 0, 0, 0, 0], kills: 1, deaths: 0, assists: 2, max_health: 900 };
  const player = { id: "p3", more: build };

  it("writes the scene's hero and drops the old hero's build, in one transaction; never the roster", () => {
    const ops = pickHeroOps(true, "slot-3", player, 77);
    expect(ops[0]).toEqual({ Set: { id: "p3", value: { More: { key: "hero", value: 77 } } } });
    const cleared = ops.slice(1).map((o) => ("Set" in o && "More" in o.Set.value ? o.Set : undefined));
    expect(cleared.every((s) => s && s.id === "p3" && "More" in s.value && s.value.More.value === null)).toBe(true);
    expect(cleared.map((s) => (s!.value as { More: { key: string } }).More.key).sort()).toEqual([...BUILD_KEYS].sort());
    expect(ops).toHaveLength(1 + BUILD_KEYS.length);
    // Applied, the record holds the new hero and no build.
    const after: More = { ...build };
    for (const o of ops) if ("Set" in o && "More" in o.Set.value) { if (o.Set.value.More.value === null) delete after[o.Set.value.More.key]; else after[o.Set.value.More.key] = o.Set.value.More.value as never; }
    expect(after).toEqual({ hero: 77 });
    expect(sceneHero(true, after, build.hero as number)).toBe(77);
    expect(holdsBuild(after, LATER, 77, true)).toBe(false);
  });

  it("clears only what the record holds; the same hero again, or no hero, writes nothing", () => {
    expect(pickHeroOps(true, "slot-3", { id: "p3", more: { hero: 13, level: 4 } }, 77)).toEqual([
      { Set: { id: "p3", value: { More: { key: "hero", value: 77 } } } },
      { Set: { id: "p3", value: { More: { key: "level", value: null } } } },
    ]);
    // A record with nothing of its own yet: its hero is set.
    expect(pickHeroOps(true, "slot-3", { id: "p3", more: undefined }, 77)).toEqual([{ Set: { id: "p3", value: { More: { key: "hero", value: 77 } } } }]);
    // A name is the slot's, not the build's: kept.
    expect(pickHeroOps(true, "slot-3", { id: "p3", more: { hero: 13, name: "x" } }, 77)).toHaveLength(1);
    expect(pickHeroOps(true, "slot-3", player, build.hero as number)).toEqual([]);
    expect(pickHeroOps(true, "slot-3", player, null)).toEqual([]);
    // No hero record for the slot in the scene: the roster, as anywhere else.
    expect(pickHeroOps(true, "slot-3", undefined, 77)).toEqual([{ Set: { id: "slot-3", value: { RosterHero: 77 } } }]);
  });
});

// TD-119's characterisation, written before the fix and run on the code before it: what a scene
// without the flag gets from Retake and a pick, op for op, and what a flagged scene's Retake
// writes of a build. The fix changes neither.
describe("as it was before TD-119", () => {
  const scene = { id: "scene", scene: { name: "s", order: "a", clock: 4, source: { match_id: tl.match_id, t: 4, tier: "replay" } } } as never;
  const records = (opts: object) => made<HeroRecord>(save(opts).ops, "PlayerState").map((x) => ({ id: x.id, state: x.r }));
  const absent = (id: string, key: string, value: unknown) => ({ SetIf: { id, expect: { More: { key, value: null } }, value: { More: { key, value } } } });
  /** Retake's writes on one hero's record. */
  const on = (ops: Op[], id: string) => ops.filter((o) => ("SetIf" in o && o.SetIf.id === id) || ("Set" in o && o.Set.id === id));

  // Every way a scene can be without the flag: no state, a state that doesn't say it, one that
  // says false, and one that says it below its own watermark.
  const unflagged: Array<[string, { id: string; more: More } | undefined]> = [
    ["no state", undefined],
    ["a state from before the row", { id: "state", more: { rows: BEFORE } }],
    ["a state that says false", { id: "state", more: { rows: LATER, has_heroes: false } }],
    ["a state that says it below its watermark", { id: "state", more: { rows: BEFORE, has_heroes: true } }],
  ];
  it.each(unflagged)("without the flag (%s), Retake writes each absent value by a SetIf, and only those", (_, state) => {
    const heroes = records({ builds: false });
    const ops = retakeOps(scene, state, heroes, roster() as never, tl, minter()).flat();
    heroes.forEach((h, i) => {
      const want = Object.entries(captureBuild(heroBuildAt(tl, tl.players[i]!, 4))).filter(([k]) => h.state.more?.[k] === undefined);
      expect(on(ops, h.id)).toEqual(want.map(([k, v]) => absent(h.id, k, v)));
    });
    expect(ops.some((o) => "Set" in o)).toBe(false);
  });

  it("without the flag, a record that holds its hero is filled with SetIfs alone, its hero not written", () => {
    const heroes = records({ written: LATER, builds: false });
    expect(heroes.every((h) => typeof h.state.more?.hero === "number")).toBe(true);
    const ops = retakeOps(scene, { id: "state", more: { rows: BEFORE } }, heroes, roster() as never, tl, minter()).flat();
    expect(ops.some((o) => "Set" in o)).toBe(false);
    for (const h of heroes) expect(on(ops, h.id).some((o) => "SetIf" in o && "More" in o.SetIf.value && o.SetIf.value.More.key === "hero")).toBe(false);
  });

  it("with the flag, Retake fills each absent build row by a SetIf, as Save would have stored it", () => {
    const heroes = records({ written: LATER, builds: false });
    const ops = retakeOps(scene, { id: "state", more: { rows: LATER, has_heroes: true } }, heroes, roster() as never, tl, minter(), LATER).flat();
    heroes.forEach((h, i) => {
      const { hero: _, ...build } = captureBuild(heroBuildAt(tl, tl.players[i]!, 4));
      const fills = on(ops, h.id).filter((o) => "SetIf" in o);
      expect(fills).toEqual(Object.entries(build).map(([k, v]) => absent(h.id, k, v)));
    });
  });

  it("with the flag, a record that holds its whole build gets nothing from Retake", () => {
    const heroes = records({ written: LATER });
    const ops = retakeOps(scene, { id: "state", more: { rows: LATER, has_heroes: true } }, heroes, roster() as never, tl, minter(), LATER).flat();
    for (const h of heroes) expect(on(ops, h.id)).toEqual([]);
  });

  it("a pick in a scene without the flag writes the roster alone", () => {
    expect(pickHeroOps(false, "slot-3", { id: "p3", more: { hero: 13, items: [5, 0, -1, -1] } }, 77)).toEqual([{ Set: { id: "slot-3", value: { RosterHero: 77 } } }]);
  });

  it("the reader draws what a flagged record holds, and nothing for one that holds no build", () => {
    expect(holdsBuild({ hero: 77, items: [5, 0, -1, -1] }, LATER, 77, true)).toBe(true);
    expect(holdsBuild({ hero: 77 }, LATER, 77, true)).toBe(false);
  });
});

describe("Retake and the scene's heroes", () => {
  const scene = (t: number) => ({ id: "scene", scene: { name: "s", order: "a", clock: t, source: { match_id: tl.match_id, t, tier: "replay" } } }) as never;
  const heroesOf = (ops: Op[]) => made<HeroRecord>(ops, "PlayerState").map((x) => ({ id: x.id, state: x.r }));

  it("never says an old scene holds its heroes, whatever this build writes", () => {
    const old = heroesOf(save({ builds: false }).ops);
    for (const written of [WRITTEN, LATER]) {
      const ops = retakeOps(scene(4), undefined, old, roster() as never, tl, minter(), written).flat();
      const state = made<{ more?: More }>(ops, "SceneState");
      expect(state).toHaveLength(1);
      expect(state[0]!.r.more).toEqual({ rows: written, has_builds: true, build: 6839 });
      expect(captured(state[0]!.r.more).heroes).toBe(false);
    }
    // Onto a state that exists: the builds' flag and patch, the watermark moved up, no more.
    const onto = retakeOps(scene(4), { id: "state", more: { rows: 3 } }, old, roster() as never, tl, minter(), LATER).flat();
    const keys = onto.flatMap((o) => ("SetIf" in o && o.SetIf.id === "state" && "More" in o.SetIf.value ? [o.SetIf.value.More.key] : []));
    expect(keys.sort()).toEqual(["build", "has_builds", "rows"]);
    // The watermark goes to the rows the retaking build writes.
    expect(onto.find((o) => "SetIf" in o && "More" in o.SetIf.value && o.SetIf.value.More.key === "rows")).toEqual({ SetIf: { id: "state", expect: { More: { key: "rows", value: 3 } }, value: { More: { key: "rows", value: LATER } } } });
  });

  it("is not offered just because the row came to be written", () => {
    const src = { source: { match_id: tl.match_id, t: 4, tier: "replay" } };
    const saved = captureScene(tl, { written: BEFORE });
    expect(retakeRows(BEFORE)).toBe(BEFORE);
    expect(retakeRows(LATER)).toBe(BEFORE);
    // (A row after it that Retake gives would move it past: there is none yet.)
    expect(retakeRows(LATER + 1)).toBe(BEFORE);
    expect(retakeRows()).toBe(BEFORE);
    expect(retakeRows(0)).toBe(0);
    expect(canRetake(src, saved, tl)).toBe(false);
    // The build that writes the row: a scene saved today has nothing to retake.
    expect(canRetake(src, saved, tl, LATER)).toBe(false);
    expect(canRetake(src, { ...saved, rows: BEFORE - 1 }, tl, LATER)).toBe(true);
    expect(canRetake(src, undefined, tl, LATER)).toBe(true);
  });

  it("leaves out a slot given another hero in the scene: the match's build is not that hero's", () => {
    const heroes = heroesOf(save({ written: LATER, builds: false }).ops);
    heroes[3]!.state.more = { hero: 77 };
    const ops = retakeOps(scene(4), { id: "state", more: { rows: LATER, has_heroes: true } }, heroes, roster() as never, tl, minter(), LATER).flat();
    const ids = new Set(ops.flatMap((o) => ("SetIf" in o ? [o.SetIf.id] : [])));
    expect(ids.has(heroes[3]!.id)).toBe(false);
    expect(heroes.filter((_, i) => i !== 3).every((h) => ids.has(h.id))).toBe(true);
    // A record with no hero of its own (a scene saved before builds) gets the match's build.
    const old = heroesOf(save({ builds: false }).ops);
    const all = new Set(retakeOps(scene(4), undefined, old, roster() as never, tl, minter()).flat().flatMap((o) => ("SetIf" in o ? [o.SetIf.id] : [])));
    expect(old.every((h) => all.has(h.id))).toBe(true);
  });
});
