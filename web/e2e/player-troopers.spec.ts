// The replay's lane troopers as dots (operator, 2026-11-08: to check the wave splits by eye), on
// a synthetic replay timeline the test hands the server as the worker would.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

const ID = "122134063";
const N = 120;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-troopers-"));
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

const pack = (list: Array<[number, number, number]>) => {
  const b = Buffer.alloc(list.length * 6);
  list.forEach(([id, x, y], i) => {
    b.writeUInt16LE(id, i * 6);
    b.writeInt16LE(x, i * 6 + 2);
    b.writeInt16LE(y, i * 6 + 4);
  });
  return b.toString("base64");
};
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/** Four troopers a side marching up and down the mid lane; nothing recorded from 60 to 70 s. */
function timeline() {
  const side = (team: "amber" | "sapphire") =>
    range((s) => (s >= 60 && s < 70 ? "" : pack([0, 1, 2, 3].map((i) => [i + (team === "amber" ? 0 : 10), (i - 1.5) * 150, team === "amber" ? -6000 + s * 40 : 6000 - s * 40] as [number, number, number]))));
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => slot * 300), y: range(() => (team === "amber" ? -8000 : 8000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [],
    waves: [{ lane: "lane4", t: range((s) => 500), stale: [] }],
    troopers: { every_s: 1, amber: side("amber"), sapphire: side("sapphire") },
  };
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}
const spots = (p: Page) => p.locator("[data-testid=trooper]").evaluateAll((els) => els.map((e) => `${e.getAttribute("cx")},${e.getAttribute("cy")}`).sort());

test("trooper dots render, move between times, keep gaps empty, and toggle off", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Troopers"), "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await scrubTo(a, 20);
  await expect(a.locator("[data-testid=trooper]")).toHaveCount(8);
  const at20 = await spots(a);
  await scrubTo(a, 40);
  await expect(a.locator("[data-testid=trooper]")).toHaveCount(8);
  expect(await spots(a)).not.toEqual(at20);
  await a.screenshot({ path: "shots/troopers-synthetic.png" });
  // Nothing recorded: nothing drawn.
  await scrubTo(a, 65);
  await expect(a.locator("[data-testid=trooper]")).toHaveCount(0);
  await scrubTo(a, 40);
  await a.getByTestId("troopers-toggle").click();
  await expect(a.locator("[data-testid=trooper]")).toHaveCount(0);
});
