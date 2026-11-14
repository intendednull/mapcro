// Follow across tabs (sessions.md §6, §9.3): the `session.tab` row of the view-state registry,
// pinned in real browsers as the follow matrix pins a board's keys. A session of two or three
// boards, a presenter and a follower who each opened it through the session's link on a device
// that holds no board link (so every tab opens through its grant), and for some rows a third
// person. Each row is one line of §9.3.

import { type Browser, type Page, expect, test } from "./fixtures";
import { joinNew, viewOf } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  // Every row makes two or three boards and a session from one address: more than the server's
  // 30 creations an hour for an address.
  server = new Server(undefined, { CREATE_PER_HOUR: "1000" });
  await server.start();
});
test.afterAll(() => server.stop());

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
