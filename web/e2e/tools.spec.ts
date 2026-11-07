// Slice 4: the tools, on the real server with two editors and a viewer.

import { type Page, expect, test } from "@playwright/test";
import { gesture, joinNew, mapPoint, viewLink } from "./helpers";
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

test("draw, arrow, callout, erase, clear ink, undo and redo", async ({ browser }) => {
  const url = await newBoardUrl(server, "tools");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");

  // Draw in a palette colour.
  await a.keyboard.press("d");
  await expect(a.getByTestId("ink-palette")).toBeVisible();
  await a.getByRole("radio", { name: "Ink: Lime" }).click();
  await gesture(a, [[0.3, 0.3], [0.4, 0.35], [0.5, 0.3]]);
  await expect(strokes(b)).toHaveCount(1);
  await expect(strokes(b).locator("path.ink")).toHaveAttribute("stroke", "#c5e07a");

  // An arrow from a hero takes the hero's team.
  await a.keyboard.press("a");
  const tok = (await a.locator('.tok[data-slot="Amber-0"]').boundingBox())!;
  const to = await mapPoint(a, 0.45, 0.55);
  await a.mouse.move(tok.x + tok.width / 2, tok.y + tok.height / 2);
  await a.mouse.down();
  await a.mouse.move(to.x, to.y, { steps: 6 });
  await a.mouse.up();
  await expect(arrows(b)).toHaveCount(1);
  await expect(arrows(b).locator(".arw")).toHaveClass(/amber/);

  // A callout, typed in place.
  await a.keyboard.press("c");
  const at = await mapPoint(a, 0.55, 0.7);
  await a.mouse.click(at.x, at.y);
  await a.getByTestId("callout-input").fill("Smoke on the bridge");
  await a.keyboard.press("Enter");
  await expect(callouts(b).locator("text")).toHaveText("Smoke on the bridge");

  // Editing it shows the editor's name beside it for everyone else.
  await a.keyboard.press("v");
  await callouts(a).locator("text").dblclick();
  await expect(a.getByTestId("callout-input")).toBeVisible();
  await expect(callouts(b).locator('.p-tag[data-tag="Coach"]')).toContainText("Coach · editing");
  await a.getByTestId("callout-input").fill("Smoke the bridge first");
  await a.keyboard.press("Enter");
  await expect(callouts(b).locator("text").first()).toHaveText("Smoke the bridge first");
  await expect(callouts(b).locator(".p-tag")).toHaveCount(0);
  // Drag it with Move: B watches it go, tagged, and it lands where A drops it.
  const pin = (p: Page) => callouts(p).locator("circle.pin");
  const before = await pin(b).getAttribute("cx");
  const tb = (await callouts(a).locator("text").boundingBox())!;
  const dest = await mapPoint(a, 0.65, 0.85);
  await a.mouse.move(tb.x + 10, tb.y + tb.height / 2);
  await a.mouse.down();
  await a.mouse.move(dest.x, dest.y, { steps: 8 });
  await expect(callouts(b).locator('.p-tag[data-tag="Coach"]')).toContainText("Coach · moving");
  await a.mouse.up();
  await expect.poll(async () => Number(await pin(b).getAttribute("cx"))).toBeGreaterThan(Number(before) + 30);

  // Erase: one scrub over the ink and the arrow is one transaction, so one undo brings both back.
  await a.keyboard.press("e");
  const s = (await strokes(a).locator("path.ink").boundingBox())!;
  const ar = (await arrows(a).locator(".arw").boundingBox())!;
  await a.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await a.mouse.down();
  await a.mouse.move(ar.x + ar.width / 2, ar.y + ar.height / 2, { steps: 15 });
  await a.mouse.up();
  await expect(strokes(b)).toHaveCount(0);
  await expect(arrows(b)).toHaveCount(0);
  await expect(callouts(b)).toHaveCount(1);
  await a.keyboard.press("Control+z");
  await expect(strokes(b)).toHaveCount(1);
  await expect(arrows(b)).toHaveCount(1);
  await a.getByTestId("redo").click();
  await expect(strokes(b)).toHaveCount(0);
  await a.getByTestId("undo").click();
  await expect(strokes(b)).toHaveCount(1);

  // Clear ink: every stroke on the scene in one step, with Undo in its toast. Arrows stay.
  await a.keyboard.press("d");
  await gesture(a, [[0.6, 0.2], [0.7, 0.25]]);
  await expect(strokes(b)).toHaveCount(2);
  await a.getByTestId("clear-ink").click();
  await expect(strokes(b)).toHaveCount(0);
  await expect(arrows(b)).toHaveCount(1);
  await a.getByTestId("toast").getByRole("button", { name: "Undo" }).click();
  await expect(strokes(b)).toHaveCount(2);

  // Undo is per person: B's undo doesn't touch A's work.
  await expect(b.getByTestId("undo")).toBeDisabled();

  await b.reload();
  await expect(strokes(b)).toHaveCount(2);
  await expect(arrows(b)).toHaveCount(1);
  await expect(callouts(b)).toHaveCount(1);
  await a.screenshot({ path: "shots/slice4-tools.png" });
});

test("objectives cycle on click; a viewer gets Look and Laser, and its laser reaches editors", async ({ browser }) => {
  const url = await newBoardUrl(server, "objectives");
  const a = await joinNew(browser, url, "Coach");
  const v = await joinNew(browser, await viewLink(server.url, url), "Guest");
  const key = "walker:amber:lane1:1";
  const mk = (p: Page) => p.locator(`.mapbox .mk[data-key="${key}"]`);
  const box = (await mk(a).boundingBox())!;
  const click = () => a.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await click();
  await expect(mk(v)).toHaveAttribute("data-status", "Destroyed");
  await click();
  // Hidden: gone for the viewer, a ghost for the editor so it can be brought back.
  await expect(mk(v)).toHaveCount(0);
  await expect(mk(a)).toHaveClass(/gone/);
  await click();
  await expect(mk(v)).toHaveAttribute("data-status", "Active");

  // The viewer's picker: Look and Laser only.
  await expect(v.getByTestId("toolbar").locator(".tb")).toHaveCount(2);
  await expect(v.getByTestId("tool-move")).toContainText("Look");
  await v.keyboard.press("l");
  const p0 = await mapPoint(v, 0.3, 0.5);
  const p1 = await mapPoint(v, 0.6, 0.65); // diagonal: a flat line has a zero-height box, which Playwright calls hidden
  await v.mouse.move(p0.x, p0.y);
  await v.mouse.down();
  await v.mouse.move(p1.x, p1.y, { steps: 10 });
  await expect(a.locator('.laser[data-laser="Guest"] path').first()).toBeVisible();
  await v.mouse.up();
  // It fades on its own and was never saved.
  await expect(a.locator('.laser[data-laser="Guest"]')).toHaveCount(0, { timeout: 4000 });
  await a.reload();
  await expect(a.locator(".laser")).toHaveCount(0);
  await expect(a.locator(".mapbox [data-stroke]")).toHaveCount(0);
});
