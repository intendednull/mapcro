import { describe, expect, it } from "vitest";
import { type Current, isOn, toggleOps } from "../src/board/objectives";

const walker = { kind: "t2" as const, key: "walker:amber:lane1:1" };
const camp = { kind: "camp" as const, key: "camp:neutral:lane1:10" };
const mid = { kind: "midboss" as const, key: "mid_boss:neutral:lane4:1" };
const west = { kind: "koth" as const, key: "rift:neutral:lane1:1" };
const east = { kind: "koth" as const, key: "rift:neutral:lane6:1" };
const all = [walker, camp, mid, west, east];
let n = 0;
const mint = () => `id${n++}`;

describe("objective clicks", () => {
  it("flip between active and destroyed, never hidden", () => {
    expect(toggleOps(walker, all, new Map(), "s", mint)).toEqual([{ Create: { id: "id0", record: { ObjectiveState: { scene: "s", key: walker.key, status: "Destroyed" } } } }]);
    const destroyed: Current = new Map([[walker.key, { id: "w", status: "Destroyed" }]]);
    expect(toggleOps(walker, all, destroyed, "s", mint)).toEqual([{ Set: { id: "w", value: { ObjectiveStatus: "Active" } } }]);
    // An old "hidden" comes back as active.
    const hidden: Current = new Map([[walker.key, { id: "w", status: "Hidden" }]]);
    expect(toggleOps(walker, all, hidden, "s", mint)).toEqual([{ Set: { id: "w", value: { ObjectiveStatus: "Active" } } }]);
  });
  it("a patron goes stage 1 → stage 2 → destroyed → stage 1, and only the clicked patron", () => {
    const amber = { kind: "t3" as const, key: "patron:amber:lane0:1" };
    const sapphire = { kind: "t3" as const, key: "patron:sapphire:lane0:1" };
    const both = [...all, amber, sapphire];
    const first = toggleOps(amber, both, new Map(), "s", mint);
    expect(first).toEqual([{ Create: { id: expect.any(String), record: { ObjectiveState: { scene: "s", key: amber.key, status: "Stage2" } } } }]);
    const stage2: Current = new Map([[amber.key, { id: "a", status: "Stage2" }]]);
    expect(isOn(amber, stage2)).toBe(true);
    expect(toggleOps(amber, both, stage2, "s", mint)).toEqual([{ Set: { id: "a", value: { ObjectiveStatus: "Destroyed" } } }]);
    const down: Current = new Map([[amber.key, { id: "a", status: "Destroyed" }], [sapphire.key, { id: "b", status: "Stage2" }]]);
    expect(toggleOps(amber, both, down, "s", mint)).toEqual([{ Set: { id: "a", value: { ObjectiveStatus: "Active" } } }]);
    expect(toggleOps(sapphire, both, down, "s", mint)).toEqual([{ Set: { id: "b", value: { ObjectiveStatus: "Destroyed" } } }]);
  });
  it("camps and the mid boss toggle the same way", () => {
    for (const m of [camp, mid]) {
      expect(isOn(m, new Map())).toBe(true);
      expect(toggleOps(m, all, new Map(), "s", mint)[0]).toMatchObject({ Create: { record: { ObjectiveState: { key: m.key, status: "Destroyed" } } } });
    }
  });
  it("rifts start off; turning one on turns the other off in the same transaction; both can be off", () => {
    expect(isOn(west, new Map())).toBe(false);
    expect(toggleOps(west, all, new Map(), "s", mint)).toHaveLength(1);
    const westOn: Current = new Map([[west.key, { id: "r1", status: "Active" }]]);
    const ops = toggleOps(east, all, westOn, "s", mint);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ Create: { record: { ObjectiveState: { key: east.key, status: "Active" } } } });
    expect(ops[1]).toEqual({ Set: { id: "r1", value: { ObjectiveStatus: "Destroyed" } } });
    expect(toggleOps(west, all, westOn, "s", mint)).toEqual([{ Set: { id: "r1", value: { ObjectiveStatus: "Destroyed" } } }]);
  });
});

