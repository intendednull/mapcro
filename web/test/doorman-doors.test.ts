import { describe, expect, it, vi } from "vitest";

// Use the browser (reactive) SolidJS build in Node Vitest so signals & memos track updates.
vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { createRoot, createSignal } from "solid-js";
import { visionFade } from "../src/board/fade";
import { LIMITS } from "../src/gen/limits";
import type { More } from "../src/gen/More";
import type { Op } from "../src/gen/Op";
import { ROWS } from "../src/gen/rows";
import { IMAGE_BLOBS } from "../src/map/pack";
import { WRITTEN, captureScene, captured, moreBytes } from "../src/mapstate/build";
import { DOOR_STRIDE, MAX_DOORS, decodeDoors, encodeDoors } from "../src/mapstate/codec";
import {
  type SceneDoorContext,
  clearTeamDoorsOps,
  doorIdentity,
  linkSecondDoorOps,
  moveDoorOps,
  placeDoorwayOps,
  removeDoorwayOps,
  removeDoorwaysOps,
  resolveDoorIndex,
  toggleDoorSightOps,
  unlinkDoorOps,
} from "../src/mapstate/edit";
import { fromScene } from "../src/mapstate/scene";
import { shownDoors } from "../src/mapstate/shown";
import { FEATURES, featuresOf, fromTimeline } from "../src/mapstate/state";
import { DROP_ORDER, canRetake, matchSceneOps, retakeOps, sourceOf } from "../src/match/save";
import { type DoorNow, type Timeline, doorsAt } from "../src/match/timeline";
import { DOOR_R, doorLinkPath } from "../src/player/Doors";

const baseTimeline = (over: Partial<Timeline> = {}): Timeline => ({
  match_id: 142815246,
  start_time: 0,
  duration_s: 60,
  source: "replay",
  tier: "replay",
  build: 6865,
  format: 11,
  reanchored: 0,
  players: [
    {
      team: "amber",
      slot: 0,
      hero_id: 1,
      x: Array(61).fill(-1000),
      y: Array(61).fill(-1000),
      health: Array(61).fill(100),
      deaths: [],
      souls: [[0, 0]],
      ult: Array(61).fill(0),
      seen: [[0, 600]],
    },
    {
      team: "sapphire",
      slot: 0,
      hero_id: 69,
      x: Array(61).fill(1000),
      y: Array(61).fill(1000),
      health: Array(61).fill(100),
      deaths: [],
      souls: [[0, 0]],
      ult: Array(61).fill(0),
      seen: [[0, 600]],
    },
  ],
  objectives: [],
  mid_boss: [],
  doors: [
    // Unpaired from 10.0s..20.0s, then linked to door 1 from 20.0s..35.0s; seen by enemy 15.0s..30.0s.
    { id: 0, team: "sapphire", x: -1200, y: 800, start_ds: 100, link_ds: 200, end_ds: 350, partner: 1, seen: [[150, 300]] },
    { id: 1, team: "sapphire", x: 1400, y: -600, start_ds: 200, link_ds: 200, end_ds: 350, partner: 0, seen: [[200, 300]] },
    // Unpaired amber door 40.0s..50.0s, never seen by enemy.
    { id: 2, team: "amber", x: 0, y: 500, start_ds: 400, end_ds: 500, seen: [] },
  ],
  ...over,
});

describe("Doorman pack asset & registry invariants (Release 2)", () => {
  it("registers the already-extracted doorway icon in IMAGE_BLOBS", () => {
    expect(IMAGE_BLOBS["doorman-door"]).toBe("icons/doorman_doorway_psd");
  });

  it("marks rows 40–41 Live so WRITTEN becomes 42 in Release 2", () => {
    expect(ROWS.has_doors.index).toBe(40);
    expect(ROWS.doors.index).toBe(41);
    expect(ROWS.has_doors.status).toBe("live");
    expect(ROWS.doors.status).toBe("live");
    expect(WRITTEN).toBe(42);
    expect(FEATURES).toContain("doors");
    expect(DROP_ORDER).toContain("doors");
  });
});

describe("doorsAt", () => {
  it("derives unpaired, linked pair, expiry, and enemy FOW visibility on tenth-second clock", () => {
    const tl = baseTimeline();
    expect(doorsAt(tl, 99.5)).toEqual([]);
    // Unpaired before link_ds, unseen before 150.
    expect(doorsAt(tl, 120.5)).toEqual([
      { id: 0, team: "sapphire", at: { x: -1200, y: 800 }, role: "unpaired", partner: null, inSight: false },
    ]);
    // Unpaired before link_ds, seen at 160.5.
    expect(doorsAt(tl, 160.5)).toEqual([
      { id: 0, team: "sapphire", at: { x: -1200, y: 800 }, role: "unpaired", partner: null, inSight: true },
    ]);
    // Linked at 250.5, both seen.
    expect(doorsAt(tl, 250.5)).toEqual([
      { id: 0, team: "sapphire", at: { x: -1200, y: 800 }, role: "door1", partner: 1, inSight: true },
      { id: 1, team: "sapphire", at: { x: 1400, y: -600 }, role: "door2", partner: 0, inSight: true },
    ]);
    // Still linked at 320.5, out of enemy sight.
    expect(doorsAt(tl, 320.5)).toEqual([
      { id: 0, team: "sapphire", at: { x: -1200, y: 800 }, role: "door1", partner: 1, inSight: false },
      { id: 1, team: "sapphire", at: { x: 1400, y: -600 }, role: "door2", partner: 0, inSight: false },
    ]);
    // Gone at end_ds.
    expect(doorsAt(tl, 350.5)).toEqual([]);
    // Never-seen amber door.
    expect(doorsAt(tl, 450.5)).toEqual([
      { id: 2, team: "amber", at: { x: 0, y: 500 }, role: "unpaired", partner: null, inSight: false },
    ]);
  });

  it("treats all doors as inSight when the timeline has no vision data (agreeing with hasVision)", () => {
    const tl = baseTimeline({
      players: [],
      doors: [{ id: 0, team: "amber", x: 10, y: 20, start_ds: 0, end_ds: 100, seen: [[10, 20]] }],
    });
    expect(doorsAt(tl, 50.5)).toEqual([
      { id: 0, team: "amber", at: { x: 10, y: 20 }, role: "unpaired", partner: null, inSight: true },
    ]);
  });
});

