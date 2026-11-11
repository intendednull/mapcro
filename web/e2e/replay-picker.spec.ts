// The Windows app's replay picker (spec §6b, The Windows app; operator 2026-11-10): in the app,
// the landing's Select replay and Player's Upload replay open a list of the replays folder's
// replays as preview cards (heroes, kills, souls, the winner), and a pick is the upload: parsed in
// the app, only its timeline sent. The app is stubbed (`__TAURI_INTERNALS__.invoke`, as Tauri
// injects it), and so are the previews and the timeline route; the board, the landing and the
// rest are the real server. In a browser nothing of this shows.
//
// With MAPCRO_SHOT_PACKS pointing at a PACKS_DIR (outside the repo), the cards draw the real
// pack's hero icons; screenshots go to MAPCRO_PICKER_SHOTS (default /tmp/pw-replay-picker),
// never into the repo.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, type Page, expect, test } from "./fixtures";
import { revealControls } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";

/** deadlock-api has its metadata, Valve no replay: the prompt asks. */
const KNOWN = 130816395;
/** Another match with a preview, a fresh one without metadata, and a Brawl match. */
const OTHER = 130816390;
const FRESH = 130816391;
const BRAWL = 130816392;
const shots = process.env.MAPCRO_PICKER_SHOTS ?? "/tmp/pw-replay-picker";
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
    const m = /^\/v1\/matches\/(\d+)\/metadata$/.exec((req.url ?? "").split("?")[0]!);
    if (m && Number(m[1]) === KNOWN) {
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
    REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-e2e-picker-")),
  });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

type Folder = { replays: Array<{ id: string; lastModified: number; size: number }> | "not_found"; other?: Array<{ id: string; lastModified: number; size: number }> };

/** The app's IPC, as Tauri injects it: the folder from `window.__folder`, calls counted. */
function APP() {
  const w = window as unknown as { __folder: Folder; __calls: string[]; __TAURI_INTERNALS__: unknown };
  w.__calls = [];
  w.__folder ??= JSON.parse(sessionStorage.getItem("folder") ?? '{"replays":[]}') as Folder;
  w.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: { id?: string }) => {
      w.__calls.push(args?.id ? `${cmd}:${args.id}` : cmd);
      const f = w.__folder;
      if (cmd === "replays_list") {
        if (f.replays === "not_found") throw "not_found";
        return f.replays;
      }
      if (cmd === "replays_choose_folder") {
        f.replays = f.other ?? [];
        return "chosen";
      }
      if (cmd === "replay_timeline") return [31, 139, 8, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      throw "unknown_command";
    },
  };
}

const hours = (h: number) => Date.now() - h * 3_600_000;
const r = (id: number, h: number) => ({ id: String(id), lastModified: hours(h), size: 500_000_000 });

/** A preview in the server's shape, with real hero ids (the pack's, when one is given). */
function preview(id: number, winner: "amber" | "sapphire" | null, mode = 1) {
  const amber = [1, 2, 3, 4, 6, 7];
  const sapphire = [8, 10, 11, 12, 13, 14];
  return {
    match_id: id,
    start_time: Math.floor(hours(3) / 1000),
    duration_s: 2052,
    game_mode: mode,
    winner,
    teams: [
      { team: "amber", heroes: amber.map((h, i) => [i, h]), kills: 31, souls: 214_300 },
      { team: "sapphire", heroes: sapphire.map((h, i) => [i, h]), kills: 27, souls: 198_900 },
    ],
  };
}

/** A context in the app's window: previews and the timeline route stubbed and recorded. */
async function inApp(browser: Browser, folder: Folder) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((f) => sessionStorage.setItem("folder", JSON.stringify(f)), folder);
  await ctx.addInitScript(APP);
  const asked: string[] = [];
  const sent: Array<{ id: string; encoding: string | undefined }> = [];
  await ctx.route("**/api/matches/*/preview", async (route) => {
    const id = Number(/matches\/(\d+)\/preview/.exec(route.request().url())![1]);
    asked.push(String(id));
    if (id === FRESH) return route.fulfill({ status: 404, json: { error: "not_found" } });
    if (id === BRAWL) return route.fulfill({ status: 422, json: { error: "brawl" } });
    return route.fulfill({ status: 200, json: preview(id, id === KNOWN ? "sapphire" : "amber") });
  });
  await ctx.route("**/api/boards/*/replays/*/timeline", async (route) => {
    sent.push({ id: /replays\/(\d+)\/timeline/.exec(route.request().url())![1]!, encoding: route.request().headers()["content-encoding"] });
    return route.fulfill({ status: 200, json: { state: "done" } });
  });
  return { ctx, asked, sent };
}

