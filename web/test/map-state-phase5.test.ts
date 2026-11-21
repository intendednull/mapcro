// Map-state Phase 5, Release R1 tests (docs/specs/map-state-phase5-plan.md §1–§9):
// - Exhaustive §9 round-trip property across all 40 rows (Group A written=27 & Group B written=40)
// - FNV-1a marker hashes (zero collisions on FALLBACK), collision fallback, over-length omission,
//   and byte-cap feature drop order
// - `shiftEdges` exact round-trip & monotonic clamping (Q7)
// - Sight (`unseen` vs legacy `visible`), `toggleSightOps`, derived skulls/urn, status-wins rules
// - Marker clicks (`objectives.ts`) with baseline `shown`
// - TD-163 `sitesAt` remapped `markerKey`
// - Dormant Retake, per-feature tier table, re-picked slot rule, `pickHeroOps`, TD-145 `decideStep`
// - Copy filter (`addSceneOps`) stripping `Ahead` keys and lowering `rows`

import { describe, expect, it, vi } from "vitest";

// Browser build of solid-js so signals and memos track reactively in vitest node workers.
vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { createRoot, createSignal } from "solid-js";
import type { Entry } from "../src/gen/Entry";
import type { More } from "../src/gen/More";
import type { ObjectiveStatus } from "../src/gen/ObjectiveStatus";
import type { Op } from "../src/gen/Op";
import type { PlayerState } from "../src/gen/PlayerState";
import type { Record as Rec } from "../src/gen/Record";
import type { RecordId } from "../src/gen/RecordId";
import { ROWS, type RowKey } from "../src/gen/rows";
import { FALLBACK } from "../src/map/fallback-data";
import { shiftEdges } from "../src/map/lanes";
import { modelFromFallback } from "../src/map/model";
import { groupToggleOps, isOn, toggleOps } from "../src/board/objectives";
import { addSceneOps } from "../src/board/scenes";
import type { BoardState, Player, Slot } from "../src/board/state";
import { WRITTEN, captured } from "../src/mapstate/build";
import {
  MAX_CAMPS, MAX_OBJ_HEALTH, MAX_POWERUPS,
  decodeEdges, encodeCamps, encodeObjHealth, encodePowerups, encodeRift, encodeUrn, fnv1a32, markerHashIndex,
} from "../src/mapstate/codec";
import { pickHeroOps, toggleSightOps } from "../src/mapstate/edit";
import { fromScene } from "../src/mapstate/scene";
import { heroDraw } from "../src/mapstate/shown";
import { FEATURES, type MapState, fromTimeline } from "../src/mapstate/state";
import { decideStep } from "../src/mapstate/undo";
import { DROP_ORDER, canRetake, matchSceneOps, opsBytes, retakeOps, sourceOf } from "../src/match/save";
import { type CampAt, type PowerupAt, type Timeline, markerKey, sitesAt, slotKey } from "../src/match/timeline";
import { tipFacts } from "../src/player/Camps";
import { markerStates } from "../src/player/markerStates";
import { keyOf, markers, metadata, replay } from "./support/synthetic-match";

const WRITTEN_A = 27;
const WRITTEN_B = 40;

const roster = (tl: Timeline): Slot[] =>
  tl.players.map((p, i) => ({
    id: `slot-${i}`,
    slot: { team: p.team === "amber" ? "Amber" : "Sapphire", slot: p.slot, name: "", hero: p.hero_id },
  }));

/** Replay fixture with all 4 real buff names, all 3 CC kinds, heights 1 & 2, zipline, skulls,
 * camps/heals/crates/midboss, obj_health for all living health objectives, rifts, urn (ground,
 * returning, carried, none), and Rejuvenator. */
