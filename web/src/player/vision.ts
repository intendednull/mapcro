// Vision in Player (spec §6b "Vision"): what one team could see of the other's heroes, from the
// replay's `seen` intervals (timeline format 4; docs/research/replay-vision.md). Pure.

import type { PlayerVision } from "../gen/PlayerVision";
import { type Timeline, type TimelinePlayer, positionAt } from "../match/timeline";

/** Whose view the map draws: every hero (as before), or one team's. */
export type Vision = "all" | "amber" | "sapphire";
/** In the order of their keys (feedback #32): 1 Hidden King, 2 Archmother, 3 All, so the teams
 * read as team 1 and team 2. The select lists them so too. */
export const VISIONS: readonly Vision[] = ["amber", "sapphire", "all"];

/** Vision's key: "1", "2", "3", as `VISIONS` orders them. */
export const visionKey = (v: Vision): string => String(VISIONS.indexOf(v) + 1);

/** The Vision a key's `code` picks (the digit row or the numpad), if any. */
export function visionForCode(code: string): Vision | undefined {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return m ? VISIONS[Number(m[1]) - 1] : undefined;
}

/** What a followed presenter's map draws (presence's `playback.vision`), in the Vision control's
 * terms; absent (an older presenter, or none sent): `undefined`, and the follower keeps its own. */
export function visionFromWire(v: PlayerVision | null | undefined): { view: Vision; ghosts: boolean } | undefined {
  if (!v) return undefined;
  return { view: v.team === "Amber" ? "amber" : v.team === "Sapphire" ? "sapphire" : "all", ghosts: v.last_seen === true };
}

export function visionToWire(view: Vision, ghosts: boolean): PlayerVision {
  return { team: view === "amber" ? "Amber" : view === "sapphire" ? "Sapphire" : null, last_seen: ghosts };
}

/** Whether the timeline says when each hero was seen (format 4 on): else only "All" applies. */
export const hasVision = (tl: Timeline): boolean => tl.players.some((p) => (p.seen?.length ?? 0) > 0);

/** An enemy hero at t as its enemies saw it. */
export type SeenAt =
  /** In their sight now: drawn as it is. */
  | { seen: true }
  /** Out of sight: where it was when they last saw it (its true position then), and how many
   * seconds ago that was. */
  | { seen: false; at: { x: number; y: number }; ago: number }
  /** Not seen since it last came into the match (never yet, or not since it last died, when
   * its last-seen spot no longer says anything; or dead when last seen): not drawn. */
  | null;

/** The scan of `seen` for one tenth of a second: in sight (`true`), or the tenth the last
 * sight before it ended (`null`: none yet). It changes only with the tenth (`Math.floor(t * 10)`),
 * so Player asks once a tenth, not once a frame (mapstate/frame.ts). */
export function sightAt(p: Pick<TimelinePlayer, "seen">, ds: number): true | number | null {
  // `[start, end)` tenths, in order.
  let last: number | null = null;
  for (const [a, b] of p.seen ?? []) {
    if (ds < a) break;
    if (ds < b) return true;
    last = b;
  }
  return last;
}

/** `seenAt` from a tenth's `sightAt`: what is left changes with the frame (how long ago). */
export function seenFrom(p: Pick<TimelinePlayer, "x" | "y" | "deaths">, t: number, sight: true | number | null): SeenAt {
  if (sight === true) return { seen: true };
  if (sight === null) return null;
  const when = sight / 10;
  if (p.deaths.some((d) => d > when && d <= t)) return null;
  const at = positionAt(p, when);
  return at ? { seen: false, at, ago: t - when } : null;
}

export function seenAt(p: Pick<TimelinePlayer, "x" | "y" | "deaths" | "seen">, t: number): SeenAt {
  return seenFrom(p, t, sightAt(p, t * 10));
}
