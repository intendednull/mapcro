// What a click on an objective does (operator, 2026-11-07): it flips between active and
// destroyed (camps: alive and cleared). Rifts are off unless turned on, and at most one is on:
// turning one on turns the others off in the same transaction. The Soul Urn's delivery points
// work the same way (one open at a time). Pure, so it's unit-tested.

import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import { type Marker, offByDefault } from "../map/model";

export type Current = Map<string, { id: RecordId; status: ObjectiveStatus }>;
export type ShownStatus = (key: string) => ObjectiveStatus | undefined;

/** Whether a marker is "on" (active, alive) in a scene. Rifts and urn points default to off;
 * the rest to on. `shown` supplies the effective status (`ObjectiveState ?? baseline detail`). */
export function isOn(m: Pick<Marker, "kind" | "key">, cur: Current, shown?: ShownStatus): boolean {
  const s = shown ? shown(m.key) : cur.get(m.key)?.status;
  return offByDefault(m.kind) ? s === "Active" : s === undefined || s === "Active" || s === "Stage2";
}

/** The Patron's two stages (operator, 2026-11-07): a click goes stage 1 → stage 2 → destroyed
 * → stage 1. */
export function nextPatron(s: ObjectiveStatus | undefined): ObjectiveStatus {
  return s === undefined || s === "Active" || s === "Hidden" ? "Stage2" : s === "Stage2" ? "Destroyed" : "Active";
}

export function toggleOps(
  m: Pick<Marker, "kind" | "key">,
  markers: Array<Pick<Marker, "kind" | "key">>,
  cur: Current,
  scene: RecordId,
  mint: () => RecordId,
  shown?: ShownStatus,
): Op[] {
  const statusOf: ShownStatus = shown ?? ((k) => cur.get(k)?.status);
  const set = (key: string, status: ObjectiveStatus): Op[] => {
    const c = cur.get(key);
    if (c) return c.status === status ? [] : [{ Set: { id: c.id, value: { ObjectiveStatus: status } } }];
    return [{ Create: { id: mint(), record: { ObjectiveState: { scene, key, status } } } }];
  };
  const on = isOn(m, cur, statusOf);
  if (m.kind === "t3") return set(m.key, nextPatron(statusOf(m.key)));
  if (!offByDefault(m.kind)) return set(m.key, on ? "Destroyed" : "Active");
  if (on) return set(m.key, "Destroyed");
  // Only one rift (one urn point) at a time: the others go off with this one coming on.
  const others = markers.filter((x) => x.kind === m.kind && x.key !== m.key && isOn(x, cur, statusOf)).flatMap((x) => set(x.key, "Destroyed"));
  return [...set(m.key, "Active"), ...others];
}

type M = Pick<Marker, "kind" | "key">;

/**
 * A group of selected objectives toggled by clicking one of them (operator, 2026-11-07): the
 * clicked one sets the direction (on → all off, off → all on), so the group ends uniform. Rifts
 * keep their rule: at most one is on, so turning a group on turns on only the clicked rift (or,
 * if a non-rift was clicked, the group's first), and any other rift that is on goes off.
 */
export function groupToggleOps(
  clicked: M,
  group: M[],
  markers: M[],
  cur: Current,
  scene: RecordId,
  mint: () => RecordId,
  shown?: ShownStatus,
): Op[] {
  const statusOf: ShownStatus = shown ?? ((k) => cur.get(k)?.status);
  const set = (key: string, status: ObjectiveStatus): Op[] => {
    const c = cur.get(key);
    if (c) return c.status === status ? [] : [{ Set: { id: c.id, value: { ObjectiveStatus: status } } }];
    // Skip creating a record only when the effective status (`shown` or board default) already equals `status`.
    const kind = markers.find((m) => m.key === key)?.kind ?? group.find((m) => m.key === key)?.kind;
    const off = !!kind && offByDefault(kind);
    const eff = statusOf(key) ?? (off ? "Destroyed" : "Active");
    if (eff === status) return [];
    return [{ Create: { id: mint(), record: { ObjectiveState: { scene, key, status } } } }];
  };
  const turnOn = !isOn(clicked, cur, statusOf);
  const ops: Op[] = [];
  if (!turnOn) {
    for (const m of group) ops.push(...set(m.key, "Destroyed"));
    return ops;
  }
  for (const m of group) if (!offByDefault(m.kind)) ops.push(...set(m.key, "Active"));
  // Per one-at-a-time kind: the clicked one if it's of that kind, else the group's first.
  for (const kind of ["koth", "urn"] as const) {
    const lit = clicked.kind === kind ? clicked : group.find((m) => m.kind === kind);
    if (!lit) continue;
    ops.push(...set(lit.key, "Active"));
    for (const r of markers.filter((x) => x.kind === kind && x.key !== lit.key)) ops.push(...set(r.key, "Destroyed"));
  }
  return ops;
}

/**
 * What a Select drag-select picks up: heroes inside win; with none, every objective inside.
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
