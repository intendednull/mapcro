// Where a held finger looks for a placed thing (TD-107): nearest first, never past the reach.
import { expect, it } from "vitest";
import { LONG_PRESS_REACH, reachPoints } from "../src/board/longPress";

it("starts at the finger's centre, goes outward, and stays inside the reach", () => {
  const pts = reachPoints(100, 200);
  expect(pts[0]).toEqual({ x: 100, y: 200 });
  const dist = pts.map((q) => Math.hypot(q.x - 100, q.y - 200));
  for (let i = 1; i < dist.length; i++) expect(dist[i]!).toBeGreaterThanOrEqual(dist[i - 1]! - 1e-9);
  expect(Math.max(...dist)).toBeCloseTo(LONG_PRESS_REACH);
});

it("leaves no gap a phone's pin (10 px across) could sit in on the outer ring", () => {
  const ring = reachPoints(0, 0).slice(-12);
  const gap = Math.hypot(ring[0]!.x - ring[1]!.x, ring[0]!.y - ring[1]!.y);
  expect(gap).toBeLessThan(12);
});
