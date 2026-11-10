// Lane shops in Player (docs/research/map-objectives-audit.md, "Shops"): a team's lane shop closes
// as the guardian beside it falls, and the game's minimap no longer shows it; the 2 secret shops
// stay all match. A board shows all 8. On a synthetic replay timeline stamped with TIMELINE_FORMAT.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

/** A synthetic match: no real replay's data. */
const ID = "131000002";
const N = 120;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-shops-"));
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
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6860, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => slot * 300), y: range(() => (team === "amber" ? -8000 : 8000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    // Sapphire's lane 6 guardian falls at 1:00 (its shop is keyed lane1: the map's LaneNum is
    // mirrored on that side), Amber's lane 4 guardian at 1:30, a walker at 1:40.
    objectives: [
      { key: "guardian:sapphire:lane6:1", kind: "guardian", team: "sapphire", lane: 6, destroyed_s: 60 },
      { key: "guardian:amber:lane4:1", kind: "guardian", team: "amber", lane: 4, destroyed_s: 90 },
      { key: "walker:amber:lane1:1", kind: "walker", team: "amber", lane: 1, destroyed_s: 100 },
    ],
    mid_boss: [], rifts: [], powerups: [], events: [], zips: [], camps: [], heals: [],
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

const shops = (p: Page) => p.locator("[data-testid=map] .mk.shop");
const shop = (p: Page, key: string) => p.locator(`[data-testid=map] .mk.shop[data-key="${key}"]`);

test("in Player a lane shop is gone once its guardian falls; the secret shops and the board keep theirs", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Shops"), "Coach");
  await expect(shops(a)).toHaveCount(8);
  await open(a);
  await scrubTo(a, 59);
  await expect(shops(a)).toHaveCount(8);
  await a.screenshot({ path: "shots/shops-before-guardian.png" });
  await scrubTo(a, 60);
  await expect(shop(a, "shop:sapphire:lane1:1")).toHaveCount(0);
  await expect(shops(a)).toHaveCount(7);
  await a.screenshot({ path: "shots/shops-after-guardian.png" });
  await scrubTo(a, 100);
  await expect(shop(a, "shop:amber:lane4:1")).toHaveCount(0);
  await expect(shops(a)).toHaveCount(6);
  await expect(shop(a, "shop:neutral:lane1:1")).toHaveCount(1);
  await expect(shop(a, "shop:neutral:lane6:1")).toHaveCount(1);
  // Back before the fall, the shop is up again.
  await scrubTo(a, 30);
  await expect(shops(a)).toHaveCount(8);
  await scrubTo(a, 100);
  await expect(shops(a)).toHaveCount(6);
  // The board is the map, not the match: every shop.
  await a.getByTestId("mode-sandbox").click();
  await expect(shops(a)).toHaveCount(8);
});
