// A placed comment, arrow or stroke after it was placed (feedback #59, #60): a right click
// (no drag) opens its menu, with a comment's side (Above, Below, Left, Right) and a colour for
// any of the three. One write each, seen by a second browser, undone by one undo, kept on
// reload. A long scene name (feedback #56) fits the stage head and the scene list.

import { type Locator, type Page, expect, test } from "./fixtures";
import { gesture, joinNew, mapPoint, viewLink } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const ROSE = "rgb(240, 143, 176)";
const ICE = "rgb(127, 224, 232)";
const LIME = "rgb(197, 224, 122)";
const css = (l: Locator, prop: "stroke" | "fill") => l.evaluate((el, prop) => getComputedStyle(el)[prop], prop);
const ids = (p: Page, attr: string) => p.locator(`.mapbox [${attr}]`).evaluateAll((els, attr) => els.map((e) => e.getAttribute(attr)!), attr);
const menu = (p: Page) => p.getByTestId("placed-menu");
const comment = (p: Page) => p.locator(".mapbox [data-callout]");
/** The centre of an element's box, in page pixels. */
const centre = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** The comment's spot: its pin's centre, opened and closed again. */
async function spotOf(p: Page) {
  await comment(p).locator(".bubble-body").click();
  const at = await centre(comment(p).locator(".pin"));
  await p.keyboard.press("Escape");
  await expect(comment(p)).toHaveAttribute("data-open", "false");
  return at;
}

/** A comment, an arrow and a stroke, in the palette's first colour, apart from the heroes. */
async function placeAll(a: Page) {
  // In Parchment, which no recolour below picks (a person's first colour is their own).
  await a.getByTestId("palette").click();
  await a.getByRole("radio", { name: "Colour: Parchment" }).click();
  await a.keyboard.press("s");
  const at = await mapPoint(a, 0.5, 0.45);
  await a.mouse.click(at.x, at.y);
  await a.getByTestId("comment-input").fill("Smoke the bridge");
  await a.keyboard.press("Enter");
  await a.keyboard.press("a");
  await gesture(a, [[0.3, 0.7], [0.45, 0.78]]);
  await a.keyboard.press("e");
  await gesture(a, [[0.55, 0.7], [0.7, 0.74]]);
  await a.keyboard.press("q");
  await expect.poll(async () => [(await ids(a, "data-callout")).length, (await ids(a, "data-arrow")).length, (await ids(a, "data-stroke")).length]).toEqual([1, 1, 1]);
  await a.mouse.move(5, 5);
  return { arrow: (await ids(a, "data-arrow"))[0]!, stroke: (await ids(a, "data-stroke"))[0]! };
}

