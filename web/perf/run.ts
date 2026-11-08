// mapcro performance harness (`just perf <scenario> [flags]`, `--help`). Measures where the time
// goes on the edit path (A's input → B's paint), the drag-preview path (presence), A's own ack,
// the client's cost per remote op, and the server's per-transaction stages and CPU.
//
//   local  a release server on a chosen filesystem, browsers (Playwright) plus Node peers
//   live   real browsers against a deployed server (gentle: capped clients and time)
//
// Results go to --out (default /tmp/mapcro-perf/out/<scenario>-<time>): summary.md, raw.json,
// and any traces. Nothing is written into the repo.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { type ProbeDump, Person, selfTimes } from "./browser";
import { PerfServer, type PerfLine, createBoard, mintLink } from "./server";
import { type Summary, presenceKey, sleep, summarize, table } from "./stats";
import { loadavg } from "node:os";
import { readTrace } from "./trace";
import type { NodeReport, PeerSpec, WorkerInit } from "./worker";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(here, "../..");
const ROOT = resolve(WEB, "..");

const HELP = `just perf <local|live> [flags]   |   just perf report <raw.json>
  --fs disk|btrfs|tmpfs   local: where the server's data dir lives (default disk)
                          disk = ${"$"}PERF_DISK_DIR or /storage/tmp-mapcro-perf (ext4 SSD here),
                          btrfs = ${"$"}TMPDIR (/tmp), tmpfs = /dev/shm (no fsync cost)
  --browsers N            editors in real browsers (default 3; 0 = Node peers only)
  --viewers N             view-link browsers following the first editor (default 0)
  --peers N               total peers; the rest are Node peers (default browsers + viewers)
  --seconds S             realistic phase (default 60)
  --storm S               then a drag storm of S seconds, traced on one observer (default 0)
  --prefill N             creates submitted first, for a realistically full board (default 150)
  --action-every S        mean seconds between one editor's actions (default 3)
  --cursor-hz H           Node peers' idle cursor updates per second (default 5)
  --bin PATH              server binary (default target/release/mapcro-server)
  --web-dir PATH          built client (default web/dist)
  --packs PATH            asset packs (default ~/.local/share/mapcro/packs if present)
  --url URL               live: the deployment (default https://mapcro.dmgdeadlock.com)
  --out DIR               results (default /tmp/mapcro-perf/out/<scenario>-<time>)
  --headed                show the browsers
  --max-load L            local: a run whose 1-min load average goes above L is marked INVALID
                          (default 4; other work on the machine pollutes client and fsync timings)`;

interface Opts {
  scenario: string;
  fs: string;
  browsers: number;
  viewers: number;
  peers: number;
  seconds: number;
  storm: number;
  prefill: number;
  actionEvery: number;
  cursorHz: number;
  bin: string;
  webDir: string;
  packs: string | undefined;
  url: string;
  out: string;
  headed: boolean;
  maxLoad: number;
}

function parse(argv: string[]): Opts {
  if (argv.includes("--help") || argv.includes("-h") || !argv[0]) {
    console.log(HELP);
    process.exit(0);
  }
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (k: string, d: number) => (get(k) === undefined ? d : Number(get(k)));
  const scenario = argv[0]!;
  const browsers = num("browsers", 3);
  const viewers = num("viewers", 0);
  const home = process.env.HOME ?? "";
  const packs = get("packs") ?? `${home}/.local/share/mapcro/packs`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fs = get("fs") ?? "disk";
  return {
    scenario,
    fs,
    browsers,
    viewers,
    peers: num("peers", browsers + viewers),
    seconds: num("seconds", 60),
    storm: num("storm", 0),
    prefill: num("prefill", 150),
    actionEvery: num("action-every", 3),
    cursorHz: num("cursor-hz", 5),
    bin: resolve(get("bin") ?? join(ROOT, "target/release/mapcro-server")),
    webDir: resolve(get("web-dir") ?? join(WEB, "dist")),
    packs,
    url: get("url") ?? "https://mapcro.dmgdeadlock.com",
    out: get("out") ?? join(tmpdir(), "mapcro-perf", "out", `${scenario}-${fs}-${stamp}`),
    headed: argv.includes("--headed"),
    maxLoad: num("max-load", 4),
  };
}

const fsDir = (fs: string) =>
  fs === "tmpfs" ? "/dev/shm" : fs === "btrfs" ? tmpdir() : process.env.PERF_DISK_DIR ?? "/storage/tmp-mapcro-perf";

