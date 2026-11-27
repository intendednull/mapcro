// Edits of a scene's stored state (map-state spec §5): each writes only the scene.

import { LIMITS } from "../gen/limits";
import type { More } from "../gen/More";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import { ROWS } from "../gen/rows";
import type { WorldPos } from "../gen/WorldPos";
import type { Marker } from "../map/model";
import { clampToMap } from "../map/transform";
import type { DoorNow } from "../match/timeline";
import { BUILD_KEYS, WRITTEN, captured, moreBytes } from "./build";
import { MAX_DOORS, decodeCamps, decodeDoors, decodeObjHealth, encodeDoors, encodeObjHealth, isHealthKind } from "./codec";
import type { FrameMarkers } from "./frame";

/**
 * A pick of `hero` for a slot (`null`: no hero), from the hero picker.
 *
 * In a scene that holds its own heroes (D2, `own`): the scene's record alone. Its `hero` is
 * set and, in the same transaction, the stored build is dropped: it was the old hero's, and a
 * slot whose hero changed has no build (spec §5). One undo step brings both back. The same
 * hero again writes nothing, and "no hero" is not a pick there (the row can't say it; a scene's
 * hero cleared would fall back to the roster's).
 *
 * Every build row is cleared, held here or not: a Retake that reached the server first may have
 * filled rows this client hasn't seen yet (TD-119). `written`: the rows this build writes; a row
 * still `ahead` is refused by the server, even as a clear, so it is named only if the record
 * holds it.
 *
 * In any other scene (made by hand, or saved before scenes held their heroes): the board's
 * roster, as it always was.
 *
 * `slot`: the roster slot's record. `player`: the slot's hero record in the scene.
 */
export function pickHeroOps(own: boolean, slot: RecordId, player: { id: RecordId; more: More | undefined } | undefined, hero: number | null, written: number = WRITTEN): Op[] {
  if (!own || !player) return [{ Set: { id: slot, value: { RosterHero: hero } } }];
  if (hero == null || player.more?.hero === hero) return [];
  const dropped = BUILD_KEYS.filter((k) => ROWS[k].index < written || player.more?.[k] !== undefined);
  return [
    { Set: { id: player.id, value: { More: { key: "hero", value: hero } } } },
    ...dropped.map((key): Op => ({ Set: { id: player.id, value: { More: { key, value: null } } } })),
  ];
}

/**
 * Toggle whether a hero is seen by its enemies (plan §3 Q2).
 *
 * - Without `has_sight` (legacy D5): flips typed `PlayerVisible`.
 * - With `has_sight`:
 *   - Currently seen (`more.unseen !== true && visible !== false`): sets `more.unseen = true`.
 *   - Currently unseen: clears `more.unseen` (if present) AND sets `PlayerVisible: true` (if
 *     `visible === false` from a pre-Retake manual mark), in one transaction / one undo step.
 */
export function toggleSightOps(hasSight: boolean, id: RecordId, rec: { visible: boolean; more?: More }): Op[] {
  if (!hasSight) return [{ Set: { id, value: { PlayerVisible: !rec.visible } } }];
  const inSight = rec.more?.unseen !== true && rec.visible !== false;
  if (inSight) return [{ Set: { id, value: { More: { key: "unseen", value: true } } } }];
  const ops: Op[] = [];
  if (rec.more?.unseen !== undefined) ops.push({ Set: { id, value: { More: { key: "unseen", value: null } } } });
  if (rec.visible === false) ops.push({ Set: { id, value: { PlayerVisible: true } } });
  return ops;
}

// ---- Doorman doorway manual Scene edits (docs/specs/doorman-doors.md §4.2, design §2.2–2.4) ----

export type DoorTeam = "amber" | "sapphire";

export interface SceneDoorContext {
  scene: RecordId;
  state: { id: RecordId; more: More | undefined } | undefined;
  mint: () => RecordId;
  written?: number;
  /** Frame-seeded replay doors when editing `liveScene` before `has_doors` is captured (spec #61 §2.5). */
  seed?: readonly DoorNow[];
}

export interface DoorIdentity {
  team: DoorTeam;
  role: DoorNow["role"];
  at: WorldPos;
  inSight: boolean;
}

export type DoorTarget = number | { index: number; expect: DoorIdentity };

