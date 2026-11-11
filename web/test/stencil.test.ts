// The map's stencil (feedback #21): its outline meets the discs it is measured as, the drag clamp
// keeps a hero inside it, and a fresh board's heroes stand inside it, token and all.

import { describe, expect, it } from "vitest";
import { STENCIL, inStencil, viewToFrame } from "../src/map/stencil";
import { clampToDisc, worldToView } from "../src/map/transform";
import { TOKEN_R } from "../src/board/Tokens";

/** The points an outline's moves and arcs end on. */
const ends = (d: string) =>
  [...d.matchAll(/[MA]([\d. ]+)/g)].map((m) => {
    const n = m[1]!.trim().split(" ").map(Number);
    return { x: n[n.length - 2]!, y: n[n.length - 1]! };
  });

describe("the stencil", () => {
  it("the outline runs along its discs' edges, and its shape is the art's", () => {
    const pts = ends(STENCIL);
    expect(pts).toHaveLength(5);
    // Every corner is where the big disc meets a bump: inside both by a hair, outside neither.
    for (const q of pts) expect(Math.abs(Math.hypot(q.x - 49.83, q.y - 49.94) - 44.83)).toBeLessThan(0.02);
    // The disc's middle and the bumps' tops are in; the map square's corners and the box's edge
    // beside the bumps are out.
    expect(inStencil({ x: 50, y: 50 })).toBe(true);
    expect(inStencil({ x: 55.34, y: 0.5 })).toBe(true);
    expect(inStencil({ x: 44.32, y: 99.5 })).toBe(true);
    expect(inStencil({ x: 44.32, y: 0.5 })).toBe(false);
    expect(inStencil(viewToFrame({ x: 10, y: 10 }))).toBe(false);
    expect(inStencil(viewToFrame({ x: 990, y: 990 }))).toBe(false);
  });

  it("a dragged hero stays on the disc, so it stays seen and in reach", () => {
    // Past a corner of the map square: pulled back along its way out, to 43/45 of the half-side.
    const c = clampToDisc({ x: 20000, y: -20000 });
    expect(Math.hypot(c.x, c.y)).toBeCloseTo((10752 * 43) / 45, -1);
    expect(c.x).toBe(-c.y);
    expect(inStencil(viewToFrame(worldToView(c, "amber")))).toBe(true);
    // Inside, nothing moves.
    expect(clampToDisc({ x: 1200, y: -3400 })).toEqual({ x: 1200, y: -3400 });
  });

  it("a fresh board's heroes stand inside the stencil, token and all", () => {
    // PlayerState::starting (crates/schema/src/records.rs).
    for (const [x0, y0, dy] of [[-5900, -7100, -900], [3900, 7100, 900]] as const)
      for (let i = 0; i < 6; i++) {
        const w = { x: x0 + (i % 3) * 1000, y: y0 + Math.floor(i / 3) * dy };
        const f = viewToFrame(worldToView(w, "amber"));
        const r = TOKEN_R * 0.09;
        for (const [dx, dyy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]] as const)
          expect(inStencil({ x: f.x + dx, y: f.y + dyy }), `${w.x},${w.y}`).toBe(true);
      }
  });
});
