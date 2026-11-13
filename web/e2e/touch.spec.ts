// Touch on the map (touch direction P0): pinch and the one-gesture rule, editors panning by
// touch, the page guards, and no peer cursor from a finger. CDP `Input.dispatchTouchEvent`
// drives real multi-touch (Chromium only, as phone-layout.ts's drags).

import { type Browser, type CDPSession, type Page, expect, test } from "./fixtures";
import { mapPoint } from "./helpers";
import { checkPhoneLayout } from "./phone-layout";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1440, height: 900 }, hasTouch: true };

async function join(browser: Browser, url: string, name: string, opts: object) {
  const page = await (await browser.newContext(opts)).newPage();
  await page.goto(url);
  await page.locator("#join-name").fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("join-card")).toBeHidden();
  return page;
}

type Pt = { x: number; y: number };
/** Fingers by id, as CDP wants every active touch point in each event. */
class Fingers {
  private down = new Map<number, Pt>();
  constructor(private cdp: CDPSession) {}
  static async on(page: Page) { return new Fingers(await page.context().newCDPSession(page)); }
  private points() { return [...this.down].map(([id, p]) => ({ id, x: p.x, y: p.y })); }
  async press(id: number, at: Pt) {
    this.down.set(id, at);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: this.points() });
  }
  async move(moves: Record<number, Pt>) {
    for (const [id, p] of Object.entries(moves)) this.down.set(Number(id), p);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: this.points() });
  }
  async lift(id: number) {
    this.down.delete(id);
    if (this.down.size) await this.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: this.points() });
    else await this.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  /** Rest, then lift everything (a lift at speed is a fling). */
  async liftAll() {
    await new Promise((ok) => setTimeout(ok, 150));
    for (const id of [...this.down.keys()]) await this.lift(id);
  }
}

const view = async (p: Page) => (await p.getByTestId("map").getAttribute("data-view"))!.split(" ").map(Number);
const viewW = async (p: Page) => (await view(p))[2]!;
const viewX = async (p: Page) => (await view(p))[0]!;
/** A point in the map's visible box (zoomed, the overlay runs past it). */
async function at(p: Page, fx: number, fy: number) {
  const m = (await p.getByTestId("map").boundingBox())!;
  return { x: m.x + m.width * fx, y: m.y + m.height * fy };
}
const strokes = (p: Page) => p.locator("[data-testid=map] [data-stroke]");
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const lerp = (a: Pt, b: Pt, f: number) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });

async function pickDraw(p: Page) {
  if (await p.locator(".phone").count()) await p.getByTestId("phone-edit").tap();
  await p.getByTestId("tool-draw").click();
}

for (const [layout, opts] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
  test(`pinch zooms, and one gesture at a time, in the ${layout} layout`, async ({ browser }) => {
    const page = await join(browser, await newBoardUrl(server, "Pinch"), "Coach", opts);
    await expect(page.locator(".phone")).toHaveCount(layout === "phone" ? 1 : 0);
    await pickDraw(page);
    const f = await Fingers.on(page);
    const c = await mapPoint(page, 0.5, 0.5);
    // Two fingers spreading: the view narrows, and no stroke is drawn.
    const w0 = await viewW(page);
    await f.press(1, { x: c.x - 20, y: c.y });
    await f.press(2, { x: c.x + 20, y: c.y });
    for (let i = 1; i <= 8; i++) await f.move({ 1: { x: c.x - 20 - i * 10, y: c.y }, 2: { x: c.x + 20 + i * 10, y: c.y } });
    // One finger lifts; the other moving on draws nothing (the next stroke needs a fresh press).
    await f.lift(2);
    for (let i = 1; i <= 6; i++) await f.move({ 1: { x: c.x - 100 + i * 15, y: c.y + i * 15 } });
    await f.liftAll();
    await expect.poll(() => viewW(page)).toBeLessThan(w0 * 0.8);
    await sleep(200);
    await expect(strokes(page)).toHaveCount(0);
    // A second finger 300 ms into a stroke is a palm: exactly one stroke, and no zoom.
    const w1 = await viewW(page);
    const a = await at(page, 0.3, 0.3);
    const b = await at(page, 0.6, 0.6);
    await f.press(1, a);
    for (let i = 1; i <= 6; i++) {
      await f.move({ 1: lerp(a, b, i / 12) });
      await sleep(60);
    }
    const palm = await at(page, 0.75, 0.45);
    await f.press(2, palm);
    for (let i = 7; i <= 12; i++) await f.move({ 1: lerp(a, b, i / 12), 2: { x: palm.x + i * 4, y: palm.y } });
    await f.liftAll();
    await expect(strokes(page)).toHaveCount(1);
    expect(await viewW(page)).toBe(w1);
    // Mouse drawing is unchanged.
    await page.mouse.move(a.x, b.y);
    await page.mouse.down();
    await page.mouse.move(b.x, a.y, { steps: 5 });
    await page.mouse.up();
    await expect(strokes(page)).toHaveCount(2);
  });
}

