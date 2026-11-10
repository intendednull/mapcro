// Regressions for two bugs the soak found (2026-11-07), both fixed in 0d7047f:
// - A view replica restored from storage accepted an edit before Ready (the role was learned only
//   from Ready), persisted it, and resent it on every connect: a Fatal each time, forever.
// - Pending work after a long offline stretch went out in one burst on Ready. Past the server's
//   300-frame burst the socket was closed as abuse and everything was resent, again and again
//   (2000 edits took 78 s and 683 abuse closes to drain).

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
import type { RecordId } from "../src/gen/RecordId";

const ROOT = resolve(__dirname, "../..");
const ORIGIN = "http://localhost:5173";
initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

const until = async (pred: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return pred();
};
const pos = (s: BoardSession, id: RecordId) => {
  const e = s.records.get(id);
  return e && "PlayerState" in e.record ? e.record.PlayerState.pos.x : undefined;
};

let server: ChildProcess;
let api: Api;
let wsUrl = "";
beforeAll(async () => {
  const started = await startServer({
    bin: join(ROOT, "target/debug/mapcro-server"),
    env: { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), "mapcro-web-")), PUBLIC_ORIGIN: ORIGIN, RUST_LOG: "error" },
  });
  server = started.child;
  const port = started.port;
  api = new Api(`http://127.0.0.1:${port}`);
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterAll(() => server.kill("SIGKILL"));

/** Sockets that record every `closed` reason the server sends. */
function recordingSockets() {
  const closes: string[] = [];
  const openSocket = (url: string) => {
    const w = new WebSocket(url, { origin: ORIGIN });
    w.on("message", (d) => {
      const f = JSON.parse(String(d)) as { t: string; reason?: string };
      if (f.t === "closed") closes.push(f.reason!);
    });
    return w as unknown as SocketLike;
  };
  return { closes, openSocket };
}

it("a view session restored from storage refuses an edit before Ready, and stays live", async () => {
  const { board, owner_token } = await api.createBoard("view before ready");
  const { token: view } = await api.mintLink(board, owner_token, "view", "fan");
  const { closes, openSocket } = recordingSockets();
  const persist = new MemoryPersist();
  const viewer = () => new BoardSession({ wsUrl, board, token: view, persist, openSocket, minDelayMs: 50, maxDelayMs: 200 });

  // The viewer's device has a copy of the board from an earlier visit.
  const first = viewer();
  await first.start();
  expect(await until(() => first.connection.kind === "live")).toBe(true);
  const player = [...first.records].find(([, e]) => "PlayerState" in e.record)![0];
  const owner = new BoardSession({ wsUrl, board, token: owner_token, persist: new MemoryPersist(), openSocket });
  await owner.start();
  expect(await until(() => owner.connection.kind === "live")).toBe(true);
  owner.edit([{ Set: { id: player, value: { PlayerAlive: false } } }]);
  expect(await until(() => persist.data.has(board))).toBe(true); // saved lazily after the broadcast
  first.stop();

  // Reloaded; something edits before the first Ready.
  const again = viewer();
  await again.start();
  const before = pos(again, player);
  again.edit([{ Set: { id: player, value: { PlayerPos: { x: 1, y: 1 } } } }]);
  expect(again.problems).toContain("this link is view-only");
  expect(again.status).toEqual({ kind: "saved" }); // nothing pending, nothing to resend
  expect(pos(again, player)).toBe(before);

  expect(await until(() => again.connection.kind === "live")).toBe(true);
  await new Promise((r) => setTimeout(r, 1000)); // a Fatal loop would show by now
  expect(again.connection).toEqual({ kind: "live", role: "view" });
  expect(again.problems.filter((p) => p.startsWith("protocol error"))).toEqual([]);
  expect(closes).toEqual([]);
  again.stop();
  owner.stop();
});

it("2000 edits made offline drain with no abuse closes, paced at about 30/s", { timeout: 180_000 }, async () => {
  const { board, owner_token } = await api.createBoard("long offline");
  const { closes, openSocket } = recordingSockets();
  const persist = new MemoryPersist();
  const opts = { wsUrl, board, token: owner_token, persist, openSocket, minDelayMs: 50, maxDelayMs: 200 };
  const a = new BoardSession(opts);
  await a.start();
  expect(await until(() => a.connection.kind === "live")).toBe(true);
  const player = [...a.records].find(([, e]) => "PlayerState" in e.record)![0];
  a.stop(); // offline for a long stretch
  const N = 2000;
  for (let i = 1; i <= N; i++) a.edit([{ Set: { id: player, value: { PlayerPos: { x: i, y: 0 } } } }]);
  expect(a.status).toEqual({ kind: "offline", pending: N });
  await new Promise((r) => setTimeout(r, 300)); // the saves land

  const back = new BoardSession(opts); // back online (reloaded)
  const t0 = Date.now();
  await back.start();
  expect(await until(() => back.connection.kind === "live" && back.status.kind === "saved", 150_000)).toBe(true);
  const ms = Date.now() - t0;
  console.log(`${N} offline edits drained in ${ms} ms, ${closes.length} closes`);
  expect(closes).toEqual([]); // never closed as abuse
  expect(back.problems.filter((p) => p.startsWith("protocol error"))).toEqual([]);
  expect(pos(back, player)).toBe(N);
  // The first 200 frames go at once and the rest at 30/s: about 60 s for 2000.
  const paced = ((N + 1 - 200) / 30) * 1000;
  expect(ms).toBeGreaterThan(paced * 0.9);
  expect(ms).toBeLessThan(paced * 1.5);
  back.stop();
});
