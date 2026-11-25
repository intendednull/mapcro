// How Player asks for a match's timeline and what it does with the answer (sessions.md §4.3):
// `Api.timeline`'s validators and its 304s, and each branch of the host's `loadTimeline` against
// the page's cache. The server is a stub here; the real one is in crates/server/tests/replays.rs
// (through a compressing proxy too) and in e2e/session-isolation.spec.ts.
//
// Solid's server build runs these (no effects, memos computed once), so they read signals only:
// the timeline shown, the mode, the problem. Playback is the browser rows'.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { Api, notAnAnswer } from "../src/player/api";
import { createPlayerHost } from "../src/player/host";
import { timelines } from "../src/player/timelineCache";
import type { Timeline } from "../src/match/timeline";

const BOARD = "AAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBBBBBBBB";
const ID = "129738985";
const CDN = '"cdn-0123456789abcdef"';
const CDN_2 = '"cdn-fedcba9876543210"';
const UP = '"up-00112233445566ff"';

class MemStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key = (i: number) => [...this.m.keys()][i] ?? null;
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
  clear = () => this.m.clear();
}

const timeline = (extra: Record<string, unknown> = {}) => ({ match_id: Number(ID), duration_s: 1200, tier: "replay", players: [], events: [], ...extra });
const sent = (tag: string | undefined, body: unknown = timeline(), more: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...(tag ? { "x-mapcro-timeline": tag, etag: tag } : {}), ...more } });
const same = (tag: string | undefined, more: Record<string, string> = {}) => new Response(null, { status: 304, headers: { ...(tag ? { "x-mapcro-timeline": tag, etag: tag } : {}), ...more } });
const refused = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

interface Asked {
  path: string;
  held: string | null;
  inm: string | null;
}
/** Every timeline request made, and the answers to give them, in order. */
let asked: Asked[];
let answers: Array<Response | Promise<Response> | (() => Response | Promise<Response>)>;
let matches: number[] | Response;

