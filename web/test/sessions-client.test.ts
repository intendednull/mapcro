// Sessions on the client (sessions.md §4, §7, §10 phase 2): the tab list's pure rules, the one
// undo over two documents, and the session connection against the real server: `Ready.kind`
// checked both ways, a tab's board opened through its grant, and removal cutting it off.

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// The browser build: the reactive one (node resolves solid-js to the server's, which doesn't
// track), as late-perf.test.ts does.
vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));
import { createRoot } from "solid-js";
import WebSocket from "ws";
import "fake-indexeddb/auto";
import { startServer } from "./support/server";
import { initSync, newRecordId } from "../src/wasm/mapcro_wasm.js";
import { Api } from "../src/core/api";
import { IdbPersist, MemoryPersist, type Persist } from "../src/core/persist";
import { BoardSession, type SocketLike, docKind } from "../src/core/session";
import { authHeader } from "../src/core/cred";
import type { Entry } from "../src/gen/Entry";
import type { RecordId } from "../src/gen/RecordId";
import type { KnownBoard } from "../src/core/device";
import { UndoHistory, type UndoSide } from "../src/session/history";
import { createSessionState } from "../src/session/state";
import { type TabRow, addTabOps, credentialFor, liveTabs, moveOps, neighbourOf, pickTab, removeOps, renameOps, sessionMeta, tabName } from "../src/session/tabs";

const ROOT = resolve(__dirname, "../..");
const ORIGIN = "http://localhost:5173";
initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

const B1 = "AAAAAAAAAAAAAAAAAAAAAA";
const G1 = "BBBBBBBBBBBBBBBBBBBBBB";
const id = (n: number) => n.toString(16).padStart(32, "0");
const tabEntry = (name: string, order: string, deleted = false, board = B1): Entry => ({ record: { Tab: { board, grant: G1, name, order } }, deleted });
const rows = (...names: string[]): TabRow[] => names.map((n, i) => ({ id: id(i + 1), board: B1, grant: G1, name: n, order: String.fromCharCode(98 + i) }));

