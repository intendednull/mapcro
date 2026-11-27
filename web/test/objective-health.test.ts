import { describe, expect, it, vi } from "vitest";

// Use the browser (reactive) SolidJS build in Node Vitest so signals & memos track updates.
vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { createRoot } from "solid-js";
import { type Current, groupToggleOps, toggleOps } from "../src/board/objectives";
import { LIMITS } from "../src/gen/limits";
import type { More } from "../src/gen/More";
import type { ObjectiveStatus } from "../src/gen/ObjectiveStatus";
import type { Op } from "../src/gen/Op";
import { ROWS } from "../src/gen/rows";
import { FALLBACK } from "../src/map/fallback-data";
import { modelFromFallback } from "../src/map/model";
import { captured, moreBytes } from "../src/mapstate/build";
import { decodeObjHealth, encodeObjHealth, fnv1a32 } from "../src/mapstate/codec";
import { type SceneObjHealthContext, clearObjHealthOps, setObjectiveHealthOps, writeObjHealthOps } from "../src/mapstate/edit";
import { fromScene } from "../src/mapstate/scene";
import { objHealthScrubLabel } from "../src/player/Camps";

const markers = modelFromFallback(FALLBACK).markers;
const walker = markers.find((m) => m.kind === "t2")!;
const guardian = markers.find((m) => m.kind === "t1")!;
const patron = markers.find((m) => m.kind === "t3")!;
const midboss = markers.find((m) => m.kind === "midboss")!;
const camp = markers.find((m) => m.kind === "camp")!;

interface SimScene {
  state: { id: string; more: More } | undefined;
  objectives: Map<string, { id: string; status: ObjectiveStatus }>;
}

/** Apply `SceneState` & `ObjectiveState` ops in memory (matching crates/schema/src/validate.rs). */
function applyOps(sim: SimScene, ops: readonly Op[]): SimScene {
  let state = sim.state ? { id: sim.state.id, more: { ...sim.state.more } } : undefined;
  const objectives = new Map([...sim.objectives].map(([k, v]) => [k, { ...v }]));
  const objById = new Map([...objectives].map(([k, v]) => [v.id, k]));

  for (const op of ops) {
    if ("Create" in op) {
      const rec = op.Create.record;
      if ("SceneState" in rec) {
        state = { id: op.Create.id, more: { ...(rec.SceneState.more ?? {}) } };
      } else if ("ObjectiveState" in rec) {
        objectives.set(rec.ObjectiveState.key, { id: op.Create.id, status: rec.ObjectiveState.status });
        objById.set(op.Create.id, rec.ObjectiveState.key);
      }
    } else if ("Set" in op) {
      if ("More" in op.Set.value && state && op.Set.id === state.id) {
        const { key, value } = op.Set.value.More;
        if (value === null) delete state.more[key];
        else state.more[key] = value;
      } else if ("ObjectiveStatus" in op.Set.value) {
        const k = objById.get(op.Set.id);
        if (k) objectives.set(k, { id: op.Set.id, status: op.Set.value.ObjectiveStatus });
      }
    } else if ("SetIf" in op) {
      if ("More" in op.SetIf.value && "More" in op.SetIf.expect && state && op.SetIf.id === state.id) {
        const { key, value: expectVal } = op.SetIf.expect.More;
        const haveVal = state.more[key] ?? null;
        if (JSON.stringify(haveVal) !== JSON.stringify(expectVal)) continue;
        const nextVal = op.SetIf.value.More.value;
        if (nextVal === null) delete state.more[key];
        else state.more[key] = nextVal;
      }
    }
  }
  return { state, objectives };
}

const makeCtx = (sim: SimScene, extra: Partial<SceneObjHealthContext> = {}): SceneObjHealthContext => {
  let n = 1;
  return {
    scene: "sc1",
    state: sim.state,
    objectives: sim.objectives,
    markers,
    mint: () => `id_${n++}`,
    ...extra,
  };
};

