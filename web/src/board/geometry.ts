// Small pure geometry for the board layers: ink simplification, paths, arrowheads, laser fade.

import type { Pt } from "../map/transform";

/** Ramer–Douglas–Peucker: drop points closer than `eps` to the line through their neighbours. */
export function simplify(points: Pt[], eps: number): Pt[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = points[a]!;
    const pb = points[b]!;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    let best = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i]!;
      const d = Math.abs(dy * (p.x - pa.x) - dx * (p.y - pa.y)) / len;
      if (d > best) [best, at] = [d, i];
    }
    if (best > eps && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Simplify until the stroke fits the schema's point cap. */
export function fitStroke(points: Pt[], max: number, eps = 2): Pt[] {
  let out = simplify(points, eps);
  while (out.length > max) out = simplify(out, (eps *= 2));
  return out;
}

const f1 = (v: number) => Math.round(v * 10) / 10;

export function polyline(points: Pt[]): string {
  if (points.length === 0) return "";
  const [h, ...t] = points;
  // A single dot still draws: a zero-length segment with round caps.
  if (t.length === 0) return `M${f1(h!.x)} ${f1(h!.y)} l0.01 0`;
  return `M${f1(h!.x)} ${f1(h!.y)}` + t.map((p) => ` L${f1(p.x)} ${f1(p.y)}`).join("");
}

/** The arrowhead triangle at `to`, pointing away from `from`. */
export function arrowHead(from: Pt, to: Pt, size: number): string {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  const tip = { x: to.x + Math.cos(a) * size * 0.35, y: to.y + Math.sin(a) * size * 0.35 };
  const l = { x: to.x - Math.cos(a - 0.5) * size, y: to.y - Math.sin(a - 0.5) * size };
  const r = { x: to.x - Math.cos(a + 0.5) * size, y: to.y - Math.sin(a + 0.5) * size };
  return [tip, l, r].map((p) => `${f1(p.x)},${f1(p.y)}`).join(" ");
}

/** The arrow's shaft stops short of the head so the round cap doesn't poke through. */
export function shaftEnd(from: Pt, to: Pt, inset: number): Pt {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d <= inset) return from;
  return { x: to.x - ((to.x - from.x) / d) * inset, y: to.y - ((to.y - from.y) / d) * inset };
}

/** Laser timing: the trail holds, then fades from its tail (spec §4). */
export const LASER_HOLD_MS = 700;
export const LASER_FADE_MS = 500;
export const LASER_MAX_POINTS = 48; // the server's cap on presence `laser`

export interface Timed {
  p: Pt;
  t: number;
  /** Which press-to-release gesture the point belongs to: each is its own trail. */
  g?: number;
}

/** Where each gesture after the first starts in a trail (presence `laser_starts`). */
export function laserStarts(trail: Timed[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < trail.length; i++) if (trail[i]!.g !== trail[i - 1]!.g) out.push(i);
  return out;
}

/** A trail cut into its gestures at `starts` (indices, rising; bad ones ignored). */
export function laserRuns<T>(points: T[], starts: readonly number[] = []): T[][] {
  const runs: T[][] = [];
  let from = 0;
  for (const i of starts) {
    if (i <= from || i >= points.length) continue;
    runs.push(points.slice(from, i));
    from = i;
  }
  if (from < points.length) runs.push(points.slice(from));
  return runs;
}

/** Drop what has fully faded, and keep at most the newest `max` points. */
export function pruneLaser(trail: Timed[], now: number, max = LASER_MAX_POINTS): Timed[] {
  const live = trail.filter((q) => now - q.t < LASER_HOLD_MS + LASER_FADE_MS);
  return live.slice(Math.max(0, live.length - max));
}

/** Opacity for a segment `i` of `n` (0 = oldest): the tail fades in, the head is solid. */
export function laserOpacity(i: number, n: number): number {
  if (n <= 1) return 1;
  return Math.min(1, 0.15 + (i / (n - 1)) * 1.4);
}
