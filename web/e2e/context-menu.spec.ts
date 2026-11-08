// The browser's right-click menu is off across the site (operator, 2026-11-08): right-drag pans
// the map, and a pan ending over a button must not open the menu there. Text fields keep it.
// A cancelled `contextmenu` event is what keeps the native menu shut, so that is what's checked.

import { type Page, expect, test } from "@playwright/test";
import { joinNew, mapPoint, viewOf } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

/** Every `contextmenu` the page sees from now on: where, and whether the menu was kept shut. */
async function record(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { menus: Array<{ at: string; shut: boolean }> };
    w.menus = [];
    window.addEventListener("contextmenu", (e) => {
      const t = e.target as Element;
      const tagged = t.closest?.("[data-testid]") as HTMLElement | null;
      w.menus.push({ at: tagged?.dataset.testid ?? t.getAttribute?.("aria-label") ?? t.tagName, shut: e.defaultPrevented });
    });
  });
  return () => page.evaluate(() => (window as unknown as { menus: Array<{ at: string; shut: boolean }> }).menus);
}

test("right-click opens no browser menu on the board, its buttons or the landing; text fields keep theirs", async ({ browser }) => {
  const url = await newBoardUrl(server, "Menus");
  const page = await joinNew(browser, url, "Coach");
  const menus = await record(page);

  // A right-drag pan from the map that ends over a toolbar button: the view moves, and no
  // menu anywhere along the way (Windows and macOS raise it on release, over the button).
  const view = async () => (await viewOf(page)).join(" ");
  const mid = await mapPoint(page, 0.5, 0.5);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await viewOf(page))[2]).toBeLessThan(700);
  const before = await view();
  const btn = await page.getByTestId("tool-draw").boundingBox();
  await page.mouse.down({ button: "right" });
  await page.mouse.move(btn!.x + btn!.width / 2, btn!.y + btn!.height / 2, { steps: 8 });
  await page.mouse.up({ button: "right" });
  expect(await view()).not.toBe(before);
  await page.getByTestId("tool-draw").click({ button: "right" });
  await page.getByTestId("share").click({ button: "right" });
  const seen = await menus();
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect(seen.filter((m) => !m.shut)).toEqual([]);
  expect(seen.some((m) => m.at === "tool-draw")).toBe(true);

  // The landing too, but its title field keeps the browser's menu (paste, spellcheck).
  await page.goto(server.url + "/");
  const landing = await record(page);
  await page.getByRole("heading", { level: 1 }).click({ button: "right" });
  await page.getByLabel("Board title").click({ button: "right" });
  expect((await landing()).map((m) => m.shut)).toEqual([true, false]);
});
