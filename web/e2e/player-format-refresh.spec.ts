// A replay timeline cached by an older worker (no `format` stamp) is upgraded (spec §6a,
// format versions): a fetched one is fetched and parsed again on open while the old one shows,
// and swaps in place; a stale upload stays, with "Upload replay file" offered as the way up.
// A fake deadlock-api and CDN; the test plays the worker and plants the old caches.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { ROOT, Server, TIMELINE_FORMAT } from "./server";

const CDN = 130816397;
const UP = 130816398;
/** A match a board already has open when its cached timeline turns out to be older. */
const KEPT = 130816399;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-format-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;
const hits: string[] = [];

function meta(id: number) {
  const m = JSON.parse(readFileSync(join(ROOT, `crates/server/tests/fixtures/match-130816395-trimmed.json`)).toString());
  m.match_info.match_id = id;
  m.match_info.start_time = Math.floor(Date.now() / 1000) - 86400;
  return JSON.stringify(m);
}

test.beforeAll(async () => {
  upstream = createServer((req, res) => {
    const url = req.url ?? "";
    hits.push(url.split("?")[0]!);
    const m = /^\/v1\/matches\/(\d+)\/metadata/.exec(url);
    if (m) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(meta(Number(m[1])));
    }
    const salts = /^\/v1\/matches\/(\d+)\/salts/.exec(url);
    if (salts && [CDN, KEPT].includes(Number(salts[1]))) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ match_id: Number(salts[1]), cluster_id: 404, replay_salt: 77, metadata_salt: 9 }));
    }
    if (url === `/cdn/404/1422450/${CDN}_77.dem.bz2` || url === `/cdn/404/1422450/${KEPT}_77.dem.bz2`) {
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
  server.stop();
  upstream.close();
});

const N = 700;
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
/** A worker's timeline: format 0 (no stamp, no urn) or the current one, with an urn on the ground. */
function timeline(id: number, current: boolean) {
  return {
    match_id: id, start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => slot * 300), y: range(() => (team === "amber" ? -8000 : 8000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], zips: [], camps: [], events: [],
    ...(current ? { format: TIMELINE_FORMAT, urn: { spawns: [{ t: 0, key: "urn:neutral:lane1:1" }], at: [{ t: 0, state: "ground", x: -6584, y: 0 }] } } : {}),
  };
}

function cache(job: string, body: unknown) {
  const dir = join(server.dataDir, "replays");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${job}.json`), JSON.stringify(body));
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

const urn = (p: import("@playwright/test").Page) => p.locator("[data-testid=map] [data-testid=urn]");

test("a fetched timeline in an older format shows at once, is fetched again once, and swaps in place", async ({ browser }) => {
  cache(`${CDN}-cdn`, timeline(CDN, false));
  const a = await openFromLanding(browser, CDN);
  const chip = a.getByTestId("match-tier");
  await expect(chip).toHaveAttribute("data-tier", "replay");
  await expect(urn(a)).toHaveCount(0);
  await expect.poll(() => readdirSync(join(queue, "inbox")).includes(`${CDN}-cdn.dem`)).toBe(true);
  await expect(chip).toHaveText("Queued");
  writeFileSync(join(queue, "outbox", `${CDN}-cdn.json`), JSON.stringify(timeline(CDN, true)));
  await expect(urn(a)).toHaveAttribute("data-state", "ground", { timeout: 15_000 });
  await expect(chip).toHaveText("Full replay");
  // Opened again: nothing more is asked.
  await openFromLanding(browser, CDN);
  expect(hits.filter((h) => h === `/v1/matches/${CDN}/salts`)).toHaveLength(1);
});

test("a stale upload stays, and offers Upload replay file as the way up", async ({ browser }) => {
  const a = await openFromLanding(browser, UP);
  const board = /\/b\/([^/#?]+)/.exec(a.url())![1]!;
  const scope = createHash("sha256").update(board).digest("hex").slice(0, 16);
  cache(`${UP}-${scope}`, timeline(UP, false));
  // Load it again in Player: the board's upload is served.
  await a.getByTestId("match-id").fill(String(UP));
  await a.getByTestId("match-load").click();
  const chip = a.getByTestId("match-tier");
  await expect(chip).toHaveAttribute("data-tier", "replay");
  await expect(chip).toHaveAttribute("data-stale", "true");
  await expect(chip).toHaveAttribute("title", /An older parse/);
  await expect(a.getByTestId("match-upload")).toHaveText("Upload replay file");
  expect(hits.filter((h) => h === `/v1/matches/${UP}/salts`).length).toBeLessThanOrEqual(1);
});

test("a board that already has the match upgrades an older fetched timeline when it's opened again, without a new attach", async ({ browser }) => {
  // Opened while its timeline was current: nothing to refresh, and the board keeps the match.
  cache(`${KEPT}-cdn`, timeline(KEPT, true));
  const a = await openFromLanding(browser, KEPT);
  await expect(urn(a)).toHaveAttribute("data-state", "ground");
  const board = a.url();
  await a.close();
  // Then the cache is older than the worker (as after a deploy that bumps the format). The board
  // is opened again by its link: no landing, no attach, just the board loading its match.
  cache(`${KEPT}-cdn`, timeline(KEPT, false));
  const b = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await b.goto(board);
  await b.locator("#join-name").or(b.getByTestId("player")).first().waitFor();
  if (await b.locator("#join-name").isVisible()) {
    await b.locator("#join-name").fill("Coach");
    await b.keyboard.press("Enter");
  }
  await expect(b.getByTestId("match-tier")).toHaveAttribute("data-tier", "replay");
  await expect.poll(() => readdirSync(join(queue, "inbox")).includes(`${KEPT}-cdn.dem`)).toBe(true);
  writeFileSync(join(queue, "outbox", `${KEPT}-cdn.json`), JSON.stringify(timeline(KEPT, true)));
  await expect(urn(b)).toHaveAttribute("data-state", "ground", { timeout: 15_000 });
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
});
