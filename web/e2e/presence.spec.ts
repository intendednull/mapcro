// Slice 5: presence and follow, on the real server: an owner presenting, an editor, a viewer.

import { expect, test } from "@playwright/test";
import { editLink, joinNew, mapPoint, viewLink, viewOf } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

test("cursors, the people list, follow, unfollow by changing your view, follow again", async ({ browser }) => {
  const url = await newBoardUrl(server, "presence");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, await editLink(server.url, url), "Marrow");
  const v = await joinNew(browser, await viewLink(server.url, url), "Guest");
  const card = (p: typeof a, i: number) => p.getByTestId("scene-card").nth(i);

  // Cursors, for everyone on the same scene, viewers included.
  const pa = await mapPoint(a, 0.4, 0.4);
  await a.mouse.move(pa.x, pa.y);
  await expect(b.locator('.cur[data-cursor="Coach"]')).toBeVisible();
  const pv = await mapPoint(v, 0.6, 0.6);
  await v.mouse.move(pv.x, pv.y);
  await expect(a.locator('.cur[data-cursor="Guest"]')).toBeVisible();

  // People: editors get a Follow button; a viewer can't be followed.
  await expect(v.locator('[data-person="Coach"] .pf-btn')).toHaveText("Follow");
  await expect(a.locator('[data-person="Guest"] .pf-btn')).toHaveCount(0);
  await expect(a.locator('[data-person="Guest"] .nofollow')).toHaveText("view only");

  // The viewer follows Coach with one click.
  await v.getByTestId("follow-Coach").click();
  await expect(v.getByTestId("follow-chip")).toContainText("Following Coach");
  await expect(a.getByTestId("presenting")).toContainText("1 following");
  await expect(a.locator('[data-person="Guest"]')).toContainText("following you");

  // Coach adds and flips scenes, and zooms in: the follower goes along.
  await a.getByTestId("scene-add").click();
  await expect(card(v, 1)).toHaveAttribute("aria-current", "true");
  const z = await mapPoint(a, 0.5, 0.5);
  await a.mouse.move(z.x, z.y);
  await a.mouse.wheel(0, -300);
  await expect.poll(async () => (await viewOf(a))[2]).toBeLessThan(600);
  const aw = (await viewOf(a))[2];
  await expect.poll(async () => Math.abs((await viewOf(v))[2] - aw)).toBeLessThan(3);

  // Changing what you see stops following, and says so; following again is one click.
  await v.keyboard.press("ArrowLeft");
  await expect(v.getByTestId("toast")).toContainText("You flipped the scene, so you stopped following Coach.");
  await expect(card(v, 0)).toHaveAttribute("aria-current", "true");
  await expect(a.getByTestId("presenting")).toHaveCount(0);
  await v.getByTestId("toast-action").click();
  await expect(card(v, 1)).toHaveAttribute("aria-current", "true");
  await expect(v.getByTestId("follow-chip")).toContainText("Following Coach");
  // Panning (drag on empty map with Look) stops it too.
  await v.mouse.move(pv.x, pv.y);
  await v.mouse.down();
  await v.mouse.move(pv.x + 60, pv.y + 40, { steps: 5 });
  await v.mouse.up();
  await expect(v.getByTestId("toast")).toContainText("panned the map");

  // The editor sees who is presenting and follows with F.
  await expect(b.getByTestId("follow-chip")).toHaveCount(0); // nobody follows Coach right now
  await v.getByTestId("toast-action").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Coach is presenting");
  await b.keyboard.press("f");
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  await expect(a.getByTestId("presenting")).toContainText("2 following");
  await expect(card(b, 1)).toHaveAttribute("aria-current", "true");
  await a.screenshot({ path: "shots/slice5-presenting.png" });
  await v.screenshot({ path: "shots/slice5-following.png" });

  // When the presenter leaves, followers are told.
  await a.close();
  await expect(b.getByTestId("toast")).toContainText("left the board", { timeout: 15000 });
  await expect(b.getByTestId("follow-chip")).toHaveCount(0);
});
