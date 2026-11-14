// The builds tracer's property (map-state spec §9): what a scene stores for a hero's build reads
// back as the build Player computed, for every row, and the calculator's input from it is the
// one Player gives. A made-up match (no names, no ids; 6v6).
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/gen/limits";
import { ROWS, type RowKey } from "../src/gen/rows";
import { WRITTEN, captureBuild, captureScene, captured, heroBuildAt, readBuild, statOf, type HeroBuild } from "../src/mapstate/build";
import { buildAt, buildOrder } from "../src/match/builds";
import { PICKUPS_FORMAT, statBuild } from "../src/match/stats";
import type { Timeline, TimelinePlayer } from "../src/match/timeline";

const hero = (team: "amber" | "sapphire", slot: number): TimelinePlayer => {
  const i = (team === "amber" ? 0 : 6) + slot;
  const dies = i === 3;
  return {
    team, slot, hero_id: 10 + i, name: "",
    x: [0, 1, 2, dies ? null : 3, 4], y: [0, 1, 2, dies ? null : 3, 4],
    health: [100, 90, 60, dies ? 0 : 75, 100], deaths: dies ? [3] : [],
    souls: [[0, 400]], ult: [null, 100, 50, 25, 0],
    level: [[0, 1], [2, 4 + i]], max_health: [[0, 700], [3, 925 + i]],
    kills: [[0, 0], [2, i]], assists: [[0, 0], [3, 2]],
    // Fractional, as a real match's are (f32; the resists move in quarters).
    pickups: [[1, [20, 1.5, 2, 3.25, 4.75]], [3, [45, 2.5, 4.4, 6.75 + i / 4, 8.5]]],
    items: [[5, 9000 + i, 0], [15, 9100 + i, 0], [25, 9000 + i, 2], [25, 9200 + i, 0], [35, 9100 + i, 1]],
    abilities: [[0, 7000 + i, 1], [2, 7000 + i, 3], [3, 7100 + i, 1]],
    casts: [[18, 7000 + i, 43], [22, 9200 + i, 0]], charges: [[10, 9100 + i, 2]], stacks: [[20, 9100 + i, 3]],
  } as TimelinePlayer;
};
const match = (format: number): Timeline => ({
  match_id: 9, start_time: 0, duration_s: 4, source: "replay", tier: "replay", build: 6839, format, reanchored: 0,
  players: (["amber", "sapphire"] as const).flatMap((team) => [0, 1, 2, 3, 4, 5].map((slot) => hero(team, slot))),
  objectives: [], mid_boss: [],
} as unknown as Timeline);

/** A build as a scene holds it once every row is written: what this build's capture leaves out
 * (rows still ahead) reads as not captured. */
const written = (b: HeroBuild): HeroBuild => {
  const out = { ...b };
  const field: Partial<Record<RowKey, keyof HeroBuild>> = { build_order: "order" };
  for (const key of Object.keys(ROWS) as RowKey[]) {
    if (ROWS[key].entity !== "hero" || ROWS[key].index < WRITTEN || key === "name") continue;
    (out as Record<string, unknown>)[field[key] ?? key] = null;
  }
  return out;
};