describe("Objective health manual Scene edits (objective-health-edit.md)", () => {
  it("creates SceneState with rows: 33, has_obj_health: true on a blank scene without falsely claiming other features", () => {
    const empty: SimScene = { state: undefined, objectives: new Map() };
    const ops = setObjectiveHealthOps(makeCtx(empty), walker, 55);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      Create: {
        id: "id_1",
        record: {
          SceneState: {
            scene: "sc1",
            more: { rows: 33, has_obj_health: true, obj_health: [fnv1a32(walker.key), 55, -1] },
          },
        },
      },
    });
    const next = applyOps(empty, ops);
    expect(captured(next.state!.more)).toMatchObject({
      obj_health: true,
      builds: false,
      heroes: false,
      sight: false,
      camps: false,
      doors: false,
      rows: 33,
    });
    expect(decodeObjHealth(next.state!.more.obj_health, markers).get(walker.key)).toEqual({ pct: 55 });

    // Setting 100% on a standing blank-scene objective is a no-op (no SceneState created).
    expect(setObjectiveHealthOps(makeCtx(empty), walker, 100)).toEqual([]);
    // Non-health markers (camps, etc.) emit no ops.
    expect(setObjectiveHealthOps(makeCtx(empty), camp, 50)).toEqual([]);
  });

  it("clears dormant flags when advancing rows < 33, uses Op::SetIf CAS, and preserves rows > 33", () => {
    const dormant: SimScene = {
      state: { id: "st_old", more: { rows: 16, has_builds: true, has_sight: true, has_camps: true } },
      objectives: new Map(),
    };
    const ops = setObjectiveHealthOps(makeCtx(dormant), walker, 65);
    const clearSightIdx = ops.findIndex((o) => "Set" in o && "More" in o.Set.value && o.Set.value.More.key === "has_sight" && o.Set.value.More.value === null);
    const clearCampsIdx = ops.findIndex((o) => "Set" in o && "More" in o.Set.value && o.Set.value.More.key === "has_camps" && o.Set.value.More.value === null);
    const setIfIdx = ops.findIndex((o) => "SetIf" in o && "More" in o.SetIf.value && o.SetIf.value.More.key === "obj_health");
    const rowsIdx = ops.findIndex((o) => "Set" in o && "More" in o.Set.value && o.Set.value.More.key === "rows");
    expect(clearSightIdx).toBeGreaterThanOrEqual(0);
    expect(clearCampsIdx).toBeGreaterThanOrEqual(0);
    expect(setIfIdx).toBeGreaterThanOrEqual(0);
    expect(clearSightIdx).toBeLessThan(rowsIdx);
    expect(clearCampsIdx).toBeLessThan(rowsIdx);

    const next = applyOps(dormant, ops);
    expect(next.state!.more.rows).toBe(33);
    expect(next.state!.more.has_obj_health).toBe(true);
    expect(next.state!.more.has_sight).toBeUndefined();
    expect(next.state!.more.has_camps).toBeUndefined();
    expect(captured(next.state!.more)).toMatchObject({ builds: true, obj_health: true, sight: false, camps: false });
    expect(decodeObjHealth(next.state!.more.obj_health, markers).get(walker.key)).toEqual({ pct: 65 });

    // Dormant `has_builds: true` at `rows: 0` is also cleared before advancing rows to 33.
    const zeroRows: SimScene = { state: { id: "st0", more: { rows: 0, has_builds: true } }, objectives: new Map() };
    const zeroNext = applyOps(zeroRows, setObjectiveHealthOps(makeCtx(zeroRows), guardian, 40));
    expect(zeroNext.state!.more.rows).toBe(33);
    expect(zeroNext.state!.more.has_builds).toBeUndefined();
    expect(captured(zeroNext.state!.more)).toMatchObject({ builds: false, obj_health: true });

    // Existing scene at rows: 42 (e.g. with doors) keeps rows: 42 and never downgrades to 33.
    const newer: SimScene = { state: { id: "st42", more: { rows: 42, has_doors: true, doors: [0, 100, 200, 0, -1, 0] } }, objectives: new Map() };
    const newerOps = setObjectiveHealthOps(makeCtx(newer), guardian, 30);
    expect(newerOps.some((o) => "Set" in o && "More" in o.Set.value && o.Set.value.More.key === "rows")).toBe(false);
    const newerNext = applyOps(newer, newerOps);
    expect(newerNext.state!.more.rows).toBe(42);
    expect(newerNext.state!.more.has_doors).toBe(true);
    expect(newerNext.state!.more.has_obj_health).toBe(true);
  });

  it("enforces Op::SetIf CAS on concurrent edits, preflights max_more_bytes, and stays dormant when written < 33", () => {
    expect(ROWS.obj_health.index).toBe(32);
    const empty: SimScene = { state: undefined, objectives: new Map() };
    expect(setObjectiveHealthOps(makeCtx(empty, { written: 32 }), walker, 50)).toEqual([]);

    // Concurrent CAS: peer B edits walker while peer A edits guardian against the same base snapshot.
    const base = applyOps(empty, setObjectiveHealthOps(makeCtx(empty), walker, 80));
    const peerBOps = setObjectiveHealthOps(makeCtx(base), walker, 40);
    const peerAOps = setObjectiveHealthOps(makeCtx(base), guardian, 60);
    const afterB = applyOps(base, peerBOps);
    const afterBThenA = applyOps(afterB, peerAOps);
    // Peer A's SetIf expected `[walker, 80, -1]` which no longer matches `[walker, 40, -1]`, so B's edit is NOT clobbered.
    expect(decodeObjHealth(afterBThenA.state!.more.obj_health, markers).get(walker.key)).toEqual({ pct: 40 });
    expect(decodeObjHealth(afterBThenA.state!.more.obj_health, markers).has(guardian.key)).toBe(false);

    // Near-cap SceneState.more: preflight rejects cleanly with [] (including omitting ObjectiveState op).
    const nearCap: SimScene = {
      state: {
        id: "st_cap",
        more: {
          rows: 42,
          has_builds: true,
          has_camps: true,
          camps: Array.from({ length: 738 }, (_, i) => 1_000_000_000 + i),
        },
      },
      objectives: new Map([[guardian.key, { id: "g1", status: "Destroyed" }]]),
    };
    expect(moreBytes(nearCap.state!.more)).toBeLessThanOrEqual(LIMITS.max_more_bytes);
    expect(setObjectiveHealthOps(makeCtx(nearCap), guardian, 50)).toEqual([]);
  });

  it("0% marks objective Destroyed (and Mid-Boss cleared) and drops its obj_health triple; 1..100% revives from Destroyed/cleared in 1 tx", () => {
    let sim: SimScene = { state: undefined, objectives: new Map() };
    sim = applyOps(sim, setObjectiveHealthOps(makeCtx(sim), walker, 55));
    expect(decodeObjHealth(sim.state!.more.obj_health, markers).get(walker.key)).toEqual({ pct: 55 });

    // Drag to 0%: marks Destroyed AND removes triple in one transaction.
    const killOps = setObjectiveHealthOps(makeCtx(sim), walker, 0);
    expect(killOps.some((o) => "Create" in o && "ObjectiveState" in o.Create.record && o.Create.record.ObjectiveState.status === "Destroyed")).toBe(true);
    expect(killOps.some((o) => "SetIf" in o && "More" in o.SetIf.value && o.SetIf.value.More.key === "obj_health" && o.SetIf.value.More.value === null)).toBe(true);
    sim = applyOps(sim, killOps);
    expect(sim.objectives.get(walker.key)?.status).toBe("Destroyed");
    expect(sim.state!.more.obj_health).toBeUndefined();
    expect(sim.state!.more.has_obj_health).toBe(true);

    // Drag upward on Destroyed objective to 60%: revives to Active AND writes 60% in one transaction.
    const reviveOps = setObjectiveHealthOps(makeCtx(sim), walker, 60);
    expect(reviveOps.some((o) => "Set" in o && "ObjectiveStatus" in o.Set.value && o.Set.value.ObjectiveStatus === "Active")).toBe(true);
    expect(reviveOps.some((o) => "SetIf" in o && "More" in o.SetIf.value && o.SetIf.value.More.key === "obj_health")).toBe(true);
    sim = applyOps(sim, reviveOps);
    expect(sim.objectives.get(walker.key)?.status).toBe("Active");
    expect(decodeObjHealth(sim.state!.more.obj_health, markers).get(walker.key)).toEqual({ pct: 60 });

    // Setting 100% on Active objective elides its triple while keeping has_obj_health: true.
    sim = applyOps(sim, setObjectiveHealthOps(makeCtx(sim), walker, 100));
    expect(sim.state!.more.obj_health).toBeUndefined();
    expect(sim.state!.more.has_obj_health).toBe(true);

    // Mid-Boss cleared via replay `camps` baseline (no ObjectiveState yet): reviving to 70% creates Active ObjectiveState + writes 70%.
    const clearedBoss: SimScene = {
      state: { id: "st_boss", more: { rows: 42, has_camps: true, camps: [fnv1a32(midboss.key), 1, 180] } },
      objectives: new Map(),
    };
    const bossRevive = applyOps(clearedBoss, setObjectiveHealthOps(makeCtx(clearedBoss), midboss, 70));
    expect(bossRevive.objectives.get(midboss.key)?.status).toBe("Active");
    expect(decodeObjHealth(bossRevive.state!.more.obj_health, markers).get(midboss.key)).toEqual({ pct: 70 });
    createRoot((dispose) => {
      const ms = fromScene({
        heroes: () => [],
        roster: () => [],
        objectives: () => bossRevive.objectives,
        waves: () => new Map(),
        state: () => bossRevive.state?.more,
        markers: () => markers,
      });
      expect(ms.marker(midboss.key).down()).toBe(false);
      expect(ms.marker(midboss.key).health()).toEqual({ pct: 70 });
      dispose();
    });

    // Mid-Boss to 0%: marks Destroyed (Cleared) and drops triple.
    const bossCleared = applyOps(bossRevive, setObjectiveHealthOps(makeCtx(bossRevive), midboss, 0));
    expect(bossCleared.objectives.get(midboss.key)?.status).toBe("Destroyed");
    expect(bossCleared.state!.more.obj_health).toBeUndefined();
  });

  it("handles Patron stages (Stage 1 / Stage 2) and clears stale partial health on 1-click toggle & group toggle", () => {
    let sim: SimScene = { state: undefined, objectives: new Map() };
    // Patron Stage 2 · 100% via context menu.
    sim = applyOps(sim, setObjectiveHealthOps(makeCtx(sim), patron, 100, 2));
    expect(sim.objectives.get(patron.key)?.status).toBe("Stage2");
    expect(decodeObjHealth(sim.state!.more.obj_health, markers).get(patron.key)).toEqual({ pct: 100, stage: 2 });

    // Setting 40% on Stage 2 Patron keeps Stage 2.
    sim = applyOps(sim, setObjectiveHealthOps(makeCtx(sim), patron, 40));
    expect(sim.objectives.get(patron.key)?.status).toBe("Stage2");
    expect(decodeObjHealth(sim.state!.more.obj_health, markers).get(patron.key)).toEqual({ pct: 40, stage: 2 });

    // 1-click stage cycle (Stage2 -> Destroyed) clears stale partial health triple in the same tx.
    const cycle1 = toggleOps(patron, markers, sim.objectives as Current, "sc1", () => "m1", undefined, makeCtx(sim));
    sim = applyOps(sim, cycle1);
    expect(sim.objectives.get(patron.key)?.status).toBe("Destroyed");
    expect(sim.state!.more.obj_health).toBeUndefined();

    // Active Patron at 35% -> 1-click cycles to Stage2 and clears stale 35% so Stage 2 starts at 100%!
    sim = applyOps(sim, setObjectiveHealthOps(makeCtx(sim), patron, 35, 1));
    expect(sim.objectives.get(patron.key)?.status).toBe("Active");
    expect(decodeObjHealth(sim.state!.more.obj_health, markers).get(patron.key)).toEqual({ pct: 35, stage: 1 });
    const cycle2 = toggleOps(patron, markers, sim.objectives as Current, "sc1", () => "m2", undefined, makeCtx(sim));
    sim = applyOps(sim, cycle2);
    expect(sim.objectives.get(patron.key)?.status).toBe("Stage2");
    expect(sim.state!.more.obj_health).toBeUndefined();

    // Group toggle destroying walker + guardian clears both partial health entries in one tx.
    sim = applyOps(sim, setObjectiveHealthOps(makeCtx(sim), walker, 45));
    sim = applyOps(sim, setObjectiveHealthOps(makeCtx(sim), guardian, 25));
    const grp = groupToggleOps(walker, [walker, guardian], markers, sim.objectives as Current, "sc1", (() => { let i = 0; return () => `g${i++}`; })(), undefined, makeCtx(sim));
    sim = applyOps(sim, grp);
    expect(sim.objectives.get(walker.key)?.status).toBe("Destroyed");
    expect(sim.objectives.get(guardian.key)?.status).toBe("Destroyed");
    expect(sim.state!.more.obj_health).toBeUndefined();
  });

  it("preserves -1 unknown entries for untouched objectives on partial-timeline scenes", () => {
    const partialInts = encodeObjHealth(
      new Map([
        [walker.key, { pct: 70 }],
        [guardian.key, null],
      ]),
      markers,
    ).ints;
    expect(decodeObjHealth(partialInts, markers).get(guardian.key)).toBeNull();

    const sim: SimScene = {
      state: { id: "st_partial", more: { rows: 40, has_obj_health: true, obj_health: partialInts } },
      objectives: new Map(),
    };
    // Edit walker to 45% -> guardian's `-1` unknown triple is preserved intact!
    const afterWalker = applyOps(sim, setObjectiveHealthOps(makeCtx(sim), walker, 45));
    const decoded = decodeObjHealth(afterWalker.state!.more.obj_health, markers);
    expect(decoded.get(walker.key)).toEqual({ pct: 45 });
    expect(decoded.get(guardian.key)).toBeNull();

    // Setting walker to 100% elides walker while still preserving guardian's `-1` unknown triple!
    const afterFull = applyOps(afterWalker, setObjectiveHealthOps(makeCtx(afterWalker), walker, 100));
    const decodedFull = decodeObjHealth(afterFull.state!.more.obj_health, markers);
    expect(decodedFull.has(walker.key)).toBe(false);
    expect(decodedFull.get(guardian.key)).toBeNull();

    // Direct writeObjHealthOps & clearObjHealthOps preserve untouched `-1` entries too.
    const afterClear = applyOps(afterWalker, clearObjHealthOps(makeCtx(afterWalker), [walker.key]));
    expect(decodeObjHealth(afterClear.state!.more.obj_health, markers).get(guardian.key)).toBeNull();
    const directOps = writeObjHealthOps(makeCtx(afterClear), new Map([[walker.key, { pct: 85 }], [guardian.key, null]]));
    const afterDirect = applyOps(afterClear, directOps);
    expect(decodeObjHealth(afterDirect.state!.more.obj_health, markers).get(walker.key)).toEqual({ pct: 85 });
    expect(decodeObjHealth(afterDirect.state!.more.obj_health, markers).get(guardian.key)).toBeNull();
  });

  it("formats §4b short live scrub readout labels cleanly", () => {
    expect(objHealthScrubLabel("t2", 65)).toBe("Walker · 65%");
    expect(objHealthScrubLabel("t1", 0)).toBe("Guardian · Destroyed");
    expect(objHealthScrubLabel("midboss", 0)).toBe("Mid-Boss · Cleared");
    expect(objHealthScrubLabel("midboss", 75)).toBe("Mid-Boss · 75%");
    expect(objHealthScrubLabel("t3", 80, 1)).toBe("Patron · 80%");
    expect(objHealthScrubLabel("t3", 40, 2)).toBe("Patron (Weakened) · 40%");
    expect(objHealthScrubLabel("t3", 0, 2)).toBe("Patron · Destroyed");
  });
});
