// Scene transactions: reorder is one key between the new neighbours; add copies the scene's
// players and objectives, and nothing else.
import { describe, expect, it } from "vitest";
import { addSceneOps, deleteSceneOps, moveSceneOps, reorderOp, type SceneRow } from "../src/board/scenes";
import { flatten } from "../src/board/tree";
import type { BoardState } from "../src/board/state";
import type { Entry } from "../src/gen/Entry";

const row = (id: string, order: string, clock: number | null = null, parent: string | null = null): SceneRow => ({ id, scene: { name: id, order, clock, parent } });
/** Just enough of the board state for scene edits: records and the scene tree. */
const fake = (scenes: SceneRow[], records: Record<string, Entry> = {}) => {
  const tree = flatten(scenes.map((r) => ({ id: r.id, order: r.scene.order, parent: r.scene.parent, row: r }))).map((t) => ({ scene: t.scene.row, depth: t.depth, parent: t.parent, hasChildren: t.hasChildren }));
  return { records, sceneTree: () => tree, scenes: () => tree.map((t) => t.scene) } as unknown as BoardState;
};
const list = [row("a", "8"), row("b", "i"), row("c", "r")];
const orderOf = (op: ReturnType<typeof reorderOp>) => (op && "Set" in op && "SceneOrder" in op.Set.value ? op.Set.value.SceneOrder : undefined);

describe("reorder", () => {
  it("moves a scene to the front, the end and the middle with one key", () => {
    expect(orderOf(reorderOp(list, "c", 0))! < "8").toBe(true);
    expect(orderOf(reorderOp(list, "a", 2))! > "r").toBe(true);
    const mid = orderOf(reorderOp(list, "a", 1))!;
    expect(mid > "i" && mid < "r").toBe(true);
  });
  it("sends nothing when a scene is dropped where it was", () => {
    expect(reorderOp(list, "b", 1)).toBeUndefined();
  });
});

describe("add scene", () => {
  it("starts after the current scene, from its positions and objectives, without its ink", () => {
    const records: Record<string, Entry> = {
      p1: { deleted: false, record: { PlayerState: { scene: "b", slot: "s1", pos: { x: 5, y: 6 }, alive: false, placed: true, souls: 900, ult_cooldown: 0, visible: true } } },
      p2: { deleted: false, record: { PlayerState: { scene: "a", slot: "s1", pos: { x: 1, y: 1 }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true } } },
      o1: { deleted: false, record: { ObjectiveState: { scene: "b", key: "walker:amber:lane1:1", status: "Destroyed" } } },
      w1: { deleted: false, record: { Wave: { scene: "b", lane: "lane4", t: 640 } } },
      k1: { deleted: false, record: { Stroke: { scene: "b", points: [{ x: 0, y: 0 }], color: 1, width: 30 } } },
      gone: { deleted: true, record: { ObjectiveState: { scene: "b", key: "guardian:amber:lane1:1", status: "Hidden" } } },
    };
    let n = 0;
    const { id, ops } = addSceneOps(fake(list, records), list[1], false, () => `new${n++}`);
    expect(id).toBe("new0");
    const [scene, ...rest] = ops;
    const s = scene && "Create" in scene && "Scene" in scene.Create.record ? scene.Create.record.Scene : undefined;
    expect(s?.order! > "i" && s?.order! < "r").toBe(true);
    expect(s?.name).toBe(""); // unnamed: shown as "Scene N" by its place
    const kinds = rest.map((o) => ("Create" in o ? Object.keys(o.Create.record)[0] : "?"));
    expect(kinds.sort()).toEqual(["ObjectiveState", "PlayerState", "Wave"]);
    const w = rest.find((o) => "Create" in o && "Wave" in o.Create.record);
    expect(w && "Create" in w && "Wave" in w.Create.record && w.Create.record.Wave).toEqual({ scene: "new0", lane: "lane4", t: 640 });
    const p = rest.find((o) => "Create" in o && "PlayerState" in o.Create.record);
    expect(p && "Create" in p && "PlayerState" in p.Create.record && p.Create.record.PlayerState).toMatchObject({ scene: "new0", pos: { x: 5, y: 6 }, alive: false, souls: 900 });
  });
});

describe("scene tree edits", () => {
  // a ─ a1, a2;  b
  const tree = [row("a", "8"), row("a1", "8", null, "a"), row("a2", "i", null, "a"), row("b", "r")];
  const st = fake(tree);
  const sets = (ops: ReturnType<typeof moveSceneOps>) => ops.map((o) => ("Set" in o ? Object.keys(o.Set.value)[0] : "Delete" in o ? "Delete" : "?"));

  it("adds a child last among the current scene's children, and a sibling right after it", () => {
    const child = addSceneOps(st, tree[0], true, () => "n").ops[0]!;
    const c = "Create" in child && "Scene" in child.Create.record ? child.Create.record.Scene : undefined;
    expect(c?.parent).toBe("a");
    expect(c!.order > "i").toBe(true);
    const after = addSceneOps(st, tree[1], false, () => "m").ops[0]!;
    const a = "Create" in after && "Scene" in after.Create.record ? after.Create.record.Scene : undefined;
    expect(a?.parent).toBe("a");
    expect(a!.order > "8" && a!.order < "i").toBe(true);
    const top = addSceneOps(st, tree[3], false, () => "t").ops[0]!;
    expect("Create" in top && "Scene" in top.Create.record && top.Create.record.Scene.parent).toBeFalsy();
  });

  it("drops: before or after a sibling reorders; into a row nests; each one transaction", () => {
    const ops = moveSceneOps(st, "a2", "a1", "before");
    expect(sets(ops)).toEqual(["SceneOrder"]);
    const nest = moveSceneOps(st, "b", "a1", "into");
    expect(nest[0]).toEqual({ Set: { id: "b", value: { SceneParent: "a1" } } });
    expect(sets(nest)).toEqual(["SceneParent", "SceneOrder"]);
    const out = moveSceneOps(st, "a1", "b", "after");
    expect(out[0]).toEqual({ Set: { id: "a1", value: { SceneParent: null } } });
    const o = out[1] && "Set" in out[1] && "SceneOrder" in out[1].Set.value ? out[1].Set.value.SceneOrder : "";
    expect(o > "r").toBe(true);
  });

  it("refuses to nest a scene under itself or its own child, and ignores a drop where it was", () => {
    expect(moveSceneOps(st, "a", "a1", "into")).toEqual([]);
    expect(moveSceneOps(st, "a", "a2", "after")).toEqual([]);
    expect(moveSceneOps(st, "a1", "a2", "before")).toEqual([]);
  });

  it("deleting a parent moves its children up to the grandparent, in the same transaction", () => {
    expect(deleteSceneOps(st, "a")).toEqual([
      { Set: { id: "a1", value: { SceneParent: null } } },
      { Set: { id: "a2", value: { SceneParent: null } } },
      { Delete: { id: "a" } },
    ]);
    expect(deleteSceneOps(fake([row("only", "8")]), "only")).toEqual([]);
  });
});
