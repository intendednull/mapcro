// Player's input latency and frame cost on a real replay (feedback #39; `just perf-player`, see
// the justfile). For each CPU throttle and match time, paused and playing:
//
//   tab      Tab keydown → all twelve build columns painted (ms)
//   hover    pointer onto an ability, an item and an ult dial → the game tooltip painted (ms)
//   scrub    one scrub step (an `input` on the time bar) → painted (ms, paused only)
//   frames   while playing: fps, main-thread busy %, script/style/layout %, long tasks
//   trace    while playing: Chromium's Layerize, PrePaint, HitTest, Paint, UpdateLayoutTree,
//            Layout and animation-frame (JS) totals over the window, and the style/layout
//            invalidations by node class and reason
//
// Only numbers are printed or written: never a name (hover texts and many DOM texts hold
// players' names). Results go to $PERF_OUT (default /tmp/mapcro-perf/out/player-<time>):
// summary.md and raw.json. Nothing is written into the repo.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, CDPSession, Page } from "@playwright/test";
import { expect, test } from "../../e2e/fixtures";
import { joinNew, revealControls } from "../../e2e/helpers";
import { Server, newBoardUrl } from "../../e2e/server";

const FALLBACK = "129738985";
const data = process.env.MAPCRO_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "mapcro/data");
const cached = (id: string) => join(data, "replays", `${id}-cdn.json`);
const asked = process.env.PERF_MATCH || "134623152";
// An explicit timeline file, else the dev stack's cache for the match, else the reference replay.
const pick = (): { id: string; file: string; note?: string } => {
  if (process.env.PERF_TIMELINE) return { id: asked, file: process.env.PERF_TIMELINE };
  if (existsSync(cached(asked))) return { id: asked, file: cached(asked) };
  return { id: FALLBACK, file: cached(FALLBACK), note: `no timeline for ${asked} in ${join(data, "replays")}: measured ${FALLBACK} instead` };
};
const src = pick();
const TIMES = (process.env.PERF_AT || "300,1735").split(",").map(Number);
const RATES = (process.env.PERF_RATES || "1,4").split(",").map(Number);
const OUT = process.env.PERF_OUT || `/tmp/mapcro-perf/out/player-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const PACKS = process.env.PERF_PACKS ?? (existsSync(join(data, "../packs")) ? join(data, "../packs") : undefined);
const TRACE_MS = 3000;

let server: Server;
test.setTimeout(1_800_000);
test.skip(({ browserName }) => browserName !== "chromium", "Chromium-only: CDP throttling, metrics and tracing");
test.beforeAll(async () => {
  if (!existsSync(src.file)) throw new Error(`no timeline at ${src.file}: fetch the match on a dev stack (docs/research/README.md) or set PERF_TIMELINE`);
  server = new Server(PACKS, { REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-perf-player-")), MATCH_API_BASE: "http://127.0.0.1:9" });
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  copyFileSync(src.file, join(server.dataDir, "replays", `${src.id}-cdn.json`));
  await server.start();
});
test.afterAll(() => server?.stop());

const seek = (p: Page, t: number) =>
  p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);

/** In the page: `lpUntil(t0, cond)` resolves with the ms from t0 to the frame after `cond` holds
 * (a frame, then a task: painted), or -1 after 3 s. Also collects long tasks. */
async function installProbe(p: Page) {
  await p.evaluate(() => {
    const w = window as any;
    w.lp = { long: [] as number[] };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.lp.long.push(e.duration); }).observe({ type: "longtask" });
    w.lpUntil = (t0: number, cond: () => boolean) =>
      new Promise<number>((res) => {
        const check = () => {
          if (performance.now() - t0 > 3000) res(-1);
          else if (cond())
            requestAnimationFrame(() => {
              const ch = new MessageChannel();
              ch.port1.onmessage = () => res(performance.now() - t0);
              ch.port2.postMessage(0);
            });
          else requestAnimationFrame(check);
        };
        check();
      });
  });
}

async function tabLatency(p: Page, n: number) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const ms = await p.evaluate(
      () =>
        new Promise<number>((res) => {
          const t0 = performance.now();
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true }));
          (window as any).lpUntil(t0, () => !!document.querySelector(".pl-topbar.all-builds") && document.querySelectorAll("[data-testid=hero-build]").length >= 12).then(res);
        }),
    );
    if (ms >= 0) out.push(ms);
    await p.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", code: "Tab", bubbles: true })));
    await p.waitForTimeout(300);
  }
  return out;
}

/** A real pointer onto each target: from the pointerover's timestamp to the tooltip painted. */
async function hoverLatency(p: Page, selector: string, n: number) {
  const out: number[] = [];
  const targets = p.locator(selector);
  const count = Math.min(n, await targets.count());
  for (let i = 0; i < count; i++) {
    const box = await targets.nth(i).boundingBox();
    if (!box) continue;
    await p.mouse.move(5, 450);
    await p.waitForTimeout(150);
    await p.evaluate(() => {
      const w = window as any;
      w.lpHover = new Promise<number>((res) => {
        const on = (e: PointerEvent) => {
          window.removeEventListener("pointerover", on, true);
          w.lpUntil(e.timeStamp, () => {
            const f = document.querySelector("[data-testid=game-tooltip-float]") as HTMLElement | null;
            return !!f && f.style.visibility !== "hidden";
          }).then(res);
        };
        window.addEventListener("pointerover", on, true);
      });
    });
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const ms = await p.evaluate(() => (window as any).lpHover);
    if (ms >= 0) out.push(ms);
  }
  await p.mouse.move(5, 450);
  return out;
}

async function scrubLatency(p: Page, from: number, n: number) {
  const out: number[] = [];
  for (let i = 0; i < n; i++)
    out.push(
      await p.getByTestId("match-time").evaluate(
        (el, t) =>
          new Promise<number>((res) => {
            const t0 = performance.now();
            (el as HTMLInputElement).value = String(t);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            requestAnimationFrame(() => {
              const ch = new MessageChannel();
              ch.port1.onmessage = () => res(performance.now() - t0);
              ch.port2.postMessage(0);
            });
          }),
        from + i,
      ),
    );
  return out;
}

async function frames(p: Page, cdp: CDPSession, ms: number) {
  await cdp.send("Performance.enable");
  const read = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value])) as Record<string, number>;
  await p.evaluate(() => {
    const w = window as any;
    w.lpFrames = 0;
    w.lp.long = [];
    const gen = (w.lpGen = (w.lpGen ?? 0) + 1);
    const tick = () => {
      if (w.lpGen !== gen) return;
      w.lpFrames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const a = await read();
  await p.waitForTimeout(ms);
  const b = await read();
  const { n, long } = await p.evaluate(() => ({ n: (window as any).lpFrames as number, long: (window as any).lp.long as number[] }));
  const pct = (k: string) => +((((b[k] ?? 0) - (a[k] ?? 0)) * 1000 * 100) / ms).toFixed(1);
  return { fps: +((n * 1000) / ms).toFixed(1), mainPct: pct("TaskDuration"), scriptPct: pct("ScriptDuration"), stylePct: pct("RecalcStyleDuration"), layoutPct: pct("LayoutDuration"), longTasks: long.length, longMs: Math.round(long.reduce((s, x) => s + x, 0)), domNodes: b.Nodes };
}

const TRACE_NAMES = ["FireAnimationFrame", "FunctionCall", "Layerize", "PrePaint", "HitTest", "Paint", "UpdateLayoutTree", "Layout", "Commit", "MajorGC", "MinorGC"];

/** The renderer main thread's totals by event name, and invalidations by node class and reason
 * (class only: never an element's text or other attributes). */
function readTrace(file: string) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  const ev: any[] = Array.isArray(d) ? d : d.traceEvents;
  const main = new Set(ev.filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`));
  const ms: Record<string, number> = { RunTask: 0 };
  for (const n of TRACE_NAMES) ms[n] = 0;
  const inval = new Map<string, number>();
  for (const e of ev) {
    const n: string = e.name ?? "";
    if (n.endsWith("InvalidationTracking")) {
      const node: string = e.args?.data?.nodeName ?? "?";
      // "circle class='pl-trooper amber'" → "circle.pl-trooper"; ids and text never kept.
      const tag = node.split(/[\s#]/)[0] ?? "?";
      const cls = /class='([^']*)'/.exec(node)?.[1]?.split(" ")[0];
      const k = `${n.replace("InvalidationTracking", "")} ${tag}${cls ? "." + cls : ""} (${String(e.args?.data?.reason ?? "").slice(0, 40)})`;
      inval.set(k, (inval.get(k) ?? 0) + 1);
    }
    if (e.ph !== "X" || e.dur == null || !main.has(`${e.pid}:${e.tid}`)) continue;
    if (n === "RunTask" || n === "ThreadControllerImpl::RunTask") ms.RunTask! += e.dur / 1000;
    else if (n in ms) ms[n]! += e.dur / 1000;
  }
  for (const k of Object.keys(ms)) ms[k] = Math.round(ms[k]!);
  const invalidations = Object.fromEntries([...inval].sort((a, b) => b[1] - a[1]).slice(0, 25));
  return { windowMs: TRACE_MS, ms, invalidations };
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => (s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * q))]!.toFixed(1) : null);
  return { med: at(0.5), p90: at(0.9), n: s.length };
};

