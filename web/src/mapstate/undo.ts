// An undo or redo step, re-decided from the view for a hero's record in a scene that holds its
// heroes (map-state spec §4.5, TD-145).
//
// A step is the inverse the engine recorded: a `SetIf` per key. A record's `hero` and each of
// its build rows are separate keys, each skipped or applied on its own, so a step made across
// another editor's pick or Retake could leave one hero with another's build. Here a record's
// `hero` and build rows in a step hold or fall together:
//
// - The step expects a hero: the one its `hero` write expects, or, where the step doesn't
//   change the hero, the one it carried from when it was made (`SetIf hero h -> h`, which the
//   engine keeps with the step: `Replica::undo_as`). If the record holds another now, someone
//   changed it since: the step leaves the record's hero and build alone.
// - If it holds that hero, the record is written whole: its hero and every build row, as the
//   step leaves them. Whichever of this and another editor's edit the server takes last then
//   decides the slot, whole (as TD-119 does for a pick and a Retake). A step that only clears
//   rows of an unchanged hero goes as it is: a clear is never another hero's build.
// - A step that writes a build with no hero to expect (one made before this build) can't say
//   whose build it is, and leaves it out.
//
// Every other op of the step, on any other record or field, is sent exactly as recorded.

import type { Entry } from "../gen/Entry";
import type { FieldValue } from "../gen/FieldValue";
import type { More } from "../gen/More";
import type { MoreValue } from "../gen/MoreValue";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import { LIMITS } from "../gen/limits";
import { ROWS } from "../gen/rows";
import { fitsTx } from "../match/save";
import { BUILD_KEYS, WRITTEN, captured, moreBytes } from "./build";

type Value = MoreValue | null;

/** A step as it is to be sent: `ops` (empty: the step no longer fits anywhere, and is dropped)
 * and `carry`, what the step it leaves must keep. `changed`: whether it differs from the step
 * as recorded at all (if not, it goes by the plain `undo`/`redo`). */
export interface Decided {
  ops: Op[];
  carry: Op[];
  changed: boolean;
}

/** A hero's slot keys: its hero and its build rows. Made on first use: the session imports this
 * module, and `build.ts` reaches the session through its own imports, so `BUILD_KEYS` may not
 * be defined yet when this module loads. */
let slotKeys: Set<string> | undefined;
const isSlot = (key: string) => (slotKeys ??= new Set<string>(["hero", ...BUILD_KEYS])).has(key);
const same = (x: Value, y: Value) => JSON.stringify(x) === JSON.stringify(y);
const more = (key: string, value: Value): FieldValue => ({ More: { key, value } });

/** The slot key an op writes on a record (`hero` or a build row), and how. */
function slotWrite(op: Op): { id: RecordId; key: string; expect: Value | undefined; value: Value } | undefined {
  const w = "Set" in op ? { id: op.Set.id, value: op.Set.value, expect: undefined } : "SetIf" in op ? { id: op.SetIf.id, value: op.SetIf.value, expect: op.SetIf.expect } : undefined;
  if (!w || !("More" in w.value) || !isSlot(w.value.More.key)) return undefined;
  const expect = w.expect && "More" in w.expect ? w.expect.More.value : undefined;
  return { id: w.id, key: w.value.More.key, expect, value: w.value.More.value };
}

/** The hero records of scenes that hold their heroes, as the view has them. A deleted scene or
 * state counts as it was: a scene's hero records are never deleted with it, so a step still
 * writes them, and restoring the scene shows what it wrote (review B1). */
function ownHeroes(records: ReadonlyMap<RecordId, Entry>): Set<RecordId> {
  const scenes = new Set<RecordId>();
  for (const [, e] of records) if ("SceneState" in e.record && captured(e.record.SceneState.more).heroes) scenes.add(e.record.SceneState.scene);
  const out = new Set<RecordId>();
  if (scenes.size) for (const [id, e] of records) if (!e.deleted && "PlayerState" in e.record && scenes.has(e.record.PlayerState.scene)) out.add(id);
  return out;
}

