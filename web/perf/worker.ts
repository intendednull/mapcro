// Node peers for the perf harness, in a worker thread: each a real BoardSession over the real
// WASM replica and a real WebSocket. They are the extra load at 10 and 40 peers, and they record
// the protocol-level timings (submit → ack, submit → others' receipt, presence one-way, the
// replica's receive cost) with no browser in the way.
//
// Actions come from the soak's builders (web/soak/actions.ts) at a human pace; a drag first
// streams its preview through presence for a few hundred milliseconds, then commits.

import { parentPort, workerData } from "node:worker_threads";
import WebSocket from "ws";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import { BoardReplica } from "../src/wasm/mapcro_wasm.js";
import { build, sceneOf } from "../soak/actions";
import { Rng } from "../soak/rng";
import { loadWasm } from "../soak/wasm";
import type { WireOut } from "../src/gen/WireOut";
import { type PresenceLike, presenceKey } from "./stats";

export interface PeerSpec {
  who: string;
  token: string;
  editor: boolean;
  /** Record per-frame receive details (probes); others only count. */
  probe: boolean;
  /** A distinct client address, as X-Forwarded-For (the server trusts it from loopback), so 40
   * local peers don't meet the 32-sockets-per-address cap. Local runs only. */
  ip: string;
}

export interface WorkerInit {
  wasm: string;
  wsUrl: string;
  origin: string;
  board: string;
  peers: PeerSpec[];
  seed: number;
  /** Mean seconds between one editor's actions. */
  actionEvery: number;
  /** Cursor presence while idle, per second (0 = only while dragging). */
  cursorHz: number;
  /** Submit this many creates first (one peer only), to give the board realistic content. */
  prefill: number;
}

export interface NodeReport {
  who: string;
  peer: number | null;
  client: string | null;
  readyT: number;
  submits: Array<{ t: number; client: string; cseq: number; op: string }>;
  entries: Array<{ t: number; seq: number; client: string; cseq: number; op: string; recvMs: number; changed: number; updBytes: number }>;
  psent: Array<{ t: number; key: string }>;
  precv: Array<{ t: number; peer: number; key: string; ms: number }>;
  rxBytes: number;
  rxFrames: number;
  /** Connections opened, and `closed` frames heard (by reason): churn shows here. */
  connects: number;
  closes: Record<string, number>;
  rxPresenceBytes: number;
  rxPresenceFrames: number;
  saves: number[];
  stateBytes: number[];
  editMs: number[];
  problems: string[];
}

const init = workerData as WorkerInit;
loadWasm(init.wasm);
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** "Set:PlayerPos", "Create:Stroke", "Delete": what a transaction's first op does. */
function opName(op: unknown): string {
  if (!op || typeof op !== "object") return "";
  const [k, v] = Object.entries(op)[0] ?? [];
  if (k === "Set" && v?.value) return `Set:${Object.keys(v.value)[0]}`;
  if (k === "Create" && v?.record) return `Create:${Object.keys(v.record)[0]}`;
  return k ?? "";
}

// The replica's receive cost, measured at the WASM boundary (Node's V8 + the same .wasm).
let recvSink: ((ms: number, out: string) => void) | undefined;
{
  const proto = BoardReplica.prototype as unknown as Record<string, (this: BoardReplica, ...a: unknown[]) => string>;
  const recv = proto.receive!;
  proto.receive = function (this: BoardReplica, ...a: unknown[]) {
    const t0 = performance.now();
    const out = recv.apply(this, a);
    recvSink?.(performance.now() - t0, out);
    return out;
  };
  const edit = proto.edit!;
  proto.edit = function (this: BoardReplica, ...a: unknown[]) {
    const t0 = performance.now();
    const out = edit.apply(this, a);
    editSink?.(performance.now() - t0);
    return out;
  };
}
let editSink: ((ms: number) => void) | undefined;

