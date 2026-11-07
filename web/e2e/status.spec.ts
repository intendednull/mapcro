// Slice 8: honest status against a real server that goes away and comes back.

import { expect, test } from "@playwright/test";
import { dragToken, joinNew, mapPoint, tokenAt } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

test("an outage: offline with changes kept, a closed tab keeps them, and they sync when the server is back", async ({ browser }) => {
  const url = await newBoardUrl(server, "outage");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const a = await ctx.newPage();
  await a.goto(url);
  await a.locator("#join-name").fill("Coach");
  await a.keyboard.press("Enter");
  const status = a.getByTestId("save-status");
  await expect(status).toHaveText("Saved");

  await server.kill();
  await expect(status).toHaveText("Offline: reconnecting");
  const before = await tokenAt(a, "Amber-0");
  await dragToken(a, "Amber-0", 0.4, 0.6);
  // Seen once in ~6 full runs: the count stayed at 0. If it recurs, this says whether the drag
  // itself landed (the token moved) and what the connection was doing.
  const after = await tokenAt(a, "Amber-0");
  const conn = await status.getAttribute("data-connection");
  await expect(status, `drag moved ${JSON.stringify(before)} -> ${JSON.stringify(after)}; connection ${conn}`).toHaveText(
    "Offline: 1 change kept on this device",
  );
  await dragToken(a, "Amber-1", 0.6, 0.6);
  await expect(status).toHaveText("Offline: 2 changes kept on this device");
  const want = [await tokenAt(a, "Amber-0"), await tokenAt(a, "Amber-1")];

  // Close the tab while offline: the changes were written to this device before anything else.
  await a.close();
  await server.start();
  const again = await ctx.newPage();
  await again.goto(url);
  await expect(again.getByTestId("save-status")).toHaveText("Saved");
  await expect.poll(async () => [await tokenAt(again, "Amber-0"), await tokenAt(again, "Amber-1")]).toEqual(want);

  // A different device sees them: they reached the server.
  const b = await joinNew(browser, url, "Marrow");
  await expect.poll(async () => [await tokenAt(b, "Amber-0"), await tokenAt(b, "Amber-1")]).toEqual(want);

  // A live reconnect, without closing anything.
  await server.kill();
  await expect(b.getByTestId("save-status")).toContainText("Offline");
  await dragToken(again, "Sapphire-0", 0.5, 0.3);
  await expect(again.getByTestId("save-status")).toHaveText("Offline: 1 change kept on this device");
  await again.screenshot({ path: "shots/slice8-offline.png" });
  await server.start();
  await expect(again.getByTestId("save-status")).toHaveText("Saved", { timeout: 20000 });
  await expect.poll(() => tokenAt(b, "Sapphire-0"), { timeout: 20000 }).toEqual(await tokenAt(again, "Sapphire-0"));
});

test("a link that doesn't open a board says what to check", async ({ browser }) => {
  const url = await newBoardUrl(server, "links");
  const page = await (await browser.newContext()).newPage();
  // Cut short: it doesn't even parse.
  await page.goto(url.slice(0, -10));
  await expect(page.getByTestId("dead-link")).toContainText("This link doesn't open a board");
  // Well-formed but not a key to this board: the server refuses it. (A fresh page: changing
  // only the hash doesn't reload a page.)
  const page2 = await page.context().newPage();
  await page2.goto(url.replace(/#.*/, `#${"A".repeat(43)}`));
  await expect(page2.getByTestId("dead-link")).toContainText("ask whoever sent it for a fresh one");
  await expect(page2.getByTestId("join-card")).toHaveCount(0);
  await expect(page2.getByTestId("save-status")).toHaveAttribute("data-state", "closed");
});

test("a single tap with Draw is a dot, and it saves", async ({ browser }) => {
  const url = await newBoardUrl(server, "dot");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await a.keyboard.press("d");
  const p = await mapPoint(a, 0.5, 0.4);
  await a.mouse.click(p.x, p.y);
  await expect(b.locator(".mapbox [data-stroke]")).toHaveCount(1);
  await expect(a.getByTestId("save-status")).toHaveText("Saved");
});