describe("encodeDoors / decodeDoors", () => {
  it("round-trips unpaired, linked, and two-team doors identically", () => {
    const doors: DoorNow[] = [
      { id: 0, team: "amber", at: { x: -3000, y: 2400 }, role: "door1", partner: 1, inSight: true },
      { id: 1, team: "amber", at: { x: 1500, y: -900 }, role: "door2", partner: 0, inSight: true },
      { id: 2, team: "sapphire", at: { x: 4200, y: 3100 }, role: "unpaired", partner: null, inSight: false },
    ];
    const encoded = encodeDoors(doors);
    expect(encoded.length).toBe(doors.length * DOOR_STRIDE);
    expect(decodeDoors(encoded)).toEqual(doors);
  });

  it("remaps non-zero Player spawn IDs to dense 0..3 scene indices and caps at MAX_DOORS", () => {
    const playerDoors: DoorNow[] = [
      { id: 14, team: "sapphire", at: { x: 100, y: 200 }, role: "door1", partner: 15, inSight: true },
      { id: 15, team: "sapphire", at: { x: 300, y: 400 }, role: "door2", partner: 14, inSight: false },
      { id: 20, team: "amber", at: { x: -100, y: -200 }, role: "unpaired", partner: null, inSight: true },
      { id: 21, team: "amber", at: { x: -300, y: -400 }, role: "door1", partner: 22, inSight: true },
      { id: 22, team: "amber", at: { x: -500, y: -600 }, role: "door2", partner: 21, inSight: true },
    ];
    const decoded = decodeDoors(encodeDoors(playerDoors));
    expect(decoded).toHaveLength(MAX_DOORS);
    expect(decoded[0]).toMatchObject({ id: 0, role: "door1", partner: 1, inSight: true });
    expect(decoded[1]).toMatchObject({ id: 1, role: "door2", partner: 0, inSight: false });
    expect(decoded[2]).toMatchObject({ id: 2, role: "unpaired", partner: null });
    // Door 21's partner (22) fell past MAX_DOORS, so it cleanly degrades to unpaired.
    expect(decoded[3]).toMatchObject({ id: 3, role: "unpaired", partner: null });
  });

  it("defends against malformed, out-of-bounds, asymmetric, and cross-team payloads", () => {
    expect(decodeDoors(undefined)).toEqual([]);
    expect(decodeDoors("bad")).toEqual([]);
    expect(decodeDoors([0, 1, 2, 3, 4])).toEqual([]); // bad stride
    expect(decodeDoors([0, 1.5, 2, 0, -1, 0])).toEqual([]); // non-integer
    expect(decodeDoors(Array((MAX_DOORS + 1) * DOOR_STRIDE).fill(0))).toEqual([]); // > MAX_DOORS

    // Asymmetric partner, self-link, cross-team link, and out-of-range coordinates:
    const malformed = [
      // 0: invalid teamCode -> dropped
      9, 0, 0, 0, -1, 0,
      // 1 & 2: valid linked pair (original indices 1 and 2) -> survives drop & re-indexes to 0 & 1!
      1, 20000, -20000, 1, 2, 0,
      1, -500, 500, 2, 1, 1,
      // 3: cross-team or dangling partner -> degrades to unpaired at index 2
      0, 100, 200, 1, 1, 0,
    ];
    expect(decodeDoors(malformed)).toEqual([
      { id: 0, team: "sapphire", at: { x: 10752, y: -10752 }, role: "door1", partner: 1, inSight: true },
      { id: 1, team: "sapphire", at: { x: -500, y: 500 }, role: "door2", partner: 0, inSight: false },
      { id: 2, team: "amber", at: { x: 100, y: 200 }, role: "unpaired", partner: null, inSight: true },
    ]);

    // Same-role pairs (`door1`+`door1` and `door2`+`door2`) degrade cleanly to unpaired on both encode & decode.
    expect(
      decodeDoors([
        0, 100, 100, 1, 1, 0,
        0, 200, 200, 1, 0, 0,
        1, 300, 300, 2, 3, 0,
        1, 400, 400, 2, 2, 0,
      ]),
    ).toEqual([
      { id: 0, team: "amber", at: { x: 100, y: 100 }, role: "unpaired", partner: null, inSight: true },
      { id: 1, team: "amber", at: { x: 200, y: 200 }, role: "unpaired", partner: null, inSight: true },
      { id: 2, team: "sapphire", at: { x: 300, y: 300 }, role: "unpaired", partner: null, inSight: true },
      { id: 3, team: "sapphire", at: { x: 400, y: 400 }, role: "unpaired", partner: null, inSight: true },
    ]);
    expect(
      decodeDoors(
        encodeDoors([
          { id: 0, team: "amber", at: { x: 100, y: 100 }, role: "door1", partner: 1, inSight: true },
          { id: 1, team: "amber", at: { x: 200, y: 200 }, role: "door1", partner: 0, inSight: true },
        ]),
      ),
    ).toEqual([
      { id: 0, team: "amber", at: { x: 100, y: 100 }, role: "unpaired", partner: null, inSight: true },
      { id: 1, team: "amber", at: { x: 200, y: 200 }, role: "unpaired", partner: null, inSight: true },
    ]);

    // Invalid unseenInt (anything other than 0 or 1) drops the malformed entry.
    expect(
      decodeDoors([
        0, 100, 100, 0, -1, 99,
        1, 200, 200, 0, -1, -1,
        1, 300, 300, 0, -1, 0,
      ]),
    ).toEqual([{ id: 0, team: "sapphire", at: { x: 300, y: 300 }, role: "unpaired", partner: null, inSight: true }]);

    // encodeDoors filters invalid-team entries BEFORE indexing so later partner indices stay aligned.
    const withBogusTeam = [
      { id: 99, team: "bogus" as unknown as "amber", at: { x: 0, y: 0 }, role: "unpaired" as const, partner: null, inSight: true },
      { id: 10, team: "sapphire" as const, at: { x: -500, y: 500 }, role: "door1" as const, partner: 11, inSight: true },
      { id: 11, team: "sapphire" as const, at: { x: 500, y: -500 }, role: "door2" as const, partner: 10, inSight: false },
    ];
    expect(decodeDoors(encodeDoors(withBogusTeam))).toEqual([
      { id: 0, team: "sapphire", at: { x: -500, y: 500 }, role: "door1", partner: 1, inSight: true },
      { id: 1, team: "sapphire", at: { x: 500, y: -500 }, role: "door2", partner: 0, inSight: false },
    ]);
  });
});

