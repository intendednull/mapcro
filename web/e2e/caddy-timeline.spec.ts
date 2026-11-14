// The page's timeline cache through a proxy that compresses the timeline itself: Caddy with
// `encode zstd gzip`, and the request's `Accept-Encoding` not passed up, so the server sends it
// plain. `encode` then rewrites the `ETag` it passes on and, of an `If-None-Match` list sent
// back, restores only the last: a validator carried there never matches, and every tab switch
// fetches the whole timeline again, twice (sessions.md §10 phase 3, review B1). As deployed
// that doesn't happen, because the route compresses its own answer and `encode` leaves it
// alone (docs/deploy.md; crates/server/tests/replays.rs runs both). The validator travels in
// headers of our own so the cache doesn't hang on that; this drives the real client through
// the rewriting proxy and counts what is sent. Needs `caddy` on the PATH (the dev shell has it).
// A run killed hard can leave its Caddy behind: docs/deploy.md, "Test proxies left behind".

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "53001";
const N = 120;
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
const timeline = () => ({
  match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
  players: (["amber", "sapphire"] as const).flatMap((team) =>
    [0, 1, 2, 3, 4, 5].map((slot) => ({
      team, slot, hero_id: 1 + slot, name: `${team === "amber" ? "A" : "S"}${slot}`,
      x: range(() => slot * 1500 - 4000), y: range(() => (team === "amber" ? -3000 : 3000)),
      health: range(() => 100), deaths: [], respawn: [], souls: [[0, 500]], ult: range(() => 0), seen: [],
      items: [], abilities: [], casts: [], charges: [], effects: [], cc: [], height: [], recaps: [],
    })),
  ),
  objectives: [], mid_boss: [], rifts: [], powerups: [], events: [],
  waves: [{ lane: "lane4", t: range(() => 500), stale: [] }],
  troopers: { every_s: 1, amber: range(() => ""), sapphire: range(() => "") },
});

/** A free port, held until `release`: the server picks its own meanwhile, so it can't take this one. */
const holdPort = () =>
  new Promise<{ port: number; release: () => Promise<void> }>((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => ok({ port: (s.address() as { port: number }).port, release: () => new Promise<void>((done) => s.close(() => done())) }));
  });

let server: Server;
let caddy: ChildProcess;
let proxy = "";

test.beforeAll(async () => {
  if (spawnSync("caddy", ["version"]).error) throw new Error("caddy isn't on the PATH: run inside `nix develop`");
  const held = await holdPort();
  proxy = `http://127.0.0.1:${held.port}`;
  // The pages come from the proxy, so that is the origin the server expects.
  server = new Server(undefined, { MATCH_API_BASE: "http://127.0.0.1:9", REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-e2e-caddy-q-")), REPLAY_PER_CLIENT_PER_HOUR: "200", PUBLIC_ORIGIN: proxy });
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  writeFileSync(join(server.dataDir, "replays", `${ID}-cdn.json`), JSON.stringify(timeline()));
  await server.start();
  const home = mkdtempSync(join(tmpdir(), "mapcro-e2e-caddy-"));
  const config = join(home, "Caddyfile");
  writeFileSync(config, `{\n\tadmin off\n\tauto_https off\n}\n${proxy} {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:${server.port} {\n\t\theader_up -Accept-Encoding\n\t}\n}\n`);
  await held.release();
  // What Caddy says goes to a file, shown if it never answers.
  const said = join(home, "caddy.log");
  const log = openSync(said, "w");
  caddy = spawn("caddy", ["run", "--adapter", "caddyfile", "--config", config], { env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config") }, stdio: ["ignore", "ignore", log] });
  closeSync(log);
  try {
    await expect.poll(() => fetch(`${proxy}/`).then((r) => r.ok, () => false), { timeout: 20_000 }).toBe(true);
  } catch {
    throw new Error(`caddy never answered on ${proxy}; it said:\n${readFileSync(said, "utf8")}`);
  }
});
test.afterAll(() => {
  caddy?.kill("SIGKILL");
  server?.stop();
});

const boardOf = (url: string) => /\/b\/([^#]+)#/.exec(url)![1]!;
const mounted = (p: Page) => p.locator('[data-testid="board"]').getAttribute("data-board");

test("through Caddy compressing and rewriting the ETag, a match is sent once and confirmed on every open after", async ({ browser }) => {
  const urls = [await newBoardUrl(server, "Proxy A"), await newBoardUrl(server, "Proxy B")].map((u) => u.replace(server.url, proxy));
  const [a, b] = urls as [string, string];
  expect(a.startsWith(proxy)).toBe(true);
  // The same fetched replay on both boards: one file for every board.
  for (const url of urls) {
    const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
    const r = await fetch(`${proxy}/api/boards/${board}/matches/${ID}`, { method: "PUT", headers: { authorization: `Bearer ${token}` } });
    expect(r.ok).toBe(true);
  }
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(a)!;
  const made = await fetch(`${proxy}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Proxy", board, board_token: token }) });
  const s = (await made.json()) as { session: string; owner_token: string };
  const me = await joinNew(browser, `${proxy}/s/${s.session}#${s.owner_token}`, "Coach");
  await me.getByTestId("add-game").click();
  await me.getByTestId("add-paste").fill(b);
  await me.getByTestId("add-paste-go").click();
  const tabs = me.getByTestId("game-tab");
  await expect(tabs).toHaveCount(2);
  const go = async (i: 0 | 1) => {
    await tabs.nth(i).click();
    await expect.poll(() => mounted(me)).toBe(boardOf(i ? b : a));
    await expect(me.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect(me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
  };
  await go(0);

  // Every answer to a timeline request from here, as the page receives it. The page's cache
  // starts empty: a reload.
  const gets: Array<{ status: number; encoding: string | undefined; timeline: string | undefined; etag: string | undefined }> = [];
  me.on("response", (r) => {
    if (!new RegExp(`/api/boards/[^/]+/matches/${ID}$`).test(new URL(r.url()).pathname) || r.request().method() !== "GET") return;
    const h = r.headers();
    gets.push({ status: r.status(), encoding: h["content-encoding"], timeline: h["x-mapcro-timeline"], etag: h["etag"] });
  });
  await me.reload();
  await expect.poll(() => mounted(me)).toBe(boardOf(a));
  await expect(me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
  for (const i of [1, 0, 1, 0] as const) await go(i);
  await expect.poll(() => gets.filter((g) => g.status === 304).length).toBeGreaterThanOrEqual(4);

  // Sent once, compressed by the proxy, with the validator as the server made it.
  const sent = gets.filter((g) => g.status !== 304);
  expect(sent.map((g) => g.status)).toEqual([200]);
  expect(gets[0]).toBe(sent[0]);
  expect(sent[0]!.encoding).toMatch(/^(zstd|gzip)$/);
  expect(sent[0]!.timeline).toMatch(/^"cdn-[0-9a-f]{16}"$/);
  // The proxy rewrote the ETag: the case this test is for. (If it stops, the test no longer
  // shows what it says, and the client reading the ETag would pass it too.)
  expect(sent[0]!.etag).toBe(sent[0]!.timeline!.replace(/"$/, `-${sent[0]!.encoding}"`));
  // Every open after, on either board: "the same", naming that validator.
  for (const g of gets.filter((g) => g.status === 304)) expect(g.timeline).toBe(sent[0]!.timeline);
  console.log(`[caddy] timeline requests ${gets.length}: 200 x${sent.length}, 304 x${gets.length - sent.length}; the ETag rewritten on the 200: ${sent[0]!.etag !== sent[0]!.timeline}`);
});