test("a comment's side and a placed thing's colour, from its right-click menu, for everyone", async ({ browser }) => {
  const url = await newBoardUrl(server, "placed");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const { arrow, stroke } = await placeAll(a);
  await expect(comment(a)).not.toHaveAttribute("data-side");

  // The comment's menu: its four sides, Above marked, then the palette.
  await comment(a).locator(".bubble-body").click({ button: "right" });
  await expect(menu(a)).toBeVisible();
  await expect(menu(a)).toHaveAttribute("aria-label", "Comment");
  await expect(menu(a).getByRole("menuitemradio")).toHaveCount(4 + 7 + 1);
  await expect(menu(a).getByRole("menuitemradio").first()).toBeFocused();
  for (const [side, on] of [["above", "true"], ["below", "false"], ["left", "false"], ["right", "false"]]) await expect(menu(a).getByTestId(`comment-side-${side}`)).toHaveAttribute("aria-checked", on!);
  // The comment's colour (the placer's palette colour) is marked, and only it.
  await expect(menu(a).locator('.ctx-swatch[aria-checked="true"]')).toHaveCount(1);
  await expect(menu(a).getByTestId("recolour-0")).toHaveAttribute("aria-checked", "true");
  // The sides a list, the colours one row of swatches after them.
  await expect(menu(a).locator(".ctx-swatches .ctx-swatch")).toHaveCount(7);
  await expect(menu(a).locator(".ctx-swatches [data-testid^='comment-side-']")).toHaveCount(0);
  // Left: the bubble's tail on the spot, its body to the left of it, for both. (Centres: a box
  // takes in the tail's pointed stroke, which runs past the spot.)
  const spot = await centre(comment(a).locator(".bubble-body"));
  await menu(a).getByTestId("comment-side-left").click();
  await expect(menu(a)).toHaveCount(0);
  for (const p of [a, b]) await expect(comment(p)).toHaveAttribute("data-side", "Left");
  const left = await centre(comment(b).locator(".bubble-body"));
  expect(left.x).toBeLessThan(spot.x - 10);
  expect(Math.abs(left.y - (await spotOf(b)).y)).toBeLessThan(3);
  // Opened, its card is on the left of the pin too.
  await comment(b).locator(".bubble-body").click();
  await expect(comment(b)).toHaveAttribute("data-open", "true");
  const pin = await centre(comment(b).locator(".pin"));
  const card = (await comment(b).locator(".card-bg").boundingBox())!;
  expect(card.x + card.width).toBeLessThan(pin.x);
  expect(Math.abs(card.y + card.height / 2 - pin.y)).toBeLessThan(3);
  await b.keyboard.press("Escape");
  await expect(comment(b)).toHaveAttribute("data-open", "false");

  // Recolour the comment, the arrow and the stroke: one write each, seen by B.
  await comment(a).locator(".bubble-body").click({ button: "right" });
  await expect(menu(a).getByTestId("comment-side-left")).toHaveAttribute("aria-checked", "true");
  await menu(a).getByTestId("recolour-3").click();
  for (const p of [a, b]) await p.mouse.move(5, 5); // a hovered bubble lightens
  for (const p of [a, b]) await expect.poll(() => css(comment(p).locator(".bubble-body"), "fill")).toBe(LIME);
  await a.locator(`.mapbox [data-arrow="${arrow}"] .arw`).click({ button: "right" });
  await expect(menu(a)).toHaveAttribute("aria-label", "Arrow");
  await expect(menu(a).getByRole("menuitemradio")).toHaveCount(7 + 1);
  await menu(a).getByRole("menuitemradio", { name: "Ice" }).click();
  for (const p of [a, b]) {
    await expect.poll(() => css(p.locator(`.mapbox [data-arrow="${arrow}"] .arw`), "stroke")).toBe(ICE);
    await expect.poll(() => css(p.locator(`.mapbox [data-arrow="${arrow}"] .head`), "fill")).toBe(ICE);
  }
  await a.locator(`.mapbox [data-stroke="${stroke}"] path.ink`).click({ button: "right" });
  await expect(menu(a)).toHaveAttribute("aria-label", "Drawing");
  // By keyboard: Rose is the second swatch.
  await a.keyboard.press("ArrowDown");
  await expect(menu(a).getByTestId("recolour-1")).toBeFocused();
  await a.keyboard.press("Enter");
  for (const p of [a, b]) await expect.poll(() => css(p.locator(`.mapbox [data-stroke="${stroke}"] path.ink`), "stroke")).toBe(ROSE);
  // A right-drag still pans, and opens no menu.
  const from = await centre(a.locator(`.mapbox [data-stroke="${stroke}"] path.ink`));
  await a.mouse.move(from.x, from.y);
  await a.mouse.down({ button: "right" });
  await a.mouse.move(from.x + 60, from.y + 30, { steps: 6 });
  await a.mouse.up({ button: "right" });
  await expect(menu(a)).toHaveCount(0);
  await expect(a.getByTestId("dismiss-rejection")).toHaveCount(0);

  // One undo, one step back: the stroke's colour, then the arrow's.
  await a.keyboard.press("Control+z");
  await expect.poll(() => css(b.locator(`.mapbox [data-stroke="${stroke}"] path.ink`), "stroke")).not.toBe(ROSE);
  await expect.poll(() => css(b.locator(`.mapbox [data-arrow="${arrow}"] .arw`), "stroke")).toBe(ICE);
  await a.keyboard.press("Control+Shift+z");
  await expect.poll(() => css(b.locator(`.mapbox [data-stroke="${stroke}"] path.ink`), "stroke")).toBe(ROSE);
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  // Kept: B reloads and sees the side and the three colours.
  await b.reload();
  await expect(comment(b)).toHaveAttribute("data-side", "Left");
  await expect.poll(() => css(comment(b).locator(".bubble-body"), "fill")).toBe(LIME);
  await expect.poll(() => css(b.locator(`.mapbox [data-arrow="${arrow}"] .arw`), "stroke")).toBe(ICE);
  await expect.poll(() => css(b.locator(`.mapbox [data-stroke="${stroke}"] path.ink`), "stroke")).toBe(ROSE);

  // Escape closes the menu and changes nothing.
  await comment(a).locator(".bubble-body").click({ button: "right" });
  await a.keyboard.press("Escape");
  await expect(menu(a)).toHaveCount(0);
  await expect(comment(b)).toHaveAttribute("data-side", "Left");
});

