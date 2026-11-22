// A pick of another hero in a scene that holds its heroes (map-state spec D2), through the real
// replica and server: the scene's `hero` set and the old hero's build cleared in one
// transaction, for everyone; one undo brings back both; and the server takes the row that says
// a scene holds its heroes once it is live (store v14), as it refused it while it was ahead.

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
import type { PlayerState } from "../src/gen/PlayerState";
import type { RecordId } from "../src/gen/RecordId";
import { LIMITS } from "../src/gen/limits";
import { ROWS } from "../src/gen/rows";
import type { Op } from "../src/gen/Op";
import type { RosterSlot } from "../src/gen/RosterSlot";
import { BUILD_KEYS, captureBuild, captureScene, captured, heroBuildAt, moreBytes, sceneHero } from "../src/mapstate/build";
import { holdsBuild } from "../src/mapstate/buildView";
import { encodeCC } from "../src/mapstate/codec";
import { pickHeroOps } from "../src/mapstate/edit";
import { secondPart, tenthPart } from "../src/mapstate/frame";
import { retakeOps, slotKey } from "../src/match/save";
import { replay } from "./support/synthetic-match";

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

/** A socket whose traffic the test can hold back in both directions: the client it serves edits
 * on a view that hasn't heard from anyone, and what it sent arrives when `release` says. */
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

