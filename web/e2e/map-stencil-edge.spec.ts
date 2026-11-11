// Zoomed in, the map is seen through the HUD's disc (the stencil, map/stencil.ts: the frame
// mask's shape with the pack's art, the drawn frame's disc without it; a clip-path on `.mm-clip`
// either way, feedback #21). Operator, 2026-11-08: the stencil
// vanished when a zoomed-in view panned past the map's border. It now holds at every edge.
//
// Two checks at each edge. The computed style: `.mm-clip` still carries the stencil (its clip-path
// names the stencil's `<clipPath>`). And what it does:
// a press near the clip box's corner, outside the disc, lands on nothing inside the clip, since a
// clip-path also clips hit-testing; unstencilled, the map's overlay (and its notes margin) takes it.

import { type Page, expect, test } from "./fixtures";
import { joinNew, mapPoint, viewOf } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

/** One right-button drag by (dx, dy) page pixels from the middle of the map's box (not the map's
 *  own middle, which pans away): pans the view. */
async function drag(page: Page, dx: number, dy: number) {
  const box = (await page.getByTestId("map").boundingBox())!;
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(c.x + dx, c.y + dy, { steps: 5 });
  await page.mouse.up({ button: "right" });
}

const stencil = (page: Page) =>
  page.evaluate(() => {
    const clip = document.querySelector<HTMLElement>("[data-testid=map] .mm-clip")!;
    const cs = getComputedStyle(clip);
    const r = clip.getBoundingClientRect();
    // 4% in from the clip box's top-left corner: 0.65 of its width from the centre, well outside
    // the disc (radius 0.478).
    const hit = document.elementFromPoint(r.x + r.width * 0.04, r.y + r.height * 0.04);
    return { clipPath: cs.clipPath, cornerInClip: !!hit && clip.contains(hit) };
  });

test("zoomed in, the map's stencil holds when the view pans past each edge", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "stencil"), "Coach");
  const c = await mapPoint(a, 0.5, 0.5);
  await a.mouse.move(c.x, c.y);
  await a.mouse.wheel(0, -300);
  await a.mouse.wheel(0, -300);
  await expect.poll(async () => (await viewOf(a))[2]).toBeLessThan(400);
  const host = a.locator("[data-testid=map] .mm-host");
  await expect(host).toHaveClass(/zoomed/);
  const before = await stencil(a);
  expect(before.clipPath).toMatch(/^url\("?#mm-stencil-\d+-box"?\)$/);
  expect(before.cornerInClip).toBe(false);

  const edges: Array<[string, number, number, (v: [number, number, number]) => boolean]> = [
    ["west", 200, 0, ([x]) => x < -20],
    ["east", -200, 0, ([x, , w]) => x + w > 1020],
    ["north", 0, 200, ([, y]) => y < -20],
    ["south", 0, -200, ([, y, w]) => y + w > 1020],
  ];
  for (const [edge, dx, dy, past] of edges) {
    let n = 0;
    while (!past(await viewOf(a))) {
      expect(++n, `panning ${edge}`).toBeLessThan(40);
      await drag(a, dx, dy);
    }
    await expect(host, edge).toHaveClass(/zoomed/);
    const s = await stencil(a);
    expect(s.clipPath, edge).toMatch(/^url\("?#mm-stencil-\d+-box"?\)$/);
    expect(s.cornerInClip, edge).toBe(false);
    await a.locator("[data-testid=map]").screenshot({ path: `shots/stencil-edge-${edge}.png` });
    for (let i = 0; i < n; i++) await drag(a, -dx, -dy); // back to the middle
  }
});
