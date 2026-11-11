// Feedback #21: a hero at the map's edge spilled past the map's cutout (its token, ring and
// labels over the frame and the margin). Heroes, troopers and selection rings are clipped to the
// map's stencil, at any zoom; the edge is drawn over them; and what the clip hides takes no
// pointer. A dragged hero stops at the disc, so none is lost past it. Ink, arrows and comments
// keep the notes margin (backlog, The canvas fills the centre area).
//
// No pack here; the stencil is the same shape (map/stencil.ts): a disc of radius 44.83 of the
// frame's 100 about (49.83, 49.94), with bumps at the top and bottom; the map square is its middle
// 90. A dragged hero stops at radius 43 about the map's centre.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { type Page, expect, test } from "./fixtures";
import { initSync } from "../src/wasm/mapcro_wasm.js";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import { dragToken, joinNew, mapPoint, tokenAt, viewOf } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";

initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const SLOT = "Amber-0";

/** Puts Amber-0 at a world point, as a board from before the drag clamp could have it. */
async function placeAt(server: Server, url: string, pos: { x: number; y: number }) {
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  const bot = new BoardSession({
    wsUrl: `ws://127.0.0.1:${new URL(server.url).port}/ws`,
    board: board!,
    token: token!,
    persist: new MemoryPersist(),
    openSocket: (u) => new WebSocket(u, { origin: server.url }) as unknown as SocketLike,
  });
  await bot.start();
  await expect.poll(() => bot.connection.kind).toBe("live");
  const recs = [...bot.records];
  const slot = recs.find(([, e]) => "RosterSlot" in e.record && e.record.RosterSlot.team === "Amber" && e.record.RosterSlot.slot === 0)![0];
  const ps = recs.find(([, e]) => "PlayerState" in e.record && e.record.PlayerState.slot === slot)![0];
  bot.edit([{ Set: { id: ps, value: { PlayerPos: pos } } }]);
  await expect.poll(() => bot.status.kind).toBe("saved");
  bot.stop();
}
const tok = (p: Page) => p.locator(`.tok[data-slot="${SLOT}"]`);

/** Frame units (0..100; the map square is 5..95) to page pixels, from the overlay's box. */
async function framePx(p: Page, f: { x: number; y: number }) {
  const m = (await p.locator("[data-testid=map] .mm-overlay.map").boundingBox())!;
  return { x: m.x + ((f.x - 5) / 90) * m.width, y: m.y + ((f.y - 5) / 90) * m.height };
}
/** Page pixels to frame units. */
async function pxFrame(p: Page, q: { x: number; y: number }) {
  const m = (await p.locator("[data-testid=map] .mm-overlay.map").boundingBox())!;
  return { x: 5 + ((q.x - m.x) / m.width) * 90, y: 5 + ((q.y - m.y) / m.height) * 90 };
}
/** What takes the pointer at a page point: the token, or something else. */
const onToken = (p: Page, q: { x: number; y: number }) =>
  p.evaluate(([x, y, slot]) => !!document.elementFromPoint(x as number, y as number)?.closest(`.tok[data-slot="${slot}"]`), [q.x, q.y, SLOT] as const);

