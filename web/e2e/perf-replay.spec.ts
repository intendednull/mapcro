// Frame time while a real replay plays at 8× with troopers, pings and health on, for the
// presenter and a follower (never committed data; skipped without MAPCRO_SHOT_REPLAY, like
// shots-replay.spec.ts). Main-thread time per frame comes from Chromium's own counters
// (Performance.getMetrics: script, style, layout and the rest of each task) over a few seconds
// of play, divided by the frames drawn.

import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl } from "./server";

const src = process.env.MAPCRO_SHOT_REPLAY;
const ID = process.env.MAPCRO_SHOT_REPLAY_ID ?? "129738985";
// The replay's busiest minute for troopers (129738985: 53 on average, 68 at most).
const FROM = Number(process.env.MAPCRO_PERF_FROM ?? "2490");
let server: Server;

test.skip(!src, "set MAPCRO_SHOT_REPLAY to a parsed timeline");
test.skip(({ browserName }) => browserName !== "chromium", "Chromium-only: frame cost from a CDP session (Performance.getMetrics)");

test.beforeAll(async () => {
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-perf-")), MATCH_API_BASE: "http://127.0.0.1:9" });
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  copyFileSync(src!, join(server.dataDir, "replays", `${ID}-cdn.json`));
  await server.start();
});
test.afterAll(() => server?.stop());

async function measure(p: Page, ms: number) {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("Performance.enable");
  const read = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  // Frames and the worst gap between them, counted in the page.
  await p.evaluate(() => {
    const w = window as unknown as { perf: { n: number; worst: number; last: number; gaps: number[] } };
    const mine = (w.perf = { n: 0, worst: 0, last: performance.now(), gaps: [] });
    const tick = (now: number) => {
      if (w.perf !== mine) return; // a later measurement took over

      const gap = now - w.perf.last;
      w.perf.gaps.push(gap);
      w.perf.worst = Math.max(w.perf.worst, gap);
      w.perf.last = now;
      w.perf.n++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const a = await read();
  await p.waitForTimeout(ms);
  const b = await read();
  const f = await p.evaluate(() => (window as unknown as { perf: { n: number; worst: number; gaps: number[] } }).perf);
  const per = (k: string) => ((b[k]! - a[k]!) * 1000) / f.n;
  const gaps = [...f.gaps].sort((x, y) => x - y);
  return {
    frames: f.n,
    taskMsPerFrame: per("TaskDuration"),
    scriptMsPerFrame: per("ScriptDuration"),
    styleMsPerFrame: per("RecalcStyleDuration"),
    layoutMsPerFrame: per("LayoutDuration"),
    gapP50: gaps[Math.floor(gaps.length * 0.5)],
    gapP95: gaps[Math.floor(gaps.length * 0.95)],
    gapMax: f.worst,
  };
}

test("8× on a real replay: frame time for the presenter and a follower", async ({ browser }) => {
  const url = await newBoardUrl(server, "Perf");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("follow-chip")).toContainText("Following Coach");
  await a.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, FROM);
  await a.getByTestId("match-speed").selectOption("8");
  await a.getByTestId("match-play").click();
  await a.waitForTimeout(1000);
  const troopers = await a.locator("[data-testid=trooper]").count();
  const [pa, pb] = await Promise.all([measure(a, 5000), measure(b, 5000)]);
  console.log("PERF on", JSON.stringify({ troopers, presenter: pa, follower: pb }));
  await a.screenshot({ path: "shots/perf-8x-presenter.png" });
  expect(troopers).toBeGreaterThan(20);
  // MAPCRO_PERF_PROFILE: the presenter's hottest functions by self time, for a closer look.
  if (process.env.MAPCRO_PERF_PROFILE) {
    const cdp = await a.context().newCDPSession(a);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
    await a.waitForTimeout(3000);
    const { profile } = await cdp.send("Profiler.stop");
    const self = new Map<string, number>();
    const dt = new Map<number, number>();
    profile.samples!.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas![i] ?? 0)));
    for (const n of profile.nodes) {
      const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`;
      self.set(k, (self.get(k) ?? 0) + (dt.get(n.id) ?? 0) / 1000);
    }
    console.log("PROFILE", JSON.stringify([...self].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, ms]) => `${ms.toFixed(0)}ms ${k}`)));
  }
  // The same stretch with troopers off, on both: what they cost.
  await a.getByTestId("match-play").click();
  await revealControls(a, "troopers-toggle");
  await a.getByTestId("troopers-toggle").click();
  await revealControls(b, "troopers-toggle");
  await b.getByTestId("troopers-toggle").click();
  await a.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, FROM);
  await a.getByTestId("match-play").click();
  await a.waitForTimeout(1000);
  const [qa, qb] = await Promise.all([measure(a, 5000), measure(b, 5000)]);
  console.log("PERF off", JSON.stringify({ presenter: qa, follower: qb }));
});
