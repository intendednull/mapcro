import { expect, it, vi } from "vitest";
import { buildAt, killsAt } from "../src/match/builds";
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
  expect(buildAt(player, 1).items?.[0]).toEqual({ id: 10, cooldown: null, charges: null });
  expect(buildAt(player, 3).items?.[0]).toEqual({ id: 10, cooldown: 2, charges: 2 });
  expect(buildAt(player, 5).items?.[0]).toEqual({ id: 10, cooldown: 0, charges: 1 });
  expect(buildAt(player, 6).items?.[0]?.cooldown).toBeNull();
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
