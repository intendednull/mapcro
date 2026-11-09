// The map's furniture (docs/research/map-objectives-audit.md): shops and teleporters always
// drawn, the healing pickups behind the Heals toggle and timed in Player like camps. Pure parts:
// the markers, the teleporters' pairs, the built-in fallback for older packs, and the timers.

import { describe, expect, it } from "vitest";
import { FALLBACK } from "../src/map/fallback-data";
import { isFurniture, markersFrom, modelFromFallback, withBuiltInFurniture, type PackEntity } from "../src/map/model";
import { artFromManifest } from "../src/map/pack";
import { type Timeline, campsAt, sitesAt } from "../src/match/timeline";
import { markerTip } from "../src/player/Camps";
import type { MatchPreview } from "../src/match/preview";

// As the extractor writes them for build 6860.
const furniture: PackEntity[] = [
  { key: "shop:amber:lane1:1", kind: "shop", team: "amber", lane: "lane1", world: [-8832, -1944, 312] },
  { key: "shop:neutral:lane6:1", kind: "shop", team: "neutral", lane: "lane6", world: [3920, -1120, -80] },
  { key: "teleporter:neutral:lane4:1", kind: "teleporter", team: "neutral", lane: "lane4", world: [-3584, -2784, -112], exit: [3904, -1664, -144] },
  { key: "teleporter:neutral:lane6:1", kind: "teleporter", team: "neutral", lane: "lane6", world: [3904, -1792, -128], exit: [-3584, -2656, -128] },
  { key: "teleporter:neutral:lane1:1", kind: "teleporter", team: "neutral", lane: "lane1", world: [-3904, 1792, -128], exit: [3584, 2656, -128] },
  { key: "teleporter:neutral:lane4:2", kind: "teleporter", team: "neutral", lane: "lane4", world: [3584, 2784, -112], exit: [-3904, 1664, -144] },
  { key: "heal:neutral:lane4:1", kind: "heal", team: "neutral", lane: "lane4", world: [1792, -1152, 1112] },
];
const camp: PackEntity = { key: "camp:neutral:lane1:9", kind: "camp", team: "neutral", lane: "lane1", world: [-5920, -1184, 264], tier: "medium" };
const count = (es: Array<{ kind: string }>, kind: string) => es.filter((e) => e.kind === kind).length;

describe("the map's furniture", () => {
  it("draws shops, teleporters and healing pickups at their HUD sizes, as furniture", () => {
    const ms = markersFrom(furniture);
    const by = (k: string) => ms.find((m) => m.key === k)!;
    expect([by("shop:amber:lane1:1").px, by("shop:amber:lane1:1").z, by("shop:amber:lane1:1").title]).toEqual([36, 3, "Shop (Hidden King)"]);
    expect(by("shop:neutral:lane6:1").title).toBe("Shop");
    expect([by("teleporter:neutral:lane4:1").px, by("teleporter:neutral:lane4:1").z]).toEqual([16, 1]);
    expect([by("heal:neutral:lane4:1").kind, by("heal:neutral:lane4:1").px]).toEqual(["heal", 16]);
    expect(ms.every((m) => isFurniture(m.kind))).toBe(true);
    expect(isFurniture("camp")).toBe(false);
  });

  it("pairs each teleporter with the end it lets out beside", () => {
    const link = Object.fromEntries(markersFrom(furniture).filter((m) => m.kind === "teleporter").map((m) => [m.key, m.link]));
    expect(link).toEqual({
      "teleporter:neutral:lane4:1": "teleporter:neutral:lane6:1",
      "teleporter:neutral:lane6:1": "teleporter:neutral:lane4:1",
      "teleporter:neutral:lane1:1": "teleporter:neutral:lane4:2",
      "teleporter:neutral:lane4:2": "teleporter:neutral:lane1:1",
    });
  });

  it("borrows the built-in map's for a pack without them, and keeps a pack's own", () => {
    // A pack from before 2026-11-09: objectives only.
    const old = withBuiltInFurniture([camp]);
    expect([count(old, "shop"), count(old, "teleporter"), count(old, "heal"), count(old, "camp")]).toEqual([8, 4, 36, 1]);
    // The built-in map's teleporters carry their exits, so they pair too.
    expect(markersFrom(old).filter((m) => m.kind === "teleporter").every((m) => m.link)).toBe(true);
    // A new pack's own are used, and nothing is doubled; a kind it lacks is still borrowed.
    const own = withBuiltInFurniture([camp, ...furniture]);
    expect([count(own, "shop"), count(own, "teleporter"), count(own, "heal")]).toEqual([2, 4, 1]);
    const noHeals = withBuiltInFurniture([camp, ...furniture.filter((e) => e.kind !== "heal")]);
    expect(count(noHeals, "heal")).toBe(36);
    // Without a pack, the schematic map has them too; and a real old manifest gets them.
    const fb = modelFromFallback(FALLBACK).markers;
    expect([count(fb, "shop"), count(fb, "teleporter"), count(fb, "heal")]).toEqual([8, 4, 36]);
    const art = artFromManifest("", "p", { game: { client_version: 6860 }, blobs: {}, entities: [camp] });
    expect(count(art.model.markers, "shop")).toBe(8);
  });
});

describe("healing pickups in Player", () => {
  const key = "heal:neutral:lane4:1";
  const tl = { heals: [{ key, first_s: 150, cleared: [[402, 582]] }], camps: [], objectives: [], mid_boss: [], players: [] } as unknown as Timeline;
  const markers = markersFrom([...furniture]);
  const pv = (t: number) => ({ camps: campsAt(tl, t), down: new Set(), health: undefined }) as unknown as MatchPreview;
  const m = markers.find((x) => x.key === key)!;

  it("is down before it first comes up and while taken, up otherwise", () => {
    expect([100, 200, 450, 600].map((t) => sitesAt(tl, t, markers).get(key))).toEqual(["Destroyed", "Active", "Destroyed", "Active"]);
    expect([100, 200, 450, 600].map((t) => campsAt(tl, t).get(key)?.state)).toEqual(["unspawned", "alive", "cleared", "alive"]);
  });

  it("says when it's back, and nothing while it's up", () => {
    expect(markerTip(m, pv(450), 450)).toBe("Respawns in 2:12");
    expect(markerTip(m, pv(100), 100)).toBe("Spawns in 0:50");
    expect(markerTip(m, pv(200), 200)).toBeUndefined();
  });

  it("shops and teleporters say nothing (the label rule)", () => {
    for (const k of ["shop:amber:lane1:1", "teleporter:neutral:lane4:1"]) expect(markerTip(markers.find((x) => x.key === k)!, pv(450), 450)).toBeUndefined();
  });
});
