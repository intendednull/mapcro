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
  return m.kind === "koth" ? s === "Active" : s === undefined || s === "Active" || s === "Stage2";
}

/** The Patron's two stages (operator, 2026-11-07): a click goes stage 1 → stage 2 → destroyed
 * → stage 1. */
export function nextPatron(s: ObjectiveStatus | undefined): ObjectiveStatus {
  return s === undefined || s === "Active" || s === "Hidden" ? "Stage2" : s === "Stage2" ? "Destroyed" : "Active";
}

export function toggleOps(m: Pick<Marker, "kind" | "key">, markers: Array<Pick<Marker, "kind" | "key">>, cur: Current, scene: RecordId, mint: () => RecordId): Op[] {
  const set = (key: string, status: ObjectiveStatus): Op[] => {
    const c = cur.get(key);
    if (c) return c.status === status ? [] : [{ Set: { id: c.id, value: { ObjectiveStatus: status } } }];
    return [{ Create: { id: mint(), record: { ObjectiveState: { scene, key, status } } } }];
  };
  const on = isOn(m, cur);
  if (m.kind === "t3") return set(m.key, nextPatron(cur.get(m.key)?.status));
  if (m.kind !== "koth") return set(m.key, on ? "Destroyed" : "Active");
  if (on) return set(m.key, "Destroyed");
  // Only one rift at a time: the others go off with this one coming on.
  const others = markers.filter((x) => x.kind === "koth" && x.key !== m.key && isOn(x, cur)).flatMap((x) => set(x.key, "Destroyed"));
  return [...set(m.key, "Active"), ...others];
}

type M = Pick<Marker, "kind" | "key">;

/**
 * A group of selected objectives toggled by clicking one of them (operator, 2026-11-07): the
 * clicked one sets the direction (on → all off, off → all on), so the group ends uniform. Rifts
 * keep their rule: at most one is on, so turning a group on turns on only the clicked rift (or,
 * if a non-rift was clicked, the group's first), and any other rift that is on goes off.
 */
export function groupToggleOps(clicked: M, group: M[], markers: M[], cur: Current, scene: RecordId, mint: () => RecordId): Op[] {
  const set = (key: string, status: ObjectiveStatus): Op[] => {
    const c = cur.get(key);
    if (c) return c.status === status ? [] : [{ Set: { id: c.id, value: { ObjectiveStatus: status } } }];
    // Absent means the default: on for objectives, off for rifts. Writing the default is a no-op.
    const kind = markers.find((m) => m.key === key)?.kind ?? group.find((m) => m.key === key)?.kind;
    if ((kind === "koth" && status === "Destroyed") || (kind !== "koth" && status === "Active")) return [];
    return [{ Create: { id: mint(), record: { ObjectiveState: { scene, key, status } } } }];
  };
  const turnOn = !isOn(clicked, cur);
  const ops: Op[] = [];
  if (!turnOn) {
    for (const m of group) ops.push(...set(m.key, "Destroyed"));
    return ops;
  }
  const rifts = group.filter((m) => m.kind === "koth");
  const lit = clicked.kind === "koth" ? clicked : rifts[0];
  for (const m of group) if (m.kind !== "koth") ops.push(...set(m.key, "Active"));
  if (lit) {
    ops.push(...set(lit.key, "Active"));
    for (const r of markers.filter((x) => x.kind === "koth" && x.key !== lit.key)) ops.push(...set(r.key, "Destroyed"));
  }
  return ops;
}

/**
 * What a Move drag-select picks up: heroes inside win; with none, every objective inside.
 * Points are in the same space as the rectangle.
 */
export function marqueePick<H extends { id: string; at: { x: number; y: number } }>(
  rect: { x0: number; y0: number; x1: number; y1: number },
  heroes: H[],
  objectives: Array<{ key: string; at: { x: number; y: number } }>,
): { heroes: string[]; objectives: string[] } {
  const inside = (p: { x: number; y: number }) => p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1;
  const hs = heroes.filter((h) => inside(h.at)).map((h) => h.id);
  if (hs.length) return { heroes: hs, objectives: [] };
  return { heroes: [], objectives: objectives.filter((o) => inside(o.at)).map((o) => o.key) };
}
