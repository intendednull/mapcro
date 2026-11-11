// Panels on the board pane (#35, #37; spec §6b "Panels"): the death recap and the hero panels
// move by a drag of their top, with a mouse or a finger; several hero panels open at once; a
// follower on another screen size gets the same set at the same places relative to its pane,
// each clamped into it and off its own controls. And the match source closes once a match is in
// (it covered the toolbar's left end).

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Locator, type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "129000201";
const N = 60;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-panels-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.describe.configure({ mode: "parallel" });
test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "200" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
/** follow-matrix's match: every hero alive at 0:15 in a row per team; Sapphire 2 dies at 40 with
 * a recap. */
function timeline(id: string) {
  return {
    match_id: Number(id), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const s2 = team === "sapphire" && slot === 2;
        const dead = (s: number) => s2 && s >= 40 && s < 50;
        const at = { x: slot * 1500 - 4000, y: team === "amber" ? -3000 : 3000 };
        return {
          team, slot, hero_id: 1 + slot, name: `${team === "amber" ? "A" : "S"}${slot}`,
          x: range((s) => (dead(s) ? null : at.x)), y: range((s) => (dead(s) ? null : at.y)), health: range((s) => (dead(s) ? 0 : 100)),
          deaths: s2 ? [40] : [], respawn: s2 ? [[40, 50]] : [], souls: [[0, 500]], ult: range(() => 0), seen: [],
          items: [[50, 715_762_406, 0]], abilities: [], casts: [], charges: [], effects: [], cc: [], height: [],
          recaps: s2 ? [{ t: 400, damage: [[1, 0, 900]], cc: [] }] : [],
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [],
    events: [{ t: 40, kind: "death", team: "sapphire", slot: 2, hero_id: 3, x: -1000, y: 3000 }],
    waves: [{ lane: "lane4", t: range(() => 500), stale: [] }],
    troopers: { every_s: 1, amber: range(() => ""), sapphire: range(() => "") },
  };
}

const answered = new Set<string>();
/** Load the match as an editor does, the worker's answer written by hand (as follow-matrix). */
async function load(p: Page) {
  const bar = p.getByTestId("player");
  if (!(await bar.count()) || (await bar.getAttribute("data-state")) !== "match") await p.getByTestId("mode-player").first().click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  const tier = p.getByTestId("match-tier");
  const straight = await expect.poll(async () => (await tier.textContent().catch(() => "")) === "Full replay", { timeout: 3000 }).toBe(true).then(() => true, () => false);
  if (!straight) {
    await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
    let job = "";
    await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem") && !answered.has(f)) ?? "")).not.toBe("");
    answered.add(job);
    writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline(ID)));
  }
  await expect(tier).toHaveText("Full replay");
}
async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await expect(p.getByTestId("match-clock")).toContainText(`0:${String(t).padStart(2, "0")} /`);
}

type Box = { x: number; y: number; width: number; height: number };
const box = async (l: Locator): Promise<Box> => (await l.boundingBox())!;
const pane = (p: Page) => box(p.getByTestId("map"));
const token = (p: Page, slot: string) => p.locator(`.mapbox .tok[data-slot="${slot}"]`);
const hero = (p: Page, slot: string) => p.locator(`[data-testid=hero-card][data-slot="${slot}"]`);
const recap = (p: Page) => p.getByTestId("skull-recap");
const slots = (p: Page) => p.getByTestId("hero-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-slot")).sort().join(" "));

/** Drag a panel by its top with the mouse, by (dx, dy). */
async function drag(p: Page, panel: Locator, dx: number, dy: number) {
  const h = await box(panel.locator(".hero-panel-head, .skull-recap-head").first());
  const x = h.x + 44;
  const y = h.y + h.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(x + dx, y + dy, { steps: 8 });
  await p.mouse.up();
}
/** Drag a panel by its top with the mouse until the pointer is at (x, y) on the page. */
async function dragTo(p: Page, panel: Locator, x: number, y: number) {
  const h = await box(panel.locator(".hero-panel-head, .skull-recap-head").first());
  await drag(p, panel, x - (h.x + 44), y - (h.y + h.height / 2));
}
/** The same with a finger: real touch input through the browser (Chromium's DevTools protocol). */
async function touchDrag(p: Page, panel: Locator, dx: number, dy: number) {
  const h = await box(panel.locator(".hero-panel-head, .skull-recap-head").first());
  const x = h.x + 44;
  const y = h.y + h.height / 2;
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / 8, y: y + (dy * i) / 8 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}
const moved = async (panel: Locator, from: Box, dx: number, dy: number) =>
  expect.poll(async () => {
    const b = await box(panel);
    return Math.abs(b.x - from.x - dx) <= 1 && Math.abs(b.y - from.y - dy) <= 1;
  }, { message: `moved by ${dx}, ${dy}` }).toBe(true);

