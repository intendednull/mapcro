// Getting a replay in (operator, 2026-11-08: people can't find their replay files, and
// deadlock-api can't always fetch one): "Where's my replay?" beside every upload, a `.dem`
// dropped on the landing or on Player, upload progress with Cancel while the board stays in
// use, and an honest line for each way it can fail. A fake deadlock-api and CDN; the test plays
// the worker (its on-disk queue is the contract).

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";

/** deadlock-api has its metadata, but Valve no replay. */
const KNOWN = 130816395;
/** deadlock-api doesn't know it yet (it just ended). */
const NEW = 130816397;
/** Past Valve's three weeks. */
const OLD = 130816398;
/** Its salts are rate-limited (asked last: the backoff holds every fetch). */
const LIMITED = 130816399;
/** Its replay parses badly. */
const BAD = 130816400;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-upload-"));
const shots = process.env.MAPCRO_UX_SHOTS ?? "/tmp/pw-upload-ux/shots";
let upstream: ReturnType<typeof createServer>;
let server: Server;
const hits: string[] = [];

function meta(id: number, ageDays: number) {
  const m = JSON.parse(readFileSync(join(ROOT, `crates/server/tests/fixtures/match-130816395-trimmed.json`)).toString());
  m.match_info.match_id = id;
  m.match_info.start_time = Math.floor(Date.now() / 1000) - ageDays * 86400;
  return JSON.stringify(m);
}

test.beforeAll(async () => {
  upstream = createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0]!;
    hits.push(url);
    const m = /^\/v1\/matches\/(\d+)\/metadata$/.exec(url);
    if (m && Number(m[1]) !== NEW) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(meta(Number(m[1]), Number(m[1]) === OLD ? 30 : 1));
    }
    if (url === `/v1/matches/${LIMITED}/salts`) {
      res.writeHead(429, { "retry-after": "600" });
      return res.end("{}");
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
    match_id: id, start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => slot * 300), y: range(() => (team === "amber" ? -8000 : 8000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: [],
  };
}
const demo = (kb = 64) => Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(kb * 1024, 7)]);

/** The job the server queued for `id` (the worker's inbox), once it's there. */
async function queued(id: number) {
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".dem")) ?? ""), { timeout: 15_000 }).not.toBe("");
  return job.replace(/\.dem$/, "");
}

/** Drag a file over the page, then drop it on `target`: the page builds the file itself. */
async function drop(p: Page, target: string, name: string, kb = 64) {
  const dt = await p.evaluateHandle(
    ({ name, kb }) => {
      const bytes = new Uint8Array(8 + kb * 1024).fill(7);
      bytes.set(new TextEncoder().encode("PBDEMS2\0"));
      const t = new DataTransfer();
      t.items.add(new File([bytes], name));
      return t;
    },
    { name, kb },
  );
  await p.dispatchEvent(target, "dragenter", { dataTransfer: dt });
  await p.dispatchEvent(target, "dragover", { dataTransfer: dt });
  await expect(p.getByTestId("drop-overlay")).toBeVisible();
  await p.dispatchEvent(target, "drop", { dataTransfer: dt });
  await expect(p.getByTestId("drop-overlay")).toBeHidden();
}

async function landing(browser: Browser, width = 1440, height = 900) {
  const p = await (await browser.newContext({ viewport: { width, height } })).newPage();
  await p.goto(`${server.url}/`);
  return p;
}
async function enter(p: Page) {
  await p.locator("#join-name").fill("Coach");
  await p.keyboard.press("Enter");
  await expect(p.getByTestId("join-card")).toBeHidden();
}
const shot = (p: Page, name: string) => p.screenshot({ path: `${shots}/${name}.png` });

