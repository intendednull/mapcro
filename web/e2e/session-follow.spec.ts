// Follow across tabs (sessions.md §6, §9.3): the `session.tab` row of the view-state registry,
// pinned in real browsers as the follow matrix pins a board's keys. A session of two or three
// boards, a presenter and a follower who each opened it through the session's link on a device
// that holds no board link (so every tab opens through its grant), and for some rows a third
// person. Each row is one line of §9.3.

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, devices, expect, test } from "./fixtures";
import { dragToken, joinNew, revealControls, tokenAt, viewLink, viewOf } from "./helpers";
import { phoneContext } from "./phone-layout";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-session-follow-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;
test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  // Every row makes two or three boards and a session from one address: more than the server's
  // 30 creations an hour for an address.
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "200", CREATE_PER_HOUR: "1000" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const boardOf = (url: string) => /\/b\/([^#]+)#/.exec(url)![1]!;
const tabs = (p: Page) => p.getByTestId("game-tab");
const mounted = (p: Page) => p.locator('[data-testid="board"]').getAttribute("data-board");
const saved = (p: Page) => expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
const following = (p: Page) => p.getByTestId("stop-following");
const scenes = (p: Page) => p.getByTestId("scene-card");
const sceneOn = (p: Page) => scenes(p).evaluateAll((els) => els.findIndex((e) => e.getAttribute("aria-current") === "true"));
/** The width of the map's view rectangle: smaller is zoomed in. */
const viewWidth = async (p: Page) => (await viewOf(p))[2];

interface Made {
  /** The session's address, with its owner's token. */
  url: string;
  session: string;
  owner: string;
  /** Each tab's board id, in strip order. */
  boards: string[];
  /** Each board's own owner link. */
  links: string[];
  /** The presenter: the session's owner, on the first tab. */
  a: Page;
}

/** Open tab `i`, as a person does, and wait for its board. */
async function go(p: Page, m: Made, i: number) {
  await tabs(p).nth(i).click();
  await expect.poll(() => mounted(p)).toBe(m.boards[i]);
  await saved(p);
}

/** A session of `n` boards made by the presenter ("Coach"), who is left on its first tab. */
async function session(browser: Browser, n: 2 | 3 = 2): Promise<Made> {
  const links: string[] = [];
  for (let i = 0; i < n; i++) links.push(await newBoardUrl(server, `Board ${"ABC"[i]}`));
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(links[0]!)!;
  const r = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Follow", board, board_token: token }) });
  const s = (await r.json()) as { session: string; owner_token: string };
  const url = `${server.url}/s/${s.session}#${s.owner_token}`;
  const a = await joinNew(browser, url, "Coach");
  for (let i = 1; i < n; i++) {
    await a.getByTestId("add-game").click();
    await a.getByTestId("add-paste").fill(links[i]!);
    await a.getByTestId("add-paste-go").click();
    await expect(tabs(a)).toHaveCount(i + 1);
    await expect.poll(() => mounted(a)).toBe(boardOf(links[i]!));
    await saved(a);
  }
  const m: Made = { url, session: s.session, owner: s.owner_token, boards: links.map(boardOf), links, a };
  await go(a, m, 0);
  return m;
}

/** Another person in the session, through `url` (default: the owner's link), on its first tab. */
async function member(browser: Browser, m: Made, name: string, url = m.url) {
  const p = await joinNew(browser, url, name);
  await expect(tabs(p)).toHaveCount(m.boards.length);
  await expect.poll(() => mounted(p)).toBe(m.boards[0]);
  return p;
}

/** Zoom in on the map's middle (a change to what you see). */
async function zoomIn(p: Page) {
  const was = await viewWidth(p);
  const box = (await p.locator("[data-testid=map] .mm-overlay.map").boundingBox())!;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.wheel(0, -300);
  await expect.poll(() => viewWidth(p)).toBeLessThan(was - 50);
}
/** `p` shows the map as `q` does (a follower's viewport is its presenter's). */
const sameView = (p: Page, q: Page) => expect.poll(async () => Math.abs((await viewWidth(p)) - (await viewWidth(q)))).toBeLessThan(1);

// Characterisation, written before the follow crossed tabs and true after it: inside one tab,
// people who came through the session follow each other as on a board alone.
test("inside a tab, a session member follows another as on a board alone: scene and viewport, Stop, the follower's own change", async ({ browser }) => {
  const m = await session(browser);
  const { a } = m;
  const b = await member(browser, m, "Student");
  await a.getByTestId("scene-add").click();
  await expect(scenes(a)).toHaveCount(2);
  await expect(scenes(b)).toHaveCount(2);
  await scenes(b).nth(0).click();
  await expect.poll(() => sceneOn(b)).toBe(0);
  await expect.poll(() => sceneOn(a)).toBe(1);
  const own = await viewWidth(b);
  await zoomIn(a);
  expect(await viewWidth(b)).toBe(own);
  await b.getByTestId("follow-Coach").click();
  await expect(following(b)).toHaveCount(1);
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  await expect.poll(() => sceneOn(b)).toBe(1);
  await sameView(b, a);
  expect(await viewWidth(b)).toBeLessThan(own - 50);
  await expect(a.getByTestId("presenting")).toContainText("1 following");
  // Live: the presenter flips back.
  await scenes(a).nth(0).click();
  await expect.poll(() => sceneOn(b)).toBe(0);
  // Stop following: the scene stays as the presenter left it.
  await following(b).click();
  await expect(following(b)).toHaveCount(0);
  await scenes(a).nth(1).click();
  await expect.poll(() => sceneOn(a)).toBe(1);
  await b.waitForTimeout(300);
  expect(await sceneOn(b)).toBe(0);
  // Following again, the follower's own flip stops it, and offers the way back.
  await b.getByTestId("follow-Coach").click();
  await expect.poll(() => sceneOn(b)).toBe(1);
  await scenes(b).nth(0).click();
  await expect(following(b)).toHaveCount(0);
  await expect(b.getByTestId("toast")).toContainText("Stopped following Coach");
  expect(await sceneOn(b)).toBe(0);
});

// ---- §9.3, a row each ----

const chip = (p: Page) => p.getByTestId("follow-chip");
const where = (p: Page) => p.getByTestId("follow-where");
const live = (p: Page) => expect(p.getByTestId("save-status")).toHaveAttribute("data-connection", "live", { timeout: 20_000 });
/** `p` is on tab `i`, its board mounted. */
const on = (p: Page, m: Made, i: number) => expect.poll(() => mounted(p), { timeout: 15_000 }).toBe(m.boards[i]);
/** Follow Coach from the people list (both in one board), and wait for it. */
async function follow(p: Page) {
  await p.getByTestId("follow-Coach").click();
  await expect(following(p)).toHaveCount(1);
  await expect(chip(p)).toContainText("Following Coach");
}
const addScene = async (p: Page, n: number) => {
  await p.getByTestId("scene-add").click();
  await expect(scenes(p)).toHaveCount(n);
};

const N = 120;
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
function timeline(id: string) {
  return {
    match_id: Number(id), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: `${team === "amber" ? "A" : "S"}${slot}`,
        x: range(() => slot * 1500 - 4000), y: range(() => (team === "amber" ? -3000 : 3000)),
        health: range(() => 100), deaths: [], respawn: [], souls: [[0, 500]], ult: range(() => 0), seen: [],
        items: [], abilities: [], casts: [], charges: [], effects: [], cc: [], height: [], recaps: [],
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [],
    waves: [{ lane: "lane4", t: range(() => 500), stale: [] }],
    troopers: { every_s: 1, amber: range(() => ""), sapphire: range(() => "") },
  };
}
/** Load a match as an editor does, through the tab's grant; the worker's answer written by hand. */
async function load(p: Page, id: string) {
  const bar = p.getByTestId("player");
  if (!(await bar.count()) || (await bar.getAttribute("data-state")) !== "match") await p.getByTestId("mode-player").first().click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(id);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${id}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline(id)));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(p.getByTestId("match-clock")).toBeVisible();
}
async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}
const clock = (p: Page) => p.getByTestId("match-clock");
const heals = async (p: Page, want: boolean) => {
  await revealControls(p, "heals-toggle");
  await expect(p.getByTestId("heals-toggle")).toHaveAttribute("aria-pressed", String(want));
};
const setHeals = async (p: Page, to: boolean) => {
  await revealControls(p, "heals-toggle");
  if ((await p.getByTestId("heals-toggle").getAttribute("aria-pressed")) !== String(to)) await p.getByTestId("heals-toggle").click();
  await heals(p, to);
};

