// Death skulls in Player (spec §6b "Death skulls"): a small skull where a hero died, fading out
// over a couple of match seconds, so a death reads differently from a hero going out of sight.
// Derived from playback time t alone, never fired by playback: a scrub that lands inside the
// window shows it part faded, one elsewhere shows none, and a follower at the presenter's t
// draws the same. Pure.

import { type TimelinePlayer, lastSeen } from "../match/timeline";
import { slotKey } from "../match/save";
import type { Vision } from "./vision";

/** How long a skull shows, in match seconds: ~2.5 s at 1×, ~0.6 s at 4×; scrubbing, a window
 * wide enough to land in. */
export const SKULL_S = 2.5;

/** How long before a death a sighting still counts as the death being seen, in seconds. The
 * `seen` intervals are tenths and may close on the death tick or one before it (crates/replay
 * `Player::seen`), so "in sight at the instant of death" would drop deaths the team watched. */
export const SEEN_GRACE_S = 1;

export interface Skull {
  /** "amber-0"…, the dead hero's slot. */
  slot: string;
  team: "amber" | "sapphire";
  /** Match second of the death. */
  t: number;
  /** World position: where the hero last stood alive at the death (on the summary tier, its
   * path's last point, approximate). */
  at: { x: number; y: number };
  /** 1 at the death, easing to 0 at `SKULL_S` (quadratic: it holds, then goes). */
  opacity: number;
}

/** Whether the hero's enemies saw it die: in their sight at some moment in the second before. */
export function deathSeen(p: Pick<TimelinePlayer, "seen">, death: number): boolean {
  const lo = (death - SEEN_GRACE_S) * 10;
  const hi = death * 10;
  return (p.seen ?? []).some(([a, b]) => a <= hi && b > lo);
}

/**
 * The skulls at playback time t: every death in `[t − SKULL_S, t]`. `view`: the team whose sight
 * the map draws (`null` or "all": every death). A team always sees its own heroes die; an enemy's
 * death only if it saw it (`deathSeen`).
 */
export function skullsAt(players: ReadonlyArray<Pick<TimelinePlayer, "team" | "slot" | "x" | "y" | "deaths" | "seen">>, t: number, view: Vision | null): Skull[] {
  const team = view === "all" ? null : view;
  const out: Skull[] = [];
  for (const p of players)
    for (const d of p.deaths) {
      const age = t - d;
      if (age < 0 || age >= SKULL_S) continue;
      if (team && p.team !== team && !deathSeen(p, d)) continue;
      const at = lastSeen(p, d);
      if (!at) continue;
      out.push({ slot: slotKey(p.team, p.slot), team: p.team, t: d, at, opacity: 1 - (age / SKULL_S) ** 2 });
    }
  return out;
}
