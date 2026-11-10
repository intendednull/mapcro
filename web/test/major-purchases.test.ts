import { expect, it } from "vitest";
import { majorPurchases, groupOf, label } from "../src/player/events";
import type { Timeline } from "../src/match/timeline";
import type { BuildCatalog } from "../src/map/pack";
it("lists recorded major buys only, preserving decisecond order and excluding sales and unknown tiers", () => {
  const tl = { players: [{ team: "amber", slot: 0, hero_id: 1, items: [[105, 1, 0], [110, 1, 1], [120, 2, 0], [130, 3, 0]] }] } as unknown as Timeline;
  const catalog = { records: new Map([[1, { kind: "item", label: "Major item", tier: 4 }], [2, { kind: "item", label: "Small item", tier: 1 }]]) } as BuildCatalog;
  const events = majorPurchases(tl, catalog);
  expect(events).toHaveLength(1);
  expect(events[0]?.t).toBe(10.5);
  expect(groupOf(events[0]!)).toBe("purchase");
  expect(label(events[0]!, { hero: () => "Hero", player: () => undefined })).toBe("Hero bought Major item");
  expect(majorPurchases(tl, undefined)).toEqual([]);
});
