// A session's own connection (sessions.md §4.1): a BoardSession on the session document, which
// must be a session (`expect: "session"`, §3.6), mirrored into signals for the strip. Its edits
// are marks in the page's one undo history (§7.2).

import { createMemo, createSignal } from "solid-js";
import { buildId } from "../wasm/mapcro_wasm.js";
import { BoardSession, type Connection, type SocketLike } from "../core/session";
import { outdatedAction } from "../core/reload";
import type { Persist } from "../core/persist";
import type { Entry } from "../gen/Entry";
import type { LinkRole } from "../gen/LinkRole";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import { loadWasm, persistence } from "../board/state";
import type { UndoHistory } from "./history";
import { type TabRow, liveTabs, sessionMeta } from "./tabs";

/** The history's name for the session document's steps (a board's is its id). */
export const SESSION_SIDE = "session";

export interface SessionStateOptions {
  wsUrl?: string;
  openSocket?: (url: string) => SocketLike;
  persist?: Persist;
  minDelayMs?: number;
  maxDelayMs?: number;
}

export function createSessionState(id: string, token: string, history: UndoHistory, o: SessionStateOptions = {}) {
  const [records, setRecords] = createSignal<Map<RecordId, Entry>>(new Map(), { equals: false });
  const [connection, setConnection] = createSignal<Connection>({ kind: "connecting", attempt: 0 });
  const [role, setRole] = createSignal<LinkRole | undefined>();
  const [undoable, setUndoable] = createSignal({ undo: false, redo: false });
  const [problems, setProblems] = createSignal<string[]>([]);
  const [current, setCurrent] = createSignal(false);
  const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
  const session = new BoardSession({
    wsUrl: o.wsUrl ?? `${proto}//${location.host}/ws`,
    board: id,
    token,
    expect: "session",
    persist: o.persist ?? persistence(),
    openSocket: o.openSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike),
    ...(o.minDelayMs !== undefined ? { minDelayMs: o.minDelayMs } : {}),
    ...(o.maxDelayMs !== undefined ? { maxDelayMs: o.maxDelayMs } : {}),
    onOutdated: () => {
      if (typeof sessionStorage !== "undefined" && outdatedAction(buildId(), sessionStorage) === "reload") location.reload();
    },
    onRecords: () => setRecords(session.records),
    onChange: (s) => {
      const c = s.connection;
      if (JSON.stringify(c) !== JSON.stringify(connection())) setConnection({ ...c } as Connection);
      if (c.kind === "live") setRole(c.role);
      if (c.kind === "closed") setRole(undefined);
      if (s.canUndo !== undoable().undo || s.canRedo !== undoable().redo) setUndoable({ undo: s.canUndo, redo: s.canRedo });
      if (s.problems.length !== problems().length) setProblems([...s.problems]);
      setCurrent(s.current());
    },
  });
  const tabs = createMemo<TabRow[]>(() => liveTabs(records()), [], {
    equals: (a, b) => a.length === b.length && a.every((t, i) => JSON.stringify(t) === JSON.stringify(b[i])),
  });
  const meta = createMemo(() => sessionMeta(records()));
  const canEdit = () => role() === "owner" || role() === "edit";
  const detach = history.attach(SESSION_SIDE, {
    canUndo: () => undoable().undo,
    canRedo: () => undoable().redo,
    undo: () => session.undo(),
    redo: () => session.redo(),
  });
  return {
    id,
    token,
    session,
    connection,
    role,
    canEdit,
    tabs,
    title: () => meta()?.title ?? "",
    metaId: () => meta()?.id,
    problems,
    /**
     * The tab list can be trusted to pick from: this copy has everything logged before it
     * connected (a fresh one gets a snapshot, then the entries after it), or it's offline on what
     * it stored. Until then a `?tab=` naming a recent tab would look gone.
     */
    settled: () => meta() !== undefined && (current() || connection().kind === "waiting"),
    /** An undoable strip edit: one step in the page's history. */
    edit(ops: Op[]): boolean {
      if (!ops.length) return false;
      const ok = session.edit(ops);
      if (ok) history.edited(SESSION_SIDE);
      return ok;
    },
    async start() {
      await loadWasm();
      await session.start();
    },
    stop() {
      detach();
      session.end();
    },
  };
}

export type SessionState = ReturnType<typeof createSessionState>;
