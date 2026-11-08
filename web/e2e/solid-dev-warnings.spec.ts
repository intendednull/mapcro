// Solid's dev build warns "computations created outside a `createRoot`" when an event handler
// reads an expression prop (`a ? b : c`, `a && b`): the compiled getter makes a memo on each
// read, outside any owner, that's never disposed. The built client is Solid's production build,
// which never warns, so this runs the same flows against Vite's dev server (QA 2026-11-08: the
// top bar's souls and totals, a scene row's name clicked, double-clicked and renamed).

import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { ROOT, Server } from "./server";

let server: Server;
let vite: ChildProcess;
let base = "";

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

test.beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = new Server(undefined, { PUBLIC_ORIGIN: base });
  await server.start();
  vite = spawn(join(ROOT, "web/node_modules/.bin/vite"), ["--port", String(port), "--host", "127.0.0.1"], {
    cwd: join(ROOT, "web"),
    env: { ...process.env, MAPCRO_PORT: String(server.port) },
    stdio: "ignore",
  });
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("vite never came up");
});
test.afterAll(() => {
  vite?.kill("SIGKILL");
  server?.stop();
});

test("the top bar and the scene tree's edits make no unowned computations", async ({ browser }) => {
  test.setTimeout(120_000);
  const r = await fetch(`${base}/api/boards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "dev warnings" }) });
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const warned: string[] = [];
  page.on("console", (m) => {
    if (/createRoot/.test(m.text())) warned.push(m.text());
  });
  await page.goto(`${base}/b/${board}#${owner_token}`);
  // Vite's first load compiles every module: give it time.
  await page.locator("#join-name").fill("Coach", { timeout: 60_000 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  // Vite's dev server is what's running, so Solid's dev build, which warns.
  await expect(page.locator('script[src="/@vite/client"]')).toHaveCount(1);

  // Souls in the top bar, then a team's total.
  const souls = page.locator('.tb-player[data-slot="Amber-0"]').getByTestId("souls");
  await souls.click();
  await page.getByTestId("souls-input").fill("9040");
  await page.keyboard.press("Enter");
  await expect(souls).toHaveText("9.0k");
  await page.getByTestId("total-edit-Amber").click();
  await page.getByTestId("total-edit-Amber-input").fill("20000");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("total-Amber")).toHaveText("20k");

  // A scene row's name: a click (views it), a double-click (opens the rename) and a commit.
  const row = (p: Page) => p.getByTestId("scene-card").first().locator(".name");
  await row(page).click();
  await row(page).dblclick();
  await page.getByTestId("scene-row-name-input").fill("Opening");
  await page.keyboard.press("Enter");
  await expect(row(page)).toHaveText("Opening");
  await row(page).click();

  expect(warned).toEqual([]);
});