test("the presenter switches tab, and the follower switches and follows inside the board: scene, view and playback", async ({ browser }) => {
  const m = await session(browser);
  const { a } = m;
  // A has two scenes; B has a match.
  await addScene(a, 2);
  await go(a, m, 1);
  await load(a, "52001");
  await go(a, m, 0);
  const b = await member(browser, m, "Student");
  await follow(b);
  await expect(a.getByTestId("presenting")).toContainText("1 following");
  // To B: the follower's board is B, its address names the tab, and it follows there.
  await go(a, m, 1);
  await on(b, m, 1);
  await expect(following(b)).toHaveCount(1);
  await expect(chip(b)).toContainText("Following Coach");
  await expect.poll(() => new URL(b.url()).searchParams.get("tab")).toBe(new URL(a.url()).searchParams.get("tab"));
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(b.getByTestId("player")).toHaveAttribute("data-state", "match");
  await expect(a.getByTestId("presenting")).toContainText("1 following");
  // Playback, as the follow matrix has it: a seek, then playing.
  await scrubTo(a, 50);
  await expect(clock(a)).toHaveText("0:50 / 2:00");
  await expect(clock(b)).toHaveText("0:50 / 2:00");
  await a.getByTestId("match-play").click();
  await expect(a.getByTestId("match-play")).toHaveText("Pause");
  await expect(b.getByTestId("match-play")).toHaveText("Pause");
  await a.getByTestId("match-play").click();
  await expect(b.getByTestId("match-play")).toHaveText("Play");
  // The viewport.
  await zoomIn(a);
  await sameView(b, a);
  // And back to A, where the presenter flips the scene: the follower's flips with it. A opened
  // here before, so the follower doesn't ask whether it opens: its board's own request only.
  let asked = 0;
  b.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === `/api/boards/${m.boards[0]}/matches`) asked += 1;
  });
  await go(a, m, 0);
  await on(b, m, 0);
  await expect(following(b)).toHaveCount(1);
  await saved(b);
  expect(asked).toBe(1);
  await scenes(a).nth(0).click();
  await expect.poll(() => sceneOn(a)).toBe(0);
  await expect.poll(() => sceneOn(b)).toBe(0);
  await scenes(a).nth(1).click();
  await expect.poll(() => sceneOn(b)).toBe(1);
  // No toast said the presenter left, on either switch.
  await expect(b.getByTestId("toast")).toHaveCount(0);
  await expect(b.getByTestId("session-toast")).toHaveCount(0);
});

