// Calculated hero stats for the Tab scoreboard (docs/research/stat-calc-spike.md "Production
// plan"; spec §6b "Calculated stats"). The pack carries one stat table per patch
// (crates/extract/src/stats.rs); the replay's build picks one, and the WASM calculator
// (crates/stats, the same code the ground-truth checks run) turns a build into values.
// Everything but the loader is pure.

import { loadWasm } from "../board/state";
import type { StatIndex } from "../map/pack";
import { StatCalc } from "../wasm/mapcro_wasm.js";
import type { BuildAt } from "./builds";
import { scoreboardValueAt, type TimelinePlayer } from "./timeline";

/** `mapcro_stats::TABLE_FORMAT`: a table in another format isn't read. */
export const TABLE_FORMAT = 1;

/**
 * The table a replay build reads: the build itself if the sources list it, else the nearest
 * listed build below it (boon-data and GameTracking publish only builds whose data changed), up to
 * the newest build the sources have seen. `null` outside that range: no table, so "—".
 */
export function tableKeyFor(index: StatIndex | undefined, build: number | undefined): string | null {
  if (!index || build == null || index.format !== TABLE_FORMAT || build > index.coveredThrough) return null;
  let key: string | null = null;
  for (const [b, k] of index.builds) {
    if (b > build) break;
    key = k;
  }
  return key;
}

/** The investment ladder's table: the replay build's, else the pack's own (current patch). */
export function ladderKeyFor(index: StatIndex | undefined, build: number | undefined): string | null {
  return tableKeyFor(index, build) ?? (index?.format === TABLE_FORMAT ? index.installKey ?? null : null);
}

/** The first timeline format with statue pickups: without them health and weapon % would be
 * short (the spike: 72% exact falls to 25%), so an older timeline gets no calculated values. */
export const PICKUPS_FORMAT = 9;

/** `(souls threshold, bonus, percent of the bar)` rows (`m_MapModCostBonuses`), ascending. */
export type Ladder = Array<[number, number, number]>;

/** The part of a table the client reads itself (the rest goes to the calculator). */
export interface StatTableData {
  format: number;
  client_version: number;
  heroes: Record<string, { cost_bonuses: [Ladder, Ladder, Ladder] }>;
}

export interface LoadedTable {
  data: StatTableData;
  calc: StatCalc;
}

/** Index into `cost_bonuses` and `invested`: vitality, spirit, weapon (`mapcro_stats::SLOTS`). */
export const SLOT = { vitality: 0, spirit: 1, weapon: 2 } as const;

const loaded = new Map<string, Promise<LoadedTable | undefined>>();

/** Fetch and parse a table once per URL; undefined if it can't be had (the UI shows "—"). */
export function loadStatTable(index: StatIndex | undefined, key: string | null): Promise<LoadedTable | undefined> {
  const url = key ? index?.tables.get(key)?.url : undefined;
  if (!url) return Promise.resolve(undefined);
  let p = loaded.get(url);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) return undefined;
        const text = await r.text();
        const data = JSON.parse(text) as StatTableData;
        if (data.format !== TABLE_FORMAT) return undefined;
        // The board's one WASM instance (a second init would replace the replica's module).
        await loadWasm();
        return { data, calc: new StatCalc(text) };
      } catch {
        return undefined;
      }
    })();
    loaded.set(url, p);
  }
  return p;
}

/**
 * How full a category's investment bar is (0..1), on the game's own scale: each ladder row takes
 * its `flPercentOnGraph` share of the bar and fills linearly from the row below's threshold (0 for
 * the first) to its own; full only at the top tier. Not checked against the running game yet
 * (docs/backlog.md "To verify in the running game").
 */
export function investFill(ladder: Ladder | undefined, souls: number): number {
  if (!ladder?.length) return 0;
  const total = ladder.reduce((sum, [, , share]) => sum + share, 0);
  if (total <= 0) return 0;
  let filled = 0;
  let from = 0;
  for (const [to, , share] of ladder) {
    if (souls >= to) filled += share;
    else {
      if (souls > from && to > from) filled += share * (souls - from) / (to - from);
      break;
    }
    from = to;
  }
  return Math.min(1, filled / total);
}

/** `mapcro_stats::Build`. */
export interface StatBuild {
  hero_id: number;
  level: number;
  items: number[];
  ability_tiers: Array<[number, number]>;
  pickups: { max_health: number; spirit_power: number; weapon_damage: number; bullet_resist: number; spirit_resist: number };
  health_pct: number | null;
}

/**
 * The calculator's input at second `t`, or null when the replay lacks what the rules need (the
 * level, or the items). Health feeds the life-threshold items; a dead hero counts as full.
 */
export function statBuild(player: TimelinePlayer, t: number, build: BuildAt): StatBuild | null {
  const level = scoreboardValueAt(player.level, t);
  if (level == null || build.items == null) return null;
  let pickups: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const [s, v] of player.pickups ?? []) {
    if (s > t) break;
    pickups = v;
  }
  const sec = Math.max(0, Math.floor(t));
  const alive = player.x[sec] != null;
  return {
    hero_id: player.hero_id,
    level,
    items: build.items.map(i => i.id),
    ability_tiers: (build.abilities ?? []).filter(a => a.level >= 2).map(a => [a.id, a.level - 1]),
    pickups: { max_health: pickups[0], spirit_power: pickups[1], weapon_damage: pickups[2], bullet_resist: pickups[3], spirit_resist: pickups[4] },
    health_pct: alive ? player.health[sec] ?? null : 100,
  };
}

/** The values the HUD shows, as integers (`mapcro_stats::Shown`). */
export interface ShownStats {
  max_health: number;
  spirit_power: number;
  weapon_damage: number;
  bullet_resist: number;
  spirit_resist: number;
}

export interface StatValues {
  shown: ShownStats;
  /** Souls in owned items per slot ([`SLOT`] order), at this patch's prices. */
  invested: [number, number, number];
}

export function statsAt(table: LoadedTable | undefined, build: StatBuild | null): StatValues | null {
  if (!table || !build) return null;
  try {
    const out = JSON.parse(table.calc.calculate(JSON.stringify(build))) as { shown: ShownStats; calculated: { invested: [number, number, number] } } | null;
    return out ? { shown: out.shown, invested: out.calculated.invested } : null;
  } catch {
    return null;
  }
}