test("Where's my replay? walks through the game and Steam, on the landing and in Player", async ({ browser }) => {
  for (const [w, h] of [[1280, 768], [1440, 900], [390, 844]] as const) {
    const p = await landing(browser, w, h);
    const help = p.getByTestId("replay-help-steps");
    await expect(help).toBeHidden();
    await p.getByTestId("replay-help-open").click();
    await expect(help).toBeVisible();
    await expect(help).toContainText("Download it in Deadlock");
    await expect(help).toContainText("Match History → the match → Replay");
    await expect(help).toContainText("Steam: right-click Deadlock → Properties… → Installed Files → Browse…");
    await expect(help).toContainText("game → citadel → replays → <match id>.dem");
    await expect(help).not.toContainText("C:\\");
    await p.getByTestId("open-match-id").fill(String(KNOWN));
    await expect(p.getByTestId("replay-help-file")).toHaveText(`${KNOWN}.dem`);
    await shot(p, `help-landing-${w}`);
  }
  // In Player, beside the upload, as a menu.
  const a = await joinNew(browser, await newBoardUrl(server, "Help"), "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(String(NEW));
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-notice-text")).toHaveText("Match not found yet.");
  await a.getByTestId("replay-help-open").click();
  await expect(a.getByTestId("replay-help-file")).toHaveText(`${NEW}.dem`);
  await shot(a, "help-player-1440");
  // A press elsewhere closes it.
  await a.locator(".pl-bar").click({ position: { x: 4, y: 4 } });
  await expect(a.getByTestId("replay-help-steps")).toBeHidden();
});

test("a match deadlock-api doesn't know yet: the landing says so, keeps the id, and its upload opens it", async ({ browser }) => {
  const p = await landing(browser);
  await p.getByTestId("open-match-id").fill(String(NEW));
  await p.getByTestId("open-match-go").click();
  await expect(p.getByTestId("open-match-notice-text")).toHaveText("Match not found yet.");
  await expect(p.getByTestId("open-match-notice-line")).toHaveText("New matches can take a while to reach deadlock-api. Try again later.");
  await expect(p.getByTestId("open-match-id")).toHaveValue(String(NEW));
  await expect(p).toHaveURL(`${server.url}/`);
  await shot(p, "landing-not-found");
  // Try again asks again.
  const asked = () => hits.filter((h) => h === `/v1/matches/${NEW}/metadata`).length;
  const before = asked();
  await p.getByTestId("open-match-retry").click();
  await expect.poll(asked).toBe(before + 1);
  await expect(p.getByTestId("open-match-notice-text")).toHaveText("Match not found yet.");
  // Its replay needs no metadata: the board opens on it and the upload runs there.
  await p.getByTestId("open-match-upload-file").setInputFiles({ name: `${NEW}.dem`, mimeType: "application/octet-stream", buffer: demo() });
  await expect(p).toHaveURL(/\/b\//);
  await enter(p);
  await expect(p.getByTestId("player")).toBeVisible();
  const job = await queued(NEW);
  await expect(p.getByTestId("match-tier")).toHaveText(/^Queued$|Uploading/);
  await expect(p.getByTestId("match-notice")).toHaveCount(0);
  writeFileSync(join(queue, "outbox", `${job}.json`), JSON.stringify(timeline(NEW)));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay", { timeout: 15_000 });
  await expect(p.getByTestId("match-id")).toHaveValue(String(NEW));
  // It opened: it's attached, and the landing lists it.
  await p.goto(`${server.url}/`);
  await expect(p.locator(".known")).toContainText(`Match ${NEW}`);
});

test("a .dem dropped anywhere on the landing opens its match; anything else is refused", async ({ browser }) => {
  const p = await landing(browser, 1280, 768);
  await p.dispatchEvent("body", "dragenter", {
    dataTransfer: await p.evaluateHandle((id) => {
      const t = new DataTransfer();
      t.items.add(new File(["x"], `${id}.dem`));
      return t;
    }, KNOWN),
  });
  await expect(p.getByTestId("drop-overlay")).toContainText("Drop the replay to upload it");
  await shot(p, "landing-drop-overlay");
  await p.dispatchEvent("body", "dragleave", { dataTransfer: await p.evaluateHandle(() => { const t = new DataTransfer(); t.items.add(new File(["x"], "x.dem")); return t; }) });
  await expect(p.getByTestId("drop-overlay")).toBeHidden();
  await drop(p, "h1", "notes.txt");
  await expect(p.getByTestId("open-match-error")).toHaveText("Not a .dem file. Pick the match's replay.");
  await expect(p).toHaveURL(`${server.url}/`);
  await drop(p, "footer", `${KNOWN}.dem`);
  await expect(p).toHaveURL(/\/b\//);
  await enter(p);
  await expect(p.getByTestId("match-id")).toHaveValue(String(KNOWN));
  const job = await queued(KNOWN);
  expect(job).not.toContain("-cdn");
  writeFileSync(join(queue, "outbox", `${job}.json`), JSON.stringify(timeline(KNOWN)));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay", { timeout: 15_000 });
  await expect(p.getByTestId("match-credit")).toHaveText("Replay: uploaded");
});

test("Player: a replay Valve hasn't got says so, Try again asks again, and a dropped file uploads", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "No replay"), "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(String(KNOWN));
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  // The board's own upload (the landing test's) doesn't count here: this board fetched.
  await expect(a.getByTestId("match-notice-text")).toHaveText("Replay not found yet. Try again later, or upload the replay file.");
  await expect(a.getByTestId("match-retry")).toHaveText("Try again");
  await expect(a.getByTestId("match-upload")).toHaveText("Upload replay file");
  await shot(a, "player-no-replay");
  await a.setViewportSize({ width: 1280, height: 768 });
  await a.getByTestId("replay-help-open").click();
  const steps = (await a.getByTestId("replay-help-steps").boundingBox())!;
  expect(steps.x + steps.width).toBeLessThanOrEqual(1280);
  expect(steps.y).toBeGreaterThanOrEqual(0);
  await shot(a, "player-no-replay-help-1280");
  await a.getByTestId("replay-help-open").click();
  await a.setViewportSize({ width: 1440, height: 900 });
  const salts = () => hits.filter((h) => h === `/v1/matches/${KNOWN}/salts`).length;
  const before = salts();
  await a.getByTestId("match-retry").click();
  await expect.poll(salts, { message: "Try again goes past the server's memory of the failure" }).toBe(before + 1);
  await expect(a.getByTestId("match-notice-text")).toHaveText("Replay not found yet. Try again later, or upload the replay file.");

  // Dropped on the stage: another match's file, then not a replay, then the right one.
  await drop(a, ".stage", "999.dem");
  await expect(a.getByTestId("match-status")).toHaveText(`That file is match 999, not ${KNOWN}`);
  await drop(a, ".stage", "clip.mp4");
  await expect(a.getByTestId("match-status")).toHaveText("Not a .dem file. Pick the match's replay.");
  await drop(a, ".stage", `${KNOWN}.dem`);
  const job = await queued(KNOWN);
  await expect(a.getByTestId("match-tier")).toHaveText("Queued");
  await expect(a.getByTestId("match-notice")).toHaveCount(0);
  writeFileSync(join(queue, "outbox", `${job}.json`), JSON.stringify(timeline(KNOWN)));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay", { timeout: 15_000 });
  // A board with the full replay takes no drop.
  await a.dispatchEvent(".stage", "dragenter", { dataTransfer: await a.evaluateHandle(() => { const t = new DataTransfer(); t.items.add(new File(["x"], "1.dem")); return t; }) });
  await expect(a.getByTestId("drop-overlay")).toHaveCount(0);
});

test("upload progress shows the percent and the size, the board stays in use, and Cancel stops it", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Progress"), "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(String(KNOWN));
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  // A slow link, so the upload takes a while.
  const cdp = await a.context().newCDPSession(a);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 3 * 1024 * 1024 });
  await drop(a, ".stage", `${KNOWN}.dem`, 40 * 1024);
  const size = a.getByTestId("upload-size");
  await expect(size).toHaveText(/^\d+% · \d+ \/ 42 MB$/);
  await expect.poll(async () => Number((await size.textContent())?.split("%")[0]), { timeout: 15_000 }).toBeGreaterThan(5);
  await expect(a.getByTestId("match-tier")).toHaveText(/^Uploading \d+%$/);
  const value = Number(await a.getByTestId("upload-bar").getAttribute("value"));
  expect(value).toBeGreaterThan(0);
  await shot(a, "player-uploading-1440");
  await a.setViewportSize({ width: 1280, height: 768 });
  await shot(a, "player-uploading-1280");
  await a.setViewportSize({ width: 1440, height: 900 });
  // Meanwhile the summary plays.
  await a.getByTestId("match-play").click();
  await expect(a.getByTestId("match-play")).toHaveText("Pause");
  await expect.poll(async () => (await a.getByTestId("match-clock").textContent())?.split(" /")[0]).not.toBe("10:00");
  await a.getByTestId("match-play").click();
  await expect(size).toBeVisible();
  // Cancel: the upload stops, the board says so and stays usable.
  await a.getByTestId("upload-cancel").click();
  await expect(a.getByTestId("upload-progress")).toHaveCount(0);
  await expect(a.getByTestId("match-notice-text")).toHaveText("Upload cancelled.");
  await expect(a.getByTestId("match-upload")).toBeVisible();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await shot(a, "player-cancelled");
  await a.getByTestId("match-forward").click();
  await expect(a.getByTestId("match-time")).toBeEnabled();
  // The server let go of it: nothing queued, and a new upload is taken.
  expect(readdirSync(join(queue, "inbox")).filter((f) => f.startsWith(`${KNOWN}-`) && !f.startsWith("."))).toEqual([]);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await a.getByTestId("match-file").setInputFiles({ name: `${KNOWN}.dem`, mimeType: "application/octet-stream", buffer: demo() });
  const job = await queued(KNOWN);
  writeFileSync(join(queue, "outbox", `${job}.json`), JSON.stringify(timeline(KNOWN)));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay", { timeout: 15_000 });
});

