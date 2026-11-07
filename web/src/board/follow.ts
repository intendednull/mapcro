// Follow mode (spec §8), the parts that are pure: who can be followed, who is presenting, and
// the view rectangle that mirrors a presenter's viewport.

import type { PeerPresence } from "../gen/PeerPresence";
import type { Viewport } from "../gen/Viewport";
import { type Viewpoint, viewToWorld, worldToView } from "../map/transform";

export interface ViewRect {
  x: number;
  y: number;
  w: number;
}

export const FIT: ViewRect = { x: 0, y: 0, w: 1000 };
export const MIN_W = 160; // the deepest zoom: about 6×

/** Anyone with edit rights can be followed; view-only people can't (the server stamps roles). */
export const followable = (p: PeerPresence) => p.state !== null && p.role !== "view";

/** Presenters: followable people someone is following, with how many follow them. */
export function presenters(peers: PeerPresence[], me: number | undefined, iFollow: number | undefined) {
  const count = new Map<number, number>();
  for (const p of peers) if (p.state?.following != null) count.set(p.state.following, (count.get(p.state.following) ?? 0) + 1);
  if (iFollow !== undefined) count.set(iFollow, (count.get(iFollow) ?? 0) + 1);
  return peers.filter((p) => followable(p) && p.peer !== me && (count.get(p.peer) ?? 0) > 0).map((p) => ({ peer: p, followers: count.get(p.peer)! }));
}

export function clampView(v: ViewRect): ViewRect {
  const w = Math.max(MIN_W, Math.min(1000, v.w));
  return { w, x: Math.max(0, Math.min(1000 - w, v.x)), y: Math.max(0, Math.min(1000 - w, v.y)) };
}

/** Zoom by `factor` (>1 zooms out) keeping the view point `at` fixed on screen. */
export function zoomAt(v: ViewRect, at: { x: number; y: number }, factor: number): ViewRect {
  const w = Math.max(MIN_W, Math.min(1000, v.w * factor));
  const k = w / v.w;
  return clampView({ w, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k });
}

/** What presence carries: the centre in world units (right in either viewpoint) and zoom. */
export function toViewport(v: ViewRect, vp: Viewpoint): Viewport {
  return { center: viewToWorld({ x: v.x + v.w / 2, y: v.y + v.w / 2 }, vp), zoom: Math.round((1000 * 1000) / v.w) };
}

export function fromViewport(p: Viewport | null, vp: Viewpoint): ViewRect {
  if (!p || p.zoom <= 0) return FIT;
  const w = (1000 * 1000) / p.zoom;
  const c = worldToView(p.center, vp);
  return clampView({ w, x: c.x - w / 2, y: c.y - w / 2 });
}
