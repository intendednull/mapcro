// A pick of another hero in a scene that holds its heroes (map-state spec D2), through the real
// replica and server: the scene's `hero` set and the old hero's build cleared in one
// transaction, for everyone; one undo brings back both; and the server refuses the row that
// says a scene holds its heroes while it is ahead of its writer, so nothing stores it yet.

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
import type { More } from "../src/gen/More";
import type { PlayerState } from "../src/gen/PlayerState";
import type { RecordId } from "../src/gen/RecordId";
import { ROWS } from "../src/gen/rows";
import { BUILD_KEYS, sceneHero } from "../src/mapstate/build";
import { holdsBuild } from "../src/mapstate/buildView";
import { pickHeroOps } from "../src/mapstate/edit";

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
const hero = (s: BoardSession, id: RecordId) => (s.records.get(id)!.record as { PlayerState: PlayerState }).PlayerState;

/** Every row of a build, as a save stores it. */
const BUILD: More = { hero: 13, items: [5, 0, -1, -1], abilities: [9, 2, 0, -1, -1], build_order: [50, 5, 0], level: 4, health: 80, pickups: [0, 0, 0, 0, 0], kills: 1, deaths: 0, assists: 2, max_health: 900 };
/** A watermark past `has_heroes`, as a build that writes it stores. */
const LATER = ROWS.has_heroes.index + 1;

async function board() {
  const api = new Api(`http://127.0.0.1:${port}`);
  const { board, owner_token } = await api.createBoard("pick");
  const open = async () => {
    const s = new BoardSession({ wsUrl: `ws://127.0.0.1:${port}/ws`, board, token: owner_token, persist: new MemoryPersist(), openSocket });
    await s.start();
    expect(await until(() => s.connection.kind === "live")).toBe(true);
    return s;
  };
  const [a, b] = [await open(), await open()];
  const scene = [...a.records].find(([, e]) => "Scene" in e.record)![0];
  const heroes = [...a.records].filter(([, e]) => !e.deleted && "PlayerState" in e.record && e.record.PlayerState.scene === scene).map(([id]) => id);
  expect(heroes).toHaveLength(12);
  return { a, b, scene, heroes };
}

it("sets the scene's hero and clears the old hero's build for everyone, in one undo step", async () => {
  const { a, b, heroes } = await board();
  const id = heroes[3]!;
  const slot = hero(a, id).slot;
  // The record as a save left it: its hero and the whole build.
  expect(a.edit(Object.entries(BUILD).map(([key, value]) => ({ Set: { id, value: { More: { key, value } } } })))).toBe(true);
  expect(await settled(a, b)).toBe(true);
  expect(await until(() => hero(b, id).more?.max_health === 900)).toBe(true);
  expect(hero(b, id).more).toEqual(BUILD);
  expect(holdsBuild(hero(b, id).more, LATER, sceneHero(true, hero(b, id).more, null), true)).toBe(true);

  const ops = pickHeroOps(true, slot, { id, more: hero(a, id).more }, 77);
  expect(ops).toHaveLength(1 + BUILD_KEYS.length);
  expect(a.edit(ops)).toBe(true);
  expect(await settled(a, b)).toBe(true);
  expect(await until(() => hero(b, id).more?.hero === 77)).toBe(true);
  // The new hero, and nothing of the old one's build; no other record touched.
  for (const s of [a, b]) {
    expect(hero(s, id).more).toEqual({ hero: 77 });
    expect(holdsBuild(hero(s, id).more, LATER, sceneHero(true, hero(s, id).more, null), true)).toBe(false);
    expect(heroes.filter((h) => h !== id).every((h) => hero(s, h).more === undefined)).toBe(true);
    // The roster is as it was.
    expect((s.records.get(slot)!.record as { RosterSlot: { hero: number | null } }).RosterSlot.hero).toBeNull();
  }
  // One step back: the first hero with its build, whole.
  a.undo();
  expect(await settled(a, b)).toBe(true);
  expect(await until(() => hero(b, id).more?.hero === 13)).toBe(true);
  for (const s of [a, b]) expect(hero(s, id).more).toEqual(BUILD);
  // And forward again.
  a.redo();
  expect(await settled(a, b)).toBe(true);
  expect(await until(() => hero(b, id).more?.hero === 77)).toBe(true);
  expect(hero(b, id).more).toEqual({ hero: 77 });
  [a, b].forEach((s) => s.stop());
});

it("the server takes the row that says a scene holds its heroes only once it is live: ahead of its writer, nothing stores it", async () => {
  const { a, b, scene } = await board();
  const state = newRecordId();
  const more = () => (s: BoardSession) => (s.records.get(state)!.record as { SceneState: { more?: More } }).SceneState.more;
  // A state as a save from before the row writes it is taken.
  expect(a.edit([{ Create: { id: state, record: { SceneState: { scene, more: { rows: ROWS.has_heroes.index, has_builds: true } } } } }])).toBe(true);
  expect(await settled(a, b)).toBe(true);
  expect(await until(() => b.records.has(state))).toBe(true);
  const before = a.problems.length;
  a.edit([{ Set: { id: state, value: { More: { key: "has_heroes", value: true } } } }]);
  if (ROWS.has_heroes.status === "ahead") {
    // Refused by the server, and gone from the one who tried.
    expect(await until(() => a.problems.length > before)).toBe(true);
    expect(a.problems.slice(before).join(" ")).toMatch(/WrongField/);
    expect(await settled(a, b)).toBe(true);
    for (const s of [a, b]) expect(more()(s)).toEqual({ rows: ROWS.has_heroes.index, has_builds: true });
  } else {
    expect(await settled(a, b)).toBe(true);
    expect(await until(() => more()(b)?.has_heroes === true)).toBe(true);
    expect(a.problems.slice(before)).toEqual([]);
  }
  [a, b].forEach((s) => s.stop());
});
