// The board's tool keys (spec §4 "Keys", feedback #28): Q Select, W Laser, E Draw, A Arrow,
// S Comment, D Erase; C the Clear menu and Shift+C clear all, an editor's only; nothing with
// Ctrl, Cmd or Alt held, so Ctrl+C still copies.
import { describe, expect, it } from "vitest";
import { TOOLS, toolbarKey } from "../src/board/tools";

const press = (key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("tool keys", () => {
  it("pick each tool by its key, in the toolbar's order", () => {
    expect(TOOLS.map((t) => [t.key, t.tool])).toEqual([
      ["Q", "select"],
      ["W", "laser"],
      ["E", "draw"],
      ["A", "arrow"],
      ["S", "callout"],
      ["D", "erase"],
    ]);
    for (const t of TOOLS) expect(toolbarKey(press(t.key.toLowerCase()), true)).toEqual({ tool: t.tool });
    // Shift is allowed (caps lock or a held Shift still picks).
    expect(toolbarKey(press("D", { shiftKey: true }), true)).toEqual({ tool: "erase" });
  });
  it("names the default tool Select (#31)", () => {
    expect(TOOLS[0]).toMatchObject({ tool: "select", label: "Select" });
  });
  it("C opens the Clear menu and Shift+C clears all, for editors only", () => {
    expect(toolbarKey(press("c"), true)).toEqual({ clear: "menu" });
    expect(toolbarKey(press("C", { shiftKey: true }), true)).toEqual({ clear: "all" });
    expect(toolbarKey(press("c"), false)).toBeUndefined();
    expect(toolbarKey(press("C", { shiftKey: true }), false)).toBeUndefined();
  });
  it("a view link gets Look and Laser only", () => {
    expect(toolbarKey(press("q"), false)).toEqual({ tool: "select" });
    expect(toolbarKey(press("w"), false)).toEqual({ tool: "laser" });
    for (const k of ["e", "a", "s", "d"]) expect(toolbarKey(press(k), false)).toBeUndefined();
  });
  it("nothing with Ctrl, Cmd or Alt held: Ctrl+C copies", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
      expect(toolbarKey(press("c", { [mod]: true }), true)).toBeUndefined();
      expect(toolbarKey(press("C", { [mod]: true, shiftKey: true }), true)).toBeUndefined();
      expect(toolbarKey(press("q", { [mod]: true }), true)).toBeUndefined();
    }
  });
  it("leaves the other board keys alone (F follow, K kill, T new scene, R)", () => {
    for (const k of ["f", "k", "t", "r", "1", " "]) expect(toolbarKey(press(k), true)).toBeUndefined();
  });
});