export const doorIdentity = (d: Pick<DoorNow, "team" | "role" | "at" | "inSight">): DoorIdentity => ({
  team: d.team,
  role: d.role,
  at: { x: d.at.x, y: d.at.y },
  inSight: d.inSight,
});

const sameDoorIdentity = (d: DoorNow, expect: DoorIdentity): boolean =>
  d.team === expect.team &&
  d.role === expect.role &&
  d.at.x === expect.at.x &&
  d.at.y === expect.at.y &&
  d.inSight === expect.inSight;

/**
 * Resolve a door's current positional index against an optional `DoorIdentity` captured at gesture start.
 * When `expect` is omitted, validates `index` directly; when provided, verifies `doors[index]` matches
 * or re-finds the exact matching door if shifted by a concurrent peer edit (returning `undefined` if gone/changed).
 */
export function resolveDoorIndex(doors: readonly DoorNow[], index: number, expect?: DoorIdentity): number | undefined {
  const at = doors[index];
  if (!expect) return at ? index : undefined;
  if (at && sameDoorIdentity(at, expect)) return index;
  const found = doors.findIndex((d) => sameDoorIdentity(d, expect));
  return found >= 0 ? found : undefined;
}

const DOOR_ROWS = ROWS.doors.index + 1;

/** Scene-level `has_*` flags gated by `ROWS[last].index < rows` (excluding `has_doors`). */
const DORMANT_FLAG_ROWS: ReadonlyArray<readonly [keyof typeof ROWS, keyof typeof ROWS]> = [
  ["has_heroes", "has_heroes"],
  ["has_sight", "unseen"],
  ["has_cc", "cc"],
  ["has_movement", "zipline"],
  ["has_lanes", "edges"],
  ["has_skulls", "skulls"],
  ["has_camps", "camps"],
  ["has_powerups", "powerups"],
  ["has_obj_health", "obj_health"],
  ["has_rifts", "rift"],
  ["has_urn", "urn_at"],
  ["has_rejuv", "rejuv"],
];

const currentDoors = (ctx: Pick<SceneDoorContext, "state" | "seed">): DoorNow[] =>
  captured(ctx.state?.more).doors ? decodeDoors(ctx.state?.more?.doors) : [...(ctx.seed ?? [])];

const sameInts = (prev: unknown, next: readonly number[]): boolean => {
  if (next.length === 0) return prev === undefined || (Array.isArray(prev) && prev.length === 0);
  return Array.isArray(prev) && prev.length === next.length && prev.every((v, i) => v === next[i]);
};

function writeDoorsOps(ctx: SceneDoorContext, nextDoors: readonly DoorNow[]): Op[] {
  const written = ctx.written ?? WRITTEN;
  if (ROWS.doors.index >= written) return [];
  const encoded = encodeDoors(nextDoors);
  const seeded = !!(ctx.seed && ctx.seed.length > 0);
  if (!ctx.state) {
    if (encoded.length === 0 && !seeded) return [];
    const more: More = encoded.length ? { rows: DOOR_ROWS, has_doors: true, doors: encoded } : { rows: DOOR_ROWS, has_doors: true };
    if (moreBytes(more) > LIMITS.max_more_bytes) return [];
    return [
      {
        Create: {
          id: ctx.mint(),
          record: { SceneState: { scene: ctx.scene, more } },
        },
      },
    ];
  }
  const have = ctx.state.more ?? {};
  const curRows = typeof have.rows === "number" && Number.isInteger(have.rows) ? have.rows : 0;
  const needBumpRows = curRows < DOOR_ROWS;
  const hadDoorsKey = have.doors !== undefined;
  if (encoded.length === 0 && have.has_doors !== true && !hadDoorsKey && !seeded) return [];
  if (have.has_doors === true && !needBumpRows && sameInts(have.doors, encoded)) return [];
  const ops: Op[] = [];
  const expectDoors = hadDoorsKey ? have.doors! : null;
  // Emit clears first so raising `rows` never activates dormant `has_*` flags and stays within per-op caps.
  if (needBumpRows) {
    if (curRows === 0 && have.has_builds === true) {
      ops.push({ Set: { id: ctx.state.id, value: { More: { key: "has_builds", value: null } } } });
    }
    for (const [flag, last] of DORMANT_FLAG_ROWS) {
      if (have[flag] === true && ROWS[last].index >= curRows) {
        ops.push({ Set: { id: ctx.state.id, value: { More: { key: flag, value: null } } } });
      }
    }
  }
  // Write `doors` with `SetIf` on the observed value so concurrent peer edits to `doors` are skipped
  // instead of silently clobbering the peer's change.
  if (encoded.length === 0) {
    if (hadDoorsKey) {
      ops.push({
        SetIf: {
          id: ctx.state.id,
          expect: { More: { key: "doors", value: expectDoors } },
          value: { More: { key: "doors", value: null } },
        },
      });
    }
  } else if (!sameInts(have.doors, encoded)) {
    ops.push({
      SetIf: {
        id: ctx.state.id,
        expect: { More: { key: "doors", value: expectDoors } },
        value: { More: { key: "doors", value: encoded } },
      },
    });
  }
  if (have.has_doors !== true) ops.push({ Set: { id: ctx.state.id, value: { More: { key: "has_doors", value: true } } } });
  if (needBumpRows) ops.push({ Set: { id: ctx.state.id, value: { More: { key: "rows", value: DOOR_ROWS } } } });
  // Preflight every intermediate `SceneState.more` state against `max_more_bytes` (matching server validation).
  const sim: More = { ...have };
  for (const op of ops) {
    const mv = "Set" in op ? op.Set.value : "SetIf" in op ? op.SetIf.value : undefined;
    if (mv && "More" in mv) {
      if (mv.More.value === null) delete sim[mv.More.key];
      else sim[mv.More.key] = mv.More.value;
      if (moreBytes(sim) > LIMITS.max_more_bytes) return [];
    }
  }
  return ops;
}

