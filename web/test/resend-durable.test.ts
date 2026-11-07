// Regression (soak 2026-11-07, fixed in 9780996): pending work resent on reconnect must be durable
// first. Before the fix, the hello and every pending transaction went out on Ready outside the
// save chain, so an edit made while the socket was down could be acked before its IndexedDB
// write landed. If the tab died, the reopened tab reused the cseq: it looped on AckMismatch
// forever, and an edit it made before Ready was silently swapped for the old one.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import WebSocket from "ws";
import { initSync } from "../src/wasm/mapcro_wasm.js";
import { Api } from "../src/core/api";
import { MemoryPersist, type Persist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import type { Op } from "../src/gen/Op";
import type { RecordId } from "../src/gen/RecordId";

const ROOT = resolve(__dirname, "../..");
const ORIGIN = "http://localhost:5173";
initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

const until = async (pred: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return pred();
};
const move = (id: RecordId, x: number): Op[] => [{ Set: { id, value: { PlayerPos: { x, y: 0 } } } }];
const pos = (s: BoardSession, id: RecordId) => {
  const e = s.records.get(id);
  return e && "PlayerState" in e.record ? e.record.PlayerState.pos.x : undefined;
};

let server: ChildProcess;
let port = 0;
beforeAll(async () => {
  port = await new Promise<number>((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
  server = spawn(join(ROOT, "target/debug/mapcro-server"), [], {
    env: { ...process.env, PORT: String(port), DATA_DIR: mkdtempSync(join(tmpdir(), "mapcro-web-")), PUBLIC_ORIGIN: ORIGIN, RUST_LOG: "error" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server never became healthy");
});
afterAll(() => server.kill("SIGKILL"));

/** A tab with an edit made during a network blip, while its storage stalls: the edit's save
 * hangs until `land()`, or forever if the tab dies first. */
async function blipWhileStorageStalls() {
  const api = new Api(`http://127.0.0.1:${port}`);
  const { board, owner_token } = await api.createBoard("durable resend");
  const storage = new MemoryPersist();
  let stalled = false;
  const held: Array<() => void> = [];
  const persist: Persist = {
    load: (b) => storage.load(b),
    save: (b, s) => (stalled ? new Promise((ok) => held.push(() => void storage.save(b, s).then(ok))) : storage.save(b, s)),
  };
  const sockets: WebSocket[] = [];
  const openSocket = (url: string) => {
    const w = new WebSocket(url, { origin: ORIGIN });
    sockets.push(w);
    return w as unknown as SocketLike;
  };
  const opts = { wsUrl: `ws://127.0.0.1:${port}/ws`, board, token: owner_token, openSocket, minDelayMs: 50, maxDelayMs: 200 };
  const tab = new BoardSession({ ...opts, persist });
  await tab.start();
  expect(await until(() => tab.connection.kind === "live")).toBe(true);
  const player = [...tab.records].find(([, e]) => "PlayerState" in e.record)![0];
  tab.edit(move(player, 1)); // durable and acked, so storage holds this tab's client id
  expect(await until(() => tab.status.kind === "saved" && storage.data.has(board))).toBe(true);

  stalled = true;
  sockets.at(-1)!.terminate(); // a network blip
  expect(await until(() => tab.connection.kind !== "live")).toBe(true);
  tab.edit(move(player, 111)); // made while reconnecting; its save stalls
  expect(await until(() => tab.connection.kind === "live")).toBe(true); // Ready arrived
  await new Promise((r) => setTimeout(r, 300)); // time for anything the reconnect sends to land

  const observer = new BoardSession({ ...opts, persist: new MemoryPersist() });
  await observer.start();
  expect(await until(() => observer.connection.kind === "live" && pos(observer, player) !== undefined)).toBe(true);
  const land = () => {
    stalled = false;
    for (const f of held.splice(0)) f();
  };
  return { opts, storage, player, tab, observer, land };
}

it("an edit whose save has not landed is not sent, and syncs once it lands", async () => {
  const { player, tab, observer, land } = await blipWhileStorageStalls();
  await new Promise((r) => setTimeout(r, 500));
  expect(pos(observer, player)).toBe(1); // the server never logged the undurable edit
  expect(tab.status).toEqual({ kind: "syncing", pending: 1 });

  land();
  expect(await until(() => tab.status.kind === "saved" && pos(observer, player) === 111)).toBe(true);
  expect(tab.problems).toEqual([]);
  tab.stop();
  observer.stop();
});

it("a tab reopened after dying mid-save syncs cleanly, and an edit made before Ready arrives", async () => {
  const { opts, storage, player, tab, observer } = await blipWhileStorageStalls();
  tab.stop(); // the tab dies; its stalled save never lands

  const reopened = new BoardSession({ ...opts, persist: storage });
  await reopened.start();
  reopened.edit(move(player, 222)); // before its first Ready
  expect(await until(() => reopened.connection.kind === "live" && reopened.status.kind === "saved")).toBe(true);
  expect(await until(() => pos(observer, player) === 222)).toBe(true);
  await new Promise((r) => setTimeout(r, 500)); // an AckMismatch loop would show by now
  expect(reopened.problems).toEqual([]);
  expect(reopened.connection.kind).toBe("live");
  expect(pos(reopened, player)).toBe(222);
  reopened.stop();
  observer.stop();
});
