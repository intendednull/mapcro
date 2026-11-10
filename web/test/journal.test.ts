// The pending-transaction journal (perf report 2026-11-07, finding 5): a live edit is durable once
// its transaction alone is written, and the whole state follows lazily. These pin the fold, the
// IndexedDB layout, and the session's invariant: nothing is sent before it is durable, and a tab
// that dies before its whole-state save restores every transaction it sent.

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
import { IdbPersist, MemoryPersist, type Persist, foldPending } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import type { Op } from "../src/gen/Op";
import type { RecordId } from "../src/gen/RecordId";
import type { Tx } from "../src/gen/Tx";

const ROOT = resolve(__dirname, "../..");
const ORIGIN = "http://localhost:5173";
initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

const tx = (cseq: number, kind: Tx["kind"] = "Edit", client = "me"): Tx => ({ client, cseq, kind, ops: [] });
const state = (o: { next: number; undo?: number[]; redo?: number[]; pending?: number[] }) =>
  JSON.stringify({
    client: "me",
    secret: "s",
    confirmed: {},
    last_seq: 0,
    pending: (o.pending ?? []).map((c) => tx(c)),
    next_cseq: o.next,
    undo: (o.undo ?? []).map((cseq) => ({ cseq, inverse: [] })),
    redo: (o.redo ?? []).map((cseq) => ({ cseq, inverse: [] })),
    rejected: [],
  });
const parsed = (s: string) =>
  JSON.parse(s) as { next_cseq: number; pending: Tx[]; undo: Array<{ cseq: number }>; redo: Array<{ cseq: number }> };

describe("folding the journal into a saved state", () => {
  it("adds this client's transactions from next_cseq on, in order, and ignores what the state holds", () => {
    const { state: s, folded } = foldPending(state({ next: 3, pending: [2] }), [tx(4), tx(1), tx(3), tx(2), tx(3, "Edit", "other")]);
    expect(folded).toBe(2);
    expect(parsed(s).pending.map((t) => t.cseq)).toEqual([2, 3, 4]);
    expect(parsed(s).next_cseq).toBe(5);
  });

  it("stops at a gap: what follows a missing transaction was never sent", () => {
    const { state: s, folded } = foldPending(state({ next: 3 }), [tx(3), tx(5)]);
    expect(folded).toBe(1);
    expect(parsed(s).next_cseq).toBe(4);
  });

  it("keeps undo history consistent: an undo journaled is not undoable again, an edit clears redo", () => {
    const undone = parsed(foldPending(state({ next: 3, undo: [0, 2], redo: [1] }), [tx(3, { Undo: { of: 2 } })]).state);
    expect(undone.undo.map((e) => e.cseq)).toEqual([0]);
    expect(undone.redo.map((e) => e.cseq)).toEqual([1]);
    const redone = parsed(foldPending(state({ next: 3, undo: [0], redo: [1] }), [tx(3, { Redo: { of: 1 } })]).state);
    expect(redone.redo).toEqual([]);
    const edited = parsed(foldPending(state({ next: 3, undo: [0], redo: [1] }), [tx(3)]).state);
    expect(edited.undo.map((e) => e.cseq)).toEqual([0]);
    expect(edited.redo).toEqual([]);
  });

  it("leaves the state untouched when nothing applies", () => {
    const s = state({ next: 3 });
    expect(foldPending(s, [tx(1), tx(2, "Edit", "other")])).toEqual({ state: s, folded: 0 });
  });
});

const journalKeys = (name: string) =>
  new Promise<IDBValidKey[]>((ok, err) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => {
      const keys = req.result.transaction("pending").objectStore("pending").getAllKeys();
      keys.onsuccess = () => {
        req.result.close();
        ok(keys.result);
      };
    };
    req.onerror = () => err(req.error);
  });

