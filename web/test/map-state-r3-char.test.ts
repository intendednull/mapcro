// Characterisation pins taken on R2 (`WRITTEN = 27`) before flipping Map-state Phase 5 Release R3
// (Writer B, store v17 floor 16; docs/specs/map-state-phase5-plan.md §8 R3):
// - Saved scene's markers (camps, heals, crates, Mid-Boss, powerups, rifts, urn, objective health
//   & Patron stage), marker hover timers, scene bar timers (Rejuvenator & Mid-Boss respawn), closed
//   lane shops, and Save's exact `ObjectiveState` record count on R2 (`written = 27`) vs R3
//   (`written = 40`).
// - Explicit `written = 27` stays frozen as the R2 baseline after R3 moves `WRITTEN` to 40.

import { describe, expect, it, vi } from "vitest";

vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { createRoot } from "solid-js";
import type { More } from "../src/gen/More";
import type { ObjectiveStatus } from "../src/gen/ObjectiveStatus";
import type { PlayerState } from "../src/gen/PlayerState";
import type { RecordId } from "../src/gen/RecordId";
import type { Slot } from "../src/board/state";
import { fromScene } from "../src/mapstate/scene";
import { shownUrn } from "../src/mapstate/shown";
import { matchSceneOps, sourceOf } from "../src/match/save";
import type { Timeline } from "../src/match/timeline";
import {
  centreTimer,
  effectiveCamp,
  markerTip,
  rejuvTip,
  respawnTip,
  tipFacts,
  urnItemTip,
} from "../src/player/Camps";
import { markerStates } from "../src/player/markerStates";
import { keyOf, markers, replay } from "./support/synthetic-match";

const rosterOf = (tl: Timeline): Slot[] =>
  tl.players.map((p, i) => ({
    id: `slot-${i}`,
    slot: { team: p.team === "amber" ? "Amber" : "Sapphire", slot: p.slot, name: "", hero: p.hero_id },
  }));

/** Enriched replay with camps, heals, crates, Mid-Boss, powerups, rifts, urn, objective health,
 * Patron stage 2, and Rejuvenator so every Group B surface is pinned in one fixture. */
function richReplay(): Timeline {
  const base = replay();
  return {
    ...base,
    powerups: [
      {
        key: keyOf("powerup"),
        available: [0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1],
        stale: [],
        spawns: [
          { t: 1, buff: "gun", taken_s: 3 },
          { t: 6, buff: "casting", taken_s: 9 },
          { t: 12, buff: "gun" },
        ],
      },
      { key: keyOf("powerup", 1), available: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], stale: [[2, 5]] },
    ],
    camps: [
      ...(base.camps ?? []),
      { key: keyOf("camp", 0), first_s: 0, cleared: [[1, 100]] },
      { key: keyOf("camp", 1), first_s: 20, cleared: [] },
      { key: keyOf("camp", 2), first_s: 0, cleared: [[2, 80]] },
    ],
    heals: [
      { key: keyOf("heal", 0), first_s: 0, cleared: [[2, 45]] },
      { key: keyOf("heal", 1), first_s: 30, cleared: [] },
    ],
    crates: [
      { key: keyOf("crate", 0), first_s: 0, cleared: [[1, 60]] },
      { key: keyOf("crate", 1), first_s: 25, cleared: [] },
    ],
  } as Timeline;
}

function buildScene(tl: Timeline, second: number, written: number) {
  const rs = rosterOf(tl);
  let n = 0;
  const saved = matchSceneOps(rs, [], undefined, tl, second, markers, () => `r3c${n++}`, [], {
    source: sourceOf(tl),
    written,
  });
  const heroes: Array<{ id: RecordId; state: PlayerState }> = [];
  const objectives = new Map<string, { status: ObjectiveStatus }>();
  const waves = new Map<string, { t: number; more?: More }>();
  let sceneState: More | undefined;
  let frameT: number | undefined;
  let tier: string | undefined;
  for (const op of saved.ops) {
    if (!("Create" in op)) continue;
    const rec = op.Create.record;
    if ("Scene" in rec) {
      frameT = rec.Scene.source?.t;
      tier = rec.Scene.source?.tier;
    } else if ("PlayerState" in rec) {
      heroes.push({ id: op.Create.id, state: rec.PlayerState });
    } else if ("ObjectiveState" in rec) {
      objectives.set(rec.ObjectiveState.key, { status: rec.ObjectiveState.status });
    } else if ("Wave" in rec) {
      waves.set(rec.Wave.lane, { t: rec.Wave.t, ...(rec.Wave.more ? { more: rec.Wave.more } : {}) });
    } else if ("SceneState" in rec) {
      sceneState = rec.SceneState.more;
    }
  }
  return { saved, heroes, objectives, waves, sceneState, frameT, tier, rs };
}

