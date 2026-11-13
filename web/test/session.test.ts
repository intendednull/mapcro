// The TypeScript session + the real WASM replica + the real server binary (spec §14 layer 4,
// minus the browser). Sockets come from the `ws` package so tests can set an Origin.

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer } from "./support/server";
import "fake-indexeddb/auto";
import { initSync } from "../src/wasm/mapcro_wasm.js";
import { Api } from "../src/core/api";
import { IdbPersist, MemoryPersist, type Persist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import type { Op } from "../src/gen/Op";
import type { RosterSlot } from "../src/gen/RosterSlot";
import { ensureLiveOps, liveIds } from "../src/player/live";
import { layerFrom } from "../src/player/layer";
import { pageSeat } from "../src/core/seat";
import type { RecordId } from "../src/gen/RecordId";

const ROOT = resolve(__dirname, "../..");
const ORIGIN = "http://localhost:5173";
initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

class Server {
  child!: ChildProcess;
  /** 0 until it first listens; then a restart comes back to the same port. */
  port = 0;
  constructor(readonly dir: string, readonly env: Record<string, string> = {}) {}
  get http() {
    return `http://127.0.0.1:${this.port}`;
  }
  get ws() {
    return `ws://127.0.0.1:${this.port}/ws`;
  }
  async start() {
    const s = await startServer({
      bin: join(ROOT, "target/debug/mapcro-server"),
      env: { ...process.env, DATA_DIR: this.dir, PUBLIC_ORIGIN: ORIGIN, RUST_LOG: "warn", ...this.env },
      port: this.port,
    });
    this.child = s.child;
    this.port = s.port;
  }
  kill9() {
    this.child.kill("SIGKILL");
    return new Promise((r) => this.child.once("exit", r));
  }
}

const openSocket = (url: string) => new WebSocket(url, { origin: ORIGIN }) as unknown as SocketLike;

async function until(pred: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function session(server: Server, board: string, token: string, persist: Persist = new MemoryPersist()) {
  return new BoardSession({ wsUrl: server.ws, board, token, persist, openSocket, minDelayMs: 50, maxDelayMs: 400 });
}

const players = (s: BoardSession) =>
  [...s.records].filter(([, e]) => !e.deleted && "PlayerState" in e.record).map(([id]) => id as RecordId);
const move = (id: RecordId, x: number): Op[] => [{ Set: { id, value: { PlayerPos: { x, y: -x } } } }];
const pos = (s: BoardSession, id: RecordId) => {
  const e = s.records.get(id);
  return e && "PlayerState" in e.record ? e.record.PlayerState.pos.x : undefined;
};
const view = (s: BoardSession) => JSON.stringify([...s.records].sort(([a], [b]) => (a < b ? -1 : 1)));

describe("board sessions against the real server", () => {
  let server: Server;
  let api: Api;
  beforeAll(async () => {
    server = new Server(mkdtempSync(join(tmpdir(), "mapcro-web-")));
    await server.start();
    api = new Api(server.http);
  });
  afterAll(() => server.child.kill("SIGKILL"));

  it("a browser whose local storage won't open still joins, edits, and says why", async () => {
    // An older mapcro tab can hold IndexedDB open at an old version and block the upgrade.
    const blocked: Persist = {
      load: () => Promise.reject(new Error("blocked: close other mapcro tabs")),
      save: () => Promise.reject(new Error("blocked: close other mapcro tabs")),
    };
    const { board, owner_token } = await api.createBoard("blocked-storage");
    const s = session(server, board, owner_token, blocked);
    await s.start();
    await until(() => s.connection.kind === "live", "live despite storage");
    expect(s.storageUnavailable).toBe(true);
    expect(s.problems.some((p) => p.includes("close other mapcro tabs"))).toBe(true);
    s.edit(move(players(s)[0]!, 42));
    await until(() => s.status.kind === "saved", "edit acked");
    s.stop();
  });

  it("storage that opened but failed a read is let go as the session falls back to memory", async () => {
    // The database opens, then the role's read fails: the session swaps to memory, and `end`
    // would close only that, so the swap must close what opened.
    const base = new MemoryPersist();
    const calls: string[] = [];
    let reads = 0;
    const flaky: Persist = {
      load: (k) => (calls.push("load"), ++reads === 2 ? Promise.reject(new Error("quota")) : base.load(k)),
      save: (k, v) => base.save(k, v),
      close: () => void calls.push("close"),
    };
    const { board, owner_token } = await api.createBoard("fallback-closes");
    const s = session(server, board, owner_token, flaky);
    await s.start();
    expect(s.storageUnavailable).toBe(true);
    expect(calls).toEqual(["load", "load", "close"]);
    s.end();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c === "close").length).toBe(1);
  });

  it("two editors converge", async () => {
    const { board, owner_token } = await api.createBoard("converge");
    const { token } = await api.mintLink(board, owner_token, "edit", "teammate");
    const a = session(server, board, owner_token);
    const b = session(server, board, token);
    await a.start();
    await b.start();
    await until(() => a.connection.kind === "live" && b.connection.kind === "live", "both live");
    const [p0, p1] = players(a);
    for (let i = 0; i < 20; i++) {
      a.edit(move(p0!, i * 10));
      b.edit(move(p1!, i * 20));
      b.edit(move(p0!, i * 30)); // contested field: last writer (server order) wins
    }
    await until(() => a.status.kind === "saved" && b.status.kind === "saved", "both saved");
    await until(() => view(a) === view(b), "views equal");
    expect(pos(a, p1!)).toBe(19 * 20);
    a.stop();
    b.stop();
  });

  it("offline edits survive a reload and sync later", async () => {
    const { board, owner_token } = await api.createBoard("offline");
    const persist = new IdbPersist(indexedDB, `mapcro-test-${board}`);
    const a = session(server, board, owner_token, persist);
    await a.start();
    await until(() => a.connection.kind === "live", "live");
    const [p0] = players(a);
    a.stop(); // offline
    a.edit(move(p0!, 1234));
    a.edit(move(p0!, 4321));
    expect(a.status).toEqual({ kind: "offline", pending: 2 });
    await new Promise((r) => setTimeout(r, 100)); // let the IndexedDB write commit

    // "Reload": a brand-new session object over the same IndexedDB.
    const again = session(server, board, owner_token, persist);
    await again.start();
    await until(() => again.status.kind === "saved", "pending flushed");
    expect(pos(again, p0!)).toBe(4321);

    const observer = session(server, board, owner_token);
    await observer.start();
    await until(() => pos(observer, p0!) === 4321, "server has the offline edits");
    again.stop();
    observer.stop();
  });

  it("reconnects through a kill -9 without losing or doubling edits", async () => {
    const { board, owner_token } = await api.createBoard("crash");
    const a = session(server, board, owner_token);
    await a.start();
    await until(() => a.connection.kind === "live", "live");
    const [p0] = players(a);
    for (let i = 0; i < 30; i++) a.edit(move(p0!, i));
    await server.kill9();
    for (let i = 30; i < 40; i++) a.edit(move(p0!, i)); // made while the server is down
    await server.start();
    await until(() => a.connection.kind === "live" && a.status.kind === "saved", "back and saved");
    expect(pos(a, p0!)).toBe(39);
    const fresh = session(server, board, owner_token);
    await fresh.start();
    await until(() => fresh.status.kind === "saved" && view(fresh) === view(a), "fresh replica equals survivor");
    a.stop();
    fresh.stop();
  });

  // The "Conflict" a follower saw after a restart (docs/backlog.md, 2026-11-11). A fresh joiner
  // starts from the room's last snapshot, which may be behind the log (spec §5: one snapshot
  // serves a burst of joiners); until its catch-up lands, its view lacks what was made since.
  // Player's live layer has ids derived from the board and the match (player/live.ts), so a
  // joiner that makes it in that moment makes records the log already holds.
  const roster = (s: BoardSession) =>
    [...s.records].flatMap(([id, e]) => (!e.deleted && "RosterSlot" in e.record ? [{ id: id as RecordId, slot: e.record.RosterSlot as RosterSlot }] : []));
  const entries = (s: BoardSession) => Object.fromEntries(s.records) as never;
  /** A second editor that runs `act` the moment it is first live, before its catch-up. */
  async function joinAndAct(board: string, token: string, act: (s: BoardSession) => void, open = openSocket) {
    let acted = false;
    const b: BoardSession = new BoardSession({
      wsUrl: server.ws, board, token, persist: new MemoryPersist(), openSocket: open, minDelayMs: 50, maxDelayMs: 400,
      onChange: (s) => {
        if (acted || s.connection.kind !== "live") return;
        acted = true;
        queueMicrotask(() => act(b)); // before the next socket message: the catch-up
      },
    });
    await b.start();
    await until(() => acted && b.connection.kind === "live" && b.status.kind === "saved" && b.records.size > 0, "b acted and saved");
    return b;
  }

  it("a fresh joiner that makes the live layer before its catch-up is refused IdTaken", async () => {
    const { board, owner_token } = await api.createBoard("live-layer-race");
    const a = session(server, board, owner_token);
    await a.start();
    await until(() => a.connection.kind === "live", "a live");
    a.editSilent(ensureLiveOps(entries(a), board, 129000101, roster(a)));
    await until(() => a.status.kind === "saved", "a made the layer");
    let made = 0;
    const b = await joinAndAct(board, owner_token, (b) => {
      const ops = ensureLiveOps(entries(b), board, 129000101, roster(b));
      made = ops.length;
      b.editSilent(ops);
    });
    expect(made).toBeGreaterThan(0); // b's view didn't have it yet
    await until(() => b.problems.length > 0, "b's rejection");
    expect(b.problems).toEqual(['rejected: "IdTaken"']);
    expect(view(b)).toBe(view(a)); // the layer is a's, the same records
    a.stop();
    b.stop();
  });

  it("an ensure that loses that race is not a problem, and a fresh joiner is current only once caught up", async () => {
    const { board, owner_token } = await api.createBoard("live-layer-ensure");
    const a = session(server, board, owner_token);
    await a.start();
    await until(() => a.connection.kind === "live" && a.current(), "a live and current");
    a.ensure(ensureLiveOps(entries(a), board, 129000101, roster(a)));
    await until(() => a.status.kind === "saved", "a made the layer");
    let made = 0;
    let currentThen: boolean | undefined;
    const b = await joinAndAct(board, owner_token, (b) => {
      currentThen = b.current();
      const ops = ensureLiveOps(entries(b), board, 129000101, roster(b));
      made = ops.length;
      b.ensure(ops);
    });
    expect(currentThen).toBe(false); // its snapshot is behind the head: the layer is missing
    expect(made).toBeGreaterThan(0); // so it made it, and the server refused it
    expect(b.current()).toBe(true);
    expect(b.problems).toEqual([]);
    expect(view(b)).toBe(view(a));
    a.stop();
    b.stop();
  });

  it("a refusal of an ensure the server sends again after a reconnect is still not a problem", async () => {
    // The server reports every refusal from the hello's `pending_from` on (authority.rs), so a
    // client that heard one with an earlier transaction of its own still pending hears it again
    // on its next connection. A fresh joiner gets its own acks with its catch-up, after its
    // refusals: its socket drops in between here (the first socket hears only refusals).
    const { board, owner_token } = await api.createBoard("live-layer-refused-again");
    const a = session(server, board, owner_token);
    await a.start();
    await until(() => a.connection.kind === "live" && a.current(), "a live and current");
    a.ensure(ensureLiveOps(entries(a), board, 129000101, roster(a)));
    await until(() => a.status.kind === "saved", "a made the layer");
    const refusals: string[] = [];
    const sockets: WebSocket[] = [];
    let heldBack = true;
    const open = (url: string): SocketLike => {
      const ws = new WebSocket(url, { origin: ORIGIN });
      sockets.push(ws);
      const first = sockets.length === 1;
      const tap: SocketLike = {
        onopen: null, onmessage: null, onclose: null, onerror: null,
        send: (d) => ws.send(d),
        close: () => ws.close(),
      };
      ws.onopen = (e) => tap.onopen?.(e);
      ws.onclose = (e) => tap.onclose?.(e);
      ws.onerror = (e) => tap.onerror?.(e);
      ws.onmessage = (e) => {
        const data = String(e.data);
        const refusal = data.includes('"Rejected"');
        if (refusal) refusals.push(data);
        if (first && heldBack && !data.includes('"ready"') && !refusal) return; // not here yet
        tap.onmessage?.({ data });
        if (first && refusal) ws.close();
      };
      return tap;
    };
    const b = await joinAndAct(
      board, owner_token,
      (b) => {
        b.edit(move(players(b)[0]!, 7)); // still pending when the refusal comes
        b.ensure(ensureLiveOps(entries(b), board, 129000101, roster(b)));
      },
      open,
    );
    heldBack = false;
    expect(refusals).toHaveLength(2); // the same refusal, once on each connection
    expect(new Set(refusals).size).toBe(1);
    expect(b.problems).toEqual([]);
    expect(view(b)).toBe(view(a));
    // Kept only while the server can say it again: the next hello passes it.
    const ensures = (b as unknown as { ensures: Set<number> }).ensures;
    expect(ensures.size).toBe(1);
    sockets.at(-1)!.close();
    await until(() => b.connection.kind !== "live", "b dropped");
    await until(() => b.connection.kind === "live" && b.status.kind === "saved", "b back");
    expect(ensures.size).toBe(0);
    expect(refusals).toHaveLength(2);
    a.stop();
    b.stop();
  });

  it("offline, the live layer is made and sent on reconnect, as on any edit", async () => {
    const { board, owner_token } = await api.createBoard("live-layer-offline");
    const a = session(server, board, owner_token);
    await a.start();
    await until(() => a.connection.kind === "live" && a.current(), "a live and current");
    await server.kill9();
    await until(() => a.connection.kind !== "live", "a offline");
    const offline = { current: a.current(), makes: layerFrom(false, a.current()) };
    const made = a.ensure(ensureLiveOps(entries(a), board, 129000101, roster(a)));
    await server.start();
    expect(offline).toEqual({ current: false, makes: true }); // offline: made, as before the gate
    expect(made).toBe(true);
    await until(() => a.connection.kind === "live" && a.status.kind === "saved", "back and saved");
    expect(a.problems).toEqual([]);
    const fresh = session(server, board, owner_token);
    await fresh.start();
    await until(() => fresh.status.kind === "saved" && view(fresh) === view(a), "the server has it");
    expect(fresh.records.get(liveIds(board, 129000101, []).scene)).toBeDefined();
    a.stop();
    fresh.stop();
  });

  it("presence flows both ways and only editors are followable", async () => {
    const { board, owner_token } = await api.createBoard("presence");
    const { token: viewToken } = await api.mintLink(board, owner_token, "view", "fan");
    const coach = session(server, board, owner_token);
    const fan = session(server, board, viewToken);
    await coach.start();
    await fan.start();
    await until(() => coach.connection.kind === "live" && fan.connection.kind === "live", "both live");
    coach.setPresence({ name: "Coach", cursor: { x: 1, y: 2 } });
    fan.setPresence({ name: "Fan", laser: [{ x: 0, y: 0 }] });
    await until(() => [...fan.peers.values()].some((p) => p.state?.name === "Coach"), "fan sees coach");
    await until(() => [...coach.peers.values()].some((p) => p.state?.name === "Fan"), "coach sees fan");
    expect(fan.followable().map((p) => p.state?.name)).toEqual(["Coach"]);
    // Each carries its page's seat, the same across the server (spec §8).
    expect(fan.followable()[0]!.state?.seat).toBe(pageSeat());
    expect(Number.isSafeInteger(pageSeat())).toBe(true);
    expect(coach.followable()).toEqual([]); // the fan is view-only
    coach.stop();
    await until(() => fan.followable().length === 0, "coach left");
    fan.stop();
  });

  it("ending a session (its board unmounted) closes the socket, takes no edit after, makes its due save once and nothing after, lets go of storage and frees the replica", async () => {
    const { board, owner_token } = await api.createBoard("end");
    const base = new MemoryPersist();
    const calls: string[] = [];
    const persist: Persist = {
      load: (k) => (calls.push("load"), base.load(k)),
      save: (k, v) => (calls.push("save"), base.save(k, v)),
      close: () => void calls.push("close"),
    };
    const a = session(server, board, owner_token, persist);
    const observer = session(server, board, owner_token);
    await a.start();
    await observer.start();
    await until(() => a.connection.kind === "live" && observer.connection.kind === "live", "both live");
    a.setPresence({ name: "Leaving" });
    await until(() => [...observer.peers.values()].some((p) => p.state?.name === "Leaving"), "observer sees it");
    const [p0] = players(a);
    expect(a.edit(move(p0!, 5))).toBe(true);
    // Acked: the lazy save of the ack is due as it ends. It's made once, at the end (its undo
    // entry is in no journal), and nothing after.
    await until(() => a.status.kind === "saved", "acked");
    const before = calls.filter((c) => c === "save").length;
    a.end();
    await until(() => calls.filter((c) => c === "save").length === before + 1, "the final save");
    const saves = calls.filter((c) => c === "save").length;
    expect(a.edit(move(p0!, 6))).toBe(false);
    await until(() => ![...observer.peers.values()].some((p) => p.state?.name === "Leaving"), "the server saw it leave");
    await until(() => calls.includes("close"), "storage let go");
    await new Promise((r) => setTimeout(r, 600));
    expect(calls.filter((c) => c === "save").length).toBe(saves);
    expect(calls.filter((c) => c === "close").length).toBe(1);
    expect(a.current()).toBe(false);
    // The replica is freed and unreachable (an undo can't reach freed memory).
    expect((a as unknown as { replica: unknown }).replica).toBeUndefined();
    a.undo();
    // The edit after it ended never reaches the server.
    expect(pos(observer, p0!)).toBe(5);
    observer.stop();
  });

  it("a session ended before it finished starting lets go of storage only after its loads", async () => {
    const { board, owner_token } = await api.createBoard("end-early");
    const base = new MemoryPersist();
    const calls: string[] = [];
    const slow = <T,>(v: Promise<T>) => new Promise<T>((r) => setTimeout(() => r(v), 100));
    const persist: Persist = {
      load: (k) => (calls.push("load"), slow(base.load(k))),
      save: (k, v) => (calls.push("save"), base.save(k, v)),
      close: () => void calls.push("close"),
    };
    const a = session(server, board, owner_token, persist);
    const started = a.start();
    a.end();
    await started;
    await until(() => calls.includes("close"), "storage let go");
    expect(calls).toEqual(["load", "load", "close"]);
    expect(a.connection.kind).not.toBe("live");
  });

  it("a presence the server would refuse is held back, not resent in a reconnect loop", async () => {
    const { board, owner_token } = await api.createBoard("refused-presence");
    let opens = 0;
    const counting = (url: string) => (opens++, openSocket(url));
    const coach = new BoardSession({ wsUrl: server.ws, board, token: owner_token, persist: new MemoryPersist(), openSocket: counting, minDelayMs: 50, maxDelayMs: 400 });
    const fan = session(server, board, owner_token);
    await coach.start();
    await fan.start();
    await until(() => coach.connection.kind === "live" && fan.connection.kind === "live", "both live");
    const playback = { player: true, match_id: 1, t: 10, playing: false, speed: 1 };
    coach.setPresence({ name: "Coach" });
    await until(() => [...fan.peers.values()].some((p) => p.state?.name === "Coach"), "fan sees coach");
    // Half a surrogate pair: not UTF-8, so the server can't parse the frame (review 2026-11-11).
    coach.setPresence({ name: "Coach 2", playback: { ...playback, event_search: "x".repeat(61) + "\ud83d" } });
    await new Promise((r) => setTimeout(r, 800));
    expect(opens).toBe(1);
    expect(coach.connection.kind).toBe("live");
    expect(coach.problems.filter((p) => p.startsWith("presence not sent"))).toHaveLength(1);
    expect([...fan.peers.values()].some((p) => p.state?.name === "Coach 2")).toBe(false);
    // The next good one goes through.
    coach.setPresence({ name: "Coach 3", playback: { ...playback, event_search: "x" } });
    await until(() => [...fan.peers.values()].some((p) => p.state?.name === "Coach 3"), "fan sees the next one");
    expect(opens).toBe(1);
    coach.stop();
    fan.stop();
  });

  it("view links are read-only and revocation is final", async () => {
    const { board, owner_token } = await api.createBoard("roles");
    const { token: viewToken } = await api.mintLink(board, owner_token, "view", "audience");
    const { link_id, token: editToken } = await api.mintLink(board, owner_token, "edit", "assistant");
    const v = session(server, board, viewToken);
    const e = session(server, board, editToken);
    await v.start();
    await e.start();
    await until(() => v.connection.kind === "live" && e.connection.kind === "live", "both live");
    expect(v.connection).toEqual({ kind: "live", role: "view" });
    const [p0] = players(v);
    const before = pos(v, p0!);
    v.edit(move(p0!, 999));
    expect(v.problems).toContain("this link is view-only");
    expect(v.status.kind).toBe("saved");
    expect(pos(v, p0!)).toBe(before);
    expect(v.connection.kind).toBe("live"); // nothing was sent, so nothing was cut off

    await api.revoke(board, owner_token, link_id);
    await until(() => e.connection.kind === "closed", "revoked session closed");
    expect(e.connection).toEqual({ kind: "closed", reason: "revoked" });
    v.stop();
  });

  it("a full board refuses edits as BoardFull and keeps what it has", async () => {
    // Security review 2026-11-07, C1: the op log has a quota. Five transactions here.
    const small = new Server(mkdtempSync(join(tmpdir(), "mapcro-web-")), { BOARD_MAX_OPS: "5" });
    await small.start();
    try {
      const { board, owner_token } = await new Api(small.http).createBoard("full");
      const a = session(small, board, owner_token);
      await a.start();
      await until(() => a.connection.kind === "live", "live");
      const [p0] = players(a);
      for (let i = 1; i <= 7; i++) a.edit(move(p0!, i));
      await until(() => a.status.kind === "saved", "every change decided");
      expect(a.problems.filter((p) => p === 'rejected: "BoardFull"')).toHaveLength(2);
      expect(pos(a, p0!)).toBe(5); // the last change that fit
      // An ensure refused for anything but IdTaken is a problem like any other.
      a.ensure(ensureLiveOps(entries(a), board, 129000101, roster(a)));
      await until(() => a.status.kind === "saved", "the ensure decided");
      expect(a.problems.filter((p) => p === 'rejected: "BoardFull"')).toHaveLength(3);
      expect(a.connection.kind).toBe("live"); // refused, not cut off
      a.stop();
    } finally {
      small.child.kill("SIGKILL");
    }
  });

  it("a copy older than the server keeps is rebased, and its pending work lands once", async () => {
    // Compaction (spec §9): the server keeps only its newest entries. A tab that comes back
    // with an older copy gets the board as it is, keeps its unsent edits on top, and sends them.
    const small = new Server(mkdtempSync(join(tmpdir(), "mapcro-web-")), { BOARD_COMPACT_OPS: "20", BOARD_KEEP_OPS: "5" });
    await small.start();
    try {
      const api = new Api(small.http);
      const { board, owner_token } = await api.createBoard("compacted");
      const persist = new IdbPersist(indexedDB, `mapcro-test-rebase-${board}`);
      const a = session(small, board, owner_token, persist);
      await a.start();
      await until(() => a.connection.kind === "live", "a live");
      const [p0, p1] = players(a);
      a.stop(); // offline, with a copy at seq 0
      a.edit(move(p1!, 1234));
      a.edit(move(p1!, 1235));
      await new Promise((r) => setTimeout(r, 100)); // let the IndexedDB write commit

      const b = session(small, board, owner_token);
      await b.start();
      await until(() => b.connection.kind === "live", "b live");
      for (let i = 0; i < 60; i++) b.edit(move(p0!, i));
      await until(() => b.status.kind === "saved", "b saved");

      const again = session(small, board, owner_token, persist);
      await again.start();
      await until(() => again.status.kind === "saved" && pos(b, p1!) === 1235, "a's edits land after the rebase");
      await until(() => view(again) === view(b), "views equal");
      expect(pos(again, p0!)).toBe(59);
      expect(again.problems.filter((p) => p.startsWith("protocol error"))).toEqual([]);
      again.stop();
      b.stop();
    } finally {
      small.child.kill("SIGKILL");
    }
  });
});

describe("when Player makes its live layer (player/layer.ts)", () => {
  it("live: only from a current copy; offline: yes, sent on reconnect", () => {
    expect(layerFrom(true, false)).toBe(false); // a joiner before its catch-up
    expect(layerFrom(true, true)).toBe(true);
    expect(layerFrom(false, false)).toBe(true); // offline, or a deploy's reconnect window
  });
});
