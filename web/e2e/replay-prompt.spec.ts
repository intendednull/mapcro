// The full-replay prompt (spec §6b; operator-approved design, 2026-11-08): when Valve's replay
// can't come, the tab that opened the match is asked, over the map, while the API summary plays:
// Try again, Upload replay file, or Use API summary. One reason line per cause; an expired match
// asks on open, the rest when the fetch fails. Nobody else on the board sees it. A fake
// deadlock-api and CDN; the test plays the worker (its on-disk queue is the contract).

import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { ROOT, Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

/** Valve hasn't got it yet (salts 404); its first salts answer is held until the test says. */
const NOT_YET = 130816395;
/** Past Valve's three weeks. */
const OLD = 130816401;
/** deadlock-api answers 500. */
const DOWN = 130816402;
/** The CDN sends something that isn't a replay. */
const BAD = 130816403;
/** For Player's Load, Esc and the second viewer (salts 404). */
const LOADED = 130816404;
/** For the upload from the prompt (salts 404). */
const UP = 130816405;
/** Rate-limited (asked last: the backoff holds every fetch). */
const LIMITED = 130816406;

const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-prompt-"));
const shots = process.env.MAPCRO_PROMPT_SHOTS ?? "/tmp/replay-prompt-shots";
mkdirSync(shots, { recursive: true });
let upstream: ReturnType<typeof createServer>;
let server: Server;
const hits: string[] = [];
/** Salts requests held until released, by match id. */
const held = new Map<number, Promise<void>>();
function hold(id: number) {
  let release!: () => void;
  held.set(id, new Promise<void>((ok) => (release = ok)));
  return () => {
    held.delete(id);
    release();
  };
}
let releaseFirst = hold(NOT_YET);

function meta(id: number, ageDays: number) {
  const m = JSON.parse(readFileSync(join(ROOT, `crates/server/tests/fixtures/match-130816395-trimmed.json`)).toString());
  m.match_info.match_id = id;
  m.match_info.start_time = Math.floor(Date.now() / 1000) - ageDays * 86400;
  return JSON.stringify(m);
}

test.beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    const url = (req.url ?? "").split("?")[0]!;
    hits.push(url);
    const m = /^\/v1\/matches\/(\d+)\/metadata$/.exec(url);
    if (m) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(meta(Number(m[1]), Number(m[1]) === OLD ? 30 : 1));
    }
    const s = /^\/v1\/matches\/(\d+)\/salts$/.exec(url);
    if (s) {
      const id = Number(s[1]);
      await held.get(id);
      if (id === DOWN) return res.writeHead(500).end("{}");
      if (id === LIMITED) return res.writeHead(429, { "retry-after": "600" }).end("{}");
      if (id === BAD) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ match_id: id, cluster_id: 404, replay_salt: 77, metadata_salt: 9 }));
    }
    if (url === `/cdn/404/1422450/${BAD}_77.dem.bz2`) return res.writeHead(200).end("<html>not a replay</html>");
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
  releaseFirst();
  server.stop();
  upstream.close();
});

const N = 1300;
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
function timeline(id: number) {
  return {
    match_id: id, start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => slot * 300), y: range(() => (team === "amber" ? -8000 : 8000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: [],
  };
}
const demo = (kb = 64) => Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(kb * 1024, 7)]);
const salts = (id: number) => hits.filter((h) => h === `/v1/matches/${id}/salts`).length;

