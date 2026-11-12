// The timers a replay has beyond the camps (timers audit, gaps 1, 2 and 7): the Rejuvenator a team
// holds (its revives and countdown, on the mid boss's label and its events), an open rift's
// capture progress and give-up deadline, and the urn walking back after lying 180 s.
import { describe, expect, it } from "vitest";
import { FALLBACK } from "../src/map/fallback-data";
import { modelFromFallback } from "../src/map/model";
import { type Timeline, captureAt, campsAt, rejuvAt, riftAt, urnAt } from "../src/match/timeline";
import { centreTimer, markerTip, rejuvTip, respawnTip, riftTip, urnItemTip } from "../src/player/Camps";
import { groupOf, label, labelParts, namesFor, shortLabel } from "../src/player/events";
import type { MatchPreview } from "../src/match/preview";

const markers = modelFromFallback(FALLBACK).markers;
const WEST = "rift:neutral:lane1:1";
const MID = "mid_boss:neutral:lane0";

// 129738985's first rift and Sapphire's Rejuvenator, shortened.
const tl: Timeline = {
  match_id: 9, start_time: 0, duration_s: 3000, source: "replay", tier: "replay", build: 6839, reanchored: 0,
  players: [], objectives: [], mid_boss: [],
  rifts: [{ key: WEST, start_s: 655, end_s: 783, live_s: 736, give_up_s: 795, capture: [[7360, 5, 2], [7400, 20, 30], [7600, 20, 30], [7700, 60, 100], [7825, 60, 100]] }],
  rejuv: [
    { team: "sapphire", taken_s: 1872, ends_s: 2052, left: [[1872, 3], [1927, 2], [1952, 1]] },
    { team: "amber", taken_s: 2394, ends_s: 2574, left: [[2394, 2], [2395, 3]] },
  ],
  camps: [{ key: MID, first_s: 0, cleared: [[1865, 2285]] }],
};

describe("rift capture", () => {
  it("is the straight line between samples, holds through a flat run, and names its capturer", () => {
    const r = tl.rifts![0]!;
    expect(captureAt(r, 735.9)).toBeNull();
    expect(captureAt(r, 738)).toEqual({ amber: 12.5, sapphire: 16, captured: null });
    expect(captureAt(r, 750)).toEqual({ amber: 20, sapphire: 30, captured: null });
    expect(captureAt(r, 765)).toEqual({ amber: 40, sapphire: 65, captured: null });
    expect(captureAt(r, 770)).toEqual({ amber: 60, sapphire: 100, captured: "sapphire" });
    // After the last sample it holds.
    expect(captureAt(r, 790)).toEqual({ amber: 60, sapphire: 100, captured: "sapphire" });
    expect(captureAt({ capture: [] }, 750)).toBeNull();
    expect(captureAt({}, 750)).toBeNull();
  });

  it("an open rift says when it gives up, until it's captured", () => {
    const tip = (t: number) => riftTip(riftAt(tl, WEST, t, markers)!, WEST, t);
    expect(tip(754)).toBe("Fades in 0:41");
    expect(tip(754.2)).toBe("Fades in 0:41");
    expect(tip(770)).toBe("Captured by Archmother");
    // Without a deadline (before format 3), as before.
    const old: Timeline = { ...tl, rifts: [{ key: WEST, start_s: 655, end_s: 783, live_s: 736 }] };
    expect(riftTip(riftAt(old, WEST, 754, markers)!, WEST, 754)).toBeUndefined();
  });
});