/**
 * Place a doorway for `team` (either an unpaired Door 1 or a linked pair `[door1, door2]`),
 * replacing any existing door(s) of `team` while preserving the other team's doors (max 4 total).
 * One atomic transaction = one undo/redo step.
 */
export function placeDoorwayOps(ctx: SceneDoorContext, team: DoorTeam, door1: WorldPos, door2?: WorldPos): Op[] {
  const cur = currentDoors(ctx);
  const addedCount = door2 ? 2 : 1;
  const other = cur.filter((d) => d.team !== team).slice(0, MAX_DOORS - addedCount);
  const at1 = clampToMap(door1);
  const baseId = 100;
  const added: DoorNow[] = door2
    ? [
        { id: baseId, team, at: at1, role: "door1", partner: baseId + 1, inSight: true },
        { id: baseId + 1, team, at: clampToMap(door2), role: "door2", partner: baseId, inSight: true },
      ]
    : [{ id: baseId, team, at: at1, role: "unpaired", partner: null, inSight: true }];
  return writeDoorsOps(ctx, [...other, ...added]);
}

/**
 * Link a new `door2` to an existing unpaired door at `index` in place (without moving Door 1),
 * inheriting Door 1's enemy sight state in lockstep.
 */
export function linkSecondDoorOps(ctx: SceneDoorContext, index: number, door2: WorldPos, expect?: DoorIdentity): Op[] {
  const cur = currentDoors(ctx);
  const resolved = resolveDoorIndex(cur, index, expect);
  const target = resolved !== undefined ? cur[resolved] : undefined;
  if (!target || target.role !== "unpaired" || target.partner !== null) return [];
  const other = cur.filter((d) => d.team !== target.team).slice(0, MAX_DOORS - 2);
  const newId = 100;
  const next: DoorNow[] = [];
  let keptOther = 0;
  for (const d of cur) {
    if (d.id === target.id) {
      next.push({ ...d, role: "door1", partner: newId });
    } else if (d.team !== target.team && keptOther < other.length) {
      next.push(d);
      keptOther++;
    }
  }
  next.push({ id: newId, team: target.team, at: clampToMap(door2), role: "door2", partner: target.id, inSight: target.inSight });
  return writeDoorsOps(ctx, next);
}

/** Move one door at `index` to `pos` (clamped to map bounds). */
export function moveDoorOps(ctx: SceneDoorContext, index: number, pos: WorldPos, expect?: DoorIdentity): Op[] {
  const cur = currentDoors(ctx);
  const resolved = resolveDoorIndex(cur, index, expect);
  const target = resolved !== undefined ? cur[resolved] : undefined;
  if (!target) return [];
  const at = clampToMap(pos);
  if (at.x === target.at.x && at.y === target.at.y) return [];
  return writeDoorsOps(
    ctx,
    cur.map((d, i) => (i === resolved ? { ...d, at } : d)),
  );
}