class Peer {
  readonly r: NodeReport;
  session!: BoardSession;
  private stop = false;
  private rng: Rng;
  private ids: Rng;
  constructor(readonly spec: PeerSpec, i: number) {
    this.rng = new Rng(init.seed, i * 2 + 1);
    this.ids = new Rng(init.seed, i * 2 + 2);
    this.r = { who: spec.who, peer: null, client: null, readyT: 0, connects: 0, closes: {}, submits: [], entries: [], psent: [], precv: [], rxBytes: 0, rxFrames: 0, rxPresenceBytes: 0, rxPresenceFrames: 0, saves: [], stateBytes: [], editMs: [], problems: [] };
  }

  private socket(url: string): SocketLike {
    const ws = new WebSocket(url, { headers: { origin: init.origin, "x-forwarded-for": this.spec.ip } });
    this.r.connects++;
    const s: SocketLike = { send: (d) => this.tapSend(ws, d), close: () => ws.close(), onopen: null, onmessage: null, onclose: null, onerror: null };
    ws.on("open", () => s.onopen?.({}));
    ws.on("close", () => s.onclose?.({}));
    ws.on("error", (e) => s.onerror?.(e));
    ws.on("message", (data) => {
      const text = String(data);
      const t = now();
      this.r.rxBytes += text.length;
      this.r.rxFrames++;
      const presence = text.startsWith('{"t":"presence"');
      if (presence) {
        this.r.rxPresenceBytes += text.length;
        this.r.rxPresenceFrames++;
      }
      let entry: { seq: number; client: string; cseq: number; op: string } | undefined;
      let recvMs = 0;
      let changed = 0;
      let updBytes = 0;
      recvSink = (ms, out) => {
        recvMs = ms;
        updBytes = out.length;
        changed = (JSON.parse(out) as { changed: unknown[] }).changed.length;
      };
      const t0 = performance.now();
      s.onmessage?.({ data: text });
      const ms = performance.now() - t0;
      recvSink = undefined;
      if (!this.spec.probe && !text.startsWith('{"t":"ready"') && !text.startsWith('{"t":"closed"')) return;
      const f = JSON.parse(text) as WireOut;
      if (f.t === "closed") this.r.closes[f.reason] = (this.r.closes[f.reason] ?? 0) + 1;
      if (f.t === "ready") {
        this.r.peer = f.peer;
        this.r.readyT = t;
      }
      else if (f.t === "msg" && typeof f.msg === "object" && "Entry" in f.msg) {
        const e = f.msg.Entry;
        entry = { seq: e.seq, client: e.tx.client, cseq: e.tx.cseq, op: opName(e.tx.ops[0]) };
        this.r.entries.push({ t, ...entry, recvMs, changed, updBytes });
      } else if (f.t === "presence") {
        for (const p of f.peers) if (p.state) this.r.precv.push({ t, peer: p.peer, key: presenceKey(p.state), ms });
      }
    });
    return s;
  }

  private tapSend(ws: WebSocket, d: string) {
    const t = now();
    if (ws.readyState === WebSocket.OPEN) ws.send(d);
    if (d.startsWith('{"t":"presence"')) {
      this.r.psent.push({ t, key: presenceKey((JSON.parse(d) as { state: PresenceLike }).state) });
    } else if (d.includes('"Submit"')) {
      const tx = (JSON.parse(d) as { msg: { Submit: { client: string; cseq: number; ops: object[] } } }).msg.Submit;
      this.r.client = tx.client;
      this.r.submits.push({ t, client: tx.client, cseq: tx.cseq, op: opName(tx.ops[0]) });
    }
  }

  async start() {
    const persist = new MemoryPersist();
    const save = persist.save.bind(persist);
    persist.save = async (k, v) => {
      const t0 = performance.now();
      await save(k, v);
      this.r.saves.push(performance.now() - t0);
      this.r.stateBytes.push(v.length);
    };
    this.session = new BoardSession({ wsUrl: init.wsUrl, board: init.board, token: this.spec.token, persist, openSocket: (u) => this.socket(u) });
    await this.session.start();
    for (let i = 0; i < 400 && this.session.connection.kind !== "live"; i++) await sleep(25);
    for (let i = 0; i < 400 && this.session.records.size === 0; i++) await sleep(25);
  }

