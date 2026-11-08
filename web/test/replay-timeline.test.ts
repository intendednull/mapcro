// The replay tier's timeline (crates/replay): ults, rifts, powerups, zipline colours and camps at
// a moment, and "Save as scene" writing them all.
import { describe, expect, it } from "vitest";
import { FALLBACK } from "../src/map/fallback-data";
import { modelFromFallback } from "../src/map/model";
import { type Timeline, campsAt, downAt, lanesAt, markerKey, playersAt, sitesAt, tierOf } from "../src/match/timeline";
import { splitEdges } from "../src/map/lanes";
import { matchSceneOps } from "../src/match/save";

const markers = modelFromFallback(FALLBACK).markers;
const lanes = modelFromFallback(FALLBACK).lanes.map((l) => l.key);

const replay: Timeline = {
  match_id: 9, start_time: 0, duration_s: 4, source: "replay", tier: "replay", build: 6813, reanchored: 0,
  players: [{ team: "amber", slot: 0, hero_id: 7, name: "Coach", x: [1, 2, 3, null, 5], y: [1, 2, 3, null, 5], health: [100, 100, 100, 0, 100], deaths: [3], souls: [[0, 500]], ult: [null, 100, 50, 25, 0] }],
  objectives: [], mid_boss: [],
  rifts: [{ key: "rift:neutral:lane6:1", start_s: 1, end_s: 3 }],
  powerups: [{ key: "powerup:neutral:lane1:1", available: [0, 1, 1, 0, 0], stale: [] }, { key: "powerup:neutral:lane6:1", available: [1, 1, 1, 1, 1], stale: [[2, 5]] }],
  zips: [{ lane: "lane4", at: [[0, 425, 574], [2, 480, 520], [4, 300, 300]] }],
  camps: [
    { key: "camp:neutral:lane0:3", first_s: 1, cleared: [[2, 4]] },
    { key: "mid_boss:neutral:lane0:1", first_s: 0, cleared: [[3, 400]] },
  ],
};

