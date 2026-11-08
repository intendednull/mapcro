// Match timelines: interpolation, deaths, souls and objectives at a moment, key mapping.
import { describe, expect, it } from "vitest";
import { FALLBACK } from "../src/map/fallback-data";
import { modelFromFallback } from "../src/map/model";
import { type Timeline, clockLabel, downAt, lastSeen, playersAt, positionAt, soulsAt } from "../src/match/timeline";

const p = { x: [0, 10, null, null, 40], y: [0, -10, null, null, -40], souls: [[180, 1788], [360, 4000]] as Array<[number, number]> };

describe("match timeline", () => {
  it("interpolates between alive samples and hides the dead", () => {
    expect(positionAt(p, 0)).toEqual({ x: 0, y: 0 });
    expect(positionAt(p, 0.5)).toEqual({ x: 5, y: -5 });
    expect(positionAt(p, 1.5)).toEqual({ x: 10, y: -10 }); // the next sample is dead: hold
    expect(positionAt(p, 2)).toBeNull();
    expect(positionAt(p, 99)).toEqual({ x: 40, y: -40 });
    expect(lastSeen(p, 3)).toEqual({ x: 10, y: -10 });
  });
  it("takes souls from the nearest sample at or before t", () => {
    expect(soulsAt(p, 100)).toBeNull();
    expect(soulsAt(p, 180)).toBe(1788);
    expect(soulsAt(p, 359)).toBe(1788);
    expect(soulsAt(p, 2000)).toBe(4000);
  });
  it("downs objectives at their destroy time, by board key, and the mid boss until it's killed again", () => {
    const markers = modelFromFallback(FALLBACK).markers;
    const tl: Timeline = {
      match_id: 1, start_time: 0, duration_s: 900, source: "deadlock-api.com", players: [], reanchored: 0,
      objectives: [
        { key: "walker:amber:lane1:1", kind: "walker", team: "amber", lane: 1, destroyed_s: 300 },
        { key: "base_guardian:sapphire:lane6", kind: "base_guardian", team: "sapphire", lane: 6, destroyed_s: 400 },
        { key: "patron:amber:lane3:1", kind: "patron", team: "amber", lane: 3, destroyed_s: 800 },
      ],
      mid_boss: [{ destroyed_s: 500, team_killed: "amber" }, { destroyed_s: 700, team_killed: "sapphire" }],
    };
    expect([...downAt(tl, 299, markers)]).toEqual([]);
    expect([...downAt(tl, 300, markers)]).toEqual(["walker:amber:lane1:1"]);
    // The fallback's base guardian key has an index; matched by kind, team and lane instead.
    expect(downAt(tl, 450, markers).has("base_guardian:sapphire:lane6")).toBe(true);
    const mid = markers.find((m) => m.kind === "midboss")!.key;
    expect(downAt(tl, 500, markers).has(mid)).toBe(true);
    expect(downAt(tl, 699, markers).has(mid)).toBe(true);
    expect(downAt(tl, 800, markers).has(mid)).toBe(true);
    expect(downAt(tl, 800, markers).has("patron:amber:lane0:1")).toBe(true); // fallback patron key
  });
  it("gives each player's state at t", () => {
    const tl: Timeline = {
      match_id: 1, start_time: 0, duration_s: 4, source: "", objectives: [], mid_boss: [], reanchored: 0,
      players: [{ team: "amber", slot: 2, hero_id: 7, x: p.x, y: p.y, health: [100, 100, 0, 0, 100], deaths: [1], souls: p.souls }],
    };
    expect(playersAt(tl, 3)).toEqual([{ team: "amber", slot: 2, hero_id: 7, pos: null, last: { x: 10, y: -10 }, souls: null, ult: null, health: null }]);
    expect(clockLabel(725)).toBe("12:05");
  });
});
