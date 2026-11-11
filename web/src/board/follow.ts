// Follow mode (spec §8), the parts that are pure: who can be followed, who is presenting, and
// the view rectangle that mirrors a presenter's viewport.

import type { PeerPresence } from "../gen/PeerPresence";
import type { Viewport } from "../gen/Viewport";
import { FIT_VIEW, MARGIN, type Viewpoint, viewToWorld, worldToView } from "../map/transform";

export interface ViewRect {
  x: number;
  y: number;
  w: number;
}

export const FIT: ViewRect = { ...FIT_VIEW };
export const MIN_W = 160; // the deepest zoom: about 6×
/** The widest view: the map and its notes margin all round. */
export const MAX_W = 1000 + 2 * MARGIN;

/** Anyone with edit rights can be followed; view-only people can't (the server stamps roles). */
export const followable = (p: PeerPresence) => p.state !== null && p.role !== "view";

/**
 * How long a follow waits for its presenter to come back (spec §8). After this page's own
 * reconnect, everyone else is coming back too, a server restart being every deploy, and their
 * reconnect backoff reaches 15 s; after the presenter's connection alone goes, its own
 * reconnect takes about a second.
 */
export const REJOIN_MS = 20_000;
export const RECONNECT_MS = 5_000;

/** Whom a follow is on: their peer id on the join it was made on (`joins`), and their seat. */
export interface FollowTarget {
  peer: number;
  seat?: number | undefined;
  /** `joined().n` when `peer` was last seen: an id from an earlier join names nobody now. */
  joins: number;
  /** When the presenter was first missed on this join, while waiting. */
  lostAt?: number;
}

export type Located =
  /** Here: `peer` is the presenter's connection now (its id may be a new one). */
  | { kind: "here"; peer: PeerPresence }
  /** Not here yet; look again at `until`. */
  | { kind: "wait"; until: number }
  | { kind: "gone" };

/**
 * Where a follow's presenter is now. On the same join, its peer, unless that peer now has
 * another seat (someone else). Otherwise, the newest editor with its seat. Missing: wait while
 * a reconnect may bring it back, then gone. A presenter with no seat (an older client) is
 * found by peer only, and only on the join the follow was made on.
 */
export function locate(t: FollowTarget, peers: PeerPresence[], me: number | undefined, joined: { n: number; at: number }, now: number): Located {
  if (t.joins === joined.n) {
    const same = peers.find((p) => p.peer === t.peer && p.state);
    const seat = same?.state?.seat;
    if (same && (t.seat == null || seat == null || seat === t.seat)) return { kind: "here", peer: same };
  }
  if (t.seat == null) return { kind: "gone" };
  let best: PeerPresence | undefined;
  for (const p of peers) if (p.peer !== me && followable(p) && p.state?.seat === t.seat && (!best || p.peer > best.peer)) best = p;
  if (best) return { kind: "here", peer: best };
  const until = t.joins !== joined.n ? joined.at + REJOIN_MS : (t.lostAt ?? now) + RECONNECT_MS;
  return now < until ? { kind: "wait", until } : { kind: "gone" };
}

/** Presenters: followable people someone is following, with how many follow them. */
export function presenters(peers: PeerPresence[], me: number | undefined, iFollow: number | undefined) {
  const count = new Map<number, number>();
  for (const p of peers) if (p.state?.following != null) count.set(p.state.following, (count.get(p.state.following) ?? 0) + 1);
  if (iFollow !== undefined) count.set(iFollow, (count.get(iFollow) ?? 0) + 1);
  return peers.filter((p) => followable(p) && p.peer !== me && (count.get(p.peer) ?? 0) > 0).map((p) => ({ peer: p, followers: count.get(p.peer)! }));
}

/** A view inside the board: the map and its notes margin (operator, 2026-11-07). */
export function clampView(v: ViewRect): ViewRect {
  const w = Math.max(MIN_W, Math.min(MAX_W, v.w));
  const c = (u: number) => Math.max(-MARGIN, Math.min(1000 + MARGIN - w, u));
  return { w, x: c(v.x), y: c(v.y) };
}

/** Zoom by `factor` (>1 zooms out) keeping the view point `at` fixed on screen. */
export function zoomAt(v: ViewRect, at: { x: number; y: number }, factor: number): ViewRect {
  const w = Math.max(MIN_W, Math.min(MAX_W, v.w * factor));
  const k = w / v.w;
  return clampView({ w, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k });
}

/** What presence carries: the centre in world units (right in either viewpoint) and zoom. */
export function toViewport(v: ViewRect, vp: Viewpoint): Viewport {
  return { center: viewToWorld({ x: v.x + v.w / 2, y: v.y + v.w / 2 }, vp), zoom: Math.round((1000 * 1000) / v.w), side: vp === "sapphire" ? "Sapphire" : "Amber" };
}

/** The side a presenter's map is turned to (`undefined` before they've sent a view). */
export function sideOf(p: Viewport | null | undefined): Viewpoint | undefined {
  if (!p) return undefined;
  return p.side === "Sapphire" ? "sapphire" : "amber";
}

export function fromViewport(p: Viewport | null, vp: Viewpoint): ViewRect {
  if (!p || p.zoom <= 0) return FIT;
  const w = (1000 * 1000) / p.zoom;
  const c = worldToView(p.center, vp);
  return clampView({ w, x: c.x - w / 2, y: c.y - w / 2 });
}
