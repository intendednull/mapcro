// Panels a person moves in the board pane (#35 the death recap, #37 the hero panels; spec §6b
// "Moving panels"): where one sits travels as a place relative to the pane (wire.rs `PanelPlace`), so a
// follower with another screen keeps the layout, and each screen clamps it into its own pane, off
// its own controls (the Map layers and Vision row). The pane is the panel's offset parent: on a
// desktop the board area round the map (#40: anywhere in it, not only over the map), on a phone
// the map.
//
// A place is, on each axis, the distance from the pane's nearer edge to the panel's edge on that
// side, in `PLACE_SCALE`ths of the pane's width or height.

import { createEffect, onCleanup, onMount, untrack } from "solid-js";
import { PLACE_SCALE, type Place, placeToWire } from "./layers";

export type { Place };
/** A spot in the pane, in px from its top left. */
export interface Spot {
  left: number;
  top: number;
}
/** A pane's size and the bands at its top and bottom its own controls take (px). */
export interface Pane {
  w: number;
  h: number;
  top: number;
  bottom: number;
}

/** The place of a panel `w`×`h` at `at` in `pane`: from the nearer edge on each axis. */
export function placeOf(at: Spot, w: number, h: number, pane: Pane): Place {
  const right = at.left + w / 2 > pane.w / 2;
  const bottom = at.top + h / 2 > pane.h / 2;
  const unit = (d: number, n: number) => Math.min(PLACE_SCALE, Math.max(0, Math.round((d / Math.max(1, n)) * PLACE_SCALE)));
  return { x: unit(right ? pane.w - at.left - w : at.left, pane.w), y: unit(bottom ? pane.h - at.top - h : at.top, pane.h), right, bottom };
}

/** Where a panel `w`×`h` with `place` sits in `pane`, clamped into it. */
export function spotOf(place: Place, w: number, h: number, pane: Pane): Spot {
  const dx = (place.x / PLACE_SCALE) * pane.w;
  const dy = (place.y / PLACE_SCALE) * pane.h;
  return clampSpot({ left: place.right ? pane.w - dx - w : dx, top: place.bottom ? pane.h - dy - h : dy }, w, h, pane);
}

/** A spot moved so the panel is inside the pane and clear of its controls' bands; a panel
 * too big for the room left sits at the top of it (its height is capped to the room). */
export function clampSpot(at: Spot, w: number, h: number, pane: Pane): Spot {
  return {
    left: Math.max(0, Math.min(at.left, pane.w - w)),
    top: Math.max(pane.top, Math.min(at.top, pane.h - pane.bottom - h)),
  };
}

/** Steps of `cascade` before it starts over. */
export const CASCADE_STEPS = 8;
/** The `n`th step where a panel opens from the map: from the pane's top left, each a step down
 * and right of the last, `CASCADE_STEPS` steps before it starts over. */
export function cascade(n: number, pane: Pane): Place {
  const k = n % CASCADE_STEPS;
  const unit = (d: number, of: number) => Math.min(PLACE_SCALE, Math.round((d / Math.max(1, of)) * PLACE_SCALE));
  return { x: unit(12 + 24 * k, pane.w), y: unit(Math.max(pane.top, 44) + 24 * k, pane.h), right: false, bottom: false };
}

/** Where a new panel opens beside the open ones (at their places): the first step of the
 * cascade none still sits on (not moved since it opened), so it never opens exactly over
 * another; with every step taken, the next after the open ones. */
export function opening(open: (Place | undefined)[], pane: Pane): Place {
  const key = (p: Place | undefined) => JSON.stringify(placeToWire(p) ?? null);
  const taken = new Set(open.map(key));
  for (let k = 0; k < CASCADE_STEPS; k++) if (!taken.has(key(cascade(k, pane)))) return cascade(k, pane);
  return cascade(open.length, pane);
}

/** The px the pane's own controls take at its top and bottom: each visible control over the
 * pane takes a band from the nearer edge to its far side, with a gap. */
