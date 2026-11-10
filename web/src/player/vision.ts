// Vision in Player (spec §6b "Vision"): what one team could see of the other's heroes, from the
// replay's `seen` intervals (timeline format 4; docs/research/replay-vision.md). Pure.

import type { PlayerVision } from "../gen/PlayerVision";
import { type Timeline, type TimelinePlayer, positionAt } from "../match/timeline";

/** Whose view the map draws: every hero (as before), or one team's. */
export type Vision = "all" | "amber" | "sapphire";
export const VISIONS: readonly Vision[] = ["all", "amber", "sapphire"];

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

export function seenAt(p: Pick<TimelinePlayer, "x" | "y" | "deaths" | "seen">, t: number): SeenAt {
  const ds = t * 10;
  // `[start, end)` tenths, in order.
  let last: number | null = null;
  for (const [a, b] of p.seen ?? []) {
    if (ds < a) break;
    if (ds < b) return { seen: true };
    last = b;
  }
  if (last === null) return null;
  const when = last / 10;
  if (p.deaths.some((d) => d > when && d <= t)) return null;
  const at = positionAt(p, when);
  return at ? { seen: false, at, ago: t - when } : null;
}
