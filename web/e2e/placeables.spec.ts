// Placed things (ink, arrows, comments): hover + E deletes in any tool, Move drags each of them
// with a live preview for the others, Clear clears one kind or all, and the notes margin round
// the map takes them too.

import { type Page, expect, test } from "./fixtures";
import { gesture, joinNew, mapPoint } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const strokes = (p: Page) => p.locator(".mapbox [data-stroke]");
const arrows = (p: Page) => p.locator(".mapbox [data-arrow]");
const callouts = (p: Page) => p.locator(".mapbox [data-callout]");
const centre = async (l: ReturnType<Page["locator"]>) => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** The numbers in an SVG path's `d`. */
const nums = async (l: ReturnType<Page["locator"]>) => (await l.getAttribute("d"))!.split(/[^-\d.]+/).filter(Boolean).map(Number);

async function place(a: Page) {
  await a.keyboard.press("d");
  await gesture(a, [[0.3, 0.3], [0.42, 0.3]]);
  await a.keyboard.press("a");
  await gesture(a, [[0.55, 0.55], [0.7, 0.62]]);
  await a.keyboard.press("c");
  const at = await mapPoint(a, 0.62, 0.78);
  await a.mouse.click(at.x, at.y);
  await a.getByTestId("comment-input").fill("Ward here");
  await a.keyboard.press("Enter");
}

test("hover + E deletes what's under the pointer in any tool, in one undoable step", async ({ browser }) => {
  const url = await newBoardUrl(server, "hover delete");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await place(a);
  await expect(strokes(b)).toHaveCount(1);
  await expect(arrows(b)).toHaveCount(1);
  await expect(callouts(b)).toHaveCount(1);

  // In Move: the arrow goes; the tool stays.
  await a.keyboard.press("v");
  const arrow = await centre(arrows(a).locator(".arw"));
  await a.mouse.move(arrow.x, arrow.y);
  await a.keyboard.press("e");
  await expect(arrows(b)).toHaveCount(0);
  await expect(a.getByTestId("tool-move")).toHaveAttribute("aria-pressed", "true");
  await a.keyboard.press("Control+z");
  await expect(arrows(b)).toHaveCount(1);

  // In Draw: the stroke.
  await a.keyboard.press("d");
  const ink = await centre(strokes(a).locator("path.ink"));
  await a.mouse.move(ink.x, ink.y);
  await a.keyboard.press("e");
  await expect(strokes(b)).toHaveCount(0);
  await expect(a.getByTestId("tool-draw")).toHaveAttribute("aria-pressed", "true");

  // In Arrow: the comment.
  await a.keyboard.press("a");
  const co = await centre(callouts(a).locator(".bubble-body"));
  await a.mouse.move(co.x, co.y);
  await a.keyboard.press("e");
  await expect(callouts(b)).toHaveCount(0);

  // Over empty map, E is still the Erase tool.
  const empty = await mapPoint(a, 0.2, 0.75);
  await a.mouse.move(empty.x, empty.y);
  await a.keyboard.press("e");
  await expect(a.getByTestId("tool-erase")).toHaveAttribute("aria-pressed", "true");
  await expect(arrows(b)).toHaveCount(1);
});

test("Move drags an arrow whole or by one end, and a stroke whole; the others watch it move", async ({ browser }) => {
  const url = await newBoardUrl(server, "move placed");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await place(a);
  await expect(arrows(b)).toHaveCount(1);
  await a.keyboard.press("v");

  // The arrow by its body: both ends move by the same amount.
  const before = await nums(arrows(b).locator(".hit"));
  const grab = await centre(arrows(a).locator(".arw"));
  await a.mouse.move(grab.x, grab.y);
  await a.mouse.down();
  await a.mouse.move(grab.x - 60, grab.y - 40, { steps: 8 });
  await expect(arrows(b).locator('.p-tag[data-tag="Coach"]')).toContainText("moving");
  await expect.poll(async () => (await nums(arrows(b).locator(".hit")))[0]).toBeLessThan(before[0]! - 20);
  await a.mouse.up();
  await expect(arrows(b).locator(".p-tag")).toHaveCount(0);
  const whole = await nums(arrows(b).locator(".hit"));
  const d = [whole[0]! - before[0]!, whole[1]! - before[1]!];
  expect(d[0]).toBeLessThan(-20);
  expect(whole[2]! - before[2]!).toBeCloseTo(d[0]!, 0);
  expect(whole[3]! - before[3]!).toBeCloseTo(d[1]!, 0);

  // By its tip: only that end moves.
  await a.mouse.move(grab.x - 60, grab.y - 40); // hover shows the ends
  const tip = await centre(arrows(a).locator('[data-arrow-end="To"]'));
  await a.mouse.move(tip.x, tip.y);
  await a.mouse.down();
  await a.mouse.move(tip.x + 50, tip.y + 50, { steps: 6 });
  await a.mouse.up();
  await expect.poll(async () => (await nums(arrows(b).locator(".hit")))[2]).toBeGreaterThan(whole[2]! + 20);
  const tipped = await nums(arrows(b).locator(".hit"));
  expect(tipped[0]).toBeCloseTo(whole[0]!, 0);
  expect(tipped[1]).toBeCloseTo(whole[1]!, 0);

  // The stroke, whole; one undo puts it back.
  const s0 = await nums(strokes(b).locator("path.ink"));
  const s = await centre(strokes(a).locator("path.ink"));
  await a.mouse.move(s.x, s.y);
  await a.mouse.down();
  await a.mouse.move(s.x + 40, s.y + 70, { steps: 8 });
  await expect(strokes(b).locator('.p-tag[data-tag="Coach"]')).toContainText("moving");
  await a.mouse.up();
  await expect.poll(async () => (await nums(strokes(b).locator("path.ink")))[1]).toBeGreaterThan(s0[1]! + 30);
  await expect(strokes(b)).toHaveCount(1);
  await a.keyboard.press("Control+z");
  await expect.poll(async () => (await nums(strokes(b).locator("path.ink")))[1]).toBeCloseTo(s0[1]!, 0);
  await expect(strokes(b)).toHaveCount(1);
  await a.screenshot({ path: "shots/placeables-moved.png" });
});

