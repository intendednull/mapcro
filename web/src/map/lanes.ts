// Lane lines as measured paths, for the lane equilibrium (where the creep waves meet). Pure.
//
// A lane is a polyline in map units (0..1000, y down), ordered from its Amber end to its
// Sapphire end. Positions along it are `t`, 0..1000 by arc length, so a `Wave` record means the
// same place in either viewpoint. The lane is drawn in two colours split at `t`: Amber's half
// from 0 to t, Sapphire's from t to 1000, with a small gap at the split (the contested zone).

import type { Pt } from "./transform";

export const T_MAX = 1000;

export interface LaneLine {
  /** Amber end first. */
  points: Pt[];
  /** Cumulative arc length at each point; the last is the total. */
  cum: number[];
}

/** Points along SVG path data made of M, L and C commands (absolute), every ~`step` units. */
export function samplePath(d: string, step = 4): Pt[] {
  const nums = (s: string) => (s.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number);
  const out: Pt[] = [];
  let cur: Pt = { x: 0, y: 0 };
  for (const [, cmd, args] of d.matchAll(/([MLC])([^MLC]*)/g)) {
    const n = nums(args ?? "");
    if (cmd === "M" || cmd === "L") {
      for (let i = 0; i + 1 < n.length; i += 2) {
        const p = { x: n[i]!, y: n[i + 1]! };
        if (cmd === "L" && out.length) {
          const k = Math.max(1, Math.ceil(Math.hypot(p.x - cur.x, p.y - cur.y) / step));
          for (let j = 1; j <= k; j++) out.push({ x: cur.x + ((p.x - cur.x) * j) / k, y: cur.y + ((p.y - cur.y) * j) / k });
        } else out.push(p);
        cur = p;
      }
    } else {
      for (let i = 0; i + 5 < n.length; i += 6) {
        const [c1, c2, p] = [{ x: n[i]!, y: n[i + 1]! }, { x: n[i + 2]!, y: n[i + 3]! }, { x: n[i + 4]!, y: n[i + 5]! }];
        const len = Math.hypot(c1.x - cur.x, c1.y - cur.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(p.x - c2.x, p.y - c2.y);
        const k = Math.max(1, Math.ceil(len / step));
        for (let j = 1; j <= k; j++) {
          const u = j / k;
          const a = (1 - u) ** 3, b = 3 * (1 - u) ** 2 * u, c = 3 * (1 - u) * u ** 2, e = u ** 3;
          out.push({ x: a * cur.x + b * c1.x + c * c2.x + e * p.x, y: a * cur.y + b * c1.y + c * c2.y + e * p.y });
        }
        cur = p;
      }
    }
  }
  return out;
}

/** Measure a lane, turning it so it runs from the Amber end (the bottom, larger y). */
export function laneLine(points: Pt[]): LaneLine {
  const pts = points.length > 1 && points[0]!.y < points[points.length - 1]!.y ? [...points].reverse() : points.slice();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  return { points: pts, cum };
}

const total = (l: LaneLine) => l.cum[l.cum.length - 1] ?? 0;

/** The point at `t` (0..1000) along the lane. */
export function pointAt(l: LaneLine, t: number): Pt {
  const n = l.points.length;
  if (n === 0) return { x: 0, y: 0 };
  const s = (Math.max(0, Math.min(T_MAX, t)) / T_MAX) * total(l);
  let i = 1;
  while (i < n - 1 && l.cum[i]! < s) i++;
  const a = l.points[i - 1]!, b = l.points[Math.min(i, n - 1)]!;
  const seg = (l.cum[i] ?? 0) - (l.cum[i - 1] ?? 0);
  const u = seg > 0 ? (s - l.cum[i - 1]!) / seg : 0;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

/** The nearest point on the lane to `p`: its `t` (rounded to a whole unit) and distance. */
export function project(l: LaneLine, p: Pt): { t: number; dist: number } {
  let best = { s: 0, d: Infinity };
  for (let i = 1; i < l.points.length; i++) {
    const a = l.points[i - 1]!, b = l.points[i]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(a.x + dx * u - p.x, a.y + dy * u - p.y);
    if (d < best.d) best = { s: l.cum[i - 1]! + Math.sqrt(len2) * u, d };
  }
  const tot = total(l);
  return { t: tot > 0 ? Math.round((best.s / tot) * T_MAX) : 0, dist: best.d };
}

/** Where a lane splits with no `Wave`: where it crosses the map's centre line (world y = 0). */
export function defaultSplit(l: LaneLine): number {
  for (let i = 1; i < l.points.length; i++) {
    const a = l.points[i - 1]!, b = l.points[i]!;
    if ((a.y - 500) * (b.y - 500) <= 0 && a.y !== b.y) {
      const u = (a.y - 500) / (a.y - b.y);
      return Math.round(((l.cum[i - 1]! + (l.cum[i]! - l.cum[i - 1]!) * u) / total(l)) * T_MAX);
    }
  }
  return T_MAX / 2;
}

/** The two halves at `t`, with a gap of `gap` map units of arc length centred on the split. */
export function splitAt(l: LaneLine, t: number, gap: number): { amber: Pt[]; sapphire: Pt[] } {
  return splitEdges(l, t, t, gap);
}

/**
 * Amber's part over `[0, amber]`, Sapphire's over `[sapphire, 1000]` (the zipline colours), the
 * gap between uncoloured and never narrower than `gap` map units of arc length, which then
 * centres on the two edges' middle.
 */
export function splitEdges(l: LaneLine, amberT: number, sapphireT: number, gap: number): { amber: Pt[]; sapphire: Pt[] } {
  const tot = total(l);
  if (tot === 0) return { amber: [], sapphire: [] };
  const at = (t: number) => (Math.max(0, Math.min(T_MAX, t)) / T_MAX) * tot;
  let a = at(amberT), b = at(Math.max(amberT, sapphireT));
  if (b - a < gap) {
    const mid = (a + b) / 2;
    [a, b] = [mid - gap / 2, mid + gap / 2];
  }
  const lo = Math.max(0, a), hi = Math.min(tot, b);
  const amber: Pt[] = [], sapphire: Pt[] = [];
  l.points.forEach((p, i) => {
    if (l.cum[i]! < lo) amber.push(p);
    else if (l.cum[i]! > hi) sapphire.push(p);
  });
  if (lo > 0) amber.push(pointAt(l, (lo / tot) * T_MAX));
  if (hi < tot) sapphire.unshift(pointAt(l, (hi / tot) * T_MAX));
  return { amber, sapphire };
}

export const pathOf = (pts: Pt[]) => (pts.length ? `M${pts.map((p) => `${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`).join(" L")}` : "");
