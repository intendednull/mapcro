import { describe, expect, it } from "vitest";
import {
  MAX_W,
  MIN_W,
  TRACK_DEFAULT_W,
  TRACK_ZOOM_THRESHOLD_W,
  centerViewOnWorld,
  normalizeSlotKey,
} from "../src/board/follow";
import { MARGIN, worldToView } from "../src/map/transform";

describe("hero camera tracking transform math", () => {
  it("uses the spec zoom defaults", () => {
    expect(TRACK_DEFAULT_W).toBe(400);
    expect(TRACK_ZOOM_THRESHOLD_W).toBe(480);
  });

  it("centers on a world point in both Amber and Sapphire viewpoints", () => {
    const pos = { x: 2400, y: -3200 };
    for (const vp of ["amber", "sapphire"] as const) {
      const v = centerViewOnWorld(pos, TRACK_DEFAULT_W, vp);
      const c = worldToView(pos, vp);
      expect(v.w).toBe(TRACK_DEFAULT_W);
      expect(v.x + v.w / 2).toBeCloseTo(c.x, 5);
      expect(v.y + v.w / 2).toBeCloseTo(c.y, 5);
    }
    const amber = centerViewOnWorld(pos, TRACK_DEFAULT_W, "amber");
    const sapphire = centerViewOnWorld(pos, TRACK_DEFAULT_W, "sapphire");
    expect(sapphire.x + sapphire.w / 2).toBeCloseTo(1000 - (amber.x + amber.w / 2), 5);
    expect(sapphire.y + sapphire.w / 2).toBeCloseTo(1000 - (amber.y + amber.w / 2), 5);
  });

  it("clamps cleanly at board edges in both viewpoints", () => {
    const farCorner = { x: -16000, y: 16000 };
    const amber = centerViewOnWorld(farCorner, TRACK_DEFAULT_W, "amber");
    expect(amber.x).toBe(-MARGIN);
    expect(amber.y).toBe(-MARGIN);
    expect(amber.w).toBe(TRACK_DEFAULT_W);

    const sapphire = centerViewOnWorld(farCorner, TRACK_DEFAULT_W, "sapphire");
    expect(sapphire.x).toBe(1000 + MARGIN - TRACK_DEFAULT_W);
    expect(sapphire.y).toBe(1000 + MARGIN - TRACK_DEFAULT_W);
    expect(sapphire.w).toBe(TRACK_DEFAULT_W);
  });

  it("clamps zoom width to [MIN_W, MAX_W] before centering", () => {
    const pos = { x: 1000, y: 1000 };
    const c = worldToView(pos, "amber");
    const deep = centerViewOnWorld(pos, 50, "amber");
    expect(deep.w).toBe(MIN_W);
    expect(deep.x + deep.w / 2).toBeCloseTo(c.x, 5);
    expect(deep.y + deep.w / 2).toBeCloseTo(c.y, 5);

    const wide = centerViewOnWorld(pos, 5000, "amber");
    expect(wide.w).toBe(MAX_W);
    expect(wide.x).toBe(-MARGIN);
    expect(wide.y).toBe(-MARGIN);
  });

  it("normalizes DOM data-slot attributes to canonical slotKey", () => {
    expect(normalizeSlotKey("Amber-0")).toBe("amber-0");
    expect(normalizeSlotKey("AMBER-0")).toBe("amber-0");
    expect(normalizeSlotKey("Sapphire-5")).toBe("sapphire-5");
    expect(normalizeSlotKey("amber-2")).toBe("amber-2");
    expect(normalizeSlotKey("  SAPPHIRE-3  ")).toBe("sapphire-3");
    expect(normalizeSlotKey("")).toBeUndefined();
    expect(normalizeSlotKey(null)).toBeUndefined();
    expect(normalizeSlotKey("neutral-0")).toBeUndefined();
    expect(normalizeSlotKey("Amber-foo")).toBeUndefined();
  });
});
