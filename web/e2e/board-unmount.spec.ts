// A board unmounts cleanly (sessions.md §4.1 and §10 phase 0): in one page, without a reload,
// board A mounts, unmounts and board B mounts, by the browser's own back and forward (core/nav.ts
// follows the address in place). Once A is gone:
// - A's socket is closed, and the server sees it: A's other person sees this one leave;
// - nothing of A's still runs: no interval, no rAF loop, no polling timeout, no window or
//   document listener, no live observer, no open socket. The page is instrumented (`watch`
//   below) and each count, taken on the landing between boards, is held to the landing's own on a
//   fresh page;
// - module state is at its defaults: no hover label and no game tooltip shown on B (the reset is
//   unit-tested in test/module-state.test.ts);
// - B works normally: Player with a match, playing; presence; following its presenter.
// Then A again, as a third mount: the same, and A opens on its match.

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
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
  /** Uploads (XHR) not yet ended. */
  xhrs: number;
  /** Body children left inert (a modal's). */
  inert: number;
  /** IndexedDB connections open. */
  idb: number;
  /** Listeners on window and document, as `target type`. */
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
  let quiet: { timeouts: Site[]; rafs: Site[]; requests: string[] } | undefined;
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
  w.clearInterval = (id?: number) => {
    if (id !== undefined) intervals.delete(id);
    ci(id);
  };
  w.setTimeout = (fn: TimerHandler, ms?: number, ...a: unknown[]) => {
    const at = quiet && site();
    if (at) quiet!.timeouts.push(at);
    return st(fn, ms, ...a);
  };
  // A timeout and an interval share ids: either clear stops either.
  w.clearTimeout = (id?: number) => {
    if (id !== undefined) intervals.delete(id);
    ct(id);
  };
  w.requestAnimationFrame = (fn: FrameRequestCallback) => {
    const at = quiet && site();
    if (at) quiet!.rafs.push(at);
    return ra(fn);
  };
  // Listeners on window and document (an element's go with it).
  const listening = new Map<string, number>();
  const key = (t: EventTarget, type: string, o?: boolean | AddEventListenerOptions) => `${t === window ? "window" : "document"} ${type}${(typeof o === "boolean" ? o : !!o?.capture) ? " capture" : ""}`;
  const handlers = new WeakMap<object, Set<string>>();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
    if ((this === window || this === document) && fn && !(typeof o === "object" && o.once) && site()) {
      const k = key(this, type, o);
      const seen = handlers.get(fn) ?? new Set();
      if (!seen.has(k)) {
        seen.add(k);
        handlers.set(fn, seen);
        listening.set(k, (listening.get(k) ?? 0) + 1);
      }
    }
    return add.call(this, type, fn, o);
  };
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) {
    if ((this === window || this === document) && fn) {
      const k = key(this, type, o);
      if (handlers.get(fn)?.delete(k)) listening.set(k, listening.get(k)! - 1);
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
    if (quiet && site()) quiet.requests.push(`${init?.method ?? "GET"} ${path(u)}`);
    return f(u, init);
  };
  let xhrs = 0;
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, m: string, u: string | URL, ...a: unknown[]) {
    if (quiet) quiet.requests.push(`${m} ${path(u)}`);
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
  w.__running = async (ms: number) => {
    quiet = { timeouts: [], rafs: [], requests: [] };
    await new Promise((r) => st(r, ms));
    const q = quiet;
    quiet = undefined;
    return {
      intervals: [...intervals.values()].sort(),
      timeoutsSet: q.timeouts.sort(),
      rafs: q.rafs.sort(),
      requests: q.requests.sort(),
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

/** Show `url` as back or forward does: a history entry for it, then a traversal onto it. */
async function open(p: Page, url: string) {
  await p.evaluate((u) => {
    history.pushState(null, "", u);
    history.pushState(null, "", "/");
    history.back();
  }, url);
  await expect.poll(() => p.url()).toBe(url);
}

/** Leave the board by the browser's Back: to the landing, the page never reloaded. */
async function back(p: Page) {
  await p.evaluate(() => history.back());
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

/** A board left: the server dropped us (the other person sees it), and nothing of it runs. */
async function leftClean(p: Page, other: Page, fresh: Running, what: string) {
  await expect(avatar(other, "Tester")).toHaveCount(0, { timeout: 10_000 });
  // Let one-shot timeouts of the board's run out (the longest, a toast, is 6 s).
  await p.waitForTimeout(500);
  const now = await running(p);
  expect.soft(now, `${what}: what still runs`).toEqual(fresh);
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
async function stubQueue(p: Page) {
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
  await p.goto(`${server.url}/`);
  await expect(p.getByTestId("open-match")).toBeVisible();
  // The landing's own, on a fresh page: what every board must leave behind.
  const fresh = await running(p);
  expect(fresh.sockets).toBe(0);

  // A.
  await open(p, urlA);
  await joinBoard(p);
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
  await inUse(p, coachA, "CoachA", "waiting");
  await back(p);
  await leftClean(p, coachA, fresh, "A");

  // B, fresh: nothing of A's shows or runs.
  await open(p, urlB);
  await joinBoard(p);
  await expect(p.getByTestId("board-title")).toHaveText("Board B");
  await expect(p.getByTestId("stop-following")).toHaveCount(0);
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
  await inUse(p, coachB, "CoachB", "sending");
  await back(p);
  await leftClean(p, coachB, fresh, "B");

  // A again: it opens on its match, as on a fresh page.
  await open(p, urlA);
  await joinBoard(p);
  await expect(p.getByTestId("board-title")).toHaveText("Board A");
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
  await inUse(p, coachA, "CoachA", "sending");
  await back(p);
  await leftClean(p, coachA, fresh, "A");

  // One page throughout: the first load only.
  expect(loads).toEqual([`${server.url}/`]);
});
