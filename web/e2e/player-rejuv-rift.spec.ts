// The timers a replay has beyond the camps (timers audit, gaps 1, 2 and 7; spec §6b), on a
// synthetic replay timeline handed to the server as the worker would: the Rejuvenator a team
// holds (its events, its marks and timer on the top bar as the game draws them, and on the mid
// boss's label), an open rift's capture rings and give-up deadline, and the urn on the ground saying when
// it walks back.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "129738985";
const N = 400;
const BOSS = "mid_boss:neutral:lane0:1";
const RIFT_W = "rift:neutral:lane1:1";
const URN_W = "urn:neutral:lane1:1";
const URN_E = "urn:neutral:lane6:1";
const WALKER = "walker:amber:lane1:1";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-rejuv-"));
const SHOTS = process.env.MAPCRO_SHOT_DIR;
let upstream: ReturnType<typeof createServer>;
let server: Server;

/** A pack with only the Rejuvenator's top-bar images (tiny generated PNGs, not game art) and no
 * entities, so the map is the built-in one and the marks come from the pack. */
function iconPack(): string {
  const root = mkdtempSync(join(tmpdir(), "mapcro-rejuv-packs-"));
  const dir = join(root, "synthetic");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const blobs: Record<string, unknown> = {};
  for (const key of ["map/minimap_midtown_mid", ...[1, 2, 3, 4].map((n) => `topbar/team_rejuv_${n}_png`), "topbar/rejuvenator"]) {
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

/** 129738985's first rift, Sapphire's Rejuvenator and the 25:00 urn, moved early and shortened. */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const y = team === "amber" ? -6000 : 6000;
        return { team, slot, hero_id: 1 + slot, name: null, x: range(() => -6000 + slot * 2400), y: range(() => y), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) };
      }),
    ),
    mid_boss: [{ destroyed_s: 20, team_killed: "unknown" }],
    // Open at 40, gives up at 100; both teams push, Sapphire holds a while, then captures at 77.
    rifts: [{ key: RIFT_W, start_s: 10, end_s: 82, live_s: 40, give_up_s: 100, capture: [[400, 0, 0], [500, 50, 20], [600, 50, 60], [700, 50, 60], [770, 60, 100], [815, 60, 100]] }],
    powerups: [],
    zips: [],
    camps: [{ key: BOSS, first_s: 0, cleared: [[20, 380]] }],
    // Amber's west walker loses health, then falls at 300.
    objectives: [{ key: WALKER, kind: "walker", team: "amber", lane: 1, destroyed_s: 300 }],
    objective_health: [{ key: WALKER, at: [[0, 100], [100, 62], [150, 61], [200, 40], [300, 0]] }],
    // Sapphire takes it at 30: three revives, one used at 60 (the charge at the death, 57), two
    // at 90; it expires at 210. Amber holds one from 180 (both do until 210) and spends its last
    // revive at 270, before its expiry at 360.
    rejuv: [
      { team: "sapphire", taken_s: 30, ends_s: 210, left: [[30, 3], [57, 2], [88, 1]] },
      { team: "amber", taken_s: 180, ends_s: 360, left: [[180, 2], [240, 1], [270, 0]] },
    ],
    events: [
      { t: 20, kind: "mid_boss", key: BOSS, x: 0, y: 0 },
      { t: 30, kind: "rejuv_taken", team: "sapphire", key: BOSS, x: 0, y: 0 },
      { t: 60, kind: "rejuv_revive", team: "sapphire", slot: 2, hero_id: 3, x: -1200, y: 6000 },
      { t: 210, kind: "rejuv_expired", team: "sapphire" },
    ],
    // Spawns at 100 over the east site, lands at 112, lies until it walks back at 292.
    urn: {
      spawns: [{ t: 100, key: URN_E }],
      at: [
        { t: 100, state: "ground", x: 6304, y: -96 },
        { t: 112, state: "ground", x: 6304, y: -96, delivery: URN_W },
        { t: 293, state: "ground", x: 6244, y: -70, delivery: URN_W },
        { t: 294, state: "ground", x: 6187, y: -42, delivery: URN_W },
      ],
    },
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

const marker = (p: Page, key: string) => p.locator(`[data-testid=map] .mk[data-key="${key}"]`);
const label = (p: Page) => p.getByTestId("hover-label");
const AT_ONCE = { timeout: 250 };

