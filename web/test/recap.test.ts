import { expect, it } from "vitest";
import { NPC_SRC, recapAbility, recapFor, recapSource } from "../src/player/recap";
import type { BuildRecord } from "../src/map/pack";
import type { Timeline } from "../src/match/timeline";
it("matches a lethal hit to its sampled death without borrowing another hero or death", () => {
  const recap = { t: 4048, damage: [[255, 0, 500]] };
  const tl = { players: [{ team: "amber", slot: 0, recaps: [recap] }] } as unknown as Timeline;
  expect(recapFor(tl, { kind: "death", t: 405, team: "amber", slot: 0 })).toBe(recap);
  expect(recapFor(tl, { kind: "death", t: 404, team: "amber", slot: 0 })).toBeUndefined();
  expect(recapFor(tl, { kind: "death", t: 405, team: "sapphire", slot: 0 })).toBeUndefined();
  expect(recapFor(tl, { kind: "ult", t: 405, team: "amber", slot: 0 })).toBeUndefined();
});
it("pairs a death with a lethal hit up to a second and a half before its sample (129738985: 520.0 s, death at 521)", () => {
  const hit = { t: 5200, damage: [[255, 0, 500]] };
  const tl = { players: [{ team: "amber", slot: 3, recaps: [hit] }] } as unknown as Timeline;
  expect(recapFor(tl, { kind: "death", t: 521, team: "amber", slot: 3 })).toBe(hit);
  expect(recapFor(tl, { kind: "death", t: 520, team: "amber", slot: 3 })).toBe(hit);
  expect(recapFor(tl, { kind: "death", t: 522, team: "amber", slot: 3 })).toBeUndefined();
  expect(recapFor(tl, { kind: "death", t: 519, team: "amber", slot: 3 })).toBeUndefined();
});

it("names a recap row's source: a hero, an NPC by the game's class name, else World / other", () => {
  const tl = { players: [{ hero_id: 7 }, { hero_id: 9 }] } as unknown as Timeline;
  const hero = (id: number) => (id === 7 ? "Haze" : undefined);
  expect(recapSource(0, tl, hero)).toBe("Haze");
  expect(recapSource(1, tl, hero)).toBe("Hero");
  expect(recapSource(255, tl, hero)).toBe("World / other");
  expect(recapSource(NPC_SRC, tl, hero)).toBe("Trooper");
  expect(recapSource(NPC_SRC + 4, tl, hero)).toBe("Walker");
  expect(recapSource(NPC_SRC + 9, tl, hero)).toBe("Sinner's Sacrifice");
  expect(recapSource(NPC_SRC + 99, tl, hero)).toBe("World / other");
});

it("never shows an engine name for a recap's ability: the parent's, else Weapon or Ability", () => {
  const rec = (id: number, name: string, label_from: BuildRecord["label_from"], ability?: number): BuildRecord => ({ id, kind: "ability", name, label: label_from === "internal" ? name : `Label ${id}`, label_from, ...(ability ? { ability } : {}) });
  const records = new Map([
    [1, rec(1, "citadel_weapon_bull_set", "internal")],
    [2, rec(2, "deadpack_primary_weapon_charge", "internal")],
    [3, rec(3, "some_internal_thing", "internal")],
    [4, rec(4, "ability_x_child", "internal", 5)],
    [5, rec(5, "ability_x", "localisation")],
    [6, rec(6, "ability_y", "localisation")],
  ]);
  const r = (id: number) => records.get(id);
  expect(recapAbility(1, r, false)).toBe("Weapon");
  expect(recapAbility(2, r, true)).toBe("Weapon");
  expect(recapAbility(3, r, false)).toBe("Ability");
  expect(recapAbility(4, r, false)).toBe("Label 5");
  expect(recapAbility(6, r, false)).toBe("Label 6");
  expect(recapAbility(77, r, false)).toBe("Unknown ability");
  expect(recapAbility(0, r, false)).toBe("Other damage");
  expect(recapAbility(0, r, true)).toBeUndefined();
});
