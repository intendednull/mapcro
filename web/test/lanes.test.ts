// Lane equilibrium geometry: t along the lane by arc length, projection, the default split,
// and both viewpoints.
import { describe, expect, it } from "vitest";
import { FALLBACK } from "../src/map/fallback-data";
import { defaultSplit, laneLine, pointAt, project, samplePath, splitAt } from "../src/map/lanes";
import { mapToView, viewToMap } from "../src/map/transform";

// A straight lane from the Amber end (bottom) to the Sapphire end, given top-first.
const straight = laneLine([{ x: 500, y: 100 }, { x: 500, y: 900 }]);

describe("lanes", () => {
  it("run from the Amber end, whichever way they were given", () => {
    expect(straight.points[0]).toEqual({ x: 500, y: 900 });
    expect(pointAt(straight, 0)).toEqual({ x: 500, y: 900 });
    expect(pointAt(straight, 1000)).toEqual({ x: 500, y: 100 });
    expect(pointAt(straight, 250)).toEqual({ x: 500, y: 700 });
  });

  it("project a click to the nearest t, and t back to the point", () => {
    const p = project(straight, { x: 520, y: 500 });
    expect(p).toEqual({ t: 500, dist: 20 });
    for (const t of [0, 137, 500, 999, 1000]) expect(project(straight, pointAt(straight, t)).t).toBe(t);
  });

  it("t survives both viewpoints: a Sapphire-side click lands on the same place", () => {
    const lane = laneLine(samplePath(FALLBACK.lanes.find((l) => l.lane === "yellow")!.d));
    for (const t of [120, 480, 900]) {
      const onScreen = mapToView(pointAt(lane, t), "sapphire");
      expect(Math.abs(project(lane, viewToMap(onScreen, "sapphire")).t - t)).toBeLessThanOrEqual(1);
    }
  });

  it("split by default where the lane crosses the centre line, as the parity spec draws it", () => {
    expect(defaultSplit(straight)).toBe(500);
    const bent = laneLine([{ x: 0, y: 900 }, { x: 0, y: 500 }, { x: 800, y: 500 }, { x: 800, y: 100 }]);
    expect(pointAt(bent, defaultSplit(bent)).y).toBeCloseTo(500);
    for (const l of FALLBACK.lanes) {
      const line = laneLine(samplePath(l.d));
      expect(Math.abs(pointAt(line, defaultSplit(line)).y - 500), l.lane).toBeLessThan(3);
    }
  });

  it("split into Amber's half and Sapphire's with a gap between", () => {
    const { amber, sapphire } = splitAt(straight, 500, 20);
    expect(amber[0]).toEqual({ x: 500, y: 900 });
    expect(amber.at(-1)!.y).toBeCloseTo(510);
    expect(sapphire[0]!.y).toBeCloseTo(490);
    expect(sapphire.at(-1)).toEqual({ x: 500, y: 100 });
    // Moving t moves the boundary.
    expect(splitAt(straight, 250, 20).amber.at(-1)!.y).toBeCloseTo(710);
  });

  it("samples SVG curves densely enough to follow them", () => {
    const pts = samplePath("M0 0 C0 100 100 100 100 0", 4);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts.at(-1)).toEqual({ x: 100, y: 0 });
    expect(pts.length).toBeGreaterThan(30);
  });
});
