// Heroes and live layers: kill and revive a hero (K or its skull), an optional respawn timer,
// heroes gliding between scenes, strokes seen while drawn, and middle-click pings.

import { type Page, expect, test } from "@playwright/test";
import { dragToken, joinNew, mapPoint, tokenAt } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const tok = (p: Page, slot: string) => p.locator(`.mapbox .tok[data-slot="${slot}"]`);

test("K kills and revives a hovered hero; dead looks unlike unseen; a respawn timer set by hand", async ({ browser }) => {
  const url = await newBoardUrl(server, "deaths");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const t = (await tok(a, "Amber-1").boundingBox())!;
  await a.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await a.keyboard.press("k");
  await expect(tok(b, "Amber-1")).toHaveClass(/dead/);
  await expect(tok(b, "Amber-1").locator(".dead-badge")).toHaveCount(1);
  await expect(tok(b, "Amber-1")).not.toHaveClass(/ghost/);
  // Out of vision is the other look: dashed and the eye-slash, no skull.
  await tok(a, "Amber-2").hover();
  await tok(a, "Amber-2").getByTestId("vision").click();
  await expect(tok(b, "Amber-2")).toHaveClass(/ghost/);
  await expect(tok(b, "Amber-2").locator(".dead-badge")).toHaveCount(0);
  await expect(tok(b, "Amber-2").locator(".vis .slash")).toHaveCount(1);

  // The timer: optional, typed by hand.
  const label = a.getByTestId("respawn").locator(".respawn-label");
  await label.click({ force: true });
  await a.getByTestId("respawn-input").fill("0:45");
  await a.keyboard.press("Enter");
  await expect(b.getByTestId("respawn")).toContainText("respawn 0:45");
  await a.mouse.move(10, 10);
  await a.screenshot({ path: "shots/hero-dead.png" });

  // Revive with the skull button: the timer goes with it, in one step.
  await tok(a, "Amber-1").hover();
  await tok(a, "Amber-1").getByTestId("life").click();
  await expect(tok(b, "Amber-1")).not.toHaveClass(/dead/);
  await expect(b.getByTestId("respawn")).toHaveCount(0);
  await a.keyboard.press("Control+z");
  await expect(b.getByTestId("respawn")).toContainText("respawn 0:45");
});

test("K acts only on the hero under the pointer, not one that moved away from it", async ({ browser }) => {
  const url = await newBoardUrl(server, "k under pointer");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const t = (await tok(a, "Amber-1").boundingBox())!;
  await a.mouse.move(t.x + t.width / 2, t.y + t.height / 2); // A hovers Amber-1 …
  await dragToken(b, "Amber-1", 0.7, 0.3); // … and B moves it out from under A's pointer
  await expect.poll(async () => (await tokenAt(a, "Amber-1")).x).toBeGreaterThan(600);
  await a.waitForTimeout(500); // the glide-free remote move has landed
  await a.keyboard.press("k");
  await a.waitForTimeout(400);
  await expect(tok(b, "Amber-1")).not.toHaveClass(/dead/);
  // The hero that is under the pointer now, if any, is the one K acts on.
  const u = (await tok(a, "Amber-1").boundingBox())!;
  await a.mouse.move(u.x + u.width / 2, u.y + u.height / 2);
  await a.keyboard.press("k");
  await expect(tok(b, "Amber-1")).toHaveClass(/dead/);
});

test("flipping scenes, heroes glide to their new spots, for followers too", async ({ browser }) => {
  const url = await newBoardUrl(server, "glide");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await a.getByTestId("scene-add").click();
  await expect(a.getByTestId("scene-card")).toHaveCount(2);
  await dragToken(a, "Amber-0", 0.75, 0.25); // only in scene 2
  await expect.poll(async () => (await tokenAt(b, "Amber-0")).x).toBeGreaterThan(0); // b sees the board
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  const end = await tokenAt(a, "Amber-0");
  await expect.poll(async () => Math.round((await tokenAt(b, "Amber-0")).x)).toBe(Math.round(end.x)); // B is on scene 2 with A
  await b.waitForTimeout(500); // any glide into scene 2 is over
  // B records Amber-0 every frame while A flips back to scene 1.
  const sampled = b.evaluate(
    () =>
      new Promise<number[]>((ok) => {
        const out: number[] = [];
        const stop = performance.now() + 1500;
        const f = () => {
          const tr = document.querySelector('.mapbox .tok[data-slot="Amber-0"]')?.getAttribute("transform") ?? "";
          out.push(Number(/translate\(([-\d.]+)/.exec(tr)?.[1]));
          if (performance.now() < stop) requestAnimationFrame(f);
          else ok(out);
        };
        f();
      }),
  );
  await a.waitForTimeout(100);
  await a.getByTestId("scene-card").first().click();
  const xs = await sampled;
  const first = xs[0]!;
  const last = xs[xs.length - 1]!;
  expect(Math.abs(first - end.x)).toBeLessThan(2);
  expect(Math.abs(last - first)).toBeGreaterThan(100);
  // In between, several frames on the way: a glide, not a jump.
  const between = xs.filter((x) => (x - first) * (x - last) < 0 && Math.abs(x - first) > 5 && Math.abs(x - last) > 5);
  expect(between.length).toBeGreaterThanOrEqual(4);
});

test("others see a stroke as it's drawn, and a middle click pings; a middle drag still pans", async ({ browser }) => {
  const url = await newBoardUrl(server, "live");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await a.keyboard.press("d");
  const p0 = await mapPoint(a, 0.3, 0.4);
  await a.mouse.move(p0.x, p0.y);
  await a.mouse.down();
  await a.mouse.move(p0.x + 80, p0.y + 20, { steps: 6 });
  const live = b.locator('.mapbox .live-ink[data-live-ink="Coach"]');
  await expect(live).toHaveCount(1);
  await expect(live.locator(".p-tag")).toContainText("Coach · drawing");
  const n1 = (await live.locator("path.ink").getAttribute("d"))!.length;
  await a.mouse.move(p0.x + 160, p0.y + 60, { steps: 6 });
  await expect.poll(async () => (await live.locator("path.ink").getAttribute("d"))!.length).toBeGreaterThan(n1);
  await a.mouse.up();
  await expect(b.locator(".mapbox [data-stroke]")).toHaveCount(1);
  await expect(live).toHaveCount(0);

  // Ping: a middle click.
  const at = await mapPoint(a, 0.6, 0.5);
  await a.mouse.move(at.x, at.y);
  await a.mouse.down({ button: "middle" });
  await a.mouse.up({ button: "middle" });
  const ping = b.locator('.mapbox .ping[data-ping="Coach"]');
  await expect(ping).toHaveCount(1);
  await expect(ping.locator(".p-tag")).toContainText("Coach");
  await b.locator("[data-testid=map]").screenshot({ path: "shots/ping.png" });
  await expect(ping).toHaveCount(0, { timeout: 4000 });
  // A middle drag pans and doesn't ping.
  const view0 = await a.getByTestId("map").getAttribute("data-view");
  await a.mouse.down({ button: "middle" });
  await a.mouse.move(at.x - 80, at.y, { steps: 5 });
  await a.mouse.up({ button: "middle" });
  await expect(a.getByTestId("map")).not.toHaveAttribute("data-view", view0!);
  await a.waitForTimeout(400);
  await expect(b.locator(".mapbox .ping")).toHaveCount(0);
});
