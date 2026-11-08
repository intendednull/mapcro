// World ↔ map ↔ view coordinates (design/parity/README.md, "Coordinates"). Pure, no DOM.
//
// - World: game units, as stored on the board (`WorldPos`). +y is toward Sapphire.
// - Map: the minimap square, 0..1000 on each side, y down, Amber at the bottom.
// - View: map units as drawn for one viewpoint. Sapphire's view turns the map 180° about its
//   centre, so Sapphire sits at the bottom; board layers are mapped, not rotated, so text stays
//   upright.

import type { WorldPos } from "../gen/WorldPos";

export interface Pt {
  x: number;
  y: number;
}

/** The square of world space the minimap texture covers: centre and half-side, in world units. */
export interface Transform {
  cx: number;
  cy: number;
  r: number;
}

/** deadlock-api's radius; every objective, camp and shop lands on its street with it. */
export const DEFAULT_TRANSFORM: Transform = { cx: 0, cy: 0, r: 10752 };

export const MAP = 1000;

export type Viewpoint = "amber" | "sapphire" | "neutral";

export function worldToMap(w: { x: number; y: number }, t: Transform = DEFAULT_TRANSFORM): Pt {
  return {
    x: ((w.x - t.cx + t.r) / (2 * t.r)) * MAP,
    y: ((t.r - (w.y - t.cy)) / (2 * t.r)) * MAP,
  };
}

/** Rounded to integers: the schema stores whole world units. */
export function mapToWorld(m: Pt, t: Transform = DEFAULT_TRANSFORM): WorldPos {
  return {
    x: Math.round((m.x / MAP) * 2 * t.r - t.r + t.cx),
    y: Math.round(t.r - (m.y / MAP) * 2 * t.r + t.cy),
  };
}

/** Map → view for a viewpoint. It is its own inverse. */
export function mapToView(m: Pt, vp: Viewpoint): Pt {
  return vp === "sapphire" ? { x: MAP - m.x, y: MAP - m.y } : m;
}
export const viewToMap = mapToView;

export function worldToView(w: { x: number; y: number }, vp: Viewpoint, t: Transform = DEFAULT_TRANSFORM): Pt {
  return mapToView(worldToMap(w, t), vp);
}

export function viewToWorld(v: Pt, vp: Viewpoint, t: Transform = DEFAULT_TRANSFORM): WorldPos {
  return mapToWorld(viewToMap(v, vp), t);
}

/** The notes margin around the map, in view units (a quarter of the map each side): ink,
 * arrows and comments may go there; heroes and objectives stay on the map. In world units it
 * reaches 1.5× the map's radius, inside the schema's ±16384. */
export const MARGIN = 250;

/** Keep a placed thing (ink, arrow, comment, pointer) on the map or its notes margin. */
export function clampToBoard(w: WorldPos, t: Transform = DEFAULT_TRANSFORM): WorldPos {
  const r = t.r * (1 + (2 * MARGIN) / MAP);
  const c = (v: number, mid: number) => Math.max(mid - r, Math.min(mid + r, v));
  return { x: Math.round(c(w.x, t.cx)), y: Math.round(c(w.y, t.cy)) };
}

/** The largest part of the shift `d` that keeps every point on the board (map and margin). */
export function clampShift(points: WorldPos[], d: { x: number; y: number }, t: Transform = DEFAULT_TRANSFORM): { x: number; y: number } {
  if (!points.length) return { x: 0, y: 0 };
  const r = t.r * (1 + (2 * MARGIN) / MAP);
  const xs = points.map((q) => q.x);
  const ys = points.map((q) => q.y);
  const c = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return {
    x: Math.round(c(d.x, t.cx - r - Math.min(...xs), t.cx + r - Math.max(...xs))),
    y: Math.round(c(d.y, t.cy - r - Math.min(...ys), t.cy + r - Math.max(...ys))),
  };
}

/** Keep a dragged position on the map square (the schema allows a little more, ±16384). */
export function clampToMap(w: WorldPos, t: Transform = DEFAULT_TRANSFORM): WorldPos {
  const c = (v: number, mid: number) => Math.max(mid - t.r, Math.min(mid + t.r, v));
  return { x: Math.round(c(w.x, t.cx)), y: Math.round(c(w.y, t.cy)) };
}