test("the follower picks a tab itself: it stops and keeps that tab; Follow again takes it back to the presenter", async ({ browser }) => {
  const m = await session(browser, 3);
  const { a } = m;
  const b = await member(browser, m, "Student");
  await follow(b);
  // The tab it is on already is no change.
  await tabs(b).nth(0).click();
  await expect(following(b)).toHaveCount(1);
  // From the strip.
  await tabs(b).nth(1).click();
  await on(b, m, 1);
  await expect(following(b)).toHaveCount(0);
  await expect(b.getByTestId("session-toast")).toContainText("Stopped following Coach");
  await expect(a.getByTestId("presenting")).toHaveCount(0);
  // The presenter moving on moves nobody now.
  await go(a, m, 2);
  await b.waitForTimeout(500);
  expect(await mounted(b)).toBe(m.boards[1]);
  // Follow again: to the presenter's tab, following there.
  await b.getByTestId("session-follow-again").click();
  await on(b, m, 2);
  await expect(following(b)).toHaveCount(1);
  await expect(chip(b)).toContainText("Following Coach");
  await expect(b.getByTestId("session-toast")).toHaveCount(0);
  // With a key.
  await b.keyboard.press("Control+PageUp");
  await on(b, m, 1);
  await expect(following(b)).toHaveCount(0);
  await go(a, m, 0);
  await b.waitForTimeout(500);
  expect(await mounted(b)).toBe(m.boards[1]);
  // By the address: a link to another tab of this session, opened in the page.
  await go(a, m, 1);
  await follow(b);
  const tabId = (i: number) => tabs(b).nth(i).getAttribute("data-tab");
  const visit = (tab: string) =>
    b.evaluate((tab) => {
      const u = new URL(location.href);
      u.searchParams.set("tab", tab);
      history.pushState(null, "", u);
      dispatchEvent(new PopStateEvent("popstate"));
    }, tab);
  await visit((await tabId(0))!);
  await on(b, m, 0);
  await expect(following(b)).toHaveCount(0);
  await expect(b.getByTestId("session-toast")).toContainText("Stopped following Coach");
  // A tab the session doesn't have: the address goes back to the tab that is open.
  await visit("f".repeat(32));
  await expect.poll(() => new URL(b.url()).searchParams.get("tab")).toBe(await tabId(0));
  expect(await mounted(b)).toBe(m.boards[0]);
  // A game added while following: the follower's own doing, to the new tab.
  await go(a, m, 0);
  await follow(b);
  const extra = await newBoardUrl(server, "Board D");
  await b.getByTestId("add-game").click();
  await b.getByTestId("add-paste").fill(extra);
  await b.getByTestId("add-paste-go").click();
  await expect(tabs(b)).toHaveCount(4);
  await expect.poll(() => mounted(b)).toBe(boardOf(extra));
  await expect(following(b)).toHaveCount(0);
});

