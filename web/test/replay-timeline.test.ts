// The replay tier's timeline (crates/replay): ults, rifts, powerups and lane waves at a moment,
// and "Save as scene" writing them all.
import { describe, expect, it } from "vitest";
import { FALLBACK } from "../src/map/fallback-data";
import { modelFromFallback } from "../src/map/model";
import { type Timeline, playersAt, sitesAt, tierOf, wavesAt } from "../src/match/timeline";
import { matchSceneOps } from "../src/match/save";

const markers = modelFromFallback(FALLBACK).markers;
const lanes = modelFromFallback(FALLBACK).lanes.map((l) => l.key);

const replay: Timeline = {
  match_id: 9, start_time: 0, duration_s: 4, source: "replay", tier: "replay", build: 6813, reanchored: 0,
  players: [{ team: "amber", slot: 0, hero_id: 7, name: "Coach", x: [1, 2, 3, null, 5], y: [1, 2, 3, null, 5], health: [100, 100, 100, 0, 100], deaths: [3], souls: [[0, 500]], ult: [null, 100, 50, 25, 0] }],
  objectives: [], mid_boss: [],
  rifts: [{ key: "rift:neutral:lane6:1", start_s: 1, end_s: 3 }],
  powerups: [{ key: "powerup:neutral:lane1:1", available: [0, 1, 1, 0, 0], stale: [] }, { key: "powerup:neutral:lane6:1", available: [1, 1, 1, 1, 1], stale: [[2, 5]] }],
  waves: [{ lane: "lane4", t: [null, 480, 500, 500, 620], stale: [[0, 1], [3, 4]] }],
};

describe("replay timeline", () => {
  it("names its tier", () => {
    expect(tierOf(replay)).toBe("replay");
    const { tier: _, rifts: _r, powerups: _p, waves: _w, ...meta } = replay;
    expect(tierOf(meta)).toBe("metadata");
  });

  it("gives ults, rifts, powerups and waves at t", () => {
    expect(playersAt(replay, 2)[0]!.ult).toBe(50);
    expect(playersAt(replay, 0)[0]!.ult).toBeNull();
    const at = (t: number) => Object.fromEntries(sitesAt(replay, t, markers));
    expect(at(0)).toEqual({ "rift:neutral:lane1:1": "Destroyed", "rift:neutral:lane6:1": "Destroyed", "powerup:neutral:lane1:1": "Destroyed", "powerup:neutral:lane6:1": "Active" });
    expect(at(2)["rift:neutral:lane6:1"]).toBe("Active");
    expect(at(2)["powerup:neutral:lane1:1"]).toBe("Active");
    expect(at(3)["rift:neutral:lane6:1"]).toBe("Destroyed");
    expect(Object.fromEntries(wavesAt(replay, 0))).toEqual({});
    expect(Object.fromEntries(wavesAt(replay, 1))).toEqual({ lane4: { t: 480, stale: false } });
    expect(Object.fromEntries(wavesAt(replay, 3))).toEqual({ lane4: { t: 500, stale: true } });
    // The metadata tier has none of it.
    const { tier: _, rifts: _r, powerups: _p, waves: _w, ...meta } = replay;
    expect(sitesAt(meta, 2, markers).size).toBe(0);
    expect(wavesAt(meta, 2).size).toBe(0);
  });

  it("saves ults, the rift that's up, taken powerups and the splits", () => {
    let n = 0;
    const mint = () => `id${n++}`;
    const roster = [{ id: "slot-a", slot: { team: "Amber" as const, slot: 0, hero: 7, name: "" } }];
    const { ops } = matchSceneOps(roster as never, [], undefined, replay, 2, markers, mint, lanes);
    const records = ops.flatMap((o) => ("Create" in o ? [o.Create.record] : []));
    const player = records.find((r) => "PlayerState" in r) as { PlayerState: { ult_cooldown: number | null } };
    expect(player.PlayerState.ult_cooldown).toBe(50);
    const states = records.flatMap((r) => ("ObjectiveState" in r ? [[r.ObjectiveState.key, r.ObjectiveState.status]] : []));
    // At 2 s the east rift is up and both powerups are available: only the rift differs from a
    // new scene's defaults.
    expect(states).toEqual([["rift:neutral:lane6:1", "Active"]]);
    const waves = records.flatMap((r) => ("Wave" in r ? [r.Wave] : []));
    expect(waves.map((w) => [w.lane, w.t])).toEqual([["lane4", 500]]);
    const later = matchSceneOps(roster as never, [], undefined, replay, 3, markers, mint, lanes).ops.flatMap((o) => ("Create" in o ? [o.Create.record] : []));
    expect(later.flatMap((r) => ("ObjectiveState" in r ? [[r.ObjectiveState.key, r.ObjectiveState.status]] : []))).toEqual([["powerup:neutral:lane1:1", "Destroyed"]]);
  });
});
