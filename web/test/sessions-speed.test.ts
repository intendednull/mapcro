// Sessions phase 3 (sessions.md §4.2, §4.3, §5, §9.1 "Unit level"): what a tab remembers of its
// board, the pool that keeps left boards' sessions warm, and the page's timeline cache. Pure
// parts here; a session parked and resumed against the real server is in sessions-park.test.ts.

import { describe, expect, it, vi } from "vitest";
import { POOL_LIMITS, type Parkable, RoomPool, poolKey } from "../src/session/pool";
import { MAX_TAB_VIEWS, type TabView, loadTabView, parseTabView, playerPart, saveTabView, tabViewKey, withMatches, withScenes } from "../src/session/tabview";
import { DECODED_PER_CHAR, TimelineCache, freezeDeep, isFetched } from "../src/player/timelineCache";
import type { Timeline } from "../src/match/timeline";

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

class Fake implements Parkable {
  parked = 0;
  ended = 0;
  connection: { kind: string } = { kind: "live" };
  constructor(readonly bytes = 1000) {}
  park() {
    this.parked += 1;
  }
  end() {
    this.ended += 1;
  }
  approxBytes() {
    return this.bytes;
  }
}

/** The pool holds to its limits once the switch that parked a board is over (a microtask). */
const settled = () => Promise.resolve();

