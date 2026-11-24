// What the viewer's choices make of a frame's facts (map-state spec §2 D3, §4.5): derived when
// drawing, never stored. Pure.
//
// Sight is Player's Vision logic in both producers: in one team's view, an enemy out of that
// team's sight is a ghost where it was last seen (with Show last seen location) or not drawn.
// The one difference in a scene: it is drawn faded where it stands, never gone, so it can still
// be picked up and edited (D3), and only that, with no last-seen ghost even when Show last seen
// location is on (operator, 2026-11-14). A scene that holds no sight data keeps its legacy
// meaning: a hero marked out of sight is faded for every viewer (D5).

import { type DoorNow, type UrnNow, slotKey } from "../match/timeline";
import type { CrowdControl } from "../player/cc";
import type { Vision } from "../player/vision";
import type { Shown } from "./frame";
import type { Death, HeroState, MapState } from "./state";

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
 * its token. `ghost`: in one team's Vision, an enemy out of its sight, drawn dim at `pos`, where
 * it was last seen, this many seconds ago. `unseen`: in one team's Vision, not drawn because it's
 * out of that team's sight (not dead, say): its going and coming fade. */
export interface PlayerHero {
  hero: number;
  name?: string | null;
  pos: { x: number; y: number } | null;
  health?: number | null;
  respawn?: number | null;
  ghost?: number | null;
  unseen?: boolean;
  cc?: CrowdControl | undefined;
  height?: number | undefined;
  zipline?: boolean;
}

/**
 * A hero of Player's frame under the viewer's choices, from its state and its `heroDraw`: what
 * `previewAt` gives its slot (the frame's definition). Only a living hero in sight shows live
 * status (movement, CC): never a ghost, which would give away what its enemies can't see.
 * `undefined`: the frame has no hero in the slot.
 */
export function playerHero(h: HeroState, draw: HeroDraw, shown: Shown): PlayerHero | undefined {
  if (!h.present()) return undefined;
  const base = { hero: h.hero() ?? 0, name: shown.names ? h.name() : null, pos: h.pos(), respawn: h.respawn() };
  if (draw.as === "ghost") return { ...base, pos: draw.at, health: null, ghost: draw.ago };
  if (draw.as !== "seen") return { ...base, pos: null, health: null, ghost: null, unseen: true };
  const live = !!base.pos;
  return {
    ...base,
    // `null` where the frame holds none (the metadata tier).
    health: shown.health ? h.health() : null,
    ...(shown.movement && live ? { height: h.height(), zipline: h.zipline() } : {}),
    ...(shown.cc && live ? { cc: h.cc() } : {}),
  };
}

/** A scene hero's health arc value (plan §5 R2, Q3): shown for a living, visible hero when
 * Health is on and the scene captured health (`h.health() !== null`). */
export const sceneTokenHealth = (h: Pick<HeroState, "health">, alive: boolean, visible: boolean, shown: Pick<Shown, "health">): number | null =>
  shown.health && alive && visible ? h.health() : null;

/** The team whose sight the frame is drawn under: none for All, or a frame without sight data. */
const sightOf = (ms: MapState, vision: Vision) => (vision !== "all" && ms.has("sight") ? vision : null);

/** Where the viewer's frame draws the hero in slot `key`, in Player: where it is, or its ghost;
 * `undefined` when it isn't drawn. */
export function playerPlace(ms: MapState, key: string, shown: Shown): Pos | undefined {
  const h = ms.hero(key);
  const team = key.startsWith("amber") ? "amber" : "sapphire";
  const draw = heroDraw({ team, inSight: h.inSight(), lastSeen: h.lastSeen() }, shown, ms.has("sight"), false);
  return playerHero(h, draw, shown)?.pos ?? undefined;
}

/** The urn as the viewer may see it. In one team's view, an urn carried by an enemy out of its
 * sight isn't drawn: where it is would give the carrier away (operator 2026-11-09), ghost or
 * undrawn alike, so the urn never follows a ghost. `at: null` draws nothing and can't be hovered. */
export function shownUrn(ms: MapState, vision: Vision): (UrnNow & { unseen?: boolean }) | undefined {
  const u = ms.scene().urn();
  const view = sightOf(ms, vision);
  if (u?.state !== "carried" || !view || !u.team || u.slot == null || u.team === view) return u;
  return ms.hero(slotKey(u.team, u.slot)).inSight() ? u : { ...u, at: null, unseen: true };
}

/** The deaths the viewer's frame shows as skulls: a team always sees its own heroes die, an
 * enemy's death only if it saw it. */
export function shownDeaths(ms: MapState, vision: Vision): Death[] {
  const view = sightOf(ms, vision);
  const deaths = ms.scene().deaths();
  return view ? deaths.filter((d) => d.team === view || d.seen) : deaths;
}

/** A Doorman doorway under the viewer's Vision (docs/specs/doorman-doors-design.md §1.7, §3.2). */
export interface ShownDoor extends DoorNow {
  draw: "seen" | "faded" | "hidden";
}

/** Doorman doorways projected through Vision: `seen` under All, own team, no sight data, or enemy
 * line-of-sight; otherwise `faded` in a Scene (D3) and `hidden` in Player (fed into `visionFade`). */
export function shownDoors(ms: MapState, vision: Vision, stored: boolean): ShownDoor[] {
  const sight = ms.has("sight");
  return ms.scene().doors().map((d) => {
    if (!sight || vision === "all" || d.team === vision || d.inSight) return { ...d, draw: "seen" };
    return { ...d, draw: stored ? "faded" : "hidden" };
  });
}