describe("visionFade defense-in-depth (unmounted element)", () => {
  it("clears held immediately on fade-out when el() is undefined instead of wedging", async () => {
    // Simulate browser fadeTiming() > 0 ms in Node by stubbing document + getComputedStyle briefly.
    const prevDoc = globalThis.document;
    const prevStyle = globalThis.getComputedStyle;
    (globalThis as Record<string, unknown>).document = { documentElement: {} };
    (globalThis as Record<string, unknown>).getComputedStyle = () => ({
      getPropertyValue: (k: string) => (k === "--value-ease-ms" ? "350ms" : "cubic-bezier(0.16, 1, 0.3, 1)"),
    });
    try {
      let ctrl!: {
        setVal: (v: string | undefined) => void;
        setHidden: (h: boolean) => void;
        vf: ReturnType<typeof visionFade<string>>;
        dispose: () => void;
      };
      createRoot((dispose) => {
        const [val, setVal] = createSignal<string | undefined>("pair");
        const [hidden, setHidden] = createSignal(false);
        const vf = visionFade({ value: val, hidden, smooth: () => true, el: () => undefined });
        ctrl = { setVal, setHidden, vf, dispose };
      });
      await Promise.resolve();
      expect(ctrl.vf.shown()).toBe("pair");
      ctrl.setHidden(true);
      ctrl.setVal(undefined);
      await Promise.resolve();
      // Without an element to animate, visionFade finishes "out" immediately and never leaves `held` wedged.
      expect(ctrl.vf.shown()).toBeUndefined();
      expect(ctrl.vf.leaving()).toBe(false);
      ctrl.dispose();
    } finally {
      (globalThis as Record<string, unknown>).document = prevDoc;
      (globalThis as Record<string, unknown>).getComputedStyle = prevStyle;
    }
  });
});

