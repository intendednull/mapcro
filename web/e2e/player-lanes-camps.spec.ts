// The replay tier's zipline colours and jungle camps (spec §6b), on a synthetic replay timeline
// the test hands the server as the worker would: each lane coloured from either end to its
// team's edge with the gap between left bare, and camps showing only their state on the map,
// with when they come back only on hover (a tap on the phone).

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, devices, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
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
  await revealControls(p, "match-id");
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

/** Where the lane's wave handle sits against the colours' gap, in screen pixels: its distance
 * from the gap's middle (between the nearest Amber and Sapphire ends), and the gap's width. */
const waveInGap = (p: Page, lane: string) =>
  p.evaluate((lane) => {
    const g = document.querySelector(`[data-testid=map] svg.lanes g[data-key="${lane}"]`)!;
    const ends = (half: string) => {
      const path = g.querySelector(`path[data-half="${half}"]`) as SVGPathElement;
      const m = path.getScreenCTM()!;
      return [0, path.getTotalLength()].map((l) => {
        const q = path.getPointAtLength(l);
        return new DOMPoint(q.x, q.y).matrixTransform(m);
      });
    };
    let gap = { a: new DOMPoint(), b: new DOMPoint(), d: Infinity };
    for (const a of ends("amber")) for (const b of ends("sapphire")) if (Math.hypot(a.x - b.x, a.y - b.y) < gap.d) gap = { a, b, d: Math.hypot(a.x - b.x, a.y - b.y) };
    const c = document.querySelector(`[data-testid=wave-gap-${lane}]`)!.getBoundingClientRect();
    return { off: Math.hypot(c.x + c.width / 2 - (gap.a.x + gap.b.x) / 2, c.y + c.height / 2 - (gap.a.y + gap.b.y) / 2), gap: gap.d };
  }, lane);

test("Player's lanes are the match's, the wave in their gap; a scene's are its own split (TD-97)", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Lane gap"), "Coach");
  await open(a);
  const mid = a.locator('[data-testid=map] svg.lanes g[data-key="lane4"]');
  // The wave sits where the match's colours leave their gap, and moves with them.
  for (const [t, amber] of [[20, "300"], [80, "600"]] as const) {
    await scrubTo(a, t);
    await expect(mid).toHaveAttribute("data-amber", amber);
    const at = await waveInGap(a, "lane4");
    expect(at.off, `the wave at ${t} s`).toBeLessThan(at.gap / 2);
  }
  // A scene draws its own split, never the open match's colours.
  await revealControls(a, "mode-sandbox");
  await a.getByTestId("mode-sandbox").click();
  await expect(a.locator(".pl-topbar")).toHaveCount(0);
  await expect(mid).toHaveAttribute("data-t", /^\d/);
  await expect(a.locator("[data-testid=map] svg.lanes g[data-amber]")).toHaveCount(0);
});

test("in Player, a split another editor drags on a scene isn't drawn", async ({ browser }) => {
  const url = await newBoardUrl(server, "Lane drag");
  const a = await joinNew(browser, url, "Coach");
  await open(a);
  await scrubTo(a, 20);
  // The side lane has no zipline colours in this match: Player draws its split, the default.
  const side = (p: Page) => p.locator('[data-testid=map] svg.lanes g[data-key="lane6"]');
  await expect(side(a)).not.toHaveAttribute("data-amber");
  const t0 = await side(a).getAttribute("data-t");
  const b = await joinNew(browser, url, "Marrow");
  if (await b.locator(".pl-topbar").count()) {
    await revealControls(b, "mode-sandbox");
    await b.getByTestId("mode-sandbox").click();
  }
  await expect(b.locator(".pl-topbar")).toHaveCount(0);
  // Marrow holds the side lane's wave dragged toward one end.
  const gap = (await b.getByTestId("wave-gap-lane6").boundingBox())!;
  const dest = await side(b).locator('path[data-half="sapphire"]').evaluate((el) => {
    const path = el as SVGPathElement;
    const q = path.getPointAtLength(path.getTotalLength() * 0.5);
    const m = path.getScreenCTM()!;
    return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f };
  });
  await b.mouse.move(gap.x + gap.width / 2, gap.y + gap.height / 2);
  await b.mouse.down();
  await b.mouse.move(dest.x, dest.y, { steps: 10 });
  await expect(b.locator('.lane-raised[data-raised="lane6"]')).toHaveCount(1);
  await expect.poll(async () => Number(await side(b).getAttribute("data-t"))).not.toBe(Number(t0));
  // Presence lands in tens of ms; Player's lane stays the match's.
  await a.waitForTimeout(1000);
  await expect(side(a)).toHaveAttribute("data-t", t0!);
  await b.mouse.up();
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
  await expect(tip).toHaveText("Spawns in 0:10");
  await a.mouse.move(5, 5);
  await noCountdown();

  await scrubTo(a, 45);
  await expect(marker(a, CAMP)).toHaveAttribute("data-camp", "alive");
  await expect(marker(a, CAMP)).toHaveAttribute("data-status", "Active");
  // Up: nothing timed, so no label (operator 2026-11-08).
  await hover(a, CAMP);
  await noCountdown();
  await a.mouse.move(5, 5);

  await scrubTo(a, 70);
  await expect(marker(a, CAMP)).toHaveAttribute("data-camp", "cleared");
  await expect(marker(a, CAMP)).toHaveAttribute("data-status", "Destroyed");
  await noCountdown();
  await hover(a, CAMP);
  await expect(tip).toHaveText("Respawns in 0:25");
  // It counts down with the playback.
  await scrubTo(a, 80);
  await expect(tip).toHaveText("Respawns in 0:15");
  await a.screenshot({ path: "shots/camps-synthetic.png" });

  // The mid boss: down from its clear to the timer's respawn, the same hover.
  await expect(marker(a, BOSS)).toHaveAttribute("data-status", "Destroyed");
  await hover(a, BOSS);
  await expect(tip).toHaveText("Respawns in 0:30");
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
  // The phone keeps its own time: a camp that's up says nothing, else its timer.
  await expect(marker(phone, CAMP)).toHaveAttribute("data-camp", /alive|unspawned|cleared/);
  await expect(phone.getByTestId("hover-label")).toHaveCount(0);
  const b = (await marker(phone, CAMP).boundingBox())!;
  await phone.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  const camp = await marker(phone, CAMP).getAttribute("data-camp");
  if (camp === "alive") await expect(phone.getByTestId("hover-label")).toHaveCount(0);
  else await expect(phone.getByTestId("hover-label")).toHaveText(/^(Spawns|Respawns) in \d:\d\d$/);
  await phone.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await expect(phone.getByTestId("hover-label")).toHaveCount(0);
});
