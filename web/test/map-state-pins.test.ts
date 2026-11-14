// Characterisation (map-state spec §9, phase 0): what Player computes at a frame and what Save as
// scene writes from it, pinned on a synthetic match before either is rebuilt on `MapState`.
// A later phase that changes a value here changes what a coach sees: the snapshot file must move
// only with a decision in the spec's §2, never as a side effect.
//
// The match is made up (no names, no ids; 6v6): twelve heroes, one dying and one unplaced, items
// and abilities with a cooldown, a rift, powerups, zipline colours, camps and the mid boss.
import { describe, expect, it } from "vitest";
import { FALLBACK } from "../src/map/fallback-data";
import { modelFromFallback } from "../src/map/model";
import { buildAt } from "../src/match/builds";
import { matchSceneOps, sourceOf } from "../src/match/save";
import { type Timeline, type TimelinePlayer, campsAt, downAt, lanesAt, playersAt, sitesAt, tierOf } from "../src/match/timeline";

const model = modelFromFallback(FALLBACK);
const markers = model.markers;
const lanes = model.lanes.map((l) => l.key);

const hero = (team: "amber" | "sapphire", slot: number): TimelinePlayer => {
  const i = (team === "amber" ? 0 : 6) + slot;
  const dies = i === 3;
  const away = i === 8; // never placed: no samples at all
  const at = (k: number) => (away || (dies && k === 3) ? null : (team === "amber" ? -1 : 1) * (1000 + 700 * slot) + 150 * k);
  return {
    team, slot, hero_id: 10 + i, name: "",
    x: [0, 1, 2, 3, 4].map(at), y: [0, 1, 2, 3, 4].map((k) => (at(k) === null ? null : 300 * slot - 80 * k)),
    health: [100, 90, 60, dies ? 0 : 75, 100], deaths: dies ? [3] : [],
    souls: [[0, 400 + 10 * i], [2, 1250 + 100 * i]],
    ult: [null, 100, 50 + i, 25, 0],
    items: [[5, 9000 + i, 0], [15, 9100 + i, 0], [25, 9000 + i, 1]],
    abilities: [[0, 7000 + i, 1], [2, 7000 + i, 2], [3, 7100 + i, 1]],
    casts: [[18, 7000 + i, 40]], charges: [[10, 9100 + i, 2]], stacks: [[20, 9100 + i, 3]],
  } as TimelinePlayer;
};

const replay: Timeline = {
  match_id: 9, start_time: 0, duration_s: 4, source: "replay", tier: "replay", build: 6839, reanchored: 0,
  players: (["amber", "sapphire"] as const).flatMap((team) => [0, 1, 2, 3, 4, 5].map((slot) => hero(team, slot))),
  objectives: [
    { key: "walker:amber:lane1:1", kind: "walker", team: "amber", lane: 1, destroyed_s: 2 },
    { key: "guardian:sapphire:lane4", kind: "guardian", team: "sapphire", lane: 4, destroyed_s: 1 },
  ],
  mid_boss: [],
  rifts: [{ key: "rift:neutral:lane6:1", start_s: 1, end_s: 3 }],
  powerups: [{ key: "powerup:neutral:lane1:1", available: [0, 1, 1, 0, 0], stale: [] }, { key: "powerup:neutral:lane6:1", available: [1, 1, 1, 1, 1], stale: [[2, 5]] }],
  zips: [{ lane: "lane1", at: [[0, 500, 500]] }, { lane: "lane4", at: [[0, 425, 574], [2, 480, 520], [4, 300, 300]] }, { lane: "lane6", at: [[0, 0, 1000], [3, 640, 700]] }],
  camps: [
    { key: "camp:neutral:lane0:3", first_s: 1, cleared: [[2, 4]] },
    { key: "mid_boss:neutral:lane0:1", first_s: 0, cleared: [[3, 400]] },
  ],
} as Timeline;

const { tier: _t, rifts: _r, powerups: _p, zips: _z, camps: _c, ...metaRest } = replay;
const metadata = { ...metaRest, source: "metadata" } as Timeline;

const TIMES = [0, 1, 1.5, 2, 3, 3.9, 4];
const entries = <V>(m: Map<string, V>) => [...m].sort(([a], [b]) => a.localeCompare(b));