async function says(p: Page, key: string, text: string | RegExp) {
  const b = (await marker(p, key).boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await expect(label(p)).toHaveAttribute("data-key", key, AT_ONCE);
  await expect(label(p)).toHaveText(text);
}

const shot = async (p: Page, name: string) => {
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` });
};

test("the Rejuvenator: its events, its badge on the holder's side of the top bar, and the mid boss's label", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Rejuvenator"), "Coach");
  await open(a);
  const ev = a.getByTestId("event");
  await expect(ev.filter({ hasText: "Rejuvenator taken by Archmother" })).toHaveCount(1);
  await expect(ev.filter({ hasText: "revived by the Rejuvenator" })).toHaveCount(1);
  await expect(ev.filter({ hasText: "Archmother Rejuvenator expired" })).toHaveCount(1);
  await expect(ev.filter({ hasText: "Rejuvenator taken" })).toHaveAttribute("data-kind", "rejuv_taken");

  // What shows, as the game draws it: one image of n marks per side (none: no marks), and the
  // timer's ring, the share of its 180 s left.
  const badge = (team: string) => a.locator(`[data-testid=tb-rejuv][data-team=${team}]`);
  const timer = (team: string) => a.locator(`[data-testid=tb-rejuv-timer][data-team=${team}]`);
  // The images shown once a crossfade settles: [n], or [] for none.
  const marks = (team: string, n: number) =>
    expect.poll(() => badge(team).locator("img:visible").evaluateAll((els) => els.map((e) => e.getAttribute("data-n")))).toEqual(n ? [String(n)] : []);
  const ring = async (team: string, pct: string | null) => {
    if (pct == null) return expect(timer(team)).toBeHidden();
    await expect(timer(team)).toBeVisible();
    await expect(timer(team).locator(".pl-rejuv-ring")).toHaveCSS("stroke-dasharray", new RegExp(`^${pct.replace(".", "\\.")}(px)?,? 100`));
  };
  const box = async (l: ReturnType<typeof a.locator>) => (await l.boundingBox())!;
  const bar = await box(a.getByTestId("topbar"));
  const mid = bar.x + bar.width / 2;

  await scrubTo(a, 25);
  await marks("sapphire", 0);
  await marks("amber", 0);
  await ring("sapphire", null);
  await ring("amber", null);

  await scrubTo(a, 40);
  await marks("sapphire", 3);
  await marks("amber", 0);
  await ring("sapphire", "94.44");
  await ring("amber", null);
  // No text: neither a count nor a countdown.
  await expect(badge("sapphire")).toHaveText("");
  await expect(timer("sapphire")).toHaveText("");
  // The pack's images, not the drawn stand-ins.
  expect(await badge("sapphire").locator("img:visible").getAttribute("src")).not.toContain("data:");
  await expect(timer("sapphire").locator("image")).toHaveCount(1);
  // Amber's view: Sapphire is the enemy, its marks right of centre, the timer at the centre.
  await expect(badge("sapphire")).toHaveClass(/\benemy\b/);
  const m40 = await box(badge("sapphire").locator("img:visible"));
  const t40 = await box(timer("sapphire"));
  expect(m40.x).toBeGreaterThan(mid);
  expect(Math.abs(t40.x + t40.width / 2 - mid)).toBeLessThan(t40.width / 2);
  expect(t40.x + t40.width).toBeLessThan(m40.x);
  await shot(a, "synthetic-rejuv-40");

  await scrubTo(a, 60);
  await marks("sapphire", 2);

  // The countdown stays in the mid boss's label.
  await scrubTo(a, 100);
  await marks("sapphire", 1);
  await ring("sapphire", "61.11");
  await says(a, BOSS, "Respawns in 4:40 · Archmother Rejuvenator: 1 revive, ends in 1:50");
  await shot(a, "synthetic-rejuv-100-boss-hover");

  // Both hold one: each side its marks, the timers side by side, Amber's (friendly) on the left.
  await scrubTo(a, 195);
  await marks("sapphire", 1);
  await marks("amber", 2);
  await ring("sapphire", "8.33");
  await ring("amber", "91.67");
  const [ta, ts] = [await box(timer("amber")), await box(timer("sapphire"))];
  expect(ta.x + ta.width).toBeLessThanOrEqual(ts.x + 0.5);
  expect((await box(badge("amber").locator("img:visible"))).x + 1).toBeLessThan(mid);
  await shot(a, "synthetic-rejuv-195-both");

  // Sapphire's expires; Amber's stays.
  await scrubTo(a, 210);
  await marks("sapphire", 0);
  await ring("sapphire", null);
  await marks("amber", 2);
  await says(a, BOSS, "Respawns in 2:50 · Hidden King Rejuvenator: 2 revives, ends in 2:30");

  // Amber's last revive spent at 270: marks and timer go, though it would run to 360.
  await scrubTo(a, 250);
  await marks("amber", 1);
  await ring("amber", "61.11");
  await scrubTo(a, 280);
  await marks("amber", 0);
  await ring("amber", null);

  // From Sapphire's side it's on the friendly (left) side.
  await scrubTo(a, 50);
  await a.getByTestId("viewpoint-flip").click();
  await expect(badge("sapphire")).toHaveClass(/\bfriend\b/);
  await marks("sapphire", 3);
  const b2 = await box(badge("sapphire").locator("img:visible"));
  expect(b2.x + b2.width).toBeLessThan(mid);
});

test("an open rift draws each team's capture and says when it gives up", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Rift capture"), "Coach");
  await open(a);
  const rings = a.getByTestId("rift-rings");
  await scrubTo(a, 30);
  await expect(rings).toHaveCount(0);
  await scrubTo(a, 45);
  await expect(rings).toHaveCount(1);
  await expect(rings).toHaveAttribute("data-key", RIFT_W);
  await expect(rings).toHaveAttribute("data-amber", "25");
  await expect(rings).toHaveAttribute("data-sapphire", "10");
  await says(a, RIFT_W, "Gives up in 0:55");
  // Both rings drawn, each filled to its team's share.
  const filled = async (team: string) => {
    const c = rings.locator(`g[data-team="${team}"] .pl-rift-fill`);
    if (!(await c.count())) return 0;
    const r = Number(await c.getAttribute("r"));
    const dash = Number((await c.getAttribute("stroke-dasharray"))!.split(" ")[0]);
    return Math.round((dash / (2 * Math.PI * r)) * 100);
  };
  // Eased: it gets there.
  await expect.poll(() => filled("amber")).toBe(25);
  await expect.poll(() => filled("sapphire")).toBe(10);
  await shot(a, "synthetic-rift-45");

  // Contested, Sapphire ahead.
  await scrubTo(a, 65);
  await expect(rings).toHaveAttribute("data-sapphire", "60");
  await expect.poll(() => filled("sapphire")).toBe(60);
  await expect.poll(() => filled("amber")).toBe(50);
  await says(a, RIFT_W, "Gives up in 0:35");
  await shot(a, "synthetic-rift-65-contested");

  // Captured: no deadline any more.
  await scrubTo(a, 79);
  await expect(rings).toHaveAttribute("data-captured", "sapphire");
  await says(a, RIFT_W, "Captured by Archmother");
  await scrubTo(a, 82);
  await expect(rings).toHaveCount(0);
});

test("the urn on the ground says when it walks back", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Urn walk-back"), "Coach");
  await open(a);
  const urn = a.locator('[data-testid=urn][data-state="ground"]');
  const over = async () => {
    const b = (await urn.boundingBox())!;
    await a.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  };
  await scrubTo(a, 105);
  await over();
  await expect(label(a)).toHaveAttribute("data-key", "soul-urn", AT_ONCE);
  await expect(label(a)).toHaveText("Urn");
  await scrubTo(a, 200);
  await over();
  await expect(label(a)).toHaveText("Urn returns in 1:32");
  await shot(a, "synthetic-urn-200");
  await scrubTo(a, 300);
  await over();
  await expect(label(a)).toHaveText("Urn returning");
  await a.mouse.move(5, 5);
  await expect(label(a)).toHaveCount(0, AT_ONCE);
});

test("an objective with health says its name and health, live with the playback; down, nothing", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Objective health"), "Coach");
  await open(a);
  await scrubTo(a, 50);
  await says(a, WALKER, "Walker 100%");
  // Hovered while the playback moves on: the label follows.
  await scrubTo(a, 100.5);
  await expect(label(a)).toHaveText("Walker 62%");
  await scrubTo(a, 250);
  await expect(label(a)).toHaveText("Walker 40%");
  await shot(a, "synthetic-walker-health");
  // Health off: the view has no health, so nothing to say. (The toggle takes the pointer: back
  // over the walker each time.)
  await revealControls(a, "health-toggle");
  await a.getByTestId("health-toggle").click();
  const w = (await marker(a, WALKER).boundingBox())!;
  await a.mouse.move(w.x + w.width / 2, w.y + w.height / 2);
  await expect(label(a)).toHaveCount(0, AT_ONCE);
  await revealControls(a, "health-toggle");
  await a.getByTestId("health-toggle").click();
  await says(a, WALKER, "Walker 40%");
  // Destroyed: nothing.
  await scrubTo(a, 320);
  await expect(label(a)).toHaveCount(0);
});