/** A panel's place as a share of the pane: from its nearer edge on each axis (or `from`'s). */
const relative = (b: Box, p: Box, from?: { right: boolean; bottom: boolean }) => {
  const right = from?.right ?? b.x + b.width / 2 > p.x + p.width / 2;
  const bottom = from?.bottom ?? b.y + b.height / 2 > p.y + p.height / 2;
  return { right, bottom, x: (right ? p.x + p.width - b.x - b.width : b.x - p.x) / p.width, y: (bottom ? p.y + p.height - b.y - b.height : b.y - p.y) / p.height };
};
/** Every panel is inside the pane and clear of the pane's controls (Map layers, Vision…). */
async function clear(p: Page) {
  const out = await p.evaluate(() => {
    const paneEl = document.querySelector("[data-testid=map]")!.getBoundingClientRect();
    const controls = [...document.querySelectorAll(".map-controls > *")].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const bad: string[] = [];
    for (const el of document.querySelectorAll("[data-testid=hero-card], [data-testid=skull-recap]")) {
      const r = el.getBoundingClientRect();
      const name = el.getAttribute("data-slot") ?? el.className;
      if (r.left < paneEl.left - 0.5 || r.top < paneEl.top - 0.5 || r.right > paneEl.right + 0.5 || r.bottom > paneEl.bottom + 0.5) bad.push(`${name} outside the pane`);
      for (const c of controls) if (r.left < c.right && c.left < r.right && r.top < c.bottom && c.top < r.bottom) bad.push(`${name} over a control`);
    }
    return bad;
  });
  expect(out).toEqual([]);
}

test("#35 the death recap moves by a drag of its top, with a mouse or a finger, and the next opens where it was left", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Recap drag"), "Coach");
  await load(a);
  await scrubTo(a, 41);
  await a.locator('[data-testid=death-skull][data-slot="sapphire-2"]').click();
  const r = recap(a);
  await expect(r).toBeVisible();
  const home = await box(r);
  await drag(a, r, 160, 120);
  await moved(r, home, 160, 120);
  const after = await box(r);
  await touchDrag(a, r, -80, 60);
  await moved(r, after, -80, 60);
  // The × is a button, not a handle: a press there closes, it doesn't move.
  const there = await box(r);
  await r.getByTestId("skull-recap-close").click();
  await expect(r).toHaveCount(0);
  await a.locator('[data-testid=death-skull][data-slot="sapphire-2"]').click();
  await expect.poll(async () => JSON.stringify(await box(r))).toBe(JSON.stringify(there));
  await clear(a);
  // With a hero panel open too, Escape closes that first, then the recap.
  await token(a, "Amber-5").click();
  await expect(hero(a, "amber-5")).toBeVisible();
  await a.keyboard.press("Escape");
  await expect(hero(a, "amber-5")).toHaveCount(0);
  await expect(r).toBeVisible();
  await a.keyboard.press("Escape");
  await expect(r).toHaveCount(0);
});

test("#37 several hero panels open at once; each moves and closes by itself; a press brings one to the front; Escape closes the front one", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Hero panels"), "Coach");
  await load(a);
  await scrubTo(a, 15);
  for (const s of ["Amber-5", "Sapphire-4", "Amber-4"]) await token(a, s).click();
  await expect.poll(() => slots(a)).toBe("amber-4 amber-5 sapphire-4");
  // Each opens a step from the last, so none hides another.
  const [b5, s4, b4] = await Promise.all(["amber-5", "sapphire-4", "amber-4"].map((s) => box(hero(a, s))));
  expect(s4!.x - b5!.x).toBeCloseTo(24, 0);
  expect(b4!.y - s4!.y).toBeCloseTo(24, 0);
  await expect(hero(a, "amber-4")).toHaveAttribute("data-front", "true");
  // One moves; the others stay.
  await drag(a, hero(a, "amber-5"), 120, 0);
  await moved(hero(a, "amber-5"), b5!, 120, 0);
  expect(await box(hero(a, "sapphire-4"))).toEqual(s4);
  // The press brought it to the front: it draws over the others.
  await expect(hero(a, "amber-5")).toHaveAttribute("data-front", "true");
  const z = (s: string) => hero(a, s).evaluate((el) => Number(getComputedStyle(el).zIndex));
  expect(await z("amber-5")).toBeGreaterThan(Math.max(await z("amber-4"), await z("sapphire-4")));
  // A press on one behind brings it to the front, where its × is; × closes that one only.
  await hero(a, "sapphire-4").click({ position: { x: 16, y: 12 } });
  await expect(hero(a, "sapphire-4")).toHaveAttribute("data-front", "true");
  await hero(a, "sapphire-4").getByTestId("hero-card-close").click();
  await expect.poll(() => slots(a)).toBe("amber-4 amber-5");
  // Escape: the front one (the one opened last, brought to the front again), then the next.
  await hero(a, "amber-4").click({ position: { x: 16, y: 12 } });
  await expect(hero(a, "amber-4")).toHaveAttribute("data-front", "true");
  await a.keyboard.press("Escape");
  await expect(hero(a, "amber-4")).toHaveCount(0);
  await expect(a.getByTestId("hero-card")).toHaveCount(1);
  await a.keyboard.press("Escape");
  await expect(a.getByTestId("hero-card")).toHaveCount(0);
});

