// Slice 1, end to end: two browsers against the real server. A board made on the landing page,
// joined with a display name; a hero dragged in one browser shows up live in the other (with
// the dragger's name tag), and survives a reload and a fresh device.

import { type Browser, type Page, expect, test } from "@playwright/test";
import { Server, translate } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

async function newDevice(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  return ctx.newPage();
}

async function join(page: Page, name: string) {
  await expect(page.getByTestId("join-card")).toBeVisible();
  await page.locator("#join-name").fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("join-card")).toBeHidden();
}

const token = (page: Page, slot: string) => page.locator(`.tok[data-slot="${slot}"]`);
const tokenAt = async (page: Page, slot: string) => translate(await token(page, slot).getAttribute("transform"));

test("create a board, join it, drag a hero, and see it in a second browser and after a reload", async ({ browser }) => {
  const a = await newDevice(browser);
  await a.goto(server.url);
  await a.getByLabel("Board title").fill("Scrim prep vs Night Owls");
  await a.getByRole("button", { name: "New board" }).click();
  await a.waitForURL(/\/b\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/);
  await expect(a.getByTestId("join-card").getByRole("heading", { name: "Scrim prep vs Night Owls" })).toBeVisible();
  await join(a, "Coach");
  await expect(a.getByTestId("board-title")).toHaveText("Scrim prep vs Night Owls");
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  // No pack on this server: the schematic map, and it says so.
  await expect(a.locator(".mapbox .mm-host")).toHaveAttribute("data-pack", "none");
  await expect(a.locator(".mapbox .mk.t2")).toHaveCount(6);
  await expect(a.locator(".tok")).toHaveCount(12);

  const link = a.url();
  const b = await newDevice(browser);
  await b.goto(link);
  await expect(b.getByTestId("join-here").locator('[title="Coach"]')).toBeVisible();
  await join(b, "Marrow");
  await expect(a.getByTestId("people")).toContainText("Marrow");

  const before = await tokenAt(b, "Amber-0");
  const box = (await token(a, "Amber-0").boundingBox())!;
  const map = (await a.locator(".mm-overlay.map").boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const to = { x: map.x + map.width * 0.5, y: map.y + map.height * 0.62 };
  await a.mouse.move(from.x, from.y);
  await a.mouse.down();
  await a.mouse.move(to.x, to.y, { steps: 12 });

  // Mid-drag: the other browser watches the hero move, with the dragger's name tag beside it.
  await expect(b.locator('.p-tag[data-tag="Coach"]')).toContainText("Coach · moving");
  await expect.poll(async () => (await tokenAt(b, "Amber-0")).y).toBeLessThan(before.y - 50);
  await a.mouse.up();
  await expect(b.locator('.p-tag[data-tag="Coach"]')).toHaveCount(0);

  const dropped = await tokenAt(a, "Amber-0");
  expect(dropped.x).toBeCloseTo(500, -1);
  expect(dropped.y).toBeCloseTo(620, -1);
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect.poll(async () => tokenAt(b, "Amber-0")).toEqual(dropped);

  // A reload keeps it, with no join card the second time; so does a device that never saw it.
  await b.reload();
  await expect(b.getByTestId("join-card")).toBeHidden();
  await expect.poll(async () => tokenAt(b, "Amber-0")).toEqual(dropped);
  const c = await newDevice(browser);
  await c.goto(link);
  await join(c, "Juno");
  await expect.poll(async () => tokenAt(c, "Amber-0")).toEqual(dropped);

  // The Sapphire view turns the map 180°: the same hero, mirrored through the centre.
  await c.getByTestId("viewpoint-flip").click();
  await expect.poll(async () => tokenAt(c, "Amber-0")).toEqual({ x: 1000 - dropped.x, y: 1000 - dropped.y });
  await expect(c.locator(".mapbox .mm-host")).toHaveClass(/vp-sapphire/);

  await a.screenshot({ path: "shots/slice1-board-fallback.png" });
});

test("a view link sees the board but can't drag", async ({ browser }) => {
  const r = await fetch(`${server.url}/api/boards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "viewers" }),
  });
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  const v = await fetch(`${server.url}/api/boards/${board}/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${owner_token}` },
    body: JSON.stringify({ role: "view", label: "guest" }),
  });
  const { token: viewToken } = (await v.json()) as { token: string };
  const page = await newDevice(browser);
  await page.goto(`${server.url}/b/${board}#${viewToken}`);
  await join(page, "Guest");
  const before = await tokenAt(page, "Sapphire-2");
  const box = (await token(page, "Sapphire-2").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 200, { steps: 5 });
  await page.mouse.up();
  expect(await tokenAt(page, "Sapphire-2")).toEqual(before);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
});

test("the map doesn't move after the board appears, even when the browser measures late", async ({ browser }) => {
  // A loaded machine delivers ResizeObserver callbacks late. The top bar's height once came only
  // from that callback, so the map jumped ~34 px after people had aimed at it (the long-running
  // outage flake). Delay every observer callback and check the map holds still.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    const RO = window.ResizeObserver;
    window.ResizeObserver = class extends RO {
      constructor(cb: ResizeObserverCallback) {
        super((entries, ob) => setTimeout(() => cb(entries, ob), 600));
      }
    };
  });
  const r = await fetch(`${server.url}/api/boards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "still" }) });
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  const page = await ctx.newPage();
  await page.goto(`${server.url}/b/${board}#${owner_token}`);
  await page.locator("#join-name").fill("Coach");
  await page.keyboard.press("Enter");
  const top = () => page.locator(".mapbox").evaluate((e) => Math.round(e.getBoundingClientRect().top));
  const first = await top();
  await page.waitForTimeout(1000);
  expect(await top()).toBe(first);
});
