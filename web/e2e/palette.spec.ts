// The colour palette (operator, 2026-11-07): its own control, used by Draw, Arrow, Comment and
// Laser, remembered per person per board, on the phone too. Each kind in two colours, as drawn
// for the person making it and for a second browser.

import { type Locator, type Page, expect, test } from "./fixtures";
import { gesture, joinNew, mapPoint } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const COLOURS = [
  { name: "Rose", rgb: "rgb(240, 143, 176)" },
  { name: "Ice", rgb: "rgb(127, 224, 232)" },
];
const css = (l: Locator, prop: "stroke" | "fill") => l.evaluate((el, prop) => getComputedStyle(el)[prop], prop);
const ids = (p: Page, attr: string) => p.locator(`.mapbox [${attr}]`).evaluateAll((els, attr) => els.map((e) => e.getAttribute(attr)!), attr);
/** The id of the one record of this kind made since `before`. */
async function made(p: Page, attr: string, before: string[]) {
  await expect.poll(async () => (await ids(p, attr)).filter((x) => !before.includes(x)).length).toBe(1);
  return (await ids(p, attr)).find((x) => !before.includes(x))!;
}
async function pick(p: Page, name: string) {
  await p.getByTestId("palette").click();
  await p.getByRole("radio", { name: `Colour: ${name}` }).click();
  await expect(p.getByTestId("palette")).toHaveAttribute("aria-label", `Colour: ${name}`);
}

test("Draw, Arrow, Comment and Laser use the palette colour, for you and for others", async ({ browser }) => {
  const url = await newBoardUrl(server, "palette");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  for (const [i, c] of COLOURS.entries()) {
    await pick(a, c.name);
    const y = 0.2 + i * 0.35;

    // Draw.
    await a.keyboard.press("d");
    const s0 = await ids(a, "data-stroke");
    await gesture(a, [[0.2, y], [0.35, y + 0.05]]);
    const sid = await made(a, "data-stroke", s0);
    for (const p of [a, b]) await expect.poll(() => css(p.locator(`.mapbox [data-stroke="${sid}"] path.ink`), "stroke")).toBe(c.rgb);

    // Arrow (away from heroes: its team would come from one).
    await a.keyboard.press("a");
    const a0 = await ids(a, "data-arrow");
    await gesture(a, [[0.45, y], [0.6, y + 0.08]]);
    const aid = await made(a, "data-arrow", a0);
    for (const p of [a, b]) {
      await expect.poll(() => css(p.locator(`.mapbox [data-arrow="${aid}"] .arw`), "stroke")).toBe(c.rgb);
      await expect.poll(() => css(p.locator(`.mapbox [data-arrow="${aid}"] .head`), "fill")).toBe(c.rgb);
    }

    // Comment: the bubble collapsed, and the card open.
    await a.keyboard.press("c");
    const at = await mapPoint(a, 0.75, y);
    await a.mouse.click(at.x, at.y);
    await a.getByTestId("comment-input").fill(`${c.name} comment`);
    await a.keyboard.press("Enter");
    await a.mouse.move(5, 5); // a hovered bubble lightens
    const co = (p: Page) => p.locator(".mapbox [data-callout]").filter({ hasText: `${c.name} comment` });
    for (const p of [a, b]) await expect.poll(() => css(co(p).locator(".bubble-body"), "fill")).toBe(c.rgb);
    await a.keyboard.press("v");
    await co(b).locator(".bubble-body").click();
    await expect(co(b)).toHaveAttribute("data-open", "true");
    await expect.poll(() => css(co(b).locator(".card-bg"), "fill")).toBe(c.rgb);
    // Readable: the card's text is the dark ink on these light colours.
    await expect.poll(() => css(co(b).locator("text").first(), "fill")).toBe("rgb(20, 16, 12)");
    await b.screenshot({ path: `shots/palette-comment-${c.name}-peer.png` });
    await b.mouse.click(5, 5);

    // Laser: held and moving, seen by B in the same colour.
    await a.keyboard.press("l");
    const l0 = await mapPoint(a, 0.3, 0.55 + i * 0.1);
    await a.mouse.move(l0.x, l0.y);
    await a.mouse.down();
    await a.mouse.move(l0.x + 120, l0.y + 20, { steps: 12 });
    await expect.poll(() => css(a.locator('.mapbox .laser[data-laser="mine"] path').first(), "stroke")).toBe(c.rgb);
    await expect.poll(() => css(b.locator('.mapbox .laser[data-laser="Coach"] path').first(), "stroke")).toBe(c.rgb);
    await a.screenshot({ path: `shots/palette-${c.name}-local.png` });
    await b.screenshot({ path: `shots/palette-${c.name}-peer.png` });
    await a.mouse.up();
    await a.keyboard.press("v");
  }
  // Remembered for this board.
  await a.reload();
  await expect(a.getByTestId("palette")).toHaveAttribute("aria-label", "Colour: Ice");
});

test("the phone has the palette too, for its laser", async ({ browser }) => {
  const url = await newBoardUrl(server, "phone palette");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.locator("#join-name").fill("Fan");
  await phone.keyboard.press("Enter");
  await pick(phone, "Ice");
  await phone.screenshot({ path: "shots/palette-phone.png" });
});