test("the phone: Player's notice, its upload and the steps fit", async ({ browser }) => {
  const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
  await p.goto(await newBoardUrl(server, "Phone"));
  await enter(p);
  await p.getByTestId("mode-player").click();
  await p.getByTestId("match-id").fill(String(NEW));
  await p.getByTestId("match-load").click();
  await expect(p.getByTestId("match-notice-text")).toHaveText("Match not found yet.");
  await expect(p.getByTestId("match-notice-line")).toBeVisible();
  await expect(p.getByTestId("match-id")).toHaveValue(String(NEW));
  await shot(p, "player-not-found-390");
  await p.getByTestId("replay-help-open").click();
  const box = (await p.getByTestId("replay-help-steps").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  // The page scrolls to the last step.
  const last = p.getByTestId("replay-help-file");
  await last.scrollIntoViewIfNeeded();
  const lb = (await last.boundingBox())!;
  expect(lb.y + lb.height).toBeLessThanOrEqual(844);
  await expect(p.getByText("Or drag it onto this page.")).toBeHidden();
  await shot(p, "player-help-390");
});

test("a parse failure reads as what happened and what to do", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Bad"), "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(String(BAD));
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await a.getByTestId("match-file").setInputFiles({ name: `${BAD}.dem`, mimeType: "application/octet-stream", buffer: demo() });
  const job = await queued(BAD);
  writeFileSync(join(queue, "outbox", `${job}.failed`), "corrupt");
  await expect(a.getByTestId("match-notice-text")).toHaveText("Corrupt. Download the replay again in Deadlock, then upload it.", { timeout: 15_000 });
  await expect(a.getByTestId("match-upload")).toBeVisible();
  await expect(a.getByTestId("match-retry")).toHaveCount(0);
  // Not a replay at all: refused as it arrives.
  await a.getByTestId("match-file").setInputFiles({ name: `${BAD}.dem`, mimeType: "application/octet-stream", buffer: Buffer.from("MZ not a demo") });
  await expect(a.getByTestId("match-notice-text")).toHaveText("Not a replay. Pick the match's .dem file.");
});

