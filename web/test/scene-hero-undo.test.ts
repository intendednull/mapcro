// Undo and redo of a hero's record in a scene that holds its heroes (map-state spec §4.5,
// TD-145), through two real replicas and the real server. A record's `hero` and its build rows
// are separate keys, so an undo or redo made across another editor's pick or Retake can leave
// one hero drawn with another's build. Each sequence here is run in order, nothing raced; the
// end state is read on both editors, on a fresh copy from the server, and on a fresh copy after
// the server restarts and replays its log.

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer } from "./support/server";
import { initSync, newRecordId } from "../src/wasm/mapcro_wasm.js";
import { Api } from "../src/core/api";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import type { More } from "../src/gen/More";
import type { Op } from "../src/gen/Op";
import type { PlayerState } from "../src/gen/PlayerState";
import type { RecordId } from "../src/gen/RecordId";
import type { RosterSlot } from "../src/gen/RosterSlot";
import { BUILD_KEYS, captureBuild, captureScene, heroBuildAt } from "../src/mapstate/build";
import { pickHeroOps } from "../src/mapstate/edit";
import { retakeOps, slotKey } from "../src/match/save";
import { replay } from "./support/synthetic-match";

const ROOT = resolve(__dirname, "../..");
const ORIGIN = "http://localhost:5173";
initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

const DATA = mkdtempSync(join(tmpdir(), "mapcro-web-"));
const env = { ...process.env, DATA_DIR: DATA, PUBLIC_ORIGIN: ORIGIN, RUST_LOG: "error" };
const BIN = join(ROOT, "target/debug/mapcro-server");
let server: ChildProcess;
let port = 0;
beforeAll(async () => {
  const started = await startServer({ bin: BIN, env });
  server = started.child;
  port = started.port;
});
afterAll(() => server.kill("SIGKILL"));

/** Stop the server and start it again on the same data and port: it replays its log. */
async function restart() {
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGTERM");
  await exited;
  server = (await startServer({ bin: BIN, env, port })).child;
}

const until = async (pred: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return pred();
};
const openSocket = (url: string) => new WebSocket(url, { origin: ORIGIN }) as unknown as SocketLike;
const settled = (...ss: BoardSession[]) => until(() => ss.every((s) => s.status.kind === "saved"));
const hero = (s: BoardSession, id: RecordId) => (s.records.get(id)!.record as { PlayerState: PlayerState }).PlayerState;
const held = (s: BoardSession) => JSON.stringify([...s.records].sort(([x], [y]) => (x < y ? -1 : 1)));

/** What a replica's undo and redo stacks hold, oldest first: each entry's ops. */
type Entry = { cseq: number; inverse: Op[] };
const stacks = (s: BoardSession) => {
  const st = JSON.parse((s as unknown as { replica: { state(): string } }).replica.state()) as { undo: Entry[]; redo: Entry[] };
  return { undo: st.undo.map((e) => e.inverse), redo: st.redo.map((e) => e.inverse) };
};

const tl = replay();
const T = 4;
const SLOT = 3;
/** Two heroes no slot of the match plays. */
const P = 77;
const Q = 78;

async function saved() {
  const api = new Api(`http://127.0.0.1:${port}`);
  const { board, owner_token } = await api.createBoard("undo");
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
  const rosterOf = (s: BoardSession) => [...s.records].flatMap(([id, e]) => ("RosterSlot" in e.record ? [{ id, slot: e.record.RosterSlot as RosterSlot }] : []));
  const match = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
  const matchOf = (id: RecordId) => {
    const r = rosterOf(a).find((x) => x.id === hero(a, id).slot)!.slot;
    return match.get(slotKey(r.team === "Amber" ? "amber" : "sapphire", r.slot))!;
  };
  // As Save leaves a scene it had no room to give builds: each record its match's hero, and a
  // state that says the scene holds them. Made by someone else, so neither editor can undo it.
  const state = newRecordId();
  const more = captureScene(tl, { builds: false });
  const setup = await open();
  expect(setup.edit([
    { Create: { id: state, record: { SceneState: { scene, more } } } },
    ...heroes.map((id): Op => ({ Set: { id, value: { More: { key: "hero", value: matchOf(id).hero_id } } } })),
  ])).toBe(true);
  expect(await settled(setup)).toBe(true);
  setup.stop();
  expect(await until(() => [a, b].every((s) => s.records.has(state) && heroes.every((id) => typeof hero(s, id).more?.hero === "number")))).toBe(true);
  const id = heroes[SLOT]!;
  const row = { id: scene, scene: { name: "s", order: "a", clock: T, source: { match_id: tl.match_id, t: T, tier: "replay" } } } as never;
  const s = {
    a, b, id, heroes, open,
    M: matchOf(id).hero_id,
    /** The match hero's build at the scene's moment, `hero` included. */
    build: captureBuild(heroBuildAt(tl, matchOf(id), T)) as More,
    pick: (by: BoardSession, h: number) => expect(by.edit(pickHeroOps(true, hero(by, id).slot, { id, more: hero(by, id).more }, h))).toBe(true),
    /** Retake by `by`, on its own view; how many transactions (undo steps) it took. */
    retake: (by: BoardSession) => {
      const txs = retakeOps(row, { id: state, more: (by.records.get(state)!.record as { SceneState: { more?: More } }).SceneState.more }, heroes.map((h) => ({ id: h, state: hero(by, h) })) as never, rosterOf(by) as never, tl, newRecordId);
      for (const tx of txs) expect(by.edit(tx)).toBe(true);
      return txs.length;
    },
  };
  return s;
}
type Saved = Awaited<ReturnType<typeof saved>>;

