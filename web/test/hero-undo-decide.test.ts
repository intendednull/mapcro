// The decision an undo or redo goes through for a hero's record in a scene that holds its heroes
// (TD-145, `mapstate/undo.ts`), case by case on a view built by hand. Through the real replica
// and server: scene-hero-undo.test.ts.

import { describe, expect, it } from "vitest";
import type { Entry } from "../src/gen/Entry";
import type { More } from "../src/gen/More";
import type { MoreValue } from "../src/gen/MoreValue";
import type { Op } from "../src/gen/Op";
import type { RecordId } from "../src/gen/RecordId";
import { LIMITS } from "../src/gen/limits";
import { ROWS } from "../src/gen/rows";
import { BUILD_KEYS, WRITTEN, moreBytes } from "../src/mapstate/build";
import { decideStep } from "../src/mapstate/undo";

const SCENE = "00000000000000000000000000000010" as RecordId;
const STATE = "00000000000000000000000000000011" as RecordId;
const H = "00000000000000000000000000000020" as RecordId;
const OTHER = "00000000000000000000000000000021" as RecordId;
const NOTE = "00000000000000000000000000000030" as RecordId;
const M = 13;
const P = 77;
/** A build, as a save stores it (`hero` apart). */
const BUILD: More = { items: [5, 0, -1, -1], abilities: [9, 2, 0, -1, -1], level: 4, kills: 1 };

type Value = MoreValue | null;
const v = (key: string, value: Value) => ({ More: { key, value } });
const setIf = (id: RecordId, key: string, from: Value, to: Value): Op => ({ SetIf: { id, expect: v(key, from), value: v(key, to) } });
const set = (id: RecordId, key: string, to: Value): Op => ({ Set: { id, value: v(key, to) } });
const note: Op = { SetIf: { id: NOTE, expect: { NoteText: "a" }, value: { NoteText: "b" } } };

/** A view: one scene (holding its heroes or not), two hero records and a note. */
function view(o: { own?: boolean; hero?: More; other?: More; sceneGone?: boolean; stateGone?: boolean } = {}): Map<RecordId, Entry> {
  const player = (more: More | undefined): Entry => ({ record: { PlayerState: { scene: SCENE, slot: SCENE, pos: { x: 0, y: 0 }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true, ...(more ? { more } : {}) } } as never, deleted: false });
  return new Map<RecordId, Entry>([
    [SCENE, { record: { Scene: { name: "s", order: "a", clock: null, source: null, live: false, parent: null } } as never, deleted: !!o.sceneGone }],
    [STATE, { record: { SceneState: { scene: SCENE, more: { rows: WRITTEN, ...(o.own !== false ? { has_heroes: true } : {}) } } }, deleted: !!o.stateGone }],
    [H, player(o.hero)],
    [OTHER, player(o.other)],
    [NOTE, { record: { Note: { scene: SCENE, pos: { x: 0, y: 0 }, text: "b" } } as never, deleted: false }],
  ]);
}
/** The step a pick of P over M with BUILD leaves to undo: each row back, then the hero. */
const undoOfPick = (id: RecordId = H): Op[] => [...Object.entries(BUILD).map(([k, x]) => setIf(id, k, null, x)).reverse(), setIf(id, "hero", P, M)];
/** Every build row this build writes, as a whole write names it: the clears, then the values. */
const whole = (hero: number, build: More, id: RecordId = H): Op[] => [
  set(id, "hero", hero),
  ...BUILD_KEYS.filter((k) => build[k] === undefined).map((k) => set(id, k, null)),
  ...BUILD_KEYS.filter((k) => build[k] !== undefined).map((k) => set(id, k, build[k]!)),
];
const assertion = (h: number, id: RecordId = H): Op => setIf(id, "hero", h, h);

describe("a step that writes no hero's record in a scene that holds its heroes goes as recorded", () => {
  it.each([
    ["writes no hero slot", [note, setIf(H, "name", "x", "y")], view()],
    ["is in a scene that doesn't hold its heroes", undoOfPick(), view({ own: false, hero: { hero: P } })],
  ])("one that %s", (_, step, records) => {
    const d = decideStep(step, records);
    expect(d).toEqual({ ops: step, carry: [], changed: false });
    expect(d.ops).toBe(step);
  });
});

