// The properties the soak checks at the end, mirroring crates/sim/src/checks.rs: one log with
// every transaction at most once, no acknowledged edit lost, rejected work never applied and
// always reported, every replica equal to the log's board, and presence converged.

import type { PeerPresence } from "../src/gen/PeerPresence";
import type { Presence } from "../src/gen/Presence";
import type { Tx } from "../src/gen/Tx";
import type { PeerStats, Sub } from "./peer";
import { fnv } from "./rng";
import { validateDoc } from "./wasm";

export interface LogEntry {
  seq: number;
  tx: Tx;
}

export interface PeerReport {
  index: number;
  role: "edit" | "view";
  late: boolean;
  clients: string[];
  view: string;
  confirmedIsView: boolean;
  mirrorIsView: boolean;
  pending: number;
  lastSeq: number;
  status: string;
  stats: PeerStats;
  seen: Uint32Array;
  present: Uint8Array;
}

export interface PresenceReport {
  index: number;
  /** As the server granted it (owner, edit or view). */
  role: string;
  myPeer: number;
  mine: Presence;
  peers: PeerPresence[];
  followable: number[];
}

export type SubReport = Sub & { baseSeq: number | null };

export interface Final {
  baseSeq: number;
  log: LogEntry[];
  /** The board replayed from the base through every logged entry. */
  oracle: string;
  fresh: string;
  reports: PeerReport[];
  subs: SubReport[];
}

/** Returns failures (empty if every property holds), with at most `cap` of each kind. */
export function checkFinal(f: Final, cap = 5): string[] {
  const out: string[] = [];
  const add = (kind: string, msg: string) => {
    const n = out.filter((m) => m.startsWith(kind)).length;
    if (n < cap) out.push(`${kind}: ${msg}`);
    else if (n === cap) out.push(`${kind}: …and more`);
  };

  // The log itself: contiguous, and each transaction in it exactly once (exactlyOnce).
  const where = new Map<string, number[]>();
  f.log.forEach((e, i) => {
    if (e.seq !== f.baseSeq + i + 1) add("log", `entry ${i} has seq ${e.seq}, expected ${f.baseSeq + i + 1}`);
    const k = `${e.tx.client}:${e.tx.cseq}`;
    where.set(k, [...(where.get(k) ?? []), e.seq]);
  });
  for (const [k, seqs] of where) if (seqs.length > 1) add("exactly once", `${k} is in the log ${seqs.length} times (seqs ${seqs.join(", ")})`);
  const head = f.baseSeq + f.log.length;
  const bySeq = new Map(f.log.map((e) => [e.seq, e]));

  // 1. Convergence: every replica equals the log's board and a fresh client's.
  const v = validateDoc(f.oracle);
  if (v) add("invariants", `the final board breaks an invariant: ${v}`);
  if (f.fresh !== f.oracle) add("converge", "a fresh client's board differs from the log replayed");
  for (const r of f.reports) {
    if (r.view !== f.oracle) add("converge", `peer ${r.index}: board differs from the log replayed (at seq ${r.lastSeq} of ${head})`);
    if (!r.confirmedIsView) add("converge", `peer ${r.index}: confirmed state differs from its view at quiescence`);
    if (!r.mirrorIsView) add("converge", `peer ${r.index}: the UI's records differ from the replica's view`);
    if (r.pending !== 0) add("converge", `peer ${r.index}: ${r.pending} pending after quiescence`);
    if (r.lastSeq !== head) add("converge", `peer ${r.index}: at seq ${r.lastSeq}, log head is ${head}`);
    // Every entry this peer was given is the log's entry at that seq.
    for (let seq = 1; seq < r.present.length; seq++) {
      if (!r.present[seq] || seq <= f.baseSeq) continue;
      const e = bySeq.get(seq);
      if (!e) add("history", `peer ${r.index}: given seq ${seq}, past the log's head ${head}`);
      else if (fnv(JSON.stringify(e.tx)) !== r.seen[seq]) add("history", `peer ${r.index}: given a different entry at seq ${seq} than the log holds`);
    }
  }

  // 2 and 3. Every transaction a peer sent is logged once (and matches, at the seq it was acked
  // at) or was rejected, never applied, and the peer was told (noLostEdits, rejectedNeverLogged).
  const ours = new Set(f.subs.map((s) => `${s.client}:${s.cseq}`));
  const viewers = new Set(f.reports.filter((r) => r.role === "view").flatMap((r) => r.clients));
  for (const s of f.subs) {
    const k = `${s.client}:${s.cseq}`;
    const seqs = where.get(k) ?? [];
    const logged = seqs.length > 0 ? bySeq.get(seqs[0]!) : undefined;
    if (s.rejected !== null) {
      if (logged) add("rejected", `${k} (peer ${s.peer}) was rejected ${s.rejected} but is in the log at seq ${logged.seq}`);
      if (!s.told) add("rejected", `${k} (peer ${s.peer}) was rejected but no live session heard it`);
      continue;
    }
    if (!logged) {
      add("lost", `${k} (peer ${s.peer}) ${s.ackSeq !== null ? `was acked at seq ${s.ackSeq} but` : "was sent,"} is not in the log${s.ackSeq === null ? " and was never rejected" : ""}`);
      continue;
    }
    if (JSON.stringify({ kind: logged.tx.kind, ops: logged.tx.ops }) !== s.body) add("lost", `${k} (peer ${s.peer}): the log holds different contents under this id`);
    if (s.ackSeq !== null && s.ackSeq !== logged.seq) add("lost", `${k} (peer ${s.peer}) was acked at seq ${s.ackSeq} but is logged at ${logged.seq}`);
  }
  for (const e of f.log) {
    const k = `${e.tx.client}:${e.tx.cseq}`;
    if (!ours.has(k)) add("phantom", `seq ${e.seq}: ${k} is in the log but no peer ever sent it`);
    if (viewers.has(e.tx.client)) add("view-only", `seq ${e.seq}: a view-only client's transaction was applied`);
  }
  return out;
}

