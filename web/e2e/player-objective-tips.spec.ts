// What a hovered map thing says (spec §6b, §8), on a synthetic replay timeline handed to the
// server as the worker would: each objective that spawns says when it's back while down and that
// it's up while up; a bridge powerup is drawn with its buff's own icon and named in the events;
// and the hover label is the same instant one for markers and tokens.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, mapPoint } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "122134063";
const N = 120;
const CAMP = "camp:neutral:lane0:3";
const BOSS = "mid_boss:neutral:lane0:1";
const RIFT_W = "rift:neutral:lane1:1";
const RIFT_E = "rift:neutral:lane6:1";
const BUFF_W = "powerup:neutral:lane1:1";
const BUFF_E = "powerup:neutral:lane6:1";
const URN_W = "urn:neutral:lane1:1";
const URN_E = "urn:neutral:lane6:1";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-tips-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

/** A pack with only the buffs' icons (tiny generated PNGs, not game art) and no entities, so
 * the map is the built-in one and the icons come from the pack. */
function iconPack(): string {
  const root = mkdtempSync(join(tmpdir(), "mapcro-tips-packs-"));
  const dir = join(root, "synthetic");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const blobs: Record<string, unknown> = {};
  for (const key of ["map/minimap_midtown_mid", "icons/powerup_weapon", "icons/powerup_health", "icons/powerup_magic", "icons/powerup_movement"]) {
    const file = `${key}.png`;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), png);
    blobs[key] = { sha256: createHash("sha256").update(png).digest("hex"), w: 1, h: 1, mime: "image/png", file };
  }
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ schema: 3, game: { client_version: 9001, source_revision: 1, date: "Nov 08 2026" }, blobs, heroes: [], entities: [] }));
  return root;
}

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(iconPack(), { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
const upWhile = (spans: Array<[number, number]>) => range((s) => (spans.some(([a, b]) => s >= a && s < b) ? 1 : 0));

function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: team === "amber" && slot === 0 ? "Ana" : null, x: range(() => -6000 + slot * 2400), y: range(() => (team === "amber" ? -6000 : 6000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    objectives: [], mid_boss: [{ destroyed_s: 50, team_killed: "unknown" }],
    // West: announced at 20, open 40 to 60. East: announced at 70, open 90 to 110.
    rifts: [
      { key: RIFT_W, start_s: 20, end_s: 60, live_s: 40 },
      { key: RIFT_E, start_s: 70, end_s: 110, live_s: 90 },
    ],
    powerups: [
      { key: BUFF_W, available: upWhile([[10, 30], [80, 121]]), stale: [], spawns: [{ t: 10, buff: "gun", taken_s: 30 }, { t: 80, buff: "casting" }] },
      { key: BUFF_E, available: upWhile([[10, 12]]), stale: [], spawns: [{ t: 10, buff: "survival", taken_s: 12 }] },
    ],
    events: [
      { t: 10, kind: "powerup_spawn", key: BUFF_W, x: -3936, y: 136, buff: "gun" },
      { t: 30, kind: "powerup_taken", key: BUFF_W, x: -3936, y: 136, buff: "gun" },
    ],
    zips: [],
    camps: [
      { key: CAMP, first_s: 30, cleared: [[60, 95]] },
      { key: BOSS, first_s: 0, cleared: [[50, 110]] },
    ],
    urn: {
      spawns: [{ t: 30, key: URN_W }],
      at: [
        { t: 30, state: "ground", x: -6584, y: 0, delivery: URN_E },
        { t: 55, state: "none" },
      ],
    },
  };
}

async function open(p: Page) {
  await p.getByTestId("mode-player").click();
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

/** Over a token's middle (its initials take the pointer, so not a locator hover). */
async function hoverToken(p: Page, slot: string) {
  const b = (await p.locator(`.tok[data-slot="${slot}"] circle.body`).boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}

const marker = (p: Page, key: string) => p.locator(`[data-testid=map] .mk[data-key="${key}"]`);
const label = (p: Page) => p.getByTestId("hover-label");
/** Well under the browser's own tooltip delay (about a second): the label is there at once. */
const AT_ONCE = { timeout: 250 };

async function hover(p: Page, key: string) {
  const b = (await marker(p, key).boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}

/** Hover each marker in turn and read what it says. */
async function says(p: Page, key: string, text: string) {
  await hover(p, key);
  await expect(label(p)).toHaveAttribute("data-key", key, AT_ONCE);
  await expect(label(p)).toHaveText(text);
}

test("each objective that spawns says when, down and up, at two moments", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Objective tips"), "Coach");
  await open(a);

  // Early: everything still to come.
  await scrubTo(a, 5);
  await says(a, RIFT_W, "Rift spawns here in 0:35 (at 0:40)");
  await says(a, RIFT_E, "Next rift spawns at the other site in 0:35 (at 0:40)");
  await says(a, BUFF_W, "Gun buff spawns in 0:05 (at 0:10)");
  await says(a, BOSS, "Mid boss up");
  await says(a, CAMP, "Spawns in 0:25 (at 0:30)");
  await says(a, URN_W, "Urn spawns here in 0:25 (at 0:30)");
  await a.mouse.move(5, 5);
  await expect(label(a)).toHaveCount(0);

  // Up.
  await scrubTo(a, 15);
  await says(a, BUFF_W, "Gun buff (+fire rate, +ammo) up");
  await scrubTo(a, 45);
  await says(a, RIFT_W, "Rift active");
  await says(a, RIFT_E, "Rift active at the other site");
  await says(a, BUFF_W, "Casting buff respawns in 0:35 (at 1:20)");
  await says(a, BUFF_E, "No more buffs in this replay");
  await says(a, CAMP, "Up");
  await says(a, URN_E, "Urn delivery point: open");

  // Later: down again, and counting with the playback.
  await scrubTo(a, 85);
  await says(a, RIFT_E, "Rift spawns here in 0:05 (at 1:30)");
  await says(a, BUFF_W, "Casting buff (+spirit, +cooldowns) up");
  await says(a, CAMP, "Respawns in 0:10 (at 1:35)");
  await says(a, BOSS, "Mid boss respawns in 0:25 (at 1:50)");
  await scrubTo(a, 95);
  await expect(label(a)).toHaveText("Mid boss respawns in 0:15 (at 1:50)");
  await scrubTo(a, 100);
  await says(a, RIFT_E, "Rift active");
  await says(a, BOSS, "Mid boss respawns in 0:10 (at 1:50)");
  await scrubTo(a, 115);
  await says(a, BOSS, "Mid boss up");
});

test("a powerup is drawn with its buff's own icon and named in the events", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Buff icons"), "Coach");
  await open(a);
  const art = (key: string) => marker(a, key).locator("i.w").last();
  await scrubTo(a, 15);
  await expect(marker(a, BUFF_W)).toHaveAttribute("data-buff", "gun");
  await expect(art(BUFF_W)).toHaveAttribute("data-img", "powerup-gun");
  expect(await art(BUFF_W).evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("powerup_weapon");
  await expect(marker(a, BUFF_E)).not.toHaveAttribute("data-buff", /./);
  await scrubTo(a, 85);
  await expect(marker(a, BUFF_W)).toHaveAttribute("data-buff", "casting");
  await expect(art(BUFF_W)).toHaveAttribute("data-img", "powerup-casting");
  expect(await art(BUFF_W).evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("powerup_magic");
  // Taken: the site's own generic look.
  await scrubTo(a, 50);
  await expect(marker(a, BUFF_W)).not.toHaveAttribute("data-buff", /./);
  await expect(art(BUFF_W)).toHaveAttribute("data-img", "powerup");

  await expect(a.getByTestId("event").filter({ hasText: "Powerup up (west): Gun buff (+fire rate, +ammo)" })).toHaveCount(1);
  await expect(a.getByTestId("event").filter({ hasText: "Powerup taken (west): Gun buff" })).toHaveCount(1);
});

test("a token and a marker show the same label at once, and hide it on leave", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Hover label"), "Coach");
  await open(a);
  await scrubTo(a, 20);
  const tok = a.locator('.tok[data-slot="Amber-0"]');
  // No browser tooltip left: the label, and an aria-label for screen readers.
  await expect(tok.locator("title")).toHaveCount(0);
  await expect(tok).toHaveAttribute("aria-label", /^Ana(, |$)/);
  await hoverToken(a, "Amber-0");
  await expect(label(a)).toHaveAttribute("data-kind", "token", AT_ONCE);
  await expect(label(a)).toHaveText(/^Ana(, |$)/);
  await a.mouse.move(5, 5);
  await expect(label(a)).toHaveCount(0, AT_ONCE);
  // A marker that doesn't spawn names itself, the same label.
  const walker = a.locator('[data-testid=map] .mk.t2').first();
  const key = (await walker.getAttribute("data-key"))!;
  await hover(a, key);
  await expect(label(a)).toHaveAttribute("data-kind", "marker", AT_ONCE);
  await expect(label(a)).toHaveText((await walker.getAttribute("aria-label"))!);
  // Off it onto bare map: gone, as off the map.
  const bare = await mapPoint(a, 0.5, 0.03);
  await a.mouse.move(bare.x, bare.y);
  await expect(label(a)).toHaveCount(0, AT_ONCE);
  await hover(a, key);
  await expect(label(a)).toHaveCount(1, AT_ONCE);
  await a.mouse.move(5, 5);
  await expect(label(a)).toHaveCount(0, AT_ONCE);
});
