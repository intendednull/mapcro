// Slice 4: the tools, on the real server with two editors and a viewer.

import { type Page, expect, test } from "@playwright/test";
import { gesture, joinNew, mapPoint, viewLink } from "./helpers";
import { Server, newBoardUrl, translate } from "./server";

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

  // A comment, typed in place: a bubble once placed.
  await a.keyboard.press("c");
  const at = await mapPoint(a, 0.55, 0.7);
  await a.mouse.click(at.x, at.y);
  await a.getByTestId("comment-input").fill("Smoke on the bridge");
  await a.keyboard.press("Enter");
  await expect(callouts(b).locator("text")).toHaveText("Smoke on the bridge");
  await expect(callouts(b)).toHaveAttribute("data-open", "false");

  // Open it, then edit it with a double click: the others see the editor's name on it.
  await a.keyboard.press("v");
  await callouts(a).locator(".bubble-body").click();
  await expect(callouts(a)).toHaveAttribute("data-open", "true");
  await callouts(a).locator("text").dblclick();
  await expect(a.getByTestId("comment-input")).toBeVisible();
  await expect(callouts(b).locator('.p-tag[data-tag="Coach"]')).toContainText("Coach");
  await a.getByTestId("comment-input").fill("Smoke the bridge first");
  await a.keyboard.press("Enter");
  await expect(callouts(b).locator("text").first()).toHaveText("Smoke the bridge first");
  await expect(callouts(b).locator(".p-tag")).toHaveCount(0);
  // Drag the bubble with Move: B watches it go, tagged, and it lands where A drops it.
  const spot = async (p: Page) => translate(await callouts(p).locator("g[transform]").first().getAttribute("transform"));
  const before = await spot(b);
  const bb = (await callouts(a).locator(".bubble-body").boundingBox())!;
  const dest = await mapPoint(a, 0.65, 0.85);
  await a.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await a.mouse.down();
  await a.mouse.move(dest.x, dest.y, { steps: 8 });
  await expect(callouts(b).locator('.p-tag[data-tag="Coach"]')).toContainText("Coach · moving");
  await a.mouse.up();
  await expect.poll(async () => (await spot(b)).x).toBeGreaterThan(before.x + 30);

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

test("objectives toggle on click (camps, mid boss, one rift at a time); a viewer gets Look and Laser, and its laser reaches editors", async ({ browser }) => {
  const url = await newBoardUrl(server, "objectives");
  const a = await joinNew(browser, url, "Coach");
  const v = await joinNew(browser, await viewLink(server.url, url), "Guest");
  const key = "walker:amber:lane1:1";
  const mk = (p: Page) => p.locator(`.mapbox .mk[data-key="${key}"]`);
  const box = (await mk(a).boundingBox())!;
  const click = () => a.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await click();
  await expect(mk(a)).toHaveAttribute("data-status", "Destroyed");
  await expect(mk(v)).toHaveAttribute("data-status", "Destroyed");
  // Two states only: a second click brings it back (no hidden step).
  await click();
  await expect(mk(a), "the clicking browser").toHaveAttribute("data-status", "Active");
  await expect(mk(v), "the viewer").toHaveAttribute("data-status", "Active");

  // The mid boss, camps and powerups toggle the same way; the fallback has both powerup sites.
  await expect(a.locator(".mapbox .mk.powerup")).toHaveCount(2);
  for (const k of ["mid_boss:neutral:lane0:1", "camp:neutral:lane0:5", "powerup:neutral:lane1:1"]) {
    const m = a.locator(`.mapbox .mk[data-key="${k}"]`);
    const bb = (await m.boundingBox())!;
    await a.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await expect(v.locator(`.mapbox .mk[data-key="${k}"]`)).toHaveAttribute("data-status", "Destroyed");
  }

  // Rifts start off; at most one is on, and turning one on turns the other off.
  const rift = (p: Page, k: string) => p.locator(`.mapbox .mk[data-key="${k}"]`);
  const [west, east] = ["rift:neutral:lane1:1", "rift:neutral:lane6:1"];
  const tap = async (k: string) => {
    const bb = (await rift(a, k).boundingBox())!;
    await a.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  };
  for (const k of [west, east]) await expect(rift(v, k)).toHaveAttribute("data-status", "Destroyed");
  await tap(west);
  await expect(rift(v, west)).toHaveAttribute("data-status", "Active");
  await tap(east);
  await expect(rift(v, east)).toHaveAttribute("data-status", "Active");
  await expect(rift(v, west)).toHaveAttribute("data-status", "Destroyed");
  await tap(east); // both can be off
  await expect(rift(v, east)).toHaveAttribute("data-status", "Destroyed");
  await expect(rift(v, west)).toHaveAttribute("data-status", "Destroyed");
  // The viewer's picker: Look and Laser only.
  await expect(v.getByTestId("toolbar").locator('[data-testid^="tool-"]')).toHaveCount(2);
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