/** A seeded uniform source for the browser drivers. */
function rand(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  if (process.argv[2] === "report") {
    // Re-run the analysis on a saved raw.json: `just perf report /tmp/mapcro-perf/out/<run>/raw.json`.
    const raw = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
    // Older raw files lack the phase times: take the first frame sent after everyone joined.
    const sent = (raw.dumps as Inputs["dumps"]).flatMap((d) => d.dump.sent.filter((s) => s.k === "submit").map((s) => s.t));
    const t0 = raw.t0 ?? Math.min(...sent) - 1000;
    const md = render(raw.opts, analyse({ o: raw.opts, board: raw.board, dumps: raw.dumps, reports: raw.reports, lines: raw.lines, t0, tRealEnd: raw.tRealEnd ?? t0 + raw.opts.seconds * 1000 }), raw.extra);
    writeFileSync(join(dirname(process.argv[3]!), "summary.md"), md);
    console.log(md);
    return;
  }
  const o = parse(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  const live = o.scenario === "live";
  if (live && (o.browsers + o.viewers > 5 || o.peers > 5 || o.seconds + o.storm > 120)) {
    throw new Error("live runs are capped: at most 5 clients and 120 s (the box hosts other services)");
  }

  // --- Server and board -----------------------------------------------------------------------
  let server: PerfServer | undefined;
  let http: string;
  let wsUrl: string;
  if (live) {
    http = o.url.replace(/\/$/, "");
    wsUrl = http.replace(/^http/, "ws") + "/ws";
  } else {
    const env: Record<string, string> = { WEB_DIR: o.webDir, BOARD_MAX_OPS: "1000000", BOARD_MAX_BYTES: String(512 * 2 ** 20) };
    if (o.packs) env.PACKS_DIR = o.packs;
    server = new PerfServer(o.bin, fsDir(o.fs), env);
    await server.start();
    http = server.http;
    wsUrl = server.ws;
  }
  const { board, owner } = await createBoard(http, "Untitled");
  const editToken = live ? owner : await mintLink(http, board, owner, "edit");
  const viewToken = o.viewers ? await mintLink(http, board, owner, "view") : "";
  const link = (t: string) => `${http}/b/${board}#${t}`;
  console.log(`board ${board} on ${live ? http : `${http} (data on ${o.fs}: ${server!.dataDir})`}`);

  // --- Node peers (load, and protocol-level probes) -------------------------------------------
  const nodeCount = live ? 0 : Math.max(0, o.peers - o.browsers - o.viewers);
  const specs: PeerSpec[] = Array.from({ length: nodeCount }, (_, i) => ({ who: `node${i}`, token: editToken, editor: true, probe: i < 2, ip: `10.77.0.${i + 1}` }));
  // A prefill needs a Node peer even when none are asked for; it only edits during the prefill.
  const prefillPeer = !live && o.prefill > 0 && nodeCount === 0;
  if (prefillPeer) specs.push({ who: "prefill", token: editToken, editor: false, probe: false, ip: "10.77.1.1" });
  const workers: Worker[] = [];
  const perWorker = 8;
  for (let i = 0; i < specs.length; i += perWorker) {
    const init: WorkerInit = {
      wasm: join(WEB, "src/wasm/mapcro_wasm_bg.wasm"),
      wsUrl,
      origin: http,
      board,
      peers: specs.slice(i, i + perWorker),
      seed: 1000 + i,
      actionEvery: o.actionEvery,
      cursorHz: o.cursorHz,
      prefill: i === 0 ? o.prefill : 0,
    };
    workers.push(new Worker(join(here, "worker.js"), { workerData: init }));
  }
  const ask = (w: Worker, t: string, want: string) =>
    new Promise<{ t: string; reports?: NodeReport[] }>((ok, fail) => {
      const on = (m: { t: string }) => {
        if (m.t === want) {
          w.off("message", on);
          ok(m);
        }
      };
      w.on("message", on);
      w.once("error", fail);
      w.postMessage({ t });
    });
  await Promise.all(workers.map((w) => ask(w, "start", "ready")));
  if (specs.length) console.log(`${nodeCount} node peers in ${workers.length} workers${o.prefill ? `, board prefilled with ${o.prefill} creates` : ""}`);

  // --- Browsers --------------------------------------------------------------------------------
  const probe = join(here, "probe.js");
  const people: Person[] = [];
  const names = ["Ana", "Ben", "Cy", "Dee", "Eli", "Fay"];
  for (let i = 0; i < o.browsers; i++) {
    people.push(await Person.join(link(editToken), names[i]!, { headless: !o.headed, probe, editor: true, failDir: o.out, joinTimeoutMs: Number(process.env.PERF_JOIN_TIMEOUT_MS ?? 180_000) }));
    console.log(`${names[i]} joined in ${people[i]!.joinMs} ms`);
  }
  for (let i = 0; i < o.viewers; i++) {
    const v = await Person.join(link(viewToken), `View${i + 1}`, { headless: !o.headed, probe, editor: false, failDir: o.out, joinTimeoutMs: Number(process.env.PERF_JOIN_TIMEOUT_MS ?? 180_000) });
    await v.follow(names[0]!);
    people.push(v);
  }
  console.log(`${people.length} browsers joined`);
  for (const p of people) p.sampleMemory(5000);
  const dom0 = people[1] ? await people[1].domNodes() : undefined;

  // --- Realistic phase -------------------------------------------------------------------------
  const t0 = Date.now();
  const loadStart = loadavg().map((l) => l.toFixed(1)).join(" ");
  const loadSamples: number[] = [loadavg()[0]!];
  const loadTimer = setInterval(() => loadSamples.push(loadavg()[0]!), 5000);
  server?.markCpu();
  for (const w of workers) w.postMessage({ t: "go" });
  let running = true;
  const loops = people
    .filter((p) => p.editor)
    .map(async (p, i) => {
      const rnd = rand(77 + i);
      await sleep(rnd() * o.actionEvery * 1000);
      while (running) {
        await p.act(rnd);
        // Between actions a person moves the mouse about (presence), then pauses.
        const gap = Math.min(4 * o.actionEvery, -Math.log(1 - rnd()) * o.actionEvery) * 1000;
        await p.hover(rnd, gap * 0.4);
        await sleep(gap * 0.6);
      }
    });
  // Watchdog: on a live server, stop at the first error (the box hosts other services).
  const end = Date.now() + o.seconds * 1000;
  const problems: string[] = [];
  while (Date.now() < end) {
    await sleep(Math.min(2000, end - Date.now()));
    for (const p of people) problems.push(...(await p.health()).map((e) => `${p.name}: ${e}`));
    if (problems.length) {
      console.log(`errors seen, stopping early: ${problems.slice(0, 5).join("; ")}`);
      if (live) break;
      problems.length = 0;
    }
  }
  running = false;
  const aborted = live && problems.length > 0;
  if (aborted) o.storm = 0;
  await Promise.all(loops);
  const cpuRealistic = server?.cpuSince();
  const tRealEnd = Date.now();

  // --- Drag storm: everyone else drags back to back; one observer is traced -------------------
  const traces: Record<string, unknown> = {};
  const observer = people.find((p, i) => i === 1 && p.editor) ?? people.find((p) => !p.editor);
  if (o.storm > 0 && observer) {
    server?.markCpu();
    const draggers = people.filter((p) => p !== observer && p.editor);
    let storming = true;
    const storm = draggers.map(async (p, i) => {
      const rnd = rand(500 + i);
      while (storming) {
        await p.drag(rnd, 20).catch(() => {});
        await sleep(80);
      }
    });
    await sleep(1000);
    const half = (o.storm * 1000) / 2;
    const tracePath = join(o.out, `trace-${observer.name}.json`);
    await observer.frames(true);
    await observer.startTrace(tracePath);
    await sleep(half);
    await observer.stopTrace();
    await observer.frames(false);
    const profPath = join(o.out, `profile-${observer.name}.cpuprofile`);
    await observer.startProfile();
    await sleep(half);
    const prof = await observer.stopProfile(profPath);
    storming = false;
    await Promise.all(storm);
    traces.trace = readTrace(tracePath);
    traces.profile = { file: profPath, top: selfTimes(prof, 30) };
    traces.stormCpu = server?.cpuSince();
    console.log(`storm traced on ${observer.name}: ${tracePath}`);
  }

  clearInterval(loadTimer);
  loadSamples.push(loadavg()[0]!);
  // --- Collect -------------------------------------------------------------------------------
  const dom1 = people[1] ? await people[1].domNodes() : undefined;
  const dumps: Array<{ name: string; editor: boolean; dump: ProbeDump; mem: Person["mem"] }> = [];
  for (const p of people) dumps.push({ name: p.name, editor: p.editor, dump: await p.dump(), mem: p.mem });
  const reports: NodeReport[] = [];
  for (const w of workers) reports.push(...((await ask(w, "stop", "report")).reports ?? []));
  for (const w of workers) void w.terminate();
  for (const p of people) await p.close();
  const lines = server?.perfLines() ?? [];
  const peakRssMb = server ? server.peakRssKb / 1024 : undefined;
  const cpuSeries = server?.cpuSeries ?? [];
  server?.stop();

  const result = analyse({ o, board, dumps, reports, lines, t0, tRealEnd });
  const extra = {
    actions: people.map((p) => ({ name: p.name, actions: p.actions, failures: p.failures, joinMs: p.joinMs, joinAfterNameMs: p.joinAfterNameMs })),
    cpuRealistic,
    peakRssMb,
    cpuSeries,
    dom0,
    dom1,
    traces,
    loadStart,
    loadMax: Math.max(...loadSamples),
    loadValid: live || Math.max(...loadSamples) <= o.maxLoad,
    problems,
  };
  writeFileSync(join(o.out, "raw.json"), JSON.stringify({ opts: o, board, dumps, reports, lines, extra, t0, tRealEnd }, null, 0));
  const md = render(o, result, extra);
  writeFileSync(join(o.out, "summary.md"), md);
  console.log(md);
  console.log(`\nresults: ${o.out}`);
  process.exit(0);
}

// --- Analysis ----------------------------------------------------------------------------------

interface Inputs {
  o: Opts;
  board: string;
  dumps: Array<{ name: string; editor: boolean; dump: ProbeDump; mem: Person["mem"] }>;
  reports: NodeReport[];
  lines: PerfLine[];
  t0: number;
  tRealEnd: number;
}

type Rows = Array<[string, Summary]>;

function analyse(x0: Inputs) {
  const S = (xs: number[]) => summarize(xs);
  // Server lines from the measured phases only (not the prefill burst or the joins).
  const x = { ...x0, lines: x0.lines.filter((l) => Number(l.ts) >= x0.t0) };
  // Every submit, by client:cseq.
  const submits = new Map<string, { t: number; who: string; browser: boolean; op: string }>();
  const clientOf = new Map<string, string>(); // client id -> who
  for (const d of x.dumps)
    for (const s of d.dump.sent)
      if (s.k === "submit") {
        submits.set(`${s.client}:${s.cseq}`, { t: s.t, who: d.name, browser: true, op: String(s.op) });
        clientOf.set(String(s.client), d.name);
      }
  for (const r of x.reports)
    for (const s of r.submits) {
      submits.set(`${s.client}:${s.cseq}`, { t: s.t, who: r.who, browser: false, op: s.op });
      clientOf.set(s.client, r.who);
    }
  // Server stages, by seq.
  const txBySeq = new Map<number, PerfLine>();
  for (const l of x.lines) if (l.kind === "tx" && Number(l.seq) > 0) txBySeq.set(Number(l.seq), l);

  // --- A's side: input → send (browser editors) --------------------------------------------------
  const inputToSend: number[] = [];
  const byOpSend = new Map<string, { send: number[]; render: number[] }>();
  // A's chain per submit: input → edit() → (A's own render) → IDB put → commit → frame sent.
  const aPre: number[] = [];
  const aRender: number[] = [];
  const aIdb: number[] = [];
  const aPost: number[] = [];
  const editWasm: number[] = [];
  const stateWasm: number[] = [];
  const idbMs: number[] = [];
  const idbBytes: number[] = [];
  const ack: number[] = [];
  const ackBrowser: number[] = [];
  for (const d of x.dumps) {
    const p = d.dump;
    for (const r of p.idb) {
      if (r.key.includes("role")) continue;
      idbMs.push(r.done - r.t);
      idbBytes.push(r.bytes);
    }
    for (const s of p.sent) {
      if (s.k !== "submit") continue;
      const inp = [...p.input].reverse().find((i) => i.t <= s.t && s.t - i.t < 1500);
      if (inp) {
        inputToSend.push(s.t - inp.t);
        var b = byOpSend.get(String(s.op)) ?? { send: [], render: [] };
        b.send.push(s.t - inp.t);
        byOpSend.set(String(s.op), b);
        const e = p.wasmCalls.filter((c) => c.t >= inp.t && c.t <= s.t);
        const ed = e.filter((c) => c.name === "edit").pop();
        const st = e.filter((c) => c.name === "state").pop();
        if (ed) editWasm.push(ed.ms);
        if (st) stateWasm.push(st.ms);
        const save = ed && [...p.idb].reverse().find((r) => r.t >= ed.t && r.done <= s.t + 0.5 && !r.key.includes("role"));
        if (ed && save) {
          aPre.push(ed.t - inp.t);
          aRender.push(save.t - ed.t - ed.ms);
          aIdb.push(save.done - save.t);
          aPost.push(s.t - save.done);
          b.render.push(save.t - ed.t - ed.ms);
        }
      }
      const own = p.recv.find((r) => r.k === "entry" && r.client === s.client && r.cseq === s.cseq);
      if (own) {
        ack.push(own.t - s.t);
        ackBrowser.push(own.t - s.t);
      }
    }
  }
  for (const r of x.reports)
    for (const s of r.submits) {
      const own = r.entries.find((e) => e.client === s.client && e.cseq === s.cseq);
      if (own) ack.push(own.t - s.t);
    }

  // --- B's side: receive, apply, paint (browser receivers of others' edits) ----------------------
  const oneWay: number[] = [];
  const oneWayFromBrowser: number[] = [];
  const handler: number[] = [];
  const wasmRecv: number[] = [];
  const parseMs: number[] = [];
  const solid: number[] = [];
  const toRaf: number[] = [];
  const toPaint: number[] = [];
  const e2e: number[] = [];
  const serverTotal: number[] = [];
  const netUp: number[] = []; // submit → server dispatch start (network + socket task + room queue)
  const byOp = new Map<string, { n: number; ms: number[]; attrs: number[]; added: number[]; removed: number[]; bytes: number[] }>();
  const readyOf = (p: ProbeDump) => p.recv.find((r) => r.k === "ready")?.t ?? 0;
  // Joining: the catch-up entries a fresh client replays (and renders) after its base.
  const joins = x.dumps.map((d) => {
    const ready = readyOf(d.dump);
    const cu = d.dump.recv.filter((r) => r.k === "entry" && r.t >= ready && r.t < x.t0 && (submits.get(`${r.client}:${r.cseq}`)?.t ?? Infinity) < ready);
    const base = d.dump.recv.find((r) => r.k === "ready");
    return { name: d.name, entries: cu.length, handlerMs: cu.reduce((a, r) => a + r.ms, 0), spanMs: cu.length ? cu[cu.length - 1]!.t + cu[cu.length - 1]!.ms - ready : 0, baseBytes: Number(base?.base ?? 0), added: cu.reduce((a, r) => a + r.added, 0) };
  });
  const rebuilt = new Map<string, Map<string, number[]>>();
  for (const d of x.dumps) {
    const p = d.dump;
    const ready = readyOf(p);
    for (const r of p.recv) {
      if (r.k !== "entry") continue;
      const key = `${r.client}:${r.cseq}`;
      const s = submits.get(key);
      if (!s || s.who === d.name) continue; // own acks are A's side
      if (s.t < ready + 500) continue; // catch-up after joining, not live traffic
      const rb = r.rebuilt as Record<string, number> | undefined;
      if (rb) {
        const m = rebuilt.get(String(r.op)) ?? new Map<string, number[]>();
        for (const [k, v] of Object.entries(rb)) m.set(k, [...(m.get(k) ?? []), v]);
        rebuilt.set(String(r.op), m);
      }
      oneWay.push(r.t - s.t);
      if (s.browser) oneWayFromBrowser.push(r.t - s.t);
      handler.push(r.ms);
      wasmRecv.push(r.wasm);
      parseMs.push(r.parse);
      solid.push(r.ms - r.wasm - r.parse);
      if (r.raf) toRaf.push(r.raf - r.t);
      if (r.painted) toPaint.push(r.painted - r.t);
      const op = String(r.op);
      const b = byOp.get(op) ?? { n: 0, ms: [], attrs: [], added: [], removed: [], bytes: [] };
      b.n++;
      b.ms.push(r.ms);
      b.attrs.push(r.attrs);
      b.added.push(r.added);
      b.removed.push(r.removed);
      b.bytes.push(r.bytes);
      byOp.set(op, b);
      if (s.browser && r.painted) {
        const sender = x.dumps.find((q) => q.name === s.who)!.dump;
        const inp = [...sender.input].reverse().find((i) => i.t <= s.t && s.t - i.t < 1500);
        if (inp) e2e.push(r.painted - inp.t);
      }
    }
  }
  for (const l of x.lines) if (l.kind === "tx") serverTotal.push((Number(l.queue_us) + Number(l.total_us)) / 1000);
  // Network legs: one-way minus the server's own time, per transaction where we can join by seq.
  const legs: number[] = [];
  for (const d of x.dumps)
    for (const r of d.dump.recv) {
      if (r.k !== "entry") continue;
      const s = submits.get(`${r.client}:${r.cseq}`);
      const l = txBySeq.get(Number(r.seq));
      if (!s || !l || s.who === d.name || s.t < readyOf(d.dump) + 500) continue;
      legs.push(r.t - s.t - (Number(l.queue_us) + Number(l.total_us)) / 1000);
    }
  for (const r of x.reports)
    for (const e of r.entries) {
      const s = submits.get(`${e.client}:${e.cseq}`);
      if (!s || s.who === r.who || s.t < r.readyT + 500) continue;
      oneWay.push(e.t - s.t);
      const l = txBySeq.get(e.seq);
      if (l) netUp.push(e.t - s.t - (Number(l.queue_us) + Number(l.total_us)) / 1000);
    }
  const nodeRecv = x.reports.flatMap((r) => r.entries.filter((e) => submits.get(`${e.client}:${e.cseq}`)?.who !== r.who && e.t > r.readyT + 500).map((e) => e.recvMs));
  const nodeChanged = x.reports.flatMap((r) => r.entries.map((e) => e.changed));
  const nodeUpd = x.reports.flatMap((r) => r.entries.map((e) => e.updBytes));

  // --- Presence ---------------------------------------------------------------------------------
  // Presence: match each receipt to the latest send of the same state by that peer.
  const psend = new Map<string, number[]>();
  const addSend = (k: string, t: number) => psend.set(k, [...(psend.get(k) ?? []), t]);
  const sentAt = (k: string, t: number) => {
    const ts = psend.get(k);
    if (!ts) return undefined;
    let best: number | undefined;
    for (const s of ts) if (s <= t + 0.5 && (best === undefined || s > best)) best = s;
    return best !== undefined && t - best < 5000 ? best : undefined;
  };
  for (const d of x.dumps) {
    if (d.dump.me == null) continue;
    for (const s of d.dump.sent) {
      if (s.k !== "presence") continue;
      const drag = s.drag as { x: number; y: number } | null;
      addSend(`${d.dump.me}|${presenceKey({ cursor: s.cursor as { x: number; y: number } | null, drag: drag ? { pos: drag } : null, focus: (s.focus as string | null) ?? null })}`, s.t);
    }
  }
  for (const r of x.reports) if (r.peer != null) for (const s of r.psent) addSend(`${r.peer}|${s.key}`, s.t);
  const pOneWay: number[] = [];
  const pOneWayBrowser: number[] = [];
  const pHandler: number[] = [];
  const pPaint: number[] = [];
  const pEntries: number[] = [];
  const pAttrs: number[] = [];
  const pAdded: number[] = [];
  for (const d of x.dumps) {
    const ready = readyOf(d.dump);
    for (const r of d.dump.recv) {
      if (r.k !== "presence" || r.t < ready + 1000) continue;
      const peers = (r.peers as Array<{ peer: number; cursor: { x: number; y: number } | null; drag: { x: number; y: number } | null; focus: string | null }>) ?? [];
      pEntries.push(peers.length);
      pHandler.push(r.ms);
      pAttrs.push(r.attrs);
      pAdded.push(r.added + r.removed);
      if (r.painted) pPaint.push(r.painted - r.t);
      for (const q of peers) {
        const t = sentAt(`${q.peer}|${presenceKey({ cursor: q.cursor, drag: q.drag ? { pos: q.drag } : null, focus: q.focus ?? null })}`, r.t);
        if (t !== undefined) {
          pOneWay.push(r.t - t);
          pOneWayBrowser.push(r.t - t);
        }
      }
    }
  }
  // How steppy a remote drag looks: the gap between successive drag positions from one peer.
  const dragGap: number[] = [];
  for (const d of x.dumps) {
    const last = new Map<number, number>();
    for (const r of d.dump.recv) {
      if (r.k !== "presence") continue;
      for (const q of (r.peers as Array<{ peer: number; drag: unknown }>) ?? []) {
        if (!q.drag) {
          last.delete(q.peer);
          continue;
        }
        const prev = last.get(q.peer);
        if (prev !== undefined && r.t - prev < 1000) dragGap.push(r.t - prev);
        last.set(q.peer, r.t);
      }
    }
  }
  for (const r of x.reports)
    for (const q of r.precv) {
      if (q.t < r.readyT + 1000) continue;
      const t = sentAt(`${q.peer}|${q.key}`, q.t);
      if (t !== undefined) pOneWay.push(q.t - t);
    }
  const seconds = (x.tRealEnd - x.t0) / 1000;
  const rx = x.reports.map((r) => ({ who: r.who, bytesPerSec: r.rxBytes / seconds, presenceBytesPerSec: r.rxPresenceBytes / seconds, presenceFramesPerSec: r.rxPresenceFrames / seconds }));

  // --- Server -----------------------------------------------------------------------------------
  const tx = x.lines.filter((l) => l.kind === "tx");
  const ap = x.lines.filter((l) => l.kind === "append");
  const fl = x.lines.filter((l) => l.kind === "flush");
  const busy = x.lines.filter((l) => l.kind === "busy");
  const us = (ls: PerfLine[], k: string) => ls.map((l) => Number(l[k]) / 1000);
  const util = busy.map((b) => (Number(b.msg_us) + Number(b.presence_us) + Number(b.join_us) + Number(b.other_us) + Number(b.flush_us)) / Number(b.window_us) * 100);
  const serverRows: Rows = [
    ["room queue wait (socket → room)", S(us(tx, "queue_us"))],
    ["apply (validate, sequence, encode)", S(us(tx, "apply_us"))],
    ["durable write (all effects)", S(us(tx, "store_us"))],
    ["  append: spawn + lock wait", S(us(ap, "wait_us"))],
    ["  append: INSERT + commit (fsync)", S(us(ap, "exec_us"))],
    ["fan-out (serialize + queue to peers)", S(us(tx, "fanout_us"))],
    ["presence flush (per batch)", S(us(fl, "us"))],
    ["presence flush lateness", S(us(fl, "late_us"))],
  ];
  const flushFrames = S(fl.map((l) => Number(l.frames)));
  const flushBytes = S(fl.map((l) => Number(l.bytes)));
  const flushBatch = S(fl.map((l) => Number(l.batch)));
  const flushBytesPerSec = fl.reduce((a, l) => a + Number(l.bytes), 0) / Math.max(1, seconds + x.o.storm);

  // --- Memory -----------------------------------------------------------------------------------
  const mem = x.dumps.map((d) => {
    const m = d.mem;
    const a = m[0];
    const b = m[m.length - 1];
    const mins = a && b ? (b.t - a.t) / 60000 : 0;
    return { name: d.name, heapStartMb: a?.heapMb, heapEndMb: b?.heapMb, heapMaxMb: Math.max(...m.map((s) => s.heapMb)), nodesStart: a?.nodes, nodesEnd: b?.nodes, listenersEnd: b?.listeners, minutes: mins };
  });
  const wasmTotals = x.dumps.map((d) => ({ name: d.name, calls: Object.entries(d.dump.wasm).filter(([, v]) => v.n).sort((a, b) => b[1].ms - a[1].ms).slice(0, 6) }));
  const longTasks = x.dumps.map((d) => ({ name: d.name, n: d.dump.longTasks.length, ms: d.dump.longTasks.reduce((a, l) => a + l.ms, 0), max: Math.max(0, ...d.dump.longTasks.map((l) => l.ms)) }));
  const frames = x.dumps.filter((d) => d.dump.frames?.length).map((d) => {
    const f = d.dump.frames!;
    const iv = f.slice(1).map((t, i) => t - f[i]!);
    return { name: d.name, frames: f.length, interval: S(iv), over33: iv.filter((v) => v > 33.4).length, over50: iv.filter((v) => v > 50).length };
  });

  const editRows: Rows = [
    ["A: input → frame sent (all of it)", S(inputToSend)],
    ["  A: input → edit() called", S(aPre)],
    ["  A: WASM edit()", S(editWasm)],
    ["  A: own apply + render (edit() → IDB put)", S(aRender)],
    ["  A: WASM state() (whole replica)", S(stateWasm)],
    ["  A: IndexedDB put → commit (this save)", S(aIdb)],
    ["  A: commit → frame sent", S(aPost)],
    ["A: IndexedDB put → commit (every save)", S(idbMs)],
    ["network + server: A sent → B received", S(oneWay)],
    ["  server: room queue + handling", S(serverTotal)],
    ["  network legs (one-way − server, browsers)", S(legs)],
    ["  network legs (one-way − server, Node)", S(netUp)],
    ["B: frame handler (all, sync)", S(handler)],
    ["  B: WASM receive()", S(wasmRecv)],
    ["  B: JSON.parse (frame + Update)", S(parseMs)],
    ["  B: Solid store + DOM writes", S(solid)],
    ["B: received → next animation frame", S(toRaf)],
    ["B: received → painted", S(toPaint)],
    ["**End to end: A input → B painted**", S(e2e)],
    ["A: own ack (sent → own entry back), all", S(ack)],
    ["A: own ack, browsers only", S(ackBrowser)],
  ];
  const presenceRows: Rows = [
    ["client throttle (by design)", { n: 0, p50: 25, p95: 47.5, p99: 49.5, mean: 25, max: 50 }],
    ["A sent → B received (incl. 50 ms batch)", S(pOneWay)],
    ["  browsers only", S(pOneWayBrowser)],
    ["B: presence handler (all, sync)", S(pHandler)],
    ["B: received → painted", S(pPaint)],
    ["B: gap between a remote drag's updates", S(dragGap)],
  ];
  const rebuiltRows = [...rebuilt].map(([op, m]) => ({
    op,
    subtrees: [...m].map(([k, v]) => ({ k, perOp: v.length, nodesP50: summarize(v).p50 })).sort((a, b) => b.nodesP50 * b.perOp - a.nodesP50 * a.perOp).slice(0, 8),
  }));
  const opRows = [...byOp].sort((a, b) => b[1].n - a[1].n).map(([op, b]) => ({ op, n: b.n, handler: S(b.ms), attrs: S(b.attrs), added: S(b.added), removed: S(b.removed), bytes: S(b.bytes) }));
  return {
    editRows,
    presenceRows,
    serverRows,
    opRows,
    sendRows: [...byOpSend].map(([op, b]) => ({ op, send: S(b.send), render: S(b.render) })),
    rebuiltRows,
    joins,
    churn: {
      peers: x.reports.length,
      connects: x.reports.reduce((a, r) => a + (r.connects ?? 0), 0),
      closes: x.reports.reduce((a, r) => {
        for (const [k, v] of Object.entries(r.closes ?? {})) a[k] = (a[k] ?? 0) + v;
        return a;
      }, {} as Record<string, number>),
    },
    nodeRecv: S(nodeRecv),
    nodeChanged: S(nodeChanged),
    nodeUpd: S(nodeUpd),
    idbBytes: S(idbBytes),
    presence: { entriesPerFrame: S(pEntries), attrs: S(pAttrs), nodes: S(pAdded), flushFrames, flushBytes, flushBatch, flushBytesPerSec, rx },
    roomUtil: S(util),
    txCount: tx.length,
    txPerSec: tx.length / Math.max(1, seconds + x.o.storm),
    mem,
    wasmTotals,
    longTasks,
    frames,
  };
}

function render(o: Opts, r: ReturnType<typeof analyse>, extra: Record<string, unknown>): string {
  const f1 = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? "–" : n.toFixed(1));
  const out: string[] = [];
  out.push(`# perf ${o.scenario} (${o.scenario === "live" ? o.url : `fs=${o.fs}`}), ${o.browsers} browser editors, ${o.viewers} viewers, ${o.peers} peers, ${o.seconds}s + storm ${o.storm}s`);
  if (extra.loadMax !== undefined)
    out.push(`load average (1 min): max ${f1(extra.loadMax as number)} during the run, ${extra.loadStart} at start — ${extra.loadValid ? "VALID" : `**INVALID: above ${o.maxLoad ?? 4}, the machine was busy**`}`);
  out.push(`transactions: ${r.txCount || "(server not instrumented)"} (${f1(r.txPerSec)}/s)`);
  out.push("\n## Edit path (ms)\n" + table(r.editRows));
  out.push(`\nNode replica receive(): ${f1(r.nodeRecv.p50)} / ${f1(r.nodeRecv.p95)} / ${f1(r.nodeRecv.p99)} ms (p50/p95/p99); changed per entry p50 ${r.nodeChanged.p50}, max ${r.nodeChanged.max}; Update JSON p50 ${r.nodeUpd.p50} B, max ${r.nodeUpd.max} B`);
  out.push(`IndexedDB save size (whole replica state): p50 ${f1(r.idbBytes.p50 / 1024)} KiB, max ${f1(r.idbBytes.max / 1024)} KiB`);
  out.push("\nA: input → sent, by op (ms): " + r.sendRows.map((x) => `${x.op} n=${x.send.n} p50 ${f1(x.send.p50)} p95 ${f1(x.send.p95)}${x.render.n ? ` (A's own render p50 ${f1(x.render.p50)} p95 ${f1(x.render.p95)})` : ""}`).join("; "));
  out.push("\n## Remote op cost on a browser receiver, by op\n");
  out.push("| op | n | handler p50 | p95 | max | attrs p50 | nodes added p50 | added max | frame bytes p50 |");
  out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const x of r.opRows) out.push(`| ${x.op} | ${x.n} | ${f1(x.handler.p50)} | ${f1(x.handler.p95)} | ${f1(x.handler.max)} | ${x.attrs.p50} | ${x.added.p50} | ${x.added.max} | ${x.bytes.p50} |`);
  out.push("\nSubtrees a remote op rebuilt (added elements ≥5 nodes; occurrences, nodes p50):");
  for (const x of r.rebuiltRows) out.push(`- ${x.op}: ${x.subtrees.map((s) => `${s.k} ×${s.perOp} (${s.nodesP50})`).join("; ")}`);
  out.push("\n## Presence (ms)\n" + table(r.presenceRows));
  const p = r.presence;
  out.push(`\npresence entries per received frame p50 ${p.entriesPerFrame.p50}, max ${p.entriesPerFrame.max}; DOM attrs per presence frame p50 ${p.attrs.p50}, max ${p.attrs.max}`);
  out.push(`server presence flush: batch p50 ${p.flushBatch.p50} (max ${p.flushBatch.max}), frames p50 ${p.flushFrames.p50}, bytes per flush p50 ${p.flushBytes.p50} (max ${p.flushBytes.max}); presence out ${f1(p.flushBytesPerSec / 1024)} KiB/s`);
  if (p.rx.length) {
    const avg = (k: "bytesPerSec" | "presenceBytesPerSec" | "presenceFramesPerSec") => p.rx.reduce((a, x) => a + x[k], 0) / p.rx.length;
    out.push(`Node peers: ${r.churn.connects} connections for ${r.churn.peers} peers; closes ${JSON.stringify(r.churn.closes)}`);
    out.push(`per Node peer received: ${f1(avg("bytesPerSec") / 1024)} KiB/s (${f1(avg("presenceBytesPerSec") / 1024)} KiB/s presence in ${f1(avg("presenceFramesPerSec"))} frames/s)`);
  }
  out.push("\n## Server (ms)\n" + table(r.serverRows));
  out.push(`\nroom task busy (% of wall time, per 1 s window): p50 ${f1(r.roomUtil.p50)}, p95 ${f1(r.roomUtil.p95)}, max ${f1(r.roomUtil.max)}`);
  out.push(`server CPU (realistic phase): ${JSON.stringify(extra.cpuRealistic)}; peak RSS ${f1(extra.peakRssMb as number)} MB`);
  out.push("\n## Client\n");
  for (const j of r.joins) out.push(`join ${j.name}: base ${f1(j.baseBytes / 1024)} KiB, then ${j.entries} catch-up entries: ${f1(j.handlerMs)} ms of handlers over ${f1(j.spanMs)} ms, ${j.added} nodes added`);
  out.push(`DOM before/after: ${JSON.stringify(extra.dom0)} → ${JSON.stringify(extra.dom1)}`);
  for (const m of r.mem) out.push(`memory ${m.name}: heap ${f1(m.heapStartMb)} → ${f1(m.heapEndMb)} MB (max ${f1(m.heapMaxMb)}) over ${f1(m.minutes)} min; nodes ${m.nodesStart} → ${m.nodesEnd}; listeners ${m.listenersEnd}`);
  for (const l of r.longTasks) out.push(`long tasks ${l.name}: ${l.n} (${f1(l.ms)} ms total, longest ${f1(l.max)} ms)`);
  for (const w of r.wasmTotals) out.push(`wasm ${w.name}: ${w.calls.map(([k, v]) => `${k.replace("boardreplica_", "")} ${v.n}× ${f1(v.ms)} ms`).join(", ")}`);
  for (const fr of r.frames) out.push(`frames ${fr.name}: ${fr.frames}, interval p50 ${f1(fr.interval.p50)} p99 ${f1(fr.interval.p99)} max ${f1(fr.interval.max)} ms; >33 ms: ${fr.over33}, >50 ms: ${fr.over50}`);
  out.push(`actions: ${JSON.stringify(extra.actions)}`);
  const tr = (extra.traces as Record<string, unknown>) ?? {};
  if (tr.trace) out.push(`\n## Storm trace\n\n\`\`\`\n${JSON.stringify(tr.trace, null, 1)}\n\`\`\``);
  if (tr.profile) {
    const pr = tr.profile as { file: string; top: Array<{ fn: string; ms: number; pct: number }> };
    out.push(`\n## Storm CPU profile (${pr.file}), self time\n`);
    for (const t of pr.top) out.push(`- ${t.fn}: ${f1(t.ms)} ms (${f1(t.pct)}%)`);
  }
  if (tr.stormCpu) out.push(`\nserver CPU (storm): ${JSON.stringify(tr.stormCpu)}`);
  return out.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
