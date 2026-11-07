// What a click on an objective does (operator, 2026-11-07): it flips between active and
// destroyed (camps: alive and cleared). Rifts are off unless turned on, and at most one is on:
// turning one on turns the others off in the same transaction. Pure, so it's unit-tested.

import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import type { Marker } from "../map/model";

export type Current = Map<string, { id: RecordId; status: ObjectiveStatus }>;

/** Whether a marker is "on" (active, alive) in a scene. Rifts default to off; the rest to on. */
export function isOn(m: Pick<Marker, "kind" | "key">, cur: Current): boolean {
  const s = cur.get(m.key)?.status;
  return m.kind === "koth" ? s === "Active" : s === undefined || s === "Active";
}

export function toggleOps(m: Pick<Marker, "kind" | "key">, markers: Array<Pick<Marker, "kind" | "key">>, cur: Current, scene: RecordId, mint: () => RecordId): Op[] {
  const set = (key: string, status: ObjectiveStatus): Op[] => {
    const c = cur.get(key);
    if (c) return c.status === status ? [] : [{ Set: { id: c.id, value: { ObjectiveStatus: status } } }];
    return [{ Create: { id: mint(), record: { ObjectiveState: { scene, key, status } } } }];
  };
  const on = isOn(m, cur);
  if (m.kind !== "koth") return set(m.key, on ? "Destroyed" : "Active");
  if (on) return set(m.key, "Destroyed");
  // Only one rift at a time: the others go off with this one coming on.
  const others = markers.filter((x) => x.kind === "koth" && x.key !== m.key && isOn(x, cur)).flatMap((x) => set(x.key, "Destroyed"));
  return [...set(m.key, "Active"), ...others];
}
