import { describe, expect, it } from "vitest";
import { SIDES, bubble, cardBox, wrap } from "../src/board/commentLayout";

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
  // Pinned before comments had sides (feedback #59): a comment with no side is placed exactly
  // as every comment was.
  it("with no side, sit exactly where every comment sat before sides", () => {
    const at = (text: string, x: number, y: number, s: number, vis = FIT) => cardBox(text, { x, y }, s, vis);
    expect(at("Hi", 500, 500, 2)).toEqual({ lines: ["Hi"], x: 528, y: 410, w: 96, h: 62 });
    expect(at("Right edge of the map", 990, 500, 2)).toEqual({ lines: ["Right edge of the map"], x: 632, y: 410, w: 330, h: 62 });
    expect(at("Top left", 5, 5, 2)).toEqual({ lines: ["Top left"], x: 33, y: 8, w: 148, h: 62 });
    const long = at("Smoke the bridge, then rotate east through the vault and hold the walker until 9:30", 20, 500, 2.2);
    expect(long.lines).toEqual(["Smoke the bridge, then rotate", "east through the vault and hold", "the walker until 9:30"]);
    expect([long.x, long.y, long.w, long.h]).toEqual([50.800000000000004, 326.2, 517, 143]);
    expect(at("Bottom", 500, 995, 1.5)).toEqual({ lines: ["Bottom"], x: 521, y: 927.5, w: 90, h: 46.5 });
    expect(at("Zoomed in", 450, 420, 0.5, { x: 400, y: 400, w: 250 })).toEqual({ lines: ["Zoomed in"], x: 457, y: 402, w: 40.5, h: 15.5 });
  });
  it("on a side (feedback #59): below, left or right of the spot, the same size", () => {
    const at = (side: "Above" | "Below" | "Left" | "Right", x = 500, y = 500) => cardBox("Hi", { x, y }, 2, FIT, side);
    const above = at("Above");
    expect(above).toEqual(cardBox("Hi", { x: 500, y: 500 }, 2, FIT));
    const below = at("Below");
    expect([below.x, below.y, below.w, below.h]).toEqual([above.x, 500 + 28, above.w, above.h]);
    const left = at("Left");
    expect([left.x + left.w, left.y + left.h / 2]).toEqual([500 - 28, 500]);
    const right = at("Right");
    expect([right.x, right.y + right.h / 2]).toEqual([500 + 28, 500]);
    // At the edges: to the other side rather than off the map, then clamped.
    const pushed = at("Left", 30);
    expect(pushed.x).toBe(30 + 28);
    const pushedBack = at("Right", 990);
    expect(pushedBack.x + pushedBack.w).toBe(990 - 28);
    const low = at("Below", 500, 990);
    expect(low.y + low.h).toBeLessThanOrEqual(1000);
    for (const side of SIDES) {
      const b = at(side, 3, 997);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(1000);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h).toBeLessThanOrEqual(1000);
    }
  });
  it("a bubble's tail on its spot, its body on its side; above is the bubble from before sides", () => {
    expect(bubble()).toEqual({ body: "M0 0 L-4 -8 H-11 A5 5 0 0 1 -16 -13 V-25 A5 5 0 0 1 -11 -30 H11 A5 5 0 0 1 16 -25 V-13 A5 5 0 0 1 11 -8 H4 Z", dots: "M-7 -19h0.01M0 -19h0.01M7 -19h0.01" });
    expect(bubble("Above")).toEqual(bubble());
    expect(bubble("Below")).toEqual({ ...bubble(), transform: "scale(1 -1)" });
    expect(bubble("Left").transform).toBeUndefined();
    expect(bubble("Right")).toEqual({ ...bubble("Left"), transform: "scale(-1 1)" });
    // Every corner of the left bubble's body is left of the spot; it starts and ends on it.
    const xs = [...bubble("Left").body.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)(?= [A-Z]|$| Z)/g)].map((m) => Number(m[1]));
    expect(bubble("Left").body.startsWith("M0 0 ")).toBe(true);
    expect(Math.max(...xs.slice(1))).toBeLessThan(0);
    expect(SIDES).toEqual(["Above", "Below", "Left", "Right"]);
  });
});
