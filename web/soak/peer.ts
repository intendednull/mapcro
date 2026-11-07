// One simulated person: a real BoardSession over the real WASM replica, a real WebSocket to the
// real server, and IndexedDB (fake-indexeddb) as the tab's storage. The socket is tapped, not
// changed: every frame is recorded on its way through, which is how the soak knows what each
// peer saw acknowledged, rejected or broadcast.

import WebSocket from "ws";
import { IdbPersist, type Persist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import type { Presence } from "../src/gen/Presence";
import type { PeerPresence } from "../src/gen/PeerPresence";
import type { RecordId } from "../src/gen/RecordId";
import type { WireIn } from "../src/gen/WireIn";
import type { WireOut } from "../src/gen/WireOut";
import { build, live, sceneOf, scenes } from "./actions";
import { Rng, fnv } from "./rng";
import type { PeerEvent, PeerPlan } from "./schedule";

export const ORIGIN = "http://localhost:5173";

/** What one submitted transaction became, as seen by the peer that made it. */
export interface Sub {
  client: string;
  cseq: number;
  peer: number;
  /** `{kind, ops}` as sent, for comparison with the log. */
  body: string;
  firstSent: number;
  /** The seq the peer saw its own entry (the ack) at. */
  ackSeq: number | null;
  rejected: string | null;
  /** The rejection reached a live session (not just a socket it had already let go of). */
  told: boolean;
}

export interface PeerStats {
  actions: number;
  skipped: number;
  edits: number;
  undos: number;
  redos: number;
  localRefusals: number;
  viewOnlyRefusals: number;
  rejectionsHeard: number;
  drops: number;
  reloads: number;
  offline: number;
  presenceSent: number;
  presenceHeard: number;
  connects: number;
  closes: Record<string, number>;
  protocolErrors: number;
  lagMax: number;
}

const newStats = (): PeerStats => ({
  actions: 0,
  skipped: 0,
  edits: 0,
  undos: 0,
  redos: 0,
  localRefusals: 0,
  viewOnlyRefusals: 0,
  rejectionsHeard: 0,
  drops: 0,
  reloads: 0,
  offline: 0,
  presenceSent: 0,
  presenceHeard: 0,
  connects: 0,
  closes: {},
  protocolErrors: 0,
  lagMax: 0,
});

/** The session's private parts the harness reads (TypeScript privacy is compile-time only). */
interface Internals {
  replica?: {
    view(): string;
    state(): string;
    lastSeq(): number;
  };
  presence: Presence;
  socket?: SocketLike;
  saveSoon?: ReturnType<typeof setTimeout>;
  presenceTimer?: ReturnType<typeof setTimeout>;
  timer?: ReturnType<typeof setTimeout>;
}
const inner = (s: BoardSession) => s as unknown as Internals;

/** The tab's IndexedDB. Killing the tab drops every save not yet started, as closing it would;
 * a save already under way finishes. A dead tab's chain never continues, so it sends nothing. */
class TabPersist implements Persist {
  dead = false;
  constructor(readonly idb: IdbPersist) {}
  load(board: string) {
    return this.idb.load(board);
  }
  save(board: string, state: string): Promise<void> {
    if (this.dead) return new Promise(() => {});
    return this.idb.save(board, state);
  }
}

/** No network: the connection attempt fails, as it does with the cable out. */
class DeadSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor() {
    setTimeout(() => {
      this.onerror?.({});
      this.onclose?.({});
    }, 5);
  }
  send() {}
  close() {}
}

class Tap implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly ws: WebSocket;
  client: string | undefined;
  readonly sent = new Map<string, number>();

  constructor(
    readonly peer: Peer,
    url: string,
  ) {
    this.ws = new WebSocket(url, { origin: ORIGIN, headers: { "x-forwarded-for": peer.plan.ip } });
    this.ws.onopen = (e) => this.onopen?.(e);
    this.ws.onmessage = (e) => {
      const delivered = this.onmessage !== null && this.peer.currentSocket() === this;
      this.peer.observeIn(this, String(e.data), delivered);
      this.onmessage?.(e);
    };
    this.ws.onclose = (e) => this.onclose?.(e);
    this.ws.onerror = (e) => this.onerror?.(e);
  }
  send(data: string) {
    this.peer.observeOut(this, data);
    this.ws.send(data);
  }
  close() {
    this.ws.close();
  }
  /** A dead network path: the socket goes without a closing handshake. */
  drop() {
    this.ws.terminate();
  }
}

