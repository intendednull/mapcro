// A placed thing's menu on touch (TD-107): a long press (a finger held still, longPress.ts) on or
// just beside a comment, an arrow or a stroke opens the menu a right click opens, in Select, for editors. A
// drag, a pan or a pinch opens nothing, and a tap does what it did. The phone's numbered pins
// have no side; the desktop layout on a touch screen has them. Each "opens nothing" row ends
// with a long press that opens the menu, so it can't pass on a board with no long press at all.
//
// Chromium: real touch through CDP `Input.dispatchTouchEvent` (as touch.spec.ts). Firefox (the
// operator's phone browser; `just e2e-firefox`) has no CDP: the same fingers are pointer events
// dispatched in the page, which is what the board listens to, without the browser's own touch
// pipeline or capture.

import { type Browser, type CDPSession, type Locator, type Page, expect, test } from "./fixtures";
import { gesture, joinNew, mapPoint } from "./helpers";
import { hasCdp, phoneContext } from "./phone-layout";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());
// Firefox draws these pages in software at 4.2 device px per CSS px (playwright.config.ts).
test.beforeEach(({ browserName }) => test.slow(browserName === "firefox"));
// A Firefox page here sometimes stops answering Playwright before its first gesture (TD-133).
test.describe.configure({ retries: process.env.MAPCRO_E2E_FIREFOX ? 2 : 0 });

type Pt = { x: number; y: number };
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** Past the 500 ms hold. */
const HOLD = 800;
const ROSE = "rgb(240, 143, 176)";
const ICE = "rgb(127, 224, 232)";
const LIME = "rgb(197, 224, 122)";

/** Fingers on a page, by id. */
interface Fingers {
  press(id: number, at: Pt): Promise<void>;
  move(id: number, at: Pt): Promise<void>;
  lift(id: number): Promise<void>;
}

/** Real touch (Chromium): every active point in each event, as CDP wants. */
class CdpFingers implements Fingers {
  private down = new Map<number, Pt>();
  constructor(private cdp: CDPSession) {}
  private points() {
    return [...this.down].map(([id, p]) => ({ id, x: p.x, y: p.y }));
  }
  async press(id: number, at: Pt) {
    this.down.set(id, at);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: this.points() });
  }
  async move(id: number, at: Pt) {
    this.down.set(id, at);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: this.points() });
  }
  async lift(id: number) {
    this.down.delete(id);
    if (this.down.size) await this.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: this.points() });
    else await this.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
}

/** Pointer events in the page (Firefox): what the board's handlers see from a finger. */
class PageFingers implements Fingers {
  constructor(private page: Page) {}
  private send(type: string, id: number, at: Pt) {
    return this.page.evaluate(
      ({ type, id, at }) => {
        const t = document.elementFromPoint(at.x, at.y) ?? document.body;
        const ev = { pointerId: 100 + id, pointerType: "touch", isPrimary: id === 1, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 };
        t.dispatchEvent(new PointerEvent(type, { ...ev, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, composed: true }));
      },
      { type, id, at },
    );
  }
  private at = new Map<number, Pt>();
  press(id: number, at: Pt) {
    this.at.set(id, at);
    return this.send("pointerdown", id, at);
  }
  move(id: number, at: Pt) {
    this.at.set(id, at);
    return this.send("pointermove", id, at);
  }
  lift(id: number) {
    const at = this.at.get(id)!;
    this.at.delete(id);
    return this.send("pointerup", id, at);
  }
}

const fingers = async (browser: Browser, page: Page): Promise<Fingers> => (hasCdp(browser) ? new CdpFingers(await page.context().newCDPSession(page)) : new PageFingers(page));

/** Press, rest past the hold, lift. */
async function longPress(f: Fingers, at: Pt) {
  await f.press(1, at);
  await sleep(HOLD);
}
/** A finger from `a` to `b` over `ms`, in steps. */
async function slide(f: Fingers, id: number, a: Pt, b: Pt, ms: number, steps = 12) {
  for (let i = 1; i <= steps; i++) {
    await f.move(id, { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps });
    await sleep(ms / steps);
  }
}

const centre = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const css = (l: Locator, prop: "stroke" | "fill") => l.evaluate((el, prop) => getComputedStyle(el)[prop], prop);
const menu = (p: Page) => p.getByTestId("placed-menu");
const ids = (p: Page, attr: string) => p.locator(`.mapbox [${attr}]`).evaluateAll((els, attr) => els.map((e) => e.getAttribute(attr)!), attr);

