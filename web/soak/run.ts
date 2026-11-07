// The many-peer soak on the real stack: the real server binary, real WebSockets, the real
// BoardSession over the real WASM replica, IndexedDB through fake-indexeddb. Peers run in
// worker threads; this coordinator owns the server (and kills it), then quiesces everyone and
// checks the properties in checks.ts. `just soak` builds and runs it; see `--help`.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import WebSocket from "ws";
import { Api } from "../src/core/api";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import type { Tx } from "../src/gen/Tx";
import type { WireOut } from "../src/gen/WireOut";
import { newClientId, newClientSecret } from "../src/wasm/mapcro_wasm.js";
import { type LogEntry, type PeerReport, type PresenceReport, type SubReport, checkFinal, checkPresence, countConflicts, percentile } from "./checks";
import { ORIGIN } from "./peer";
import { parseSeed } from "./rng";
import { type SoakConfig, makeSchedule } from "./schedule";
import { SoakServer } from "./server";
import type { Request, WorkerInit } from "./worker";
import { loadWasm, replay } from "./wasm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.MAPCRO_ROOT ?? resolve(HERE, "../../..");
const WASM = join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm");
const BIN = process.env.MAPCRO_SERVER_BIN ?? join(process.env.CARGO_TARGET_DIR ?? join(ROOT, "target"), "release/mapcro-server");

/** History caps raised so a long soak never fills the board; the session cap (64) is a constant. */
const SOAK_CAPS = { BOARD_MAX_OPS: "2000000", BOARD_MAX_BYTES: String(1 << 30), BOARD_MAX_REJECTIONS: "1000000", BOARD_MAX_CLIENTS: "100000" };

const HELP = `just soak [seed] [peers] [seconds] [-- flags]
  --seed N|0xN     schedule seed (default: from the clock; printed)
  --peers N        sessions on one board (default 40)
  --viewers N      of which view-only (default peers/4)
  --seconds N      run length before quiescing (default 60)
  --restarts N     server kill -9 and restarts (default 3)
  --rate R         mean edits per editor per second outside bursts (default 2)
  --faults F       scale drops, reloads and offline bursts (default 1; 0 disables)
  --workers N      worker threads (default min(12, peers))
  --default-caps   run with the server's default history caps
  --probe-full     once everyone is in, check one more peer gets a clean "full" (on at 64 peers)
  --json PATH      also write the summary as JSON
  --tmp DIR        parent for the server's data dir (default the OS temp dir; a disk, so every
                   ack waits on SQLite's fsync as it does in production)
  --keep           keep the server's data dir`;

