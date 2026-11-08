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
  // A clock read before the playback was stamped would run it backwards: never (QA, item 6).
  return p.playing ? clampT(p.t + (Math.max(0, now - p.at) / 1000) * p.speed, duration) : clampT(p.t, duration);
}

/** The same playback, re-sampled at `now` (before changing speed or pausing). */
export const rebase = (p: Playback, now: number, duration: number): Playback => ({ ...p, t: tAt(p, now, duration), at: now });

/**
 * A follower's clock against a presenter's (spec §6b). `theirs.t` is where the presenter was when
 * it arrived (`at`), so it's carried forward to `now`. A pause, a speed change or a jump is
 * adopted at once; while both play at the same speed, drift within `slack` seconds of match time
 * per unit of speed is left alone, so small network jitter doesn't make the follower stutter.
 */
export function follow(
  mine: Playback,
  theirs: { t: number; playing: boolean; speed: number; at: number },
  now: number,
  duration: number,
  slack = 0.75,
): Playback {
  const there = tAt({ t: theirs.t, playing: theirs.playing, speed: theirs.speed, at: theirs.at }, now, duration);
  const here = tAt(mine, now, duration);
  const same = mine.playing === theirs.playing && mine.speed === theirs.speed;
  if (same && Math.abs(here - there) <= slack * Math.max(1, theirs.speed)) return mine;
  // At the end the presenter has stopped: so does the follower, at the end.
  const playing = theirs.playing && there < duration;
  return { t: clampT(there, duration), playing, speed: theirs.speed, at: now };
}
