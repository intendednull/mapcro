// How long a tab switch takes in a session of two boards, each with a real replay (sessions.md
// §5 "Target", §10 phase 3: measured before the pool and the caches, and after). Never committed
// data: skipped without MAPCRO_SHOT_REPLAY (a parsed timeline, as perf-replay.spec.ts), and it
// prints numbers only, never a name.
//
// One switch, timed in the page from the click on the tab:
//   mounted   the new board's root is in the page
//   drawn     its document is drawn (its scene cards)
//   timeline  its match is drawn (the clock)
//   live      its room answered Ready (the socket's first `ready` after the click)
// Three kinds of switch: to a board this browser never opened (nothing stored), to one it left
// earlier, and the same with HTTP held to 40 ms and 20 Mbit/s (the socket isn't slowed: Chromium
// throttles HTTP only).
// MAPCRO_PERF_EVICT=1 also times a switch back to a board the pool has dropped (four others
// opened since).

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

const src = process.env.MAPCRO_SHOT_REPLAY;
const ID = process.env.MAPCRO_SHOT_REPLAY_ID ?? "129738985";
/** The second board's match: the same timeline under another id. */
const ID_B = String(Number(ID) + 1);
const ROUNDS = Number(process.env.MAPCRO_PERF_ROUNDS ?? "7");
const SCENES = Number(process.env.MAPCRO_PERF_SCENES ?? "0");
let server: Server;

test.skip(!src, "set MAPCRO_SHOT_REPLAY to a parsed timeline");
test.skip(({ browserName }) => browserName !== "chromium", "Chromium-only: heap and network throttling over a CDP session");

test.beforeAll(async () => {
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-perf-")), MATCH_API_BASE: "http://127.0.0.1:9", REPLAY_PER_CLIENT_PER_HOUR: "200" });
  const dir = join(server.dataDir, "replays");
  mkdirSync(dir, { recursive: true });
  copyFileSync(src!, join(dir, `${ID}-cdn.json`));
  const other = JSON.parse(readFileSync(src!, "utf8")) as { match_id: number };
  other.match_id = Number(ID_B);
  writeFileSync(join(dir, `${ID_B}-cdn.json`), JSON.stringify(other));
  await server.start();
});
test.afterAll(() => server?.stop());

const parts = (url: string) => {
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  return { board: board!, token: token! };
};

interface Times {
  mounted: number;
  drawn: number;
  timeline: number;
  live: number;
}