/** Everything the frame functions give for `tl` at `t`, in a stable order. */
const frame = (tl: Timeline, t: number) => ({
  t,
  players: playersAt(tl, t),
  builds: tl.players.map((p) => buildAt(p, t)),
  down: [...downAt(tl, t, markers)].sort(),
  sites: entries(sitesAt(tl, t, markers)),
  lanes: entries(lanesAt(tl, t)),
  camps: entries(campsAt(tl, t)),
});

const roster = replay.players.map((p, i) => ({ id: `slot-${i}`, slot: { team: p.team === "amber" ? ("Amber" as const) : ("Sapphire" as const), slot: p.slot, hero: i < 6 ? p.hero_id : null, name: "" } }));

/** Save as scene's ops at `t`, with ids minted in order. */
const saved = (tl: Timeline, t: number) => {
  let n = 0;
  // `builds` (whether the snapshot fitted) is the caller's to report, not a stored value.
  const { builds: _fitted, ...ops } = matchSceneOps(roster as never, [], undefined, tl, t, markers, () => `id${n++}`, lanes, { source: sourceOf(tl) });
  return ops;
};

describe("map state, as it is before MapState (phase 0 pins)", () => {
  it("the synthetic match is a replay-tier 6v6, and its metadata twin has no replay fields", () => {
    expect(tierOf(replay)).toBe("replay");
    expect(tierOf(metadata)).toBe("metadata");
    expect(replay.players).toHaveLength(12);
  });

  it("Player's frame from the replay tier, at a spread of times", async () => {
    await expect(JSON.stringify(TIMES.map((t) => frame(replay, t)), null, 1)).toMatchFileSnapshot("./pins/player-frames-replay.json");
  });

  it("Player's frame from the metadata tier", async () => {
    await expect(JSON.stringify([0, 2, 3.9].map((t) => frame(metadata, t)), null, 1)).toMatchFileSnapshot("./pins/player-frames-metadata.json");
  });

  it("Save as scene's records, from each tier (moved by phase 2: each hero's build and the scene's state)", async () => {
    await expect(JSON.stringify({ replay_2: saved(replay, 2), replay_3_9: saved(replay, 3.9), metadata_3: saved(metadata, 3) }, null, 1)).toMatchFileSnapshot("./pins/save-as-scene.json");
  });

  it("Save writes a dead hero where it died, a hero with no samples as dead and unplaced, and rewrites the roster", () => {
    // The parts of today's copy that decisions D2 and D4 will change, stated so the change is seen.
    const ops = saved(replay, 3).ops;
    const players = ops.flatMap((o) => ("Create" in o && "PlayerState" in o.Create.record ? [o.Create.record.PlayerState] : []));
    expect(players).toHaveLength(12);
    expect(players[3]).toMatchObject({ alive: false, placed: true, visible: true });
    expect(players[8]).toMatchObject({ alive: false, placed: false, pos: { x: 0, y: 0 } });
    expect(players.every((p) => p.visible === true && p.respawn === undefined)).toBe(true);
    // Six slots had no hero: Save sets the board's roster to the match's.
    expect(ops.filter((o) => "Set" in o && "RosterHero" in o.Set.value)).toHaveLength(6);
    // Phase 2 (spec §8): the frame's builds are stored too, on the heroes' records, with one
    // state for the scene that says so. Health on the bar, timers and sight are later phases.
    const kinds = new Set(ops.flatMap((o) => ("Create" in o ? Object.keys(o.Create.record) : [])));
    expect([...kinds].sort()).toEqual(["ObjectiveState", "PlayerState", "Scene", "SceneState", "Wave"]);
    // Without the snapshot it is the save as it was before phase 2, record for record.
    const bare = matchSceneOps(roster as never, [], undefined, replay, 3, markers, (() => { let n = 0; return () => `id${n++}`; })(), lanes, { source: sourceOf(replay), builds: false }).ops;
    expect(new Set(bare.flatMap((o) => ("Create" in o ? Object.keys(o.Create.record) : [])))).toEqual(new Set(["ObjectiveState", "PlayerState", "Scene", "Wave"]));
    expect(bare.every((o) => !("Create" in o && "PlayerState" in o.Create.record && o.Create.record.PlayerState.more))).toBe(true);
  });
});
