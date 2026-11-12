// Reparse in the app (operator, 2026-11-11; spec §6b, The Windows app): a board's upload parsed
// in an older timeline format is stale. In the app, with that match's demo in the replays
// folder, a small alert offers "Outdated" with Reparse: one click parses it in the app and sends
// the timeline (the real client-timeline route), and Player shows the new one. Without the demo,
// or in a browser, the upload stays the way. An app whose parser the server refuses as older
// (`outdated_parser`) is pointed at the update instead. The app is stubbed
// (`__TAURI_INTERNALS__.invoke`, as Tauri injects it); the server and its checks are real.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { type Browser, type Page, expect, test } from "./fixtures";
import { revealControls } from "./helpers";
import { ROOT, Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const MATCH = 130816397;
let upstream: ReturnType<typeof createServer>;
let server: Server;

function meta(id: number) {
  const m = JSON.parse(readFileSync(join(ROOT, `crates/server/tests/fixtures/match-130816395-trimmed.json`)).toString());
  m.match_info.match_id = id;
  m.match_info.start_time = Math.floor(Date.now() / 1000) - 86400;
  return JSON.stringify(m);
}

test.beforeAll(async () => {
  // deadlock-api has the match's metadata; Valve has no replay of it (no salts).
  upstream = createServer((req, res) => {
    const m = /^\/v1\/matches\/(\d+)\/metadata$/.exec((req.url ?? "").split("?")[0]!);
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
    REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-e2e-reparse-")),
  });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const N = 700;
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
/** A timeline: format 0 (no stamp, no urn) or the current one, with an urn on the ground. */
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

type App = { replays: Array<{ id: string; lastModified: number; size: number }>; gz: number[] };

/** The app's IPC, as Tauri injects it: the folder and the parse's gzip from sessionStorage. */
function APP() {
  const w = window as unknown as { __calls: string[]; __TAURI_INTERNALS__: unknown };
  w.__calls = [];
  const a = JSON.parse(sessionStorage.getItem("app") ?? '{"replays":[],"gz":[]}') as App;
  w.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: { id?: string }) => {
      w.__calls.push(args?.id ? `${cmd}:${args.id}` : cmd);
      if (cmd === "replays_list") return a.replays;
      if (cmd === "replay_timeline") {
        if (!a.replays.some((r) => r.id === args?.id)) throw "not_found";
        if (!a.gz.length) throw "corrupt";
        return a.gz;
      }
      if (cmd === "app_update") return null;
      throw "unknown_command";
    },
  };
}

const demo = { id: String(MATCH), lastModified: Date.now() - 3_600_000, size: 500_000_000 };
const gz = (current: boolean) => [...gzipSync(JSON.stringify(timeline(MATCH, current)))];

/** A page on a new board (in the app, given `app`) whose upload of MATCH is an older parse. */
async function staleBoard(browser: Browser, app?: App): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (app) {
    await ctx.addInitScript((a) => sessionStorage.getItem("app") ?? sessionStorage.setItem("app", JSON.stringify(a)), app);
    await ctx.addInitScript(APP);
  }
  const p = await ctx.newPage();
  const url = await newBoardUrl(server, "Reparse");
  const board = /\/b\/([^/#?]+)/.exec(url)![1]!;
  const scope = createHash("sha256").update(board).digest("hex").slice(0, 16);
  const dir = join(server.dataDir, "replays");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${MATCH}-${scope}.json`), JSON.stringify(timeline(MATCH, false)));
  await p.goto(url);
  await p.locator("#join-name").fill("Coach");
  await p.keyboard.press("Enter");
  await expect(p.getByTestId("join-card")).toBeHidden();
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(String(MATCH));
  await p.getByTestId("match-load").click();
  await expect(p.getByTestId("match-tier")).toHaveAttribute("data-stale", "true");
  return p;
}

const urn = (p: Page) => p.locator("[data-testid=map] [data-testid=urn]");
const calls = (p: Page) => p.evaluate(() => (window as unknown as { __calls: string[] }).__calls);

test("in the app, a stale upload whose demo is in the folder offers Reparse; one click parses it here and Player shows the new timeline", async ({ browser }) => {
  const p = await staleBoard(browser, { replays: [demo], gz: gz(true) });
  const alert = p.getByTestId("match-reparse");
  await expect(alert).toHaveAttribute("data-offer", "reparse");
  await expect(p.getByTestId("match-reparse-text")).toHaveText("Outdated");
  const go = p.getByTestId("match-reparse-go");
  await expect(go).toHaveText("Reparse");
  await expect(go).toHaveAttribute("title", "Reparse replay");
  await expect(urn(p)).toHaveCount(0);
  const sent = p.waitForRequest((q) => q.method() === "POST" && q.url().endsWith(`/replays/${MATCH}/timeline`));
  await go.click();
  expect((await sent).headers()["content-encoding"]).toBe("gzip");
  // The new timeline, in place: current, with its newer layers.
  await expect(urn(p)).toHaveAttribute("data-state", "ground", { timeout: 15_000 });
  await expect(p.getByTestId("match-tier")).not.toHaveAttribute("data-stale", "true");
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(alert).toHaveCount(0);
  expect(await calls(p)).toContain(`replay_timeline:${MATCH}`);
  expect((await calls(p)).filter((c) => c.startsWith("replay_read"))).toEqual([]);
});

test("in the app, without the match's demo in the folder, there's no Reparse: Upload replay stays the way", async ({ browser }) => {
  const p = await staleBoard(browser, { replays: [], gz: gz(true) });
  await expect.poll(() => calls(p)).toContain("replays_list");
  await expect(p.getByTestId("match-upload")).toHaveText("Upload replay");
  await expect(p.getByTestId("match-reparse")).toHaveCount(0);
});

test("in a browser, a stale upload offers Upload replay file and no Reparse", async ({ browser }) => {
  const p = await staleBoard(browser);
  await expect(p.getByTestId("match-upload")).toHaveText("Upload replay file");
  await expect(p.getByTestId("match-reparse")).toHaveCount(0);
});

test("an app older than the server's format is refused, and pointed at the update instead of Reparse", async ({ browser }) => {
  // This app's parser writes an older format than the server's.
  const p = await staleBoard(browser, { replays: [demo], gz: gz(false) });
  await p.getByTestId("match-reparse-go").click();
  await expect(p.getByTestId("match-reparse")).toHaveAttribute("data-offer", "update");
  await expect(p.getByTestId("match-reparse-text")).toHaveText("Update the mapcro app");
  await expect(p.getByTestId("match-reparse-go")).toHaveCount(0);
  await expect(p.getByTestId("match-tier")).toHaveAttribute("data-stale", "true");
  // Loaded again in this run: the update, not Reparse.
  await p.reload();
  await p.getByTestId("player").waitFor();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(String(MATCH));
  await p.getByTestId("match-load").click();
  await expect(p.getByTestId("match-tier")).toHaveAttribute("data-stale", "true");
  await expect(p.getByTestId("match-reparse")).toHaveAttribute("data-offer", "update");
  await expect(p.getByTestId("match-reparse-text")).toHaveText("Update the mapcro app");
  await expect(p.getByTestId("match-reparse-go")).toHaveCount(0);
  expect((await calls(p)).filter((c) => c.startsWith("replay_timeline"))).toEqual([]);
});

test("a reparse that fails says how, keeps the old timeline, and offers Reparse again", async ({ browser }) => {
  // The demo is there but the app can't read it.
  const p = await staleBoard(browser, { replays: [demo], gz: [] });
  await p.getByTestId("match-reparse-go").click();
  await expect(p.getByTestId("match-reparse-text")).toHaveText("Corrupt. Download the replay again in Deadlock, then upload it.");
  await expect(p.getByTestId("match-reparse-go")).toHaveText("Reparse");
  await expect(p.getByTestId("match-tier")).toHaveAttribute("data-stale", "true");
  expect((await calls(p)).filter((c) => c.startsWith("replay_timeline"))).toEqual([`replay_timeline:${MATCH}`]);
});