// A deleted scene's hero records are not deleted with it: a step still writes them, and a
// Restore of the scene shows what it wrote (review B1). So they are decided as if it were there.
describe("a step that writes a hero's record in a deleted scene that held its heroes", () => {
  it.each([
    ["whose state is deleted", { stateGone: true }],
    ["that is deleted", { sceneGone: true }],
    ["that is deleted with its state", { sceneGone: true, stateGone: true }],
  ])("in a scene %s: decided as in a live one", (_, gone) => {
    expect(decideStep(undoOfPick(), view({ ...gone, hero: { hero: P } }))).toEqual({ ops: whole(M, BUILD), carry: [], changed: true });
    expect(decideStep(undoOfPick(), view({ ...gone, hero: { hero: 78 } }))).toEqual({ ops: [], carry: [], changed: true });
  });
});

it("a hero record of another scene, one that doesn't hold its heroes, goes as recorded beside one that does", () => {
  const records = view({ hero: { hero: P } });
  const SCENE2 = "00000000000000000000000000000012" as RecordId;
  const X = "00000000000000000000000000000022" as RecordId;
  records.set(SCENE2, records.get(SCENE)!);
  const h = records.get(H)!.record as { PlayerState: object };
  records.set(X, { record: { PlayerState: { ...h.PlayerState, scene: SCENE2, more: { hero: P } } } as never, deleted: false });
  const step = undoOfPick(X);
  expect(decideStep(step, records)).toEqual({ ops: step, carry: [], changed: false });
});

