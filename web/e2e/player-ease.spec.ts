// Changing values ease (spec §4a; operator, 2026-11-08): beyond health (player-health.spec.ts),
// the top bar's ult rings (a CSS transition on a typed --left), and through `easedNumber` the
// souls, the team totals, the respawn countdown, the lanes' zipline colours and the upload's
// bar and percent. Each eases out-expo over 350 ms to its new value, and with reduced motion
// jumps. A synthetic timeline the test hands the server as the worker would.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

const ID = "129000021";
const UPLOAD_ID = "129000022";
const N = 120;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-ease-"));
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

/** Amber's first hero dies at 20 s and is back at 80 s; its souls go 100 → 900 at 40 s (its
 *  team's total too: the others have none), and its ult cooldown runs down from 100% at 20 s.
 *  Mid's zipline: Amber to 300, then to 600 at 40 s. */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const first = team === "amber" && slot === 0;
        const alive = (s: number) => !first || s < 20 || s >= 80;
        return {
          team, slot, hero_id: 1 + slot, name: null,
          x: range((s) => (alive(s) ? slot * 300 : null)),
          y: range((s) => (alive(s) ? (team === "amber" ? -8000 : 8000) : null)),
          health: range((s) => (alive(s) ? 100 : 0)),
          deaths: first ? [20] : [], respawn: first ? [[20, 80]] : [],
          souls: first ? [[0, 100], [40, 900]] : [[0, 0]],
          ult: range((s) => (first && s >= 20 ? Math.max(0, 100 - (s - 20)) : 0)),
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [], camps: [],
    zips: [{ lane: "lane4", at: [[0, 300, 700], [40, 600, 650]] }],
  };
}

const dem = (size: number) => Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(size)]);

async function open(p: Page) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: dem(4096) });
  // The same file again is already parsed (the server says so): then there's no job to answer.
  let job = "";
  await expect
    .poll(async () => {
      job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "";
      return job !== "" || (await p.getByTestId("match-tier").textContent()) === "Full replay";
    })
    .toBe(true);
  if (job) writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}

const AMBER0 = '[data-testid=topbar] .tb-player[data-slot="Amber-0"]';

interface Frame {
  /** Milliseconds since the scrub. */
  at: number;
  respawn: number;
  souls: number;
  total: number;
  lane: number;
}

/** Scrub to `t`, then read the eased numbers each frame for 500 ms (in the page, so a slow
 *  round trip can't skip the frames between). Also the transitions on the ult ring a frame in. */
async function scrubAndSample(p: Page, t: number) {
  return p.evaluate(
    ({ t, AMBER0 }) =>
      new Promise<{ frames: Frame[]; ult: string[] }>((done) => {
        const el = document.querySelector("[data-testid=match-time]") as HTMLInputElement;
        el.value = String(t);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        const frames: Frame[] = [];
        let ult: string[] = [];
        const t0 = performance.now();
        const read = () => {
          const num = (sel: string) => Number(document.querySelector(sel)?.textContent ?? NaN);
          frames.push({
            at: performance.now() - t0,
            respawn: num(`${AMBER0} [data-testid=tb-respawn]`),
            souls: num(`${AMBER0} [data-testid=souls]`),
            total: num("[data-testid=total-Amber] .tb-score-label"),
            lane: Number(document.querySelector('[data-testid=map] svg.lanes g[data-key="lane4"]')?.getAttribute("data-amber") ?? NaN),
          });
          if (frames.length === 1)
            ult = (document.querySelector(`${AMBER0} .tb-ult`)?.getAnimations() ?? [])
              .filter((x): x is CSSTransition => x instanceof CSSTransition)
              .map((x) => `${x.transitionProperty} ${(x.effect as KeyframeEffect).getTiming().easing} ${(x.effect as KeyframeEffect).getTiming().duration}`);
          if (performance.now() - t0 < 500) requestAnimationFrame(read);
          else done({ frames, ult });
        };
        requestAnimationFrame(read);
      }),
    { t, AMBER0 },
  );
}

const between = (v: number, a: number, b: number) => v > Math.min(a, b) && v < Math.max(a, b);
const monotonic = (xs: number[], down: boolean) => xs.every((x, i) => i === 0 || (down ? x <= xs[i - 1]! : x >= xs[i - 1]!));