describe("fromTimeline, fromScene & shownDoors", () => {
  it("projects Player (hidden) and Scene D3 (faded) doors through Vision", () => {
    createRoot((dispose) => {
      const [t, setT] = createSignal(25);
      const tl = baseTimeline();
      expect(featuresOf(tl).doors).toBe(true);
      expect(featuresOf(baseTimeline({ doors: [] })).doors).toBe(false);

      const ms = fromTimeline({ tl: () => tl, t, markers: () => [] });
      expect(ms.has("doors")).toBe(true);
      // At t = 25s: sapphire pair is inSight = true -> seen under every Vision.
      expect(shownDoors(ms, "amber", false).map((d) => d.draw)).toEqual(["seen", "seen"]);
      // At t = 32s: sapphire pair is inSight = false -> hidden under enemy (amber) Vision in Player, seen under own (sapphire) & all.
      setT(32);
      expect(shownDoors(ms, "all", false).map((d) => d.draw)).toEqual(["seen", "seen"]);
      expect(shownDoors(ms, "sapphire", false).map((d) => d.draw)).toEqual(["seen", "seen"]);
      expect(shownDoors(ms, "amber", false).map((d) => d.draw)).toEqual(["hidden", "hidden"]);

      // Scene reader: Release 1 reads v19 `rows: 42, has_doors: true, doors: [...]` and draws faded under enemy Vision (D3).
      const sceneMs = fromScene({
        heroes: () => [],
        roster: () => [],
        objectives: () => new Map(),
        waves: () => new Map(),
        state: () => ({
          rows: 42,
          has_sight: true,
          has_doors: true,
          doors: encodeDoors(ms.scene().doors()),
        }),
      });
      expect(sceneMs.has("doors")).toBe(true);
      expect(shownDoors(sceneMs, "all", true).map((d) => d.draw)).toEqual(["seen", "seen"]);
      expect(shownDoors(sceneMs, "sapphire", true).map((d) => d.draw)).toEqual(["seen", "seen"]);
      expect(shownDoors(sceneMs, "amber", true).map((d) => d.draw)).toEqual(["faded", "faded"]);

      // Scene without `has_sight` (blank board / manual placement): matches `heroDraw` D5 fallback
      // (`!inSight` draws `faded` under every Vision in a Scene; `seen` in Player).
      const noSightSceneMs = fromScene({
        heroes: () => [],
        roster: () => [],
        objectives: () => new Map(),
        waves: () => new Map(),
        state: () => ({
          rows: 42,
          has_doors: true,
          doors: encodeDoors([
            { id: 0, team: "amber", at: { x: 100, y: 200 }, role: "door1", partner: 1, inSight: false },
            { id: 1, team: "amber", at: { x: 400, y: 500 }, role: "door2", partner: 0, inSight: false },
            { id: 2, team: "sapphire", at: { x: -300, y: -400 }, role: "unpaired", partner: null, inSight: true },
          ]),
        }),
      });
      expect(noSightSceneMs.has("sight")).toBe(false);
      expect(noSightSceneMs.has("doors")).toBe(true);
      expect(shownDoors(noSightSceneMs, "all", true).map((d) => d.draw)).toEqual(["faded", "faded", "seen"]);
      expect(shownDoors(noSightSceneMs, "amber", true).map((d) => d.draw)).toEqual(["faded", "faded", "seen"]);
      expect(shownDoors(noSightSceneMs, "sapphire", true).map((d) => d.draw)).toEqual(["faded", "faded", "seen"]);
      expect(shownDoors(noSightSceneMs, "sapphire", false).map((d) => d.draw)).toEqual(["seen", "seen", "seen"]);

      // Dormant watermark (`rows: 40`) ignores rows 40–41.
      const dormantMs = fromScene({
        heroes: () => [],
        roster: () => [],
        objectives: () => new Map(),
        waves: () => new Map(),
        state: () => ({ rows: 40, has_doors: true, doors: [1, 0, 0, 0, -1, 0] }),
      });
      expect(dormantMs.has("doors")).toBe(false);
      expect(dormantMs.scene().doors()).toEqual([]);

      dispose();
    });
  });
});

describe("doorLinkPath geometry", () => {
  it("suppresses short spans and bows long spans gently toward map centre", () => {
    expect(doorLinkPath({ x: 200, y: 200 }, { x: 200 + 2.4 * DOOR_R, y: 200 }, 1)).toBeNull();
    const path = doorLinkPath({ x: 200, y: 200 }, { x: 600, y: 200 }, 1);
    expect(path).toMatch(/^M214\.0 200\.0 Q400\.0 226\.0 586\.0 200\.0$/);
  });
});

