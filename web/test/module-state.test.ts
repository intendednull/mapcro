// Module state and boards (sessions.md §4.1, phase 0): no module-level state under web/src without
// a policy for when a board unmounts (module-state-ledger.ts), and the board's cleanup puts each
// `reset-on-unmount` one back to its default. e2e/board-unmount.spec.ts mounts boards in one page
// and checks that nothing of a board left runs or shows.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hoverHandle, hoverMarker, hoverToken, hoverUnit, hoveredHandle, hoveredToken, localHover, registerHover, remoteHover, setRemoteHover } from "../src/map/HoverLabel";
import { openTip, tipOpen } from "../src/player/GameTooltip";
import { resetBoardModules } from "../src/board/reset";
import { MODULE_STATE } from "./module-state-ledger";

const src = new URL("../src/", import.meta.url);
/** Every module under src, but the generated ones (gen/, wasm/). */
function modules(dir = ""): string[] {
  return readdirSync(new URL(dir || ".", src)).flatMap((f) => {
    const rel = `${dir}${f}`;
    if (rel === "gen" || rel === "wasm") return [];
    if (statSync(new URL(rel, src)).isDirectory()) return modules(`${rel}/`);
    return /\.tsx?$/.test(f) ? [rel] : [];
  });
}

/** Module-level state: what a line at the top of a module makes (not inside a function). */
const STATE = [
  // `let x`, `var x`.
  /^(?:export\s+)?(?:let|var)\s+(\w+)/,
  // `const [x, setX] = createSignal(…)` (and createStore, createResource).
  /^(?:export\s+)?const\s+\[\s*(\w+)/,
  // `const x = new Map()`, a Set, a WeakMap, an empty array or object, a store or a root.
  /^(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:new\s+(?:Map|Set|WeakMap|WeakSet|Array)\b|\[\s*\]|\{\s*\}|create(?:Signal|Store|Mutable|Root|Memo|Resource)\b)/,
];
/** A reactive primitive made at the top of a module: each must be one the patterns name. */
const REACTIVE = /^(?!\s|(?:export\s+)?(?:async\s+)?function\b|import\b).*\bcreate(?:Signal|Store|Mutable|Root|Memo|Effect|Resource)\s*[<(]/;

function scan() {
  const found: Record<string, string[]> = {};
  const unnamed: string[] = [];
  for (const f of modules()) {
    readFileSync(new URL(f, src), "utf8")
      .split("\n")
      .forEach((line, i) => {
        const name = STATE.map((re) => re.exec(line)?.[1]).find(Boolean);
        if (name) (found[f] ??= []).push(name);
        else if (REACTIVE.test(line)) unnamed.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  return { found, unnamed };
}

describe("no module state without a policy for a board's unmount", () => {
  const { found, unnamed } = scan();
  const HOW = "say what happens to it when a board unmounts: an entry in web/test/module-state-ledger.ts (and, for reset-on-unmount, a reset in src/board/reset.ts and a row below)";

  it("finds the state it should (the scan itself)", () => {
    // A sample of each kind of line, so a broken pattern can't pass by finding nothing.
    expect(found["map/HoverLabel.tsx"]).toEqual(expect.arrayContaining(["resolvers", "token", "remote"]));
    expect(found["player/handoff.ts"]).toEqual(["pending"]);
    expect(found["ui/modal.ts"]).toEqual(["open", "made"]);
    expect(found["core/keys.ts"]).toEqual(["TEXT_TYPES"]);
  });

  it("every piece of module state is in the ledger", () => {
    expect(unnamed, `module-level reactive state the guard can't name; destructure it as [get, set] or give it a name: ${HOW}`).toEqual([]);
    for (const [f, names] of Object.entries(found)) for (const n of names) expect(MODULE_STATE[f]?.[n], `${f}: \`${n}\` is module state with no policy; ${HOW}`).toBeDefined();
    for (const [f, entries] of Object.entries(MODULE_STATE)) for (const n of Object.keys(entries)) expect(found[f] ?? [], `ledger: ${f} has no \`${n}\` any more; remove the entry`).toContain(n);
  });

  it("the board's cleanup resets module state", () => {
    const board = readFileSync(new URL("board/Board.tsx", src), "utf8");
    expect(board).toMatch(/onCleanup\(resetBoardModules\)/);
  });
});

/** Each `reset-on-unmount` entry: set away from its default, and whether it's at it. */
const RESETS: Record<string, Record<string, { set: () => void; atDefault: () => boolean }>> = {
  "map/HoverLabel.tsx": {
    token: { set: () => hoverToken({ kind: "token", id: "Amber-0" }), atDefault: () => hoveredToken() === undefined },
    marker: { set: () => hoverMarker({ kind: "marker", id: "camp:x" }), atDefault: () => localHover()?.id !== "camp:x" },
    unit: { set: () => hoverUnit({ kind: "marker", id: "rift:1" }), atDefault: () => localHover()?.id !== "rift:1" },
    handle: { set: () => hoverHandle({ kind: "marker", id: "wave:lane1" }), atDefault: () => hoveredHandle() === undefined },
    remote: { set: () => setRemoteHover({ ref: { kind: "token", id: "Sapphire-2" }, name: "them", color: "#fff" }), atDefault: () => remoteHover() === undefined },
  },
  "player/GameTooltip.tsx": {
    openId: { set: () => openTip(Symbol("tip")), atDefault: () => !tipOpen() },
  },
};

describe("a board's cleanup puts module state back to its defaults", () => {
  const resets = Object.entries(MODULE_STATE).flatMap(([f, entries]) => Object.entries(entries).filter(([, [p]]) => p === "reset-on-unmount").map(([n]) => [f, n] as const));
  // What the hover channels resolve to: each is on the map, so a stale one would show.
  const offs = ["camp:x", "rift:1", "wave:lane1"].map((k) => registerHover("marker", k, () => ({ x: 0, y: 0, gap: 0, text: k })));
  offs.push(registerHover("token", "Amber-0", () => ({ x: 0, y: 0, gap: 0, text: "A" })));

  it("has a check for every reset-on-unmount entry, and no other", () => {
    expect(resets.length).toBeGreaterThan(0);
    for (const [f, n] of resets) expect(RESETS[f]?.[n], `${f}: \`${n}\` is reset-on-unmount: add its row to RESETS`).toBeDefined();
    for (const [f, rows] of Object.entries(RESETS)) for (const n of Object.keys(rows)) expect(MODULE_STATE[f]?.[n]?.[0], `${f}: \`${n}\` has a reset row but isn't reset-on-unmount`).toBe("reset-on-unmount");
  });

  for (const [f, n] of resets) {
    it(`${f} \`${n}\``, () => {
      const row = RESETS[f]![n]!;
      row.set();
      expect(row.atDefault(), "set away from its default").toBe(false);
      resetBoardModules();
      expect(row.atDefault(), "back at its default after the board's cleanup").toBe(true);
    });
  }

  it("all at once", () => {
    for (const [f, n] of resets) RESETS[f]![n]!.set();
    resetBoardModules();
    for (const [f, n] of resets) expect(RESETS[f]![n]!.atDefault(), `${f} ${n}`).toBe(true);
    for (const off of offs) off();
  });
});