describe("replay timeline", () => {
  it("names its tier", () => {
    expect(tierOf(replay)).toBe("replay");
    const { tier: _, rifts: _r, powerups: _p, zips: _z, camps: _c, ...meta } = replay;
    expect(tierOf(meta)).toBe("metadata");
  });

  it("gives ults, rifts, powerups, zipline colours and camps at t", () => {
    expect(playersAt(replay, 2)[0]!.ult).toBe(50);
    expect(playersAt(replay, 0)[0]!.ult).toBeNull();
    const at = (t: number) => Object.fromEntries(sitesAt(replay, t, markers));
    expect(at(0)).toEqual({ "rift:neutral:lane1:1": "Destroyed", "rift:neutral:lane6:1": "Destroyed", "powerup:neutral:lane1:1": "Destroyed", "powerup:neutral:lane6:1": "Active", "camp:neutral:lane0:3": "Destroyed" });
    expect(at(2)["rift:neutral:lane6:1"]).toBe("Active");
    expect(at(2)["powerup:neutral:lane1:1"]).toBe("Active");
    expect(at(3)["rift:neutral:lane6:1"]).toBe("Destroyed");
    expect(at(1)["camp:neutral:lane0:3"]).toBe("Active");
    expect(at(2)["camp:neutral:lane0:3"]).toBe("Destroyed");
    expect(at(4)["camp:neutral:lane0:3"]).toBe("Active");
    expect(Object.fromEntries(lanesAt(replay, 0))).toEqual({ lane4: { amber: 425, sapphire: 574 } });
    expect(Object.fromEntries(lanesAt(replay, 3.9))).toEqual({ lane4: { amber: 480, sapphire: 520 } });
    expect(Object.fromEntries(campsAt(replay, 0))).toEqual({ "camp:neutral:lane0:3": { state: "unspawned", at: 1 }, "mid_boss:neutral:lane0:1": { state: "alive" } });
    expect(campsAt(replay, 3).get("camp:neutral:lane0:3")).toEqual({ state: "cleared", at: 4 });
    // The mid boss is down from its clear to its respawn (from the camp timer, not the kills).
    expect(downAt(replay, 2, markers).has("mid_boss:neutral:lane0:1")).toBe(false);
    expect(downAt(replay, 3, markers).has("mid_boss:neutral:lane0:1")).toBe(true);
    // The metadata tier has none of it.
    const { tier: _, rifts: _r, powerups: _p, zips: _z, camps: _c, ...meta } = replay;
    expect(sitesAt(meta, 2, markers).size).toBe(0);
    expect(lanesAt(meta, 2).size).toBe(0);
  });

  it("colours a lane from each end to its edge and leaves the gap", () => {
    const l = modelFromFallback(FALLBACK).lanes.find((x) => x.key === "lane4")!.line;
    const len = (pts: Array<{ x: number; y: number }>) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y), 0);
    const tot = l.cum[l.cum.length - 1]!;
    const h = splitEdges(l, 300, 700, 12);
    expect(len(h.amber) / tot).toBeCloseTo(0.3, 2);
    expect(len(h.sapphire) / tot).toBeCloseTo(0.3, 2);
    // Edges that touch still leave the gap, centred on them; one team owning nothing draws none.
    const touch = splitEdges(l, 500, 500, 12);
    expect(len(touch.amber)).toBeCloseTo(tot / 2 - 6, 0);
    expect(splitEdges(l, 0, 1000, 12).amber).toEqual([]);
    expect(splitEdges(l, 0, 1000, 12).sapphire).toEqual([]);
  });

  it("finds the board's marker for a key the pack spells differently", () => {
    // A pack keys the patron by Valve's lane and camps by their lane (~/.local/share/mapcro/packs).
    const pack = markers.map((m) =>
      m.kind === "t3" ? { ...m, key: m.key.replace("lane0", "lane3") } : m.kind === "camp" ? { ...m, key: `camp:neutral:lane6:${m.key.split(":")[3]}x` } : m.kind === "midboss" ? { ...m, key: "mid_boss:neutral:lane4:1" } : m,
    );
    expect(markerKey("patron:sapphire:lane0:1", pack)).toBe("patron:sapphire:lane3:1");
    expect(markerKey("patron:sapphire:lane3:1", markers)).toBe("patron:sapphire:lane0:1");
    expect(markerKey("mid_boss:neutral:lane0:1", pack)).toBe("mid_boss:neutral:lane4:1");
    expect(markerKey("camp:neutral:lane0:3", pack)).toBe("camp:neutral:lane6:3x");
    expect(markerKey("walker:amber:lane1:1", pack)).toBe("walker:amber:lane1:1");
    expect(markerKey("camp:neutral:lane0:99", pack)).toBeUndefined();
    // The metadata tier's patron is down on a fallback board, and the replay's on a pack board.
    const { tier: _t, camps: _c, ...rest } = replay;
    const meta: Timeline = { ...rest, objectives: [{ key: "patron:sapphire:lane3:1", kind: "patron", team: "sapphire", lane: 3, destroyed_s: 2 }] };
    expect(downAt(meta, 2, markers).has("patron:sapphire:lane0:1")).toBe(true);
    const rep: Timeline = { ...replay, objectives: [{ key: "patron:sapphire:lane0:1", kind: "patron", team: "sapphire", lane: 0, destroyed_s: 2 }] };
    expect(downAt(rep, 2, pack).has("patron:sapphire:lane3:1")).toBe(true);
    expect(sitesAt(replay, 2, pack).get("camp:neutral:lane6:3x")).toBe("Destroyed");
  });

  it("saves ults, the rift that's up, taken powerups, cleared camps and the splits", () => {
    let n = 0;
    const mint = () => `id${n++}`;
    const roster = [{ id: "slot-a", slot: { team: "Amber" as const, slot: 0, hero: 7, name: "" } }];
    const { ops } = matchSceneOps(roster as never, [], undefined, replay, 2, markers, mint, lanes);
    const records = ops.flatMap((o) => ("Create" in o ? [o.Create.record] : []));
    const player = records.find((r) => "PlayerState" in r) as { PlayerState: { ult_cooldown: number | null } };
    expect(player.PlayerState.ult_cooldown).toBe(50);
    const states = records.flatMap((r) => ("ObjectiveState" in r ? [[r.ObjectiveState.key, r.ObjectiveState.status]] : []));
    // At 2 s the east rift is up, both powerups are available and camp 3 is cleared: the rift
    // and the camp differ from a new scene's defaults.
    expect(states).toEqual([["rift:neutral:lane6:1", "Active"], ["camp:neutral:lane0:3", "Destroyed"]]);
    // A scene has one split per lane: the middle of the zipline colours' gap.
    const waves = records.flatMap((r) => ("Wave" in r ? [r.Wave] : []));
    expect(waves.map((w) => [w.lane, w.t])).toEqual([["lane4", 500]]);
    const later = matchSceneOps(roster as never, [], undefined, replay, 3, markers, mint, lanes).ops.flatMap((o) => ("Create" in o ? [o.Create.record] : []));
    expect(later.flatMap((r) => ("ObjectiveState" in r ? [[r.ObjectiveState.key, r.ObjectiveState.status]] : []))).toEqual([
      ["mid_boss:neutral:lane0:1", "Destroyed"],
      ["powerup:neutral:lane1:1", "Destroyed"],
      ["camp:neutral:lane0:3", "Destroyed"],
    ]);
  });
});