beforeEach(() => {
  asked = [];
  answers = [];
  matches = [Number(ID)];
  timelines.clear();
  vi.stubGlobal("localStorage", new MemStorage());
  vi.stubGlobal("sessionStorage", new MemStorage());
  // The host's frame clock: not run here (no effects), only cancelled on cleanup.
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("fetch", async (path: string, init?: { headers?: Record<string, string>; method?: string }) => {
    if (/\/matches$/.test(path)) return matches instanceof Response ? matches : new Response(JSON.stringify({ matches }), { status: 200 });
    if (/\/matches\/\d+$/.test(path) && (init?.method ?? "GET") === "GET") {
      asked.push({ path, held: init?.headers?.["x-mapcro-held"] ?? null, inm: init?.headers?.["if-none-match"] ?? null });
      const next = answers.shift();
      if (!next) throw new Error(`no answer left for ${path}`);
      return typeof next === "function" ? next() : next;
    }
    // The replay job, an attach: nothing.
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Api.timeline: the validator, and a 304", () => {
  const api = () => new Api(BOARD, "token");

  it("asks plainly with nothing held, and takes the validator from its own header", async () => {
    answers.push(sent(CDN));
    const r = await api().timeline(ID);
    expect(asked).toEqual([{ path: `/api/boards/${BOARD}/matches/${ID}`, held: null, inm: null }]);
    expect(r).toEqual({ tl: timeline(), etag: CDN, chars: JSON.stringify(timeline()).length });
  });

  it("sends what is held in both headers, and a 304 naming one of them is the same", async () => {
    answers.push(same(CDN));
    expect(await api().timeline(ID, [UP, CDN])).toEqual({ same: CDN });
    expect(asked).toEqual([{ path: `/api/boards/${BOARD}/matches/${ID}`, held: `${UP}, ${CDN}`, inm: `${UP}, ${CDN}` }]);
    answers.push(same(UP));
    expect(await api().timeline(ID, [UP, CDN])).toEqual({ same: UP });
  });

  it("never reads the ETag: a compressing proxy rewrites it on the 200 and not on the 304", async () => {
    // As Caddy's `encode` hands them over when it compresses the answer itself
    // (docs/deploy.md): `-zstd` on the 200's ETag only.
    answers.push(sent(CDN, timeline(), { etag: '"cdn-0123456789abcdef-zstd"' }));
    const first = await api().timeline(ID);
    expect("etag" in first && first.etag).toBe(CDN);
    answers.push(same(CDN, { etag: CDN }));
    expect(await api().timeline(ID, [CDN])).toEqual({ same: CDN });
    expect(asked.length).toBe(2);
    // An ETag alone names nothing (an older server, a proxy that drops our header): no validator.
    // The page says so, once (this is the file's first replay without one), however many come.
    const said = vi.spyOn(console, "warn").mockImplementation(() => {});
    answers.push(sent(undefined, timeline({ tier: "summary" }))); // the summary has none by design: nothing to say
    await api().timeline(ID);
    expect(said).not.toHaveBeenCalled();
    answers.push(new Response(JSON.stringify(timeline()), { status: 200, headers: { etag: CDN } }));
    expect(await api().timeline(ID)).toEqual({ tl: timeline(), chars: JSON.stringify(timeline()).length });
    answers.push(sent(undefined), sent(undefined));
    await api().timeline(ID);
    await new Api(OTHER, "token").timeline(ID);
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]![0])).toContain("X-Mapcro-Timeline");
    said.mockRestore();
  });

  it("asks again, plainly, when a 304 names nothing this page holds", async () => {
    // Another validator, then none at all (only an ETag): each is asked again with nothing held.
    for (const strange of [same(CDN_2), same(undefined, { etag: CDN })]) {
      asked = [];
      answers.push(strange, sent(CDN_2));
      const r = await api().timeline(ID, [CDN]);
      expect(asked.map((a) => a.held)).toEqual([CDN, null]);
      expect(asked.map((a) => a.inm)).toEqual([CDN, null]);
      expect("etag" in r && r.etag).toBe(CDN_2);
    }
    // A 304 to a plain ask is no answer.
    answers.push(same(CDN));
    expect(await api().timeline(ID)).toEqual({ error: "failed", unknown: true });
    answers.push(same(CDN_2), same(CDN_2));
    expect(await api().timeline(ID, [CDN])).toEqual({ error: "failed", unknown: true });
  });

  it("gives the summary no validator, a refusal its code, and tells no answer from a refusal", async () => {
    answers.push(sent(undefined, timeline({ tier: "summary" })));
    expect(await api().timeline(ID, [])).toEqual({ tl: timeline({ tier: "summary" }), chars: JSON.stringify(timeline({ tier: "summary" })).length });
    // The server's own refusals: a code, and no more.
    for (const [status, code] of [[422, "brawl"], [403, "forbidden"], [404, "not_found"], [401, "unauthorized"], [400, "bad_id"]] as const) {
      answers.push(refused(status, code));
      expect(await api().timeline(ID), String(status)).toEqual({ error: code });
    }
    // Not the server's answer: the proxy's page while it restarts, a 429, a timeout, a body that isn't its JSON.
    for (const none of [new Response("<html>Bad Gateway</html>", { status: 502 }), refused(503, "busy"), refused(504, "late"), refused(500, "failed"), refused(429, "slow_down"), new Response("", { status: 408 }), new Response("not json", { status: 200, headers: { "x-mapcro-timeline": CDN } })]) {
      answers.push(none);
      expect(await api().timeline(ID)).toMatchObject({ unknown: true });
    }
    for (const status of [400, 401, 403, 404, 410, 422, 499]) expect(notAnAnswer(status), String(status)).toBe(false);
    for (const status of [408, 425, 429, 500, 502, 503, 504]) expect(notAnAnswer(status), String(status)).toBe(true);
  });

  it("says the matches aren't known when the server doesn't say", async () => {
    expect(await api().matches()).toEqual([Number(ID)]);
    matches = new Response(JSON.stringify({}), { status: 200 });
    expect(await api().matches()).toEqual([]);
    for (const status of [502, 429, 500]) {
      matches = new Response("no", { status });
      expect(await api().matches()).toBeUndefined();
    }
  });
});

