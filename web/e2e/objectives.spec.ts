// Marquee-selecting objectives (operator, 2026-11-07), on the real server with two editors.

import { type Page, expect, test } from "@playwright/test";
import { dragToken, joinNew, mapPoint } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

// A patch of camps east of the mid lane on the fallback map, with no objectives or heroes in it.
const PATCH: [[number, number], [number, number]] = [[0.655, 0.355], [0.728, 0.468]];

async function marquee(p: Page, [a, b]: typeof PATCH) {
  const p0 = await mapPoint(p, ...a);
  const p1 = await mapPoint(p, ...b);
  await p.mouse.move(p0.x, p0.y);
  await p.mouse.down();
  await p.mouse.move(p1.x, p1.y, { steps: 6 });
  await p.mouse.up();
}
const picked = (p: Page) => p.locator(".mapbox .mk.picked");
const keysOf = (p: Page) => picked(p).evaluateAll((els) => els.map((e) => e.getAttribute("data-key")!));
const statusOf = (p: Page, keys: string[]) => Promise.all(keys.map((k) => p.locator(`.mapbox .mk[data-key="${k}"]`).getAttribute("data-status")));
async function clickMarker(p: Page, key: string) {
  const bb = (await p.locator(`.mapbox .mk[data-key="${key}"]`).boundingBox())!;
  await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
}

test("a marquee over camps selects them; with a hero inside it selects only the hero", async ({ browser }) => {
  const url = await newBoardUrl(server, "pick");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await marquee(a, PATCH);
  const keys = await keysOf(a);
  expect(keys.length).toBeGreaterThanOrEqual(3);
  expect(keys.every((k) => k.startsWith("camp:"))).toBe(true);
  await expect(a.locator(".mapbox .tok.selected")).toHaveCount(0);
  // The other editor sees whose selection it is.
  await expect(b.locator(`.picks[data-picks="Coach"] .pick-ring`)).toHaveCount(keys.length);
  await expect(b.locator('.picks .p-tag[data-tag="Coach"]')).toContainText(`${keys.length} selected`);
  await a.screenshot({ path: "shots/objectives-selected.png" });

  // A hero inside the same rectangle wins: only the hero is selected.
  await a.keyboard.press("Escape");
  await expect(picked(a)).toHaveCount(0);
  await dragToken(a, "Amber-0", 0.69, 0.41);
  await marquee(a, PATCH);
  await expect(a.locator(".mapbox .tok.selected")).toHaveCount(1);
  await expect(picked(a)).toHaveCount(0);
});

test("clicking one selected camp toggles them all in one transaction; one undo restores them", async ({ browser }) => {
  const url = await newBoardUrl(server, "toggle");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await marquee(a, PATCH);
  const keys = await keysOf(a);
  expect(keys.length).toBeGreaterThanOrEqual(3);
  await clickMarker(a, keys[1]!);
  await expect.poll(() => statusOf(b, keys)).toEqual(keys.map(() => "Destroyed"));
  // Still selected: a second click brings the group back.
  await clickMarker(a, keys[0]!);
  await expect.poll(() => statusOf(b, keys)).toEqual(keys.map(() => "Active"));
  await a.keyboard.press("Control+z");
  await expect.poll(() => statusOf(b, keys)).toEqual(keys.map(() => "Destroyed"));
  await a.keyboard.press("Control+z");
  await expect.poll(() => statusOf(b, keys)).toEqual(keys.map(() => "Active"));
});

test("a click on empty map or on an objective outside the group deselects; the outside one toggles alone", async ({ browser }) => {
  const url = await newBoardUrl(server, "deselect");
  const a = await joinNew(browser, url, "Coach");
  await marquee(a, PATCH);
  const keys = await keysOf(a);
  expect(keys.length).toBeGreaterThanOrEqual(3);
  // Empty map: a short click well away from everything.
  const empty = await mapPoint(a, 0.62, 0.3);
  await a.mouse.click(empty.x, empty.y);
  await expect(picked(a)).toHaveCount(0);

  await marquee(a, PATCH);
  await expect(picked(a)).toHaveCount(keys.length);
  const walker = "walker:sapphire:lane6:1";
  await clickMarker(a, walker);
  await expect(picked(a)).toHaveCount(0);
  await expect(a.locator(`.mapbox .mk[data-key="${walker}"]`)).toHaveAttribute("data-status", "Destroyed");
  expect(await statusOf(a, keys)).toEqual(keys.map(() => "Active"));
});

test("a viewer can't select objectives", async ({ browser }) => {
  const url = await newBoardUrl(server, "viewer");
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  const r = await fetch(`${server.url}/api/boards/${board}/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ role: "view", label: "guest" }),
  });
  const { token: view } = (await r.json()) as { token: string };
  const v = await joinNew(browser, `${server.url}/b/${board}#${view}`, "Guest");
  await marquee(v, PATCH);
  await expect(picked(v)).toHaveCount(0);
});

test("a marquee picks up a powerup with the camps, and the group toggle takes it too", async ({ browser }) => {
  const url = await newBoardUrl(server, "powerups");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  // Around the west powerup site (map 31.7%, 49.4%) and a camp or two near it.
  await marquee(a, [[0.29, 0.46], [0.36, 0.6]]);
  const keys = await keysOf(a);
  expect(keys).toContain("powerup:neutral:lane1:1");
  expect(keys.length).toBeGreaterThanOrEqual(2);
  await clickMarker(a, "powerup:neutral:lane1:1");
  await expect.poll(() => statusOf(b, keys)).toEqual(keys.map(() => "Destroyed"));
  // A new scene starts with the powerup still taken.
  await a.keyboard.press("Escape");
  await a.getByTestId("scene-add").click();
  await expect(a.locator('.mapbox .mk[data-key="powerup:neutral:lane1:1"]')).toHaveAttribute("data-status", "Destroyed");
});