export function paneOf(pane: HTMLElement, controls: Iterable<Element>, gap = 4): Pane {
  const p = pane.getBoundingClientRect();
  let top = 0;
  let bottom = 0;
  for (const c of controls) {
    const b = c.getBoundingClientRect();
    if (b.width < 1 || b.height < 1 || b.right <= p.left || b.left >= p.right || b.bottom <= p.top || b.top >= p.bottom) continue;
    if (b.top + b.height / 2 < p.top + p.height / 2) top = Math.max(top, b.bottom - p.top + gap);
    else bottom = Math.max(bottom, p.bottom - b.top + gap);
  }
  return { w: p.width, h: p.height, top, bottom };
}

export interface Movable {
  /** Where it was put, or none: `home`. */
  place: () => Place | undefined;
  /** Where it sits until moved (px from the pane's top left). */
  home: () => Spot;
  /** It was moved: its new place. */
  onPlace: (p: Place) => void;
  /** A press anywhere on it (to bring it to the front). */
  onPress?: () => void;
  /** The part it is dragged by, inside it. */
  handle: string;
}

/**
 * Make `el` (a panel absolutely placed in the board pane) sit at its place and move with a drag
 * of its handle: mouse, pen or touch, through pointer events. Use as a ref: `ref={(el) =>
 * movable(el, …)}`. The pane's controls (`.map-controls > *` beside it) are kept clear.
 */
export function movable(el: HTMLElement, o: Movable) {
  onMount(() => {
    const pane = () => el.offsetParent as HTMLElement | null;
    const measure = () => {
      const p = pane();
      return p && paneOf(p, p.parentElement?.querySelectorAll(".map-controls > *") ?? []);
    };
    const layout = () => {
      const p = measure();
      if (!p) return;
      // Its height capped to the room between the controls, so it is never pushed past them.
      el.style.maxHeight = `${Math.max(0, p.h - p.top - p.bottom)}px`;
      const place = untrack(o.place);
      const { width: w, height: h } = el.getBoundingClientRect();
      const at = place ? spotOf(place, w, h, p) : clampSpot(untrack(o.home), w, h, p);
      el.style.left = `${at.left}px`;
      el.style.top = `${at.top}px`;
    };
    createEffect(() => {
      o.place();
      o.home();
      layout();
    });
    // Its own size (its content changes with t), the pane's (the window, the layout) and the
    // controls row's (it wraps, and grows, as its controls change), on the next frame: placing
    // it can change its size (the height cap), which mustn't loop here.
    let frame = 0;
    const seen = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(layout);
    });
    seen.observe(el);
    const p = pane();
    if (p) seen.observe(p);
    const controls = p?.parentElement?.querySelector(".map-controls");
    if (controls) seen.observe(controls, { box: "border-box" });
    onCleanup(() => {
      cancelAnimationFrame(frame);
      seen.disconnect();
    });

    const handle = el.querySelector<HTMLElement>(o.handle);
    if (!handle) return;
    let drag: { id: number; x: number; y: number; left: number; top: number } | undefined;
    const press = () => o.onPress?.();
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // Its buttons (×) stay buttons.
      if ((e.target as Element).closest("button, a, input, select, summary, [tabindex]")) return;
      e.preventDefault();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: parseFloat(el.style.left) || el.offsetLeft, top: parseFloat(el.style.top) || el.offsetTop };
      handle.setPointerCapture?.(e.pointerId);
      el.dataset.moving = "true";
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const p = measure();
      if (!p) return;
      const { width: w, height: h } = el.getBoundingClientRect();
      const at = clampSpot({ left: drag.left + e.clientX - drag.x, top: drag.top + e.clientY - drag.y }, w, h, p);
      o.onPlace(placeOf(at, w, h, p));
    };
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = undefined;
      delete el.dataset.moving;
    };
    el.addEventListener("pointerdown", press, true);
    handle.addEventListener("pointerdown", down);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    handle.addEventListener("lostpointercapture", up);
    onCleanup(() => {
      el.removeEventListener("pointerdown", press, true);
      handle.removeEventListener("pointerdown", down);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.removeEventListener("lostpointercapture", up);
    });
  });
}