async function joinBoard(p: Page) {
  await p.locator("#join-name").fill("Coach");
  await p.keyboard.press("Enter");
  await expect(p.getByTestId("join-card")).toBeHidden();
}

const calls = (p: Page) => p.evaluate(() => (window as unknown as { __calls: string[] }).__calls);

test("the landing's Select replay opens the picker; a card shows the match; a pick opens its board and sends the timeline", async ({ browser }) => {
  const { ctx, asked, sent } = await inApp(browser, { replays: [r(OTHER, 2), r(FRESH, 0.5), r(BRAWL, 30)] });
  const p = await ctx.newPage();
  await p.goto(server.url);
  await expect(p.getByTestId("open-match-file")).toHaveCount(0);
  await p.getByTestId("open-match-pick").click();
  const picker = p.getByTestId("replay-picker");
  await expect(picker).toBeVisible();
  const cards = picker.getByTestId("picker-card");
  // Newest first.
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveAttribute("data-match", String(FRESH));
  await expect(cards.nth(1)).toHaveAttribute("data-match", String(OTHER));
  // A preview: twelve heroes, the score, the winner.
  const other = picker.locator(`[data-testid=picker-card][data-match="${OTHER}"]`);
  await expect(other).toHaveAttribute("data-state", "preview");
  await expect(other.getByTestId("picker-hero")).toHaveCount(12);
  await expect(other.getByTestId("picker-kills")).toHaveText(["31", "27"]);
  await expect(other.getByTestId("picker-souls")).toHaveText(["214k", "198k"]);
  await expect(other.getByTestId("picker-won")).toHaveText("Win");
  await expect(other.locator("[data-team=amber] [data-testid=picker-won]")).toHaveCount(1);
  await expect(other.getByTestId("picker-length")).toHaveText("34:12");
  await expect(other.getByTestId("picker-when")).toHaveText("2 h ago");
  // No metadata yet: id and time only.
  const fresh = picker.locator(`[data-testid=picker-card][data-match="${FRESH}"]`);
  await expect(fresh.getByTestId("picker-none")).toHaveText("Not recorded");
  await expect(fresh.getByTestId("picker-length")).toHaveText("—");
  await expect(fresh.getByTestId("picker-when")).toHaveText("30 min ago");
  await expect(picker.locator(`[data-testid=picker-card][data-match="${BRAWL}"] [data-testid=picker-mode]`)).toHaveText("Street Brawl");
  if (process.env.MAPCRO_SHOT_PACKS) await expect(other.locator("[data-testid=picker-hero] img").first()).toBeVisible();
  await picker.screenshot({ path: `${shots}/landing-picker.png` });
  // Each preview asked once.
  expect(asked.sort()).toEqual([String(OTHER), String(FRESH), String(BRAWL)].sort());
  // The pick: a board for the match, its timeline parsed in the app and sent, the match attached.
  const attach = p.waitForRequest((q) => q.method() === "PUT" && q.url().includes(`/matches/${OTHER}`));
  await other.click();
  await expect(picker).toHaveCount(0);
  await expect.poll(() => sent.map((s) => s.id)).toEqual([String(OTHER)]);
  expect(sent[0]!.encoding).toBe("gzip");
  await attach;
  await expect(p).toHaveURL(/\/b\//);
  expect(await calls(p)).toContain(`replay_timeline:${OTHER}`);
  expect((await calls(p)).filter((c) => c.startsWith("replay_read"))).toEqual([]);
});

test("in Player the prompt's Upload replay opens the picker, the open match first; a pick sends it", async ({ browser }) => {
  const { ctx, sent } = await inApp(browser, { replays: [r(OTHER, 1), r(KNOWN, 5)] });
  const p = await ctx.newPage();
  await p.goto(await newBoardUrl(server, "Picker"));
  await joinBoard(p);
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(String(KNOWN));
  await p.getByTestId("match-load").click();
  const prompt = p.getByTestId("replay-prompt");
  await expect(prompt.getByTestId("replay-prompt-why")).toHaveText("Valve doesn't have the replay yet.", { timeout: 15_000 });
  // No link, no file dialog in the app: Upload replay is the picker.
  await expect(p.locator("[data-testid^=folder-]")).toHaveCount(0);
  await expect(prompt.getByTestId("replay-prompt-upload")).toHaveText("Upload replay");
  await expect(prompt.getByTestId("replay-prompt-upload")).toHaveClass(/primary/);
  await prompt.getByTestId("replay-prompt-upload").click();
  const picker = p.getByTestId("replay-picker");
  const cards = picker.getByTestId("picker-card");
  await expect(cards.first()).toHaveAttribute("data-match", String(KNOWN));
  await expect(cards.first().getByTestId("picker-current")).toHaveText("This match");
  await expect(cards.first().locator("[data-team=sapphire] [data-testid=picker-won]")).toHaveText("Win");
  await picker.screenshot({ path: `${shots}/player-picker.png` });
  await cards.first().click();
  await expect.poll(() => sent.map((s) => s.id)).toEqual([String(KNOWN)]);
  await expect(picker).toHaveCount(0);
});

test("an empty folder, a folder not found, and Change folder; the list refreshes only while open", async ({ browser }) => {
  const { ctx } = await inApp(browser, { replays: "not_found", other: [r(OTHER, 1)] });
  const p = await ctx.newPage();
  await p.goto(server.url);
  await p.getByTestId("open-match-pick").click();
  const picker = p.getByTestId("replay-picker");
  await expect(picker.getByTestId("picker-missing")).toHaveText("Replays folder not found");
  await picker.screenshot({ path: `${shots}/picker-missing.png` });
  await picker.getByTestId("picker-folder").click();
  await expect(picker.getByTestId("picker-card")).toHaveCount(1);
  // Emptied meanwhile: seen on focus.
  await p.evaluate(() => ((window as unknown as { __folder: Folder }).__folder.replays = []));
  await p.evaluate(() => dispatchEvent(new Event("focus")));
  await expect(picker.getByTestId("picker-empty")).toHaveText("No replays");
  // Closed: no more looks.
  await picker.getByTestId("picker-close").click();
  await expect(picker).toHaveCount(0);
  const before = (await calls(p)).filter((c) => c === "replays_list").length;
  await p.evaluate(() => dispatchEvent(new Event("focus")));
  await p.waitForTimeout(6_000);
  expect((await calls(p)).filter((c) => c === "replays_list").length).toBe(before);
});

test("cards past the first ten come with More; previews are asked for cards in view only", async ({ browser }) => {
  const many = Array.from({ length: 14 }, (_, i) => r(130816300 + i, i + 1));
  const { ctx, asked } = await inApp(browser, { replays: many });
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1280, height: 520 });
  await p.goto(server.url);
  await p.getByTestId("open-match-pick").click();
  const picker = p.getByTestId("replay-picker");
  await expect(picker.getByTestId("picker-card")).toHaveCount(10);
  await expect(picker.getByTestId("picker-card").first()).toHaveAttribute("data-state", "preview");
  expect(asked.length, "only the cards in view").toBeLessThan(10);
  await picker.getByTestId("picker-more").click();
  await expect(picker.getByTestId("picker-card")).toHaveCount(14);
  await expect(picker.getByTestId("picker-more")).toHaveCount(0);
  await picker.getByTestId("picker-card").last().scrollIntoViewIfNeeded();
  await expect(picker.getByTestId("picker-card").last()).toHaveAttribute("data-state", "preview");
  expect(new Set(asked).size).toBe(asked.length);
});

test("in a browser nothing changes: the file input stays and no picker shows", async ({ browser }) => {
  const ctx: BrowserContext = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(server.url);
  await expect(p.getByTestId("open-match-file")).toHaveCount(1);
  await expect(p.getByTestId("open-match-pick")).toHaveCount(0);
});
