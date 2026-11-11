// The investment ladder as the game's stat panels write it (citadel_tooltip_mod_bonus_display;
// player/StatPanel.tsx). Pure.

import type { Ladder } from "./stats";

/** Souls as the ladder writes them: 800, 1.6K … 28.8K. */
export function soulsLabel(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}K`;
}

/** The ladder row the souls reach (index into the ascending rows), or -1 below the first. */
export function tierReached(ladder: Ladder, souls: number): number {
  let at = -1;
  ladder.forEach(([to], i) => { if (souls >= to) at = i; });
  return at;
}
