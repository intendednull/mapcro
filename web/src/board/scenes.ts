// Scene edits as single transactions (one gesture, one undo step).

import { keyBetween } from "../core/order";
import { LIMITS } from "../gen/limits";
import type { Op } from "../gen/Op";
import type { Record as Rec } from "../gen/Record";
import type { RecordId } from "../gen/RecordId";
import type { Scene } from "../gen/Scene";
import { chunkByBytes, fitsTx } from "../match/save";
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
 * ended). Ink, arrows, callouts and the note stay, unless `ink`: a copy of the scene takes
 * them too (#54).
 *
 * `ops` is the copy as one transaction; `txs` is what to send. They are the same unless the
 * copy is over a transaction's caps (twelve builds near a record's 8 KiB are 96 KiB). Then the
 * first transaction makes the scene and all its heroes, without their `more`: a scene with
 * fewer than every slot's hero is refused whole (`IncompleteScene`). Each hero's `more` follows
 * as sets, then the other records, and the scene's state last, so a scene never says it holds
 * builds that aren't written yet. That copy is more than one undo step.
 *
 * `full`: the board has no room for every record of the new scene (deleted records count
 * toward its cap too). Nothing is sent then (`txs` is empty): a copy sent in several
 * transactions would stop part way, and leave a scene with some of its ink (review F1 of RC1).
 */
export function addSceneOps(
  state: BoardState,
  from: SceneRow | undefined,
  asChild = false,
  mint = newRecordId,
  name = "",
  ink = false,
): { id: RecordId; ops: Op[]; txs: Op[][]; full: boolean } {
  const { parentOf, kids } = treeOf(state);
  const parent = from ? (asChild ? from.id : (parentOf.get(from.id) ?? null)) : null;
  const sibs = kids(parent);
  const i = asChild || !from ? sibs.length - 1 : sibs.findIndex((s) => s.id === from.id);
  const lo = sibs[i]?.scene.order;
  const hi = sibs[i + 1]?.scene.order;
  const id = mint();
  const scene: Op = {
    Create: {
      id,
      record: { Scene: { name, order: keyBetween(lo, hi), clock: from?.scene.clock ?? null, ...(parent ? { parent } : {}) } },
    },
  };
  const src = from?.id;
  const create = (record: Rec): Op => ({ Create: { id: mint(), record } });
  // The heroes whole (one transaction), and split: bare, then each one's `more` as sets.
  const heroes: Op[] = [];
  const bare: Op[] = [];
  const mores: Op[][] = [];
  const rest: Op[] = [];
  const drawn: Op[] = [];
  const states: Op[] = [];
  for (const [, e] of Object.entries(state.records)) {
    if (e.deleted) continue;
    const r = e.record;
    if ("PlayerState" in r && r.PlayerState.scene === src) {
      const { more, ...fields } = r.PlayerState;
      const hero = mint();
      heroes.push({ Create: { id: hero, record: { PlayerState: { ...r.PlayerState, scene: id } } } });
      bare.push({ Create: { id: hero, record: { PlayerState: { ...fields, scene: id } } } });
      const sets = Object.entries(more ?? {}).map(([key, value]): Op => ({ Set: { id: hero, value: { More: { key, value } } } }));
      if (sets.length) mores.push(sets);
    }
    if ("Wave" in r && r.Wave.scene === src) rest.push(create({ Wave: { ...r.Wave, scene: id } }));
    if ("ObjectiveState" in r && r.ObjectiveState.scene === src) rest.push(create({ ObjectiveState: { ...r.ObjectiveState, scene: id } }));
    if (ink) {
      if ("Arrow" in r && r.Arrow.scene === src) drawn.push(create({ Arrow: { ...r.Arrow, scene: id } }));
      if ("Callout" in r && r.Callout.scene === src) drawn.push(create({ Callout: { ...r.Callout, scene: id } }));
      if ("Stroke" in r && r.Stroke.scene === src) drawn.push(create({ Stroke: { ...r.Stroke, scene: id } }));
      if ("Note" in r && r.Note.scene === src) drawn.push(create({ Note: { ...r.Note, scene: id } }));
    }
    // The snapshot goes with the scene (map-state spec §4.5): its state, and each record's
    // `more` above. Without it the copied values would be stored and never drawn.
    if ("SceneState" in r && r.SceneState.scene === src) states.push(create({ SceneState: { ...r.SceneState, scene: id } }));
  }
  const after = [...rest, ...drawn, ...states];
  const ops = [scene, ...heroes, ...after];
  // Every op here makes one record.
  if (Object.keys(state.records).length + ops.length > LIMITS.max_records) return { id, ops, txs: [], full: true };
  if (ops.length <= LIMITS.max_ops_per_tx && fitsTx(ops)) return { id, ops, txs: [ops], full: false };
  return { id, ops, txs: chunkByBytes([[scene, ...bare], ...mores, ...after.map((op) => [op])]), full: false };
}

/**
 * Send a new scene's transactions in order; a refused one stops the rest. Whether the scene was
 * made (its first transaction): the caller shows the scene only then, never an id that
 * doesn't exist. With nothing to send (the board is full), nothing was made.
 */
export const sendScene = (txs: Op[][], edit: (ops: Op[]) => boolean) => txs.length > 0 && txs.findIndex((tx) => !edit(tx)) !== 0;

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
