// The load tier, in words (operator, 2026-11-08): "API summary" for the metadata, "Full replay"
// for a parsed replay, the upgrade's progress in between, in place: the playback keeps its time,
// and a follower upgrades too. The test plays the worker through its outbox (the queue's
// contract; a real demo can't be committed).

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, useSummary } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";

const ID = "130816395";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-tier-"));
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
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const N = 1300;
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
const heroes = { amber: [67, 7, 20, 77, 27, 80], sapphire: [17, 63, 6, 13, 12, 76] };
/** A replay timeline for the fixture's match, as the worker writes it. */
function replayTimeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0, format: 1,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      heroes[team].map((hero_id, slot) => ({
        team, slot, hero_id, name: null,
        x: range(() => (team === "amber" ? -2000 : 2000) + slot * 400),
        y: range((s) => (team === "amber" ? -5000 : 5000) + s),
        health: range(() => 100), deaths: [], souls: [[0, 500]],
        ult: range((s) => (slot === 0 ? Math.max(0, 100 - (s % 120)) : 0)),
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: [],
  };
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}

test("the chip names the tier; an upload upgrades it in place, keeping the time, for a follower too", async ({ browser }) => {
  const url = await newBoardUrl(server, "Tier");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  const chip = (p: Page) => p.getByTestId("match-tier");
  await expect(chip(a)).toHaveText("API summary");
  await useSummary(a);
  await expect(a.getByTestId("match-upload")).toHaveText("Upload replay file");
  // For the coach who opened it, the chip brings the full-replay prompt back (spec §6b).
  await expect(chip(a)).toHaveAttribute("title", "Full replay unavailable: upload or try again");
  await scrubTo(a, 300);
  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  await expect(chip(b)).toHaveText("API summary");
  // For everyone else it says what the summary lacks.
  await chip(b).click();
  await expect(b.getByTestId("tier-why")).toContainText("No health, ult timers, zipline colours, camps, rifts or powerups");
  await b.screenshot({ path: "shots/tier-api-summary.png" });
  await expect(b.getByTestId("match-clock")).toHaveText("5:00 / 21:40");

  // Another match's file is refused by its name.
  await a.getByTestId("match-file").setInputFiles({ name: "999.dem", mimeType: "application/octet-stream", buffer: Buffer.from("PBDEMS2\0x", "binary") });
  await expect(a.getByTestId("match-status")).toHaveText(`That file is match 999, not ${ID}`);

  const demo = Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(64 * 1024, 7)]);
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: demo });
  await expect(chip(a)).toHaveText("Queued");
  await a.screenshot({ path: "shots/tier-parsing.png" });
  // The worker's result arrives.
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(replayTimeline()));
  await expect(chip(a)).toHaveText("Full replay");
  await expect(chip(a)).toHaveClass(/\breplay\b/);
  await expect(a.getByTestId("match-clock")).toHaveText("5:00 / 21:40");
  await expect(a.getByTestId("match-upload")).toHaveCount(0);
  await a.screenshot({ path: "shots/tier-full-replay.png" });
  // The follower upgrades too (it's watching the same board's match), and stays on the time.
  await expect(chip(b)).toHaveText("Full replay", { timeout: 15000 });
  await expect(b.getByTestId("match-clock")).toHaveText("5:00 / 21:40");
});
