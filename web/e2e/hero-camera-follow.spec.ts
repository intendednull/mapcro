// Hero minimap token camera tracking (#16, docs/specs/hero-camera-follow.md):
// all 4 triggers (top-bar portrait dblclick, minimap token dblclick, context-sensitive F hotkey,
// hero-menu / HeroCard button), free wheel & 2-finger pinch zooming, strict Vision FOW anti-leak,
// cancellation matrix, and follower detachment.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CDPSession, type Page, expect, test } from "./fixtures";
import { dragToken, joinNew, pickHero, revealControls, tokenAt, viewOf } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";
import { heroPack } from "./synthetic";

const ID = "129000161";
const N = 60;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-herotrack-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(heroPack(14), {
    MATCH_API_BASE: `http://127.0.0.1:${port}`,
    REPLAY_DIR: queue,
    REPLAY_PER_CLIENT_PER_HOUR: "30",
  });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
const stand = (team: string, slot: number) => ({ x: slot * 1400 - 3500, y: team === "amber" ? -2800 : 2800 });

/**
 * - Amber-0 walks north steadily across the map (0..60 s), always visible.
 * - Sapphire-0 walks east across the map (-4500 -> +4500 over 60 s), seen by Amber (Hidden King)
 *   only during 10..20 s and 45..55 s (hidden in FOW during 20..45 s).
 * - Other heroes stand apart, always visible.
 */
function timeline() {
  return {
    match_id: Number(ID),
    start_time: 0,
    duration_s: N,
    source: "replay",
    tier: "replay",
    build: 6839,
    reanchored: 0,
    format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const amberWalker = team === "amber" && slot === 0;
        const sapphireFow = team === "sapphire" && slot === 0;
        const at = (s: number) =>
          amberWalker
            ? { x: -2000 + s * 60, y: -3500 + s * 110 }
            : sapphireFow
              ? { x: -4500 + s * 150, y: 1200 }
              : stand(team, slot);
        return {
          team,
          slot,
          hero_id: 1 + slot + (team === "sapphire" ? 6 : 0),
          name: null,
          x: range((s) => at(s).x),
          y: range((s) => at(s).y),
          health: range(() => 100),
          deaths: [],
          respawn: [],
          souls: [[0, 500]],
          ult: range(() => 0),
          seen: sapphireFow ? [[100, 200], [450, 550]] : [[0, N * 10]],
        };
      }),
    ),
    objectives: [],
    mid_boss: [],
    rifts: [],
    powerups: [],
    events: [],
  };
}

async function openReplay(p: Page) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({
    name: `${ID}.dem`,
    mimeType: "application/octet-stream",
    buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]),
  });
  let job = "";
  await expect
    .poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? ""))
    .not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, sec) => {
    (el as HTMLInputElement).value = String(sec);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await expect(p.getByTestId("match-clock")).toContainText(`0:${String(t).padStart(2, "0")} /`);
}

const centreOf = async (p: Page, sel: string) => {
  const r = (await p.locator(sel).first().boundingBox())!;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};

const offCentre = async (p: Page, slot: string) => {
  const t = await centreOf(p, `[data-testid=map] .tok[data-slot="${slot}"]`);
  const m = await centreOf(p, "[data-testid=map]");
  return Math.hypot(t.x - m.x, t.y - m.y);
};

const portrait = (p: Page, slot: string) => p.locator(`.tb-player[data-slot="${slot}"] [data-testid=focus-hero]`);
const tok = (p: Page, slot: string) => p.locator(`[data-testid=map] .tok[data-slot="${slot}"]`);

type Pt = { x: number; y: number };
class Fingers {
  private down = new Map<number, Pt>();
  constructor(private cdp: CDPSession) {}
  static async on(page: Page) {
    return new Fingers(await page.context().newCDPSession(page));
  }
  private points() {
    return [...this.down].map(([id, p]) => ({ id, x: p.x, y: p.y }));
  }
  async press(id: number, at: Pt) {
    this.down.set(id, at);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: this.points() });
  }
  async move(moves: Record<number, Pt>) {
    for (const [id, p] of Object.entries(moves)) this.down.set(Number(id), p);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: this.points() });
  }
  async liftAll() {
    await new Promise((ok) => setTimeout(ok, 120));
    for (const id of [...this.down.keys()]) {
      this.down.delete(id);
      if (this.down.size) await this.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: this.points() });
      else await this.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  }
}

