// Vision in Player (spec §6b "Vision"): what one team could see of the other's heroes, from the
// replay's `seen` intervals (timeline format 4; docs/research/replay-vision.md). Pure.

import { type Timeline, type TimelinePlayer, positionAt } from "../match/timeline";

/** Whose view the map draws: every hero (as before), or one team's. */
export type Vision = "all" | "amber" | "sapphire";
export const VISIONS: readonly Vision[] = ["all", "amber", "sapphire"];

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