  private cursor() {
    // Integers: WorldPos is i32, and a fractional coordinate fails to parse (the server closes the
    // socket as abuse). Random over ±14000 is unique enough to match a send to its receipt.
    return { x: Math.round((this.rng.next() * 2 - 1) * 14000), y: Math.round((this.rng.next() * 2 - 1) * 14000) };
  }

  /** One editing action at a human pace; drags stream a preview first. */
  async act() {
    const s = this.session;
    const scene = sceneOf(s.records, null);
    if (!scene) return;
    const kinds = ["move", "move", "move", "move", "move", "stroke", "stroke", "objective", "objective", "souls", "arrow", "callout", "clock"];
    const k = kinds[Math.floor(this.rng.next() * kinds.length)]!;
    const r = Array.from({ length: 6 }, () => this.rng.next());
    const b = build(k, r, s.records, scene, this.ids);
    if (!b) return;
    if (b.drag) {
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        const pos = { x: Math.round(b.drag.from.x + (b.drag.to.x - b.drag.from.x) * f), y: Math.round(b.drag.from.y + (b.drag.to.y - b.drag.from.y) * f) };
        s.setPresence({ drag: { id: b.drag.id, pos }, drag_group: b.drag.group, cursor: { x: pos.x + Math.floor(this.rng.next() * 50), y: pos.y + Math.floor(this.rng.next() * 50) }, focus: b.drag.id });
        await sleep(50);
      }
    }
    editSink = (ms) => this.r.editMs.push(ms);
    s.edit(b.ops);
    editSink = undefined;
    if (b.drag) s.setPresence({ drag: null, drag_group: [], focus: null });
  }

  async prefill(n: number) {
    const kinds = ["stroke", "stroke", "stroke", "arrow", "callout", "objective", "move", "souls"];
    for (let i = 0; i < n; i++) {
      const scene = sceneOf(this.session.records, null);
      if (!scene) break;
      const k = kinds[i % kinds.length]!;
      const b = build(k, Array.from({ length: 6 }, () => this.rng.next()), this.session.records, scene, this.ids);
      if (b) this.session.edit(b.ops);
      if (i % 50 === 49) await sleep(200); // stay under the server's frame rate limit
    }
    for (let i = 0; i < 400 && this.session.status.kind !== "saved"; i++) await sleep(25);
  }

  async run() {
    const idle = async () => {
      while (!this.stop && init.cursorHz > 0) {
        this.session.setPresence({ cursor: this.cursor() });
        await sleep(1000 / init.cursorHz);
      }
    };
    void idle();
    if (!this.spec.editor) return;
    await sleep(this.rng.next() * init.actionEvery * 1000);
    while (!this.stop) {
      try {
        await this.act();
      } catch (e) {
        this.r.problems.push(String(e));
      }
      // Exponential gaps around the mean: people are bursty.
      await sleep(Math.min(4 * init.actionEvery, -Math.log(1 - this.rng.next()) * init.actionEvery) * 1000);
    }
  }

  halt() {
    this.stop = true;
  }
}

const peers = init.peers.map((p, i) => new Peer(p, i + init.seed));
const port = parentPort!;
port.on("message", async (m: { t: string }) => {
  if (m.t === "start") {
    await Promise.all(peers.map((p) => p.start()));
    if (init.prefill > 0) await peers[0]!.prefill(init.prefill);
    port.postMessage({ t: "ready" });
  } else if (m.t === "go") {
    for (const p of peers) void p.run();
  } else if (m.t === "stop") {
    for (const p of peers) p.halt();
    await sleep(1500); // let the last acks land
    for (const p of peers) p.r.problems.push(...p.session.problems);
    port.postMessage({ t: "report", reports: peers.map((p) => p.r) });
    for (const p of peers) p.session.stop();
  }
});
