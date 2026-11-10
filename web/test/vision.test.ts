// Vision (spec §6b): an enemy hero as the other team saw it, from the timeline's `seen` intervals.
import { describe, expect, it } from "vitest";
import type { Timeline } from "../src/match/timeline";
import { VISIONS, hasVision, seenAt, visionFromWire, visionToWire } from "../src/player/vision";

// Walks east 100 a second; dies at 8 (dead 8 and 9), back at 10. Seen 1.0–3.5 s and 6.0–7.0 s.
const xs = [0, 100, 200, 300, 400, 500, 600, 700, null, null, 1000, 1100];
const hero = { x: xs, y: xs.map((x) => (x == null ? null : 0)), deaths: [8], seen: [[10, 35], [60, 70]] as Array<[number, number]> };

describe("vision", () => {
  it("is never seen before its first sighting", () => {
    expect(seenAt(hero, 0)).toBeNull();
    expect(seenAt(hero, 0.99)).toBeNull();
  });
  it("is seen inside an interval, its end excluded", () => {
    expect(seenAt(hero, 1)).toEqual({ seen: true });
    expect(seenAt(hero, 3.49)).toEqual({ seen: true });
    expect(seenAt(hero, 3.5)).not.toEqual({ seen: true });
  });
  it("out of sight, stays where it was last seen and says how long ago", () => {
    expect(seenAt(hero, 3.5)).toEqual({ seen: false, at: { x: 350, y: 0 }, ago: 0 });
    expect(seenAt(hero, 5.5)).toEqual({ seen: false, at: { x: 350, y: 0 }, ago: 2 });
    expect(seenAt(hero, 7.5)).toEqual({ seen: false, at: { x: 700, y: 0 }, ago: 0.5 });
  });
  it("a death since it was last seen drops it until it is seen again", () => {
    expect(seenAt(hero, 8)).toBeNull();
    expect(seenAt(hero, 11)).toBeNull();
  });
  it("without seen data, nothing says so", () => {
    const { seen: _, ...old } = hero;
    expect(seenAt(old, 2)).toBeNull();
    const tl = { players: [{ ...hero, seen: [] }] } as unknown as Timeline;
    expect(hasVision(tl)).toBe(false);
    expect(hasVision({ players: [hero] } as unknown as Timeline)).toBe(true);
  });
});

describe("vision in presence (following, spec §6b)", () => {
  it("round-trips every view and both ghost settings", () => {
    for (const view of VISIONS) for (const ghosts of [false, true]) expect(visionFromWire(visionToWire(view, ghosts))).toEqual({ view, ghosts });
  });
  it("says All as no team, and names the team otherwise", () => {
    expect(visionToWire("all", false)).toEqual({ team: null, last_seen: false });
    expect(visionToWire("amber", true)).toEqual({ team: "Amber", last_seen: true });
    expect(visionToWire("sapphire", false)).toEqual({ team: "Sapphire", last_seen: false });
  });
  it("an older presenter sends none: the follower keeps its own", () => {
    expect(visionFromWire(undefined)).toBeUndefined();
    expect(visionFromWire(null)).toBeUndefined();
  });
});