describe("a hero's build through a scene", () => {
  const tl = match(PICKUPS_FORMAT);
  it.each([0, 1, 2, 3, 4])("reads back as Player computed it at second %i, for every hero", (t) => {
    const rows = captured(captureScene(tl));
    expect(rows).toEqual({ builds: true, rows: WRITTEN, patch: 6839 });
    for (const p of tl.players) {
      const computed = heroBuildAt(tl, p, t);
      const stored = captureBuild(computed);
      // Through JSON, as the document holds it.
      const back = readBuild(JSON.parse(JSON.stringify(stored)), rows.rows, p.hero_id);
      expect(back).toEqual(written(computed));
      // The column's inputs: the build, the build order and the calculator's.
      expect({ items: back.items, abilities: back.abilities }).toEqual(buildAt(p, t));
      expect(buildOrder({ items: back.order! })).toEqual(buildOrder(p)!.filter((e) => e.t <= t));
      const alive = p.x[t] != null;
      expect(statOf(back, alive)).toEqual(statBuild(p, t, buildAt(p, t)));
    }
  });

  it("stores integers within each row's bounds, and nothing for what the match lacks", () => {
    for (const p of tl.players) {
      for (const [key, v] of Object.entries(captureBuild(heroBuildAt(tl, p, 2.5)))) {
        const row = ROWS[key as RowKey];
        expect(row.entity).toBe("hero");
        expect(row.status).not.toBe("ahead");
        for (const n of Array.isArray(v) ? v : [v]) {
          expect(Number.isInteger(n)).toBe(true);
          if (row.kind === "int" || row.kind === "ints") expect(n as number >= row.min && n as number <= row.max).toBe(true);
        }
        if (row.kind === "ints") expect((v as number[]).length).toBeLessThanOrEqual(row.len);
      }
    }
    // An older format has no pickups: no calculated stats in the scene either, as in Player.
    const old = match(PICKUPS_FORMAT - 1);
    const b = readBuild(captureBuild(heroBuildAt(old, old.players[0]!, 2)), WRITTEN, 10);
    expect(b.pickups).toBeNull();
    expect(statOf(b, true)).toBeNull();
    // A metadata-tier hero: no items series, so none stored and none read.
    const { items: _items, abilities: _abilities, ...bare } = old.players[0]!;
    const none = captureBuild(heroBuildAt(old, bare as TimelinePlayer, 2));
    expect("items" in none || "abilities" in none || "build_order" in none).toBe(false);
  });

  it("keeps a record within its byte cap by dropping the oldest build order rows", () => {
    const p = { ...tl.players[0]!, items: Array.from({ length: 900 }, (_, i) => [i * 10, 4_000_000_000 + i, i % 4] as [number, number, number]) };
    const more = captureBuild(heroBuildAt(tl, p, 4000));
    expect(new TextEncoder().encode(JSON.stringify(more)).length).toBeLessThanOrEqual(LIMITS.max_more_bytes);
    const order = more.build_order as number[];
    expect(order.length % 3).toBe(0);
    expect(order.length).toBeGreaterThan(0);
    expect(order.slice(-3)).toEqual([8990, 4_000_000_899, 3]);
  });

  it("cuts each list at its row's length: the first 32 items and 9 abilities, the latest 200 buys", () => {
    const entry = (id: number) => ({ id, cooldown: null, charges: null, stacks: null });
    const build: HeroBuild = {
      ...heroBuildAt(tl, tl.players[0]!, 2),
      items: Array.from({ length: 40 }, (_, i) => entry(100 + i)),
      abilities: Array.from({ length: 12 }, (_, i) => ({ ...entry(200 + i), level: 1 })),
      order: Array.from({ length: 250 }, (_, i) => [i, 300 + i, 0] as [number, number, number]),
    };
    const more = captureBuild(build);
    // The server refuses a list over its row's length, and a record's whole `more` with it.
    for (const key of ["items", "abilities", "build_order"] as const) expect((more[key] as number[]).length).toBeLessThanOrEqual(ROWS[key].len);
    const back = readBuild(JSON.parse(JSON.stringify(more)), WRITTEN, build.hero);
    expect(back.items).toEqual(build.items!.slice(0, 32));
    expect(back.abilities).toEqual(build.abilities!.slice(0, 9));
    expect(back.order).toEqual(build.order!.slice(-200));
    // At the cap exactly, nothing is cut.
    const full = { ...build, items: build.items!.slice(0, 32), abilities: build.abilities!.slice(0, 9), order: build.order!.slice(0, 200) };
    expect(readBuild(captureBuild(full), WRITTEN, build.hero)).toMatchObject({ items: full.items, abilities: full.abilities, order: full.order });
  });

  it("reads a row at or above the snapshot's watermark, or a damaged list, as not captured", () => {
    const p = tl.players[1]!;
    const more = captureBuild(heroBuildAt(tl, p, 2));
    expect(readBuild(more, ROWS.items.index, p.hero_id).items).toBeNull();
    expect(readBuild(more, ROWS.items.index + 1, p.hero_id).items).not.toBeNull();
    expect(readBuild({ ...more, items: [1, 2, 3] }, WRITTEN, p.hero_id).items).toBeNull();
    expect(readBuild({ ...more, abilities: "x", level: [1], pickups: [1, 2] }, WRITTEN, p.hero_id)).toMatchObject({ abilities: null, level: null, pickups: null });
    expect(captured(undefined)).toEqual({ builds: false, rows: 0, patch: undefined });
    expect(captured({ has_builds: true })).toMatchObject({ builds: false });
    expect(readBuild(undefined, WRITTEN, 5)).toMatchObject({ hero: 5, items: null, order: null });
  });
});
