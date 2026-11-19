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
import type { MoreValue } from "../gen/MoreValue";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import { LIMITS } from "../gen/limits";
import { ROWS } from "../gen/rows";
import { fitsTx } from "../match/save";
import { BUILD_KEYS, WRITTEN, captured } from "./build";

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

/** The hero records of scenes that hold their heroes, as the view has them. */
function ownHeroes(records: ReadonlyMap<RecordId, Entry>): Set<RecordId> {
  const scenes = new Set<RecordId>();
  for (const [, e] of records) {
    if (e.deleted || !("SceneState" in e.record)) continue;
    const scene = records.get(e.record.SceneState.scene);
    if (scene && !scene.deleted && captured(e.record.SceneState.more).heroes) scenes.add(e.record.SceneState.scene);
  }
  const out = new Set<RecordId>();
  if (scenes.size) for (const [id, e] of records) if (!e.deleted && "PlayerState" in e.record && scenes.has(e.record.PlayerState.scene)) out.add(id);
  return out;
}

/** `step` (the ops `nextUndo`/`nextRedo` show) as this client sends it, decided on `records`
 * (the view). `written`: the rows this build writes (a row still `ahead` is never named unless
 * the record holds it, as for a pick). */
export function decideStep(step: Op[], records: ReadonlyMap<RecordId, Entry>, written: number = WRITTEN): Decided {
  const asIs = { ops: step, carry: [], changed: false };
  if (!step.some((o) => slotWrite(o))) return asIs;
  const own = ownHeroes(records);
  const groups = new Map<RecordId, number[]>();
  step.forEach((o, i) => {
    const w = slotWrite(o);
    if (w && own.has(w.id)) groups.set(w.id, [...(groups.get(w.id) ?? []), i]);
  });
  if (!groups.size) return asIs;

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
  return { ops, carry, changed: true };
}

/** A `SetIf` of a value onto itself: an assertion a step carries, which changes nothing. */
function isAssertion(op: Op): boolean {
  return "SetIf" in op && JSON.stringify(op.SetIf.expect) === JSON.stringify(op.SetIf.value);
}