async function board(sockets: Array<(url: string) => SocketLike> = []) {
  const api = new Api(`http://127.0.0.1:${port}`);
  const { board, owner_token } = await api.createBoard("pick");
  let opened = 0;
  const open = async () => {
    const s = new BoardSession({ wsUrl: `ws://127.0.0.1:${port}/ws`, board, token: owner_token, persist: new MemoryPersist(), openSocket: sockets[opened++] ?? openSocket });
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

it("the server takes the row that says a scene holds its heroes once it is live, and refuses it while it is ahead of its writer", async () => {
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

// TD-119: a pick and a Retake sent at about the same moment, each made on a view that doesn't
// hold the other. The server puts them in one order or the other; each is run here through the
// real replicas and server, the second editor's socket held until the first is decided.
describe("a pick racing a Retake, in a scene that holds its heroes and has no builds yet", () => {
  const tl = replay();
  const T = 4;
  const PICKED = 77;
  const SLOT = 3;
  const LATER = ROWS.has_heroes.index + 1;

  async function saved() {
    const [ga, gb] = [heldSocket(), heldSocket()];
    const { a, b, scene, heroes } = await board([ga.open, gb.open]);
    const rosterOf = (s: BoardSession) => [...s.records].flatMap(([id, e]) => ("RosterSlot" in e.record ? [{ id, slot: e.record.RosterSlot as RosterSlot }] : []));
    const match = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
    const matchOf = (id: RecordId) => {
      const r = rosterOf(a).find((x) => x.id === hero(a, id).slot)!.slot;
      return match.get(slotKey(r.team === "Amber" ? "amber" : "sapphire", r.slot))!;
    };
    // As Save leaves a scene it had no room to give builds: each record its match's hero, and
    // a state that says the scene holds them.
    const state = newRecordId();
    const more = captureScene(tl, { builds: false });
    expect(a.edit([
      { Create: { id: state, record: { SceneState: { scene, more } } } },
      ...heroes.map((id): Op => ({ Set: { id, value: { More: { key: "hero", value: matchOf(id).hero_id } } } })),
    ])).toBe(true);
    expect(await settled(a, b)).toBe(true);
    expect(await until(() => b.records.has(state) && heroes.every((id) => typeof hero(b, id).more?.hero === "number"))).toBe(true);
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
    const build = captureBuild(heroBuildAt(tl, pl, T));
    return {
      a, b, ga, gb, id, heroes, state: { id: state, more }, row, rosterOf,
      matchHero: pl.hero_id,
      build,
      groupA,
      retaken: { ...build, ...groupA } as More,
    };
  }
  type Saved = Awaited<ReturnType<typeof saved>>;
  /** What each editor sends, on the view each has when it is called. */
  const pick = (s: Saved) => pickHeroOps(true, hero(s.a, s.id).slot, { id: s.id, more: hero(s.a, s.id).more }, PICKED);
  const retake = (s: Saved) => retakeOps(s.row, s.state, s.heroes.map((h) => ({ id: h, state: hero(s.b, h) })) as never, s.rosterOf(s.b) as never, tl, newRecordId);
  /** What a client from before TD-119 sends. */
  const oldPick = (s: Saved) => {
    const more = hero(s.a, s.id).more;
    return [
      { Set: { id: s.id, value: { More: { key: "hero", value: PICKED } } } },
      ...BUILD_KEYS.filter((k) => more?.[k] !== undefined).map((key): Op => ({ Set: { id: s.id, value: { More: { key, value: null } } } })),
    ] as Op[];
  };
  const oldRetake = (s: Saved) =>
    retake(s).map((tx) => tx.flatMap((o): Op[] => ("Set" in o && "More" in o.Set.value && o.Set.value.More.key === "hero" ? [] : [o])));

  const held = (s: BoardSession) => JSON.stringify([...s.records].sort(([x], [y]) => (x < y ? -1 : 1)));
  /** `first` is decided by the server while `second`, made at the same moment, is still on its
   * way. Each makes its edit on a view that doesn't hold the other's. */
  async function race(s: Saved, first: "pick" | "retake", txs: { pick: (s: Saved) => Op[]; retake: (s: Saved) => Op[][] } = { pick, retake }) {
    const late = first === "pick" ? s.gb : s.ga;
    late.hold();
    const pending = { pick: [txs.pick(s)], retake: txs.retake(s) };
    const sends: { pick: [BoardSession, Op[][]]; retake: [BoardSession, Op[][]] } = { pick: [s.a, pending.pick], retake: [s.b, pending.retake] };
    const [sooner, later] = first === "pick" ? [sends.pick, sends.retake] : [sends.retake, sends.pick];
    for (const tx of later[1]) expect(later[0].edit(tx)).toBe(true);
    for (const tx of sooner[1]) expect(sooner[0].edit(tx)).toBe(true);
    expect(await settled(sooner[0])).toBe(true);
    late.release();
    expect(await settled(s.a, s.b)).toBe(true);
    expect(await until(() => held(s.a) === held(s.b))).toBe(true);
  }
  /** Whatever the order: both replicas hold the same, and a hero holds only its own build. */
  function agreed(s: Saved) {
    const more = hero(s.a, s.id).more;
    expect(hero(s.b, s.id).more).toEqual(more);
    if (more?.hero !== s.matchHero) expect(BUILD_KEYS.filter((k) => more?.[k] !== undefined)).toEqual([]);
    return more;
  }
  const stop = (s: Saved) => [s.a, s.b].forEach((x) => x.stop());

  it("the Retake decided first: the pick wins the slot, the new hero with no build (Group A kept)", async () => {
    const s = await saved();
    await race(s, "retake");
    expect(agreed(s)).toEqual({ hero: PICKED, ...s.groupA });
    expect(holdsBuild(hero(s.b, s.id).more, LATER, PICKED, true)).toBe(false);
    stop(s);
  });

  it("the pick decided first: the Retake wins the slot, the match's hero with its own build and Group A", async () => {
    const s = await saved();
    await race(s, "pick");
    expect(agreed(s)).toEqual(s.retaken);
    expect(holdsBuild(hero(s.b, s.id).more, LATER, s.matchHero, true)).toBe(true);
    stop(s);
  });

  it.each(["pick", "retake"] as const)("the other eleven get the match's build whatever the order (%s first)", async (first) => {
    const s = await saved();
    await race(s, first);
    for (const h of s.heroes.filter((x) => x !== s.id)) {
      expect(hero(s.a, h).more).toEqual(hero(s.b, h).more);
      expect(BUILD_KEYS.some((k) => hero(s.b, h).more?.[k] !== undefined)).toBe(true);
    }
    expect(s.a.problems).toEqual([]);
    expect(s.b.problems).toEqual([]);
    stop(s);
  });

  it("undoing the pick that lost nothing: the match's hero again, and nobody's build on another hero (Group A kept)", async () => {
    const s = await saved();
    await race(s, "retake");
    s.a.undo();
    expect(await settled(s.a, s.b)).toBe(true);
    expect(await until(() => hero(s.b, s.id).more?.hero === s.matchHero)).toBe(true);
    // The pick never saw the build, so its undo can't bring it back (TD-146); Group A stays (plan §6).
    expect(agreed(s)).toEqual({ hero: s.matchHero, ...s.groupA });
    stop(s);
  });

  it("undoing the pick the Retake overrode changes nothing", async () => {
    const s = await saved();
    await race(s, "pick");
    s.a.undo();
    expect(await settled(s.a, s.b)).toBe(true);
    expect(await until(() => held(s.a) === held(s.b))).toBe(true);
    expect(agreed(s)).toEqual(s.retaken);
    stop(s);
  });

  // A scene whose record already holds part of its build: Retake has only the rest to give.
  describe("when the record already holds part of its build", () => {
    const sync = async (s: Saved) => {
      expect(await settled(s.a, s.b)).toBe(true);
      expect(await until(() => held(s.a) === held(s.b))).toBe(true);
    };
    /** The record holds every row of its build but the last. */
    async function partly() {
      const s = await saved();
      const rows = Object.keys(s.build).filter((k) => k !== "hero");
      const lacks = rows.at(-1)!;
      expect(rows.length).toBeGreaterThan(1);
      expect(s.a.edit(rows.filter((k) => k !== lacks).map((key): Op => ({ Set: { id: s.id, value: { More: { key, value: s.build[key]! } } } })))).toBe(true);
      await sync(s);
      return { s, lacks };
    }

    it("the pick decided first: the match's hero with its whole build and Group A, not a fragment", async () => {
      const { s } = await partly();
      await race(s, "pick");
      expect(agreed(s)).toEqual(s.retaken);
      stop(s);
    });

    it("the Retake decided first: the new hero with no build (Group A kept)", async () => {
      const { s } = await partly();
      await race(s, "retake");
      expect(agreed(s)).toEqual({ hero: PICKED, ...s.groupA });
      stop(s);
    });

    it("a row someone changed while the Retake was on its way keeps their value", async () => {
      const { s, lacks } = await partly();
      const kept = Object.keys(s.build).find((k) => k !== "hero" && k !== lacks && typeof s.build[k] === "number")!;
      const theirs = (s.build[kept] as number) + 1;
      s.gb.hold();
      for (const tx of retake(s)) expect(s.b.edit(tx)).toBe(true);
      expect(s.a.edit([{ Set: { id: s.id, value: { More: { key: kept, value: theirs } } } }])).toBe(true);
      expect(await settled(s.a)).toBe(true);
      s.gb.release();
      await sync(s);
      expect(agreed(s)).toEqual({ ...s.retaken, [kept]: theirs });
      stop(s);
    });

    it("undoing the Retake takes back only what it filled", async () => {
      const { s, lacks } = await partly();
      const before = hero(s.a, s.id).more;
      const txs = retake(s);
      for (const tx of txs) expect(s.b.edit(tx)).toBe(true);
      await sync(s);
      expect(hero(s.a, s.id).more?.[lacks]).toBeDefined();
      for (let i = 0; i < txs.length; i++) {
        s.b.undo();
        await sync(s);
      }
      expect(agreed(s)).toEqual(before);
      stop(s);
    });
  });

  // A tab open from before this build stays open across a client deploy (the build id hashes
  // the schema). Against it the slot ends no worse than it does today: the half this build
  // sent holds, and only the old client's half can still leave the old hero's build.
  describe("with a client from before the fix", () => {
    it("this pick, an older Retake: the pick decided last is whole; decided first is as today", async () => {
      const last = await saved();
      await race(last, "retake", { pick, retake: oldRetake });
      expect(agreed(last)).toEqual({ hero: PICKED, ...last.groupA });
      stop(last);
      const first = await saved();
      await race(first, "pick", { pick, retake: oldRetake });
      const { hero: who, ...rest } = hero(first.a, first.id).more!;
      expect(who).toBe(PICKED);
      expect(BUILD_KEYS.some((k) => rest[k] !== undefined)).toBe(true);
      stop(first);
    });

    it("this Retake, an older pick: the Retake decided last is whole; decided first is as today", async () => {
      const last = await saved();
      await race(last, "pick", { pick: oldPick, retake });
      expect(agreed(last)).toEqual(last.retaken);
      stop(last);
      const first = await saved();
      await race(first, "retake", { pick: oldPick, retake });
      const { hero: who, ...rest } = hero(first.a, first.id).more!;
      expect(who).toBe(PICKED);
      expect(BUILD_KEYS.some((k) => rest[k] !== undefined)).toBe(true);
      stop(first);
    });
  });

  // Blocking #1 (Astra Round 2): when a peer concurrently eats the remaining bytes under
  // `max_more_bytes` while a Retake's `sceneGroup` is in flight, `Op::Set` on the hero's Group A
  // key fails `check_more_fits?` (`TxTooLarge`) and aborts the ENTIRE `sceneGroup` transaction
  // atomically on the server — so `has_sight` and `rows` never commit without `unseen`!
  it("a concurrent peer eating max_more_bytes aborts Retake's sceneGroup atomically (no false has_sight or rows bump)", async () => {
    const [ga, gb] = [heldSocket(), heldSocket()];
    const { a, b, scene, heroes } = await board([ga.open, gb.open]);
    const rosterOf = (s: BoardSession) => [...s.records].flatMap(([id, e]) => ("RosterSlot" in e.record ? [{ id, slot: e.record.RosterSlot as RosterSlot }] : []));
    const match = new Map(tl.players.map((p) => [slotKey(p.team, p.slot), p]));
    const matchOf = (id: RecordId) => {
      const r = rosterOf(a).find((x) => x.id === hero(a, id).slot)!.slot;
      return match.get(slotKey(r.team === "Amber" ? "amber" : "sapphire", r.slot))!;
    };
    const ten = tenthPart(tl, T);
    // Pick a hero that is unseen at T=4 (`unseen: true` = 14B, `height: 1` = 11B -> 25B total).
    const target = heroes.find((h) => ten.sight[tl.players.indexOf(matchOf(h))] !== true)!;
    expect(target).toBeDefined();

    // Build a 100% schema-legal `more` on `target` leaving exactly 30 bytes free under `max_more_bytes`
    // (`build_order` <= 600 ints, `items` <= 128 ints, `abilities` <= 48 ints, no `name` yet).
    const targetMore: More = {
      ...captureBuild(heroBuildAt(tl, matchOf(target), T)),
      build_order: Array.from({ length: 600 }, () => 4_294_967_295),
      items: Array.from({ length: 128 }, () => 4_294_967_295),
      abilities: [] as number[],
    };
    const ab = targetMore.abilities as number[];
    while (ab.length < 48 && moreBytes({ ...targetMore, abilities: [...ab, 4_294_967_295] }) <= LIMITS.max_more_bytes - 30) {
      ab.push(4_294_967_295);
    }
    const rem = LIMITS.max_more_bytes - 30 - moreBytes(targetMore);
    if (rem >= 2 && ab.length < 48) {
      const digits = Math.min(10, rem - 1);
      ab.push(digits === 10 ? 1_000_000_000 : Number("1".repeat(digits)));
    }
    const free = LIMITS.max_more_bytes - moreBytes(targetMore);
    expect(free).toBeGreaterThanOrEqual(25);
    expect(free).toBeLessThanOrEqual(34);

    // Seed a v14 scene (`rows: 16, has_builds: true, has_heroes: true`) with builds on all 12 heroes.
    const stateId = newRecordId();
    const stateMore: More = { rows: 16, has_builds: true, has_heroes: true, build: 6839 };
    expect(a.edit([{ Create: { id: stateId, record: { SceneState: { scene, more: stateMore } } } }])).toBe(true);
    for (const h of heroes) {
      const m = h === target ? targetMore : captureBuild(heroBuildAt(tl, matchOf(h), T));
      expect(a.edit(Object.entries(m).map(([key, value]): Op => ({ Set: { id: h, value: { More: { key, value } } } })))).toBe(true);
    }
    expect(await settled(a, b)).toBe(true);
    expect(await until(() => held(a) === held(b))).toBe(true);

    // Hold Peer A while Peer A plans & submits Retake (preflight passes: 25B <= free <= 34B!).
    const row = { id: scene, scene: { name: "s", order: "a", clock: T, source: { match_id: tl.match_id, t: T, tier: "replay" } } } as never;
    const beforeProblems = a.problems.length;
    ga.hold();
    const txs = retakeOps(
      row,
      { id: stateId, more: stateMore },
      heroes.map((h) => ({ id: h, state: hero(a, h) })) as never,
      rosterOf(a) as never,
      tl,
      newRecordId,
    );
    expect(txs).toHaveLength(1);
    expect(a.edit(txs[0]!)).toBe(true);

    // Concurrently, Peer B sets a schema-legal `name` (`<= 24` chars) consuming almost all free bytes
    // (`,"name":"..."` = 10 + nameLen bytes), leaving < 10 bytes free under `max_more_bytes`.
    const nameLen = Math.min(LIMITS.max_name, Math.max(1, free - 10 - 4));
    expect(b.edit([{ Set: { id: target, value: { More: { key: "name", value: "a".repeat(nameLen) } } } }])).toBe(true);
    expect(await settled(b)).toBe(true);
    expect(LIMITS.max_more_bytes - moreBytes(hero(b, target).more!)).toBeLessThan(14);

    // Release Peer A: server rejects `sceneGroup` atomically (`TxTooLarge`); neither `unseen` nor
    // `has_sight` nor `rows` commits, and both replicas agree!
    ga.release();
    expect(await until(() => a.problems.length > beforeProblems)).toBe(true);
    expect(a.problems.slice(beforeProblems).join(" ")).toMatch(/TxTooLarge/);
    expect(await settled(a, b)).toBe(true);
    expect(await until(() => held(a) === held(b))).toBe(true);

    const stateOf = (s: BoardSession) => (s.records.get(stateId)!.record as { SceneState: { more?: More } }).SceneState.more;
    for (const s of [a, b]) {
      expect(hero(s, target).more?.unseen).toBeUndefined();
      expect(hero(s, target).more?.height).toBeUndefined();
      expect(hero(s, target).more?.name).toBe("a".repeat(nameLen));
      expect(stateOf(s)?.has_sight).toBeUndefined();
      expect(stateOf(s)?.has_movement).toBeUndefined();
      expect(stateOf(s)?.rows).toBe(16);
      expect(captured(stateOf(s)).sight).toBe(false);
    }
    [a, b].forEach((x) => x.stop());
  });
});
