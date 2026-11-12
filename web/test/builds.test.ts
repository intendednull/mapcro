import { expect, it, vi } from "vitest";
import { buildAt, buildOrder, killsAt, type BuildAt, type BuildEntry } from "../src/match/builds";
import { artFromManifest, buildCatalogFromData, loadArt, type PackManifest } from "../src/map/pack";
import type { TimelinePlayer } from "../src/match/timeline";

type PlayerBuild = Pick<TimelinePlayer, "items" | "abilities" | "casts" | "charges" | "stacks">;

/** The linear version `buildAt` replaced, kept as the oracle for the equivalence test. */
function referenceBuildAt(player: PlayerBuild, t: number): BuildAt {
  const ds = t * 10;
  const casts = new Map<number, number>();
  const charges = new Map<number, number>();
  for (const [at, id, end] of player.casts ?? []) if (at <= ds) casts.set(id, end);
  for (const [at, id, count] of player.charges ?? []) if (at <= ds) charges.set(id, count);
  const stacks = new Map<number, number>();
  for (const [at, id, count] of player.stacks ?? []) if (at <= ds) stacks.set(id, count);
  const entry = (id: number): BuildEntry => {
    const end = casts.get(id);
    return { id, cooldown: end == null || end === 0 ? null : Math.max(0, (end - ds) / 10), charges: charges.get(id) ?? null, stacks: stacks.get(id) || null };
  };
  const owned = new Set<number>();
  for (const [at, id, kind] of player.items ?? []) {
    if (at > ds) continue;
    if (kind === 0) owned.add(id);
    else owned.delete(id);
  }
  const levels = new Map<number, number>();
  for (const [at, id, level] of player.abilities ?? []) if (at <= t) levels.set(id, level);
  return {
    items: player.items == null ? null : [...owned].map(entry),
    abilities: player.abilities == null ? null : [...levels].map(([id, level]) => ({ ...entry(id), level })),
  };
}

/** Deterministic PRNG (mulberry32) so a failure is reproducible. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A time-sorted series, with duplicate times, over a small id set. */
function series(rand: () => number, n: number, ids: number[], value: () => number): [number, number, number][] {
  const rows: [number, number, number][] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    at += rand() < 0.25 ? 0 : 1 + Math.floor(rand() * 4);
    rows.push([at, ids[Math.floor(rand() * ids.length)]!, value()]);
  }
  return rows;
}

it("matches the linear reference on random sorted series and every t shape", () => {
  const rand = rng(129738985);
  for (let round = 0; round < 60; round++) {
    const ids = Array.from({ length: 1 + Math.floor(rand() * 5) }, (_, i) => 10 + i);
    const player: PlayerBuild = {};
    if (rand() >= 0.1) player.items = series(rand, Math.floor(rand() * 8), ids, () => Math.floor(rand() * 4));
    if (rand() >= 0.1) player.abilities = series(rand, Math.floor(rand() * 6), ids, () => 1 + Math.floor(rand() * 4));
    if (rand() >= 0.1) player.casts = series(rand, Math.floor(rand() * 12), ids, () => (rand() < 0.15 ? 0 : Math.floor(rand() * 200)));
    if (rand() >= 0.1) player.charges = series(rand, Math.floor(rand() * 10), ids, () => Math.floor(rand() * 4));
    if (rand() >= 0.1) player.stacks = series(rand, Math.floor(rand() * 10), ids, () => Math.floor(rand() * 8));
    const times = new Set<number>([-1, 0, 0.05, 0.1, 1.5, 2.345, 1e6]);
    for (const rows of [player.items, player.abilities, player.casts, player.charges, player.stacks]) {
      for (const row of rows ?? []) {
        // Exactly on the entry, just before and just after it, in both clocks.
        times.add(row[0] / 10);
        times.add(row[0] / 10 - 0.001);
        times.add(row[0] / 10 + 0.001);
        times.add(row[0]);
        times.add(row[0] - 0.001);
      }
    }
    for (let i = 0; i < 10; i++) times.add(rand() * 60);
    for (const t of times) expect(buildAt(player, t)).toEqual(referenceBuildAt(player, t));
  }
  // Wanted ids with no rows at all in a series (most owned items never cast, most abilities
  // never stack).
  const sparse: PlayerBuild = { items: [[0, 1, 0], [0, 2, 0], [5, 3, 0]], abilities: [[0, 9, 1]], casts: [[10, 1, 40], [20, 1, 0]], charges: [[30, 2, 2]] };
  for (const t of [0, 0.5, 1, 2, 3, 4, 10, 100]) expect(buildAt(sparse, t)).toEqual(referenceBuildAt(sparse, t));
});

