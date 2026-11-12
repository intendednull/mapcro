// The marker space above the scrubber scrubs too (#45): a press and drag along the event ticks
// moves match time with the pointer, on and off the row, as the bar does; a press on the space
// between ticks seeks there; a plain click on a tick, even with a hand's jitter, still jumps to
// that tick's event. With a mouse and with a finger. A synthetic replay timeline the test hands
// the server as the worker would.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, expect, test } from "./fixtures";
import { revealControls } from "./helpers";
import { Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

const ID = "129000045";
const N = 240;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-scrubdrag-"));
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
const spot = (slot: number) => ({ x: slot * 1500 - 3500, y: 2500 });
const ev = (t: number, kind: string, extra: Record<string, unknown>) => ({ t, kind, team: null, slot: null, hero_id: null, by: null, key: null, x: null, y: null, amount: null, ability: null, ...extra });
/** Ten deaths, 10 s apart from 20 s: ticks with room between them. */
const EVENTS = Array.from({ length: 10 }, (_, i) => ev(20 + 10 * i, "death", { team: "amber", slot: i % 6, hero_id: 1 + (i % 6), ...spot(i % 6) }));

function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: null,
        x: range(() => spot(slot).x), y: range(() => spot(slot).y),
        health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0),
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: EVENTS,
  };
}

const clock = async (p: Page) => {
  const [m, s] = ((await p.getByTestId("match-clock").textContent()) ?? "").split(" / ")[0]!.split(":").map(Number);
  return m! * 60 + s!;
};

async function open(browser: Browser, touch: boolean): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: touch });
  const a = await ctx.newPage();
  await a.goto(await newBoardUrl(server, touch ? "Scrub drag touch" : "Scrub drag"));
  await a.locator("#join-name").fill("Coach");
  await a.keyboard.press("Enter");
  await expect(a.getByTestId("join-card")).toBeHidden();
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  const had = new Set(readdirSync(join(queue, "inbox")));
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem") && !had.has(f)) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(a.getByTestId("scrub-tick")).toHaveCount(EVENTS.length);
  return a;
}

/** The ticks' row: its box is the time axis (it lines up with the bar's thumb travel). */
async function axis(a: Page) {
  const r = (await a.locator(".pl-ticks").boundingBox())!;
  return { y: r.y + r.height / 2, x: (t: number) => r.x + (t / N) * r.width, t: (x: number) => Math.round(((x - r.x) / r.width) * N) };
}

/** Match time within a second of t (the pointer lands between whole seconds). */
const near = (a: Page, t: number) => expect.poll(async () => Math.abs((await clock(a)) - t)).toBeLessThanOrEqual(1);

test("a drag along the marker row scrubs; a click on a tick still jumps to it (#45)", async ({ browser }) => {
  const a = await open(browser, false);
  const ax = await axis(a);
  const lead = Number(await a.getByTestId("events-lead").inputValue());

  // A plain click on the 50 s tick, with a 2 px jitter between press and release: a jump.
  const tick = a.locator('[data-testid=scrub-tick][data-t="50"]');
  const tb = (await tick.boundingBox())!;
  const tx = tb.x + tb.width / 2;
  await a.mouse.move(tx, tb.y + tb.height / 2);
  await a.mouse.down();
  await a.mouse.move(tx + 2, tb.y + tb.height / 2);
  await a.mouse.up();
  await expect.poll(() => clock(a)).toBe(Math.max(0, 50 - lead));
  await expect(a.getByTestId("event-highlight")).toBeVisible();

  // Pressed on the 30 s tick and dragged right: match time follows the pointer.
  const from = a.locator('[data-testid=scrub-tick][data-t="30"]');
  const fb = (await from.boundingBox())!;
  await a.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await a.mouse.down();
  for (const t of [70, 135]) {
    await a.mouse.move(ax.x(t), ax.y, { steps: 8 });
    await near(a, t);
  }
  // Off the row (well above the bar) it carries on: the drag holds the pointer.
  await a.mouse.move(ax.x(180), ax.y - 120, { steps: 8 });
  await near(a, 180);
  // And it ends over a tick without that tick's jump taking over.
  const over = a.locator('[data-testid=scrub-tick][data-t="110"]');
  const ob = (await over.boundingBox())!;
  await a.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2, { steps: 8 });
  const end = ax.t(ob.x + ob.width / 2);
  await near(a, end);
  await a.mouse.up();
  await a.waitForTimeout(150);
  expect(Math.abs((await clock(a)) - end)).toBeLessThanOrEqual(1);
  expect(await clock(a)).not.toBe(Math.max(0, 110 - lead));

  // A press on the space between ticks seeks there, as the bar does.
  await a.mouse.click(ax.x(205), ax.y);
  await near(a, 205);
});

test("a finger's drag along the marker row scrubs; a tap on a tick still jumps (#45)", async ({ browser }) => {
  const a = await open(browser, true);
  const ax = await axis(a);
  const lead = Number(await a.getByTestId("events-lead").inputValue());
  const cdp = await a.context().newCDPSession(a);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x?: number, y?: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: x === undefined ? [] : [{ x, y: y!, id: 1 }] });

  // A tap with a finger's wobble (5 px) on the 60 s tick: a jump.
  const tick = a.locator('[data-testid=scrub-tick][data-t="60"]');
  const tb = (await tick.boundingBox())!;
  const tx = tb.x + tb.width / 2;
  const ty = tb.y + tb.height / 2;
  await touch("touchStart", tx, ty);
  await touch("touchMove", tx + 5, ty);
  await touch("touchEnd");
  await expect.poll(() => clock(a)).toBe(Math.max(0, 60 - lead));

  // A drag from the 40 s tick: time follows the finger, off the row too.
  const fb = (await a.locator('[data-testid=scrub-tick][data-t="40"]').boundingBox())!;
  let x = fb.x + fb.width / 2;
  await touch("touchStart", x, ax.y);
  for (const [t, dy] of [[95, 0], [150, -80]] as const) {
    const to = ax.x(t);
    for (let i = 1; i <= 8; i++) await touch("touchMove", x + ((to - x) * i) / 8, ax.y + (dy * i) / 8);
    x = to;
    await near(a, t);
  }
  await touch("touchEnd");
  await a.waitForTimeout(150);
  expect(Math.abs((await clock(a)) - 150)).toBeLessThanOrEqual(1);
});
