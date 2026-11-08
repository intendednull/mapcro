// Player's live annotation layer (spec §6b, operator decision 2026-11-08): ink, arrows and
// comments drawn over playback are records of a hidden "live" scene per match, shared live like
// any other; they're kept only by saving a scene, which moves them into it. The layer's ids are
// derived from the board and the match, so two editors entering at once make the same one, and
// it's made, restored and cleared with silent edits (no undo step, review 2026-11-08 finding 8).
// Stale ink is cleared when someone enters Player and nobody else is in it. Pings and the laser
// are presence, never stored. Pure.

import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import type { Slot } from "../board/state";
import { LIMITS } from "../gen/limits";

/** The annotation kinds a saved scene takes over from the live layer. */
export const ANNOTATIONS = ["Stroke", "Arrow", "Callout"] as const;

/** A 128-bit id (32 hex digits) from a string: two 64-bit FNV-1a hashes. Never 0. */
export function idFrom(s: string): RecordId {
  const fnv = (seed: bigint) => {
    let h = seed;
    for (const b of new TextEncoder().encode(s)) {
      h ^= BigInt(b);
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return h;
  };
  const hi = fnv(0xcbf29ce484222325n);
  const lo = fnv(0x84222325cbf29ce4n) | 1n;
  return (hi.toString(16).padStart(16, "0") + lo.toString(16).padStart(16, "0")).slice(0, 32);
}

/** The live layer's scene id and its player states' ids, for this board and match. */
export function liveIds(board: string, match: number, roster: Slot[]): { scene: RecordId; players: Array<[RecordId, RecordId]> } {
  return { scene: idFrom(`mapcro-live:${board}:${match}`), players: roster.map((s) => [idFrom(`mapcro-live:${board}:${match}:${s.id}`), s.id]) };
}

type Entries = Record<string, { deleted?: boolean } | undefined>;

/**
 * What it takes for the live layer to exist: nothing if it does, a Restore of whatever an
 * undo removed, or a Create of all of it. The order key is the last possible, so it's never
 * between real scenes (and it's never listed anyway).
 */
export function ensureLiveOps(records: Entries, board: string, match: number, roster: Slot[]): Op[] {
  const ids = liveIds(board, match, roster);
  const ops: Op[] = [];
  const scene = records[ids.scene];
  if (!scene) {
    ops.push({ Create: { id: ids.scene, record: { Scene: { name: "Live", order: "zzzzzzzz", clock: null, live: true, source: { match_id: match, t: 0, tier: "metadata" } } } } });
    for (const [id, slot] of ids.players) {
      ops.push({ Create: { id, record: { PlayerState: { scene: ids.scene, slot, pos: { x: 0, y: 0 }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true } } } });
    }
    return ops;
  }
  if (scene.deleted) ops.push({ Restore: { id: ids.scene } });
  for (const [id] of ids.players) if (records[id]?.deleted) ops.push({ Restore: { id } });
  return ops;
}

type Rows = (kind: string, scene: RecordId) => ReadonlyArray<readonly [RecordId, Record<string, unknown>]>;

/** Move the live layer's annotations into `scene`: the copies there, the originals deleted. */
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

/** Copy a scene's annotations into `to` (new ids; the scene keeps its own). */
export function copyAnnotationsOps(rows: Rows, from: RecordId, to: RecordId, mint: () => RecordId): Op[] {
  return ANNOTATIONS.flatMap((kind) =>
    rows(kind, from).map(([, rec]) => ({ Create: { id: mint(), record: { [kind]: { ...(rec[kind] as Record<string, unknown>), scene: to } } as never } }) as Op),
  );
}

/** Clear the live layer. */
export function clearAnnotationsOps(rows: Rows, live: RecordId): Op[] {
  return ANNOTATIONS.flatMap((kind) => rows(kind, live).map(([id]) => ({ Delete: { id } }) as Op));
}

/** Split ops into transactions within `cap`, never splitting a group (one scene's ops). */
export function chunks(groups: Op[][], cap: number): Op[][] {
  const out: Op[][] = [];
  let cur: Op[] = [];
  for (const g of groups) {
    if (cur.length && cur.length + g.length > cap) {
      out.push(cur);
      cur = [];
    }
    if (g.length > cap) {
      for (let i = 0; i < g.length; i += cap) out.push(g.slice(i, i + cap));
      continue;
    }
    cur.push(...g);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The schema's per-transaction op cap (crates/schema/src/validate.rs `max_ops_per_tx`). */
export const MAX_OPS_PER_TX = LIMITS.max_ops_per_tx;