/** Withdraw the session's grant on board `i` from the board's side: its tab stays, and opens
 * for nobody (§6.3: a revoked grant). */
async function revokeGrant(m: Made, i: number) {
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(m.links[i]!)!;
  const auth = { authorization: `Bearer ${token}` };
  const list = (await (await fetch(`${server.url}/api/boards/${board}/links`, { headers: auth })).json()) as Array<{ link_id: string; label: string }>;
  const grants = list.filter((l) => l.label.startsWith("Session: "));
  expect(grants.length).toBe(1);
  expect((await fetch(`${server.url}/api/boards/${board}/links/${grants[0]!.link_id}`, { method: "DELETE", headers: auth })).status).toBe(204);
}

test("the presenter goes to a tab nobody can open: the follower stays, its chip reads No access, and the follow resumes", async ({ browser }) => {
  const m = await session(browser, 3);
  const { a } = m;
  const b = await member(browser, m, "Student");
  await revokeGrant(m, 2);
  await follow(b);
  await expect(where(b)).not.toHaveText("No access");
  // The presenter opens the dead tab.
  await tabs(a).nth(2).click();
  await expect(a.getByTestId("no-access")).toBeVisible();
  // The follower stays on A, following, and is told.
  await expect(where(b)).toHaveText("No access");
  expect(await mounted(b)).toBe(m.boards[0]);
  await expect(following(b)).toHaveCount(1);
  await expect(chip(b)).toContainText("Following Coach");
  await expect(b.getByTestId("no-access")).toHaveCount(0);
  // Said at every width: under 1280 px the chip drops its scene name, never this.
  await b.setViewportSize({ width: 1200, height: 900 });
  await expect(where(b)).toBeVisible();
  await expect(where(b)).toHaveText("No access");
  await b.setViewportSize({ width: 1440, height: 900 });
  // Longer than a presenter's own reconnect is waited for: still following, not "Presenter left".
  await b.waitForTimeout(6500);
  await expect(following(b)).toHaveCount(1);
  await expect(where(b)).toHaveText("No access");
  await expect(b.getByTestId("toast")).toHaveCount(0);
  expect(await mounted(b)).toBe(m.boards[0]);
  // The presenter moves to a tab that opens: the follow resumes there.
  await go(a, m, 1);
  await on(b, m, 1);
  await expect(following(b)).toHaveCount(1);
  await expect(where(b)).not.toHaveText("No access");
  await addScene(a, 2);
  await expect.poll(() => sceneOn(b)).toBe(1);
  // And once more round: dead tab, then back to the first.
  await tabs(a).nth(2).click();
  await expect(a.getByTestId("no-access")).toBeVisible();
  await expect(where(b)).toHaveText("No access");
  expect(await mounted(b)).toBe(m.boards[1]);
  await go(a, m, 0);
  await on(b, m, 0);
  await expect(where(b)).not.toHaveText("No access");
  // Stop following from there: nothing moves the follower after.
  await tabs(a).nth(2).click();
  await expect(where(b)).toHaveText("No access");
  await following(b).click();
  await expect(following(b)).toHaveCount(0);
  await go(a, m, 1);
  await b.waitForTimeout(500);
  expect(await mounted(b)).toBe(m.boards[0]);
});

