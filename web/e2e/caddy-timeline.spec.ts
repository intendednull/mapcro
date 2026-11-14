// The page's timeline cache through a compressing proxy, as deployed (docs/deploy.md): Caddy
// with `encode zstd gzip` in front of the server. `encode` rewrites the `ETag` it passes on and,
// of an `If-None-Match` list sent back, restores only the last, so a validator carried there
// never matched and every tab switch fetched the whole timeline again, twice (sessions.md §10
// phase 3, review B1). The validator travels in headers of our own; this drives the real
// client through a real Caddy and counts what is sent. Needs `caddy` on the PATH (the dev shell
// has it).

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

const freePort = () =>
  new Promise<number>((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });

let server: Server;
let caddy: ChildProcess;
let proxy = "";

test.beforeAll(async () => {
  if (spawnSync("caddy", ["version"]).error) throw new Error("caddy isn't on the PATH: run inside `nix develop`");
  const port = await freePort();
  proxy = `http://127.0.0.1:${port}`;
  // The pages come from the proxy, so that is the origin the server expects.
  server = new Server(undefined, { MATCH_API_BASE: "http://127.0.0.1:9", REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-e2e-caddy-q-")), REPLAY_PER_CLIENT_PER_HOUR: "200", PUBLIC_ORIGIN: proxy });
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  writeFileSync(join(server.dataDir, "replays", `${ID}-cdn.json`), JSON.stringify(timeline()));
  await server.start();
  const home = mkdtempSync(join(tmpdir(), "mapcro-e2e-caddy-"));
  const config = join(home, "Caddyfile");
  writeFileSync(config, `{\n\tadmin off\n\tauto_https off\n}\n${proxy} {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:${server.port}\n}\n`);
  caddy = spawn("caddy", ["run", "--adapter", "caddyfile", "--config", config], { env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config") }, stdio: "ignore" });
  await expect.poll(() => fetch(`${proxy}/`).then((r) => r.ok, () => false), { timeout: 20_000 }).toBe(true);
});
test.afterAll(() => {
  caddy?.kill("SIGKILL");
  server?.stop();
});

const boardOf = (url: string) => /\/b\/([^#]+)#/.exec(url)![1]!;
const mounted = (p: Page) => p.locator('[data-testid="board"]').getAttribute("data-board");

test("through Caddy's encode, a match is sent once, compressed, and confirmed on every open after", async ({ browser }) => {
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

  // Sent once, compressed by the proxy (the case that matters), with the validator as the server made it.
  const sent = gets.filter((g) => g.status !== 304);
  expect(sent.map((g) => g.status)).toEqual([200]);
  expect(gets[0]).toBe(sent[0]);
  expect(sent[0]!.encoding).toMatch(/^(zstd|gzip)$/);
  expect(sent[0]!.timeline).toMatch(/^"cdn-[0-9a-f]{16}"$/);
  // Every open after, on either board: "the same", naming that validator.
  for (const g of gets.filter((g) => g.status === 304)) expect(g.timeline).toBe(sent[0]!.timeline);
  // What `encode` did to the ETag, for the record (the client never reads it).
  console.log(`[caddy] timeline requests ${gets.length}: 200 x${sent.length}, 304 x${gets.length - sent.length}; ETag rewritten on the 200: ${sent[0]!.etag !== sent[0]!.timeline}`);
});
