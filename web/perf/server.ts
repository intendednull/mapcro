// The server under test: the real mapcro-server binary on a free port, its data dir on the
// filesystem being measured (a real disk, or tmpfs to take fsync out). Samples its CPU and RSS
// from /proc, and reads the per-stage timings the optional instrumentation patch logs
// (web/perf/server-timing.patch; target `mapcro_perf`). An unpatched binary just logs none.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

const TICK = 100; // USER_HZ on Linux

function cpuTicks(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(f[11]) + Number(f[12]); // utime + stime
}

/** CPU ticks per thread name (tokio workers, blocking pool, ...). */
function threadTicks(pid: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const tid of readdirSync(`/proc/${pid}/task`)) {
    try {
      const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8");
      const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      out.set(`${name}#${tid}`, Number(f[11]) + Number(f[12]));
    } catch {}
  }
  return out;
}

export interface PerfLine {
  kind: string;
  [k: string]: number | string;
}

export class PerfServer {
  child: ChildProcess | undefined;
  port = 0;
  readonly dataDir: string;
  readonly log: string;
  peakRssKb = 0;
  private sampler: ReturnType<typeof setInterval> | undefined;
  private cpu0 = 0;
  private t0 = 0;
  /** CPU% samples (one core = 100), each over the last second. */
  readonly cpuSeries: Array<{ t: number; pct: number; rssKb: number }> = [];

  constructor(
    readonly bin: string,
    /** Parent directory on the filesystem under test. */
    parent: string,
    readonly env: Record<string, string>,
  ) {
    mkdirSync(parent, { recursive: true });
    this.dataDir = mkdtempSync(join(parent, "mapcro-perf-"));
    this.log = join(this.dataDir, "server.log");
  }

  get http() {
    return `http://127.0.0.1:${this.port}`;
  }
  get ws() {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  async start() {
    this.port = await freePort();
    const out = openSync(this.log, "a");
    this.child = spawn(this.bin, [], {
      env: {
        ...process.env,
        PORT: String(this.port),
        DATA_DIR: this.dataDir,
        PUBLIC_ORIGIN: `http://127.0.0.1:${this.port},http://localhost:5173`,
        RUST_LOG: "warn,mapcro_perf=info",
        NO_COLOR: "1",
        ...this.env,
      },
      stdio: ["ignore", out, out],
    });
    for (let i = 0; i < 400; i++) {
      try {
        if ((await fetch(`${this.http}/healthz`)).ok) break;
      } catch {}
      if (i === 399) throw new Error(`server never became healthy (log: ${this.log})`);
      await new Promise((r) => setTimeout(r, 25));
    }
    this.markCpu();
    let last = { t: performance.now(), ticks: cpuTicks(this.child.pid!) };
    this.sampler = setInterval(() => {
      const pid = this.child?.pid;
      if (!pid || this.child?.exitCode !== null) return;
      try {
        const m = /VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
        const rss = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
        if (m) this.peakRssKb = Math.max(this.peakRssKb, Number(m[1]));
        const t = performance.now();
        const ticks = cpuTicks(pid);
        this.cpuSeries.push({ t: performance.timeOrigin + t, pct: ((ticks - last.ticks) / TICK / ((t - last.t) / 1000)) * 100, rssKb: Number(rss?.[1] ?? 0) });
        last = { t, ticks };
      } catch {}
    }, 1000);
  }

  /** Start a CPU accounting window. */
  markCpu() {
    this.cpu0 = cpuTicks(this.child!.pid!);
    this.t0 = performance.now();
    this.threads0 = threadTicks(this.child!.pid!);
  }
  private threads0 = new Map<string, number>();

  /** CPU used since `markCpu`, as % of one core, overall and for the busiest threads. */
  cpuSince(): { pct: number; seconds: number; threads: Array<[string, number]> } {
    const pid = this.child!.pid!;
    const secs = (performance.now() - this.t0) / 1000;
    const used = (cpuTicks(pid) - this.cpu0) / TICK;
    const th = [...threadTicks(pid)].map(([k, v]) => [k, ((v - (this.threads0.get(k) ?? 0)) / TICK / secs) * 100] as [string, number]);
    th.sort((a, b) => b[1] - a[1]);
    return { pct: (used / secs) * 100, seconds: used, threads: th.slice(0, 6) };
  }

  /** The instrumentation patch's lines (empty for an unpatched binary). */
  perfLines(since = 0): PerfLine[] {
    const out: PerfLine[] = [];
    let text = "";
    try {
      text = readFileSync(this.log, "utf8");
    } catch {
      return out;
    }
    for (const raw of text.split("\n")) {
      if (!raw.includes("mapcro_perf")) continue;
      const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
      const ts = Date.parse(line.slice(0, line.indexOf(" ")));
      if (since && ts < since) continue;
      const rec: PerfLine = { kind: "?", ts };
      for (const m of line.matchAll(/(\w+)=("([^"]*)"|\S+)/g)) rec[m[1]!] = m[3] ?? (Number.isNaN(Number(m[2])) ? m[2]! : Number(m[2]));
      out.push(rec);
    }
    return out;
  }

  stop(keep = false) {
    clearInterval(this.sampler);
    this.child?.kill("SIGKILL");
    if (!keep) {
      try {
        // Keep the log; drop the database.
        for (const f of readdirSync(this.dataDir)) if (f !== "server.log") rmSync(join(this.dataDir, f), { recursive: true, force: true });
      } catch {}
    }
  }
}

/** A board through the API: its id and owner token. */
export async function createBoard(http: string, title: string): Promise<{ board: string; owner: string }> {
  const r = await fetch(`${http}/api/boards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
  if (!r.ok) throw new Error(`create board: ${r.status} ${await r.text()}`);
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  return { board, owner: owner_token };
}

export async function mintLink(http: string, board: string, owner: string, role: "edit" | "view"): Promise<string> {
  const r = await fetch(`${http}/api/boards/${board}/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${owner}` },
    body: JSON.stringify({ role, label: role }),
  });
  if (!r.ok) throw new Error(`mint ${role}: ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}
