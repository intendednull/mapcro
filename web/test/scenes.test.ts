// Scene transactions: reorder is one key between the new neighbours; add copies the scene's
// players and objectives, and nothing else.
import { describe, expect, it } from "vitest";
import { addSceneOps, deleteSceneOps, moveSceneOps, reorderOp, sendScene, type SceneRow } from "../src/board/scenes";
import { flatten } from "../src/board/tree";
import type { BoardState } from "../src/board/state";
import type { Entry } from "../src/gen/Entry";
import { LIMITS } from "../src/gen/limits";
import type { Op } from "../src/gen/Op";
import { opsBytes } from "../src/match/save";

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

describe("a copy of a scene (#54)", () => {
  const records: Record<string, Entry> = {
    p1: { deleted: false, record: { PlayerState: { scene: "b", slot: "s1", pos: { x: 5, y: 6 }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true } } },
    ar: { deleted: false, record: { Arrow: { scene: "b", from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, team: "Amber", color: 3 } } },
    co: { deleted: false, record: { Callout: { scene: "b", pos: { x: 7, y: 8 }, text: "rotate", color: null } } },
    st: { deleted: false, record: { Stroke: { scene: "b", points: [{ x: 0, y: 0 }, { x: 9, y: 9 }], color: 1, width: 30, offset: { x: 2, y: 2 } } } },
    no: { deleted: false, record: { Note: { scene: "b", text: "the plan" } } },
    // Not this scene's, and erased ink: neither is copied.
    other: { deleted: false, record: { Arrow: { scene: "a", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, team: null } } },
    erased: { deleted: true, record: { Callout: { scene: "b", pos: { x: 0, y: 0 }, text: "old" } } },
  };
  const made = (ops: Op[]) => ops.map((o) => ("Create" in o ? o.Create.record : undefined));

  it("takes everything drawn on it: arrows, callouts, ink and the note", () => {
    let n = 0;
    const { id, ops, txs } = addSceneOps(fake(list, records), list[1], false, () => `new${n++}`, "b copy", true);
    expect(made(ops).slice(1)).toEqual([
      { PlayerState: { ...(records.p1!.record as { PlayerState: object }).PlayerState, scene: id } },
      { Arrow: { scene: id, from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, team: "Amber", color: 3 } },
      { Callout: { scene: id, pos: { x: 7, y: 8 }, text: "rotate", color: null } },
      { Stroke: { scene: id, points: [{ x: 0, y: 0 }, { x: 9, y: 9 }], color: 1, width: 30, offset: { x: 2, y: 2 } } },
      { Note: { scene: id, text: "the plan" } },
    ]);
    // Each a record of its own, and all one undo step.
    expect(new Set(ops.map((o) => ("Create" in o ? o.Create.id : ""))).size).toBe(ops.length);
    expect(txs).toEqual([ops]);
  });

  it("a new scene (not a copy) still starts without them", () => {
    const { ops } = addSceneOps(fake(list, records), list[1], false, () => "n");
    expect(made(ops).map((r) => Object.keys(r!)[0])).toEqual(["Scene", "PlayerState"]);
  });
});