it("looks up casts without scanning all of them", () => {
  const n = 10_000;
  const ids = [100, 101, 102, 103];
  const rows: [number, number, number][] = Array.from({ length: n }, (_, i) => [i, ids[i % ids.length]!, 0]);
  let reads = 0;
  const counted = new Proxy(rows, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const player: PlayerBuild = { items: [[0, 100, 0]], abilities: ids.map((id) => [0, id, 1]), casts: counted };
  buildAt(player, n / 10); // the per-array index's one pass
  reads = 0;
  const build = buildAt(player, n / 10);
  expect(build.abilities?.map((a) => a.id)).toEqual(ids);
  // A binary search plus one step per wanted id; the linear version read all 10,000.
  expect(reads).toBeLessThan(100);
  expect(reads).toBeLessThan(n / 10);
});

it("does not walk back through casts for ids that never cast", () => {
  // A real build: six owned items, two of them active and cast; the rest never appear.
  const n = 10_000;
  const castIds = [200, 201];
  const owned = [200, 201, 202, 203, 204, 205];
  const rows: [number, number, number][] = Array.from({ length: n }, (_, i) => [i, castIds[i % castIds.length]!, 0]);
  let reads = 0;
  const counted = new Proxy(rows, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
      return Reflect.get(target, prop, receiver);
    },
  });
  const player: PlayerBuild = { items: owned.map((id) => [0, id, 0]), casts: counted };
  buildAt(player, n / 10); // the per-array index's one pass
  reads = 0;
  const build = buildAt(player, n / 10);
  expect(build.items?.map((e) => e.id)).toEqual(owned);
  // One binary search per id that has rows; ids with none cost nothing. The linear version read
  // all 10,000 to look for the four that never cast.
  expect(reads).toBeLessThan(200);
});

it("distinguishes unavailable builds from tracked empty builds", () => {
  expect(buildAt({}, 5)).toEqual({ items: null, abilities: null });
  expect(buildAt({ items: [], abilities: [] }, 5)).toEqual({ items: [], abilities: [] });
});
it("applies merges, sales, removals and ability upgrades at the exact clocks", () => {
  const player = { items: [[15, 10, 0], [20, 10, 2], [20, 11, 0], [35, 11, 1], [40, 12, 0], [45, 12, 3]] as [number, number, number][], abilities: [[1, 90, 1], [3, 90, 2]] as [number, number, number][] };
  expect(buildAt(player, 1.4).items).toEqual([]);
  expect(buildAt(player, 1.5).items?.map(x => x.id)).toEqual([10]);
  expect(buildAt(player, 3).items?.map(x => x.id)).toEqual([11]);
  expect(buildAt(player, 3).abilities?.[0]?.level).toBe(2);
  expect(buildAt(player, 4.5).items).toEqual([]);
});
it("tracks casts and charges by token without interpreting unknown end times as ready", () => {
  const player = { items: [[0, 10, 0]] as [number, number, number][], casts: [[20, 10, 50], [60, 10, 0]] as [number, number, number][], charges: [[25, 10, 2], [40, 10, 1]] as [number, number, number][] };
  expect(buildAt(player, 1).items?.[0]).toEqual({ id: 10, cooldown: null, charges: null, stacks: null });
  expect(buildAt(player, 3).items?.[0]).toEqual({ id: 10, cooldown: 2, charges: 2, stacks: null });
  expect(buildAt(player, 5).items?.[0]).toEqual({ id: 10, cooldown: 0, charges: 1, stacks: null });
  expect(buildAt(player, 6).items?.[0]?.cooldown).toBeNull();
});
it("holds the stacks on each ability and item as they change, none at 0", () => {
  // Leech Therapy (90): leeches collected rise, a death takes some; an item's stacks run out.
  const player = {
    items: [[0, 10, 0]] as [number, number, number][],
    abilities: [[0, 90, 1]] as [number, number, number][],
    stacks: [[20, 90, 1], [40, 90, 4], [60, 90, 3], [50, 10, 6], [70, 10, 0]] as [number, number, number][],
  };
  expect(buildAt(player, 1).abilities?.[0]?.stacks).toBeNull();
  expect(buildAt(player, 2).abilities?.[0]?.stacks).toBe(1);
  expect(buildAt(player, 5).abilities?.[0]?.stacks).toBe(4);
  expect(buildAt(player, 6).abilities?.[0]?.stacks).toBe(3);
  expect(buildAt(player, 6).items?.[0]?.stacks).toBe(6);
  expect(buildAt(player, 7).items?.[0]?.stacks).toBeNull();
  // A timeline from before format 10 has none.
  expect(buildAt({ abilities: player.abilities }, 6).abilities?.[0]?.stacks).toBeNull();
});
const manifest: PackManifest = {
  game: { client_version: 6860 },
  blobs: { "data/abilities": { sha256: "x", mime: "application/json", file: "data/abilities.json" }, icon: { sha256: "y", mime: "image/png", file: "icons/item.png" } },
  abilities: { blob: "data/abilities" },
  heroes: [{ hero_id: 1, name: "Infernus", minimap_blob: null, abilities: [491391007, 3516947824, 1593133799, 1142270357] }],
};
const data = { records: { "1009965641": { kind: "item" as const, name: "upgrade_non_player_bonus", label: "Monster Rounds", cost: 800, tier: 1, icon: "icon" } } };
it("preserves game tokens and HUD order, resolving icons in the same pack", () => {
  expect(buildCatalogFromData("/base", "selected", manifest, data).records.get(1009965641)).toMatchObject({ label: "Monster Rounds", cost: 800, icon: "/base/packs/selected/icons/item.png" });
  expect(artFromManifest("", "selected", manifest).heroes.get(1)?.abilities).toEqual(manifest.heroes![0]!.abilities);
  expect(buildCatalogFromData("", "selected", { ...manifest, blobs: {} }, data).records.get(1009965641)?.icon).toBeUndefined();
});
it("loads the selected catalog and retains art when its catalog is unavailable", async () => {
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify([{ pack_id: "selected" }]))).mockResolvedValueOnce(new Response(JSON.stringify(manifest))).mockResolvedValueOnce(new Response(JSON.stringify(data)));
  try {
    expect((await loadArt("/base")).buildCatalog?.records.get(1009965641)?.label).toBe("Monster Rounds");
    expect(mock.mock.calls[2]?.[0]).toBe("/base/packs/selected/data/abilities.json");
    mock.mockResolvedValueOnce(new Response(JSON.stringify([{ pack_id: "selected" }]))).mockResolvedValueOnce(new Response(JSON.stringify(manifest))).mockRejectedValueOnce(new Error("offline"));
    const art = await loadArt();
    expect(art.packId).toBe("selected");
    expect(art.buildCatalog).toBeUndefined();
  } finally { mock.mockRestore(); }
});

