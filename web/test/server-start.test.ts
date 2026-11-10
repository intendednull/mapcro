// The harness helper that starts the real server on a port of its own (test/support/server.ts):
// it waits for its own child's word, reports an early exit with the child's reason, and a restart
// on a fixed port waits out whoever holds it rather than talking to them.

import { mkdtempSync } from "node:fs";
import { type Server as NetServer, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ServerExited, type Started, startServer } from "./support/server";

const ROOT = resolve(__dirname, "../..");
const bin = join(ROOT, "target/debug/mapcro-server");
const env = () => ({ ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), "mapcro-web-")), PUBLIC_ORIGIN: "http://localhost:5173", RUST_LOG: "error" });

const started: Started[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.child.kill("SIGKILL");
});
const exited = (s: Started) => new Promise((r) => (s.child.exitCode !== null ? r(null) : s.child.once("exit", r)));
const listen = (port: number) =>
  new Promise<NetServer>((ok, fail) => {
    const s = createServer((c) => c.end("HTTP/1.1 200 OK\r\ncontent-length: 7\r\n\r\nsquat\r\n"));
    s.once("error", fail).listen(port, "127.0.0.1", () => ok(s));
  });

it("takes a port of its own and answers on it", async () => {
  const s = await startServer({ bin, env: { ...env(), METRICS_ADDR: "127.0.0.1:0" } });
  started.push(s);
  expect(s.port).toBeGreaterThan(0);
  expect(await (await fetch(`http://127.0.0.1:${s.port}/healthz`)).text()).not.toContain("squat");
  expect(s.metricsPort).toBeGreaterThan(0);
  expect(s.metricsPort).not.toBe(s.port);
  expect((await fetch(`http://127.0.0.1:${s.metricsPort}/metrics`)).ok).toBe(true);
});

it("a server that exits before listening is reported with its own reason", async () => {
  const { DATA_DIR: _, ...noData } = env();
  const e = await startServer({ bin, env: noData, onStderr: () => {} }).catch((e: unknown) => e);
  expect(e).toBeInstanceOf(ServerExited);
  expect((e as ServerExited).message).toContain("DATA_DIR is required");
  expect((e as ServerExited).bindFailed).toBe(false);
});

it("a restart waits for its port while another process holds it, then is the one answering", async () => {
  const first = await startServer({ bin, env: env() });
  first.child.kill("SIGKILL");
  await exited(first);
  const squatter = await listen(first.port);
  let bindFailures = 0;
  const again = startServer({ bin, env: env(), port: first.port, onStderr: (t) => void (bindFailures += t.split("cannot bind").length - 1) });
  await new Promise((r) => setTimeout(r, 700));
  expect(bindFailures).toBeGreaterThan(0); // it really did meet the squatter
  await new Promise((r) => squatter.close(r));
  const s = await again;
  started.push(s);
  expect(s.port).toBe(first.port);
  expect(await (await fetch(`http://127.0.0.1:${s.port}/healthz`)).text()).not.toContain("squat");
});

it("a server whose env names its port is given the port it then binds", async () => {
  const asked: number[] = [];
  const s = await startServer({ bin, env: env(), namesPort: (p) => (asked.push(p), { PUBLIC_ORIGIN: `http://127.0.0.1:${p}` }) });
  started.push(s);
  expect(asked.at(-1)).toBe(s.port);
});