test("on a phone in Player, the follow chip drops the scene name but says No access", async ({ browser }) => {
  const m = await session(browser, 3);
  const { a } = m;
  await load(a, "52031");
  await revokeGrant(m, 2);
  // Someone follows Coach, so Coach is presenting and the phone offers Follow.
  const b = await member(browser, m, "Marrow");
  await follow(b);
  const iphone = devices["iPhone 13"];
  const phone = await (await phoneContext(browser, iphone.viewport, iphone)).newPage();
  await phone.goto(m.url);
  await phone.locator("#join-name").fill("Student");
  await phone.keyboard.press("Enter");
  await expect(phone.getByTestId("board")).toHaveAttribute("data-layout", "phone");
  await expect.poll(() => mounted(phone)).toBe(m.boards[0]);
  await expect(phone.getByTestId("match-tier")).toHaveText("Full replay");
  await phone.getByTestId("follow-presenter").tap();
  await expect(chip(phone)).toContainText("Following Coach");
  await expect(where(phone)).toBeHidden(); // the scene name, under the phone's Player bar
  // The presenter opens the dead tab: the phone stays, following, and its chip says so.
  await tabs(a).nth(2).click();
  await expect(a.getByTestId("no-access")).toBeVisible();
  await expect(where(phone)).toBeVisible();
  await expect(where(phone)).toHaveText("No access");
  await expect(following(phone)).toHaveCount(1);
  expect(await mounted(phone)).toBe(m.boards[0]);
  // Back on the first tab: the chip clears.
  await go(a, m, 0);
  await expect(where(phone)).not.toHaveText("No access");
  await expect(where(phone)).toBeHidden();
  await expect(following(phone)).toHaveCount(1);
});

test("a tab that died after the follower had opened it: the follower lands there once, and not again", async ({ browser }) => {
  const m = await session(browser, 3);
  const { a } = m;
  const b = await member(browser, m, "Student");
  // The follower has been on C, so it knows C opens.
  await go(b, m, 2);
  await go(b, m, 0);
  await follow(b);
  await revokeGrant(m, 2);
  // The presenter opens C: the follower goes too, and both are told.
  await tabs(a).nth(2).click();
  await expect(a.getByTestId("no-access")).toBeVisible();
  await expect(b.getByTestId("no-access")).toBeVisible();
  // On to a tab that opens: the follow goes on there.
  await go(a, m, 1);
  await on(b, m, 1);
  await expect(following(b)).toHaveCount(1);
  // C again: the follower knows now, and stays.
  await tabs(a).nth(2).click();
  await expect(a.getByTestId("no-access")).toBeVisible();
  await expect(where(b)).toHaveText("No access");
  await b.waitForTimeout(500);
  expect(await mounted(b)).toBe(m.boards[1]);
  await expect(b.getByTestId("no-access")).toHaveCount(0);
});

test("the presenter's tab is removed: both move left, and the follow goes on", async ({ browser }) => {
  const m = await session(browser, 3);
  const { a } = m;
  await addScene(a, 2);
  const b = await member(browser, m, "Student");
  await go(a, m, 1);
  await go(b, m, 1);
  await follow(b);
  // The presenter removes the tab both are on.
  await tabs(a).nth(1).getByTestId("tab-remove").click();
  await expect(tabs(a)).toHaveCount(2);
  await on(a, m, 0);
  await on(b, m, 0);
  await expect(tabs(b)).toHaveCount(2);
  await expect(following(b)).toHaveCount(1);
  await expect(chip(b)).toContainText("Following Coach");
  await expect(b.getByTestId("session-toast")).toHaveCount(0);
  // Still live: the presenter's scene, on the tab they landed on.
  await scenes(a).nth(0).click();
  await expect.poll(() => sceneOn(b)).toBe(0);
  await scenes(a).nth(1).click();
  await expect.poll(() => sceneOn(b)).toBe(1);
  await expect(a.getByTestId("presenting")).toContainText("1 following");
});

test("the presenter leaves the session: the follower stays where it is", async ({ browser }) => {
  const m = await session(browser);
  const { a } = m;
  const b = await member(browser, m, "Student");
  await follow(b);
  await go(a, m, 1);
  await on(b, m, 1);
  await expect(following(b)).toHaveCount(1);
  await a.context().close();
  await expect(following(b)).toHaveCount(0, { timeout: 40_000 });
  await expect(b.getByTestId("toast")).toContainText("Presenter left");
  expect(await mounted(b)).toBe(m.boards[1]);
  expect(await tabs(b).nth(1).getAttribute("aria-selected")).toBe("true");
});

