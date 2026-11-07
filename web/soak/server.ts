// The real mapcro-server binary on a free port and a temporary data dir: started, kill -9'd and
// restarted on the same data, with its memory sampled throughout.

import { type ChildProcess, spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { ORIGIN } from "./peer";

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

export class SoakServer {
  child: ChildProcess | undefined;
  port = 0;
  peakRssKb = 0;
  restarts = 0;
  readonly log: string;
  private sampler: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly bin: string,
    readonly dataDir: string,
    readonly env: Record<string, string>,
  ) {
    this.log = join(dataDir, "server.log");
  }

  get http() {
    return `http://127.0.0.1:${this.port}`;
  }
  get ws() {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  async start() {
    if (!this.port) this.port = await freePort();
    const out = openSync(this.log, "a");
    this.child = spawn(this.bin, [], {
      env: { ...process.env, PORT: String(this.port), DATA_DIR: this.dataDir, PUBLIC_ORIGIN: ORIGIN, RUST_LOG: "warn", ...this.env },
      stdio: ["ignore", out, out],
    });
    for (let i = 0; i < 400; i++) {
      try {
        if ((await fetch(`${this.http}/healthz`)).ok) break;
      } catch {}
      if (i === 399) throw new Error(`server never became healthy (log: ${this.log})`);
      await new Promise((r) => setTimeout(r, 25));
    }
    clearInterval(this.sampler);
    this.sampler = setInterval(() => this.sample(), 250);
  }

  /** The process's high-water RSS so far (kB). */
  sample() {
    const pid = this.child?.pid;
    if (!pid || this.child?.exitCode !== null) return;
    try {
      const m = /VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      if (m) this.peakRssKb = Math.max(this.peakRssKb, Number(m[1]));
    } catch {}
  }

  async kill9() {
    const c = this.child;
    if (!c || c.exitCode !== null) return;
    this.sample();
    clearInterval(this.sampler);
    const gone = new Promise((r) => c.once("exit", r));
    c.kill("SIGKILL");
    await gone;
  }

  async restart(downMs: number) {
    await this.kill9();
    this.restarts += 1;
    await new Promise((r) => setTimeout(r, downMs));
    await this.start();
  }
}
