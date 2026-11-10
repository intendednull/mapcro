// The real mapcro-server binary on a port of its own and a temporary data dir: started, kill -9'd
// and restarted on the same port and data, with its memory sampled throughout.

import type { ChildProcess } from "node:child_process";
import { openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../test/support/server";
import { ORIGIN } from "./peer";

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

  /** Starts on a port of its own, or again on the same port and data (a restart). */
  async start() {
    const out = openSync(this.log, "a");
    const s = await startServer({
      bin: this.bin,
      env: { ...process.env, DATA_DIR: this.dataDir, PUBLIC_ORIGIN: ORIGIN, RUST_LOG: "warn", ...this.env },
      port: this.port,
      stdout: out,
      onStderr: (t) => void writeSync(out, t),
    });
    this.child = s.child;
    this.port = s.port;
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