test("1. top-bar double-click zooms to 2.5x, centers hero, closes newly opened BuildColumn, and toggles off", async ({ browser }) => {
  const url = await newBoardUrl(server, "track topbar");
  const a = await joinNew(browser, url, "Coach");
  await openReplay(a);
  await scrubTo(a, 15);

  const fitW = (await viewOf(a))[2];
  expect(fitW).toBeGreaterThan(800);

  // Double-click Amber-0 portrait in Player top bar.
  await portrait(a, "Amber-0").dblclick();

  await expect(a.getByTestId("track-chip")).toBeVisible();
  await expect(a.getByTestId("track-chip")).toContainText("Tracking Testhero A");
  await expect(a.locator('.tb-player[data-slot="Amber-0"]')).toHaveClass(/\btracked\b/);
  await expect(tok(a, "Amber-0")).toHaveClass(/\btracked\b/);
  await expect(tok(a, "Amber-0").locator(".tok-track-ring")).toHaveCount(1);

  // Zoomed from fit view to w = 400 (2.5x) and centered on Amber-0.
  await expect.poll(async () => (await viewOf(a))[2]).toBe(400);
  await expect.poll(() => offCentre(a, "Amber-0")).toBeLessThan(5);

  // Click 1 opened BuildColumn, click 2 must have closed it so it does not obscure the map.
  await expect(a.locator('.tb-player[data-slot="Amber-0"] [data-testid=hero-build]')).toHaveCount(0);

  // At most 1 ping (2nd click's duplicate ping suppressed).
  await expect(a.locator(".mapbox .ping")).toHaveCount(1);

  // Double-clicking the same portrait again stops tracking.
  await portrait(a, "Amber-0").dblclick();
  await expect(a.getByTestId("track-chip")).toHaveCount(0);
  await expect(a.locator('.tb-player[data-slot="Amber-0"]')).not.toHaveClass(/\btracked\b/);
});

test("2. minimap token double-click works in Scenes (zero undo ops) and Player (cleans up HeroCard)", async ({ browser }) => {
  const url = await newBoardUrl(server, "track token");
  const a = await joinNew(browser, url, "Coach");
  await pickHero(a, "Amber-3", "Testhero B");
  await dragToken(a, "Amber-3", 0.32, 0.42);

  // Verify token position before double-click and that we have 1 undoable edit (the drag).
  const beforePos = await tokenAt(a, "Amber-3");
  await expect(a.getByTestId("undo")).toBeEnabled();

  // Double-click the minimap token in Scenes.
  const c = await centreOf(a, '[data-testid=map] .tok[data-slot="Amber-3"]');
  await a.mouse.click(c.x, c.y);
  await a.mouse.click(c.x, c.y);

  await expect(a.getByTestId("track-chip")).toBeVisible();
  await expect(a.getByTestId("track-chip")).toContainText("Tracking Testhero B");
  await expect.poll(async () => (await viewOf(a))[2]).toBe(400);
  await expect.poll(() => offCentre(a, "Amber-3")).toBeLessThan(5);
  expect(await tokenAt(a, "Amber-3")).toEqual(beforePos);

  // Zero drag ops were emitted on tap 1/2: a single Undo reverts the dragToken move itself.
  await a.getByTestId("undo").click();
  await expect.poll(() => tokenAt(a, "Amber-3")).not.toEqual(beforePos);

  // Context menu trigger (`hero-menu-track`) toggles tracking off then on.
  await a.locator('.tb-player[data-slot="Amber-3"]').click({ button: "right" });
  await expect(a.getByTestId("hero-menu-track")).toHaveText("Stop tracking");
  await a.getByTestId("hero-menu-track").click();
  await expect(a.getByTestId("track-chip")).toHaveCount(0);

  await a.locator('.tb-player[data-slot="Amber-3"]').click({ button: "right" });
  await expect(a.getByTestId("hero-menu-track")).toHaveText("Track hero");
  await a.getByTestId("hero-menu-track").click();
  await expect(a.getByTestId("track-chip")).toBeVisible();

  // Now open a fresh board in Player (at fit view) and test token double-click + HeroCard cleanup.
  const playerUrl = await newBoardUrl(server, "track token player");
  const p = await joinNew(browser, playerUrl, "Coach");
  await openReplay(p);
  await scrubTo(p, 15);

  // Double-click Sapphire-1 token when HeroCard is closed -> zooms from fit to 400, tracks hero, and closes the HeroCard tap 1 opened.
  const s1 = await centreOf(p, '[data-testid=map] .tok[data-slot="Sapphire-1"]');
  await p.mouse.click(s1.x, s1.y);
  await p.mouse.click(s1.x, s1.y);
  await expect(p.getByTestId("track-chip")).toBeVisible();
  await expect(p.getByTestId("track-chip")).toHaveAttribute("data-slot", "sapphire-1");
  await expect(p.getByTestId("hero-card")).toHaveCount(0);
  await expect.poll(async () => (await viewOf(p))[2]).toBe(400);
  await expect.poll(() => offCentre(p, "Sapphire-1")).toBeLessThan(5);

  // Single-click Sapphire-1 token to open HeroCard, then use HeroCard's track toggle button.
  await tok(p, "Sapphire-1").click();
  await expect(p.getByTestId("hero-card")).toHaveCount(1);
  await expect(p.getByTestId("hero-card-track")).toHaveAttribute("aria-pressed", "true");
  await p.getByTestId("hero-card-track").click();
  await expect(p.getByTestId("track-chip")).toHaveCount(0);
  await expect(p.getByTestId("hero-card-track")).toHaveAttribute("aria-pressed", "false");

  // With HeroCard ALREADY open before tap 1, double-clicking the token starts tracking and leaves HeroCard open.
  const s1Again = await centreOf(p, '[data-testid=map] .tok[data-slot="Sapphire-1"]');
  await p.mouse.click(s1Again.x, s1Again.y);
  await p.mouse.click(s1Again.x, s1Again.y);
  await expect(p.getByTestId("track-chip")).toBeVisible();
  await expect(p.getByTestId("hero-card")).toHaveCount(1);
});

