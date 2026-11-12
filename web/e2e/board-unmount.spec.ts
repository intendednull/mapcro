// A board unmounts cleanly (sessions.md §4.1 and §10 phase 0): in one page, without a reload,
// board A mounts, unmounts and board B mounts, by the browser's own back and forward (core/nav.ts
// follows the address in place). Once A is gone:
// - A's socket is closed, and the server sees it: A's other person sees this one leave;
// - nothing of A's still runs: no interval, no rAF loop, no polling timeout, no window or
//   document listener (a `once` one too), no live observer, no open socket, no timeout pending.
//   The page is instrumented (`watch` below) and each count, taken on the landing between boards,
//   is held to the landing's own on a fresh page. From the moment A is left, no request is made
//   and no timeout or rAF is set from a place the fresh landing doesn't set one from, so a long
//   one-shot timer (a 5 s retry, a reconnect's backoff) shows even if it fires late;
// - the tab's title is the page's own (on the landing, on a dead link, and as B mounts until
//   B's arrives);
// - module state is at its defaults: no hover label and no game tooltip shown on B (the reset is
//   unit-tested in test/module-state.test.ts);
// - B works normally: Player with a match, playing; presence; following its presenter.
// Then A again, as a third mount: the same, and A opens on its match. Also: a board left while
// its matches, a timeline or a Load's answer is held back starts nothing when they come; the
// landing left while Open match makes its board doesn't move the user after; and the same board
// under another token mounts afresh with the stroke the old mount just drew.

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, type Route, expect, test } from "./fixtures";
import { editLink, gesture, joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const N = 120;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-board-unmount-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "200" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
/** A match whose heroes stand still, `shift` apart between matches (so a hover carried from one
 * board to the other would label a token away from the pointer). */
function timeline(id: string, shift: number) {
  return {
    match_id: Number(id), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: `${team === "amber" ? "A" : "S"}${slot}`,
        x: range(() => slot * 1500 - 4000 + shift), y: range(() => (team === "amber" ? -3000 : 3000) + shift),
        health: range(() => 100), deaths: [], respawn: [], souls: [[0, 500]], ult: range(() => 0), seen: [],
        items: [[50, 715_762_406, 0]], abilities: [], casts: [], charges: [], effects: [], cc: [], height: [], recaps: [],
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [],
    waves: [{ lane: "lane4", t: range(() => 500), stale: [] }],
    troopers: { every_s: 1, amber: range(() => ""), sapphire: range(() => "") },
  };
}

/** Load a match as an editor does, the worker's answer written by hand (as follow-matrix). */
async function load(p: Page, id: string, shift: number) {
  const bar = p.getByTestId("player");
  if (!(await bar.count()) || (await bar.getAttribute("data-state")) !== "match") await p.getByTestId("mode-player").first().click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(id);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${id}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline(id, shift)));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(p.getByTestId("match-clock")).toBeVisible();
}

// ---- the instrument: what a page has running, counted from before the app loads ----

interface Running {
  intervals: string[];
  /** Timeouts set, rAF callbacks asked for and requests made (method and path) during the quiet
   * window. */
  timeoutsSet: string[];
  rafs: string[];
  requests: string[];
  /** One-shot timeouts set and not yet run or cleared (where each was set). */
  pending: string[];
  /** Uploads (XHR) not yet ended. */
  xhrs: number;
  /** Body children left inert (a modal's). */
  inert: number;
  /** IndexedDB connections open. */
  idb: number;
  /** Listeners on window and document, as `target type` (a `once` one until it runs). */
  listeners: string[];
  /** Observers observing something (made and not disconnected). */
  observers: string[];
  sockets: number;
}