test("ult rings, souls, totals, the respawn countdown and the ziplines ease to each new value, and jump with reduced motion", async ({ browser }) => {
  for (const reduced of [false, true]) {
    const a = await joinNew(browser, await newBoardUrl(server, `Ease ${reduced}`), "Coach");
    await a.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
    await open(a);
    await scrubTo(a, 25);
    // Dead for 55 s more, 100 souls, mid's Amber edge at 300, the ult 95% left.
    await expect(a.locator(`${AMBER0} [data-testid=tb-respawn]`)).toHaveText("55");
    await expect(a.locator(`${AMBER0} [data-testid=souls]`)).toHaveText("100");
    await expect(a.locator('[data-testid=map] svg.lanes g[data-key="lane4"]')).toHaveAttribute("data-amber", "300");
    await expect(a.locator(`${AMBER0} [data-testid=ult]`)).toHaveAttribute("data-ult", "95");
    // Let every ease from loading settle.
    await expect.poll(() => a.locator(`${AMBER0} .tb-ult`).evaluate((el) => el.getAnimations().length)).toBe(0);
    await a.waitForTimeout(400);

    // 25 s → 75 s: the countdown 55 → 5, souls and total 100 → 900, the edge 300 → 600, the ult 95% → 45%.
    const { frames, ult } = await scrubAndSample(a, 75);
    const col = (k: keyof Frame) => frames.map((f) => f[k]);
    const last = (({ at: _, ...v }) => v)(frames[frames.length - 1]!);
    const value = (f: Frame) => (({ at: _, ...v }) => v)(f);
    // Each lands on the new value.
    expect(last).toEqual({ respawn: 5, souls: 900, total: 900, lane: 600 });
    if (reduced) {
      // Jumps: the first frame already shows the new value, and nothing between.
      expect(value(frames[0]!)).toEqual(last);
      for (const k of ["respawn", "souls", "total", "lane"] as const) expect(col(k).filter((v) => v !== last[k])).toEqual([]);
      expect(ult).toEqual([]);
    } else {
      // Counts through the values in between, one way, out-expo over 350 ms.
      const range: Record<Exclude<keyof Frame, "at">, [number, number]> = { respawn: [55, 5], souls: [100, 900], total: [100, 900], lane: [300, 600] };
      for (const k of ["respawn", "souls", "total", "lane"] as const) {
        const [from, to] = range[k];
        expect(col(k).filter((v) => between(v, from, to)).length, k).toBeGreaterThan(2);
        expect(monotonic(col(k), to < from), k).toBe(true);
        // Out-expo, not linear: most of the way there by 100 ms (86%; linear would be 29%).
        const early = frames.filter((f) => f.at >= 100 && f.at <= 200).map((f) => (f[k] - from) / (to - from));
        expect(early.length, k).toBeGreaterThan(0);
        expect(Math.min(...early), k).toBeGreaterThan(0.6);
      }
      expect(ult).toEqual(["--left cubic-bezier(0.16, 1, 0.3, 1) 350"]);
    }
    await a.close();
  }
});

test("the upload's bar and percent ease to each progress event, and jump with reduced motion", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium-only: throttles the upload with a CDP session (Network.emulateNetworkConditions)");
  for (const reduced of [false, true]) {
    const a = await joinNew(browser, await newBoardUrl(server, `Upload ease ${reduced}`), "Coach");
    await a.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
    await a.getByTestId("mode-player").click();
    await revealControls(a, "match-id");
    await a.getByTestId("match-id").fill(UPLOAD_ID);
    await a.getByTestId("match-load").click();
    // A slow link, so the upload takes a while and reports progress in steps.
    const cdp = await a.context().newCDPSession(a);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 1024 * 1024 });
    await revealControls(a, "match-file");
    await a.getByTestId("match-file").setInputFiles({ name: `${UPLOAD_ID}.dem`, mimeType: "application/octet-stream", buffer: dem(8 * 1024 * 1024) });
    await expect(a.getByTestId("upload-bar")).toBeVisible();
    // Each frame for a second: the bar drawn, and the bytes the last progress event reported.
    const frames = await a.evaluate(
      () =>
        new Promise<Array<[number, number]>>((done) => {
          const out: Array<[number, number]> = [];
          const t0 = performance.now();
          const read = () => {
            const bar = document.querySelector("[data-testid=upload-bar]") as HTMLProgressElement | null;
            if (bar) out.push([bar.value, Number(bar.dataset.loaded)]);
            if (performance.now() - t0 < 1000) requestAnimationFrame(read);
            else done(out);
          };
          requestAnimationFrame(read);
        }),
    );
    expect(frames.length).toBeGreaterThan(10);
    // Some progress arrived in the second.
    expect(new Set(frames.map((f) => f[1])).size).toBeGreaterThan(1);
    // Eased, the bar trails each event on its way there; with reduced motion it is always there.
    const trailing = frames.filter(([v, loaded]) => v > 0 && v < loaded).length;
    if (reduced) expect(trailing).toBe(0);
    else expect(trailing).toBeGreaterThan(2);
    await a.getByTestId("upload-cancel").click();
    await a.close();
  }
});
