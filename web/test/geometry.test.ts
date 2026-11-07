import { describe, expect, it } from "vitest";
import { LASER_FADE_MS, LASER_HOLD_MS, arrowHead, fitStroke, laserOpacity, polyline, pruneLaser, simplify } from "../src/board/geometry";

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
  it("fades from the tail", () => {
    expect(laserOpacity(0, 10)).toBeLessThan(laserOpacity(5, 10));
    expect(laserOpacity(9, 10)).toBe(1);
  });
});