async function open(browser: Browser) {
  const a = await joinNew(browser, await newBoardUrl(server, "Perf"), "Perf");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(src.id);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await installProbe(a);
  return a;
}

test("player: input latency and frame cost", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const a = await open(browser);
  const cdp = await a.context().newCDPSession(a);
  const rows: any[] = [];
  for (const rate of RATES) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    for (const t of TIMES) {
      for (const playing of [false, true]) {
        await seek(a, t);
        await a.waitForTimeout(500);
        if (playing) {
          await a.getByTestId("match-play").click();
          await a.waitForTimeout(500);
        }
        // PERF_ALL_BUILDS=1: measure with all twelve build columns open (each runs buildAt per draw).
        const allBuilds = !!process.env.PERF_ALL_BUILDS;
        if (allBuilds) {
          await a.locator(".tb-all-builds").click();
          await a.waitForTimeout(500);
        }
        const frame = await frames(a, cdp, 3000);
        let trace;
        if (playing) {
          const file = join(OUT, `trace-x${rate}-t${t}.json`);
          await browser.startTracing(a, { path: file, categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.invalidationTracking"] });
          await a.waitForTimeout(TRACE_MS);
          await browser.stopTracing();
          trace = readTrace(file);
          // The raw trace holds the page's URLs and DOM: kept only when asked (PERF_KEEP_TRACE).
          if (!process.env.PERF_KEEP_TRACE) rmSync(file);
        }
        if (allBuilds) {
          await a.locator(".tb-all-builds").click();
          await a.waitForTimeout(300);
        }
        const tab = await tabLatency(a, 8);
        await a.getByTestId("souls-banner").first().click();
        await a.waitForTimeout(300);
        const hover = [
          ...(await hoverLatency(a, "[data-testid=hero-build] .tb-build-ability", 4)),
          ...(await hoverLatency(a, "[data-testid=hero-build] .tb-build-item", 4)),
          ...(await hoverLatency(a, "[data-testid=ult-hover] > *", 4)),
        ];
        await a.keyboard.press("Escape");
        await a.waitForTimeout(200);
        if (playing) {
          await a.getByTestId("match-play").click();
          await a.waitForTimeout(300);
        }
        const scrub = playing ? undefined : stat(await scrubLatency(a, t, 15));
        const row = { load: +loadavg()[0]!.toFixed(1), rate, t, playing, frames: frame, tab: stat(tab), hover: stat(hover), ...(scrub ? { scrub } : {}), ...(trace ? { trace } : {}) };
        console.log(`PERF x${rate} t=${t} ${playing ? "playing" : "paused"} ${JSON.stringify({ load: row.load, frames: frame, tab: row.tab, hover: row.hover, scrub })}`);
        rows.push(row);
      }
    }
  }
  const raw = { match: src.id, note: src.note, rates: RATES, times: TIMES, rows };
  writeFileSync(join(OUT, "raw.json"), JSON.stringify(raw, null, 1));
  writeFileSync(join(OUT, "summary.md"), summary(raw));
  console.log(`PERF results in ${OUT}`);
});

