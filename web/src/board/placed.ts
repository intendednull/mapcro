// Edits to placed things (ink, arrows, comments) as transactions. Pure, so they're tested
// against the real server for what concurrent edits do.

import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import type { Side } from "../gen/Side";
import type { Stroke } from "../gen/Stroke";
import type { WorldPos } from "../gen/WorldPos";
import { fitStroke } from "./geometry";

/** Where a stroke is drawn: its points moved by its offset. */
export const strokePoints = (s: Stroke): WorldPos[] => {
  const o = s.offset ?? { x: 0, y: 0 };
  return o.x || o.y ? s.points.map((q) => ({ x: q.x + o.x, y: q.y + o.y })) : s.points;
};

/**
 * Move a stroke by `d` (world units) from where it's drawn now: one last-writer-wins write of
 * its offset. On a stroke someone deleted meanwhile it's skipped, and its undo is too.
 */
export function moveStrokeOps(id: RecordId, s: Stroke, d: { x: number; y: number }): Op[] {
  const o = s.offset ?? { x: 0, y: 0 };
  return [{ Set: { id, value: { StrokeOffset: { x: o.x + d.x, y: o.y + d.y } } } }];
}

/**
 * The most points a live stroke preview carries. Presence resends it whole every tick while
 * you draw, so it's downsampled; the saved stroke keeps full fidelity.
 */
export const LIVE_INK_POINTS = 128;

/** The live preview of a stroke being drawn, as presence carries it (view points in, world out). */
export function liveInk(points: Array<{ x: number; y: number }>, color: number, world: (p: { x: number; y: number }) => WorldPos): { color: number; points: WorldPos[] } {
  return { color, points: fitStroke(points, LIVE_INK_POINTS).map((q) => world(q)) };
}

/** What a placed thing's menu is for (feedback #59, #60). */
export type Placed = "Callout" | "Arrow" | "Stroke";

/**
 * Recolour a placed thing to palette colour `i`: one write; none if it has that colour. `null`
 * is no colour, as before colours: a comment's own colour, an arrow's team's. A stroke always
 * has one (its ink), so it has no "no colour".
 */
export function recolourOps(kind: Placed, id: RecordId, now: number | null | undefined, i: number | null): Op[] {
  if ((now ?? null) === i) return [];
  if (kind === "Callout") return [{ Set: { id, value: { CalloutColor: i } } }];
  if (kind === "Arrow") return [{ Set: { id, value: { ArrowColor: i } } }];
  return i === null ? [] : [{ Set: { id, value: { StrokeColor: i } } }];
}

/** Move a comment to `side` of its spot: one write; none if it is there (no side is `Above`). */
export function sideOps(id: RecordId, now: Side | undefined, side: Side): Op[] {
  return (now ?? "Above") === side ? [] : [{ Set: { id, value: { CalloutSide: side } } }];
}
