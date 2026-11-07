// Starts the real mapcro-server binary on a free port, serving the built client from dist/.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

export class Server {
  child!: ChildProcess;
  port = 0;
  readonly dataDir = mkdtempSync(join(tmpdir(), "mapcro-e2e-"));
  constructor(private readonly packsDir?: string) {}

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Starts on a free port, or again on the same port and data (a restart). */
  async start() {
    if (!this.port) this.port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(this.port),
      DATA_DIR: this.dataDir,
      PUBLIC_ORIGIN: this.url,
      WEB_DIR: join(ROOT, "web/dist"),
      RUST_LOG: "warn",
    };
    if (this.packsDir) env.PACKS_DIR = this.packsDir;
    this.child = spawn(join(ROOT, "target/debug/mapcro-server"), [], { env, stdio: ["ignore", "ignore", "inherit"] });
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(`${this.url}/healthz`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("server never became healthy");
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