test("Clear is a menu: ink, arrows, comments or all, each one step with Undo", async ({ browser }) => {
  const url = await newBoardUrl(server, "clear menu");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await place(a);
  await expect(callouts(b)).toHaveCount(1);
  await a.getByTestId("clear-menu").click();
  await expect(a.getByTestId("clear-pop")).toBeVisible();
  await a.getByTestId("clear-pop").screenshot({ path: "shots/clear-menu.png" });
  await a.getByTestId("clear-arrows").click();
  await expect(arrows(b)).toHaveCount(0);
  await expect(strokes(b)).toHaveCount(1);
  await expect(callouts(b)).toHaveCount(1);
  await expect(a.getByTestId("toast")).toContainText("Arrows cleared");
  await a.getByTestId("toast").getByRole("button", { name: "Undo" }).click();
  await expect(arrows(b)).toHaveCount(1);

  await a.getByTestId("clear-menu").click();
  await a.getByTestId("clear-comments").click();
  await expect(callouts(b)).toHaveCount(0);
  await expect(arrows(b)).toHaveCount(1);
  await a.getByTestId("toast").getByRole("button", { name: "Undo" }).click();
  await expect(callouts(b)).toHaveCount(1);

  await a.getByTestId("clear-menu").click();
  await a.getByTestId("clear-all").click();
  for (const l of [strokes(b), arrows(b), callouts(b)]) await expect(l).toHaveCount(0);
  await expect(a.getByTestId("clear-menu")).toBeDisabled();
  await a.getByTestId("toast").getByRole("button", { name: "Undo" }).click();
  for (const l of [strokes(b), arrows(b), callouts(b)]) await expect(l).toHaveCount(1);
});

test("the notes margin: zoom out past the map, draw and comment there; it stays inside the board", async ({ browser }) => {
  const url = await newBoardUrl(server, "margin");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const map = a.getByTestId("map");
  const zoomOut = async (p: Page) => {
    const c = await mapPoint(p, 0.5, 0.5);
    await p.mouse.move(c.x, c.y);
    for (let i = 0; i < 4; i++) await p.mouse.wheel(0, 300);
    await expect(p.getByTestId("map")).toHaveAttribute("data-view", "-250 -250 1500");
    await expect(p.locator("[data-testid=map] .mm-host")).toHaveClass(/free/);
  };
  await zoomOut(a);
  await zoomOut(b);
  // Draw in the left margin and comment in the top one (map fractions past 0..1).
  await a.keyboard.press("d");
  await gesture(a, [[-0.2, 0.35], [-0.1, 0.55]]);
  await a.keyboard.press("c");
  const at = await mapPoint(a, 0.5, -0.12);
  await a.mouse.click(at.x, at.y);
  await a.getByTestId("comment-input").fill("Rotate after boss");
  await a.keyboard.press("Enter");
  await expect(strokes(b)).toHaveCount(1);
  await expect(callouts(b)).toHaveCount(1);
  // Outside the map, inside the board's box.
  const terrain = (await b.locator("[data-testid=map] .mm-rot").boundingBox())!;
  const box = (await b.getByTestId("map").boundingBox())!;
  const ink = (await strokes(b).locator("path.ink").boundingBox())!;
  expect(ink.x + ink.width).toBeLessThan(terrain.x);
  expect(ink.x).toBeGreaterThan(box.x);
  const co = (await callouts(b).locator(".bubble-body").boundingBox())!;
  expect(co.y + co.height).toBeLessThan(terrain.y + 2);
  await map.screenshot({ path: "shots/notes-margin.png" });

  // Back at fit the margin is out of view, and nothing spills over the top bar.
  await b.reload();
  await expect(strokes(b)).toHaveCount(1);
  await expect(b.getByTestId("map")).toHaveAttribute("data-view", "36 36 928"); // the default view
  const top = (await b.getByTestId("map").boundingBox())!;
  const hit = await b.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("[data-testid=map]") === null, [top.x + top.width / 2, top.y - 6]);
  expect(hit).toBe(true);
  // Panning at fit reaches the margin too.
  await b.mouse.move(top.x + top.width / 2, top.y + top.height / 2);
  await b.mouse.down({ button: "right" });
  await b.mouse.move(top.x + top.width / 2 + 120, top.y + top.height / 2, { steps: 4 });
  await b.mouse.up({ button: "right" });
  await expect.poll(async () => Number((await b.getByTestId("map").getAttribute("data-view"))!.split(" ")[0])).toBeLessThan(-50);
  await expect(strokes(b).locator("path.ink")).toBeInViewport();
});
