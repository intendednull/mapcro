// One top-bar portrait's state at playback time t (PlayerTopBar.tsx): only what the bar draws,
// held in a memo that changes only when one of those values does. Playback moves t every frame,
// but the bar's values are the timeline's per-second samples, so a portrait redraws when a sample
// changes, not on every frame (#39: twelve portraits redrawn each frame kept the main thread busy
// while playing, and input waited behind it).

import { createMemo } from "solid-js";
import type { HeroState } from "../mapstate/state";

export interface BarSlot {
  hero_id: number;
  /** No position at t: dead. The bar draws no position, only this. */
  dead: boolean;
  souls: number | null;
  ult: number | null;
  health: number | null;
  /** While dead: seconds to respawn. The bar shows it rounded up, so a value is kept while that
   * rounding stays the same. */
  respawn: number | null;
}

/** What the bar reads of a hero. */
export type BarHero = Pick<HeroState, "present" | "hero" | "pos" | "souls" | "ult" | "health" | "respawn">;

export function barSlotOf(h: BarHero): BarSlot | undefined {
  return h.present() ? { hero_id: h.hero() ?? 0, dead: h.pos() === null, souls: h.souls(), ult: h.ult(), health: h.health(), respawn: h.respawn() } : undefined;
}

const shownRespawn = (s: number | null) => (s == null ? null : Math.ceil(s));

/** Whether the bar would draw `a` and `b` the same. */
export function sameBarSlot(a: BarSlot | undefined, b: BarSlot | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.hero_id === b.hero_id && a.dead === b.dead && a.souls === b.souls && a.ult === b.ult && a.health === b.health && shownRespawn(a.respawn) === shownRespawn(b.respawn);
}

/** The hero's bar state, as a memo that only changes with it. Call inside a component or root. */
export function barSlot(h: BarHero): () => BarSlot | undefined {
  return createMemo(() => barSlotOf(h), undefined, { equals: sameBarSlot });
}