function watch() {
  type Site = string;
  // Where a call came from, in the app's own code: the first two frames of the app's bundle.
  // Playwright's own (its injected script, anonymous) are left out of every count.
  const site = (): Site | undefined => {
    const lines = (new Error().stack ?? "").split("\n").filter((l) => l.includes("/assets/"));
    return lines.length ? lines.slice(0, 2).map((l) => l.trim().replace(/^at /, "").replace(/https?:\/\/[^/]+\//, "")).join(" < ") : undefined;
  };
  const intervals = new Map<number, Site>();
  /** One-shot timeouts set and not yet run or cleared. */
  const pending = new Map<number, Site>();
  type Log = { timeouts: Site[]; rafs: Site[]; requests: string[] };
  const log = (): Log => ({ timeouts: [], rafs: [], requests: [] });
  let quiet: Log | undefined;
  /** What was set or asked for since `__mark` (the board being left), or since the page loaded:
   * a long one-shot timer set as the board goes (a 5 s retry, a reconnect's backoff) shows here
   * even if it fires after the quiet window, and in `pending` while it waits. */
  let since = log();
  const request = (what: string) => {
    quiet?.requests.push(what);
    since.requests.push(what);
  };
  const w = window as unknown as Record<string, unknown>;
  const si = window.setInterval.bind(window);
  const ci = window.clearInterval.bind(window);
  const st = window.setTimeout.bind(window);
  const ct = window.clearTimeout.bind(window);
  const ra = window.requestAnimationFrame.bind(window);
  w.setInterval = (fn: TimerHandler, ms?: number, ...a: unknown[]) => {
    const id = si(fn, ms, ...a);
    const at = site();
    if (at) intervals.set(id, at);
    return id;
  };
  w.setTimeout = (fn: TimerHandler, ms?: number, ...a: unknown[]) => {
    const at = site();
    if (!at || typeof fn !== "function") return st(fn, ms, ...a);
    quiet?.timeouts.push(at);
    since.timeouts.push(at);
    const id: number = st((...b: unknown[]) => {
      pending.delete(id);
      (fn as (...b: unknown[]) => void)(...b);
    }, ms, ...a);
    pending.set(id, at);
    return id;
  };
  // A timeout and an interval share ids: either clear stops either.
  w.clearTimeout = (id?: number) => {
    if (id !== undefined) {
      intervals.delete(id);
      pending.delete(id);
    }
    ct(id);
  };
  w.clearInterval = (id?: number) => {
    if (id !== undefined) {
      intervals.delete(id);
      pending.delete(id);
    }
    ci(id);
  };
  w.requestAnimationFrame = (fn: FrameRequestCallback) => {
    const at = site();
    if (at) {
      quiet?.rafs.push(at);
      since.rafs.push(at);
    }
    return ra(fn);
  };
  // Listeners on window and document (an element's go with it).
  const listening = new Map<string, number>();
  const key = (t: EventTarget, type: string, o?: boolean | AddEventListenerOptions) => `${t === window ? "window" : "document"} ${type}${(typeof o === "boolean" ? o : !!o?.capture) ? " capture" : ""}`;
  const handlers = new WeakMap<object, Set<string>>();
  // A `once` listener is counted until it runs: it's added as a wrapper that uncounts itself
  // first (and is what a removeEventListener of the original removes).
  const wrappers = new WeakMap<object, Map<string, EventListener>>();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const uncount = (fn: object, k: string) => {
    if (handlers.get(fn)?.delete(k)) listening.set(k, listening.get(k)! - 1);
  };
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
    if ((this === window || this === document) && fn && site()) {
      const k = key(this, type, o);
      const seen = handlers.get(fn) ?? new Set();
      if (!seen.has(k)) {
        seen.add(k);
        handlers.set(fn, seen);
        listening.set(k, (listening.get(k) ?? 0) + 1);
        // A listener given an AbortSignal goes when it aborts, with no remove.
        if (typeof o === "object" && o.signal) o.signal.addEventListener("abort", () => uncount(fn, k), { once: true });
        if (typeof o === "object" && o.once) {
          const run: EventListener = (e) => {
            uncount(fn, k);
            wrappers.get(fn)?.delete(k);
            return typeof fn === "function" ? fn.call(this, e) : fn.handleEvent(e);
          };
          const ws = wrappers.get(fn) ?? new Map<string, EventListener>();
          ws.set(k, run);
          wrappers.set(fn, ws);
          return add.call(this, type, run, o);
        }
      }
    }
    return add.call(this, type, fn, o);
  };
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) {
    if ((this === window || this === document) && fn) {
      const k = key(this, type, o);
      uncount(fn, k);
      const run = wrappers.get(fn)?.get(k);
      if (run) {
        wrappers.get(fn)!.delete(k);
        return remove.call(this, type, run, o);
      }
    }
    return remove.call(this, type, fn, o);
  };
  // Observers, and sockets.
  const observing = new Map<object, string>();
  for (const name of ["ResizeObserver", "IntersectionObserver", "MutationObserver"] as const) {
    const Base = w[name] as { new (...a: never[]): { observe(...a: unknown[]): void; disconnect(): void } };
    w[name] = class extends Base {
      override observe(...a: unknown[]) {
        const at = site();
        if (at) observing.set(this, `${name} ${at}`);
        return super.observe(...a);
      }
      override disconnect() {
        observing.delete(this);
        return super.disconnect();
      }
    };
  }
  // Requests: fetch and XHR.
  const path = (u: unknown) => new URL(String(u instanceof Request ? u.url : u), location.href).pathname.replace(/[A-Za-z0-9_-]{22}/, "<board>").replace(/\d{6,}/, "<match>");
  const f = window.fetch.bind(window);
  w.fetch = (u: RequestInfo | URL, init?: RequestInit) => {
    if (site()) request(`${init?.method ?? "GET"} ${path(u)}`);
    return f(u, init);
  };
  let xhrs = 0;
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, m: string, u: string | URL, ...a: unknown[]) {
    request(`${m} ${path(u)}`);
    return (open as (...a: unknown[]) => void).call(this, m, u, ...a);
  };
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    xhrs++;
    this.addEventListener("loadend", () => xhrs--, { once: true });
    return send.call(this, body);
  };
  // IndexedDB connections: opened, and not closed (by us or a version change).
  let idb = 0;
  const idbOpen = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
    const req = idbOpen.call(this, name, version);
    req.addEventListener("success", () => {
      idb++;
      let closed = false;
      const db = req.result;
      const close = db.close.bind(db);
      db.close = () => {
        if (!closed) idb--;
        closed = true;
        close();
      };
      db.addEventListener("close", () => {
        if (!closed) idb--;
        closed = true;
      });
    });
    return req;
  };
  const sockets: WebSocket[] = [];
  const WS = window.WebSocket;
  w.WebSocket = class extends WS {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(this);
    }
  };
  w.__mark = () => void (since = log());
  w.__since = () => ({ timeouts: [...since.timeouts].sort(), rafs: [...since.rafs].sort(), requests: [...since.requests].sort() });
  w.__running = async (ms: number) => {
    quiet = log();
    await new Promise((r) => st(r, ms));
    const q = quiet;
    quiet = undefined;
    return {
      intervals: [...intervals.values()].sort(),
      timeoutsSet: q.timeouts.sort(),
      rafs: q.rafs.sort(),
      requests: q.requests.sort(),
      pending: [...pending.values()].sort(),
      xhrs,
      idb,
      inert: [...document.body.children].filter((c) => (c as HTMLElement).inert).length,
      listeners: [...listening].flatMap(([k, n]) => Array<string>(Math.max(0, n)).fill(k)).sort(),
      observers: [...observing.values()].sort(),
      sockets: sockets.filter((s) => s.readyState === WebSocket.CONNECTING || s.readyState === WebSocket.OPEN).length,
    } satisfies Running;
  };
}

