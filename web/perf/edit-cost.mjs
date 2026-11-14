// What one edit costs in the browser on a board full of saved scenes (map-state spec §6, "Edit
// cost"): the real WASM replica in Chromium, loaded with a board dumped by the engine's
// `scene_cost` example, timing the calls a drag makes on every frame (an edit, then its ack),
// a peer's entry, and the whole-state save. `just edit-cost` runs it; nothing is written to
// the repo.
//
// node perf/edit-cost.mjs <base.json> [runs]

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const [basePath, runsArg] = process.argv.slice(2);
if (!basePath) {
  console.error("usage: node perf/edit-cost.mjs <base.json> [runs]");
  process.exit(2);
}
const runs = Number(runsArg ?? 300);
const files = {
  "/": ["text/html", "<!doctype html><title>edit cost</title>"],
  "/base.json": ["application/json", readFileSync(basePath)],
  "/mapcro_wasm.js": ["text/javascript", readFileSync(join(here, "../src/wasm/mapcro_wasm.js"))],
  "/mapcro_wasm_bg.wasm": ["application/wasm", readFileSync(join(here, "../src/wasm/mapcro_wasm_bg.wasm"))],
};
const server = createServer((req, res) => {
  const f = files[req.url ?? "/"];
  if (!f) return res.writeHead(404).end();
  // Cross-origin isolated: performance.now() is then fine to 5 µs, not 100.
  res.writeHead(200, { "content-type": f[0], "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" }).end(f[1]);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(url);
  const out = await page.evaluate(async (runs) => {
    const m = await import("/mapcro_wasm.js");
    await m.default({ module_or_path: "/mapcro_wasm_bg.wasm" });
    const base = await (await fetch("/base.json")).text();
    const replica = new m.BoardReplica(m.newClientId(), m.newClientSecret(), base);
    replica.connect();
    const view = JSON.parse(replica.view());
    const heroes = view.filter(([, e]) => !e.deleted && "PlayerState" in e.record).map(([id]) => id);
    const hero = heroes[heroes.length - 1];
    const stats = (ms) => {
      const s = [...ms].sort((a, b) => a - b);
      return { median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
    };
    const move = (x, y) => JSON.stringify([{ Set: { id: hero, value: { PlayerPos: { x, y } } } }]);
    let seq = 0;
    const edit = [], ack = [], peer = [], parse = [];
    // Warm up, then a drag: an edit and its ack, a frame each.
    for (let i = 0; i < runs + 20; i++) {
      const t0 = performance.now();
      const u = replica.edit(move(i + 1, 0));
      const t1 = performance.now();
      const update = JSON.parse(u);
      const t2 = performance.now();
      const tx = update.frames[0].msg.Submit;
      const frame = JSON.stringify({ t: "msg", msg: { Entry: { seq: ++seq, tx } } });
      const t3 = performance.now();
      const a = replica.receive(frame);
      const t4 = performance.now();
      if (JSON.parse(a).changed.length !== 0) throw new Error("an ack changed the view");
      if (update.changed.length !== 1) throw new Error("an edit changed " + update.changed.length + " records");
      if (i >= 20) (edit.push(t1 - t0), parse.push(t2 - t1), ack.push(t4 - t3));
    }
    // Someone else's drag arriving, with nothing pending here.
    for (let i = 0; i < runs + 20; i++) {
      const tx = { client: "000000000000000000000000000000ff", cseq: i, kind: "Edit", ops: JSON.parse(move(i + 1, 1)) };
      const frame = JSON.stringify({ t: "msg", msg: { Entry: { seq: ++seq, tx } } });
      const t0 = performance.now();
      const u = replica.receive(frame);
      const t1 = performance.now();
      if (JSON.parse(u).changed.length !== 1) throw new Error("a peer's entry changed something else");
      if (i >= 20) peer.push(t1 - t0);
    }
    // Someone else's drag arriving while an edit of ours is pending (the view is rebuilt).
    const under = [];
    replica.edit(move(-1, -1));
    for (let i = 0; i < Math.min(runs, 60) + 5; i++) {
      const tx = { client: "000000000000000000000000000000ff", cseq: runs + 20 + i, kind: "Edit", ops: [{ Set: { id: heroes[0], value: { PlayerPos: { x: i + 1, y: 2 } } } }] };
      const frame = JSON.stringify({ t: "msg", msg: { Entry: { seq: ++seq, tx } } });
      const t0 = performance.now();
      replica.receive(frame);
      const t1 = performance.now();
      if (i >= 5) under.push(t1 - t0);
    }
    const save = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      replica.state();
      const t1 = performance.now();
      if (i >= 2) save.push(t1 - t0);
    }
    return { records: view.length, heroes: heroes.length, baseKiB: Math.round(base.length / 1024), isolated: crossOriginIsolated, edit: stats(edit), parse: stats(parse), ack: stats(ack), peer: stats(peer), under: stats(under), save: stats(save) };
  }, runs);
  const ms = (s) => `median ${s.median.toFixed(2)} ms  p95 ${s.p95.toFixed(2)}  max ${s.max.toFixed(2)}`;
  console.log(`records ${out.records}  heroes ${out.heroes}  base ${out.baseKiB} KiB  runs ${runs}  timer ${out.isolated ? "5 µs" : "100 µs"}`);
  console.log(`local edit (replica.edit)              ${ms(out.edit)}`);
  console.log(`its ack (replica.receive)              ${ms(out.ack)}`);
  console.log(`a peer's entry, nothing pending        ${ms(out.peer)}`);
  console.log(`a peer's entry under a pending edit    ${ms(out.under)}`);
  console.log(`whole-state save (replica.state)       ${ms(out.save)}`);
  console.log(`a drag frame (edit + ack), medians     ${(out.edit.median + out.ack.median).toFixed(2)} ms`);
} finally {
  await browser.close();
  server.close();
}
