import { describe, expect, it } from "vitest";
import { LIVE_INK_POINTS, liveInk } from "../src/board/placed";

describe("live ink (review 2026-11-07, finding 4)", () => {
  it("a long stroke's live preview stays small, from its first point to its last", () => {
    // A wiggly 2,000-point stroke: nothing for simplification to drop.
    const pts = Array.from({ length: 2000 }, (_, i) => ({ x: i, y: (i % 2) * 40 }));
    const ink = liveInk(pts, 3, (p) => ({ x: p.x * 10, y: p.y * 10 }));
    expect(ink.color).toBe(3);
    expect(ink.points.length).toBeLessThanOrEqual(LIVE_INK_POINTS);
    expect(LIVE_INK_POINTS).toBeLessThanOrEqual(128);
    expect(ink.points[0]).toEqual({ x: 0, y: 0 });
    expect(ink.points.at(-1)).toEqual({ x: 19990, y: 400 });
  });
});