describe("Rejuvenator", () => {
  it("is held from its pickup to its end, with the revives the game counts", () => {
    expect(rejuvAt(tl, 1871.9)).toEqual([]);
    expect(rejuvAt(tl, 1872)).toEqual([{ team: "sapphire", left: 3, ends: 2052 }]);
    expect(rejuvAt(tl, 1952.5)).toEqual([{ team: "sapphire", left: 1, ends: 2052 }]);
    expect(rejuvAt(tl, 2052)).toEqual([]);
    expect(rejuvAt(tl, 2394.5)).toEqual([{ team: "amber", left: 2, ends: 2574 }]);
    expect(rejuvAt({}, 2000)).toEqual([]);
  });

  it("the timer's hover counts down to its end, rounding the seconds up", () => {
    expect(rejuvTip({ team: "sapphire", left: 2, ends: 2052 }, 1952)).toBe("Archmother Rejuvenator ends in 1:40");
    expect(rejuvTip({ team: "sapphire", left: 2, ends: 2052 }, 1951.2)).toBe("Archmother Rejuvenator ends in 1:41");
    expect(rejuvTip({ team: "amber", left: 1, ends: 2574 }, 2573.5)).toBe("Hidden King Rejuvenator ends in 0:01");
    expect(rejuvTip({ team: "amber", left: 0, ends: 2574 }, 2580)).toBe("Hidden King Rejuvenator ends in 0:00");
  });

  it("the mid boss's label is its respawn or health alone, never the Rejuvenator (feedback #44)", () => {
    const boss = markers.find((m) => m.kind === "midboss")!;
    const pv = (t: number): MatchPreview => ({ players: new Map(), down: new Set(), sites: new Map(), lanes: new Map(), camps: new Map([[boss.key, campsAt(tl, t).get(MID)!]]), rejuv: rejuvAt(tl, t) });
    expect(pv(1952).rejuv).toHaveLength(1);
    expect(markerTip(boss, pv(1952), 1952)).toBe("Respawns in 5:33");
    expect(markerTip(boss, pv(2100), 2100)).toBe("Respawns in 3:05");
    // Up, with a Rejuvenator held: nothing (no health known here), or its health.
    expect(pv(2400).rejuv).toHaveLength(1);
    expect(markerTip(boss, { ...pv(2400), camps: new Map() }, 2400)).toBeUndefined();
    expect(markerTip(boss, { ...pv(2400), camps: new Map(), health: new Map([[boss.key, { pct: 45 }]]) } as MatchPreview, 2400)).toBe("Mid-Boss 45%");
    expect(markerTip(boss, { ...pv(2600), camps: new Map() }, 2600)).toBeUndefined();
  });

  it("the centre timer: a held Rejuvenator's, else the Mid-Boss's respawn while it's dead, else none", () => {
    const boss = (t: number) => campsAt(tl, t).get(MID);
    // Held (Sapphire's, from 1872), the boss dead: the Rejuvenator's.
    expect(centreTimer(rejuvAt(tl, 1952), boss(1952))).toEqual({ kind: "rejuv" });
    // Expired at 2052, the boss still dead until 2285: its respawn.
    expect(rejuvAt(tl, 2100)).toEqual([]);
    expect(centreTimer(rejuvAt(tl, 2100), boss(2100))).toEqual({ kind: "respawn", at: 2285 });
    // Up again, nothing held: none.
    expect(centreTimer([], boss(2300))).toEqual({ kind: "none" });
    // Held with no revives left counts as none held.
    expect(centreTimer([{ team: "amber", left: 0, ends: 2574 }], boss(2100))).toEqual({ kind: "respawn", at: 2285 });
    // Held while the boss is up: the Rejuvenator's.
    expect(centreTimer(rejuvAt(tl, 2400), boss(2400))).toEqual({ kind: "rejuv" });
    // Before its first spawn, or no camps (the API summary): none.
    expect(centreTimer([], { state: "unspawned", at: 600 })).toEqual({ kind: "none" });
    expect(centreTimer([], undefined)).toEqual({ kind: "none" });
    expect(respawnTip(2285, 2100)).toBe("Mid-Boss respawns in 3:05");
  });

  it("its events are the mid boss's, and name the revived hero", () => {
    const n = namesFor(tl, (id) => (id === 13 ? "Haze" : `#${id}`), (team, slot) => (team === "sapphire" && slot === 4 ? "Coach" : undefined));
    const taken = { t: 1872, kind: "rejuv_taken" as const, team: "sapphire" };
    const revive = { t: 1930, kind: "rejuv_revive" as const, team: "sapphire", slot: 4, hero_id: 13 };
    const expired = { t: 2052, kind: "rejuv_expired" as const, team: "sapphire" };
    expect([taken, revive, expired].map((e) => groupOf(e))).toEqual(["mid_boss", "mid_boss", "mid_boss"]);
    expect(label(taken, n)).toBe("Rejuvenator taken by Archmother");
    expect(label(revive, n)).toBe("Haze revived by the Rejuvenator");
    expect(label({ ...revive, hero_id: null }, n)).toBe("Archmother revived by the Rejuvenator");
    expect(label(expired, n)).toBe("Archmother Rejuvenator expired");
    expect(labelParts(revive, n)).toEqual([{ text: "Haze revived by the Rejuvenator" }, { text: " Coach", muted: true }]);
    expect([taken, revive, expired].map((e) => shortLabel(e, n))).toEqual(["Rejuvenator taken", "Haze revived", "Rejuvenator expired"]);
  });
});

