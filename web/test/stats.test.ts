import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { statIndex, type PackManifest, type StatIndex } from "../src/map/pack";
import { buildAt } from "../src/match/builds";
import { investFill, ladderKeyFor, statBuild, statsAt, tableKeyFor, type Ladder } from "../src/match/stats";
import type { TimelinePlayer } from "../src/match/timeline";
import { LABELS } from "../src/player/labels";
import { StatCalc, initSync } from "../src/wasm/mapcro_wasm.js";

const ROOT = join(import.meta.dirname, "../..");
initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

function manifest(builds: Record<string, string>, covered: number, own = 6860): PackManifest {
  const keys = [...new Set(Object.values(builds))];
  return {
    game: { client_version: own },
    blobs: Object.fromEntries(keys.map(k => [`data/stats/${k}`, { sha256: "x", mime: "application/json", file: `data/stats/${k}.json` }])),
    stats: { format: 1, covered_through: covered, builds, tables: Object.fromEntries(keys.map(k => [k, { blob: `data/stats/${k}`, client_version: Number(k.split("-")[1]), source: k.split("-")[0]! }])) },
  };
}
const index = (m: PackManifest) => statIndex(m, key => m.blobs[key] ? `/packs/p/${m.blobs[key]!.file}` : undefined) as StatIndex;

it("matches a replay build to its patch's table, the nearest earlier listed build, or none", () => {
  const ix = index(manifest({ 6711: "boon-6711", 6712: "boon-6711", 6837: "boon-6837", 6839: "boon-6837", 6842: "boon-6842", 6860: "vdata-6860" }, 6860));
  expect(tableKeyFor(ix, 6839)).toBe("boon-6837");
  expect(tableKeyFor(ix, 6712)).toBe("boon-6711");
  // Unlisted: data didn't change since the listed build below it.
  expect(tableKeyFor(ix, 6840)).toBe("boon-6837");
  expect(tableKeyFor(ix, 6859)).toBe("boon-6842");
  expect(tableKeyFor(ix, 6860)).toBe("vdata-6860");
  // Newer than the sources have seen, older than every table, or no build: none.
  expect(tableKeyFor(ix, 6861)).toBeNull();
  expect(tableKeyFor(ix, 6700)).toBeNull();
  expect(tableKeyFor(ix, undefined)).toBeNull();
  expect(tableKeyFor(undefined, 6839)).toBeNull();
  expect(tableKeyFor({ ...ix, format: 2 }, 6839)).toBeNull();
  // The ladder falls back to the pack's own patch.
  expect(ladderKeyFor(ix, 6861)).toBe("vdata-6860");
  expect(ladderKeyFor(ix, 6839)).toBe("boon-6837");
  expect(ix.tables.get("boon-6837")?.url).toBe("/packs/p/data/stats/boon-6837.json");
  expect(statIndex({ game: { client_version: 1 }, blobs: {} }, () => undefined)).toBeUndefined();
});

// m_MapModCostBonuses' rows (6860, every slot): threshold, bonus, flPercentOnGraph.
const LADDER: Ladder = [[800, 9, 7], [1600, 12, 7], [2400, 15, 8], [3200, 18, 8], [4800, 46, 9], [6400, 54, 9], [8000, 62, 10], [11200, 74, 10], [16000, 86, 10], [22400, 100, 11], [28800, 115, 11]];

it("fills an investment bar along the game's ladder, full only at the top tier", () => {
  expect(investFill(LADDER, 0)).toBe(0);
  // The first breakpoint is a small step, not a full bar.
  expect(investFill(LADDER, 800)).toBeCloseTo(0.07);
  expect(investFill(LADDER, 400)).toBeCloseTo(0.035);
  expect(investFill(LADDER, 4800)).toBeCloseTo(0.39);
  // Halfway from 16K to 22.4K: 78% + half of 11%.
  expect(investFill(LADDER, 19200)).toBeCloseTo(0.835);
  expect(investFill(LADDER, 28799)).toBeLessThan(1);
  expect(investFill(LADDER, 28800)).toBe(1);
  expect(investFill(LADDER, 50000)).toBe(1);
  expect(investFill(undefined, 5000)).toBe(0);
});