/** Phase 5 capture features whose hero or `SceneState` payload rows must stay atomic with their
 * `has_*` flag on redo: when a redo transitions a scene from uncaptured to captured for a feature
 * (via explicit `has_*`, `Create`, `Restore` of a deleted `SceneState`, or a watermark `rows` bump
 * activating a dormant `has_*`), preflight `max_more_bytes` on touched hero and `SceneState`
 * records and rewrite matching non-null payload `SetIf` ops to `Op::Set` so neither a settled nor
 * a concurrent near-cap edit can leave `has_*` captured with missing hero or Group B baseline data
 * (under `UNFIT_UNDO`, an overflowing `SetIf` would otherwise be silently skipped). */
type Phase5UndoFeature = "sight" | "cc" | "movement" | "lanes" | "skulls" | "camps" | "powerups" | "obj_health" | "rifts" | "urn" | "rejuv";
const PHASE5_UNDO_FEATURES: readonly Phase5UndoFeature[] = [
  "sight",
  "cc",
  "movement",
  "lanes",
  "skulls",
  "camps",
  "powerups",
  "obj_health",
  "rifts",
  "urn",
  "rejuv",
];
const HERO_KEY_FEATURE: Record<string, Phase5UndoFeature> = {
  unseen: "sight",
  cc: "cc",
  height: "movement",
  zipline: "movement",
};
const STATE_KEY_FEATURE: Record<string, Phase5UndoFeature> = {
  skulls: "skulls",
  camps: "camps",
  powerups: "powerups",
  obj_health: "obj_health",
  rift: "rifts",
  urn: "urn",
  urn_at: "urn",
  rejuv: "rejuv",
};
const STATE_FLAG_FEATURE: Record<string, Phase5UndoFeature> = {
  has_sight: "sight",
  has_cc: "cc",
  has_movement: "movement",
  has_lanes: "lanes",
  has_skulls: "skulls",
  has_camps: "camps",
  has_powerups: "powerups",
  has_obj_health: "obj_health",
  has_rifts: "rifts",
  has_urn: "urn",
  has_rejuv: "rejuv",
};

function moreWrite(op: Op): { id: RecordId; key: string; expect: Value | undefined; value: Value; isSetIf: boolean } | undefined {
  if ("Set" in op && "More" in op.Set.value) {
    return { id: op.Set.id, key: op.Set.value.More.key, expect: undefined, value: op.Set.value.More.value, isSetIf: false };
  }
  if ("SetIf" in op && "More" in op.SetIf.value) {
    const expect = "More" in op.SetIf.expect ? op.SetIf.expect.More.value : undefined;
    return { id: op.SetIf.id, key: op.SetIf.value.More.key, expect, value: op.SetIf.value.More.value, isSetIf: true };
  }
  return undefined;
}

/** Find every `(sceneId, feature)` and `(stateId, feature)` that transitions from `!before[f]` to
 * `after[f]` when `ops` runs on `records` (covering `Create`, `Restore`, `Set`, `SetIf`, and
 * watermark-only activation), along with each touched `SceneState`'s projected `afterMore`. */
