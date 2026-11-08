// Slice 2: the scene strip on the real server. Add a scene (it starts from the current one),
// flip with clicks and arrow keys, edit the clock and name in place, drag to reorder; every
// browser agrees and a reload keeps it. Which scene you look at is yours alone.

import { expect, test } from "./fixtures";
import { dragToken, joinNew, tokenAt } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

test("add, flip, edit the clock and name, reorder", async ({ browser }) => {
  const url = await newBoardUrl(server, "scenes");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const cards = (p: typeof a) => p.getByTestId("scene-card");

  await dragToken(a, "Amber-0", 0.3, 0.7);
  const first = await tokenAt(a, "Amber-0");

  await a.getByTestId("scene-add").click();
  await expect(cards(a)).toHaveCount(2);
  await expect(cards(a).nth(1)).toHaveAttribute("aria-current", "true");
  await expect(a.getByText("Scene 2 of 2")).toBeVisible();
  // The new scene starts where the last one ended.
  expect(await tokenAt(a, "Amber-0")).toEqual(first);
  await dragToken(a, "Amber-0", 0.6, 0.4);
  const second = await tokenAt(a, "Amber-0");
  expect(second).not.toEqual(first);

  // B sees the new card but stays on its own scene until it flips.
  await expect(cards(b)).toHaveCount(2);
  await expect(cards(b).nth(0)).toHaveAttribute("aria-current", "true");
  await expect.poll(() => tokenAt(b, "Amber-0")).toEqual(first);
  await b.keyboard.press("ArrowRight");
  await expect(cards(b).nth(1)).toHaveAttribute("aria-current", "true");
  await expect.poll(() => tokenAt(b, "Amber-0")).toEqual(second);
  await b.keyboard.press("ArrowLeft");
  await expect.poll(() => tokenAt(b, "Amber-0")).toEqual(first);
  // Presence: B's avatar sits on the card of the scene B is looking at.
  await expect(cards(a).nth(0).locator(".here .av")).toHaveAttribute("title", "Marrow");

  // Clock and name, edited where they're shown. A clock that isn't one stays open, unsent.
  await a.getByTestId("scene-clock").click();
  await a.getByTestId("scene-clock-input").fill("8:75");
  await a.keyboard.press("Enter");
  await expect(a.getByTestId("scene-clock-input")).toHaveClass(/bad/);
  await a.getByTestId("scene-clock-input").fill("8:00");
  await a.keyboard.press("Enter");
  await a.getByTestId("scene-name").click();
  await a.getByTestId("scene-name-input").fill("mid boss setup");
  await a.keyboard.press("Enter");
  await expect(cards(b).nth(1)).toHaveAttribute("aria-label", "Scene 2: 8:00 mid boss setup");

  // Reorder: drag the second card before the first, in A; B sees the new order.
  await cards(a).nth(1).dragTo(cards(a).nth(0), { targetPosition: { x: 60, y: 3 } });
  await expect(cards(a).nth(0)).toHaveAttribute("aria-label", "Scene 1: 8:00 mid boss setup");
  await expect(cards(b).nth(0)).toHaveAttribute("aria-label", "Scene 1: 8:00 mid boss setup");
  // A still looks at the scene it moved.
  await expect(cards(a).nth(0)).toHaveAttribute("aria-current", "true");

  await b.reload();
  await expect(cards(b).nth(0)).toHaveAttribute("aria-label", "Scene 1: 8:00 mid boss setup");
  await expect(cards(b)).toHaveCount(2);
  await a.screenshot({ path: "shots/slice2-scenes.png" });
});

test("a viewer can flip but not add, rename or reorder", async ({ browser }) => {
  const url = await newBoardUrl(server, "viewing");
  const owner = await joinNew(browser, url, "Coach");
  await owner.getByTestId("scene-add").click();
  await expect(owner.getByTestId("scene-card")).toHaveCount(2);
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  const r = await fetch(`${server.url}/api/boards/${board}/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ role: "view", label: "guest" }),
  });
  const { token: view } = (await r.json()) as { token: string };
  const v = await joinNew(browser, `${server.url}/b/${board}#${view}`, "Guest");
  await expect(v.getByTestId("scene-add")).toHaveCount(0);
  await v.getByTestId("scene-card").nth(1).click();
  await expect(v.getByTestId("scene-card").nth(1)).toHaveAttribute("aria-current", "true");
  await v.getByTestId("scene-name").click();
  await expect(v.getByTestId("scene-name-input")).toHaveCount(0);
  await expect(v.getByTestId("scene-card").nth(0)).toHaveAttribute("draggable", "false");
});
