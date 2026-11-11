// Death skulls (spec §6b): which deaths show a skull at playback time t, where, how faded, and
// under whose vision.
import { describe, expect, it } from "vitest";
import { SKULL_S, deathSeen, deathShown, skullsAt } from "../src/player/skulls";

// Walks east 100 a second; dies at 8 (dead 8 and 9), back at 10, dies again at 11.
const xs = [0, 100, 200, 300, 400, 500, 600, 700, null, null, 1000, 1100, null];
const walker = (o: { seen?: Array<[number, number]>; deaths?: number[] } = {}) => ({
  team: "sapphire" as const,
  slot: 2,
  x: xs,
  y: xs.map((x) => (x == null ? null : 50)),
  deaths: o.deaths ?? [8, 11.5],
  seen: o.seen ?? [],
});

describe("death skulls", () => {
  it("shows from the death until SKULL_S after, the window's end excluded", () => {
    const p = [{ ...walker(), x: xs.map((x, i) => i >= 8 ? null : x) }];
    expect(skullsAt(p, 7.99, null)).toEqual([]);
    expect(skullsAt(p, 8, null)).toEqual([{ slot: "sapphire-2", team: "sapphire", t: 8, at: { x: 700, y: 50 }, opacity: 1 }]);
    expect(skullsAt(p, 8 + SKULL_S - 0.01, null)).toHaveLength(1);
    expect(skullsAt(p, 8 + SKULL_S, null)).toEqual([]);
  });
  it("fades with the time since the death: holds, then goes", () => {
    const p = { ...walker(), x: xs.map((x, i) => i >= 8 ? null : x) };
    const op = (t: number) => skullsAt([p], t, null)[0]!.opacity;
    expect(op(8 + SKULL_S / 2)).toBeCloseTo(0.75);
    expect(op(8 + SKULL_S * 0.9)).toBeCloseTo(0.19);
    expect(op(9)).toBeGreaterThan(op(10));
  });
  it("sits where the hero last stood alive, mid-second deaths included", () => {
    expect(skullsAt([walker()], 12, null)[0]).toMatchObject({ t: 11.5, at: { x: 1100, y: 50 } });
  });
  it("a death at the match's first moment or its last shows", () => {
    const p = [{ ...walker({ deaths: [0, 12] }), x: [0, ...xs.slice(1)] }];
    expect(skullsAt(p, 0, null)).toMatchObject([{ t: 0, at: { x: 0, y: 50 } }]);
    expect(skullsAt(p, 12, null)).toMatchObject([{ t: 12, at: { x: 1100, y: 50 } }]);
  });
  it("a hero with no position at its death has no skull", () => {
    expect(skullsAt([{ ...walker({ deaths: [1] }), x: [null, null, null], y: [null, null, null] }], 1, null)).toEqual([]);
  });

  it("removes the fallen portrait at a quick respawn, including old timelines without timers", () => {
    expect(skullsAt([walker()], 9.99, null)).toHaveLength(1);
    expect(skullsAt([walker()], 10, null)).toEqual([]);
    const p = { ...walker(), respawn: [[8, 8.75]] as Array<[number, number]> };
    expect(skullsAt([p], 8.74, null)).toHaveLength(1);
    expect(skullsAt([p], 8.75, null)).toEqual([]);
  });
  it("never draws two fallen portraits for a hero that dies again inside the window", () => {
    const p = { ...walker({ deaths: [8, 8.5] }), x: xs.map((x, i) => i >= 8 ? null : x) };
    expect(skullsAt([p], 8.6, null)).toMatchObject([{ t: 8.5 }]);
    expect(skullsAt([p], 8.6, null)).toHaveLength(1);
  });
  it("seeking back recreates precisely the same death frame", () => {
    const p = [walker()];
    const frame = skullsAt(p, 8.75, "sapphire");
    expect(skullsAt(p, 5, "sapphire")).toEqual([]);
    expect(skullsAt(p, 30, "sapphire")).toEqual([]);
    expect(skullsAt(p, 8.75, "sapphire")).toEqual(frame);
  });

  describe("under one team's vision", () => {
    it("its own heroes' deaths always show", () => {
      expect(skullsAt([walker()], 8.5, "sapphire")).toHaveLength(1);
    });
    it("an enemy's death shows only if it was in sight within the second before", () => {
      // In sight until 7.0: a second before the death at 8, just in.
      expect(skullsAt([walker({ seen: [[30, 71]] })], 8.5, "amber")).toHaveLength(1);
      expect(skullsAt([walker({ seen: [[30, 70]] })], 8.5, "amber")).toEqual([]);
      // Never seen; seen long before; seen only after.
      expect(skullsAt([walker()], 8.5, "amber")).toEqual([]);
      expect(skullsAt([walker({ seen: [[0, 20]] })], 8.5, "amber")).toEqual([]);
      expect(skullsAt([walker({ seen: [[81, 100]] })], 8.5, "amber")).toEqual([]);
    });
    it("a sighting that starts on the death tick counts", () => {
      expect(deathSeen({ seen: [[80, 81]] }, 8)).toBe(true);
      expect(deathSeen({ seen: [[79, 80]] }, 8)).toBe(true);
    });
    it("All shows every death, seen or not", () => {
      expect(skullsAt([walker()], 8.5, null)).toHaveLength(1);
      expect(skullsAt([walker()], 8.5, "all")).toHaveLength(1);
    });
  });
});

it("shows a death to every view, its own team's, and an enemy's only if it saw it", () => {
  const p = { team: "sapphire" as const, seen: [[50, 79]] as Array<[number, number]> };
  expect(deathShown(p, 8, null)).toBe(true);
  expect(deathShown(p, 8, "all")).toBe(true);
  expect(deathShown(p, 8, "sapphire")).toBe(true);
  expect(deathShown(p, 8, "amber")).toBe(true);
  expect(deathShown(p, 20, "amber")).toBe(false);
});
