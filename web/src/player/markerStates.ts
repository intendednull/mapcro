// What the map's markers show from the match at playback time t, by marker key (Board.tsx →
// MapView): each one's status, health, camp state and buff. The preview is new on every frame of
// playback, while these change only when the match does: held in memos that change only when a
// value does, so the map's markers redraw then, not on every frame (#39).

import { createMemo } from "solid-js";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { MatchPreview } from "../match/preview";

/** Whether two maps hold the same values by the same keys. */
export function sameEntries<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v || (v === undefined && !b.has(k))) return false;
  return true;
}

function valuesOf<V, W>(src: ReadonlyMap<string, V> | undefined, pick: (v: V) => W | undefined): Map<string, W> {
  const out = new Map<string, W>();
  if (src) for (const [k, v] of src) {
    const w = pick(v);
    if (w !== undefined) out.set(k, w);
  }
  return out;
}

/**
 * `preview`: the match at t (none outside Player). `keys`: the map's marker keys. `own`: a
 * marker's state in the scene, which is what it shows outside Player. Call inside a component or
 * root.
 */
export function markerStates(preview: () => MatchPreview | undefined, keys: () => readonly string[], own: (key: string) => ObjectiveStatus | undefined) {
  const statusNow = (k: string): ObjectiveStatus | undefined => {
    const pv = preview();
    // A shop is up on a board; in Player a lane shop is gone once its guardian falls.
    if (k.startsWith("shop:")) return pv?.shops?.has(k) ? "Hidden" : undefined;
    // Player shows only the match at t (spec §6b): what was down, and from a replay
    // the rifts and powerups; never the scene's states. Without a replay, rifts are off.
    if (!pv) return own(k);
    const site = pv.sites.get(k);
    if (site) return site;
    if (k.startsWith("rift:") || k.startsWith("urn:")) return "Destroyed";
    if (pv.down.has(k)) return "Destroyed";
    // The patron's stage from the replay: its shield (stage 1) or its core (stage 2).
    return pv.health?.get(k)?.stage === 2 ? "Stage2" : "Active";
  };
  const statuses = createMemo(() => new Map(keys().map((k) => [k, statusNow(k)] as const)), undefined, { equals: sameEntries });
  const health = createMemo(() => valuesOf(preview()?.health, (h) => h.pct), undefined, { equals: sameEntries });
  const camps = createMemo(() => valuesOf(preview()?.camps, (c) => c.state), undefined, { equals: sameEntries });
  const buffs = createMemo(() => valuesOf(preview()?.powerups, (b) => (b.state === "up" ? b.buff : undefined)), undefined, { equals: sameEntries });
  return {
    /** A key off the map (none is asked today) is read from the preview itself. */
    status: (k: string) => {
      const s = statuses();
      return s.has(k) ? s.get(k) : statusNow(k);
    },
    health: (k: string) => health().get(k),
    camp: (k: string) => camps().get(k),
    buff: (k: string) => buffs().get(k),
  };
}
