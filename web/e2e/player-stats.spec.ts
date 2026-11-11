// The Tab scoreboard's calculated stats (spec §6b "Calculated stats"): a synthetic pack carries
// two stat tables (made-up numbers, not game data) for two patches, and the replay's build picks
// its own patch's. Without a table for the build, the calculated values show "—" and max health
// falls back to the recorded one. The investment bars fill along the ladder: a low breakpoint is
// a small step, not a full bar. Hovers are tags (spec §4b).

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const N = 40;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-stats-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

// m_MapModCostBonuses' shape: threshold, bonus, share of the bar (sums to 100).
const LADDER = [[800, 9, 7], [1600, 12, 7], [2400, 15, 8], [3200, 18, 8], [4800, 46, 9], [6400, 54, 9], [8000, 62, 10], [11200, 74, 10], [16000, 86, 10], [22400, 100, 11], [28800, 115, 11]];
const VIT = 7, WEAPON = 8;

function table(version: number, vitalityHealth: number) {
  const hero = { max_health: 700, per_boon: { max_health: 50 }, boon_levels: [2, 3, 4, 5], cost_bonuses: [LADDER, LADDER, LADDER], bullet_resist: 0, spirit_resist: 0, bullet_resist_per_spirit: 0, spirit_resist_per_spirit: 0 };
  return {
    format: 1, client_version: version, source: "test",
    heroes: Object.fromEntries([1, 2, 3, 4, 5, 6].map((id) => [id, hero])),
    items: { [VIT]: { slot: 0, price: 800, passive: [["max_health", vitalityHealth], ["bullet_resist", 10]] }, [WEAPON]: { slot: 2, price: 1600, passive: [["weapon_damage", 14], ["spirit_power", 5]] } },
  };
}

function pack(): string {
  const root = mkdtempSync(join(tmpdir(), "mapcro-packs-stats-"));
  const dir = join(root, "synthetic");
  const blobs: Record<string, unknown> = {};
  const tables: Record<string, unknown> = {};
  for (const [key, t] of [["boon-6837", table(6837, 100)], ["vdata-6860", table(6860, 200)]] as const) {
    const file = `data/stats/${key}.json`;
    const bytes = Buffer.from(JSON.stringify(t));
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), bytes);
    blobs[`data/stats/${key}`] = { sha256: createHash("sha256").update(bytes).digest("hex"), w: 0, h: 0, mime: "application/json", file };
    tables[key] = { blob: `data/stats/${key}`, client_version: t.client_version, source: "test" };
  }
  const manifest = {
    schema: 4, game: { client_version: 6860, source_revision: 1, date: "Nov 05 2026" }, blobs, heroes: [], entities: [],
    stats: { format: 1, covered_through: 6860, builds: { 6837: "boon-6837", 6839: "boon-6837", 6860: "vdata-6860" }, tables },
  };
  writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest));
  return root;
}

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(pack(), { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "20" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/** Every hero: level 5 from 10 s, a vitality item at 5 s and a weapon item at 12 s, a statue
 * pickup (+20 health, +3% weapon) at 20 s; the recorded max health is 777 from the spawn. */
function timeline(id: string, build: number) {
  return {
    match_id: Number(id), start_time: 0, duration_s: N, source: "replay", tier: "replay", build, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: null,
        x: range(() => slot * 1500 - 4000), y: range(() => (team === "amber" ? -3000 : 3000)),
        health: range(() => 100), deaths: [], respawn: [], souls: [[0, 500]], ult: range(() => 0), seen: [],
        level: [[0, 1], [10, 5]], max_health: [[0, 777]], kills: [[0, 0]], assists: [[0, 0]],
        pickups: [[20, [20, 0, 3, 0, 0]]],
        items: [[50, VIT, 0], [120, WEAPON, 0]], abilities: [], casts: [], charges: [], cc: [], effects: [], recaps: [],
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [],
  };
}

const answered = new Set<string>();
async function open(p: Page, id: string, build: number) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(id);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${id}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".dem") && !answered.has(f)) ?? "")).not.toBe("");
  answered.add(job);
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline(id, build)));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await expect(p.getByTestId("match-clock")).toContainText(`0:${String(t).padStart(2, "0")} /`);
}

