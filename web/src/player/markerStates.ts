// What the map's markers show, by marker key (Board.tsx → MapView): each one's status, health,
// camp state and buff, read from the frame's `marker(key)` in both modes (map-state spec §6). Held
// in memos that change only when a value does, so the map's markers redraw when the match changes
// (#39); the fields they read are the second's in Player, new once a second.

import { createMemo } from "solid-js";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { MapState } from "../mapstate/state";
import { effectiveCamp, effectivePowerup } from "./Camps";

/** Whether two maps hold the same values by the same keys. */
export function sameEntries<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v || (v === undefined && !b.has(k))) return false;
  return true;
}

/** What the markers read: the frame, whether it is Player's, and the viewer's Health. */
export interface MarkerFrame {
  ms: () => MapState;
  player: () => boolean;
  health: () => boolean;
}

/** `keys`: the map's marker keys. Call inside a component or root. */
export function markerStates(frame: MarkerFrame, keys: () => readonly string[]) {
  const statusNow = (k: string): ObjectiveStatus | undefined => {
    const m = frame.ms().marker(k);
    // A shop is up on a board; in Player (or a scene with `has_camps`) a lane shop is gone once its guardian falls.
    if (k.startsWith("shop:")) return m.shopClosed() ? "Hidden" : undefined;
    // In a scene, stored status wins over baseline detail (map-state spec §5, plan §4).
    if (!frame.player()) {
      const own = m.status();
      if (own !== undefined) return own;
      const site = m.site();
      if (site) return site;
      const c = m.camp();
      if (c) return c.state === "alive" ? "Active" : "Destroyed";
      return m.health()?.stage === 2 ? "Stage2" : undefined;
    }
    // Player shows the match at t (spec §6b), with paused `liveScene` ObjectiveState overrides
    // taking precedence when present (fromTimeline always returns `status() === undefined`).
    const own = m.status();
    if (own !== undefined) return own;
    const site = m.site();
    if (site) return site;
    if (k.startsWith("rift:") || k.startsWith("urn:")) return "Destroyed";
    if (m.down()) return "Destroyed";
    // The patron's stage from the replay: its shield (stage 1) or its core (stage 2),
    // independent of the viewer's Health toggle (TD-100).
    return m.health()?.stage === 2 ? "Stage2" : "Active";
  };
  /** Each marker's value, for the markers that have one. */
  const valuesOf = <W,>(pick: (m: ReturnType<MapState["marker"]>) => W | undefined) => {
    const out = new Map<string, W>();
    for (const k of keys()) {
      const w = pick(frame.ms().marker(k));
      if (w !== undefined) out.set(k, w);
    }
    return out;
  };
  const statuses = createMemo(() => new Map(keys().map((k) => [k, statusNow(k)] as const)), undefined, { equals: sameEntries });
  const health = createMemo(() => valuesOf((m) => (frame.health() && !m.down() ? m.health()?.pct : undefined)), undefined, { equals: sameEntries });
  const camps = createMemo(() => valuesOf((m) => {
    const own = m.status();
    const base = m.camp();
    const eff = effectiveCamp(own, base);
    if (eff) return eff.state;
    return own === "Active" && base ? "alive" : undefined;
  }), undefined, { equals: sameEntries });
  const buffs = createMemo(() => valuesOf((m) => {
    const b = effectivePowerup(m.status(), m.powerup());
    return b?.state === "up" ? b.buff : undefined;
  }), undefined, { equals: sameEntries });
  return {
    /** A key off the map (none is asked today) is read from the frame itself. */
    status: (k: string) => {
      const s = statuses();
      return s.has(k) ? s.get(k) : statusNow(k);
    },
    health: (k: string) => health().get(k),
    camp: (k: string) => camps().get(k),
    buff: (k: string) => buffs().get(k),
  };
}
