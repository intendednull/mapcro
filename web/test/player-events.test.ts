// Player's events: labels, search across hero, player name, type, team and time, the jump time,
// where it happened, and scene names.
import { describe, expect, it } from "vitest";
import { FALLBACK } from "../src/map/fallback-data";
import { modelFromFallback } from "../src/map/model";
import type { MatchEvent, Timeline } from "../src/match/timeline";
import { groupOf, jumpTime, label, namesFor, placeOf, search, shortLabel } from "../src/player/events";
import { sceneName } from "../src/match/save";

const tl = {
  match_id: 1, start_time: 0, duration_s: 900, source: "", reanchored: 0, objectives: [], mid_boss: [],
  players: [
    { team: "amber", slot: 0, hero_id: 1, name: "Coach", x: [], y: [], health: [], deaths: [], souls: [] },
    { team: "sapphire", slot: 2, hero_id: 2, x: [], y: [], health: [], deaths: [], souls: [] },
  ],
} as Timeline;
const n = namesFor(tl, (id) => ({ 1: "Infernus", 2: "Haze" })[id] ?? `Hero ${id}`);
const ev: MatchEvent[] = [
  { t: 125, kind: "death", team: "amber", slot: 0, hero_id: 1, by: { team: "sapphire", slot: 2, hero_id: 2 }, x: 100, y: -200 },
  { t: 300, kind: "objective", team: "sapphire", key: "walker:sapphire:lane6:1" },
  { t: 410, kind: "rift_capture", team: "amber", key: "rift:neutral:lane1:1" },
  { t: 500, kind: "powerup_taken", key: "powerup:neutral:lane6:1" },
  { t: 600, kind: "souls_swing", team: "amber", amount: 12400 },
  { t: 700, kind: "mid_boss", team: "unknown" },
  { t: 800, kind: "ult", team: "sapphire", slot: 2, hero_id: 2, ability: "citadel_ability_haze_bullet_dance" },
];

describe("player events", () => {
  it("labels each kind", () => {
    expect(ev.map((e) => label(e, n))).toEqual([
      "Infernus killed by Haze",
      "Sapphire walker down (east)",
      "Rift captured by Amber",
      "Powerup taken (east)",
      "Souls swing Amber +12.4k",
      "Mid boss killed",
      "Haze ult (bullet dance)",
    ]);
    expect(ev.map(groupOf)).toEqual(["death", "objective", "rift", "powerup", "souls", "mid_boss", "ult"]);
  });

  it("searches hero, player name, type, team and time, within the chips", () => {
    const ts = (q: string, on: string[] = []) => search(ev, n, q, new Set(on as never)).map((e) => e.t);
    expect(ts("haze")).toEqual([125, 800]);
    expect(ts("bullet dance")).toEqual([800]);
    expect(ts("coach")).toEqual([125]);
    expect(ts("walker east")).toEqual([300]);
    expect(ts("amber")).toEqual([125, 410, 600]);
    expect(ts("2:05")).toEqual([125]);
    expect(ts("", ["rift", "powerup"])).toEqual([410, 500]);
    expect(ts("amber", ["souls"])).toEqual([600]);
  });

  it("jumps a lead before, finds the place, and names scenes within 24 characters", () => {
    expect(jumpTime(ev[0]!, 5)).toBe(120);
    expect(jumpTime({ t: 3 }, 5)).toBe(0);
    const markers = modelFromFallback(FALLBACK).markers;
    expect(placeOf(ev[0]!, markers)).toEqual({ x: (100 + 10752) / 21504 * 1000, y: (10752 + 200) / 21504 * 1000 });
    expect(placeOf(ev[1]!, markers)).toEqual(markers.find((m) => m.key === "walker:sapphire:lane6:1")!.at);
    expect(sceneName(shortLabel(ev[0]!, n), 120)).toBe("Infernus died @ 2:00");
    expect(sceneName("A very long hero name died", 1234)).toBe("A very long her… @ 20:34");
    expect(sceneName("A very long hero name died", 1234).length).toBe(24);
  });
});

import { matchSceneOps, matchScenesOps, sourceOf } from "../src/match/save";
import { clearAnnotationsOps, liveSceneOps, takeAnnotationsOps } from "../src/player/live";

describe("player scenes", () => {
  const roster = [0, 1].map((i) => ({ id: `slot${i}`, slot: { team: "Amber" as const, slot: i, hero: 1, name: "" } }));
  const timeline = { ...tl, duration_s: 900, tier: "replay" as const };

  it("store their source, and several are one transaction in order", () => {
    let n = 0;
    const mint = () => `id${n++}`;
    const one = matchSceneOps(roster as never, [], undefined, timeline, 125.6, [], mint, [], { source: sourceOf(timeline) });
    expect(one.ops[0]).toMatchObject({ Create: { record: { Scene: { clock: 125, source: { match_id: 1, t: 125, tier: "replay" } } } } });
    const many = matchScenesOps(roster as never, [], undefined, timeline, [{ t: 10, name: "A" }, { t: 20, name: "B" }], [], mint);
    const scenes = many.ops.flatMap((o) => ("Create" in o && "Scene" in o.Create.record ? [o.Create.record.Scene] : []));
    expect(scenes.map((s) => s.name)).toEqual(["A @ 0:10", "B @ 0:20"]);
    expect(scenes[0]!.order < scenes[1]!.order).toBe(true);
    expect(scenes.every((s) => s.source?.tier === "replay")).toBe(true);
  });

  it("the live layer is a hidden scene; saving moves its ink, clearing deletes it", () => {
    let n = 0;
    const mint = () => `id${n++}`;
    const live = liveSceneOps(roster as never, [], mint);
    expect(live.ops[0]).toMatchObject({ Create: { record: { Scene: { live: true } } } });
    expect(live.ops.filter((o) => "Create" in o && "PlayerState" in o.Create.record)).toHaveLength(2);
    const rows = (kind: string) => (kind === "Stroke" ? [["s1", { Stroke: { scene: live.id, points: [], color: 1, width: 3 } }] as const] : []);
    const moved = takeAnnotationsOps(rows as never, live.id, "scene9", mint);
    expect(moved).toEqual([{ Create: { id: expect.any(String), record: { Stroke: { scene: "scene9", points: [], color: 1, width: 3 } } } }, { Delete: { id: "s1" } }]);
    expect(clearAnnotationsOps(rows as never, live.id)).toEqual([{ Delete: { id: "s1" } }]);
  });
});
