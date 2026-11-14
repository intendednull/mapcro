// Duplicating a scene, through the real replica and server (review F1 of e878c30, feedback
// #54). A copy over a transaction's bytes used to be sent one op at a time: the first
// transaction held the scene with fewer than twelve heroes, the board refused it
// (`IncompleteScene`) and nothing was made. And a copy left the scene's ink behind.

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
import { addSceneOps, sendScene, type SceneRow } from "../src/board/scenes";
import type { BoardState } from "../src/board/state";
import { flatten } from "../src/board/tree";
import type { Entry } from "../src/gen/Entry";
import { LIMITS } from "../src/gen/limits";
import type { Op } from "../src/gen/Op";
import type { Record as Rec } from "../src/gen/Record";
import type { RecordId } from "../src/gen/RecordId";
import { opsBytes } from "../src/match/save";

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

/** The session's records as the board state `addSceneOps` reads. */
const stateOf = (s: BoardSession) => {
  const records: { [id: string]: Entry } = Object.fromEntries(s.records);
  const rows: SceneRow[] = [...s.records].flatMap(([id, e]) => (!e.deleted && "Scene" in e.record ? [{ id, scene: e.record.Scene }] : []));
  const tree = flatten(rows.map((r) => ({ id: r.id, order: r.scene.order, parent: r.scene.parent ?? null, row: r }))).map((t) => ({ scene: t.scene.row, depth: t.depth, parent: t.parent, hasChildren: t.hasChildren }));
  return { records, sceneTree: () => tree, scenes: () => tree.map((t) => t.scene) } as unknown as BoardState;
};
/** The live records of `scene`, by kind, without their ids and scene. */
const inScene = (s: BoardSession, scene: RecordId) => {
  const out: { [kind: string]: unknown[] } = {};
  for (const [, e] of s.records) {
    if (e.deleted) continue;
    const [kind, body] = Object.entries(e.record)[0] as [string, { scene?: RecordId }];
    if (body.scene !== scene) continue;
    const { scene: _, ...rest } = body;
    (out[kind] ??= []).push(rest);
  }
  for (const list of Object.values(out)) list.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return out;
};
const heroesOf = (s: BoardSession, scene: RecordId) => [...s.records].filter(([, e]) => !e.deleted && "PlayerState" in e.record && e.record.PlayerState.scene === scene);

/** Two sessions on a new board whose scene holds ink, a note and (if `big`) a snapshot with
 * every hero's `more` near the record's cap: twelve of them are over one transaction. */
async function board(big: boolean) {
  const api = new Api(`http://127.0.0.1:${port}`);
  const { board, owner_token } = await api.createBoard("copy");
  const open = async () => {
    const s = new BoardSession({ wsUrl: `ws://127.0.0.1:${port}/ws`, board, token: owner_token, persist: new MemoryPersist(), openSocket });
    await s.start();
    expect(await until(() => s.connection.kind === "live")).toBe(true);
    return s;
  };
  const [a, b] = [await open(), await open()];
  const scene = [...a.records].find(([, e]) => "Scene" in e.record)![0];
  const make = (record: Rec): Op => ({ Create: { id: newRecordId(), record } });
  expect(
    a.edit([
      make({ Arrow: { scene, from: { x: 10, y: 20 }, to: { x: 300, y: 400 }, team: "Amber", color: 2 } }),
      make({ Callout: { scene, pos: { x: 50, y: 60 }, text: "rotate", color: null } }),
      make({ Stroke: { scene, points: [{ x: 0, y: 0 }, { x: 100, y: 50 }], color: 1, width: 30 } }),
      make({ Note: { scene, text: "the plan" } }),
    ]),
  ).toBe(true);
  if (big) {
    const heroes = heroesOf(a, scene);
    expect(heroes).toHaveLength(12);
    heroes.forEach(([id], n) => {
      const order = Array.from({ length: 600 }, (_, i) => 4_000_000_000 + i + n);
      expect(a.edit([{ Set: { id, value: { More: { key: "build_order", value: order } } } }, { Set: { id, value: { More: { key: "level", value: n + 1 } } } }])).toBe(true);
    });
    expect(a.edit([make({ SceneState: { scene, more: { rows: 15, has_builds: true, build: 6839 } } })])).toBe(true);
  }
  expect(await settled(a, b)).toBe(true);
  return { a, b, scene, row: { id: scene, scene: (a.records.get(scene)!.record as { Scene: SceneRow["scene"] }).Scene } };
}