test("No colour: a recoloured comment and arrow go back to none, for everyone, and one undo puts the colour back; a drawing has none", async ({ browser }) => {
  const url = await newBoardUrl(server, "no colour");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const { arrow, stroke } = await placeAll(a);
  const arw = (p: Page) => p.locator(`.mapbox [data-arrow="${arrow}"] .arw`);
  // The comment: coloured (the placer's colour), then No colour, after the swatches.
  await comment(a).locator(".bubble-body").click({ button: "right" });
  await expect(menu(a).getByTestId("recolour-none")).toHaveAttribute("aria-checked", "false");
  await expect(menu(a).locator(".ctx-swatches [data-testid='recolour-none']")).toHaveCount(0);
  await expect(menu(a).getByTestId("recolour-none")).toHaveText("No colour");
  await menu(a).getByTestId("recolour-none").click();
  for (const p of [a, b]) await expect(comment(p)).not.toHaveClass(/tinted/);
  await comment(a).locator(".bubble-body").click({ button: "right" });
  await expect(menu(a).getByTestId("recolour-none")).toHaveAttribute("aria-checked", "true");
  await expect(menu(a).locator('[aria-checked="true"]')).toHaveCount(2); // Above, and No colour
  await a.keyboard.press("Escape");
  // The arrow: Ice, then No colour: drawn as before colours (no colour of its own).
  await arw(a).click({ button: "right" });
  await menu(a).getByTestId("recolour-4").click();
  for (const p of [a, b]) await expect.poll(() => css(arw(p), "stroke")).toBe(ICE);
  await arw(a).click({ button: "right" });
  await menu(a).getByTestId("recolour-none").click();
  for (const p of [a, b]) {
    await expect.poll(() => css(arw(p), "stroke")).not.toBe(ICE);
    await expect(arw(p)).not.toHaveAttribute("style", /stroke/);
  }
  await expect(a.getByTestId("dismiss-rejection")).toHaveCount(0);
  // One undo: Ice again, for both; redo: none again.
  await a.keyboard.press("Control+z");
  for (const p of [a, b]) await expect.poll(() => css(arw(p), "stroke")).toBe(ICE);
  await a.keyboard.press("Control+Shift+z");
  for (const p of [a, b]) await expect(arw(p)).not.toHaveAttribute("style", /stroke/);
  // A drawing's ink always has a colour: no No colour.
  await a.locator(`.mapbox [data-stroke="${stroke}"] path.ink`).click({ button: "right" });
  await expect(menu(a)).toHaveAttribute("aria-label", "Drawing");
  await expect(menu(a).getByTestId("recolour-none")).toHaveCount(0);
  await expect(menu(a).getByRole("menuitemradio")).toHaveCount(7);
  await a.keyboard.press("Escape");
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  // Kept: B reloads and sees both without colour.
  await b.reload();
  await expect(comment(b)).not.toHaveClass(/tinted/);
  await expect(arw(b)).not.toHaveAttribute("style", /stroke/);
});

test("each side places the bubble and the card on that side of the spot; a viewer gets no menu", async ({ browser }) => {
  const url = await newBoardUrl(server, "sides");
  const a = await joinNew(browser, url, "Coach");
  await placeAll(a);
  const tip = await spotOf(a);
  for (const side of ["Below", "Right", "Above"] as const) {
    await comment(a).locator(".bubble-body").click({ button: "right" });
    await menu(a).getByTestId(`comment-side-${side.toLowerCase()}`).click();
    if (side === "Above") await expect(comment(a)).not.toHaveAttribute("data-side");
    else await expect(comment(a)).toHaveAttribute("data-side", side);
    await a.mouse.move(5, 5);
    const body = await centre(comment(a).locator(".bubble-body"));
    if (side === "Below") expect(body.y).toBeGreaterThan(tip.y + 10);
    if (side === "Right") expect(body.x).toBeGreaterThan(tip.x + 10);
    if (side === "Above") expect(body.y).toBeLessThan(tip.y - 10);
    await comment(a).locator(".bubble-body").click();
    const card = (await comment(a).locator(".card-bg").boundingBox())!;
    if (side === "Below") expect(card.y).toBeGreaterThan(tip.y);
    if (side === "Right") expect(card.x).toBeGreaterThan(tip.x);
    if (side === "Above") expect(card.y + card.height).toBeLessThan(tip.y);
    await a.keyboard.press("Escape");
    await expect(comment(a)).toHaveAttribute("data-open", "false");
  }
  // Back above, the comment is stored with no side, and drawn as before.
  await expect(comment(a)).not.toHaveAttribute("data-side");
  // A viewer: a right click opens nothing.
  const v = await joinNew(browser, await viewLink(server.url, url), "Guest");
  await comment(v).locator(".bubble-body").click({ button: "right" });
  await expect(menu(v)).toHaveCount(0);
});

test("a scene name takes 48 characters and fits the stage head and the scene list", async ({ browser }) => {
  const url = await newBoardUrl(server, "long names");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  // Wide letters, so the name is wider than the head and must be cut.
  const name = "WMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWMWM";
  await a.getByTestId("scene-name").click();
  await a.getByTestId("scene-name-input").fill("");
  await a.getByTestId("scene-name-input").pressSequentially(name);
  await expect(a.getByTestId("scene-name-input")).toHaveValue(name.slice(0, 48));
  await a.keyboard.press("Enter");
  await expect(b.getByTestId("scene-name")).toHaveText(name.slice(0, 48));
  await expect(a.getByTestId("dismiss-rejection")).toHaveCount(0);
  for (const p of [a, b]) {
    // Nothing runs off the page sideways; the head and the row cut the name with an ellipsis.
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const fits = await p.evaluate(() => {
      const head = document.querySelector(".stage-head")!.getBoundingClientRect();
      const title = document.querySelector(".stage-head h1")!;
      // Cut where it ends, with an ellipsis, not drawn on past it.
      const cut = getComputedStyle(title);
      return title.getBoundingClientRect().right <= head.right + 1 && title.scrollWidth > title.clientWidth && cut.overflowX === "hidden" && cut.textOverflow === "ellipsis";
    });
    expect(fits).toBe(true);
  }
});