test("an editor pans by touch on empty map in Select; the mouse still draws a marquee", async ({ browser }) => {
  const page = await join(browser, await newBoardUrl(server, "Editor pan"), "Coach", DESKTOP);
  await page.getByTestId("tool-select").click();
  const from = await mapPoint(page, 0.04, 0.04);
  const to = await mapPoint(page, 0.2, 0.12);
  const x0 = await viewX(page);
  const f = await Fingers.on(page);
  await f.press(1, from);
  for (let i = 1; i <= 8; i++) await f.move({ 1: lerp(from, to, i / 8) });
  await f.liftAll();
  await expect.poll(() => viewX(page)).not.toBe(x0);
  await expect(page.getByTestId("marquee")).toHaveCount(0);
  await expect(page.locator(".tok.selected")).toHaveCount(0);
  const x1 = await viewX(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await expect(page.getByTestId("marquee")).toBeVisible();
  await page.mouse.up();
  expect(await viewX(page)).toBe(x1);
});

test("the touch shell guards the page", async ({ browser }) => {
  const page = await join(browser, await newBoardUrl(server, "Guards"), "Coach", PHONE);
  await expect(page.getByTestId("board")).toHaveAttribute("data-layout", "phone");
  // Player's match source holds text fields.
  await page.getByTestId("mode-player").tap();
  await page.getByTestId("phone-more").tap();
  await page.getByTestId("phone-match").tap();
  await expect(page.getByTestId("match-id")).toBeVisible();
  const report = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const shell = getComputedStyle(document.querySelector(".phone")!);
    const shown = (e: Element) => (e as HTMLElement).offsetParent !== null;
    const buttons = [...document.querySelectorAll(".phone button")].filter(shown);
    const inputs = [...document.querySelectorAll("input:not([type=hidden]):not([type=range]):not([type=checkbox]), textarea, select")].filter(shown);
    return {
      overscroll: root.overscrollBehaviorY,
      select: shell.userSelect || shell.webkitUserSelect,
      map: getComputedStyle(document.querySelector(".mm-overlay.map")!).touchAction,
      buttons: buttons.length,
      notManipulation: buttons.filter((b) => !["manipulation", "none"].includes(getComputedStyle(b).touchAction)).length,
      inputs: inputs.length,
      small: inputs.filter((i) => parseFloat(getComputedStyle(i).fontSize) < 16).length,
    };
  });
  expect(report.overscroll).toBe("none");
  expect(report.select).toBe("none");
  expect(report.map).toBe("none");
  expect(report.buttons).toBeGreaterThan(0);
  expect(report.notManipulation).toBe(0);
  expect(report.inputs).toBeGreaterThan(0);
  expect(report.small).toBe(0);
});

test("a finger sends no cursor; the mouse does, and a touch laser still shows", async ({ browser }) => {
  const url = await newBoardUrl(server, "Cursors");
  const peer = await join(browser, url, "Watcher", { viewport: { width: 1440, height: 900 } });
  const page = await join(browser, url, "Coach", DESKTOP);
  const cursor = peer.locator('.cur[data-cursor="Coach"]');
  await page.getByTestId("tool-select").click();
  const f = await Fingers.on(page);
  const a = await mapPoint(page, 0.04, 0.04);
  const b = await mapPoint(page, 0.2, 0.2);
  await f.press(1, a);
  for (let i = 1; i <= 8; i++) await f.move({ 1: lerp(a, b, i / 8) });
  await sleep(400);
  await expect(cursor).toHaveCount(0);
  await f.liftAll();
  await sleep(400);
  await expect(cursor).toHaveCount(0);
  await page.mouse.move(b.x, b.y);
  await page.mouse.move(a.x, a.y, { steps: 4 });
  await expect(cursor).toHaveCount(1);
  await page.mouse.move(0, 0);
  // A finger's laser still shows to the peer.
  await page.getByTestId("tool-laser").click();
  await f.press(1, a);
  for (let i = 1; i <= 8; i++) await f.move({ 1: lerp(a, b, i / 8) });
  await expect(peer.locator('.laser[data-laser="Coach"]')).toHaveCount(1);
  await f.liftAll();
});
