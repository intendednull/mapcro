// A long press on touch: a finger held still on a placed thing opens its menu, as a right click
// does with a mouse (TD-107). A mouse or a pen never reaches this.
//
// 500 ms is the platforms' own hold (Android's long-press timeout, iOS's long-press gesture), so
// it is what a finger expects, and well past a tap or the 150 ms in which a second finger turns
// a gesture into a pinch (touchGestures.ts). 10 px is the board's touch slop already: a tap that
// pans or clears (Layers.tsx `pan`) and a young gesture (`PINCH_YOUNG_PX`). A finger that goes
// further is a drag, and a drag never opens the menu, even if it stops and holds.

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_PX = 10;
/** How far from the finger's centre a hold still finds a thing: half a 44 px touch target. A
 *  phone's numbered pin is far smaller than a fingertip. */
export const LONG_PRESS_REACH = 22;

/** Where to look for what a finger holds, nearest first: its centre, then rings out to the reach. */
export function reachPoints(x: number, y: number): Array<{ x: number; y: number }> {
  const out = [{ x, y }];
  for (const r of [8, 16, LONG_PRESS_REACH])
    for (let i = 0; i < 12; i++) out.push({ x: x + r * Math.cos((i * Math.PI) / 6), y: y + r * Math.sin((i * Math.PI) / 6) });
  return out;
}

/**
 * Watch a touch press: `fire` runs if the finger stays within `LONG_PRESS_PX` of where it went
 * down for `LONG_PRESS_MS`. A lift, a cancel (a pinch cancels the first finger's gesture) or a
 * move past the slop ends the watch. Returns a function that ends it too.
 */
export function longPress(e: PointerEvent, fire: () => void): () => void {
  const id = e.pointerId;
  const x0 = e.clientX;
  const y0 = e.clientY;
  // Capture on the window: ahead of any gesture's own handler, which may stop the event.
  const opts = { capture: true } as const;
  const stop = () => {
    clearTimeout(timer);
    window.removeEventListener("pointermove", move, opts);
    window.removeEventListener("pointerup", end, opts);
    window.removeEventListener("pointercancel", end, opts);
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId === id && Math.hypot(ev.clientX - x0, ev.clientY - y0) > LONG_PRESS_PX) stop();
  };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId === id) stop();
  };
  const timer = setTimeout(() => {
    stop();
    fire();
  }, LONG_PRESS_MS);
  window.addEventListener("pointermove", move, opts);
  window.addEventListener("pointerup", end, opts);
  window.addEventListener("pointercancel", end, opts);
  return stop;
}