/** What the page runs over a quiet 2.5 s (no input meanwhile): longer than the board's polls
 * (the replay job's 1.5 s, the upload queue's 2 s). */
const running = (p: Page): Promise<Running> => p.evaluate(() => (window as unknown as { __running: (ms: number) => Promise<Running> }).__running(2500));
/** Timeouts set, rAFs asked for and requests made since the board was left (or the page loaded). */
interface Since {
  timeouts: string[];
  rafs: string[];
  requests: string[];
}
const sinceOf = (p: Page): Promise<Since> => p.evaluate(() => (window as unknown as { __since: () => Since }).__since());
/** The landing on a fresh page: what it runs, and what it set going as it loaded. */
interface Fresh {
  running: Running;
  since: Since;
}
async function freshLanding(p: Page): Promise<Fresh> {
  await p.goto(`${server.url}/`);
  await expect(p.getByTestId("open-match")).toBeVisible();
  const r = await running(p);
  expect(r.sockets).toBe(0);
  return { running: r, since: await sinceOf(p) };
}
/** The places in `now` that `base` never set from. */
const beyond = (now: string[], base: string[]) => [...new Set(now)].filter((at) => !base.includes(at));

/** Show `url` as back or forward does: a history entry for it, then a traversal onto it. */
async function open(p: Page, url: string) {
  await p.evaluate((u) => {
    history.pushState(null, "", u);
    history.pushState(null, "", "/");
    history.back();
  }, url);
  await expect.poll(() => p.url()).toBe(url);
}