describe("Release 2 Save / Retake (WRITTEN = 42) & non-Doorman zero-retake", () => {
  const roster = [
    { id: "r0", slot: { team: "Amber" as const, slot: 0, hero: 1, name: "" } },
    { id: "r1", slot: { team: "Sapphire" as const, slot: 0, hero: 69, name: "" } },
  ];
  const minter = () => {
    let n = 1;
    return () => `id${n++}`;
  };

  it("stays dormant at synthetic written = 40 (Release 1)", () => {
    const tl = baseTimeline();
    const res = matchSceneOps(roster, [], undefined, tl, 25, [], minter(), [], { source: sourceOf(tl), written: 40 });
    const stateOp = res.ops.find((op) => "Create" in op && "SceneState" in op.Create.record);
    expect(stateOp).toBeDefined();
    const more = (stateOp as { Create: { record: { SceneState: { more: Record<string, unknown> } } } }).Create.record.SceneState.more;
    expect(more.rows).toBe(40);
    expect(more.has_doors).toBeUndefined();
    expect(more.doors).toBeUndefined();
    expect(canRetake({ source: { match_id: tl.match_id, tier: "replay", t: 25 } }, more as never, tl, 40)).toBe(false);
  });

  it("writes has_doors + doors by default on Release 2 (WRITTEN = 42), omits doors at 0-door timestamp, and skips non-Doorman matches", () => {
    const tl = baseTimeline();
    // Save at linked timestamp (t = 25s) with default WRITTEN = 42.
    const linked = matchSceneOps(roster, [], undefined, tl, 25, [], minter(), [], { source: sourceOf(tl) });
    const stateOp = linked.ops.find((op) => "Create" in op && "SceneState" in op.Create.record);
    const more = (stateOp as { Create: { record: { SceneState: { more: Record<string, unknown> } } } }).Create.record.SceneState.more;
    expect(more.rows).toBe(42);
    expect(more.has_doors).toBe(true);
    expect(decodeDoors(more.doors)).toEqual([
      { id: 0, team: "sapphire", at: { x: -1200, y: 800 }, role: "door1", partner: 1, inSight: true },
      { id: 1, team: "sapphire", at: { x: 1400, y: -600 }, role: "door2", partner: 0, inSight: true },
    ]);

    // Save at unpaired timestamp (t = 12s).
    const unpaired = matchSceneOps(roster, [], undefined, tl, 12, [], minter(), [], { source: sourceOf(tl) });
    const uState = (unpaired.ops.find((op) => "Create" in op && "SceneState" in op.Create.record) as { Create: { record: { SceneState: { more: Record<string, unknown> } } } }).Create.record.SceneState.more;
    expect(uState.has_doors).toBe(true);
    expect(decodeDoors(uState.doors)).toEqual([
      { id: 0, team: "sapphire", at: { x: -1200, y: 800 }, role: "unpaired", partner: null, inSight: false },
    ]);

    // Save at 0-active-doors timestamp (t = 5s) on Doorman match: sets has_doors: true, omits doors key.
    const emptyT = matchSceneOps(roster, [], undefined, tl, 5, [], minter(), [], { source: sourceOf(tl) });
    const eState = (emptyT.ops.find((op) => "Create" in op && "SceneState" in op.Create.record) as { Create: { record: { SceneState: { more: Record<string, unknown> } } } }).Create.record.SceneState.more;
    expect(eState.has_doors).toBe(true);
    expect(eState.doors).toBeUndefined();

    // Non-Doorman match (`doors: []`): never writes has_doors/doors and existing R1 scenes show 0 spurious Retake buttons!
    const nonDoorman = baseTimeline({ doors: [] });
    const ndSave = matchSceneOps(roster, [], undefined, nonDoorman, 25, [], minter(), [], { source: sourceOf(nonDoorman) });
    const ndMore = (ndSave.ops.find((op) => "Create" in op && "SceneState" in op.Create.record) as { Create: { record: { SceneState: { more: Record<string, unknown> } } } }).Create.record.SceneState.more;
    expect(ndMore.has_doors).toBeUndefined();
    expect(ndMore.doors).toBeUndefined();
    const r1NonDoormanMore = captureScene(nonDoorman, { written: 40, sight: true, skulls: true });
    expect(canRetake({ source: { match_id: nonDoorman.match_id, tier: "replay", t: 25 } }, r1NonDoormanMore, nonDoorman)).toBe(false);

    // Retake from an R1 (rows: 40) scene on a Doorman match backfills has_doors + doors + rows: 42.
    const r1More = captureScene(tl, { written: 40, sight: true, skulls: true });
    expect(captured(r1More).doors).toBe(false);
    const sc = { id: "s1", scene: { name: "Saved", order: "a", clock: 25, source: { match_id: tl.match_id, tier: "replay", t: 25 }, live: false, parent: null } };
    expect(canRetake(sc.scene, r1More, tl)).toBe(true);
    const txs = retakeOps(sc, { id: "st1", more: r1More }, [], roster, tl, minter());
    const ops = txs.flat();
    expect(ops).toContainEqual({ Set: { id: "st1", value: { More: { key: "has_doors", value: true } } } });
    expect(ops).toContainEqual({ Set: { id: "st1", value: { More: { key: "doors", value: encodeDoors(doorsAt(tl, 250.5)) } } } });
    expect(ops).toContainEqual({ SetIf: { id: "st1", expect: { More: { key: "rows", value: 40 } }, value: { More: { key: "rows", value: 42 } } } });
  });
});

