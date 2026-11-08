// A live connection to one board: authenticates, keeps the replica in step with the server,
// reconnects with backoff, and persists pending work before sending it.

import type { Entry } from "../gen/Entry";
import type { LinkRole } from "../gen/LinkRole";
import type { CloseReason } from "../gen/CloseReason";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import type { WireIn } from "../gen/WireIn";
import type { WireOut } from "../gen/WireOut";
import type { PeerPresence } from "../gen/PeerPresence";
import type { Presence } from "../gen/Presence";
import { BoardReplica, newClientId, newClientSecret } from "../wasm/mapcro_wasm.js";
import { MemoryPersist, type Persist } from "./persist";
import type { SaveStatus, Update } from "./update";

/** The subset of the WebSocket API the session uses (browser WebSocket or the `ws` package). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type Connection =
  | { kind: "connecting"; attempt: number }
  | { kind: "live"; role: LinkRole }
  | { kind: "waiting"; retryInMs: number }
  /** The server refused this link for good (unauthorized, revoked). */
  | { kind: "closed"; reason: CloseReason };

export interface SessionOptions {
  wsUrl: string;
  board: string;
  token: string;
  persist: Persist;
  openSocket: (url: string) => SocketLike;
  onChange?: (s: BoardSession) => void;
  /**
   * Exactly the records that changed (`null`: gone), or the whole board when `reset`. Lets a UI
   * touch only what changed instead of re-reading every record (perf report 2026-11-07).
   */
  onRecords?: (changed: Array<[RecordId, Entry | null]>, reset: boolean) => void;
  /** The peers in a presence batch (a `null` state: gone), or `reset` when the room restarts. */
  onPeers?: (changed: PeerPresence[], reset: boolean) => void;
  /** Backoff bounds, overridable for tests. */
  minDelayMs?: number;
  maxDelayMs?: number;
}

const FINAL: CloseReason[] = ["unauthorized", "revoked"];

/**
 * Presence send cadence. The server coalesces presence in 50 ms batches, the latest state per
 * peer winning. Sent every 50 ms, arrival jitter put two of one person's updates in one batch
 * often (11 to 22% of a remote drag's steps were 100 ms in the 2026-11-07 perf runs): the first
 * was dropped and others saw the drag jump. A little over the batch, no two land in one.
 */
export const PRESENCE_MS = 60;

/**
 * Reconnect resend pacing. The server allows a burst of 300 frames per socket, then 60/s
 * (crates/server/src/ws.rs), and closes a faster sender as abuse. Pending work after a long
 * offline stretch can exceed that, so the first RESEND_BURST go at once and the rest at
 * RESEND_PER_SEC, which leaves room for presence (at most 1000 / PRESENCE_MS per second) under
 * the steady rate (soak 2026-11-07, long-offline-abuse).
 */
const RESEND_BURST = 200;
const RESEND_PER_SEC = 30;

