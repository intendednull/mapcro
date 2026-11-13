// Touch on the map: two fingers pinch (zoom and pan, in every tool), and one gesture at a time
// (touch direction, 2026-11-12). Behaviour is chosen per event by `pointerType`; a mouse or a
// pen never reaches this.
//
// A second finger that lands while the first finger's gesture is young (under 150 ms or 10 px)
// cancels that gesture uncommitted (a synthetic `pointercancel`, which every map gesture already
// treats as "not committed") and starts a pinch. Later than that it is a palm: ignored, and the
// gesture carries on. A pan has nothing to commit, so it always turns into a pinch. Lifting to
// one finger after a pinch starts nothing; the next gesture needs a fresh press.

import { capture } from "../ui/capture";
import type { Pt } from "../map/transform";

export const PINCH_YOUNG_MS = 150;
export const PINCH_YOUNG_PX = 10;

type Finger = { x: number; y: number; x0: number; y0: number; t0: number; target: EventTarget | null; spent: boolean };

export function touchGestures(
  svg: SVGSVGElement,
  q: {
    /** View units, as the map's pan: positive moves the content right/down. */
    onPan: (dx: number, dy: number) => void;
    /** About a point in view units; factor > 1 zooms out. */
    onZoom: (at: Pt, factor: number) => void;
    /** This pointer's gesture is a pan (nothing to commit). */
    isPan: (id: number) => boolean;
    toView: (x: number, y: number) => Pt;
  },
) {
  const fingers = new Map<number, Finger>();
  const palms = new Set<number>();
  let pinch: { a: number; b: number } | undefined;
  let cancelling = false;

  const cancel = (id: number, f: Finger) => {
    f.spent = true;
    cancelling = true;
    try {
      (f.target ?? svg).dispatchEvent(new PointerEvent("pointercancel", { pointerId: id, pointerType: "touch", bubbles: true, clientX: f.x, clientY: f.y }));
    } finally {
      cancelling = false;
    }
  };
  const swallow = (e: PointerEvent) => {
    e.stopImmediatePropagation();
    e.preventDefault();
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    const f: Finger = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), target: e.target, spent: false };
    if (pinch || fingers.size >= 2) {
      palms.add(e.pointerId);
      return swallow(e);
    }
    const first = [...fingers][0];
    if (!first) {
      fingers.set(e.pointerId, f);
      return; // the first finger's gesture is the tools'
    }
    const [id0, f0] = first;
    const young = performance.now() - f0.t0 < PINCH_YOUNG_MS || Math.hypot(f0.x - f0.x0, f0.y - f0.y0) < PINCH_YOUNG_PX;
    if (!f0.spent && !young && !q.isPan(id0)) {
      palms.add(e.pointerId);
      return swallow(e);
    }
    swallow(e);
    if (!f0.spent) cancel(id0, f0);
    f.spent = true;
    fingers.set(e.pointerId, f);
    capture(svg, e.pointerId);
    pinch = { a: id0, b: e.pointerId };
  };

  const move = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    if (palms.has(e.pointerId)) return swallow(e);
    const f = fingers.get(e.pointerId);
    if (!f) return;
    if (!pinch) {
      f.x = e.clientX;
      f.y = e.clientY;
      if (f.spent) swallow(e); // after a pinch: nothing until a fresh press
      return;
    }
    const a = fingers.get(pinch.a)!;
    const b = fingers.get(pinch.b)!;
    const mid0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d0 = Math.hypot(a.x - b.x, a.y - b.y);
    f.x = e.clientX;
    f.y = e.clientY;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    swallow(e);
    const perPx = svg.viewBox.baseVal.width / svg.getBoundingClientRect().width;
    if (mid.x !== mid0.x || mid.y !== mid0.y) q.onPan((mid.x - mid0.x) * perPx, (mid.y - mid0.y) * perPx);
    if (d > 0 && d0 > 0 && d !== d0) q.onZoom(q.toView(mid.x, mid.y), d0 / d);
  };

  const up = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || cancelling) return;
    if (palms.delete(e.pointerId)) return swallow(e);
    const f = fingers.get(e.pointerId);
    if (!f) return;
    fingers.delete(e.pointerId);
    if (pinch && (pinch.a === e.pointerId || pinch.b === e.pointerId)) {
      pinch = undefined;
      swallow(e);
    } else if (f.spent) swallow(e);
  };

  // Capture phase on the map: ahead of every gesture on it, the tokens' delegated ones included.
  const opts = { capture: true } as const;
  svg.addEventListener("pointerdown", down, opts);
  window.addEventListener("pointermove", move, opts);
  window.addEventListener("pointerup", up, opts);
  window.addEventListener("pointercancel", up, opts);
  return () => {
    svg.removeEventListener("pointerdown", down, opts);
    window.removeEventListener("pointermove", move, opts);
    window.removeEventListener("pointerup", up, opts);
    window.removeEventListener("pointercancel", up, opts);
  };
}
