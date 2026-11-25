// Sessions phase 5, polish (sessions.md §7.2, §8, §10): the strip's details (each tab's newest
// match, its winner and length, the tier chip and the job under way; "Sandbox"; a tab nobody can
// open dimmed, "No access" on hover), loaded only for tabs in view and never through a board's
// room; Load a game (a match id, a replay file) and New board from the add menu; "All games (n)"
// once the tabs don't fit. The phone's Games sheet is in phone.spec.ts (Firefox runs it too); the
// Session people group and its follow in session-follow.spec.ts. The worker is played through
// its outbox (the queue's contract), and deadlock-api is a fake serving the fixture's match.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, type WebSocketRoute, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { ROOT, Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "130816395";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-sessions-polish-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;
test.beforeAll(async () => {
  // The fixture's match, won by Sapphire (the trimmed file has no winner of its own).
  const raw = JSON.parse(readFileSync(join(ROOT, `crates/server/tests/fixtures/match-${ID}-trimmed.json`), "utf8")) as { match_info?: Record<string, unknown> } & Record<string, unknown>;
  (raw.match_info ?? raw).winning_team = 1;
  const fixture = JSON.stringify(raw);
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
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "200", CREATE_PER_HOUR: "1000" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const tabs = (p: Page) => p.getByTestId("game-tab");
const tab = (p: Page, i: number) => tabs(p).nth(i);
const mounted = (p: Page) => p.locator('[data-testid="board"]').getAttribute("data-board");
const boardOf = (url: string) => /\/b\/([^#]+)#/.exec(url)![1]!;
const saved = (p: Page) => expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
const line = (p: Page, i: number) => tab(p, i).getByTestId("tab-line");
const tier = (p: Page, i: number) => tab(p, i).getByTestId("tab-tier");

const N = 120;
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
function timeline(id: string) {
  return {
    match_id: Number(id), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: null,
        x: range(() => slot * 1500 - 4000), y: range(() => (team === "amber" ? -3000 : 3000)),
        health: range(() => 100), deaths: [], respawn: [], souls: [[0, 500]], ult: range(() => 0), seen: [],
        items: [], abilities: [], casts: [], charges: [], effects: [], cc: [], height: [], recaps: [],
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [],
    waves: [{ lane: "lane4", t: range(() => 500), stale: [] }],
    troopers: { every_s: 1, amber: range(() => ""), sapphire: range(() => "") },
  };
}
/** The queued job for match `id`: its file in the inbox. */
async function job(id: string) {
  let name = "";
  await expect.poll(() => (name = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".dem")) ?? ""), { timeout: 15_000 }).not.toBe("");
  return name.replace(/\.dem$/, "");
}
const demo = (id: string) => ({ name: `${id}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });

interface Made {
  url: string;
  session: string;
  owner: string;
  links: string[];
}

/** A session made from the first of `titles`' boards, its other boards pasted in by its owner
 * ("Coach"), who is left on the first tab. Every tab opens through its grant. */
async function session(browser: Browser, titles: string[], viewport = { width: 1440, height: 900 }): Promise<Made & { a: Page }> {
  const links: string[] = [];
  for (const t of titles) links.push(await newBoardUrl(server, t));
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(links[0]!)!;
  const r = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Scrim review", board, board_token: token }) });
  const s = (await r.json()) as { session: string; owner_token: string };
  const url = `${server.url}/s/${s.session}#${s.owner_token}`;
  const a = await (await browser.newContext({ viewport })).newPage();
  await a.goto(url);
  await a.locator("#join-name").fill("Coach");
  await a.keyboard.press("Enter");
  await expect(a.getByTestId("join-card")).toBeHidden();
  for (let i = 1; i < links.length; i++) {
    await a.getByTestId("add-game").last().click();
    await a.getByTestId("add-paste").fill(links[i]!);
    await a.getByTestId("add-paste-go").click();
    await expect(tabs(a)).toHaveCount(i + 1);
    await expect.poll(() => mounted(a)).toBe(boardOf(links[i]!));
  }
  await tab(a, 0).click();
  await expect.poll(() => mounted(a)).toBe(boardOf(links[0]!));
  await saved(a);
  return { url, session: s.session, owner: s.owner_token, links, a };
}

/** Attach match `id` to a board through its own owner link, as an editor's open does. */
async function attach(link: string, id: string) {
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(link)!;
  const r = await fetch(`${server.url}/api/boards/${board}/matches/${id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` } });
  expect(r.status).toBe(200);
}

test("each tab says its board's newest match, winner, length and tier; Load a game and New board add tabs; a tab nobody can open is dimmed", async ({ browser }) => {
  // A long row: someone else's strip hears a job move only every few seconds.
  test.setTimeout(180_000);
  const m = await session(browser, ["Board A", "Board B", "Board C"]);
  await attach(m.links[1]!, ID);
  // A fresh page: the strip asks each tab in view for its matches, never opening its room.
  const b = await joinNew(browser, m.url, "Student");
  const sockets: string[] = [];
  b.on("websocket", (ws) => sockets.push(ws.url()));
  await expect(tabs(b)).toHaveCount(3);
  await expect(line(b, 0)).toHaveText("Sandbox");
  await expect(tier(b, 0)).toHaveCount(0);
  await expect(line(b, 1)).toHaveText("Sapphire · 21:40");
  await expect(line(b, 1)).toHaveAttribute("data-winner", "sapphire");
  await expect(tab(b, 1).locator(".game-win.sapphire")).toHaveCount(1);
  // No replay can come (the fake has none): the summary is what the board has.
  await expect(tier(b, 1)).toHaveText("API summary");
  await expect(line(b, 2)).toHaveText("Sandbox");
  // Hover text is the name alone.
  const nameB = await tab(b, 1).getByTestId("tab-name").innerText();
  await expect(tab(b, 1)).toHaveAttribute("title", nameB);
  // Switching a tab mounts its board: the one room more is that board's, the strip's none.
  await tab(b, 1).click();
  await expect.poll(() => mounted(b)).toBe(boardOf(m.links[1]!));
  await expect(b.getByTestId("match-tier")).toHaveText("API summary");
  expect(sockets.length).toBe(1);

  // ---- Someone loads a match on a tab the student saw as Sandbox: the strip catches up, as
  // someone is on that tab ----
  const { a } = m;
  await tab(a, 2).click();
  await expect.poll(() => mounted(a)).toBe(boardOf(m.links[2]!));
  await saved(a);
  await a.getByTestId("mode-player").first().click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  await expect(line(b, 2)).toHaveText("Sapphire · 21:40", { timeout: 30_000 });
  await tab(a, 0).click();
  await expect.poll(() => mounted(a)).toBe(boardOf(m.links[0]!));

  // ---- Load a game, by match id: a tab named for it, open in Player, kept in Your boards ----
  await a.getByTestId("add-game").last().click();
  await expect(a.getByTestId("add-match-id")).toBeFocused();
  await a.getByTestId("add-match-id").fill("12x");
  await a.getByTestId("add-match-go").click();
  await expect(a.getByTestId("add-match-error")).toHaveText("Invalid id");
  await a.getByTestId("add-match-id").fill(ID);
  await a.getByTestId("add-match-go").click();
  await expect(a.getByTestId("add-menu")).toHaveCount(0);
  await expect(tabs(a)).toHaveCount(4);
  await expect(tab(a, 3).getByTestId("tab-name")).toHaveText(`Match ${ID}`);
  await expect(tab(a, 3)).toHaveAttribute("aria-selected", "true");
  await expect(a.getByTestId("player")).toHaveAttribute("data-state", "match");
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  // The open tab's details are its board's own.
  await expect(line(a, 3)).toHaveText("Sapphire · 21:40");
  await expect(tier(a, 3)).toHaveText("API summary");
  // The other person's strip has the new tab and its details.
  await expect(tabs(b)).toHaveCount(4);
  await expect(line(b, 3)).toHaveText("Sapphire · 21:40");

  // ---- Load a game, with a replay file: the board uploads it; its job shows on the strip ----
  await a.getByTestId("add-game").last().click();
  await a.getByTestId("add-match-file").setInputFiles(demo("52001"));
  await a.getByTestId("add-match-go").click();
  await expect(tabs(a)).toHaveCount(5);
  await expect(tab(a, 4).getByTestId("tab-name")).toHaveText("Match 52001");
  // The open tab's own board says its upload, before the match is attached (nothing to ask yet).
  await expect(tier(a, 4)).toHaveText(/^(Uploading…|Waiting|Queued)$/);
  const j = await job("52001");
  // Someone else sees it queued, then parsing, then the full replay, without opening it: Coach
  // is on that tab, so it's asked about again now and then.
  await expect(tabs(b)).toHaveCount(5);
  await expect(tier(b, 4)).toHaveText(/^(Queued|Uploading…|Waiting)$/, { timeout: 30_000 });
  writeFileSync(join(queue, "outbox", `${j}.parsing`), "");
  await expect(tier(b, 4)).toHaveText("Parsing…", { timeout: 30_000 });
  writeFileSync(join(queue, "outbox", `${j}.json`), JSON.stringify(timeline("52001")));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(tier(a, 4)).toHaveText("Full replay");
  await expect(tier(a, 4)).toHaveAttribute("data-tier", "replay");
  // No metadata for it: the length from the board's own timeline, no winner.
  await expect(line(a, 4)).toHaveText("2:00");
  await expect(tier(b, 4)).toHaveText("Full replay", { timeout: 30_000 });

  // ---- New board: an empty one, named as asked ----
  await a.getByTestId("add-game").last().click();
  await a.getByTestId("add-new-title").fill("Fresh plan");
  await a.getByTestId("add-new-go").click();
  await expect(tabs(a)).toHaveCount(6);
  await expect(tab(a, 5).getByTestId("tab-name")).toHaveText("Fresh plan");
  await expect(tab(a, 5)).toHaveAttribute("aria-selected", "true");
  await expect(line(a, 5)).toHaveText("Sandbox");
  await saved(a);
  // Your boards keeps the adder's two games and the new board, beside the session.
  await a.goto(server.url);
  const known = a.getByTestId("known-board");
  await expect(known.filter({ hasText: "Fresh plan" })).toHaveCount(1);
  await expect(known.filter({ hasText: `Match ${ID}` })).toHaveCount(1);
  await expect(known.filter({ hasText: "Match 52001" })).toHaveCount(1);

  // ---- A tab whose grant is withdrawn (its tab left in place): dimmed, "No access" on hover ----
  // The tab's grant, from the strip's key for it (its board, and the grant it opens through).
  const grant = (await tab(b, 0).getAttribute("data-key"))!.split(" ")[1]!;
  expect(grant).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const gone = await fetch(`${server.url}/api/sessions/${m.session}/grants/${grant}`, { method: "DELETE", headers: { authorization: `Bearer ${m.owner}` } });
  expect(gone.status).toBe(204);
  // A late joiner opens the session on that tab, its first: its board refuses them, and the
  // session still asks their name, once (TD-118).
  const c = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await c.goto(m.url);
  await expect(tabs(c)).toHaveCount(6);
  await expect(c.getByTestId("no-access")).toBeVisible();
  await expect(c.getByTestId("join-card")).toBeVisible();
  await expect(c.locator("#join-h")).toHaveText("Scrim review");
  await c.locator("#join-name").fill("Late");
  await c.keyboard.press("Enter");
  await expect(c.getByTestId("join-card")).toBeHidden();
  await expect(c.getByTestId("no-access")).toBeVisible();
  const nameA = await tab(c, 0).getByTestId("tab-name").innerText();
  await expect(tab(c, 0)).toHaveClass(/unavailable/);
  await expect(tab(c, 0)).toHaveAttribute("title", `${nameA} · No access`);
  await expect(tab(c, 1)).not.toHaveClass(/unavailable/);
  await expect(tab(c, 1)).toHaveAttribute("title", nameB);
  // The tab that admits them has their name, and doesn't ask again.
  await tab(c, 1).click();
  await expect.poll(() => mounted(c)).toBe(boardOf(m.links[1]!));
  await expect(c.getByTestId("no-access")).toHaveCount(0);
  await expect(c.getByTestId("join-card")).toHaveCount(0);
  await expect(tab(b, 1).locator(`.game-dot[title="Late"]`)).toHaveCount(1);
  await tab(b, 1).click();
  await expect.poll(() => mounted(b)).toBe(boardOf(m.links[1]!));
  await expect(b.getByTestId("people")).toContainText("Late");
  await c.reload();
  await expect(tabs(c)).toHaveCount(6);
  await expect(c.getByTestId("join-card")).toHaveCount(0);
  // Nor on the tab that refuses them.
  await tab(c, 0).click();
  await expect(c.getByTestId("no-access")).toBeVisible();
  await c.reload();
  await expect(tabs(c)).toHaveCount(6);
  await expect(c.getByTestId("no-access")).toBeVisible();
  await expect(c.getByTestId("join-card")).toHaveCount(0);
});

test("a tab whose owner link is opened elsewhere keeps its details, asked with the new credential (TD-118)", async ({ browser }) => {
  const m = await session(browser, ["Board A", "Board B"]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const b = await ctx.newPage();
  await b.goto(m.url);
  await b.locator("#join-name").fill("Student");
  await b.keyboard.press("Enter");
  await expect(line(b, 1)).toHaveText("Sandbox");
  const board = boardOf(m.links[1]!);
  const token = m.links[1]!.split("#")[1]!;
  // Asked again with the board's own link, once this browser holds it.
  const own = b.waitForRequest((r) => r.url().endsWith(`/api/boards/${board}/matches`) && r.headers().authorization === `Bearer ${token}`, { timeout: 20_000 });
  const other = await ctx.newPage();
  await other.goto(m.links[1]!);
  await other.locator("#join-name").press("Enter");
  await expect(other.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await own;
  // Anything the strip hears reads the tab's key as it is now: it still says what it did.
  await tab(b, 1).click();
  await expect.poll(() => mounted(b)).toBe(board);
  await tab(b, 0).click();
  await expect.poll(() => mounted(b)).toBe(boardOf(m.links[0]!));
  await expect(line(b, 1)).toHaveText("Sandbox");
});

test("the open tab's owner link opened elsewhere: what its board says reaches the strip, and leaving asks with the new credential (TD-118)", async ({ browser }) => {
  const m = await session(browser, ["Board A", "Board B"]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const b = await ctx.newPage();
  await b.goto(m.url);
  await b.locator("#join-name").fill("Student");
  await b.keyboard.press("Enter");
  await expect(line(b, 1)).toHaveText("Sandbox");
  const board = boardOf(m.links[1]!);
  const token = m.links[1]!.split("#")[1]!;
  await tab(b, 1).click();
  await expect.poll(() => mounted(b)).toBe(board);
  const byOwnLink = (r: { url(): string; headers(): Record<string, string> }) => r.url().endsWith(`/api/boards/${board}/matches`) && r.headers().authorization === `Bearer ${token}`;
  // The strip moves to the board's own link while the board stays open through its grant.
  const own = b.waitForResponse((r) => byOwnLink(r.request()), { timeout: 20_000 });
  const other = await ctx.newPage();
  await other.goto(m.links[1]!);
  await other.locator("#join-name").press("Enter");
  await expect(other.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await own;
  await other.close();
  await expect(line(b, 1)).toHaveText("Sandbox");
  // A match loaded on the open board: the tab says so at once.
  await b.getByTestId("mode-player").first().click();
  await revealControls(b, "match-id");
  await b.getByTestId("match-id").fill(ID);
  await b.getByTestId("match-load").click();
  await expect(b.getByTestId("match-tier")).toHaveText("API summary");
  await expect(line(b, 1)).toHaveText(/^Sapphire/);
  await expect(tier(b, 1)).toHaveText("API summary");
  // Left: asked about again, with the credential the strip reads it by.
  const again = b.waitForRequest(byOwnLink, { timeout: 10_000 });
  await tab(b, 0).click();
  await expect.poll(() => mounted(b)).toBe(boardOf(m.links[0]!));
  await again;
  await expect(line(b, 1)).toHaveText(/^Sapphire/);
});

test("while the server is away a tab is asked less and less, and asked soon after it's back (TD-118)", async ({ browser }) => {
  test.setTimeout(200_000);
  const m = await session(browser, ["Board A", "Board B"]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const b = await ctx.newPage();
  const board = boardOf(m.links[1]!);
  let asked = 0;
  // The page's sockets, to drop them: going offline leaves an open socket up.
  const sockets = new Set<WebSocketRoute>();
  await b.routeWebSocket(/.*/, (w) => {
    w.connectToServer();
    sockets.add(w);
  });
  // Tab B's board gives no answer, from the page's first ask.
  await b.route(`**/api/boards/${board}/matches`, (r) => {
    asked++;
    return r.abort();
  });
  await b.goto(m.url);
  await b.locator("#join-name").fill("Student");
  await b.keyboard.press("Enter");
  await expect(tabs(b)).toHaveCount(2);
  await expect.poll(() => asked, { timeout: 15_000 }).toBeGreaterThan(0);
  // 80 s at one ask per 5 s tick would be 16 asks; backing off, asked at about 0, 5, 15, 35 and
  // 75 s, the next not for a minute.
  await b.waitForTimeout(80_000);
  expect(asked).toBeLessThanOrEqual(6);
  // The server is back, as the session's room hears when it reconnects: asked within a tick or
  // so, where its wait has most of a minute to run.
  await b.unroute(`**/api/boards/${board}/matches`);
  for (const w of sockets) await w.close();
  await expect(line(b, 1)).toHaveText("Sandbox", { timeout: 25_000 });
});

test("Load a game refuses what the landing refuses, and a match without its metadata asks for the replay", async ({ browser }) => {
  const { a } = await session(browser, ["Only"]);
  await a.getByTestId("add-game").last().click();
  // Not found at deadlock-api, and no replay given: the landing's words, and the upload offered.
  await a.getByTestId("add-match-id").fill("52009");
  await a.getByTestId("add-match-go").click();
  await expect(a.getByTestId("add-match-error")).toContainText("Match not found yet.");
  await expect(a.getByTestId("add-match-upload")).toHaveText("Upload replay file");
  // A file named for another match.
  await a.getByTestId("add-match-file").setInputFiles(demo("52010"));
  await a.getByTestId("add-match-go").click();
  await expect(a.getByTestId("add-match-error")).toContainText("That file is match 52010, not 52009");
  await expect(tabs(a)).toHaveCount(1);
  // Not a .dem.
  await a.getByTestId("add-match-id").fill("");
  await a.getByTestId("add-match-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await a.getByTestId("add-match-go").click();
  await expect(a.getByTestId("add-match-error")).toBeVisible();
  await expect(tabs(a)).toHaveCount(1);
});

test("tabs that don't fit scroll, All games lists them all, and only tabs in view are asked about", async ({ browser }) => {
  const titles = Array.from({ length: 14 }, (_, i) => `Board ${String(i + 1).padStart(2, "0")}`);
  const m = await session(browser, titles, { width: 1100, height: 800 });
  // Few tabs fit at this width: the list is offered.
  await expect(m.a.getByTestId("all-games")).toHaveText("All games (14)");
  // A fresh page counts which boards' matches it asks for.
  const asked = new Set<string>();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const b = await ctx.newPage();
  b.on("request", (r) => {
    const u = new URL(r.url());
    const x = /^\/api\/boards\/([^/]+)\/matches$/.exec(u.pathname);
    if (x) asked.add(x[1]!);
  });
  await b.goto(m.url);
  await b.locator("#join-name").fill("Student");
  await b.keyboard.press("Enter");
  await expect(tabs(b)).toHaveCount(14);
  await expect(line(b, 0)).toHaveText("Sandbox");
  const shown = await tabs(b).evaluateAll((els) => {
    const strip = els[0]!.parentElement!.getBoundingClientRect();
    return els.map((e) => {
      const r = e.getBoundingClientRect();
      return r.right > strip.left && r.left < strip.right;
    });
  });
  const boards = await tabs(b).evaluateAll((els) => els.map((e) => e.getAttribute("data-board")!));
  expect(shown.filter(Boolean).length).toBeLessThan(14);
  // Only those in view were asked about (the open tab's board asks its own, as it mounts).
  await b.waitForTimeout(1000);
  for (let i = 0; i < 14; i++) if (!shown[i]) expect(asked.has(boards[i]!), `tab ${i} out of view`).toBe(false);
  // All games: every tab, the open one marked; picking the last switches to it and shows it.
  await b.getByTestId("all-games").click();
  const items = b.getByTestId("all-games-list").getByTestId("all-games-tab");
  await expect(items).toHaveCount(14);
  await expect(items.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(items.nth(13)).toHaveText("Board 14");
  await items.nth(13).click();
  await expect(b.getByTestId("all-games-list")).toHaveCount(0);
  await expect(tab(b, 13)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => mounted(b)).toBe(boards[13]);
  await expect(tab(b, 13)).toBeInViewport();
  // In view now: asked about, and says so.
  await expect(line(b, 13)).toHaveText("Sandbox");
  // The list again: its button closes it.
  await b.getByTestId("all-games").click();
  await expect(items).toHaveCount(14);
  await expect(items.nth(13)).toHaveAttribute("aria-checked", "true");
  await b.getByTestId("all-games").click();
  await expect(b.getByTestId("all-games-list")).toHaveCount(0);
  // With few tabs, no list.
  const few = await session(browser, ["One", "Two"]);
  await expect(tabs(few.a)).toHaveCount(2);
  await expect(few.a.getByTestId("all-games")).toHaveCount(0);
});