/** Where a link's role is remembered, per board and per link (one device may hold several). */
async function roleKey(board: string, token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hex = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${board}\u0000role\u0000${hex}`;
}

export class BoardSession {
  readonly records = new Map<RecordId, Entry>();
  status: SaveStatus = { kind: "saved" };
  connection: Connection = { kind: "connecting", attempt: 0 };
  canUndo = false;
  canRedo = false;
  /** Local refusals and server rejections, newest last, for the UI to explain. */
  readonly problems: string[] = [];
  /** Everyone else in the room, by peer id. Roles are stamped by the server. */
  readonly peers = new Map<number, PeerPresence>();
  /** Our own peer id in this room (from Ready); others' `following` may point at it. */
  myPeer: number | undefined;

  private presence: Presence = {
    name: "", color: 0, scene: null, floor: "surface", view: null, cursor: null, laser: [], drag: null, drag_group: [], focus: null, following: null,
  };
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceSentAt = 0;

  private replica: BoardReplica | undefined;
  /**
   * Whether this link may edit. Read-only until the role is known: remembered from an earlier
   * Ready on this device, or learned from this one. A restored view replica that accepted an edit
   * before Ready would resend it forever (soak 2026-11-07, view-edit-before-ready).
   */
  private readOnly = true;
  private roleStore: string | undefined;
  private socket: SocketLike | undefined;
  private live = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Saves and sends run in order through this chain, so frames leave in cseq order. */
  private chain: Promise<void> = Promise.resolve();
  /** Whole-state saves, one at a time and in the order taken, so storage never goes back. */
  private saves: Promise<void> = Promise.resolve();
  /** The next cseq after every transaction journaled so far, and whose they are. */
  private journaled = 0;
  private client: string | undefined;
  private saveSoon: ReturnType<typeof setTimeout> | undefined;
  private dirtySince: number | undefined;
  /** Local storage couldn't be opened; this session keeps everything in memory. */
  storageUnavailable = false;

  constructor(private o: SessionOptions) {}

  async start(): Promise<void> {
    this.roleStore = await roleKey(this.o.board, this.o.token);
    let saved: string | undefined;
    let role: string | undefined;
    try {
      saved = await this.o.persist.load(this.o.board);
      role = await this.o.persist.load(this.roleStore);
    } catch (e) {
      // Local storage can't be opened (another tab holds an older version open, private mode,
      // quota). Connect anyway on memory only, and say so: edits still sync, but a reload before
      // they're acked would lose them.
      this.problems.push(`local storage unavailable: ${e instanceof Error ? e.message : e}`);
      this.storageUnavailable = true;
      this.o = { ...this.o, persist: new MemoryPersist() };
    }
    if (saved !== undefined) {
      this.replica = BoardReplica.restore(saved);
      this.resetRecords(this.replica.view());
    }
    this.readOnly = role !== "owner" && role !== "edit";
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.dropSocket();
    // The save indicator must say "offline", never "syncing", once nothing is connected.
    this.markOffline();
  }

  edit(ops: Op[]): void {
    this.local((r) => r.edit(JSON.stringify(ops)));
  }

  /** Update what others see of us. Sent at most every PRESENCE_MS; the latest state always wins. */
  setPresence(patch: Partial<Presence>): void {
    this.presence = { ...this.presence, ...patch };
    if (this.presenceTimer !== undefined) return;
    const wait = Math.max(0, this.presenceSentAt + PRESENCE_MS - Date.now());
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      this.presenceSentAt = Date.now();
      if (this.live) this.send({ t: "presence", state: this.presence });
    }, wait);
  }

  /** People this session may follow: anyone with edit rights (spec §8). */
  followable(): PeerPresence[] {
    return [...this.peers.values()].filter((p) => p.state !== null && p.role !== "view");
  }

  undo(): void {
    this.local((r) => r.undo());
  }

  redo(): void {
    this.local((r) => r.redo());
  }

  private local(call: (r: BoardReplica) => string): void {
    const r = this.replica;
    if (!r) return; // not loaded yet: the UI is read-only until the first Ready
    if (this.readOnly) {
      // View links never edit; the server would treat it as abuse and drop the connection.
      this.problems.push("this link is view-only");
      return;
    }
    const u = this.apply(call(r));
    if (u.refused) this.problems.push(u.refused);
    if (u.frames.length === 0) {
      // Offline (or refused): nothing to send. An offline edit is saved whole, and the
      // reconnect's resend waits for it (the save queue runs in order).
      if (u.changed.length) this.saveState().catch((e) => this.problems.push(`could not save locally: ${e}`));
      return;
    }
    const sock = this.socket;
    const txs = u.frames.flatMap((f) => (f.t === "msg" && "Submit" in f.msg ? [f.msg.Submit] : []));
    const journal = this.o.persist.savePending;
    // Durable first, then send. Frames go only on the socket that is live now; if it drops,
    // the next `connect()` resends all pending work anyway. With a journal, the durable part is
    // the transaction alone, and its write starts now; the whole state follows lazily.
    let durable: Promise<void>;
    if (journal && txs.length === u.frames.length) {
      durable = journal.call(this.o.persist, this.o.board, txs).catch(async (e) => {
        // Never send past a hole in the journal: save everything whole first.
        this.problems.push(`could not journal locally: ${e}`);
        await this.saveState();
      });
      for (const tx of txs) {
        this.journaled = Math.max(this.journaled, tx.cseq + 1);
        this.client = tx.client;
      }
      this.persistSoon();
    } else durable = this.saveState();
    this.chain = this.chain
      .then(() => durable)
      .then(() => {
        if (sock === this.socket && this.live) for (const f of u.frames) this.send(f);
      })
      .catch((e) => {
        this.problems.push(`could not save locally, reconnecting: ${e}`);
        if (sock === this.socket) this.retry();
      });
  }

  /**
   * Save the whole replica state as it is now, behind any earlier whole save, then drop the
   * journal entries it holds. Resolves once the state is durable.
   */
  private saveState(): Promise<void> {
    const r = this.replica;
    if (!r) return Promise.resolve();
    const state = r.state();
    const below = this.journaled;
    const client = this.client;
    this.dirtySince = undefined;
    const saved = this.saves.then(() => this.o.persist.save(this.o.board, state));
    this.saves = saved
      .then(() => (client !== undefined && below > 0 ? this.o.persist.dropPending?.(this.o.board, client, below) : undefined))
      .catch(() => {});
    return saved;
  }

  private apply(json: string): Update {
    const u = JSON.parse(json) as Update;
    for (const [id, entry] of u.changed) {
      if (entry) this.records.set(id, entry);
      else this.records.delete(id);
    }
    if (u.changed.length) this.o.onRecords?.(u.changed, false);
    this.status = u.status;
    this.canUndo = u.canUndo;
    this.canRedo = u.canRedo;
    this.o.onChange?.(this);
    return u;
  }

  private resetRecords(viewJson: string) {
    this.records.clear();
    const all = JSON.parse(viewJson) as Array<[RecordId, Entry]>;
    for (const [id, entry] of all) this.records.set(id, entry);
    this.o.onRecords?.(all, true);
  }

  private send(frame: WireIn) {
    this.socket?.send(JSON.stringify(frame));
  }

  private open() {
    if (this.stopped) return;
    this.connection = { kind: "connecting", attempt: this.attempt };
    this.o.onChange?.(this);
    const sock = this.o.openSocket(this.o.wsUrl);
    this.socket = sock;
    this.live = false;
    sock.onopen = () => {
      const known_seq = this.replica ? this.replica.lastSeq() : null;
      sock.send(JSON.stringify({ t: "auth", board: this.o.board, token: this.o.token, known_seq } satisfies WireIn));
    };
    sock.onmessage = (ev) => {
      if (sock !== this.socket) return;
      try {
        this.onFrame(JSON.parse(String(ev.data)) as WireOut);
      } catch (e) {
        // A protocol error (gap, ack mismatch): start over on a fresh connection. Pending work
        // is untouched, so nothing is lost.
        this.problems.push(`protocol error, reconnecting: ${e}`);
        this.retry();
      }
    };
    sock.onclose = () => {
      if (sock === this.socket) this.retry();
    };
    sock.onerror = () => {};
  }

  private onFrame(frame: WireOut) {
    switch (frame.t) {
      case "ready": {
        if (!this.replica) {
          if (!frame.base) throw new Error("server sent no base for a new replica");
          this.replica = new BoardReplica(newClientId(), newClientSecret(), JSON.stringify(frame.base));
          this.resetRecords(this.replica.view());
        }
        const u = this.apply(this.replica.connect());
        // The hello resends every pending transaction, so it goes through the save chain like any
        // edit: an edit made offline may not be durable yet, and the server must never ack what a
        // reload would forget (soak 2026-11-07, resend-before-durable). Later edits queue behind
        // this on the chain, so frames still leave in cseq order.
        const sock = this.socket;
        const saved = this.saveState();
        const role = frame.role;
        this.chain = this.chain
          .then(() => saved)
          .then(() => (this.roleStore ? this.o.persist.save(this.roleStore, role) : undefined))
          .then(async () => {
            for (let i = 0; i < u.frames.length; i++) {
              if (sock !== this.socket) return;
              if (i >= RESEND_BURST) await new Promise((r) => setTimeout(r, 1000 / RESEND_PER_SEC));
              if (sock !== this.socket) return;
              this.send(u.frames[i]!);
              if (i === 0) this.send({ t: "presence", state: this.presence });
            }
          })
          .catch((e) => {
            this.problems.push(`could not save locally, reconnecting: ${e}`);
            if (sock === this.socket) this.retry();
          });
        this.live = true;
        this.readOnly = frame.role === "view";
        this.peers.clear(); // the room sends everyone present right after Ready
        this.o.onPeers?.([], true);
        this.myPeer = frame.peer;
        this.attempt = 0;
        this.connection = { kind: "live", role: frame.role };
        this.o.onChange?.(this);
        return;
      }
      case "msg": {
        const r = this.replica;
        if (!r) throw new Error("message before ready");
        this.apply(r.receive(JSON.stringify(frame)));
        const m = frame.msg;
        if (typeof m === "object" && "Rejected" in m) this.problems.push(`rejected: ${JSON.stringify(m.Rejected.reason)}`);
        this.persistSoon();
        return;
      }
      case "presence": {
        for (const p of frame.peers) {
          if (p.state) this.peers.set(p.peer, p);
          else this.peers.delete(p.peer);
        }
        if (this.o.onPeers) this.o.onPeers(frame.peers, false);
        else this.o.onChange?.(this);
        return;
      }
      case "closed": {
        if (FINAL.includes(frame.reason)) {
          this.stopped = true;
          this.connection = { kind: "closed", reason: frame.reason };
          this.dropSocket();
          this.markOffline();
          this.o.onChange?.(this);
        } else {
          this.retry();
        }
        return;
      }
    }
  }

  /**
   * Save the whole state lazily: 300 ms after things go quiet, and at least every 2 s while they
   * don't. Confirmed progress means less catch-up after a reload; after journaled edits it keeps
   * the journal short.
   */
  private persistSoon() {
    const now = Date.now();
    this.dirtySince ??= now;
    clearTimeout(this.saveSoon);
    this.saveSoon = setTimeout(
      () => {
        this.saveSoon = undefined;
        this.saveState().catch(() => {});
      },
      Math.max(0, Math.min(300, this.dirtySince + 2000 - now)),
    );
  }

  private markOffline() {
    if (this.replica) this.apply(this.replica.disconnect());
  }

  private dropSocket() {
    const s = this.socket;
    this.socket = undefined;
    this.live = false;
    if (s) {
      s.onclose = null;
      s.onmessage = null;
      s.close();
    }
  }

  private retry() {
    this.dropSocket();
    this.markOffline();
    if (this.stopped) return;
    const min = this.o.minDelayMs ?? 250;
    const max = this.o.maxDelayMs ?? 10_000;
    const base = Math.min(max, min * 2 ** this.attempt);
    const delay = Math.round(base * (0.5 + Math.random()));
    this.attempt += 1;
    this.connection = { kind: "waiting", retryInMs: delay };
    this.o.onChange?.(this);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), delay);
  }
}
