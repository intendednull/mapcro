// The map renderer's pure parts: the transform, markers from pack entities, tints and lanes.
// Expected positions are the ones design/parity/README.md and design/shared/minimap-data.js give.

import { describe, expect, it } from "vitest";
import { FALLBACK } from "../src/map/fallback-data";
import { ENEMY, LANE_TINT, OFFWHITE, TEAM_TINT, campTier, laneStroke, lanesFrom, markersFrom, modelFromFallback, washFor, type PackEntity } from "../src/map/model";
import { artCss, artFromManifest, fallbackArt } from "../src/map/pack";
import { clampToMap, mapToWorld, viewToWorld, worldToMap, worldToView } from "../src/map/transform";

const near = (a: { x: number; y: number }, b: { x: number; y: number }, eps = 0.01) => {
  expect(a.x).toBeCloseTo(b.x, -Math.log10(eps));
  expect(a.y).toBeCloseTo(b.y, -Math.log10(eps));
};

// Entities exactly as the extractor wrote them for build 6860 (pack.json schema 2).
const ents: PackEntity[] = [
  { key: "guardian:amber:lane1:1", kind: "guardian", team: "amber", lane: "lane1", world: [-8192, -1856, 248] },
  { key: "guardian:sapphire:lane6:1", kind: "guardian", team: "sapphire", lane: "lane6", world: [8128, 1856, 248] },
  { key: "mid_boss:neutral:lane4:1", kind: "mid_boss", team: "neutral", lane: "lane4", world: [0, 0, -832] },
  { key: "patron:amber:lane3:1", kind: "patron", team: "amber", lane: "lane3", world: [-1280, -8034, 632] },
  { key: "base_guardian:amber:lane4:1", kind: "base_guardian", team: "amber", lane: "lane4", world: [-1488, -5458.68896484375, 640] },
  { key: "base_guardian:amber:lane4:2", kind: "base_guardian", team: "amber", lane: "lane4", world: [-1072, -5454.18994140625, 640] },
  { key: "walker:amber:lane6:1", kind: "walker", team: "amber", lane: "lane6", world: [5628, -5060, 400] },
  { key: "sentry:amber:lane1:1", kind: "sentry", team: "amber", lane: "lane1", world: [-1568, -9424, 1152] },
  {
    key: "camp:neutral:lane1:9",
    kind: "camp",
    team: "neutral",
    lane: "lane1",
    world: [-5920, -1184.000244140625, 264],
    src: { classname: "info_neutral_trooper_camp", hammeruniqueid: "1", targetname: "[PR#]dock_authority_vault" },
  },
];

describe("world → map transform (README: mx = (x + 10752) / 21504 × 1000, my = (10752 − y) / 21504 × 1000)", () => {
  it("puts known entities where the README and the derived minimap data say", () => {
    near(worldToMap({ x: -8192, y: -1856 }), { x: 119.05, y: 586.31 }); // Amber west guardian: 11.905%, 58.631%
    near(worldToMap({ x: 0, y: 0 }), { x: 500, y: 500 }); // mid boss: the centre
    near(worldToMap({ x: -1280, y: -8034 }), { x: 440.48, y: 873.6 }); // Amber patron: 44.048%, 87.36%
    near(worldToMap({ x: 10752, y: 10752 }), { x: 1000, y: 0 }); // Sapphire's corner is top right
  });

  it("round-trips whole world units", () => {
    for (const w of [{ x: -8192, y: -1856 }, { x: 0, y: 0 }, { x: 5628, y: -5060 }, { x: 10752, y: -10752 }]) {
      expect(mapToWorld(worldToMap(w))).toEqual(w);
      expect(viewToWorld(worldToView(w, "sapphire"), "sapphire")).toEqual(w);
    }
  });

  it("turns the Sapphire view 180° about the centre and leaves Amber's as is", () => {
    near(worldToView({ x: -1280, y: -8034 }, "sapphire"), { x: 559.52, y: 126.4 });
    near(worldToView({ x: -1280, y: -8034 }, "amber"), { x: 440.48, y: 873.6 });
    near(worldToView({ x: -1280, y: -8034 }, "neutral"), { x: 440.48, y: 873.6 });
  });

  it("clamps drags to the map square", () => {
    expect(clampToMap({ x: 20000, y: -20000 })).toEqual({ x: 10752, y: -10752 });
  });
});