const sync = async (s: Saved) => {
  expect(await settled(s.a, s.b)).toBe(true);
  expect(await until(() => held(s.a) === held(s.b))).toBe(true);
};
const step = async (s: Saved, f: () => void) => {
  f();
  await sync(s);
};

/** The record as both editors hold it, and as a fresh copy from the server holds it: now, and
 * after the server restarts and replays its log. */
async function everywhere(s: Saved): Promise<More | undefined> {
  const more = hero(s.a, s.id).more;
  expect(hero(s.b, s.id).more).toEqual(more);
  const fresh = await s.open();
  expect(hero(fresh, s.id).more).toEqual(more);
  fresh.stop();
  [s.a, s.b].forEach((x) => x.stop());
  await restart();
  const replayed = await s.open();
  expect(hero(replayed, s.id).more).toEqual(more);
  replayed.stop();
  return more;
}

/** The build rows a record holds. */
const rows = (more: More | undefined) => BUILD_KEYS.filter((k) => more?.[k] !== undefined);
const withoutHero = (b: More) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "hero"));

// The three sequences as they behave before the fix (TD-145): each ends with a hero that is not
// the match's holding the match hero's build.
describe("TD-145 as it is: an undo or redo across another editor's edit mixes two heroes", () => {
  it("(1) A picks P, A undoes, B Retakes, A redoes: P with the match hero's build", async () => {
    const s = await saved();
    await step(s, () => s.pick(s.a, P));
    await step(s, () => s.a.undo());
    expect(hero(s.a, s.id).more).toEqual({ hero: s.M });
    await step(s, () => s.retake(s.b));
    expect(hero(s.a, s.id).more).toEqual(s.build);
    await step(s, () => s.a.redo());
    expect(await everywhere(s)).toEqual({ ...s.build, hero: P });
  });

  it("(2) B Retakes over the match's hero, B undoes every step, A picks P, B redoes: P with the match hero's build", async () => {
    const s = await saved();
    let n = 0;
    await step(s, () => (n = s.retake(s.b)));
    expect(hero(s.a, s.id).more).toEqual(s.build);
    for (let i = 0; i < n; i++) await step(s, () => s.b.undo());
    expect(hero(s.a, s.id).more).toEqual({ hero: s.M });
    // The Retake's `Set hero` wrote the hero the record already had, so it left no undo: the
    // redo is only the rows' `SetIf null -> value`.
    expect(stacks(s.b).redo.flat().filter((o) => "SetIf" in o && o.SetIf.id === s.id && "More" in o.SetIf.value && o.SetIf.value.More.key === "hero")).toEqual([]);
    await step(s, () => s.pick(s.a, P));
    for (let i = 0; i < n; i++) await step(s, () => s.b.redo());
    expect(await everywhere(s)).toEqual({ ...s.build, hero: P });
  });

  it("(3) A picks P over the match's hero with its build, B picks Q, A undoes: Q with the match hero's build", async () => {
    const s = await saved();
    // The record as a save with room for builds leaves it, made by someone else.
    const setup = await s.open();
    expect(setup.edit(Object.entries(withoutHero(s.build)).map(([key, value]): Op => ({ Set: { id: s.id, value: { More: { key, value } } } })))).toBe(true);
    expect(await settled(setup)).toBe(true);
    setup.stop();
    expect(await until(() => rows(hero(s.a, s.id).more).length > 0 && rows(hero(s.b, s.id).more).length > 0)).toBe(true);
    await sync(s);
    expect(hero(s.a, s.id).more).toEqual(s.build);
    await step(s, () => s.pick(s.a, P));
    await step(s, () => s.pick(s.b, Q));
    await step(s, () => s.a.undo());
    expect(await everywhere(s)).toEqual({ ...s.build, hero: Q });
  });
});