function activatingPhase5(ops: Op[], records: ReadonlyMap<RecordId, Entry>): {
  byScene: Map<RecordId, Set<Phase5UndoFeature>>;
  byState: Map<RecordId, { features: Set<Phase5UndoFeature>; afterMore: More }>;
} {
  const touchedStates = new Set<RecordId>();
  for (const o of ops) {
    if ("Create" in o && "SceneState" in o.Create.record) {
      touchedStates.add(o.Create.id);
    } else {
      const id = "Restore" in o ? o.Restore.id : "Delete" in o ? o.Delete.id : "Set" in o ? o.Set.id : "SetIf" in o ? o.SetIf.id : undefined;
      const e = id ? records.get(id) : undefined;
      if (id && e && "SceneState" in e.record) touchedStates.add(id);
    }
  }
  const byScene = new Map<RecordId, Set<Phase5UndoFeature>>();
  const byState = new Map<RecordId, { features: Set<Phase5UndoFeature>; afterMore: More }>();
  for (const stateId of touchedStates) {
    const existing = records.get(stateId);
    const existingState = existing && "SceneState" in existing.record ? existing.record.SceneState : undefined;
    let sceneId: RecordId | undefined = existingState?.scene;
    let exists = !!existingState;
    let live = !!existing && !existing.deleted && !!existingState;
    const before = live ? captured(existingState!.more) : captured(undefined);
    let afterMore: More = existingState ? { ...(existingState.more ?? {}) } : {};

    for (const o of ops) {
      if ("Create" in o && o.Create.id === stateId && "SceneState" in o.Create.record) {
        if (!exists) {
          sceneId = o.Create.record.SceneState.scene;
          exists = true;
          live = true;
          afterMore = { ...(o.Create.record.SceneState.more ?? {}) };
        }
      } else if ("Restore" in o && o.Restore.id === stateId) {
        // Restore only clears the deletion bit (`validate.rs:476`), preserving projected `more`.
        if (!live && exists) live = true;
      } else if ("Delete" in o && o.Delete.id === stateId) {
        live = false;
      } else {
        const w = moreWrite(o);
        if (!w || w.id !== stateId || !live) continue;
        if (!w.isSetIf || same(afterMore[w.key] ?? null, w.expect ?? null)) {
          if (w.value === null) delete afterMore[w.key];
          else afterMore[w.key] = w.value;
        }
      }
    }
    if (!sceneId) continue;
    const after = live ? captured(afterMore) : captured(undefined);
    for (const f of PHASE5_UNDO_FEATURES) {
      if (!before[f] && after[f]) {
        let sceneSet = byScene.get(sceneId);
        if (!sceneSet) byScene.set(sceneId, (sceneSet = new Set()));
        sceneSet.add(f);
        let stateInfo = byState.get(stateId);
        if (!stateInfo) byState.set(stateId, (stateInfo = { features: new Set(), afterMore }));
        stateInfo.features.add(f);
      }
    }
  }
  return { byScene, byState };
}

/** Preflight and harden a Phase 5 capture redo step: for each activating feature on a hero or
 * `SceneState`, walk every matching op (whose `SetIf` expectation still matches current `more`,
 * preserving settled edits when mismatched) and check `moreBytes(proj) <= LIMITS.max_more_bytes`
 * after each op (matching `crates/schema/src/validate.rs:436`). If any intermediate or final
 * state exceeds the cap, drop the whole step; otherwise rewrite matching activating hero payloads,
 * `SceneState` payloads, and `SceneState` `has_*` flags (`SetIf` -> `Op::Set`) so concurrent byte
 * pressure aborts the entire redo transaction atomically on the server rather than partially
 * skipping later features under `UNFIT_UNDO`. */
