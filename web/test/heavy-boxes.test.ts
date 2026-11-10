// The heavy boxes (the map's tough crates): furniture behind their own toggle, borrowed from the
// built-in map by a pack without them, and in Player down while broken, timed like a camp.

import { describe, expect, it } from "vitest";
import { FALLBACK } from "../src/map/fallback-data";
import { isFurniture, markersFrom, modelFromFallback, optionalShown, withBuiltInFurniture, type PackEntity } from "../src/map/model";
import { artFromManifest } from "../src/map/pack";
import { type Timeline, campsAt, sitesAt } from "../src/match/timeline";
import { markerTip } from "../src/player/Camps";
import type { MatchPreview } from "../src/match/preview";

// As the extractor writes one (129738985's lane4:3 broke at 181, back at 361).
const crate: PackEntity = { key: "tough_crate:neutral:lane4:3", kind: "tough_crate", team: "neutral", lane: "lane4", world: [3480, 1112, 320] };
const heal: PackEntity = { key: "heal:neutral:lane4:1", kind: "heal", team: "neutral", lane: "lane4", world: [1792, -1152, 1112] };
const camp: PackEntity = { key: "camp:neutral:lane1:9", kind: "camp", team: "neutral", lane: "lane1", world: [-5920, -1184, 264], tier: "medium" };
const count = (es: Array<{ kind: string }>, kind: string) => es.filter((e) => e.kind === kind).length;

describe("heavy boxes on the map", () => {
  it("are small furniture markers of their own kind", () => {
    const [m] = markersFrom([crate]);
    expect([m!.kind, m!.px, m!.z, m!.title, m!.key]).toEqual(["crate", 10, 1, "Heavy box", crate.key]);
    expect(isFurniture("crate")).toBe(true);
  });

  it("are drawn only with their own toggle, apart from the heals'", () => {
    expect([optionalShown("crate", {}), optionalShown("crate", { heals: true }), optionalShown("crate", { crates: true })]).toEqual([false, false, true]);
    expect([optionalShown("heal", { crates: true }), optionalShown("heal", { heals: true })]).toEqual([false, true]);
    expect([optionalShown("camp", {}), optionalShown("shop", {})]).toEqual([true, true]);
  });

  it("come from the built-in map for a pack without them, and a pack's own are kept", () => {
    expect(count(withBuiltInFurniture([camp]), "tough_crate")).toBe(78);
    // A pack from the Heals' day: heals of its own, no crates.
    const heals = withBuiltInFurniture([camp, heal]);
    expect([count(heals, "heal"), count(heals, "tough_crate")]).toEqual([1, 78]);
    expect(count(withBuiltInFurniture([camp, crate]), "tough_crate")).toBe(1);
    expect(count(modelFromFallback(FALLBACK).markers, "crate")).toBe(78);
    const art = artFromManifest("", "p", { game: { client_version: 6860 }, blobs: {}, entities: [camp, heal] });
    expect(count(art.model.markers, "crate")).toBe(78);
  });
});

describe("heavy boxes in Player", () => {
  const key = crate.key;
  const tl = { crates: [{ key, first_s: 180, cleared: [[181, 361]] }], camps: [], objectives: [], mid_boss: [], players: [] } as unknown as Timeline;
  const markers = markersFrom([crate]);
  const m = markers[0]!;
  const pv = (t: number) => ({ camps: campsAt(tl, t), down: new Set(), health: undefined }) as unknown as MatchPreview;

  it("is down before its spawn group comes up and while broken, up otherwise", () => {
    expect([100, 180, 200, 361].map((t) => sitesAt(tl, t, markers).get(key))).toEqual(["Destroyed", "Active", "Destroyed", "Active"]);
  });

  it("says when it's back, and nothing while it's up", () => {
    expect(markerTip(m, pv(200), 200)).toBe("Respawns in 2:41");
    expect(markerTip(m, pv(100), 100)).toBe("Spawns in 1:20");
    expect(markerTip(m, pv(400), 400)).toBeUndefined();
  });

  it("finds the crate by place when a pack keys it differently", () => {
    // The worker keys by the built-in map; a later pack's ordinals can shift.
    const site = FALLBACK.entities.find((e) => e.key === key)!;
    const moved = markersFrom([{ ...crate, key: "tough_crate:neutral:lane4:9", world: site.world }]);
    expect(sitesAt(tl, 200, moved).get("tough_crate:neutral:lane4:9")).toBe("Destroyed");
  });

  it("a timeline from before format 7 leaves them alone", () => {
    const old = { camps: [], objectives: [], mid_boss: [], players: [] } as unknown as Timeline;
    expect(sitesAt(old, 200, markers).get(key)).toBeUndefined();
  });
});
