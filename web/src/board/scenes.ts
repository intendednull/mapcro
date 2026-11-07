// Scene edits as single transactions (one gesture, one undo step).

import { keyBetween } from "../core/order";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import type { Scene } from "../gen/Scene";
import { newRecordId } from "../wasm/mapcro_wasm.js";
import type { BoardState } from "./state";

export interface SceneRow {
  id: RecordId;
  scene: Scene;
}

/**
 * A new scene right after `after`, starting from its positions and objectives (the next frame
 * of a play usually starts where the last one ended). Ink, arrows and callouts stay behind.
 */
export function addSceneOps(state: BoardState, scenes: SceneRow[], after: SceneRow | undefined, mint = newRecordId): { id: RecordId; ops: Op[] } {
  const i = after ? scenes.findIndex((s) => s.id === after.id) : scenes.length - 1;
  const lo = scenes[i]?.scene.order;
  const hi = scenes[i + 1]?.scene.order;
  const id = mint();
  const ops: Op[] = [
    { Create: { id, record: { Scene: { name: `Scene ${scenes.length + 1}`, order: keyBetween(lo, hi), clock: after?.scene.clock ?? null } } } },
  ];
  const from = after?.id;
  for (const [, e] of Object.entries(state.records)) {
    if (e.deleted) continue;
    const r = e.record;
    if ("PlayerState" in r && r.PlayerState.scene === from) ops.push({ Create: { id: mint(), record: { PlayerState: { ...r.PlayerState, scene: id } } } });
    if ("ObjectiveState" in r && r.ObjectiveState.scene === from)
      ops.push({ Create: { id: mint(), record: { ObjectiveState: { ...r.ObjectiveState, scene: id } } } });
  }
  return { id, ops };
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
