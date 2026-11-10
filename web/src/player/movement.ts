import type { TimelinePlayer } from "../match/timeline";

/** Recorded movement only; never infer height from screen position. */
export function movementAt(p: Pick<TimelinePlayer, "height" | "zipline">, t: number) {
  let height: number | undefined;
  for (const [at, value] of p.height ?? []) { if (at > t) break; height = value; }
  return { height, zipline: p.zipline?.some(([from, to]) => from <= t && t < to) ?? false };
}