describe("the pool of left boards (RoomPool)", () => {
  const via = { session: S, grant: "GGGGGGGGGGGGGGGGGGGGGG" };

  it("gives a parked session back only to its own board and credential", () => {
    const pool = new RoomPool<Fake>();
    const a = new Fake();
    pool.park(A, "tok", via, a);
    expect(a.parked).toBe(1);
    // Another board, same credential: never.
    expect(pool.take(B, "tok", via)).toBeUndefined();
    expect(pool.size().n).toBe(1);
    expect(pool.take(A, "tok", via)).toBe(a);
    expect(a.ended).toBe(0);
    // Taken: it's the mount's now, not the pool's.
    expect(pool.size().n).toBe(0);
    expect(pool.take(A, "tok", via)).toBeUndefined();
  });

  it("starts fresh when the credential changed, and ends the one parked for that board", () => {
    for (const [token, v] of [
      ["other", via], // another token
      ["tok", { ...via, grant: "HHHHHHHHHHHHHHHHHHHHHH" }], // another grant ("Can view")
      ["tok", { ...via, session: "TTTTTTTTTTTTTTTTTTTTTT" }], // another session
      ["tok", undefined], // the board's own link, not a grant
    ] as const) {
      const pool = new RoomPool<Fake>();
      const a = new Fake();
      const b = new Fake();
      pool.park(A, "tok", via, a);
      pool.park(B, "tok", via, b);
      expect(pool.take(A, token, v)).toBeUndefined();
      // One session per board: the parked one ended, the other board's untouched.
      expect(a.ended).toBe(1);
      expect(b.ended).toBe(0);
      expect(pool.size().n).toBe(1);
    }
    expect(poolKey(A, "tok")).not.toBe(poolKey(A, "tok", via));
    // No two credentials share a key by how their parts join.
    expect(poolKey(A, "t\u0000x")).not.toBe(poolKey(A, "t", { session: "x", grant: "" }));
  });

  it("keeps at most three beside the open board, dropping the one parked longest", async () => {
    let now = 0;
    const pool = new RoomPool<Fake>(POOL_LIMITS, () => now);
    const made: Fake[] = [];
    for (const board of ["b0", "b1", "b2", "b3"]) {
      const f = new Fake();
      made.push(f);
      now += 1000;
      pool.park(board, "tok", undefined, f);
      await settled();
    }
    expect(pool.size().n).toBe(3);
    expect(made.map((f) => f.ended)).toEqual([1, 0, 0, 0]);
    expect(pool.take("b0", "tok")).toBeUndefined();
    // Parked again, a board is the newest: b1 is the oldest now.
    const b2 = pool.take("b2", "tok")!;
    pool.park("b2", "tok", undefined, b2);
    pool.park("b4", "tok", undefined, new Fake());
    await settled();
    expect(made.map((f) => f.ended)).toEqual([1, 1, 0, 0]);
    expect(pool.take("b2", "tok")).toBe(b2);
    pool.close();
  });

  it("a board asked for in the switch that parks a fourth is given, not dropped", async () => {
    const pool = new RoomPool<Fake>();
    const made = ["b0", "b1", "b2"].map((board) => {
      const f = new Fake();
      pool.park(board, "tok", undefined, f);
      return f;
    });
    await settled();
    // Leaving b3 for b0: b3 is parked and b0 taken in one task, as a tab switch does.
    const b3 = new Fake();
    pool.park("b3", "tok", undefined, b3);
    expect(pool.take("b0", "tok")).toBe(made[0]);
    await settled();
    expect([...made, b3].map((f) => f.ended)).toEqual([0, 0, 0, 0]);
    expect(pool.size().n).toBe(3);
    pool.close();
  });

  it("keeps at most its bytes, and never one larger than all of it", async () => {
    const pool = new RoomPool<Fake>({ max: 3, bytes: 2500, ageMs: 60_000 });
    const a = new Fake(1000);
    const b = new Fake(1000);
    const c = new Fake(1000);
    pool.park("a", "t", undefined, a);
    pool.park("b", "t", undefined, b);
    expect(pool.size()).toEqual({ n: 2, bytes: 2000 });
    pool.park("c", "t", undefined, c);
    await settled();
    expect([a.ended, b.ended, c.ended]).toEqual([1, 0, 0]);
    expect(pool.size()).toEqual({ n: 2, bytes: 2000 });
    const huge = new Fake(2501);
    pool.park("d", "t", undefined, huge);
    expect(huge.ended).toBe(1);
    expect([b.ended, c.ended]).toEqual([0, 0]);
    // One of exactly the budget is kept (and the rest make room for it).
    const whole = new Fake(2500);
    pool.park("e", "t", undefined, whole);
    await settled();
    expect([b.ended, c.ended, whole.ended]).toEqual([1, 1, 0]);
    expect(pool.size()).toEqual({ n: 1, bytes: 2500 });
    // Exactly the budget is kept.
    const pool2 = new RoomPool<Fake>({ max: 3, bytes: 2000, ageMs: 60_000 });
    const x = new Fake(1000);
    const y = new Fake(1000);
    pool2.park("x", "t", undefined, x);
    pool2.park("y", "t", undefined, y);
    await settled();
    expect([x.ended, y.ended]).toEqual([0, 0]);
    pool.close();
    pool2.close();
  });

  it("drops a board parked ten minutes, on its own timer and when asked for", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pool = new RoomPool<Fake>();
      const a = new Fake();
      const b = new Fake();
      pool.park(A, "tok", undefined, a);
      await settled();
      vi.advanceTimersByTime(4 * 60_000);
      pool.park(B, "tok", undefined, b);
      await settled();
      vi.advanceTimersByTime(6 * 60_000 - 1);
      expect([a.ended, b.ended]).toEqual([0, 0]);
      vi.advanceTimersByTime(1);
      expect([a.ended, b.ended]).toEqual([1, 0]);
      expect(pool.size().n).toBe(1);
      vi.advanceTimersByTime(4 * 60_000);
      expect(b.ended).toBe(1);
      expect(pool.size().n).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      // Asked for at the very moment its time is up, before the timer ran: not given.
      let now = 0;
      const p2 = new RoomPool<Fake>({ ...POOL_LIMITS, ageMs: 100 }, () => now);
      const c = new Fake();
      p2.park(A, "tok", undefined, c);
      now = 99;
      expect(p2.take(A, "tok")).toBe(c);
      p2.park(A, "tok", undefined, c);
      now = 99 + 100;
      expect(p2.take(A, "tok")).toBeUndefined();
      expect(c.ended).toBe(1);
      p2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never keeps a session whose link was refused, and ends everything when it closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pool = new RoomPool<Fake>();
      const dead = new Fake();
      dead.connection = { kind: "closed" };
      pool.park(A, "tok", undefined, dead);
      expect([dead.parked, dead.ended]).toEqual([0, 1]);
      expect(pool.size().n).toBe(0);
      const a = new Fake();
      const b = new Fake();
      pool.park(A, "tok", undefined, a);
      pool.park(B, "tok", undefined, b);
      await settled();
      expect(vi.getTimerCount()).toBe(1);
      pool.close();
      expect([a.ended, b.ended]).toEqual([1, 1]);
      expect(pool.size().n).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      // Closed: a board left after that ends at once (the session view is going).
      const late = new Fake();
      pool.park("c", "tok", undefined, late);
      expect([late.parked, late.ended]).toEqual([0, 1]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
