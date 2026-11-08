// The replay queue, seen from Player (spec §6a, "The queue"): an upload behind other people's
// jobs shows how many are ahead and, once recent parses give one, the wait; it parses in turn and
// upgrades to the full replay. When the queue is full the file waits in the browser for a turn
// ("Waiting for a slot · N ahead"), Cancel gives the place up, and only an absurd backlog is
// refused. A fake deadlock-api; the test plays a slow worker (its on-disk queue is the contract).

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";

/** deadlock-api has its metadata, Valve no replay: Player offers the upload. */
const KNOWN = 130816395;
/** Other people's jobs, ahead in the queue. */
const OTHER = 140000000;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-queue-"));
const shots = process.env.MAPCRO_QUEUE_SHOTS ?? "/tmp/pw-capacity/shots";
let upstream: ReturnType<typeof createServer>;
let server: Server;

function meta(id: number) {
  const m = JSON.parse(readFileSync(join(ROOT, `crates/server/tests/fixtures/match-130816395-trimmed.json`)).toString());
  m.match_info.match_id = id;
  m.match_info.start_time = Math.floor(Date.now() / 1000) - 86400;
  return JSON.stringify(m);
}

test.beforeAll(async () => {
  upstream = createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0]!;
    const m = /^\/v1\/matches\/(\d+)\/metadata$/.exec(url);
    if (m) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(meta(Number(m[1])));
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(process.env.MAPCRO_SHOT_PACKS, {
    MATCH_API_BASE: `http://127.0.0.1:${port}`,
    REPLAY_CDN_BASE: `http://127.0.0.1:${port}/cdn`,
    REPLAY_DIR: queue,
    REPLAY_PER_CLIENT_PER_HOUR: "100",
    REPLAY_WORKERS: "2",
    // Five jobs fill it; a line of three is the last resort.
    REPLAY_MAX_QUEUED: "5",
    REPLAY_MAX_WAITING: "3",
  });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const N = 1300;
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
function timeline(id: number) {
  return {
    match_id: id, start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0, format: 1,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => slot * 300), y: range(() => (team === "amber" ? -8000 : 8000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: [],
  };
}
const demo = (kb = 64) => Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(kb * 1024, 7)]);
const shot = (p: Page, name: string) => p.screenshot({ path: `${shots}/${name}.png` });

/** Another person's board, uploading from its own address (as Caddy forwards it). */
async function other() {
  const url = await newBoardUrl(server, "Someone else");
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  const call = (path: string, init: RequestInit, ip: string) =>
    fetch(`${server.url}/api/boards/${board}/replays${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, "x-forwarded-for": ip } });
  return {
    upload: async (id: number, ip: string) => expect((await call(`/${id}/upload`, { method: "POST", body: demo(8) }, ip)).status).toBe(202),
    reserve: async (id: number, ip: string) => (await call(`/${id}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bytes: 8200 }) }, ip)).json() as Promise<{ state?: string; ahead?: number; error?: string }>,
    release: async (id: number, ip: string) => void (await call(`/${id}/reserve`, { method: "DELETE" }, ip)),
  };
}

/** The queued job for match `id` (its file in the inbox). */
async function job(id: number) {
  let name = "";
  await expect.poll(() => (name = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".dem")) ?? ""), { timeout: 15_000 }).not.toBe("");
  return name.replace(/\.dem$/, "");
}
/** The slow worker: starts a job, then (later) finishes it. */
const parsing = async (id: number) => writeFileSync(join(queue, "outbox", `${await job(id)}.parsing`), "");
const failed = async (id: number) => {
  const j = await job(id);
  writeFileSync(join(queue, "outbox", `${j}.failed`), "old_map");
  await expect.poll(() => readdirSync(join(queue, "inbox")).includes(`${j}.dem`), { timeout: 15_000 }).toBe(false);
};
/** A parse that made a timeline: only these give the wait estimate its samples. */
const parsed = async (id: number) => {
  const j = await job(id);
  writeFileSync(join(queue, "outbox", `${j}.json`), JSON.stringify(timeline(id)));
  await expect.poll(() => readdirSync(join(queue, "inbox")).includes(`${j}.dem`), { timeout: 15_000 }).toBe(false);
};