export interface WorkerCtx {
  wsUrl: string;
  board: string;
  t0: number;
  subs: Map<string, Sub>;
  latencies: number[];
  fail(msg: string): void;
  /** `client:cseq` → the seq the edit was made against (from the replica patch). */
  baseSeq: Map<string, number>;
}

export class Peer {
  session: BoardSession | undefined;
  private persist: TabPersist | undefined;
  private offline = false;
  private reloading = false;
  private quiescing = false;
  private tap: Tap | undefined;
  private scene: RecordId | null = null;
  private readonly ids: Rng;
  private problemsSeen = 0;
  readonly stats = newStats();
  readonly clients = new Set<string>();
  /** seq → fingerprint of the entry this peer was given there. */
  readonly entries = new Map<number, number>();
  private gestures = 0;
  /** A Ready since this tab loaded: the UI enables editing only then (board/state.ts), and a
   * view session restored from storage would take an edit before it (repro/). */
  private readySinceLoad = false;

  constructor(
    readonly plan: PeerPlan,
    readonly token: string,
    readonly ctx: WorkerCtx,
  ) {
    this.ids = new Rng(plan.seed, 7);
  }

  get dbName() {
    return `soak-peer-${this.plan.index}`;
  }

  currentSocket(): SocketLike | undefined {
    return this.session ? inner(this.session).socket : undefined;
  }

  async start() {
    this.persist = new TabPersist(new IdbPersist(indexedDB, this.dbName));
    const s = new BoardSession({
      wsUrl: this.ctx.wsUrl,
      board: this.ctx.board,
      token: this.token,
      persist: this.persist,
      openSocket: (url) => this.open(url),
      minDelayMs: 100,
      maxDelayMs: 2000,
    });
    this.session = s;
    this.problemsSeen = 0;
    this.readySinceLoad = false;
    await s.start();
  }

  private open(url: string): SocketLike {
    if (this.offline) return new DeadSocket();
    this.stats.connects += 1;
    this.tap = new Tap(this, url);
    return this.tap;
  }

  // ---- observation -------------------------------------------------------------------------

  observeOut(tap: Tap, data: string) {
    const f = JSON.parse(data) as WireIn;
    if (f.t === "presence") {
      this.stats.presenceSent += 1;
      return;
    }
    if (f.t !== "msg") return;
    const m = f.msg;
    if ("Hello" in m) {
      tap.client = m.Hello.client;
      this.clients.add(m.Hello.client);
      return;
    }
    const tx = m.Submit;
    const key = `${tx.client}:${tx.cseq}`;
    const now = Date.now();
    tap.sent.set(key, now);
    const body = JSON.stringify({ kind: tx.kind, ops: tx.ops });
    const known = this.ctx.subs.get(key);
    if (!known) {
      this.ctx.subs.set(key, { client: tx.client, cseq: tx.cseq, peer: this.plan.index, body, firstSent: now, ackSeq: null, rejected: null, told: false });
    } else if (known.body !== body) {
      this.ctx.fail(`peer ${this.plan.index}: ${key} resent with different contents (a cseq reused?)`);
    }
  }

  observeIn(tap: Tap, data: string, delivered: boolean) {
    const f = JSON.parse(data) as WireOut;
    switch (f.t) {
      case "presence":
        this.stats.presenceHeard += 1;
        return;
      case "closed":
        this.stats.closes[f.reason] = (this.stats.closes[f.reason] ?? 0) + 1;
        if (["abuse", "protocol", "storage_failure", "unauthorized", "revoked"].includes(f.reason)) {
          this.ctx.fail(`peer ${this.plan.index}: server closed the connection: ${f.reason}`);
        }
        return;
      case "ready":
        if (delivered) this.readySinceLoad = true;
        return;
      case "msg": {
        const m = f.msg;
        if ("Fatal" in m) {
          this.ctx.fail(`peer ${this.plan.index}: server sent Fatal: ${m.Fatal}`);
          return;
        }
        if (!delivered) return;
        if ("Entry" in m) {
          const { seq, tx } = m.Entry;
          const h = fnv(JSON.stringify(tx));
          const had = this.entries.get(seq);
          if (had === undefined) this.entries.set(seq, h);
          else if (had !== h) this.ctx.fail(`peer ${this.plan.index}: given two different entries at seq ${seq}`);
          if (tx.client === tap.client) {
            const key = `${tx.client}:${tx.cseq}`;
            const sub = this.ctx.subs.get(key);
            if (!sub) {
              this.ctx.fail(`peer ${this.plan.index}: acked ${key}, which it never sent`);
              return;
            }
            if (sub.ackSeq !== null && sub.ackSeq !== seq) {
              this.ctx.fail(`peer ${this.plan.index}: ${key} acked at seq ${sub.ackSeq} and again at ${seq}`);
            }
            if (sub.ackSeq === null) {
              const sent = tap.sent.get(key);
              if (sent !== undefined) this.ctx.latencies.push(Date.now() - sent);
            }
            sub.ackSeq = seq;
          }
        } else if ("Rejected" in m) {
          this.stats.rejectionsHeard += 1;
          const key = `${tap.client}:${m.Rejected.cseq}`;
          const sub = this.ctx.subs.get(key);
          if (!sub) {
            this.ctx.fail(`peer ${this.plan.index}: rejection for ${key}, which it never sent`);
            return;
          }
          sub.rejected = JSON.stringify(m.Rejected.reason);
          sub.told = true;
        }
        return;
      }
    }
  }

