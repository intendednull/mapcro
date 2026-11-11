// Feedback #22: "All builds / Hold Tab" sat over the Rejuvenator's timer in Player's top bar.
// Neither covers the other at any width the bar is drawn at, desktop or phone, with one team's
// timer showing or both. A synthetic replay timeline handed to the server as the worker would
// (as player-rejuv-rift.spec.ts does).

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "129738985";
const N = 300;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-rejuv-builds-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/** Sapphire holds a Rejuvenator from 30 to 210, Amber from 180 to 290: both between 180 and 210. */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => -6000 + slot * 2400), y: range(() => (team === "amber" ? -6000 : 6000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    mid_boss: [], rifts: [], powerups: [], zips: [], camps: [], objectives: [], objective_health: [],
    rejuv: [
      { team: "sapphire", taken_s: 30, ends_s: 210, left: [[30, 3]] },
      { team: "amber", taken_s: 180, ends_s: 290, left: [[180, 2]] },
    ],
    events: [],
  };
}

async function open(p: Page) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}

/** The button's box and each shown timer's, in page pixels. */
const boxes = (p: Page) =>
  p.evaluate(() => {
    const r = (e: Element) => {
      const b = e.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    };
    const bar = document.querySelector("[data-testid=topbar]")!;
    const btn = bar.querySelector(".tb-all-builds")!;
    const timers = [...bar.querySelectorAll("[data-testid=tb-rejuv-timer].on")].filter((e) => getComputedStyle(e).visibility === "visible");
    const badges = [...bar.querySelectorAll("[data-testid=tb-rejuv][role]")].map((e) => [...e.querySelectorAll("img.on")]).flat();
    return { bar: r(bar), button: r(btn), timers: timers.map(r), badges: badges.map(r), phone: !!document.querySelector("[data-layout=phone]") };
  });
type Box = { x: number; y: number; w: number; h: number };
const meets = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("All builds clears the Rejuvenator's timer and marks at every width", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Rejuvenator and All builds"), "Coach");
  await open(a);
  // The widths the bar is drawn at: phone (≤ 700 px, the compact bar) to a wide desktop.
  for (const width of [320, 390, 700, 701, 960, 1280, 1440, 1920, 2560]) {
    await a.setViewportSize({ width, height: width <= 700 ? 820 : 900 });
    for (const [t, n] of [[40, 1], [200, 2]] as const) {
      await scrubTo(a, t);
      await expect.poll(async () => (await boxes(a)).timers.length, `${width} px at ${t}`).toBe(n);
      // After the bar's unit settles (a ResizeObserver) and the timers fade in.
      await a.waitForTimeout(400);
      const b = await boxes(a);
      expect(b.phone, `${width} px`).toBe(width <= 700);
      expect(b.button.w, `${width} px`).toBeGreaterThan(0);
      for (const tm of [...b.timers, ...b.badges]) expect(meets(b.button, tm), `${width} px at ${t}: ${JSON.stringify({ button: b.button, other: tm })}`).toBe(false);
      // Still in the bar's column, not off its sides.
      expect(b.button.x, `${width} px`).toBeGreaterThanOrEqual(b.bar.x);
      expect(b.button.x + b.button.w, `${width} px`).toBeLessThanOrEqual(b.bar.x + b.bar.w);
      if (t === 200 && [390, 1440].includes(width)) await a.getByTestId("topbar").screenshot({ path: `shots/rejuv-builds-${width}.png` });
    }
  }
  // Open, the kill counts come under it and clear it too.
  await a.setViewportSize({ width: 1440, height: 900 });
  await a.locator(".tb-all-builds").click();
  const kills = (await a.locator(".tb-build-team-kills").boundingBox())!;
  const btn = (await a.locator(".tb-all-builds").boundingBox())!;
  expect(meets({ x: kills.x, y: kills.y, w: kills.width, h: kills.height }, { x: btn.x, y: btn.y, w: btn.width, h: btn.height })).toBe(false);
});
