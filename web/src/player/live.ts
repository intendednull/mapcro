// Player's live annotation layer (spec §6b, operator decision 2026-11-08): ink, arrows and
// comments drawn over playback are records of a hidden "live" scene per match, shared live like
// any other; they're kept only by saving a scene, which moves them into it. The layer's ids are
// derived from the board and the match, so two editors entering at once make the same one, and
// it's made, restored and cleared with silent edits (no undo step, review 2026-11-08 finding 8).
// Stale ink is cleared when someone enters Player and nobody else is in it. Pings and the laser
// are presence, never stored. Pure.

import type { Entry } from "../gen/Entry";
import type { More } from "../gen/More";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { Op } from "../gen/Op";
import type { PlayerState } from "../gen/PlayerState";
import type { RecordId } from "../gen/RecordId";
import type { Tx } from "../gen/Tx";
import type { Slot } from "../board/state";
import { LIMITS } from "../gen/limits";
import type { PauseOverrides } from "../match/save";

/** The annotation kinds a saved scene takes over from the live layer. */
export const ANNOTATIONS = ["Stroke", "Arrow", "Callout"] as const;

/** Canonical integer second for pause-edit scoping, bounded to `SceneClock`'s schema limit (0..14400). */
export const pauseClock = (t: number): number =>
  Math.min(4 * 3600, Math.max(0, Math.round(Math.round(t * 100) / 100)));

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

/** Deterministic `SceneState` id for `liveScene` pause-edit overrides (zero unbounded tombstone growth). */
export const liveSceneStateId = (board: string, match: number): RecordId =>
  idFrom(`mapcro-live:${board}:${match}:state`);
/** Deterministic `Wave` id for `liveScene` pause-edit overrides. */
export const liveWaveId = (board: string, match: number, lane: string): RecordId =>
  idFrom(`mapcro-live:${board}:${match}:wave:${lane}`);
/** Deterministic `ObjectiveState` id for `liveScene` pause-edit overrides. */
export const liveObjId = (board: string, match: number, key: string): RecordId =>
  idFrom(`mapcro-live:${board}:${match}:obj:${key}`);

type Entries = Record<string, { deleted?: boolean; record?: Entry["record"] } | undefined>;

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
      ops.push({ Create: { id, record: { PlayerState: { scene: ids.scene, slot, pos: { x: 0, y: 0 }, alive: true, placed: false, souls: null, ult_cooldown: null, visible: true } } } });
    }
    return ops;
  }
  if (scene.deleted) ops.push({ Restore: { id: ids.scene } });
  for (const [id] of ids.players) if (records[id]?.deleted) ops.push({ Restore: { id } });
  return ops;
}

/** Whether `more` carries at least one defined key (empty `{}` is clean). */
export const hasMoreKeys = (more?: More): boolean => Object.keys(more ?? {}).length > 0;

/** Untouched legacy `liveScene` `PlayerState` persisted before `#61` (`placed: true, pos: {0,0}`, `clock === null`). */
export function isLegacyUntouchedPlayerState(ps: PlayerState, liveClock: number | null): boolean {
  return (
    liveClock === null &&
    ps.placed &&
    ps.pos.x === 0 &&
    ps.pos.y === 0 &&
    ps.alive &&
    ps.souls == null &&
    ps.ult_cooldown == null &&
    ps.visible &&
    ps.respawn == null &&
    !hasMoreKeys(ps.more)
  );
}

/** Whether a `liveScene` `PlayerState` is at neutral baseline (no pause-edit override). */
export function isBaselinePlayerState(ps: PlayerState, liveClock: number | null): boolean {
  const standard =
    !ps.placed &&
    ps.alive &&
    ps.souls == null &&
    ps.ult_cooldown == null &&
    ps.visible &&
    ps.respawn == null &&
    !hasMoreKeys(ps.more);
  return standard || isLegacyUntouchedPlayerState(ps, liveClock);
}