/** Remove one door of a linked pair and convert its partner to an unpaired Door 1 in place. */
export function unlinkDoorOps(ctx: SceneDoorContext, index: number, expect?: DoorIdentity): Op[] {
  const cur = currentDoors(ctx);
  const resolved = resolveDoorIndex(cur, index, expect);
  const target = resolved !== undefined ? cur[resolved] : undefined;
  if (!target || target.role === "unpaired" || target.partner === null) return [];
  const next = cur
    .filter((_, i) => i !== resolved)
    .map((d) => (d.id === target.partner ? { ...d, role: "unpaired" as const, partner: null } : d));
  return writeDoorsOps(ctx, next);
}

/**
 * Toggle enemy sight (`inSight`) on the door at `index` and its linked partner in lockstep.
 * Writes ONLY `doors` — never sets `has_sight` (preserving `canRetake` for hero sight).
 */
export function toggleDoorSightOps(ctx: SceneDoorContext, index: number, expect?: DoorIdentity): Op[] {
  const cur = currentDoors(ctx);
  const resolved = resolveDoorIndex(cur, index, expect);
  const target = resolved !== undefined ? cur[resolved] : undefined;
  if (!target) return [];
  const inSight = !target.inSight;
  const next = cur.map((d, i) => (i === resolved || (target.partner !== null && d.id === target.partner) ? { ...d, inSight } : d));
  return writeDoorsOps(ctx, next);
}

/** Remove every doorway touched by `targets` (each unpaired door, or both doors of any linked pair). */
export function removeDoorwaysOps(ctx: SceneDoorContext, targets: Iterable<DoorTarget>): Op[] {
  const cur = currentDoors(ctx);
  const drop = new Set<number>();
  for (const t of targets) {
    const resolved = typeof t === "number" ? resolveDoorIndex(cur, t) : resolveDoorIndex(cur, t.index, t.expect);
    if (resolved === undefined) continue;
    const d = cur[resolved]!;
    drop.add(d.id);
    if (d.partner !== null) drop.add(d.partner);
  }
  if (!drop.size) return [];
  return writeDoorsOps(
    ctx,
    cur.filter((d) => !drop.has(d.id)),
  );
}

/** Remove the doorway at `index` (the unpaired door, or both doors of a linked pair). */
export function removeDoorwayOps(ctx: SceneDoorContext, index: number, expect?: DoorIdentity): Op[] {
  return removeDoorwaysOps(ctx, [expect ? { index, expect } : index]);
}

/** Remove all doors belonging to `team`, preserving the other team's doors. */
export function clearTeamDoorsOps(ctx: SceneDoorContext, team: DoorTeam): Op[] {
  const cur = currentDoors(ctx);
  const next = cur.filter((d) => d.team !== team);
  if (next.length === cur.length) return [];
  return writeDoorsOps(ctx, next);
}

// ---- Objective health manual Scene edits (docs/specs/objective-health-edit.md §1.3) ----

export type ObjHealthEntry = { pct: number; stage?: number };

export interface SceneObjHealthContext {
  scene: RecordId;
  state: { id: RecordId; more: More | undefined } | undefined;
  objectives: ReadonlyMap<string, { id: RecordId; status: ObjectiveStatus }>;
  markers: FrameMarkers;
  mint: () => RecordId;
  /** Effective marker status (`ObjectiveState ?? baseline detail`), if already computed by the caller. */
  shownStatus?: (key: string) => ObjectiveStatus | undefined;
  /** Frame-seeded replay `obj_health` when editing `liveScene` before `has_obj_health` is captured (spec #61 §2.5). */
  seed?: ReadonlyMap<string, ObjHealthEntry | null>;
  /** Optional deterministic tombstone-aware ObjectiveState upserter (used for `liveScene`). */
  upsertObjective?: (key: string, status: ObjectiveStatus) => Op[];
  written?: number;
}

const OBJ_HEALTH_ROWS = ROWS.obj_health.index + 1;