/** Leave the board by the browser's Back (`steps` entries back): to the landing, the page never
 * reloaded. Requests, timeouts and rAFs are counted from here. */
async function back(p: Page, steps = 1) {
  await p.evaluate((n) => {
    (window as unknown as { __mark: () => void }).__mark();
    history.go(-n);
  }, steps);
  await expect(p.getByTestId("open-match")).toBeVisible();
}

async function joinBoard(p: Page) {
  const card = p.getByTestId("join-card");
  await expect(p.getByTestId("save-status")).toBeVisible();
  if (await card.isVisible()) {
    await p.locator("#join-name").fill("Tester");
    await p.keyboard.press("Enter");
    await expect(card).toBeHidden();
  }
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
}

const avatar = (p: Page, name: string) => p.locator(`[data-testid=avatars] [title="${name}"]`);
const clockAt = async (p: Page) => ((await p.getByTestId("match-clock").textContent()) ?? "").split(" / ")[0]!.trim();

/** A board left: the server dropped us (the other person sees it), and nothing of it runs. Its
 * only requests since are `asks` (an upload's place given back), and it set no timeout or rAF
 * from a place the fresh landing doesn't (the landing mounts again meanwhile). Answers held back
 * while it was up (`hold`) are given meanwhile: one coming after the board is gone sets nothing
 * going. The tab's title is the page's own again. */
async function leftClean(p: Page, other: Page, fresh: Fresh, what: string, asks: string[]) {
  await expect(avatar(other, "Tester")).toHaveCount(0, { timeout: 10_000 });
  await p.waitForTimeout(500);
  const [now] = await Promise.all([running(p), p.waitForTimeout(300).then(() => release(p))]);
  expect.soft(now, `${what}: what still runs`).toEqual(fresh.running);
  const since = await sinceOf(p);
  expect.soft(since.requests, `${what}: requests after it was left`).toEqual(asks);
  expect.soft(beyond(since.timeouts, fresh.since.timeouts), `${what}: timeouts set after it was left`).toEqual([]);
  expect.soft(beyond(since.rafs, fresh.since.rafs), `${what}: rAFs asked for after it was left`).toEqual([]);
  expect.soft(await p.title(), `${what}: the tab's title`).toBe("mapcro");
  // Module state: no label or tooltip left showing anywhere.
  await expect(p.getByTestId("hover-label")).toHaveCount(0);
  await expect(p.getByTestId("game-tooltip-float")).toHaveCount(0);
}