it("does not turn missing kill attribution into zero or an incomplete total", () => {
  const timeline = { events: [
    { t: 10, kind: "death" as const, by: { team: "amber", slot: 0, hero_id: 1 } },
    { t: 20, kind: "death" as const },
  ] };
  expect(killsAt(undefined, 10, "amber")).toBeNull();
  expect(killsAt(timeline, 9, "amber", 0)).toBe(0);
  expect(killsAt(timeline, 10, "amber", 0)).toBe(1);
  expect(killsAt(timeline, 10, "amber", 1)).toBe(0);
  expect(killsAt(timeline, 20, "amber")).toBeNull();
});


it("prefers recorded kills without leaking future totals or bridging unknown samples", () => {
  const player = (kills: Array<[number, number | null]>) => ({ team: "amber", slot: 0, kills }) as import("../src/match/timeline").TimelinePlayer;
  const timeline = { events: [], players: [player([[0, 0], [5, 2], [8, null], [10, 3]])] };
  expect(killsAt(timeline, 4, "amber")).toBe(0);
  expect(killsAt(timeline, 5, "amber", 0)).toBe(2);
  expect(killsAt(timeline, 9, "amber")).toBeNull();
  expect(killsAt(timeline, 10, "amber")).toBe(3);
});
it("lists the build order earliest first, an upgrade's used-up components with its buy", () => {
  const player = { items: [[40, 12, 0], [15, 10, 0], [20, 10, 2], [20, 11, 0], [35, 11, 1], [45, 12, 3], [60, 13, 2]] as [number, number, number][] };
  expect(buildOrder({})).toBeNull();
  expect(buildOrder({ items: [] })).toEqual([]);
  expect(buildOrder(player, id => (id === 11 ? [10] : []))).toEqual([
    { t: 1.5, id: 10, kind: "bought", from: [] },
    { t: 2, id: 11, kind: "bought", from: [10] },
    { t: 3.5, id: 11, kind: "sold", from: [] },
    { t: 4, id: 12, kind: "bought", from: [] },
    { t: 4.5, id: 12, kind: "removed", from: [] },
    { t: 6, id: 13, kind: "merged", from: [] },
  ]);
  // Not a component of the buy at that moment (by the catalog): its own row.
  expect(buildOrder({ items: [[20, 10, 2], [20, 11, 0]] }, () => [])?.map(e => e.kind)).toEqual(["merged", "bought"]);
});