function hardenPhase5CaptureRedo(ops: Op[], carry: Op[], changed: boolean, records: ReadonlyMap<RecordId, Entry>): Decided {
  if (!ops.length) return { ops, carry, changed };
  const { byScene, byState } = activatingPhase5(ops, records);
  if (!byScene.size && !byState.size) return { ops, carry, changed };

  const rewriteIndices = new Set<number>();

  // 1. Check `SceneState` records activating Phase 5 features (Group A flags + skulls + Group B).
  for (const [stateId, { features, afterMore }] of byState) {
    if (moreBytes(afterMore) > LIMITS.max_more_bytes) {
      return { ops: [], carry: [], changed: true };
    }
    const existing = records.get(stateId);
    const existingState = existing && "SceneState" in existing.record ? existing.record.SceneState : undefined;
    let exists = !!existingState;
    let live = !!existing && !existing.deleted && !!existingState;
    let proj: More = existingState ? { ...(existingState.more ?? {}) } : {};
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i]!;
      if ("Create" in o && o.Create.id === stateId && "SceneState" in o.Create.record) {
        if (!exists) {
          exists = true;
          live = true;
          proj = { ...(o.Create.record.SceneState.more ?? {}) };
          if (moreBytes(proj) > LIMITS.max_more_bytes) return { ops: [], carry: [], changed: true };
        }
        continue;
      }
      if ("Restore" in o && o.Restore.id === stateId) {
        if (!live && exists) live = true;
        continue;
      }
      if ("Delete" in o && o.Delete.id === stateId) {
        live = false;
        continue;
      }
      const w = moreWrite(o);
      if (!w || w.id !== stateId || !live) continue;
      if (w.isSetIf && !same(proj[w.key] ?? null, w.expect ?? null)) continue;
      if (w.value === null) delete proj[w.key];
      else proj[w.key] = w.value;
      if (moreBytes(proj) > LIMITS.max_more_bytes) return { ops: [], carry: [], changed: true };
      const payloadF = STATE_KEY_FEATURE[w.key];
      const flagF = STATE_FLAG_FEATURE[w.key];
      if (w.isSetIf && ((payloadF && features.has(payloadF) && w.value !== null) || (flagF && features.has(flagF) && w.value === true))) {
        rewriteIndices.add(i);
      }
    }
  }

  // 2. Check hero records activating Group A hero features (`sight`, `cc`, `movement`).
  const heroIds = new Set<RecordId>();
  for (const o of ops) {
    const w = moreWrite(o);
    if (!w || w.value === null) continue;
    const f = HERO_KEY_FEATURE[w.key];
    if (!f) continue;
    const e = records.get(w.id);
    if (e && !e.deleted && "PlayerState" in e.record && byScene.get(e.record.PlayerState.scene)?.has(f)) {
      heroIds.add(w.id);
    }
  }

  for (const id of heroIds) {
    const e = records.get(id)!;
    const ps = (e.record as { PlayerState: { scene: RecordId; more?: More } }).PlayerState;
    const active = byScene.get(ps.scene)!;
    const proj: More = { ...(ps.more ?? {}) };
    let appliedActive = false;
    let peakExceeded = false;
    for (let i = 0; i < ops.length; i++) {
      const w = moreWrite(ops[i]!);
      if (!w || w.id !== id) continue;
      if (w.isSetIf && !same(proj[w.key] ?? null, w.expect ?? null)) continue;
      if (w.value === null) delete proj[w.key];
      else proj[w.key] = w.value;
      if (moreBytes(proj) > LIMITS.max_more_bytes) peakExceeded = true;
      const f = HERO_KEY_FEATURE[w.key];
      if (f && active.has(f) && w.value !== null) {
        appliedActive = true;
        if (w.isSetIf) rewriteIndices.add(i);
      }
    }
    if (appliedActive && (peakExceeded || moreBytes(proj) > LIMITS.max_more_bytes)) {
      return { ops: [], carry: [], changed: true };
    }
  }

  if (!rewriteIndices.size) return { ops, carry, changed };
  const hardened = ops.map((o, i): Op => {
    if (!rewriteIndices.has(i)) return o;
    const w = moreWrite(o)!;
    return { Set: { id: w.id, value: more(w.key, w.value) } };
  });
  return { ops: hardened, carry, changed: true };
}

/** `step` (the ops `nextUndo`/`nextRedo` show) as this client sends it, decided on `records`
 * (the view). `written`: the rows this build writes (a row still `ahead` is never named unless
 * the record holds it, as for a pick). */