it("labels are tags (spec §4b)", () => {
  expect([LABELS.weapon, LABELS.spirit, LABELS.vitality]).toEqual(["Weapon invest", "Spirit invest", "Vitality invest"]);
  expect([LABELS.maxHealth, LABELS.bulletResist, LABELS.spiritResist, LABELS.weaponDamage, LABELS.spiritPower]).toEqual(["Max health", "Bullet resist", "Spirit resist", "Weapon damage", "Spirit power"]);
  expect(LABELS.missing).toBe("Not recorded");
  for (const l of Object.values(LABELS)) expect(l.split(" ").length).toBeLessThanOrEqual(3);
});

function player(over: Partial<TimelinePlayer> = {}): TimelinePlayer {
  return { team: "amber", slot: 0, hero_id: 52, x: [0, 0, null], y: [0, 0, null], health: [100, 50, 0], deaths: [], souls: [], level: [[0, 1], [1, 3]], items: [[0, 7, 0], [5, 8, 0], [15, 7, 1]], abilities: [[0, 30, 1], [1, 30, 2]], pickups: [[1, [20, 0, 3, 0, 0.75]]], ...over };
}

it("assembles the calculator's build from the timeline at a moment", () => {
  const p = player();
  const at = (t: number) => statBuild(p, t, buildAt(p, t));
  expect(at(0)).toEqual({ hero_id: 52, level: 1, items: [7], ability_tiers: [], pickups: { max_health: 0, spirit_power: 0, weapon_damage: 0, bullet_resist: 0, spirit_resist: 0 }, health_pct: 100 });
  expect(at(1)).toMatchObject({ level: 3, items: [7, 8], ability_tiers: [[30, 1]], pickups: { max_health: 20, weapon_damage: 3, spirit_resist: 0.75 }, health_pct: 50 });
  // Sold by 1.5 s; dead counts as full health for life thresholds.
  expect(at(2)).toMatchObject({ items: [8], health_pct: 100 });
  // No level, or no item series: nothing to calculate.
  expect(statBuild(player({ level: undefined }), 1, buildAt(p, 1))).toBeNull();
  expect(statBuild(p, 1, { items: null, abilities: null })).toBeNull();
});

it("runs the Rust calculator through WASM", () => {
  const table = { format: 1, client_version: 6860, source: "test", heroes: { 52: { max_health: 730, per_boon: { max_health: 45 }, boon_levels: [2, 3], cost_bonuses: [[[800, 9, 7]], [], []], bullet_resist: 0, spirit_resist: 0, bullet_resist_per_spirit: 0, spirit_resist_per_spirit: 0 } },
    items: { 7: { slot: 0, price: 800, passive: [["max_health", 100], ["spirit_resist", 10]] }, 8: { passive: [["weapon_damage", 15]] } } };
  const calc = { data: table as never, calc: new StatCalc(JSON.stringify(table)) };
  const p = player();
  const v = statsAt(calc, statBuild(p, 1, buildAt(p, 1)));
  // (730 + 2 boons · 45) · 1.09 + 100 + 20 pickup; 15 + 3; 1 - 0.9 · (1 - 0.0075).
  expect(v?.shown).toEqual({ max_health: 1013, spirit_power: 0, weapon_damage: 18, bullet_resist: 0, spirit_resist: 11 });
  expect(v?.invested).toEqual([800, 0, 0]);
  expect(statsAt(calc, { ...statBuild(p, 1, buildAt(p, 1))!, hero_id: 1 })).toBeNull();
  expect(() => new StatCalc(JSON.stringify({ ...table, format: 2 }))).toThrow();
});