it("a copy takes the scene's arrows, callouts, ink and note (#54), in one undo step", async () => {
  const { a, b, scene, row } = await board(false);
  const { id, txs } = addSceneOps(stateOf(a), row, false, undefined, "", true);
  expect(txs).toHaveLength(1);
  expect(sendScene(txs, (tx) => a.edit(tx))).toBe(true);
  expect(await settled(a)).toBe(true);
  expect(await until(() => b.records.has(id) && heroesOf(b, id).length === 12)).toBe(true);
  const copy = inScene(b, id);
  expect(Object.keys(copy).sort()).toEqual(["Arrow", "Callout", "Note", "PlayerState", "Stroke"]);
  expect(copy).toEqual(inScene(b, scene));
  // One step: an undo takes the whole copy away again.
  a.undo();
  expect(await settled(a)).toBe(true);
  expect(await until(() => b.records.get(id)?.deleted === true)).toBe(true);
  [a, b].forEach((s) => s.stop());
});

it("a copy over one transaction makes the scene with all its heroes first, then their builds", async () => {
  const { a, b, scene, row } = await board(true);
  const { id, ops, txs } = addSceneOps(stateOf(a), row, false, undefined, "", true);
  expect(opsBytes(ops)).toBeGreaterThan(LIMITS.max_tx_bytes);
  expect(txs.length).toBeGreaterThan(1);
  // What the old split sent first, the scene with one hero, is refused by the replica.
  expect(a.edit(ops.slice(0, 2))).toBe(false);
  expect(a.records.has(id)).toBe(false);
  // Every transaction is taken, by the replica and then by the server.
  const sent: boolean[] = [];
  expect(sendScene(txs, (tx) => (sent.push(a.edit(tx)), sent.at(-1)!))).toBe(true);
  expect(sent).toEqual(txs.map(() => true));
  expect(await settled(a)).toBe(true);
  expect(await until(() => [...b.records].some(([, e]) => !e.deleted && "SceneState" in e.record && e.record.SceneState.scene === id))).toBe(true);
  const copy = inScene(b, id);
  expect(copy.PlayerState).toHaveLength(12);
  expect((copy.PlayerState as { more: { build_order: number[] } }[]).every((h) => h.more.build_order.length === 600)).toBe(true);
  expect(copy.SceneState).toEqual([{ more: { rows: 15, has_builds: true, build: 6839 } }]);
  expect(copy).toEqual(inScene(b, scene));
  [a, b].forEach((s) => s.stop());
});

it("a copy the board has room to start but not to finish makes nothing (review F1 of RC1)", async () => {
  const { a, b, scene, row } = await board(false);
  const make = (record: Rec): Op => ({ Create: { id: newRecordId(), record } });
  const stroke = (in_: RecordId, i: number) => make({ Stroke: { scene: in_, points: [{ x: i, y: 0 }, { x: i, y: 9 }], color: 1, width: 30 } });
  const fill = (in_: RecordId, n: number) => {
    for (let i = 0; i < n; i += 200) expect(a.edit(Array.from({ length: Math.min(200, n - i) }, (_, k) => stroke(in_, i + k)))).toBe(true);
  };
  // A second scene with 300 strokes: its copy is 313 records, over one transaction's 256 ops.
  const second = addSceneOps(stateOf(a), row, false);
  expect(sendScene(second.txs, (tx) => a.edit(tx))).toBe(true);
  fill(second.id, 300);
  // The board filled to 60 records short of its cap, some of them deleted (they count).
  const short = 60;
  fill(scene, LIMITS.max_records - short - a.records.size);
  const some = [...a.records].filter(([, e]) => "Stroke" in e.record && e.record.Stroke.scene === scene).slice(0, 40).map(([id]): Op => ({ Delete: { id } }));
  expect(a.edit(some)).toBe(true);
  expect(a.records.size).toBe(LIMITS.max_records - short);
  expect(await settled(a)).toBe(true);
  const from = { id: second.id, scene: (a.records.get(second.id)!.record as { Scene: SceneRow["scene"] }).Scene };
  const copy = addSceneOps(stateOf(a), from, false, undefined, "", true);
  expect(copy.ops).toHaveLength(313);
  // Nothing to send, and nothing made: the caller stays on its scene.
  expect([copy.full, copy.txs]).toEqual([true, []]);
  const sent: Op[][] = [];
  expect(sendScene(copy.txs, (tx) => (sent.push(tx), a.edit(tx)))).toBe(false);
  expect(sent).toEqual([]);
  expect(a.records.has(copy.id)).toBe(false);
  expect(a.records.size).toBe(LIMITS.max_records - short);
  // What it prevents: the copy's first transaction (the scene and its heroes) has room and is
  // taken; a later one is refused, and the board is left with part of the scene.
  expect(a.edit(copy.ops.slice(0, 13))).toBe(true);
  expect(a.records.has(copy.id)).toBe(true);
  expect(a.edit(copy.ops.slice(13, 13 + 40))).toBe(true);
  expect(a.edit(copy.ops.slice(53, 53 + 40))).toBe(false);
  expect(await settled(a)).toBe(true);
  expect(await until(() => b.records.has(copy.id))).toBe(true);
  expect((inScene(b, copy.id).Stroke ?? []).length).toBe(40);
  [a, b].forEach((s) => s.stop());
});
