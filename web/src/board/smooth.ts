// Remote motion, smoothed at render time (perf report 2026-11-07, finding 3). Others' drags and
// cursors arrive in presence batches about every 50 ms, unevenly; drawn as they land they step.
// A Glide eases from where the value is shown now to its latest target over SMOOTH_MS, so the
// motion is continuous and trails the sender by about that much. Nothing here touches the data:
// records, presence and what is sent stay exact. Below, `easedNumber`: the out-expo ease every
// changing value shown from the match or the data uses (spec §4a).

import { createComputed, createSignal, onCleanup, untrack } from "solid-js";
import type { WorldPos } from "../gen/WorldPos";

export const SMOOTH_MS = 100;

/** The pure part: a position easing linearly toward its latest target. */
export class Glide {
  private from: WorldPos | undefined;
  private to: WorldPos | undefined;
  private t0 = 0;
  constructor(readonly ms = SMOOTH_MS) {}

  /** A new target at `now` (`undefined`: gone). Returns whether there is motion to animate. */
  set(to: WorldPos | undefined, now: number): boolean {
    if (!to) {
      this.from = this.to = undefined;
      return false;
    }
    const cur = this.at(now);
    this.to = { x: to.x, y: to.y };
    // First sight snaps: there is no "from" to glide in from.
    this.from = cur ?? this.to;
    this.t0 = now;
    return cur !== undefined && (cur.x !== to.x || cur.y !== to.y);
  }

  /** Where it is shown at `now`. */
  at(now: number): WorldPos | undefined {
    const { from, to } = this;
    if (!to || !from) return to;
    const a = (now - this.t0) / this.ms;
    if (a >= 1) return to;
    const k = Math.max(0, a);
    return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
  }

  /** Whether it has arrived (no frame to draw). */
  done(now: number): boolean {
    return !this.to || now - this.t0 >= this.ms;
  }
}

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/** How long heroes glide from one scene's positions to the next's when the scene flips. */
export const FLIP_MS = 350;

/**
 * `target`, eased over `ms` with requestAnimationFrame. Call inside a component or root. With
 * `on`, it glides only when `on()` changed since the last target (a scene flip), and otherwise
 * follows the target exactly.
 */
export function smoothed(target: () => WorldPos | undefined, ms = SMOOTH_MS, on?: () => unknown): () => WorldPos | undefined {
  const g = new Glide(ms);
  const [pos, setPos] = createSignal<WorldPos | undefined>();
  let raf = 0;
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  const tick = () => {
    const now = performance.now();
    setPos(g.at(now));
    raf = g.done(now) ? 0 : requestAnimationFrame(tick);
  };
  let key: unknown = on?.();
  createComputed(() => {
    const t = target();
    const to = t ? { x: t.x, y: t.y } : undefined; // read x and y: a store may update them in place
    const k = on?.();
    untrack(() => {
      const now = performance.now();
      const changed = k !== key;
      key = k;
      // A hidden tab draws no frames, so it takes the target as is.
      if (hidden() || (on && !changed)) g.set(undefined, now);
      const moving = g.set(to, now);
      setPos(g.at(now));
      if (moving && !raf) raf = requestAnimationFrame(tick);
      else if (!moving) stop();
    });
  });
  onCleanup(stop);
  return pos;
}

/**
 * Changing values ease (spec §4a): the curve and duration every value shown from the match or the
 * data eases with, the same as CSS's `--ease-out-expo` and `--value-ease-ms` (styles/app.css).
 */
export const VALUE_EASE_MS = 350;
/** https://easings.net/#easeOutExpo */
export const easeOutExpo = (x: number): number => (x >= 1 ? 1 : x <= 0 ? 0 : 1 - Math.pow(2, -10 * x));

/** The pure part of `easedNumber`: a number easing out-expo from where it's shown to its target. */
export class NumberEase {
  private from: number | null = null;
  private to: number | null = null;
  private t0 = 0;
  constructor(readonly ms = VALUE_EASE_MS) {}

  /** A new target at `now` (`null`: none; the next one then snaps). With `snap`, it jumps there.
   *  Returns whether there is motion to animate. */
  set(to: number | null, now: number, snap = false): boolean {
    // The same target again (a source re-read with no change) keeps the ease it's on.
    if (to === this.to && !snap) return !this.done(now);
    const cur = this.at(now);
    this.to = to;
    this.from = to === null || cur === null || snap ? to : cur;
    this.t0 = now;
    return this.from !== this.to;
  }

  at(now: number): number | null {
    const { from, to } = this;
    if (to === null || from === null) return to;
    return from + (to - from) * easeOutExpo((now - this.t0) / this.ms);
  }

  done(now: number): boolean {
    return this.to === null || this.from === this.to || now - this.t0 >= this.ms;
  }
}

/** The query, made once: every eased value asks on every change, many each frame while a replay
 * plays (#39), and its `matches` follows the setting. */
let motionQuery: MediaQueryList | undefined;
const reducedMotion = () => typeof matchMedia !== "undefined" && (motionQuery ??= matchMedia("(prefers-reduced-motion: reduce)")).matches;

/**
 * `source`, eased out-expo over `ms` with requestAnimationFrame: for a changing value drawn as a
 * number or as geometry CSS can't transition (a counter, a countdown, a path). Round for display
 * from the eased value. The first value, one after `null`, a hidden tab and reduced motion jump.
 * Call inside a component or root.
 */
export function easedNumber(source: () => number | null | undefined, ms = VALUE_EASE_MS): () => number | null {
  const e = new NumberEase(ms);
  const [v, setV] = createSignal<number | null>(null);
  let raf = 0;
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  const tick = () => {
    const now = performance.now();
    setV(e.at(now));
    raf = e.done(now) ? 0 : requestAnimationFrame(tick);
  };
  createComputed(() => {
    const to = source() ?? null;
    untrack(() => {
      const now = performance.now();
      const moving = e.set(to, now, hidden() || reducedMotion());
      setV(e.at(now));
      if (moving && !raf) raf = requestAnimationFrame(tick);
      else if (!moving) stop();
    });
  });
  onCleanup(stop);
  return v;
}