describe("the tab list", () => {
  it("lists live tabs by order, ties by id, and never a removed one", () => {
    const recs: Array<[RecordId, Entry]> = [
      [id(3), tabEntry("C", "k")],
      [id(1), tabEntry("A", "c")],
      [id(4), tabEntry("gone", "d", true)],
      [id(2), tabEntry("B", "k")],
      [id(9), { record: { SessionMeta: { title: "Scrims", version: 1 } }, deleted: false }],
    ];
    expect(liveTabs(recs).map((t) => t.name)).toEqual(["A", "B", "C"]);
    expect(sessionMeta(recs)).toEqual({ id: id(9), title: "Scrims" });
    expect(docKind(recs)).toBe("session");
    expect(docKind([[id(1), tabEntry("A", "c")]])).toBe("board");
  });

  it("opens the tab asked for while it's live, else the first", () => {
    const t = rows("A", "B", "C");
    expect(pickTab(t, id(2))).toBe(id(2));
    expect(pickTab(t, id(7))).toBe(id(1));
    expect(pickTab(t, undefined)).toBe(id(1));
    expect(pickTab([], id(1))).toBeUndefined();
  });

  it("moves off a removed tab to its left neighbour, else its right", () => {
    const before = [id(1), id(2), id(3), id(4)];
    const t = rows("A", "B", "C", "D");
    expect(neighbourOf(before, id(3), t.filter((x) => x.id !== id(3)))).toBe(id(2));
    // The left one went too (a peer removed both): the nearest live one further left.
    expect(neighbourOf(before, id(3), t.filter((x) => x.id !== id(3) && x.id !== id(2)))).toBe(id(1));
    expect(neighbourOf(before, id(1), t.filter((x) => x.id !== id(1)))).toBe(id(2));
    expect(neighbourOf(before, id(1), [])).toBeUndefined();
  });

  it("reorders with a key between the new neighbours", () => {
    const t = rows("A", "B", "C");
    const order = (ops: ReturnType<typeof moveOps>) => {
      const op = ops[0];
      if (!op || !("Set" in op) || !("TabOrder" in op.Set.value)) throw new Error("no move");
      const key = op.Set.value.TabOrder;
      return liveTabs(t.map((x) => [x.id, tabEntry(x.name, x.id === op.Set.id ? key : x.order)] as [RecordId, Entry])).map((x) => x.name);
    };
    expect(order(moveOps(t, id(3), 0))).toEqual(["C", "A", "B"]);
    expect(order(moveOps(t, id(1), 2))).toEqual(["B", "C", "A"]);
    expect(order(moveOps(t, id(1), 1))).toEqual(["B", "A", "C"]);
    expect(moveOps(t, id(2), 1)).toEqual([]);
    expect(moveOps(t, id(8), 0)).toEqual([]);
  });

  it("adds last, renames within the cap, removes as a delete", () => {
    const t = rows("A", "B");
    const add = addTabOps(id(5), t, B1, G1, "A very long board title that runs on");
    const made = add[0]!;
    if (!("Create" in made) || !("Tab" in made.Create.record)) throw new Error("not a tab");
    expect(made.Create.record.Tab.order > t[1]!.order).toBe(true);
    expect(made.Create.record.Tab.name).toBe(tabName("A very long board title that runs on"));
    expect([...made.Create.record.Tab.name].length).toBe(24);
    expect(renameOps(t[0]!, "  ")).toEqual([]);
    expect(renameOps(t[0]!, "A")).toEqual([]);
    expect(renameOps(t[0]!, "Game 2")).toEqual([{ Set: { id: id(1), value: { TabName: "Game 2" } } }]);
    expect(removeOps(id(1))).toEqual([{ Delete: { id: id(1) } }]);
  });

  it("opens a tab with this device's own link only when it can edit", () => {
    const t = rows("A")[0]!;
    const k = (o: Partial<KnownBoard>): KnownBoard => ({ board: B1, token: "own", title: "A", seen: 1, ...o });
    expect(credentialFor(t, "S", "st", [])).toEqual({ token: "st", via: { session: "S", grant: G1 } });
    expect(credentialFor(t, "S", "st", [k({ edit: true })])).toEqual({ token: "own" });
    expect(credentialFor(t, "S", "st", [k({ edit: false })])).toEqual({ token: "st", via: { session: "S", grant: G1 } });
    expect(credentialFor(t, "S", "st", [k({})])).toEqual({ token: "st", via: { session: "S", grant: G1 } });
    // A session entry with the same id is a session's link, never a board's.
    expect(credentialFor(t, "S", "st", [k({ edit: true, kind: "session" })])).toEqual({ token: "st", via: { session: "S", grant: G1 } });
    expect(authHeader("tok")).toBe("Bearer tok");
    expect(authHeader("tok", { session: "S", grant: "G" })).toBe("Grant S.G.tok");
  });
});

/** A document's stack, as the replica keeps one: steps done, steps undone. */
class Stack implements UndoSide {
  done: string[] = [];
  undone: string[] = [];
  log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  push(s: string) {
    this.done.push(s);
    this.undone = [];
  }
  canUndo = () => this.done.length > 0;
  canRedo = () => this.undone.length > 0;
  undo = () => {
    const s = this.done.pop()!;
    this.undone.push(s);
    this.log.push(`undo ${s}`);
  };
  redo = () => {
    const s = this.undone.pop()!;
    this.done.push(s);
    this.log.push(`redo ${s}`);
  };
}

