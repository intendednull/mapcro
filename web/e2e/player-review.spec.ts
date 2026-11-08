// Player against the review of 2026-11-08 (findings 1–8, 12), on the real server with a fake
// deadlock-api serving the trimmed, anonymised real match (crates/server/tests/fixtures).

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, devices, expect, test } from "@playwright/test";
import { gesture, joinNew, mapPoint } from "./helpers";
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

async function openMatch(p: Page, id = ID) {
  await p.getByTestId("mode-player").click();
  await p.getByTestId("match-id").fill(id);
  await p.getByTestId("match-load").click();
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

test("Player with no timeline shows an empty map, never the scene, and nothing moves (7, 12)", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Empty"), "Coach");
  await expect(a.locator(".mapbox .tok")).toHaveCount(12);
  await openMatch(a, "404");
  await expect(a.getByTestId("match-status")).toHaveText("Not found");
  await expect(a.locator(".mapbox .tok")).toHaveCount(0);
  await expect(a.locator(".stage-head")).toBeHidden();
  await expect(a.getByTestId("scene-note-edit")).toBeHidden();
  await a.getByTestId("mode-sandbox").click();
  await expect(a.locator(".mapbox .tok")).toHaveCount(12);
});

test("Clear in Player clears the live layer, not the scene; entering the live layer is no undo step (2, 8)", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Clear"), "Coach");
  await a.keyboard.press("d");
  await gesture(a, [[0.2, 0.2], [0.3, 0.25]]);
  await expect(strokes(a)).toHaveCount(1);
  await openMatch(a);
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await expect(strokes(a)).toHaveCount(0);
  // The ink from before is still the only undo step: making the live layer added none.
  await a.keyboard.press("d");
  await gesture(a, [[0.6, 0.6], [0.7, 0.65]]);
  await expect(strokes(a)).toHaveCount(1);
  await a.getByTestId("clear-menu").click();
  await a.getByTestId("clear-ink").click();
  await expect(strokes(a)).toHaveCount(0);
  await a.getByTestId("mode-sandbox").click();
  await expect(strokes(a)).toHaveCount(1);
});

test("in Player others see your laser; a follower follows a presenter who pans while playing, at 1x and 8x (3, 4)", async ({ browser }) => {
  const url = await newBoardUrl(server, "Watch");
  const a = await joinNew(browser, url, "Coach");
  await openMatch(a);
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await scrubTo(a, 200);
  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("match-clock")).toHaveText("3:20 / 21:40");

  // A laser in Player shows to the follower in Player.
  await a.getByTestId("tool-laser").click();
  await gesture(a, [[0.3, 0.3], [0.5, 0.5]]);
  await expect(b.locator('.laser[data-laser="Coach"]')).toHaveCount(1);
  await a.getByTestId("tool-move").click();

  for (const speed of ["1", "8"]) {
    await a.getByTestId("match-speed").selectOption(speed);
    await a.getByTestId("match-play").click();
    // The presenter pans as it plays: each pan resends presence with the playback in it.
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const p = await mapPoint(a, 0.5, 0.5);
      await a.mouse.move(p.x, p.y);
      await a.mouse.wheel(0, i % 2 ? 120 : -120);
      await a.waitForTimeout(300);
      seen.push(await clock(b));
    }
    // Never snapped back, and close to the presenter.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!, `${speed}x: ${seen}`).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(Math.abs((await clock(a)) - (await clock(b)))).toBeLessThanOrEqual(Number(speed) + 1);
    await a.getByTestId("match-play").click();
    const stopped = await clock(a);
    await expect.poll(() => clock(b)).toBe(stopped);
  }
});

test("a phone follows a presenter in Player, with the transport (1)", async ({ browser }) => {
  const url = await newBoardUrl(server, "Phone watch");
  const a = await joinNew(browser, url, "Coach");
  await openMatch(a);
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await scrubTo(a, 300);
  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  const ctx = await browser.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined } as never);
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.locator("#join-name").fill("Guest");
  await phone.keyboard.press("Enter");
  await expect(phone.getByTestId("board")).toHaveAttribute("data-layout", "phone");
  await phone.getByTestId("follow-presenter").tap();
  await expect(phone.getByTestId("player")).toBeVisible();
  await expect(phone.getByTestId("match-clock")).toHaveText("5:00 / 21:40");
  // Heroes at the match's places, not stacked: at least two distinct positions.
  const spots = await phone.locator(".p-map .tok").evaluateAll((els) => new Set(els.map((e) => e.getAttribute("transform"))).size);
  expect(spots).toBeGreaterThan(1);
  await scrubTo(a, 600);
  await expect(phone.getByTestId("match-clock")).toHaveText("10:00 / 21:40");
  await a.getByTestId("mode-sandbox").click();
  await expect(phone.getByTestId("player")).toHaveAttribute("data-state", "scene");
});

test("stale ink is cleared when someone enters Player alone, kept while someone is there (5)", async ({ browser }) => {
  const url = await newBoardUrl(server, "Stale");
  const a = await joinNew(browser, url, "Coach");
  await openMatch(a);
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await a.keyboard.press("d");
  await gesture(a, [[0.6, 0.6], [0.7, 0.65]]);
  await expect(strokes(a)).toHaveCount(1);
  // A second person enters while Coach is in Player: the ink stays.
  const b = await joinNew(browser, url, "Marrow");
  await expect(b.getByTestId("player")).toBeVisible();
  await b.waitForTimeout(2000);
  await expect(strokes(b)).toHaveCount(1);
  // Back from a scene keeps it (spec §6b: Back returns to the match as it was).
  await b.getByTestId("mode-sandbox").click();
  await b.getByTestId("mode-player").click();
  await expect(strokes(b)).toHaveCount(1);
  // Everyone leaves; one opens the board again alone: last session's ink is gone.
  await a.close();
  await b.reload();
  await expect(b.getByTestId("player")).toHaveAttribute("data-state", "match");
  await expect(strokes(b)).toHaveCount(0, { timeout: 5000 });
});

test("fifteen events save as fifteen scenes, in transactions within the op cap (6)", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Many"), "Coach");
  await openMatch(a);
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await a.getByTestId("chip-death").click();
  const rows = a.getByTestId("event");
  await expect.poll(() => rows.count()).toBeGreaterThan(15);
  // The last fifteen deaths: late game, every objective down so far rides along in each scene.
  const n = await rows.count();
  for (let i = n - 15; i < n; i++) await rows.nth(i).getByTestId("event-pick").check();
  await a.getByTestId("events-save").click();
  await expect(a.getByTestId("scene-card")).toHaveCount(16);
  await expect(a.getByTestId("events-save")).toHaveCount(0);
  await expect(a.getByTestId("match-status")).toHaveText("");
});