describe("urn walking back", () => {
  // 129738985's 25:00 urn, shortened: it falls (no point open), lands at 1512, walks off 180 s
  // later; then another is dropped at 1854, picked up, dropped again at 1857.
  const urn: Timeline = {
    ...tl,
    urn: {
      spawns: [{ t: 1500, key: "urn:neutral:lane6:1" }],
      at: [
        { t: 1500, state: "ground", x: 6304, y: -96 },
        { t: 1512, state: "ground", x: 6304, y: -96, delivery: "urn:neutral:lane1:1" },
        { t: 1693, state: "ground", x: 6244, y: -70, delivery: "urn:neutral:lane1:1" },
        { t: 1694, state: "ground", x: 6187, y: -42, delivery: "urn:neutral:lane1:1" },
        { t: 1708, state: "carried", team: "sapphire", slot: 0, delivery: "urn:neutral:lane1:1" },
        { t: 1757, state: "none" },
        { t: 1800, state: "ground", x: -6584, y: 0 },
        { t: 1812, state: "ground", x: -6584, y: 0, delivery: "urn:neutral:lane6:1" },
        { t: 1818, state: "carried", team: "amber", slot: 1, delivery: "urn:neutral:lane6:1" },
        { t: 1854, state: "ground", x: 4267, y: -3082, team: "amber", delivery: "urn:neutral:lane6:1" },
        { t: 1856, state: "carried", team: "amber", slot: 1, delivery: "urn:neutral:lane6:1" },
        { t: 1857, state: "ground", x: 4222, y: -3220, team: "amber", delivery: "urn:neutral:lane6:1" },
      ],
    },
  };
  const tip = (t: number) => urnItemTip(urnAt(urn, t)!, t);

  it("counts 180 s from when it settles: landed, or dropped (each drop starts again)", () => {
    expect(tip(1505)).toBe("Urn");
    expect(urnAt(urn, 1600)!.returns).toBe(1692);
    expect(tip(1600)).toBe("Urn returns in 1:32");
    // Walking: it keeps the time it set off, not each new place.
    expect(tip(1693.5)).toBe("Urn returning");
    expect(urnAt(urn, 1700)!.returns).toBe(1692);
    expect(tip(1720)).toBe("Urn");
    // The next urn, still falling: nothing carried over from the last.
    expect(tip(1805)).toBe("Urn");
    expect(urnAt(urn, 1805)!.returns).toBeNull();
    expect(urnAt(urn, 1854.5)!.returns).toBe(1854 + 180);
    expect(urnAt(urn, 1860)!.returns).toBe(1857 + 180);
    expect(tip(1860)).toBe("Urn returns in 2:57");
    expect(urnAt(urn, 1760)!.returns).toBeUndefined();
  });
});