describe("one undo over the strip and the board", () => {
  const setup = () => {
    const log: string[] = [];
    const h = createRoot(() => new UndoHistory());
    const session = new Stack(log);
    const a = new Stack(log);
    const b = new Stack(log);
    h.attach("session", session);
    const edit = (side: string, st: Stack, step: string) => {
      st.push(step);
      h.edited(side);
    };
    return { log, h, session, a, b, edit };
  };

  it("takes the newest step, whichever document it's in", () => {
    const { log, h, session, a, edit } = setup();
    h.attach("A", a);
    edit("A", a, "a1");
    edit("session", session, "remove");
    edit("A", a, "a2");
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(true);
    expect(log).toEqual(["undo a2", "undo remove", "undo a1"]);
    expect(h.undo()).toBe(false);
    expect(h.canUndo()).toBe(false);
    h.redo();
    h.redo();
    expect(log.slice(3)).toEqual(["redo a1", "redo remove"]);
  });

  it("never reaches a board that isn't mounted, and gives its steps back when it is", () => {
    const { log, h, session, a, b, edit } = setup();
    const offA = h.attach("A", a);
    edit("A", a, "a1");
    edit("session", session, "add B");
    offA();
    h.attach("B", b);
    edit("B", b, "b1");
    h.undo();
    h.undo();
    // A's step waits: nothing of A's is undone on B.
    expect(h.undo()).toBe(false);
    expect(log).toEqual(["undo b1", "undo add B"]);
    h.attach("A", a);
    expect(h.canUndo()).toBe(true);
    h.undo();
    expect(log.at(-1)).toBe("undo a1");
  });

  it("drops a step its document can no longer undo, and a new edit ends that document's redo", () => {
    const { log, h, session, a, edit } = setup();
    h.attach("A", a);
    edit("session", session, "s1");
    edit("A", a, "a1");
    a.done = []; // the replica's stack was emptied (a remote edit made the step a no-op)
    expect(h.undo()).toBe(true);
    expect(log).toEqual(["undo s1"]);
    edit("A", a, "a2");
    h.undo();
    expect(log.at(-1)).toBe("undo a2");
    edit("A", a, "a3"); // A's redo is gone; the session's (s1) stays
    expect(h.redo()).toBe(true);
    expect(log.at(-1)).toBe("redo s1");
    expect(h.redo()).toBe(false);
  });
});

// ---- against the real server ----