test("a hero at the edge is clipped to the map's stencil, under its edge, and takes no pointer past it", async ({ browser }) => {
  const url = await newBoardUrl(server, "edge");
  // Straddling the disc's edge to the north-west: its centre on the edge, at 44.83 frame units
  // from (49.83, 49.94) along the diagonal (frame (18.13, 18.24); view (145.9, 147.1)).
  await placeAt(server, url, { x: -7615, y: 7589 });
  const a = await joinNew(browser, url, "Coach");
  const map = a.locator("[data-testid=map] .mm-host");
  await expect(map).not.toHaveClass(/zoomed/);
  await expect.poll(async () => Math.round((await tokenAt(a, SLOT)).x)).toBe(146);
  let b = (await tok(a).boundingBox())!;
  const r = b.width / 2;
  const mid = { x: b.x + r, y: b.y + b.height / 2 };
  const d = r / Math.SQRT2;
  const out = { x: mid.x - 0.7 * d, y: mid.y - 0.7 * d };
  const inside = { x: mid.x + 0.5 * d, y: mid.y + 0.5 * d };
  const fo = await pxFrame(a, out);
  expect(Math.hypot(fo.x - 49.83, fo.y - 49.94)).toBeGreaterThan(44.83);
  // Past the edge the token isn't there to hover or press (the notes margin's is); inside it is.
  expect(await onToken(a, out)).toBe(false);
  expect(await onToken(a, inside)).toBe(true);
  await a.mouse.move(out.x, out.y);
  await expect(a.getByTestId("hover-label")).toHaveCount(0);
  await a.mouse.move(inside.x, inside.y);
  await expect(a.getByTestId("hover-label")).toHaveCount(1);
  await a.mouse.move(out.x, out.y);
  await expect(a.getByTestId("hover-label")).toHaveCount(0);
  await a.locator("[data-testid=map]").screenshot({ path: "shots/edge-clip-straddle.png" });

  // Dragged out past the map square's corner: it stops on the disc (radius 43 about the map's
  // centre), inside the stencil, so it stays seen and in reach.
  await dragToken(a, SLOT, -0.05, -0.05);
  await expect.poll(async () => Math.round((await tokenAt(a, SLOT)).x)).not.toBe(146);
  b = (await tok(a).boundingBox())!;
  const c = await pxFrame(a, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  expect(Math.hypot(c.x - 50, c.y - 50)).toBeLessThanOrEqual(43.05);
  expect(Math.hypot(c.x - 50, c.y - 50)).toBeGreaterThan(42);
  expect(await onToken(a, { x: b.x + b.width / 2, y: b.y + b.height / 2 })).toBe(true);

  // The clip, and the edge over it: drawn after the overlay, above it, moving with the map.
  const look = await a.evaluate(() => {
    const zoom = document.querySelector("[data-testid=map] .mm-zoom")!;
    const overlay = zoom.querySelector(":scope > .mm-overlay")!;
    const edge = zoom.querySelector(":scope > .mm-edge.moving");
    const tokens = overlay.querySelector(":scope > .tokens")!;
    return {
      tokens: getComputedStyle(tokens).clipPath,
      rot: getComputedStyle(zoom.querySelector(".mm-rot")!).clipPath,
      edge: !!edge,
      above: !!edge && Number(getComputedStyle(edge).zIndex) > Number(getComputedStyle(overlay).zIndex),
      edgeLast: zoom.lastElementChild === edge,
      stroke: edge ? getComputedStyle(edge.querySelector("path")!).stroke : "",
    };
  });
  expect(look.tokens).toMatch(/^url\("?#mm-stencil-\d+-view"?\)$/);
  expect(look.rot).toMatch(/^url\("?#mm-stencil-\d+-box"?\)$/);
  expect(look.edge && look.above && look.edgeLast).toBe(true);
  expect(look.stroke).not.toBe("none");
  // The edge is where the clip is: drawn in the frame's box, which moves with the map, and the
  // same outline as the clip's.
  const same = await a.evaluate(() => {
    const zoom = document.querySelector("[data-testid=map] .mm-zoom")!;
    const e = zoom.querySelector(":scope > .mm-edge")!.getBoundingClientRect();
    const f = zoom.querySelector(":scope > .mm-frame.moving")!.getBoundingClientRect();
    const clip = document.querySelector("[data-testid=map] .mm-defs clipPath[id$=-view] path")!.getAttribute("d");
    return { box: [e.x - f.x, e.y - f.y, e.width - f.width, e.height - f.height].every((v) => Math.abs(v) < 0.5), outline: zoom.querySelector(".mm-edge path")!.getAttribute("d") === clip };
  });
  expect(same).toEqual({ box: true, outline: true });
  await a.locator("[data-testid=map]").screenshot({ path: "shots/edge-clip-default.png" });

  // Ink still reaches into the notes margin, past the edge.
  await a.getByTestId("tool-draw").click();
  const from = await mapPoint(a, 0.2, 0.5);
  const to = await framePx(a, { x: 1.5, y: 50 });
  await a.mouse.move(from.x, from.y);
  await a.mouse.down();
  await a.mouse.move(to.x, to.y, { steps: 8 });
  await a.mouse.up();
  const ink = (await a.locator("[data-testid=map] .inks path:not(.hit)").last().boundingBox())!;
  expect((await pxFrame(a, { x: ink.x, y: ink.y })).x).toBeLessThan(4);

  // Zoomed in about the map's centre: the token, on the disc's north-west, moves out past the
  // view's fixed stencil while still inside its box (its corner). The clip hides it there, and
  // it takes no pointer (the zoomed view's mask, before, let it).
  await a.getByTestId("tool-move").click();
  const centre = await mapPoint(a, 0.5, 0.5);
  await a.mouse.move(centre.x, centre.y);
  // Far enough that 43 of the default view's units lands past the stencil, not past the box:
  // 927.8 / w between 1.08 and 1.4.
  for (let i = 0; (await viewOf(a))[2] > 820; i++) {
    expect(i).toBeLessThan(40);
    await a.mouse.wheel(0, -15);
    await a.waitForTimeout(50);
  }
  expect((await viewOf(a))[2]).toBeGreaterThan(680);
  await expect(map).toHaveClass(/zoomed/);
  await a.mouse.move(5, 5);
  const z = await a.evaluate((slot) => {
    const host = document.querySelector("[data-testid=map] .mm-host")!.getBoundingClientRect();
    const clip = document.querySelector("[data-testid=map] .mm-clip")!.getBoundingClientRect();
    const t = document.querySelector(`.tok[data-slot="${slot}"]`)!.getBoundingClientRect();
    const [x, y] = [t.x + t.width / 2, t.y + t.height / 2];
    const f = { x: ((x - host.x) / host.width) * 100, y: ((y - host.y) / host.height) * 100 };
    const hit = document.elementFromPoint(x, y);
    return { f, inBox: x > clip.x && x < clip.right && y > clip.y && y < clip.bottom, onToken: !!hit?.closest(`.tok[data-slot="${slot}"]`) };
  }, SLOT);
  expect(z.inBox).toBe(true);
  expect(Math.hypot(z.f.x - 49.83, z.f.y - 49.94)).toBeGreaterThan(46.5);
  expect(z.onToken).toBe(false);
  const zoomed = await a.evaluate(() => {
    const host = document.querySelector("[data-testid=map] .mm-host")!;
    const clip = host.querySelector(".mm-clip")!;
    const edge = host.querySelector(":scope > .mm-edge:not(.moving)");
    return { clip: getComputedStyle(clip).clipPath, edge: !!edge && Number(getComputedStyle(edge).zIndex) > Number(getComputedStyle(clip).zIndex) };
  });
  expect(zoomed.clip).toMatch(/^url\("?#mm-stencil-\d+-box"?\)$/);
  expect(zoomed.edge).toBe(true);
  await a.locator("[data-testid=map]").screenshot({ path: "shots/edge-clip-zoomed.png" });
});