test("an expired replay says to upload it", async ({ browser }) => {
  const p = await landing(browser);
  await p.getByTestId("open-match-id").fill(String(OLD));
  await p.getByTestId("open-match-go").click();
  await enter(p);
  await expect(p.getByTestId("match-tier")).toHaveText("API summary");
  await expect(p.getByTestId("match-notice-text")).toHaveText("Replay expired. Upload the replay file.");
  await expect(p.getByTestId("match-upload")).toBeVisible();
  await expect(p.getByTestId("match-retry")).toHaveCount(0);
  await shot(p, "player-expired");
  expect(hits).not.toContain(`/v1/matches/${OLD}/salts`);
});

// Last: deadlock-api's 429 backs every fetch off for its Retry-After.
test("deadlock-api backing off reads as busy", async ({ browser }) => {
  const p = await landing(browser);
  await p.getByTestId("open-match-id").fill(String(LIMITED));
  await p.getByTestId("open-match-go").click();
  await enter(p);
  await expect(p.getByTestId("match-notice-text")).toHaveText("Busy. Try again in a few minutes.", { timeout: 15_000 });
  await expect(p.getByTestId("match-retry")).toBeVisible();
  await expect(p.getByTestId("match-upload")).toBeVisible();
  await shot(p, "player-busy");
  await p.getByTestId("match-retry").click();
  await expect(p.getByTestId("match-notice-text")).toHaveText("Busy. Try again in a few minutes.");
});

