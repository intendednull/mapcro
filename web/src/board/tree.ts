// Scenes as a tree (operator, 2026-11-07): a scene may nest under another (`Scene.parent`), the
// order key orders siblings, and flipping walks the tree depth-first. Pure, so it's unit-tested.

import type { RecordId } from "../gen/RecordId";

export interface TreeScene {
  id: RecordId;
  order: string;
  parent: RecordId | null | undefined;
}

/** A parent that isn't a live scene (deleted, or never was) is resolved through `up`: a deleted
 * scene's own parent, recursively; otherwise the root. */
export type Up = (id: RecordId) => RecordId | null | undefined;

const byOrder = (a: TreeScene, b: TreeScene) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Each live scene's effective parent: a live scene, or null (root). Cycles break at the root. */
export function parents(scenes: TreeScene[], up: Up = () => null): Map<RecordId, RecordId | null> {
  const live = new Map(scenes.map((s) => [s.id, s]));
  const out = new Map<RecordId, RecordId | null>();
  for (const s of scenes) {
    let p = s.parent ?? null;
    const seen = new Set<RecordId>([s.id]);
    // Through deleted scenes to the nearest live ancestor.
    while (p !== null && !live.has(p)) {
      if (seen.has(p)) {
        p = null;
        break;
      }
      seen.add(p);
      p = up(p) ?? null;
    }
    out.set(s.id, p);
  }
  // A cycle (only possible from concurrent edits): break it at its smallest id, which goes to
  // the root, so every client breaks it the same way.
  for (const s of scenes) {
    const path: RecordId[] = [];
    let p: RecordId | null = s.id;
    while (p !== null && !path.includes(p)) {
      path.push(p);
      p = out.get(p) ?? null;
    }
    if (p !== null) {
      const cycle = path.slice(path.indexOf(p));
      out.set(cycle.reduce((a, b) => (b < a ? b : a)), null);
    }
  }
  return out;
}

export interface TreeRow<S extends TreeScene> {
  scene: S;
  depth: number;
  parent: RecordId | null;
  hasChildren: boolean;
}

/** Depth-first, siblings by order key: the order rows are listed and ← → flip. */
export function flatten<S extends TreeScene>(scenes: S[], up?: Up): TreeRow<S>[] {
  const par = parents(scenes, up);
  const kids = new Map<RecordId | null, S[]>();
  for (const s of scenes) {
    const p = par.get(s.id) ?? null;
    kids.set(p, [...(kids.get(p) ?? []), s]);
  }
  for (const list of kids.values()) list.sort(byOrder);
  const out: TreeRow<S>[] = [];
  const walk = (p: RecordId | null, depth: number) => {
    for (const s of kids.get(p) ?? []) {
      out.push({ scene: s, depth, parent: p, hasChildren: (kids.get(s.id)?.length ?? 0) > 0 });
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The rows shown with some scenes collapsed: their descendants are hidden. */
export function visibleRows<R extends { scene: { id: RecordId }; depth: number; hasChildren: boolean }>(rows: R[], collapsed: Set<RecordId>): R[] {
  const out: R[] = [];
  let hideBelow: number | undefined;
  for (const r of rows) {
    if (hideBelow !== undefined && r.depth > hideBelow) continue;
    hideBelow = undefined;
    out.push(r);
    if (collapsed.has(r.scene.id) && r.hasChildren) hideBelow = r.depth;
  }
  return out;
}

/** Whether `id` may nest under `parent`: not itself, and not one of its own descendants. */
export function canNest(scenes: TreeScene[], id: RecordId, parent: RecordId | null, up?: Up): boolean {
  if (parent === null) return true;
  if (parent === id) return false;
  const par = parents(scenes, up);
  let p: RecordId | null = parent;
  const seen = new Set<RecordId>();
  while (p !== null && !seen.has(p)) {
    if (p === id) return false;
    seen.add(p);
    p = par.get(p) ?? null;
  }
  return true;
}
