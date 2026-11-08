// People in real browsers: one Chromium per person (its own renderer process, as on separate
// machines), the probe (probe.js) injected before the app loads, and human-paced gestures through
// the real input surface: drag a hero, draw ink, toggle an objective.

import { type Browser, type CDPSession, type Page, chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { sleep } from "./stats";

export interface ProbeDump {
  recv: Array<Record<string, unknown> & { t: number; k: string; ms: number; wasm: number; parse: number; raf?: number; painted?: number; mut: number; attrs: number; added: number; removed: number; bytes: number }>;
  sent: Array<Record<string, unknown> & { t: number; k: string }>;
  idb: Array<{ t: number; done: number; bytes: number; key: string }>;
  input: Array<{ k: string; t: number; seen: number; end?: number }>;
  wasm: Record<string, { n: number; ms: number }>;
  wasmCalls: Array<{ name: string; t: number; ms: number }>;
  longTasks: Array<{ t: number; ms: number }>;
  me: number | null;
  frames?: number[];
}

export interface MemSample {
  t: number;
  heapMb: number;
  nodes: number;
  listeners: number;
}

export class Person {
  readonly mem: MemSample[] = [];
  private memTimer: ReturnType<typeof setInterval> | undefined;
  private cdp!: CDPSession;
  actions = 0;
  failures = 0;
  /** From navigation to the board's tokens on screen, and from the name entered. */
  joinMs = 0;
  joinAfterNameMs = 0;
  /** Page errors, HTTP 5xx/429 and server `closed` frames seen: a live run stops on the first. */
  readonly errors: string[] = [];
  constructor(
    readonly name: string,
    readonly browser: Browser,
    readonly page: Page,
    readonly editor: boolean,
  ) {}

  static async join(url: string, name: string, o: { headless: boolean; probe: string; editor: boolean; failDir?: string; joinTimeoutMs?: number }): Promise<Person> {
    const browser = await chromium.launch({ headless: o.headless });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript({ path: o.probe });
    const page = await ctx.newPage();
    const t0 = Date.now();
    await page.goto(url);
    await page.locator("#join-name").fill(name, { timeout: 180_000 });
    const t1 = Date.now();
    await page.keyboard.press("Enter");
    try {
      await page.getByTestId("join-card").waitFor({ state: "hidden", timeout: o.joinTimeoutMs ?? 180_000 });
      await page.locator(".mapbox .tok").first().waitFor({ timeout: o.joinTimeoutMs ?? 180_000 });
    } catch (e) {
      // Leave evidence: what the page shows, and what it was doing.
      if (o.failDir) {
        await page.screenshot({ path: `${o.failDir}/join-fail-${name}.png` }).catch(() => {});
        const why = await page
          .evaluate(() => {
            const P = (window as unknown as { __perf: ProbeDump }).__perf;
            const by: Record<string, { n: number; ms: number }> = {};
            for (const r of P.recv) {
              const b = (by[r.k] ??= { n: 0, ms: 0 });
              b.n++;
              b.ms += r.ms;
            }
            const status = document.querySelector("[data-testid=save-status]")?.getAttribute("data-state");
            return { by, status, sent: P.sent.length, last: P.recv.slice(-5).map((r) => [r.k, r.ms, r.bytes]), body: document.body.innerText.slice(0, 300) };
          })
          .catch((err) => String(err));
        writeFileSync(`${o.failDir}/join-fail-${name}.json`, JSON.stringify(why, null, 1));
      }
      throw e;
    }
    const p = new Person(name, browser, page, o.editor);
    p.joinMs = Date.now() - t0;
    p.joinAfterNameMs = Date.now() - t1;
    page.on("pageerror", (e) => p.errors.push(`pageerror: ${e.message}`));
    page.on("response", (r) => {
      if (r.status() >= 500 || r.status() === 429) p.errors.push(`http ${r.status()} ${r.url()}`);
    });
    p.cdp = await ctx.newCDPSession(page);
    await p.cdp.send("Performance.enable");
    return p;
  }

  sampleMemory(everyMs: number) {
    const take = async () => {
      try {
        const { metrics } = (await this.cdp.send("Performance.getMetrics")) as { metrics: Array<{ name: string; value: number }> };
        const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
        this.mem.push({ t: Date.now(), heapMb: (m.JSHeapUsedSize ?? 0) / 2 ** 20, nodes: m.Nodes ?? 0, listeners: m.JSEventListeners ?? 0 });
      } catch {}
    };
    void take();
    this.memTimer = setInterval(take, everyMs);
  }

  async follow(presenter: string) {
    await this.page.getByTestId(`follow-${presenter}`).click({ timeout: 10_000 });
    await this.page.getByTestId("follow-chip").waitFor({ timeout: 10_000 });
  }

  private async mapBox() {
    return (await this.page.locator("[data-testid=map] .mm-overlay.map").boundingBox())!;
  }

  /** Press on a hero, move it in small steps the way a hand does, release. */
  async drag(rnd: () => number, stepMs = 30) {
    const toks = this.page.locator(".mapbox .tok");
    const n = await toks.count();
    if (!n) return;
    const box = await toks.nth(Math.floor(rnd() * n)).boundingBox();
    if (!box) return;
    const map = await this.mapBox();
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const to = { x: map.x + map.width * (0.2 + 0.6 * rnd()), y: map.y + map.height * (0.2 + 0.6 * rnd()) };
    const m = this.page.mouse;
    await m.move(from.x, from.y);
    await m.down();
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await m.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await sleep(stepMs);
    }
    await m.up();
  }

  /** Draw tool, a short scribble, back to Move. */
  async ink(rnd: () => number) {
    const map = await this.mapBox();
    const kb = this.page.keyboard;
    await kb.press("d");
    const m = this.page.mouse;
    let x = map.x + map.width * (0.25 + 0.5 * rnd());
    let y = map.y + map.height * (0.25 + 0.5 * rnd());
    await m.move(x, y);
    await m.down();
    for (let i = 0; i < 16; i++) {
      x += (rnd() - 0.4) * 18;
      y += (rnd() - 0.5) * 18;
      await m.move(x, y);
      await sleep(16);
    }
    await m.up();
    await kb.press("v");
  }

  /** Click an objective: cycles its state. */
  async objective(rnd: () => number) {
    const mk = this.page.locator('.mapbox .mk[data-key^="walker"], .mapbox .mk[data-key^="guardian"]');
    const n = await mk.count();
    if (!n) return;
    const bb = await mk.nth(Math.floor(rnd() * n)).boundingBox();
    if (!bb) return;
    await this.page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  }

  /** Move the cursor over the map for a while (presence only). */
  async hover(rnd: () => number, ms: number) {
    const map = await this.mapBox();
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await this.page.mouse.move(map.x + map.width * rnd(), map.y + map.height * rnd(), { steps: 3 });
      await sleep(40);
    }
  }

  async act(rnd: () => number) {
    const r = rnd();
    try {
      if (r < 0.6) await this.drag(rnd);
      else if (r < 0.8) await this.ink(rnd);
      else await this.objective(rnd);
      this.actions++;
    } catch {
      this.failures++;
    }
  }

  /** Start/stop recording every animation frame's timestamp (frame pacing). */
  async frames(on: boolean) {
    await this.page.evaluate((on) => {
      const w = window as unknown as { __perf: { frames?: number[]; framesOn?: boolean } };
      if (on) {
        w.__perf.frames = [];
        w.__perf.framesOn = true;
        const loop = (t: number) => {
          if (!w.__perf.framesOn) return;
          w.__perf.frames!.push(performance.timeOrigin + t);
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      } else w.__perf.framesOn = false;
    }, on);
  }

  async startTrace(path: string) {
    await this.browser.startTracing(this.page, {
      path,
      screenshots: false,
      categories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
        "toplevel",
        "blink.user_timing",
        "v8.execute",
        "v8",
        "blink",
        "cc",
        "gpu",
      ],
    });
  }

  async stopTrace() {
    await this.browser.stopTracing();
  }

  async startProfile() {
    await this.cdp.send("Profiler.enable");
    await this.cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await this.cdp.send("Profiler.start");
  }

  async stopProfile(path: string): Promise<CpuProfile> {
    const { profile } = (await this.cdp.send("Profiler.stop")) as { profile: CpuProfile };
    writeFileSync(path, JSON.stringify(profile));
    return profile;
  }

  async domNodes(): Promise<{ all: number; svg: number; tokens: number; strokes: number }> {
    return this.page.evaluate(() => ({
      all: document.getElementsByTagName("*").length,
      svg: document.querySelectorAll("svg *").length,
      tokens: document.querySelectorAll(".mapbox .tok").length,
      strokes: document.querySelectorAll(".mapbox [data-stroke]").length,
    }));
  }

  /** Server `closed` frames and save problems the page has seen so far. */
  async health(): Promise<string[]> {
    const closed = await this.page.evaluate(() => (window as unknown as { __perf: ProbeDump }).__perf.recv.filter((r) => r.k === "closed").length).catch(() => 0);
    return closed ? [...this.errors, `${closed} closed frame(s)`] : this.errors;
  }

  async dump(): Promise<ProbeDump> {
    return this.page.evaluate(() => (window as unknown as { __perf: unknown }).__perf) as Promise<ProbeDump>;
  }

  async close() {
    clearInterval(this.memTimer);
    await this.browser.close().catch(() => {});
  }
}

export interface CpuProfile {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }>;
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
}

/** Self time per function from a CPU profile, the busiest first. */
export function selfTimes(p: CpuProfile, top = 25): Array<{ fn: string; ms: number; pct: number }> {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < p.samples.length; i++) {
    const n = byId.get(p.samples[i]!);
    const dt = (p.timeDeltas[i + 1] ?? p.timeDeltas[i] ?? 0) / 1000;
    if (!n) continue;
    const cf = n.callFrame;
    const file = cf.url.split("/").pop() || "";
    const key = `${cf.functionName || "(anonymous)"} ${file}${file ? `:${cf.lineNumber + 1}` : ""}`;
    self.set(key, (self.get(key) ?? 0) + dt);
    total += dt;
  }
  return [...self]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([fn, ms]) => ({ fn, ms, pct: (ms / total) * 100 }));
}