describe("a board with no room for the whole new scene", () => {
  const hero = (n: number): Entry => ({ deleted: false, record: { PlayerState: { scene: "b", slot: `s${n}`, pos: { x: n, y: n }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true } } });
  /** A board of `n` records: scene b's two heroes and a stroke, the rest filler (some deleted). */
  const boardOf = (n: number) => {
    const records: Record<string, Entry> = { p1: hero(1), p2: hero(2), k: { deleted: false, record: { Stroke: { scene: "b", points: [{ x: 0, y: 0 }], color: 1, width: 30 } } } };
    for (let i = 0; Object.keys(records).length < n; i++) records[`f${i}`] = { deleted: i % 2 === 0, record: { Stroke: { scene: "a", points: [{ x: i, y: 0 }], color: 1, width: 30 } } };
    return fake(list, records);
  };

  it("makes nothing: no transactions, and it says the board is full", () => {
    let n = 0;
    const mint = () => `new${n++}`;
    // A copy is four records (the scene, two heroes, the stroke); a new scene three.
    const fits = addSceneOps(boardOf(LIMITS.max_records - 4), list[1], false, mint, "", true);
    expect(fits.ops).toHaveLength(4);
    expect([fits.full, fits.txs]).toEqual([false, [fits.ops]]);
    // One record over, deleted records counted: nothing to send.
    const over = addSceneOps(boardOf(LIMITS.max_records - 3), list[1], false, mint, "", true);
    expect(over.ops).toHaveLength(4);
    expect([over.full, over.txs]).toEqual([true, []]);
    // The same board still has room for a new scene without the ink.
    const bare = addSceneOps(boardOf(LIMITS.max_records - 3), list[1], false, mint);
    expect([bare.ops.length, bare.full, bare.txs.length]).toEqual([3, false, 1]);
    expect(addSceneOps(boardOf(LIMITS.max_records - 2), list[1], false, mint).full).toBe(true);
  });

  it("nothing sent is nothing made: the page stays where it was", () => {
    const sent: Op[][] = [];
    expect(sendScene([], (tx) => (sent.push(tx), true))).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("sending a new scene", () => {
  const txs: Op[][] = [[{ Delete: { id: "a" } }], [{ Delete: { id: "b" } }], [{ Delete: { id: "c" } }]];
  it("stops at a refused transaction, and says whether the scene was made", () => {
    const sent: Op[][] = [];
    expect(sendScene(txs, (tx) => (sent.push(tx), true))).toBe(true);
    expect(sent).toEqual(txs);
    // The first refused: nothing was made, and nothing more is sent.
    sent.length = 0;
    expect(sendScene(txs, (tx) => (sent.push(tx), false))).toBe(false);
    expect(sent).toEqual([txs[0]]);
    // A later one refused: the scene exists; the rest is not sent.
    sent.length = 0;
    expect(sendScene(txs, (tx) => (sent.push(tx), sent.length < 2))).toBe(true);
    expect(sent).toEqual([txs[0], txs[1]]);
  });
});

describe("a copied snapshot", () => {
  const hero = (n: number, more?: Record<string, unknown>): Entry => ({ deleted: false, record: { PlayerState: { scene: "b", slot: `s${n}`, pos: { x: n, y: n }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true, ...(more ? { more } : {}) } } } as Entry);
  const state = (scene: string, more: Record<string, unknown>): Entry => ({ deleted: false, record: { SceneState: { scene, more } } } as Entry);
  const mint = () => { let n = 0; return () => `new${n++}`; };
  const created = (ops: Op[]) => ops.map((o) => ("Create" in o ? o.Create.record : undefined));

  it("copies the scene's state and each hero's `more`, the state last", () => {
    const records: Record<string, Entry> = {
      // The state first in the document: it is still the copy's last op.
      st: state("b", { rows: 11, has_builds: true, build: 6839 }),
      other: state("a", { rows: 3 }),
      gone: { ...state("b", { rows: 1 }), deleted: true },
      p1: hero(1, { hero: 13, items: [1, -1, -1, -1], level: 7 }),
      p2: hero(2),
    };
    const { id, ops, txs } = addSceneOps(fake(list, records), list[1], false, mint());
    const recs = created(ops);
    expect(recs.map((r) => Object.keys(r!)[0])).toEqual(["Scene", "PlayerState", "PlayerState", "SceneState"]);
    expect(recs[3]).toEqual({ SceneState: { scene: id, more: { rows: 11, has_builds: true, build: 6839 } } });
    expect(recs[1]).toMatchObject({ PlayerState: { scene: id, slot: "s1", more: { hero: 13, items: [1, -1, -1, -1], level: 7 } } });
    expect("more" in (recs[2] as { PlayerState: object }).PlayerState).toBe(false);
    // Small: one transaction, one undo step.
    expect(txs).toEqual([ops]);
    // A scene with no state copies none.
    expect(created(addSceneOps(fake(list, records), list[2], false, mint()).ops).map((r) => Object.keys(r!)[0])).toEqual(["Scene"]);
  });

  it("is sent in transactions within the byte cap when twelve builds are over one", () => {
    // Each hero's `more` near the record's 8 KiB: twelve are over a transaction's 64 KiB.
    const big = { build_order: Array.from({ length: 600 }, (_, i) => 4_000_000_000 + i) };
    expect(JSON.stringify(big).length).toBeGreaterThan(6000);
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(LIMITS.max_more_bytes);
    // The state first in the document, with a split and an arrow after it: still sent last.
    const records: Record<string, Entry> = {
      st: state("b", { rows: 11, has_builds: true }),
      w1: { deleted: false, record: { Wave: { scene: "b", lane: "lane4", t: 640 } } },
      ar: { deleted: false, record: { Arrow: { scene: "b", from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, team: null } } },
    };
    for (let n = 0; n < 12; n++) records[`p${n}`] = hero(n, big);
    const { id, ops, txs } = addSceneOps(fake(list, records), list[1], false, mint(), "", true);
    expect(created(ops).at(-1)).toEqual({ SceneState: { scene: id, more: { rows: 11, has_builds: true } } });
    expect(opsBytes(ops)).toBeGreaterThan(LIMITS.max_tx_bytes);
    expect(txs.length).toBeGreaterThan(1);
    // What wraps the ops on the wire (client, cseq) is well under the slack left.
    for (const tx of txs) expect(opsBytes(tx) + 512).toBeLessThanOrEqual(LIMITS.max_tx_bytes);
    // The first makes the scene and all twelve heroes, bare: fewer is refused whole
    // (`IncompleteScene`, review F1), and their `more` is what doesn't fit.
    const first = created(txs[0]!.slice(0, 13));
    expect(first.map((r) => Object.keys(r!)[0])).toEqual(["Scene", ...Array.from({ length: 12 }, () => "PlayerState")]);
    expect(first.slice(1).every((r) => !("more" in (r as { PlayerState: object }).PlayerState))).toBe(true);
    // Sent in order, the transactions leave the records the one transaction would.
    const apply = (all: Op[]) => {
      const out = new Map<string, unknown>();
      for (const o of all) {
        if ("Create" in o) out.set(o.Create.id, structuredClone(o.Create.record));
        else if ("Set" in o && "More" in o.Set.value) {
          const hero = (out.get(o.Set.id) as { PlayerState: { more?: Record<string, unknown> } }).PlayerState;
          hero.more = { ...hero.more, [o.Set.value.More.key]: o.Set.value.More.value };
        } else throw new Error("an op the copy doesn't make");
      }
      return out;
    };
    expect(apply(txs.flat())).toEqual(apply(ops));
    expect(txs.flat().filter((o) => "Set" in o)).toHaveLength(12);
    // The scene says it holds builds only after them.
    expect(created(txs.at(-1)!).at(-1)).toEqual({ SceneState: { scene: id, more: { rows: 11, has_builds: true } } });
    expect(txs.slice(0, -1).flat().some((o) => "Create" in o && "SceneState" in o.Create.record)).toBe(false);
    // Many small records: within the op cap too.
    const many: Record<string, Entry> = {};
    for (let n = 0; n < 300; n++) many[`o${n}`] = { deleted: false, record: { ObjectiveState: { scene: "b", key: `camp:${n}`, status: "Destroyed" } } } as Entry;
    const wide = addSceneOps(fake(list, many), list[1], false, mint());
    expect(wide.txs.length).toBe(2);
    expect(wide.txs.every((tx) => tx.length <= LIMITS.max_ops_per_tx)).toBe(true);
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
