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
import { BoardReplica, initSync, newRecordId } from "../src/wasm/mapcro_wasm.js";
import { Api } from "../src/core/api";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import type { More } from "../src/gen/More";
import type { Op } from "../src/gen/Op";
import type { PlayerState } from "../src/gen/PlayerState";
import type { RecordId } from "../src/gen/RecordId";
import type { RosterSlot } from "../src/gen/RosterSlot";
import { BUILD_KEYS, captureBuild, captureScene, heroBuildAt } from "../src/mapstate/build";
import { encodeCC } from "../src/mapstate/codec";
import { pickHeroOps } from "../src/mapstate/edit";
import { secondPart, tenthPart } from "../src/mapstate/frame";
import { decideStep } from "../src/mapstate/undo";
import type { Entry as RecordEntry } from "../src/gen/Entry";
import { matchSceneOps, retakeOps, slotKey, sourceOf } from "../src/match/save";
import { keyBetween } from "../src/core/order";
import type { Tx } from "../src/gen/Tx";
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

async function saved(sockets: Array<(url: string) => SocketLike> = [], own = true) {
  const api = new Api(`http://127.0.0.1:${port}`);
  const { board, owner_token } = await api.createBoard("undo");
  let opened = 0;
  const persists = new Map<BoardSession, MemoryPersist>();
  const open = async () => {
    const persist = new MemoryPersist();
    const s = new BoardSession({ wsUrl: `ws://127.0.0.1:${port}/ws`, board, token: owner_token, persist, openSocket: sockets[opened++] ?? openSocket });
    persists.set(s, persist);
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
  const more = captureScene(tl, { builds: false, heroes: own });
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
  const pl = matchOf(id);
  const idx = tl.players.indexOf(pl);
  const sec = secondPart(tl, T, []);
  const ten = tenthPart(tl, T);
  const groupA: More = {};
  if (ten.sight[idx] !== true) groupA.unseen = true;
  const cc = encodeCC(ten.cc[idx]);
  if (cc !== undefined) groupA.cc = cc;
  const mv = sec.movement[idx];
  if (mv?.height === 1 || mv?.height === 2) groupA.height = mv.height;
  if (mv?.zipline) groupA.zipline = true;
  expect(Object.keys(groupA).length).toBeGreaterThan(0);
  const build = captureBuild(heroBuildAt(tl, pl, T)) as More;
  const s = {
    a, b, id, heroes, open, scene, state, rosterOf,
    /** What `x` saved of its replica's state, once its saves are done. */
    stored: async (x: BoardSession) => {
      await (x as unknown as { saves: Promise<void> }).saves;
      return JSON.parse(persists.get(x)!.data.get(board)!) as { undo: Entry[]; redo: Entry[] };
    },
    M: pl.hero_id,
    /** The match hero's build at the scene's moment, `hero` included. */
    build,
    /** Group A hero rows at the scene's moment (outside `BUILD_KEYS`, kept on pick per plan §6). */
    groupA,
    /** Build + Group A as Retake/Save leave the slot in R2. */
    retaken: { ...build, ...groupA } as More,
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
async function everywhere(s: Saved, id: RecordId = s.id): Promise<More | undefined> {
  const more = hero(s.a, id).more;
  expect(hero(s.b, id).more).toEqual(more);
  // A fresh copy is live before it has caught up: wait on the record itself.
  const holds = (x: BoardSession) => until(() => x.records.has(id) && JSON.stringify(hero(x, id).more) === JSON.stringify(more));
  const fresh = await s.open();
  await holds(fresh);
  expect(hero(fresh, id).more).toEqual(more);
  fresh.stop();
  [s.a, s.b].forEach((x) => x.stop());
  await restart();
  const replayed = await s.open();
  await holds(replayed);
  expect(hero(replayed, id).more).toEqual(more);
  replayed.stop();
  return more;
}

/** The build rows a record holds. */
const rows = (more: More | undefined) => BUILD_KEYS.filter((k) => more?.[k] !== undefined);
const withoutHero = (b: More) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "hero"));

const buildOnly = (more: More | undefined) =>
  more ? Object.fromEntries(Object.entries(more).filter(([k]) => k === "hero" || BUILD_KEYS.includes(k as never))) : undefined;
/** Whatever happened: a record that holds a build holds the match hero's, whole. */
function coherent(s: Saved, more: More | undefined) {
  if (more?.hero !== s.M) expect(rows(more)).toEqual([]);
  else if (rows(more).length) expect(buildOnly(more)).toEqual(s.build);
}
const heroOf = (o: Op) => ("SetIf" in o && "More" in o.SetIf.value && o.SetIf.value.More.key === "hero" ? o.SetIf : undefined);
/** A stack's build/hero steps for the record: each as its hero write (`h -> h` an assertion)
 * and the build rows it writes, `null` for a clear (Group A rows live outside `slotKeys`). */
const steps = (s: Saved, st: Op[][]) =>
  st
    .map((e) =>
      e.filter(
        (o) =>
          ("SetIf" in o ? o.SetIf.id : "Set" in o ? o.Set.id : undefined) === s.id &&
          (("SetIf" in o && "More" in o.SetIf.value && (o.SetIf.value.More.key === "hero" || BUILD_KEYS.includes(o.SetIf.value.More.key as never))) ||
            ("Set" in o && "More" in o.Set.value && (o.Set.value.More.key === "hero" || BUILD_KEYS.includes(o.Set.value.More.key as never)))),
      ),
    )
    .filter((e) => e.length)
    .map((e) => {
      const h = e.map(heroOf).find(Boolean);
      const fill = e.flatMap((o) => ("SetIf" in o && "More" in o.SetIf.value && BUILD_KEYS.includes(o.SetIf.value.More.key as never) ? [o.SetIf.value.More.value === null ? "clear" : "fill"] : []));
      return { hero: h && [h.expect, h.value].map((v) => ("More" in v ? v.More.value : v)), rows: [...new Set(fill)] };
    });
/** The record as a save with room for builds leaves it, made by someone else. */
async function withBuild(s: Saved) {
  const setup = await s.open();
  expect(setup.edit(Object.entries(withoutHero(s.build)).map(([key, value]): Op => ({ Set: { id: s.id, value: { More: { key, value } } } })))).toBe(true);
  expect(await settled(setup)).toBe(true);
  setup.stop();
  expect(await until(() => [s.a, s.b].every((x) => rows(hero(x, s.id).more).length > 0))).toBe(true);
  await sync(s);
  expect(hero(s.a, s.id).more).toEqual(s.build);
}

// The three sequences of TD-145, in order, nothing raced. Before the fix each ended with a hero
// that isn't the match's holding the match hero's build (commit "TD-145's three undo and redo
// sequences, as they behave today"): now the step that no longer fits leaves the record whole.
describe("an undo or redo across another editor's pick or Retake leaves a hero with its own build", () => {
  it("(1) A picks P, A undoes, B Retakes, A redoes: P with no build; A's undo then gives back the match hero with its build", async () => {
    const s = await saved();
    await step(s, () => s.pick(s.a, P));
    await step(s, () => s.a.undo());
    expect(hero(s.a, s.id).more).toEqual({ hero: s.M });
    expect(steps(s, stacks(s.a).redo)).toEqual([{ hero: [s.M, P], rows: [] }]);
    await step(s, () => s.retake(s.b));
    expect(hero(s.a, s.id).more).toEqual(s.retaken);
    await step(s, () => s.a.redo());
    expect(hero(s.a, s.id).more).toEqual({ hero: P, ...s.groupA });
    // The redo wrote the record's slot whole, so its undo gives back what it replaced, whole (Group A untouched).
    expect(steps(s, stacks(s.a).undo)).toEqual([{ hero: [P, s.M], rows: ["fill"] }]);
    expect(stacks(s.a).redo).toEqual([]);
    await step(s, () => s.a.undo());
    expect(hero(s.a, s.id).more).toEqual(s.retaken);
    await step(s, () => s.a.redo());
    expect(await everywhere(s)).toEqual({ hero: P, ...s.groupA });
  });

  it("(2) B Retakes over the match's hero, B undoes every step, A picks P, B redoes: P with no build (Group A applied & undoable)", async () => {
    const s = await saved();
    let n = 0;
    await step(s, () => (n = s.retake(s.b)));
    expect(hero(s.a, s.id).more).toEqual(s.retaken);
    // The Retake's `Set hero` wrote the hero the record already had, so its undo has none.
    expect(steps(s, stacks(s.b).undo)).toEqual([{ hero: undefined, rows: ["clear"] }]);
    for (let i = 0; i < n; i++) await step(s, () => s.b.undo());
    expect(hero(s.a, s.id).more).toEqual({ hero: s.M });
    // The redo carries the hero it was made on.
    expect(steps(s, stacks(s.b).redo)).toEqual([{ hero: [s.M, s.M], rows: ["fill"] }]);
    await step(s, () => s.pick(s.a, P));
    for (let i = 0; i < n; i++) await step(s, () => s.b.redo());
    // The build redo no longer fits the record, and left it out: nothing of its build to undo there,
    // while Group A ops (outside `slotKeys`, plan §6) went through as recorded.
    expect(steps(s, stacks(s.b).undo)).toEqual([]);
    expect(stacks(s.b).redo).toEqual([]);
    // The other eleven took their builds back.
    for (const h of s.heroes.filter((x) => x !== s.id)) expect(rows(hero(s.b, h).more).length).toBeGreaterThan(0);
    expect(await everywhere(s)).toEqual({ hero: P, ...s.groupA });
  });

  it("(3) A picks P over the match's hero with its build, B picks Q, A undoes: Q with no build", async () => {
    const s = await saved();
    await withBuild(s);
    await step(s, () => s.pick(s.a, P));
    expect(steps(s, stacks(s.a).undo)).toEqual([{ hero: [P, s.M], rows: ["fill"] }]);
    await step(s, () => s.pick(s.b, Q));
    // A's state as saved holds its pick's step...
    const end = Date.now() + 10_000;
    while ((await s.stored(s.a)).undo.length !== 1 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect((await s.stored(s.a)).undo).toHaveLength(1);
    const sentBefore = s.a.records.size;
    s.a.undo();
    // ...and the dropped step is saved as gone at once: no reload brings it back.
    expect(await s.stored(s.a)).toMatchObject({ undo: [], redo: [] });
    await sync(s);
    // The step touched this record alone: dropped whole, nothing sent, nothing left to redo.
    expect(s.a.records.size).toBe(sentBefore);
    expect(stacks(s.a)).toEqual({ undo: [], redo: [] });
    expect(s.a.canUndo).toBe(false);
    // B's own undo still gives back what B's pick replaced: P, with no build.
    await step(s, () => s.b.undo());
    expect(hero(s.a, s.id).more).toEqual({ hero: P });
    await step(s, () => s.b.redo());
    expect(await everywhere(s)).toEqual({ hero: Q });
  });

  it("the undo of a pick, with no one else's edit between, gives back the old hero with its build, as before", async () => {
    const s = await saved();
    await withBuild(s);
    await step(s, () => s.pick(s.a, P));
    await step(s, () => s.a.undo());
    expect(hero(s.b, s.id).more).toEqual(s.build);
    await step(s, () => s.a.redo());
    expect(hero(s.b, s.id).more).toEqual({ hero: P });
    await step(s, () => s.a.undo());
    expect(await everywhere(s)).toEqual(s.build);
  });

  it("a Retake's undo and redo, with no one else's edit between, as before", async () => {
    const s = await saved();
    let n = 0;
    await step(s, () => (n = s.retake(s.b)));
    for (let i = 0; i < n; i++) await step(s, () => s.b.undo());
    expect(hero(s.a, s.id).more).toEqual({ hero: s.M });
    for (let i = 0; i < n; i++) await step(s, () => s.b.redo());
    expect(hero(s.a, s.id).more).toEqual(s.retaken);
    for (let i = 0; i < n; i++) await step(s, () => s.b.undo());
    expect(await everywhere(s)).toEqual({ hero: s.M });
  });

  it("Group A Retake over a scene that already holds builds: racing a pick keeps P + Group A, and undoing Retake reverts Group A + SceneState cleanly", async () => {
    const s = await saved();
    await withBuild(s);
    // Mark builds already captured so Retake writes Group A + SceneState alone (one atomic tx).
    const setup = await s.open();
    expect(setup.edit([{ Set: { id: s.state, value: { More: { key: "has_builds", value: true } } } }])).toBe(true);
    expect(await settled(setup)).toBe(true);
    setup.stop();
    await sync(s);

    // A picks P (clears builds), then B Retakes (adds Group A + SceneState flags, skips builds on P).
    await step(s, () => s.pick(s.a, P));
    expect(hero(s.a, s.id).more).toEqual({ hero: P });
    let n = 0;
    await step(s, () => (n = s.retake(s.b)));
    expect(n).toBe(1);
    expect(hero(s.a, s.id).more).toEqual({ hero: P, ...s.groupA });
    const stateMore = (x: BoardSession) => (x.records.get(s.state)!.record as { SceneState: { more?: More } }).SceneState.more;
    expect(stateMore(s.a)?.has_movement).toBe(true);
    expect(stateMore(s.a)?.has_sight).toBe(true);

    // B undoes the Group A Retake: Group A rows and SceneState flags revert together while P stays P.
    await step(s, () => s.b.undo());
    expect(stateMore(s.a)?.has_movement).toBeUndefined();
    expect(stateMore(s.a)?.has_sight).toBeUndefined();
    expect(await everywhere(s)).toEqual({ hero: P });
  });
});

// A deleted scene's hero records are not deleted with it (they live and die with their scene,
// hidden while it is): an undo or redo still writes them, and restoring the scene shows what it
// wrote. Each sequence here mixed two heroes before the fix's review B1, with no race.
describe("an undo or redo of a hero's record in a deleted scene: what a restore shows is whole", () => {
  /** Another scene, made by `by` as New scene makes one: the scene and a hero per slot. */
  async function another(s: Saved, by: BoardSession) {
    const id = newRecordId();
    const order = (by.records.get(s.scene)!.record as { Scene: { order: string } }).Scene.order;
    const heroes = s.heroes.map((h): Op => {
      const { more: _, ...fields } = hero(by, h);
      return { Create: { id: newRecordId(), record: { PlayerState: { ...fields, scene: id } } } };
    });
    await step(s, () => expect(by.edit([{ Create: { id, record: { Scene: { name: "", order: keyBetween(order, undefined), clock: null } } as never } }, ...heroes])).toBe(true));
    return id;
  }
  const deleteScene = (s: Saved, by: BoardSession, scene: RecordId) => step(s, () => expect(by.edit([{ Delete: { id: scene } }])).toBe(true));
  const gone = (s: Saved, scene: RecordId) => (s.a.records.get(scene)!.deleted);

  it("(B1.1) A picks P over the match's hero with its build, B picks Q, B deletes the scene, A undoes, B restores it: Q with no build", async () => {
    const s = await saved();
    await withBuild(s);
    await step(s, () => s.pick(s.a, P));
    await step(s, () => s.pick(s.b, Q));
    await another(s, s.b);
    await deleteScene(s, s.b, s.scene);
    expect(gone(s, s.scene)).toBe(true);
    await step(s, () => s.a.undo());
    // While the scene is gone the record holds what a restore will show.
    expect(hero(s.a, s.id).more).toEqual({ hero: Q });
    await step(s, () => s.b.undo());
    expect(gone(s, s.scene)).toBe(false);
    expect(await everywhere(s)).toEqual({ hero: Q });
  });

  it("(B1.2) A picks P, A undoes, B Retakes, B deletes the scene, A redoes, B restores it: P with no build (Group A kept)", async () => {
    const s = await saved();
    await step(s, () => s.pick(s.a, P));
    await step(s, () => s.a.undo());
    await step(s, () => s.retake(s.b));
    expect(hero(s.a, s.id).more).toEqual(s.retaken);
    await another(s, s.b);
    await deleteScene(s, s.b, s.scene);
    await step(s, () => s.a.redo());
    await step(s, () => s.b.undo());
    expect(gone(s, s.scene)).toBe(false);
    expect(await everywhere(s)).toEqual({ hero: P, ...s.groupA });
  });

  it("(B1.3) B saves a scene, A picks P in it, C picks Q, B undoes the save, A undoes, B redoes the save: Q with no build (Group A kept)", async () => {
    const s = await saved();
    const scenes = [...s.b.records].flatMap(([id, e]) => (!e.deleted && "Scene" in e.record ? [{ id, scene: e.record.Scene }] : [])) as never;
    const save = matchSceneOps(s.rosterOf(s.b) as never, scenes, undefined, tl, T, [], newRecordId, [], { source: sourceOf(tl) });
    expect(save.builds).toBe(true);
    await step(s, () => expect(s.b.edit(save.ops)).toBe(true));
    const slot = hero(s.a, s.id).slot;
    const id = [...s.a.records].find(([, e]) => "PlayerState" in e.record && e.record.PlayerState.scene === save.id && e.record.PlayerState.slot === slot)![0];
    const saved_ = hero(s.a, id).more!;
    expect(saved_.hero).toBe(s.M);
    expect(rows(saved_).length).toBeGreaterThan(0);
    const c = await s.open();
    expect(await until(() => c.records.has(id))).toBe(true);
    await step(s, () => expect(s.a.edit(pickHeroOps(true, slot, { id, more: hero(s.a, id).more }, P))).toBe(true));
    expect(await until(() => c.records.get(id) !== undefined && hero(c, id).more?.hero === P)).toBe(true);
    expect(c.edit(pickHeroOps(true, slot, { id, more: hero(c, id).more }, Q))).toBe(true);
    expect(await settled(c)).toBe(true);
    await sync(s);
    expect(hero(s.a, id).more).toEqual({ hero: Q, ...s.groupA });
    c.stop();
    await step(s, () => s.b.undo());
    expect(gone(s, save.id)).toBe(true);
    await step(s, () => s.a.undo());
    await step(s, () => s.b.redo());
    expect(gone(s, save.id)).toBe(false);
    expect(await everywhere(s, id)).toEqual({ hero: Q, ...s.groupA });
  });
});

/** A socket whose traffic the test can hold back in both directions (as scene-hero-pick's). */
function heldSocket() {
  let held = false;
  const out: unknown[] = [];
  const back: unknown[] = [];
  let sock: Record<string, unknown> | undefined;
  let raw: WebSocket | undefined;
  const open = (url: string) => {
    const w = new WebSocket(url, { origin: ORIGIN });
    raw = w;
    const s: Record<string, unknown> = { send: (d: never) => (held ? out.push(d) : w.send(d)), close: () => w.close(), onopen: null, onmessage: null, onclose: null, onerror: null };
    w.onopen = () => (s.onopen as (() => void) | null)?.();
    w.onclose = () => (s.onclose as (() => void) | null)?.();
    w.onerror = (e) => (s.onerror as ((e: unknown) => void) | null)?.(e);
    w.onmessage = (e) => (held ? back.push(e) : (s.onmessage as ((e: unknown) => void) | null)?.(e));
    sock = s;
    return s as unknown as SocketLike;
  };
  return {
    open,
    hold: () => { held = true; },
    release: () => {
      held = false;
      for (const d of out.splice(0)) raw!.send(d as never);
      for (const e of back.splice(0)) (sock!.onmessage as (e: unknown) => void)(e);
    },
  };
}

// The same sequences with the last two edits made at the same moment, each on a view that
// doesn't hold the other: the server takes them in one order or the other, and the slot ends
// as the later of the two left it, whole (spec §4.5). An undo that lands just after another
// editor's pick takes the slot back; that is the cost of never mixing two heroes.
describe("an undo or redo racing another editor's pick or Retake: the later one decides the slot, whole", () => {
  type Held = Saved & { ga: ReturnType<typeof heldSocket>; gb: ReturnType<typeof heldSocket> };
  async function heldSaved(): Promise<Held> {
    const [ga, gb] = [heldSocket(), heldSocket()];
    return { ...(await saved([ga.open, gb.open])), ga, gb };
  }
  interface Case {
    name: string;
    /** Whose undo or redo it is: "a" or "b"; the other makes the pick or the Retake. */
    mine: "a" | "b";
    setup: (s: Held) => Promise<void>;
    undoing: (s: Held) => void;
    other: (s: Held) => void;
    /** The record when the undo or redo is decided last, and when the other edit is. */
    mineLast: (s: Held) => More;
    otherLast: (s: Held) => More;
  }
  const cases: Case[] = [
    {
      name: "(1) A's redo of its pick, B's Retake",
      mine: "a",
      setup: async (s) => { await step(s, () => s.pick(s.a, P)); await step(s, () => s.a.undo()); },
      undoing: (s) => s.a.redo(),
      other: (s) => void s.retake(s.b),
      mineLast: (s) => ({ hero: P, ...s.groupA }),
      otherLast: (s) => s.retaken,
    },
    {
      name: "(2) B's redo of its Retake, A's pick of P",
      mine: "b",
      setup: async (s) => { const n = s.retake(s.b); await sync(s); for (let i = 0; i < n; i++) await step(s, () => s.b.undo()); },
      undoing: (s) => { while (s.b.canRedo) s.b.redo(); },
      other: (s) => s.pick(s.a, P),
      mineLast: (s) => s.retaken,
      otherLast: (s) => ({ hero: P, ...s.groupA }),
    },
    {
      name: "(3) A's undo of its pick, B's pick of Q",
      mine: "a",
      setup: async (s) => { await withBuild(s); await step(s, () => s.pick(s.a, P)); },
      undoing: (s) => s.a.undo(),
      other: (s) => s.pick(s.b, Q),
      mineLast: (s) => s.build,
      otherLast: () => ({ hero: Q }),
    },
  ];
  for (const c of cases) {
    for (const last of ["mine", "other"] as const) {
      it(`${c.name}: ${last === "mine" ? "the undo or redo" : "the other edit"} decided last`, async () => {
        const s = await heldSaved();
        await c.setup(s);
        const me = c.mine === "a" ? { session: s.a, sock: s.ga } : { session: s.b, sock: s.gb };
        const them = c.mine === "a" ? { session: s.b, sock: s.gb } : { session: s.a, sock: s.ga };
        const [sooner, later] = last === "mine" ? [them, me] : [me, them];
        later.sock.hold();
        // Each made on a view that doesn't hold the other.
        if (later === me) { c.undoing(s); c.other(s); } else { c.other(s); c.undoing(s); }
        expect(await settled(sooner.session)).toBe(true);
        later.sock.release();
        await sync(s);
        coherent(s, hero(s.a, s.id).more);
        expect(await everywhere(s)).toEqual(last === "mine" ? c.mineLast(s) : c.otherLast(s));
      });
    }
  }
});

// The decided path against the plain one, through the real replica: a step that writes no
// hero's record in a scene that holds its heroes goes on the wire exactly as the plain undo
// and redo send it, and in a step that does, every other record's ops do too.
describe("every other record's ops go exactly as the plain undo and redo send them", () => {
  /** Two replicas restored from `s.a`'s state, connected; and `s.a`'s view as records. */
  function twins(s: Saved) {
    const state = (s.a as unknown as { replica: { state(): string } }).replica.state();
    const pair = [BoardReplica.restore(state), BoardReplica.restore(state)] as const;
    for (const x of pair) x.connect();
    return pair;
  }
  const submits = (u: string) => (JSON.parse(u).frames as Array<{ msg: { Submit?: { ops: Op[]; kind: unknown } } }>).flatMap((f) => (f.msg.Submit ? [f.msg.Submit] : []));
  const target = (o: Op) => (Object.values(o)[0] as { id: RecordId }).id;
  const records = (r: BoardReplica) => new Map(JSON.parse(r.view()) as Array<[RecordId, RecordEntry]>);
  /** Undo (or redo) on both: plainly, and as decided. */
  function both(plain: BoardReplica, decided: BoardReplica, which: "undo" | "redo") {
    const step = JSON.parse(which === "undo" ? plain.nextUndo() : plain.nextRedo()) as Op[];
    const d = decideStep(step, records(decided));
    const p = submits(which === "undo" ? plain.undo() : plain.redo());
    const q = submits(which === "undo" ? decided.undoAs(JSON.stringify(d.ops), JSON.stringify(d.carry)) : decided.redoAs(JSON.stringify(d.ops), JSON.stringify(d.carry)));
    return { d, p: p[0]!, q: q[0]! };
  }

  it("a step that writes no hero's record in such a scene: the same tx, the same next step", async () => {
    const s = await saved();
    const other = s.heroes[0]!;
    await step(s, () => expect(s.a.edit([{ Set: { id: other, value: { PlayerPos: { x: 5, y: 6 } } } }, { Set: { id: other, value: { More: { key: "name", value: "x" } } } }])).toBe(true));
    const [plain, decided] = twins(s);
    for (const which of ["undo", "redo", "undo"] as const) {
      const { d, p, q } = both(plain, decided, which);
      expect(d.changed).toBe(false);
      expect(q).toEqual(p);
      expect(decided.nextUndo()).toEqual(plain.nextUndo());
      expect(decided.nextRedo()).toEqual(plain.nextRedo());
    }
    [s.a, s.b].forEach((x) => x.stop());
  });

  it("a step that writes one and other records too: the others' ops as `undo` sends them, in order", async () => {
    const s = await saved();
    const other = s.heroes[0]!;
    await withBuild(s);
    const pick = pickHeroOps(true, hero(s.a, s.id).slot, { id: s.id, more: hero(s.a, s.id).more }, P);
    await step(s, () => expect(s.a.edit([{ Set: { id: other, value: { PlayerPos: { x: 5, y: 6 } } } }, ...pick, { Set: { id: other, value: { More: { key: "name", value: "x" } } } }])).toBe(true));
    const [plain, decided] = twins(s);
    for (const which of ["undo", "redo"] as const) {
      const { d, p, q } = both(plain, decided, which);
      expect(d.changed).toBe(true);
      expect(q.kind).toEqual(p.kind);
      expect(q.ops.filter((o) => target(o) !== s.id)).toEqual(p.ops.filter((o) => target(o) !== s.id));
      // With no one else's edit between, the hero's record ends as the plain step leaves it.
      expect(records(decided).get(s.id)).toEqual(records(plain).get(s.id));
      expect(records(decided).get(other)).toEqual(records(plain).get(other));
    }
    [s.a, s.b].forEach((x) => x.stop());
  });
});

// The session's own choice, through BoardSession.undo and redo: a step it needn't decide goes by
// the plain undo, exactly; one it decides goes as decided. Each sent transaction is compared
// with what the plain undo of a copy of the same replica sends.
describe("BoardSession.undo and redo send the plain step unless a hero's record needs deciding", () => {
  /** A socket that records every transaction it sends. */
  function recording() {
    const sent: Tx[] = [];
    const open = (url: string) => {
      const w = openSocket(url) as unknown as { send: (d: string) => void };
      const send = w.send.bind(w);
      w.send = (d: string) => {
        const f = JSON.parse(d) as { t: string; msg?: { Submit?: Tx } };
        if (f.msg?.Submit) sent.push(f.msg.Submit);
        send(d);
      };
      return w as unknown as SocketLike;
    };
    return { open, sent };
  }
  /** What the plain undo (redo) of a copy of `x`'s replica sends now. */
  const plainly = (x: BoardSession, which: "undo" | "redo") => {
    const twin = BoardReplica.restore((x as unknown as { replica: { state(): string } }).replica.state());
    twin.connect();
    const u = JSON.parse(which === "undo" ? twin.undo() : twin.redo()) as { frames: Array<{ msg: { Submit?: Tx } }> };
    return u.frames.flatMap((f) => (f.msg.Submit ? [f.msg.Submit] : []));
  };
  async function through(s: Saved, rec: ReturnType<typeof recording>, which: "undo" | "redo") {
    const want = plainly(s.a, which);
    const from = rec.sent.length;
    await step(s, () => (which === "undo" ? s.a.undo() : s.a.redo()));
    return { want, got: rec.sent.slice(from) };
  }

  it("a step with no hero's record: what the plain undo and redo send", async () => {
    const rec = recording();
    const s = await saved([rec.open]);
    await step(s, () => expect(s.a.edit([{ Set: { id: s.heroes[0]!, value: { PlayerPos: { x: 5, y: 6 } } } }, { Set: { id: s.scene, value: { SceneName: "x" } } }])).toBe(true));
    for (const which of ["undo", "redo", "undo"] as const) {
      const { want, got } = await through(s, rec, which);
      expect(got).toEqual(want);
    }
    [s.a, s.b].forEach((x) => x.stop());
  });

  it("a Retake in a scene that doesn't hold its heroes (slot writes, no `has_heroes`): what the plain undo and redo send", async () => {
    const rec = recording();
    const s = await saved([rec.open], false);
    // `a` is the recorded one: it retakes.
    let n = 0;
    await step(s, () => (n = s.retake(s.a)));
    expect(rows(hero(s.a, s.id).more).length).toBeGreaterThan(0);
    for (const which of ["undo", "redo", "undo"] as const) {
      for (let i = 0; i < n; i++) {
        const { want, got } = await through(s, rec, which);
        expect(got).toEqual(want);
      }
    }
    [s.a, s.b].forEach((x) => x.stop());
  });

  it("a hero's record in a scene that holds its heroes: the step as decided, not the plain one", async () => {
    const rec = recording();
    const s = await saved([rec.open]);
    await step(s, () => s.pick(s.a, P));
    const { want, got } = await through(s, rec, "undo");
    expect(got).toHaveLength(1);
    expect(got[0]!.ops).not.toEqual(want[0]!.ops);
    // The record written whole: its hero, then every build row.
    expect(got[0]!.ops[0]).toEqual({ Set: { id: s.id, value: { More: { key: "hero", value: s.M } } } });
    expect(got[0]!.kind).toEqual(want[0]!.kind);
    [s.a, s.b].forEach((x) => x.stop());
  });
});
