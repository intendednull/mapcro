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
import { LIMITS } from "../src/gen/limits";
import { ROWS, type RowKey } from "../src/gen/rows";
import { FALLBACK } from "../src/map/fallback-data";
import { shiftEdges } from "../src/map/lanes";
import { modelFromFallback } from "../src/map/model";
import { groupToggleOps, isOn, toggleOps } from "../src/board/objectives";
import { addSceneOps, materializeDroppedBaseline } from "../src/board/scenes";
import type { BoardState, Player, Slot } from "../src/board/state";
import { WRITTEN, captured, heroBuildAt, moreBytes, readBuild } from "../src/mapstate/build";
import {
  MAX_CAMPS, MAX_OBJ_HEALTH, MAX_POWERUPS,
  decodeEdges, decodeUrn, encodeCamps, encodeObjHealth, encodePowerups, encodeRift, encodeUrn, fnv1a32, markerHashIndex,
} from "../src/mapstate/codec";
import { pickHeroOps, toggleSightOps } from "../src/mapstate/edit";
import { fromScene } from "../src/mapstate/scene";
import { heroDraw, sceneTokenHealth } from "../src/mapstate/shown";
import { FEATURES, type MapState, fromTimeline } from "../src/mapstate/state";
import { decideStep } from "../src/mapstate/undo";
import { canRetake, matchSceneOps, opsBytes, retakeOps, sourceOf } from "../src/match/save";
import { type CampAt, type PowerupAt, type Timeline, markerKey, sitesAt, slotKey } from "../src/match/timeline";
import { centreTimer, effectiveCamp, effectivePowerup, effectiveRift, effectiveUrn, markerTip, tipFacts, urnItemTip } from "../src/player/Camps";
import { markerStates } from "../src/player/markerStates";
import { mapControlFeatures, visionKeyChoice } from "../src/player/Player";
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