function summary(r: { match: string; note: string | undefined; rows: any[] }) {
  const ms = (s: { med: number | null; p90: number | null } | undefined) => (s && s.med != null ? `${s.med} / ${s.p90}` : "–");
  const lines = [
    `# Player perf: match ${r.match}`,
    ...(r.note ? ["", `Note: ${r.note}`] : []),
    "",
    "Latencies are median / p90 ms to painted. Load is the box's 1-min load average when the row was measured (keep it low).",
    "",
    "| CPU | t | state | load | fps | main % | JS % | style % | layout % | long tasks | Tab | hover | scrub |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...r.rows.map((x) => `| ${x.rate}x | ${x.t} | ${x.playing ? "playing" : "paused"} | ${x.load} | ${x.frames.fps} | ${x.frames.mainPct} | ${x.frames.scriptPct} | ${x.frames.stylePct} | ${x.frames.layoutPct} | ${x.frames.longTasks} (${x.frames.longMs} ms) | ${ms(x.tab)} | ${ms(x.hover)} | ${ms(x.scrub)} |`),
    "",
    `## Trace while playing (renderer main thread, ms per ${TRACE_MS / 1000} s)`,
    "",
    "Traced with invalidation tracking on, which costs time itself: compare these with other traces, not with the table above.",
    "",
    `| CPU | t | ${["RunTask", ...TRACE_NAMES].join(" | ")} |`,
    `|---|---|${["RunTask", ...TRACE_NAMES].map(() => "---").join("|")}|`,
    ...r.rows.filter((x) => x.trace).map((x) => `| ${x.rate}x | ${x.t} | ${["RunTask", ...TRACE_NAMES].map((n) => x.trace.ms[n]).join(" | ")} |`),
    "",
    "## Invalidations while playing (count per window, by kind, node and reason)",
    "",
    ...r.rows.filter((x) => x.trace).flatMap((x) => [`### ${x.rate}x, t=${x.t}`, "", ...Object.entries(x.trace.invalidations).map(([k, n]) => `- ${n} ${k}`), ""]),
  ];
  return lines.join("\n") + "\n";
}
