import { describe, expect, it } from "vitest";
import { Glide } from "../src/board/smooth";

describe("remote motion glides", () => {
  it("snaps on first sight, then eases linearly to each new target", () => {
    const g = new Glide(100);
    expect(g.set({ x: 0, y: 0 }, 0)).toBe(false);
    expect(g.at(0)).toEqual({ x: 0, y: 0 });
    expect(g.set({ x: 100, y: 0 }, 1000)).toBe(true);
    expect(g.frame(1000)).toEqual({ x: 0, y: 0 });
    expect(g.at(1050)).toEqual({ x: 50, y: 0 });
    expect(g.done(1050)).toBe(false);
    expect(g.at(1100)).toEqual({ x: 100, y: 0 });
    expect(g.done(1100)).toBe(true);
  });

  it("a target mid-glide starts from where it is shown, not from the last target", () => {
    const g = new Glide(100);
    g.set({ x: 0, y: 0 }, 0);
    g.set({ x: 100, y: 0 }, 0);
    g.frame(0);
    g.set({ x: 100, y: 100 }, 50); // shown at (50, 0) then
    expect(g.frame(50)).toEqual({ x: 50, y: 0 });
    expect(g.at(100)).toEqual({ x: 75, y: 50 });
    expect(g.at(150)).toEqual({ x: 100, y: 100 });
  });

  it("the ease starts at the first frame drawn, so a stalled page still shows it", () => {
    const g = new Glide(100);
    g.set({ x: 0, y: 0 }, 0);
    g.set({ x: 100, y: 0 }, 1000);
    // No frame for 300 ms: still shown where it was, with motion to draw.
    expect(g.at(1300)).toEqual({ x: 0, y: 0 });
    expect(g.done(1300)).toBe(false);
    expect(g.frame(1300)).toEqual({ x: 0, y: 0 });
    expect(g.frame(1350)).toEqual({ x: 50, y: 0 });
    expect(g.frame(1400)).toEqual({ x: 100, y: 0 });
    expect(g.done(1400)).toBe(true);
    // A new target before the first frame glides from where it is shown.
    g.set({ x: 0, y: 0 }, 2000);
    g.set({ x: 0, y: 100 }, 2010);
    expect(g.frame(2050)).toEqual({ x: 100, y: 0 });
    expect(g.frame(2100)).toEqual({ x: 50, y: 50 });
  });

  it("gone is gone at once, and a return snaps instead of gliding from the old place", () => {
    const g = new Glide(100);
    g.set({ x: 0, y: 0 }, 0);
    g.set({ x: 100, y: 0 }, 0);
    expect(g.set(undefined, 20)).toBe(false);
    expect(g.at(20)).toBeUndefined();
    expect(g.set({ x: 500, y: 500 }, 30)).toBe(false);
    expect(g.at(30)).toEqual({ x: 500, y: 500 });
  });

  it("the same target again is no motion", () => {
    const g = new Glide(100);
    g.set({ x: 3, y: 4 }, 0);
    expect(g.set({ x: 3, y: 4 }, 10)).toBe(false);
    expect(g.at(10)).toEqual({ x: 3, y: 4 });
  });
});
