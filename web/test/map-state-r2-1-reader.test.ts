// Map-state Phase 5, Release R2.1 reader tests (pre-R3 rollback target):
// Ensures the deployed v16 reader renders R3's announced pre-live rift (`open === 0` with slot-1
// site hash) and sparse `obj_health` unknown sentinel (`pct === -1`) identically to R3, including
// coach overrides and R2.1 copy materialization.

import { describe, expect, it, vi } from "vitest";

vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { createRoot } from "solid-js";
import type { More } from "../src/gen/More";
import type { ObjectiveStatus } from "../src/gen/ObjectiveStatus";
import { materializeDroppedBaseline } from "../src/board/scenes";
import { WRITTEN } from "../src/mapstate/build";
import { decodeObjHealth, decodeRift, fnv1a32 } from "../src/mapstate/codec";
import { fromScene } from "../src/mapstate/scene";
import { effectiveRift, markerTip, tipFacts } from "../src/player/Camps";
import { keyOf, markers } from "./support/synthetic-match";

function sceneWith(more: More, objectives: ReadonlyMap<string, { status: ObjectiveStatus }> = new Map(), frame = 700) {
  return fromScene({
    roster: () => [],
    heroes: () => [],
    objectives: () => objectives,
    waves: () => new Map(),
    state: () => more,
    markers: () => markers,
    frame: () => frame,
  });
}

describe("Phase 5 R2.1 reader (pre-R3 rollback parity)", () => {
  it("stays on R2 writer watermark (WRITTEN = 27)", () => {
    expect(WRITTEN).toBe(27);
  });

  it("decodes pre-live announced rift (open=0 with slot-1 site hash) and keeps lit icon + opening hover", () => {
    const kothMarkers = markers.filter((m) => m.kind === "koth");
    expect(kothMarkers.length).toBeGreaterThanOrEqual(2);
    const announced = kothMarkers[0]!;
    const other = kothMarkers[1]!;
    const annHash = fnv1a32(announced.key);
    const frame = 700;
    const riftInts = [0, annHash, -1, -1, -1, -1, 36, annHash];

    const decoded = decodeRift(riftInts, frame, markers);
    expect(decoded).toEqual({
      activeKey: null,
      announcedKey: announced.key,
      active: null,
      waiting: { state: "waiting", next: { t: 736, key: announced.key } },
    });

    createRoot((dispose) => {
      try {
        const more: More = { rows: 40, has_rifts: true, rift: riftInts };

        // 1. Fresh R3 Save / metadata-to-replay Retake (no ObjectiveState record)
        const fresh = sceneWith(more, new Map(), frame);
        expect(fresh.marker(announced.key).site()).toBe("Active");
        expect(fresh.marker(other.key).site()).toBe("Destroyed");
        expect(tipFacts(fresh, announced.key, false, undefined).rift).toEqual({
          state: "waiting",
          next: { t: 736, key: announced.key },
        });
        expect(markerTip(announced, tipFacts(fresh, announced.key, false, undefined), frame)).toBe("Rift opens in 0:36");

        // 2. Legacy R1/R2 replay-scene Retake (existing ObjectiveState: Active on announced site)
        const legacy = sceneWith(more, new Map([[announced.key, { status: "Active" }]]), frame);
        expect(effectiveRift("Active", legacy.marker(announced.key).rift(), legacy.marker(announced.key).site())).toEqual({
          state: "waiting",
          next: { t: 736, key: announced.key },
        });
        expect(markerTip(announced, tipFacts(legacy, announced.key, false, undefined), frame)).toBe("Rift opens in 0:36");

        // 3. Coach overrides: turning announced site off suppresses countdown; turning unannounced dark site on suppresses countdown
        const offOverride = sceneWith(more, new Map([[announced.key, { status: "Destroyed" }]]), frame);
        expect(tipFacts(offOverride, announced.key, false, undefined).rift).toBeUndefined();

        const beforeAnnounce = sceneWith({ rows: 40, has_rifts: true, rift: [0, -1, -1, -1, -1, -1, 80, annHash] }, new Map([[announced.key, { status: "Active" }]]), 600);
        expect(beforeAnnounce.marker(announced.key).site()).toBe("Destroyed");
        expect(tipFacts(beforeAnnounce, announced.key, false, undefined).rift).toBeUndefined();
      } finally {
        dispose();
      }
    });
  });

  it("decodes sparse obj_health unknown sentinel (pct = -1) without fabricating 100% hovers", () => {
    const walkers = markers.filter((m) => m.kind === "t2");
    const shrines = markers.filter((m) => m.kind === "shrine");
    expect(walkers.length).toBeGreaterThanOrEqual(2);
    expect(shrines.length).toBeGreaterThanOrEqual(1);
    const sampled = walkers[0]!;
    const fullDefault = walkers[1]!;
    const unsampled = shrines[0]!;

    const packed = [fnv1a32(sampled.key), 65, -1, fnv1a32(unsampled.key), -1, -1];
    const map = decodeObjHealth(packed, markers);
    expect(map.get(sampled.key)).toEqual({ pct: 65 });
    expect(map.get(unsampled.key)).toBeNull();
    expect(map.has(fullDefault.key)).toBe(false);

    createRoot((dispose) => {
      try {
        const s = sceneWith({ rows: 40, has_obj_health: true, obj_health: packed });
        expect(s.marker(sampled.key).health()).toEqual({ pct: 65 });
        expect(s.marker(fullDefault.key).health()).toEqual({ pct: 100 });
        expect(s.marker(unsampled.key).health()).toBeUndefined();
      } finally {
        dispose();
      }
    });
  });

  it("materializes announced rift and safely skips unknown obj_health sentinels when R2.1 copies an R3 scene", () => {
    const kothKey = keyOf("koth");
    const shrineKey = keyOf("shrine");
    const patronKey = keyOf("t3");
    const stateMore: More = {
      rows: 40,
      has_rifts: true,
      rift: [0, fnv1a32(kothKey), -1, -1, -1, -1, 30, fnv1a32(kothKey)],
      has_obj_health: true,
      obj_health: [fnv1a32(shrineKey), -1, -1, fnv1a32(patronKey), 80, 2],
    };
    const mat = new Map(materializeDroppedBaseline(stateMore, WRITTEN, 700, markers, new Set()).map((x) => [x.key, x.status]));
    expect(mat.get(kothKey)).toBe("Active");
    expect(mat.get(patronKey)).toBe("Stage2");
    expect(mat.has(shrineKey)).toBe(false);
  });
});