const column = (p: Page) => p.locator('.tb-player[data-slot="Amber-0"] [data-testid=hero-build]');

test("the scoreboard shows the build's calculated stats from its own patch's table", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Calculated stats"), "Coach");
  await open(a, "129000091", 6839);
  await scrubTo(a, 25);
  await a.locator(".tb-all-builds").click();
  const c = column(a);
  // 6837's table (6839 reads it): (700 + 4 boons · 50) · 1.09 (800 vitality) + 100 + 20 pickup.
  // 6860's would give 1201; the recorded 777 is replaced.
  await expect(c.getByTestId("stat-max-health")).toContainText("1101");
  await expect(c.getByTestId("stat-max-health")).toHaveAttribute("title", "Max health");
  // 12 (1,600 weapon souls) + 14 + 3 pickup.
  await expect(c.getByTestId("stat-weapon-damage")).toHaveText("29%");
  await expect(c.getByTestId("stat-weapon-damage")).toHaveAttribute("title", "Weapon damage");
  await expect(c.getByTestId("stat-spirit-power")).toHaveText("5");
  await expect(c.getByTestId("stat-spirit-power")).toHaveAttribute("title", "Spirit power");
  await expect(c.getByTestId("stat-bullet-resist")).toHaveText("10%");
  await expect(c.getByTestId("stat-bullet-resist")).toHaveAttribute("title", "Bullet resist");
  await expect(c.getByTestId("stat-spirit-resist")).toHaveText("0%");
  await expect(c.getByTestId("stat-spirit-resist")).toHaveAttribute("title", "Spirit resist");
  // Calculated values carry the quiet "≈" (spec §4b rule 5), drawn by CSS so the text stays the number.
  for (const k of ["max-health", "weapon-damage", "spirit-power", "bullet-resist", "spirit-resist"]) await expect(c.getByTestId(`stat-${k}`)).toHaveClass(/\bcalc\b/);
  expect(await c.getByTestId("stat-weapon-damage").evaluate((el) => getComputedStyle(el, "::before").content)).toBe('"≈"');
  // The bars fill along the ladder: 1,600 weapon souls is two small steps (14%), 800 vitality one
  // (7%); nothing in spirit. Not relative to the hero's own largest category.
  const bar = (k: string) => c.getByTestId(`invest-${k}`);
  await expect(bar("weapon")).toHaveAttribute("data-fill", "0.140");
  await expect(bar("vitality")).toHaveAttribute("data-fill", "0.070");
  await expect(bar("spirit")).toHaveAttribute("data-fill", "0.000");
  await expect(bar("weapon")).toHaveAttribute("title", "Weapon invest");
  await expect(bar("spirit")).toHaveAttribute("title", "Spirit invest");
  await expect(bar("vitality")).toHaveAttribute("title", "Vitality invest");
  await expect(bar("weapon")).toHaveAttribute("aria-label", "Weapon invest, 1,600");
  const height = await bar("weapon").locator("i").evaluate((el) => (el as HTMLElement).style.height);
  expect(parseFloat(height)).toBeCloseTo(14, 3);
  // Before the pickup and the weapon item: 1081, no weapon damage.
  await scrubTo(a, 11);
  await expect(c.getByTestId("stat-max-health")).toContainText("1081");
  await expect(c.getByTestId("stat-weapon-damage")).toHaveText("0%");
});

test("a build no table covers shows — and the recorded max health", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "No table"), "Coach");
  await open(a, "129000092", 6900);
  await scrubTo(a, 25);
  await a.locator(".tb-all-builds").click();
  const c = column(a);
  await expect(c.getByTestId("stat-max-health")).toContainText("777");
  // The recorded fallback is not calculated: no "≈".
  await expect(c.getByTestId("stat-max-health")).not.toHaveClass(/\bcalc\b/);
  for (const k of ["weapon-damage", "spirit-power", "bullet-resist", "spirit-resist"]) {
    await expect(c.getByTestId(`stat-${k}`)).toHaveText("—");
    await expect(c.getByTestId(`stat-${k}`)).toHaveAttribute("title", "Not recorded");
  }
});
