// Edits of a scene's stored state (map-state spec §5): each writes only the scene.

import { LIMITS } from "../gen/limits";
import type { More } from "../gen/More";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import { ROWS } from "../gen/rows";
import type { WorldPos } from "../gen/WorldPos";
import { clampToMap } from "../map/transform";
import type { DoorNow } from "../match/timeline";
import { BUILD_KEYS, WRITTEN, captured, moreBytes } from "./build";
import { MAX_DOORS, decodeDoors, encodeDoors } from "./codec";

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

const currentDoors = (state: { more: More | undefined } | undefined): DoorNow[] =>
  captured(state?.more).doors ? decodeDoors(state?.more?.doors) : [];

const sameDoorInts = (prev: unknown, next: readonly number[]): boolean => {
  if (next.length === 0) return prev === undefined || (Array.isArray(prev) && prev.length === 0);
  return Array.isArray(prev) && prev.length === next.length && prev.every((v, i) => v === next[i]);
};

function writeDoorsOps(ctx: SceneDoorContext, nextDoors: readonly DoorNow[]): Op[] {
  const written = ctx.written ?? WRITTEN;
  if (ROWS.doors.index >= written) return [];
  const encoded = encodeDoors(nextDoors);
  if (!ctx.state) {
    if (encoded.length === 0) return [];
    const more: More = { rows: DOOR_ROWS, has_doors: true, doors: encoded };
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
  if (encoded.length === 0 && have.has_doors !== true && !hadDoorsKey) return [];
  if (have.has_doors === true && !needBumpRows && sameDoorInts(have.doors, encoded)) return [];
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
  } else if (!sameDoorInts(have.doors, encoded)) {
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
  const cur = currentDoors(ctx.state);
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
  const cur = currentDoors(ctx.state);
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
  const cur = currentDoors(ctx.state);
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
  const cur = currentDoors(ctx.state);
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
  const cur = currentDoors(ctx.state);
  const resolved = resolveDoorIndex(cur, index, expect);
  const target = resolved !== undefined ? cur[resolved] : undefined;
  if (!target) return [];
  const inSight = !target.inSight;
  const next = cur.map((d, i) => (i === resolved || (target.partner !== null && d.id === target.partner) ? { ...d, inSight } : d));
  return writeDoorsOps(ctx, next);
}

/** Remove every doorway touched by `targets` (each unpaired door, or both doors of any linked pair). */
export function removeDoorwaysOps(ctx: SceneDoorContext, targets: Iterable<DoorTarget>): Op[] {
  const cur = currentDoors(ctx.state);
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
  const cur = currentDoors(ctx.state);
  const next = cur.filter((d) => d.team !== team);
  if (next.length === cur.length) return [];
  return writeDoorsOps(ctx, next);
}
