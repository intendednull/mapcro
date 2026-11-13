// When what an event marks began (docs/research/event-starts.md): a souls swing's turning point,
// an objective's last push, a Mid-Boss attempt, a rift's cash-in; a click jumps there.
import { describe, expect, it } from "vitest";
import type { MatchEvent, Timeline, TimelineRift } from "../src/match/timeline";
import { eventStart, jumpAt, jumpTarget, midBossStart, objectiveStart, riftCaptureStart, soulsLead, swingStart } from "../src/player/events";

/** Two players' souls: Amber's lead is the samples' difference. */
const timeline = (amber: Array<[number, number]>, sapphire: Array<[number, number]> = [[0, 0]]) =>
  ({
    match_id: 1, start_time: 0, duration_s: 600, source: "", reanchored: 0, objectives: [], mid_boss: [],
    players: [
      { team: "amber", slot: 0, hero_id: 1, name: null, x: [], y: [], health: [], deaths: [], souls: amber },
      { team: "sapphire", slot: 1, hero_id: 2, name: null, x: [], y: [], health: [], deaths: [], souls: sapphire },
    ],
  }) as Timeline;

const walker = "walker:amber:lane1:1";

describe("event starts", () => {
  it("reads the souls lead from each player's last sample", () => {
    const tl = timeline([[0, 3000], [10, 5000]], [[0, 1000], [5, 2000]]);
    expect(soulsLead(tl, 4)).toBe(2000);
    expect(soulsLead(tl, 5)).toBe(1000);
    expect(soulsLead(tl, 10)).toBe(3000);
  });

  it("starts a souls swing at the lead's turning point, not where the window's 5000 is reached", () => {
    // The lead sits at 3000, dips to 0 at 160, then runs to 9000 by 210: the event is at 210,
    // the turn at 160 (the 5 s mean makes it 162).
    const tl = timeline([[0, 3000], [150, 3000], [160, 0], [180, 6000], [210, 9000]]);
    expect(swingStart(tl, 210)).toBe(162);
    const swing = { t: 210, kind: "souls_swing", team: "amber", amount: 6000 } as MatchEvent;
    expect(eventStart(tl, swing)).toBe(162);
    expect(jumpTarget(tl, swing, 5)).toBe(157);
  });

  it("starts a downward swing at its peak", () => {
    // 6000 at the window's start, a peak of 9000 at 160, then a fall to 0.
    const tl = timeline([[0, 6000], [150, 6000], [160, 9000], [180, 0], [210, 0]]);
    expect(swingStart(tl, 210)).toBe(162);
  });

  it("clamps a swing already moving at the window's start to that start", () => {
    // The lead was at 1000 for the whole window before it moved: the turn is earlier than the
    // parser looks, so the window's first second is the earliest the timeline can say.
    const tl = timeline([[0, 1000], [100, 1000], [160, 7000]]);
    expect(swingStart(tl, 210)).toBe(150);
  });

  it("has no start for a swing whose lead never moved", () => {
    const tl = timeline([[0, 1000]]);
    expect(swingStart(tl, 200)).toBeUndefined();
    expect(eventStart(tl, { t: 200, kind: "souls_swing", team: "amber" } as MatchEvent)).toBe(200);
  });

  it("starts an objective at its last push, not its first chip damage", () => {
    expect(objectiveStart([[0, 100], [100, 80], [140, 60], [150, 0]], 150)).toBe(140);
    // Two pushes: the last one wins.
    expect(objectiveStart([[0, 100], [100, 50], [105, 100], [200, 40], [205, 0]], 205)).toBe(200);
    // A heal inside a push isn't a new push.
    expect(objectiveStart([[0, 100], [100, 40], [101, 90], [120, 0]], 120)).toBe(100);
    // Exactly the quiet window is a new push.
    expect(objectiveStart([[0, 100], [80, 100], [100, 0]], 100)).toBe(100);
    // Every change within the quiet window: no separate push.
    expect(objectiveStart([[0, 100], [5, 90]], 5)).toBeUndefined();
    expect(objectiveStart([], 5)).toBeUndefined();
  });

  it("starts a Mid-Boss fight at its first drop after its last full health", () => {
    expect(midBossStart([[1, 100], [1850, 99], [1865, 0]], 1865)).toBe(1850);
    // It regenerates to full between attempts: the later 100 is the one this fight started from.
    expect(midBossStart([[1, 100], [100, 50], [120, 100], [140, 60], [160, 0]], 160)).toBe(140);
    // A one-shot kill starts at the kill second.
    expect(midBossStart([[0, 100], [100, 0]], 100)).toBe(100);
    expect(midBossStart([[10, 50], [20, 0]], 20)).toBeUndefined();
  });

  it("starts a rift capture when the capturing team's cash-in began", () => {
    const rift: TimelineRift = { key: "rift:neutral:lane1:1", start_s: 100, end_s: 140, live_s: 110, capture: [[1100, 0, 0], [1105, 2, 0], [1110, 5, 0]] };
    expect(riftCaptureStart(rift, "amber")).toBe(110.5);
    expect(riftCaptureStart(rift, "sapphire")).toBe(110);
    expect(riftCaptureStart({ ...rift, capture: [] }, "amber")).toBe(110);
    expect(riftCaptureStart(rift, null)).toBeUndefined();
  });

  it("gives each kind its start, and t where the timeline has no signal", () => {
    const tl = {
      ...timeline([[0, 0]]),
      objective_health: [
        { key: walker, at: [[0, 100], [100, 80], [140, 60], [150, 0]] },
        { key: "patron:sapphire:lane0:1", at: [[0, 100], [100, 99], [150, 0]] },
        { key: "mid_boss:neutral:lane0:1", at: [[1, 100], [1850, 99], [1865, 0]] },
      ],
      rifts: [{ key: "rift:neutral:lane1:1", start_s: 100, end_s: 140, live_s: 110, capture: [[1100, 0, 0], [1105, 2, 0]] }],
    } as Timeline;
    expect(eventStart(tl, { t: 150, kind: "objective", key: walker } as MatchEvent)).toBe(140);
    // A patron's down is the match ending: no push to start at.
    expect(eventStart(tl, { t: 150, kind: "objective", key: "patron:sapphire:lane0:1" } as MatchEvent)).toBe(150);
    expect(eventStart(tl, { t: 1865, kind: "mid_boss", key: "mid_boss:neutral:lane0:1" } as MatchEvent)).toBe(1850);
    expect(eventStart(tl, { t: 120, kind: "rift_capture", team: "amber", key: "rift:neutral:lane1:1" } as MatchEvent)).toBe(110.5);
    // A death's recap has no per-hit times; a cast, a spawn or a pickup is its own start.
    for (const kind of ["death", "ult", "powerup_spawn", "powerup_taken", "urn_pickup", "urn_drop", "urn_delivered", "rejuv_taken", "rejuv_revive", "rejuv_expired", "rift_up"] as const) {
      expect(eventStart(tl, { t: 120, kind } as MatchEvent)).toBe(120);
    }
    // The metadata tier has no health, camps or rifts: every event keeps its second.
    const meta = { ...timeline([[0, 0]]), players: [] } as Timeline;
    expect(eventStart(meta, { t: 150, kind: "objective", key: walker } as MatchEvent)).toBe(150);
  });

  it("jumps to the start less the lead, never before the match", () => {
    const tl = { ...timeline([[0, 0]]), objective_health: [{ key: walker, at: [[0, 100], [100, 80], [140, 60], [150, 0]] }] } as Timeline;
    const e = { t: 150, kind: "objective", key: walker } as MatchEvent;
    expect(jumpTarget(tl, e, 5)).toBe(135);
    expect(jumpTarget(tl, { t: 150, kind: "death" } as MatchEvent, 5)).toBe(145);
    expect(jumpTarget(tl, e, 200)).toBe(0);
    expect(jumpAt(3, 5)).toBe(0);
    expect(jumpAt(120, 0)).toBe(120);
  });
});
