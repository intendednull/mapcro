// Player's playback clock and its follower drift correction.
import { describe, expect, it } from "vitest";
import { follow, rebase, tAt } from "../src/player/clock";

describe("playback clock", () => {
  it("runs at its speed, stops at the end, and holds when paused", () => {
    const p = { t: 10, playing: true, speed: 2, at: 1000 };
    expect(tAt(p, 2000, 100)).toBe(12);
    expect(tAt(p, 100_000, 100)).toBe(100);
    expect(tAt({ ...p, playing: false }, 9000, 100)).toBe(10);
    expect(rebase(p, 3000, 100)).toEqual({ t: 14, playing: true, speed: 2, at: 3000 });
  });

  it("a follower keeps its clock within the slack and snaps beyond it", () => {
    const mine = { t: 10, playing: true, speed: 1, at: 0 };
    expect(follow(mine, { t: 10.5, playing: true, speed: 1, at: 0 }, 0, 100)).toBe(mine);
    expect(follow(mine, { t: 12, playing: true, speed: 1, at: 0 }, 0, 100)).toEqual({ t: 12, playing: true, speed: 1, at: 0 });
    // A pause or a new speed is adopted at once, at the presenter's position.
    expect(follow(mine, { t: 10.2, playing: false, speed: 1, at: 500 }, 500, 100)).toEqual({ t: 10.2, playing: false, speed: 1, at: 500 });
    expect(follow(mine, { t: 10, playing: true, speed: 4, at: 0 }, 0, 100).speed).toBe(4);
  });

  it("carries the presenter's time forward from when it arrived, with a slack scaled by speed", () => {
    // Received 2 s ago at t 10, playing at 8x: the presenter is at 26 now, and so are we.
    const mine = { t: 25.5, playing: true, speed: 8, at: 2000 };
    expect(follow(mine, { t: 10, playing: true, speed: 8, at: 0 }, 2000, 100)).toBe(mine);
    // A stale value re-read later is still carried forward: no snap back.
    expect(follow({ t: 42, playing: true, speed: 8, at: 4000 }, { t: 10, playing: true, speed: 8, at: 0 }, 4000, 100).t).toBe(42);
  });

  it("stops at the end instead of replaying it", () => {
    const mine = { t: 90, playing: true, speed: 1, at: 0 };
    const p = follow(mine, { t: 99, playing: true, speed: 1, at: 0 }, 5000, 100);
    expect(p).toEqual({ t: 100, playing: false, speed: 1, at: 5000 });
  });
});
