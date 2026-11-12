// A board as a file (spec §6): Download in the board's top bar saves `<title>.mapcro.json`; Import
// board on the landing (its button, or a file dropped on the page) makes a new board, yours, and
// opens it. The original is never touched. A match comes back by its id: a replay Valve has is
// there again, and one only an upload had is asked for again (the prompt, §6b). A refused file
// says why in a tag. A fake deadlock-api; fetched replays are placed in the server's cache.

import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, expect, test } from "./fixtures";
import { ROOT, Server, TIMELINE_FORMAT } from "./server";

/** A match whose replay Valve served (cached by the server, shared by every board). */
const FETCHED = 130816395;
/** A match past Valve's three weeks: only an upload could have had its replay. */
const UPLOADED = 130816401;

const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-board-file-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

function meta(id: number, ageDays: number) {
  const m = JSON.parse(readFileSync(join(ROOT, "crates/server/tests/fixtures/match-130816395-trimmed.json")).toString());
  m.match_info.match_id = id;
  m.match_info.start_time = Math.floor(Date.now() / 1000) - ageDays * 86400;
  return JSON.stringify(m);
}

test.beforeAll(async () => {
  upstream = createServer((req, res) => {
    const m = /^\/v1\/matches\/(\d+)\/metadata$/.exec((req.url ?? "").split("?")[0]!);
    if (m) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(meta(Number(m[1]), Number(m[1]) === UPLOADED ? 30 : 1));
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_CDN_BASE: `http://127.0.0.1:${port}/cdn`, REPLAY_DIR: queue });
  await server.start();
  const N = 1300;
  const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
  const timeline = {
    match_id: FETCHED, start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => slot * 300), y: range(() => (team === "amber" ? -8000 : 8000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: [],
  };
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  writeFileSync(join(server.dataDir, "replays", `${FETCHED}-cdn.json`), JSON.stringify(timeline));
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

type Rec = [string, Record<string, Record<string, unknown>>];
const hex = (n: number) => n.toString(16).padStart(32, "0");

/** A board file: the server's test fixture (one scene with ink, an arrow, a comment and a note,
 * in the oldest record shapes) plus a second scene with ink of its own. */
function boardFile(matches: number[] = []) {
  const f = JSON.parse(readFileSync(join(ROOT, "crates/server/tests/fixtures/board-file-v1-oldest-records.mapcro.json")).toString()) as { records: Rec[]; matches: number[] };
  const scene = hex(0xaaa);
  f.records.push([scene, { Scene: { name: "8:40 rotate", order: "s" } }]);
  const players = f.records.filter((r) => r[1].PlayerState);
  players.forEach((r, i) => f.records.push([hex(0xb00 + i), { PlayerState: { ...r[1].PlayerState, scene } }]));
  f.records.push([hex(0xc00), { Stroke: { scene, points: [{ x: -900, y: 0 }, { x: 900, y: 400 }], color: 3, width: 30 } }]);
  f.records.push([hex(0xc01), { Stroke: { scene, points: [{ x: 0, y: -900 }, { x: 300, y: 300 }], color: 5, width: 20 } }]);
  f.matches = matches;
  return f;
}

/** Make a board from a file through the API, as a seeded "original"; its owner link. */
async function seed(file: unknown): Promise<string> {
  const r = await fetch(`${server.url}/api/boards/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(file) });
  expect(r.status).toBe(201);
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  return `${server.url}/b/${board}#${owner_token}`;
}

async function page(browser: Browser, url: string) {
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto(url);
  return p;
}

async function joinAs(p: Page) {
  await p.locator("#join-name").fill("Coach");
  await p.keyboard.press("Enter");
  await expect(p.getByTestId("join-card")).toBeHidden();
}

/** Import `file` from the landing's Import board, and land on the new board. */
async function importFromLanding(p: Page, file: { name: string; buffer: Buffer }) {
  await p.goto(`${server.url}/`);
  await p.getByTestId("import-board-file").setInputFiles({ ...file, mimeType: "application/json" });
  await p.waitForURL(/\/b\//);
  await joinAs(p);
}

const strokes = (p: Page) => p.locator(".mapbox [data-stroke]");
const scenes = (p: Page) => p.getByTestId("scene-card");

test("Download, then Import board: the same board, new and yours, and the original untouched", async ({ browser }) => {
  const original = await seed(boardFile());
  const a = await page(browser, original);
  await joinAs(a);
  await expect(a.getByTestId("board-title")).toHaveText("Old scrim");
  await expect(scenes(a)).toHaveCount(2);
  await expect(a.locator(".mapbox [data-callout]")).toContainText("rotate");
  await expect(strokes(a)).toHaveCount(1);

  await expect(a.getByTestId("download")).toHaveAttribute("title", "Download");
  const saving = a.waitForEvent("download");
  await a.getByTestId("download").click();
  const dl = await saving;
  expect(dl.suggestedFilename()).toBe("Old scrim.mapcro.json");
  const bytes = readFileSync((await dl.path())!);
  const text = bytes.toString();
  expect(JSON.parse(text).format).toBe("mapcro-board");
  // No token of the board's in the file.
  expect(text).not.toContain(original.split("#")[1]!);

  const b = await page(browser, `${server.url}/`);
  await expect(b.getByTestId("import-board")).toHaveText("Import board");
  await importFromLanding(b, { name: dl.suggestedFilename(), buffer: bytes });
  expect(new URL(b.url()).pathname).not.toBe(new URL(original).pathname);
  await expect(b.getByTestId("board-title")).toHaveText("Old scrim");
  await expect(scenes(b)).toHaveCount(2);
  await expect(scenes(b).nth(1)).toContainText("8:40 rotate");
  await expect(b.locator(".mapbox [data-callout]")).toContainText("rotate");
  await expect(strokes(b)).toHaveCount(1);
  await scenes(b).nth(1).click();
  await expect(strokes(b)).toHaveCount(2);
  // Owned here: Share is offered, and it's in Your boards.
  await expect(b.getByTestId("share")).toBeVisible();
  await expect(b.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  // An edit to the copy (a third scene) leaves the original as it was.
  await b.getByTestId("scene-add").click();
  await expect(scenes(b)).toHaveCount(3);
  await expect(b.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await a.reload();
  await expect(a.getByTestId("board-title")).toHaveText("Old scrim");
  await expect(scenes(a)).toHaveCount(2);
  await b.goto(`${server.url}/`);
  await expect(b.getByTestId("known-title")).toHaveText(["Old scrim"]);
});

test("a match board's import opens on the match again, with Valve's replay", async ({ browser }) => {
  const original = await seed(boardFile([FETCHED]));
  const a = await page(browser, original);
  await joinAs(a);
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  const saving = a.waitForEvent("download");
  await a.getByTestId("download").click();
  const dl = await saving;

  const b = await page(browser, `${server.url}/`);
  await importFromLanding(b, { name: dl.suggestedFilename(), buffer: readFileSync((await dl.path())!) });
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(b.getByTestId("match-clock")).toHaveText(/ 21:40$/);
  await b.goto(`${server.url}/`);
  await expect(b.getByTestId("known-match")).toHaveText(String(FETCHED));
});

test("a board whose replay was an upload asks for the file again", async ({ browser }) => {
  const b = await page(browser, `${server.url}/`);
  const file = Buffer.from(JSON.stringify(boardFile([UPLOADED])));
  await importFromLanding(b, { name: "Old scrim.mapcro.json", buffer: file });
  const prompt = b.getByTestId("replay-prompt");
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await expect(b.getByTestId("replay-prompt-why")).toHaveText("Valve keeps replays about 3 weeks, and this one has expired.");
  await expect(b.getByTestId("replay-prompt-upload")).toHaveText("Upload replay file");
  await expect(b.getByTestId("match-tier")).toHaveText("API summary");
});

test("a refused file says why in a tag, and makes no board", async ({ browser }) => {
  const p = await page(browser, `${server.url}/`);
  const newer = Buffer.from(JSON.stringify({ ...boardFile(), version: 99 }));
  await p.getByTestId("import-board-file").setInputFiles({ name: "future.mapcro.json", mimeType: "application/json", buffer: newer });
  await expect(p.getByTestId("import-error")).toHaveText("Newer file");
  await p.getByTestId("import-board-file").setInputFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from('{"hello": "world"}') });
  await expect(p.getByTestId("import-error")).toHaveText("Not a board");
  const long = boardFile();
  long.records[0]![1].BoardMeta!.title = "x".repeat(81);
  await p.getByTestId("import-board-file").setInputFiles({ name: "long.mapcro.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(long)) });
  await expect(p.getByTestId("import-error")).toHaveText("Bad file");

  // Dropped on the page, the same.
  await p.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], "future.mapcro.json", { type: "application/json" }));
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, newer.toString());
  await expect(p.getByTestId("import-error")).toHaveText("Newer file");
  // Another JSON file dropped isn't sent: it isn't a board's download, and a send would spend
  // a creation attempt to be told so.
  const sent: string[] = [];
  p.on("request", (r) => r.url().includes("/api/boards/import") && sent.push(r.url()));
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['{"hello": "world"}'], "notes.json", { type: "application/json" }));
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(p.getByTestId("import-error")).toHaveText("Not a board");
  expect(sent).toEqual([]);
  await expect(p).toHaveURL(`${server.url}/`);
  await expect(p.getByTestId("known-boards")).toHaveCount(0);
});

test("a board file dropped on the landing is imported", async ({ browser }) => {
  const p = await page(browser, `${server.url}/`);
  await p.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], "Old scrim.mapcro.json", { type: "application/json" }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, JSON.stringify(boardFile()));
  await p.waitForURL(/\/b\//);
  await joinAs(p);
  await expect(p.getByTestId("board-title")).toHaveText("Old scrim");
  await expect(scenes(p)).toHaveCount(2);
});