export function decideStep(step: Op[], records: ReadonlyMap<RecordId, Entry>, written: number = WRITTEN): Decided {
  const own = step.some((o) => slotWrite(o)) ? ownHeroes(records) : new Set<RecordId>();
  const groups = new Map<RecordId, number[]>();
  if (own.size) {
    step.forEach((o, i) => {
      const w = slotWrite(o);
      if (w && own.has(w.id)) groups.set(w.id, [...(groups.get(w.id) ?? []), i]);
    });
  }
  if (!groups.size) return hardenPhase5CaptureRedo(step, [], false, records);

  const whole = new Map<RecordId, Op[]>();
  const kept = new Map<RecordId, Op[]>();
  const carry: Op[] = [];
  for (const [id, at] of groups) {
    const writes = at.map((i) => slotWrite(step[i]!)!);
    const e = records.get(id)!;
    const have = ("PlayerState" in e.record ? e.record.PlayerState.more : undefined) ?? {};
    const now: Value = have.hero ?? null;
    const heroes = writes.filter((w) => w.key === "hero");
    const rows = writes.filter((w) => w.key !== "hero");
    const asserted = (h: Value): Op => ({ SetIf: { id, expect: more("hero", h), value: more("hero", h) } });
    const expected = heroes[0]?.expect;
    if (expected === undefined) {
      // No hero to expect: a clear is safe whoever the hero is; a build is nobody's to give.
      if (heroes.length || rows.some((w) => w.value !== null)) continue;
      kept.set(id, at.map((i) => step[i]!));
      carry.push(asserted(now));
      continue;
    }
    // Someone gave the record another hero since: its hero and build stay as they are.
    if (!same(now, expected)) continue;
    const goal = heroes.filter((w) => w.expect !== undefined && same(w.expect, expected)).at(-1)!.value;
    const moved = !same(goal, expected);
    const to = new Map<string, Value>();
    for (const k of BUILD_KEYS) {
      // A new hero holds only the build the step gives it; the same hero keeps what it has
      // where the step's writes, in order, wouldn't apply.
      let v: Value = moved ? null : (have[k] ?? null);
      for (const w of rows) if (w.key === k && (moved || w.expect === undefined || same(v, w.expect))) v = w.value;
      to.set(k, v);
    }
    if (!moved) carry.push(asserted(goal));
    if (!moved && [...to.values()].every((v) => v === null)) {
      // Only clears of the hero it has: as recorded, but for the assertion.
      kept.set(id, at.filter((i) => slotWrite(step[i]!)!.key !== "hero").map((i) => step[i]!));
      continue;
    }
    const named = BUILD_KEYS.filter((k) => ROWS[k].index < written || have[k] !== undefined || to.get(k) !== null);
    whole.set(id, [
      { Set: { id, value: more("hero", goal) } },
      ...named.filter((k) => to.get(k) === null).map((k): Op => ({ Set: { id, value: more(k, null) } })),
      ...named.filter((k) => to.get(k) !== null).map((k): Op => ({ Set: { id, value: more(k, to.get(k)!) } })),
    ]);
  }

  const build = (wholes: boolean) => {
    const out: Op[] = [];
    step.forEach((o, i) => {
      const w = slotWrite(o);
      const at = w && groups.get(w.id);
      if (!w || !at) return void out.push(o);
      if (at[0] !== i) return;
      const id = w.id;
      if (wholes && whole.has(id)) out.push(...whole.get(id)!);
      else if (kept.has(id)) out.push(...kept.get(id)!);
      else if (whole.has(id)) out.push(...at.map((j) => step[j]!).filter((x) => !isAssertion(x)));
    });
    return out;
  };
  let ops = build(true);
  // Written whole the step may not fit a transaction: then as recorded, decided on the view.
  if (ops.length > LIMITS.max_ops_per_tx || !fitsTx(ops)) ops = build(false);
  return hardenPhase5CaptureRedo(ops, carry, true, records);
}

/** A `SetIf` of a value onto itself: an assertion a step carries, which changes nothing. */
function isAssertion(op: Op): boolean {
  return "SetIf" in op && JSON.stringify(op.SetIf.expect) === JSON.stringify(op.SetIf.value);
}