/** 4. Presence: each peer's last state is what every other peer holds for it; nobody sees
 * themselves; only editors can be followed; nobody who left lingers. */
export function checkPresence(rs: PresenceReport[], cap = 8): string[] {
  const out: string[] = [];
  const byPeer = new Map(rs.map((r) => [r.myPeer, r]));
  const editors = new Set(rs.filter((r) => r.role !== "view").map((r) => r.myPeer));
  for (const a of rs) {
    if (out.length >= cap) break;
    if (a.peers.some((p) => p.peer === a.myPeer)) out.push(`presence: peer ${a.index} sees itself`);
    for (const p of a.peers) {
      if (!byPeer.has(p.peer)) out.push(`presence: peer ${a.index} still sees connection ${p.peer}, which is gone`);
    }
    for (const b of rs) {
      if (a === b) continue;
      const got = a.peers.find((p) => p.peer === b.myPeer);
      if (!got) out.push(`presence: peer ${a.index} never got peer ${b.index}'s presence`);
      else if (JSON.stringify(got.state) !== JSON.stringify(b.mine)) out.push(`presence: peer ${a.index} holds a stale state for peer ${b.index}`);
      else if (got.role !== b.role) out.push(`presence: peer ${a.index} sees peer ${b.index} as ${got.role}, not ${b.role}`);
    }
    const expected = [...editors].filter((p) => p !== a.myPeer).sort((x, y) => x - y);
    const followable = [...a.followable].sort((x, y) => x - y);
    if (JSON.stringify(expected) !== JSON.stringify(followable)) {
      out.push(`presence: peer ${a.index} may follow [${followable.join(",")}], expected the editors [${expected.join(",")}]`);
    }
  }
  return out.slice(0, cap);
}

/** Transactions that overwrote a field another client had written since the writer's base:
 * genuinely concurrent writes to the same field. */
export function countConflicts(log: LogEntry[], baseSeq: Map<string, number | null>): number {
  const last = new Map<string, { seq: number; client: string }>();
  let n = 0;
  for (const e of log) {
    const base = baseSeq.get(`${e.tx.client}:${e.tx.cseq}`);
    let conflict = false;
    for (const op of e.tx.ops) {
      const set = "Set" in op ? op.Set : "SetIf" in op ? op.SetIf : undefined;
      if (!set) continue;
      const key = `${set.id}|${Object.keys(set.value)[0]}`;
      const prior = last.get(key);
      if (prior && prior.client !== e.tx.client && base !== undefined && base !== null && prior.seq > base) conflict = true;
      last.set(key, { seq: e.seq, client: e.tx.client });
    }
    if (conflict) n += 1;
  }
  return n;
}

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}
