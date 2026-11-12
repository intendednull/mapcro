// Each laser press-to-release is its own trail (operator bug, 2026-11-08): a second press while
// the first still fades starts a fresh trail, never one segment bridging the two, for you and for
// everyone who sees it: in Sandbox, from a view link, and in Player to a follower. The ping (a
// middle click) still reaches the others.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { gesture, joinNew, mapPoint, revealControls, viewLink } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";

const ID = "130816395";
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  const fixture = readFileSync(join(ROOT, `crates/server/tests/fixtures/match-${ID}-trimmed.json`));
  upstream = createServer((req, res) => {
    if (req.url?.startsWith(`/v1/matches/${ID}/metadata`)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(fixture);
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}` });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

/** Two gestures, one on the map's left, one on its right, the second while the first fades. */
async function twoGestures(p: Page) {
  await gesture(p, [[0.3, 0.35], [0.36, 0.42], [0.42, 0.5]], 4);
  await gesture(p, [[0.6, 0.35], [0.65, 0.42], [0.7, 0.5]], 4);
}

/**
 * The trails `who` shows on `p` (view units): each trail's segments, as [x0, x1] pairs. Two
 * trails, each wholly on one side of the map's middle: no segment bridges them.
 */
async function trails(p: Page, who: string) {
  return p.locator(`.mapbox .laser[data-laser="${who}"]`).evaluateAll((gs) =>
    gs.map((g) =>
      [...g.querySelectorAll("path")].map((path) => {
        const n = (path.getAttribute("d") ?? "").match(/-?[\d.]+/g)!.map(Number);
        return [n[0]!, n[2]!] as [number, number];
      }),
    ),
  );
}
async function expectTwoSeparate(p: Page, who: string) {
  await expect(p.locator(`.mapbox .laser[data-laser="${who}"]`)).toHaveCount(2);
  const ts = await trails(p, who);
  const side = (x: number) => (x < 500 ? "left" : "right");
  for (const t of ts) {
    expect(t.length).toBeGreaterThan(0);
    for (const [a, b] of t) expect(side(a)).toBe(side(b));
  }
  expect(new Set(ts.map((t) => side(t[0]![0])))).toEqual(new Set(["left", "right"]));
}

test("two laser gestures are two trails, locally and for a peer and from a view link; the ping still goes", async ({ browser }) => {
  const url = await newBoardUrl(server, "Laser");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await a.keyboard.press("w");
  await expect(a.getByTestId("tool-laser")).toHaveAttribute("aria-pressed", "true");
  await twoGestures(a);
  await expectTwoSeparate(a, "mine");
  await expectTwoSeparate(b, "Coach");
  // Both fade on their own.
  await expect(b.locator('.mapbox .laser[data-laser="Coach"]')).toHaveCount(0, { timeout: 4000 });
  await expect(a.locator('.mapbox .laser[data-laser="mine"]')).toHaveCount(0, { timeout: 4000 });

  // A view link's laser, the same.
  const v = await joinNew(browser, await viewLink(server.url, url), "Guest");
  await v.keyboard.press("w");
  await expect(v.getByTestId("tool-laser")).toHaveAttribute("aria-pressed", "true");
  await twoGestures(v);
  await expectTwoSeparate(v, "mine");
  await expectTwoSeparate(a, "Guest");

  // The middle-click ping reaches the others.
  const at = await mapPoint(a, 0.5, 0.7);
  await a.mouse.click(at.x, at.y, { button: "middle" });
  await expect(b.locator('.mapbox .ping[data-ping="Coach"]')).toHaveCount(1);
});

/** The opacity of `who`'s newest trail segment on `p` (null: none drawn), in one evaluation. */
const headOpacity = (p: Page, who: string) =>
  p.evaluate((who) => {
    const paths = [...document.querySelectorAll(`.mapbox .laser[data-laser="${who}"] path`)];
    const last = paths.at(-1);
    return last ? Number(getComputedStyle(last).opacity) : null;
  }, who);

// #42: the tail fades on the clock, every point by its own age: holding the pointer still mid-draw,
// the trail keeps fading for you and for a peer (it used to sit solid until points were dropped).
test("a laser held still mid-draw keeps fading, for you and for a peer", async ({ browser }) => {
  const url = await newBoardUrl(server, "Laser fade");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await a.keyboard.press("w");
  await expect(a.getByTestId("tool-laser")).toHaveAttribute("aria-pressed", "true");
  const from = await mapPoint(a, 0.3, 0.4);
  const to = await mapPoint(a, 0.6, 0.5);
  await a.mouse.move(from.x, from.y);
  await a.mouse.down();
  await a.mouse.move(to.x, to.y, { steps: 8 });
  // Held: no more moves. The newest segment, solid as drawn, fades away while still held.
  await expect(b.locator('.mapbox .laser[data-laser="Coach"] path').first()).toBeAttached();
  await expect.poll(() => headOpacity(a, "mine"), { timeout: 3000 }).toBeLessThan(0.6);
  await expect.poll(() => headOpacity(b, "Coach"), { timeout: 3000 }).toBeLessThan(0.6);
  await expect(a.locator('.mapbox .laser[data-laser="mine"]')).toHaveCount(0, { timeout: 4000 });
  await a.mouse.up();
});

test("in Player, a follower sees two laser gestures as two trails", async ({ browser }) => {
  const url = await newBoardUrl(server, "Laser Player");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  await expect(b.getByTestId("player")).toHaveAttribute("data-state", "match");

  // By its key: the match source's panel, still open after Load, lies over the toolbar's left end.
  await a.keyboard.press("w");
  await expect(a.getByTestId("tool-laser")).toHaveAttribute("aria-pressed", "true");
  await twoGestures(a);
  await expectTwoSeparate(a, "mine");
  await expectTwoSeparate(b, "Coach");
  await b.screenshot({ path: "shots/laser-two-gestures-follower.png" });
});

/**
 * How the trail's segments paint the pixels of its box, in view units: a segment's painted shape
 * is its stroke, cut by its clip polygon, as the DOM declares them. A pixel painted twice has
 * twice the alpha there, which is the seam (#46).
 */
async function paintedTwice(p: Page) {
  return p.evaluate(() => {
    const g = document.querySelector('.mapbox .laser[data-laser="mine"]')!;
    const shapes = [...g.querySelectorAll("path")].map((el) => {
      const clip = /url\(#(.+)\)/.exec(el.getAttribute("clip-path") ?? "")?.[1];
      return {
        d: el.getAttribute("d") ?? "",
        w: parseFloat(getComputedStyle(el).strokeWidth),
        clip: clip ? (document.getElementById(clip)?.querySelector("polygon")?.getAttribute("points") ?? "") : "",
      };
    });
    const at = (d: string) => (d.match(/-?[\d.]+/g) ?? []).map(Number);
    const ends = shapes.map((s) => at(s.d));
    const xs = ends.flatMap((n) => [n[0]!, n[2]!]);
    const ys = ends.flatMap((n) => [n[1]!, n[3]!]);
    const pad = 14;
    const [x0, y0] = [Math.min(...xs) - pad, Math.min(...ys) - pad];
    const [w, h] = [Math.max(...xs) + pad - x0, Math.max(...ys) + pad - y0];
    const scale = 3; // px per view unit: the cut's antialiasing stays under one pixel a side
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext("2d")!;
    const count = new Uint8Array(canvas.width * canvas.height);
    const cover = new Float32Array(canvas.width * canvas.height);
    for (const s of shapes) {
      ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
      ctx.clearRect(x0, y0, w, h);
      ctx.save();
      if (s.clip) {
        const q = s.clip.split(" ").map((t) => t.split(",").map(Number) as [number, number]);
        const cut = new Path2D();
        cut.moveTo(q[0]![0], q[0]![1]);
        for (const [x, y] of q.slice(1)) cut.lineTo(x, y);
        cut.closePath();
        ctx.clip(cut);
      }
      ctx.lineWidth = s.w;
      ctx.lineCap = "round";
      ctx.strokeStyle = "#000";
      ctx.stroke(new Path2D(s.d));
      ctx.restore();
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < count.length; i++) {
        const a = px[i * 4 + 3]! / 255;
        if (a >= 0.75) count[i] = (count[i] ?? 0) + 1;
        cover[i] = (cover[i] ?? 0) + a;
      }
    }
    // At a joint, where one segment ends and the next begins, the two halves of the cap add up to
    // one stroke: not two (a doubled alpha) and not less (a gap).
    const joints = ends.slice(1).map((n) => {
      const x = Math.round((n[0]! - x0) * scale);
      const y = Math.round((n[1]! - y0) * scale);
      return cover[y * canvas.width + x] ?? 0;
    });
    let twice = 0;
    for (const c of count) if (c > 1) twice++;
    return { segments: shapes.length, joints, twice };
  });
}

test("no joint of the laser trail is painted twice: the fade has no brighter seams", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Laser seams"), "Coach");
  await a.keyboard.press("w");
  await expect(a.getByTestId("tool-laser")).toHaveAttribute("aria-pressed", "true");
  // Slow enough that each move keeps its own point (a point every LASER_STEP_MS), so there are
  // several joints to check.
  const at: Array<{ x: number; y: number }> = [];
  for (const q of [[0.3, 0.35], [0.34, 0.4], [0.38, 0.45], [0.42, 0.5]] as Array<[number, number]>) at.push(await mapPoint(a, ...q));
  await a.mouse.move(at[0]!.x, at[0]!.y);
  await a.mouse.down();
  for (const q of at.slice(1)) {
    await a.mouse.move(q.x, q.y, { steps: 4 });
    await a.waitForTimeout(80);
  }
  const r = await paintedTwice(a);
  await a.mouse.up();
  expect(r.segments).toBeGreaterThan(2);
  // Antialiasing along a cut may touch a pixel or two; a doubled alpha covers the cap's disc.
  expect(r.twice).toBeLessThanOrEqual(2);
  for (const n of r.joints) {
    expect(n).toBeGreaterThan(0.6);
    expect(n).toBeLessThan(1.3);
  }
});

test("the laser keeps its size on screen when the map is zoomed in", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Laser zoom"), "Coach");
  // The trail's width on screen: its stroke in the overlay's units times the overlay's scale.
  const onScreen = () =>
    a.locator('[data-laser="mine"] path').last().evaluate((el) => {
      const svg = (el as SVGGraphicsElement).ownerSVGElement!;
      return parseFloat(getComputedStyle(el).strokeWidth) * svg.getScreenCTM()!.a;
    });
  const sweep = async () => {
    await a.keyboard.press("w");
    const from = await mapPoint(a, 0.4, 0.45);
    const to = await mapPoint(a, 0.6, 0.55);
    await a.mouse.move(from.x, from.y);
    await a.mouse.down();
    await a.mouse.move(to.x, to.y, { steps: 6 });
    const w = await onScreen();
    await a.mouse.up();
    return w;
  };
  const before = await sweep();
  const mid = await mapPoint(a, 0.5, 0.5);
  await a.mouse.move(mid.x, mid.y);
  await a.mouse.wheel(0, -600);
  await expect.poll(async () => (await a.getByTestId("map").getAttribute("data-view"))!.split(" ").map(Number)[2]).toBeLessThan(600);
  const zoomed = await sweep();
  expect(zoomed / before).toBeGreaterThan(0.8);
  expect(zoomed / before).toBeLessThan(1.25);
});
