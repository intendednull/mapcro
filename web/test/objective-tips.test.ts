// What a hovered objective says (spec §6b): rifts, the bridge buffs, camps and the mid boss, as
// "Respawns in m:ss" while down and nothing while up (operator 2026-11-08: labels only for
// timers and news), from the replay's own times; and the powerup events naming their buff.
import { describe, expect, it } from "vitest";
import { FALLBACK } from "../src/map/fallback-data";
import { modelFromFallback } from "../src/map/model";
import { type Timeline, campAt, powerupAt, riftAt } from "../src/match/timeline";
import { campTip, markerTip, powerupTip, riftTip } from "../src/player/Camps";
import { label, namesFor, shortLabel } from "../src/player/events";
import { hoverFromWire, hoverWire } from "../src/map/HoverLabel";

const markers = modelFromFallback(FALLBACK).markers;
const WEST = "rift:neutral:lane1:1";
const EAST = "rift:neutral:lane6:1";

const tl: Timeline = {
  match_id: 9, start_time: 0, duration_s: 700, source: "replay", tier: "replay", build: 6839, reanchored: 0,
  players: [], objectives: [], mid_boss: [],
  // Announced at 100, open from 180 to 230 (west); then east, announced 500, open 580.
  rifts: [
    { key: WEST, start_s: 100, end_s: 230, live_s: 180 },
    { key: EAST, start_s: 500, end_s: 640, live_s: 580 },
  ],
  powerups: [],
};

describe("objective tips", () => {
  it("a rift spawns when its cash-in opens, here or at the other site", () => {
    const at = (key: string, t: number) => riftTip(riftAt(tl, key, t, markers)!, key, t);
    expect(at(WEST, 10)).toBe("Rift opens in 2:50");
    expect(at(EAST, 10)).toBe("Rift opens at the other site in 2:50");
    // Announced, not open yet: still counting down.
    expect(at(WEST, 150)).toBe("Rift opens in 0:30");
    // Open with no deadline in the data, or open elsewhere: nothing timed to say.
    expect(at(WEST, 200)).toBeUndefined();
    expect(at(EAST, 200)).toBeUndefined();
    expect(at(EAST, 230)).toBe("Rift opens in 5:50");
    expect(at(WEST, 650)).toBeUndefined();
    // Before format 2 the announcement stands in for the opening.
    const old: Timeline = { ...tl, rifts: [{ key: WEST, start_s: 100, end_s: 230 }] };
    expect(riftTip(riftAt(old, WEST, 120, markers)!, WEST, 120)).toBeUndefined();
  });

  it("a powerup site names the buff that's up, else the next and when", () => {
    const p = { available: [0, 0, 1, 1, 0, 0, 0, 0, 1, 0], spawns: [{ t: 2, buff: "gun", taken_s: 4 }, { t: 8, buff: "casting", taken_s: 9 }] };
    const at = (t: number) => powerupTip(powerupAt(p, t)!, t);
    expect(at(0.5)).toBe("Buff spawns in 0:02");
    expect(at(3)).toBe("Gun buff");
    expect(at(5)).toBe("Buff respawns in 0:03");
    expect(at(8.2)).toBe("Casting buff");
    expect(at(9)).toBeUndefined();
    // An older timeline has no spawns: no timer, the marker's name.
    expect(powerupAt({ available: [1] }, 0)).toBeUndefined();
  });

  it("camps and the mid boss count down to their respawn", () => {
    const c = { key: "camp:neutral:lane0:3", first_s: 30, cleared: [[60, 95]] as Array<[number, number]> };
    expect(campTip(campAt(c, 20), 20)).toBe("Spawns in 0:10");
    // Up: nothing to say.
    expect(campTip(campAt(c, 40), 40)).toBeUndefined();
    expect(campTip(campAt(c, 70), 70)).toBe("Respawns in 0:25");
    expect(campTip(campAt(c, 94.2), 94.2)).toBe("Respawns in 0:01");
  });

  it("a marker with nothing timed says nothing: the API summary's mid boss, and Sandbox", () => {
    const boss = markers.find((m) => m.kind === "midboss")!;
    const pv = { players: new Map(), down: new Set([boss.key]), sites: new Map(), lanes: new Map(), camps: new Map() };
    expect(markerTip(boss, pv, 10)).toBeUndefined();
    expect(markerTip(boss, { ...pv, down: new Set() }, 10)).toBeUndefined();
    expect(markerTip(boss, undefined, 10)).toBeUndefined();
    const walker = markers.find((m) => m.kind === "t2")!;
    expect(markerTip(walker, pv, 10)).toBeUndefined();
  });

  it("an objective with health says its name and health, rounded; down or unknown, nothing", () => {
    const walker = markers.find((m) => m.kind === "t2")!;
    const guardian = markers.find((m) => m.kind === "t1")!;
    const boss = markers.find((m) => m.kind === "midboss")!;
    const health = new Map([[walker.key, { pct: 61.6 }], [guardian.key, { pct: 100 }], [boss.key, { pct: 44.5 }]]);
    const pv = { players: new Map(), down: new Set<string>(), sites: new Map(), lanes: new Map(), camps: new Map(), health };
    expect(markerTip(walker, pv, 10)).toBe("Walker 62%");
    expect(markerTip(guardian, pv, 10)).toBe("Guardian 100%");
    expect(markerTip(boss, pv, 10)).toBe("Mid boss 45%");
    // Down: nothing; the mid boss, its timer instead.
    expect(markerTip(walker, { ...pv, down: new Set([walker.key]) }, 10)).toBeUndefined();
    const camps = new Map([[boss.key, { state: "cleared" as const, at: 70 }]]);
    expect(markerTip(boss, { ...pv, camps }, 10)).toBe("Respawns in 1:00");
    // Health off (no health in the view): nothing.
    const { health: _off, ...off } = pv;
    expect(markerTip(walker, off, 10)).toBeUndefined();
  });

  it("powerup events name their buff", () => {
    const n = namesFor(tl, () => "");
    const e = (kind: "powerup_spawn" | "powerup_taken", buff?: string) => ({ t: 300, kind, key: "powerup:neutral:lane1:1", buff: buff ?? null });
    expect(label(e("powerup_spawn", "gun"), n)).toBe("Powerup up (west): Gun buff (+fire rate, +ammo)");
    expect(label(e("powerup_taken", "survival"), n)).toBe("Powerup taken (west): Survival buff");
    expect(label(e("powerup_spawn"), n)).toBe("Powerup up (west)");
    expect(shortLabel(e("powerup_spawn", "movement"), n)).toBe("Movement buff up");
  });

  it("a hover crosses the wire as a key alone", () => {
    for (const r of [{ kind: "marker" as const, id: "camp:neutral:lane0:3" }, { kind: "token" as const, id: "Amber-2" }, { kind: "token" as const, id: "Sapphire-0", part: "vis" }]) {
      expect(hoverFromWire(hoverWire(r))).toEqual({ part: undefined, ...r });
    }
    expect(hoverFromWire("token:Amber-1:evil")).toEqual({ kind: "token", id: "Amber-1", part: undefined });
    expect(hoverFromWire("nope:x")).toBeUndefined();
    expect(hoverWire(undefined)).toBeNull();
  });
});
