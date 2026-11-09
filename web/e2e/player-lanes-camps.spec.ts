// The replay tier's zipline colours and jungle camps (spec §6b), on a synthetic replay timeline
// the test hands the server as the worker would: each lane coloured from either end to its
// team's edge with the gap between left bare, and camps showing only their state on the map,
// with when they come back only on hover (a tap on the phone).

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, devices, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

const ID = "122134063";
const N = 120;
const CAMP = "camp:neutral:lane0:3";
const BOSS = "mid_boss:neutral:lane0:1";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-lanes-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => slot * 300), y: range(() => (team === "amber" ? -8000 : 8000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    objectives: [], mid_boss: [{ destroyed_s: 50, team_killed: "unknown" }], rifts: [], powerups: [], events: [],
    // Mid: Amber to 300 and Sapphire from 700, then Amber to 600 and Sapphire from 650.
    zips: [
      { lane: "lane4", at: [[0, 300, 700], [40, 600, 650]] },
      { lane: "lane1", at: [[0, 0, 1000]] },
    ],
    camps: [
      { key: CAMP, first_s: 30, cleared: [[60, 95]] },
      { key: BOSS, first_s: 0, cleared: [[50, 110]] },
    ],
  };
}

async function open(p: Page) {
  await p.getByTestId("mode-player").click();
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}

/** The drawn lengths of a lane's Amber and Sapphire parts, in map units. */
const halves = (p: Page, lane: string) =>
  p.locator(`[data-testid=map] svg.lanes g[data-key="${lane}"]`).evaluate((g) => {
    const len = (h: string) => (g.querySelector(`path[data-half="${h}"]`) as SVGPathElement | null)?.getTotalLength() ?? 0;
    return { amber: len("amber"), sapphire: len("sapphire") };
  });

const marker = (p: Page, key: string) => p.locator(`[data-testid=map] .mk[data-key="${key}"]`);

async function hover(p: Page, key: string) {
  const b = (await marker(p, key).boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}

test("lanes take the zipline colours: each team to its edge, the gap bare", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Lanes"), "Coach");
  await open(a);
  await scrubTo(a, 20);
  await expect(a.locator('[data-testid=map] svg.lanes g[data-key="lane4"]')).toHaveAttribute("data-amber", "300");
  const early = await halves(a, "lane4");
  await scrubTo(a, 80);
  await expect(a.locator('[data-testid=map] svg.lanes g[data-key="lane4"]')).toHaveAttribute("data-amber", "600");
  const late = await halves(a, "lane4");
  // Late, 60% Amber and 35% Sapphire of the lane: that gives the lane's length.
  const total = (late.amber + late.sapphire) / 0.95;
  expect(late.amber / total).toBeCloseTo(0.6, 1);
  expect(late.sapphire / total).toBeCloseTo(0.35, 1);
  // Early, 30% each, with the middle 40% bare.
  expect(early.amber / total).toBeCloseTo(0.3, 1);
  expect(early.sapphire / total).toBeCloseTo(0.3, 1);
  // A lane neither team owns any of is uncoloured end to end.
  expect(await halves(a, "lane1")).toEqual({ amber: 0, sapphire: 0 });
  await expect(a.getByTestId("match-stale")).toHaveCount(0);
  await a.screenshot({ path: "shots/lanes-synthetic.png" });
});

test("camps show their state; when they come back shows only on hover", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Camps"), "Coach");
  await open(a);
  const tip = a.getByTestId("hover-label");
  const noCountdown = async () => {
    await expect(tip).toHaveCount(0);
    await expect(a.getByText(/Respawns in|Spawns in/)).toHaveCount(0);
  };

  await scrubTo(a, 20);
  await expect(marker(a, CAMP)).toHaveAttribute("data-camp", "unspawned");
  await noCountdown();
  await hover(a, CAMP);
  await expect(tip).toHaveText("Spawns in 0:10 (at 0:30)");
  await a.mouse.move(5, 5);
  await noCountdown();

  await scrubTo(a, 45);
  await expect(marker(a, CAMP)).toHaveAttribute("data-camp", "alive");
  await expect(marker(a, CAMP)).toHaveAttribute("data-status", "Active");

  await scrubTo(a, 70);
  await expect(marker(a, CAMP)).toHaveAttribute("data-camp", "cleared");
  await expect(marker(a, CAMP)).toHaveAttribute("data-status", "Destroyed");
  await noCountdown();
  await hover(a, CAMP);
  await expect(tip).toHaveText("Respawns in 0:25 (at 1:35)");
  // It counts down with the playback.
  await scrubTo(a, 80);
  await expect(tip).toHaveText("Respawns in 0:15 (at 1:35)");
  await a.screenshot({ path: "shots/camps-synthetic.png" });

  // The mid boss: down from its clear to the timer's respawn, the same hover.
  await expect(marker(a, BOSS)).toHaveAttribute("data-status", "Destroyed");
  await hover(a, BOSS);
  await expect(tip).toHaveText("Mid boss respawns in 0:30 (at 1:50)");
  await a.mouse.move(5, 5);
  await noCountdown();

  await scrubTo(a, 100);
  await expect(marker(a, CAMP)).toHaveAttribute("data-camp", "alive");
  await expect(marker(a, BOSS)).toHaveAttribute("data-status", "Destroyed");
  await scrubTo(a, 115);
  await expect(marker(a, BOSS)).toHaveAttribute("data-status", "Active");

  // On a phone, a tap shows it and another hides it.
  const ctx = await browser.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined } as never);
  const phone = await ctx.newPage();
  await phone.goto(a.url());
  await phone.locator("#join-name").fill("Guest");
  await phone.keyboard.press("Enter");
  await expect(phone.getByTestId("board")).toHaveAttribute("data-layout", "phone");
  await expect(marker(phone, CAMP)).toHaveAttribute("data-camp", /alive|unspawned|cleared/);
  await expect(phone.getByTestId("hover-label")).toHaveCount(0);
  const b = (await marker(phone, CAMP).boundingBox())!;
  await phone.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await expect(phone.getByTestId("hover-label")).toHaveText(/^(Up|Spawns in \d:\d\d \(at 0:30\)|Respawns in \d:\d\d \(at 1:35\))$/);
  await phone.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await expect(phone.getByTestId("hover-label")).toHaveCount(0);
});
