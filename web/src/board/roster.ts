// A new board starts with twelve different random playable heroes, one per slot (operator,
// 2026-11-07), in one transaction. With no pack (no hero list) the slots stay empty.

import type { Op } from "../gen/Op";
import type { Hero } from "../map/pack";
import type { Slot } from "./state";

export function randomRosterOps(slots: Slot[], heroes: Hero[], random: () => number = Math.random): Op[] {
  const pool = heroes.filter((h) => h.playable);
  if (slots.length === 0 || pool.length < slots.length || slots.some((s) => s.slot.hero != null)) return [];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return slots.map((s, i) => ({ Set: { id: s.id, value: { RosterHero: pool[i]!.id } } }));
}

/** The flag Landing leaves for the board it just made, so only its creator rolls the roster. */
export const FRESH_BOARD = "mapcro.fresh";

/** The hero picker's search: by name, case-insensitively, anywhere in the name. */
export const matchHeroes = (heroes: Hero[], q: string) => {
  const s = q.trim().toLowerCase();
  return s ? heroes.filter((h) => h.name.toLowerCase().includes(s)) : heroes;
};
