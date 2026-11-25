// A marker hidden from the map has nothing to say: hovering where it sits shows no label
// (review 2026-11-08, buffs-timers finding 4), while the markers around it still do.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import WebSocket from "ws";
import { initSync, newRecordId } from "../src/wasm/mapcro_wasm.js";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import { joinNew, revealControls } from "./helpers";
import { ROOT, Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-hover-hidden-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;
test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const HIDDEN = "walker:amber:lane1:1";
const SHOWN = "walker:sapphire:lane1:1";
const marker = (p: Page, key: string) => p.locator(`[data-testid=map] .mk[data-key="${key}"]`);
const label = (p: Page) => p.getByTestId("hover-label");

async function hover(p: Page, key: string) {
  const b = (await marker(p, key).boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}

test("a marker with nothing timed shows no label, hidden or shown; it keeps its name for screen readers", async ({ browser }) => {
  const url = await newBoardUrl(server, "hidden marker");
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  const bot = new BoardSession({
    wsUrl: `ws://127.0.0.1:${new URL(server.url).port}/ws`,
    board: board!,
    token: token!,
    persist: new MemoryPersist(),
    openSocket: (u) => new WebSocket(u, { origin: server.url }) as unknown as SocketLike,
  });
  await bot.start();
  await expect.poll(() => bot.connection.kind).toBe("live");
  const scene = [...bot.records].find(([, e]) => "Scene" in e.record)![0];
  bot.edit([{ Create: { id: newRecordId(), record: { ObjectiveState: { scene, key: HIDDEN, status: "Hidden" } } } }]);
  await expect.poll(() => bot.status.kind).toBe("saved");
  bot.stop();

  const a = await joinNew(browser, url, "Coach");
  // An editor still sees where it was, faded; it says nothing.
  await expect(marker(a, HIDDEN)).toHaveAttribute("data-status", "Hidden");
  // A walker is a walker (operator 2026-11-08): no label shown or hidden.
  await hover(a, SHOWN);
  await expect(label(a)).toHaveCount(0);
  await hover(a, HIDDEN);
  await expect(label(a)).toHaveCount(0);
  // And its role: a named image, found by its name.
  await expect(a.getByRole("img", { name: (await marker(a, SHOWN).getAttribute("aria-label"))! }).first()).toBeVisible();
});

test("a hidden timed marker shows no hover label while a visible cleared marker still shows its respawn timer (TD-14)", async ({ browser }) => {
  const ID = "131000014";
  const N = 40;
  const CAMP = "camp:neutral:lane0:3";
  const BOSS = "mid_boss:neutral:lane0:1";
  const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
  const tl = {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6860, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: null,
        x: range(() => slot * 300 - 7000), y: range(() => (team === "amber" ? -8000 : 8000)),
        health: range(() => 100), deaths: [], respawn: [], souls: [[0, 500]], ult: range(() => 0),
        seen: [[0, N * 10]], level: [[0, 1]], items: [], abilities: [], casts: [], charges: [], cc: [], effects: [], recaps: [],
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [], zips: [],
    camps: [
      { key: CAMP, first_s: 0, cleared: [[10, 130]] },
      { key: BOSS, first_s: 0, cleared: [[10, 250]] },
    ],
  };

  const url = await newBoardUrl(server, "hidden timed camp");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await a.getByTestId("match-file").setInputFiles({
    name: `${ID}.dem`,
    mimeType: "application/octet-stream",
    buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]),
  });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(tl));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");

  // Scrub to t=20s (both CAMP and BOSS are cleared with respawn timers) and save a Scene.
  await a.getByTestId("match-time").evaluate((el) => {
    (el as HTMLInputElement).value = "20";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(a.getByTestId("match-clock")).toContainText("0:20 /");
  await a.getByTestId("match-save").click();
  await expect(a.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  // Both cleared markers show their respawn timers on hover.
  await hover(a, CAMP);
  await expect(label(a)).toHaveText("Respawns in 1:50");
  await hover(a, BOSS);
  await expect(label(a)).toHaveText("Respawns in 3:50");
  await a.mouse.move(5, 5);

  // Hide CAMP in this scene (`ObjectiveState: Hidden`): hovering it now shows NO label, while BOSS keeps its timer.
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  const bot = new BoardSession({
    wsUrl: `ws://127.0.0.1:${new URL(server.url).port}/ws`,
    board: board!,
    token: token!,
    persist: new MemoryPersist(),
    openSocket: (u) => new WebSocket(u, { origin: server.url }) as unknown as SocketLike,
  });
  await bot.start();
  await expect.poll(() => bot.connection.kind).toBe("live");
  const savedScene = [...bot.records].find(([, e]) => "Scene" in e.record && !e.record.Scene.live && e.record.Scene.source != null)![0];
  const existing = [...bot.records].find(([, e]) => "ObjectiveState" in e.record && e.record.ObjectiveState.scene === savedScene && e.record.ObjectiveState.key === CAMP);
  bot.edit([
    existing
      ? { Set: { id: existing[0], value: { ObjectiveStatus: "Hidden" } } }
      : { Create: { id: newRecordId(), record: { ObjectiveState: { scene: savedScene, key: CAMP, status: "Hidden" } } } },
  ]);
  await expect.poll(() => bot.status.kind).toBe("saved");
  bot.stop();

  await expect(marker(a, CAMP)).toHaveAttribute("data-status", "Hidden");
  await hover(a, CAMP);
  await expect(label(a)).toHaveCount(0);
  await hover(a, BOSS);
  await expect(label(a)).toHaveText("Respawns in 3:50");
});
