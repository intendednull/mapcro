// The live board as Solid state: a BoardSession (the source of truth, over the WASM replica)
// mirrored into fine-grained stores for rendering. The UI never writes these stores; it calls
// `edit` and `presence`, and the session's change callback reconciles.

import { type Accessor, type Setter, batch, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import init, { buildId } from "../wasm/mapcro_wasm.js";
import { outdatedAction } from "../core/reload";
import { BoardSession, type Connection, type SocketLike } from "../core/session";
import { IdbPersist, MemoryPersist, type Persist } from "../core/persist";
import type { SaveStatus } from "../core/update";
import type { BoardMeta } from "../gen/BoardMeta";
import type { Entry } from "../gen/Entry";
import type { LinkRole } from "../gen/LinkRole";
import type { Op } from "../gen/Op";
import type { PeerPresence } from "../gen/PeerPresence";
import type { PlayerState } from "../gen/PlayerState";
import type { Presence } from "../gen/Presence";
import type { RecordId } from "../gen/RecordId";
import type { RosterSlot } from "../gen/RosterSlot";
import type { Scene } from "../gen/Scene";
import type { Via } from "../gen/Via";
import { flatten } from "./tree";

let wasm: Promise<unknown> | undefined;
export const loadWasm = () => (wasm ??= init());

export interface Slot {
  id: RecordId;
  slot: RosterSlot;
}

export interface Player {
  id: RecordId;
  state: PlayerState;
}

export type BoardState = ReturnType<typeof createBoardState>;

export function persistence(): Persist {
  try {
    return typeof indexedDB === "undefined" ? new MemoryPersist() : new IdbPersist(indexedDB);
  } catch {
    return new MemoryPersist();
  }
}

/** A record's kind: its one key (`{ "Stroke": {...} }` is a Stroke). */
const kindOf = (e: Entry) => Object.keys(e.record)[0] ?? "";

/** A row in a list: a stable object per record id, whose `r` reads the live record. */
export interface Row<T> {
  readonly id: RecordId;
  readonly r: T;
}

export interface BoardStateOptions {
  /** Opened as a session's tab (sessions.md §3.4): `token` is the session's. */
  via?: Via;
  /** You made an undoable edit (the page's one history, session/history.ts). */
  onEdit?: () => void;
}

export function createBoardState(board: string, token: string, opts: BoardStateOptions = {}) {
  // Records live in a store keyed by id, updated only where the replica says something changed
  // (perf report 2026-11-07, findings 1 and 2): a new stroke touches one key, not the board.
  const [records, setRecords] = createStore<Record<RecordId, Entry>>({});
  /** Records this tab's user created (through `edit`, this page load). */
  const made = new Set<RecordId>();
  const [peers, setPeers] = createStore<Record<string, PeerPresence>>({});
  const [status, setStatus] = createSignal<SaveStatus>({ kind: "saved" });
  const [connection, setConnection] = createSignal<Connection>({ kind: "connecting", attempt: 0 });
  const [myPeer, setMyPeer] = createSignal<number | undefined>();
  const [current, setCurrent] = createSignal(false);
  /** This page's joins of the room (each Ready) and when the last was: peer ids from an earlier
   * one name nobody now (they restart with the server), so a follow re-finds its presenter. */
  const [joined, setJoined] = createSignal({ n: 0, at: 0 });
  const [problems, setProblems] = createSignal<string[]>([]);
  const [undoable, setUndoable] = createSignal({ undo: false, redo: false });
  const [lastRole, setLastRole] = createSignal<LinkRole | undefined>();

  // Live ids per kind, each its own signal: a new stroke wakes what lists strokes, and nothing
  // that lists heroes, scenes or the roster.
  const kinds = new Map<string, { get: Accessor<RecordId[]>; set: Setter<RecordId[]> }>();
  const kindSignal = (kind: string) => {
    let k = kinds.get(kind);
    if (!k) {
      const [get, set] = createSignal<RecordId[]>([]);
      k = { get, set };
      kinds.set(kind, k);
    }
    return k;
  };
  const known = new Map<RecordId, { kind: string; live: boolean }>();

  // Stable rows: one object per record id, so keyed lists keep their DOM.
  const rows = new Map<string, Row<unknown>>();
  function row<T>(kind: string, id: RecordId): Row<T> {
    const key = `${kind}\u0000${id}`;
    let w = rows.get(key);
    if (!w) {
      w = {
        id,
        get r() {
          const e = records[id];
          return e ? (e.record as unknown as Record<string, unknown>)[kind] : undefined;
        },
      };
      rows.set(key, w);
    }
    return w as Row<T>;
  }

  const applyChanged = (changed: Array<[RecordId, Entry | null]>, reset: boolean) =>
    batch(() => {
      const touched = new Set<string>();
      if (reset) {
        const all = Object.fromEntries(changed.filter(([, e]) => e).map(([id, e]) => [id, e!]));
        setRecords(reconcile(all));
        known.clear();
        for (const k of kinds.keys()) touched.add(k);
      } else {
        for (const [id, e] of changed) setRecords(id, e ? reconcile(e) : undefined!);
      }
      for (const [id, e] of changed) {
        const before = known.get(id);
        const kind = e ? kindOf(e) : (before?.kind ?? "");
        const live = !!e && !e.deleted;
        if (!before || before.live !== live) touched.add(kind);
        if (e) known.set(id, { kind, live });
        else known.delete(id);
      }
      for (const kind of touched) {
        const ids: RecordId[] = [];
        for (const [id, k] of known) if (k.kind === kind && k.live) ids.push(id);
        ids.sort();
        kindSignal(kind).set(ids);
      }
    });

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const session = new BoardSession({
    wsUrl: `${proto}//${location.host}/ws`,
    board,
    token,
    ...(opts.via ? { via: opts.via } : {}),
    persist: persistence(),
    // A deploy happened under this tab: reload once to the new build (edits are kept in
    // storage); if that didn't help, the board offers the reload.
    onOutdated: () => {
      if (typeof sessionStorage !== "undefined" && outdatedAction(buildId(), sessionStorage) === "reload") location.reload();
    },
    openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    onRecords: applyChanged,
    onPeers: (changed, reset) =>
      batch(() => {
        if (reset) {
          setPeers(reconcile({}));
          setJoined((j) => ({ n: j.n + 1, at: Date.now() }));
        }
        for (const p of changed) setPeers(String(p.peer), p.state ? reconcile(p) : undefined!);
      }),
    onChange: (s) => {
      // Status only: records and peers arrive through their own callbacks.
      const st = s.status;
      const cur = status();
      if (st.kind !== cur.kind || ("pending" in st ? st.pending : 0) !== ("pending" in cur ? cur.pending : 0)) setStatus({ ...st });
      const c = s.connection;
      if (JSON.stringify(c) !== JSON.stringify(connection())) setConnection({ ...c } as Connection);
      if (c.kind === "live") setLastRole(c.role);
      if (c.kind === "closed") setLastRole(undefined);
      setMyPeer(s.myPeer);
      setCurrent(s.current());
      if (s.canUndo !== undoable().undo || s.canRedo !== undoable().redo) setUndoable({ undo: s.canUndo, redo: s.canRedo });
      if (s.problems.length !== problems().length) setProblems([...s.problems]);
    },
  });

  /** Live records of a kind, as stable rows (ordered by id). */
  function live<T>(kind: string): Row<T>[] {
    return kindSignal(kind).get().map((id) => row<T>(kind, id));
  }

  const title = createMemo(() => live<BoardMeta>("BoardMeta")[0]?.r?.title ?? "");
  /** The board's own record (presence `focus` on it, with a scene: that scene's note, not yet made). */
  const metaId = () => live<BoardMeta>("BoardMeta")[0]?.id;

  // Player's live annotation layer is a scene, but never one of the board's scenes (spec §6b).
  // The scenes form a tree (`Scene.parent`): listed and flipped depth-first, siblings by order.
  // A parent that's gone resolves through its own parent (a deleted scene keeps its record).
  const sceneTree = createMemo(() => {
    const list = live<Scene>("Scene")
      .filter((w) => !w.r.live)
      .map((w) => sceneRow(w.id));
    const up = (id: RecordId) => {
      const e = records[id];
      return e && "Scene" in e.record ? (e.record.Scene.parent ?? null) : null;
    };
    return flatten(
      list.map((row) => ({ id: row.id, order: row.scene.order, parent: row.scene.parent, row })),
      up,
    ).map((r) => ({ scene: r.scene.row, depth: r.depth, parent: r.parent, hasChildren: r.hasChildren }));
  });
  const scenes = createMemo(() => sceneTree().map((r) => r.scene), undefined, { equals: sameItems });

  const roster = createMemo(() =>
    live<RosterSlot>("RosterSlot")
      .map((w) => slotRow(w.id))
      .sort((a, b) => (a.slot.team === b.slot.team ? a.slot.slot - b.slot.slot : a.slot.team === "Amber" ? -1 : 1)),
  );

  // Rows in the shapes the components use, also one object per id.
  const named = new Map<string, unknown>();
  function sceneRow(id: RecordId): { id: RecordId; scene: Scene } {
    const k = `scene\u0000${id}`;
    if (!named.has(k)) named.set(k, { id, get scene() { return (records[id]?.record as { Scene: Scene }).Scene; } });
    return named.get(k) as { id: RecordId; scene: Scene };
  }
  function slotRow(id: RecordId): Slot {
    const k = `slot\u0000${id}`;
    if (!named.has(k)) named.set(k, { id, get slot() { return (records[id]?.record as { RosterSlot: RosterSlot }).RosterSlot; } });
    return named.get(k) as Slot;
  }
  function playerRow(id: RecordId): Player {
    const k = `player\u0000${id}`;
    if (!named.has(k)) named.set(k, { id, get state() { return (records[id]?.record as { PlayerState: PlayerState }).PlayerState; } });
    return named.get(k) as Player;
  }

  // Players by scene: one memo per scene, so a scene's list reruns only when its players change.
  const playerLists = new Map<RecordId, Accessor<Player[]>>();
  const playersIn = (scene: RecordId | undefined): Player[] => {
    if (scene === undefined) return [];
    let m = playerLists.get(scene);
    if (!m) {
      m = createRoot(() =>
        createMemo(() => live<PlayerState>("PlayerState").filter((w) => w.r?.scene === scene).map((w) => playerRow(w.id)), undefined, {
          equals: sameItems,
        }),
      );
      playerLists.set(scene, m);
    }
    return m();
  };

  /** Live records of one kind in one scene, as stable rows. */
  const rowsIn = <T extends { scene: RecordId }>(kind: string, scene: RecordId | undefined): Row<T>[] =>
    scene === undefined ? [] : live<T>(kind).filter((w) => w.r?.scene === scene);

  // The role a link had when it last connected. It holds while offline, so editing offline
  // works (the edits wait on this device); a link the server refused for good has none.
  // (A signal set from the session's change callback, not a side effect of reading: an earlier
  // version updated a plain variable inside this getter, which depended on who read it when.)
  const role = () => lastRole();

  return {
    board,
    token,
    session,
    records,
    peers,
    status,
    connection,
    myPeer,
    joined,
    problems,
    title,
    metaId,
    scenes,
    sceneTree,
    /** Player's live annotation layer for a match, if it exists (spec §6b; player/live.ts). */
    liveScene: (match: number | undefined) =>
      match === undefined ? undefined : live<Scene>("Scene").find((w) => w.r.live && w.r.source?.match_id === match)?.id,
    /** Every match's live layer. */
    liveScenes: () => live<Scene>("Scene").flatMap((w) => (w.r.live ? [{ id: w.id, match: w.r.source?.match_id }] : [])),
    roster,
    playersIn,
    role,
    canEdit: () => {
      const r = role();
      return r === "owner" || r === "edit";
    },
    edit: (ops: Op[]) => {
      for (const op of ops) if ("Create" in op) made.add(op.Create.id);
      const ok = session.edit(ops);
      if (ok) opts.onEdit?.();
      return ok;
    },
    /** Whether this tab's user made the record (an `edit` this page load): never stale ink. */
    madeHere: (id: RecordId) => made.has(id),
    /** An edit that isn't the user's to undo: Player's live layer (spec §6b). */
    editSilent: (ops: Op[]) => session.editSilent(ops),
    /** A silent edit of records anyone would make the same (the live layer): losing the race
     * to make them is not a problem (session.ts `ensure`). */
    ensure: (ops: Op[]) => session.ensure(ops),
    /** This copy has everything logged before it connected (session.ts `current`). */
    current,
    undo: () => session.undo(),
    redo: () => session.redo(),
    canUndo: () => undoable().undo,
    canRedo: () => undoable().redo,
    rowsIn,
    /** Live records of one kind in one scene, as `[id, record]` pairs (the record is live). */
    inScene: <K extends string>(kind: K, scene: RecordId | undefined) =>
      rowsIn<{ scene: RecordId }>(kind, scene).map((w) => [w.id, records[w.id]!.record] as const),
    presence: (p: Partial<Presence>) => session.setPresence(p),
    peerList: () => Object.values(peers).filter((p) => p.state !== null),
    start: async () => {
      await loadWasm();
      await session.start();
    },
    /** The board unmounted: its session ends for good. (The per-scene memos above read only
     * this board's own signals, which nothing writes after: they go with it.) */
    stop: () => session.end(),
  };
}

/** Memo equality for lists of stable rows: the same rows in the same order. */
function sameItems<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