class Server {
  child!: ChildProcess;
  port = 0;
  constructor(readonly dir: string) {}
  get http() {
    return `http://127.0.0.1:${this.port}`;
  }
  get ws() {
    return `ws://127.0.0.1:${this.port}/ws`;
  }
  async start() {
    const s = await startServer({
      bin: join(ROOT, "target/debug/mapcro-server"),
      env: { ...process.env, DATA_DIR: this.dir, PUBLIC_ORIGIN: ORIGIN, RUST_LOG: "warn" },
      port: this.port,
    });
    this.child = s.child;
    this.port = s.port;
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

describe("the session connection against the real server", () => {
  let server: Server;
  let api: Api;
  beforeAll(async () => {
    server = new Server(mkdtempSync(join(tmpdir(), "mapcro-sessions-")));
    await server.start();
    api = new Api(server.http);
  });
  afterAll(() => server.child.kill("SIGKILL"));

  const post = async <T,>(path: string, body: unknown, token?: string): Promise<T> => {
    const r = await fetch(`${server.http}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return (await r.json()) as T;
  };
  const makeSession = async (title: string) => {
    const b = await api.createBoard(`${title} board`);
    const s = await post<{ session: string; owner_token: string; tab: string; grant: { grant_id: string; role: string } }>(
      "/api/sessions",
      { title, board: b.board, board_token: b.owner_token },
    );
    return { ...s, board: b.board, boardToken: b.owner_token };
  };
  const open = (board: string, token: string, o: { expect?: "board" | "session"; via?: { session: string; grant: string }; persist?: MemoryPersist } = {}) =>
    new BoardSession({ wsUrl: server.ws, board, token, persist: o.persist ?? new MemoryPersist(), openSocket, minDelayMs: 50, maxDelayMs: 400, ...(o.expect ? { expect: o.expect } : {}), ...(o.via ? { via: o.via } : {}) });

  it("a session's room, opened by a page that expects a board, is left at once and nothing of it kept", async () => {
    const s = await makeSession("wrong kind");
    const saved: string[] = [];
    const persist = new MemoryPersist();
    const orig = persist.save.bind(persist);
    persist.save = (k: string, v: string) => (saved.push(k), orig(k, v));
    const page = open(s.session, s.owner_token, { persist });
    await page.start();
    await until(() => page.connection.kind === "closed", "left the session room");
    expect(page.connection).toEqual({ kind: "closed", reason: "wrong_kind" });
    expect(page.records.size).toBe(0);
    expect(saved).toEqual([]);
    // And it isn't retried.
    await new Promise((r) => setTimeout(r, 300));
    expect(page.connection.kind).toBe("closed");
    page.end();

    // The reverse: a board's room on a session page.
    const back = open(s.board, s.boardToken, { expect: "session" });
    await back.start();
    await until(() => back.connection.kind === "closed", "left the board room");
    expect(back.records.size).toBe(0);
    back.end();

    // What each page expects, it opens.
    const right = open(s.session, s.owner_token, { expect: "session" });
    await right.start();
    await until(() => right.connection.kind === "live", "session live");
    expect(liveTabs(right.records).map((t) => t.id)).toEqual([s.tab]);
    right.end();
  });

  it("a stored copy of the other kind is never drawn", async () => {
    const s = await makeSession("stored kind");
    const persist = new MemoryPersist();
    const first = open(s.session, s.owner_token, { expect: "session", persist });
    await first.start();
    await until(() => first.connection.kind === "live" && first.status.kind === "saved", "session live");
    await new Promise((r) => setTimeout(r, 400)); // the lazy save
    first.end();
    expect(await persist.load(s.session)).toBeDefined();
    let drawn = 0;
    const page = new BoardSession({ wsUrl: server.ws, board: s.session, token: s.owner_token, persist, openSocket, onRecords: (c) => (drawn += c.length) });
    await page.start();
    expect(drawn).toBe(0);
    await until(() => page.connection.kind === "closed", "left");
    expect(drawn).toBe(0);
    page.end();
  });

  it("opens a tab's board through its grant, at the session's role, and a removed tab cuts it off until undo", async () => {
    const s = await makeSession("through the grant");
    const view = await post<{ token: string }>(`/api/sessions/${s.session}/links`, { role: "view", label: "" }, s.owner_token);
    const via = { session: s.session, grant: s.grant.grant_id };
    const editor = open(s.board, s.owner_token, { via });
    const viewer = open(s.board, view.token, { via });
    await editor.start();
    await viewer.start();
    await until(() => editor.connection.kind === "live" && viewer.connection.kind === "live", "both live");
    expect(editor.connection).toEqual({ kind: "live", role: "edit" }); // owner is never delegated
    expect(viewer.connection).toEqual({ kind: "live", role: "view" });
    // HTTP with the grant credential works for a board route.
    const r = await fetch(`${server.http}/api/boards/${s.board}/matches`, { headers: { authorization: authHeader(s.owner_token, via) } });
    expect(r.status).toBe(200);

    // The strip, through the client's session state, removes the tab: the board's connections
    // through that grant close.
    await createRoot(async () => {
      const h = new UndoHistory();
      const st = createSessionState(s.session, s.owner_token, h, { wsUrl: server.ws, openSocket, persist: new MemoryPersist(), minDelayMs: 50, maxDelayMs: 400 });
      await st.session.start(); // the WASM is loaded already (initSync), as `start` would
      await until(() => st.connection().kind === "live" && st.tabs().length === 1, "strip live");
      expect(st.canEdit()).toBe(true);
      expect(st.edit(removeOps(s.tab))).toBe(true);
      expect(st.tabs()).toEqual([]);
      expect(h.canUndo()).toBe(true);
      await until(() => editor.connection.kind !== "live" && viewer.connection.kind !== "live", "cut off");
      // A new open through the removed tab's grant is refused.
      const again = open(s.board, s.owner_token, { via });
      await again.start();
      await until(() => again.connection.kind === "closed", "refused");
      again.end();
      // Undo, through the one history, re-links it: a new connection goes live.
      expect(h.undo()).toBe(true);
      expect(st.tabs().map((t) => t.id)).toEqual([s.tab]);
      await until(() => st.session.status.kind === "saved", "restore acked");
      const back = open(s.board, s.owner_token, { via });
      await back.start();
      await until(() => back.connection.kind === "live", "open again");
      back.end();
      st.stop();
    });
    editor.end();
    viewer.end();
  });

  it("an edit made as its board is left still goes to that board (a drag released at a switch)", async () => {
    const b = await api.createBoard("left mid-edit");
    const a = open(b.board, b.owner_token);
    const observer = open(b.board, b.owner_token);
    await a.start();
    await observer.start();
    await until(() => a.connection.kind === "live" && observer.connection.kind === "live", "both live");
    const p0 = [...a.records].find(([, e]) => "PlayerState" in e.record)![0];
    expect(a.edit([{ Set: { id: p0, value: { PlayerPos: { x: 77, y: -77 } } } }])).toBe(true);
    a.end(); // in the same tick: the edit is still on its way through the save chain
    await until(() => {
      const e = observer.records.get(p0);
      return !!e && "PlayerState" in e.record && e.record.PlayerState.pos.x === 77;
    }, "the observer gets it");
    observer.end();
  });

  it("a view link reads the strip and can't edit it", async () => {
    const s = await makeSession("view strip");
    const view = await post<{ token: string }>(`/api/sessions/${s.session}/links`, { role: "view", label: "" }, s.owner_token);
    await createRoot(async () => {
      const h = new UndoHistory();
      const st = createSessionState(s.session, view.token, h, { wsUrl: server.ws, openSocket, persist: new MemoryPersist() });
      await st.session.start(); // the WASM is loaded already (initSync), as `start` would
      await until(() => st.connection().kind === "live" && st.tabs().length === 1, "strip live");
      expect(st.role()).toBe("view");
      expect(st.canEdit()).toBe(false);
      expect(st.edit(removeOps(s.tab))).toBe(false);
      expect(st.edit(renameOps(st.tabs()[0]!, "Mine"))).toBe(false);
      expect(st.tabs().length).toBe(1);
      expect(h.canUndo()).toBe(false);
      st.stop();
    });
  });

  const move = (id: RecordId, x: number) => [{ Set: { id, value: { PlayerPos: { x, y: -x } } } }] as Parameters<BoardSession["edit"]>[0];
  const xOf = (s: BoardSession, id: RecordId) => {
    const e = s.records.get(id);
    return e && "PlayerState" in e.record ? e.record.PlayerState.pos.x : undefined;
  };
  const players = (s: BoardSession) => [...s.records].filter(([, e]) => "PlayerState" in e.record).map(([id]) => id);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Review finding 1: e1, a pause (its lazy save lands), e2, then the board is left before e2's
  // lazy save. Back on it, one undo must take back e2, the newest, not e1.
  for (const [what, persists] of [
    ["one store", () => { const m = new MemoryPersist(); return () => m as Persist; }],
    ["a database per mount, the next opened at once", () => { const name = `undo-${Math.random()}`; return () => new IdbPersist(indexedDB, name) as Persist; }],
    // A slow write (a busy disk): the next mount's load must wait for the last save, not read
    // the storage from before it.
    ["a slow store, the next mount opened at once", () => {
      const m = new MemoryPersist();
      const slow: Persist = {
        load: (k) => m.load(k),
        save: (k, v) => sleep(300).then(() => m.save(k, v)),
        savePending: (b, t) => m.savePending(b, t),
        dropPending: (b, c, n) => m.dropPending(b, c, n),
      };
      return () => slow;
    }],
  ] as const) {
    it(`undo after leaving a board just after an edit takes back that edit (${what})`, async () => {
      const b = await api.createBoard("quick switch");
      const persist = persists();
      const a = new BoardSession({ wsUrl: server.ws, board: b.board, token: b.owner_token, persist: persist(), openSocket, minDelayMs: 50, maxDelayMs: 400 });
      await a.start();
      await until(() => a.connection.kind === "live", "live");
      const [p0, p1] = players(a);
      expect(a.edit(move(p0!, 11))).toBe(true);
      await sleep(700);
      expect(a.edit(move(p1!, 22))).toBe(true);
      await sleep(100);
      a.end();
      const back = new BoardSession({ wsUrl: server.ws, board: b.board, token: b.owner_token, persist: persist(), openSocket, minDelayMs: 50, maxDelayMs: 400 });
      await back.start();
      await until(() => back.connection.kind === "live" && back.status.kind === "saved", "back live");
      expect(xOf(back, p1!)).toBe(22);
      expect(back.canUndo).toBe(true);
      back.undo();
      expect(xOf(back, p1!)).not.toBe(22);
      expect(xOf(back, p0!)).toBe(11);
      back.end();
    });
  }

  it("an ended session's lazy save never runs after its final one", async () => {
    const b = await api.createBoard("no late save");
    const base = new MemoryPersist();
    const saves: string[] = [];
    const persist: Persist = {
      load: (k) => base.load(k),
      save: (k, v) => (saves.push(k), base.save(k, v)),
      // A slow journal: the edit is still on its way as the board is left, so the session
      // flushes (and its replica lives) for a while after `end`.
      savePending: (bd, t) => sleep(1000).then(() => base.savePending(bd, t)),
      dropPending: (bd, c, n) => base.dropPending(bd, c, n),
    };
    const a = new BoardSession({ wsUrl: server.ws, board: b.board, token: b.owner_token, persist, openSocket });
    await a.start();
    await until(() => a.connection.kind === "live" && a.status.kind === "saved", "live");
    await sleep(400);
    expect(a.edit(move(players(a)[0]!, 5))).toBe(true);
    a.end();
    await sleep(20);
    const n = saves.length;
    // A frame landing while it flushes asks for a lazy save.
    (a as unknown as { persistSoon(): void }).persistSoon();
    await sleep(500);
    expect(saves.length).toBe(n);
  });

  // Review finding 6: edits made through an edit grant, then the same board opened through a
  // view grant of the same session (the same session token): the role isn't taken from the edit
  // grant, and the pending edits are held, not resent through a link that can't edit.
  it("pending edits are held, not resent, through a view grant; the edit grant sends them", async () => {
    const s = await makeSession("view hold");
    const vg = await post<{ grant_id: string }>(`/api/sessions/${s.session}/grants`, { board: s.board, board_token: s.boardToken, role: "view" }, s.owner_token);
    expect(vg.grant_id).not.toBe(s.grant.grant_id);
    // A grant opens its board only while a tab holds it.
    const strip = open(s.session, s.owner_token, { expect: "session" });
    await strip.start();
    await until(() => strip.connection.kind === "live" && strip.current(), "strip live");
    expect(strip.edit(addTabOps(newRecordId(), liveTabs(strip.records), s.board, vg.grant_id, "Can view"))).toBe(true);
    await until(() => strip.status.kind === "saved", "tab added");
    strip.end();
    const persist = new MemoryPersist();
    const editVia = { session: s.session, grant: s.grant.grant_id };
    const viewVia = { session: s.session, grant: vg.grant_id };
    const ed = open(s.board, s.owner_token, { via: editVia, persist });
    await ed.start();
    await until(() => ed.connection.kind === "live" && ed.status.kind === "saved", "edit grant live");
    const [p0] = players(ed);
    ed.stop(); // offline
    expect(ed.edit(move(p0!, 33))).toBe(true);
    await sleep(50);
    ed.end();
    const observer = open(s.board, s.boardToken);
    await observer.start();
    await until(() => observer.connection.kind === "live", "observer live");

    const vw = open(s.board, s.owner_token, { via: viewVia, persist });
    await vw.start();
    // Before its Ready, the view grant's role is unknown on this device: no edit is taken.
    expect(vw.edit(move(p0!, 44))).toBe(false);
    await until(() => vw.connection.kind === "live", `view grant live`).catch((e) => { throw new Error(`${e} ${JSON.stringify(vw.connection)} ${JSON.stringify(vw.problems)}`); });
    await sleep(1000);
    expect(vw.connection).toEqual({ kind: "live", role: "view" });
    expect(vw.problems).toContain("edits not sent: this link is view-only");
    expect(xOf(observer, p0!)).not.toBe(33);
    vw.end();

    const again = open(s.board, s.owner_token, { via: editVia, persist });
    await again.start();
    await until(() => xOf(observer, p0!) === 33, "the held edit lands through the edit grant");
    again.end();
    observer.end();
  });
});
