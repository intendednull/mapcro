// Player's events list on the real server (spec §6b), with a fake deadlock-api serving the
// trimmed, anonymised real match (crates/server/tests/fixtures): search by type, hero, team and
// time; filter chips; jump with a lead and a highlight; several events saved as scenes in one
// transaction, which one undo removes.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
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
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-e2e-player-")) });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const events = (p: Page) => p.getByTestId("event");
const times = (p: Page) => events(p).evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-t"))));

test("events: search, filter, jump, and save several as scenes with one undo", async ({ browser }) => {
  const url = await newBoardUrl(server, "Events");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  // 42 deaths and 9 objectives in the fixture, souls swings on top; every row says its tier.
  await expect.poll(async () => (await times(a)).length).toBeGreaterThan(50);

  // Search by type, by team, by time; filter chips by type.
  await a.getByTestId("events-search").fill("walker");
  await expect.poll(() => times(a)).toEqual([899, 1005, 1169]);
  await a.getByTestId("events-search").fill("sapphire walker");
  await expect.poll(() => times(a)).toEqual([1005, 1169]);
  await a.getByTestId("events-search").fill("6:22");
  await expect.poll(() => times(a)).toEqual([382]);
  await a.getByTestId("events-search").fill("");
  await a.getByTestId("chip-objective").click();
  await expect.poll(async () => (await times(a)).length).toBe(9);
  await a.getByTestId("chip-objective").click();
  await a.getByTestId("chip-death").click();
  await expect.poll(async () => (await times(a)).length).toBe(42);
  // Search by hero: Amber's third player's hero (20, a fallback name without a pack).
  // Every word must match somewhere (the hero, or a clock with "20" in it).
  await a.getByTestId("events-search").fill("hero 20 died");
  await expect.poll(() => times(a)).toEqual(expect.arrayContaining([382, 599, 879, 1207]));
  await a.getByTestId("events-search").fill("hero 20 6:22");
  await expect.poll(() => times(a)).toEqual([382]);

  // Jump: a lead before the event, the scrubber there, the place highlighted.
  await a.getByTestId("events-lead").fill("8");
  await events(a).first().getByTestId("event-jump").click();
  await expect(a.getByTestId("match-clock")).toHaveText("6:14 / 21:40");
  await expect(a.getByTestId("event-highlight")).toBeVisible();
  await a.getByTestId("events-lead").fill("5");

  // Multi-select: three events, three scenes, one transaction.
  const cards = a.getByTestId("scene-card");
  await expect(cards).toHaveCount(1);
  await a.getByTestId("events-search").fill("");
  await a.getByTestId("chip-death").click();
  await a.getByTestId("chip-objective").click();
  for (const i of [0, 1, 2]) await events(a).nth(i).getByTestId("event-pick").check();
  await a.getByTestId("events-save").click();
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(1)).toHaveAttribute("aria-label", /^Scene 2: 8:44 Guardian down$/);
  await expect(cards.nth(2)).toHaveAttribute("aria-label", /^Scene 3: 9:14 Guardian down$/);
  await expect(cards.nth(3)).toHaveAttribute("aria-label", /^Scene 4: 9:59 Guardian down$/);
  await a.getByTestId("mode-sandbox").click();
  await a.getByTestId("undo").click();
  await expect(cards).toHaveCount(1);
});

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}

test("Player draws only the match, Sandbox only the scene, and neither leaks into the other", async ({ browser }) => {
  const url = await newBoardUrl(server, "Modes");
  const a = await joinNew(browser, url, "Coach");
  const x = a.locator('.mapbox .tok[data-slot="Amber-2"]');
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");

  // Amber-2 dies at 382 s: hidden in Player.
  await scrubTo(a, 386);
  await expect(x).toHaveCount(0);
  // Sandbox shows the scene's record: there, alive and not dark.
  await a.getByTestId("mode-sandbox").click();
  await expect(x).toHaveCount(1);
  await expect(x).not.toHaveClass(/\bdead\b/);
  // Back in Player at a time it's alive: drawn, not dark.
  await a.getByTestId("mode-player").click();
  await scrubTo(a, 120);
  await expect(x).toHaveCount(1);
  await expect(x).not.toHaveClass(/\bdead\b/);

  // A scene saved while it's dead holds it dead; Player over that scene still draws the match.
  await scrubTo(a, 386);
  await a.getByTestId("match-save").click();
  await expect(a.getByTestId("scene-card")).toHaveCount(2);
  await scrubTo(a, 120);
  await expect(x).toHaveCount(1);
  await expect(x).not.toHaveClass(/\bdead\b/);
  await a.getByTestId("mode-sandbox").click();
  await expect(x).toHaveClass(/\bdead\b/);
  await a.getByTestId("scene-card").nth(0).click();
  await expect(x).not.toHaveClass(/\bdead\b/);
});

const clock = async (p: Page) => {
  const [m, s] = ((await p.getByTestId("match-clock").textContent()) ?? "").split(" / ")[0]!.split(":").map(Number);
  return m! * 60 + s!;
};