/** One-time silent normalization of legacy untouched `liveScene` `PlayerState` records (`placed: true -> false`). */
export function normalizeLegacyLiveOps(records: Record<string, Entry | undefined>, liveSceneId: RecordId): Op[] {
  const sc = records[liveSceneId];
  if (!sc || sc.deleted || !("Scene" in sc.record) || sc.record.Scene.clock != null) return [];
  const ops: Op[] = [];
  for (const [id, e] of Object.entries(records)) {
    if (!e || e.deleted || !("PlayerState" in e.record)) continue;
    const ps = e.record.PlayerState;
    if (ps.scene === liveSceneId && isLegacyUntouchedPlayerState(ps, null)) {
      ops.push({ Set: { id, value: { PlayerPlaced: false } } });
    }
  }
  return ops;
}

/** Whether `liveSceneId` holds any pause-edit entity overrides scoped to `(playing=false, pauseClock(t))`. */
export function hasPauseEntityOverrides(
  records: Record<string, Entry | undefined>,
  liveSceneId: RecordId | undefined,
  playing: boolean,
  t: number,
): boolean {
  if (playing || !liveSceneId) return false;
  const sc = records[liveSceneId];
  if (!sc || sc.deleted || !("Scene" in sc.record)) return false;
  const liveClock = sc.record.Scene.clock ?? null;
  if (liveClock !== pauseClock(t)) return false;
  for (const e of Object.values(records)) {
    if (!e || e.deleted) continue;
    const r = e.record;
    if ("PlayerState" in r && r.PlayerState.scene === liveSceneId) {
      if (!isBaselinePlayerState(r.PlayerState, liveClock)) return true;
    } else if ("SceneState" in r && r.SceneState.scene === liveSceneId) {
      if (hasMoreKeys(r.SceneState.more)) return true;
    } else if ("Wave" in r && r.Wave.scene === liveSceneId) {
      return true;
    } else if ("ObjectiveState" in r && r.ObjectiveState.scene === liveSceneId) {
      return true;
    }
  }
  return false;
}

/** Whether `liveSceneId` holds any live annotation (`Stroke`, `Arrow`, `Callout`). */
export function hasLiveAnnotations(records: Record<string, Entry | undefined>, liveSceneId: RecordId | undefined): boolean {
  if (!liveSceneId) return false;
  for (const e of Object.values(records)) {
    if (!e || e.deleted) continue;
    const r = e.record;
    if ("Stroke" in r && r.Stroke.scene === liveSceneId) return true;
    if ("Arrow" in r && r.Arrow.scene === liveSceneId) return true;
    if ("Callout" in r && r.Callout.scene === liveSceneId) return true;
  }
  return false;
}

/**
 * Every `liveScene` entity record id (live OR tombstoned) for history pruning (`dropHistoryFor`):
 * `liveSceneId` itself plus its `PlayerState`, `SceneState`, `Wave`, and `ObjectiveState` records.
 * Explicitly excludes `Stroke`, `Arrow`, and `Callout` so live-ink undo survives Play (D1).
 */
export function liveEntityRecordIds(records: Record<string, Entry | undefined>, liveSceneId: RecordId): RecordId[] {
  const out: RecordId[] = [liveSceneId];
  for (const [id, e] of Object.entries(records)) {
    if (!e) continue;
    const r = e.record;
    if (
      ("PlayerState" in r && r.PlayerState.scene === liveSceneId) ||
      ("SceneState" in r && r.SceneState.scene === liveSceneId) ||
      ("Wave" in r && r.Wave.scene === liveSceneId) ||
      ("ObjectiveState" in r && r.ObjectiveState.scene === liveSceneId)
    ) {
      out.push(id);
    }
  }
  return out;
}

/**
 * Reset all entity overrides on `liveSceneId` (`SceneClock: null`, non-baseline `PlayerState`
 * fields back to neutral baseline, and `Delete` of live `SceneState` / `Wave` / `ObjectiveState`),
 * chunked within `MAX_OPS_PER_TX`. Leaves live ink (`Stroke` / `Arrow` / `Callout`) untouched.
 */