describe("Manual Scene doorway op builders (mapstate/edit.ts)", () => {
  /** Apply `SceneState` Create/Set/SetIf ops to an in-memory `{ id, more }` state (matching validate.rs semantics). */
  function applyStateOps(
    state: { id: string; more: More } | undefined,
    ops: readonly Op[],
  ): { id: string; more: More } | undefined {
    let cur = state ? { id: state.id, more: { ...state.more } } : undefined;
    for (const op of ops) {
      if ("Create" in op && "SceneState" in op.Create.record) {
        cur = { id: op.Create.id, more: { ...(op.Create.record.SceneState.more ?? {}) } };
      } else if ("Set" in op && "More" in op.Set.value && cur && op.Set.id === cur.id) {
        const { key, value } = op.Set.value.More;
        if (value === null) delete cur.more[key];
        else cur.more[key] = value;
      } else if ("SetIf" in op && "More" in op.SetIf.value && "More" in op.SetIf.expect && cur && op.SetIf.id === cur.id) {
        const { key, value: expectVal } = op.SetIf.expect.More;
        const haveVal = cur.more[key] ?? null;
        if (JSON.stringify(haveVal) !== JSON.stringify(expectVal)) continue;
        const nextVal = op.SetIf.value.More.value;
        if (nextVal === null) delete cur.more[key];
        else cur.more[key] = nextVal;
      }
    }
    return cur;
  }

  const makeCtx = (state: { id: string; more: More } | undefined, written?: number): SceneDoorContext => {
    let n = 1;
    return { scene: "sc1", state, mint: () => `st_${n++}`, ...(written !== undefined ? { written } : {}) };
  };

  it("creates SceneState cleanly on a fresh blank board without falsely claiming builds/heroes/sight", () => {
    const ops = placeDoorwayOps(makeCtx(undefined), "amber", { x: 20000, y: -20000 }, { x: 1200, y: -800 });
    expect(ops).toHaveLength(1);
    const st = applyStateOps(undefined, ops);
    expect(st).toBeDefined();
    expect(st!.more.rows).toBe(42);
    expect(st!.more.has_doors).toBe(true);
    expect(st!.more.has_builds).toBeUndefined();
    expect(st!.more.has_heroes).toBeUndefined();
    expect(st!.more.has_sight).toBeUndefined();
    const snap = captured(st!.more);
    expect(snap.doors).toBe(true);
    expect(snap.builds).toBe(false);
    expect(snap.heroes).toBe(false);
    expect(snap.sight).toBe(false);
    expect(decodeDoors(st!.more.doors)).toEqual([
      { id: 0, team: "amber", at: { x: 10752, y: -10752 }, role: "door1", partner: 1, inSight: true },
      { id: 1, team: "amber", at: { x: 1200, y: -800 }, role: "door2", partner: 0, inSight: true },
    ]);
  });

  it("places doors on a pre-R2 scene (rows: 40 or rows: 16), bumping rows to 42 without breaking Retake for other features", () => {
    const tl = baseTimeline();
    const preR2: { id: string; more: More } = { id: "st_old", more: { rows: 16, has_builds: true, has_heroes: true } };
    const ops = placeDoorwayOps(makeCtx(preR2), "sapphire", { x: -500, y: 600 });
    expect(ops.length).toBeGreaterThan(0);
    const next = applyStateOps(preR2, ops)!;
    expect(next.more.rows).toBe(42);
    expect(next.more.has_doors).toBe(true);
    expect(next.more.has_sight).toBeUndefined();
    expect(captured(next.more)).toMatchObject({ builds: true, heroes: true, doors: true, sight: false, skulls: false });
    expect(decodeDoors(next.more.doors)).toEqual([
      { id: 0, team: "sapphire", at: { x: -500, y: 600 }, role: "unpaired", partner: null, inSight: true },
    ]);
    // Other uncaptured Phase 5 features (sight, skulls) remain retakable!
    expect(canRetake({ source: { match_id: tl.match_id, tier: "replay", t: 25 } }, next.more, tl)).toBe(true);
  });

  it("clears dormant has_* flags above curRows before raising rows to 42", () => {
    const withDormant: { id: string; more: More } = {
      id: "st_dormant",
      more: { rows: 16, has_builds: true, has_camps: true, has_sight: true },
    };
    const ops = placeDoorwayOps(makeCtx(withDormant), "amber", { x: 100, y: 200 });
    const rowsIdx = ops.findIndex((o) => "Set" in o && "More" in o.Set.value && o.Set.value.More.key === "rows");
    const clearCampsIdx = ops.findIndex((o) => "Set" in o && "More" in o.Set.value && o.Set.value.More.key === "has_camps" && o.Set.value.More.value === null);
    const clearSightIdx = ops.findIndex((o) => "Set" in o && "More" in o.Set.value && o.Set.value.More.key === "has_sight" && o.Set.value.More.value === null);
    expect(clearCampsIdx).toBeGreaterThanOrEqual(0);
    expect(clearSightIdx).toBeGreaterThanOrEqual(0);
    expect(clearCampsIdx).toBeLessThan(rowsIdx);
    expect(clearSightIdx).toBeLessThan(rowsIdx);
    const next = applyStateOps(withDormant, ops)!;
    expect(next.more.rows).toBe(42);
    expect(next.more.has_camps).toBeUndefined();
    expect(next.more.has_sight).toBeUndefined();
    expect(captured(next.more)).toMatchObject({ builds: true, doors: true, camps: false, sight: false });

    // Dormant `has_builds: true` at `rows: 0` is cleared before raising `rows` to 42.
    const zeroBuilds: { id: string; more: More } = { id: "st_zero", more: { rows: 0, has_builds: true } };
    const zeroNext = applyStateOps(zeroBuilds, placeDoorwayOps(makeCtx(zeroBuilds), "amber", { x: 100, y: 200 }))!;
    expect(zeroNext.more.rows).toBe(42);
    expect(zeroNext.more.has_builds).toBeUndefined();
    expect(captured(zeroNext.more)).toMatchObject({ builds: false, doors: true });
  });

  it("uniformly bumps legacy v9 (rows: 11, has_builds: true) scenes to rows: 42 for R1 rollback visibility and preserves doors on Retake", () => {
    const tl = baseTimeline();
    const legacy: { id: string; more: More } = { id: "st_v9", more: { rows: 11, has_builds: true, build: 6839 } };
    const ops = placeDoorwayOps(makeCtx(legacy), "sapphire", { x: -300, y: 400 });
    const next = applyStateOps(legacy, ops)!;
    expect(next.more.rows).toBe(42);
    expect(next.more.has_doors).toBe(true);
    expect(captured(next.more)).toMatchObject({ builds: true, doors: true, rows: 42 });
    expect(decodeDoors(next.more.doors)).toEqual([
      { id: 0, team: "sapphire", at: { x: -300, y: 400 }, role: "unpaired", partner: null, inSight: true },
    ]);
    // Subsequent Retake backfills missing features while preserving the manually placed doors!
    expect(canRetake({ source: { match_id: tl.match_id, tier: "replay", t: 25 } }, next.more, tl)).toBe(true);
    const rOps = retakeOps({ id: "sc1", scene: { name: "s", order: "a", clock: 25, source: { match_id: tl.match_id, tier: "replay", t: 25 } } }, next, [], [], tl, () => "id", WRITTEN, []).flat();
    const afterRetake = applyStateOps(next, rOps)!;
    expect(decodeDoors(afterRetake.more.doors)).toEqual([
      { id: 0, team: "sapphire", at: { x: -300, y: 400 }, role: "unpaired", partner: null, inSight: true },
    ]);
    // Dormant `rows: 40, has_doors: true` still reads as `doors: false`!
    expect(captured({ rows: 40, has_doors: true }).doors).toBe(false);
  });

  it("stays dormant when written < 42, replaces stale dormant doors at rows: 16, preflights max_more_bytes, and defends against concurrent peer edits via SetIf + DoorIdentity", () => {
    // 1. Dormant when written = 40 (R1 watermark).
    expect(placeDoorwayOps(makeCtx(undefined, 40), "amber", { x: 100, y: 200 })).toEqual([]);

    // 2. Existing rows: 16 scene holding dormant `has_doors: true` + stale `doors` payload: replaces stale doors cleanly!
    const stale: { id: string; more: More } = {
      id: "st_stale",
      more: { rows: 16, has_builds: true, has_doors: true, doors: [1, 900, 900, 0, -1, 0] },
    };
    expect(captured(stale.more).doors).toBe(false);
    const replaced = applyStateOps(stale, placeDoorwayOps(makeCtx(stale), "amber", { x: 10, y: 20 }))!;
    expect(replaced.more.rows).toBe(42);
    expect(decodeDoors(replaced.more.doors)).toEqual([
      { id: 0, team: "amber", at: { x: 10, y: 20 }, role: "unpaired", partner: null, inSight: true },
    ]);

    // 3. Near-cap `SceneState.more`: preflights `max_more_bytes` and returns [] instead of emitting a doomed tx!
    const nearCap: { id: string; more: More } = {
      id: "st_cap",
      more: {
        rows: 42,
        has_builds: true,
        has_camps: true,
        camps: Array.from({ length: 738 }, (_, i) => 1_000_000_000 + i),
      },
    };
    expect(moreBytes(nearCap.more)).toBeLessThanOrEqual(LIMITS.max_more_bytes);
    expect(moreBytes({ ...nearCap.more, has_doors: true, doors: [0, 100, 200, 1, 1, 0, 0, 300, 400, 2, 0, 0] })).toBeGreaterThan(LIMITS.max_more_bytes);
    expect(placeDoorwayOps(makeCtx(nearCap), "amber", { x: 100, y: 200 }, { x: 300, y: 400 })).toEqual([]);

    // 4. `SetIf` skips stale concurrent peer edit instead of clobbering peer B's change!
    const base = applyStateOps(undefined, placeDoorwayOps(makeCtx(undefined), "amber", { x: -500, y: 500 }))!;
    const peerBOps = placeDoorwayOps(makeCtx(base), "sapphire", { x: 800, y: -800 });
    const peerAOps = moveDoorOps(makeCtx(base), 0, { x: -100, y: 100 }, doorIdentity(decodeDoors(base.more.doors)[0]!));
    const afterB = applyStateOps(base, peerBOps)!;
    const afterBThenA = applyStateOps(afterB, peerAOps)!;
    // Peer A's `SetIf` expected `base.more.doors`, which no longer matches `afterB.more.doors`, so B's sapphire door is NOT clobbered!
    expect(decodeDoors(afterBThenA.more.doors)).toEqual(decodeDoors(afterB.more.doors));

    // 5. `DoorIdentity` re-resolves shifted doors and returns [] when target door was deleted/changed by a peer.
    const both = afterB;
    const doors = decodeDoors(both.more.doors);
    const sapId = doorIdentity(doors[1]!);
    expect(resolveDoorIndex(doors, 1, sapId)).toBe(1);
    // If Amber's door at index 0 is removed, Sapphire's door shifts to index 0 and still resolves by identity!
    const onlySap = applyStateOps(both, clearTeamDoorsOps(makeCtx(both), "amber"))!;
    expect(resolveDoorIndex(decodeDoors(onlySap.more.doors), 1, sapId)).toBe(0);
    const movedShifted = applyStateOps(onlySap, moveDoorOps(makeCtx(onlySap), 1, { x: 900, y: -900 }, sapId))!;
    expect(decodeDoors(movedShifted.more.doors)).toEqual([
      { id: 0, team: "sapphire", at: { x: 900, y: -900 }, role: "unpaired", partner: null, inSight: true },
    ]);
    // Once moved, the old identity no longer matches -> returns [] (never hits another door!).
    expect(removeDoorwayOps(makeCtx(movedShifted), 0, sapId)).toEqual([]);
  });

  it("enforces team replacement (1 pair per team, max 4 doors total) while preserving the other team's doors", () => {
    let st = applyStateOps(undefined, placeDoorwayOps(makeCtx(undefined), "amber", { x: -1000, y: 1000 }, { x: 1000, y: -1000 }))!;
    st = applyStateOps(st, placeDoorwayOps(makeCtx(st), "sapphire", { x: 2000, y: 2000 }, { x: -2000, y: -2000 }))!;
    expect(decodeDoors(st.more.doors)).toHaveLength(MAX_DOORS);
    // Replacing Amber with an unpaired door preserves Sapphire's linked pair intact.
    st = applyStateOps(st, placeDoorwayOps(makeCtx(st), "amber", { x: 50, y: 60 }))!;
    expect(decodeDoors(st.more.doors)).toEqual([
      { id: 0, team: "sapphire", at: { x: 2000, y: 2000 }, role: "door1", partner: 1, inSight: true },
      { id: 1, team: "sapphire", at: { x: -2000, y: -2000 }, role: "door2", partner: 0, inSight: true },
      { id: 2, team: "amber", at: { x: 50, y: 60 }, role: "unpaired", partner: null, inSight: true },
    ]);
  });

  it("supports linkSecondDoorOps, moveDoorOps, toggleDoorSightOps (lockstep, no has_sight), unlinkDoorOps, removeDoorwayOps, and clearTeamDoorsOps", () => {
    // Start with Sapphire pair + Amber unpaired (marked not seen first).
    let st = applyStateOps(undefined, placeDoorwayOps(makeCtx(undefined), "sapphire", { x: -1000, y: 0 }, { x: 1000, y: 0 }))!;
    st = applyStateOps(st, placeDoorwayOps(makeCtx(st), "amber", { x: 0, y: 2000 }))!;

    // Toggle sight on Amber unpaired (index 2): writes only `doors` via `SetIf`, never touches has_sight!
    const sightOps1 = toggleDoorSightOps(makeCtx(st), 2);
    expect(sightOps1.every((op) => "SetIf" in op && "More" in op.SetIf.value && op.SetIf.value.More.key === "doors")).toBe(true);
    st = applyStateOps(st, sightOps1)!;
    expect(st.more.has_sight).toBeUndefined();
    expect(decodeDoors(st.more.doors)[2]!.inSight).toBe(false);

    // Link second door to Amber unpaired (index 2): Door 1 does not move, Door 2 inherits inSight: false!
    st = applyStateOps(st, linkSecondDoorOps(makeCtx(st), 2, { x: 0, y: -2000 }))!;
    expect(decodeDoors(st.more.doors)).toEqual([
      { id: 0, team: "sapphire", at: { x: -1000, y: 0 }, role: "door1", partner: 1, inSight: true },
      { id: 1, team: "sapphire", at: { x: 1000, y: 0 }, role: "door2", partner: 0, inSight: true },
      { id: 2, team: "amber", at: { x: 0, y: 2000 }, role: "door1", partner: 3, inSight: false },
      { id: 3, team: "amber", at: { x: 0, y: -2000 }, role: "door2", partner: 2, inSight: false },
    ]);

    // Toggle sight on linked Sapphire Door 0 -> flips BOTH Door 0 and Door 1 in lockstep!
    const sightOps2 = toggleDoorSightOps(makeCtx(st), 0);
    expect(sightOps2).toHaveLength(1);
    st = applyStateOps(st, sightOps2)!;
    expect(st.more.has_sight).toBeUndefined();
    expect(decodeDoors(st.more.doors).slice(0, 2).map((d) => d.inSight)).toEqual([false, false]);

    // Move Door 3 (clamped to map) and verify no-op when moving to same spot.
    expect(moveDoorOps(makeCtx(st), 3, { x: 0, y: -2000 })).toEqual([]);
    st = applyStateOps(st, moveDoorOps(makeCtx(st), 3, { x: 500, y: -30000 }))!;
    expect(decodeDoors(st.more.doors)[3]!.at).toEqual({ x: 500, y: -10752 });

    // Unlink Door 0 -> removes Door 0, turns Door 1 into unpaired at its exact spot.
    st = applyStateOps(st, unlinkDoorOps(makeCtx(st), 0))!;
    expect(decodeDoors(st.more.doors)).toEqual([
      { id: 0, team: "sapphire", at: { x: 1000, y: 0 }, role: "unpaired", partner: null, inSight: false },
      { id: 1, team: "amber", at: { x: 0, y: 2000 }, role: "door1", partner: 2, inSight: false },
      { id: 2, team: "amber", at: { x: 500, y: -10752 }, role: "door2", partner: 1, inSight: false },
    ]);

    // Remove linked Amber doorway by clicking Door 1 -> removes BOTH Amber doors!
    st = applyStateOps(st, removeDoorwayOps(makeCtx(st), 1))!;
    expect(decodeDoors(st.more.doors)).toEqual([
      { id: 0, team: "sapphire", at: { x: 1000, y: 0 }, role: "unpaired", partner: null, inSight: false },
    ]);

    // Clear last team's doors -> sets `doors: null` via `SetIf` while KEEPING `has_doors: true` (no spurious Retake!).
    const clearOps = clearTeamDoorsOps(makeCtx(st), "sapphire");
    expect(clearOps).toEqual([
      { SetIf: { id: st.id, expect: { More: { key: "doors", value: st.more.doors! } }, value: { More: { key: "doors", value: null } } } },
    ]);
    st = applyStateOps(st, clearOps)!;
    expect(st.more.doors).toBeUndefined();
    expect(st.more.has_doors).toBe(true);
    expect(captured(st.more).doors).toBe(true);
    expect(clearTeamDoorsOps(makeCtx(st), "sapphire")).toEqual([]);
    expect(clearTeamDoorsOps(makeCtx(undefined), "amber")).toEqual([]);

    // Batch scrub removeDoorwaysOps removes multiple doorways across both teams in 1 `SetIf` op.
    let st2 = applyStateOps(undefined, placeDoorwayOps(makeCtx(undefined), "amber", { x: 100, y: 100 }, { x: 200, y: 200 }))!;
    st2 = applyStateOps(st2, placeDoorwayOps(makeCtx(st2), "sapphire", { x: -100, y: -100 }))!;
    const batchOps = removeDoorwaysOps(makeCtx(st2), [0, 2]);
    expect(batchOps).toEqual([
      { SetIf: { id: st2.id, expect: { More: { key: "doors", value: st2.more.doors! } }, value: { More: { key: "doors", value: null } } } },
    ]);
  });
});