// The real thing (never committed data; skipped without MAPCRO_REAL_DEM): a 504 MB replay of a
// match deadlock-api doesn't know, picked from the landing's "Match not found yet", uploaded with
// progress on the board it opens, parsed by the real worker, shown as the full replay.
test.describe("a real replay", () => {
  const dem = process.env.MAPCRO_REAL_DEM;
  const id = (dem ?? "").match(/(\d+)\.dem$/)?.[1] ?? "0";
  test.skip(!dem, "set MAPCRO_REAL_DEM to a replay file");
  test.setTimeout(420_000);
  let real: Server;
  let worker: import("node:child_process").ChildProcess;
  const q = mkdtempSync(join(tmpdir(), "mapcro-e2e-real-"));
  test.beforeAll(async () => {
    const { spawn } = await import("node:child_process");
    real = new Server(process.env.MAPCRO_SHOT_PACKS, { MATCH_API_BASE: "http://127.0.0.1:9", REPLAY_DIR: q });
    await real.start();
    // After the server: it makes the queue's directories, which the worker checks for.
    worker = spawn(join(ROOT, "target/release/mapcro-replay"), ["work", q], { stdio: ["ignore", "ignore", "inherit"] });
  });
  test.afterAll(() => {
    real?.stop();
    worker?.kill("SIGKILL");
  });

  test("uploads with progress from the landing's not-found, parses, and plays", async ({ browser }) => {
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await p.goto(`${real.url}/`);
    await p.getByTestId("open-match-id").fill(id);
    await p.getByTestId("open-match-go").click();
    // deadlock-api isn't there at all here: it reads as down, and the upload is still offered.
    await expect(p.getByTestId("open-match-notice")).toBeVisible();
    await expect(p.getByTestId("open-match-id")).toHaveValue(id);
    const cdp = await p.context().newCDPSession(p);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 60 * 1024 * 1024 });
    await p.getByTestId("open-match-upload-file").setInputFiles(dem!);
    await expect(p).toHaveURL(/\/b\//);
    await p.locator("#join-name").fill("Coach");
    await p.keyboard.press("Enter");
    const size = p.getByTestId("upload-size");
    await expect(size).toHaveText(/^\d+% · \d+ \/ 504 MB$/);
    await expect.poll(async () => Number((await size.textContent().catch(() => "0"))?.split("%")[0]), { timeout: 60_000 }).toBeGreaterThan(20);
    await p.screenshot({ path: `${shots}/real-uploading.png` });
    await expect(p.getByTestId("match-tier")).toHaveText("Parsing replay…", { timeout: 120_000 });
    await p.screenshot({ path: `${shots}/real-parsing.png` });
    await expect(p.getByTestId("match-tier")).toHaveText("Full replay", { timeout: 300_000 });
    await expect(p.getByTestId("match-notice")).toHaveCount(0);
    // The heroes at 10:00 (the dead hidden).
    await expect.poll(() => p.locator(".mapbox .tok").count()).toBeGreaterThan(8);
    await expect(p.getByTestId("health-toggle")).toBeVisible();
    await p.screenshot({ path: `${shots}/real-full.png` });
  });
});
