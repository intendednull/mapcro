import { describe, expect, it } from "vitest";
import { LASER_FADE_MS, LASER_HOLD_MS, LASER_LIFE_MS, LASER_MAX_POINTS, LASER_STEP_MS, type Timed, addLaser, arrowHead, fitStroke, laserAlpha, laserClip, polyline, pruneLaser, simplify, stampLaser } from "../src/board/geometry";

describe("ink", () => {
  it("drops points on a straight line and keeps corners", () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }));
    expect(simplify(line, 1)).toEqual([{ x: 0, y: 0 }, { x: 49, y: 0 }]);
    const corner = [...line, ...Array.from({ length: 50 }, (_, i) => ({ x: 49, y: i + 1 }))];
    expect(simplify(corner, 1)).toEqual([{ x: 0, y: 0 }, { x: 49, y: 0 }, { x: 49, y: 50 }]);
  });
  it("fits any scribble under the schema's 512-point cap", () => {
    const scribble = Array.from({ length: 5000 }, (_, i) => ({ x: Math.sin(i / 3) * 300, y: Math.cos(i / 7) * 300 }));
    const out = fitStroke(scribble, 512);
    expect(out.length).toBeLessThanOrEqual(512);
    expect(out[0]).toEqual(scribble[0]);
    expect(out.at(-1)).toEqual(scribble.at(-1));
  });
  it("draws a single dot", () => {
    expect(polyline([{ x: 5, y: 5 }])).toBe("M5 5 l0.01 0");
  });
  it("points the arrowhead along the shaft", () => {
    const [tip] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 20).split(" ");
    expect(tip).toBe("107,0");
  });
});

describe("laser", () => {
  it("holds, then lets go of points once they've faded", () => {
    const trail = [{ p: { x: 0, y: 0 }, t: 0 }, { p: { x: 1, y: 1 }, t: 500 }];
    expect(pruneLaser(trail, LASER_HOLD_MS)).toHaveLength(2);
    expect(pruneLaser(trail, LASER_HOLD_MS + LASER_FADE_MS)).toHaveLength(1);
    expect(pruneLaser(trail, 500 + LASER_HOLD_MS + LASER_FADE_MS)).toHaveLength(0);
  });
  it("keeps the newest 48 points (the server's cap)", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ p: { x: i, y: 0 }, t: 1000 }));
    const out = pruneLaser(many, 1000);
    expect(out).toHaveLength(48);
    expect(out.at(-1)!.p.x).toBe(99);
  });
  // #42: a point fades by its own age, on the clock: older is always fainter, from the start.
  it("fades each point by its age, all the way, never by its place in the trail", () => {
    expect(laserAlpha(0)).toBe(1);
    for (let age = 0; age < LASER_LIFE_MS; age += 50) expect(laserAlpha(age + 50)).toBeLessThan(laserAlpha(age));
    expect(laserAlpha(100)).toBeGreaterThan(0.95);
    expect(laserAlpha(LASER_LIFE_MS)).toBe(0);
  });
  it("keeps points a step apart, the head following the pointer, so a fast stroke's tail ages out", () => {
    // A stroke at 120 Hz for a whole second: the cap never cuts its tail; it spans the second.
    let trail: Timed[] = [];
    for (let i = 0; i <= 120; i++) trail = addLaser(trail, { x: i, y: 0 }, (i * 1000) / 120, 1);
    expect(trail.length).toBeLessThanOrEqual(LASER_MAX_POINTS);
    expect(trail[0]!.t).toBe(0);
    expect(trail.at(-1)!.p.x).toBe(120);
    for (let i = 2; i < trail.length; i++) expect(trail[i - 1]!.t - trail[i - 2]!.t).toBeGreaterThanOrEqual(LASER_STEP_MS);
    // A new gesture always starts its own point.
    const next = addLaser(trail, { x: 0, y: 9 }, 1001, 2);
    expect(next.at(-1)!.g).toBe(2);
    expect(next.at(-2)!.g).toBe(1);
  });
  it("stamps a peer's points when first seen, keeping each known point's time", () => {
    const a = stampLaser([], [{ x: 1, y: 1 }, { x: 2, y: 2 }], 100);
    expect(a.map((q) => q.t)).toEqual([100, 100]);
    const b = stampLaser(a, [{ x: 2, y: 2 }, { x: 3, y: 3 }], 150);
    expect(b.map((q) => q.t)).toEqual([100, 150]);
    // The same spot twice: each time is used once.
    const c = stampLaser([{ p: { x: 5, y: 5 }, t: 10 }], [{ x: 5, y: 5 }, { x: 5, y: 5 }], 20);
    expect(c.map((q) => q.t)).toEqual([10, 20]);
  });
});

/** A `laserClip` polygon as its corners. */
const corners = (points: string) => points.split(" ").map((q) => q.split(",").map(Number) as [number, number]);

/** Is `q` inside the convex quad `poly`? */
function inside(poly: [number, number][], q: { x: number; y: number }): boolean {
  const side = (a: [number, number], b: [number, number]) => (b[0] - a[0]) * (q.y - a[1]) - (b[1] - a[1]) * (q.x - a[0]);
  const s = poly.map((a, i) => Math.sign(side(a, poly[(i + 1) % poly.length]!)));
  return s.every((v) => v === s[0]);
}

// #46: neighbouring segments' round caps used to overlap at every joint, doubling the alpha there
// into a bright seam while the trail faded. Each segment is now cut at its joint, along one line
// both share, so the caps meet: nothing covered twice, nothing left uncovered.
describe("laser joints", () => {
  const trail = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 80, y: 40 }];
  it("splits the joint between the two segments, with no overlap and no gap", () => {
    const quads = [0, 1].map((i) => corners(laserClip(trail, i)));
    let both = 0;
    let neither = 0;
    let once = 0;
    // The disc the stroke paints around the joint (a segment is at most 9 wide on screen).
    for (let dx = -4; dx <= 4; dx += 0.37) {
      for (let dy = -4; dy <= 4; dy += 0.37) {
        if (Math.hypot(dx, dy) > 4) continue;
        const q = { x: 40 + dx, y: 0 + dy };
        const n = quads.filter((poly) => inside(poly, q)).length;
        if (n > 1) both++;
        else if (n === 0) neither++;
        else once++;
      }
    }
    expect(both).toBe(0); // no doubled alpha at the joint
    expect(neither).toBe(0); // and no gap in the trail either
    expect(once).toBeGreaterThan(200);
  });
  it("leaves the trail's own ends uncut, cap and all", () => {
    const line = [{ x: 0, y: 0 }, { x: 40, y: 0 }];
    expect(inside(corners(laserClip(line, 0)), { x: 44, y: 0 })).toBe(true);
  });
  it("still cuts cleanly when the trail doubles back on itself", () => {
    const back = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 1, y: 0.5 }];
    for (const i of [0, 1]) for (const [x, y] of corners(laserClip(back, i))) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    }
    const quads = [0, 1].map((i) => corners(laserClip(back, i)));
    expect(quads.filter((poly) => inside(poly, { x: 20, y: 3.5 })).length).toBeLessThan(2);
  });
});
