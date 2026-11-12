// Player's cost per frame of playback and per hover (#39: input felt sluggish while a replay
// played). These count work, not time: what reruns when t moves but what's drawn doesn't change,
// and what a tooltip opening wakes.
import { describe, expect, it, vi } from "vitest";

// The browser build: the reactive one (node resolves solid-js to the server's, which doesn't
// track). For this file's imports, the sources' too.
vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { batch, createComputed, createMemo, createRoot, createSignal } from "solid-js";
import { markerKey, type PlayerAt } from "../src/match/timeline";
import { barSlot } from "../src/player/barSlot";
import { markerStates } from "../src/player/markerStates";
import { openTip, closeTips, tipIsOpen } from "../src/player/GameTooltip";
import { easedNumber } from "../src/board/smooth";
import { buildState } from "../src/player/buildState";
import type { TimelinePlayer } from "../src/match/timeline";
import type { MatchPreview } from "../src/match/preview";

/** Runs `read` in a computation of its own and counts how often it runs. */
function runs(read: () => unknown): () => number {
  let n = 0;
  createComputed(() => {
    read();
    n++;
  });
  return () => n;
}

describe("markerKey", () => {
  it("answers a key it was asked before without going through the markers again", () => {
    let reads = 0;
    const list = [
      { key: "camp:a", kind: "camp" as const, team: "neutral" as const, at: { x: 1, y: 1 } },
      { key: "mid_boss", kind: "midboss" as const, team: "neutral" as const, at: { x: 500, y: 500 } },
    ];
    const markers = new Proxy(list, { get: (o, k, r) => (reads++, Reflect.get(o, k, r)) }) as typeof list;
    expect(markerKey("camp:a", markers)).toBe("camp:a");
    expect(markerKey("mid_boss:1", markers)).toBe("mid_boss");
    expect(markerKey("nothing:here", markers)).toBeUndefined();
    const first = reads;
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) {
      expect(markerKey("camp:a", markers)).toBe("camp:a");
      expect(markerKey("mid_boss:1", markers)).toBe("mid_boss");
      expect(markerKey("nothing:here", markers)).toBeUndefined();
    }
    expect(reads).toBe(first);
  });

  it("a different marker list gets its own answers", () => {
    const a = [{ key: "mid_boss", kind: "midboss" as const, team: "neutral" as const, at: { x: 500, y: 500 } }];
    const b = [{ key: "midboss:pack", kind: "midboss" as const, team: "neutral" as const, at: { x: 500, y: 500 } }];
    expect(markerKey("mid_boss:1", a)).toBe("mid_boss");
    expect(markerKey("mid_boss:1", b)).toBe("midboss:pack");
  });
});

const player = (over: Partial<PlayerAt> = {}): PlayerAt => ({ team: "amber", slot: 0, hero_id: 7, name: null, pos: { x: 0, y: 0 }, last: { x: 0, y: 0 }, souls: 1000, ult: 40, health: 80, respawn: null, ...over });

describe("the top bar's portraits", () => {
  it("don't redraw on a frame that changes only the position", () => {
    createRoot((dispose) => {
      const [t, setT] = createSignal(100);
      // As PlayerTopBar's `at`: a new map of new rows every frame; only the position moves.
      const at = createMemo(() => new Map([["Amber-0", player({ pos: { x: t(), y: t() } })]]));
      const x = barSlot(at, "Amber-0");
      const count = runs(x);
      for (let i = 1; i <= 60; i++) setT(100 + i / 60);
      expect(count()).toBe(1);
      dispose();
    });
  });

  it("redraw when what they draw changes", () => {
    createRoot((dispose) => {
      const [row, setRow] = createSignal(player());
      const x = barSlot(() => new Map([["Amber-0", row()]]), "Amber-0");
      const count = runs(x);
      setRow(player({ souls: 1100 }));
      expect(x()?.souls).toBe(1100);
      setRow(player({ souls: 1100, pos: null, respawn: 9.5 }));
      expect(x()?.dead).toBe(true);
      expect(count()).toBe(3);
      // The countdown shows whole seconds: 9.5 and 9.1 both read 10.
      setRow(player({ souls: 1100, pos: null, respawn: 9.1 }));
      expect(count()).toBe(3);
      setRow(player({ souls: 1100, pos: null, respawn: 8.9 }));
      expect(count()).toBe(4);
      expect(Math.ceil(x()!.respawn!)).toBe(9);
      dispose();
    });
  });
});

const preview = (over: Partial<MatchPreview> = {}): MatchPreview => ({
  players: new Map(),
  down: new Set(["t1:amber:1"]),
  shops: new Set(),
  sites: new Map([["rift:1", "Active"]]),
  lanes: new Map(),
  camps: new Map([["camp:a", { state: "alive" }]]),
  powerups: new Map([["powerup:1", { state: "up", buff: "gun" }]]),
  health: new Map([["t3:amber", { pct: 60, stage: 1 }]]),
  ...over,
});

