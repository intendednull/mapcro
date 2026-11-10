// A stroke moved while someone else deletes or moves it (review 2026-11-07, finding 1): the
// move must never bring a deleted stroke back or leave two copies, and undoing a move after
// a peer's delete must leave it deleted.

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer } from "./support/server";
import { initSync, newRecordId } from "../src/wasm/mapcro_wasm.js";
import { Api } from "../src/core/api";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import { moveStrokeOps } from "../src/board/placed";
import type { RecordId } from "../src/gen/RecordId";
import type { Stroke } from "../src/gen/Stroke";

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

const until = async (pred: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return pred();
};
const openSocket = (url: string) => new WebSocket(url, { origin: ORIGIN }) as unknown as SocketLike;
const strokes = (s: BoardSession) => [...s.records].filter(([, e]) => !e.deleted && "Stroke" in e.record);
const strokeOf = (s: BoardSession, id: RecordId) => {
  const e = s.records.get(id);
  return e && "Stroke" in e.record ? e.record.Stroke : undefined;
};
const settled = (...ss: BoardSession[]) => until(() => ss.every((s) => s.status.kind === "saved"));

/** Two editors and an observer on a board with one stroke. */
async function board() {
  const api = new Api(`http://127.0.0.1:${port}`);
  const { board, owner_token } = await api.createBoard("strokes");
  const open = async () => {
    const s = new BoardSession({ wsUrl: `ws://127.0.0.1:${port}/ws`, board, token: owner_token, persist: new MemoryPersist(), openSocket });
    await s.start();
    expect(await until(() => s.connection.kind === "live")).toBe(true);
    return s;
  };
  const [a, b, obs] = [await open(), await open(), await open()];
  const scene = [...a.records].find(([, e]) => "Scene" in e.record)![0];
  const id = newRecordId();
  const stroke: Stroke = { scene, points: [{ x: 0, y: 0 }, { x: 100, y: 50 }], color: 1, width: 30 } as Stroke;
  a.edit([{ Create: { id, record: { Stroke: stroke } } }]);
  expect(await until(() => [a, b, obs].every((s) => strokeOf(s, id) !== undefined))).toBe(true);
  return { a, b, obs, id, stroke: strokeOf(a, id)! };
}
const stop = (...ss: BoardSession[]) => ss.forEach((s) => s.stop());

it("a move racing a delete doesn't bring the stroke back", async () => {
  const { a, b, obs, id, stroke } = await board();
  const move = moveStrokeOps(id, stroke, { x: 40, y: 40 }); // A's move, from what A saw
  b.edit([{ Delete: { id } }]);
  expect(await settled(b)).toBe(true);
  a.edit(move);
  expect(await settled(a, b)).toBe(true);
  await new Promise((r) => setTimeout(r, 200));
  expect(strokes(obs)).toHaveLength(0);
  stop(a, b, obs);
});

it("two moves at once leave one stroke", async () => {
  const { a, b, obs, id, stroke } = await board();
  const ma = moveStrokeOps(id, stroke, { x: 40, y: 0 });
  const mb = moveStrokeOps(id, stroke, { x: 0, y: 70 });
  a.edit(ma);
  b.edit(mb);
  expect(await settled(a, b)).toBe(true);
  await new Promise((r) => setTimeout(r, 200));
  expect(strokes(obs)).toHaveLength(1);
  expect(strokes(a)).toHaveLength(1);
  stop(a, b, obs);
});

it("undoing a move after a peer deleted the stroke leaves it deleted", async () => {
  const { a, b, obs, id, stroke } = await board();
  a.edit(moveStrokeOps(id, stroke, { x: 40, y: 40 }));
  expect(await settled(a)).toBe(true);
  expect(await until(() => strokes(b).length === 1 && strokes(b)[0]![0] !== undefined)).toBe(true);
  b.edit(strokes(b).map(([sid]) => ({ Delete: { id: sid } })));
  expect(await settled(b)).toBe(true);
  expect(await until(() => strokes(a).length === 0)).toBe(true);
  a.undo();
  expect(await settled(a, b)).toBe(true);
  await new Promise((r) => setTimeout(r, 200));
  expect(strokes(obs)).toHaveLength(0);
  stop(a, b, obs);
});