test("a late joiner follows, and lands on the presenter's tab", async ({ browser }) => {
  const m = await session(browser);
  const { a } = m;
  const b = await member(browser, m, "Student");
  await follow(b);
  await go(a, m, 1);
  await on(b, m, 1);
  await addScene(a, 2);
  // Someone opens the session's link: on its first tab, where the presenter isn't.
  const c = await member(browser, m, "Late");
  await expect(c.locator(".people")).not.toContainText("Coach");
  await expect(chip(c)).toContainText("Coach is presenting");
  await c.getByTestId("follow-presenter").click();
  await on(c, m, 1);
  await expect(following(c)).toHaveCount(1);
  await expect(chip(c)).toContainText("Following Coach");
  await expect.poll(() => sceneOn(c)).toBe(1);
  await scenes(a).nth(0).click();
  await expect.poll(() => sceneOn(c)).toBe(0);
  await expect(a.getByTestId("presenting")).toContainText("2 following");
  // With the key: another late joiner presses F.
  const d = await member(browser, m, "Later");
  await expect(chip(d)).toContainText("Coach is presenting");
  await d.keyboard.press("f");
  await on(d, m, 1);
  await expect(following(d)).toHaveCount(1);
});

test("a session editor on a view-only tab is followable by session members, and not by a board-only viewer", async ({ browser }) => {
  // The second tab is added through a view link: everyone who comes through the session is a
  // viewer on its board.
  const first = await newBoardUrl(server, "Board A");
  const second = await newBoardUrl(server, "Board V");
  const guestLink = await viewLink(server.url, second);
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(first)!;
  const r = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Follow", board, board_token: token }) });
  const s = (await r.json()) as { session: string; owner_token: string };
  const url = `${server.url}/s/${s.session}#${s.owner_token}`;
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("add-game").click();
  await a.getByTestId("add-paste").fill(await viewLink(server.url, second));
  await a.getByTestId("add-paste-go").click();
  await expect(tabs(a)).toHaveCount(2);
  await expect.poll(() => mounted(a)).toBe(boardOf(second));
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-connection", "live");
  const m: Made = { url, session: s.session, owner: s.owner_token, boards: [boardOf(first), boardOf(second)], links: [first, second], a };
  const b = await member(browser, m, "Student");
  await tabs(b).nth(1).click();
  await on(b, m, 1);
  // A session member is offered the session's owner, though both only view this board.
  await expect(b.locator('.person[data-person="Coach"] .nofollow')).toHaveCount(0);
  await follow(b);
  await zoomIn(a);
  await sameView(b, a);
  await expect(a.getByTestId("presenting")).toContainText("1 following");
  // Someone on the board by its own view link is not: to them the presenter is a viewer.
  const g = await joinNew(browser, guestLink, "Guest");
  await expect(g.locator('.person[data-person="Coach"] .nofollow')).toHaveText("view only");
  await expect(g.getByTestId("follow-Coach")).toHaveCount(0);
  await expect(g.getByTestId("follow-presenter")).toHaveCount(0);
  // Nor is a session's viewer followable by anyone: the session's view link.
  const sv = (await (await fetch(`${server.url}/api/sessions/${s.session}/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.owner_token}` }, body: JSON.stringify({ role: "view", label: "v" }) })).json()) as { token: string };
  const v = await member(browser, m, "Viewer", `${server.url}/s/${s.session}#${sv.token}`);
  await tabs(v).nth(1).click();
  await on(v, m, 1);
  await expect(b.locator('.person[data-person="Viewer"] .nofollow')).toHaveText("view only");
  await expect(v.getByTestId("follow-Coach")).toHaveCount(1);
});

test("after a server restart mid-follow, the follower re-finds the presenter by seat, and still crosses tabs with it", async ({ browser }) => {
  const m = await session(browser);
  const { a } = m;
  await addScene(a, 2);
  const b = await member(browser, m, "Student");
  await follow(b);
  await go(a, m, 1);
  await on(b, m, 1);
  await server.kill();
  await server.start();
  await a.waitForTimeout(1000);
  for (const p of [a, b]) await live(p);
  await expect(following(b)).toHaveCount(1);
  await expect(a.getByTestId("presenting")).toContainText("1 following", { timeout: 20_000 });
  // Found again in the session's room too: the presenter's next switch takes the follower.
  await go(a, m, 0);
  await on(b, m, 0);
  await expect(following(b)).toHaveCount(1);
  await scenes(a).nth(0).click();
  await expect.poll(() => sceneOn(b)).toBe(0);
  await scenes(a).nth(1).click();
  await expect.poll(() => sceneOn(b)).toBe(1);
  await expect(b.getByTestId("toast")).toHaveCount(0);
});