describe("Phase 5 R2: exhaustive §9 round-trip property (Groups A live & B ahead)", () => {
  it("R2 ships with WRITTEN = 27 and 40 rows (rows 0–26 live, rows 27–39 ahead)", () => {
    expect(WRITTEN).toBe(27);
    expect(WRITTEN).toBe(WRITTEN_A);
    const keys = Object.keys(ROWS) as RowKey[];
    expect(keys).toHaveLength(40);
    for (const k of keys) {
      if (ROWS[k].index < 27) expect(ROWS[k].status).toBe("live");
      else expect(ROWS[k].status).toBe("ahead");
    }
  });

  it("fromScene(capture(fromTimeline(t))) === fromTimeline(t) for every row (compile-checked over RowKey)", () => {
    const tl = richReplay();
    const rs = roster(tl);
    const hitRows = new Set<RowKey>();

    // Exhaustive per-row check table: adding a row to ROWS without checking it here is a type error.
    type Ctx = { p: MapState; s: MapState; second: number; cap: ReturnType<typeof captureToScene>; written: number };
    const decodedBuilds = (cap: ReturnType<typeof captureToScene>, second: number, written: number) =>
      tl.players.map((pl, idx) => ({
        got: readBuild(cap.heroes[idx]!.state.more, written, pl.hero_id),
        want: heroBuildAt(tl, pl, second, cap.tier),
      }));
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
      items: ({ cap, second, written }) => {
        for (const { got, want } of decodedBuilds(cap, second, written)) expect(got.items).toEqual(want.items);
      },
      abilities: ({ cap, second, written }) => {
        for (const { got, want } of decodedBuilds(cap, second, written)) expect(got.abilities).toEqual(want.abilities);
      },
      build_order: ({ cap, second, written }) => {
        for (const { got, want } of decodedBuilds(cap, second, written)) expect(got.order).toEqual(want.order);
      },
      level: ({ cap, second, written }) => {
        for (const { got, want } of decodedBuilds(cap, second, written)) expect(got.level).toEqual(want.level);
      },
      health: ({ p, s }) => {
        for (const sl of rs) {
          const k = slotKey(sl.slot.team, sl.slot.slot);
          expect(s.hero(k).health()).toBe(p.hero(k).health());
        }
      },
      pickups: ({ cap, second, written }) => {
        for (const { got, want } of decodedBuilds(cap, second, written)) expect(got.pickups).toEqual(want.pickups);
      },
      kills: ({ cap, second, written }) => {
        for (const { got, want } of decodedBuilds(cap, second, written)) expect(got.kills).toEqual(want.kills);
      },
      deaths: ({ cap, second, written }) => {
        for (const { got, want } of decodedBuilds(cap, second, written)) expect(got.deaths).toEqual(want.deaths);
      },
      assists: ({ cap, second, written }) => {
        for (const { got, want } of decodedBuilds(cap, second, written)) expect(got.assists).toEqual(want.assists);
      },
      max_health: ({ cap, second, written }) => {
        for (const { got, want } of decodedBuilds(cap, second, written)) expect(got.max_health).toEqual(want.max_health);
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
          // A down objective (including cleared Mid-Boss) has no shown health in either renderer.
          const want = p.marker(m.key).down() ? undefined : p.marker(m.key).health();
          expect(s.marker(m.key).health(), m.key).toEqual(want);
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

    for (const written of [WRITTEN, WRITTEN_B]) {
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
    for (const written of [WRITTEN, WRITTEN_B]) {
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

  it("drops optional features one by one in plan §3 DROP_ORDER without re-inserting ObjectiveStates, never dropping camps", () => {
    // At t=4 on richReplay(), EVERY feature in DROP_ORDER has non-empty data AND urn (delivery open),
    // rift (active), and powerups (1 down, 1 up) are non-default: shedding them for bytes must clear
    // their SceneState flags WITHOUT re-inserting ObjectiveState records (plan §3).
    const dropTl = richReplay();
    const rs = roster(dropTl);
    const EXPECTED_DROP_ORDER = [
      "skulls", "movement", "cc", "rejuv", "urn", "rifts", "powerups", "obj_health", "lanes", "sight",
    ] as const;
    const flagOf: Record<(typeof EXPECTED_DROP_ORDER)[number] | "camps", keyof More> = {
      skulls: "has_skulls",
      movement: "has_movement",
      cc: "has_cc",
      rejuv: "has_rejuv",
      urn: "has_urn",
      rifts: "has_rifts",
      powerups: "has_powerups",
      obj_health: "has_obj_health",
      lanes: "has_lanes",
      sight: "has_sight",
      camps: "has_camps",
    };

    const saveAt = (txBudget?: number) => {
      let n = 0;
      const saved = matchSceneOps(rs, [], undefined, dropTl, 4, markers, () => `d${n++}`, [], {
        source: sourceOf(dropTl),
        written: WRITTEN_B,
        ...(txBudget !== undefined ? { txBudget } : {}),
      });
      const st = saved.ops.find((o) => "Create" in o && "SceneState" in o.Create.record);
      const more = st && "Create" in st && "SceneState" in st.Create.record ? st.Create.record.SceneState.more : undefined;
      const objKeys = saved.ops.flatMap((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [o.Create.record.ObjectiveState.key] : []));
      return { saved, more, objKeys, bytes: opsBytes(saved.ops) };
    };

    const full = saveAt();
    expect(full.saved.builds).toBe(true);
    expect(full.more?.has_camps).toBe(true);
    for (const f of EXPECTED_DROP_ORDER) expect(full.more?.[flagOf[f]], f).toBe(true);
    // At t=4, only guardian:sapphire:lane4 is destroyed; urn/rift/powerup/camp have no ObjectiveState.
    expect(full.objKeys).toEqual([markerKey("guardian:sapphire:lane4", markers)!]);

    // Step txBudget down just below each previous step: every single DROP_ORDER transition fires
    // in exact plan §3 order, never re-inserting ObjectiveState records for shed baseline features!
    let budget = full.bytes;
    const droppedInOrder: string[] = [];
    for (let step = 0; step < EXPECTED_DROP_ORDER.length; step++) {
      const next = saveAt(budget - 1);
      const expected = EXPECTED_DROP_ORDER[step]!;
      expect(next.saved.builds, `step ${step} (${expected})`).toBe(true);
      expect(next.more?.has_camps, `step ${step} keeps camps`).toBe(true);
      // Shedding urn, rifts, powerups for bytes NEVER re-inserts ObjectiveState records!
      expect(next.objKeys, `step ${step} (${expected}) adds no ObjectiveState`).toEqual(full.objKeys);
      expect(next.more?.[flagOf[expected]], `step ${step} drops ${expected}`).toBeUndefined();
      for (let i = 0; i <= step; i++) expect(next.more?.[flagOf[EXPECTED_DROP_ORDER[i]!]], `dropped ${EXPECTED_DROP_ORDER[i]}`).toBeUndefined();
      for (let i = step + 1; i < EXPECTED_DROP_ORDER.length; i++) expect(next.more?.[flagOf[EXPECTED_DROP_ORDER[i]!]], `kept ${EXPECTED_DROP_ORDER[i]}`).toBe(true);
      droppedInOrder.push(expected);
      expect(next.bytes).toBeLessThan(budget);
      budget = next.bytes;
    }
    expect(droppedInOrder).toEqual([...EXPECTED_DROP_ORDER]);

    // Verify decoded surviving `camps` after all 10 optional features dropped!
    const campOnly = saveAt(budget);
    const heroes = campOnly.saved.ops.flatMap((o) => ("Create" in o && "PlayerState" in o.Create.record ? [{ id: o.Create.id, state: o.Create.record.PlayerState as PlayerState }] : []));
    const objs = new Map(campOnly.saved.ops.flatMap((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [[o.Create.record.ObjectiveState.key, { status: o.Create.record.ObjectiveState.status }]] : [])));
    const waves = new Map(campOnly.saved.ops.flatMap((o) => ("Create" in o && "Wave" in o.Create.record ? [[o.Create.record.Wave.lane, { t: o.Create.record.Wave.t, ...(o.Create.record.Wave.more ? { more: o.Create.record.Wave.more } : {}) }]] : [])));
    createRoot((dispose) => {
      const p = fromTimeline({ tl: () => dropTl, t: () => 4, markers: () => markers });
      const s = fromScene({
        heroes: () => heroes, roster: () => rs, objectives: () => objs, waves: () => waves,
        state: () => campOnly.more, tier: () => "replay", frame: () => 4, markers: () => markers,
      });
      expect(s.has("camps")).toBe(true);
      expect(s.has("sight")).toBe(false);
      expect(s.marker(keyOf("camp", 3)).camp()).toEqual(p.marker(keyOf("camp", 3)).camp());
      expect(s.scene().bossCamp()).toEqual(p.scene().bossCamp());
      dispose();
    });
  });

  it("overflow (>256 ops): v14 (written=16) stays all-or-nothing, while written=40 omits whole overflowing camp bucket without losing mandatory/urn/rift", () => {
    // 250 cleared camps (overflows MAX_CAMPS=200 AND op cap 256) + destroyed lane objectives + active rift + open urn.
    const tl = richReplay();
    const riftMarker = markers.find((m) => m.key === keyOf("koth", 0))!;
    const urnMarker0 = markers.find((m) => m.key === keyOf("urn", 0))!;
    const urnMarker1 = markers.find((m) => m.key === keyOf("urn", 1))!;
    const fakeMarkers = [
      ...markers.filter((m) => m.kind === "t1" || m.kind === "t2"),
      riftMarker,
      urnMarker0,
      urnMarker1,
      ...Array.from({ length: 250 }, (_, i) => ({
        key: `camp:neutral:lane1:${i}`,
        kind: "camp" as const,
        team: "neutral" as const,
        lane: "yellow" as const,
        at: { x: 100 + i, y: 200 },
      })),
    ];
    const bigTl = {
      ...tl,
      camps: fakeMarkers
        .filter((m) => m.kind === "camp")
        .map((m) => ({ key: m.key, first_s: 0, cleared: [[0, 200]] as Array<[number, number]> })),
    } as unknown as Timeline;

    // 1. At written=16 (R1): exact v14 all-or-nothing behavior — 12 heroes + 250 down sites + waves > 256 -> empty ops ("Not saved")!
    let n16 = 0;
    const saved16 = matchSceneOps(roster(bigTl), [], undefined, bigTl, 4, fakeMarkers, () => `v16_${n16++}`, [], {
      source: sourceOf(bigTl),
      written: 16,
    });
    expect(saved16.ops).toEqual([]);
    expect(saved16.builds).toBe(false);

    // 2. At written=40: saves cleanly within max_ops_per_tx, keeps mandatory lane objectives + active rift/urn,
    // and omits the overflowing 250-camp bucket WHOLE (zero partial camp ObjectiveStates!).
    let n40 = 0;
    const saved40 = matchSceneOps(roster(bigTl), [], undefined, bigTl, 4, fakeMarkers, () => `ov${n40++}`, [], {
      source: sourceOf(bigTl),
      written: WRITTEN_B,
    });
    expect(saved40.ops.length).toBeGreaterThan(0);
    expect(saved40.ops.length).toBeLessThanOrEqual(LIMITS.max_ops_per_tx);
    expect(saved40.builds).toBe(true);
    const st = saved40.ops.find((o) => "Create" in o && "SceneState" in o.Create.record);
    expect(st).toBeDefined();
    const more = st && "Create" in st && "SceneState" in st.Create.record ? st.Create.record.SceneState.more : undefined;
    expect(more?.has_camps).toBeUndefined();
    expect(more?.has_rifts).toBe(true);
    expect(more?.has_urn).toBe(true);
    const objKeys = saved40.ops.flatMap((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [o.Create.record.ObjectiveState.key] : []));
    // Mandatory destroyed lane objective preserved; ZERO partial prefix of camp ObjectiveStates!
    expect(objKeys).toContain(markerKey("guardian:sapphire:lane4", fakeMarkers)!);
    expect(objKeys.filter((k) => k.startsWith("camp:"))).toEqual([]);
  });

  it("tight txBudget heroes-only fallback preserves legacy ObjectiveState buckets and drops overflowing site bucket whole", () => {
    // 1. Normal tight txBudget on richReplay: heroes-only fallback keeps ALL legacy ObjectiveState records.
    const tl = richReplay();
    const rs = roster(tl);
    let m0 = 0;
    const legacy = matchSceneOps(rs, [], undefined, tl, 3, markers, () => `lg${m0++}`, [], {
      source: sourceOf(tl),
      written: 16,
      builds: false,
    });
    const legacyBudget = opsBytes(legacy.ops) + 600;
    let n = 0;
    const fallback = matchSceneOps(rs, [], undefined, tl, 3, markers, () => `fb${n++}`, [], {
      source: sourceOf(tl),
      written: WRITTEN_B,
      txBudget: legacyBudget,
    });
    expect(fallback.ops.length).toBeGreaterThan(0);
    expect(fallback.builds).toBe(false);
    const st = fallback.ops.find((o) => "Create" in o && "SceneState" in o.Create.record);
    const more = st && "Create" in st && "SceneState" in st.Create.record ? st.Create.record.SceneState.more : undefined;
    expect(more?.has_heroes).toBe(true);
    expect(more?.has_builds).toBeUndefined();
    expect(more?.has_camps).toBeUndefined();
    const objs = new Map(fallback.ops.flatMap((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [[o.Create.record.ObjectiveState.key, o.Create.record.ObjectiveState.status]] : [])));
    expect(objs.get(keyOf("camp", 3))).toBe("Destroyed");
    expect(objs.get(keyOf("midboss", 0))).toBe("Destroyed");
    expect(objs.get(keyOf("koth", 0))).toBe("Active");
    expect(objs.get(keyOf("urn", 1))).toBe("Active");
    expect(objs.get(keyOf("powerup", 0))).toBe("Destroyed");

    // 2. Over-length optional camps bucket (150 cleared camps ~18 KB) exhausts txBudget while mandatory
    // heroes-only + lane objectives + urn/rift/powerup buckets DO fit: drops camps bucket WHOLE so Save succeeds!
    const manyCampMarkers = [
      ...markers.filter((m) => m.kind !== "camp"),
      ...Array.from({ length: 150 }, (_, i) => ({
        key: `camp:neutral:lane1:${i}`,
        kind: "camp" as const,
        team: "neutral" as const,
        lane: "yellow" as const,
        at: { x: 100 + i, y: 200 },
      })),
    ];
    const manyCampTl = {
      ...tl,
      camps: [
        ...manyCampMarkers
          .filter((m) => m.kind === "camp")
          .map((m) => ({ key: m.key, first_s: 0, cleared: [[0, 200]] as Array<[number, number]> })),
        { key: keyOf("midboss"), first_s: 0, cleared: [[3, 400]] as Array<[number, number]> },
      ],
    } as unknown as Timeline;
    // Budget fits heroes-only + mandatory + urn/rift/powerups (~4.5 KB), NOT builds (~10 KB) or 150 camps (~18 KB).
    let k = 0;
    const tightHero = matchSceneOps(rs, [], undefined, manyCampTl, 3, manyCampMarkers, () => `th${k++}`, [], {
      source: sourceOf(manyCampTl),
      written: WRITTEN_B,
      txBudget: 5000,
    });
    expect(tightHero.ops.length).toBeGreaterThan(0);
    expect(opsBytes(tightHero.ops)).toBeLessThanOrEqual(5000);
    expect(tightHero.builds).toBe(false);
    const thObjs = new Map(tightHero.ops.flatMap((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [[o.Create.record.ObjectiveState.key, o.Create.record.ObjectiveState.status]] : [])));
    // Mandatory objectives + small site buckets (urn, rift, powerup) preserved; 150-camp bucket dropped WHOLE!
    expect(thObjs.get(markerKey("guardian:sapphire:lane4", manyCampMarkers)!)).toBe("Destroyed");
    expect(thObjs.get(keyOf("midboss", 0))).toBe("Destroyed");
    expect(thObjs.get(keyOf("koth", 0))).toBe("Active");
    expect(thObjs.get(keyOf("urn", 1))).toBe("Active");
    expect(thObjs.get(keyOf("powerup", 0))).toBe("Destroyed");
    expect([...thObjs.keys()].filter((key) => key.startsWith("camp:"))).toEqual([]);
  });

  it("covered only omits camps/midboss actually tracked in sec.camps (Mid-Boss kill without camp track keeps ObjectiveState)", () => {
    // Must-Fix #4: replay has neutral camps (`has_camps = true`) AND a Mid-Boss kill in `tl.mid_boss`,
    // but NO `mid_boss:` camp track in `tl.camps` -> Mid-Boss must NOT be omitted from ObjectiveState!
    const base = richReplay();
    const noBossCamp = {
      ...base,
      camps: (base.camps ?? []).filter((c) => !c.key.startsWith("mid_boss:")),
      mid_boss: [{ destroyed_s: 3 }],
    } as unknown as Timeline;
    const cap = captureToScene(noBossCamp, 5, WRITTEN_B);
    expect(cap.sceneState?.has_camps).toBe(true);
    expect(cap.objectives.get(keyOf("midboss", 0))?.status).toBe("Destroyed");
    // Neutral camp that IS tracked in sec.camps is still omitted!
    expect(cap.objectives.has(keyOf("camp", 0))).toBe(false);
    createRoot((dispose) => {
      const s = fromScene({
        heroes: () => cap.heroes, roster: () => cap.rs, objectives: () => cap.objectives, waves: () => cap.waves,
        state: () => cap.sceneState, tier: () => cap.tier, frame: () => cap.frameT, markers: () => markers,
      });
      expect(s.marker(keyOf("midboss", 0)).down()).toBe(true);
      dispose();
    });
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

  it("gates shopClosed strictly on has_camps (D5 parity on old scenes) and round-trips returning ground urn", () => {
    const tl = richReplay();
    const rs = roster(tl);
    // At t=6, guardian:sapphire:lane4:1 is destroyed; its adjacent lane shop closes ONLY when has_camps is true.
    const capA = captureToScene(tl, 6, WRITTEN_A, rs);
    const capB = captureToScene(tl, 6, WRITTEN_B, rs);
    const shopKeys = markers.filter((m) => m.kind === "shop").map((m) => m.key);
    createRoot((dispose) => {
      const sA = fromScene({
        heroes: () => capA.heroes, roster: () => rs, objectives: () => capA.objectives, waves: () => capA.waves,
        state: () => capA.sceneState, tier: () => capA.tier, frame: () => capA.frameT, markers: () => markers,
      });
      const sB = fromScene({
        heroes: () => capB.heroes, roster: () => rs, objectives: () => capB.objectives, waves: () => capB.waves,
        state: () => capB.sceneState, tier: () => capB.tier, frame: () => capB.frameT, markers: () => markers,
      });
      expect(sA.has("camps")).toBe(false);
      expect(shopKeys.some((k) => sA.marker(k).shopClosed())).toBe(false);
      expect(sB.has("camps")).toBe(true);
      expect(shopKeys.some((k) => sB.marker(k).shopClosed())).toBe(true);
      dispose();
    });

    // Returning ground urn (`returns <= second`) encodes walkBackIn=0 (not -1) and says "Urn returning".
    const frame = 300;
    const delivery = keyOf("urn", 1);
    const returning = encodeUrn(
      { state: "ground", at: { x: 100, y: 200 }, team: null, slot: null, delivery, next: null, returns: 295 },
      frame,
      markers,
    );
    expect(returning.ints[4]).toBe(0);
    const decodedRet = decodeUrn(returning.ints, returning.at, frame, markers, () => null)!;
    expect(decodedRet.returns).toBe(frame);
    expect(urnItemTip(decodedRet, frame)).toBe("Urn returning");

    // Falling/unsettled ground urn (`returns === null`) encodes walkBackIn=-1 and says "Urn".
    const unsettled = encodeUrn(
      { state: "ground", at: { x: 100, y: 200 }, team: null, slot: null, delivery, next: null, returns: null },
      frame,
      markers,
    );
    expect(unsettled.ints[4]).toBe(-1);
    const decodedUn = decodeUrn(unsettled.ints, unsettled.at, frame, markers, () => null)!;
    expect(decodedUn.returns).toBeNull();
    expect(urnItemTip(decodedUn, frame)).toBe("Urn");
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

    for (const written of [WRITTEN, WRITTEN_B]) {
      let n = 0;
      const txs = retakeOps(scRow, { id: "st0", more: cap.sceneState }, heroes, rs, tl, () => `rt${n++}`, written, markers, waves);
      // Since builds are already held, the ENTIRE Retake is one single atomic transaction!
      expect(txs).toHaveLength(1);
      const tx = txs[0]!;
      expect(tx.length).toBeLessThanOrEqual(written === WRITTEN_A ? 58 : 71);
      expect(opsBytes(tx)).toBeLessThanOrEqual(written === WRITTEN_A ? 8300 : 15600);
      // Re-picked slot 0: gets NO `Set hero` and NO build rows, only Group A hero rows via `Set` in `sceneGroup`!
      const slot0Ops = tx.filter((o) => ("Set" in o ? o.Set.id : "SetIf" in o ? o.SetIf.id : "") === heroes[0]!.id);
      expect(slot0Ops.every((o) => "Set" in o && "More" in o.Set.value && ["unseen", "cc", "height", "zipline"].includes(o.Set.value.More.key))).toBe(true);
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

  it("Must-Fix #1: Mid-Boss respawn timer works in MapState even when pack lacks a midboss marker", () => {
    const tl = { ...richReplay(), rejuv: [] } as unknown as Timeline;
    const withoutBoss = markers.filter((m) => m.kind !== "midboss");
    expect(withoutBoss.length).toBeGreaterThan(0);
    expect(withoutBoss.some((m) => m.kind === "midboss")).toBe(false);
    createRoot((dispose) => {
      const ms = fromTimeline({ tl: () => tl, t: () => 5, markers: () => withoutBoss });
      // Mid-Boss was cleared [3, 400] on richReplay: scene().bossCamp() exposes it without a midboss marker!
      expect(ms.scene().bossCamp()).toEqual({ state: "cleared", at: 400 });
      expect(centreTimer(ms.scene().rejuv() ?? [], ms.scene().bossCamp())).toEqual({ kind: "respawn", at: 400 });
      dispose();
    });
  });

  it("Must-Fix #2: R3 Retake never re-writes Group A hero rows for already-captured features (preserves coach sight edits)", () => {
    const tl = richReplay();
    const rs = roster(tl);
    // R2 save (`written = 27`, `has_sight = true`) at t=3 where at least one hero is match-unseen.
    const cap = captureToScene(tl, 3, WRITTEN_A, rs);
    expect(cap.sceneState?.has_sight).toBe(true);
    const unseenIdx = cap.heroes.findIndex((h) => h.state.more?.unseen === true);
    expect(unseenIdx).toBeGreaterThanOrEqual(0);

    // Coach marks that hero back in vision: clears `unseen` (`have.unseen === undefined`).
    const editedHeroes: Player[] = cap.heroes.map((h, i) => {
      if (i !== unseenIdx) return h;
      const { unseen: _cleared, ...restMore } = h.state.more ?? {};
      return { id: h.id, state: { ...h.state, more: restMore } };
    });
    const waves = new Map(
      [...cap.waves.entries()].map(([lane, w], idx) => [lane, { id: `w${idx}`, t: w.t, ...(w.more ? { more: w.more } : {}) }]),
    );
    const scRow = { id: cap.saved.id, scene: { name: "t3", order: "a0", clock: 3, source: { ...sourceOf(tl), t: 3 }, live: false, parent: null } };

    // Later on R3 (`written = 40`), coach clicks Retake to add Group B.
    let n = 0;
    const txs = retakeOps(scRow, { id: "st0", more: cap.sceneState }, editedHeroes, rs, tl, () => `rt3_${n++}`, WRITTEN_B, markers, waves);
    expect(txs).toHaveLength(1);
    const ops = txs[0]!;
    // ZERO Group A hero ops (and specifically NO `unseen` re-write on the coach-edited hero)!
    const heroOps = ops.filter((o) => ("Set" in o ? o.Set.id : "SetIf" in o ? o.SetIf.id : "") !== "st0");
    expect(heroOps).toEqual([]);
    // Group B flags (`Set`) and rows:40 (`SetIf` monotonic) ARE written to SceneState!
    const stateKeys = ops.flatMap((o) =>
      "Set" in o && o.Set.id === "st0" && "More" in o.Set.value
        ? [o.Set.value.More.key]
        : "SetIf" in o && o.SetIf.id === "st0" && "More" in o.SetIf.value
          ? [o.SetIf.value.More.key]
          : [],
    );
    expect(stateKeys).toContain("has_camps");
    expect(stateKeys).toContain("rows");
    // Already-captured Group A SceneState flags are NOT re-written.
    expect(stateKeys).not.toContain("has_sight");
    expect(stateKeys).not.toContain("has_skulls");
  });

  it("Must-Fix #3: legacy-save ObjectiveState + Group B Retake keeps compatible timers/detail, while contradicting overrides suppress them", () => {
    const base = richReplay();
    const clearedCamp = keyOf("camp", 3);
    const tl = {
      ...base,
      rejuv: [],
      camps: (base.camps ?? []).map((c) => (c.key === clearedCamp ? { ...c, cleared: [[2, 40]] } : c)),
    } as unknown as Timeline;
    const rs = roster(tl);
    // Capture Group B baseline at t=4:
    // - camp 3 is cleared ([2, 40])
    // - midboss 0 is cleared ([3, 400])
    // - camp 1 is alive
    // - rift 0 is active ([2, 5))
    // - powerup 0 is down (available[4]=0), powerup 1 is up ("casting")
    // - urn delivery is urn 1
    const cap = captureToScene(tl, 4, WRITTEN_B, rs);
    const aliveCamp = keyOf("camp", 1);
    const bossKey = keyOf("midboss", 0);
    const activeRift = keyOf("koth", 0);
    const waitingRift = keyOf("koth", 1);
    const downPwr = keyOf("powerup", 0);
    const upPwr = keyOf("powerup", 1);
    const openUrn = keyOf("urn", 1);
    const closedUrn = keyOf("urn", 0);

    // 1. Legacy-save → Group B Retake: scene ALREADY holds matching ObjectiveState records from R1/R2 save!
    const legacyObjectives = new Map<string, { status: ObjectiveStatus }>([
      [clearedCamp, { status: "Destroyed" }],
      [bossKey, { status: "Destroyed" }],
      [activeRift, { status: "Active" }],
      [downPwr, { status: "Destroyed" }],
      [openUrn, { status: "Active" }],
    ]);
    createRoot((dispose) => {
      const s = fromScene({
        heroes: () => cap.heroes, roster: () => rs, objectives: () => legacyObjectives, waves: () => cap.waves,
        state: () => cap.sceneState, tier: () => cap.tier, frame: () => cap.frameT, markers: () => markers,
      });
      const ms = markerStates({ ms: () => s, player: () => false, health: () => true }, () => markers.map((m) => m.key));
      const urn = s.scene().urn();
      // Compatible legacy `Destroyed` on cleared camp & Mid-Boss KEEPS respawn timers + camp state!
      expect(tipFacts(s, clearedCamp, true, urn).camp).toEqual({ state: "cleared", at: 40 });
      expect(ms.camp(clearedCamp)).toBe("cleared");
      expect(tipFacts(s, bossKey, true, urn).camp).toEqual({ state: "cleared", at: 400 });
      expect(centreTimer([], effectiveCamp(s.marker(bossKey).status(), s.marker(bossKey).camp()))).toEqual({ kind: "respawn", at: 400 });
      // Compatible legacy `Active` on active rift & open urn KEEPS detail!
      expect(tipFacts(s, activeRift, true, urn).rift?.state).toBe("active");
      expect(effectiveRift(s.marker(activeRift).status(), s.marker(activeRift).rift())?.state).toBe("active");
      expect(tipFacts(s, openUrn, true, urn).urn?.delivery).toBe(openUrn);
      // Compatible legacy `Destroyed` on down powerup KEEPS respawn timer (and shows no buff icon)!
      expect(tipFacts(s, downPwr, true, urn).powerup?.state).toBe("down");
      expect(ms.buff(downPwr)).toBeUndefined();
      dispose();
    });

    // 2. Contradicting coach overrides MUST suppress baseline detail!
    const contradicting = new Map<string, { status: ObjectiveStatus }>([
      [clearedCamp, { status: "Active" }],   // revived cleared camp -> no respawn timer
      [bossKey, { status: "Active" }],       // revived cleared Mid-Boss -> no bar or hover respawn timer
      [aliveCamp, { status: "Destroyed" }],  // manually killed live camp -> no match respawn timer
      [activeRift, { status: "Destroyed" }], // turned off active rift -> no fade timer / rings
      [waitingRift, { status: "Active" }],   // forced inactive rift on -> no "opens in" timer
      [downPwr, { status: "Active" }],       // revived down powerup -> no respawn timer
      [upPwr, { status: "Destroyed" }],      // killed up powerup -> no buff icon or hover
      [openUrn, { status: "Destroyed" }],    // turned off open urn -> no delivery tip
      [closedUrn, { status: "Active" }],     // forced non-delivery urn point on -> no urn tip
    ]);
    createRoot((dispose) => {
      const s = fromScene({
        heroes: () => cap.heroes, roster: () => rs, objectives: () => contradicting, waves: () => cap.waves,
        state: () => cap.sceneState, tier: () => cap.tier, frame: () => cap.frameT, markers: () => markers,
      });
      const ms = markerStates({ ms: () => s, player: () => false, health: () => true }, () => markers.map((m) => m.key));
      const urn = s.scene().urn();
      expect(tipFacts(s, clearedCamp, true, urn).camp).toBeUndefined();
      expect(ms.camp(clearedCamp)).toBe("alive");
      expect(tipFacts(s, bossKey, true, urn).camp).toBeUndefined();
      expect(centreTimer([], effectiveCamp(s.marker(bossKey).status(), s.marker(bossKey).camp()))).toEqual({ kind: "none" });
      expect(tipFacts(s, aliveCamp, true, urn).camp).toBeUndefined();
      expect(ms.camp(aliveCamp)).toBeUndefined();
      expect(tipFacts(s, activeRift, true, urn).rift).toBeUndefined();
      expect(effectiveRift(s.marker(activeRift).status(), s.marker(activeRift).rift())).toBeUndefined();
      expect(tipFacts(s, waitingRift, true, urn).rift).toBeUndefined();
      expect(tipFacts(s, downPwr, true, urn).powerup).toBeUndefined();
      expect(tipFacts(s, upPwr, true, urn).powerup).toBeUndefined();
      expect(ms.buff(upPwr)).toBeUndefined();
      expect(tipFacts(s, openUrn, true, urn).urn).toBeUndefined();
      expect(effectiveUrn(s.marker(closedUrn).status(), closedUrn, urn)).toBeUndefined();
      expect(effectivePowerup("Active", { state: "up", buff: "gun" })).toEqual({ state: "up", buff: "gun" });
      dispose();
    });

    // 3. Compatible `Destroyed` on CLOSED sites (waiting rift & closed urn with spawn timer) keeps their countdown tips!
    // At t=8 on richReplay(): urn is `state: "none"` with `next: { t: 10, key: urn 1 }` and rift 0 is waiting?
    // Use t=6 on a timeline where rift 0 opens at t=30 and urn is `none` spawning at t=25.
    const closedTl = {
      ...base,
      rifts: [{ key: activeRift, start_s: 30, live_s: 30, end_s: 60 }],
      urn: { spawns: [{ t: 25, key: closedUrn }], at: [{ t: 0, state: "none" }] },
    } as unknown as Timeline;
    const capClosed = captureToScene(closedTl, 5, WRITTEN_B, rs);
    const closedObjectives = new Map<string, { status: ObjectiveStatus }>([
      [activeRift, { status: "Destroyed" }],
      [closedUrn, { status: "Destroyed" }],
    ]);
    createRoot((dispose) => {
      const s = fromScene({
        heroes: () => capClosed.heroes, roster: () => rs, objectives: () => closedObjectives, waves: () => capClosed.waves,
        state: () => capClosed.sceneState, tier: () => capClosed.tier, frame: () => capClosed.frameT, markers: () => markers,
      });
      const urn = s.scene().urn();
      const rf = tipFacts(s, activeRift, true, urn);
      expect(rf.rift?.state).toBe("waiting");
      expect(markerTip({ key: activeRift, kind: "koth" }, rf, 5)).toBe("Rift opens in 0:25");
      const uf = tipFacts(s, closedUrn, true, urn);
      expect(uf.urn?.state).toBe("none");
      expect(markerTip({ key: closedUrn, kind: "urn" }, uf, 5)).toBe("Urn spawns in 0:20");
      dispose();
    });
  });

  it("Should-Fix #3: canRetake returns false when markers are absent and only marker-keyed Group B features are missing", () => {
    const tl = richReplay();
    const sc = { source: { ...sourceOf(tl), t: 5 } };
    // All Group A + rejuv already captured; only marker-keyed Group B features remain missing.
    const state: More = {
      rows: 40,
      has_builds: true,
      has_heroes: true,
      has_sight: true,
      has_cc: true,
      has_movement: true,
      has_lanes: true,
      has_skulls: true,
      has_rejuv: true,
    };
    expect(canRetake(sc, state, tl, WRITTEN_B, undefined)).toBe(false);
    expect(canRetake(sc, state, tl, WRITTEN_B, [])).toBe(false);
    expect(canRetake(sc, state, tl, WRITTEN_B, markers)).toBe(true);
  });
});

describe("Phase 5 R2: Writer A, health arc (Q3), TD-162 MapControls, copy materialization & Astra edge", () => {
  it("Q3 sceneTokenHealth shows stored health only for living, visible heroes when Health is on and scene captured health", () => {
    const tl = richReplay();
    const rs = roster(tl);
    // Replay scene at t=6: slot 3 (amber-3) is dead; living heroes have health 70.
    const replayCap = captureToScene(tl, 6, WRITTEN, rs);
    // Metadata scene at t=6: has("health") is false.
    const metaCap = captureToScene(metadata, 6, WRITTEN, rs);
    createRoot((dispose) => {
      const rMs = fromScene({
        heroes: () => replayCap.heroes, roster: () => rs, objectives: () => replayCap.objectives, waves: () => replayCap.waves,
        state: () => replayCap.sceneState, tier: () => replayCap.tier, frame: () => replayCap.frameT, markers: () => markers,
      });
      const mMs = fromScene({
        heroes: () => metaCap.heroes, roster: () => rs, objectives: () => metaCap.objectives, waves: () => metaCap.waves,
        state: () => metaCap.sceneState, tier: () => metaCap.tier, frame: () => metaCap.frameT, markers: () => markers,
      });
      const legacyMs = fromScene({
        heroes: () => replayCap.heroes, roster: () => rs, objectives: () => replayCap.objectives, waves: () => replayCap.waves,
        state: () => undefined, tier: () => undefined, frame: () => undefined, markers: () => markers,
      });

      const a0 = rMs.hero("amber-0");
      expect(a0.health()).toBe(70);
      expect(sceneTokenHealth(a0, true, true, { health: true })).toBe(70);
      expect(sceneTokenHealth(a0, true, true, { health: false })).toBeNull();
      expect(sceneTokenHealth(a0, true, false, { health: true })).toBeNull();
      expect(sceneTokenHealth(a0, false, true, { health: true })).toBeNull();

      // Dead hero at frame: health is 0, and alive=false hides the arc.
      const a3 = rMs.hero("amber-3");
      expect(a3.alive()).toBe(false);
      expect(sceneTokenHealth(a3, false, true, { health: true })).toBeNull();

      // Metadata scene & pre-SceneState legacy scene: no health arc (zero DOM pin impact).
      expect(sceneTokenHealth(mMs.hero("amber-0"), true, true, { health: true })).toBeNull();
      expect(sceneTokenHealth(legacyMs.hero("amber-0"), true, true, { health: true })).toBeNull();
      dispose();
    });
  });

  it("TD-162: mapControlFeatures and visionKeyChoice activate from MapState even when no match is open", () => {
    const tl = richReplay();
    const rs = roster(tl);
    const replayCap = captureToScene(tl, 6, WRITTEN, rs);
    const metaCap = captureToScene(metadata, 6, WRITTEN, rs);

    createRoot((dispose) => {
      const rMs = fromScene({
        heroes: () => replayCap.heroes, roster: () => rs, objectives: () => replayCap.objectives, waves: () => replayCap.waves,
        state: () => replayCap.sceneState, tier: () => replayCap.tier, frame: () => replayCap.frameT, markers: () => markers,
      });
      const mMs = fromScene({
        heroes: () => metaCap.heroes, roster: () => rs, objectives: () => metaCap.objectives, waves: () => metaCap.waves,
        state: () => metaCap.sceneState, tier: () => metaCap.tier, frame: () => metaCap.frameT, markers: () => markers,
      });
      const legacyMs = fromScene({
        heroes: () => replayCap.heroes, roster: () => rs, objectives: () => replayCap.objectives, waves: () => replayCap.waves,
        state: () => undefined, tier: () => undefined, frame: () => undefined, markers: () => markers,
      });
      const objHealthOnlyMs = fromScene({
        heroes: () => [], roster: () => rs, objectives: () => new Map(), waves: () => new Map(),
        state: () => ({ rows: 40, has_obj_health: true }), tier: () => "metadata", frame: () => 5, markers: () => markers,
      });

      // No match open (`tl = undefined`): saved R2 replay scene enables Health, CC, Movement, and Vision!
      expect(mapControlFeatures(undefined, rMs)).toEqual({ health: true, cc: true, movement: true, vision: true });
      // Scene holding only obj_health still enables Health toggle.
      expect(mapControlFeatures(undefined, objHealthOnlyMs)).toEqual({ health: true, cc: false, movement: false, vision: false });
      // Metadata scene & hand-made scene with no match open: all 4 stay off.
      expect(mapControlFeatures(undefined, mMs)).toEqual({ health: false, cc: false, movement: false, vision: false });
      expect(mapControlFeatures(undefined, legacyMs)).toEqual({ health: false, cc: false, movement: false, vision: false });
      // Open replay timeline + hand-made scene: timeline still enables all 4.
      expect(mapControlFeatures(tl, legacyMs)).toEqual({ health: true, cc: true, movement: true, vision: true });
      // Open metadata timeline + saved R2 replay scene: scene's MapState enables all 4.
      expect(mapControlFeatures(metadata, rMs)).toEqual({ health: true, cc: true, movement: true, vision: true });
      dispose();
    });

    // visionKeyChoice: 1/2/3 work when canVision is true (no player-mode gate!), silent when false or modified/in input.
    const ev = (code: string, extra: Partial<KeyboardEvent> = {}) => ({
      altKey: false, ctrlKey: false, metaKey: false, repeat: false, defaultPrevented: false, code, target: null, ...extra,
    });
    expect(visionKeyChoice(ev("Digit1"), true)).toBe("amber");
    expect(visionKeyChoice(ev("Digit2"), true)).toBe("sapphire");
    expect(visionKeyChoice(ev("Digit3"), true)).toBe("all");
    expect(visionKeyChoice(ev("Numpad1"), true)).toBe("amber");
    expect(visionKeyChoice(ev("Digit1"), false)).toBeUndefined();
    expect(visionKeyChoice(ev("Digit1", { ctrlKey: true }), true)).toBeUndefined();
    expect(visionKeyChoice(ev("Digit1", { repeat: true }), true)).toBeUndefined();
    expect(visionKeyChoice(ev("Digit1", { defaultPrevented: true }), true)).toBeUndefined();
    expect(visionKeyChoice(ev("KeyA"), true)).toBeUndefined();
  });

  it("R2 copy materialization: copying an R3 (written=40) scene on R2 (written=27) materializes all 5 Group B types without duplicating existing ObjectiveStates", () => {
    const base = richReplay();
    const clearedCamp = keyOf("camp", 3);
    const unspawnedCamp = keyOf("camp", 0);
    const aliveCamp = keyOf("camp", 1);
    const clearedHeal = keyOf("heal", 0);
    const clearedCrate = keyOf("crate", 0);
    const bossKey = keyOf("midboss", 0);
    const downPwr = keyOf("powerup", 0);
    const upPwr = keyOf("powerup", 1);
    const activeRift = keyOf("koth", 0);
    const inactiveRift = keyOf("koth", 1);
    const deliveryUrn = keyOf("urn", 1);
    const otherUrn = keyOf("urn", 0);
    const patronAmber = markers.find((m) => m.kind === "t3" && m.team === "amber")!.key;
    const patronSapphire = markers.find((m) => m.kind === "t3" && m.team === "sapphire")!.key;

    // Craft a frame at t=4 where all 5 Group B baseline types are non-default at once:
    // - camps: clearedCamp (cleared), unspawnedCamp (unspawned, first_s: 10), clearedHeal (cleared),
    //   clearedCrate (cleared), bossKey (cleared); aliveCamp is alive (must NOT materialize).
    // - powerups: downPwr is down, upPwr is up (must NOT materialize).
    // - rifts: activeRift is active, inactiveRift is elsewhere (must NOT materialize).
    // - urn: carried with delivery = deliveryUrn; otherUrn must NOT materialize.
    // - obj_health: patronAmber at stage 2 (materializes Stage2), patronSapphire at stage 1 (must NOT materialize).
    const tl = {
      ...base,
      camps: [
        ...markers
          .filter((m) => m.kind === "camp")
          .map((m) => ({
            key: m.key,
            first_s: m.key === unspawnedCamp ? 10 : 0,
            cleared: m.key === clearedCamp ? ([[2, 40]] as Array<[number, number]>) : [],
          })),
        { key: bossKey, first_s: 0, cleared: [[3, 400]] as Array<[number, number]> },
      ],
      objective_health: [
        { key: "walker:amber:lane1:1", at: [[0, 100], [4, 35]] },
        { key: patronAmber, at: [[0, 100], [4, 60]], stage: [[0, 1], [3, 2]] },
        { key: patronSapphire, at: [[0, 100], [4, 80]], stage: [[0, 1]] },
      ],
      urn: {
        spawns: [{ t: 1, key: otherUrn }],
        at: [{ t: 3, state: "carried", team: "sapphire", slot: 1, delivery: deliveryUrn }],
      },
    } as unknown as Timeline;

    const rs = roster(tl);
    const cap = captureToScene(tl, 4, WRITTEN_B, rs);
    const records: Record<RecordId, Entry> = {};
    for (const op of cap.saved.ops) {
      if ("Create" in op) records[op.Create.id] = { record: op.Create.record, deleted: false };
    }
    const scId = cap.saved.id;
    const scRec = (records[scId]!.record as { Scene: Record<string, unknown> }).Scene;

    // Simulate a coach override already stored on the source scene: revived clearedCamp ("Active").
    records["coach_override"] = {
      record: { ObjectiveState: { scene: scId, key: clearedCamp, status: "Active" } },
      deleted: false,
    };

    const fakeState = {
      records,
      sceneTree: () => [{ scene: { id: scId, scene: scRec }, parent: null, depth: 0 }],
    } as unknown as BoardState;

    // 1. Copy on R2 (WRITTEN = 27) with markers: drops Group B, lowers rows 40 -> 27, materializes all 5 types!
    let n = 0;
    const copy27 = addSceneOps(fakeState, { id: scId, scene: scRec as never }, false, () => `m${n++}`, "Copy", false, WRITTEN, markers);
    expect(copy27.full).toBe(false);
    // SceneState is strictly last in ops and in the last transaction.
    const lastCopyOp = copy27.ops.at(-1)!;
    const lastCopyTxOp = copy27.txs.at(-1)!.at(-1)!;
    expect("Create" in lastCopyOp && "SceneState" in lastCopyOp.Create.record).toBe(true);
    expect("Create" in lastCopyTxOp && "SceneState" in lastCopyTxOp.Create.record).toBe(true);

    const copiedState = copy27.ops.flatMap((o) => ("Create" in o && "SceneState" in o.Create.record ? [o.Create.record.SceneState.more!] : []))[0]!;
    expect(copiedState.rows).toBe(27);
    for (const k of Object.keys(copiedState)) expect(ROWS[k as RowKey].index, k).toBeLessThan(27);

    const objs = copy27.ops.flatMap((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [o.Create.record.ObjectiveState] : []));
    const byKey = new Map<string, ObjectiveStatus[]>();
    for (const o of objs) byKey.set(o.key, [...(byKey.get(o.key) ?? []), o.status]);

    // No duplicate keys!
    for (const [k, list] of byKey) expect(list, `duplicate ObjectiveState for ${k}`).toHaveLength(1);
    // Coach override preserved, not duplicated with "Destroyed":
    expect(byKey.get(clearedCamp)).toEqual(["Active"]);
    // All 5 Group B baseline types materialized accurately:
    expect(byKey.get(unspawnedCamp)).toEqual(["Destroyed"]);
    expect(byKey.get(clearedHeal)).toEqual(["Destroyed"]);
    expect(byKey.get(clearedCrate)).toEqual(["Destroyed"]);
    expect(byKey.get(bossKey)).toEqual(["Destroyed"]);
    expect(byKey.get(downPwr)).toEqual(["Destroyed"]);
    expect(byKey.get(activeRift)).toEqual(["Active"]);
    expect(byKey.get(deliveryUrn)).toEqual(["Active"]);
    expect(byKey.get(patronAmber)).toEqual(["Stage2"]);
    // Defaults NOT materialized:
    expect(byKey.has(aliveCamp)).toBe(false);
    expect(byKey.has(upPwr)).toBe(false);
    expect(byKey.has(inactiveRift)).toBe(false);
    expect(byKey.has(otherUrn)).toBe(false);
    expect(byKey.has(patronSapphire)).toBe(false);
    expect(byKey.has("walker:amber:lane1:1")).toBe(false);

    // 2. Copy on R3 (written = 40) with markers: ZERO Group B rows dropped -> ZERO extra ObjectiveStates materialized!
    n = 0;
    const copy40 = addSceneOps(fakeState, { id: scId, scene: scRec as never }, false, () => `r${n++}`, "Copy", false, WRITTEN_B, markers);
    const objs40 = copy40.ops.flatMap((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [o.Create.record.ObjectiveState] : []));
    expect(objs40.some((o) => o.key === unspawnedCamp)).toBe(false);
    expect(objs40.some((o) => o.key === patronAmber)).toBe(false);
    expect(objs40.some((o) => o.key === clearedCamp && o.status === "Active")).toBe(true);

    // 3. Respects `LIMITS.max_records`: materialized ObjectiveStates are counted against the cap!
    const needCount = copy27.ops.length;
    const padRecords = (total: number): BoardState => {
      const padded: Record<RecordId, Entry> = { ...records };
      let i = 0;
      while (Object.keys(padded).length < total) {
        padded[`pad_${i++}`] = { record: { Note: { scene: "other", text: "" } }, deleted: true };
      }
      return {
        records: padded,
        sceneTree: () => [{ scene: { id: scId, scene: scRec }, parent: null, depth: 0 }],
      } as unknown as BoardState;
    };
    const atCap = addSceneOps(padRecords(LIMITS.max_records - needCount), { id: scId, scene: scRec as never }, false, () => `f${n++}`, "Copy", false, WRITTEN, markers);
    expect(atCap.full).toBe(false);
    expect(atCap.txs.length).toBeGreaterThan(0);
    const overCap = addSceneOps(padRecords(LIMITS.max_records - needCount + 1), { id: scId, scene: scRec as never }, false, () => `g${n++}`, "Copy", false, WRITTEN, markers);
    expect(overCap.full).toBe(true);
    expect(overCap.txs).toEqual([]);

    // 4. Chunking via chunkByBytes when materialized ObjectiveStates push total ops > max_ops_per_tx (256), keeping SceneState last!
    const manyCampsTl = {
      ...tl,
      camps: markers.filter((m) => m.kind === "camp").map((m) => ({ key: m.key, first_s: 10, cleared: [] })),
      heals: markers.filter((m) => m.kind === "heal").map((m) => ({ key: m.key, first_s: 10, cleared: [] })),
      crates: markers.filter((m) => m.kind === "crate").map((m) => ({ key: m.key, first_s: 10, cleared: [] })),
    } as unknown as Timeline;
    const capMany = captureToScene(manyCampsTl, 4, WRITTEN_B, rs);
    const manyRecords: Record<RecordId, Entry> = {};
    for (const op of capMany.saved.ops) {
      if ("Create" in op) manyRecords[op.Create.id] = { record: op.Create.record, deleted: false };
    }
    const scManyId = capMany.saved.id;
    const scManyRec = (manyRecords[scManyId]!.record as { Scene: Record<string, unknown> }).Scene;
    // Add 120 drawings so scene + heroes + materialized camps + ink > 256 ops.
    for (let i = 0; i < 120; i++) {
      manyRecords[`ink_${i}`] = { record: { Arrow: { scene: scManyId, from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, team: null, color: null } }, deleted: false };
    }
    const manyState = {
      records: manyRecords,
      sceneTree: () => [{ scene: { id: scManyId, scene: scManyRec }, parent: null, depth: 0 }],
    } as unknown as BoardState;
    const chunked = addSceneOps(manyState, { id: scManyId, scene: scManyRec as never }, false, () => `k${n++}`, "Copy", true, WRITTEN, markers);
    expect(chunked.full).toBe(false);
    expect(chunked.ops.length).toBeGreaterThan(LIMITS.max_ops_per_tx);
    expect(chunked.txs.length).toBeGreaterThan(1);
    for (const tx of chunked.txs) {
      expect(tx.length).toBeLessThanOrEqual(LIMITS.max_ops_per_tx);
      expect(opsBytes(tx)).toBeLessThanOrEqual(LIMITS.max_tx_bytes - 1024);
    }
    // SceneState is strictly in the last tx, last op!
    const lastChunkOp = chunked.txs.at(-1)!.at(-1)!;
    expect("Create" in lastChunkOp && "SceneState" in lastChunkOp.Create.record).toBe(true);
    expect(chunked.txs.slice(0, -1).every((tx) => tx.every((o) => !("Create" in o && "SceneState" in o.Create.record)))).toBe(true);

    // 5. Ground urn with state="none" materializes nothing; direct helper sanity check.
    expect(materializeDroppedBaseline({ rows: 40, has_urn: true, urn: [0, -1, -1, -1, -1, -1, -1] }, 27, 4, markers, new Set())).toEqual([]);
  });

  it("Astra R1 review edge: explicit { written: 40, builds: false } and { written: 27, builds: false } use bucketed overflow fallback", () => {
    const base = richReplay();
    const extraMarkers = [
      ...markers,
      ...Array.from({ length: 245 }, (_, i) => ({
        key: `camp:neutral:lane0:extra_${i}`,
        kind: "camp" as const,
        team: "neutral" as const,
        lane: null,
        at: { x: 10 + (i % 900), y: 10 + Math.floor(i / 900) },
      })),
    ];
    const tl = {
      ...base,
      objectives: [{ key: "guardian:sapphire:lane4:1", kind: "guardian", team: "sapphire", lane: 4, destroyed_s: 1 }],
      camps: extraMarkers.filter((m) => m.kind === "camp").map((m) => ({ key: m.key, first_s: 100, cleared: [] })),
    } as unknown as Timeline;
    const rs = roster(tl);

    // Legacy v14 (`written: 16, builds: false`) stays all-or-nothing and returns empty ops on > 256 ops.
    let n = 0;
    const v14 = matchSceneOps(rs, [], undefined, tl, 4, extraMarkers, () => `v14_${n++}`, [], {
      source: sourceOf(tl),
      written: 16,
      builds: false,
    });
    expect(v14.ops).toEqual([]);

    // Phase 5 (`written: 27` and `written: 40`, with `builds: false`) uses fitBuckets, dropping the
    // overflowing camp bucket whole while preserving mandatory destroyed objectives + SceneState!
    for (const written of [WRITTEN, WRITTEN_B]) {
      n = 0;
      const saved = matchSceneOps(rs, [], undefined, tl, 4, extraMarkers, () => `p5_${n++}`, [], {
        source: sourceOf(tl),
        written,
        builds: false,
      });
      expect(saved.builds).toBe(false);
      expect(saved.ops.length).toBeGreaterThan(0);
      expect(saved.ops.length).toBeLessThanOrEqual(LIMITS.max_ops_per_tx);
      expect(opsBytes(saved.ops)).toBeLessThanOrEqual(LIMITS.max_tx_bytes - 1024);
      const objs = saved.ops.flatMap((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [o.Create.record.ObjectiveState] : []));
      expect(objs.some((o) => o.key === "guardian:sapphire:lane4:1" && o.status === "Destroyed")).toBe(true);
      expect(objs.some((o) => o.key.startsWith("camp:"))).toBe(false);
      const st = saved.ops.flatMap((o) => ("Create" in o && "SceneState" in o.Create.record ? [o.Create.record.SceneState.more!] : []))[0]!;
      expect(st).toEqual({ rows: written, has_heroes: true });
    }
  });

  it("Finding #1: Retake preflights max_more_bytes so incomplete sight/CC/movement/lanes are never flagged captured or passed by rows", () => {
    // At t=3: amber-1 (i=1) is unseen (seen [[6,23],[41,67]]), not on cc; let's force amber-1
    // to have unseen=true, cc=20, height=1, zipline=true all at t=3!
    const base = richReplay();
    const tl = {
      ...base,
      players: base.players.map((p, i) =>
        i === 1
          ? { ...p, seen: [[6, 23], [41, 67]], cc: [[25, 35, 20, 255, 0]], height: [[0, 1]], zipline: [[2, 5]] }
          : p,
      ),
    } as unknown as Timeline;
    const rs = roster(tl);
    const v14Cap = captureToScene(tl, 3, 16, rs);
    const sceneObj = { name: "s", order: "a", clock: 3, source: { match_id: tl.match_id, t: 3, tier: "replay" } };
    const sceneRow = { id: v14Cap.saved.id, scene: sceneObj } as never;

    // Helper: craft a 100% schema-legal hero `more` with exactly `free` bytes remaining under
    // `LIMITS.max_more_bytes` (`build_order <= 600`, `items <= 128`, `abilities <= 48`, `name <= 24`,
    // all ints within `ROWS` bounds).
    const padHeroMore = (baseMore: More, free: number): More => {
      const m: More = {
        ...baseMore,
        build_order: Array.from({ length: 600 }, () => 4_294_967_295),
        items: [] as number[],
        abilities: [] as number[],
      };
      const items = m.items as number[];
      while (items.length < 128 && moreBytes({ ...m, items: [...items, 4_294_967_295] }) <= LIMITS.max_more_bytes - free - 24) {
        items.push(4_294_967_295);
      }
      const ab = m.abilities as number[];
      while (ab.length < 48 && moreBytes({ ...m, abilities: [...ab, 4_294_967_295] }) <= LIMITS.max_more_bytes - free - 12) {
        ab.push(4_294_967_295);
      }
      // Fine-tune exact byte count using a schema-legal `name` (`<= LIMITS.max_name = 24` chars).
      let len = 1;
      while (len < LIMITS.max_name && moreBytes({ ...m, name: "a".repeat(len) }) < LIMITS.max_more_bytes - free) len++;
      const out: More = { ...m, name: "a".repeat(len) };
      expect((out.build_order as number[]).length).toBeLessThanOrEqual(600);
      expect((out.items as number[]).length).toBeLessThanOrEqual(128);
      expect((out.abilities as number[]).length).toBeLessThanOrEqual(48);
      expect((out.name as string).length).toBeLessThanOrEqual(LIMITS.max_name);
      expect(LIMITS.max_more_bytes - moreBytes(out)).toBe(free);
      return out;
    };

    const wavesMap = new Map(
      [...v14Cap.waves].map(([lane, w], idx) => [lane, { id: `w${idx}`, t: w.t, ...(w.more ? { more: w.more } : {}) }]),
    );
    const stateEntries = (ops: Op[], id: string) =>
      ops.flatMap((o) =>
        "Set" in o && o.Set.id === id && "More" in o.Set.value
          ? [[o.Set.value.More.key, o.Set.value.More.value] as const]
          : "SetIf" in o && o.SetIf.id === id && "More" in o.SetIf.value
            ? [[o.SetIf.value.More.key, o.SetIf.value.More.value] as const]
            : [],
      );
    const stateMoreOps = (ops: Op[], id: string): More => {
      const out: More = {};
      for (const [k, v] of stateEntries(ops, id)) if (v !== null) out[k] = v;
      return out;
    };
    const applyStateOps = (baseState: More, ops: Op[], id: string): More => {
      const next: More = { ...baseState };
      for (const [k, v] of stateEntries(ops, id)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      return next;
    };

    // Case 1a: Hero 1 has only 4 bytes free -> neither `unseen` (14B), `cc` (8B), nor `height`/`zipline` fits.
    // Retake must NOT set has_sight/has_cc/has_movement and must NOT emit partial hero writes!
    // Lanes (`SetIf` on edges) & skulls (`Set` on SceneState) DO fit and are admitted cleanly, while
    // `rows` uses `SetIf` expecting the observed watermark (monotonic!).
    const heroesTight = v14Cap.heroes.map((h, i) =>
      i === 1 ? { ...h, state: { ...h.state, more: padHeroMore(h.state.more ?? {}, 4) } } : h,
    );
    const st16 = { id: "st1", more: { rows: 16, has_builds: true, has_heroes: true, build: 6839 } as More };
    let mid = 0;
    const txsTight = retakeOps(sceneRow, st16, heroesTight, rs, tl, () => `r${mid++}`, WRITTEN, markers, wavesMap);
    const opsTight = txsTight.flat();
    // `rows` uses `SetIf` expecting 16 (monotonic); `Wave.more.edges` uses `SetIf` expecting null; flags use `Set`.
    expect(opsTight).toContainEqual({ SetIf: { id: "st1", expect: { More: { key: "rows", value: 16 } }, value: { More: { key: "rows", value: ROWS.skulls.index + 1 } } } });
    expect(opsTight.filter((o) => "SetIf" in o && o.SetIf.id.startsWith("w")).length).toBeGreaterThan(0);
    expect(opsTight).toContainEqual({ Set: { id: "st1", value: { More: { key: "has_lanes", value: true } } } });
    expect(opsTight).toContainEqual({ Set: { id: "st1", value: { More: { key: "has_skulls", value: true } } } });
    const stateWrites = stateMoreOps(opsTight, "st1");
    expect(stateWrites.has_sight).toBeUndefined();
    expect(stateWrites.has_cc).toBeUndefined();
    expect(stateWrites.has_movement).toBeUndefined();
    // Lanes & skulls DO fit and are admitted cleanly!
    expect(stateWrites.has_lanes).toBe(true);
    expect(stateWrites.has_skulls).toBe(true);
    expect(stateWrites.rows).toBe(ROWS.skulls.index + 1);
    // ZERO partial unseen/cc/height/zipline writes on ANY hero!
    const allHeroKeys = opsTight.flatMap((o) =>
      "Set" in o && o.Set.id !== "st1" && "More" in o.Set.value ? [o.Set.value.More.key] : [],
    );
    expect(allHeroKeys).not.toContain("unseen");
    expect(allHeroKeys).not.toContain("cc");
    expect(allHeroKeys).not.toContain("height");
    expect(allHeroKeys).not.toContain("zipline");

    // Verify `captured()` reads lanes & skulls as true and sight/cc/movement as false!
    const afterPartialState: More = applyStateOps(st16.more, opsTight, "st1");
    expect(captured(afterPartialState)).toMatchObject({
      sight: false,
      cc: false,
      movement: false,
      lanes: true,
      skulls: true,
    });

    // After applying lanes & skulls, `canRetake` with heroes/roster returns false (no dead no-op button while jammed),
    // and once hero 1's space is freed (e.g. re-picked), `canRetake` returns true and Retake fills sight/cc/movement!
    expect(canRetake(sceneObj, afterPartialState, tl, WRITTEN, markers, heroesTight, rs, wavesMap)).toBe(false);
    expect(retakeOps(sceneRow, { id: "st1", more: afterPartialState }, heroesTight, rs, tl, () => `r${mid++}`, WRITTEN, markers, wavesMap)).toEqual([]);

    expect(canRetake(sceneObj, afterPartialState, tl, WRITTEN, markers, v14Cap.heroes, rs, wavesMap)).toBe(true);
    const txsAfterFree = retakeOps(sceneRow, { id: "st1", more: afterPartialState }, v14Cap.heroes, rs, tl, () => `r${mid++}`, WRITTEN, markers, wavesMap);
    expect(stateMoreOps(txsAfterFree.flat(), "st1")).toMatchObject({ has_sight: true, has_cc: true, has_movement: true });

    // Case 1b: When NO missing feature can fit, Retake emits [] and does NOT advance `rows` past 16!
    const noLanesSkullsTl = { ...tl, zips: [], players: tl.players.map((p) => ({ ...p, deaths: [] })) } as unknown as Timeline;
    const txsOnlyTight = retakeOps(sceneRow, st16, heroesTight, rs, noLanesSkullsTl, () => `z${mid++}`, ROWS.zipline.index + 1, markers, wavesMap);
    expect(txsOnlyTight).toEqual([]);

    // Case 2: Hero 1 has 24 bytes free -> `unseen` (14B) + `cc` (8B) fit (22B), `height`+`zipline` (~26B) do NOT fit.
    // Retake (up through movement, written = ROWS.zipline.index + 1) admits sight + cc via `Set`, skips movement
    // completely, and advances `rows` only to `ROWS.cc.index + 1` (20) — NOT past uncaptured movement!
    const heroesMid = v14Cap.heroes.map((h, i) =>
      i === 1 ? { ...h, state: { ...h.state, more: padHeroMore(h.state.more ?? {}, 24) } } : h,
    );
    const txsMid = retakeOps(sceneRow, st16, heroesMid, rs, tl, () => `m${mid++}`, ROWS.zipline.index + 1, markers, wavesMap);
    const midStateOps = stateMoreOps(txsMid.flat(), "st1");
    expect(midStateOps.has_sight).toBe(true);
    expect(midStateOps.has_cc).toBe(true);
    expect(midStateOps.has_movement).toBeUndefined();
    expect(midStateOps.rows).toBe(ROWS.cc.index + 1);
    expect(captured(applyStateOps(st16.more, txsMid.flat(), "st1"))).toMatchObject({ sight: true, cc: true, movement: false });
    const midHeroKeys = txsMid.flat().flatMap((o) =>
      "Set" in o && o.Set.id !== "st1" && "More" in o.Set.value ? [o.Set.value.More.key] : [],
    );
    expect(midHeroKeys).toContain("unseen");
    expect(midHeroKeys).toContain("cc");
    expect(midHeroKeys).not.toContain("height");
    expect(midHeroKeys).not.toContain("zipline");

    // Case 3 (Blocking #2 Half A): Dormant `true` flag beyond `rows` (`{ rows: 16, has_sight: true }`) is cleared
    // when sight fails preflight and another feature (`lanes`/`skulls`) advances `rows` past `unseen`, so dormant
    // flags never silently activate without data! Same for dormant `has_heroes: true` at `rows: 15`.
    const dormantSight = { id: "st_dormant", more: { rows: 16, has_builds: true, has_heroes: true, has_sight: true } as More };
    expect(captured(dormantSight.more).sight).toBe(false);
    const txsDormant = retakeOps(sceneRow, dormantSight, heroesTight, rs, tl, () => `d${mid++}`, WRITTEN, markers, wavesMap);
    const dormantClears = stateEntries(txsDormant.flat(), "st_dormant").filter(([, v]) => v === null).map(([k]) => k);
    expect(dormantClears).toContain("has_sight");
    const afterDormant = applyStateOps(dormantSight.more, txsDormant.flat(), "st_dormant");
    expect(afterDormant.has_sight).toBeUndefined();
    expect(captured(afterDormant)).toMatchObject({ sight: false, lanes: true, skulls: true });

    const dormantHeroes = { id: "st_dh", more: { rows: 15, has_builds: true, has_heroes: true } as More };
    expect(captured(dormantHeroes.more).heroes).toBe(false);
    const txsDormantH = retakeOps(sceneRow, dormantHeroes, v14Cap.heroes, rs, tl, () => `dh${mid++}`, WRITTEN, markers, wavesMap);
    const afterDormantH = applyStateOps(dormantHeroes.more, txsDormantH.flat(), "st_dh");
    expect(afterDormantH.has_heroes).toBeUndefined();
    expect(captured(afterDormantH).heroes).toBe(false);

    // Case 4 (Blocking #2 Half B): Explicit `has_sight: false` (at `rows: 16` or `rows: 27`) transitions to `true`
    // when sight is admitted, and `canRetake` becomes false once all features are captured!
    for (const initRows of [16, 27]) {
      const falseSight = {
        id: "st_false",
        more: {
          rows: initRows,
          has_builds: true,
          has_heroes: true,
          has_sight: false,
          ...(initRows === 27 ? { has_cc: true, has_movement: true, has_lanes: true, has_skulls: true } : {}),
        } as More,
      };
      expect(canRetake(sceneObj, falseSight.more, tl, WRITTEN, markers, v14Cap.heroes, rs, wavesMap)).toBe(true);
      const txsFalse = retakeOps(sceneRow, falseSight, v14Cap.heroes, rs, tl, () => `f${mid++}`, WRITTEN, markers, wavesMap);
      const afterFalse = applyStateOps(falseSight.more, txsFalse.flat(), "st_false");
      expect(afterFalse.has_sight).toBe(true);
      expect(captured(afterFalse).sight).toBe(true);
      expect(canRetake(sceneObj, afterFalse, tl, WRITTEN, markers, v14Cap.heroes, rs, wavesMap)).toBe(false);
    }

    // Case 5 (Blocking #3): Pre-v10 near-cap hero (`rows: 11`, missing `kills`/`deaths`/`assists`/`max_health`)
    // must NOT silently drop `max_health` or advance `rows` past 11 while jammed; once space frees up,
    // `canRetake` returns true and Retake backfills `max_health` + Group A + `rows = 27`!
    const preV10State = { id: "st_v10", more: { rows: 11, has_builds: true } as More };
    const preV10Heroes = v14Cap.heroes.map((h, i) => {
      if (i !== 1) return h;
      const { kills: _k, deaths: _d, assists: _a, max_health: _mh, ...withoutKda } = h.state.more!;
      return { ...h, state: { ...h.state, more: padHeroMore(withoutKda, 4) } };
    });
    expect(canRetake(sceneObj, preV10State.more, tl, WRITTEN, markers, preV10Heroes, rs, wavesMap)).toBe(false);
    expect(retakeOps(sceneRow, preV10State, preV10Heroes, rs, tl, () => `v10_${mid++}`, WRITTEN, markers, wavesMap)).toEqual([]);
    // Free hero 1's space (remove padded arrays): `canRetake` re-enables and fills K/D/A/max_health + Group A!
    const preV10Freed = preV10Heroes.map((h, i) =>
      i === 1 ? { ...h, state: { ...h.state, more: { hero: h.state.more!.hero! } } } : h,
    );
    expect(canRetake(sceneObj, preV10State.more, tl, WRITTEN, markers, preV10Freed, rs, wavesMap)).toBe(true);
    const txsV10Freed = retakeOps(sceneRow, preV10State, preV10Freed, rs, tl, () => `v10f_${mid++}`, WRITTEN, markers, wavesMap);
    const afterV10 = applyStateOps(preV10State.more, txsV10Freed.flat(), "st_v10");
    expect(afterV10.rows).toBe(27);
    expect(captured(afterV10)).toMatchObject({ builds: true, sight: true, cc: true, movement: true, lanes: true, skulls: true });
    // Also verify v14 `builds: false` scene with hero 1 jammed omits `has_builds: true` while allowing lanes/skulls:
    const v14NoBuilds = { id: "st_nb", more: { rows: 16, has_builds: false, has_heroes: true } as More };
    const v14JammedHeroes = v14Cap.heroes.map((h, i) => {
      if (i !== 1) return h;
      const { max_health: _mh, ...withoutMh } = h.state.more!;
      return { ...h, state: { ...h.state, more: padHeroMore(withoutMh, 4) } };
    });
    const txsNb = retakeOps(sceneRow, v14NoBuilds, v14JammedHeroes, rs, tl, () => `nb_${mid++}`, WRITTEN, markers, wavesMap);
    const afterNb = applyStateOps(v14NoBuilds.more, txsNb.flat(), "st_nb");
    expect(afterNb.has_builds).toBe(false);
    expect(captured(afterNb)).toMatchObject({ builds: false, lanes: true, skulls: true });

    // Case 6: Late-game Retake without builds reserves Group A headroom in captureBuild so sight/cc/movement all fit!
    const hugeItems = Array.from({ length: 300 }, (_, k): [number, number, number] => [k, 1_000_000_000 + k, 0]);
    const lateTl = {
      ...tl,
      players: tl.players.map((p, i) => (i === 1 ? { ...p, items: hugeItems } : p)),
    } as unknown as Timeline;
    const bareHeroes = v14Cap.heroes.map((h) => ({ ...h, state: { ...h.state, more: { hero: h.state.more!.hero! } } }));
    const bareState = { id: "st_bare", more: { rows: 16, has_builds: false, has_heroes: true } as More };
    const txsLate = retakeOps(sceneRow, bareState, bareHeroes, rs, lateTl, () => `l${mid++}`, WRITTEN, markers, wavesMap);
    const lateStateOps = stateMoreOps(txsLate.flat(), "st_bare");
    expect(lateStateOps).toMatchObject({ has_builds: true, has_sight: true, has_cc: true, has_movement: true, rows: 27 });
    // Verify hero 1's resulting `more` after applying all ops stays strictly <= max_more_bytes!
    const hero1Id = bareHeroes[1]!.id;
    const hero1Result: More = { ...bareHeroes[1]!.state.more };
    for (const op of txsLate.flat()) {
      if ("Set" in op && op.Set.id === hero1Id && "More" in op.Set.value && op.Set.value.More.value !== null) {
        hero1Result[op.Set.value.More.key] = op.Set.value.More.value;
      }
      if ("SetIf" in op && op.SetIf.id === hero1Id && "More" in op.SetIf.value && op.SetIf.value.More.value !== null) {
        hero1Result[op.SetIf.value.More.key] = op.SetIf.value.More.value;
      }
    }
    expect(moreBytes(hero1Result)).toBeLessThanOrEqual(LIMITS.max_more_bytes);
    expect(hero1Result.unseen).toBe(true);
    expect(hero1Result.cc).toBeDefined();
    expect(hero1Result.height).toBe(1);
    expect(hero1Result.zipline).toBe(true);

    // Case 7 (Astra Round 3 #4): Dormant-flag activation when the only admitted feature already has
    // `has_skulls: true` and 0 deaths at the frame (metadata scene `{ rows: 16, has_builds: true, has_skulls: true }`):
    // `canRetake` is true, first `retakeOps` emits the monotonic `SetIf rows 16 -> 27`, and after applying it `canRetake` is false!
    const metaNoDeaths = {
      ...metadata,
      players: metadata.players.map((p) => ({ ...p, deaths: [] })),
    } as unknown as Timeline;
    const metaSceneObj = { name: "m", order: "a", clock: 3, source: { match_id: metaNoDeaths.match_id, t: 3, tier: "metadata" } };
    const metaSceneRow = { id: "sc_meta", scene: metaSceneObj } as never;
    const metaCap = captureToScene(metaNoDeaths, 3, 16, rs);
    const dormantSkulls = { id: "st_ds", more: { rows: 16, has_builds: true, build: 6839, has_heroes: true, has_skulls: true } as More };
    expect(captured(dormantSkulls.more).skulls).toBe(false);
    expect(canRetake(metaSceneObj, dormantSkulls.more, metaNoDeaths, WRITTEN, markers, metaCap.heroes, rs)).toBe(true);
    const txsDs = retakeOps(metaSceneRow, dormantSkulls, metaCap.heroes, rs, metaNoDeaths, () => `ds_${mid++}`, WRITTEN, markers);
    expect(txsDs).toEqual([[{ SetIf: { id: "st_ds", expect: { More: { key: "rows", value: 16 } }, value: { More: { key: "rows", value: WRITTEN } } } }]]);
    const afterDs = applyStateOps(dormantSkulls.more, txsDs.flat(), "st_ds");
    expect(captured(afterDs).skulls).toBe(true);
    expect(canRetake(metaSceneObj, afterDs, metaNoDeaths, WRITTEN, markers, metaCap.heroes, rs)).toBe(false);
  });

  it("Finding #4: remapped active koth/urn/powerup markers (without rift:/urn:/powerup: prefix) emit Active/Destroyed ObjectiveStates and keep bucket priority on overflow", () => {
    const base = richReplay();
    const origRift = keyOf("koth", 0);
    const origUrnDelivery = keyOf("urn", 1);
    const origPowerup = keyOf("powerup", 0);

    // Rename the board markers to custom keys that don't start with "rift:", "urn:", or "powerup:".
    const remappedMarkers = markers.map((m) =>
      m.key === origRift
        ? { ...m, key: "east-gate" }
        : m.key === origUrnDelivery
          ? { ...m, key: "west-drop" }
          : m.key === origPowerup
            ? { ...m, key: "north-bridge" }
            : m,
    );
    // Sanity: markerKey resolves the timeline's keys to the renamed board markers.
    expect(markerKey(origRift, remappedMarkers)).toBe("east-gate");
    expect(markerKey(origUrnDelivery, remappedMarkers)).toBe("west-drop");
    expect(markerKey(origPowerup, remappedMarkers)).toBe("north-bridge");

    // At t=4 in richReplay(): origRift is active (1..5), origUrnDelivery is open delivery (3..6),
    // and origPowerup is down (available[4] === 0).
    const rs = roster(base);
    let n = 0;
    const saved = matchSceneOps(rs, [], undefined, base, 4, remappedMarkers, () => `rm_${n++}`, [], {
      source: sourceOf(base),
      written: WRITTEN,
    });
    const objs = saved.ops.flatMap((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [o.Create.record.ObjectiveState] : []));
    expect(objs).toContainEqual(expect.objectContaining({ key: "east-gate", status: "Active" }));
    expect(objs).toContainEqual(expect.objectContaining({ key: "west-drop", status: "Active" }));
    expect(objs).toContainEqual(expect.objectContaining({ key: "north-bridge", status: "Destroyed" }));

    // Overflow (>256 ops with 245 extra down camps): "west-drop" (urn bucket) and "east-gate" (rifts bucket)
    // BOTH survive when the overflowing camps bucket is dropped whole!
    const overflowMarkers = [
      ...remappedMarkers,
      ...Array.from({ length: 245 }, (_, i) => ({
        key: `camp:neutral:lane0:ov_${i}`,
        kind: "camp" as const,
        team: "neutral" as const,
        lane: null,
        at: { x: 10 + (i % 900), y: 10 + Math.floor(i / 900) },
      })),
    ];
    const overflowTl = {
      ...base,
      camps: overflowMarkers.filter((m) => m.kind === "camp").map((m) => ({ key: m.key, first_s: 100, cleared: [] })),
    } as unknown as Timeline;
    n = 0;
    const savedOverflow = matchSceneOps(rs, [], undefined, overflowTl, 4, overflowMarkers, () => `ov_${n++}`, [], {
      source: sourceOf(overflowTl),
      written: WRITTEN,
    });
    expect(savedOverflow.ops.length).toBeGreaterThan(0);
    expect(savedOverflow.ops.length).toBeLessThanOrEqual(LIMITS.max_ops_per_tx);
    const ovObjs = savedOverflow.ops.flatMap((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [o.Create.record.ObjectiveState] : []));
    expect(ovObjs).toContainEqual(expect.objectContaining({ key: "west-drop", status: "Active" }));
    expect(ovObjs).toContainEqual(expect.objectContaining({ key: "east-gate", status: "Active" }));
    expect(ovObjs).toContainEqual(expect.objectContaining({ key: "north-bridge", status: "Destroyed" }));
    expect(ovObjs.some((o) => o.key.startsWith("camp:"))).toBe(false);
  });
});
