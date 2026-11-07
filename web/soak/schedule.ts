// The soak's plan, drawn up front from the seed: who does what, and when. Network timing varies
// between runs; the schedule does not (its fingerprint is printed so two runs can be compared).

import { Rng, fnv } from "./rng";

export interface SoakConfig {
  seed: number;
  /** Sessions on the board, viewers included. */
  peers: number;
  viewers: number;
  seconds: number;
  /** Server kill -9 and restarts during the run. */
  restarts: number;
  /** Worker threads hosting the peers. */
  workers: number;
  /** Mean actions per second per editor, outside bursts. */
  rate: number;
  /** Fault intensity multiplier (1 = default rates of drops, reloads and offline bursts). */
  faults: number;
  /** Server env overrides (the soak raises history caps; `--default-caps` keeps them). */
  serverEnv: Record<string, string>;
  /** Probe the room's session cap with one more peer once everyone is in. */
  probeFull: boolean;
  /** Where to write a JSON summary, if anywhere. */
  json?: string | undefined;
}

export const EDITOR_ACTIONS = {
  move: 20,
  group: 4,
  souls: 6,
  ult: 5,
  clock: 4,
  alive: 4,
  roster: 3,
  title: 1,
  stroke: 8,
  arrow: 5,
  arrowEdit: 3,
  callout: 4,
  calloutEdit: 4,
  note: 4,
  erase: 5,
  sceneAdd: 1.2,
  sceneReorder: 2,
  sceneDelete: 0.4,
  sceneSwitch: 3,
  objective: 6,
  wave: 3,
  undo: 7,
  redo: 4,
  cursor: 6,
  laser: 4,
  focus: 2,
  follow: 1,
} as const;

const VIEWER_ACTIONS = { cursor: 40, laser: 20, sceneSwitch: 15, follow: 15, focus: 7, viewerEdit: 3 } as const;

/** Actions that create records, and roughly how many each creates. The board holds at most 5000
 * records, tombstones included, so long runs scale these down to stay under it. */
const CREATES: Partial<Record<keyof typeof EDITOR_ACTIONS, number>> = {
  stroke: 1,
  arrow: 1,
  callout: 1,
  note: 0.3,
  objective: 0.3,
  wave: 0.3,
  sceneAdd: 13,
};

export type ActionKind = keyof typeof EDITOR_ACTIONS | keyof typeof VIEWER_ACTIONS | "contest";
export type FaultKind = "drop" | "reload" | "offline";

export interface PeerEvent {
  at: number;
  peer: number;
  k: ActionKind | FaultKind;
  /** Parameters in [0, 1): what to target and what to write. Contests share r[0..2]. */
  r: number[];
  /** Duration, for gestures, offline bursts and reloads. */
  ms?: number;
}

export interface Restart {
  at: number;
  downMs: number;
}

export interface PeerPlan {
  index: number;
  role: "edit" | "view";
  startAt: number;
  /** A distinct client address (sent as X-Forwarded-For; the server trusts it from loopback,
   * as behind Caddy), so the per-address socket cap counts people, not the test host. */
  ip: string;
  seed: number;
  late: boolean;
}

export interface Schedule {
  peers: PeerPlan[];
  events: PeerEvent[];
  restarts: Restart[];
  fingerprint: string;
}

function weighted<T extends string>(rng: Rng, table: Record<T, number>): T {
  const entries = Object.entries(table) as Array<[T, number]>;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = rng.next() * total;
  for (const [k, w] of entries) {
    x -= w;
    if (x < 0) return k;
  }
  return entries[entries.length - 1]![0];
}

const params = (rng: Rng) => Array.from({ length: 6 }, () => rng.next());

