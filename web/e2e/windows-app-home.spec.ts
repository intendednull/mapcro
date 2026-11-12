// The home page offers the Windows app to Windows browsers (operator, 2026-11-11): the installer by
// default and a quieter "Portable" beside it. Never on other systems, never inside the app.

import { expect, test } from "./fixtures";
import { Server } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

test("a Windows browser sees Get the Windows app under Load a game", async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: WINDOWS_UA });
  const page = await ctx.newPage();
  await page.goto(server.url);
  const row = page.getByTestId("windows-app-home");
  await expect(row).toBeVisible();
  await expect(row.getByRole("link", { name: "Get the Windows app" })).toHaveAttribute("href", /releases\/latest\/download\/mapcro_x64-setup\.exe$/);
  await expect(page.getByTestId("windows-portable-home")).toHaveAttribute("href", /releases\/latest\/download\/mapcro_x64-portable\.zip$/);
  await expect(page.getByTestId("windows-app-landing")).toBeVisible();
  await ctx.close();
});

test("other systems and the app itself don't see it", async ({ browser }) => {
  const linux = await browser.newContext();
  const p = await linux.newPage();
  await p.goto(server.url);
  await expect(p.getByTestId("open-match")).toBeVisible();
  await expect(p.getByTestId("windows-app-home")).toHaveCount(0);
  await linux.close();
  const app = await browser.newContext({ userAgent: WINDOWS_UA });
  await app.addInitScript(() => { (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: () => Promise.reject(new Error("no")) }; });
  const q = await app.newPage();
  await q.goto(server.url);
  await expect(q.getByTestId("open-match")).toBeVisible();
  await expect(q.getByTestId("windows-app-home")).toHaveCount(0);
  await app.close();
});
