// The TypeScript session + the real WASM replica + the real server binary (spec §14 layer 4,
// minus the browser). Sockets come from the `ws` package so tests can set an Origin.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import "fake-indexeddb/auto";
import { initSync } from "../src/wasm/mapcro_wasm.js";
import { Api } from "../src/core/api";
import { IdbPersist, MemoryPersist, type Persist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import type { Op } from "../src/gen/Op";
import type { RecordId } from "../src/gen/RecordId";

const ROOT = resolve(__dirname, "../..");
const ORIGIN = "http://localhost:5173";
initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

class Server {
  child!: ChildProcess;
  constructor(readonly dir: string, readonly port: number) {}
  get http() {
    return `http://127.0.0.1:${this.port}`;
  }
  get ws() {
    return `ws://127.0.0.1:${this.port}/ws`;
  }
  async start() {
    this.child = spawn(join(ROOT, "target/debug/mapcro-server"), [], {
      env: { ...process.env, PORT: String(this.port), DATA_DIR: this.dir, PUBLIC_ORIGIN: ORIGIN, RUST_LOG: "warn" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(`${this.http}/healthz`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("server never became healthy");
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
    server = new Server(mkdtempSync(join(tmpdir(), "mapcro-web-")), await freePort());
    await server.start();
    api = new Api(server.http);
  });
  afterAll(() => server.child.kill("SIGKILL"));

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
    await until(() => v.problems.some((p) => p.includes("Forbidden")), "rejection");
    await until(() => v.status.kind === "saved", "rejected edit dropped");
    expect(pos(v, p0!)).toBe(before);

    await api.revoke(board, owner_token, link_id);
    await until(() => e.connection.kind === "closed", "revoked session closed");
    expect(e.connection).toEqual({ kind: "closed", reason: "revoked" });
    v.stop();
  });
});
