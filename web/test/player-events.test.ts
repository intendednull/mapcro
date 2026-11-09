// Player's events: labels, search across hero, player name, type, team and time, the jump time,
// where it happened, and scene names.
import { describe, expect, it } from "vitest";
import { FALLBACK } from "../src/map/fallback-data";
import { modelFromFallback } from "../src/map/model";
import type { MatchEvent, Timeline } from "../src/match/timeline";
import { groupOf, jumpTime, label, labelParts, namesFor, placeOf, search, shortLabel } from "../src/player/events";
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
      "Archmother walker down (east)",
      "Rift captured by Hidden King",
      "Powerup taken (east)",
      "Souls swing Hidden King +12.4k",
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
    expect(ts("hidden king")).toEqual([125, 410, 600]);
    expect(ts("2:05")).toEqual([125]);
    expect(ts("", ["rift", "powerup"])).toEqual([410, 500]);
    expect(ts("amber", ["souls"])).toEqual([600]);
  });

  it("with names hidden (Names off), no label or search finds a player by name", () => {
    const hidden = namesFor(tl, (id) => ({ 1: "Infernus", 2: "Haze" })[id] ?? `Hero ${id}`, () => undefined);
    expect(labelParts(ev[0]!, n).map((x) => x.text).join("")).toBe("Infernus Coach killed by Haze");
    expect(labelParts(ev[0]!, hidden).map((x) => x.text).join("")).toBe("Infernus killed by Haze");
    expect(search(ev, hidden, "coach", new Set()).length).toBe(0);
    expect(search(ev, hidden, "infernus", new Set()).map((e) => e.t)).toEqual([125]);
  });

  it("jumps a lead before, finds the place, and names scenes within 24 characters", () => {
    expect(jumpTime(ev[0]!, 5)).toBe(120);
    expect(jumpTime({ t: 3 }, 5)).toBe(0);
    const markers = modelFromFallback(FALLBACK).markers;
    expect(placeOf(ev[0]!, markers)).toEqual({ x: (100 + 10752) / 21504 * 1000, y: (10752 + 200) / 21504 * 1000 });
    expect(placeOf(ev[1]!, markers)).toEqual(markers.find((m) => m.key === "walker:sapphire:lane6:1")!.at);
    // The metadata names the patron by Valve's lane; this board's marker is keyed lane0.
    expect(placeOf({ t: 9, kind: "objective", key: "patron:sapphire:lane3:1" }, markers)).toEqual(markers.find((m) => m.key === "patron:sapphire:lane0:1")!.at);
    expect(sceneName(shortLabel(ev[0]!, n))).toBe("Infernus died");
    expect(sceneName("A very long hero name has died here")).toBe("A very long hero name h…");
    expect(sceneName("A very long hero name has died here").length).toBe(24);
  });
});

import { matchSceneOps, matchScenesOps, sourceOf } from "../src/match/save";
import type { Op } from "../src/gen/Op";
import { MAX_OPS_PER_TX, chunks, clearAnnotationsOps, ensureLiveOps, idFrom, liveIds, takeAnnotationsOps } from "../src/player/live";
import { eventKey } from "../src/player/events";

describe("player scenes", () => {
  const roster = [0, 1].map((i) => ({ id: `slot${i}`, slot: { team: "Amber" as const, slot: i, hero: 1, name: "" } }));
  const timeline = { ...tl, duration_s: 900, tier: "replay" as const };

  it("store their source at their own moment, in order, one group per scene", () => {
    let n = 0;
    const mint = () => `id${n++}`;
    const one = matchSceneOps(roster as never, [], undefined, timeline, 125.6, [], mint, [], { source: sourceOf(timeline) });
    expect(one.ops[0]).toMatchObject({ Create: { record: { Scene: { clock: 125, source: { match_id: 1, t: 125, tier: "replay" } } } } });
    const many = matchScenesOps(roster as never, [], undefined, timeline, [{ t: 10, name: "A" }, { t: 20, name: "B" }], [], mint);
    const scenes = many.ops.flatMap((o) => ("Create" in o && "Scene" in o.Create.record ? [o.Create.record.Scene] : []));
    expect(scenes.map((s) => s.name)).toEqual(["A", "B"]);
    expect(scenes.map((s) => s.source?.t)).toEqual([10, 20]);
    expect(scenes[0]!.order < scenes[1]!.order).toBe(true);
    expect(scenes.every((s) => s.source?.tier === "replay")).toBe(true);
    expect(many.groups).toHaveLength(2);
  });

  it("many scenes go in transactions within the op cap, never splitting a scene", () => {
    // 15 late-game scenes of 40 ops each: 600 ops, more than two transactions' worth.
    const group = (i: number): Op[] => Array.from({ length: 40 }, (_, k) => ({ Delete: { id: `g${i}-${k}` } }));
    const groups = Array.from({ length: 15 }, (_, i) => group(i));
    const txs = chunks(groups, MAX_OPS_PER_TX);
    expect(txs.every((t) => t.length <= MAX_OPS_PER_TX)).toBe(true);
    expect(txs.flat()).toEqual(groups.flat());
    expect(txs.map((t) => t.length)).toEqual([240, 240, 120]);
  });

  it("the live layer has fixed ids per board and match; it's made, restored, moved and cleared", () => {
    let n = 0;
    const mint = () => `id${n++}`;
    expect(idFrom("x")).toMatch(/^[0-9a-f]{32}$/);
    const a = liveIds("boardA", 7, roster as never);
    expect(liveIds("boardA", 7, roster as never)).toEqual(a);
    expect(liveIds("boardA", 8, roster as never).scene).not.toBe(a.scene);
    expect(liveIds("boardB", 7, roster as never).scene).not.toBe(a.scene);
    const made = ensureLiveOps({}, "boardA", 7, roster as never);
    expect(made[0]).toMatchObject({ Create: { id: a.scene, record: { Scene: { live: true, source: { match_id: 7 } } } } });
    expect(made.filter((o) => "Create" in o && "PlayerState" in o.Create.record)).toHaveLength(2);
    // An undo took it away: it comes back by Restore, same ids.
    const gone = Object.fromEntries([a.scene, ...a.players.map(([id]) => id)].map((id) => [id, { deleted: true }]));
    expect(ensureLiveOps(gone, "boardA", 7, roster as never)).toEqual([{ Restore: { id: a.scene } }, ...a.players.map(([id]) => ({ Restore: { id } }))]);
    const there = Object.fromEntries([a.scene, ...a.players.map(([id]) => id)].map((id) => [id, {}]));
    expect(ensureLiveOps(there, "boardA", 7, roster as never)).toEqual([]);
    const rows = (kind: string) => (kind === "Stroke" ? [["s1", { Stroke: { scene: a.scene, points: [], color: 1, width: 3 } }] as const] : []);
    const moved = takeAnnotationsOps(rows as never, a.scene, "scene9", mint);
    expect(moved).toEqual([{ Create: { id: expect.any(String), record: { Stroke: { scene: "scene9", points: [], color: 1, width: 3 } } } }, { Delete: { id: "s1" } }]);
    expect(clearAnnotationsOps(rows as never, a.scene)).toEqual([{ Delete: { id: "s1" } }]);
  });

  it("events keep their key when a replay reorders the list", () => {
    const e = { t: 300, kind: "objective" as const, team: "sapphire", key: "walker:sapphire:lane6:1" };
    expect(eventKey(e)).toBe(eventKey({ ...e }));
    expect(eventKey(e)).not.toBe(eventKey({ ...e, t: 301 }));
  });
});
