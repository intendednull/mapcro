// Player's live annotation layer (spec §6b, operator decision 2026-11-08): ink, arrows and
// comments drawn over playback are records of a hidden "live" scene, shared live like any
// other; they're kept only by saving a scene, which moves them into it, and cleared when the
// last person leaves Player. Pings and the laser are presence, never stored. Pure.

import { keyBetween } from "../core/order";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import type { Slot } from "../board/state";
import type { SceneRow } from "../board/scenes";

/** The annotation kinds a saved scene takes over from the live layer. */
export const ANNOTATIONS = ["Stroke", "Arrow", "Callout"] as const;

/** Make the live layer: a scene that's never listed, with the player states every scene has. */
export function liveSceneOps(roster: Slot[], scenes: SceneRow[], mint: () => RecordId): { id: RecordId; ops: Op[] } {
  const id = mint();
  const ops: Op[] = [{ Create: { id, record: { Scene: { name: "Live", order: keyBetween(scenes[scenes.length - 1]?.scene.order, undefined), clock: null, live: true } } } }];
  for (const s of roster) {
    ops.push({ Create: { id: mint(), record: { PlayerState: { scene: id, slot: s.id, pos: { x: 0, y: 0 }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true } } } });
  }
  return { id, ops };
}

type Rows = (kind: string, scene: RecordId) => ReadonlyArray<readonly [RecordId, Record<string, unknown>]>;

/** Move the live layer's annotations into `scene` (copies there, the originals deleted). */
export function takeAnnotationsOps(rows: Rows, live: RecordId, scene: RecordId, mint: () => RecordId): Op[] {
  const ops: Op[] = [];
  for (const kind of ANNOTATIONS) {
    for (const [id, rec] of rows(kind, live)) {
      const body = rec[kind] as Record<string, unknown>;
      ops.push({ Create: { id: mint(), record: { [kind]: { ...body, scene } } as never } });
      ops.push({ Delete: { id } });
    }
  }
  return ops;
}

/** Clear the live layer. */
export function clearAnnotationsOps(rows: Rows, live: RecordId): Op[] {
  return ANNOTATIONS.flatMap((kind) => rows(kind, live).map(([id]) => ({ Delete: { id } }) as Op));
}
