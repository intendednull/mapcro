// A tab left open across a deploy (review 2026-11-07, finding 2): a server on another build
// closes it as outdated, and a message this build can't read is treated the same way: the tab
// is told to reload rather than retrying the same unreadable catch-up for ever.

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer } from "./support/server";
import { initSync } from "../src/wasm/mapcro_wasm.js";
import { Api } from "../src/core/api";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import { outdatedAction } from "../src/core/reload";

const ROOT = resolve(__dirname, "../..");
const ORIGIN = "http://localhost:5173";
initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

let server: ChildProcess;
let port = 0;
beforeAll(async () => {
  const started = await startServer({
    bin: join(ROOT, "target/debug/mapcro-server"),
    env: { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), "mapcro-web-")), PUBLIC_ORIGIN: ORIGIN, RUST_LOG: "error" },
  });
  server = started.child;
  port = started.port;
});
afterAll(() => server.kill("SIGKILL"));

const until = async (pred: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return pred();
};

async function session(o: { build?: string }) {
  const api = new Api(`http://127.0.0.1:${port}`);
  const { board, owner_token } = await api.createBoard("deploy");
  let opened = 0;
  let outdated = 0;
  let last: Record<string, unknown> | undefined;
  // A socket the test can also push server messages into, as a newer server would send them.
  const openSocket = (url: string) => {
    opened += 1;
    const w = new WebSocket(url, { origin: ORIGIN });
    const s: Record<string, unknown> = { send: (d: string) => w.send(d), close: () => w.close(), onopen: null, onmessage: null, onclose: null, onerror: null };
    w.on("open", () => (s.onopen as (() => void) | null)?.());
    w.on("message", (d) => (s.onmessage as ((e: { data: string }) => void) | null)?.({ data: String(d) }));
    w.on("close", () => (s.onclose as (() => void) | null)?.());
    last = s;
    return s as unknown as SocketLike;
  };
  const s = new BoardSession({
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    board,
    token: owner_token,
    persist: new MemoryPersist(),
    openSocket,
    minDelayMs: 20,
    maxDelayMs: 50,
    ...(o.build !== undefined ? { build: o.build } : {}),
    onOutdated: () => (outdated += 1),
  });
  await s.start();
  const push = (frame: unknown) => (last!.onmessage as (e: { data: string }) => void)({ data: JSON.stringify(frame) });
  return { s, opened: () => opened, outdated: () => outdated, push };
}

it("a client on another build is closed as outdated and told to reload, once", async () => {
  const { s, opened, outdated } = await session({ build: "an-older-build" });
  expect(await until(() => outdated() === 1)).toBe(true);
  expect(s.connection).toEqual({ kind: "closed", reason: "outdated" });
  await new Promise((r) => setTimeout(r, 300));
  expect(opened()).toBe(1); // no retries
  s.stop();
});

it("this build connects as usual", async () => {
  const { s, outdated } = await session({});
  expect(await until(() => s.connection.kind === "live")).toBe(true);
  expect(outdated()).toBe(0);
  s.stop();
});

it("a server message this build can't read means reload, not a retry loop", async () => {
  const { s, opened, outdated, push } = await session({});
  expect(await until(() => s.connection.kind === "live")).toBe(true);
  // A catch-up entry from a newer server, with a record field value this build doesn't know.
  push({ t: "msg", msg: { Entry: { seq: 999_999, tx: { client: "00000000000000000000000000000001", cseq: 0, kind: "Edit", ops: [{ Set: { id: "00000000000000000000000000000002", value: { FromTheFuture: 1 } } }] } } } });
  expect(await until(() => outdated() === 1)).toBe(true);
  await new Promise((r) => setTimeout(r, 300));
  expect(opened()).toBe(1); // no reconnect, no replay of the same unreadable entry
  s.stop();
});

it("reload once per build per tab, then offer it", () => {
  const store = new Map<string, string>();
  const ss = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  expect(outdatedAction("b1", ss)).toBe("reload");
  expect(outdatedAction("b1", ss)).toBe("offer");
  expect(outdatedAction("b2", ss)).toBe("reload");
});
