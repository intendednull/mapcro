import { describe, expect, it, vi } from "vitest";

// Use the browser (reactive) SolidJS build in Node Vitest so signals & memos track updates.
vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { createRoot, createSignal } from "solid-js";
import { visionFade } from "../src/board/fade";
import { ROWS } from "../src/gen/rows";
import { IMAGE_BLOBS } from "../src/map/pack";
import { WRITTEN, captureScene, captured } from "../src/mapstate/build";
import { DOOR_STRIDE, MAX_DOORS, decodeDoors, encodeDoors } from "../src/mapstate/codec";
import { fromScene } from "../src/mapstate/scene";
import { shownDoors } from "../src/mapstate/shown";
import { FEATURES, featuresOf, fromTimeline } from "../src/mapstate/state";
import { canRetake, matchSceneOps, retakeOps, sourceOf } from "../src/match/save";
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

describe("Doorman pack asset & registry invariants (Release 1)", () => {
  it("registers the already-extracted doorway icon in IMAGE_BLOBS", () => {
    expect(IMAGE_BLOBS["doorman-door"]).toBe("icons/doorman_doorway_psd");
  });

  it("keeps rows 40–41 Ahead so WRITTEN stays 40 in Release 1", () => {
    expect(ROWS.has_doors.index).toBe(40);
    expect(ROWS.doors.index).toBe(41);
    expect(ROWS.has_doors.status).toBe("ahead");
    expect(ROWS.doors.status).toBe("ahead");
    expect(WRITTEN).toBe(40);
    expect(FEATURES).toContain("doors");
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

describe("Release 1 dormancy vs synthetic Release 2 (written = 42) Save / Retake", () => {
  const roster = [
    { id: "r0", slot: { team: "Amber" as const, slot: 0, hero: 1, name: "" } },
    { id: "r1", slot: { team: "Sapphire" as const, slot: 0, hero: 69, name: "" } },
  ];
  const minter = () => {
    let n = 1;
    return () => `id${n++}`;
  };

  it("emits zero has_doors/doors ops on Release 1 (WRITTEN = 40)", () => {
    const tl = baseTimeline();
    const res = matchSceneOps(roster, [], undefined, tl, 25, [], minter(), [], { source: sourceOf(tl) });
    const stateOp = res.ops.find((op) => "Create" in op && "SceneState" in op.Create.record);
    expect(stateOp).toBeDefined();
    const more = (stateOp as { Create: { record: { SceneState: { more: Record<string, unknown> } } } }).Create.record.SceneState.more;
    expect(more.rows).toBe(40);
    expect(more.has_doors).toBeUndefined();
    expect(more.doors).toBeUndefined();
    expect(canRetake({ source: { match_id: tl.match_id, tier: "replay", t: 25 } }, more as never, tl, WRITTEN)).toBe(false);
  });

  it("captures and retakes doors cleanly at synthetic written = 42", () => {
    const tl = baseTimeline();
    // Save at linked timestamp (t = 25s) with synthetic written = 42.
    const linked = matchSceneOps(roster, [], undefined, tl, 25, [], minter(), [], { source: sourceOf(tl), written: 42 });
    const stateOp = linked.ops.find((op) => "Create" in op && "SceneState" in op.Create.record);
    const more = (stateOp as { Create: { record: { SceneState: { more: Record<string, unknown> } } } }).Create.record.SceneState.more;
    expect(more.rows).toBe(42);
    expect(more.has_doors).toBe(true);
    expect(decodeDoors(more.doors)).toEqual([
      { id: 0, team: "sapphire", at: { x: -1200, y: 800 }, role: "door1", partner: 1, inSight: true },
      { id: 1, team: "sapphire", at: { x: 1400, y: -600 }, role: "door2", partner: 0, inSight: true },
    ]);

    // Save at unpaired timestamp (t = 12s) with synthetic written = 42.
    const unpaired = matchSceneOps(roster, [], undefined, tl, 12, [], minter(), [], { source: sourceOf(tl), written: 42 });
    const uState = (unpaired.ops.find((op) => "Create" in op && "SceneState" in op.Create.record) as { Create: { record: { SceneState: { more: Record<string, unknown> } } } }).Create.record.SceneState.more;
    expect(decodeDoors(uState.doors)).toEqual([
      { id: 0, team: "sapphire", at: { x: -1200, y: 800 }, role: "unpaired", partner: null, inSight: false },
    ]);

    // Retake from an R1 (rows: 40) scene at synthetic written = 42 backfills has_doors + doors + rows: 42.
    const r1More = captureScene(tl, { written: 40, sight: true, skulls: true });
    expect(captured(r1More).doors).toBe(false);
    const sc = { id: "s1", scene: { name: "Saved", order: "a", clock: 25, source: { match_id: tl.match_id, tier: "replay", t: 25 }, live: false, parent: null } };
    expect(canRetake(sc.scene, r1More, tl, 42)).toBe(true);
    const txs = retakeOps(sc, { id: "st1", more: r1More }, [], roster, tl, minter(), 42);
    const ops = txs.flat();
    expect(ops).toContainEqual({ Set: { id: "st1", value: { More: { key: "has_doors", value: true } } } });
    expect(ops).toContainEqual({ Set: { id: "st1", value: { More: { key: "doors", value: encodeDoors(doorsAt(tl, 250.5)) } } } });
    expect(ops).toContainEqual({ SetIf: { id: "st1", expect: { More: { key: "rows", value: 40 } }, value: { More: { key: "rows", value: 42 } } } });
  });
});