async function player(browser: Browser, title: string) {
  const a = await joinNew(browser, await newBoardUrl(server, title), "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(String(KNOWN));
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await expect(a.getByTestId("match-upload")).toBeVisible();
  return a;
}
const pick = (a: Page) => a.getByTestId("match-file").setInputFiles({ name: `${KNOWN}.dem`, mimeType: "application/octet-stream", buffer: demo() });

test("an upload behind other jobs says how many are ahead and the wait, then parses to the full replay", async ({ browser }) => {
  const o = await other();
  for (let i = 0; i < 4; i++) await o.upload(OTHER + i, `10.9.0.${i + 1}`);
  const a = await player(browser, "Queued");
  const chip = a.getByTestId("match-tier");
  await pick(a);
  await expect(chip).toHaveText("Queued · 4 ahead");
  await shot(a, "queue-queued-4-ahead");
  // Two parse at once; they still count as ahead until they're done.
  await parsing(OTHER);
  await parsing(OTHER + 1);
  await a.waitForTimeout(1500);
  await expect(chip).toHaveText("Queued · 4 ahead");
  // A refusal ends in no time: it isn't a parse time.
  await failed(OTHER);
  await expect(chip).toHaveText("Queued · 3 ahead");
  await parsing(OTHER + 2);
  await parsed(OTHER + 1);
  await parsing(OTHER + 3);
  await parsed(OTHER + 2);
  await expect(chip).toHaveText("Queued · 1 ahead");
  await parsed(OTHER + 3);
  // Three parses done: the server has an estimate.
  await expect(chip).toHaveText("Queued · ~1 min");
  await shot(a, "queue-queued-eta");
  await parsing(KNOWN);
  await expect(chip).toHaveText("Parsing replay…");
  await shot(a, "queue-parsing");
  writeFileSync(join(queue, "outbox", `${await job(KNOWN)}.json`), JSON.stringify(timeline(KNOWN)));
  await expect(chip).toHaveText("Full replay", { timeout: 15_000 });
  await expect(chip).toHaveAttribute("data-tier", "replay");
  await shot(a, "queue-full-replay");
});

test("a full queue: the file waits in the browser for a turn, Cancel gives it up, and its turn sends it", async ({ browser }) => {
  const o = await other();
  for (let i = 0; i < 5; i++) await o.upload(OTHER + 10 + i, `10.9.1.${i + 1}`);
  // Someone else is waiting already.
  expect(await o.reserve(OTHER + 20, "10.9.1.9")).toEqual({ state: "waiting", source: "upload", ahead: 0 });
  const keep = setInterval(() => void o.reserve(OTHER + 20, "10.9.1.9"), 2000);
  try {
    const a = await player(browser, "Waiting");
    const chip = a.getByTestId("match-tier");
    await pick(a);
    await expect(chip).toHaveText("Waiting for a slot · 1 ahead");
    await expect(a.getByTestId("upload-waiting")).toHaveText("Waiting for a slot · 1 ahead");
    await expect(a.getByTestId("upload-bar")).toHaveCount(0);
    await shot(a, "queue-waiting-1-ahead");
    // Cancel while waiting: the place is given up.
    await a.getByTestId("upload-cancel").click();
    await expect(a.getByTestId("match-notice-text")).toHaveText("Upload cancelled.");
    await expect(chip).toHaveText("API summary");
    await pick(a);
    await expect(chip).toHaveText("Waiting for a slot · 1 ahead");
    // A job finishes: the one ahead gets its turn (and gives it up), then this file's comes.
    await failed(OTHER + 10);
    await expect(chip).toHaveText("Waiting for a slot");
    await shot(a, "queue-waiting-next");
    clearInterval(keep);
    await o.release(OTHER + 20, "10.9.1.9");
    // Sent, and queued behind the four still there.
    // (The first test's parses gave the server an estimate.)
    await expect(chip).toHaveText(/^Queued · 4 ahead( · ~1 min)?$/, { timeout: 15_000 });
    for (let i = 1; i < 5; i++) await failed(OTHER + 10 + i);
    await parsing(KNOWN);
    await expect(chip).toHaveText("Parsing replay…");
    writeFileSync(join(queue, "outbox", `${await job(KNOWN)}.json`), JSON.stringify(timeline(KNOWN)));
    await expect(chip).toHaveText("Full replay", { timeout: 15_000 });
  } finally {
    clearInterval(keep);
  }
});

test("a backlog past the line's cap is refused, honestly", async ({ browser }) => {
  const o = await other();
  for (let i = 0; i < 5; i++) await o.upload(OTHER + 30 + i, `10.9.2.${i + 1}`);
  for (let i = 0; i < 3; i++) expect((await o.reserve(OTHER + 40 + i, `10.9.2.${10 + i}`)).state).toBe("waiting");
  const a = await player(browser, "Busy");
  await pick(a);
  await expect(a.getByTestId("match-notice-text")).toHaveText("Busy. Try again in a few minutes.");
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await shot(a, "queue-busy");
  for (let i = 0; i < 3; i++) await o.release(OTHER + 40 + i, `10.9.2.${10 + i}`);
  for (let i = 0; i < 5; i++) await failed(OTHER + 30 + i);
});

/** Fill the queue so the next upload waits; returns the cleanup (past the first `done`). */
async function fill(base: number, net: string) {
  const o = await other();
  for (let i = 0; i < 5; i++) await o.upload(base + i, `${net}.${i + 1}`);
  return async (done = 0) => {
    for (let i = done; i < 5; i++) await failed(base + i);
  };
}

test("Cancel while a reserve is under way gives back the turn it brings", async ({ browser }) => {
  const clear = await fill(OTHER + 60, "10.9.4");
  const a = await player(browser, "Cancel in flight");
  const chip = a.getByTestId("match-tier");
  await pick(a);
  await expect(chip).toHaveText("Waiting for a slot");
  // Room comes; the next ask is held on its way back, and Cancel is pressed meanwhile.
  let held: (() => void) | undefined;
  await a.route("**/reserve", async (r) => {
    if (r.request().method() !== "POST" || held) return r.fallback();
    const res = await r.fetch();
    if ((await res.json()).state !== "ready") return r.fulfill({ response: res });
    await new Promise<void>((go) => (held = go));
    await r.fulfill({ response: res });
  });
  await failed(OTHER + 60);
  await expect.poll(() => !!held, { timeout: 10_000 }).toBe(true);
  await a.getByTestId("upload-cancel").click();
  const gave = a.waitForRequest((q) => q.method() === "DELETE" && q.url().endsWith("/reserve"), { timeout: 10_000 });
  held!();
  await gave;
  await expect(a.getByTestId("match-notice-text")).toHaveText("Upload cancelled.");
  // The turn went back: the next person's is ready at once.
  const o = await other();
  expect((await o.reserve(OTHER + 69, "10.9.4.9")).state).toBe("ready");
  await o.release(OTHER + 69, "10.9.4.9");
  await clear(1);
});

test("a reserve request that gets no answer is tried again: the wait goes on, its place kept", async ({ browser }) => {
  const clear = await fill(OTHER + 50, "10.9.3");
  const a = await player(browser, "Blip");
  const chip = a.getByTestId("match-tier");
  await pick(a);
  await expect(chip).toHaveText("Waiting for a slot");
  // The next ask is lost (a dropped connection, a restart): the wait doesn't end there.
  let lost = 0;
  await a.route("**/reserve", (r) => (r.request().method() === "POST" && lost++ === 0 ? r.abort("failed") : r.fallback()));
  await expect.poll(() => lost, { timeout: 10_000 }).toBeGreaterThan(1);
  await expect(chip).toHaveText("Waiting for a slot");
  await expect(a.getByTestId("match-notice-text")).toHaveCount(0);
  await shot(a, "queue-waiting-after-blip");
  // Its turn still comes, and sends the file.
  await failed(OTHER + 50);
  await expect(chip).toHaveText(/^Queued · 4 ahead( · ~1 min)?$/, { timeout: 15_000 });
  await clear(1);
  await failed(KNOWN);
});
