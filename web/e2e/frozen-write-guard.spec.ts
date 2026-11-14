// The guard in fixtures.ts: a page that writes to a frozen object fails its test. Player's
// timelines are frozen all the way down (sessions.md §4.3), so this is what catches code that
// writes to one. Each test here is expected to fail, by the guard alone.

import { expect, test } from "./fixtures";
import { Server } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server?.stop());

const write = () => {
  setTimeout(() => {
    "use strict";
    const held = Object.freeze({ t: 1, rows: Object.freeze([1]) });
    (held as { t: number }).t = 2;
  }, 0);
};

test("a write to a frozen object in the test's own page fails the test", async ({ page }) => {
  test.fail();
  await page.goto(server.url);
  await page.evaluate(write);
  await expect.poll(() => page.evaluate(() => 1)).toBe(1);
  await page.waitForTimeout(100);
});

test("and in a page of a context the test made", async ({ browser }) => {
  test.fail();
  const page = await (await browser.newContext()).newPage();
  await page.goto(server.url);
  await page.evaluate(write);
  await page.waitForTimeout(100);
});
