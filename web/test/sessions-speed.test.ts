// Sessions phase 3 (sessions.md §4.2, §4.3, §9.1 "Unit level"): what a tab remembers of its
// board, and the page's timeline cache. Pure parts; the browser rows are in
// e2e/session-isolation.spec.ts.

import { describe, expect, it } from "vitest";
import { MAX_TAB_VIEWS, TAB_LAYERS, type TabView, loadTabView, parseTabView, playerPart, saveTabView, sceneGone, tabOwn, tabViewKey, withMatches, withOwn, withScenes } from "../src/session/tabview";
import { DECODED_PER_CHAR, TimelineCache, freezeDeep, isFetched } from "../src/player/timelineCache";
import type { Timeline } from "../src/match/timeline";
import { VIEW_STATE } from "../src/gen/viewState";

const A = "AAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBB";
const S = "SSSSSSSSSSSSSSSSSSSSSS";
const rid = (n: number) => n.toString(16).padStart(32, "0");

/** sessionStorage, in memory. */
function storage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const full: TabView = {
  board: A,
  at: 1000,
  scene: rid(7),
  view: { x: 10, y: 20, w: 50 },
  viewpoint: "sapphire",
  side: "notes",
  mode: "player",
  match: "129738985",
  t: 812.5,
  playing: true,
  speed: 4,
  layers: { troopers: false, health: true, pings: true, cc: true, movement: false, heals: true, crates: false },
  vision: "amber",
  lastSeen: true,
};

