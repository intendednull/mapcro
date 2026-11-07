// The live board as Solid state: a BoardSession (the source of truth, over the WASM replica)
// mirrored into fine-grained stores for rendering. The UI never writes these stores; it calls
// `edit` and `presence`, and the session's change callback reconciles.

import { createMemo, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import init from "../wasm/mapcro_wasm.js";
import { BoardSession, type Connection, type SocketLike } from "../core/session";
import { IdbPersist, MemoryPersist, type Persist } from "../core/persist";
import type { SaveStatus } from "../core/update";
import type { Entry } from "../gen/Entry";
import type { LinkRole } from "../gen/LinkRole";
import type { Op } from "../gen/Op";
import type { PeerPresence } from "../gen/PeerPresence";
import type { PlayerState } from "../gen/PlayerState";
import type { Presence } from "../gen/Presence";
import type { RecordId } from "../gen/RecordId";
import type { RosterSlot } from "../gen/RosterSlot";
import type { Scene } from "../gen/Scene";

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

function persistence(): Persist {
  try {
    return typeof indexedDB === "undefined" ? new MemoryPersist() : new IdbPersist(indexedDB);
  } catch {
    return new MemoryPersist();
  }
}

export function createBoardState(board: string, token: string) {
  const [records, setRecords] = createStore<Record<RecordId, Entry>>({});
  const [peers, setPeers] = createStore<Record<number, PeerPresence>>({});
  const [status, setStatus] = createSignal<SaveStatus>({ kind: "saved" });
  const [connection, setConnection] = createSignal<Connection>({ kind: "connecting", attempt: 0 });
  const [myPeer, setMyPeer] = createSignal<number | undefined>();
  const [problems, setProblems] = createSignal<string[]>([]);
  const [undoable, setUndoable] = createSignal({ undo: false, redo: false });
  const [lastRole, setLastRole] = createSignal<LinkRole | undefined>();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const session = new BoardSession({
    wsUrl: `${proto}//${location.host}/ws`,
    board,
    token,
    persist: persistence(),
    openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    onChange: (s) => {
      setRecords(reconcile(Object.fromEntries(s.records)));
      setPeers(reconcile(Object.fromEntries([...s.peers].map(([k, v]) => [String(k), v]))));
      setStatus({ ...s.status });
      setConnection({ ...s.connection } as Connection);
      if (s.connection.kind === "live") setLastRole(s.connection.role);
      if (s.connection.kind === "closed") setLastRole(undefined);
      setMyPeer(s.myPeer);
      if (s.canUndo !== undoable().undo || s.canRedo !== undoable().redo) setUndoable({ undo: s.canUndo, redo: s.canRedo });
      if (s.problems.length !== problems().length) setProblems([...s.problems]);
    },
  });

  const live = (kind: string) =>
    Object.entries(records).flatMap(([id, e]) => (!e.deleted && kind in e.record ? [[id, e.record] as const] : []));

  const title = createMemo(() => {
    const m = live("BoardMeta")[0];
    return m && "BoardMeta" in m[1] ? m[1].BoardMeta.title : "";
  });

  const scenes = createMemo(() =>
    live("Scene")
      .flatMap(([id, r]) => ("Scene" in r ? [{ id, scene: r.Scene as Scene }] : []))
      .sort((a, b) => (a.scene.order < b.scene.order ? -1 : a.scene.order > b.scene.order ? 1 : a.id < b.id ? -1 : 1)),
  );

  const roster = createMemo(() =>
    live("RosterSlot")
      .flatMap(([id, r]) => ("RosterSlot" in r ? [{ id, slot: r.RosterSlot }] : []))
      .sort((a, b) => (a.slot.team === b.slot.team ? a.slot.slot - b.slot.slot : a.slot.team === "Amber" ? -1 : 1)),
  );

  const playersIn = (scene: RecordId | undefined): Player[] =>
    scene === undefined
      ? []
      : live("PlayerState").flatMap(([id, r]) =>
          "PlayerState" in r && r.PlayerState.scene === scene ? [{ id, state: r.PlayerState }] : [],
        );

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
    problems,
    title,
    scenes,
    roster,
    playersIn,
    role,
    canEdit: () => {
      const r = role();
      return r === "owner" || r === "edit";
    },
    edit: (ops: Op[]) => session.edit(ops),
    undo: () => session.undo(),
    redo: () => session.redo(),
    canUndo: () => undoable().undo,
    canRedo: () => undoable().redo,
    /** Live records of one kind in one scene. */
    inScene: <K extends string>(kind: K, scene: RecordId | undefined) =>
      scene === undefined ? [] : live(kind).filter(([, r]) => (Object.values(r)[0] as { scene?: string }).scene === scene),
    presence: (p: Partial<Presence>) => session.setPresence(p),
    peerList: () => Object.values(peers).filter((p) => p.state !== null),
    start: async () => {
      await loadWasm();
      await session.start();
    },
    stop: () => session.stop(),
  };
}
