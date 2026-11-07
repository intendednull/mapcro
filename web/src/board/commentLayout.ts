// Where a comment's card goes (operator audit, 2026-11-07): screen-sized whatever the zoom,
// wrapped to a readable width, and kept inside the visible map so it's never clipped. Pure.

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
 */
export function cardBox(text: string, pos: Pt, s: number, vis: { x: number; y: number; w: number }): CardBox {
  const max = Math.floor((CARD.maxW - 2 * CARD.padX) / CARD.charW);
  const lines = wrap(text, max);
  const wPx = Math.max(48, Math.min(CARD.maxW, Math.max(...lines.map((l) => l.length)) * CARD.charW + 2 * CARD.padX));
  const hPx = lines.length * CARD.line + 2 * CARD.padY;
  const [w, h, g, m] = [wPx * s, hPx * s, CARD.gap * s, 4 * s];
  // Up and to the right of the spot; to the left if that would leave the view.
  let x = pos.x + g;
  if (x + w > vis.x + vis.w - m) x = pos.x - g - w;
  let y = pos.y - g - h;
  x = Math.min(Math.max(x, vis.x + m), vis.x + vis.w - m - w);
  y = Math.min(Math.max(y, vis.y + m), vis.y + vis.w - m - h);
  return { lines, x, y, w, h };
}
