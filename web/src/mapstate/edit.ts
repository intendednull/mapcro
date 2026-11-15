// Edits of a scene's stored state (map-state spec §5): each writes only the scene.

import type { More } from "../gen/More";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import { BUILD_KEYS } from "./build";

/**
 * A pick of `hero` for a slot (`null`: no hero), from the hero picker.
 *
 * In a scene that holds its own heroes (D2, `own`): the scene's record alone. Its `hero` is
 * set and, in the same transaction, the stored build is dropped: it was the old hero's, and a
 * slot whose hero changed has no build (spec §5). One undo step brings both back. The same
 * hero again writes nothing, and "no hero" is not a pick there (the row can't say it; a scene's
 * hero cleared would fall back to the roster's).
 *
 * In any other scene (made by hand, or saved before scenes held their heroes): the board's
 * roster, as it always was.
 *
 * `slot`: the roster slot's record. `player`: the slot's hero record in the scene.
 */
export function pickHeroOps(own: boolean, slot: RecordId, player: { id: RecordId; more: More | undefined } | undefined, hero: number | null): Op[] {
  if (!own || !player) return [{ Set: { id: slot, value: { RosterHero: hero } } }];
  if (hero == null || player.more?.hero === hero) return [];
  const dropped = BUILD_KEYS.filter((k) => player.more?.[k] !== undefined);
  return [
    { Set: { id: player.id, value: { More: { key: "hero", value: hero } } } },
    ...dropped.map((key): Op => ({ Set: { id: player.id, value: { More: { key, value: null } } } })),
  ];
}
