import { expect, it, vi } from "vitest";
import { buildAt, buildOrder, killsAt } from "../src/match/builds";
import { artFromManifest, buildCatalogFromData, loadArt, type PackManifest } from "../src/map/pack";

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
