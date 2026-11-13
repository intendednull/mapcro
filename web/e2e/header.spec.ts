// The desktop board header (spec §4b, The board header): one row that fits from 1920 down to
// 1180 px for every role. Left: the wordmark, the title (the only part that shrinks), a quiet save
// state and "+ Add game"; the Presenting pill or Follow chip between two spacers; right: the
// avatars (5, or 3 at 1440 and under, then "+N"), the one main action (Share for an editor, Clone
// for a view link) and More, a menu with the rest. Checked at four widths for: the owner alone,
// the owner presenting with two followers, an editor following in Player with a match, a view
// link following and a session's owner; then the menu, the save states, a long title and a full
// room on their own.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, expect, test } from "./fixtures";
import { editLink, viewLink } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";

const ID = "130816395";
const WIDTHS = [1920, 1440, 1280, 1180];
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

let upstream: ReturnType<typeof createServer>;
let matches = "";
let server: Server;
const feedbackDir = mkdtempSync(join(tmpdir(), "mapcro-e2e-header-fb-"));
writeFileSync(join(feedbackDir, "token"), "x");
/** Feedback on (nothing is sent: the API is a closed port), and the match API stubbed. */
const env = () => ({
  FEEDBACK_GITHUB_TOKEN_FILE: join(feedbackDir, "token"),
  FEEDBACK_GITHUB_API: "http://127.0.0.1:9",
  MATCH_API_BASE: matches,
  REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-e2e-header-q-")),
});

test.beforeAll(async () => {
  const fixture = readFileSync(join(ROOT, `crates/server/tests/fixtures/match-${ID}-trimmed.json`));
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
  matches = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  server = new Server(undefined, env());
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

interface JoinOpts {
  ua?: string;
  /** The portable app with an update to offer (the bridge stubbed, as open-link.spec does). */
  update?: boolean;
  width?: number;
}

/** A new device (a Windows browser unless said) that joins `url` as `name`. */
async function enter(browser: Browser, url: string, name: string, o: JoinOpts = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: o.width ?? 1440, height: 900 }, ...(o.update ? {} : { userAgent: o.ua ?? WINDOWS_UA }) });
  if (o.update)
    await ctx.addInitScript(() => {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string) => (cmd === "app_update" ? { version: "9.9.9", kind: "link" } : Promise.reject("unknown_command")),
      };
    });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.locator("#join-name").fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("join-card")).toBeHidden();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  return page;
}

/** Load the stubbed match in Player, going on with the API summary. */
async function loadMatch(p: Page) {
  await p.getByTestId("mode-player").click();
  const details = p.locator(".pl-source");
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.locator(":scope > summary").click();
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("replay-prompt-summary").click();
  await expect(p.getByTestId("match-tier")).toBeVisible();
}

async function follow(p: Page, who = "Coach") {
  await p.getByTestId(`follow-${who}`).click();
  await expect(p.getByTestId("follow-chip")).toContainText(`Following ${who}`);
}

type Role = "owner" | "editor" | "viewer" | "session";
interface Case {
  name: string;
  page: Page;
  role: Role;
  match?: boolean;
  live?: "presenting" | "follow-chip";
}

