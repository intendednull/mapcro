import { expect, it } from "vitest";
import { effectsAt } from "../src/player/effects";
import type { BuildCatalog } from "../src/map/pack";
type Row = [number, number, number, number, number, number];
const catalog: BuildCatalog = { records: new Map([
  [1, { id: 1, kind: "modifier", name: "slowed", label: "Slowed", ability: 2 }],
  [2, { id: 2, kind: "item", name: "item", label: "Item", icon: "/game/item.png" }],
  [3, { id: 3, kind: "modifier", name: "permanent_pickup", label: "permanent_pickup", label_from: "internal" }],
  [4, { id: 4, kind: "modifier", name: "mark", label: "Mark", icon: "/game/mark.png" }],
]) };
it("keeps missing data unknown and resolves active effects with the source game icon", () => {
  const player = { effects: [[10, 30, 1, 255, 2, 3]] as Row[] };
  expect(effectsAt({}, 2)).toBeNull();
  expect(effectsAt(player, .9, catalog)).toEqual([]);
  expect(effectsAt(player, 2, catalog)).toEqual([{ id: 1, source: 255, stacks: 3, remaining: 1, label: "Slowed", icon: "/game/item.png" }]);
  expect(effectsAt(player, 3, catalog)).toEqual([]);
});
it("merges repeats, marks match-long effects permanent and drops internal bookkeeping", () => {
  const player = { effects: [[0, 100, 4, 1, 0, 1], [0, 100, 4, 1, 0, 1], [0, 100, 4, 1, 0, 2], [0, 100, 3, 1, 0, 1], [0, 40, 1, 1, 2, 1]] as Row[] };
  expect(effectsAt(player, 2, catalog, 100)).toEqual([
    { id: 1, source: 1, stacks: 1, remaining: 2, label: "Slowed", icon: "/game/item.png" },
    { id: 4, source: 1, stacks: 3, remaining: null, label: "Mark", icon: "/game/mark.png" },
  ]);
});
it("names an internal-named effect after its parent ability or item", () => {
  const named: BuildCatalog = { records: new Map([
    [5, { id: 5, kind: "item", name: "upgrade_escalating_exposure", label: "Escalating Exposure", icon: "/game/exposure.png" }],
    [6, { id: 6, kind: "modifier", name: "escalating_exposure_tech_armor_debuff", label: "escalating_exposure_tech_armor_debuff", label_from: "internal", ability: 5 }],
  ]) };
  const player = { effects: [[0, 40, 6, 1, 0, 1]] as Row[] };
  expect(effectsAt(player, 1, named)).toEqual([{ id: 6, source: 1, stacks: 1, remaining: 3, label: "Escalating Exposure", icon: "/game/exposure.png" }]);
});