/** A comment, an arrow and a stroke in Parchment, placed by a mouse editor. */
async function placeAll(a: Page) {
  await a.getByTestId("palette").click();
  await a.getByRole("radio", { name: "Colour: Parchment" }).click();
  await a.keyboard.press("s");
  const at = await mapPoint(a, 0.5, 0.45);
  await a.mouse.click(at.x, at.y);
  await a.getByTestId("comment-input").fill("Smoke the bridge");
  await a.keyboard.press("Enter");
  await a.keyboard.press("a");
  await gesture(a, [[0.25, 0.72], [0.45, 0.72]]);
  await a.keyboard.press("e");
  await gesture(a, [[0.55, 0.62], [0.75, 0.62]]);
  await a.keyboard.press("q");
  await expect.poll(async () => [(await ids(a, "data-callout")).length, (await ids(a, "data-arrow")).length, (await ids(a, "data-stroke")).length]).toEqual([1, 1, 1]);
  await a.mouse.move(5, 5);
  return { arrow: (await ids(a, "data-arrow"))[0]!, stroke: (await ids(a, "data-stroke"))[0]! };
}

/** A touch editor on the board, Edit on and Select picked. */
async function touchEditor(browser: Browser, url: string, viewport: { width: number; height: number }) {
  const ctx = await phoneContext(browser, viewport);
  const p = await ctx.newPage();
  await p.goto(url);
  await p.locator("#join-name").fill("Thumb");
  await p.keyboard.press("Enter");
  await expect(p.getByTestId("join-card")).toBeHidden();
  if ((await p.getByTestId("board").getAttribute("data-layout")) === "phone") {
    await p.getByTestId("phone-edit").tap();
    await p.getByTestId("tool-select").tap();
    // Not Playwright's scrollIntoViewIfNeeded: it waits on a stable box, which a software-drawn
    // Firefox at a phone's pixel ratio can starve for the whole test.
    await p.getByTestId("map").evaluate((e) => e.scrollIntoView({ block: "nearest" }));
  } else await p.getByTestId("tool-select").tap();
  return p;
}

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };
/** The operator's phone, about (playwright.config.ts). */
const SMALL = { width: 344, height: 615 };