async function cases(browser: Browser): Promise<Case[]> {
  const alone = await enter(browser, await newBoardUrl(server, "Scrim vs Team Two, game 1"), "Coach");
  const b1 = await newBoardUrl(server, "Scrim vs Team Two, game 2");
  const owner = await enter(browser, b1, "Coach");
  const viewer = await enter(browser, await viewLink(server.url, b1), "Juno");
  const second = await enter(browser, await editLink(server.url, b1), "Vexa");
  await follow(viewer);
  await follow(second);
  await expect(owner.getByTestId("presenting")).toContainText("2 following");
  const b2 = await newBoardUrl(server, "Review: ranked");
  const coach = await enter(browser, b2, "Coach");
  await loadMatch(coach);
  const editor = await enter(browser, await editLink(server.url, b2), "Marrow");
  await follow(editor);
  await expect(editor.getByTestId("match-tier")).toBeVisible();
  const host = await enter(browser, await newBoardUrl(server, "Scrim night"), "Coach");
  await host.getByTestId("add-game").click();
  await expect(host.getByTestId("session-share")).toBeVisible();
  await expect(host.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  return [
    { name: "owner alone", page: alone, role: "owner" },
    { name: "owner presenting", page: owner, role: "owner", live: "presenting" },
    { name: "editor following in Player", page: editor, role: "editor", match: true, live: "follow-chip" },
    { name: "view link following", page: viewer, role: "viewer", live: "follow-chip" },
    { name: "session owner", page: host, role: "session" },
  ];
}

interface Kid {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** The header's visible children, in DOM order, by testid (the title block is "title"). */
async function header(p: Page) {
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return p.evaluate(() => {
    const h = document.querySelector("header.top")!;
    const kids = [...h.children]
      .filter((e) => !e.classList.contains("spacer"))
      .map((e) => {
        const r = e.getBoundingClientRect();
        const id = (e as HTMLElement).dataset.testid ?? (e.classList.contains("board-title") ? "title" : e.querySelector("[data-testid=match-tier]") ? "match-tier" : e.className || e.tagName);
        return { id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, last: e === h.lastElementChild };
      })
      .filter((k) => k.width > 0 && k.height > 0);
    return { kids: kids as (Kid & { last: boolean })[], sw: h.scrollWidth, cw: h.clientWidth, doc: document.documentElement.scrollWidth, iw: innerWidth };
  });
}

/** Check 1: nothing clipped, nothing wrapped, the page no wider than the window. */
function fits(h: Awaited<ReturnType<typeof header>>, at: string) {
  expect.soft(h.sw, `${at}: header scrollWidth`).toBe(h.cw);
  expect.soft(h.doc, `${at}: page scrollWidth`).toBe(h.iw);
  for (const k of h.kids) {
    expect.soft(k.right, `${at}: ${k.id} right edge`).toBeLessThanOrEqual(h.iw - 18 + 0.5);
    expect.soft(k.height, `${at}: ${k.id} height`).toBeLessThan(40);
  }
}

const mainOf = (c: Case) => (c.role === "viewer" ? "clone" : c.role === "session" ? "session-share" : "share");

test("the header fits at 1920, 1440, 1280 and 1180 for every role, in order, with one main action and the rest in More", async ({ browser }) => {
  test.setTimeout(300_000);
  const all = await cases(browser);
  for (const c of all) {
    const p = c.page;
    const top = p.locator("header.top");
    for (const w of WIDTHS) {
      await p.setViewportSize({ width: w, height: 900 });
      const at = `${c.name} at ${w}`;
      const h = await header(p);
      // 1. No overflow.
      fits(h, at);
      // 2. Order: by left edge, and nothing overlaps; More last and 34 x 34.
      const want = ["home", "title", "save-status", ...(c.role === "session" ? [] : ["add-game"]), ...(c.match ? ["match-tier"] : []), ...(c.live ? [c.live] : []), "avatars", mainOf(c), "more"];
      expect.soft([...h.kids].sort((a, b) => a.left - b.left).map((k) => k.id), `${at}: order`).toEqual(want);
      for (let i = 0; i < h.kids.length; i++)
        for (let j = i + 1; j < h.kids.length; j++) {
          const [a, b] = [h.kids[i]!, h.kids[j]!];
          const overlap = a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
          expect.soft(overlap, `${at}: ${a.id} overlaps ${b.id}`).toBe(false);
        }
      const more = h.kids.find((k) => k.id === "more");
      expect.soft(more?.last, `${at}: more is the last child`).toBe(true);
      expect.soft([Math.round(more?.width ?? 0), Math.round(more?.height ?? 0)], `${at}: more's size`).toEqual([34, 34]);
      // 10. Add game: on a plain board at every width, its label from 1280 up; never shrinks.
      if (c.role !== "session") {
        const add = top.getByTestId("add-game");
        await expect.soft(add, `${at}: add-game`).toBeVisible();
        if (w >= 1280) await expect.soft(add.locator(".add-label"), `${at}: add-game's label`).toBeVisible();
        else await expect.soft(add.locator(".add-label"), `${at}: add-game's label`).toBeHidden();
        expect.soft(await add.evaluate((e) => `${getComputedStyle(e).flexGrow} ${getComputedStyle(e).flexShrink}`), `${at}: add-game's flex`).toBe("0 0");
      }
      // 11. The scene (or game) count: only above 1440.
      const count = c.role === "session" ? top.getByTestId("session-games") : top.locator(".board-title > span");
      if (w > 1440) await expect.soft(count, `${at}: the count`).toBeVisible();
      else await expect.soft(count, `${at}: the count`).toBeHidden();
      // 13. The chip drops its scene label under 1280; the chip and the pill stay one line.
      // (In Player the chip names no scene: its label is empty.)
      if (c.live === "follow-chip" && !c.match) {
        const where = top.getByTestId("follow-chip").locator(".where");
        if (w >= 1280) await expect.soft(where, `${at}: the chip's label`).toBeVisible();
        else await expect.soft(where, `${at}: the chip's label`).toBeHidden();
      }
      if (c.live) expect.soft(h.kids.find((k) => k.id === c.live)?.height ?? 99, `${at}: ${c.live} height`).toBeLessThanOrEqual(34);
    }
    const at = c.name;
    // 3. The main action: Share (or the session's) for an editor, Clone for a view link; one filled control.
    if (c.role === "viewer") {
      await expect.soft(top.getByTestId("clone"), `${at}: clone`).toBeVisible();
      await expect.soft(top.getByTestId("share"), `${at}: share`).toHaveCount(0);
    } else {
      await expect.soft(top.getByTestId(mainOf(c)), `${at}: ${mainOf(c)}`).toBeVisible();
      await expect.soft(top.getByTestId(mainOf(c)), `${at}: ${mainOf(c)}`).toHaveClass(/\bprimary\b/);
      await expect.soft(top.getByTestId("clone"), `${at}: clone in the header`).toHaveCount(0);
    }
    expect.soft(await top.locator(".btn.primary").count(), `${at}: filled controls`).toBeLessThanOrEqual(1);
    if (c.role === "session") await expect.soft(top.getByTestId("session-share").locator("svg.ico"), `${at}: session-share's icon`).toHaveCount(1);
    // 4. Nothing else on the right: these are rows of More's menu now.
    for (const id of ["feedback-open", "open-in-app", "open-in-app-get", "download", "app-update"])
      await expect.soft(p.locator(`header.top > [data-testid="${id}"]`), `${at}: ${id} in the header`).toHaveCount(0);
  }
});

const rows = (p: Page) => p.locator('[role="menu"] [role="menuitem"]');
const focused = (p: Page) => p.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName);

test("More's menu: its rows by role and app, the update dot, the rows' testids", async ({ browser }) => {
  // 5. Owner in a Windows browser with feedback on; then a view link.
  const url = await newBoardUrl(server, "Menu");
  const owner = await enter(browser, url, "Coach");
  await expect(owner.getByTestId("more")).toHaveAttribute("aria-haspopup", "menu");
  await expect(owner.getByTestId("more")).toHaveAttribute("aria-label", "More");
  await expect(owner.getByTestId("more")).toHaveAttribute("aria-expanded", "false");
  await owner.getByTestId("more").click();
  await expect(owner.getByTestId("more")).toHaveAttribute("aria-expanded", "true");
  await expect(rows(owner)).toHaveText(["Clone", "Download", "Open in app", "Get the app", "Feedback"]);
  for (const id of ["clone", "download", "open-in-app", "open-in-app-get", "feedback-open"]) {
    await expect(owner.locator(`[role="menu"] [data-testid="${id}"]`)).toHaveAttribute("role", "menuitem");
    await expect(owner.locator(`[role="menu"] [data-testid="${id}"]`)).not.toHaveAttribute("title");
  }
  await expect(owner.getByTestId("more-dot")).toHaveCount(0);
  const viewer = await enter(browser, await viewLink(server.url, url), "Juno");
  await viewer.getByTestId("more").click();
  await expect(rows(viewer)).toHaveText(["Download", "Open in app", "Get the app", "Feedback"]);

  // Through a session grant (another device on the session's link): no Open in app.
  await owner.keyboard.press("Escape");
  await owner.getByTestId("add-game").click();
  await expect(owner.getByTestId("session-share")).toBeVisible();
  const guest = await enter(browser, owner.url(), "Vexa");
  await guest.getByTestId("more").click();
  await expect(rows(guest)).toHaveText(["Clone", "Download", "Feedback"]);

  // The portable app with an update: Update available first, and a dot on More.
  const app = await enter(browser, url, "Marrow", { update: true });
  await expect(app.getByTestId("more-dot")).toBeVisible();
  await app.getByTestId("more").click();
  await expect(rows(app)).toHaveText(["Update available", "Clone", "Download", "Feedback"]);
  await expect(app.locator('[role="menu"] [data-testid="app-update"]')).toHaveAttribute("role", "menuitem");
});

test("More's menu sits under More, inside the window, and works by keyboard", async ({ browser }) => {
  const url = await newBoardUrl(server, "Keys");
  const p = await enter(browser, url, "Coach", { width: 1180 });
  const more = p.getByTestId("more");
  // 6. Geometry.
  await more.click();
  const menu = p.locator('[role="menu"]');
  await expect(menu).toBeVisible();
  const [m, b] = [(await menu.boundingBox())!, (await more.boundingBox())!];
  expect(Math.abs(m.x + m.width - (b.x + b.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(m.y - (b.y + b.height + 6))).toBeLessThanOrEqual(1);
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(1180);
  expect(m.y + m.height).toBeLessThanOrEqual(900);
  for (const row of await rows(p).all()) {
    const r = (await row.boundingBox())!;
    expect(await row.evaluate((e, [x, y]) => e.contains(document.elementFromPoint(x!, y!)), [r.x + r.width / 2, r.y + r.height / 2])).toBe(true);
  }
  // A press outside closes it.
  await p.mouse.click(600, 400);
  await expect(menu).toHaveCount(0);

  // 7. Keys: Enter opens on the first row; Down wraps; Home and End jump; Escape gives focus back.
  await more.focus();
  await p.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  expect(await focused(p)).toBe("clone");
  await p.keyboard.press("End");
  expect(await focused(p)).toBe("feedback-open");
  await p.keyboard.press("ArrowDown");
  expect(await focused(p)).toBe("clone");
  await p.keyboard.press("ArrowUp");
  expect(await focused(p)).toBe("feedback-open");
  await p.keyboard.press("Home");
  expect(await focused(p)).toBe("clone");
  await p.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  expect(await focused(p)).toBe("more");
  // Arrow Down opens it too; Space runs Clone; closing its dialog gives focus back to More.
  await p.keyboard.press("ArrowDown");
  expect(await focused(p)).toBe("clone");
  await p.keyboard.press(" ");
  await expect(menu).toHaveCount(0);
  await expect(p.getByTestId("clone-dialog")).toBeVisible();
  await p.keyboard.press("Escape");
  await expect(p.getByTestId("clone-dialog")).toHaveCount(0);
  expect(await focused(p)).toBe("more");
  // Feedback's dialog, the same.
  await p.keyboard.press("Enter");
  await p.keyboard.press("End");
  await p.keyboard.press("Enter");
  await expect(p.getByTestId("feedback-dialog")).toBeVisible();
  await p.keyboard.press("Escape");
  await expect(p.getByTestId("feedback-dialog")).toHaveCount(0);
  expect(await focused(p)).toBe("more");
  // Tab closes it and moves on.
  await p.keyboard.press("Enter");
  await p.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  expect(await focused(p)).not.toBe("more");
  // Tab from Share lands on More.
  await p.getByTestId("share").focus();
  await p.keyboard.press("Tab");
  expect(await focused(p)).toBe("more");
});

test("the save state: a quiet check when saved, a full pill when offline or rejected", async ({ browser }) => {
  // 8. Saved: a 16 px check by the title, "Saved" still its text.
  const p = await enter(browser, await newBoardUrl(server, "Saved"), "Coach");
  const status = p.getByTestId("save-status");
  await expect(status).toHaveText("Saved");
  const s = (await status.boundingBox())!;
  const t = (await p.locator("header.top .board-title").boundingBox())!;
  expect(Math.abs(s.width - 16)).toBeLessThanOrEqual(1);
  expect(s.x - (t.x + t.width)).toBeGreaterThanOrEqual(0);
  expect(s.x - (t.x + t.width)).toBeLessThanOrEqual(12);
  await expect(status).toHaveAttribute("title", "Saved");

  // Rejected: the server refuses a title it finds too long (the socket rewrites it on the way).
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.routeWebSocket(/\/ws$/, (ws) => {
    const srv = ws.connectToServer();
    ws.onMessage((m) => srv.send(typeof m === "string" ? m.replace("Too long", "x".repeat(400)) : m));
  });
  const r = await ctx.newPage();
  await r.goto(await newBoardUrl(server, "Rejected"));
  await r.locator("#join-name").fill("Coach");
  await r.keyboard.press("Enter");
  await expect(r.getByTestId("save-status")).toHaveText("Saved");
  await r.getByTestId("board-title").click();
  await r.getByTestId("board-title-input").fill("Too long");
  await r.keyboard.press("Enter");
  await expect(r.getByTestId("save-status")).toHaveAttribute("data-state", "rejected");
  await expect(r.getByTestId("dismiss-rejection")).toBeVisible();
  expect((await r.getByTestId("save-status").boundingBox())!.width).toBeGreaterThan(60);
  await r.getByTestId("dismiss-rejection").click();
  await expect(r.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  // Offline (the server killed), for an editor following in Player, at 1180: a full pill, and
  // the header still fits (check 1).
  const down = new Server(undefined, env());
  await down.start();
  try {
    const url = await newBoardUrl(down, "Offline");
    const coach = await enter(browser, url, "Coach");
    await loadMatch(coach);
    const ed = await enter(browser, await editLink(down.url, url), "Marrow", { width: 1180 });
    await follow(ed);
    await down.kill();
    const st = ed.getByTestId("save-status");
    await expect(st).toHaveAttribute("data-state", "offline");
    await expect(st.getByText("Offline")).toBeVisible();
    expect((await st.boundingBox())!.width).toBeGreaterThan(60);
    fits(await header(ed), "editor following, offline, at 1180");
  } finally {
    down.stop();
  }
});
