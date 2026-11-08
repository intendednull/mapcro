// Clone a scene from its row (operator, 2026-11-08): the copy lands right after that row, as its
// sibling, with that scene's heroes, in one undoable step; on the phone the row's buttons show.

import { expect, test } from "@playwright/test";
import { dragToken, joinNew, tokenAt } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

test("cloning row 2 of 3 puts the copy at position 3, with row 2's heroes; one undo removes it", async ({ browser }) => {
  const url = await newBoardUrl(server, "clone");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const rows = a.getByTestId("scene-card");
  await a.getByTestId("scene-add").click();
  await dragToken(a, "Amber-0", 0.62, 0.38); // scene 2's own spot
  const spot = await tokenAt(a, "Amber-0");
  await a.getByTestId("scene-add").click();
  await expect(rows).toHaveCount(3);
  await rows.first().click(); // look at scene 1: the clone is of row 2, not the current scene
  await rows.nth(1).hover();
  await rows.nth(1).getByTestId("scene-clone").click();
  await expect(rows).toHaveCount(4);
  await expect(b.getByTestId("scene-card")).toHaveCount(4);
  await expect(rows.nth(2)).toHaveAttribute("aria-current", "true"); // the copy, at position 3
  await expect.poll(() => tokenAt(a, "Amber-0")).toEqual(spot);
  await a.getByTestId("scene-tree").screenshot({ path: "shots/scene-clone.png" });
  await a.keyboard.press("Control+z");
  await expect(b.getByTestId("scene-card")).toHaveCount(3);
});

test("on the phone drawer, a row's clone and delete are always there", async ({ browser }) => {
  const url = await newBoardUrl(server, "clone phone");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.locator("#join-name").fill("Coach");
  await phone.keyboard.press("Enter");
  await phone.getByTestId("scene-drawer").click();
  await phone.getByTestId("scene-add").click();
  const rows = phone.getByTestId("scene-card");
  await expect(rows).toHaveCount(2);
  for (const id of ["scene-clone", "scene-delete"]) await expect(rows.nth(0).getByTestId(id)).toBeVisible();
  await expect.poll(() => rows.nth(0).getByTestId("scene-clone").evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
  await phone.screenshot({ path: "shots/scene-drawer-buttons.png" });
});