/** Click the tab of `board` and time it, in the page's clock. */
async function switchTo(p: Page, board: string): Promise<Times> {
  const t = await p.evaluate(
    (board) =>
      new Promise<Times>((done) => {
        const w = window as unknown as { __ready: number[] };
        const tab = document.querySelector<HTMLElement>(`[data-testid="game-tab"][data-board="${board}"]`)!;
        const t0 = performance.now();
        const out: Partial<Times> = {};
        const tick = () => {
          const now = performance.now() - t0;
          const root = document.querySelector(`[data-testid="board"][data-board="${board}"]`);
          if (root) {
            out.mounted ??= now;
            if (root.querySelector('[data-testid="scene-card"]')) out.drawn ??= now;
            if (root.querySelector('[data-testid="match-clock"]')) out.timeline ??= now;
          }
          const ready = w.__ready.find((at) => at > t0);
          if (ready !== undefined) out.live ??= ready - t0;
          if (out.mounted !== undefined && out.drawn !== undefined && out.timeline !== undefined && out.live !== undefined) return done(out as Times);
          requestAnimationFrame(tick);
        };
        tab.click();
        // The mount is synchronous with the click when nothing holds it: look at once, then per frame.
        queueMicrotask(tick);
      }),
    board,
  );
  // Settled before the next switch: the save status, and the tier chip.
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
  return t;
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const row = (name: string, ts: Times[]) => {
  const col = (k: keyof Times) => {
    const xs = ts.map((t) => t[k]);
    return `${med(xs).toFixed(0)} (${Math.min(...xs).toFixed(0)}–${Math.max(...xs).toFixed(0)})`;
  };
  console.log(`[switch] ${name.padEnd(34)} n=${ts.length}  mounted ${col("mounted")}  drawn ${col("drawn")}  timeline ${col("timeline")}  live ${col("live")}  ms, median (min–max)`);
};

test("a tab switch, timed: never opened, left earlier, and over a slower network", async ({ browser }) => {
  test.setTimeout(300_000);
  const a = await newBoardUrl(server, "Perf A");
  const b = await newBoardUrl(server, "Perf B");
  const extra = process.env.MAPCRO_PERF_EVICT ? [await newBoardUrl(server, "Perf C"), await newBoardUrl(server, "Perf D"), await newBoardUrl(server, "Perf E")] : [];
  // MAPCRO_PERF_SCENES: this many more scenes on A and on B (each holds its heroes), for a
  // board of some size; made before the match is attached, on the board alone.
  for (const url of SCENES ? [a, b] : []) {
    const owner = await joinNew(browser, url, "Owner");
    for (let i = 0; i < SCENES; i++) await owner.getByTestId("scene-add").first().click({ timeout: 5000 });
    await expect(owner.getByTestId("scene-card")).toHaveCount(SCENES + 1);
    await expect(owner.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await owner.context().close();
  }
  // Each board has its match already, attached by its owner: the session's device opens it cold.
  for (const [url, id] of [[a, ID], [b, ID_B], ...extra.map((u) => [u, ID] as const)] as const) {
    const { board, token } = parts(url);
    const r = await fetch(`${server.url}/api/boards/${board}/matches/${id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` } });
    expect(r.ok).toBe(true);
  }
  const first = parts(a);
  const made = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Perf", board: first.board, board_token: first.token }) });
  const s = (await made.json()) as { session: string; owner_token: string };
  const link = `${server.url}/s/${s.session}#${s.owner_token}`;
  // The other tabs are added by a second device, so the timed one has never opened them.
  const adder = await joinNew(browser, link, "Adder");
  for (const [i, url] of [b, ...extra].entries()) {
    await adder.getByTestId("add-game").click();
    await adder.getByTestId("add-paste").fill(url);
    await adder.getByTestId("add-paste-go").click();
    await expect(adder.getByTestId("game-tab")).toHaveCount(2 + i);
    await expect(adder.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  }
  await adder.context().close();
  // The session's device: it holds no board link, so each tab opens through its grant.
  const me = await joinNew(browser, link, "Coach", (p) =>
    void p.addInitScript(() => {
      const w = window as unknown as { __ready: number[] };
      w.__ready = [];
      const Real = window.WebSocket;
      window.WebSocket = class extends Real {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (e) => {
            if (typeof e.data === "string" && e.data.startsWith('{"t":"ready"')) w.__ready.push(performance.now());
          });
        }
      };
    }),
  );
  await expect(me.getByTestId("game-tab")).toHaveCount(2 + extra.length);
  await expect(me.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(me.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const A = first.board;
  const B = parts(b).board;
  console.log(`[switch] build ${process.env.MAPCRO_PERF_LABEL ?? "?"}; rounds ${ROUNDS}; scenes on A and B ${SCENES + 1}`);
  row("B, never opened here", [await switchTo(me, B)]);
  const back: Times[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    back.push(await switchTo(me, A));
    back.push(await switchTo(me, B));
  }
  row("left earlier (A and B in turn)", back);

  if (extra.length) {
    // B is left for four other boards: past the pool's three, it's dropped.
    const evicted: Times[] = [];
    for (let i = 0; i < 3; i++) {
      for (const url of extra) await switchTo(me, parts(url).board);
      await switchTo(me, A);
      evicted.push(await switchTo(me, B));
    }
    row("left four boards ago", evicted);
  }

  const cdp = await me.context().newCDPSession(me);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: (20 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 });
  const slow: Times[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    slow.push(await switchTo(me, A));
    slow.push(await switchTo(me, B));
  }
  row("left earlier, 40 ms and 20 Mbit/s", slow);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  // The decoded size of one timeline (§4.3: the cache's cap is set from it), and what parsing
  // and freezing it cost.
  await cdp.send("HeapProfiler.enable");
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    return (await cdp.send("Runtime.getHeapUsage")).usedSize;
  };
  const before = await heap();
  const parsed = await me.evaluate(
    async ({ board, id, auth }) => {
      const r = await fetch(`/api/boards/${board}/matches/${id}`, { headers: { authorization: auth } });
      const text = await r.text();
      const t0 = performance.now();
      (window as unknown as { __tl: unknown }).__tl = JSON.parse(text);
      return { chars: text.length, parseMs: performance.now() - t0 };
    },
    { board: A, id: ID, auth: `Bearer ${first.token}` },
  );
  const held = await heap();
  const frozen = await me.evaluate(() => {
    const freeze = (v: unknown, all: boolean): void => {
      if (v === null || typeof v !== "object" || Object.isFrozen(v)) return;
      if (Array.isArray(v) && !all && (typeof v[0] === "number" || typeof v[0] === "string")) return;
      Object.freeze(v);
      for (const x of Array.isArray(v) ? v : Object.values(v)) freeze(x, all);
    };
    const w = window as unknown as { __tl: unknown; __freeze: typeof freeze };
    w.__freeze = freeze;
    const t0 = performance.now();
    freeze(w.__tl, false);
    return performance.now() - t0;
  });
  const afterShallow = await heap();
  const deep = await me.evaluate(() => {
    const w = window as unknown as { __tl: unknown; __freeze: (v: unknown, all: boolean) => void };
    const thaw = JSON.parse(JSON.stringify(w.__tl));
    w.__tl = thaw;
    const t0 = performance.now();
    w.__freeze(thaw, true);
    return performance.now() - t0;
  });
  const afterDeep = await heap();
  const mib = (n: number) => (n / 1048576).toFixed(2);
  console.log(
    `[timeline] text ${mib(parsed.chars)} MiB (chars); decoded ${mib(held - before)} MiB (${((held - before) / parsed.chars).toFixed(2)}x); parse ${parsed.parseMs.toFixed(0)} ms; ` +
      `freeze objects only ${frozen.toFixed(1)} ms, heap ${mib(afterShallow - before)} MiB; freeze everything ${deep.toFixed(1)} ms, heap ${mib(afterDeep - before)} MiB`,
  );
});