async function openFromLanding(browser: Browser, id: number, viewport = { width: 1440, height: 900 }, phone = false) {
  const p = await (await browser.newContext({ viewport, ...(phone ? { hasTouch: true, isMobile: true } : {}) })).newPage();
  await p.goto(`${server.url}/`);
  await p.getByTestId("open-match-id").fill(String(id));
  await p.getByTestId("open-match-go").click();
  await p.waitForURL(/\/b\//);
  await p.locator("#join-name").fill("Coach");
  await p.keyboard.press("Enter");
  await expect(p.getByTestId("join-card")).toBeHidden();
  return p;
}
/** A screenshot for the operator, once the match behind has drawn its heroes and art. */
async function shot(p: Page, name: string) {
  // 15:00: some heroes away from the lanes' middle, which the dialog covers.
  await p.getByTestId("match-time").fill("900");
  await expect(p.locator(".tok").first()).toBeVisible();
  await p.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => undefined))));
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${shots}/${name}.png` });
}
const prompt = (p: Page) => p.getByTestId("replay-prompt");

/** The prompt reads as the operator approved, with these buttons. */
async function expectPrompt(p: Page, why: string, retry: boolean) {
  await expect(prompt(p)).toBeVisible({ timeout: 15_000 });
  await expect(prompt(p)).toHaveAttribute("role", "dialog");
  await expect(p.getByRole("dialog", { name: "Full replay unavailable" })).toBeVisible();
  await expect(p.getByTestId("replay-prompt-why")).toHaveText(why);
  await expect(prompt(p)).toContainText("The API summary has heroes, souls and events, but no troopers, health or camps.");
  await expect(p.getByTestId("replay-prompt-retry")).toHaveCount(retry ? 1 : 0);
  await expect(p.getByTestId("replay-prompt-upload")).toHaveText("Upload replay file");
  await expect(p.getByTestId("replay-prompt-summary")).toHaveText("Use API summary");
  await expect(prompt(p).getByTestId("replay-help-open")).toHaveText("Where's my replay?");
  // The summary is there underneath, and the old notice doesn't say it twice.
  await expect(p.getByTestId("match-tier")).toHaveText("API summary");
  await expect(p.getByTestId("match-notice")).toHaveCount(0);
}

test("not at Valve yet: fetching first, then the prompt; Try again fetches again and it returns", async ({ browser }) => {
  const p = await openFromLanding(browser, NOT_YET);
  const chip = p.getByTestId("match-tier");
  await expect(chip).toHaveText("Fetching replay…");
  await expect(p.getByTestId("match-play")).toBeVisible(); // the summary plays meanwhile
  await expect.poll(() => salts(NOT_YET)).toBe(1);
  await expect(prompt(p)).toHaveCount(0);
  releaseFirst();
  await expectPrompt(p, "Valve doesn't have the replay yet.", true);
  // Focus went into the dialog.
  expect(await p.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(true);
  await shot(p, "prompt-not-yet-1440");
  // Try again: closed, fetching again, then back when that fails too.
  const release = hold(NOT_YET);
  await p.getByTestId("replay-prompt-retry").click();
  await expect(prompt(p)).toHaveCount(0);
  await expect(chip).toHaveText("Fetching replay…");
  await expect.poll(() => salts(NOT_YET)).toBe(2);
  release();
  await expectPrompt(p, "Valve doesn't have the replay yet.", true);
});

test("expired: the prompt on open, with no Try again, and nothing asked of Valve", async ({ browser }) => {
  const p = await openFromLanding(browser, OLD);
  await expectPrompt(p, "Valve keeps replays about 3 weeks, and this one has expired.", false);
  await shot(p, "prompt-expired-1440");
  // Where's my replay? opens the guide, inside the dialog.
  await prompt(p).getByTestId("replay-help-open").click();
  await expect(prompt(p).getByTestId("replay-help-steps")).toBeVisible();
  await expect(prompt(p).getByTestId("replay-help-file")).toHaveText(`${OLD}.dem`);
  await shot(p, "prompt-expired-help-1440");
  expect(salts(OLD)).toBe(0);
});

test("deadlock-api down, and a download that couldn't be read, each say so", async ({ browser }) => {
  const d = await openFromLanding(browser, DOWN);
  await expectPrompt(d, "deadlock-api is down right now.", true);
  await shot(d, "prompt-down-1440");
  const b = await openFromLanding(browser, BAD);
  await expectPrompt(b, "The download couldn't be read.", true);
  await shot(b, "prompt-unreadable-1440");
});

test("Use API summary closes it for good in this browser; the chip brings it back; Esc closes it", async ({ browser }) => {
  // Player's Load opens it too (an editor attaching the match).
  const a = await joinNew(browser, await newBoardUrl(server, "Summary"), "Coach");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(String(LOADED));
  await a.getByTestId("match-load").click();
  await expectPrompt(a, "Valve doesn't have the replay yet.", true);
  await a.getByTestId("replay-prompt-summary").click();
  await expect(prompt(a)).toHaveCount(0);
  await a.reload();
  const chip = a.getByTestId("match-tier");
  await expect(chip).toHaveText("API summary");
  await expect(chip).toHaveAttribute("data-why", "Replay not found yet");
  await a.waitForTimeout(1500);
  await expect(prompt(a)).toHaveCount(0);
  // The chip reopens it, and says so.
  await expect(chip).toHaveAttribute("title", "Full replay unavailable: upload or try again");
  await chip.click();
  await expectPrompt(a, "Valve doesn't have the replay yet.", true);
  // Esc closes it; the arrows inside it don't seek the match.
  const clock = await a.getByTestId("match-clock").textContent();
  await a.keyboard.press("ArrowRight");
  await expect(a.getByTestId("match-clock")).toHaveText(clock!);
  await a.keyboard.press("Escape");
  await expect(prompt(a)).toHaveCount(0);
});

test("Esc on a fresh prompt chooses the summary: a reload doesn't ask again", async ({ browser }) => {
  const p = await openFromLanding(browser, LOADED);
  await expectPrompt(p, "Valve doesn't have the replay yet.", true);
  await p.keyboard.press("Escape");
  await expect(prompt(p)).toHaveCount(0);
  await p.reload();
  await expect(p.getByTestId("match-tier")).toHaveAttribute("data-why", "Replay not found yet");
  await p.waitForTimeout(1500);
  await expect(prompt(p)).toHaveCount(0);
});

test("a reload of the tab that opened it asks again; a second person on the board never sees it", async ({ browser }) => {
  const a = await openFromLanding(browser, UP);
  await expectPrompt(a, "Valve doesn't have the replay yet.", true);
  const url = a.url();
  await a.reload();
  await expectPrompt(a, "Valve doesn't have the replay yet.", true);
  // Someone else with the same link, in their own browser: the chip only.
  const b = await joinNew(browser, url, "Viewer");
  const chip = b.getByTestId("match-tier");
  await expect(chip).toHaveText("API summary");
  await expect(chip).toHaveAttribute("data-why", "Replay not found yet");
  await b.waitForTimeout(1500);
  await expect(prompt(b)).toHaveCount(0);
  await expect(chip).not.toHaveAttribute("title", "Full replay unavailable: upload or try again");
  await chip.click();
  await expect(prompt(b)).toHaveCount(0);
  await expect(b.getByTestId("tier-reason")).toHaveText("Replay not found yet");

  // Upload replay file, from the prompt: the file picker, then the upload as usual.
  const chooser = a.waitForEvent("filechooser");
  await a.getByTestId("replay-prompt-upload").click();
  await (await chooser).setFiles({ name: `${UP}.dem`, mimeType: "application/octet-stream", buffer: demo() });
  await expect(prompt(a)).toHaveCount(0);
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${UP}-`) && f.endsWith(".dem")) ?? ""), { timeout: 15_000 }).not.toBe("");
  expect(job).not.toContain("-cdn");
  await expect(a.getByTestId("match-tier")).toHaveText(/^Queued|Uploading|Parsing/);
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline(UP)));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay", { timeout: 15_000 });
  await expect(a.getByTestId("match-credit")).toHaveText("Replay: uploaded");
  await expect(prompt(a)).toHaveCount(0);
});

// Last: deadlock-api's 429 backs every fetch off for its Retry-After.
test("busy: the prompt says so with all three, at 1440 and on a phone", async ({ browser }) => {
  const p = await openFromLanding(browser, LIMITED);
  await expectPrompt(p, "Replay downloads are busy right now.", true);
  await shot(p, "prompt-busy-1440");
  const phone = await openFromLanding(browser, LIMITED, { width: 390, height: 844 }, true);
  await expectPrompt(phone, "Replay downloads are busy right now.", true);
  // It fits, and the buttons stack, full width.
  const box = (await prompt(phone).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  const [r, u, s] = await Promise.all(["replay-prompt-retry", "replay-prompt-upload", "replay-prompt-summary"].map(async (t) => (await phone.getByTestId(t).boundingBox())!));
  expect(u!.y).toBeGreaterThan(r!.y + r!.height - 1);
  expect(s!.y).toBeGreaterThan(u!.y + u!.height - 1);
  expect(Math.abs(r!.width - s!.width)).toBeLessThan(1);
  await shot(phone, "prompt-busy-390");
  // Try again while backing off: refused at once, and it asks again.
  await phone.getByTestId("replay-prompt-retry").click();
  await expectPrompt(phone, "Replay downloads are busy right now.", true);
});