function richReplay(): Timeline {
  const base = replay();
  const healKey = keyOf("heal");
  const crateKey = keyOf("crate");
  const allHealth = markers
    .filter((m) => m.kind === "t1" || m.kind === "t2" || m.kind === "barracks" || m.kind === "shrine" || m.kind === "t3" || m.kind === "midboss")
    .map((m) => {
      if (m.key === "walker:amber:lane1:1") return { key: m.key, at: [[0, 100], [2, 80], [4, 35], [6, 0]] as Array<[number, number]> };
      if (m.key === "patron:amber") return { key: m.key, at: [[0, 100], [8, 60]] as Array<[number, number]>, stage: [[0, 1], [10, 2]] as Array<[number, number]> };
      if (m.kind === "t3") return { key: m.key, at: [[0, 100]] as Array<[number, number]>, stage: [[0, 1]] as Array<[number, number]> };
      return { key: m.key, at: [[0, 100]] as Array<[number, number]> };
    });
  return {
    ...base,
    objectives: base.objectives.map((o) => ({ ...o, key: markerKey(o.key, markers) ?? o.key })),
    players: base.players.map((p, i) => ({
      ...p,
      items: [[0, 9000 + i, 1]],
      abilities: [[0, 5000 + i, 1]],
      level: [[0, 1 + i]],
      kills: [[0, i % 3]],
      assists: [[0, i % 2]],
      max_health: [[0, 600 + 20 * i]],
      pickups: [[0, [10, 5, 2, 1, 0.5]]],
    })),
    powerups: [
      {
        key: keyOf("powerup"),
        available: [0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1],
        stale: [],
        spawns: [
          { t: 1, buff: "gun", taken_s: 3 },
          { t: 6, buff: "casting", taken_s: 9 },
          { t: 12, buff: "movement" },
        ],
      },
      {
        key: keyOf("powerup", 1),
        available: [1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        stale: [],
        spawns: [
          { t: 0, buff: "survival", taken_s: 2 },
          { t: 4, buff: "casting" },
        ],
      },
    ],
    camps: [
      ...markers
        .filter((m) => m.kind === "camp")
        .map((m, idx) => ({
          key: m.key,
          first_s: idx === 0 ? 1 : 0,
          cleared: idx === 3 ? ([[2, 4], [9, 400]] as Array<[number, number]>) : [],
        })),
      { key: keyOf("midboss"), first_s: 0, cleared: [[3, 400]] as Array<[number, number]> },
    ],
    heals: markers
      .filter((m) => m.kind === "heal")
      .map((m) => ({ key: m.key, first_s: 0, cleared: m.key === healKey ? ([[2, 8]] as Array<[number, number]>) : [] })),
    crates: markers
      .filter((m) => m.kind === "crate")
      .map((m) => ({ key: m.key, first_s: 0, cleared: m.key === crateKey ? ([[1, 7]] as Array<[number, number]>) : [] })),
    objective_health: allHealth,
    rifts: [
      { key: keyOf("koth"), start_s: 2, live_s: 2, end_s: 5, give_up_s: 5, capture: [[20, 0, 0], [30, 40, 10], [40, 100, 35]] },
      { key: keyOf("koth", 1), start_s: 8, live_s: 8, end_s: 11, capture: [[80, 0, 0], [100, 20, 80]] },
    ],
  } as unknown as Timeline;
}

/** Build a scene via `matchSceneOps` and open it with `fromScene`. */
function captureToScene(tl: Timeline, second: number, written: number, rs = roster(tl)) {
  let n = 0;
  const saved = matchSceneOps(rs, [], undefined, tl, second, markers, () => `r${n++}`, [], {
    source: sourceOf(tl),
    written,
  });
  const heroes: Array<{ id: RecordId; state: PlayerState }> = [];
  const objectives = new Map<string, { status: ObjectiveStatus }>();
  const waves = new Map<string, { t: number; more?: More }>();
  let sceneState: More | undefined;
  let frameT: number | undefined;
  let tier: string | undefined;
  for (const op of saved.ops) {
    if (!("Create" in op)) continue;
    const rec = op.Create.record;
    if ("Scene" in rec) {
      frameT = rec.Scene.source?.t;
      tier = rec.Scene.source?.tier;
    } else if ("PlayerState" in rec) {
      heroes.push({ id: op.Create.id, state: rec.PlayerState });
    } else if ("ObjectiveState" in rec) {
      objectives.set(rec.ObjectiveState.key, { status: rec.ObjectiveState.status });
    } else if ("Wave" in rec) {
      waves.set(rec.Wave.lane, { t: rec.Wave.t, ...(rec.Wave.more ? { more: rec.Wave.more } : {}) });
    } else if ("SceneState" in rec) {
      sceneState = rec.SceneState.more;
    }
  }
  return { saved, heroes, objectives, waves, sceneState, frameT, tier, rs };
}

describe("Phase 5 R1: exhaustive §9 round-trip property (Groups A & B)", () => {
  it("R1 ships with WRITTEN = 16 and 40 rows (rows 16–39 all ahead)", () => {
    expect(WRITTEN).toBe(16);
    const keys = Object.keys(ROWS) as RowKey[];
    expect(keys).toHaveLength(40);
    for (const k of keys) {
      if (ROWS[k].index < 16) expect(ROWS[k].status).toBe("live");
      else expect(ROWS[k].status).toBe("ahead");
    }
  });

  it("fromScene(capture(fromTimeline(t))) === fromTimeline(t) for every row (compile-checked over RowKey)", () => {
    const tl = richReplay();
    const rs = roster(tl);
    const hitRows = new Set<RowKey>();

    // Exhaustive per-row check table: adding a row to ROWS without checking it here is a type error.
    type Ctx = { p: MapState; s: MapState; second: number; cap: ReturnType<typeof captureToScene>; written: number };
    const ROW_CHECKS: { [K in RowKey]-?: (c: Ctx) => void } = {
      hero: ({ p, s }) => {
        for (const sl of rs) {
          const k = slotKey(sl.slot.team, sl.slot.slot);
          expect(s.hero(k).hero()).toBe(p.hero(k).hero());
        }
      },
      name: ({ s }) => {
        // Match names are never stored in `more.name` (D1).
        expect(s.hero("amber-0").name()).toBeNull();
      },
      rows: ({ cap, written }) => {
        expect(cap.sceneState?.rows).toBe(written);
      },
      has_builds: ({ cap }) => {
        expect(cap.sceneState?.has_builds).toBe(true);
      },
      build: ({ cap }) => {
        expect(cap.sceneState?.build).toBe(tl.build);
      },
      items: ({ cap }) => {
        expect(cap.heroes.some((h) => Array.isArray(h.state.more?.items))).toBe(true);
      },
      abilities: ({ cap }) => {
        expect(cap.heroes.some((h) => Array.isArray(h.state.more?.abilities))).toBe(true);
      },
      build_order: ({ cap }) => {
        expect(cap.heroes.some((h) => h.state.more?.build_order === undefined || Array.isArray(h.state.more?.build_order))).toBe(true);
      },
      level: ({ cap }) => {
        expect(cap.heroes.every((h) => h.state.more?.level === undefined || typeof h.state.more?.level === "number")).toBe(true);
      },
      health: ({ p, s }) => {
        for (const sl of rs) {
          const k = slotKey(sl.slot.team, sl.slot.slot);
          expect(s.hero(k).health()).toBe(p.hero(k).health());
        }
      },
      pickups: ({ cap }) => {
        expect(cap.heroes.some((h) => Array.isArray(h.state.more?.pickups))).toBe(true);
      },
      kills: ({ cap }) => {
        expect(cap.heroes.every((h) => typeof h.state.more?.kills === "number")).toBe(true);
      },
      deaths: ({ cap }) => {
        expect(cap.heroes.every((h) => typeof h.state.more?.deaths === "number")).toBe(true);
      },
      assists: ({ cap }) => {
        expect(cap.heroes.every((h) => h.state.more?.assists === undefined || typeof h.state.more?.assists === "number")).toBe(true);
      },
      max_health: ({ cap }) => {
        expect(cap.heroes.every((h) => h.state.more?.max_health === undefined || typeof h.state.more?.max_health === "number")).toBe(true);
      },
      has_heroes: ({ cap }) => {
        expect(cap.sceneState?.has_heroes).toBe(true);
      },
      // Group A (16–26)
      has_sight: ({ p, s }) => expect(s.has("sight")).toBe(p.has("sight")),
      unseen: ({ p, s }) => {
        for (const sl of rs) {
          const k = slotKey(sl.slot.team, sl.slot.slot);
          expect(s.hero(k).inSight(), k).toBe(p.hero(k).inSight());
        }
      },
      has_cc: ({ p, s }) => expect(s.has("cc")).toBe(p.has("cc")),
      cc: ({ p, s }) => {
        for (const sl of rs) {
          const k = slotKey(sl.slot.team, sl.slot.slot);
          expect(s.hero(k).cc(), k).toEqual(p.hero(k).cc());
        }
      },
      has_movement: ({ p, s }) => expect(s.has("movement")).toBe(p.has("movement")),
      height: ({ p, s }) => {
        for (const sl of rs) {
          const k = slotKey(sl.slot.team, sl.slot.slot);
          // Street level (0) is the omitted default and reads as `undefined` in fromScene (plan §3 row 21).
          const ph = p.hero(k).height();
          expect(s.hero(k).height(), k).toBe(ph === 1 || ph === 2 ? ph : undefined);
        }
      },
      zipline: ({ p, s }) => {
        for (const sl of rs) {
          const k = slotKey(sl.slot.team, sl.slot.slot);
          expect(s.hero(k).zipline(), k).toBe(p.hero(k).zipline());
        }
      },
      has_lanes: ({ p, s }) => expect(s.has("lanes")).toBe(p.has("lanes")),
      edges: ({ p, s }) => {
        for (const lane of ["lane1", "lane4", "lane6"]) {
          expect(s.lane(lane).edges(), lane).toEqual(p.lane(lane).edges());
        }
      },
      has_skulls: ({ p, s }) => expect(s.has("skulls")).toBe(p.has("skulls")),
      skulls: ({ p, s }) => {
        expect(s.scene().deaths()).toEqual(p.scene().deaths());
      },
      // Group B (27–39)
      has_camps: ({ p, s, written }) => {
        if (written >= WRITTEN_B) expect(s.has("camps")).toBe(p.has("camps"));
        else expect(s.has("camps")).toBe(false);
      },
      camps: ({ p, s, written }) => {
        if (written < WRITTEN_B) return;
        for (const m of markers) {
          expect(s.marker(m.key).camp(), m.key).toEqual(p.marker(m.key).camp());
          expect(s.marker(m.key).shopClosed(), m.key).toBe(p.marker(m.key).shopClosed());
          expect(s.marker(m.key).down(), m.key).toBe(p.marker(m.key).down());
        }
      },
      has_powerups: ({ p, s, written }) => {
        if (written >= WRITTEN_B) expect(s.has("powerups")).toBe(p.has("powerups"));
        else expect(s.has("powerups")).toBe(false);
      },
      powerups: ({ p, s, written }) => {
        if (written < WRITTEN_B) return;
        for (const m of markers.filter((x) => x.kind === "powerup")) {
          expect(s.marker(m.key).powerup(), m.key).toEqual(p.marker(m.key).powerup());
          expect(s.marker(m.key).site(), m.key).toBe(p.marker(m.key).site());
        }
      },
      has_obj_health: ({ p, s, written }) => {
        if (written >= WRITTEN_B) expect(s.has("obj_health")).toBe(p.has("obj_health"));
        else expect(s.has("obj_health")).toBe(false);
      },
      obj_health: ({ p, s, written }) => {
        if (written < WRITTEN_B) return;
        for (const m of markers) {
          expect(s.marker(m.key).health(), m.key).toEqual(p.marker(m.key).health());
        }
      },
      has_rifts: ({ p, s, written }) => {
        if (written >= WRITTEN_B) expect(s.has("rifts")).toBe(p.has("rifts"));
        else expect(s.has("rifts")).toBe(false);
      },
      rift: ({ p, s, written }) => {
        if (written < WRITTEN_B) return;
        for (const m of markers.filter((x) => x.kind === "koth")) {
          expect(s.marker(m.key).rift(), m.key).toEqual(p.marker(m.key).rift());
          expect(s.marker(m.key).site(), m.key).toBe(p.marker(m.key).site());
        }
      },
      has_urn: ({ p, s, written }) => {
        if (written >= WRITTEN_B) expect(s.has("urn")).toBe(p.has("urn"));
        else expect(s.has("urn")).toBe(false);
      },
      urn: ({ p, s, written }) => {
        if (written < WRITTEN_B) return;
        expect(s.scene().urn()).toEqual(p.scene().urn());
        for (const m of markers.filter((x) => x.kind === "urn")) {
          expect(s.marker(m.key).site(), m.key).toBe(p.marker(m.key).site());
        }
      },
      urn_at: ({ p, s, written }) => {
        if (written < WRITTEN_B) return;
        expect(s.scene().urn()?.at).toEqual(p.scene().urn()?.at);
      },
      has_rejuv: ({ p, s, written }) => {
        if (written >= WRITTEN_B) expect(s.has("rejuv")).toBe(p.has("rejuv"));
        else expect(s.has("rejuv")).toBe(false);
      },
      rejuv: ({ p, s, written }) => {
        if (written < WRITTEN_B) return;
        expect(s.scene().rejuv()).toEqual(p.scene().rejuv());
      },
    };

    for (const written of [WRITTEN_A, WRITTEN_B]) {
      for (const second of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
        const cap = captureToScene(tl, second, written, rs);
        createRoot((dispose) => {
          const p = fromTimeline({ tl: () => tl, t: () => second, markers: () => markers });
          const s = fromScene({
            heroes: () => cap.heroes,
            roster: () => rs,
            objectives: () => cap.objectives,
            waves: () => cap.waves,
            state: () => cap.sceneState,
            tier: () => cap.tier,
            frame: () => cap.frameT,
            markers: () => markers,
          });
          for (const k of Object.keys(ROW_CHECKS) as RowKey[]) {
            ROW_CHECKS[k]({ p, s, second, cap, written });
            hitRows.add(k);
          }
          if (written === WRITTEN_B) {
            expect(FEATURES.filter((f) => s.has(f))).toEqual(FEATURES.filter((f) => p.has(f)));
          }
          dispose();
        });
      }
    }
    expect(hitRows.size).toBe(40);
  });

  it("round-trips metadata tier on both written=27 and written=40 (only skulls captured from Phase 5)", () => {
    const rs = roster(metadata);
    for (const written of [WRITTEN_A, WRITTEN_B]) {
      const cap = captureToScene(metadata, 5, written, rs);
      createRoot((dispose) => {
        const p = fromTimeline({ tl: () => metadata, t: () => 5, markers: () => markers });
        const s = fromScene({
          heroes: () => cap.heroes,
          roster: () => rs,
          objectives: () => cap.objectives,
          waves: () => cap.waves,
          state: () => cap.sceneState,
          tier: () => cap.tier,
          frame: () => cap.frameT,
          markers: () => markers,
        });
        expect(FEATURES.filter((f) => s.has(f))).toEqual(["skulls"]);
        expect(s.scene().deaths()).toEqual(p.scene().deaths());
        expect(s.scene().deaths().length).toBeGreaterThan(0);
        dispose();
      });
    }
  });
});

describe("FNV-1a hashes, collision fallback, over-length caps & byte-cap drop order", () => {
  it("FALLBACK has zero FNV-1a 32-bit collisions across every marker", () => {
    const all = modelFromFallback(FALLBACK).markers;
    const { byHash, collisions } = markerHashIndex(all);
    expect(collisions.size).toBe(0);
    expect(byHash.size).toBe(all.length);
  });

  it("omits colliding marker keys from baseline and falls back to ObjectiveState", () => {
    // Known 32-bit FNV-1a collision pair: "costarring" and "liquid".
    expect(fnv1a32("costarring")).toBe(fnv1a32("liquid"));
    const collidingMarkers = [
      ...markers,
      { key: "costarring", kind: "camp" as const, team: "neutral" as const, lane: null, at: { x: 100, y: 100 } },
      { key: "liquid", kind: "camp" as const, team: "neutral" as const, lane: null, at: { x: 200, y: 200 } },
    ];
    const camps = new Map<string, CampAt>([
      ["costarring", { state: "cleared", at: 100 }],
      [keyOf("camp"), { state: "cleared", at: 120 }],
    ]);
    const enc = encodeCamps(camps, 50, collidingMarkers);
    expect(enc.overflow).toBe(false);
    expect(enc.skipped.has("costarring")).toBe(true);
    expect(enc.ints).toHaveLength(3); // only the non-colliding camp

    // Colliding rift / urn site key reports collision so Save falls back to ObjectiveState.
    const riftMarkers = [
      { key: "costarring", kind: "koth" as const, team: "neutral" as const, lane: null, at: { x: 100, y: 100 } },
      { key: "liquid", kind: "koth" as const, team: "neutral" as const, lane: null, at: { x: 200, y: 200 } },
    ];
    expect(encodeRift(new Map([["costarring", { state: "active", giveUp: 100, capture: null }]]), 50, riftMarkers).collision).toBe(true);
    expect(
      encodeUrn(
        { state: "ground", at: { x: 1, y: 2 }, team: null, slot: null, delivery: "costarring", next: null, returns: null },
        50,
        riftMarkers,
      ).collision,
    ).toBe(true);
  });

  it("omits both list and flag when camps > 200, obj_health > 40, or powerups > 4", () => {
    const fakeMarkers = Array.from({ length: 205 }, (_, i) => ({
      key: `camp:neutral:lane1:${i}`,
      kind: "camp" as const,
      team: "neutral" as const,
      lane: null,
      at: { x: i, y: i },
    }));
    const camps = new Map<string, CampAt>(fakeMarkers.map((m) => [m.key, { state: "cleared", at: 200 }]));
    expect(encodeCamps(camps, 10, fakeMarkers).overflow).toBe(true);
    expect(encodeCamps(new Map([...camps].slice(0, MAX_CAMPS)), 10, fakeMarkers).overflow).toBe(false);

    const health = new Map(fakeMarkers.slice(0, MAX_OBJ_HEALTH + 1).map((m) => [m.key, { pct: 50 }]));
    expect(encodeObjHealth(health, fakeMarkers).overflow).toBe(true);
    expect(encodeObjHealth(new Map([...health].slice(0, MAX_OBJ_HEALTH)), fakeMarkers).overflow).toBe(false);

    const powerups = new Map<string, PowerupAt>(
      fakeMarkers.slice(0, MAX_POWERUPS + 1).map((m) => [m.key, { state: "up", buff: "gun" }]),
    );
    expect(encodePowerups(powerups, 10, fakeMarkers).overflow).toBe(true);
    expect(encodePowerups(new Map([...powerups].slice(0, MAX_POWERUPS)), 10, fakeMarkers).overflow).toBe(false);

    // End-to-end Save with > 200 cleared camps omits has_camps/camps and writes ObjectiveStates instead.
    const tl = richReplay();
    const bigTl = {
      ...tl,
      camps: fakeMarkers.map((m) => ({ key: m.key, first_s: 0, cleared: [[0, 200]] as Array<[number, number]> })),
    } as unknown as Timeline;
    let n = 0;
    const saved = matchSceneOps(roster(bigTl), [], undefined, bigTl, 5, fakeMarkers, () => `o${n++}`, [], {
      source: sourceOf(bigTl),
      written: WRITTEN_B,
    });
    const st = saved.ops.find((o) => "Create" in o && "SceneState" in o.Create.record);
    const more = st && "Create" in st && "SceneState" in st.Create.record ? st.Create.record.SceneState.more : undefined;
    expect(more?.has_camps).toBeUndefined();
    expect(more?.camps).toBeUndefined();
    const objOps = saved.ops.filter((o) => "Create" in o && "ObjectiveState" in o.Create.record);
    expect(objOps.length).toBeGreaterThanOrEqual(205);
  });

  it("drops optional features in DROP_ORDER when txBudget is tight, never dropping camps", () => {
    const tl = richReplay();
    const rs = roster(tl);
    const full = captureToScene(tl, 5, WRITTEN_B, rs);
    const fullBytes = opsBytes(full.saved.ops);
    expect(full.sceneState?.has_skulls).toBe(true);
    expect(full.sceneState?.has_camps).toBe(true);

    // Tighten budget just below fullBytes: drops `skulls` first, keeps `sight` & `camps`!
    let n = 0;
    const tight = matchSceneOps(rs, [], undefined, tl, 5, markers, () => `d${n++}`, [], {
      source: sourceOf(tl),
      written: WRITTEN_B,
      txBudget: fullBytes - 10,
    });
    expect(tight.builds).toBe(true);
    const st = tight.ops.find((o) => "Create" in o && "SceneState" in o.Create.record);
    const more = st && "Create" in st && "SceneState" in st.Create.record ? st.Create.record.SceneState.more : undefined;
    expect(more?.has_skulls).toBeUndefined();
    expect(more?.skulls).toBeUndefined();
    expect(more?.has_camps).toBe(true);
    expect(more?.has_sight).toBe(true);

    // Verify DROP_ORDER matches plan §3 verbatim.
    expect(DROP_ORDER).toEqual([
      "skulls", "movement", "cc", "rejuv", "urn", "rifts", "powerups", "obj_health", "lanes", "sight",
    ]);
  });

  it("Group B Save omits ObjectiveState for covered baseline sites but keeps destroyed lane/base objectives", () => {
    const tl = richReplay();
    const cap = captureToScene(tl, 6, WRITTEN_B);
    // At t=6, walker:amber:lane1:1 and guardian:sapphire:lane4 are destroyed (always ObjectiveState).
    expect(cap.objectives.get(markerKey("walker:amber:lane1:1", markers)!)?.status).toBe("Destroyed");
    expect(cap.objectives.get(markerKey("guardian:sapphire:lane4", markers)!)?.status).toBe("Destroyed");
    // Camps, heals, crates, midboss, powerups, rifts, urn points are all covered by baseline -> NO ObjectiveState!
    for (const key of cap.objectives.keys()) {
      expect(key.startsWith("camp:") || key.startsWith("heal:") || key.startsWith("crate:") || key.startsWith("mid_boss:") || key.startsWith("powerup:") || key.startsWith("rift:") || key.startsWith("urn:")).toBe(false);
    }
  });
});

describe("shiftEdges (Q7) & lane drag behaviour", () => {
  it("exact round-trip at Math.round((a0 + b0) / 2) for both even and odd widths, and monotonic clamping", () => {
    for (let a0 = 0; a0 <= 1000; a0 += 37) {
      for (const w of [0, 1, 2, 3, 50, 99, 100, 149, 250, 501, 1000 - a0]) {
        const b0 = Math.min(1000, a0 + w);
        const split = Math.round((a0 + b0) / 2);
        expect(shiftEdges({ amber: a0, sapphire: b0 }, split)).toEqual({ amber: a0, sapphire: b0 });
      }
    }
    // Dragging to edges clamps monotonically and preserves 0 <= amber <= sapphire <= 1000.
    const raw = { amber: 400, sapphire: 601 }; // width 201
    expect(shiftEdges(raw, 0)).toEqual({ amber: 0, sapphire: 100 });
    expect(shiftEdges(raw, 1000)).toEqual({ amber: 899, sapphire: 1000 });
    expect(shiftEdges(raw, 501)).toEqual({ amber: 400, sapphire: 601 });
    expect(decodeEdges([400, 601])).toEqual({ amber: 400, sapphire: 601 });
    expect(decodeEdges([-1, 500])).toBeUndefined();
    expect(decodeEdges([400])).toBeUndefined();
  });

  it("dragging a lane to 0 and back in fromScene preserves original gap width", () => {
    const tl = richReplay();
    const cap = captureToScene(tl, 0, WRITTEN_A);
    // lane4 at t=0 has [425, 574] (width 149, split 500)
    const [waveT, setWaveT] = createSignal(500);
    createRoot((dispose) => {
      const s = fromScene({
        heroes: () => cap.heroes,
        roster: () => cap.rs,
        objectives: () => cap.objectives,
        waves: () => new Map([["lane4", { t: waveT(), more: { edges: [425, 574] } }]]),
        state: () => cap.sceneState,
        tier: () => cap.tier,
        frame: () => cap.frameT,
        markers: () => markers,
      });
      expect(s.lane("lane4").edges()).toEqual({ amber: 425, sapphire: 574 });
      setWaveT(0);
      expect(s.lane("lane4").edges()).toEqual({ amber: 0, sapphire: 74 });
      setWaveT(500);
      expect(s.lane("lane4").edges()).toEqual({ amber: 425, sapphire: 574 });
      dispose();
    });
  });
});

describe("Sight (Q2), toggleSightOps, derived skulls/urn & status-wins rules", () => {
  it("toggleSightOps respects legacy D5 vs has_sight (including clearing pre-Retake visible: false)", () => {
    // Legacy scene (!has_sight): flips PlayerVisible.
    expect(toggleSightOps(false, "p1", { visible: true })).toEqual([{ Set: { id: "p1", value: { PlayerVisible: false } } }]);
    expect(toggleSightOps(false, "p1", { visible: false })).toEqual([{ Set: { id: "p1", value: { PlayerVisible: true } } }]);

    // has_sight: seen -> sets more.unseen = true (never touches PlayerVisible).
    expect(toggleSightOps(true, "p1", { visible: true, more: {} })).toEqual([
      { Set: { id: "p1", value: { More: { key: "unseen", value: true } } } },
    ]);
    // has_sight: unseen via more.unseen -> clears more.unseen.
    expect(toggleSightOps(true, "p1", { visible: true, more: { unseen: true } })).toEqual([
      { Set: { id: "p1", value: { More: { key: "unseen", value: null } } } },
    ]);
    // has_sight: unseen via pre-Retake visible: false + more.unseen -> clears BOTH in one tx!
    expect(toggleSightOps(true, "p1", { visible: false, more: { unseen: true } })).toEqual([
      { Set: { id: "p1", value: { More: { key: "unseen", value: null } } } },
      { Set: { id: "p1", value: { PlayerVisible: true } } },
    ]);
    // has_sight: unseen via pre-Retake visible: false alone -> sets PlayerVisible: true.
    expect(toggleSightOps(true, "p1", { visible: false, more: {} })).toEqual([
      { Set: { id: "p1", value: { PlayerVisible: true } } },
    ]);
  });

  it("has_sight obeys heroDraw under Vision All vs team Vision, and keeps pre-Retake visible: false unseen", () => {
    const tl = richReplay();
    const cap = captureToScene(tl, 1, WRITTEN_A);
    // Hero 0: force visible: false (pre-Retake manual mark) and no more.unseen.
    const h0 = cap.heroes[0]!;
    const nextMore: More = { ...(h0.state.more ?? {}) };
    delete nextMore.unseen;
    h0.state = { ...h0.state, visible: false, more: nextMore };
    createRoot((dispose) => {
      const s = fromScene({
        heroes: () => cap.heroes,
        roster: () => cap.rs,
        objectives: () => cap.objectives,
        waves: () => cap.waves,
        state: () => cap.sceneState,
        tier: () => cap.tier,
        frame: () => cap.frameT,
        markers: () => markers,
      });
      expect(s.has("sight")).toBe(true);
      expect(s.hero("amber-0").inSight()).toBe(false);
      // Vision All never fades; Sapphire Vision fades unseen Amber hero.
      expect(heroDraw({ team: "amber", inSight: false, lastSeen: null }, { vision: "all", lastSeen: true }, true, true)).toEqual({ as: "seen" });
      expect(heroDraw({ team: "amber", inSight: false, lastSeen: null }, { vision: "sapphire", lastSeen: true }, true, true)).toEqual({ as: "faded" });
      expect(heroDraw({ team: "amber", inSight: false, lastSeen: null }, { vision: "amber", lastSeen: true }, true, true)).toEqual({ as: "seen" });
      dispose();
    });
  });

  it("dragging a dead hero moves its skull; reviving hides its skull; dragging carrier moves carried urn", () => {
    const tl = richReplay();
    // t=5: amber-3 and sapphire-3 die (skulls present). t=3: sapphire-1 carries urn.
    const cap5 = captureToScene(tl, 5, WRITTEN_A);
    const deadIdx = cap5.heroes.findIndex((h) => h.state.slot === "slot-3");
    const [deadPos, setDeadPos] = createSignal(cap5.heroes[deadIdx]!.state.pos);
    const [deadAlive, setDeadAlive] = createSignal(false);
    createRoot((dispose) => {
      const s = fromScene({
        heroes: () => cap5.heroes.map((h, i) => (i === deadIdx ? { ...h, state: { ...h.state, pos: deadPos(), alive: deadAlive() } } : h)),
        roster: () => cap5.rs,
        objectives: () => cap5.objectives,
        waves: () => cap5.waves,
        state: () => cap5.sceneState,
        tier: () => cap5.tier,
        frame: () => cap5.frameT,
        markers: () => markers,
      });
      expect(s.scene().deaths().find((d) => d.slot === "amber-3")?.at).toEqual(deadPos());
      setDeadPos({ x: 3333, y: -2222 });
      expect(s.scene().deaths().find((d) => d.slot === "amber-3")?.at).toEqual({ x: 3333, y: -2222 });
      setDeadAlive(true);
      expect(s.scene().deaths().find((d) => d.slot === "amber-3")).toBeUndefined();
      dispose();
    });

    const cap3 = captureToScene(tl, 3, WRITTEN_B);
    const carrierIdx = cap3.heroes.findIndex((h) => h.state.slot === "slot-7"); // sapphire-1
    const [carrierPos, setCarrierPos] = createSignal(cap3.heroes[carrierIdx]!.state.pos);
    createRoot((dispose) => {
      const s = fromScene({
        heroes: () => cap3.heroes.map((h, i) => (i === carrierIdx ? { ...h, state: { ...h.state, pos: carrierPos() } } : h)),
        roster: () => cap3.rs,
        objectives: () => cap3.objectives,
        waves: () => cap3.waves,
        state: () => cap3.sceneState,
        tier: () => cap3.tier,
        frame: () => cap3.frameT,
        markers: () => markers,
      });
      expect(s.scene().urn()?.state).toBe("carried");
      expect(s.scene().urn()?.at).toEqual(carrierPos());
      setCarrierPos({ x: -1234, y: 4567 });
      expect(s.scene().urn()?.at).toEqual({ x: -1234, y: 4567 });
      dispose();
    });
  });

  it("status wins over baseline camp timers, powerup buffs, and rift/urn tips", () => {
    const tl = richReplay();
    const cap = captureToScene(tl, 3, WRITTEN_B);
    const campKey = keyOf("camp", 3); // cleared at t=3
    const pwrKey = keyOf("powerup", 1); // down at t=3; at t=4 it's up
    const cap4 = captureToScene(tl, 4, WRITTEN_B);
    const riftKey = keyOf("koth"); // active at t=4

    const [overrides, setOverrides] = createSignal(new Map<string, { status: ObjectiveStatus }>());
    createRoot((dispose) => {
      const s = fromScene({
        heroes: () => cap4.heroes,
        roster: () => cap4.rs,
        objectives: () => new Map([...cap4.objectives, ...overrides()]),
        waves: () => cap4.waves,
        state: () => cap4.sceneState,
        tier: () => cap4.tier,
        frame: () => cap4.frameT,
        markers: () => markers,
      });
      const keys = markers.map((m) => m.key);
      const ms = markerStates({ ms: () => s, player: () => false, health: () => true }, () => keys);
      // Baseline: powerup 1 is up ("casting"), rift 0 is active.
      expect(ms.status(pwrKey)).toBe("Active");
      expect(ms.buff(pwrKey)).toBe("casting");
      expect(ms.status(riftKey)).toBe("Active");
      expect(tipFacts(s, riftKey, true, s.scene().urn()).rift?.state).toBe("active");

      // Override powerup -> Destroyed, rift -> Destroyed: status wins!
      setOverrides(
        new Map<string, { status: ObjectiveStatus }>([
          [pwrKey, { status: "Destroyed" }],
          [riftKey, { status: "Destroyed" }],
        ]),
      );
      expect(ms.status(pwrKey)).toBe("Destroyed");
      expect(ms.buff(pwrKey)).toBeUndefined();
      expect(tipFacts(s, pwrKey, true, s.scene().urn()).powerup).toBeUndefined();
      expect(ms.status(riftKey)).toBe("Destroyed");
      expect(tipFacts(s, riftKey, true, s.scene().urn()).rift).toBeUndefined();
      dispose();
    });

    // Cleared camp overridden to Active -> camp state becomes "alive" and tipFacts has no stale timer.
    createRoot((dispose) => {
      const s = fromScene({
        heroes: () => cap.heroes,
        roster: () => cap.rs,
        objectives: () => new Map([...cap.objectives, [campKey, { status: "Active" }]]),
        waves: () => cap.waves,
        state: () => cap.sceneState,
        tier: () => cap.tier,
        frame: () => cap.frameT,
        markers: () => markers,
      });
      const ms = markerStates({ ms: () => s, player: () => false, health: () => true }, () => markers.map((m) => m.key));
      expect(ms.status(campKey)).toBe("Active");
      expect(ms.camp(campKey)).toBe("alive");
      expect(tipFacts(s, campKey, true, s.scene().urn()).camp).toBeUndefined();
      dispose();
    });
  });
});

describe("Marker clicks (objectives.ts) with baseline shown & TD-163 sitesAt", () => {
  it("first click flips baseline-cleared camp, Stage-2 Patron, baseline-active rift/urn, and group toggles", () => {
    const camp = { key: "camp:neutral:lane1:1", kind: "camp" as const };
    const patron = { key: "patron:amber", kind: "t3" as const };
    const rift0 = { key: "rift:neutral:lane1:1", kind: "koth" as const };
    const rift1 = { key: "rift:neutral:lane6:1", kind: "koth" as const };
    const urn0 = { key: "urn:neutral:lane1:1", kind: "urn" as const };
    const all = [camp, patron, rift0, rift1, urn0];
    const empty = new Map();
    const baseline = new Map<string, ObjectiveStatus>([
      [camp.key, "Destroyed"],
      [patron.key, "Stage2"],
      [rift0.key, "Active"],
      [urn0.key, "Active"],
    ]);
    const shown = (k: string) => baseline.get(k);
    let n = 0;
    const mint = () => `id${n++}`;

    // Baseline-cleared camp -> first click creates Active (not Destroyed!).
    expect(isOn(camp, empty, shown)).toBe(false);
    expect(toggleOps(camp, all, empty, "s1", mint, shown)).toEqual([
      { Create: { id: "id0", record: { ObjectiveState: { scene: "s1", key: camp.key, status: "Active" } } } },
    ]);

    // Baseline Stage-2 Patron -> first click advances to Destroyed!
    expect(toggleOps(patron, all, empty, "s1", mint, shown)).toEqual([
      { Create: { id: "id1", record: { ObjectiveState: { scene: "s1", key: patron.key, status: "Destroyed" } } } },
    ]);

    // Baseline-active urn -> first click turns it off!
    expect(toggleOps(urn0, all, empty, "s1", mint, shown)).toEqual([
      { Create: { id: "id2", record: { ObjectiveState: { scene: "s1", key: urn0.key, status: "Destroyed" } } } },
    ]);

    // Clicking the OTHER rift turns baseline-active rift0 off and rift1 on in one tx!
    expect(toggleOps(rift1, all, empty, "s1", mint, shown)).toEqual([
      { Create: { id: "id4", record: { ObjectiveState: { scene: "s1", key: rift1.key, status: "Active" } } } },
      { Create: { id: "id3", record: { ObjectiveState: { scene: "s1", key: rift0.key, status: "Destroyed" } } } },
    ]);

    // groupToggleOps: clicking baseline-cleared camp turns group ON -> writes Active for camp (does NOT skip!).
    const gOps = groupToggleOps(camp, [camp, rift1], all, empty, "s1", mint, shown);
    expect(gOps).toContainEqual({ Create: { id: expect.any(String), record: { ObjectiveState: { scene: "s1", key: camp.key, status: "Active" } } } });
    expect(gOps).toContainEqual({ Create: { id: expect.any(String), record: { ObjectiveState: { scene: "s1", key: rift1.key, status: "Active" } } } });
    expect(gOps).toContainEqual({ Create: { id: expect.any(String), record: { ObjectiveState: { scene: "s1", key: rift0.key, status: "Destroyed" } } } });
  });

  it("TD-163: sitesAt resolves remapped rift and powerup keys via markerKey", () => {
    const tl = richReplay();
    // Remap the pack's rift and powerup keys (same coordinates, different key strings).
    const remapped = markers.map((m) =>
      m.key === keyOf("koth")
        ? { ...m, key: "rift:neutral:lane1:99" }
        : m.key === keyOf("powerup")
          ? { ...m, key: "powerup:neutral:lane4:99" }
          : m,
    );
    const sites = sitesAt(tl, 2, remapped);
    expect(sites.get("rift:neutral:lane1:99")).toBe("Active");
    expect(sites.get("powerup:neutral:lane4:99")).toBe("Active");
  });
});

describe("Dormant Retake, re-picked slots, TD-145 undo & copy filter", () => {
  it("canRetake per-feature tier matrix never offers a no-op Retake (TD-161)", () => {
    const tl = richReplay();
    const scReplay = { source: { ...sourceOf(tl), t: 3 } };
    const scMeta = { source: { ...sourceOf(metadata), t: 3 } };
    // v14 scene on R2 (written=27): replay & metadata both retakable (skulls for metadata, all A for replay).
    const v14State: More = { rows: 16, has_builds: true, has_heroes: true };
    expect(canRetake(scReplay, v14State, tl, WRITTEN_A, markers)).toBe(true);
    expect(canRetake(scMeta, v14State, metadata, WRITTEN_A, markers)).toBe(true);
    // Metadata scene after R2 Retake (has_skulls: true, rows: 27): NOT retakable on R2 OR R3 from metadata!
    const metaR2: More = { rows: 27, has_builds: true, has_heroes: true, has_skulls: true };
    expect(canRetake(scMeta, metaR2, metadata, WRITTEN_A, markers)).toBe(false);
    expect(canRetake(scMeta, metaR2, metadata, WRITTEN_B, markers)).toBe(false);
    // Same metadata scene retaken from upgraded replay IS retakable on R2 and R3!
    expect(canRetake(scMeta, metaR2, tl, WRITTEN_A, markers)).toBe(true);
    expect(canRetake(scMeta, metaR2, tl, WRITTEN_B, markers)).toBe(true);
    // Replay scene after R2 Retake: NOT retakable on R2, IS retakable on R3.
    const replayR2: More = { rows: 27, has_builds: true, has_heroes: true, has_sight: true, has_cc: true, has_movement: true, has_lanes: true, has_skulls: true };
    expect(canRetake(scReplay, replayR2, tl, WRITTEN_A, markers)).toBe(false);
    expect(canRetake(scReplay, replayR2, tl, WRITTEN_B, markers)).toBe(true);
    // Replay scene after R3 Retake: NOT retakable on R3.
    const replayR3: More = { ...replayR2, rows: 40, has_camps: true, has_powerups: true, has_obj_health: true, has_rifts: true, has_urn: true, has_rejuv: true };
    expect(canRetake(scReplay, replayR3, tl, WRITTEN_B, markers)).toBe(false);
  });

  it("retakeOps keeps Group A + SceneState atomic, respects re-picked slots, and stays well within caps", () => {
    const tl = richReplay();
    const rs = roster(tl);
    // Start from a v14 scene (rows=16, builds captured, hero 0 re-picked to another hero id 999).
    const cap = captureToScene(tl, 3, 16, rs);
    const heroes: Player[] = cap.heroes.map((h, i) => ({
      id: h.id,
      state: i === 0 ? { ...h.state, more: { hero: 999 } } : h.state,
    }));
    const waves = new Map(
      [...cap.waves.entries()].map(([lane, w], idx) => [lane, { id: `w${idx}`, t: w.t, ...(w.more ? { more: w.more } : {}) }]),
    );
    const scRow = { id: cap.saved.id, scene: { name: "t3", order: "a0", clock: 3, source: { ...sourceOf(tl), t: 3 }, live: false, parent: null } };

    for (const written of [WRITTEN_A, WRITTEN_B]) {
      let n = 0;
      const txs = retakeOps(scRow, { id: "st0", more: cap.sceneState }, heroes, rs, tl, () => `rt${n++}`, written, markers, waves);
      // Since builds are already held, the ENTIRE Retake is one single atomic transaction!
      expect(txs).toHaveLength(1);
      const tx = txs[0]!;
      expect(tx.length).toBeLessThanOrEqual(written === WRITTEN_A ? 58 : 71);
      expect(opsBytes(tx)).toBeLessThanOrEqual(written === WRITTEN_A ? 8300 : 15600);
      // Re-picked slot 0: gets NO `Set hero` and NO build rows, but DOES get Group A hero rows via SetIf on absent!
      const slot0Ops = tx.filter((o) => ("Set" in o ? o.Set.id : "SetIf" in o ? o.SetIf.id : "") === heroes[0]!.id);
      expect(slot0Ops.some((o) => "Set" in o)).toBe(false);
      expect(slot0Ops.every((o) => "SetIf" in o && "More" in o.SetIf.value && ["unseen", "cc", "height", "zipline"].includes(o.SetIf.value.More.key))).toBe(true);
      expect(slot0Ops.length).toBeGreaterThan(0);
    }

    // pickHeroOps clears BUILD_KEYS only, keeping Group A hero rows (`unseen`, `cc`, `height`, `zipline`).
    const pick = pickHeroOps(true, "slot-0", { id: "h0", more: { hero: 10, level: 5, unseen: true, cc: 1, height: 2, zipline: true } }, 20, WRITTEN_B);
    const clearedKeys = pick.flatMap((o) => ("Set" in o && "More" in o.Set.value && o.Set.value.More.value === null ? [o.Set.value.More.key] : []));
    expect(clearedKeys).toContain("level");
    for (const k of ["unseen", "cc", "height", "zipline"]) expect(clearedKeys).not.toContain(k);
  });

  it("TD-145 decideStep leaves Group A hero ops as recorded alongside build/pick undo", () => {
    const records = new Map<RecordId, Entry>([
      ["st", { record: { SceneState: { scene: "sc", more: { rows: 27, has_heroes: true, has_sight: true, has_cc: true } } }, deleted: false }],
      // Another editor re-picked hero 10 -> 99 since the Retake.
      ["h0", { record: { PlayerState: { scene: "sc", slot: "s0", pos: { x: 0, y: 0 }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true, respawn: null, more: { hero: 99, unseen: true, cc: 1 } } }, deleted: false }],
    ]);
    // Undo step of a Retake that set hero=10, level=5, unseen=true, cc=1.
    const step: Op[] = [
      { SetIf: { id: "h0", expect: { More: { key: "hero", value: 10 } }, value: { More: { key: "hero", value: 10 } } } },
      { SetIf: { id: "h0", expect: { More: { key: "level", value: 5 } }, value: { More: { key: "level", value: null } } } },
      { SetIf: { id: "h0", expect: { More: { key: "unseen", value: true } }, value: { More: { key: "unseen", value: null } } } },
      { SetIf: { id: "h0", expect: { More: { key: "cc", value: 1 } }, value: { More: { key: "cc", value: null } } } },
    ];
    const decided = decideStep(step, records, WRITTEN_A);
    // Hero & build ops were skipped (hero changed to 99), but unseen & cc are sent as recorded!
    expect(decided.ops).toEqual([step[2], step[3]]);
  });

  it("addSceneOps copy filter strips Ahead keys (index >= written) and lowers SceneState.more.rows", () => {
    const tl = richReplay();
    const rs = roster(tl);
    const cap = captureToScene(tl, 5, WRITTEN_B, rs);
    const records: Record<RecordId, Entry> = {};
    for (const op of cap.saved.ops) {
      if ("Create" in op) records[op.Create.id] = { record: op.Create.record, deleted: false };
    }
    const scId = cap.saved.id;
    const scRec = (records[scId]!.record as { Scene: Rec extends infer _ ? never : never } & Record<string, unknown>).Scene;
    const fakeState = {
      records,
      sceneTree: () => [{ scene: { id: scId, scene: scRec }, parent: null, depth: 0 }],
    } as unknown as BoardState;

    // Copy under R1 (written = 16): drops ALL Group A & Group B keys, lowers rows 40 -> 16, keeps visible: true.
    let n = 0;
    const copy16 = addSceneOps(fakeState, { id: scId, scene: scRec as never }, false, () => `c${n++}`, "Copy", false, 16);
    expect(copy16.full).toBe(false);
    for (const op of copy16.ops) {
      if (!("Create" in op)) continue;
      const r = op.Create.record;
      const more =
        "PlayerState" in r ? r.PlayerState.more : "Wave" in r ? r.Wave.more : "ObjectiveState" in r ? r.ObjectiveState.more : "SceneState" in r ? r.SceneState.more : undefined;
      if (more) {
        for (const k of Object.keys(more)) expect(ROWS[k as RowKey].index, k).toBeLessThan(16);
      }
      if ("PlayerState" in r) expect(r.PlayerState.visible).toBe(true);
      if ("Wave" in r) expect(r.Wave.more).toBeUndefined();
      if ("SceneState" in r) expect(r.SceneState.more?.rows).toBe(16);
    }

    // Copy under R2 (written = 27): keeps Group A, drops Group B, lowers rows 40 -> 27.
    n = 0;
    const copy27 = addSceneOps(fakeState, { id: scId, scene: scRec as never }, false, () => `d${n++}`, "Copy", false, WRITTEN_A);
    let sawRows = 0;
    let sawEdges = false;
    for (const op of copy27.ops) {
      if (!("Create" in op)) continue;
      const r = op.Create.record;
      const more =
        "PlayerState" in r ? r.PlayerState.more : "Wave" in r ? r.Wave.more : "ObjectiveState" in r ? r.ObjectiveState.more : "SceneState" in r ? r.SceneState.more : undefined;
      if (more) {
        for (const k of Object.keys(more)) expect(ROWS[k as RowKey].index, k).toBeLessThan(27);
      }
      if ("Wave" in r && r.Wave.more?.edges) sawEdges = true;
      if ("SceneState" in r) sawRows = Number(r.SceneState.more?.rows ?? 0);
    }
    expect(sawRows).toBe(27);
    expect(sawEdges).toBe(true);
  });
});
