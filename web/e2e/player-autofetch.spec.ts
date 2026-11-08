// Opening a match by id fetches its full replay on its own (operator, 2026-11-08): the tier chip
// reads "Fetching replay…", then "Queued" (and "Parsing replay…" once the worker starts it), then upgrades in place to "Full replay". A
// match Valve has no replay for settles on "API summary", says why (in the bar and the chip's
// hint), and offers "Try again" and "Upload replay file". A fake deadlock-api and CDN; the test plays the worker.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ROOT, Server } from "./server";

const ID = 130816395;
const NONE = 130816396;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-autofetch-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;
let release!: () => void;
const released = new Promise<void>((ok) => (release = ok));
const hits: string[] = [];

/** The trimmed real metadata as match `id`, started a day ago (inside Valve's three weeks). */
function meta(id: number) {
  const m = JSON.parse(readFileSync(join(ROOT, `crates/server/tests/fixtures/match-130816395-trimmed.json`)).toString());
  m.match_info.match_id = id;
  m.match_info.start_time = Math.floor(Date.now() / 1000) - 86400;
  return JSON.stringify(m);
}

test.beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    const url = req.url ?? "";
    hits.push(url.split("?")[0]!);
    const m = /^\/v1\/matches\/(\d+)\/metadata/.exec(url);
    if (m) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(meta(Number(m[1])));
    }
    if (url === `/v1/matches/${ID}/salts`) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ match_id: ID, cluster_id: 404, replay_salt: 77, metadata_salt: 9 }));
    }
    if (url === `/cdn/404/1422450/${ID}_77.dem.bz2`) {
      // Held until the test has seen the chip say it's fetching.
      await released;
      res.writeHead(200);
      return res.end(Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]));
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_CDN_BASE: `http://127.0.0.1:${port}/cdn`, REPLAY_DIR: queue });
  await server.start();
});
test.afterAll(() => {
  release();
  server.stop();
  upstream.close();
});

const N = 1300;
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
function timeline() {
  return {
    match_id: ID, start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => slot * 300), y: range(() => (team === "amber" ? -8000 : 8000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: [],
  };
}

async function openFromLanding(browser: import("@playwright/test").Browser, id: number) {
  const a = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await a.goto(`${server.url}/`);
  await a.getByTestId("open-match-id").fill(String(id));
  await a.getByTestId("open-match-go").click();
  await a.waitForURL(/\/b\//);
  await a.locator("#join-name").fill("Coach");
  await a.keyboard.press("Enter");
  return a;
}

test("opening a match fetches its replay: the chip goes from fetching to Full replay in place", async ({ browser }) => {
  const a = await openFromLanding(browser, ID);
  const chip = a.getByTestId("match-tier");
  await expect(chip).toHaveText("Fetching replay…");
  await a.screenshot({ path: "shots/autofetch-fetching.png" });
  release();
  // Downloaded: queued for the worker.
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f === `${ID}-cdn.dem`) ?? "")).not.toBe("");
  // Waiting for the worker (the test plays it, and hasn't started it): nothing ahead.
  await expect(chip).toHaveText("Queued");
  writeFileSync(join(queue, "outbox", `${ID}-cdn.json`), JSON.stringify(timeline()));
  await expect(chip).toHaveText("Full replay", { timeout: 15_000 });
  await expect(chip).toHaveAttribute("data-tier", "replay");
  await a.screenshot({ path: "shots/autofetch-full.png" });
  expect(hits.filter((h) => h === `/v1/matches/${ID}/salts`)).toHaveLength(1);
});

test("a match Valve has no replay for settles on the summary, says why, and offers the upload", async ({ browser }) => {
  const a = await openFromLanding(browser, NONE);
  const chip = a.getByTestId("match-tier");
  await expect(chip).toHaveAttribute("data-why", "Replay not found yet");
  await expect(chip).toHaveText("API summary");
  await expect(a.getByTestId("match-notice-text")).toHaveText("Replay not found yet. Try again later, or upload the replay file.");
  await expect(a.getByTestId("match-retry")).toHaveText("Try again");
  await expect(a.getByTestId("match-upload")).toHaveText("Upload replay file");
  await expect(a.getByTestId("match-upload")).toHaveClass(/primary/);
  await chip.click();
  await expect(a.getByTestId("tier-reason")).toHaveText("Replay not found yet");
  await a.screenshot({ path: "shots/autofetch-none.png" });
  // Opened again (a new board): deadlock-api isn't asked again.
  const b = await openFromLanding(browser, NONE);
  await expect(b.getByTestId("match-tier")).toHaveAttribute("data-why", "Replay not found yet");
  expect(hits.filter((h) => h === `/v1/matches/${NONE}/salts`)).toHaveLength(1);
});
