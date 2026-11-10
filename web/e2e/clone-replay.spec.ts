// A clone keeps the board's match (operator, 2026-11-09: "we lose the replay player when we
// clone a board"). The match list and an uploaded replay live beside the board, keyed by its id,
// so Clone has to carry them: the copy opens in Player on the same match, at the same tier,
// without fetching or parsing again. The test plays the worker through its outbox (the queue's
// contract; a real demo can't be committed).

import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { ROOT, Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

const ID = "130816395";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-clone-replay-"));
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
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      heroes[team].map((hero_id, slot) => ({
        team, slot, hero_id, name: null,
        x: range(() => (team === "amber" ? -2000 : 2000) + slot * 400),
        y: range((s) => (team === "amber" ? -5000 : 5000) + s),
        health: range(() => 100), deaths: [], souls: [[0, 500]],
        ult: range(() => 0),
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: [],
  };
}

const chip = (p: Page) => p.getByTestId("match-tier");

/** Clone the board from the top bar, and land on the copy. */
async function cloneIt(p: Page, title: string) {
  const from = new URL(p.url()).pathname;
  await p.getByTestId("clone").click();
  await p.locator("#clone-title").fill(title);
  await p.getByTestId("clone-go").click();
  await p.waitForURL((u) => u.pathname !== from);
  await expect(p.getByTestId("board-title")).toHaveText(title);
}

test("a clone opens in Player on the source's uploaded replay, at full tier, with no new parse", async ({ browser }) => {
  const url = await newBoardUrl(server, "Uploaded");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(chip(a)).toHaveText("API summary");
  const demo = Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(64 * 1024, 7)]);
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: demo });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(replayTimeline()));
  await expect(chip(a)).toHaveText("Full replay");

  await cloneIt(a, "Uploaded (copy)");
  await expect(a.getByTestId("match-clock")).toHaveText(/ 21:40$/);
  await expect(chip(a)).toHaveText("Full replay");
  await a.screenshot({ path: "shots/clone-replay-uploaded.png" });
  // Nothing was queued again: the copy shares the parse.
  expect(readdirSync(join(queue, "inbox")).filter((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem"))).toEqual([]);
});

test("a clone opens in Player on the source's fetched replay", async ({ browser }) => {
  // A replay fetched from Valve's CDN, already in the server's cache (shared by every board).
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  writeFileSync(join(server.dataDir, "replays", `${ID}-cdn.json`), JSON.stringify(replayTimeline()));
  const url = await newBoardUrl(server, "Fetched");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(chip(a)).toHaveText("Full replay");

  await cloneIt(a, "Fetched (copy)");
  await expect(a.getByTestId("match-clock")).toHaveText(/ 21:40$/);
  await expect(chip(a)).toHaveText("Full replay");
  await a.screenshot({ path: "shots/clone-replay-fetched.png" });
});
