// Health on the replay tier (operator, 2026-11-08): a thin bar under each top-bar portrait, an
// arc on each hero token, a ring round a damaged objective (the patron with its stage), all
// following the timeline; a Health toggle; none on the API summary. A synthetic timeline the
// test hands the server as the worker would.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
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
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0,
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
const barWidth = (p: Page) => bar(p).evaluate((el) => (el.firstElementChild as HTMLElement).getBoundingClientRect().width / el.getBoundingClientRect().width);

test("health bars, token arcs and objective rings follow the replay; Health turns them off", async ({ browser }) => {
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
  // Undamaged objectives have no ring.
  await expect(a.getByTestId("obj-health")).toHaveCount(0);
  await scrubTo(a, 45);
  await expect(bar(a)).toHaveAttribute("data-health", "55");
  await expect.poll(() => barWidth(a)).toBeCloseTo(0.55, 1);
  await expect(a.locator('[data-testid=obj-health][data-key="walker:amber:lane1:1"]')).toHaveAttribute("data-health", "25");
  await expect(a.locator('[data-testid=obj-health][data-key="patron:sapphire:lane0:1"]')).toHaveAttribute("data-stage", "1");
  await a.screenshot({ path: "shots/health-synthetic.png" });
  await scrubTo(a, 65);
  await expect(a.locator('[data-testid=obj-health][data-key="patron:sapphire:lane0:1"]')).toHaveAttribute("data-stage", "2");
  await expect(a.locator('[data-testid=obj-health][data-key="patron:sapphire:lane0:1"] text')).toHaveText("Stage 2");
  // Dead: the bar is empty, red.
  await scrubTo(a, 110);
  await expect(bar(a)).toHaveAttribute("data-health", "0");
  await expect(bar(a)).toHaveClass(/\blow\b/);

  await scrubTo(a, 45);
  await a.getByTestId("health-toggle").click();
  await expect(bar(a)).toHaveCount(0);
  await expect(a.locator("[data-testid=tok-health]")).toHaveCount(0);
  await expect(a.getByTestId("obj-health")).toHaveCount(0);
});
