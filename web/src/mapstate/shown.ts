// What the viewer's choices make of a frame's facts (map-state spec §2 D3, §4.5): derived when
// drawing, never stored. Pure.
//
// Sight is Player's Vision logic in both producers: in one team's view, an enemy out of that
// team's sight is a ghost where it was last seen (with Show last seen location) or not drawn.
// The one difference in a scene: it is drawn faded where it stands, never gone, so it can still
// be picked up and edited (D3), and only that, with no last-seen ghost even when Show last seen
// location is on (operator, 2026-11-14). A scene that holds no sight data keeps its legacy
// meaning: a hero marked out of sight is faded for every viewer (D5).

import type { MatchPreview } from "../match/preview";
import type { Vision } from "../player/vision";
import type { Shown } from "./frame";
import type { Feature, HeroState } from "./state";

type Pos = { x: number; y: number };

/** How a hero's token is drawn under the viewer's Vision. */
export type HeroDraw =
  /** As it is. */
  | { as: "seen" }
  /** Player: dim, where its enemies last saw it, that many seconds ago. */
  | { as: "ghost"; at: Pos; ago: number }
  /** Player: not drawn. */
  | { as: "hidden" }
  /** A scene: dim where it stands, and nothing where it was last seen. */
  | { as: "faded" };

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
  if (!sight) return stored && !h.inSight ? { as: "faded" } : { as: "seen" };
  if (viewer.vision === "all" || h.team === viewer.vision || h.inSight) return { as: "seen" };
  if (stored) return { as: "faded" };
  const ghost = viewer.lastSeen ? h.lastSeen : null;
  return ghost ? { as: "ghost", ...ghost } : { as: "hidden" };
}

/** A hero as Player draws it: where it is or its ghost (`pos` null: not drawn), and what shows on
 * its token. */
export type PlayerHero = NonNullable<ReturnType<MatchPreview["players"]["get"]>>;

/**
 * A hero of Player's frame under the viewer's choices, from its state and its `heroDraw`: what
 * `previewAt` gives its slot (the frame's definition). Only a living hero in sight shows live
 * status (movement, CC): never a ghost, which would give away what its enemies can't see.
 * `undefined`: the frame has no hero in the slot.
 */
export function playerHero(h: HeroState, draw: HeroDraw, shown: Shown, has: (f: Feature) => boolean): PlayerHero | undefined {
  if (!h.present()) return undefined;
  const base = { hero: h.hero() ?? 0, name: shown.names ? h.name() : null, pos: h.pos(), respawn: h.respawn() };
  if (draw.as === "ghost") return { ...base, pos: draw.at, health: null, ghost: draw.ago };
  if (draw.as !== "seen") return { ...base, pos: null, health: null, ghost: null, unseen: true };
  const live = !!base.pos;
  return {
    ...base,
    health: shown.health && has("health") ? h.health() : null,
    ...(shown.movement && live ? { height: h.height(), zipline: h.zipline() } : {}),
    ...(shown.cc && live ? { cc: h.cc() } : {}),
  };
}