import { groupToggleOps, marqueePick } from "../src/board/objectives";
describe("objective groups", () => {
  const camps = [1, 2, 3].map((i) => ({ kind: "camp" as const, key: `camp:neutral:lane0:${i}` }));
  const keys = (ops: ReturnType<typeof groupToggleOps>) =>
    ops.map((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [o.Create.record.ObjectiveState.key, o.Create.record.ObjectiveState.status] : "Set" in o && "ObjectiveStatus" in o.Set.value ? [o.Set.id, o.Set.value.ObjectiveStatus] : ["?"]));

  it("a drag-select takes heroes if there are any inside, else every objective inside", () => {
    const rect = { x0: 0, y0: 0, x1: 100, y1: 100 };
    const objs = [{ key: "camp:a", at: { x: 10, y: 10 } }, { key: "camp:b", at: { x: 50, y: 50 } }, { key: "camp:c", at: { x: 500, y: 50 } }];
    expect(marqueePick(rect, [{ id: "h1", at: { x: 20, y: 20 } }, { id: "h2", at: { x: 300, y: 1 } }], objs)).toEqual({ heroes: ["h1"], objectives: [] });
    expect(marqueePick(rect, [{ id: "h2", at: { x: 300, y: 1 } }], objs)).toEqual({ heroes: [], objectives: ["camp:a", "camp:b"] });
    expect(marqueePick(rect, [], [])).toEqual({ heroes: [], objectives: [] });
  });

  it("the clicked one sets the direction and the group ends uniform", () => {
    // All alive: clicking one clears them all.
    expect(keys(groupToggleOps(camps[0]!, camps, all, new Map(), "s", mint))).toEqual(camps.map((c) => [c.key, "Destroyed"]));
    // Mixed, clicked one cleared: everything comes back; the ones already alive need no op.
    const mixed: Current = new Map([[camps[0]!.key, { id: "c1", status: "Destroyed" }], [camps[2]!.key, { id: "c3", status: "Destroyed" }]]);
    expect(keys(groupToggleOps(camps[0]!, camps, all, mixed, "s", mint))).toEqual([["c1", "Active"], ["c3", "Active"]]);
    // Mixed, clicked one alive: everything is cleared.
    expect(keys(groupToggleOps(camps[1]!, camps, all, mixed, "s", mint))).toEqual([[camps[1]!.key, "Destroyed"]]);
  });

  it("turning a group on lights one rift only: the clicked one, else the group's first", () => {
    const group = [camps[0]!, west, east];
    const allOff: Current = new Map([[camps[0]!.key, { id: "c1", status: "Destroyed" }]]);
    expect(keys(groupToggleOps(east, group, all, allOff, "s", mint))).toEqual([["c1", "Active"], [east.key, "Active"]]);
    expect(keys(groupToggleOps(camps[0]!, group, all, allOff, "s", mint))).toEqual([["c1", "Active"], [west.key, "Active"]]);
    // A rift outside the group that is on goes off when one in the group comes on.
    const eastOn: Current = new Map([...allOff, [east.key, { id: "r2", status: "Active" }]]);
    expect(keys(groupToggleOps(camps[0]!, [camps[0]!, west], all, eastOn, "s", mint))).toEqual([["c1", "Active"], [west.key, "Active"], ["r2", "Destroyed"]]);
    // Turning a group off turns its rifts off too.
    const westOn: Current = new Map([[west.key, { id: "r1", status: "Active" }]]);
    expect(keys(groupToggleOps(camps[0]!, group, all, westOn, "s", mint))).toEqual([[camps[0]!.key, "Destroyed"], ["r1", "Destroyed"]]);
  });
});

describe("the Soul Urn's points (Sandbox)", () => {
  const uw = { kind: "urn" as const, key: "urn:neutral:lane1:1" };
  const ue = { kind: "urn" as const, key: "urn:neutral:lane6:1" };
  const withUrn = [...all, uw, ue];
  it("start off like the rifts, and one opens at a time without touching the rifts", () => {
    expect(isOn(uw, new Map())).toBe(false);
    expect(toggleOps(uw, withUrn, new Map(), "s", () => "u1")).toEqual([{ Create: { id: "u1", record: { ObjectiveState: { scene: "s", key: uw.key, status: "Active" } } } }]);
    const eastOpen: Current = new Map([[ue.key, { id: "e", status: "Active" }], [west.key, { id: "r", status: "Active" }]]);
    expect(toggleOps(uw, withUrn, eastOpen, "s", () => "u2")).toEqual([
      { Create: { id: "u2", record: { ObjectiveState: { scene: "s", key: uw.key, status: "Active" } } } },
      { Set: { id: "e", value: { ObjectiveStatus: "Destroyed" } } },
    ]);
    expect(toggleOps(ue, withUrn, eastOpen, "s", mint)).toEqual([{ Set: { id: "e", value: { ObjectiveStatus: "Destroyed" } } }]);
  });
  it("in a group turned on, one point opens alongside one rift", () => {
    const keys = (ops: ReturnType<typeof groupToggleOps>) =>
      ops.map((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [o.Create.record.ObjectiveState.key, o.Create.record.ObjectiveState.status] : "Set" in o && "ObjectiveStatus" in o.Set.value ? [o.Set.id, o.Set.value.ObjectiveStatus] : ["?"]));
    expect(keys(groupToggleOps(ue, [uw, ue, west], withUrn, new Map(), "s", mint))).toEqual([[west.key, "Active"], [ue.key, "Active"]]);
  });
});