/** A host for `board`, in a root of its own; `end` disposes it. */
function host(board = BOARD, remembered?: Parameters<typeof createPlayerHost>[3]) {
  return createRoot((end) => ({ h: createPlayerHost(board, "token", undefined, remembered), end }));
}
const deferred = () => {
  let answer!: (r: Response) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<Response>((ok, no) => ((answer = ok), (fail = no)));
  return { promise, answer, fail };
};
/** Let the host's awaits run. */
const tick = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
const cached = (board = BOARD) => timelines.candidates(board, ID).map((x) => x.etag);

describe("the host's loadTimeline, against the page's cache", () => {
  it("shows and keeps a timeline sent with a validator, frozen; the next open draws it before the answer and keeps it on a 304", async () => {
    answers.push(sent(CDN));
    const a = host();
    await a.h.open(ID);
    const first = a.h.tl();
    expect(first?.duration_s).toBe(1200);
    expect(Object.isFrozen(first)).toBe(true);
    expect(cached()).toEqual([CDN]);
    expect(asked.map((x) => x.held)).toEqual([null]);
    a.end();

    // Another mount (a tab switched back to), and another board with the same fetched match.
    for (const board of [BOARD, OTHER]) {
      asked = [];
      const d = deferred();
      answers.push(d.promise);
      const b = host(board);
      const opening = b.h.open(ID);
      await tick();
      // Drawn from the page's copy, the server not yet heard from.
      expect(b.h.tl()).toBe(first);
      expect(asked.map((x) => x.held)).toEqual([CDN]);
      d.answer(same(CDN));
      await opening;
      expect(b.h.tl()).toBe(first);
      expect(b.h.problem()).toBeUndefined();
      expect(asked.length).toBe(1);
      b.end();
    }
  });

  it("swaps in the timeline the server sends in place of the one held", async () => {
    answers.push(sent(CDN));
    const a = host();
    await a.h.open(ID);
    const old = a.h.tl();
    a.end();
    const d = deferred();
    answers.push(d.promise);
    const b = host();
    const opening = b.h.open(ID);
    await tick();
    expect(b.h.tl()).toBe(old);
    d.answer(sent(CDN_2, timeline({ duration_s: 1300 })));
    await opening;
    expect(b.h.tl()?.duration_s).toBe(1300);
    expect(Object.isFrozen(b.h.tl())).toBe(true);
    expect(cached()).toEqual([CDN_2]);
    b.end();
  });

  it("takes down what it drew early when the server refuses, and drops the board's own copy", async () => {
    answers.push(sent(UP));
    const a = host();
    await a.h.open(ID);
    expect(cached()).toEqual([UP]);
    a.end();
    const d = deferred();
    answers.push(d.promise);
    const b = host();
    const opening = b.h.open(ID);
    await tick();
    expect(b.h.tl()).toBeDefined();
    d.answer(refused(403, "forbidden"));
    await opening;
    expect(b.h.tl()).toBeUndefined();
    expect(b.h.problem()).toEqual({ code: "forbidden", step: "load" });
    expect(cached()).toEqual([]);
    b.end();
  });

  it("keeps what it drew, and what the page holds, when the answer is the proxy's and not the server's: a 502, a 429", async () => {
    answers.push(sent(UP));
    const a = host();
    await a.h.open(ID);
    const first = a.h.tl();
    a.end();
    for (const none of [new Response("<html>Bad Gateway</html>", { status: 502 }), refused(429, "slow_down"), refused(503, "busy")]) {
      const d = deferred();
      answers.push(d.promise);
      const b = host();
      const opening = b.h.open(ID);
      await tick();
      expect(b.h.tl()).toBe(first);
      d.answer(none);
      await opening;
      // As no answer: drawn still, held still, and nothing said to be wrong with the match.
      expect(b.h.tl()).toBe(first);
      expect(b.h.problem()).toBeUndefined();
      expect(cached()).toEqual([UP]);
      b.end();
    }
    // With nothing to draw, the problem shows; a later open still asks with what is held.
    timelines.clear();
    answers.push(new Response("<html>Bad Gateway</html>", { status: 502 }));
    const c = host();
    await c.h.open(ID);
    expect([c.h.tl(), c.h.problem()]).toEqual([undefined, { code: "failed", step: "load" }]);
    c.end();
  });

  it("keeps what it drew when there is no answer at all", async () => {
    answers.push(sent(CDN));
    const a = host();
    await a.h.open(ID);
    const first = a.h.tl();
    a.end();
    const d = deferred();
    answers.push(d.promise);
    const b = host();
    const opening = b.h.open(ID);
    await tick();
    d.fail(new TypeError("offline"));
    await opening;
    expect(b.h.tl()).toBe(first);
    expect(b.h.status()).toBe("Offline");
    expect(cached()).toEqual([CDN]);
    b.end();
  });

  it("shows the summary frozen and unkept, and forgets the fetched replay it held for the match", async () => {
    answers.push(sent(CDN));
    const a = host();
    await a.h.open(ID);
    a.end();
    answers.push(sent(undefined, timeline({ tier: "summary", duration_s: 900 })));
    const b = host();
    await b.h.open(ID);
    expect(b.h.tl()?.duration_s).toBe(900);
    expect(Object.isFrozen(b.h.tl())).toBe(true);
    // Nothing held now: the next open draws nothing early, and asks plainly.
    expect(cached()).toEqual([]);
    expect(cached(OTHER)).toEqual([]);
    b.end();
    asked = [];
    const d = deferred();
    answers.push(d.promise);
    const c = host();
    const opening = c.h.open(ID);
    await tick();
    expect(c.h.tl()).toBeUndefined();
    expect(asked.map((x) => x.held)).toEqual([null]);
    d.answer(sent(undefined, timeline({ tier: "summary", duration_s: 900 })));
    await opening;
    c.end();
  });

  it("drops the board's own upload when the server answers with the fetched replay", async () => {
    answers.push(sent(UP, timeline({ duration_s: 1250 })));
    const a = host();
    await a.h.open(ID);
    a.end();
    answers.push(sent(CDN));
    const b = host();
    await b.h.open(ID);
    expect(asked.map((x) => x.held)).toEqual([null, UP]);
    expect(b.h.tl()?.duration_s).toBe(1200);
    expect(cached()).toEqual([CDN]);
    b.end();
  });

  it("asks again, plainly, when the one named the same was dropped meanwhile", async () => {
    answers.push(sent(CDN));
    const a = host();
    await a.h.open(ID);
    a.end();
    asked = [];
    // The cache made room between the question and the answer.
    answers.push(() => (timelines.clear(), same(CDN)), sent(CDN, timeline({ duration_s: 1210 })));
    const b = host();
    await b.h.open(ID);
    expect(asked.map((x) => x.held)).toEqual([CDN, null]);
    expect(b.h.tl()?.duration_s).toBe(1210);
    expect(cached()).toEqual([CDN]);
    b.end();
  });
});

