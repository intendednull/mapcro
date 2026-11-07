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
import type { Persist } from "./persist";
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
  /** Backoff bounds, overridable for tests. */
  minDelayMs?: number;
  maxDelayMs?: number;
}

const FINAL: CloseReason[] = ["unauthorized", "revoked"];

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
    name: "", color: 0, scene: null, floor: "surface", view: null, cursor: null, laser: [], drag: null, focus: null, following: null,
  };
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceSentAt = 0;

  private replica: BoardReplica | undefined;
  /** Set from the link's role on Ready. */
  private readOnly = false;
  private socket: SocketLike | undefined;
  private live = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Saves and sends run in order through this chain, so frames leave in cseq order. */
  private chain: Promise<void> = Promise.resolve();
  private saveSoon: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly o: SessionOptions) {}

  async start(): Promise<void> {
    const saved = await this.o.persist.load(this.o.board);
    if (saved !== undefined) {
      this.replica = BoardReplica.restore(saved);
      this.resetRecords(this.replica.view());
    }
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

  /** Update what others see of us. Sent at most every 50 ms; the latest state always wins. */
  setPresence(patch: Partial<Presence>): void {
    this.presence = { ...this.presence, ...patch };
    if (this.presenceTimer !== undefined) return;
    const wait = Math.max(0, this.presenceSentAt + 50 - Date.now());
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
    const state = r.state();
    const sock = this.socket;
    // Durable first, then send. Frames go only on the socket that is live now; if it drops,
    // the next `connect()` resends all pending work anyway.
    this.chain = this.chain
      .then(() => this.o.persist.save(this.o.board, state))
      .then(() => {
        if (sock === this.socket && this.live) for (const f of u.frames) this.send(f);
      })
      .catch((e) => {
        this.problems.push(`could not save locally: ${e}`);
      });
  }

  private apply(json: string): Update {
    const u = JSON.parse(json) as Update;
    for (const [id, entry] of u.changed) {
      if (entry) this.records.set(id, entry);
      else this.records.delete(id);
    }
    this.status = u.status;
    this.canUndo = u.canUndo;
    this.canRedo = u.canRedo;
    this.o.onChange?.(this);
    return u;
  }

  private resetRecords(viewJson: string) {
    this.records.clear();
    for (const [id, entry] of JSON.parse(viewJson) as Array<[RecordId, Entry]>) this.records.set(id, entry);
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
        for (const f of u.frames) this.send(f);
        this.live = true;
        this.readOnly = frame.role === "view";
        this.peers.clear(); // the room sends everyone present right after Ready
        this.myPeer = frame.peer;
        this.send({ t: "presence", state: this.presence });
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
        this.o.onChange?.(this);
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

  /** Confirmed progress is worth saving too (a reload then needs less catch-up), but lazily. */
  private persistSoon() {
    clearTimeout(this.saveSoon);
    this.saveSoon = setTimeout(() => {
      const r = this.replica;
      if (!r) return;
      const state = r.state();
      this.chain = this.chain.then(() => this.o.persist.save(this.o.board, state)).catch(() => {});
    }, 300);
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
