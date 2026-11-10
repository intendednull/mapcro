// Vision fades in Player (spec §6b "Vision"): an enemy hero coming into a team's sight fades in,
// one leaving it fades out where it was last drawn, and so does the urn it carries. Only the
// transition: what is drawn when is the host's (player/host.ts), and a break in playback (a seek,
// a scrub, a view switch) snaps. Timed like every eased value (styles/app.css): `--value-ease-ms`
// on `--ease-out-expo`, 0 ms under reduced motion, where nothing fades.

import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";

/** The app's eased-value timing, read from the CSS (0 ms: reduced motion, jump). */
export function fadeTiming(): { ms: number; easing: string } {
  if (typeof document === "undefined") return { ms: 0, easing: "linear" };
  const s = getComputedStyle(document.documentElement);
  // "350ms" as written, or "0.35s" where the property is registered as a <time>.
  const v = s.getPropertyValue("--value-ease-ms").trim();
  const ms = (parseFloat(v) || 0) * (v.endsWith("ms") ? 1 : v.endsWith("s") ? 1000 : 1);
  return { ms, easing: s.getPropertyValue("--ease-out-expo").trim() || "ease-out" };
}

const fades = new WeakMap<Element, Animation>();

/** Stop any fade on `el`: it shows at full opacity again. */
export function stopFade(el: Element | undefined) {
  if (!el) return;
  fades.get(el)?.cancel();
  fades.delete(el);
}

/**
 * Fade `el`'s opacity to `to`, from where a fade in progress has it (a quick out-and-back never
 * flashes), else from the other end; one fade per element, so they never pile up. `done` runs
 * once it has finished, never if it's replaced or stopped. Undefined, and nothing runs, with no
 * time to fade.
 */
export function fadeTo(el: Element, to: 0 | 1, done?: () => void): Animation | undefined {
  const { ms, easing } = fadeTiming();
  const cur = fades.get(el);
  const from = cur ? Number(getComputedStyle(el).opacity) : 1 - to;
  stopFade(el);
  if (ms <= 0) return undefined;
  const a = el.animate([{ opacity: from }, { opacity: to }], { duration: ms * Math.abs(to - from), easing, fill: "forwards" });
  fades.set(el, a);
  a.onfinish = () => {
    if (fades.get(el) !== a) return;
    fades.delete(el);
    // A finished fade-in leaves nothing behind; a fade-out holds 0 until `done` removes it.
    if (to === 1) a.cancel();
    done?.();
  };
  return a;
}

/**
 * What to draw of something vision can hide: `value()`, or, for the fade after it went out of
 * sight on continuous playback, its last value (`leaving()`). It fades in when it comes back
 * into sight. `hidden()`: whether its absence now is vision's (anything else, a death, the end
 * of a carry, snaps); `smooth()`: whether this moment continues the last in playback. `el()`:
 * the element drawn, for the fade. A memo, not an effect: whatever shows `shown()` reads it
 * already settled, so the element is never unmounted and remounted on its way out.
 */
export function visionFade<T>(o: { value: Accessor<T | undefined>; hidden: Accessor<boolean>; smooth: Accessor<boolean>; el: Accessor<Element | undefined> }) {
  interface S {
    value: T | undefined;
    /** Its last value, fading out (`id`: this fade's). */
    held: T | undefined;
    id: number;
    /** Out of sight now (vision's), so its return fades in. */
    hidden: boolean;
    /** What this change does to the element, once drawn. */
    fade?: "in" | "out" | "stop" | undefined;
  }
  const [finished, setFinished] = createSignal(0);
  const s = createMemo<S>(
    (p) => {
      const value = o.value();
      const smooth = o.smooth();
      const hidden = value === undefined && o.hidden();
      const base = { value, held: undefined, id: p.id, hidden };
      if (value !== undefined) {
        const back = p.value === undefined && (p.hidden || p.held !== undefined);
        return { ...base, fade: back && smooth ? "in" : smooth ? undefined : "stop" };
      }
      if (p.held !== undefined)
        // Still going, unless it's done or broken off (a seek, a death mid-fade): gone at once.
        return finished() === p.id || !smooth || !hidden ? { ...base, fade: "stop" } : { ...base, held: p.held };
      if (p.value !== undefined && hidden && smooth && fadeTiming().ms > 0) return { ...base, held: p.value, id: p.id + 1, fade: "out" };
      return base;
    },
    { value: undefined, held: undefined, id: 0, hidden: false },
  );
  createEffect(
    on(s, (x) => {
      const el = o.el();
      if (!el || !x.fade) return;
      if (x.fade === "in") fadeTo(el, 1);
      else if (x.fade === "out") fadeTo(el, 0, () => setFinished(x.id));
      else stopFade(el);
    }),
  );
  onCleanup(() => stopFade(o.el()));
  const shown = () => s().value ?? s().held;
  const leaving = () => s().value === undefined && s().held !== undefined;
  return { shown, leaving };
}
