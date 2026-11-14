// A board's session parked and resumed (sessions.md §5, §9.1's parked rows at the session's
// level), against the real server: a parked session leaves the room once its edits are acked,
// flushes edits made offline without showing up in anyone's people list, takes no edit, keeps
// its replica and undo stack for the board's next mount, and is let back in only by the server.

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer } from "./support/server";
import { initSync } from "../src/wasm/mapcro_wasm.js";
import { Api } from "../src/core/api";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SessionCallbacks, type SocketLike } from "../src/core/session";
import type { Entry } from "../src/gen/Entry";
import type { RecordId } from "../src/gen/RecordId";
import { RoomPool } from "../src/session/pool";

const ROOT = resolve(__dirname, "../..");
const ORIGIN = "http://localhost:5173";
initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

async function until(pred: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a board's session, parked and resumed", () => {
  let child: ChildProcess;
  let port = 0;
  let api: Api;
  /** Sockets opened, by the session that opened them. */
  const sockets = new Map<string, WebSocket[]>();
  beforeAll(async () => {
    const s = await startServer({
      bin: join(ROOT, "target/debug/mapcro-server"),
      env: { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), "mapcro-park-")), PUBLIC_ORIGIN: ORIGIN, RUST_LOG: "warn" },
      port: 0,
    });
    child = s.child;
    port = s.port;
    api = new Api(`http://127.0.0.1:${port}`);
  });
  afterAll(() => child.kill("SIGKILL"));

  const open = (who: string, board: string, token: string, o: Partial<SessionCallbacks> & { persist?: MemoryPersist; via?: { session: string; grant: string } } = {}) => {
    const { persist, via, ...cb } = o;
    return new BoardSession({
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      board,
      token,
      persist: persist ?? new MemoryPersist(),
      openSocket: (url) => {
        const ws = new WebSocket(url, { origin: ORIGIN });
        sockets.set(who, [...(sockets.get(who) ?? []), ws]);
        return ws as unknown as SocketLike;
      },
      minDelayMs: 30,
      maxDelayMs: 200,
      ...(via ? { via } : {}),
      ...cb,
    });
  };
  const openSockets = (who: string) => (sockets.get(who) ?? []).filter((w) => w.readyState === WebSocket.OPEN || w.readyState === WebSocket.CONNECTING).length;
  const live = (s: BoardSession) => s.connection.kind === "live";
  const hero = (s: BoardSession) => [...s.records].find(([, e]) => "PlayerState" in e.record)![0];
  const x = (s: BoardSession, id: RecordId) => {
    const e = s.records.get(id);
    return e && "PlayerState" in e.record ? e.record.PlayerState.pos.x : undefined;
  };
  const move = (id: RecordId, to: number) => [{ Set: { id, value: { PlayerPos: { x: to, y: 0 } } } }];
  const named = (s: BoardSession, name: string) => [...s.peers.values()].some((p) => p.state?.name === name);

  it("leaves the room at once with nothing to send, and comes back drawn, caught up and able to undo", async () => {
    const b = await api.createBoard("parked");
    const a = open("a1", b.board, b.owner_token);
    const peer = open("p1", b.board, b.owner_token);
    await a.start();
    await peer.start();
    await until(() => live(a) && live(peer), "both live");
    a.setPresence({ name: "Ada" });
    await until(() => named(peer, "Ada"), "the peer sees Ada");
    const h = hero(a);
    expect(a.edit(move(h, 11))).toBe(true);
    await until(() => a.status.kind === "saved" && x(peer, h) === 11, "acked");
    expect(a.canUndo).toBe(true);

    a.park();
    // No socket, at once (nothing pending), and off the people list.
    expect(a.isParked()).toBe(true);
    expect(openSockets("a1")).toBe(0);
    await until(() => !named(peer, "Ada"), "Ada left the people list");
    // Parked, it takes no edit, undo or redo.
    expect(a.edit(move(h, 99))).toBe(false);
    a.undo();
    expect(x(a, h)).toBe(11);
    // Nor does it reconnect on its own, or send presence.
    a.setPresence({ name: "Ghost" });
    await pause(300);
    expect(openSockets("a1")).toBe(0);
    expect(named(peer, "Ghost")).toBe(false);

    // The peer edits meanwhile.
    expect(peer.edit(move(h, 22))).toBe(true);
    await until(() => peer.status.kind === "saved", "the peer's edit acked");
    expect(a.approxBytes()).toBeGreaterThan(1000);

    // Resumed for a new mount: it draws at once from the replica as it stood, then catches up.
    const drawn: Array<{ reset: boolean; n: number; x: number | undefined; socketsThen: number }> = [];
    let changes = 0;
    a.resume({
      onRecords: (changed, reset) => drawn.push({ reset, n: changed.length, x: x(a, h), socketsThen: sockets.get("a1")!.length }),
      onChange: () => void changes++,
    });
    expect(a.isParked()).toBe(false);
    // Synchronously, before any socket: every record, as a reset.
    expect(drawn[0]).toEqual({ reset: true, n: a.records.size, x: 11, socketsThen: 1 });
    expect(changes).toBeGreaterThan(0);
    expect(a.connection.kind).not.toBe("live");
    await until(() => live(a) && x(a, h) === 22, "caught up");
    expect(sockets.get("a1")!.length).toBe(2);
    // Its presence is back (the last one it had), and its undo stack was kept.
    await until(() => named(peer, "Ghost"), "seen again");
    expect(a.canUndo).toBe(true);
    a.undo();
    await until(() => a.status.kind === "saved", "undo acked");
    // The undo is of its own move (to 11), evaluated against the peer's later one: as on any board.
    expect(a.problems.filter((p) => p.startsWith("protocol"))).toEqual([]);
    expect(() => a.resume({})).toThrow();
    a.end();
    peer.end();
  });

  it("flushes edits made offline on quiet reconnects, on nobody's people list, then closes", async () => {
    const b = await api.createBoard("parked pending");
    let block = false;
    const a = new BoardSession({
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      board: b.board,
      token: b.owner_token,
      persist: new MemoryPersist(),
      openSocket: (url) => {
        // "Offline": sockets that never open.
        const ws = new WebSocket(block ? "ws://127.0.0.1:9/ws" : url, { origin: ORIGIN });
        ws.on("error", () => {});
        sockets.set("a2", [...(sockets.get("a2") ?? []), ws]);
        return ws as unknown as SocketLike;
      },
      minDelayMs: 30,
      maxDelayMs: 100,
    });
    const peer = open("p2", b.board, b.owner_token);
    await a.start();
    await peer.start();
    await until(() => live(a) && live(peer), "both live");
    a.setPresence({ name: "Ada" });
    await until(() => named(peer, "Ada"), "the peer sees Ada");
    const h = hero(a);
    // Offline: the socket drops and no new one opens.
    block = true;
    sockets.get("a2")!.at(-1)!.close();
    await until(() => !live(a), "offline");
    await until(() => !named(peer, "Ada"), "gone from the list");
    expect(a.edit(move(h, 33))).toBe(true);
    expect(a.status).toEqual({ kind: "offline", pending: 1 });

    a.park();
    // Still trying: it has an edit to flush.
    await pause(200);
    expect(a.status.kind).not.toBe("saved");
    const tries = sockets.get("a2")!.length;
    expect(tries).toBeGreaterThan(2);
    // Back online: the edit lands on its board, the peer sees it, and never sees Ada again.
    let seen = false;
    const watch = setInterval(() => (seen ||= named(peer, "Ada")), 5);
    block = false;
    await until(() => x(peer, h) === 33, "the parked edit reached the board");
    await until(() => openSockets("a2") === 0, "then its socket closed");
    expect(a.status.kind).toBe("saved");
    await pause(200);
    clearInterval(watch);
    expect(seen).toBe(false);
    // And it stays closed.
    const after = sockets.get("a2")!.length;
    await pause(300);
    expect(sockets.get("a2")!.length).toBe(after);
    a.end();
    peer.end();
  });

  it("an edit still on its way when the board is left goes out on its socket, which then closes", async () => {
    const b = await api.createBoard("parked mid-edit");
    const a = open("a3", b.board, b.owner_token);
    const peer = open("p3", b.board, b.owner_token);
    await a.start();
    await peer.start();
    await until(() => live(a) && live(peer), "both live");
    const h = hero(a);
    expect(a.edit(move(h, 44))).toBe(true);
    a.park(); // in the same tick: the edit is still on the save chain
    expect(openSockets("a3")).toBe(1);
    await until(() => x(peer, h) === 44, "the peer gets it");
    await until(() => openSockets("a3") === 0, "closed once acked");
    expect(a.status.kind).toBe("saved");
    expect(sockets.get("a3")!.length).toBe(1); // on the socket it had: no reconnect
    a.end();
    peer.end();
  });

  it("parked before it finished loading, it opens no socket until it's resumed, and then one", async () => {
    const b = await api.createBoard("parked early");
    const a = open("a6", b.board, b.owner_token);
    void a.start();
    a.park(); // the tab was left at once: its load is still under way
    await pause(300);
    expect(sockets.get("a6") ?? []).toEqual([]);
    a.resume({});
    await until(() => live(a), "live once resumed");
    await pause(100);
    expect(sockets.get("a6")!.length).toBe(1);
    // And resumed while that load is still under way: one socket, never two.
    const c = open("a7", b.board, b.owner_token);
    void c.start();
    c.park();
    c.resume({});
    await until(() => live(c), "live");
    await pause(100);
    expect(sockets.get("a7")!.length).toBe(1);
    a.end();
    c.end();
  });

  it("is let back in only by the server: a grant withdrawn while parked is refused on resume", async () => {
    const b = await api.createBoard("parked revoked");
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "S", board: b.board, board_token: b.owner_token }) });
    const s = (await r.json()) as { session: string; owner_token: string; grant: { grant_id: string } };
    const via = { session: s.session, grant: s.grant.grant_id };
    const a = open("a4", b.board, s.owner_token, { via });
    await a.start();
    await until(() => live(a), "live through the grant");
    a.park();
    expect(openSockets("a4")).toBe(0);
    const gone = await fetch(`http://127.0.0.1:${port}/api/sessions/${s.session}/grants/${via.grant}`, { method: "DELETE", headers: { authorization: `Bearer ${s.owner_token}` } });
    expect(gone.status).toBe(204);
    a.resume({});
    await until(() => a.connection.kind === "closed", "refused");
    expect(a.connection).toEqual({ kind: "closed", reason: "unauthorized" });
    // Refused for good: the pool wouldn't keep it.
    const pool = new RoomPool<BoardSession>();
    pool.park(b.board, s.owner_token, via, a);
    expect(pool.size().n).toBe(0);
    expect(pool.take(b.board, s.owner_token, via)).toBeUndefined();
    pool.close();
  });

  it("through the pool: the same board and credential get the session back; another credential a fresh start", async () => {
    const b = await api.createBoard("pooled");
    const edit = await api.mintLink(b.board, b.owner_token, "edit", "");
    const persist = new MemoryPersist();
    const pool = new RoomPool<BoardSession>();
    const a = open("a5", b.board, b.owner_token, { persist });
    await a.start();
    await until(() => live(a), "live");
    const h = hero(a);
    expect(a.edit(move(h, 55))).toBe(true);
    await until(() => a.status.kind === "saved", "acked");
    pool.park(b.board, b.owner_token, undefined, a);
    expect(pool.size().n).toBe(1);
    expect(pool.size().bytes).toBe(a.approxBytes());
    expect(pool.take(b.board, b.owner_token, undefined)).toBe(a);
    a.resume({});
    await until(() => live(a), "live again");
    pool.park(b.board, b.owner_token, undefined, a);
    // The board through another link: the parked session ends, and the new one loads what it stored.
    expect(pool.take(b.board, edit.token, undefined)).toBeUndefined();
    expect(() => a.resume({})).toThrow();
    const fresh = open("a5b", b.board, edit.token, { persist });
    await fresh.start();
    await until(() => live(fresh), "the fresh one is live");
    expect(x(fresh, h)).toBe(55);
    expect(fresh.connection).toEqual({ kind: "live", role: "edit" });
    fresh.end();
    pool.close();
  });
});
