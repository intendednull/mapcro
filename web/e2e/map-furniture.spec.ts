// The map's furniture (docs/research/map-objectives-audit.md): shops and teleporters always on
// the map, a teleporter's pair shown on hover only, and the healing pickups behind this
// browser's Heals toggle, off by default and kept across a reload. In Player, on a synthetic
// replay timeline (format 5), a healing pickup is down while taken and says when it's back.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

/** A synthetic match: no real replay's data. */
const ID = "131000001";
const N = 120;
const HEAL = "heal:neutral:lane4:1";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-furniture-"));
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
    // Up at 0:30, taken at 1:00, back at 1:35.
    heals: [{ key: HEAL, first_s: 30, cleared: [[60, 95]] }],
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

test("shops and teleporters are on the map; heals only with the toggle, which a reload keeps", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Furniture"), "Coach");
  await expect(marks(a, "shop")).toHaveCount(8);
  await expect(marks(a, "teleporter")).toHaveCount(4);
  await expect(marks(a, "heal")).toHaveCount(0);
  const toggle = a.getByTestId("heals-toggle");
  await revealControls(a, "heals-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveAccessibleName("Healing pickups");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(marks(a, "heal")).toHaveCount(36);
  await a.reload();
  await expect(a.getByTestId("heals-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(marks(a, "heal")).toHaveCount(36);
  // A shop is the map's, not the scene's: a click leaves it as it was, and it says nothing.
  const shop = marks(a, "shop").first();
  const key = (await shop.getAttribute("data-key"))!;
  await hover(a, key);
  await expect(a.getByTestId("hover-label")).toHaveCount(0);
  await a.mouse.down();
  await a.mouse.up();
  await expect(marker(a, key)).not.toHaveClass(/\bdown\b/);
  await expect(marker(a, key)).toHaveAttribute("data-status", "Active");
  await a.screenshot({ path: "shots/furniture-board-heals.png" });
  // The toggle is under the map in Player too, and off is kept as well.
  await a.getByTestId("mode-player").click();
  await revealControls(a, "heals-toggle");
  await expect(a.getByTestId("heals-toggle")).toBeVisible();
  await revealControls(a, "heals-toggle");
  await a.getByTestId("heals-toggle").click();
  await expect(marks(a, "heal")).toHaveCount(0);
  await a.reload();
  await expect(a.getByTestId("heals-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(marks(a, "heal")).toHaveCount(0);
});

test("a teleporter's pair shows on hover only", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Teleporters"), "Coach");
  const link = a.getByTestId("teleporter-link");
  await expect(link).toHaveCount(0);
  // The King's side's west end lets out beside its east end, and back.
  await hover(a, "teleporter:neutral:lane4:1");
  await expect(link).toHaveAttribute("data-to", "teleporter:neutral:lane6:1");
  await expect(a.getByTestId("hover-label")).toHaveCount(0);
  await a.screenshot({ path: "shots/furniture-teleporter-link.png" });
  await hover(a, "teleporter:neutral:lane6:1");
  await expect(link).toHaveAttribute("data-to", "teleporter:neutral:lane4:1");
  await a.mouse.move(5, 5);
  await expect(link).toHaveCount(0);
});

test("Player: a healing pickup is down while taken and says when it's back", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Heals"), "Coach");
  await revealControls(a, "heals-toggle");
  await a.getByTestId("heals-toggle").click();
  await open(a);
  const heal = marker(a, HEAL);
  const tip = a.getByTestId("hover-label");
  await scrubTo(a, 20);
  await expect(heal).toHaveAttribute("data-camp", "unspawned");
  await hover(a, HEAL);
  await expect(tip).toHaveText("Spawns in 0:10");
  await scrubTo(a, 40);
  await expect(heal).toHaveAttribute("data-camp", "alive");
  await expect(heal).not.toHaveClass(/\bdown\b/);
  await expect(tip).toHaveCount(0);
  await scrubTo(a, 70);
  await expect(heal).toHaveAttribute("data-camp", "cleared");
  await expect(heal).toHaveClass(/\bdown\b/);
  await expect(tip).toHaveText("Respawns in 0:25");
  await a.screenshot({ path: "shots/furniture-heal-taken.png" });
  await scrubTo(a, 100);
  await expect(heal).toHaveAttribute("data-camp", "alive");
  await expect(heal).not.toHaveClass(/\bdown\b/);
  // The other pickups say nothing timed: this replay has only the one.
  await expect(marks(a, "heal")).toHaveCount(36);
});