test("a follower on another screen size sees the same panels at the same places in its pane, each clamped clear of its controls", async ({ browser }) => {
  const url = await newBoardUrl(server, "Panels follow");
  const a = await joinNew(browser, url, "Coach");
  await load(a);
  await scrubTo(a, 41);
  await a.locator('[data-testid=death-skull][data-slot="sapphire-2"]').click();
  // The recap to the bottom right, one hero panel to the right edge, the other left as it opened.
  const ap = await pane(a);
  await dragTo(a, recap(a), ap.x + ap.width + 100, ap.y + ap.height + 100);
  for (const s of ["Amber-5", "Sapphire-4"]) await token(a, s).click();
  await dragTo(a, hero(a, "amber-5"), ap.x + ap.width + 100, ap.y + 60);
  await clear(a);
  // Off the pane is clamped into it: dragged far past the bottom right, it sits in the corner.
  const r = await box(recap(a));
  expect(Math.round(r.x + r.width)).toBe(Math.round(ap.x + ap.width));
  expect(r.y + r.height).toBeLessThanOrEqual(ap.y + ap.height + 0.5);

  const b = await joinNew(browser, url, "Second");
  await b.setViewportSize({ width: 1180, height: 760 });
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("stop-following")).toHaveCount(1);
  await expect.poll(() => slots(b)).toBe("amber-5 sapphire-4");
  await expect(recap(b)).toBeVisible();
  const bp = await pane(b);
  expect(bp.width).toBeLessThan(ap.width - 50);
  // Each panel is the same share of the pane from the same edges (within a pixel's worth or two;
  // a panel too big for its place on the smaller pane is clamped, so only those that fit compare).
  const near = (x: number, y: number) => Math.abs(x - y) < 0.01;
  for (const l of [(p: Page) => hero(p, "amber-5"), (p: Page) => hero(p, "sapphire-4"), recap]) {
    const want = relative(await box(l(a)), ap);
    await expect.poll(async () => {
      const got = relative(await box(l(b)), bp, want);
      return near(got.x, want.x) && (near(got.y, want.y) || got.y < want.y);
    }).toBe(true);
  }
  await clear(b);

  // Live: the presenter moves one, the follower's follows; still following.
  const before = relative(await box(hero(b, "sapphire-4")), bp);
  expect(before.right).toBe(false);
  await dragTo(a, hero(a, "sapphire-4"), ap.x + ap.width + 100, ap.y + ap.height + 100);
  await expect.poll(async () => relative(await box(hero(b, "sapphire-4")), bp).right).toBe(true);
  await clear(b);
  // The follower's own move is its own (following goes on) until the presenter's next change.
  const mine = await box(hero(b, "amber-5"));
  await drag(b, hero(b, "amber-5"), -30, 0);
  await moved(hero(b, "amber-5"), mine, -30, 0);
  await expect(b.getByTestId("stop-following")).toHaveCount(1);
  await drag(a, hero(a, "amber-5"), -40, 0);
  const theirs = relative(await box(hero(a, "amber-5")), ap);
  expect(theirs.right).toBe(true);
  await expect.poll(async () => Math.abs(relative(await box(hero(b, "amber-5")), bp, theirs).x - theirs.x)).toBeLessThan(0.01);
  await clear(b);
  // A smaller screen still: everything stays in the pane, off the controls.
  await b.setViewportSize({ width: 1000, height: 640 });
  await expect.poll(async () => (await pane(b)).width).toBeLessThan(bp.width - 20);
  await clear(b);
});

test("the match source closes once the match is in, clear of the toolbar's left end; a refused id keeps it open", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Source closes"), "Coach");
  await load(a);
  const source = a.locator(".pl-source");
  await expect.poll(() => source.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
  // Select and Laser take a press at their centres: nothing covers them.
  for (const t of ["tool-move", "tool-laser"]) {
    const hit = await a.getByTestId(t).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    expect(hit, t).toBe(true);
  }
  await a.getByTestId("tool-laser").click();
  await expect(a.getByTestId("tool-laser")).toHaveAttribute("aria-pressed", "true");
  // An id that isn't one: the panel stays, saying why.
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill("abc");
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-status")).toHaveText("Invalid id");
  await expect(a.getByTestId("match-status")).toBeVisible();
  expect(await source.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
});
