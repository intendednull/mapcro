// Only the standard 6v6 mode is understood (operator, 2026-11-08): a Street Brawl or unknown-mode
// match is refused on import, from the metadata and from a replay's game rules, and gets no
// board. Synthetic metadata from a fake deadlock-api; the worker played through its outbox.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

const BRAWL = "122134063";
const ODD = "122134064";
const NO_META = "122134065";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-mode-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

const meta = (id: string, mode: number) => JSON.stringify({ match_info: { match_id: Number(id), duration_s: 600, start_time: 0, game_mode: mode, match_mode: 1, players: [] } });

test.beforeAll(async () => {
  upstream = createServer((req, res) => {
    const id = /^\/v1\/matches\/(\d+)\/metadata/.exec(req.url ?? "")?.[1];
    if (id === BRAWL || id === ODD) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(meta(id, id === BRAWL ? 4 : 99));
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

test("a Brawl or unknown-mode match is refused in Player and never attached", async ({ browser }) => {
  const url = await newBoardUrl(server, "Modes");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  for (const [id, label] of [[BRAWL, "Brawl not supported"], [ODD, "Mode not supported"]] as const) {
    await a.getByTestId("match-id").fill(id);
    await a.getByTestId("match-load").click();
    await expect(a.getByTestId("match-status")).toHaveText(label);
  }
  await a.screenshot({ path: "shots/mode-brawl-refused.png" });
  const board = new URL(url).pathname.split("/").pop()!;
  const token = new URL(url).hash.replace(/^#/, "").split("=").pop()!;
  const r = await a.request.get(`${server.url}/api/boards/${board}/matches`, { headers: { authorization: `Bearer ${token}` } });
  expect(await r.json()).toEqual({ matches: [] });
});

test("a replay whose game rules say Brawl fails with its label", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Brawl replay"), "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(NO_META);
  await a.getByTestId("match-load").click();
  await a.getByTestId("match-file").setInputFiles({ name: `${NO_META}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${NO_META}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".failed")), "brawl");
  await expect(a.getByTestId("match-job")).toHaveText("Brawl not supported");
});

test("Open match with a Brawl id makes no board", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(server.url);
  await page.getByTestId("open-match-id").fill(BRAWL);
  await page.getByTestId("open-match-go").click();
  await expect(page.locator(".landing .error")).toHaveText("Brawl not supported");
  await expect(page).toHaveURL(server.url + "/");
  await page.reload();
  await expect(page.locator(".known")).toHaveCount(0);
});
