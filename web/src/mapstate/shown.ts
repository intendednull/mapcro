// What the viewer's choices make of a frame's facts (map-state spec §2 D3, §4.5): derived when
// drawing, never stored. Pure.
//
// Sight is Player's Vision logic in both producers: in one team's view, an enemy out of that
// team's sight is a ghost where it was last seen (with Show last seen location) or not drawn.
// The one difference in a scene: it is drawn faded where it stands, never gone, so it can still
// be picked up and edited (D3). A scene that holds no sight data keeps its legacy meaning: a hero
// marked out of sight is faded for every viewer (D5).

import type { Vision } from "../player/vision";

type Pos = { x: number; y: number };

/** How a hero's token is drawn under the viewer's Vision. */
export type HeroDraw =
  /** As it is. */
  | { as: "seen" }
  /** Player: dim, where its enemies last saw it, that many seconds ago. */
  | { as: "ghost"; at: Pos; ago: number }
  /** Player: not drawn. */
  | { as: "hidden" }
  /** A scene: dim where it stands; `ghost`: where it was last seen, when that is shown too. */
  | { as: "faded"; ghost: { at: Pos; ago: number } | null };

/** The viewer's Vision choices. */
export interface Viewer {
  vision: Vision;
  lastSeen: boolean;
}

/** The hero's facts the rule reads (`HeroState`'s, read). */
export interface HeroSight {
  team: "amber" | "sapphire";
  inSight: boolean;
  lastSeen: { at: Pos; ago: number } | null;
}

/**
 * @param sight whether the frame holds each team's sight (`has("sight")`)
 * @param stored a scene's frame (drawn to be edited), not Player's
 */
export function heroDraw(h: HeroSight, viewer: Viewer, sight: boolean, stored: boolean): HeroDraw {
  if (!sight) return stored && !h.inSight ? { as: "faded", ghost: null } : { as: "seen" };
  if (viewer.vision === "all" || h.team === viewer.vision || h.inSight) return { as: "seen" };
  const ghost = viewer.lastSeen ? h.lastSeen : null;
  if (stored) return { as: "faded", ghost };
  return ghost ? { as: "ghost", ...ghost } : { as: "hidden" };
}