test("two presenters on different tabs, each with followers: no follower's board shows the other presenter's state", async ({ browser }) => {
  const m = await session(browser);
  const { a } = m;
  await addScene(a, 2);
  const a2 = await member(browser, m, "Second");
  await go(a2, m, 1);
  await addScene(a2, 2);
  await addScene(a2, 3);
  const f1 = await member(browser, m, "One");
  await follow(f1);
  const f2 = await member(browser, m, "Two");
  await go(f2, m, 1);
  await f2.getByTestId("follow-Second").click();
  await expect(following(f2)).toHaveCount(1);
  // Each presenter changes what it shows on its own tab.
  await scenes(a).nth(0).click();
  await zoomIn(a);
  await scenes(a2).nth(0).click();
  await expect.poll(() => sceneOn(f2)).toBe(0);
  await scenes(a2).nth(2).click();
  await expect.poll(() => sceneOn(f1)).toBe(0);
  await sameView(f1, a);
  await expect.poll(() => sceneOn(f2)).toBe(2);
  expect(await mounted(f1)).toBe(m.boards[0]);
  expect(await mounted(f2)).toBe(m.boards[1]);
  await expect(scenes(f1)).toHaveCount(2);
  await expect(scenes(f2)).toHaveCount(3);
  // Nothing of the other's: Two's map is not zoomed as Coach's is.
  expect(Math.abs((await viewWidth(f2)) - (await viewWidth(a)))).toBeGreaterThan(50);
  // Coach comes to Second's tab: One comes with Coach and follows Coach there, not Second.
  await go(a, m, 1);
  await on(f1, m, 1);
  await expect(chip(f1)).toContainText("Following Coach");
  await expect(chip(f2)).toContainText("Following Second");
  await scenes(a).nth(1).click();
  await expect.poll(() => sceneOn(a)).toBe(1);
  await expect.poll(() => sceneOn(f1)).toBe(1);
  await zoomIn(a);
  await sameView(f1, a);
  await f2.waitForTimeout(300);
  expect(await sceneOn(f2)).toBe(2);
  expect(Math.abs((await viewWidth(f2)) - (await viewWidth(a)))).toBeGreaterThan(50);
  // Second moves away: Two goes, One stays with Coach.
  await go(a2, m, 0);
  await on(f2, m, 0);
  await f1.waitForTimeout(300);
  expect(await mounted(f1)).toBe(m.boards[1]);
  await expect(following(f1)).toHaveCount(1);
});

// ---- the checks carried from phase 3 (sessions.md §10, phase 4) ----