describe("markers from pack entities", () => {
  const ms = markersFrom(ents);
  const by = (k: string) => ms.find((m) => m.key === k)!;

  it("draws one base guardian per team and lane, at the pair's midpoint", () => {
    const b = by("base_guardian:amber:lane4");
    expect(ms.filter((m) => m.kind === "barracks")).toHaveLength(1);
    near(b.at, { x: 440.48, y: 753.74 }); // minimap-data: 44.048%, 75.374%
    expect(b.px).toBe(40);
  });

  it("sizes markers in HUD px and keeps the HUD's layer order", () => {
    expect([by("guardian:amber:lane1:1").px, by("walker:amber:lane6:1").px, by("patron:amber:lane3:1").px]).toEqual([40, 64, 80]);
    expect(by("mid_boss:neutral:lane4:1").z).toBeLessThan(by("guardian:amber:lane1:1").z);
    expect(by("camp:neutral:lane1:9").z).toBeLessThan(by("mid_boss:neutral:lane4:1").z);
  });

  it("skips kinds the minimap doesn't draw", () => {
    expect(ms.some((m) => m.key.startsWith("sentry"))).toBe(false);
    expect(by("camp:neutral:lane1:9").tier).toBe("vaults");
  });

  it("tints by viewpoint: friendly lane colours, enemy red, neutral team colours", () => {
    const g = by("guardian:amber:lane1:1");
    expect(washFor(g, "amber")).toBe(LANE_TINT.yellow);
    expect(washFor(g, "sapphire")).toBe(ENEMY);
    expect(washFor(g, "neutral")).toBe(TEAM_TINT.amber);
    expect(washFor(by("patron:amber:lane3:1"), "amber")).toBe(OFFWHITE);
    expect(washFor(by("guardian:sapphire:lane6:1"), "sapphire")).toBe(LANE_TINT.purple);
  });

  it("splits lane lines: friendly half in the lane colour, enemy half red", () => {
    expect(laneStroke("blue", "amber", "amber")).toBe(LANE_TINT.blue);
    expect(laneStroke("blue", "sapphire", "amber")).toBe(ENEMY);
    expect(laneStroke("blue", "sapphire", "sapphire")).toBe(LANE_TINT.blue);
    expect(laneStroke("blue", "amber", "neutral")).toBe(TEAM_TINT.amber);
  });
});

describe("lanes", () => {
  it("draws the Lane zipline through its nodes, from the Amber base up", () => {
    const zip: PackEntity = {
      key: "zipline:neutral:lane4:1",
      kind: "zipline",
      team: "neutral",
      lane: "lane4",
      world: [-1280, -10774, 1472],
      src: { classname: "citadel_zipline_path", hammeruniqueid: "1", targetname: "[PR#]8785_Lane4" },
      nodes: [[-1280, -10774, 1472], [-1280, -8000, 1400], [0, 0, 1400]],
    };
    const other = { ...zip, key: "zipline:neutral:lane4:2", src: { ...zip.src!, targetname: "" } };
    const ls = lanesFrom([zip, other]);
    expect(ls).toHaveLength(1);
    expect(ls[0]!.lane).toBe("blue");
    expect(ls[0]!.d.startsWith("M440.5 1001")).toBe(true); // as the design's lane data starts
    expect(ls[0]!.d.endsWith(" 500 500")).toBe(true);
    expect(ls[0]!.d.match(/C/g)).toHaveLength(2);
  });
});

describe("art", () => {
  it("the fallback has every objective and all three lanes, and no images", () => {
    const m = modelFromFallback(FALLBACK);
    const count = (k: string) => m.markers.filter((x) => x.kind === k).length;
    expect([count("t1"), count("t2"), count("t3"), count("shrine"), count("barracks"), count("midboss")]).toEqual([6, 6, 2, 4, 6, 1]);
    expect(m.lanes.map((l) => l.lane).sort()).toEqual(["blue", "purple", "yellow"]);
    // Both powerup spawners, mirrored about the centre (the pack has them at x = ±3936).
    const pu = m.markers.filter((x) => x.kind === "powerup");
    expect(pu.map((x) => x.key).sort()).toEqual(["powerup:neutral:lane1:1", "powerup:neutral:lane6:1"]);
    expect(pu.every((x) => x.px === 20)).toBe(true);
    expect(artCss(fallbackArt())).toBe("");
  });

  it("a pack supplies terrain, icons and portraits by URL, and its entities drive the map", () => {
    const art = artFromManifest("", "abc", {
      game: { client_version: 6860 },
      blobs: {
        "map/minimap_midtown_mid": { sha256: "0", mime: "image/png", file: "map/minimap_midtown_mid.png" },
        "heroes/1": { sha256: "1", mime: "image/png", file: "heroes/1.png" },
      },
      heroes: [{ hero_id: 1, name: "Infernus", minimap_blob: "heroes/1" }, { hero_id: 2, name: "Seven", minimap_blob: null }],
      entities: ents,
    });
    expect(art.version).toBe("6860");
    expect(art.images.get("terrain-mid")).toBe("/packs/abc/map/minimap_midtown_mid.png");
    expect(art.heroes.get(1)?.portrait).toBe("/packs/abc/heroes/1.png");
    expect(art.heroes.get(2)?.portrait).toBeUndefined();
    expect(art.model.markers.some((m) => m.key === "base_guardian:amber:lane4")).toBe(true);
    expect(artCss(art)).toContain('[data-pimg="terrain-mid"] { background-image: url("/packs/abc/map/minimap_midtown_mid.png")');
  });
});