function parseArgs(argv: string[]): SoakConfig & { keep: boolean; tmp: string } {
  const a = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith("--")) throw new Error(`unexpected argument ${k}\n${HELP}`);
    if (["--default-caps", "--probe-full", "--keep", "--help"].includes(k)) flags.add(k);
    else a.set(k, argv[++i] ?? "");
  }
  if (flags.has("--help")) {
    console.log(HELP);
    process.exit(0);
  }
  const num = (k: string, d: number) => (a.has(k) && a.get(k) !== "" ? Number(a.get(k)) : d);
  const peers = num("--peers", 40);
  return {
    seed: parseSeed(a.get("--seed") || undefined),
    peers,
    viewers: num("--viewers", Math.floor(peers / 4)),
    seconds: num("--seconds", 60),
    restarts: num("--restarts", 3),
    workers: Math.min(num("--workers", 12), peers),
    rate: num("--rate", 2),
    faults: num("--faults", 1),
    serverEnv: flags.has("--default-caps") ? {} : SOAK_CAPS,
    probeFull: flags.has("--probe-full") || peers >= 64,
    json: a.get("--json"),
    keep: flags.has("--keep"),
    tmp: a.get("--tmp") || tmpdir(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

class Pool {
  private nextId = 0;
  private waiting = new Map<number, (v: unknown) => void>();
  constructor(
    readonly workers: Worker[],
    onFail: (msg: string) => void,
  ) {
    for (const w of workers) {
      w.on("message", (m: { t: string; id?: number; body?: unknown; msg?: string }) => {
        if (m.t === "fail") onFail(m.msg!);
        else if (m.t === "reply") {
          this.waiting.get(m.id!)?.(m.body);
          this.waiting.delete(m.id!);
        }
      });
      w.on("error", (e) => onFail(`worker crashed: ${e.stack ?? e}`));
    }
  }
  /** Ask every worker; answers in worker order. */
  ask<T>(t: Request["t"]): Promise<T[]> {
    return Promise.all(
      this.workers.map(
        (w) =>
          new Promise<T>((ok) => {
            const id = this.nextId++;
            this.waiting.set(id, ok as (v: unknown) => void);
            w.postMessage({ id, t } satisfies Request);
          }),
      ),
    );
  }
}

interface Status {
  index: number;
  started: boolean;
  live: boolean;
  connection: string;
  status: string;
  lastSeq: number;
}

/** The board's base at seq 0, read before anyone edits: a fresh client then gets the board as it
 * is, which on a new board is the genesis document. */
async function readGenesis(wsUrl: string, board: string, token: string) {
  return new Promise<string>((ok, fail) => {
    const ws = new WebSocket(wsUrl, { origin: ORIGIN, headers: { "x-forwarded-for": "10.255.255.1" } });
    ws.on("open", () => ws.send(JSON.stringify({ t: "auth", board, token, known_seq: null })));
    ws.on("message", (data) => {
      const f = JSON.parse(String(data)) as WireOut;
      if (f.t !== "ready") return;
      ws.close();
      if (!f.base || f.base.seq !== 0) return fail(new Error(`a new board's base should be at seq 0, got ${f.base?.seq}`));
      ok(JSON.stringify(f.base));
    });
    ws.on("error", (e) => fail(e));
  });
}

/** A raw view connection that reads the whole log: it already holds the genesis base, so it says
 * `known_seq: 0` and gets every entry up to `head` as catch-up. (A fresh reader would get a
 * snapshot of the board instead; `freshClient` checks that one against this log.) */
async function readLog(wsUrl: string, board: string, token: string, head: number, genesis: string) {
  return new Promise<{ base: string; baseSeq: number; log: LogEntry[] }>((ok, fail) => {
    const ws = new WebSocket(wsUrl, { origin: ORIGIN, headers: { "x-forwarded-for": "10.255.255.1" } });
    const log: LogEntry[] = [];
    const base = genesis;
    const baseSeq = 0;
    const timer = setTimeout(() => fail(new Error(`log reader timed out at ${log.length} entries of ${head}`)), 180_000);
    const done = () => {
      clearTimeout(timer);
      ws.close();
      ok({ base, baseSeq, log });
    };
    ws.on("open", () => ws.send(JSON.stringify({ t: "auth", board, token, known_seq: 0 })));
    ws.on("message", (data) => {
      const f = JSON.parse(String(data)) as WireOut;
      if (f.t === "ready") {
        ws.send(JSON.stringify({ t: "msg", msg: { Hello: { client: newClientId(), secret: newClientSecret(), last_seq: baseSeq, pending_from: 0 } } }));
        if (baseSeq >= head) done();
      } else if (f.t === "msg" && "Entry" in f.msg) {
        log.push({ seq: f.msg.Entry.seq, tx: f.msg.Entry.tx as Tx });
        if (f.msg.Entry.seq >= head) done();
      } else if (f.t === "closed") fail(new Error(`log reader closed: ${f.reason}`));
    });
    ws.on("error", (e) => fail(e));
  });
}

/** A brand-new client from scratch (no storage): the board as the server serves it. */
async function freshClient(wsUrl: string, board: string, token: string, head: number): Promise<string> {
  const s = new BoardSession({
    wsUrl,
    board,
    token,
    persist: new MemoryPersist(),
    openSocket: (url) => new WebSocket(url, { origin: ORIGIN, headers: { "x-forwarded-for": "10.255.255.2" } }) as unknown as SocketLike,
  });
  await s.start();
  const r = () => (s as unknown as { replica?: { lastSeq(): number; view(): string } }).replica;
  const end = Date.now() + 180_000;
  while (!(s.connection.kind === "live" && r() && r()!.lastSeq() >= head)) {
    if (Date.now() > end) throw new Error(`fresh client stuck at seq ${r()?.lastSeq()} of ${head}`);
    await sleep(50);
  }
  const view = JSON.stringify(JSON.parse(r()!.view()));
  s.stop();
  return view;
}

/** One more peer than the room holds: it must get a clean `closed: full`, and nobody else may
 * notice. Returns a failure, if any. */
async function probeFull(wsUrl: string, board: string, token: string): Promise<string | undefined> {
  const reason = await new Promise<string>((ok) => {
    const ws = new WebSocket(wsUrl, { origin: ORIGIN, headers: { "x-forwarded-for": "10.255.255.3" } });
    const timer = setTimeout(() => ok("no answer in 10 s"), 10_000);
    let got = "closed without a frame";
    ws.on("open", () => ws.send(JSON.stringify({ t: "auth", board, token, known_seq: null })));
    ws.on("message", (d) => {
      const f = JSON.parse(String(d)) as WireOut;
      got = f.t === "closed" ? `closed:${f.reason}` : `got ${f.t} instead of closed`;
    });
    ws.on("close", () => {
      clearTimeout(timer);
      ok(got);
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      ok(`error: ${e.message}`);
    });
  });
  return reason === "closed:full" ? undefined : `full: the extra peer got ${reason}, not a clean closed:full`;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const schedule = makeSchedule(cfg);
  const T = cfg.seconds * 1000;
  loadWasm(WASM);
  const failures: string[] = [];
  const t00 = Date.now();
  const fail = (m: string) => {
    if (failures.length < 200) failures.push(m);
    if (failures.length <= 10) console.log(`  FAIL ${m}`);
  };
  const editors = cfg.peers - cfg.viewers;
  console.log(
    `soak: seed ${cfg.seed} (0x${cfg.seed.toString(16)}), ${cfg.peers} peers (${editors} editors, ${cfg.viewers} viewers), ${cfg.seconds}s, ` +
      `${cfg.restarts} restarts, ${schedule.events.length} scheduled events, schedule ${schedule.fingerprint}`,
  );

  const dataDir = mkdtempSync(join(cfg.tmp, "mapcro-soak-"));
  const server = new SoakServer(BIN, dataDir, cfg.serverEnv);
  await server.start();
  const api = new Api(server.http);
  const { board, owner_token } = await api.createBoard("Soak");
  const { token: editToken } = await api.mintLink(board, owner_token, "edit", "team");
  const { token: viewToken } = await api.mintLink(board, owner_token, "view", "audience");
  const genesis = await readGenesis(server.ws, board, viewToken);

  // Peers, round-robin over the workers; peer 0 holds the owner link.
  const t0 = Date.now() + 1500;
  const inits: WorkerInit[] = Array.from({ length: cfg.workers }, (_, id) => ({ id, wasm: WASM, wsUrl: server.ws, board, t0, peers: [], events: [] }));
  for (const p of schedule.peers) {
    const token = p.role === "view" ? viewToken : p.index === 0 ? owner_token : editToken;
    inits[p.index % cfg.workers]!.peers.push({ plan: p, token });
  }
  for (const e of schedule.events) inits[e.peer % cfg.workers]!.events.push(e);
  const pool = new Pool(
    inits.map((w) => new Worker(join(HERE, "worker.js"), { workerData: w })),
    fail,
  );

  // The run: restarts on schedule, progress every 10 s, the late joiner's catch-up timed.
  const late = schedule.peers.find((p) => p.late)!;
  let lateHeadAtJoin = -1;
  let lateCaughtUp: number | undefined;
  let head = 0;
  const restarts = (async () => {
    for (const r of schedule.restarts) {
      await sleep(Math.max(0, t0 + r.at - Date.now()));
      console.log(`  t=${secs(Date.now() - t0)} kill -9 the server (down ${r.downMs} ms)`);
      await server.restart(r.downMs);
    }
  })();
  let lastProgress = 0;
  while (Date.now() < t0 + T) {
    await sleep(1000);
    const st = (await pool.ask<Status[]>("status")).flat();
    head = Math.max(head, ...st.map((s) => s.lastSeq));
    const now = Date.now() - t0;
    const l = st.find((s) => s.index === late.index)!;
    if (lateHeadAtJoin < 0 && l.started) lateHeadAtJoin = head;
    if (lateHeadAtJoin >= 0 && lateCaughtUp === undefined && l.lastSeq >= lateHeadAtJoin) lateCaughtUp = now - late.startAt;
    if (now - lastProgress >= 10_000) {
      lastProgress = now;
      server.sample();
      console.log(`  t=${secs(now)} head ${head}, live ${st.filter((s) => s.live).length}/${st.filter((s) => s.started).length}, server rss ${Math.round(server.peakRssKb / 1024)} MB peak`);
    }
  }
  await restarts;

  // Quiesce: no more actions or faults; everyone reconnects and drains.
  const q0 = Date.now();
  await pool.ask("quiesce");
  let stable = 0;
  let prev = "";
  let st: Status[] = [];
  while (true) {
    st = (await pool.ask<Status[]>("status")).flat();
    const top = Math.max(...st.map((s) => s.lastSeq));
    const done = st.every((s) => s.live && s.status === "saved" && s.lastSeq === top);
    const key = `${top}`;
    stable = done && key === prev ? stable + 1 : 0;
    prev = key;
    if (stable >= 3) break;
    if (Date.now() - q0 > 180_000) {
      const stuck = st.filter((s) => !(s.live && s.status === "saved" && s.lastSeq === top));
      fail(`quiesce: not quiet after 180 s; ${stuck.length} peers behind: ${stuck.slice(0, 6).map((s) => `#${s.index} ${s.connection}/${s.status}@${s.lastSeq}`).join(", ")} (head ${top})`);
      break;
    }
    await sleep(200);
  }
  const quiesceMs = Date.now() - q0;
  head = Math.max(...st.map((s) => s.lastSeq));

  // Presence: everyone's last state reaches everyone else.
  await pool.ask("presence");
  let presence: string[] = [];
  const p0 = Date.now();
  while (Date.now() - p0 < 15_000) {
    await sleep(500);
    presence = checkPresence((await pool.ask<PresenceReport[]>("presenceReport")).flat());
    if (!presence.length) break;
  }
  presence.forEach(fail);

  if (cfg.probeFull) {
    const bad = await probeFull(server.ws, board, viewToken);
    if (bad) fail(bad);
    else console.log(`  probe: peer ${cfg.peers + 1} got a clean closed:full`);
    await sleep(500);
    const after = (await pool.ask<Status[]>("status")).flat();
    if (!after.every((s) => s.live)) fail("full: a peer lost its connection when the extra peer was refused");
  }

  // Collect, stop everyone, then read the log and a fresh client's board from the server.
  const parts = await pool.ask<{ reports: PeerReport[]; subs: SubReport[]; latencies: number[]; lagMax: number }>("report");
  await pool.ask("stop");
  const reports = parts.flatMap((p) => p.reports);
  const subs = parts.flatMap((p) => p.subs);
  const latencies = parts.flatMap((p) => p.latencies);
  // Stopped sessions take a moment to leave the room; at the session cap the reader waits.
  let read: Awaited<ReturnType<typeof readLog>> | undefined;
  for (let i = 0; !read; i++) {
    try {
      read = await readLog(server.ws, board, viewToken, head, genesis);
    } catch (e) {
      if (i > 50 || !String(e).includes("closed: full")) throw e;
      await sleep(200);
    }
  }
  const { base, baseSeq, log } = read;
  const f0 = Date.now();
  const fresh = await freshClient(server.ws, board, viewToken, head);
  const freshMs = Date.now() - f0;
  const oracle = replay(base, log);
  checkFinal({ baseSeq, log, oracle, fresh, reports, subs }).forEach(fail);
  if (baseSeq > 0) console.log(`  note: the server's base is at seq ${baseSeq}; entries before it can't be checked`);
  server.sample();
  await server.kill9();
  for (const w of pool.workers) await w.terminate();

  // Stats.
  const sum = (f: (r: PeerReport) => number) => reports.reduce((s, r) => s + f(r), 0);
  const closes: Record<string, number> = {};
  for (const r of reports) for (const [k, n] of Object.entries(r.stats.closes)) closes[k] = (closes[k] ?? 0) + n;
  const rejections: Record<string, number> = {};
  for (const s of subs) if (s.rejected) rejections[s.rejected] = (rejections[s.rejected] ?? 0) + 1;
  const conflicts = countConflicts(log, new Map(subs.map((s) => [`${s.client}:${s.cseq}`, s.baseSeq])));
  const stats = {
    seed: cfg.seed,
    schedule: schedule.fingerprint,
    peers: cfg.peers,
    editors,
    viewers: cfg.viewers,
    seconds: cfg.seconds,
    transactions: log.length,
    submitted: subs.length,
    acked: subs.filter((s) => s.ackSeq !== null).length,
    conflicts,
    rejections,
    localRefusals: sum((r) => r.stats.localRefusals),
    viewOnlyRefusals: sum((r) => r.stats.viewOnlyRefusals),
    drops: sum((r) => r.stats.drops),
    reloads: sum((r) => r.stats.reloads),
    offlineBursts: sum((r) => r.stats.offline),
    restarts: server.restarts,
    connects: sum((r) => r.stats.connects),
    closes,
    presenceSent: sum((r) => r.stats.presenceSent),
    presenceHeard: sum((r) => r.stats.presenceHeard),
    ackP50Ms: percentile(latencies, 50),
    ackP99Ms: percentile(latencies, 99),
    peakServerRssMb: Math.round(server.peakRssKb / 1024),
    quiesceMs,
    lateJoiner: { joinedAtSeq: lateHeadAtJoin, caughtUpMs: lateCaughtUp ?? null },
    freshClientMs: freshMs,
    scheduleLagMaxMs: Math.max(...parts.map((p) => p.lagMax)),
    wallMs: Date.now() - t00,
    failures: failures.length,
  };
  console.log(
    [
      `peers ${stats.peers} (${editors} edit, ${cfg.viewers} view) for ${cfg.seconds}s, seed ${cfg.seed}, schedule ${schedule.fingerprint}`,
      `transactions ${stats.transactions} logged of ${stats.submitted} sent (${stats.acked} acks seen), conflicts ${conflicts}, rejections ${JSON.stringify(rejections)}`,
      `refused locally ${stats.localRefusals}, view-only refusals ${stats.viewOnlyRefusals}`,
      `faults: drops ${stats.drops}, reloads ${stats.reloads}, offline bursts ${stats.offlineBursts}, server restarts ${stats.restarts}; connects ${stats.connects}, closes ${JSON.stringify(closes)}`,
      `presence: ${stats.presenceSent} sent, ${stats.presenceHeard} batches heard`,
      `ack latency p50 ${stats.ackP50Ms} ms, p99 ${stats.ackP99Ms} ms; peak server RSS ${stats.peakServerRssMb} MB; quiesce ${secs(quiesceMs)}`,
      `late joiner: joined at seq ${lateHeadAtJoin}, caught up in ${lateCaughtUp === undefined ? "?" : secs(lateCaughtUp)}; a fresh client loaded all ${head} in ${secs(freshMs)}; schedule lag max ${stats.scheduleLagMaxMs} ms; wall ${secs(stats.wallMs)}`,
    ]
      .map((l) => `  ${l}`)
      .join("\n"),
  );
  if (cfg.json) writeFileSync(cfg.json, JSON.stringify({ ...stats, failureList: failures }, null, 2));
  if (failures.length) {
    console.log(`FAILED: ${failures.length} problems${failures.length > 10 ? " (first 10 above; all below)" : ""}; server log ${server.log}`);
    if (failures.length > 10) for (const f of failures.slice(10, 60)) console.log(`  FAIL ${f}`);
    console.log(`replay the same schedule: just soak --seed ${cfg.seed} --peers ${cfg.peers} --seconds ${cfg.seconds}`);
    process.exit(1);
  }
  if (!cfg.keep) rmSync(dataDir, { recursive: true, force: true });
  console.log("soak: OK");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