test("a follower moved off a tab keeps none of the presenter's layers there: only what it set itself; the playback is kept as shown", async ({ browser }) => {
  const m = await session(browser);
  const { a } = m;
  await load(a, "52011");
  await setHeals(a, true);
  const b = await member(browser, m, "Student");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await heals(b, false);
  // Its own choice on this tab before following: Troopers off.
  await revealControls(b, "troopers-toggle");
  await b.getByTestId("troopers-toggle").click();
  await expect(b.getByTestId("troopers-toggle")).toHaveAttribute("aria-pressed", "false");
  await follow(b);
  await heals(b, true); // the presenter's, while following
  await expect(b.getByTestId("troopers-toggle")).toHaveAttribute("aria-pressed", "true");
  await scrubTo(a, 50);
  await expect(clock(b)).toHaveText("0:50 / 2:00");
  // The presenter moves on, and the follower with it.
  await go(a, m, 1);
  await on(b, m, 1);
  await following(b).click();
  await expect(following(b)).toHaveCount(0);
  // Back on A by itself: its own layers (Heals off, Troopers off as it set them there), never
  // the presenter's; the playback where the presenter left it (Keep).
  await go(b, m, 0);
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(following(b)).toHaveCount(0);
  await heals(b, false);
  await expect(b.getByTestId("troopers-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(clock(b)).toHaveText("0:50 / 2:00");
  // And after a reload, from what the tab remembered.
  await b.reload();
  await on(b, m, 0);
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await heals(b, false);
  await expect(b.getByTestId("troopers-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(clock(b)).toHaveText("0:50 / 2:00");
});

test("a layer set before a tab's match is confirmed is the tab's own, also when a follow moves the person off the tab at that moment", async ({ browser }) => {
  const m = await session(browser);
  const { a } = m;
  await load(a, "52021");
  await go(a, m, 1);
  await load(a, "52022");
  await go(a, m, 0);
  const b = await member(browser, m, "Student");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await heals(b, false);
  // B opened and left, then A again with the server's answer for its match held: A's match is
  // drawn from this page's copy, not yet confirmed.
  await go(b, m, 1);
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  let answer!: () => void;
  const held = new Promise<void>((ok) => (answer = ok));
  const timelineOfA = (url: URL) => url.pathname === `/api/boards/${m.boards[0]}/matches/52021`;
  await b.route(timelineOfA, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await held;
    await route.continue().catch(() => {});
  });
  await tabs(b).nth(0).click();
  await on(b, m, 0);
  await expect(clock(b)).toBeVisible();
  // Heals on, set here; then it follows the presenter, who shows Heals off.
  await setHeals(b, true);
  await follow(b);
  await heals(b, false);
  // The presenter leaves for B: the follower is moved off A, its answer still held.
  await go(a, m, 1);
  await on(b, m, 1);
  answer();
  await b.unroute(timelineOfA);
  await saved(b);
  await expect(following(b)).toHaveCount(1);
  // On B it turns Heals off itself (which stops the follow): this browser's choice is off now.
  await setHeals(a, true);
  await heals(b, true);
  await setHeals(b, false);
  await expect(following(b)).toHaveCount(0);
  // A still has what was set there.
  await go(b, m, 0);
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await heals(b, true);
});

test("the strip marks a tab left with changes not sent, until that board is opened again and they go", async ({ browser }) => {
  const m = await session(browser);
  const { a } = m;
  const peer = await joinNew(browser, m.links[0]!, "Peer"); // on A by A's own link
  const unsent = (p: Page) => p.getByTestId("tab-unsent");
  const home = await tokenAt(a, "Amber-0");
  // A move made as the tab is left goes out: no mark.
  await dragToken(a, "Amber-0", 0.3, 0.3);
  await tabs(a).nth(1).click();
  await on(a, m, 1);
  await expect.poll(() => tokenAt(peer, "Amber-0")).not.toEqual(home);
  await a.waitForTimeout(2500);
  await expect(unsent(a)).toHaveCount(0);
  await go(a, m, 0);
  const sent = await tokenAt(a, "Amber-0");
  // The server goes away; a move on A waits in this browser, and A is left.
  await server.kill();
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-state", "offline");
  await dragToken(a, "Amber-0", 0.6, 0.6);
  const kept = await tokenAt(a, "Amber-0");
  await expect(unsent(a)).toHaveCount(0); // the open tab's own save status says it
  await tabs(a).nth(1).click();
  await on(a, m, 1);
  await expect(tabs(a).nth(0).getByTestId("tab-unsent")).toHaveCount(1);
  await expect(unsent(a)).toHaveCount(1);
  await expect(unsent(a)).toHaveAttribute("title", "Not sent");
  expect(await tabs(a).nth(0).getAttribute("title")).not.toContain("Not sent"); // the tab's hover is its name
  // The server is back: the others still don't have the move, and the mark says so; after a
  // reload too.
  await server.start();
  await saved(a);
  await live(peer);
  expect(await tokenAt(peer, "Amber-0")).toEqual(sent);
  await expect(unsent(a)).toHaveCount(1);
  await a.reload();
  await on(a, m, 1);
  await saved(a);
  await expect(tabs(a).nth(0).getByTestId("tab-unsent")).toHaveCount(1);
  // The board opened here again: the move goes, and the mark with it.
  await tabs(a).nth(0).click();
  await on(a, m, 0);
  await expect(unsent(a)).toHaveCount(0);
  await expect.poll(() => tokenAt(peer, "Amber-0"), { timeout: 20_000 }).toEqual(kept);
  await saved(a);
  await tabs(a).nth(1).click();
  await on(a, m, 1);
  await a.waitForTimeout(500);
  await expect(unsent(a)).toHaveCount(0);
  await a.reload();
  await on(a, m, 1);
  await expect(unsent(a)).toHaveCount(0);
});