describe("what a tab remembers (TabView)", () => {
  it("comes back whole for its own board in its own session", () => {
    const s = storage();
    saveTabView(s, S, full);
    expect(loadTabView(s, S, A)).toEqual(full);
    expect(s.getItem(tabViewKey(S, A))).not.toBeNull();
    // Another session's tab of the same board remembers nothing of this one.
    expect(loadTabView(s, "TTTTTTTTTTTTTTTTTTTTTT", A)).toBeUndefined();
    expect(loadTabView(s, S, B)).toBeUndefined();
  });

  it("restores only into the board it names", () => {
    const s = storage();
    // An entry of A's, found under B's key (moved by hand, or a bug): B never takes it.
    s.setItem(tabViewKey(S, B), JSON.stringify(full));
    expect(loadTabView(s, S, B)).toBeUndefined();
    expect(parseTabView(JSON.stringify(full), B)).toBeUndefined();
    expect(parseTabView(JSON.stringify({ ...full, board: undefined }), A)).toBeUndefined();
  });

  it("takes each field only in its own shape", () => {
    const bad = { board: A, at: "soon", scene: "nope", view: { x: 1, y: "2", w: 3 }, viewpoint: "top", side: 3, mode: "replay", match: "12x", t: 5, playing: true, speed: 2, layers: { troopers: "yes", heals: true, extra: true }, vision: "team", lastSeen: 1 };
    expect(parseTabView(JSON.stringify(bad), A)).toEqual({ board: A, at: 0, layers: { heals: true } });
    // Playback hangs on its match: without one, none of it.
    expect(parseTabView(JSON.stringify({ board: A, at: 1, t: 5, playing: true, speed: 2 }), A)).toEqual({ board: A, at: 1 });
    expect(parseTabView(JSON.stringify({ board: A, at: 1, match: "7", t: -1, speed: 0, view: { x: 0, y: 0, w: 0 } }), A)).toEqual({ board: A, at: 1, match: "7" });
    for (const raw of [null, "", "{", "null", "[]", '"x"', "7"]) expect(parseTabView(raw, A)).toBeUndefined();
  });

  it("drops a scene that's gone with its viewport and side, and keeps the rest", () => {
    expect(withScenes(full, (id) => id === rid(7))).toBe(full);
    const cold = withScenes(full, () => false);
    expect(cold.scene).toBeUndefined();
    expect(cold.view).toBeUndefined();
    expect(cold.viewpoint).toBeUndefined();
    expect(cold).toEqual({ ...full, scene: undefined, view: undefined, viewpoint: undefined });
    const none: TabView = { board: A, at: 1, view: { x: 1, y: 1, w: 9 } };
    expect(withScenes(none, () => false)).toBe(none);
  });

  it("drops a match no longer attached with its playback and mode, and keeps the rest", () => {
    expect(withMatches(full, [5, 129738985])).toBe(full);
    const cold = withMatches(full, [5]);
    expect(cold).toEqual({ ...full, match: undefined, t: undefined, playing: undefined, speed: undefined, mode: undefined });
    expect(cold.layers).toEqual(full.layers);
    expect(cold.scene).toBe(full.scene);
    const none: TabView = { board: A, at: 1, mode: "sandbox" };
    expect(withMatches(none, [])).toBe(none);
  });

  it("hands Player its part alone", () => {
    expect(playerPart(undefined)).toEqual({});
    expect(playerPart(full)).toEqual({ mode: "player", match: "129738985", t: 812.5, playing: true, speed: 4, layers: full.layers, vision: "amber", lastSeen: true });
  });

  it("holds of Vision and the map layers only what was set on the tab", () => {
    // A tab only passed through holds none of them: it shows this browser's choice.
    expect(tabOwn(undefined)).toEqual({});
    expect(tabOwn({ board: A, at: 1, mode: "player", layers: {} } as TabView)).toEqual({});
    // What it remembered before is its own still, and nothing else of the view is.
    expect(tabOwn(full)).toEqual({ layers: full.layers, vision: "amber", lastSeen: true });
    expect(tabOwn({ lastSeen: false })).toEqual({ lastSeen: false });
    expect(tabOwn({ vision: "all" })).toEqual({ vision: "all" });
    // Each key set becomes the tab's own, alone: the others stay unheld.
    let own = withOwn({}, "layer.heals", true);
    expect(own).toEqual({ layers: { heals: true } });
    own = withOwn(own, "layer.troopers", false);
    expect(own).toEqual({ layers: { heals: true, troopers: false } });
    own = withOwn(own, "layer.heals", false);
    expect(own).toEqual({ layers: { heals: false, troopers: false } });
    own = withOwn(own, "vision.team", "sapphire");
    own = withOwn(own, "vision.last_seen", false);
    expect(own).toEqual({ layers: { heals: false, troopers: false }, vision: "sapphire", lastSeen: false });
    // A layer set after them keeps them.
    expect(withOwn(own, "layer.cc", true)).toEqual({ layers: { heals: false, troopers: false, cc: true }, vision: "sapphire", lastSeen: false });
    for (const k of TAB_LAYERS) expect(withOwn({}, `layer.${k}`, true)).toEqual({ layers: { [k]: true } });
    // Never the value handed in: the host keeps the one before for a tab left unsettled.
    const before = { layers: { cc: true } };
    expect(withOwn(before, "layer.movement", true)).toEqual({ layers: { cc: true, movement: true } });
    expect(before).toEqual({ layers: { cc: true } });
    // Any other key, or a value out of shape, is not a tab's: names, panels, the events filters.
    for (const [k, v] of [["names", true], ["builds.all", true], ["events.filter.death", true], ["layer.fog", true], ["layers", true], ["heals", true], ["other.heals", true], ["layer.heals", "on"], ["vision.team", "top"], ["vision.team", true], ["vision.last_seen", "yes"], ["vision", "amber"]] as const)
      expect(withOwn(own, k, v)).toBe(own);
    // Stored and read back, a tab's own is only what was set.
    const s = storage();
    saveTabView(s, S, { board: A, at: 1, ...own });
    expect(tabOwn(loadTabView(s, S, A))).toEqual(own);
  });

  it("holds every map layer and Vision key the view-state registry has", () => {
    // A layer added to the registry (crates/engine/src/view_state.rs) is added here too, or it
    // would silently be this browser's on every tab while its neighbours are the tab's own.
    const keys = Object.keys(VIEW_STATE);
    expect(keys.filter((k) => k.startsWith("layer.")).map((k) => k.slice("layer.".length)).sort()).toEqual([...TAB_LAYERS].sort());
    const tabs = keys.filter((k) => k.startsWith("layer.") || k.startsWith("vision."));
    expect(tabs.length).toBe(TAB_LAYERS.length + 2);
    for (const k of tabs) {
      const row = VIEW_STATE[k as keyof typeof VIEW_STATE] as { kind: string; options?: readonly string[] };
      const value = row.kind === "bool" ? true : row.options![1];
      expect(withOwn({}, k, value), k).not.toEqual({});
      expect(tabOwn(withOwn({}, k, value)), k).toEqual(withOwn({}, k, value));
    }
  });

  it("opens cold in place of a remembered scene that's gone, unless another was picked meanwhile", () => {
    const gone = () => false;
    const there = (id: string) => id === rid(7);
    // Gone, and the tab is still on it: cold.
    expect(sceneGone(full, gone, rid(7))).toBe(true);
    // Still there: as left.
    expect(sceneGone(full, there, rid(7))).toBe(false);
    // Gone, but the user picked another scene since the tab opened (or none is picked): theirs.
    expect(sceneGone(full, gone, rid(8))).toBe(false);
    expect(sceneGone(full, gone, undefined)).toBe(false);
    // No scene remembered: nothing to be gone.
    expect(sceneGone({ board: A, at: 1 }, gone, undefined)).toBe(false);
  });

  it("keeps at most 200, dropping the oldest, and leaves other keys alone", () => {
    const s = storage();
    s.setItem("mapcro.me", "x");
    const board = (i: number) => `board${String(i).padStart(17, "0")}`;
    for (let i = 0; i < MAX_TAB_VIEWS; i++) saveTabView(s, S, { board: board(i), at: 1000 + i });
    expect(s.length).toBe(MAX_TAB_VIEWS + 1);
    // One more: the oldest goes, whatever order they were stored in.
    saveTabView(s, S, { board: board(0), at: 5000 }); // board 0 is the newest now
    saveTabView(s, S, { board: board(999), at: 5001 });
    expect(s.length).toBe(MAX_TAB_VIEWS + 1);
    expect(loadTabView(s, S, board(1))).toBeUndefined();
    expect(loadTabView(s, S, board(0))?.at).toBe(5000);
    expect(loadTabView(s, S, board(2))?.at).toBe(1002);
    expect(loadTabView(s, S, board(999))?.at).toBe(5001);
    expect(s.getItem("mapcro.me")).toBe("x");
    // A damaged entry counts as the oldest: it goes first, then the oldest real one.
    s.setItem("mapcro.tabview.x.y", "{");
    saveTabView(s, S, { board: board(1000), at: 5002 });
    expect(s.getItem("mapcro.tabview.x.y")).toBeNull();
    expect(loadTabView(s, S, board(2))).toBeUndefined();
    expect(loadTabView(s, S, board(3))?.at).toBe(1003);
    expect(s.length).toBe(MAX_TAB_VIEWS + 1);
  });

  it("is simply not remembered when storage refuses", () => {
    const refusing = { ...storage(), setItem: () => { throw new Error("quota"); }, getItem: () => { throw new Error("denied"); } } as unknown as Storage;
    expect(() => saveTabView(refusing, S, full)).not.toThrow();
    expect(loadTabView(refusing, S, A)).toBeUndefined();
  });
});

