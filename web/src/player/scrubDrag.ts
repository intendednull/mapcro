// Scrubbing from the marker space above the bar (#45): a press and drag along the event ticks
// and scene marks scrubs as the bar does; a plain press on a marker still does the marker's own
// thing (a tick jumps to its event, a mark opens its scene). A press on the space between markers
// seeks there at once, as a press on the bar does.
//
// A press that starts on a marker is a click until the pointer travels past the slop below; only
// then does it become a drag, take pointer capture (so it carries on off the row, off the bar,
// off the window) and swallow the click that the release would fire. The slop is the usual
// press-to-drag distance: 4 CSS px for a mouse or pen, which covers a hand's jitter on a click
// without making a short drag feel stuck, and 10 px for a finger, whose contact point wanders
// more on a tap (Android's touch slop is 8 dp; iOS's is about 10 pt).

/** How far, in CSS px, a press on a marker travels before it's a drag rather than a click. */
export const DRAG_SLOP = { mouse: 4, pen: 4, touch: 10 } as const;

export const slopFor = (pointerType: string) => DRAG_SLOP[pointerType as keyof typeof DRAG_SLOP] ?? DRAG_SLOP.mouse;

/**
 * The whole second at clientX along a track spanning `left` to `left + width` (the markers' own
 * row, which lines up with the bar's thumb travel), clamped to the match.
 */
export function scrubTimeAt(clientX: number, left: number, width: number, duration: number): number {
  if (!(width > 0) || !(duration > 0)) return 0;
  const f = Math.min(1, Math.max(0, (clientX - left) / width));
  return Math.round(f * duration);
}

/**
 * The marker space's pointerdown handler. `track` is the element whose box is the time axis,
 * `marker` says whether a press target is a marker (whose click must survive a jitter), `seek`
 * scrubs to a time.
 */
export function markerScrub(o: {
  track: () => HTMLElement | undefined;
  duration: () => number;
  marker: (target: Element) => boolean;
  seek: (t: number) => void;
}) {
  return (e: PointerEvent) => {
    if (!e.isPrimary || e.button !== 0) return;
    const host = e.currentTarget as HTMLElement;
    const target = e.target as Element;
    const track = o.track();
    if (!track) return;
    const box = track.getBoundingClientRect();
    const at = (x: number) => scrubTimeAt(x, box.left, box.width, o.duration());
    const id = e.pointerId;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const slop = slopFor(e.pointerType);
    let dragging = false;
    let last = -1;
    const seek = (x: number) => {
      const t = at(x);
      if (t !== last) o.seek((last = t));
    };
    const start = () => {
      dragging = true;
      try { host.setPointerCapture(id); } catch { /* the pointer is gone already */ }
    };
    const move = (m: PointerEvent) => {
      if (m.pointerId !== id) return;
      if (!dragging && Math.hypot(m.clientX - x0, m.clientY - y0) < slop) return;
      if (!dragging) start();
      m.preventDefault();
      seek(m.clientX);
    };
    // The click a drag's release fires (on the host, under capture, or on the marker it ends
    // over) isn't the marker's: swallow it, once, before it reaches the marker.
    const swallow = (c: MouseEvent) => {
      c.stopPropagation();
      c.preventDefault();
    };
    const end = (u: PointerEvent) => {
      if (u.pointerId !== id) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (dragging) {
        window.addEventListener("click", swallow, { capture: true, once: true });
        // No click follows a cancelled or off-element release: don't let the swallow linger.
        setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      }
    };
    // On the window: before capture the pointer may leave the host while still under the slop,
    // and the captured events bubble up to it after.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    if (!o.marker(target)) {
      // The space between markers: a press seeks there, as the bar does.
      start();
      seek(e.clientX);
    }
  };
}
