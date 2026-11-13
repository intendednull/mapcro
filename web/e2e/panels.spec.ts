// Panels on the board pane (#35, #37; spec §6b "Panels"): the death recap and the hero panels
// move by a drag of their top, with a mouse or a finger, anywhere in the board area round the
// map (#40); several hero panels open at once; a
// follower on another screen size gets the same set at the same places relative to its pane,
// each clamped into it and off its own controls. And the match source closes once a match is in
// (it covered the toolbar's left end).

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { type Locator, type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { ROOT, Server, TIMELINE_FORMAT, newBoardUrl } from "./server";
import { initSync } from "../src/wasm/mapcro_wasm.js";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import type { Playback } from "../src/gen/Playback";

initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

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
async function load(p: Page, id = ID, o: { beforeAnswer?: () => Promise<void> } = {}) {
  const bar = p.getByTestId("player");
  if (!(await bar.count()) || (await bar.getAttribute("data-state")) !== "match") await p.getByTestId("mode-player").first().click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(id);
  await p.getByTestId("match-load").click();
  const tier = p.getByTestId("match-tier");
  const straight = await expect.poll(async () => (await tier.textContent().catch(() => "")) === "Full replay", { timeout: 3000 }).toBe(true).then(() => true, () => false);
  if (!straight) {
    await p.getByTestId("match-file").setInputFiles({ name: `${id}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
    let job = "";
    await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".dem") && !answered.has(f)) ?? "")).not.toBe("");
    answered.add(job);
    await o.beforeAnswer?.();
    writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline(id)));
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
/** The pane the panels are placed in: the board area round the map (#40). */
const pane = (p: Page) => box(p.getByTestId("board-area"));
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
/** Bring a panel to the front with a press on it, wherever another covers it. */
async function raise(panel: Locator) {
  await panel.dispatchEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" });
  await expect(panel).toHaveAttribute("data-front", "true");
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
  expect(await faults(p)).toEqual([]);
}
/** The panel sits against the pane's controls, or its edge, at its top or bottom (clamped there). */
const clamped = (p: Page, panel: Locator) =>
  panel.evaluate((el) => {
    const pane = document.querySelector("[data-testid=board-area]")!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const mid = pane.top + pane.height / 2;
    const controls = [...document.querySelectorAll(".map-controls > *")].map((c) => c.getBoundingClientRect()).filter((c) => c.width > 0 && c.height > 0);
    const low = Math.min(pane.bottom, ...controls.filter((c) => c.top + c.height / 2 > mid).map((c) => c.top - 4));
    const high = Math.max(pane.top, ...controls.filter((c) => c.top + c.height / 2 <= mid).map((c) => c.bottom + 4));
    return Math.abs(r.bottom - low) < 1 || Math.abs(r.top - high) < 1;
  });
/** The panels outside the pane or over one of its controls. */
async function faults(p: Page) {
  return p.evaluate(() => {
    const paneEl = document.querySelector("[data-testid=board-area]")!.getBoundingClientRect();
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
  // The × is a button, not a handle: a press there that moves doesn't move the panel; a click closes.
  const there = await box(r);
  const x = await box(r.getByTestId("skull-recap-close"));
  await a.mouse.move(x.x + x.width / 2, x.y + x.height / 2);
  await a.mouse.down();
  await a.mouse.move(x.x - 120, x.y + 90, { steps: 8 });
  await a.mouse.up();
  expect(await box(r)).toEqual(there);
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
  // Each opens beside its own token (#48), so neighbours' panels overlap: set them apart in a
  // row, each brought to the front first so its top is free.
  const ap = await pane(a);
  for (const [s, x] of [["amber-5", 0], ["sapphire-4", 400], ["amber-4", 598]] as const) {
    await raise(hero(a, s));
    await dragTo(a, hero(a, s), ap.x + x + 44, ap.y + 100);
  }
  const [b5, s4] = await Promise.all(["amber-5", "sapphire-4"].map((s) => box(hero(a, s))));
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
  // The front one opened first: Escape closes it alone, not the one that comes to the front.
  for (const s of ["Amber-5", "Amber-4"]) await token(a, s).click();
  // (Amber-4's, beside the next token, over part of Amber-5's: moved off it, to the front again.)
  await dragTo(a, hero(a, "amber-4"), ap.x + 44, ap.y + 100);
  await hero(a, "amber-4").click({ position: { x: 16, y: 12 } });
  await expect(hero(a, "amber-4")).toHaveAttribute("data-front", "true");
  await hero(a, "amber-5").click({ position: { x: 8, y: 120 } });
  await expect(hero(a, "amber-5")).toHaveAttribute("data-front", "true");
  await a.keyboard.press("Escape");
  await expect(hero(a, "amber-5")).toHaveCount(0);
  await expect(hero(a, "amber-4")).toHaveCount(1);
  // Open A, open B, close A, open C: C opens beside its own token, and B stays where it was.
  await a.keyboard.press("Escape");
  await expect(a.getByTestId("hero-card")).toHaveCount(0);
  for (const s of ["Amber-5", "Sapphire-4"]) await token(a, s).click();
  await expect(hero(a, "sapphire-4")).toHaveCount(1);
  const second = await box(hero(a, "sapphire-4"));
  await hero(a, "amber-5").getByTestId("hero-card-close").click();
  await token(a, "Amber-4").click();
  const t4 = await box(token(a, "Amber-4"));
  await expect.poll(async () => { const c = await box(hero(a, "amber-4")); return Math.abs(c.x - (t4.x + t4.width)) < 24 || Math.abs(c.x + c.width - t4.x) < 24; }).toBe(true);
  expect(await box(hero(a, "sapphire-4"))).toEqual(second);
});

test("#48 a hero panel opens beside its token, to its right (its left at the area's right edge), level with it and off it", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Panels beside"), "Coach");
  await load(a);
  await scrubTo(a, 15);
  const area = await pane(a);
  for (const s of ["Amber-0", "Sapphire-5", "Amber-5"]) {
    await token(a, s).click();
    const card = hero(a, s.toLowerCase());
    await expect(card).toHaveCount(1);
    // Placed again at its own size on the next frame: wait for it to settle.
    let c = await box(card);
    await expect.poll(async () => { const was = c; c = await box(card); return JSON.stringify(was) === JSON.stringify(c); }).toBe(true);
    const t = await box(token(a, s));
    const right = c.x >= t.x + t.width;
    const gap = right ? c.x - (t.x + t.width) : t.x - (c.x + c.width);
    // Within 24 px of the token, on one side, never over it.
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(24);
    // To its right where it fits in the area.
    expect(right).toBe(t.x + t.width + 10 + c.width <= area.x + area.width);
    // Level with it, unless clamped into the area (it stays inside it).
    expect(c.y).toBeGreaterThanOrEqual(area.y);
    expect(c.y + c.height).toBeLessThanOrEqual(area.y + area.height + 0.5);
    const off = Math.abs(c.y + c.height / 2 - (t.y + t.height / 2));
    expect(off < 30 || c.y <= area.y + 60 || c.y + c.height >= area.y + area.height - 60).toBe(true);
    await card.getByTestId("hero-card-close").click();
  }
});

test("a drag ends when the browser cancels the pointer or takes its capture away", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Drag ends"), "Coach");
  await load(a);
  await scrubTo(a, 15);
  await token(a, "Amber-5").click();
  const panel = hero(a, "amber-5");
  const head = panel.locator(".hero-panel-head");
  await a.evaluate(() => document.addEventListener("pointerdown", (e) => ((window as unknown as { pid: number }).pid = e.pointerId), true));
  for (const end of ["pointercancel", "lostpointercapture"] as const) {
    const h = await box(head);
    const [x, y] = [h.x + 60, h.y + h.height / 2];
    await a.mouse.move(x, y);
    await a.mouse.down();
    await a.mouse.move(x + 30, y + 20, { steps: 4 });
    await expect(panel).toHaveAttribute("data-moving", "true");
    // The browser ends it (a touch turned into a scroll, a window switch): a real end, then
    // the pointer still moving over the panel's top moves nothing.
    // (A capture released is lost at the next pointer event, before it is dispatched.)
    const stopped = await box(panel);
    await head.evaluate((el, end) => {
      const id = (window as unknown as { pid: number }).pid;
      if (end === "lostpointercapture") el.releasePointerCapture(id);
      else el.dispatchEvent(new PointerEvent("pointercancel", { pointerId: id, bubbles: true }));
    }, end);
    await a.mouse.move(x + 50, y + 30, { steps: 4 });
    await expect(panel, end).not.toHaveAttribute("data-moving");
    expect(await box(panel), end).toEqual(stopped);
    await a.mouse.up();
  }
});

test("one Escape with a build inspected and a death recap open closes the build only", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Escape build"), "Coach");
  await load(a);
  await scrubTo(a, 41);
  await a.locator('[data-testid=death-skull][data-slot="sapphire-2"]').click();
  await expect(recap(a)).toBeVisible();
  await a.locator('.tb-player[data-slot="Amber-0"] [data-testid=focus-hero]').click();
  const build = a.locator('.tb-player[data-slot="Amber-0"] [data-testid=hero-build]');
  await expect(build).toHaveCount(1);
  await a.keyboard.press("Escape");
  await expect(build).toHaveCount(0);
  await expect(recap(a)).toBeVisible();
  await a.keyboard.press("Escape");
  await expect(recap(a)).toHaveCount(0);
});

test("a panel moves off the map controls when their row changes size, the pane unchanged", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Controls grow"), "Coach");
  await load(a);
  await scrubTo(a, 15);
  await token(a, "Amber-5").click();
  const ap = await pane(a);
  await dragTo(a, hero(a, "amber-5"), ap.x + 60, ap.y + ap.height + 100);
  await clear(a);
  const was = await box(hero(a, "amber-5"));
  // The row grows upward (as when it wraps onto a second line), its controls with it.
  await a.locator(".map-controls").evaluate((el) => ((el as HTMLElement).style.paddingBottom = "90px"));
  expect(await pane(a)).toEqual(ap);
  await expect.poll(() => faults(a)).toEqual([]);
  expect((await box(hero(a, "amber-5"))).y).toBeLessThan(was.y - 60);
});

test("#40 a panel moves anywhere in the board area, off the map too, clamped to the area's edges and clear of its controls; a follower on another screen gets the same place in its area", async ({ browser }) => {
  const url = await newBoardUrl(server, "Panels anywhere");
  const a = await joinNew(browser, url, "Coach");
  await load(a);
  await scrubTo(a, 15);
  await token(a, "Amber-5").click();
  const panel = hero(a, "amber-5");
  const ap = await pane(a);
  const map = await box(a.getByTestId("map"));
  // The area is wider than the map (the map is the largest square that fits it): room beside it.
  expect(ap.width).toBeGreaterThan(map.width + 200);
  // Past the map's left edge: it goes there, into the room left of the map.
  const p0 = await box(panel);
  await drag(a, panel, ap.x - p0.x, 0);
  await expect.poll(async () => Math.round((await box(panel)).x)).toBe(Math.round(ap.x));
  expect((await box(panel)).x).toBeLessThan(map.x - 100);
  await clear(a);
  // Far past the top left, then the right: it stops at the area's edges, not the map's.
  await dragTo(a, panel, ap.x - 300, ap.y - 300);
  await expect.poll(async () => { const b = await box(panel); return [Math.round(b.x), Math.round(b.y)]; }).toEqual([Math.round(ap.x), Math.round(ap.y)]);
  await dragTo(a, panel, ap.x + ap.width + 300, ap.y + 100);
  await expect.poll(async () => { const b = await box(panel); return Math.round(b.x + b.width); }).toBe(Math.round(ap.x + ap.width));
  const r = await box(panel);
  expect(r.x + r.width).toBeGreaterThan(map.x + map.width + 100);
  // Far past the bottom: it stops clear of the map's controls (they are in the area too).
  await dragTo(a, panel, ap.x + 40, ap.y + ap.height + 300);
  await expect.poll(() => clamped(a, panel)).toBe(true);
  await clear(a);
  // A drag of its top leaves the focused control, as a press on the map does.
  await a.getByTestId("match-time").focus();
  await drag(a, panel, 0, 20);
  expect(await a.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "")).not.toBe("match-time");
  // Left of the map, a little down: a follower with a smaller screen has it the same share of
  // its area from the same edges (on y, unless that would put it past its controls: clamped).
  await dragTo(a, panel, ap.x + 60, ap.y + 40);
  await expect.poll(async () => (await box(panel)).x < map.x - 50).toBe(true);
  const want = relative(await box(panel), ap);
  expect(want.right).toBe(false);
  const b = await joinNew(browser, url, "Second");
  await b.setViewportSize({ width: 1180, height: 760 });
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("stop-following")).toHaveCount(1);
  await expect(hero(b, "amber-5")).toBeVisible();
  const bp = await pane(b);
  expect(bp.width).toBeLessThan(ap.width - 50);
  await expect.poll(async () => {
    const got = relative(await box(hero(b, "amber-5")), bp, want);
    return Math.abs(got.x - want.x) < 0.01 && (Math.abs(got.y - want.y) < 0.01 || (await clamped(b, hero(b, "amber-5"))));
  }).toBe(true);
  await clear(b);
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
  // (Sapphire-4's first, moved to the left: Amber-5's, beside a token near it (#48), is then on
  // top, its top free, and off it once moved.)
  await token(a, "Sapphire-4").click();
  await dragTo(a, hero(a, "sapphire-4"), ap.x - 100, ap.y + ap.height / 2);
  await token(a, "Amber-5").click();
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
  // Each panel is the same share of the pane from the same edges (within a pixel's worth or two),
  // unless that would put it over the pane's controls or past its edge: then it is clamped to
  // them, which is nearer the pane's centre (the controls are the same px on a smaller pane, so a
  // bigger share of it; a panel too big for its place is also pushed in).
  const near = (x: number, y: number) => Math.abs(x - y) < 0.01;
  for (const l of [(p: Page) => hero(p, "amber-5"), (p: Page) => hero(p, "sapphire-4"), recap]) {
    const want = relative(await box(l(a)), ap);
    await expect.poll(async () => {
      const got = relative(await box(l(b)), bp, want);
      return near(got.x, want.x) && (near(got.y, want.y) || (got.y > want.y && (await clamped(b, l(b)))) || got.y < want.y);
    }).toBe(true);
  }
  await clear(b);

  // The presenter brings the one behind to the front: so does the follower's.
  await expect(hero(b, "amber-5")).toHaveAttribute("data-front", "true");
  await hero(a, "sapphire-4").click({ position: { x: 16, y: 12 } });
  await expect(hero(a, "sapphire-4")).toHaveAttribute("data-front", "true");
  await expect(hero(b, "sapphire-4")).toHaveAttribute("data-front", "true");
  await expect(hero(b, "amber-5")).toHaveAttribute("data-front", "false");
  const zb = (s: string) => hero(b, s).evaluate((el) => Number(getComputedStyle(el).zIndex));
  expect(await zb("sapphire-4")).toBeGreaterThan(await zb("amber-5"));
  await hero(a, "amber-5").click({ position: { x: 16, y: 12 } });
  await expect(hero(b, "amber-5")).toHaveAttribute("data-front", "true");

  // Live: the presenter moves one, the follower's follows; still following.
  const before = relative(await box(hero(b, "sapphire-4")), bp);
  expect(before.right).toBe(false);
  await dragTo(a, hero(a, "sapphire-4"), ap.x + ap.width + 100, ap.y + ap.height + 100);
  await expect.poll(async () => relative(await box(hero(b, "sapphire-4")), bp).right).toBe(true);
  await clear(b);
  // The follower's own move is its own (following goes on) until the presenter's next change.
  // (amber-5 to the front first: the presenter's drag brought sapphire-4 there, over its top.)
  await hero(a, "amber-5").click({ position: { x: 16, y: 12 } });
  await expect(hero(b, "amber-5")).toHaveAttribute("data-front", "true");
  const mine = await box(hero(b, "amber-5"));
  await drag(b, hero(b, "amber-5"), -30, 0);
  await moved(hero(b, "amber-5"), mine, -30, 0);
  await expect(b.getByTestId("stop-following")).toHaveCount(1);
  await drag(a, hero(a, "amber-5"), -40, 0);
  const theirs = relative(await box(hero(a, "amber-5")), ap);
  expect(theirs.right).toBe(true);
  await expect.poll(async () => Math.abs(relative(await box(hero(b, "amber-5")), bp, theirs).x - theirs.x)).toBeLessThan(0.01);
  await clear(b);
  // A presenter's drag moves that panel only (lead 2026-11-11): the follower's own panels,
  // build and recap stay as it left them, through every move of the drag.
  await hero(b, "sapphire-4").getByTestId("hero-card-close").click();
  await token(b, "Amber-0").click();
  await recap(b).getByTestId("skull-recap-close").click();
  await b.locator('.tb-player[data-slot="Amber-1"] [data-testid=focus-hero]').click();
  const bBuild = b.locator('.tb-player[data-slot="Amber-1"] [data-testid=hero-build]');
  await expect(bBuild).toHaveCount(1);
  await expect.poll(() => slots(b)).toBe("amber-0 amber-5");
  const was5 = await box(hero(b, "amber-5"));
  await drag(a, hero(a, "amber-5"), -150, 0);
  await expect.poll(async () => (await box(hero(b, "amber-5"))).x).toBeLessThan(was5.x - 20);
  expect(await slots(b)).toBe("amber-0 amber-5");
  await expect(recap(b)).toHaveCount(0);
  await expect(bBuild).toHaveCount(1);
  await expect(b.getByTestId("stop-following")).toHaveCount(1);
  // The presenter closing one is a panel change: its panels apply whole.
  await hero(a, "sapphire-4").getByTestId("hero-card-close").click();
  await expect.poll(() => slots(b)).toBe("amber-5");
  await expect(recap(b)).toBeVisible();
  // A smaller screen still: everything stays in the pane, off the controls.
  await b.setViewportSize({ width: 1000, height: 640 });
  await expect.poll(async () => { const q = await pane(b); return q.width * q.height; }).toBeLessThan(bp.width * bp.height - 20 * bp.height);
  // The panels are laid out again on the next frame after the pane's resize: wait for it.
  await expect.poll(() => faults(b)).toEqual([]);
});

test("the match source closes once the match is in, clear of the toolbar's left end; a refused id keeps it open", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Source closes"), "Coach");
  await load(a);
  const source = a.locator(".pl-source");
  await expect.poll(() => source.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
  // Select and Laser take a press at their centres: nothing covers them.
  for (const t of ["tool-select", "tool-laser"]) {
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

test("the match source closes for this user's own Load only: not for a presenter's match, nor once another id is typed", async ({ browser }) => {
  const url = await newBoardUrl(server, "Source own load");
  const a = await joinNew(browser, url, "Coach");
  await load(a);
  const source = (p: Page) => p.locator(".pl-source");
  const open = (p: Page) => source(p).evaluate((el) => (el as HTMLDetailsElement).open);
  await expect.poll(() => open(a)).toBe(false);
  // A slow Load of one match while another id is being typed: its answer leaves the panel open.
  await load(a, "129000202", {
    beforeAnswer: async () => {
      await a.getByTestId("match-id").fill("129000203");
      expect(await open(a)).toBe(true);
    },
  });
  await expect(a.getByTestId("match-id")).toHaveValue("129000203");
  expect(await open(a)).toBe(true);
  // A follower with its source open: the presenter's next match doesn't close it.
  const b = await joinNew(browser, url, "Second");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("stop-following")).toHaveCount(1);
  await revealControls(b, "match-id");
  await load(a, ID);
  await expect(b.getByTestId("match-id")).toHaveValue(ID);
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  expect(await open(b)).toBe(true);
});

test("a presenter from an older build leaves the follower's hero panels; a slot the match hasn't takes no Escape", async ({ browser }) => {
  const url = await newBoardUrl(server, "Panels older presenter");
  const b = await joinNew(browser, url, "Second");
  await load(b);
  await scrubTo(b, 41);
  await token(b, "Amber-5").click();
  await expect(hero(b, "amber-5")).toBeVisible();
  // A presenter that is a session of its own, sending exactly the presence it is given.
  const [, board, key] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  const bot = new BoardSession({
    wsUrl: `ws://127.0.0.1:${new URL(server.url).port}/ws`,
    board: board!,
    token: key!,
    persist: new MemoryPersist(),
    openSocket: (u) => new WebSocket(u, { origin: server.url }) as unknown as SocketLike,
  });
  await bot.start();
  try {
    await expect.poll(() => bot.connection.kind).toBe("live");
    const playback = (more: Partial<Playback> = {}): Playback => ({ player: true, match_id: Number(ID), t: 41, playing: false, speed: 1, ...more });
    // An older build: no hero_panels at all.
    bot.setPresence({ name: "Older", playback: playback({ inspect: { team: "Amber", slot: 1 } }) });
    await b.getByTestId("follow-Older").click();
    await expect(b.getByTestId("stop-following")).toHaveCount(1);
    await expect(b.locator('.tb-player[data-slot="Amber-1"] [data-testid=hero-build]')).toHaveCount(1);
    expect(await slots(b)).toBe("amber-5");
    // A newer one with a panel for a slot this match hasn't: no panel, and it takes no Escape.
    bot.setPresence({ playback: playback({ hero_panels: [{ team: "Amber", slot: 9 }] }) });
    await expect(b.getByTestId("hero-card")).toHaveCount(0);
    await b.locator('[data-testid=death-skull][data-slot="sapphire-2"]').click();
    await expect(recap(b)).toBeVisible();
    await b.keyboard.press("Escape");
    await expect(recap(b)).toHaveCount(0);
  } finally {
    bot.stop();
  }
});
