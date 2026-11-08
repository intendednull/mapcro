// Remote motion, smoothed at render time (perf report 2026-11-07, finding 3). Others' drags and
// cursors arrive in presence batches about every 50 ms, unevenly; drawn as they land they step.
// A Glide eases from where the value is shown now to its latest target over SMOOTH_MS, so the
// motion is continuous and trails the sender by about that much. Nothing here touches the data:
// records, presence and what is sent stay exact.

import { createComputed, createSignal, onCleanup, untrack } from "solid-js";
import type { WorldPos } from "../gen/WorldPos";

export const SMOOTH_MS = 100;

/**
 * The pure part: a position easing linearly toward its latest target. The ease's clock starts at
 * the first frame drawn after a new target, not when the target arrived: a page that stalls (a
 * loaded box, a long task) then still shows the glide after the stall instead of jumping to the
 * end, at the cost of trailing by up to one more frame.
 */
export class Glide {
  private from: WorldPos | undefined;
  private to: WorldPos | undefined;
  private t0 = 0;
  /** A new target no frame has drawn yet: shown at `from` until `frame` starts the clock. */
  private pending = false;
  constructor(readonly ms = SMOOTH_MS) {}

  /** A new target at `now` (`undefined`: gone). Returns whether there is motion to animate. */
  set(to: WorldPos | undefined, now: number): boolean {
    if (!to) {
      this.from = this.to = undefined;
      this.pending = false;
      return false;
    }
    const cur = this.at(now);
    this.to = { x: to.x, y: to.y };
    // First sight snaps: there is no "from" to glide in from.
    this.from = cur ?? this.to;
    this.t0 = now;
    this.pending = cur !== undefined && (cur.x !== to.x || cur.y !== to.y);
    return this.pending;
  }

  /** Where a frame drawn at `now` shows it; the first frame after a new target starts its ease. */
  frame(now: number): WorldPos | undefined {
    if (this.pending) {
      this.pending = false;
      this.t0 = now;
    }
    return this.at(now);
  }

  /** Where it is shown at `now`. */
  at(now: number): WorldPos | undefined {
    const { from, to } = this;
    if (!to || !from) return to;
    if (this.pending) return from;
    const a = (now - this.t0) / this.ms;
    if (a >= 1) return to;
    const k = Math.max(0, a);
    return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
  }

  /** Whether it has arrived (no frame to draw). */
  done(now: number): boolean {
    return !this.to || (!this.pending && now - this.t0 >= this.ms);
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
    setPos(g.frame(now));
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
