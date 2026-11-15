// Where a comment's card goes (operator audit, 2026-11-07): screen-sized whatever the zoom,
// wrapped to a readable width, and kept inside the visible map so it's never clipped. Pure.

import type { Side } from "../gen/Side";
import type { Pt } from "../map/transform";

export const CARD = { font: 13, line: 17, padX: 9, padY: 7, maxW: 240, charW: 7, gap: 14 } as const;

/** Greedy word wrap to `max` characters a line (a long word is cut). */
export function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    for (let w = word; w.length; ) {
      const room = cur ? max - cur.length - 1 : max;
      if (w.length <= room) {
        cur = cur ? `${cur} ${w}` : w;
        w = "";
      } else if (!cur) {
        lines.push(w.slice(0, max));
        w = w.slice(max);
      } else {
        lines.push(cur);
        cur = "";
      }
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

export interface CardBox {
  lines: string[];
  /** Top-left and size, in view units. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * @param pos the comment's spot, in view units
 * @param s view units per screen pixel (the map's zoom and size)
 * @param vis the visible part of the map, in view units
 * @param side which side of the spot it sits on (feedback #59); `Above`, as every comment
 *   before sides, is up and to the right
 */
export function cardBox(text: string, pos: Pt, s: number, vis: { x: number; y: number; w: number }, side: Side = "Above"): CardBox {
  const max = Math.floor((CARD.maxW - 2 * CARD.padX) / CARD.charW);
  const lines = wrap(text, max);
  const wPx = Math.max(48, Math.min(CARD.maxW, Math.max(...lines.map((l) => l.length)) * CARD.charW + 2 * CARD.padX));
  const hPx = lines.length * CARD.line + 2 * CARD.padY;
  const [w, h, g, m] = [wPx * s, hPx * s, CARD.gap * s, 4 * s];
  const [right, left] = [pos.x + g, pos.x - g - w];
  let x: number;
  let y: number;
  if (side === "Left" || side === "Right") {
    // Beside the spot, level with it; to the other side if that would leave the view.
    x = side === "Left" ? (left < vis.x + m ? right : left) : right + w > vis.x + vis.w - m ? left : right;
    y = pos.y - h / 2;
  } else {
    // Up (or down) and to the right of the spot; to the left if that would leave the view.
    x = right + w > vis.x + vis.w - m ? left : right;
    y = side === "Below" ? pos.y + g : pos.y - g - h;
  }
  x = Math.min(Math.max(x, vis.x + m), vis.x + vis.w - m - w);
  y = Math.min(Math.max(y, vis.y + m), vis.y + vis.w - m - h);
  return { lines, x, y, w, h };
}

/** A closed comment's speech bubble, its tail on the spot (the origin), in bubble units. */
export interface Bubble {
  body: string;
  dots: string;
  /** Mirrors the drawing for the side it doesn't draw itself (Below, Right). */
  transform?: string;
}

const ABOVE: Bubble = { body: "M0 0 L-4 -8 H-11 A5 5 0 0 1 -16 -13 V-25 A5 5 0 0 1 -11 -30 H11 A5 5 0 0 1 16 -25 V-13 A5 5 0 0 1 11 -8 H4 Z", dots: "M-7 -19h0.01M0 -19h0.01M7 -19h0.01" };
/** The same body, 32 × 22, to the left of the spot, its tail pointing right at it. */
const LEFT: Bubble = { body: "M0 0 L-8 -4 V-6 A5 5 0 0 0 -13 -11 H-35 A5 5 0 0 0 -40 -6 V6 A5 5 0 0 0 -35 11 H-13 A5 5 0 0 0 -8 6 V4 Z", dots: "M-31 0h0.01M-24 0h0.01M-17 0h0.01" };

/** The bubble on `side` of its spot. `Above` is the bubble every comment had before sides. */
export function bubble(side: Side = "Above"): Bubble {
  if (side === "Below") return { ...ABOVE, transform: "scale(1 -1)" };
  if (side === "Left") return LEFT;
  if (side === "Right") return { ...LEFT, transform: "scale(-1 1)" };
  return ABOVE;
}

/** The sides a comment can sit on, in the menu's order. */
export const SIDES: Side[] = ["Above", "Below", "Left", "Right"];
