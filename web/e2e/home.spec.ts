// The way back: the mapcro mark on a board links to the front page, where you open another match
// or board (desktop and phone).

import { expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

for (const [label, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`the mark goes home from a board (${label})`, async ({ browser }) => {
    const url = await newBoardUrl(server, "Home trip");
    const page = await joinNew(browser, url, "Coach");
    await page.setViewportSize(viewport);
    const home = page.locator('[data-testid="home"]:visible');
    await expect(home).toHaveCount(1);
    await home.click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("open-match")).toBeVisible();
    await expect(page.getByTestId("new-board")).toBeVisible();
  });
}
