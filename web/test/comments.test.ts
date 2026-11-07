import { describe, expect, it } from "vitest";
import { cardBox, wrap } from "../src/board/commentLayout";

const FIT = { x: 0, y: 0, w: 1000 };
describe("comment cards", () => {
  it("wrap long text to a readable width, cutting only words longer than a line", () => {
    expect(wrap("Smoke the bridge, then rotate east through the vault", 25)).toEqual(["Smoke the bridge, then", "rotate east through the", "vault"]);
    expect(wrap("x".repeat(30), 12)).toEqual(["xxxxxxxxxxxx", "xxxxxxxxxxxx", "xxxxxx"]);
    expect(wrap("", 10)).toEqual([""]);
  });
  it("sit up and right of the spot, at screen size whatever the zoom", () => {
    const b = cardBox("Hi", { x: 500, y: 500 }, 2, FIT); // 2 view units per screen px
    expect(b.w).toBe(48 * 2);
    expect(b.x).toBe(500 + 14 * 2);
    expect(b.y + b.h).toBe(500 - 14 * 2);
    const zoomed = cardBox("Hi", { x: 500, y: 500 }, 0.5, { x: 400, y: 400, w: 250 });
    expect(zoomed.w).toBe(24);
  });
  it("never leave the visible map: flip left at the right edge, clamp at the others", () => {
    const right = cardBox("Right edge of the map", { x: 990, y: 500 }, 2, FIT);
    expect(right.x + right.w).toBeLessThanOrEqual(1000);
    expect(right.x).toBeLessThan(990);
    const corner = cardBox("Top left", { x: 5, y: 5 }, 2, FIT);
    expect(corner.x).toBeGreaterThanOrEqual(0);
    expect(corner.y).toBeGreaterThanOrEqual(0);
    const long = cardBox("Smoke the bridge, then rotate east through the vault and hold the walker until 9:30", { x: 20, y: 500 }, 2.2, FIT);
    expect(long.lines.length).toBeGreaterThan(1);
    expect(long.x).toBeGreaterThanOrEqual(0);
    expect(long.x + long.w).toBeLessThanOrEqual(1000);
  });
});
