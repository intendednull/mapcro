// Scene transactions: reorder is one key between the new neighbours; add copies the scene's
// players and objectives, and nothing else.
import { describe, expect, it } from "vitest";
import { addSceneOps, reorderOp, type SceneRow } from "../src/board/scenes";
import type { BoardState } from "../src/board/state";
import type { Entry } from "../src/gen/Entry";

const row = (id: string, order: string, clock: number | null = null): SceneRow => ({ id, scene: { name: id, order, clock } });
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
      k1: { deleted: false, record: { Stroke: { scene: "b", points: [{ x: 0, y: 0 }], color: 1, width: 30 } } },
      gone: { deleted: true, record: { ObjectiveState: { scene: "b", key: "guardian:amber:lane1:1", status: "Hidden" } } },
    };
    let n = 0;
    const { id, ops } = addSceneOps({ records } as unknown as BoardState, list, list[1], () => `new${n++}`);
    expect(id).toBe("new0");
    const [scene, ...rest] = ops;
    const s = scene && "Create" in scene && "Scene" in scene.Create.record ? scene.Create.record.Scene : undefined;
    expect(s?.order! > "i" && s?.order! < "r").toBe(true);
    expect(s?.name).toBe("Scene 4");
    const kinds = rest.map((o) => ("Create" in o ? Object.keys(o.Create.record)[0] : "?"));
    expect(kinds.sort()).toEqual(["ObjectiveState", "PlayerState"]);
    const p = rest.find((o) => "Create" in o && "PlayerState" in o.Create.record);
    expect(p && "Create" in p && "PlayerState" in p.Create.record && p.Create.record.PlayerState).toMatchObject({ scene: "new0", pos: { x: 5, y: 6 }, alive: false, souls: 900 });
  });
});
