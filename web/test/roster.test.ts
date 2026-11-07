import { describe, expect, it } from "vitest";
import { randomRosterOps } from "../src/board/roster";
import type { Slot } from "../src/board/state";
import type { Hero } from "../src/map/pack";

const slots: Slot[] = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, slot: { team: i < 6 ? "Amber" : "Sapphire", slot: i % 6, name: "", hero: null } }));
const heroes = (n: number, playable = true): Hero[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `H${i}`, portrait: undefined, topbar: undefined, playable }));

describe("random roster", () => {
  it("gives twelve slots twelve different playable heroes in one transaction", () => {
    const ops = randomRosterOps(slots, [...heroes(30), ...heroes(5, false).map((h) => ({ ...h, id: h.id + 100 }))]);
    expect(ops).toHaveLength(12);
    const ids = ops.map((o) => ("Set" in o && "RosterHero" in o.Set.value ? o.Set.value.RosterHero : -1));
    expect(new Set(ids).size).toBe(12);
    expect(ids.every((id) => id! >= 1 && id! <= 30)).toBe(true);
    expect(ops.map((o) => ("Set" in o ? o.Set.id : "")).sort()).toEqual(slots.map((s) => s.id).sort());
  });
  it("is random: two rolls differ", () => {
    const pick = () => JSON.stringify(randomRosterOps(slots, heroes(40)));
    expect(new Set([pick(), pick(), pick()]).size).toBeGreaterThan(1);
  });
  it("leaves the slots empty without a pack, with too few heroes, or once heroes are picked", () => {
    expect(randomRosterOps(slots, [])).toEqual([]);
    expect(randomRosterOps(slots, heroes(11))).toEqual([]);
    const picked = slots.map((s, i) => (i === 3 ? { ...s, slot: { ...s.slot, hero: 7 } } : s));
    expect(randomRosterOps(picked, heroes(40))).toEqual([]);
  });
});

import { matchHeroes } from "../src/board/roster";
describe("hero search", () => {
  const hs = ["Haze", "Lady Geist", "Mo & Krill", "Grey Talon"].map((name, i) => ({ id: i, name, portrait: undefined, topbar: undefined, playable: true }));
  it("filters by name, case-insensitively, anywhere in the name", () => {
    expect(matchHeroes(hs, "ge").map((h) => h.name)).toEqual(["Lady Geist"]);
    expect(matchHeroes(hs, "KRILL").map((h) => h.name)).toEqual(["Mo & Krill"]);
    expect(matchHeroes(hs, " ")).toHaveLength(4);
  });
});