const currentObjHealth = (
  ctx: Pick<SceneObjHealthContext, "state" | "markers" | "seed">,
): Map<string, ObjHealthEntry | null> =>
  captured(ctx.state?.more).obj_health ? decodeObjHealth(ctx.state?.more?.obj_health, ctx.markers) : new Map(ctx.seed ?? []);

function writeObjHealthOpsInternal(
  ctx: Pick<SceneObjHealthContext, "scene" | "state" | "markers" | "mint" | "written" | "seed">,
  nextHealth: ReadonlyMap<string, ObjHealthEntry | null>,
): { ops: Op[]; ok: boolean } {
  const written = ctx.written ?? WRITTEN;
  if (ROWS.obj_health.index >= written) return { ops: [], ok: true };
  const res = encodeObjHealth(nextHealth, ctx.markers);
  if (res.overflow) return { ops: [], ok: false };
  const encoded = res.ints;
  const seeded = !!(ctx.seed && ctx.seed.size > 0);
  if (!ctx.state) {
    if (encoded.length === 0 && !seeded) return { ops: [], ok: true };
    const more: More = encoded.length ? { rows: OBJ_HEALTH_ROWS, has_obj_health: true, obj_health: encoded } : { rows: OBJ_HEALTH_ROWS, has_obj_health: true };
    if (moreBytes(more) > LIMITS.max_more_bytes) return { ops: [], ok: false };
    return {
      ops: [
        {
          Create: {
            id: ctx.mint(),
            record: { SceneState: { scene: ctx.scene, more } },
          },
        },
      ],
      ok: true,
    };
  }
  const have = ctx.state.more ?? {};
  const curRows = typeof have.rows === "number" && Number.isInteger(have.rows) ? have.rows : 0;
  const needBumpRows = curRows < OBJ_HEALTH_ROWS;
  const hadKey = have.obj_health !== undefined;
  const wasCaptured = captured(have).obj_health;
  if (encoded.length === 0 && !wasCaptured && !seeded) return { ops: [], ok: true };
  if (wasCaptured && !needBumpRows && sameInts(have.obj_health, encoded)) return { ops: [], ok: true };
  const ops: Op[] = [];
  const expectVal = hadKey ? have.obj_health! : null;
  // Emit clears first so raising `rows` never activates dormant `has_*` flags and stays within per-op caps.
  if (needBumpRows) {
    if (curRows === 0 && have.has_builds === true) {
      ops.push({ Set: { id: ctx.state.id, value: { More: { key: "has_builds", value: null } } } });
    }
    for (const [flag, last] of DORMANT_FLAG_ROWS) {
      if (flag !== "has_obj_health" && have[flag] === true && ROWS[last].index >= curRows) {
        ops.push({ Set: { id: ctx.state.id, value: { More: { key: flag, value: null } } } });
      }
    }
  }
  // Write `obj_health` with `SetIf` on the observed value so concurrent peer edits are skipped
  // instead of silently clobbering another coach's change.
  if (encoded.length === 0) {
    if (hadKey) {
      ops.push({
        SetIf: {
          id: ctx.state.id,
          expect: { More: { key: "obj_health", value: expectVal } },
          value: { More: { key: "obj_health", value: null } },
        },
      });
    }
  } else if (!sameInts(have.obj_health, encoded)) {
    ops.push({
      SetIf: {
        id: ctx.state.id,
        expect: { More: { key: "obj_health", value: expectVal } },
        value: { More: { key: "obj_health", value: encoded } },
      },
    });
  }
  if (have.has_obj_health !== true) ops.push({ Set: { id: ctx.state.id, value: { More: { key: "has_obj_health", value: true } } } });
  if (needBumpRows) {
    // Watermark uses `SetIf` on the observed value so a stale health writer can never regress a higher `rows`.
    ops.push({
      SetIf: {
        id: ctx.state.id,
        expect: { More: { key: "rows", value: have.rows ?? null } },
        value: { More: { key: "rows", value: OBJ_HEALTH_ROWS } },
      },
    });
  }
  // Preflight every intermediate `SceneState.more` state against `max_more_bytes` (matching server validation).
  const sim: More = { ...have };
  for (const op of ops) {
    const mv = "Set" in op ? op.Set.value : "SetIf" in op ? op.SetIf.value : undefined;
    if (mv && "More" in mv) {
      if (mv.More.value === null) delete sim[mv.More.key];
      else sim[mv.More.key] = mv.More.value;
      if (moreBytes(sim) > LIMITS.max_more_bytes) return { ops: [], ok: false };
    }
  }
  return { ops, ok: true };
}