export function makeSchedule(c: SoakConfig): Schedule {
  const T = c.seconds * 1000;
  const rng = new Rng(c.seed, 0);
  const editors = c.peers - c.viewers;
  if (editors < 2) throw new Error("need at least two editors");
  const lateIndex = editors - 1;
  const peers: PeerPlan[] = [];
  for (let i = 0; i < c.peers; i++) {
    const late = i === lateIndex;
    peers.push({
      index: i,
      role: i < editors ? "edit" : "view",
      startAt: late ? Math.round(T * 0.7) : rng.int(0, 2000),
      ip: `10.${(i >> 8) & 255}.${i & 255}.${1 + rng.int(0, 250)}`,
      seed: rng.u32(),
      late,
    });
  }

  // Keep record creation under the board's record cap over the whole run.
  const totalWeight = Object.values(EDITOR_ACTIONS).reduce((s: number, w) => s + w, 0);
  const createsPerAction = Object.entries(CREATES).reduce(
    (s, [k, n]) => s + (EDITOR_ACTIONS[k as keyof typeof EDITOR_ACTIONS] / totalWeight) * (n ?? 0),
    0,
  );
  const expectedActions = editors * c.rate * c.seconds * 1.4; // bursts and offline edits on top
  const createScale = Math.min(1, 3500 / (expectedActions * createsPerAction));
  const editorTable: Record<string, number> = { ...EDITOR_ACTIONS };
  for (const k of Object.keys(CREATES)) editorTable[k] = editorTable[k]! * createScale;

  const events: PeerEvent[] = [];
  for (const p of peers) {
    const r = new Rng(c.seed, 1000 + p.index);
    const mean = 1000 / (p.role === "edit" ? c.rate : c.rate * 0.6);
    let t = p.startAt + 300 + r.int(0, 500);
    let burstUntil = 0;
    while (t < T) {
      if (t > burstUntil && r.chance(0.02)) burstUntil = t + r.int(1000, 3000);
      const table = p.role === "edit" ? editorTable : VIEWER_ACTIONS;
      const k = weighted(r, table as Record<string, number>) as ActionKind;
      const ev: PeerEvent = { at: Math.round(t), peer: p.index, k, r: params(r) };
      if (k === "move" || k === "group" || k === "laser" || k === "cursor") ev.ms = r.int(150, 1200);
      events.push(ev);
      t += r.exp(t < burstUntil ? mean / 4 : mean);
    }
    // Faults, as Poisson processes per peer.
    const fault = (k: FaultKind, meanMs: number, ms: () => number) => {
      let at = p.startAt + 1500 + r.exp(meanMs / c.faults);
      while (at < T * 0.92) {
        const ev: PeerEvent = { at: Math.round(at), peer: p.index, k, r: params(r), ms: ms() };
        events.push(ev);
        if (k === "offline" && p.role === "edit") {
          // Edit while disconnected: a burst of changes that sync on reconnect.
          const n = r.int(3, 12);
          for (let j = 0; j < n; j++) {
            const kk = r.pick(["move", "souls", "clock", "stroke", "callout", "objective", "undo", "redo", "calloutEdit"] as const);
            events.push({ at: Math.round(at + ((j + 1) * ev.ms!) / (n + 2)), peer: p.index, k: kk, r: params(r) });
          }
        }
        at += r.exp(meanMs / c.faults) + (ev.ms ?? 0);
      }
    };
    fault("drop", 25_000, () => 0);
    fault("reload", 45_000, () => r.int(50, 1500));
    fault("offline", 60_000, () => r.int(1500, 8000));
  }

  // Contests: several editors write the same field within a few milliseconds, on purpose.
  const cr = new Rng(c.seed, 1);
  for (let t = 3000 + cr.int(0, 2000); t < T; t += cr.exp(2500)) {
    const n = cr.int(3, Math.min(7, editors + 1));
    const shared = params(cr);
    const kind = cr.next();
    const chosen = new Set<number>();
    while (chosen.size < n) chosen.add(cr.int(0, editors));
    for (const peer of [...chosen].sort((a, b) => a - b)) {
      const own = params(cr);
      events.push({ at: Math.round(t + cr.int(0, 40)), peer, k: "contest", r: [shared[0]!, shared[1]!, kind, ...own.slice(0, 3)] });
    }
  }

  const restarts: Restart[] = [];
  if (c.restarts > 0) {
    const sr = new Rng(c.seed, 2);
    const span = T * 0.75;
    for (let i = 0; i < c.restarts; i++) {
      const slot = span / c.restarts;
      restarts.push({ at: Math.round(T * 0.1 + i * slot + sr.next() * slot * 0.6), downMs: sr.int(300, 2500) });
    }
  }

  events.sort((a, b) => a.at - b.at || a.peer - b.peer);
  const fingerprint = fnv(JSON.stringify({ peers, events, restarts })).toString(16).padStart(8, "0");
  return { peers, events, restarts, fingerprint };
}
