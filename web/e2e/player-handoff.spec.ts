// Moving between scenes and the match on a board with a match (spec §6b, operator 2026-11-08):
// the bar never goes; it watches the match or says which scene is shown, with Play from here
// and Back. Asserted on screen; screenshots in shots/.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, devices, expect, test } from "@playwright/test";
import { gesture, joinNew } from "./helpers";
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

async function openMatch(p: Page) {
  await p.getByTestId("mode-player").click();
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await expect(p.getByTestId("match-tier")).toHaveText("API summary");
}
async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}
const clock = async (p: Page) => {
  const [m, s] = ((await p.getByTestId("match-clock").textContent()) ?? "").split(" / ")[0]!.split(":").map(Number);
  return m! * 60 + s!;
};
const strokes = (p: Page) => p.locator(".mapbox [data-stroke], .p-map [data-stroke]");
const bar = (p: Page) => p.getByTestId("player");

/** A board with one scene saved from the match at 5:00, carrying one stroke. */
async function boardWithScene(browser: import("@playwright/test").Browser) {
  const url = await newBoardUrl(server, "Handoff");
  const a = await joinNew(browser, url, "Coach");
  await openMatch(a);
  await scrubTo(a, 300);
  await a.keyboard.press("d");
  await gesture(a, [[0.3, 0.3], [0.45, 0.35]]);
  await expect(strokes(a)).toHaveCount(1);
  await a.keyboard.press("v");
  await a.getByTestId("match-save").click();
  await expect(a.getByTestId("scene-card")).toHaveCount(2);
  await expect(strokes(a)).toHaveCount(0); // moved into the scene
  return { url, a };
}

test("viewing a scene keeps the bar; Back returns to the match where it was", async ({ browser }) => {
  const { a } = await boardWithScene(browser);
  await scrubTo(a, 640);
  await a.getByTestId("scene-card").nth(1).click();
  await expect(bar(a)).toHaveAttribute("data-state", "scene");
  await expect(a.getByTestId("pl-scene")).toHaveText("Scene “Match moment” · 5:00");
  await expect(a.getByTestId("play-from-here")).toBeVisible();
  await expect(a.getByTestId("mode-player")).toHaveText("↩ Back to 10:40");
  await expect(strokes(a)).toHaveCount(1); // the scene's drawing
  await a.screenshot({ path: "shots/handoff-scene.png" });
  // A scene with no source for this match: no Play from here.
  await a.getByTestId("scene-card").nth(0).click();
  await expect(bar(a)).toHaveAttribute("data-state", "scene");
  await expect(a.getByTestId("play-from-here")).toHaveCount(0);
  await a.getByTestId("mode-player").click();
  await expect(bar(a)).toHaveAttribute("data-state", "match");
  await expect(a.getByTestId("match-clock")).toHaveText("10:40 / 21:40");
});

test("Play from here: the scene's drawings over the match, playing from its moment; Clear never touches the scene", async ({ browser }) => {
  const { a } = await boardWithScene(browser);
  await scrubTo(a, 900);
  await a.getByTestId("scene-card").nth(1).click();
  await a.getByTestId("play-from-here").click();
  await expect(bar(a)).toHaveAttribute("data-state", "match");
  await expect(a.getByTestId("match-play")).toHaveText("Pause");
  const t = await clock(a);
  expect(t).toBeGreaterThanOrEqual(300);
  expect(t).toBeLessThan(310);
  await expect(strokes(a)).toHaveCount(1); // a copy, on the live layer
  await a.screenshot({ path: "shots/handoff-play-from-here.png" });
  await a.getByTestId("match-play").click();
  await a.getByTestId("clear-menu").click();
  await a.getByTestId("clear-ink").click();
  await expect(strokes(a)).toHaveCount(0);
  await a.getByTestId("scene-card").nth(1).click();
  await expect(strokes(a)).toHaveCount(1); // the scene's own, untouched
});

test("the tree chip and the scrubber marker each do their job; ← → follow the map's content", async ({ browser }) => {
  const { a } = await boardWithScene(browser);
  await scrubTo(a, 1000);
  // The chip jumps the match to the scene's moment without leaving it.
  await a.getByTestId("scene-chip").click();
  await expect(bar(a)).toHaveAttribute("data-state", "match");
  await expect(a.getByTestId("match-clock")).toHaveText("5:00 / 21:40");
  // A marker on the scrubber views its scene.
  await expect(a.getByTestId("scene-mark")).toHaveCount(1);
  await expect(a.getByTestId("scene-mark")).toHaveAttribute("title", "Match moment");
  await a.getByTestId("scene-mark").click();
  await expect(bar(a)).toHaveAttribute("data-state", "scene");
  await expect(a.locator('[data-testid="scene-card"][aria-current="true"]')).toHaveAttribute("aria-label", /^Scene 2: 5:00 Match moment$/);
  // Viewing scenes: ← → step scenes.
  await a.keyboard.press("ArrowLeft");
  await expect(a.locator('[data-testid="scene-card"][aria-current="true"]')).toHaveAttribute("aria-label", /^Scene 1:/);
  await expect(bar(a)).toHaveAttribute("data-state", "scene");
  // Watching: ← → step events.
  await a.getByTestId("mode-player").click();
  await expect(bar(a)).toHaveAttribute("data-state", "match");
  const t0 = await clock(a);
  await a.keyboard.press("ArrowRight");
  await expect.poll(() => clock(a)).toBeGreaterThan(t0);
  const t1 = await clock(a);
  await expect(a.getByTestId("event-highlight")).toBeVisible();
  await expect(a.locator('[data-testid="scene-card"][aria-current="true"]')).toHaveAttribute("aria-label", /^Scene 1:/);
  await a.keyboard.press("ArrowLeft");
  await expect.poll(() => clock(a)).toBeLessThan(t1);
});

test("a follower switches between the match and scenes with the presenter", async ({ browser }) => {
  const { url, a } = await boardWithScene(browser);
  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  await a.getByTestId("scene-card").nth(1).click();
  await expect(bar(b)).toHaveAttribute("data-state", "scene");
  await expect(b.locator('[data-testid="scene-card"][aria-current="true"]')).toHaveAttribute("aria-label", /^Scene 2: 5:00 Match moment$/);
  await expect(strokes(b)).toHaveCount(1);
  await a.getByTestId("play-from-here").click();
  await expect(bar(b)).toHaveAttribute("data-state", "match");
  await expect.poll(async () => Math.abs((await clock(a)) - (await clock(b)))).toBeLessThan(3);
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
});

test("on a phone the bar shows in both states", async ({ browser }) => {
  const { url } = await boardWithScene(browser);
  const ctx = await browser.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined } as never);
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.locator("#join-name").fill("Guest");
  await phone.keyboard.press("Enter");
  await expect(phone.getByTestId("board")).toHaveAttribute("data-layout", "phone");
  await expect(bar(phone)).toHaveAttribute("data-state", "match");
  await phone.screenshot({ path: "shots/handoff-phone-match.png" });
  await phone.getByTestId("mode-sandbox").tap();
  await expect(bar(phone)).toHaveAttribute("data-state", "scene");
  await expect(phone.getByTestId("mode-player")).toBeVisible();
  await phone.screenshot({ path: "shots/handoff-phone-scene.png" });
  await phone.getByTestId("mode-player").tap();
  await expect(bar(phone)).toHaveAttribute("data-state", "match");
});