  /** Reads new problems the session reported; protocol errors are bugs (spec §5.4). */
  sweepProblems() {
    const s = this.session;
    if (!s) return;
    for (; this.problemsSeen < s.problems.length; this.problemsSeen++) {
      const p = s.problems[this.problemsSeen]!;
      if (p.startsWith("protocol error")) {
        this.stats.protocolErrors += 1;
        this.ctx.fail(`peer ${this.plan.index}: ${p}`);
      } else if (p.startsWith("could not save locally")) {
        this.ctx.fail(`peer ${this.plan.index}: ${p}`);
      } else if (p === "this link is view-only") {
        this.stats.viewOnlyRefusals += 1;
      } else if (!p.startsWith("rejected:")) {
        this.stats.localRefusals += 1;
      }
    }
  }

  // ---- actions -----------------------------------------------------------------------------

  run(ev: PeerEvent) {
    const s = this.session;
    if (this.quiescing) return;
    if (!s || this.reloading) {
      this.stats.skipped += 1;
      return;
    }
    this.stats.actions += 1;
    switch (ev.k) {
      case "drop":
        this.stats.drops += 1;
        this.tap?.drop();
        return;
      case "offline":
        this.stats.offline += 1;
        this.offline = true;
        this.tap?.drop();
        setTimeout(() => (this.offline = false), ev.ms);
        return;
      case "reload":
        void this.reload(ev.ms ?? 200);
        return;
      case "undo":
        this.stats.undos += 1;
        s.undo();
        return;
      case "redo":
        this.stats.redos += 1;
        s.redo();
        return;
      case "sceneSwitch": {
        const all = scenes(s.records);
        const pick = all[Math.floor(ev.r[0]! * all.length)];
        this.scene = pick ? pick[0] : null;
        s.setPresence({ scene: this.scene, view: { center: { x: 0, y: 0 }, zoom: 1000 + Math.floor(ev.r[1]! * 3000) } });
        return;
      }
      case "cursor":
        return this.gesture(ev.ms ?? 400, (f) => ({ cursor: { x: Math.round((ev.r[0]! - 0.5) * 20000 + f * 3000), y: Math.round((ev.r[1]! - 0.5) * 20000 - f * 2000) } }));
      case "laser": {
        const trail: Array<{ x: number; y: number }> = [];
        return this.gesture(
          ev.ms ?? 400,
          (f) => {
            trail.push({ x: Math.round((ev.r[0]! - 0.5) * 20000 + f * 4000), y: Math.round((ev.r[1]! - 0.5) * 20000 + Math.sin(f * 6) * 2000) });
            while (trail.length > 48) trail.shift();
            return { laser: [...trail] };
          },
          () => ({ laser: [] }),
        );
      }
      case "focus": {
        const all = live(s.records, "Callout");
        const f = all[Math.floor(ev.r[0]! * all.length)];
        s.setPresence({ focus: f ? f[0] : null });
        return;
      }
      case "follow": {
        const them = s.followable();
        const p = ev.r[0]! < 0.3 ? undefined : them[Math.floor(ev.r[1]! * them.length)];
        s.setPresence({ following: p ? p.peer : null });
        return;
      }
    }
    if (ev.k === "viewerEdit" && !this.readySinceLoad) {
      this.stats.skipped += 1;
      return;
    }
    const scene = sceneOf(s.records, this.scene);
    if (!scene) return;
    const built = build(ev.k, ev.r, s.records, scene, this.ids);
    if (!built) {
      this.stats.skipped += 1;
      return;
    }
    if (built.drag && ev.ms) {
      // A drag is a preview through presence, then one transaction (spec §4a).
      const { id, from, to, group } = built.drag;
      const ops = built.ops;
      const session = s;
      this.gesture(
        ev.ms,
        (f) => ({ drag: { id, pos: { x: Math.round(from.x + (to.x - from.x) * f), y: Math.round(from.y + (to.y - from.y) * f) } }, drag_group: group }),
        () => {
          if (this.session === session && !this.reloading) {
            this.stats.edits += 1;
            session.edit(ops);
          }
          return { drag: null, drag_group: [] };
        },
      );
      return;
    }
    this.stats.edits += 1;
    s.edit(built.ops);
  }