test("3. hover hotkey F tracks hovered token or portrait, toggles off, switches hero, and falls through to presenter follow on empty map", async ({ browser }) => {
  const url = await newBoardUrl(server, "track hotkey F");
  const a = await joinNew(browser, url, "Coach");
  await openReplay(a);
  await scrubTo(a, 15);
  const b = await joinNew(browser, url, "Marrow");
  const c = await joinNew(browser, url, "Vexa");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(c.getByTestId("match-tier")).toHaveText("Full replay");
  // Make Coach an active presenter (Vexa follows Coach).
  await c.getByTestId("follow-Coach").click();
  await expect(c.getByTestId("follow-chip")).toContainText("Following Coach");

  // Hover minimap token Amber-0 on Marrow and press F -> tracks Amber-0 (does NOT follow Coach).
  const t0 = await centreOf(b, '[data-testid=map] .tok[data-slot="Amber-0"]');
  await b.mouse.move(t0.x, t0.y);
  await b.keyboard.press("f");
  await expect(b.getByTestId("track-chip")).toHaveAttribute("data-slot", "amber-0");
  await expect(b.getByTestId("stop-following")).toHaveCount(0);
  await expect.poll(() => offCentre(b, "Amber-0")).toBeLessThan(5);

  // Hover top-bar portrait Sapphire-2 and press F -> switches tracking directly to Sapphire-2.
  const p2 = await centreOf(b, '.tb-player[data-slot="Sapphire-2"] [data-testid=focus-hero]');
  await b.mouse.move(p2.x, p2.y);
  await b.keyboard.press("f");
  await expect(b.getByTestId("track-chip")).toHaveAttribute("data-slot", "sapphire-2");
  await expect.poll(() => offCentre(b, "Sapphire-2")).toBeLessThan(5);

  // Press F again while still hovering Sapphire-2 -> stops tracking.
  await b.keyboard.press("f");
  await expect(b.getByTestId("track-chip")).toHaveCount(0);

  // Move pointer to an empty corner inside the visible map box (not over any token or portrait) and press F -> falls through to presenter follow!
  const mapBox = (await b.getByTestId("map").boundingBox())!;
  await b.mouse.move(mapBox.x + mapBox.width * 0.12, mapBox.y + mapBox.height * 0.12);
  await b.keyboard.press("f");
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
});