describe("a step that writes a hero's record in a scene that holds its heroes", () => {
  it("that fits and gives the record another hero: the record whole, other ops as they were and where they were", () => {
    const step = [note, ...undoOfPick(), setIf(OTHER, "name", "x", "y")];
    const d = decideStep(step, view({ hero: { hero: P } }));
    expect(d.ops).toEqual([note, ...whole(M, BUILD), setIf(OTHER, "name", "x", "y")]);
    // The step it leaves has the hero's own write: no assertion is needed.
    expect(d.carry).toEqual([]);
    expect(d.changed).toBe(true);
  });

  it("that fits and gives another hero no build: every build row cleared", () => {
    const d = decideStep([setIf(H, "hero", M, P)], view({ hero: { hero: M, ...BUILD } }));
    expect(d.ops).toEqual(whole(P, {}));
    expect(d.carry).toEqual([]);
  });

  it("a new hero holds the step's build even where the view held something else", () => {
    const d = decideStep([setIf(H, "level", null, 4), setIf(H, "kills", 3, 1), setIf(H, "hero", P, M)], view({ hero: { hero: P, level: 9 } }));
    expect(d.ops).toEqual(whole(M, { level: 4, kills: 1 }));
  });

  it("that no longer fits (someone gave the record another hero): its hero and build left out, the rest sent", () => {
    const step = [note, ...undoOfPick()];
    const d = decideStep(step, view({ hero: { hero: 78 } }));
    expect(d).toEqual({ ops: [note], carry: [], changed: true });
  });

  it("that no longer fits anywhere: nothing to send", () => {
    expect(decideStep(undoOfPick(), view({ hero: { hero: 78 } }))).toEqual({ ops: [], carry: [], changed: true });
    // A record with no hero is not one with P.
    expect(decideStep(undoOfPick(), view({ hero: {} })).ops).toEqual([]);
  });

  it("that fills the build of the hero it has: the record whole, and the hero carried", () => {
    const fill = Object.entries(BUILD).map(([k, x]) => setIf(H, k, null, x));
    const d = decideStep([assertion(M), ...fill], view({ hero: { hero: M } }));
    expect(d.ops).toEqual(whole(M, BUILD));
    expect(d.carry).toEqual([assertion(M)]);
  });

  it("a same hero keeps a row of its own where the step's write wouldn't apply, and takes the rest", () => {
    const d = decideStep([assertion(M), setIf(H, "level", null, 4), setIf(H, "kills", null, 1)], view({ hero: { hero: M, level: 9 } }));
    expect(d.ops).toEqual(whole(M, { level: 9, kills: 1 }));
    // The view's hero is the one asserted (the hero's write `M -> M` is the goal).
    expect(d.carry).toEqual([assertion(M)]);
  });

  it("a same hero takes the step's writes in order, as the engine would apply them", () => {
    const chain = [assertion(M), setIf(H, "level", 9, 5), setIf(H, "level", 5, 4), set(H, "kills", 2)];
    expect(decideStep(chain, view({ hero: { hero: M, level: 9, kills: 1 } })).ops).toEqual(whole(M, { level: 4, kills: 2 }));
    // The first write no longer applies, so neither does the one after it.
    expect(decideStep(chain, view({ hero: { hero: M, level: 8, kills: 1 } })).ops).toEqual(whole(M, { level: 8, kills: 2 }));
  });

  it("a step on a hero record that is gone goes as recorded", () => {
    const records = view({ hero: { hero: P } });
    records.set(H, { ...records.get(H)!, deleted: true });
    expect(decideStep(undoOfPick(), records)).toEqual({ ops: undoOfPick(), carry: [], changed: false });
  });

  it("a carried hero that is no longer the record's: the fill is left out", () => {
    const fill = Object.entries(BUILD).map(([k, x]) => setIf(H, k, null, x));
    expect(decideStep([assertion(M), ...fill, note], view({ hero: { hero: P } }))).toEqual({ ops: [note], carry: [], changed: true });
  });

  it("that only clears the build of the hero it has: as recorded but the assertion, and the hero carried", () => {
    const clear = Object.entries(BUILD).map(([k, x]) => setIf(H, k, x, null));
    const d = decideStep([assertion(M), ...clear], view({ hero: { hero: M, ...BUILD } }));
    expect(d.ops).toEqual(clear);
    expect(d.carry).toEqual([assertion(M)]);
  });

  it("a clear the view's rows don't match is no clear: the record whole with what it holds", () => {
    const d = decideStep([assertion(M), setIf(H, "level", 4, null)], view({ hero: { hero: M, level: 9 } }));
    expect(d.ops).toEqual(whole(M, { level: 9 }));
  });

  it("a step with no hero to expect that only clears: as recorded, the view's hero carried", () => {
    const clear = Object.entries(BUILD).map(([k, x]) => setIf(H, k, x, null));
    const d = decideStep(clear, view({ hero: { hero: M, ...BUILD } }));
    expect(d).toEqual({ ops: clear, carry: [assertion(M)], changed: true });
  });

  it("a step with no hero to expect that writes a build: whose it is can't be told, so it is left out", () => {
    const fill = Object.entries(BUILD).map(([k, x]) => setIf(H, k, null, x));
    expect(decideStep([...fill, note], view({ hero: { hero: M } }))).toEqual({ ops: [note], carry: [], changed: true });
    // A `Set` of the hero (no expectation) says no more.
    expect(decideStep([set(H, "hero", M)], view({ hero: { hero: M } })).ops).toEqual([]);
  });

  it("two hero records, each decided on its own", () => {
    const step = [...undoOfPick(H), ...undoOfPick(OTHER)];
    const d = decideStep(step, view({ hero: { hero: P }, other: { hero: 78 } }));
    expect(d.ops).toEqual(whole(M, BUILD, H));
  });

  it("a row this build doesn't write yet is named only if the record holds it or the step writes it", () => {
    const later = ROWS.max_health.index; // as if `max_health` were still ahead
    const d = decideStep([setIf(H, "hero", M, P)], view({ hero: { hero: M, kills: 1 } }), later);
    const named = (ops: Op[]) => ops.map((o) => ("Set" in o && "More" in o.Set.value ? o.Set.value.More.key : "?"));
    expect(named(d.ops)).toContain("kills");
    expect(named(d.ops)).not.toContain("max_health");
    const f = decideStep([setIf(H, "max_health", null, 900), setIf(H, "hero", P, M)], view({ hero: { hero: P } }), later);
    expect(named(f.ops)).toContain("max_health");
    // Held but not written by this build: cleared with the rest when the hero changes.
    const h = decideStep([setIf(H, "hero", M, P)], view({ hero: { hero: M, max_health: 900 } }), later);
    expect(h.ops).toContainEqual(set(H, "max_health", null));
  });

  it("written whole the step wouldn't fit a transaction: as recorded for the records that fit, decided on the view", () => {
    // Many records' hero writes: whole, each would be every build row.
    const ids = Array.from({ length: 40 }, (_, i) => `000000000000000000000000000001${(i + 10).toString(16).padStart(2, "0")}` as RecordId);
    const records = view();
    for (const id of ids) records.set(id, { ...records.get(H)!, record: { PlayerState: { ...(records.get(H)!.record as { PlayerState: object }).PlayerState, more: { hero: P } } } as never });
    records.set(ids[0]!, { ...records.get(ids[0]!)!, record: { PlayerState: { ...(records.get(H)!.record as { PlayerState: object }).PlayerState, more: { hero: 78 } } } as never });
    const step = ids.flatMap((id) => [assertion(P, id), setIf(id, "hero", P, M)]);
    expect(ids.length * whole(M, {}).length).toBeGreaterThan(LIMITS.max_ops_per_tx);
    const d = decideStep(step, records);
    // The first no longer fits and is left out; the rest go as recorded, without assertions.
    expect(d.ops).toEqual(ids.slice(1).map((id) => setIf(id, "hero", P, M)));
  });

  // Astra Round 3 #3: Redo restoring a Group A capture (`has_sight`/`has_cc`/`has_movement` = true
  // alongside non-null hero keys) preflights `max_more_bytes` and hardens hero ops to `Op::Set`.
  describe("Group A capture redo hardening (Astra Round 3 #3)", () => {
    const captureRedo: Op[] = [
      setIf(H, "unseen", null, true),
      setIf(H, "height", null, 1),
      setIf(STATE, "has_sight", null, true),
      setIf(STATE, "has_movement", null, true),
      setIf(STATE, "rows", 16, 27),
    ];

    it("fitting hero: rewrites non-null Group A hero writes from SetIf to Set (leaving SceneState SetIf intact)", () => {
      const records = view({ hero: { hero: M, ...BUILD } });
      const d = decideStep(captureRedo, records);
      expect(d.changed).toBe(true);
      expect(d.ops).toEqual([
        set(H, "unseen", true),
        set(H, "height", 1),
        setIf(STATE, "has_sight", null, true),
        setIf(STATE, "has_movement", null, true),
        setIf(STATE, "rows", 16, 27),
      ]);
    });

    it("near-cap hero after a peer's name edit: drops the whole capture redo step instead of leaving has_sight set without unseen", () => {
      const tight: More = {
        hero: M,
        build_order: Array.from({ length: 600 }, () => 4_294_967_295),
        items: [] as number[],
        abilities: [] as number[],
      };
      const items = tight.items as number[];
      while (items.length < 128 && moreBytes({ ...tight, items: [...items, 4_294_967_295] }) <= LIMITS.max_more_bytes - 28) {
        items.push(4_294_967_295);
      }
      const ab = tight.abilities as number[];
      while (ab.length < 48 && moreBytes({ ...tight, abilities: [...ab, 4_294_967_295] }) <= LIMITS.max_more_bytes - 16) {
        ab.push(4_294_967_295);
      }
      let len = 1;
      while (len < LIMITS.max_name && moreBytes({ ...tight, name: "a".repeat(len) }) < LIMITS.max_more_bytes - 4) len++;
      tight.name = "a".repeat(len);
      expect(LIMITS.max_more_bytes - moreBytes(tight)).toBeLessThan(14);

      const records = view({ hero: tight });
      const d = decideStep(captureRedo, records);
      expect(d).toEqual({ ops: [], carry: [], changed: true });
    });

    it("undo clearing Group A (value: null) is left untouched", () => {
      const undoClear: Op[] = [
        setIf(H, "unseen", true, null),
        setIf(H, "height", 1, null),
        setIf(STATE, "has_sight", true, null),
        setIf(STATE, "rows", 27, 16),
      ];
      const records = view({ hero: { hero: M, unseen: true, height: 1 } });
      expect(decideStep(undoClear, records)).toEqual({ ops: undoClear, carry: [], changed: false });
    });
  });
});