/** Write a scene's `obj_health` map (preserving untouched `-1` unknown entries via `null`). */
export function writeObjHealthOps(
  ctx: Pick<SceneObjHealthContext, "scene" | "state" | "markers" | "mint" | "written">,
  nextHealth: ReadonlyMap<string, ObjHealthEntry | null>,
): Op[] {
  return writeObjHealthOpsInternal(ctx, nextHealth).ops;
}

/** Clear stored `obj_health` triples for `keys` (e.g. when 1-click toggling an objective or Patron stage). */
export function clearObjHealthOps(
  ctx: Pick<SceneObjHealthContext, "scene" | "state" | "markers" | "mint" | "written">,
  keys: Iterable<string>,
): Op[] {
  if (!ctx.state || !captured(ctx.state.more).obj_health) return [];
  const cur = decodeObjHealth(ctx.state.more?.obj_health, ctx.markers);
  let changed = false;
  for (const k of keys) {
    if (cur.delete(k)) changed = true;
  }
  if (!changed) return [];
  return writeObjHealthOps(ctx, cur);
}

/**
 * Set an objective's health (`0..100`, with optional Patron `stage: 1 | 2`) in one atomic transaction,
 * coordinating `ObjectiveState` (`Active` / `Stage2` / `Destroyed`, including Mid-Boss cleared/revive)
 * with `SceneState.more.obj_health`.
 */
export function setObjectiveHealthOps(
  ctx: SceneObjHealthContext,
  marker: Pick<Marker, "key" | "kind">,
  pct: number,
  explicitStage?: 1 | 2,
): Op[] {
  if (!isHealthKind(marker.kind)) return [];
  const nextPct = Math.max(0, Math.min(100, Math.round(pct)));
  const curHealth = currentObjHealth(ctx);
  const curObj = ctx.objectives.get(marker.key);
  let curStatus: ObjectiveStatus | undefined;
  if (ctx.shownStatus) {
    curStatus = ctx.shownStatus(marker.key);
  } else if (curObj !== undefined) {
    curStatus = curObj.status;
  } else if (marker.kind === "midboss" && captured(ctx.state?.more).camps) {
    const camp = decodeCamps(ctx.state?.more?.camps, 0, ctx.markers).get(marker.key);
    if (camp && camp.state !== "alive") curStatus = "Destroyed";
  } else if (marker.kind === "t3" && curHealth.get(marker.key)?.stage === 2) {
    curStatus = "Stage2";
  }
  const effBefore: ObjectiveStatus = curStatus ?? "Active";
  const stage: 1 | 2 | undefined = marker.kind === "t3" ? (explicitStage ?? (curStatus === "Stage2" ? 2 : 1)) : undefined;
  const targetStatus: ObjectiveStatus = nextPct === 0 ? "Destroyed" : stage === 2 ? "Stage2" : "Active";

  const nextHealth = new Map(curHealth);
  if (nextPct === 0) {
    nextHealth.delete(marker.key);
  } else if (marker.kind === "t3") {
    if (nextPct === 100 && stage === 1) nextHealth.delete(marker.key);
    else nextHealth.set(marker.key, { pct: nextPct, stage: stage! });
  } else {
    if (nextPct === 100) nextHealth.delete(marker.key);
    else nextHealth.set(marker.key, { pct: nextPct });
  }

  const statusOps: Op[] = [];
  if (curObj) {
    if (curObj.status !== targetStatus) {
      statusOps.push({
        SetIf: {
          id: curObj.id,
          expect: { ObjectiveStatus: curObj.status },
          value: { ObjectiveStatus: targetStatus },
        },
      });
    }
  } else if (effBefore !== targetStatus && (targetStatus !== "Active" || effBefore === "Destroyed")) {
    if (ctx.upsertObjective) statusOps.push(...ctx.upsertObjective(marker.key, targetStatus));
    else statusOps.push({ Create: { id: ctx.mint(), record: { ObjectiveState: { scene: ctx.scene, key: marker.key, status: targetStatus } } } });
  }

  const healthRes = writeObjHealthOpsInternal(ctx, nextHealth);
  if (!healthRes.ok) return [];
  return [...statusOps, ...healthRes.ops];
}