// Camps as the extractor wrote them for build 6860: before 2026-11-09 without a tier, after it
// with the lump's `subclass_name` tier (docs/research/map-objectives-audit.md).
const camp = (key: string, world: number[], name: string, tier?: string): PackEntity => ({
  key,
  kind: "camp",
  team: "neutral",
  lane: key.split(":")[2]!,
  world,
  src: { classname: "info_neutral_trooper_camp", hammeruniqueid: "1", targetname: `[PR#]${name}` },
  ...(tier ? { tier } : {}),
});
/** The five Sinner's Sacrifice camps whose names don't say "vault", where the pack puts them. */
const SINNERS_UNNAMED = [
  camp("camp:neutral:lane4:5", [3248, -1888, 2499], "1380394_chinatown_bell_1"),
  camp("camp:neutral:lane6:14", [4160, 2784, 1008], "theater_balcony_camp"),
  camp("camp:neutral:lane4:1", [-3264, -1600, 564], "slums_garage_up_camp"),
  camp("camp:neutral:lane4:7", [2208, -960, 400], "drug_store_camp"),
  camp("camp:neutral:lane4:12", [-2220, 1024, 392], "hotel_01_camp"),
];
const MID_BOSS: PackEntity = { key: "mid_boss:neutral:lane4:1", kind: "mid_boss", team: "neutral", lane: "lane4", world: [0, 0, -832] };
const MID_CAMP = camp("camp:neutral:lane4:9", [-1.52716064453125, -0.8299026489257812, -832], "mid_neutrals");

describe("camp tiers", () => {
  it("draws every Sinner's Sacrifice camp as a vault, named so, from an older pack too", () => {
    for (const ms of [markersFrom(SINNERS_UNNAMED), markersFrom(SINNERS_UNNAMED.map((e) => ({ ...e, tier: "vaults" })))]) {
      expect(ms.map((m) => m.tier)).toEqual(["vaults", "vaults", "vaults", "vaults", "vaults"]);
      expect(ms.map((m) => m.title)).toEqual(Array(5).fill("Sinner's Sacrifice"));
    }
  });

  it("takes the pack's tier first, then the built-in camp on the same spot, then the name", () => {
    // The pack's own tier wins, even against the built-in map.
    expect(campTier(camp("camp:neutral:lane4:5", [3248, -1888, 2499], "1380394_chinatown_bell_1", "strong"))).toBe("strong");
    // Tier-less: the built-in camp there (weak, strong) whatever the name says.
    expect(campTier(camp("camp:neutral:lane1:10", [-7168, -1280, 264], "dock_authority_camp"))).toBe("weak");
    expect(campTier(camp("camp:neutral:lane6:8", [9184, 0, 256], "park_gate_camp"))).toBe("strong");
    // Off every built-in camp: the name, else medium.
    expect(campTier(camp("camp:neutral:lane1:99", [-9000, 9000, 0], "new_vault"))).toBe("vaults");
    expect(campTier(camp("camp:neutral:lane1:99", [-9000, 9000, 0], "new_camp"))).toBe("medium");
    // An unknown tier string isn't trusted.
    expect(campTier(camp("camp:neutral:lane1:99", [-9000, 9000, 0], "new_camp", "huge"))).toBe("medium");
  });

  it("leaves the mid boss's own camp to the mid boss marker", () => {
    const keys = (es: PackEntity[]) => markersFrom(es).map((m) => m.key);
    expect(keys([MID_BOSS, MID_CAMP])).toEqual(["mid_boss:neutral:lane4:1"]);
    expect(keys([MID_BOSS, { ...MID_CAMP, tier: "midboss" }])).toEqual(["mid_boss:neutral:lane4:1"]);
    // A tiered camp beside the mid boss would still be a camp.
    expect(keys([MID_BOSS, { ...MID_CAMP, tier: "weak" }])).toEqual(["mid_boss:neutral:lane4:1", "camp:neutral:lane4:9"]);
  });

  it("keeps the built-in map's 51 camps at the game's tiers (4 weak, 24 medium, 12 strong, 11 vaults)", () => {
    const tiers = modelFromFallback(FALLBACK).markers.filter((m) => m.kind === "camp").map((m) => m.tier);
    const count = (t: string) => tiers.filter((x) => x === t).length;
    expect([tiers.length, count("weak"), count("medium"), count("strong"), count("vaults")]).toEqual([51, 4, 24, 12, 11]);
  });
});
