// The events list holds every event of a match (hundreds of rows) while a screenful shows: the
// rows out of view are skipped for layout and paint, and a frame of playback touches no row
// while the current event stays, and at most the two rows that change when it moves (perf:
// hiding the list cut PrePaint 118 -> 27 ms per 3 s of play). Counts work, never time. A
// synthetic replay timeline the test hands the server as the worker would.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

const ID = "129000010";
const N = 1200;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-evcost-"));
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

/** 596 deaths every 2 s from 10 s: a 40-minute list, far more rows than it shows. */
const EVENTS = Array.from({ length: 596 }, (_, i) => {
  const slot = i % 6;
  return ev(10 + 2 * i, "death", { team: "amber", slot, hero_id: 1 + slot, ...spot(slot) });
});

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

const seek = (p: Page, t: number) =>
  p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);

/** Watches the list's rows: attributes, child lists and text, and the frames that pass. */
async function watch(p: Page) {
  await p.evaluate(() => {
    const w = window as any;
    const rows = new Set<string>();
    let attrs = 0;
    let other = 0;
    const obs = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type !== "attributes") other++;
        else {
          attrs++;
          rows.add((m.target as HTMLElement).dataset.key ?? "?");
        }
      }
    });
    obs.observe(document.querySelector(".pl-list")!, { attributes: true, subtree: true, childList: true, characterData: true });
    let frames = 0;
    const gen = (w.evCostGen = (w.evCostGen ?? 0) + 1);
    const tick = () => {
      if (w.evCostGen !== gen) return;
      frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    w.evCost = () => {
      w.evCostGen++;
      obs.disconnect();
      return { attrs, other, rows: rows.size, frames };
    };
  });
}
const counted = (p: Page) => p.evaluate(() => (window as any).evCost() as { attrs: number; other: number; rows: number; frames: number });

test("the list skips the rows out of view and playback touches no row", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Events cost"), "Coach");
  // Each row says when the browser skips its contents (content-visibility: auto) and when it
  // draws them again.
  await a.evaluate(() => {
    const w = window as any;
    w.evSkipped = new Map<string, boolean>();
    document.addEventListener(
      "contentvisibilityautostatechange",
      (e) => {
        const el = e.target as HTMLElement;
        if (el.dataset.key) w.evSkipped.set(el.dataset.key, (e as unknown as { skipped: boolean }).skipped);
      },
      true,
    );
  });
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(a.getByTestId("event")).toHaveCount(EVENTS.length);

  await seek(a, 600);
  await a.waitForTimeout(500);

  // Most rows are out of view and skipped; the current one, in view, is drawn.
  const view = await a.evaluate(() => {
    const w = window as any;
    const now = document.querySelector<HTMLElement>('[data-testid=event][data-current="true"]')!;
    return {
      rows: document.querySelectorAll("[data-testid=event]").length,
      skipped: [...w.evSkipped.values()].filter(Boolean).length,
      current: w.evSkipped.get(now.dataset.key!),
      at: Number(now.dataset.t),
    };
  });
  expect(view.rows).toBeGreaterThan(100);
  expect(view.at).toBe(600);
  expect(view.skipped, "the rows out of view are skipped").toBeGreaterThan(view.rows / 2);
  expect(view.current, "the current row is drawn").toBe(false);

  // 1x for a second: the current event (600 s, the next at 602 s) stays, and no row changes.
  await watch(a);
  await a.getByTestId("match-play").click();
  await a.waitForTimeout(1200);
  const played = await counted(a);
  await a.getByTestId("match-play").click();
  expect(played.frames).toBeGreaterThan(30);
  expect(played, "a frame of playback changes no row").toEqual({ attrs: 0, other: 0, rows: 0, frames: played.frames });

  // A seek past the next events moves the mark: the two rows that changed, no more.
  await a.waitForTimeout(300);
  await watch(a);
  await seek(a, 800);
  await a.waitForTimeout(500);
  const seeked = await counted(a);
  await expect(a.locator('[data-testid=event][data-current="true"]')).toHaveAttribute("data-t", "800");
  expect(seeked.rows).toBeLessThanOrEqual(2);
  expect(seeked.other).toBe(0);
});