const tl = (id: number, extra: Record<string, unknown> = {}) => ({ match_id: id, duration_s: 60, players: [{ x: [1, 2, 3], name: "n" }], events: [], ...extra }) as unknown as Timeline;
const CDN = '"cdn-100-1"';
const UP_A = '"up-aaaa-100-1"';

describe("the page's timeline cache", () => {
  it("keeps the fetched replay by match for every board, and an upload for its own board alone", () => {
    const c = new TimelineCache();
    expect(isFetched(CDN)).toBe(true);
    expect(isFetched(UP_A)).toBe(false);
    const fetched = c.put(A, "7", CDN, tl(7), 100);
    expect(c.candidates(A, "7").map((h) => h.tl)).toEqual([fetched]);
    expect(c.candidates(B, "7").map((h) => h.tl)).toEqual([fetched]);
    expect(c.candidates(B, "8")).toEqual([]);
    const mine = c.put(A, "7", UP_A, tl(7, { tier: "replay" }), 100);
    // A's own first (the server prefers it), then the fetched; B never sees A's upload.
    expect(c.candidates(A, "7").map((h) => h.tl)).toEqual([mine, fetched]);
    expect(c.candidates(B, "7").map((h) => h.tl)).toEqual([fetched]);
    expect(c.size().n).toBe(2);
  });

  it("forgets the fetched replay too when the server has no replay of the match; a dead link drops the board's own, every match's", () => {
    const c = new TimelineCache();
    const fetched7 = c.put(A, "7", CDN, tl(7), 100);
    c.put(A, "7", UP_A, tl(7), 100);
    const fetched8 = c.put(A, "8", '"cdn-8"', tl(8), 100);
    const b7 = c.put(B, "7", '"up-bbbb"', tl(7), 100);
    // The summary for A's match 7: its upload and the fetched replay of 7 go; nothing else.
    c.forget(A, "7");
    expect(c.candidates(A, "7")).toEqual([]);
    expect(c.candidates(B, "7").map((h) => h.tl)).toEqual([b7]);
    expect(c.candidates(A, "8").map((h) => h.tl)).toEqual([fetched8]);
    expect(c.size()).toEqual({ bytes: Math.ceil(100 * DECODED_PER_CHAR) * 2, n: 2 });
    // A dead link on A: A's own uploads of every match, never B's, never a fetched replay.
    c.put(A, "7", CDN, tl(7), 100);
    c.put(A, "7", UP_A, tl(7), 100);
    c.put(A, "9", '"up-aaaa-9"', tl(9), 100);
    c.dropBoard(A);
    expect(c.candidates(A, "7").map((h) => h.etag)).toEqual([CDN]);
    expect(c.candidates(A, "9")).toEqual([]);
    expect(c.candidates(A, "8").map((h) => h.tl)).toEqual([fetched8]);
    expect(c.candidates(B, "7").map((h) => h.etag)).toEqual(['"up-bbbb"', CDN]);
    expect(c.size().n).toBe(3);
    void fetched7;
  });

  it("gives back only the one the server named", () => {
    const c = new TimelineCache();
    const fetched = c.put(A, "7", CDN, tl(7), 100);
    c.put(A, "7", UP_A, tl(7), 100);
    expect(c.confirm(B, "7", CDN)?.tl).toBe(fetched);
    // The same file under another validator (written again since), another board's upload, another match: none.
    expect(c.confirm(A, "7", '"cdn-100-2"')).toBeUndefined();
    expect(c.confirm(B, "7", UP_A)).toBeUndefined();
    expect(c.confirm(A, "8", CDN)).toBeUndefined();
    expect(c.confirm(A, "7", UP_A)?.etag).toBe(UP_A);
  });

  it("drops a board's own when the server refuses it or answers with another, never the fetched", () => {
    const c = new TimelineCache();
    c.put(A, "7", CDN, tl(7), 100);
    c.put(A, "7", UP_A, tl(7), 100);
    c.drop(A, "7");
    expect(c.candidates(A, "7").map((h) => h.etag)).toEqual([CDN]);
    expect(c.size()).toEqual({ n: 1, bytes: Math.ceil(100 * DECODED_PER_CHAR) });
    c.drop(B, "7");
    expect(c.size().n).toBe(1);
    // A newer file for the same place replaces the old one, and its size with it.
    c.put(B, "7", '"cdn-300-9"', tl(7), 300);
    expect(c.candidates(A, "7").map((h) => h.etag)).toEqual(['"cdn-300-9"']);
    expect(c.size()).toEqual({ n: 1, bytes: Math.ceil(300 * DECODED_PER_CHAR) });
  });

  it("holds at most its bytes, dropping the least recently used", () => {
    const c = new TimelineCache(Math.ceil(250 * DECODED_PER_CHAR));
    c.put(A, "1", '"cdn-1-1"', tl(1), 100);
    c.put(A, "2", '"cdn-2-1"', tl(2), 100);
    // 1 is used again: 2 is the least recently used.
    expect(c.confirm(A, "1", '"cdn-1-1"')).toBeDefined();
    c.put(A, "3", '"cdn-3-1"', tl(3), 100);
    expect(c.candidates(A, "2")).toEqual([]);
    expect(c.candidates(A, "1").length).toBe(1);
    expect(c.candidates(A, "3").length).toBe(1);
    expect(c.size()).toEqual({ n: 2, bytes: 2 * Math.ceil(100 * DECODED_PER_CHAR) });
    // One larger than the whole cap is handed back, not kept, and pushes nothing out.
    const big = c.put(A, "4", '"cdn-4-1"', tl(4), 251);
    expect(Object.isFrozen(big)).toBe(true);
    expect(c.candidates(A, "4")).toEqual([]);
    expect(c.size().n).toBe(2);
    c.clear();
    expect(c.size()).toEqual({ n: 0, bytes: 0 });
  });

  it("freezes what it keeps, all the way down", () => {
    const c = new TimelineCache();
    const t = c.put(A, "7", CDN, tl(7), 100) as unknown as { players: Array<{ x: number[]; name: string }>; duration_s: number };
    expect(Object.isFrozen(t)).toBe(true);
    expect(Object.isFrozen(t.players)).toBe(true);
    expect(Object.isFrozen(t.players[0])).toBe(true);
    expect(Object.isFrozen(t.players[0]!.x)).toBe(true);
    expect(() => (t.players[0]!.x[0] = 9)).toThrow(TypeError);
    expect(() => t.players.push(t.players[0]!)).toThrow(TypeError);
    expect(() => (t.duration_s = 1)).toThrow(TypeError);
    expect(freezeDeep(null)).toBeNull();
    expect(freezeDeep(3)).toBe(3);
  });
});