test("4. free zooming via mouse wheel and 2-finger touch pinch keeps tracking active and hero centered during playback", async ({ browser }) => {
  const url = await newBoardUrl(server, "track zoom");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  const a = await ctx.newPage();
  await a.goto(url);
  await a.locator("#join-name").fill("Coach");
  await a.keyboard.press("Enter");
  await expect(a.getByTestId("join-card")).toBeHidden();
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  await openReplay(a);
  await scrubTo(a, 5);
  await portrait(a, "Amber-0").dblclick();
  await expect(a.getByTestId("track-chip")).toHaveAttribute("data-slot", "amber-0");
  await expect.poll(async () => (await viewOf(a))[2]).toBe(400);
  await expect.poll(() => offCentre(a, "Amber-0")).toBeLessThan(5);

  // Start playback so Amber-0 moves continuously across the map.
  await a.getByTestId("match-play").click();

  // Mouse wheel zoom in while tracking: w shrinks, tracking stays active, hero stays centered.
  const mid = await centreOf(a, "[data-testid=map]");
  await a.mouse.move(mid.x + 80, mid.y - 60);
  await a.mouse.wheel(0, -250);
  await expect.poll(async () => (await viewOf(a))[2]).toBeLessThan(350);
  await expect(a.getByTestId("track-chip")).toBeVisible();
  await expect.poll(() => offCentre(a, "Amber-0")).toBeLessThan(8);

  // Mouse wheel zoom out while tracking: w grows, tracking stays active.
  const zoomedInW = (await viewOf(a))[2];
  await a.mouse.wheel(0, 300);
  await expect.poll(async () => (await viewOf(a))[2]).toBeGreaterThan(zoomedInW + 50);
  await expect(a.getByTestId("track-chip")).toBeVisible();

  // 2-finger touch pinch zoom (with midpoint drift!) must NOT cancel tracking!
  const wBeforePinch = (await viewOf(a))[2];
  const f = await Fingers.on(a);
  await f.press(1, { x: mid.x - 30, y: mid.y });
  await f.press(2, { x: mid.x + 30, y: mid.y });
  for (let i = 1; i <= 6; i++) {
    await f.move({
      1: { x: mid.x - 30 - i * 12 + i * 3, y: mid.y + i * 2 },
      2: { x: mid.x + 30 + i * 12 + i * 3, y: mid.y + i * 2 },
    });
  }
  await f.liftAll();

  await expect.poll(async () => (await viewOf(a))[2]).toBeLessThan(wBeforePinch - 20);
  await expect(a.getByTestId("track-chip")).toBeVisible();
  await expect.poll(() => offCentre(a, "Amber-0")).toBeLessThan(8);

  await a.getByTestId("match-play").click();
  await ctx.close();
});

test("5. strict Vision FOW anti-leak: holds at fade-out or ghost without leaking unseen position, glides on re-sighting", async ({ browser }) => {
  const url = await newBoardUrl(server, "track fow");
  const a = await joinNew(browser, url, "Coach");
  await openReplay(a);
  await a.emulateMedia({ reducedMotion: "reduce" });

  // Switch Vision to Hidden King (Amber) and ensure Last seen is OFF.
  await a.getByTestId("vision-select").selectOption("amber");
  const lastSeenBtn = a.getByTestId("last-seen-toggle");
  if ((await lastSeenBtn.getAttribute("aria-pressed")) === "true") await lastSeenBtn.click();
  await expect(lastSeenBtn).toHaveAttribute("aria-pressed", "false");

  // At t = 15 s, Sapphire-0 is in Amber's Vision (seen 10..20 s). Track Sapphire-0.
  await scrubTo(a, 15);
  await portrait(a, "Sapphire-0").dblclick();
  await expect(a.getByTestId("track-chip")).toHaveAttribute("data-slot", "sapphire-0");
  await expect.poll(() => offCentre(a, "Sapphire-0")).toBeLessThan(5);
  const viewAt15 = await viewOf(a);

  // Scrub to t = 25 s and t = 38 s (Sapphire-0 is hidden in FOW and moving east!).
  await scrubTo(a, 25);
  await expect(tok(a, "Sapphire-0")).toHaveCount(0);
  await a.waitForTimeout(250);
  // Camera MUST stay frozen at viewAt15 — zero FOW coordinate leak!
  expect(await viewOf(a)).toEqual(viewAt15);
  await expect(a.getByTestId("track-chip")).toBeVisible();

  await scrubTo(a, 38);
  await a.waitForTimeout(250);
  expect(await viewOf(a)).toEqual(viewAt15);

  // At t = 48 s, Sapphire-0 re-enters Amber's Vision (seen 45..55 s): camera glides to their new spot!
  await scrubTo(a, 48);
  await expect(tok(a, "Sapphire-0")).toHaveCount(1);
  await expect.poll(() => offCentre(a, "Sapphire-0")).toBeLessThan(5);
  const viewAt48 = await viewOf(a);
  expect(viewAt48[0]).toBeGreaterThan(viewAt15[0] + 100);

  // Now test Last seen ON: scrub back to t = 25 s and t = 35 s -> holds on the frozen t = 20 s ghost!
  await lastSeenBtn.click();
  await expect(lastSeenBtn).toHaveAttribute("aria-pressed", "true");
  await scrubTo(a, 25);
  await expect(tok(a, "Sapphire-0")).toHaveAttribute("data-seen", "false");
  await expect.poll(() => offCentre(a, "Sapphire-0")).toBeLessThan(5);
  const ghostViewAt25 = await viewOf(a);
  await scrubTo(a, 35);
  await a.waitForTimeout(250);
  expect(await viewOf(a)).toEqual(ghostViewAt25);
});

