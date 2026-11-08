import { describe, expect, it } from "vitest";
import { canNest, flatten, parents, visibleRows } from "../src/board/tree";

const s = (id: string, order: string, parent: string | null = null) => ({ id, order, parent });

describe("scene tree", () => {
  it("lists depth-first, siblings by order key (ties by id)", () => {
    const scenes = [s("b", "m"), s("a", "a"), s("a2", "b", "a"), s("a1", "a", "a"), s("a1x", "z", "a1"), s("c", "m")];
    const rows = flatten(scenes);
    expect(rows.map((r) => r.scene.id)).toEqual(["a", "a1", "a1x", "a2", "b", "c"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 0, 0]);
    expect(rows.find((r) => r.scene.id === "a1")!.hasChildren).toBe(true);
    expect(rows.find((r) => r.scene.id === "a2")!.hasChildren).toBe(false);
  });

  it("a deleted parent's children sit under its own parent; an unknown one is the root", () => {
    const up = (id: string) => (id === "gone" ? "a" : id === "gone2" ? "gone" : undefined);
    const scenes = [s("a", "a"), s("x", "a", "gone"), s("y", "b", "gone2"), s("z", "c", "nowhere")];
    const par = parents(scenes, up);
    expect(par.get("x")).toBe("a");
    expect(par.get("y")).toBe("a");
    expect(par.get("z")).toBe(null);
  });

  it("a cycle from concurrent edits breaks at its smallest id, the same everywhere", () => {
    const scenes = [s("p", "a", "q"), s("q", "a", "r"), s("r", "a", "p"), s("t", "a", "q")];
    const par = parents(scenes);
    expect(par.get("p")).toBe(null);
    expect(par.get("q")).toBe("r");
    expect(par.get("r")).toBe("p");
    expect(flatten(scenes).map((r) => r.scene.id)).toEqual(["p", "r", "q", "t"]);
  });

  it("won't nest a scene under itself or its own descendants", () => {
    const scenes = [s("a", "a"), s("b", "a", "a"), s("c", "a", "b"), s("d", "b")];
    expect(canNest(scenes, "a", "a")).toBe(false);
    expect(canNest(scenes, "a", "c")).toBe(false);
    expect(canNest(scenes, "a", "b")).toBe(false);
    expect(canNest(scenes, "c", "a")).toBe(true);
    expect(canNest(scenes, "a", "d")).toBe(true);
    expect(canNest(scenes, "b", null)).toBe(true);
  });

  it("collapsing hides the descendants only", () => {
    const rows = flatten([s("a", "a"), s("a1", "a", "a"), s("a1x", "a", "a1"), s("b", "b")]);
    expect(visibleRows(rows, new Set(["a1"])).map((r) => r.scene.id)).toEqual(["a", "a1", "b"]);
    expect(visibleRows(rows, new Set(["a"])).map((r) => r.scene.id)).toEqual(["a", "b"]);
    expect(visibleRows(rows, new Set(["b"])).map((r) => r.scene.id)).toEqual(["a", "a1", "a1x", "b"]);
  });
});