  /** Presence at about 20 Hz for `ms`, then a final patch. */
  private gesture(ms: number, frame: (f: number) => Partial<Presence>, end?: () => Partial<Presence>) {
    const s = this.session!;
    const started = Date.now();
    this.gestures += 1;
    const step = () => {
      if (this.session !== s || this.reloading) {
        this.gestures -= 1;
        return;
      }
      const f = Math.min(1, (Date.now() - started) / ms);
      if (f >= 1 || this.quiescing) {
        this.gestures -= 1;
        if (end) s.setPresence(end());
        return;
      }
      s.setPresence(frame(f));
      setTimeout(step, 50);
    };
    step();
  }

  /** Close the tab and open it again: a brand-new session over the same IndexedDB. */
  async reload(downMs: number) {
    const old = this.session;
    if (!old || this.reloading) return;
    this.reloading = true;
    this.stats.reloads += 1;
    this.sweepProblems();
    this.persist!.dead = true;
    old.stop();
    const i = inner(old);
    clearTimeout(i.saveSoon);
    clearTimeout(i.presenceTimer);
    clearTimeout(i.timer);
    const idb = this.persist!.idb as unknown as { db: Promise<IDBDatabase> };
    this.session = undefined;
    this.tap = undefined;
    await new Promise((r) => setTimeout(r, downMs));
    // The old tab's connection to the database goes with it.
    void idb.db.then((d) => setTimeout(() => d.close(), 2000));
    try {
      await this.start();
    } finally {
      this.reloading = false;
    }
  }

  // ---- end of run --------------------------------------------------------------------------

  async quiesce() {
    this.quiescing = true;
    this.offline = false;
    while (this.reloading || this.gestures > 0) await new Promise((r) => setTimeout(r, 20));
  }

  status() {
    const s = this.session;
    const r = s && inner(s).replica;
    this.sweepProblems();
    return {
      index: this.plan.index,
      started: !!s,
      live: s?.connection.kind === "live",
      connection: s?.connection.kind ?? "none",
      status: s?.status.kind ?? "none",
      lastSeq: r ? r.lastSeq() : -1,
    };
  }

  finalPresence(): Partial<Presence> {
    const i = this.plan.index;
    return { name: `peer ${i}`, color: i % 16, cursor: { x: i * 10, y: -i * 10 }, laser: [], drag: null, drag_group: [], focus: null };
  }

  presenceReport() {
    const s = this.session!;
    return {
      index: this.plan.index,
      role: s.connection.kind === "live" ? s.connection.role : "none",
      myPeer: s.myPeer ?? -1,
      mine: inner(s).presence,
      peers: [...s.peers.values()] as PeerPresence[],
      followable: s.followable().map((p) => p.peer),
    };
  }

  report() {
    const s = this.session!;
    const r = inner(s).replica!;
    const view = JSON.stringify(JSON.parse(r.view()));
    const state = JSON.parse(r.state()) as { confirmed: unknown; pending: unknown[] };
    const mirror = JSON.stringify([...s.records].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    this.sweepProblems();
    const maxSeq = Math.max(0, ...this.entries.keys());
    const seen = new Uint32Array(maxSeq + 1);
    const present = new Uint8Array(maxSeq + 1);
    for (const [seq, h] of this.entries) {
      seen[seq] = h;
      present[seq] = 1;
    }
    return {
      index: this.plan.index,
      role: this.plan.role,
      late: this.plan.late,
      clients: [...this.clients],
      view,
      confirmedIsView: JSON.stringify(state.confirmed) === view,
      mirrorIsView: mirror === view,
      pending: state.pending.length,
      lastSeq: r.lastSeq(),
      status: s.status.kind,
      stats: this.stats,
      seen,
      present,
    };
  }

  stop() {
    this.session?.stop();
  }
}