test("6. cancellation matrix: manual pan, Escape (respecting overlays), track-chip click, and flip keeps tracking", async ({ browser }) => {
  const url = await newBoardUrl(server, "track cancel");
  const a = await joinNew(browser, url, "Coach");
  await openReplay(a);
  await scrubTo(a, 15);

  // Start tracking Amber-0.
  await portrait(a, "Amber-0").dblclick();
  await expect(a.getByTestId("track-chip")).toBeVisible();
  await expect.poll(() => offCentre(a, "Amber-0")).toBeLessThan(5);

  // Flip map keeps tracking and re-centers in Sapphire viewpoint.
  await a.getByTestId("viewpoint-flip").click();
  await expect(a.getByTestId("track-chip")).toBeVisible();
  await expect.poll(() => offCentre(a, "Amber-0")).toBeLessThan(5);

  // Escape respects open HeroCard: 1st Escape closes HeroCard, tracking stays active; 2nd Escape cancels tracking!
  await tok(a, "Amber-0").click();
  await expect(a.getByTestId("hero-card")).toHaveCount(1);
  await a.keyboard.press("Escape");
  await expect(a.getByTestId("hero-card")).toHaveCount(0);
  await expect(a.getByTestId("track-chip")).toBeVisible();
  await a.keyboard.press("Escape");
  await expect(a.getByTestId("track-chip")).toHaveCount(0);

  // Re-start tracking, then cancel via manual right-drag map pan (far >= 4 px).
  await portrait(a, "Amber-0").dblclick();
  await expect(a.getByTestId("track-chip")).toBeVisible();
  await expect.poll(() => offCentre(a, "Amber-0")).toBeLessThan(5);
  const m = await centreOf(a, "[data-testid=map]");
  await a.mouse.move(m.x, m.y);
  await a.mouse.down({ button: "right" });
  await a.mouse.move(m.x + 80, m.y + 40, { steps: 6 });
  await a.mouse.up({ button: "right" });
  await expect(a.getByTestId("track-chip")).toHaveCount(0);

  // Re-start tracking, then cancel by clicking track-chip.
  await portrait(a, "Amber-0").dblclick();
  await expect(a.getByTestId("track-chip")).toBeVisible();
  await a.getByTestId("track-chip").click();
  await expect(a.getByTestId("track-chip")).toHaveCount(0);
});

test("7. follower detachment: tracking a hero stops following presenter, Follow again cancels hero tracking", async ({ browser }) => {
  const url = await newBoardUrl(server, "track follower");
  const a = await joinNew(browser, url, "Coach");
  await openReplay(a);
  await scrubTo(a, 15);
  const b = await joinNew(browser, url, "Marrow");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");

  // Marrow follows Coach.
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");

  // Marrow double-clicks Sapphire-3 portrait to track -> detaches from Coach cleanly.
  await portrait(b, "Sapphire-3").dblclick();
  await expect(b.getByTestId("track-chip")).toHaveAttribute("data-slot", "sapphire-3");
  await expect(b.getByTestId("stop-following")).toHaveCount(0);
  await expect(b.getByTestId("toast")).toContainText("Stopped following Coach");
  await expect.poll(() => offCentre(b, "Sapphire-3")).toBeLessThan(5);

  // Clicking "Follow again" in the toast cancels Marrow's hero tracking and resumes following Coach.
  await b.getByTestId("toast-action").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  await expect(b.getByTestId("track-chip")).toHaveCount(0);
});
