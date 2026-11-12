// The marker space's scrub (#45): where a press lands in match time, and how far a press on a
// marker travels before it's a drag.
import { describe, expect, it } from "vitest";
import { DRAG_SLOP, scrubTimeAt, slopFor } from "../src/player/scrubDrag";

describe("marker-space scrub", () => {
  it("maps the pointer along the track to whole seconds, clamped to the match", () => {
    expect(scrubTimeAt(100, 100, 400, 240)).toBe(0);
    expect(scrubTimeAt(300, 100, 400, 240)).toBe(120);
    expect(scrubTimeAt(500, 100, 400, 240)).toBe(240);
    expect(scrubTimeAt(101, 100, 400, 240)).toBe(1);
    expect(scrubTimeAt(20, 100, 400, 240)).toBe(0);
    expect(scrubTimeAt(900, 100, 400, 240)).toBe(240);
    expect(scrubTimeAt(300, 100, 0, 240)).toBe(0);
    expect(scrubTimeAt(300, 100, 400, 0)).toBe(0);
  });

  it("a finger gets more slop than a mouse; an unknown pointer a mouse's", () => {
    expect(slopFor("mouse")).toBe(DRAG_SLOP.mouse);
    expect(slopFor("touch")).toBeGreaterThan(slopFor("mouse"));
    expect(slopFor("pen")).toBe(DRAG_SLOP.pen);
    expect(slopFor("")).toBe(DRAG_SLOP.mouse);
  });
});
