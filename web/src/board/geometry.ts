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

/** Laser timing (spec §4): each point of the trail fades by its own age, from the moment it's
 * drawn, whether or not the pointer moves (#42), and is gone at `LASER_LIFE_MS`. */
export const LASER_HOLD_MS = 700;
export const LASER_FADE_MS = 500;
export const LASER_LIFE_MS = LASER_HOLD_MS + LASER_FADE_MS;
export const LASER_MAX_POINTS = 48; // the server's cap on presence `laser`
/** The least time between two kept points of a gesture: the cap then spans a whole life, so a
 * fast stroke's tail ages out rather than being cut off by the point count. */
export const LASER_STEP_MS = Math.ceil(LASER_LIFE_MS / LASER_MAX_POINTS) + 1;

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
  const live = trail.filter((q) => now - q.t < LASER_LIFE_MS);
  return live.slice(Math.max(0, live.length - max));
}

/**
 * The trail with the pointer at `p` in gesture `g`: a new point, or, when the newest came less
 * than `LASER_STEP_MS` after the one before it in the same gesture, that newest point moved here
 * (the head follows the pointer; kept points stay `LASER_STEP_MS` apart).
 */
export function addLaser(trail: Timed[], p: Pt, now: number, g: number): Timed[] {
  const live = pruneLaser(trail, now);
  const last = live[live.length - 1], before = live[live.length - 2];
  if (last && before && last.g === g && before.g === g && last.t - before.t < LASER_STEP_MS) live.pop();
  return pruneLaser([...live, { p, t: now, g }], now);
}

/** A point's opacity at `age` ms: near solid at first, fading ever faster, gone at the end. */
export function laserAlpha(age: number): number {
  if (age <= 0) return 1;
  if (age >= LASER_LIFE_MS) return 0;
  const x = age / LASER_LIFE_MS;
  return 1 - x * x;
}

/** The joint's cut, as its direction: the turn's bisector, the line along which both segments
 * meet. A near-reversal has no bisector, so cut square to the stroke (a line both still share). */
function jointAxis(a: Pt, b: Pt, c: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y, ex = c.x - b.x, ey = c.y - b.y;
  const d = Math.hypot(dx, dy) || 1, e = Math.hypot(ex, ey) || 1;
  const mx = -dy / d - ey / e, my = dx / d + ex / e;
  const len = Math.hypot(mx, my);
  return len < 1e-3 ? { x: -dy / d, y: dx / d } : { x: mx / len, y: my / len };
}

/** The convex polygon `poly` cut down to the half-plane `{(x - at) . n >= 0}`. */
function halfPlane(poly: Pt[], at: Pt, n: Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const da = (a.x - at.x) * n.x + (a.y - at.y) * n.y;
    const db = (b.x - at.x) * n.x + (b.y - at.y) * n.y;
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) out.push({ x: a.x + ((b.x - a.x) * da) / (da - db), y: a.y + ((b.y - a.y) * da) / (da - db) });
  }
  return out;
}

/**
 * Segment `i`'s clip polygon (`points`, user space): its stroke, cut at each end where it meets a
 * neighbour. Neighbours cut along the same line at their joint, so their round caps meet there
 * instead of overlapping: overlapping caps doubled the alpha, a bright seam at every joint (#46).
 */
export function laserClip(pts: readonly Pt[], i: number): string {
  const a = pts[i]!, b = pts[i + 1]!;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  // Well clear of the stroke: a segment is at most 9 wide, and its caps reach 5 past its ends.
  const r = len / 2 + 50;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  let poly: Pt[] = [{ x: cx - r, y: cy - r }, { x: cx + r, y: cy - r }, { x: cx + r, y: cy + r }, { x: cx - r, y: cy + r }];
  // The side of the cut this segment is on: the one its own body lies on. A trail's own ends are
  // not joints, so they are left whole, cap and all.
  const keep = (axis: Pt): Pt => ({ x: -axis.y, y: axis.x });
  if (i > 0) {
    const n = keep(jointAxis(pts[i - 1]!, a, b));
    poly = halfPlane(poly, a, { x: -n.x, y: -n.y });
  }
  if (i + 2 < pts.length) poly = halfPlane(poly, b, keep(jointAxis(a, b, pts[i + 2]!)));
  return poly.map((q) => `${Math.round(q.x * 100) / 100},${Math.round(q.y * 100) / 100}`).join(" ");
}

/**
 * A peer's trail (presence carries points, not times) stamped with when this browser first saw
 * each point: one already in `prev` keeps its time, a new one is `now`. Points match by position,
 * in order, so a repeated position keeps each time once.
 */
export function stampLaser<P extends { x: number; y: number }>(prev: readonly { p: P; t: number }[], next: readonly P[], now: number): { p: P; t: number }[] {
  const seen = new Map<string, number[]>();
  for (const q of prev) {
    const k = `${q.p.x},${q.p.y}`;
    const ts = seen.get(k);
    if (ts) ts.push(q.t);
    else seen.set(k, [q.t]);
  }
  return next.map((p) => ({ p, t: seen.get(`${p.x},${p.y}`)?.shift() ?? now }));
}
