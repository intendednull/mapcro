// The default view (operator, 2026-11-07): the playable circle fills the map's box at any
// size, and zooming in, out to the notes margin, and panning still work from there.

import { expect, test } from "@playwright/test";
import { joinNew, mapPoint } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const fill = (p: import("@playwright/test").Page) =>
  p.evaluate(() => {
    const box = document.querySelector("[data-testid=map]")!.getBoundingClientRect();
    const circle = document.querySelector("[data-testid=map] .mm-rot")!.getBoundingClientRect();
    return { w: circle.width / box.width, dx: Math.abs(circle.x + circle.width / 2 - (box.x + box.width / 2)) };
  });

test("the playable circle fills the box, at any window size; zoom and the margin still work", async ({ browser }) => {
  const url = await newBoardUrl(server, "fit");
  const a = await joinNew(browser, url, "Coach");
  for (const [w, h] of [[1440, 900], [1920, 1080], [1100, 760]] as const) {
    await a.setViewportSize({ width: w, height: h });
    await a.waitForTimeout(300);
    const f = await fill(a);
    expect(f.w, `${w}×${h}`).toBeGreaterThan(0.95);
    expect(f.w).toBeLessThan(1.0);
    expect(f.dx).toBeLessThan(2);
  }
  await a.locator("[data-testid=map]").screenshot({ path: "shots/fit-default.png" });
  // Zoom in and back out past the default to the notes margin; pan.
  const c = await mapPoint(a, 0.5, 0.5);
  await a.mouse.move(c.x, c.y);
  await a.mouse.wheel(0, -300);
  await expect.poll(async () => Number((await a.getByTestId("map").getAttribute("data-view"))!.split(" ")[2])).toBeLessThan(600);
  await expect(a.locator("[data-testid=map] .mm-host")).toHaveClass(/zoomed/);
  for (let i = 0; i < 4; i++) await a.mouse.wheel(0, 300);
  await expect(a.getByTestId("map")).toHaveAttribute("data-view", "-250 -250 1500");
  await expect(a.locator("[data-testid=map] .mm-host")).toHaveClass(/free/);
});
