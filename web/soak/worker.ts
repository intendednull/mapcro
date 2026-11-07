// A worker thread hosting some of the peers, each with its own session, replica and IndexedDB.
// The coordinator (run.ts) owns the server and the checks; workers run their peers' schedules
// against a shared start time and answer the coordinator's questions.

import "fake-indexeddb/auto";
import { parentPort, workerData } from "node:worker_threads";
import { Peer, type Sub, type WorkerCtx } from "./peer";
import type { PeerEvent, PeerPlan } from "./schedule";
import { loadWasm, recordBaseSeqs, validateDoc } from "./wasm";

export interface WorkerInit {
  id: number;
  wasm: string;
  wsUrl: string;
  board: string;
  t0: number;
  peers: Array<{ plan: PeerPlan; token: string }>;
  events: PeerEvent[];
}

export type Request = { id: number; t: "quiesce" | "status" | "presence" | "presenceReport" | "report" | "stop" };

const init = workerData as WorkerInit;
loadWasm(init.wasm);
const baseSeq = new Map<string, number>();
recordBaseSeqs(baseSeq);

const ctx: WorkerCtx = {
  wsUrl: init.wsUrl,
  board: init.board,
  t0: init.t0,
  subs: new Map<string, Sub>(),
  latencies: [],
  baseSeq,
  fail(msg) {
    const at = ((Date.now() - init.t0) / 1000).toFixed(1);
    parentPort!.postMessage({ t: "fail", msg: `[t=${at}s] ${msg}` });
  },
};

const peers = new Map<number, Peer>();
for (const { plan, token } of init.peers) peers.set(plan.index, new Peer(plan, token, ctx));

// ---- the schedule ------------------------------------------------------------------------------

let next = 0;
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const starts = [...peers.values()].map((p) => ({ at: p.plan.startAt, p })).sort((a, b) => a.at - b.at);
let nextStart = 0;
let lagMax = 0;

function tick() {
  if (stopped) return;
  const now = Date.now() - init.t0;
  while (nextStart < starts.length && starts[nextStart]!.at <= now) {
    const { p } = starts[nextStart++]!;
    void p.start();
  }
  while (next < init.events.length && init.events[next]!.at <= now) {
    const ev = init.events[next++]!;
    lagMax = Math.max(lagMax, now - ev.at);
    try {
      peers.get(ev.peer)!.run(ev);
    } catch (e) {
      ctx.fail(`peer ${ev.peer}: action ${ev.k} threw: ${e instanceof Error ? e.stack : e}`);
    }
  }
  const upcoming = Math.min(init.events[next]?.at ?? Infinity, starts[nextStart]?.at ?? Infinity);
  if (upcoming === Infinity) return;
  timer = setTimeout(tick, Math.max(0, upcoming - (Date.now() - init.t0)));
}
timer = setTimeout(tick, Math.max(0, init.t0 - Date.now()));

// Invariants on every view the UI could render, sampled through the run.
let round = 0;
const sampler = setInterval(() => {
  const list = [...peers.values()];
  for (const p of list) p.sweepProblems();
  const p = list[round++ % list.length]!;
  const r = p.session && (p.session as unknown as { replica?: { view(): string } }).replica;
  if (!r) return;
  const bad = validateDoc(r.view());
  if (bad) ctx.fail(`peer ${p.plan.index}: its view breaks an invariant: ${bad}`);
}, 1000);

// ---- the coordinator's questions -------------------------------------------------------------

parentPort!.on("message", async (q: Request) => {
  const reply = (body: unknown, transfer: Transferable[] = []) => parentPort!.postMessage({ t: "reply", id: q.id, body }, transfer as never);
  switch (q.t) {
    case "quiesce": {
      stopped = true;
      clearTimeout(timer);
      // Anyone who hasn't joined yet (a run shorter than the late joiner's start) joins now.
      while (nextStart < starts.length) await starts[nextStart++]!.p.start();
      await Promise.all([...peers.values()].map((p) => p.quiesce()));
      return reply(null);
    }
    case "status":
      return reply([...peers.values()].map((p) => p.status()));
    case "presence":
      for (const p of peers.values()) p.session!.setPresence(p.finalPresence());
      return reply(null);
    case "presenceReport":
      return reply([...peers.values()].map((p) => p.presenceReport()));
    case "report": {
      clearInterval(sampler);
      const reports = [...peers.values()].map((p) => p.report());
      const subs = [...ctx.subs.values()].map((s) => ({ ...s, baseSeq: baseSeq.get(`${s.client}:${s.cseq}`) ?? null }));
      const transfer = reports.flatMap((r) => [r.seen.buffer, r.present.buffer]);
      return reply({ reports, subs, latencies: ctx.latencies, lagMax }, transfer);
    }
    case "stop":
      for (const p of peers.values()) p.stop();
      return reply(null);
  }
});
