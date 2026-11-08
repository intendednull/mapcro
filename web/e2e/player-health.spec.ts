// Health on the replay tier (operator, 2026-11-08): a thin bar under each top-bar portrait, an
// arc on each hero token, each objective's icon filled from the bottom up to its health (the
// patron's shield in stage 1, its core in stage 2), all following the timeline; a Health
// toggle; none on the API summary. A synthetic timeline the
// test hands the server as the worker would.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

const ID = "129000001";
const N = 120;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-health-"));
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

/** Amber's first hero loses health from 100 to 20 over the match and dies at 100 s. */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0, format: 1,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const tracked = team === "amber" && slot === 0;
        const alive = (s: number) => !tracked || s < 100;
        return {
          team, slot, hero_id: 1 + slot, name: null,
          x: range((s) => (alive(s) ? slot * 600 - 1500 : null)),
          y: range((s) => (alive(s) ? (team === "amber" ? -3000 : 3000) : null)),
          health: range((s) => (!alive(s) ? 0 : tracked ? Math.max(20, 100 - s) : 100)),
          deaths: tracked ? [100] : [], souls: [[0, 500]], ult: range(() => 0),
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: [],
    objective_health: [
      { key: "walker:amber:lane1:1", at: [[0, 100], [20, 60], [40, 25]] },
      { key: "patron:sapphire:lane0:1", at: [[0, 100], [30, 50], [50, 100], [60, 40]], stage: [[0, 1], [50, 2]] },
    ],
  };
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}
const bar = (p: Page) => p.locator('.tb-player[data-slot="Amber-0"] [data-testid=tb-health]');
const mk = (p: Page, key: string) => p.locator(`.mk[data-key="${key}"]`);
/**
 * How much of an objective's icon is filled, in percent of its shape: the part of its fill
 * layer's shape (`data-span`, the shape's top and bottom in its box) the clip leaves showing.
 */
const fill = (p: Page, key: string, layer = "hp-fill") =>
  mk(p, key).locator(`i.${layer}`).first().evaluate((el) => {
    const [top, bottom] = (el.getAttribute("data-span") ?? "0 1").split(" ").map(Number) as [number, number];
    const m = /^inset\((.*)\)$/.exec(getComputedStyle(el).clipPath);
    if (!m) return 100;
    const v = m[1]!.split(" ").map((x) => parseFloat(x) / 100);
    const [cutTop, cutBottom] = [v[0]!, v[2] ?? v[0]!];
    // Clipped from the top (filling up), or from the bottom for a layer drawn rotated.
    const lit = cutTop > 0 ? bottom - Math.max(top, cutTop) : Math.min(bottom, 1 - cutBottom) - top;
    return Math.round((Math.max(0, lit) / (bottom - top)) * 100);
  });
const barWidth = (p: Page) => bar(p).evaluate((el) => (el.firstElementChild as HTMLElement).getBoundingClientRect().width / el.getBoundingClientRect().width);

test("health bars, token arcs and objective fills follow the replay; Health turns them off", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Health"), "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");

  // Two times: the bar's fill and the token's arc follow the data.
  await scrubTo(a, 10);
  await expect(bar(a)).toHaveAttribute("data-health", "90");
  await expect.poll(() => barWidth(a)).toBeCloseTo(0.9, 1);
  await expect(a.locator('.tok[data-slot="Amber-0"] [data-testid=tok-health]')).toHaveAttribute("data-health", "90");
  // Undamaged objectives are full.
  await expect(mk(a, "walker:amber:lane1:1")).toHaveAttribute("data-health", "100");
  expect(await fill(a, "walker:amber:lane1:1")).toBe(100);
  await scrubTo(a, 45);
  await expect(bar(a)).toHaveAttribute("data-health", "55");
  await expect.poll(() => barWidth(a)).toBeCloseTo(0.55, 1);
  // The walker's icon is a quarter full; the patron's shield (stage 1) half.
  await expect(mk(a, "walker:amber:lane1:1")).toHaveAttribute("data-health", "25");
  expect(await fill(a, "walker:amber:lane1:1")).toBeCloseTo(25, 0);
  await expect(mk(a, "patron:sapphire:lane0:1")).not.toHaveClass(/\bstage2\b/);
  expect(await fill(a, "patron:sapphire:lane0:1")).toBeCloseTo(50, 0);
  expect(await fill(a, "patron:sapphire:lane0:1", "hp-core")).toBe(100);
  await a.screenshot({ path: "shots/health-synthetic.png" });
  await scrubTo(a, 65);
  // Stage 2: the shield is gone and the core fills to the health.
  await expect(mk(a, "patron:sapphire:lane0:1")).toHaveClass(/\bstage2\b/);
  expect(await fill(a, "patron:sapphire:lane0:1", "hp-core")).toBeCloseTo(40, 0);
  // Dead: the bar is empty, red.
  await scrubTo(a, 110);
  await expect(bar(a)).toHaveAttribute("data-health", "0");
  await expect(bar(a)).toHaveClass(/\blow\b/);

  await scrubTo(a, 45);
  await a.getByTestId("health-toggle").click();
  await expect(bar(a)).toHaveCount(0);
  await expect(a.locator("[data-testid=tok-health]")).toHaveCount(0);
  await expect(a.locator(".mk[data-health]")).toHaveCount(0);
  expect(await fill(a, "walker:amber:lane1:1")).toBe(100);
});
