// Starts the real mapcro-server binary on a port of its own, serving the built client from dist/.
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../test/support/server";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** The replay worker's current timeline format (`mapcro_replay::timeline::FORMAT`), read from its
 * source, so a synthetic "current" timeline stays current when the format moves on. */
export const TIMELINE_FORMAT = Number(/pub const FORMAT: u32 = (\d+);/.exec(readFileSync(join(ROOT, "crates/replay/src/timeline.rs"), "utf8"))![1]);

export class Server {
  child!: ChildProcess;
  port = 0;
  readonly dataDir = mkdtempSync(join(tmpdir(), "mapcro-e2e-"));
  constructor(
    private readonly packsDir?: string,
    private readonly extraEnv: Record<string, string> = {},
  ) {}

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Starts on a port of its own, or again on the same port and data (a restart). */
  async start() {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATA_DIR: this.dataDir,
      // A build of its own (MAPCRO_WEB_DIR) keeps a run off the dist another run is serving.
      WEB_DIR: process.env.MAPCRO_WEB_DIR ?? join(ROOT, "web/dist"),
      RUST_LOG: "warn",
    };
    if (this.packsDir) env.PACKS_DIR = this.packsDir;
    Object.assign(env, this.extraEnv);
    const s = await startServer({
      bin: join(ROOT, "target/debug/mapcro-server"),
      env,
      port: this.port,
      // The browser loads the server's own pages, so its origin names the port; unless the
      // spec serves the pages from elsewhere and says so.
      ...(this.extraEnv.PUBLIC_ORIGIN ? {} : { namesPort: (port: number) => ({ PUBLIC_ORIGIN: `http://127.0.0.1:${port}` }) }),
    });
    this.child = s.child;
    this.port = s.port;
  }

  stop() {
    this.child?.kill("SIGKILL");
  }

  /** Kill -9 and wait until it's gone, for outage tests. */
  async kill() {
    if (this.child.exitCode !== null) return;
    const gone = new Promise((r) => this.child.once("exit", r));
    this.child.kill("SIGKILL");
    await gone;
  }
}

/** The `translate(x y)` of an SVG transform attribute. */
export function translate(t: string | null): { x: number; y: number } {
  const m = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(t ?? "");
  if (!m) throw new Error(`no translate in ${t}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** A board made through the API; returns its owner link. */
export async function newBoardUrl(server: Server, title: string): Promise<string> {
  const r = await fetch(`${server.url}/api/boards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  return `${server.url}/b/${board}#${owner_token}`;
}