describe("a tab as its board opens (sessions.md §4.2)", () => {
  const left = { mode: "player", match: ID, t: 50, playing: false, speed: 2 } as const;

  it("opens in Player on the match it was left on, and on its scene when it was left on one", async () => {
    answers.push(sent(CDN), sent(CDN));
    const a = host(BOARD, left);
    await a.h.init();
    expect([a.h.mode(), a.h.matchId()]).toEqual(["player", ID]);
    a.end();
    timelines.clear();
    const b = host(BOARD, { ...left, mode: "sandbox" });
    await b.h.init();
    expect([b.h.mode(), b.h.matchId()]).toEqual(["sandbox", ID]);
    b.end();
  });

  it("keeps a scene picked while its match is on its way, before the match is drawn and after", async () => {
    // Before: the matches aren't known yet when the user picks a scene.
    const d = deferred();
    answers.push(d.promise);
    const a = host(BOARD, left);
    const opening = a.h.init();
    a.h.setMode("sandbox");
    expect(a.h.remember()).toEqual({ ...left, mode: "sandbox" });
    // A layer set meanwhile is the tab's own already.
    a.h.setShowHeals(true);
    expect(a.h.remember()).toEqual({ ...left, mode: "sandbox", layers: { heals: true } });
    d.answer(sent(CDN));
    await opening;
    expect([a.h.mode(), a.h.matchId()]).toEqual(["sandbox", ID]);
    expect(a.h.remember().mode).toBe("sandbox");
    a.end();

    // After: drawn from the page's copy, the server's answer still out.
    const e = deferred();
    answers.push(e.promise);
    const b = host(BOARD, left);
    const again = b.h.init();
    await tick();
    expect([b.h.mode(), !!b.h.tl()]).toEqual(["player", true]);
    b.h.setMode("sandbox");
    expect(b.h.remember()).toMatchObject({ mode: "sandbox", match: ID, speed: 2 });
    // Drawn: what is done from here is the tab's, though the server hasn't answered.
    b.h.control.speed(4);
    expect(b.h.remember()).toMatchObject({ mode: "sandbox", match: ID, speed: 4 });
    e.answer(same(CDN));
    await again;
    expect(b.h.mode()).toBe("sandbox");
    b.end();
  });

  it("holds a cold match at its default place behind a scene picked before it drew, not at 0:00", async () => {
    const d = deferred();
    answers.push(d.promise);
    const a = host();
    const opening = a.h.init();
    await tick();
    expect([a.h.mode(), a.h.matchId(), a.h.tl()]).toEqual(["player", ID, undefined]);
    a.h.setMode("sandbox"); // a scene picked: the empty Player is left at 0:00
    d.answer(sent(CDN));
    await opening;
    expect(a.h.mode()).toBe("sandbox");
    a.h.setMode("player"); // Back to replay
    expect(a.h.playback().t).toBe(600);
    a.end();
  });

  it("a layer set while the matches aren't known stays the tab's own when a follow begins and moves the page off", async () => {
    // sessions.md §10 phase 4, carried from phase 3: the tab opens, its matches not known yet.
    const d = deferred();
    answers.push(d.promise);
    const a = host(BOARD, left);
    const opening = a.h.init();
    a.h.setShowHeals(true);
    // A follow begins: the presenter's layers are drawn (Heals and Troopers off, Health and
    // Pings on) ...
    a.h.mirror({ layers: 2 | 4 });
    expect([a.h.showHeals(), a.h.showTroopers()]).toEqual([false, false]);
    // ... and it moves this page to another tab at that moment: the tab keeps what was set
    // here, and nothing of the presenter's.
    expect(a.h.remember()).toEqual({ ...left, layers: { heals: true } });
    // And so it does once the matches are known.
    d.answer(sent(CDN));
    await opening;
    expect(a.h.remember().layers).toEqual({ heals: true });
    a.end();
  });

  it("goes to Player when the user asks for it while a tab left on a scene opens", async () => {
    const d = deferred();
    answers.push(d.promise);
    const a = host(BOARD, { ...left, mode: "sandbox" });
    const opening = a.h.init();
    a.h.setMode("player");
    d.answer(sent(CDN));
    await opening;
    expect(a.h.mode()).toBe("player");
    expect(a.h.remember().mode).toBe("player");
    a.end();
  });

  it("takes the tab to Player for a match the user loads, whatever was chosen while it opened", async () => {
    // The matches never became known, and a scene was picked meanwhile.
    matches = new Response("Bad Gateway", { status: 502 });
    const a = host(BOARD, left);
    await a.h.init();
    a.h.setMode("sandbox");
    expect(a.h.remember().mode).toBe("sandbox");
    // Load: the user's own, not the board's match opening behind them.
    answers.push(sent(CDN));
    await a.h.open(ID, { attach: true });
    expect([a.h.mode(), a.h.matchId(), !!a.h.tl()]).toEqual(["player", ID, true]);
    expect(a.h.remember()).toMatchObject({ mode: "player", match: ID });
    a.end();
  });

  it("stays on the scene when it was left on one whose match didn't load; a board that has a match now, or lost that one, opens as cold", async () => {
    // The match is there and its timeline isn't: the tab remembers the match, with no playback.
    answers.push(refused(500, "failed"));
    const a = host(BOARD, left);
    await a.h.init();
    expect([a.h.matchId(), a.h.tl(), a.h.problem()?.code]).toEqual([ID, undefined, "failed"]);
    a.h.setMode("sandbox");
    // The match it was left on, so the playback it had then stays (a 500 mid-deploy loses nothing).
    expect(a.h.remember()).toEqual({ ...left, mode: "sandbox" });
    a.end();
    // Another match than the one remembered, not drawn either: the match alone.
    answers.push(refused(500, "failed"));
    const other = host(BOARD, { ...left, match: "7" });
    await other.h.init();
    other.h.setMode("sandbox");
    expect(other.h.remember()).toEqual({ mode: "sandbox", match: ID });
    const was = other.h.remember();
    other.end();
    // Back: on the scene, the match (loading this time) behind it.
    answers.push(sent(CDN));
    const b = host(BOARD, was);
    await b.h.init();
    expect([b.h.mode(), b.h.matchId(), !!b.h.tl()]).toEqual(["sandbox", ID, true]);
    b.end();
    // Left on a board with no match at all, which has one now: in Player, as a board alone.
    timelines.clear();
    answers.push(sent(CDN));
    const c = host(BOARD, { mode: "sandbox" });
    await c.h.init();
    expect([c.h.mode(), c.h.matchId()]).toEqual(["player", ID]);
    c.end();
    // Left on a scene behind a match that is no longer attached: the newest, in Player.
    timelines.clear();
    answers.push(sent(CDN));
    const d = host(BOARD, { mode: "sandbox", match: "7", t: 3 });
    await d.h.init();
    expect([d.h.mode(), d.h.matchId()]).toEqual(["player", ID]);
    d.end();
  });

  it("remembers what it did before while the matches aren't known: no answer, a 502, a 429", async () => {
    for (const unknown of [new Response("Bad Gateway", { status: 502 }), new Response("slow down", { status: 429 })]) {
      matches = unknown;
      const a = host(BOARD, { ...left, layers: { heals: true } });
      await a.h.init();
      expect(a.h.matchId()).toBeUndefined();
      expect(a.h.matches()).toEqual([]);
      // As a tab that got no answer: not "this board has no match".
      expect(a.h.remember()).toEqual({ ...left, layers: { heals: true } });
      a.end();
    }
    // Known, and none: the match it was on is gone.
    matches = [];
    const b = host(BOARD, left);
    await b.h.init();
    expect(b.h.remember().match).toBeUndefined();
    b.end();
  });

  it("no-match presenter always sends mode in presence so followers mirror Sandbox/Player and scene build open/close consistently (F4)", () => {
    const presenter = host(BOARD);
    const follower = host(BOARD);
    try {
      // Follower starts in Player (no match) with its own Vision choice; presenter is in Sandbox (no match).
      follower.h.setMode("player");
      follower.h.setVision("sapphire");
      const closed = presenter.h.presence();
      expect(closed).toEqual({ player: false, match_id: 0, t: 0, playing: false, speed: 1 });

      // Mirroring the closed no-match presenter puts follower into Sandbox immediately without disturbing Vision.
      follower.h.mirror({ playback: closed! });
      expect(follower.h.mode()).toBe("sandbox");
      expect(follower.h.vision()).toBe("sapphire");
      expect(follower.h.openBuild()).toBeUndefined();

      // Presenter opens a scene build panel -> follower mirrors it in Sandbox.
      presenter.h.setOpenBuild("amber-2");
      const opened = presenter.h.presence();
      expect(opened).toMatchObject({ player: false, match_id: 0, inspect: { team: "Amber", slot: 2 } });
      follower.h.mirror({ playback: opened! });
      expect(follower.h.mode()).toBe("sandbox");
      expect(follower.h.openBuild()).toBe("amber-2");

      // Presenter closes the build panel -> presence still carries player:false; follower closes the panel and stays in Sandbox.
      presenter.h.setOpenBuild(undefined);
      const closedAgain = presenter.h.presence();
      expect(closedAgain).toEqual({ player: false, match_id: 0, t: 0, playing: false, speed: 1 });
      follower.h.mirror({ playback: closedAgain! });
      expect(follower.h.mode()).toBe("sandbox");
      expect(follower.h.openBuild()).toBeUndefined();

      // Presenter switches to Player (no match) and back to Sandbox (no match) -> follower mirrors both transitions.
      presenter.h.setMode("player");
      follower.h.mirror({ playback: presenter.h.presence()! });
      expect(follower.h.mode()).toBe("player");
      presenter.h.setMode("sandbox");
      follower.h.mirror({ playback: presenter.h.presence()! });
      expect(follower.h.mode()).toBe("sandbox");
    } finally {
      presenter.end();
      follower.end();
    }
  });
});