export function clearPauseOverridesOps(records: Record<string, Entry | undefined>, liveSceneId: RecordId): Op[][] {
  const ops: Op[] = [];
  const sc = records[liveSceneId];
  if (sc && !sc.deleted && "Scene" in sc.record && sc.record.Scene.clock != null) {
    ops.push({ Set: { id: liveSceneId, value: { SceneClock: null } } });
  }
  for (const [id, e] of Object.entries(records)) {
    if (!e || e.deleted) continue;
    const r = e.record;
    if ("PlayerState" in r && r.PlayerState.scene === liveSceneId) {
      const ps = r.PlayerState;
      const dirty =
        ps.placed ||
        ps.pos.x !== 0 ||
        ps.pos.y !== 0 ||
        !ps.alive ||
        ps.souls != null ||
        ps.ult_cooldown != null ||
        ps.respawn != null ||
        !ps.visible ||
        hasMoreKeys(ps.more);
      if (!dirty) continue;
      if (ps.placed) ops.push({ Set: { id, value: { PlayerPlaced: false } } });
      if (ps.pos.x !== 0 || ps.pos.y !== 0) ops.push({ Set: { id, value: { PlayerPos: { x: 0, y: 0 } } } });
      if (!ps.alive) ops.push({ Set: { id, value: { PlayerAlive: true } } });
      if (ps.ult_cooldown != null) ops.push({ Set: { id, value: { PlayerUltCooldown: null } } });
      if (ps.souls != null) ops.push({ Set: { id, value: { PlayerSouls: null } } });
      if (ps.respawn != null) ops.push({ Set: { id, value: { PlayerRespawn: null } } });
      if (!ps.visible) ops.push({ Set: { id, value: { PlayerVisible: true } } });
      for (const key of Object.keys(ps.more ?? {})) {
        ops.push({ Set: { id, value: { More: { key, value: null } } } });
      }
    } else if (
      ("SceneState" in r && r.SceneState.scene === liveSceneId) ||
      ("Wave" in r && r.Wave.scene === liveSceneId) ||
      ("ObjectiveState" in r && r.ObjectiveState.scene === liveSceneId)
    ) {
      ops.push({ Delete: { id } });
    }
  }
  if (!ops.length) return [];
  return chunks(
    ops.map((o) => [o]),
    MAX_OPS_PER_TX,
  );
}

