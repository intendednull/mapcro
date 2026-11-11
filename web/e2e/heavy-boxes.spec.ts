// The heavy boxes (the map's tough crates): behind this browser's own Heavy boxes toggle, apart
// from Heals, off by default and kept across a reload, on the board and in Player. In Player, on
// a synthetic replay timeline (format 7), a crate is down before its spawn group comes up and
// while broken, and says when it's back.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

/** A synthetic match: no real replay's data. */
const ID = "131000007";
const N = 400;
const CRATE = "tough_crate:neutral:lane4:3";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-crates-"));
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

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6860, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => slot * 300), y: range(() => (team === "amber" ? -8000 : 8000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [], zips: [], camps: [],
    // Up at 3:00, broken at 3:01, back at 6:01.
    crates: [{ key: CRATE, first_s: 180, cleared: [[181, 361]] }],
  };
}

async function open(p: Page) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}

const marks = (p: Page, kind: string) => p.locator(`[data-testid=map] .mk.${kind}`);
const marker = (p: Page, key: string) => p.locator(`[data-testid=map] .mk[data-key="${key}"]`);

async function hover(p: Page, key: string) {
  const b = (await marker(p, key).boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}

test("heavy boxes only with their own toggle, which a reload keeps, on the board and in Player", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Heavy boxes"), "Coach");
  await expect(marks(a, "shop")).toHaveCount(8);
  await expect(marks(a, "crate")).toHaveCount(0);
  const toggle = a.getByTestId("crates-toggle");
  await revealControls(a, "crates-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveAccessibleName("Heavy boxes");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(marks(a, "crate")).toHaveCount(78);
  // Its own toggle: the heals stay off.
  await expect(a.getByTestId("heals-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(marks(a, "heal")).toHaveCount(0);
  // Drawn with or without a pack: the box itself is visible.
  await expect(marks(a, "crate").first().locator(".fb.crate")).toBeVisible();
  await a.reload();
  await expect(a.getByTestId("crates-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(marks(a, "crate")).toHaveCount(78);
  // A crate is the map's, not the scene's: a click leaves it up.
  await hover(a, CRATE);
  await a.mouse.down();
  await a.mouse.up();
  await expect(marker(a, CRATE)).not.toHaveClass(/\bdown\b/);
  await a.mouse.move(5, 5);
  await a.screenshot({ path: "shots/heavy-boxes-board.png" });
  // The toggle is under the map in Player too, and off is kept as well.
  await a.getByTestId("mode-player").click();
  await revealControls(a, "crates-toggle");
  await expect(a.getByTestId("crates-toggle")).toBeVisible();
  await revealControls(a, "crates-toggle");
  await a.getByTestId("crates-toggle").click();
  await expect(marks(a, "crate")).toHaveCount(0);
  await a.reload();
  await expect(a.getByTestId("crates-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(marks(a, "crate")).toHaveCount(0);
});

test("Player: a heavy box is down until it spawns and while broken, and says when it's back", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Crates"), "Coach");
  await revealControls(a, "crates-toggle");
  await a.getByTestId("crates-toggle").click();
  await open(a);
  const crate = marker(a, CRATE);
  const tip = a.getByTestId("hover-label");
  await scrubTo(a, 100);
  await expect(crate).toHaveAttribute("data-camp", "unspawned");
  await expect(crate).toHaveClass(/\bdown\b/);
  await hover(a, CRATE);
  await expect(tip).toHaveText("Spawns in 1:20");
  await scrubTo(a, 180);
  await expect(crate).toHaveAttribute("data-camp", "alive");
  await expect(crate).not.toHaveClass(/\bdown\b/);
  await expect(tip).toHaveCount(0);
  await scrubTo(a, 200);
  await expect(crate).toHaveAttribute("data-camp", "cleared");
  await expect(crate).toHaveClass(/\bdown\b/);
  await expect(tip).toHaveText("Respawns in 2:41");
  await a.screenshot({ path: "shots/heavy-boxes-player-broken.png" });
  await scrubTo(a, 361);
  await expect(crate).toHaveAttribute("data-camp", "alive");
  await expect(crate).not.toHaveClass(/\bdown\b/);
  // The rest of the map's crates, not in this timeline, stay as they are.
  await expect(marks(a, "crate")).toHaveCount(78);
  await expect(a.locator('[data-testid=map] .mk.crate[data-camp="cleared"]')).toHaveCount(0);
});
