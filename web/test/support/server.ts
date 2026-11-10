// Starting the real mapcro-server binary for a test or harness, on a port of its own.
//
// The server is given `PORT=0`, binds a free port itself, and says which on stderr
// (`mapcro-server: listening on <addr>`, after `metrics on <addr>` when it has METRICS_ADDR). The
// harness waits for that line from its own child: then the port is the child's and connections
// queue. This is the TypeScript side of crates/server/tests/support/mod.rs.
//
// Picking a free port in the harness and handing it over raced on a busy box: the port was free
// when the harness looked and taken by the time the child bound it (by another test's server, or
// by any outbound connection's local port), so the child died of `cannot bind` while a /healthz
// poll waited it out or, worse, was answered by the other test's server (backlog, 2026-11-09).

import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";

/** How long a spawned server may take to bind. Milliseconds on a quiet box; this only bounds a
 * server that hangs. Waiting is on the child's own word, never a poll, so it costs nothing. */
export const READY_WITHIN_MS = 60_000;
/** How long a restart waits for its fixed port while someone else holds it. */
const RETAKE_WITHIN_MS = 30_000;
/** Candidate ports tried for a server whose env must name its port before it binds. */
const CANDIDATES = 20;

export interface Started {
  child: ChildProcess;
  port: number;
  /** The `/metrics` listener's port, if the server was given `METRICS_ADDR`. */
  metricsPort: number | undefined;
}

/** The child exited before it listened. */
export class ServerExited extends Error {
  constructor(
    readonly status: string,
    readonly stderr: string,
  ) {
    super(`mapcro-server exited before listening (${status}): ${stderr.trimEnd()}`);
  }
  get bindFailed() {
    return this.stderr.includes("cannot bind");
  }
}

export interface StartOptions {
  bin: string;
  /** The child's whole environment, but for `PORT`. */
  env: NodeJS.ProcessEnv;
  /** 0 (the default): a free port of the server's own choosing. A number: that port, for a
   * restart that clients come back to; while another process holds it, wait for it. */
  port?: number;
  /** For a server whose env must name its own port before it binds (a `PUBLIC_ORIGIN` for the
   * pages it serves itself): the env for a given port, merged over `env`. A first start then
   * tries candidate ports, and only its own child's bind failure sends it to the next. */
  namesPort?: (port: number) => NodeJS.ProcessEnv;
  /** Where the child's stdout goes. Default: nowhere. */
  stdout?: "ignore" | "inherit" | number;
  /** Where the child's stderr goes, as it arrives, for its whole life. Default: this process's. */
  onStderr?: (text: string) => void;
}

/** Start the server and wait until it says where it listens. Rejects with `ServerExited` if
 * the child exits first, or with a timeout after `READY_WITHIN_MS`. */
export async function startServer(o: StartOptions): Promise<Started> {
  const named = (port: number) => ({ ...o.env, ...o.namesPort?.(port) });
  if (o.port) {
    const deadline = Date.now() + RETAKE_WITHIN_MS;
    for (;;) {
      try {
        return await spawnOnce(o, o.port, named(o.port));
      } catch (e) {
        if (!(e instanceof ServerExited && e.bindFailed && Date.now() < deadline)) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
  if (!o.namesPort) return spawnOnce(o, 0, o.env);
  for (let i = 1; ; i++) {
    const port = await unusedPort();
    try {
      return await spawnOnce(o, port, named(port));
    } catch (e) {
      if (!(e instanceof ServerExited && e.bindFailed && i < CANDIDATES)) throw e;
    }
  }
}

/** A port nothing listened on a moment ago. Only for an env that must name the port before the
 * server binds it; the bind can still lose, which `startServer` sees in the child's stderr. */
function unusedPort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

function spawnOnce(o: StartOptions, port: number, env: NodeJS.ProcessEnv): Promise<Started> {
  const child = spawn(o.bin, [], { env: { ...env, PORT: String(port) }, stdio: ["ignore", o.stdout ?? "ignore", "pipe"] });
  const echo = o.onStderr ?? ((t: string) => void process.stderr.write(t));
  return new Promise((ok, fail) => {
    let settled = false;
    let seen = ""; // stderr until it listened, for the error if it doesn't
    let partial = "";
    let metricsPort: number | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      fail(new Error(`mapcro-server did not listen within ${READY_WITHIN_MS / 1000} s: ${seen.trimEnd()}`));
    }, READY_WITHIN_MS);
    const settle = () => {
      settled = true;
      clearTimeout(timer);
    };
    // Drained for the child's whole life, or a chatty server would block on a full pipe.
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      echo(chunk);
      if (settled) return;
      seen += chunk;
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!;
      for (const line of lines) {
        metricsPort = portAfter(line, "mapcro-server: metrics on ") ?? metricsPort;
        const p = portAfter(line, "mapcro-server: listening on ");
        if (p !== undefined) {
          settle();
          ok({ child, port: p, metricsPort });
          return;
        }
      }
    });
    child.once("error", (e) => {
      if (settled) return;
      settle();
      fail(e);
    });
    // `close` comes after the exit and the end of stderr, so `seen` is all of it.
    child.once("close", (code, signal) => {
      if (settled) return;
      settle();
      fail(new ServerExited(signal ? `signal ${signal}` : `exit code ${code}`, seen));
    });
  });
}

function portAfter(line: string, prefix: string): number | undefined {
  const t = line.trimEnd();
  if (!t.startsWith(prefix)) return undefined;
  const m = /:(\d+)$/.exec(t);
  return m ? Number(m[1]) : undefined;
}
