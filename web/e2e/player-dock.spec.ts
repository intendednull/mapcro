// The stage's dock (operator, 2026-11-08): the tools and Player's bar in one column under the
// map, in flow, so they never overlap and the map shrinks to fit. Plus QA's items: Play never
// runs the clock backwards, the phone keeps every control, and a failed Open match isn't kept.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Locator, type Page, devices, expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
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
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-e2e-dock-")) });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

type Box = { x: number; y: number; width: number; height: number };
const box = async (l: Locator) => (await l.boundingBox())!;
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (a: Box, w: number, h: number) => a.x >= 0 && a.y >= 0 && a.x + a.width <= w + 0.5 && a.y + a.height <= h + 0.5;

async function openMatch(p: Page) {
  await p.getByTestId("mode-player").click();
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await expect(p.getByTestId("match-tier")).toHaveText("API summary");
}

for (const [w, h] of [[1280, 768], [1440, 900], [1920, 1080], [1100, 900]] as const) {
  test(`at ${w}×${h} the tools, the bar and the map never overlap, in every state`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const a = await ctx.newPage();
    await a.goto(await newBoardUrl(server, "Dock"));
    await a.locator("#join-name").fill("Coach");
    await a.keyboard.press("Enter");
    await expect(a.getByTestId("join-card")).toBeHidden();
    const tools = a.getByTestId("toolbar");
    const map = a.locator("[data-testid=map]");
    // Sandbox: no bar.
    expect(overlap(await box(tools), await box(map))).toBe(false);
    expect(inside(await box(tools), w, h)).toBe(true);
    await a.screenshot({ path: `shots/dock-sandbox-${w}x${h}.png` });
    await openMatch(a);
    for (const state of ["match", "scene"] as const) {
      if (state === "scene") await a.getByTestId("mode-sandbox").click();
      const bar = a.getByTestId("player");
      await expect(bar).toHaveAttribute("data-state", state);
      const [t, b, m] = [await box(tools), await box(bar), await box(map)];
      expect(overlap(t, b), `${state}: tools ${JSON.stringify(t)} bar ${JSON.stringify(b)}`).toBe(false);
      expect(overlap(m, b), `${state}: map under the bar`).toBe(false);
      expect(overlap(m, t), `${state}: map under the tools`).toBe(false);
      expect(inside(b, w, h), `${state}: bar on screen`).toBe(true);
      await a.screenshot({ path: `shots/dock-${state}-${w}x${h}.png` });
    }
    await ctx.close();
  });
}

test("on a phone every control is reachable and the scrubber has a row of its own", async ({ browser }) => {
  const url = await newBoardUrl(server, "Phone dock");
  const a = await joinNew(browser, url, "Coach");
  await openMatch(a);
  const ctx = await browser.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined } as never);
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.locator("#join-name").fill("Guest");
  await phone.keyboard.press("Enter");
  await expect(phone.getByTestId("player")).toHaveAttribute("data-state", "match");
  const scrub = await box(phone.getByTestId("match-time"));
  expect(scrub.width).toBeGreaterThan(250);
  for (const id of ["p-prev", "p-next", "scene-drawer", "match-play"]) {
    const el = phone.getByTestId(id);
    await el.scrollIntoViewIfNeeded();
    await expect(el).toBeVisible();
    // What a tap at its centre hits is the control itself, nothing laid over it.
    const b = await box(el);
    const hit = await phone.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("[data-testid]")?.getAttribute("data-testid"), [b.x + b.width / 2, b.y + b.height / 2]);
    expect(hit, id).toBe(id);
  }
  await phone.screenshot({ path: "shots/dock-phone-match.png", fullPage: true });
  await phone.getByTestId("mode-sandbox").tap();
  await expect(phone.getByTestId("player")).toHaveAttribute("data-state", "scene");
  await phone.screenshot({ path: "shots/dock-phone-scene.png", fullPage: true });
});

test("Play never runs the clock backwards, here or for a follower", async ({ browser }) => {
  const url = await newBoardUrl(server, "Clock");
  const a = await joinNew(browser, url, "Coach");
  await openMatch(a);
  await a.getByTestId("match-time").evaluate((el) => {
    (el as HTMLInputElement).value = "600";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("match-clock")).toHaveText("10:00 / 21:40");
  await a.waitForTimeout(1500); // paused a while: the frame clock is stale
  const sample = (p: Page) =>
    p.evaluate(
      () =>
        new Promise<number[]>((ok) => {
          const out: number[] = [];
          const end = performance.now() + 1500;
          const f = () => {
            const [m, s] = (document.querySelector("[data-testid=match-clock]")!.textContent ?? "").split(" / ")[0]!.split(":").map(Number);
            out.push(m! * 60 + s!);
            if (performance.now() < end) requestAnimationFrame(f);
            else ok(out);
          };
          f();
        }),
    );
  const [seenA, seenB] = await Promise.all([sample(a), sample(b), a.getByTestId("match-play").click()]);
  for (const seen of [seenA, seenB]) {
    expect(seen.every((t, i) => i === 0 || t >= seen[i - 1]!), seen.join(",")).toBe(true);
    expect(seen[0]).toBe(600);
  }
});

test("a failed Open match isn't added to Your boards", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(server.url);
  await page.getByTestId("open-match-file").setInputFiles({ name: "122134063.dem", mimeType: "application/octet-stream", buffer: Buffer.from("not a demo at all") });
  await page.getByTestId("open-match-go").click();
  await expect(page.locator(".landing .error")).toHaveText("Not a replay");
  await page.reload();
  await expect(page.locator(".known")).toHaveCount(0);
});