test("a follower mirrors the presenter's playback and mode; its own scrub stops following", async ({ browser }) => {
  const url = await newBoardUrl(server, "Watch party");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await scrubTo(a, 300);

  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  // Paused: the same moment.
  await expect(b.getByTestId("match-clock")).toHaveText("5:00 / 21:40");
  // Playing at 8×: the follower runs along, within a second or two.
  await a.getByTestId("match-speed").selectOption("8");
  await a.getByTestId("match-play").click();
  await a.waitForTimeout(1500);
  await expect.poll(async () => Math.abs((await clock(a)) - (await clock(b)))).toBeLessThan(3);
  expect(await clock(b)).toBeGreaterThan(305);
  await expect(b.getByTestId("match-speed")).toHaveValue("8");
  await a.getByTestId("match-play").click();
  const stopped = await clock(a);
  await expect.poll(() => clock(b)).toBe(stopped);
  // The presenter's mode carries.
  await a.getByTestId("mode-sandbox").click();
  await expect(b.getByTestId("player")).toHaveAttribute("data-state", "scene");
  await a.getByTestId("mode-player").click();
  await expect(b.getByTestId("player")).toBeVisible();
  // The follower's own scrub stops following, and says so.
  await scrubTo(b, 60);
  await expect(b.getByTestId("toast")).toContainText("Stopped following Coach");
  await scrubTo(a, 900);
  await b.waitForTimeout(500);
  expect(await clock(b)).toBe(60);
});

test("the landing page opens a match, by id or by replay, straight into Player", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(server.url);
  await page.getByTestId("open-match-id").fill(ID);
  await page.getByTestId("open-match-go").click();
  await page.locator("#join-name").fill("Coach");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("player")).toBeVisible();
  await expect(page.getByTestId("match-tier")).toHaveText("API summary");
  await expect(page.getByTestId("match-clock")).toHaveText("10:00 / 21:40");
  // Sandbox and back: the board keeps its match.
  await page.getByTestId("mode-sandbox").click();
  await page.reload();
  await expect(page.getByTestId("player")).toBeVisible();

  // A replay alone (named after its match, as the game saves them): uploaded, then queued.
  await page.goto(server.url);
  const demo = Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(64 * 1024, 7)]);
  await page.getByTestId("open-match-file").setInputFiles({ name: "122134063.dem", mimeType: "application/octet-stream", buffer: demo });
  await page.getByTestId("open-match-go").click();
  await page.locator("#join-name").or(page.getByTestId("player")).first().waitFor();
  if (await page.locator("#join-name").isVisible()) {
    await page.locator("#join-name").fill("Coach");
    await page.keyboard.press("Enter");
  }
  await expect(page.getByTestId("player")).toBeVisible();
  await expect(page.getByTestId("match-job")).toHaveText("Queued");
  await expect(page.getByTestId("match-id")).toHaveValue("122134063");
});

test("ink over playback is live, kept only by saving a scene, and cleared when the last leaves", async ({ browser }) => {
  const url = await newBoardUrl(server, "Annotate");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const strokes = (p: Page) => p.locator(".mapbox [data-stroke]");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await scrubTo(a, 400);

  await a.keyboard.press("d");
  await gesture(a, [[0.3, 0.3], [0.4, 0.35], [0.5, 0.3]]);
  await expect(strokes(a)).toHaveCount(1);
  // Not on the scene: B, in Sandbox, doesn't see it; in Player, B does, live.
  await expect(strokes(b)).toHaveCount(0);
  await expect(b.getByTestId("scene-card")).toHaveCount(1);
  await b.getByTestId("mode-player").click();
  await expect(strokes(b)).toHaveCount(1);

  // Saving moves it into the new scene, and the live layer is clear again.
  await a.getByTestId("match-save").click();
  await expect(a.getByTestId("scene-card")).toHaveCount(2);
  await expect(strokes(a)).toHaveCount(0);
  await expect(strokes(b)).toHaveCount(0);
  await b.getByTestId("mode-sandbox").click();
  await b.getByTestId("scene-card").nth(1).click();
  await expect(strokes(b)).toHaveCount(1);
  await expect(b.getByTestId("scene-card").nth(1)).toHaveAttribute("aria-label", /^Scene 2: 6:40 Match moment$/);

  // Unsaved ink stays while someone is in Player, and through viewing a scene and coming
  // Back; it goes when the board is opened again with nobody watching the match.
  await b.getByTestId("mode-player").click();
  await a.keyboard.press("d");
  await gesture(a, [[0.6, 0.6], [0.65, 0.62]]);
  await expect(strokes(b)).toHaveCount(1);
  await a.getByTestId("mode-sandbox").click();
  await expect(strokes(b)).toHaveCount(1);
  await b.getByTestId("mode-sandbox").click();
  await a.getByTestId("mode-player").click();
  await expect(strokes(a)).toHaveCount(1);
  await a.getByTestId("mode-sandbox").click();
  await a.reload();
  await expect(a.getByTestId("player")).toHaveAttribute("data-state", "match");
  await expect(strokes(a)).toHaveCount(0, { timeout: 5000 });
});
