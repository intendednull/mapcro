// "Your boards": this device's list of boards (core/device.ts). Remove takes a board off the
// list only, Undo puts it back where it was, and freshening an entry keeps what it knew.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askRename, forgetBoard, knownBoards, rememberBoard, restoreBoard, takeRename } from "../src/core/device";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemStorage());
  vi.stubGlobal("sessionStorage", new MemStorage());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const at = (t: number) => vi.spyOn(Date, "now").mockReturnValue(t);

describe("known boards", () => {
  it("lists newest first and freshens an entry in place", () => {
    at(1);
    rememberBoard({ board: "a", token: "ta", title: "A" });
    at(2);
    rememberBoard({ board: "b", token: "tb", title: "B" });
    at(3);
    rememberBoard({ board: "a", token: "ta", title: "A renamed" });
    expect(knownBoards().map((k) => [k.board, k.title, k.seen])).toEqual([
      ["a", "A renamed", 3],
      ["b", "B", 2],
    ]);
  });

  it("keeps the match id and edit flag when a later freshen leaves them out", () => {
    at(1);
    rememberBoard({ board: "m", token: "t", title: "Match 42", match: "42", edit: true });
    at(2);
    rememberBoard({ board: "m", token: "t", title: "Lane review" });
    expect(knownBoards()[0]).toEqual({ board: "m", token: "t", title: "Lane review", seen: 2, match: "42", edit: true });
    rememberBoard({ board: "m", token: "view", title: "Lane review", edit: false });
    expect(knownBoards()[0]).toMatchObject({ token: "view", edit: false, match: "42" });
  });

  it("an entry without a match or edit flag stores neither", () => {
    rememberBoard({ board: "s", token: "t", title: "Sandbox" });
    expect(Object.keys(knownBoards()[0]!).sort()).toEqual(["board", "seen", "title", "token"]);
  });

  it("forget removes only that board, and hands back its entry", () => {
    at(1);
    rememberBoard({ board: "a", token: "ta", title: "A" });
    at(2);
    rememberBoard({ board: "b", token: "tb", title: "B" });
    const gone = forgetBoard("a");
    expect(gone).toEqual({ board: "a", token: "ta", title: "A", seen: 1 });
    expect(knownBoards().map((k) => k.board)).toEqual(["b"]);
    expect(forgetBoard("a")).toBeUndefined();
  });

  it("undo puts it back in its place, with its last-opened time", () => {
    for (const [i, b] of ["a", "b", "c"].entries()) {
      at(i + 1);
      rememberBoard({ board: b, token: `t${b}`, title: b.toUpperCase() });
    }
    const gone = forgetBoard("b")!;
    at(9);
    restoreBoard(gone);
    expect(knownBoards().map((k) => [k.board, k.seen])).toEqual([
      ["c", 3],
      ["b", 2],
      ["a", 1],
    ]);
  });

  it("undo doesn't duplicate a board that came back meanwhile (its link reopened)", () => {
    at(1);
    rememberBoard({ board: "a", token: "ta", title: "A" });
    const gone = forgetBoard("a")!;
    at(5);
    rememberBoard({ board: "a", token: "ta", title: "A again" });
    restoreBoard(gone);
    expect(knownBoards()).toEqual([{ board: "a", token: "ta", title: "A again", seen: 5 }]);
  });

  it("forget leaves the board's other local data alone", () => {
    localStorage.setItem("mapcro.colour.a", "3");
    localStorage.setItem("mapcro.joined", JSON.stringify(["a"]));
    rememberBoard({ board: "a", token: "ta", title: "A" });
    forgetBoard("a");
    expect(localStorage.getItem("mapcro.colour.a")).toBe("3");
    expect(localStorage.getItem("mapcro.joined")).toBe(JSON.stringify(["a"]));
  });

  it("a rename ask is for one board and is used up", () => {
    askRename("a");
    expect(takeRename("b")).toBe(false);
    expect(takeRename("a")).toBe(true);
    expect(takeRename("a")).toBe(false);
  });
});
