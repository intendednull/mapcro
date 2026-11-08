// Scene edits as single transactions (one gesture, one undo step).

import { keyBetween } from "../core/order";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import type { Scene } from "../gen/Scene";
import { newRecordId } from "../wasm/mapcro_wasm.js";
import { canNest } from "./tree";
import type { BoardState } from "./state";

export interface SceneRow {
  id: RecordId;
  scene: Scene;
}

/**
 * An unnamed scene is shown as "Scene N" by its place in the list, so a reorder never leaves
 * "Scene 4" first. New scenes are stored unnamed (""); a stored name that is exactly
 * "Scene <number>" (older boards) counts as unnamed too.
 */
export const isUnnamed = (name: string) => /^(Scene \d+)?$/.test(name.trim());
/** The name to show for the scene at `index` (0-based) in the list. */
export const sceneName = (name: string, index: number) => (isUnnamed(name) ? `Scene ${index + 1}` : name);

/** The scenes as a tree: each scene's effective parent, and the depth-first order. */
function treeOf(state: BoardState) {
  const rows = state.sceneTree();
  const parentOf = new Map(rows.map((r) => [r.scene.id, r.parent]));
  const kids = (p: RecordId | null) => rows.filter((r) => r.parent === p).map((r) => r.scene);
  return { rows, parentOf, kids };
}

/**
 * A new scene after `from` (its next sibling) or as its last child, starting from its positions,
 * objectives and lane splits (the next frame of a play usually starts where the last one
 * ended). Ink, arrows and callouts stay.
 */
export function addSceneOps(state: BoardState, from: SceneRow | undefined, asChild = false, mint = newRecordId, name = ""): { id: RecordId; ops: Op[] } {
  const { parentOf, kids } = treeOf(state);
  const parent = from ? (asChild ? from.id : (parentOf.get(from.id) ?? null)) : null;
  const sibs = kids(parent);
  const i = asChild || !from ? sibs.length - 1 : sibs.findIndex((s) => s.id === from.id);
  const lo = sibs[i]?.scene.order;
  const hi = sibs[i + 1]?.scene.order;
  const id = mint();
  const ops: Op[] = [
    {
      Create: {
        id,
        record: { Scene: { name, order: keyBetween(lo, hi), clock: from?.scene.clock ?? null, ...(parent ? { parent } : {}) } },
      },
    },
  ];
  const src = from?.id;
  for (const [, e] of Object.entries(state.records)) {
    if (e.deleted) continue;
    const r = e.record;
    if ("PlayerState" in r && r.PlayerState.scene === src) ops.push({ Create: { id: mint(), record: { PlayerState: { ...r.PlayerState, scene: id } } } });
    if ("Wave" in r && r.Wave.scene === src) ops.push({ Create: { id: mint(), record: { Wave: { ...r.Wave, scene: id } } } });
    if ("ObjectiveState" in r && r.ObjectiveState.scene === src)
      ops.push({ Create: { id: mint(), record: { ObjectiveState: { ...r.ObjectiveState, scene: id } } } });
  }
  return { id, ops };
}

/**
 * A dropped scene row, as one transaction: before or after `target` (its sibling, same parent),
 * or into it (its last child). Nothing if it would nest a scene under itself or a descendant,
 * or if it lands where it was.
 */
export function moveSceneOps(state: BoardState, moved: RecordId, target: RecordId, where: "before" | "after" | "into"): Op[] {
  const { rows, parentOf, kids } = treeOf(state);
  const parent = where === "into" ? target : (parentOf.get(target) ?? null);
  const flat = rows.map((r) => ({ id: r.scene.id, order: r.scene.scene.order, parent: r.parent }));
  if (!canNest(flat, moved, parent)) return [];
  const sibs = kids(parent).filter((s) => s.id !== moved);
  let at = sibs.length;
  if (where !== "into") {
    const t = sibs.findIndex((s) => s.id === target);
    at = where === "before" ? t : t + 1;
  }
  const order = keyBetween(sibs[at - 1]?.scene.order, sibs[at]?.scene.order);
  const ops: Op[] = [];
  const was = parentOf.get(moved) ?? null;
  if (was !== parent) ops.push({ Set: { id: moved, value: { SceneParent: parent } } });
  const before = kids(parent);
  const same = was === parent && before.findIndex((s) => s.id === moved) === at;
  if (!same) ops.push({ Set: { id: moved, value: { SceneOrder: order } } });
  return ops;
}

/** Delete a scene; its children move up to its parent (keeping their order), in one step. */
export function deleteSceneOps(state: BoardState, id: RecordId): Op[] {
  const { parentOf, kids } = treeOf(state);
  if (!parentOf.has(id) || state.scenes().length <= 1) return [];
  const up = parentOf.get(id) ?? null;
  return [...kids(id).map((c): Op => ({ Set: { id: c.id, value: { SceneParent: up } } })), { Delete: { id } }];
}
/** Move `moved` to position `to` (in the list without it): one SceneOrder set. */
export function reorderOp(scenes: SceneRow[], moved: RecordId, to: number): Op | undefined {
  const rest = scenes.filter((s) => s.id !== moved);
  const at = Math.max(0, Math.min(rest.length, to));
  const lo = rest[at - 1]?.scene.order;
  const hi = rest[at]?.scene.order;
  if (scenes.findIndex((s) => s.id === moved) === at) return undefined; // dropped where it was
  return { Set: { id: moved, value: { SceneOrder: keyBetween(lo, hi) } } };
}