/** A board in use: playing a match, a hero hovered (its label up), a presenter followed. */
async function inUse(p: Page, presenter: Page, presenterName: string, upload: Upload) {
  // Presence: each sees the other.
  await expect(avatar(presenter, "Tester")).toHaveCount(1);
  await expect(avatar(p, presenterName)).toHaveCount(1);
  // Module state at its defaults on arrival: no label before anything is hovered.
  await expect(p.getByTestId("hover-label")).toHaveCount(0);
  // Player plays.
  await p.getByTestId("match-play").click();
  const t0 = await clockAt(p);
  await expect.poll(() => clockAt(p)).not.toBe(t0);
  // Follow: the presenter's scrub shows here.
  await p.getByTestId(`follow-${presenterName}`).click();
  await expect(p.getByTestId("follow-chip")).toContainText(`Following ${presenterName}`);
  await presenter.getByTestId("match-time").evaluate((el) => {
    (el as HTMLInputElement).value = "100";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(() => clockAt(p)).toMatch(/^1:4\d$/);
  // Hover a hero: its label shows, and stays up as the board is left.
  const tok = p.locator(`[data-testid=map] .tok[data-slot="Amber-0"]`);
  const b = (await tok.boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await expect(p.getByTestId("hover-label")).toHaveAttribute("data-key", "Amber-0");
  // An upload of the match's replay under way as the board is left, by `upload`: waiting for its
  // turn (the board asks again every 2 s), or sending (its request never answered).
  uploading.set(p, upload);
  await revealControls(p, "match-id");
  await p.getByTestId("match-file").setInputFiles({ name: `${await matchOf(p)}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  await expect.poll(() => (upload === "waiting" ? asked : sending).get(p) ?? 0).toBeGreaterThan(0);
  // And a dialog open as the board is left: Share.
  await p.getByTestId("share").click();
  await expect(p.getByTestId("share-dialog")).toBeVisible();
}

/** The upload queue, stubbed by page: always one ahead, or your turn and the upload never
 * answered. Counts the turns asked for and the uploads sent. */
type Upload = "waiting" | "sending";
const uploading = new Map<Page, Upload>();
const asked = new Map<Page, number>();
const sending = new Map<Page, number>();
const bump = (m: Map<Page, number>, p: Page) => m.set(p, (m.get(p) ?? 0) + 1);
/** Answers held back, by page, while `hold` says so: the replay job's state (given as still in
 * progress), the board's matches, a match's timeline (`GET …/matches/<id>`), a new board. The
 * others are given as the server answers. */
type Hold = "jobs" | "matches" | "timelines" | "boards";
const holding = new Map<Page, Set<Hold>>();
const held = new Map<Page, Array<() => Promise<void>>>();
const hold = (p: Page, ...what: Hold[]) => holding.set(p, new Set(what));
const heldCount = (p: Page) => (held.get(p) ?? []).length;
/** Stop holding, and give the held answers. */
async function release(p: Page) {
  holding.delete(p);
  const h = held.get(p) ?? [];
  held.set(p, []);
  await Promise.all(h.map((f) => f()));
}
/** Hold `r` back if `p` holds `what`, given later by `answer`; else let it through. */
function maybeHold(p: Page, what: Hold, r: Route, answer: () => Promise<void>) {
  if (!holding.get(p)?.has(what)) return r.continue();
  held.set(p, [...(held.get(p) ?? []), () => answer().catch(() => {})]);
}
async function stubQueue(p: Page) {
  await p.route("**/api/boards/*/replays/*", (r) => {
    if (r.request().method() !== "GET") return r.continue();
    return maybeHold(p, "jobs", r, () => r.fulfill({ json: { state: "queued", source: "cdn", ahead: 0 } }));
  });
  await p.route("**/api/boards/*/matches", (r) => (r.request().method() === "GET" ? maybeHold(p, "matches", r, () => r.continue()) : r.continue()));
  await p.route("**/api/boards/*/matches/*", (r) => (r.request().method() === "GET" ? maybeHold(p, "timelines", r, () => r.continue()) : r.continue()));
  await p.route("**/api/boards", (r) => (r.request().method() === "POST" ? maybeHold(p, "boards", r, () => r.continue()) : r.continue()));
  await p.route("**/api/boards/*/replays/*/reserve", (r) => {
    if (r.request().method() !== "POST") return r.continue();
    bump(asked, p);
    return r.fulfill({ json: uploading.get(p) === "sending" ? { state: "ready" } : { state: "waiting", ahead: 1 } });
  });
  await p.route("**/api/boards/*/replays/*/upload", () => {
    // Held: the upload stays in flight until the page gives it up.
    bump(sending, p);
  });
}
const matchOf = async (p: Page) => /\d{6,}/.exec((await p.locator(".pl-source summary").textContent()) ?? "")![0];

test("a board unmounts cleanly: A, then B, then A again in one page, by back and forward", async ({ browser }) => {
  test.setTimeout(120_000);
  const urlA = await newBoardUrl(server, "Board A");
  const urlB = await newBoardUrl(server, "Board B");
  const coachA = await joinNew(browser, urlA, "CoachA");
  const coachB = await joinNew(browser, urlB, "CoachB");
  await load(coachA, "129000301", 0);
  await load(coachB, "129000302", 900);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(watch);
  const p = await ctx.newPage();
  await stubQueue(p);
  const loads: string[] = [];
  p.on("load", () => loads.push(p.url()));
  // The landing's own, on a fresh page: what every board must leave behind.
  const fresh = await freshLanding(p);

  // A.
  await open(p, urlA);
  await joinBoard(p);
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
  await inUse(p, coachA, "CoachA", "waiting");
  await back(p);
  await leftClean(p, coachA, fresh, "A", ["DELETE /api/boards/<board>/replays/<match>/reserve"]);

  // B, fresh: nothing of A's shows or runs. Its replay job's state is held back, so the board
  // is still waiting for the answer as it's left.
  hold(p, "jobs");
  await open(p, urlB);
  await joinBoard(p);
  await expect(p.getByTestId("board-title")).toHaveText("Board B");
  await expect(p.getByTestId("stop-following")).toHaveCount(0);
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
  await inUse(p, coachB, "CoachB", "sending");
  expect(heldCount(p)).toBeGreaterThan(0);
  await back(p);
  await leftClean(p, coachB, fresh, "B", []);

  // A again: it opens on its match, as on a fresh page.
  await open(p, urlA);
  await joinBoard(p);
  await expect(p.getByTestId("board-title")).toHaveText("Board A");
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
  await inUse(p, coachA, "CoachA", "sending");
  await back(p);
  await leftClean(p, coachA, fresh, "A", []);

  // Board to board, with no landing between: A, then B straight from it.
  await open(p, urlA);
  await expect(p.getByTestId("board-title")).toHaveText("Board A");
  await expect(avatar(coachA, "Tester")).toHaveCount(1);
  await expect(p).toHaveTitle("Board A · mapcro");
  // The tab's titles as B mounts: A's goes as A does, before B's own arrives.
  await p.evaluate(() => {
    const titles: string[] = [];
    (window as unknown as { __titles: string[] }).__titles = titles;
    new MutationObserver(() => titles.push(document.title)).observe(document.head, { childList: true, subtree: true, characterData: true });
  });
  await open(p, urlB);
  await expect(p.getByTestId("board-title")).toHaveText("Board B");
  await expect(p).toHaveTitle("Board B · mapcro");
  expect((await p.evaluate(() => (window as unknown as { __titles: string[] }).__titles))[0]).toBe("mapcro");
  await expect(avatar(coachA, "Tester")).toHaveCount(0, { timeout: 10_000 });
  await expect(avatar(coachB, "Tester")).toHaveCount(1);
  // A board link that doesn't parse: B's title goes with it.
  await open(p, `${server.url}/b/cut-short`);
  await expect(p.getByTestId("dead-link")).toBeVisible();
  await expect(p).toHaveTitle("mapcro");

  // One page throughout: the first load only.
  expect(loads).toEqual([`${server.url}/`]);
});

/** A page as the main test has it: instrumented, the queue stubbed, on a fresh landing. */
async function watched(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(watch);
  const p = await ctx.newPage();
  await stubQueue(p);
  const loads: string[] = [];
  p.on("load", () => loads.push(p.url()));
  return { p, loads, fresh: await freshLanding(p) };
}

test("a board left before its answers come starts nothing after: its matches, a timeline, a Load's attach", async ({ browser }) => {
  test.setTimeout(90_000);
  const url = await newBoardUrl(server, "Board C");
  const coach = await joinNew(browser, url, "CoachC");
  await load(coach, "129000303", 0);
  const { p, fresh } = await watched(browser);

  // Its matches held: left before it knows it has one. Given after, they open nothing.
  hold(p, "matches");
  await open(p, url);
  await joinBoard(p);
  await expect(avatar(coach, "Tester")).toHaveCount(1);
  await expect.poll(() => heldCount(p)).toBeGreaterThan(0);
  await back(p);
  await leftClean(p, coach, fresh, "matches held", []);

  // The match's timeline held: the board's own open waits on it, and so does a Load (an
  // editor's, which attaches once the timeline is in). Given after, neither goes on.
  hold(p, "timelines");
  await open(p, url);
  await joinBoard(p);
  await expect(avatar(coach, "Tester")).toHaveCount(1);
  await expect.poll(() => heldCount(p)).toBeGreaterThan(0);
  const before = heldCount(p);
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill("129000303");
  await p.getByTestId("match-load").click();
  await expect.poll(() => heldCount(p)).toBeGreaterThan(before);
  await back(p);
  await leftClean(p, coach, fresh, "timelines held", []);
});

test("the landing left while Open match makes its board takes no one anywhere after", async ({ browser }) => {
  test.setTimeout(60_000);
  const url = await newBoardUrl(server, "Board E");
  const { p, loads } = await watched(browser);
  // A replay picked: the board for it is being made (its answer held) as the landing is left.
  hold(p, "boards");
  await p.getByTestId("open-match-file").setInputFiles({ name: "129000304.dem", mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  await p.getByTestId("open-match-go").click();
  await expect.poll(() => heldCount(p)).toBe(1);
  await open(p, url);
  await expect(p.getByTestId("board-title")).toHaveText("Board E");
  await release(p);
  await p.waitForTimeout(1500);
  expect(p.url()).toBe(url);
  await expect(p.getByTestId("board-title")).toHaveText("Board E");
  expect(loads).toEqual([`${server.url}/`]);
});

test("the same board under another token: the new mount loads what the old one just drew, and nothing of the old runs", async ({ browser }) => {
  test.setTimeout(90_000);
  const owner = await newBoardUrl(server, "Board D");
  const edit = await editLink(server.url, owner);
  const coach = await joinNew(browser, owner, "CoachD");
  const { p, fresh, loads } = await watched(browser);
  const strokes = (q: Page) => q.locator(".mapbox [data-stroke]");

  await open(p, owner);
  await joinBoard(p);
  await expect(avatar(coach, "Tester")).toHaveCount(1);
  // A stroke, and straight to the edit link: the old session's writes may still be under way
  // as the new one reads the same board's storage.
  await p.keyboard.press("e");
  await gesture(p, [[0.3, 0.3], [0.45, 0.4]]);
  await expect(strokes(p)).toHaveCount(1);
  await open(p, edit);
  await joinBoard(p);
  await expect(p.getByTestId("board-title")).toHaveText("Board D");
  await expect(strokes(p)).toHaveCount(1);
  // A second on the new mount: both reach the other person and stay.
  await p.keyboard.press("e");
  await gesture(p, [[0.6, 0.6], [0.7, 0.65]]);
  await expect(strokes(p)).toHaveCount(2);
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect(strokes(coach)).toHaveCount(2);
  // Left to the landing (the owner link's entry, then the landing's): nothing of either mount
  // runs, and no IndexedDB connection is left open (the instrument's `idb`).
  await back(p, 2);
  await leftClean(p, coach, fresh, "D by two tokens", []);
  // Back on it: the strokes are there, from this device's storage and the server.
  await open(p, owner);
  await expect(p.getByTestId("board-title")).toHaveText("Board D");
  await expect(strokes(p)).toHaveCount(2);
  expect(loads).toEqual([`${server.url}/`]);
});