/** Collect active `PauseOverrides` from `liveSceneId` for `matchSceneOps` (`Save as scene`). */
export function collectPauseOverrides(
  records: Record<string, Entry | undefined>,
  liveSceneId: RecordId | undefined,
  playing: boolean,
  t: number,
): PauseOverrides | undefined {
  if (!hasPauseEntityOverrides(records, liveSceneId, playing, t) || !liveSceneId) return undefined;
  const sc = records[liveSceneId]!;
  const liveClock = "Scene" in sc.record ? (sc.record.Scene.clock ?? null) : null;
  const players = new Map<RecordId, PlayerState>();
  const objectives = new Map<string, ObjectiveStatus>();
  const waves = new Map<string, { t: number; more?: More }>();
  let state: More | undefined;
  for (const e of Object.values(records)) {
    if (!e || e.deleted) continue;
    const r = e.record;
    if ("PlayerState" in r && r.PlayerState.scene === liveSceneId) {
      if (!isBaselinePlayerState(r.PlayerState, liveClock)) players.set(r.PlayerState.slot, r.PlayerState);
    } else if ("ObjectiveState" in r && r.ObjectiveState.scene === liveSceneId) {
      objectives.set(r.ObjectiveState.key, r.ObjectiveState.status);
    } else if ("Wave" in r && r.Wave.scene === liveSceneId) {
      waves.set(r.Wave.lane, { t: r.Wave.t, ...(r.Wave.more ? { more: r.Wave.more } : {}) });
    } else if ("SceneState" in r && r.SceneState.scene === liveSceneId && hasMoreKeys(r.SceneState.more)) {
      state = r.SceneState.more;
    }
  }
  return { players, objectives, waves, ...(state ? { state } : {}) };
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

/**
 * Whether `tx` is a live-layer `ensure` creation for `board`: deterministic live-scene id plus
 * deterministic per-slot `PlayerState` ids only. Used to recognise a pending live-layer ensure
 * refused `IdTaken` across a page reload (TD-35).
 */
export function isLiveLayerCreate(board: string, tx: Pick<Tx, "kind" | "ops">): boolean {
  if (tx.kind !== "Edit" || tx.ops.length === 0) return false;
  const first = tx.ops[0]!;
  if (!("Create" in first) || !("Scene" in first.Create.record)) return false;
  const scene = first.Create.record.Scene;
  if (!scene.live || !scene.source) return false;
  const match = scene.source.match_id;
  const sceneId = idFrom(`mapcro-live:${board}:${match}`);
  if (first.Create.id !== sceneId) return false;
  for (let i = 1; i < tx.ops.length; i++) {
    const op = tx.ops[i]!;
    if (!("Create" in op) || !("PlayerState" in op.Create.record)) return false;
    const ps = op.Create.record.PlayerState;
    if (ps.scene !== sceneId || op.Create.id !== idFrom(`mapcro-live:${board}:${match}:${ps.slot}`)) return false;
  }
  return true;
}

/**
 * Whether `tx` creates a deterministic pause-edit entity (`liveObjId` / `liveWaveId` /
 * `liveSceneStateId`) on a `liveScene` of `board`, so a concurrent `IdTaken` race between two
 * paused editors is absorbed cleanly (spec §4.4 M7).
 */
export function isLiveEntityCreate(
  board: string,
  records: ReadonlyMap<RecordId, Entry>,
  tx: Pick<Tx, "kind" | "ops">,
): boolean {
  if (tx.kind !== "Edit" || tx.ops.length === 0) return false;
  const matchOf = (sceneId: RecordId): number | undefined => {
    const e = records.get(sceneId);
    return e && "Scene" in e.record && e.record.Scene.live ? e.record.Scene.source?.match_id : undefined;
  };
  for (const op of tx.ops) {
    if (!("Create" in op)) continue;
    const rec = op.Create.record;
    if ("ObjectiveState" in rec) {
      const m = matchOf(rec.ObjectiveState.scene);
      if (m !== undefined && op.Create.id === liveObjId(board, m, rec.ObjectiveState.key)) return true;
    } else if ("Wave" in rec) {
      const m = matchOf(rec.Wave.scene);
      if (m !== undefined && op.Create.id === liveWaveId(board, m, rec.Wave.lane)) return true;
    } else if ("SceneState" in rec) {
      const m = matchOf(rec.SceneState.scene);
      if (m !== undefined && op.Create.id === liveSceneStateId(board, m)) return true;
    }
  }
  return false;
}

/**
 * Transactions for Play from here (TD-35): keep the live-layer `ensure` ops in their own
 * transaction ahead of the clear/copy transactions so an `IdTaken` race on the live layer never
 * refuses the copied drawings.
 */
export function playFromTxs(
  records: Entries,
  rows: Rows,
  board: string,
  match: number,
  roster: Slot[],
  fromScene: RecordId,
  existingLive: RecordId | undefined,
  mint: () => RecordId,
): { ensure: Op[]; copies: Op[][] } {
  const live = liveIds(board, match, roster).scene;
  const ensure = ensureLiveOps(records, board, match, roster);
  const groups: Op[][] = [];
  if (existingLive) groups.push(...clearAnnotationsOps(rows, existingLive).map((o) => [o]));
  groups.push(...copyAnnotationsOps(rows, fromScene, live, mint).map((o) => [o]));
  return { ensure, copies: chunks(groups.filter((g) => g.length), MAX_OPS_PER_TX) };
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
