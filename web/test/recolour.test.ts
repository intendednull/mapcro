// A placed thing recoloured, and a comment moved to a side, after it was placed (feedback #59,
// #60), against the real server: one write each, seen by everyone, and undone by one undo.
// What the server as built takes (store v11's three `Ahead` statuses are `Live` from the writer).

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
import { recolourOps, sideOps } from "../src/board/placed";
import type { Record as Rec } from "../src/gen/Record";
import type { RecordId } from "../src/gen/RecordId";
import { LIMITS } from "../src/gen/limits";

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
const settled = (...ss: BoardSession[]) => until(() => ss.every((s) => s.status.kind === "saved"));
const body = <K extends string>(s: BoardSession, id: RecordId, kind: K) => {
  const e = s.records.get(id);
  return e && !e.deleted && kind in e.record ? ((e.record as Record<string, unknown>)[kind] as Record<string, unknown>) : undefined;
};

/** An editor and a watcher on a board with an arrow, a comment and a stroke, each colour 1. */
async function board() {
  const api = new Api(`http://127.0.0.1:${port}`);
  const { board, owner_token } = await api.createBoard("recolour");
  const open = async () => {
    const s = new BoardSession({ wsUrl: `ws://127.0.0.1:${port}/ws`, board, token: owner_token, persist: new MemoryPersist(), openSocket });
    await s.start();
    expect(await until(() => s.connection.kind === "live")).toBe(true);
    return s;
  };
  const [a, b] = [await open(), await open()];
  const scene = [...a.records].find(([, e]) => "Scene" in e.record)![0];
  const ids = { Arrow: newRecordId(), Callout: newRecordId(), Stroke: newRecordId() };
  const records: Array<[RecordId, Rec]> = [
    [ids.Arrow, { Arrow: { scene, from: { x: 0, y: 0 }, to: { x: 90, y: 90 }, team: null, color: 1 } }],
    [ids.Callout, { Callout: { scene, pos: { x: 10, y: 10 }, text: "smoke", color: 1 } }],
    [ids.Stroke, { Stroke: { scene, points: [{ x: 0, y: 0 }, { x: 40, y: 20 }], color: 1, width: 30 } }],
  ];
  a.edit(records.map(([id, record]) => ({ Create: { id, record } })));
  expect(await until(() => Object.entries(ids).every(([k, id]) => body(b, id, k) !== undefined))).toBe(true);
  return { a, b, ids, scene };
}

it("an arrow, a comment and a stroke are recoloured, seen by the other, and one undo puts each back", async () => {
  const { a, b, ids } = await board();
  for (const kind of ["Arrow", "Callout", "Stroke"] as const) {
    const ops = recolourOps(kind, ids[kind], 1, 5);
    expect(ops).toHaveLength(1);
    a.edit(ops);
    expect(await settled(a)).toBe(true);
    expect(await until(() => body(b, ids[kind], kind)?.color === 5)).toBe(true);
    a.undo();
    expect(await settled(a)).toBe(true);
    expect(await until(() => body(b, ids[kind], kind)?.color === 1)).toBe(true);
    // The colour it has already: nothing to send.
    expect(recolourOps(kind, ids[kind], 1, 1)).toEqual([]);
  }
  expect(a.status.kind).toBe("saved");
  [a, b].forEach((s) => s.stop());
});

it("a comment and an arrow go back to no colour, seen by the other, and one undo puts the colour back; a stroke has none", async () => {
  const { a, b, ids } = await board();
  for (const kind of ["Arrow", "Callout"] as const) {
    const ops = recolourOps(kind, ids[kind], 1, null);
    expect(ops).toHaveLength(1);
    a.edit(ops);
    expect(await settled(a)).toBe(true);
    expect(await until(() => body(b, ids[kind], kind) !== undefined && body(b, ids[kind], kind)!.color == null)).toBe(true);
    // No colour already: nothing to send, stored as null or as before colours (absent).
    expect(recolourOps(kind, ids[kind], null, null)).toEqual([]);
    expect(recolourOps(kind, ids[kind], undefined, null)).toEqual([]);
    a.undo();
    expect(await settled(a)).toBe(true);
    expect(await until(() => body(b, ids[kind], kind)?.color === 1)).toBe(true);
  }
  // A stroke's ink always has a colour.
  expect(recolourOps("Stroke", ids.Stroke, 1, null)).toEqual([]);
  expect(a.status.kind).toBe("saved");
  [a, b].forEach((s) => s.stop());
});

it("a comment moves to each side and back above, where it's stored as before sides", async () => {
  const { a, b, ids } = await board();
  const id = ids.Callout;
  const side = (s: BoardSession) => body(s, id, "Callout")?.side ?? "Above";
  expect(sideOps(id, undefined, "Above")).toEqual([]);
  for (const to of ["Left", "Below", "Right", "Above"] as const) {
    a.edit(sideOps(id, side(a) as never, to));
    expect(await settled(a)).toBe(true);
    expect(await until(() => side(b) === to)).toBe(true);
  }
  expect(body(b, id, "Callout")).not.toHaveProperty("side");
  a.undo();
  expect(await settled(a)).toBe(true);
  expect(await until(() => side(b) === "Right")).toBe(true);
  [a, b].forEach((s) => s.stop());
});

it("a scene name takes 48 characters (feedback #56); a hero's seat name stays at 24", async () => {
  const { a, b, scene } = await board();
  const name = "é".repeat(LIMITS.max_scene_name);
  a.edit([{ Set: { id: scene, value: { SceneName: name } } }]);
  expect(await settled(a)).toBe(true);
  expect(await until(() => body(b, scene, "Scene")?.name === name)).toBe(true);
  expect(LIMITS.max_name).toBe(24);
  [a, b].forEach((s) => s.stop());
});