const markerByKey = (key: string) => markers.find((m) => m.key === key)!;
const allKeys = markers.map((m) => m.key);

describe("R3 pre-flip characterisation: Group B markers, hovers, bar timers, closed shops, and record count", () => {
  const tl = richReplay();
  const campClearedKey = keyOf("camp", 0);
  const campUnspawnedKey = keyOf("camp", 1);
  const healClearedKey = keyOf("heal", 0);
  const crateClearedKey = keyOf("crate", 0);
  const bossKey = keyOf("midboss");
  const powerupKey = keyOf("powerup", 0);
  const rift0Key = keyOf("koth", 0);
  const rift1Key = keyOf("koth", 1);
  const urn0Key = keyOf("urn", 0);
  const urn1Key = keyOf("urn", 1);
  const walkerKey = "walker:amber:lane1:1";
  const guardianKey = "guardian:sapphire:lane4:1";
  const patronKey = "patron:amber:lane0:1";
  const closedShopKey = "shop:sapphire:lane4:1";
  const openShopKey = "shop:amber:lane1:1";

  it("R2 save (written = 27) at t = 4: no Group B baseline, no hovers/timers/closed shops, full legacy ObjectiveStates", () => {
    const cap = buildScene(tl, 4, 27);
    expect(cap.sceneState?.rows).toBe(27);
    // R2 writes ObjectiveStates for structural down objectives PLUS every non-default site:
    // 1 structural (guardian:sapphire:lane4:1) + 3 camps + 2 heals + 1 Mid-Boss + 2 crates
    // + 1 down powerup + 1 active rift + 1 open urn delivery = 12 ObjectiveStates.
    expect([...cap.objectives.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      [keyOf("camp", 0), { status: "Destroyed" }],
      [keyOf("camp", 1), { status: "Destroyed" }],
      [keyOf("camp", 2), { status: "Destroyed" }],
      [guardianKey, { status: "Destroyed" }],
      [keyOf("heal", 0), { status: "Destroyed" }],
      [keyOf("heal", 1), { status: "Destroyed" }],
      [bossKey, { status: "Destroyed" }],
      [powerupKey, { status: "Destroyed" }],
      [rift0Key, { status: "Active" }],
      [keyOf("crate", 0), { status: "Destroyed" }],
      [keyOf("crate", 1), { status: "Destroyed" }],
      [urn1Key, { status: "Active" }],
    ]);
    expect(cap.objectives.size).toBe(12);

    createRoot((dispose) => {
      const ms = fromScene({
        heroes: () => cap.heroes,
        roster: () => cap.rs,
        objectives: () => cap.objectives,
        waves: () => cap.waves,
        state: () => cap.sceneState,
        tier: () => cap.tier,
        frame: () => cap.frameT,
        markers: () => markers,
      });
      const st = markerStates({ ms: () => ms, player: () => false, health: () => true }, () => allKeys);

      // All Group B features are uncaptured on R2.
      for (const f of ["camps", "powerups", "obj_health", "rifts", "urn", "rejuv"] as const) {
        expect(ms.has(f), f).toBe(false);
      }

      // No Group B baseline details, no marker hover timers, no bar timers, no closed lane shops.
      expect(st.camp(campClearedKey)).toBeUndefined();
      expect(st.camp(bossKey)).toBeUndefined();
      expect(st.buff(powerupKey)).toBeUndefined();
      expect(st.health(walkerKey)).toBeUndefined();
      expect(st.status(closedShopKey)).toBeUndefined();
      expect(ms.marker(closedShopKey).shopClosed()).toBe(false);
      expect(ms.scene().urn()).toBeUndefined();
      expect(ms.scene().rejuv()).toBeUndefined();
      expect(centreTimer(ms.scene().rejuv() ?? [], ms.marker(bossKey).camp())).toEqual({ kind: "none" });
      for (const key of [campClearedKey, healClearedKey, crateClearedKey, bossKey, powerupKey, rift0Key, walkerKey]) {
        expect(markerTip(markerByKey(key), tipFacts(ms, key, true, shownUrn(ms, "all")), 4), key).toBeUndefined();
      }
      dispose();
    });
  });

  it("R3 save (written = 40) at t = 4: full Group B baseline, hovers, Rejuv bar timer, closed shop, and reduced ObjectiveStates", () => {
    const cap = buildScene(tl, 4, 40);
    expect(cap.sceneState?.rows).toBe(40);
    // R3 omits ObjectiveStates for baseline-covered sites (powerup, rift, urn, camps/heals/crates/midboss)
    // and keeps ONLY destroyed structural objectives (1 record instead of 4!).
    expect([...cap.objectives.entries()]).toEqual([[guardianKey, { status: "Destroyed" }]]);
    expect(cap.objectives.size).toBe(1);

    createRoot((dispose) => {
      const ms = fromScene({
        heroes: () => cap.heroes,
        roster: () => cap.rs,
        objectives: () => cap.objectives,
        waves: () => cap.waves,
        state: () => cap.sceneState,
        tier: () => cap.tier,
        frame: () => cap.frameT,
        markers: () => markers,
      });
      const st = markerStates({ ms: () => ms, player: () => false, health: () => true }, () => allKeys);

      for (const f of ["camps", "powerups", "obj_health", "rifts", "urn", "rejuv"] as const) {
        expect(ms.has(f), f).toBe(true);
      }

      // Camps, heals, crates, and Mid-Boss states + hover timers.
      expect(st.status(campClearedKey)).toBe("Destroyed");
      expect(st.camp(campClearedKey)).toBe("cleared");
      expect(st.status(campUnspawnedKey)).toBe("Destroyed");
      expect(st.camp(campUnspawnedKey)).toBe("unspawned");
      expect(st.status(healClearedKey)).toBe("Destroyed");
      expect(st.camp(healClearedKey)).toBe("cleared");
      expect(st.status(crateClearedKey)).toBe("Destroyed");
      expect(st.camp(crateClearedKey)).toBe("cleared");
      expect(st.status(bossKey)).toBe("Destroyed");
      expect(st.camp(bossKey)).toBe("cleared");

      const urn = shownUrn(ms, "all");
      expect(markerTip(markerByKey(campClearedKey), tipFacts(ms, campClearedKey, true, urn), 4)).toBe("Respawns in 1:36");
      expect(markerTip(markerByKey(campUnspawnedKey), tipFacts(ms, campUnspawnedKey, true, urn), 4)).toBe("Spawns in 0:16");
      expect(markerTip(markerByKey(healClearedKey), tipFacts(ms, healClearedKey, true, urn), 4)).toBe("Respawns in 0:41");
      expect(markerTip(markerByKey(crateClearedKey), tipFacts(ms, crateClearedKey, true, urn), 4)).toBe("Respawns in 0:56");
      expect(markerTip(markerByKey(bossKey), tipFacts(ms, bossKey, true, urn), 4)).toBe("Respawns in 6:36");

      // Powerup down with next spawn timer; rift active with capture & fade timer, other site "elsewhere".
      expect(st.status(powerupKey)).toBe("Destroyed");
      expect(markerTip(markerByKey(powerupKey), tipFacts(ms, powerupKey, true, urn), 4)).toBe("Buff respawns in 0:02");
      expect(st.status(rift0Key)).toBe("Active");
      expect(st.status(rift1Key)).toBe("Destroyed");
      expect(ms.marker(rift0Key).rift()).toEqual({ state: "active", giveUp: 5, capture: { amber: 65, sapphire: 23, captured: null } });
      expect(ms.marker(rift1Key).rift()).toEqual({ state: "elsewhere" });
      expect(markerTip(markerByKey(rift0Key), tipFacts(ms, rift0Key, true, urn), 4)).toBe("Fades in 0:01");

      // Urn carried by sapphire-1 at t = 4, delivery open at urn1.
      expect(urn?.state).toBe("carried");
      expect(urn?.delivery).toBe(urn1Key);
      expect(st.status(urn1Key)).toBe("Active");
      expect(st.status(urn0Key)).toBe("Destroyed");

      // Objective health (walker at 35%).
      expect(st.health(walkerKey)).toBe(35);
      expect(markerTip(markerByKey(walkerKey), tipFacts(ms, walkerKey, true, urn), 4)).toBe("Walker 35%");

      // Closed lane shop (sapphire lane4 guardian is down; amber lane1 guardian is up).
      expect(ms.marker(closedShopKey).shopClosed()).toBe(true);
      expect(st.status(closedShopKey)).toBe("Hidden");
      expect(ms.marker(openShopKey).shopClosed()).toBe(false);
      expect(st.status(openShopKey)).toBeUndefined();

      // Scene bar timers: Sapphire holds Rejuvenator (3 revives, ends at 9, taken at 4).
      const rejuv = ms.scene().rejuv() ?? [];
      expect(rejuv).toEqual([{ team: "sapphire", left: 3, ends: 9, taken: 4 }]);
      expect(centreTimer(rejuv, effectiveCamp(ms.marker(bossKey).status(), ms.marker(bossKey).camp()))).toEqual({ kind: "rejuv" });
      expect(rejuvTip(rejuv[0]!, 4)).toBe("Archmother Rejuvenator ends in 0:05");
      dispose();
    });
  });

  it("R3 save (written = 40) at t = 6 & t = 10: buff-up powerup, ground urn, Patron Stage 2, and Mid-Boss respawn bar timer", () => {
    // At t = 6: powerup0 is up with "spirit" buff; urn is on the ground at (700, -30); walker:amber:lane1:1 is now down.
    const cap6 = buildScene(tl, 6, 40);
    // Only the 2 destroyed structural objectives remain as ObjectiveStates (walker + guardian).
    expect([...cap6.objectives.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      [guardianKey, { status: "Destroyed" }],
      [walkerKey, { status: "Destroyed" }],
    ]);
    createRoot((dispose) => {
      const ms = fromScene({
        heroes: () => cap6.heroes,
        roster: () => cap6.rs,
        objectives: () => cap6.objectives,
        waves: () => cap6.waves,
        state: () => cap6.sceneState,
        tier: () => cap6.tier,
        frame: () => cap6.frameT,
        markers: () => markers,
      });
      const st = markerStates({ ms: () => ms, player: () => false, health: () => true }, () => allKeys);
      expect(st.status(powerupKey)).toBe("Active");
      expect(st.buff(powerupKey)).toBe("casting");
      const urn = shownUrn(ms, "all")!;
      expect(urn.state).toBe("ground");
      expect(urn.at).toEqual({ x: 700, y: -30 });
      expect(urnItemTip(urn, 6)).toBe("Urn returns in 3:00");
      expect(markerTip(markerByKey(powerupKey), tipFacts(ms, powerupKey, true, urn), 6)).toBe("Casting buff");
      dispose();
    });

    // At t = 10: Rejuvenator is expired, Mid-Boss is still cleared (respawns at 400), Patron is Stage 2 (60% HP).
    const cap10R2 = buildScene(tl, 10, 27);
    const cap10R3 = buildScene(tl, 10, 40);
    // R2 writes 14 ObjectiveStates (2 structural + 4 camps + 2 heals + 1 Mid-Boss + 2 crates + powerup + rift1 + urn0);
    // R3 writes only the 2 destroyed structural objectives!
    expect(cap10R2.objectives.size).toBe(14);
    expect(cap10R3.objectives.size).toBe(2);
    expect([...cap10R3.objectives.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      [guardianKey, { status: "Destroyed" }],
      [walkerKey, { status: "Destroyed" }],
    ]);

    createRoot((dispose) => {
      const ms = fromScene({
        heroes: () => cap10R3.heroes,
        roster: () => cap10R3.rs,
        objectives: () => cap10R3.objectives,
        waves: () => cap10R3.waves,
        state: () => cap10R3.sceneState,
        tier: () => cap10R3.tier,
        frame: () => cap10R3.frameT,
        markers: () => markers,
      });
      const st = markerStates({ ms: () => ms, player: () => false, health: () => true }, () => allKeys);
      expect(st.status(patronKey)).toBe("Stage2");
      expect(st.health(patronKey)).toBe(60);
      expect(markerTip(markerByKey(patronKey), tipFacts(ms, patronKey, true, shownUrn(ms, "all")), 10)).toBe("Patron 60%");
      const ct = centreTimer(ms.scene().rejuv() ?? [], effectiveCamp(ms.marker(bossKey).status(), ms.marker(bossKey).camp()));
      expect(ct).toEqual({ kind: "respawn", at: 400 });
      expect(respawnTip(400, 10)).toBe("Mid-Boss respawns in 6:30");
      dispose();
    });
  });

  it("R3 save record-count reduction across many non-up camps vs R2, while preserving uncovered sites on fallback", () => {
    // Realistic early-game frame: 40 camps + 20 heals + 20 crates unspawned/cleared, plus powerup/rift/urn.
    const base = replay();
    const camps = markers.filter((m) => m.kind === "camp").slice(0, 40).map((m) => ({ key: m.key, first_s: 120, cleared: [] }));
    const heals = markers.filter((m) => m.kind === "heal").slice(0, 20).map((m) => ({ key: m.key, first_s: 120, cleared: [] }));
    const crates = markers.filter((m) => m.kind === "crate").slice(0, 20).map((m) => ({ key: m.key, first_s: 120, cleared: [] }));
    const earlyTl = { ...base, camps: [...(base.camps ?? []), ...camps], heals, crates } as Timeline;

    const r2 = buildScene(earlyTl, 4, 27);
    const r3 = buildScene(earlyTl, 4, 40);
    // R2 emits structural down (1) + 40 camps + 20 heals + 20 crates + 1 Mid-Boss + powerup + rift + urn = 85;
    // R3 emits ONLY the 1 structural down objective while packing all 81 non-up camp/heal/crate/Mid-Boss entries
    // into SceneState.more.camps (saving 84 ObjectiveState records in one scene!).
    expect(r2.objectives.size).toBe(85);
    expect(r3.objectives.size).toBe(1);
    expect((r3.sceneState?.camps as number[]).length).toBe(81 * 3);
    expect(r3.saved.ops.length).toBe(r2.saved.ops.length - 84);

    // Uncovered sites are preserved: when a timeline lacks `rifts`, R3 omits `has_rifts` and still
    // keeps structural down objectives + any uncovered sites cleanly.
    const { rifts: _dropRifts, ...noRiftsTl } = earlyTl;
    const r3NoRifts = buildScene(noRiftsTl as Timeline, 4, 40);
    expect(r3NoRifts.sceneState?.has_rifts).toBeUndefined();
    expect(r3NoRifts.sceneState?.has_camps).toBe(true);
    expect(r3NoRifts.objectives.size).toBe(1);

    // When `camps` is unavailable on a timeline lacking camps/heals/crates, `has_camps` is absent
    // and Mid-Boss/powerup/rift/urn coverage still works independently.
    const { camps: _c, heals: _h, crates: _cr, ...noCampsTl } = earlyTl;
    const r3NoCamps = buildScene(noCampsTl as Timeline, 4, 40);
    expect(r3NoCamps.sceneState?.has_camps).toBeUndefined();
    expect(r3NoCamps.sceneState?.has_powerups).toBe(true);
    expect(r3NoCamps.sceneState?.has_rifts).toBe(true);
    expect(r3NoCamps.sceneState?.has_urn).toBe(true);
    expect(r3NoCamps.objectives.size).toBe(1);

    // When `written = 29` (`has_camps` + `camps` live, `powerups`/`rifts`/`urn` still Ahead),
    // R3 omits camp/heal/crate/Mid-Boss ObjectiveStates while keeping uncovered powerup, rift, urn!
    const partial = buildScene(earlyTl, 4, 29);
    expect(partial.sceneState?.has_camps).toBe(true);
    expect(partial.sceneState?.has_powerups).toBeUndefined();
    expect(partial.sceneState?.has_rifts).toBeUndefined();
    expect(partial.sceneState?.has_urn).toBeUndefined();
    expect([...partial.objectives.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      [guardianKey, { status: "Destroyed" }],
      [powerupKey, { status: "Destroyed" }],
      [rift0Key, { status: "Active" }],
      [urn1Key, { status: "Active" }],
    ]);
  });
});