describe("the map's markers", () => {
  const keys = ["t1:amber:1", "rift:1", "camp:a", "powerup:1", "t3:amber", "shop:1"];

  it("don't redraw on a frame whose preview shows the same", () => {
    createRoot((dispose) => {
      const [pv, setPv] = createSignal(preview());
      const marks = markerStates(pv, () => keys, () => undefined);
      const counts = keys.map((k) => runs(() => [marks.status(k), marks.health(k), marks.camp(k), marks.buff(k)]));
      for (let i = 0; i < 60; i++) setPv(preview());
      expect(counts.map((c) => c())).toEqual(keys.map(() => 1));
      dispose();
    });
  });

  it("show the match: a change redraws, and the values are the preview's", () => {
    createRoot((dispose) => {
      const [pv, setPv] = createSignal<MatchPreview | undefined>(preview());
      const marks = markerStates(pv, () => keys, (k) => (k === "t1:amber:1" ? "Active" : undefined));
      const count = runs(() => marks.status("rift:1"));
      expect([marks.status("t1:amber:1"), marks.status("rift:1"), marks.status("t3:amber"), marks.status("shop:1")]).toEqual(["Destroyed", "Active", "Active", undefined]);
      expect([marks.health("t3:amber"), marks.camp("camp:a"), marks.buff("powerup:1")]).toEqual([60, "alive", "gun"]);
      setPv(preview({ sites: new Map([["rift:1", "Destroyed"]]), health: new Map([["t3:amber", { pct: 40, stage: 2 }]]), shops: new Set(["shop:1"]) }));
      expect([marks.status("rift:1"), marks.status("t3:amber"), marks.status("shop:1"), marks.health("t3:amber")]).toEqual(["Destroyed", "Stage2", "Hidden", 40]);
      expect(count()).toBe(2);
      // Outside Player, the scene's own states.
      setPv(undefined);
      expect([marks.status("t1:amber:1"), marks.status("rift:1")]).toEqual(["Active", undefined]);
      dispose();
    });
  });
});

describe("tooltips", () => {
  it("opening one wakes only the tooltips whose state changed, not every one on the page", () => {
    createRoot((dispose) => {
      const ids = Array.from({ length: 300 }, () => Symbol("tip"));
      const counts = ids.map((id) => runs(() => tipIsOpen(id)));
      const total = () => counts.reduce((s, c) => s + c(), 0);
      expect(total()).toBe(300);
      openTip(ids[0]!);
      expect(total()).toBe(301);
      expect(tipIsOpen(ids[0]!)).toBe(true);
      openTip(ids[1]!);
      expect(total()).toBe(303);
      expect([tipIsOpen(ids[0]!), tipIsOpen(ids[1]!)]).toEqual([false, true]);
      closeTips();
      expect(total()).toBe(304);
      dispose();
    });
  });
});

describe("eased numbers", () => {
  it("ask for the reduced-motion setting once, not on every change", () => {
    const asked = vi.fn(() => ({ matches: false }) as MediaQueryList);
    vi.stubGlobal("matchMedia", asked);
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      createRoot((dispose) => {
        const [v, setV] = createSignal(0);
        const shown = easedNumber(v);
        for (let i = 1; i <= 50; i++) batch(() => setV(i));
        expect(shown()).not.toBeNull();
        dispose();
      });
      expect(asked.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a build column", () => {
  // Item 11 bought at 50 s; ability 21 unlocked at 10 s and cast at 85 s with its cooldown ending at
  // 100 s; level 9 from 60 s.
  const hero = {
    hero_id: 7,
    items: [[500, 11, 0]],
    abilities: [[10, 21, 1]],
    casts: [[850, 21, 1000]],
    charges: [],
    stacks: [],
    level: [[0, 1], [60, 9]],
    pickups: [],
    x: Array.from({ length: 200 }, () => 0),
    health: Array.from({ length: 200 }, () => 100),
  } as unknown as TimelinePlayer;

  it("doesn't redraw or recalculate on a frame that shows the same", () => {
    createRoot((dispose) => {
      const [t, setT] = createSignal(90.05);
      const { build, statInput } = buildState(() => hero, t);
      const drawn = runs(build);
      const calculated = runs(statInput);
      // 9.95 s to 9.05 s left: "10" all along.
      for (let i = 1; i <= 54; i++) setT(90.05 + i / 60);
      expect([drawn(), calculated()]).toEqual([1, 1]);
      expect(Math.ceil(build().abilities![0]!.cooldown!)).toBe(10);
      // 8.95 s left: the cooldown shows 9, the stats are the same.
      setT(91.05);
      expect([drawn(), calculated()]).toEqual([2, 1]);
      expect(Math.ceil(build().abilities![0]!.cooldown!)).toBe(9);
      dispose();
    });
  });

  it("follows the match: a buy redraws and recalculates", () => {
    createRoot((dispose) => {
      const [t, setT] = createSignal(40);
      const { build, statInput } = buildState(() => hero, t);
      expect(build().items).toEqual([]);
      expect(statInput()?.level).toBe(1);
      setT(65);
      expect(build().items!.map((i) => i.id)).toEqual([11]);
      expect(statInput()).toMatchObject({ level: 9, items: [11] });
      dispose();
    });
  });
});
