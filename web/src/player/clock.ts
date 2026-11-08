// Player's playback clock (spec §6b): a position, whether it runs, and how fast, sampled at a
// wall-clock moment. Followers adopt a presenter's and correct drift. Pure.

export const SPEEDS = [0.5, 1, 2, 4, 8] as const;

export interface Playback {
  /** Match seconds at `at`. */
  t: number;
  playing: boolean;
  speed: number;
  /** Wall clock (ms, `performance.now()` or similar) when `t` held. */
  at: number;
}

export const clampT = (t: number, duration: number) => Math.max(0, Math.min(duration, t));

/** Where playback is at wall time `now`; it stops at the end. */
export function tAt(p: Playback, now: number, duration: number): number {
  return p.playing ? clampT(p.t + ((now - p.at) / 1000) * p.speed, duration) : clampT(p.t, duration);
}

/** The same playback, re-sampled at `now` (before changing speed or pausing). */
export const rebase = (p: Playback, now: number, duration: number): Playback => ({ ...p, t: tAt(p, now, duration), at: now });

/** A follower's clock against a presenter's: adopt their state; keep ours if within `slack` s. */
export function follow(mine: Playback, theirs: { t: number; playing: boolean; speed: number }, now: number, duration: number, slack = 0.75): Playback {
  const here = tAt(mine, now, duration);
  const same = mine.playing === theirs.playing && mine.speed === theirs.speed;
  if (same && Math.abs(here - theirs.t) <= slack) return mine;
  return { t: clampT(theirs.t, duration), playing: theirs.playing, speed: theirs.speed, at: now };
}
