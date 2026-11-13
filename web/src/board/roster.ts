// A new board starts with twelve different random playable heroes, one per slot (operator,
// 2026-11-07), in one transaction. With no pack (no hero list) the slots stay empty.

import type { Op } from "../gen/Op";
import type { Hero } from "../map/pack";
import { rosterTeamShort } from "../map/model";
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

/**
 * The match's in-game name for a slot in a scene (spec §6b "Names"): from the open match, unless
 * the scene was saved from another match. `named` is the Player host's `playerName` (absent with
 * Names off or no name in the timeline); never an account id.
 */
export function sceneMatchName(
  open: { match_id: number } | undefined,
  source: { match_id: number } | null | undefined,
  named: (team: string, slot: number) => string | undefined,
  team: string,
  slot: number,
): string | undefined {
  if (!open || (source && source.match_id !== open.match_id)) return undefined;
  return named(team.toLowerCase(), slot) || undefined;
}

/** A slot's name in a scene: the one typed into the board's slot wins over the match's. */
export const slotName = (typed: string, match: string | undefined): string | undefined => typed.trim() || match || undefined;

/**
 * A slot's placeholder player name, where there is no name to show: Names off (spec §6b), a match
 * without one, or a board with none typed in. The game's short patron and the slot's number
 * ("King 1", "Archmother 3"). One function, so every label that needs a stand-in agrees.
 */
export const slotPlaceholder = (team: string, slot: number): string => `${rosterTeamShort(team)} ${slot + 1}`;
