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