for (const viewport of [PHONE, TABLET, SMALL]) {
  test(`a long press on a pin, an arrow and a stroke opens its menu and recolours it, for everyone, at ${viewport.width}×${viewport.height}`, async ({ browser }) => {
    const url = await newBoardUrl(server, "touch menu");
    const a = await joinNew(browser, url, "Coach");
    const { arrow, stroke } = await placeAll(a);
    const t = await touchEditor(browser, url, viewport);
    await expect(t.getByTestId("board")).toHaveAttribute("data-layout", "phone");
    const f = await fingers(browser, t);
    const pin = t.locator(".p-map [data-callout]");

    // The pin: held, its menu opens under the finger, and stays when the finger lifts. No side
    // (pins have none), the seven colours, and No colour.
    await longPress(f, await centre(pin));
    await expect(menu(t)).toBeVisible();
    await f.lift(1);
    await expect(menu(t)).toHaveAttribute("aria-label", "Comment");
    // The lift picks nothing, whatever of the menu came up under the finger.
    await sleep(600);
    await expect(menu(t)).toBeVisible();
    await expect(menu(t).locator("[data-testid^='comment-side-']")).toHaveCount(0);
    await expect(menu(t).getByRole("menuitemradio")).toHaveCount(7 + 1);
    await expect(menu(t).getByTestId("recolour-0")).toHaveAttribute("aria-checked", "true");
    // Sized for a finger: every item 40 px or more, the seven swatches in one row, all inside
    // the window.
    const fit = await menu(t).evaluate((el) => {
      const m = el.getBoundingClientRect();
      const items = [...el.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
      const rows = new Set([...el.querySelectorAll(".ctx-swatch")].map((b) => Math.round(b.getBoundingClientRect().top)));
      return { inside: m.left >= 0 && m.top >= 0 && m.right <= innerWidth && m.bottom <= innerHeight, small: items.filter((b) => b.height < 40).length, rows: rows.size };
    });
    expect(fit).toEqual({ inside: true, small: 0, rows: 1 });
    // The hold opened nothing else: the comment isn't open for the other person.
    await menu(t).getByTestId("recolour-1").tap();
    await expect(menu(t)).toHaveCount(0);
    await expect.poll(() => css(a.locator(".mapbox [data-callout] .bubble-body"), "fill")).toBe(ROSE);
    await expect(a.locator(".mapbox [data-callout]")).toHaveAttribute("data-open", "false");

    // Back to no colour: one write, seen by the other.
    await longPress(f, await centre(pin));
    await f.lift(1);
    await expect(menu(t).getByTestId("recolour-1")).toHaveAttribute("aria-checked", "true");
    await menu(t).getByTestId("recolour-none").tap();
    await expect(a.locator(".mapbox [data-callout]")).not.toHaveClass(/tinted/);
    await expect(pin).not.toHaveClass(/tinted/);

    // The arrow, held by its middle: recoloured, and not moved.
    const arrowHit = t.locator(`.p-map [data-arrow="${arrow}"] .hit`);
    const was = await a.locator(`.mapbox [data-arrow="${arrow}"] .hit`).getAttribute("d");
    await longPress(f, await centre(arrowHit));
    await f.lift(1);
    await expect(menu(t)).toHaveAttribute("aria-label", "Arrow");
    await menu(t).getByTestId("recolour-4").tap();
    await expect.poll(() => css(a.locator(`.mapbox [data-arrow="${arrow}"] .arw`), "stroke")).toBe(ICE);
    expect(await a.locator(`.mapbox [data-arrow="${arrow}"] .hit`).getAttribute("d")).toBe(was);

    // The stroke: a drawing's ink always has a colour, so no No colour.
    await longPress(f, await centre(t.locator(`.p-map [data-stroke="${stroke}"] .hit`)));
    await f.lift(1);
    await expect(menu(t)).toHaveAttribute("aria-label", "Drawing");
    await expect(menu(t).getByTestId("recolour-none")).toHaveCount(0);
    await menu(t).getByTestId("recolour-3").tap();
    await expect.poll(() => css(a.locator(`.mapbox [data-stroke="${stroke}"] path.ink`), "stroke")).toBe(LIME);
    await expect(t.getByTestId("dismiss-rejection")).toHaveCount(0);
  });
}

test("a drag on a placed thing moves it and opens no menu, even held still at its end", async ({ browser }) => {
  const url = await newBoardUrl(server, "touch drag");
  const a = await joinNew(browser, url, "Coach");
  const { arrow } = await placeAll(a);
  const t = await touchEditor(browser, url, PHONE);
  const f = await fingers(browser, t);
  const hit = t.locator(`.p-map [data-arrow="${arrow}"] .hit`);
  const was = await a.locator(`.mapbox [data-arrow="${arrow}"] .hit`).getAttribute("d");
  const from = await centre(hit);
  const to = { x: from.x, y: from.y - 60 };
  // Moving for longer than the hold, then held still past it: a drag, not a long press.
  await f.press(1, from);
  await slide(f, 1, from, to, 700);
  await sleep(HOLD);
  await expect(menu(t)).toHaveCount(0);
  await f.lift(1);
  await expect(menu(t)).toHaveCount(0);
  await expect.poll(() => a.locator(`.mapbox [data-arrow="${arrow}"] .hit`).getAttribute("d")).not.toBe(was);
  // A tap on it opens nothing either.
  const now = await centre(hit);
  await f.press(1, now);
  await sleep(100);
  await f.lift(1);
  await sleep(HOLD);
  await expect(menu(t)).toHaveCount(0);
  // Held where it is now: the menu.
  await longPress(f, now);
  await expect(menu(t)).toBeVisible();
  await f.lift(1);
  await expect(menu(t)).toHaveAttribute("aria-label", "Arrow");
});

test("a pan onto a pin, and a pinch with a finger held on it, open no menu", async ({ browser }) => {
  const url = await newBoardUrl(server, "touch pan");
  const a = await joinNew(browser, url, "Coach");
  await placeAll(a);
  const t = await touchEditor(browser, url, PHONE);
  const f = await fingers(browser, t);
  const pin = t.locator(".p-map [data-callout]");
  const view = () => t.getByTestId("map").getAttribute("data-view");

  // A pinch: one finger on the pin, held still the whole time; the other lands at once and
  // spreads. The map zooms and no menu opens, even with both fingers resting past the hold.
  const p0 = await centre(pin);
  const v0 = await view();
  await f.press(1, p0);
  await sleep(40);
  const q0 = { x: p0.x + 40, y: p0.y + 60 };
  await f.press(2, q0);
  await slide(f, 2, q0, { x: q0.x + 60, y: q0.y + 90 }, 300);
  await sleep(HOLD);
  await expect(menu(t)).toHaveCount(0);
  await f.lift(2);
  await f.lift(1);
  await expect.poll(view).not.toBe(v0);
  await sleep(HOLD);
  await expect(menu(t)).toHaveCount(0);

  // A pan from empty map (zoomed in) that ends on the pin and rests there:
  // the map moves, no menu.
  const q = await centre(pin);
  // On the map itself, away from the pin: nothing placed, no hero, no lane's split there. The
  // first such point of a grid over the map's box.
  const start = await t.evaluate((q) => {
    const box = document.querySelector("[data-testid=map]")!.getBoundingClientRect();
    for (let fy = 0.1; fy < 0.95; fy += 0.08)
      for (let fx = 0.1; fx < 0.95; fx += 0.08) {
        const x = box.left + box.width * fx;
        const y = box.top + box.height * fy;
        if (Math.hypot(x - q.x, y - q.y) < 80 || y < 0 || y > innerHeight) continue;
        const e = document.elementFromPoint(x, y);
        if (e?.closest(".mm-overlay.map") && !e.closest("[data-callout], [data-arrow], [data-stroke], .tok, .wave-hit, .lane-raised")) return { x, y };
      }
    return undefined;
  }, q);
  expect(start).toBeTruthy();
  const v1 = await view();
  await f.press(1, start!);
  await slide(f, 1, start!, q, 300);
  await sleep(HOLD);
  await expect(menu(t)).toHaveCount(0);
  await f.lift(1);
  await expect.poll(view).not.toBe(v1);
  await expect(menu(t)).toHaveCount(0);

  // Held on the pin: the menu.
  await longPress(f, await centre(pin));
  await expect(menu(t)).toBeVisible();
  await f.lift(1);
});

test("a hold beside a small pin finds it; a hold on a hero beside it, or on empty map, opens nothing", async ({ browser }) => {
  const url = await newBoardUrl(server, "touch reach");
  const a = await joinNew(browser, url, "Coach");
  // A comment just beside a hero that stands on the map.
  const slot = await a.locator(".mapbox .tok[data-slot]").first().getAttribute("data-slot");
  const tok = await centre(a.locator(`.mapbox .tok[data-slot="${slot}"]`));
  await a.keyboard.press("s");
  await a.mouse.click(tok.x + 34, tok.y);
  await a.getByTestId("comment-input").fill("Smoke the bridge");
  await a.keyboard.press("Enter");
  await a.keyboard.press("q");
  await expect(a.locator(".mapbox [data-callout]")).toHaveCount(1);
  await a.mouse.move(5, 5);
  const t = await touchEditor(browser, url, SMALL);
  const f = await fingers(browser, t);
  const pin = await centre(t.locator(".p-map [data-callout]"));
  const hero = await centre(t.locator(`.p-map .tok[data-slot="${slot}"]`));
  // Beside the pin, on the side away from the hero: its menu.
  await longPress(f, { x: pin.x + (pin.x >= hero.x ? 14 : -14), y: pin.y });
  await expect(menu(t)).toBeVisible();
  await f.lift(1);
  await expect(menu(t)).toHaveAttribute("aria-label", "Comment");
  await t.keyboard.press("Escape");
  await expect(menu(t)).toHaveCount(0);
  // Far from anything placed: nothing.
  const box = (await t.getByTestId("map").boundingBox())!;
  await longPress(f, { x: box.x + box.width / 2, y: pin.y > box.y + box.height / 2 ? box.y + 30 : box.y + box.height - 30 });
  await expect(menu(t)).toHaveCount(0);
  await f.lift(1);
  // On the hero: its own press, no menu, though the pin is within reach. (Last: a hero's tap
  // may open its sheet over the map.)
  await longPress(f, hero);
  await expect(menu(t)).toHaveCount(0);
  await f.lift(1);
  await expect(menu(t)).toHaveCount(0);
});

test("on a touch screen's desktop layout, a tap opens a comment and a long press sets its side, for everyone", async ({ browser }) => {
  const url = await newBoardUrl(server, "touch sides");
  const a = await joinNew(browser, url, "Coach");
  await placeAll(a);
  const t = await touchEditor(browser, url, { width: 1440, height: 900 });
  await expect(t.getByTestId("board")).not.toHaveAttribute("data-layout", "phone");
  const f = await fingers(browser, t);
  const co = t.locator(".mapbox [data-callout]");
  const body = co.locator(".bubble-body");

  // A tap opens the comment, as before, and no menu.
  await f.press(1, await centre(body));
  await sleep(80);
  await f.lift(1);
  await expect(co).toHaveAttribute("data-open", "true");
  await sleep(HOLD);
  await expect(menu(t)).toHaveCount(0);
  await t.keyboard.press("Escape");
  await expect(co).toHaveAttribute("data-open", "false");

  // Held: the menu with the four sides; Below, for both.
  await longPress(f, await centre(body));
  await expect(menu(t)).toBeVisible();
  await f.lift(1);
  await expect(menu(t).getByTestId("comment-side-above")).toHaveAttribute("aria-checked", "true");
  await menu(t).getByTestId("comment-side-below").tap();
  for (const p of [a, t]) await expect(p.locator(".mapbox [data-callout]")).toHaveAttribute("data-side", "Below");
  await expect(co).toHaveAttribute("data-open", "false");
});