describe("IndexedDB", () => {
  it("load folds the journal in, writes the result back, and clears this client's entries only", async () => {
    const p = new IdbPersist(indexedDB, "journal-load");
    await p.save("b", state({ next: 2 }));
    await p.savePending("b", [tx(2), tx(3)]);
    await p.savePending("b", [tx(7, "Edit", "other")]);
    await p.savePending("c", [tx(2)]);
    expect(parsed((await p.load("b"))!).next_cseq).toBe(4);
    // Written back, so a second load sees the same without the journal.
    const again = new IdbPersist(indexedDB, "journal-load");
    expect(parsed((await again.load("b"))!).next_cseq).toBe(4);
    expect(await again.load("nothing")).toBeUndefined();
    // Another client's entries and another board's stay.
    expect(await journalKeys("journal-load")).toEqual([
      ["b", "other", 7],
      ["c", "me", 2],
    ]);
  });

  it("dropPending removes entries below the bound only", async () => {
    const p = new IdbPersist(indexedDB, "journal-drop");
    await p.save("b", state({ next: 0 }));
    await p.savePending("b", [tx(0), tx(1), tx(2)]);
    await p.dropPending("b", "me", 2);
    // 0 and 1 are gone, so the fold stops at the gap before 2.
    expect(parsed((await p.load("b"))!).next_cseq).toBe(0);
    const q = new IdbPersist(indexedDB, "journal-drop-2");
    await q.save("b", state({ next: 0 }));
    await q.savePending("b", [tx(0), tx(1), tx(2)]);
    await q.dropPending("b", "me", 0);
    expect(parsed((await q.load("b"))!).next_cseq).toBe(3);
  });

  it("opens a database from before the journal", async () => {
    await new Promise<void>((ok, err) => {
      const req = indexedDB.open("journal-v1", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("replicas");
      req.onsuccess = () => {
        const t = req.result.transaction("replicas", "readwrite");
        t.objectStore("replicas").put(state({ next: 5 }), "b");
        t.oncomplete = () => {
          req.result.close();
          ok();
        };
      };
      req.onerror = () => err(req.error);
    });
    const p = new IdbPersist(indexedDB, "journal-v1");
    expect(parsed((await p.load("b"))!).next_cseq).toBe(5);
    await p.savePending("b", [tx(5)]);
    expect(parsed((await p.load("b"))!).next_cseq).toBe(6);
  });
});

// ---- the session over the real server ------------------------------------------------------

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
const move = (id: RecordId, x: number): Op[] => [{ Set: { id, value: { PlayerPos: { x, y: 0 } } } }];
const pos = (s: BoardSession, id: RecordId) => {
  const e = s.records.get(id);
  return e && "PlayerState" in e.record ? e.record.PlayerState.pos.x : undefined;
};
const openSocket = (url: string) => new WebSocket(url, { origin: ORIGIN }) as unknown as SocketLike;

/** Storage whose whole-state saves or journal writes can be held, for ever if the tab dies. */
function stallable(storage: MemoryPersist) {
  const stall = { state: false, journal: false };
  const held: Array<() => void> = [];
  const hold = (go: () => Promise<void>, stalled: boolean) => (stalled ? new Promise<void>((ok) => held.push(() => void go().then(ok))) : go());
  const persist: Persist = {
    load: (k) => storage.load(k),
    save: (k, v) => hold(() => storage.save(k, v), stall.state),
    savePending: (b, txs) => hold(() => storage.savePending(b, txs), stall.journal),
    dropPending: (b, c, n) => storage.dropPending(b, c, n),
  };
  const land = () => {
    stall.state = stall.journal = false;
    for (const f of held.splice(0)) f();
  };
  return { persist, stall, land };
}

async function liveTab() {
  const api = new Api(`http://127.0.0.1:${port}`);
  const { board, owner_token } = await api.createBoard("journal");
  const storage = new MemoryPersist();
  const s = stallable(storage);
  const opts = { wsUrl: `ws://127.0.0.1:${port}/ws`, board, token: owner_token, openSocket, minDelayMs: 50, maxDelayMs: 200 };
  const tab = new BoardSession({ ...opts, persist: s.persist });
  await tab.start();
  expect(await until(() => tab.connection.kind === "live" && storage.data.has(board))).toBe(true);
  const player = [...tab.records].find(([, e]) => "PlayerState" in e.record)![0];
  const observer = new BoardSession({ ...opts, persist: new MemoryPersist() });
  await observer.start();
  expect(await until(() => observer.connection.kind === "live" && pos(observer, player) !== undefined)).toBe(true);
  return { opts, board, storage, ...s, tab, player, observer };
}

it("a live edit is sent once its journal entry lands, not before", async () => {
  const { stall, land, tab, player, observer, storage, board } = await liveTab();
  stall.journal = true;
  tab.edit(move(player, 5));
  await new Promise((r) => setTimeout(r, 400));
  expect(pos(observer, player)).not.toBe(5);
  expect(tab.status).toEqual({ kind: "syncing", pending: 1 });
  land();
  expect(await until(() => tab.status.kind === "saved" && pos(observer, player) === 5)).toBe(true);
  // The lazy whole save follows and drops the entry it now holds.
  expect(await until(() => (storage.journal.get(board)?.size ?? 0) === 0, 3000)).toBe(true);
  expect(tab.problems).toEqual([]);
  tab.stop();
  observer.stop();
});

it("a tab that dies after sending, before its whole state is saved, restores the edits and syncs cleanly", async () => {
  const { opts, stall, storage, board, tab, player, observer } = await liveTab();
  stall.state = true; // no whole save lands from here on
  tab.edit(move(player, 7));
  tab.edit(move(player, 8));
  tab.undo(); // back to 7
  expect(await until(() => tab.status.kind === "saved" && pos(observer, player) === 7)).toBe(true);
  expect(storage.journal.get(board)?.size).toBe(3);
  tab.stop(); // dies; its held saves never land

  const reopened = new BoardSession({ ...opts, persist: storage });
  await reopened.start();
  expect(pos(reopened, player)).toBe(7); // from storage, before Ready
  expect(await until(() => reopened.connection.kind === "live" && reopened.status.kind === "saved")).toBe(true);
  // New edits take new cseqs: a reused one would loop on AckMismatch.
  reopened.edit(move(player, 9));
  expect(await until(() => reopened.status.kind === "saved" && pos(observer, player) === 9)).toBe(true);
  // The undo of 8 was journaled, so 8 can't be redone twice or undone again from stale history.
  reopened.undo(); // undoes 9 (its history is this session's)
  expect(await until(() => reopened.status.kind === "saved" && pos(observer, player) === 7)).toBe(true);
  await new Promise((r) => setTimeout(r, 300));
  expect(reopened.problems).toEqual([]);
  expect(reopened.connection.kind).toBe("live");
  reopened.stop();
  observer.stop();
});
