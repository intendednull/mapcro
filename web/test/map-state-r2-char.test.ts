// Characterisation pins taken on R1 (`WRITTEN = 16`) before flipping Map-state Phase 5 Release R2
// (Writer A, store v16 floor 15; docs/specs/map-state-phase5-plan.md §8 R2):
// - Saved scene tokens (health, sight, CC, movement), lanes (split & dragged split), and skulls
//   under every Vision × Show last seen combination on an R1 (`written = 16`) save vs a Group A
//   (`written = 27`) save.
// - Explicit `written = 16` stays frozen as the R1 baseline after R2 moves `WRITTEN` to 27.

import { describe, expect, it, vi } from "vitest";

vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { createRoot } from "solid-js";
import type { More } from "../src/gen/More";
import type { ObjectiveStatus } from "../src/gen/ObjectiveStatus";
import type { PlayerState } from "../src/gen/PlayerState";
import type { RecordId } from "../src/gen/RecordId";
import type { Slot } from "../src/board/state";
import { shiftEdges } from "../src/map/lanes";
import { fromScene } from "../src/mapstate/scene";
import { heroDraw, shownDeaths } from "../src/mapstate/shown";
import { matchSceneOps, sourceOf } from "../src/match/save";
import { type Timeline, slotKey } from "../src/match/timeline";
import { VISIONS } from "../src/player/vision";
import { markers, replay } from "./support/synthetic-match";

const rosterOf = (tl: Timeline): Slot[] =>
  tl.players.map((p, i) => ({
    id: `slot-${i}`,
    slot: { team: p.team === "amber" ? "Amber" : "Sapphire", slot: p.slot, name: "", hero: p.hero_id },
  }));

function buildScene(tl: Timeline, second: number, written: number) {
  const rs = rosterOf(tl);
  let n = 0;
  const saved = matchSceneOps(rs, [], undefined, tl, second, markers, () => `ch${n++}`, [], {
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

describe("R2 pre-flip characterisation: saved scene tokens, lanes, and skulls across Vision × Show last seen", () => {
  const tl = replay();

  it("R1 save (written = 16): no Group A features captured; legacy sight ignores Vision × Show last seen", () => {
    // At t = 6 on synthetic replay: heroes have health, unseen enemies, height=2, lane edges, and 1s-old skulls (deaths at t=5).
    const cap = buildScene(tl, 6, 16);
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

      // Health is captured on replay-tier saves since phase 2; Group A features are all false at written = 16.
      expect(ms.has("health")).toBe(true);
      expect(ms.has("sight")).toBe(false);
      expect(ms.has("cc")).toBe(false);
      expect(ms.has("movement")).toBe(false);
      expect(ms.has("lanes")).toBe(false);
      expect(ms.has("skulls")).toBe(false);

      // Every hero reads legacy defaults for Group A rows; health is present for living heroes.
      const living = tl.players.filter((p) => p.x[6] != null);
      expect(living.length).toBeGreaterThan(0);
      for (const p of tl.players) {
        const key = slotKey(p.team, p.slot);
        const h = ms.hero(key);
        expect(h.inSight()).toBe(true);
        expect(h.cc()).toBeUndefined();
        expect(h.height()).toBeUndefined();
        expect(h.zipline()).toBe(false);
        expect(h.lastSeen()).toBeNull();
        for (const vision of VISIONS) {
          for (const lastSeen of [false, true]) {
            expect(
              heroDraw({ team: p.team, inSight: h.inSight(), lastSeen: h.lastSeen() }, { vision, lastSeen }, ms.has("sight"), true),
            ).toEqual({ as: "seen" });
          }
        }
      }

      // Lanes store split only (no edges); skulls are empty under every Vision.
      for (const lane of ["lane1", "lane4", "lane6"]) {
        expect(ms.lane(lane).split()).toBeTypeOf("number");
        expect(ms.lane(lane).edges()).toBeUndefined();
      }
      for (const vision of VISIONS) {
        expect(shownDeaths(ms, vision)).toEqual([]);
      }
      dispose();
    });
  });

  it("Group A save (written = 27): tokens, dragged lane edges, and skulls under every Vision × Show last seen", () => {
    const cap = buildScene(tl, 6, 27);
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

      expect(ms.has("health")).toBe(true);
      expect(ms.has("sight")).toBe(true);
      expect(ms.has("cc")).toBe(true);
      expect(ms.has("movement")).toBe(true);
      expect(ms.has("lanes")).toBe(true);
      expect(ms.has("skulls")).toBe(true);

      // Every Vision × Show last seen combination: unseen enemies are faded (never hidden, never ghost),
      // and Show last seen is a strict no-op on every slot.
      const unseenSlots = tl.players.filter((p) => !ms.hero(slotKey(p.team, p.slot)).inSight());
      expect(unseenSlots.length).toBeGreaterThan(0);

      for (const p of tl.players) {
        const key = slotKey(p.team, p.slot);
        const h = ms.hero(key);
        const seen = h.inSight();
        for (const vision of VISIONS) {
          const drawOff = heroDraw({ team: p.team, inSight: seen, lastSeen: h.lastSeen() }, { vision, lastSeen: false }, ms.has("sight"), true);
          const drawOn = heroDraw({ team: p.team, inSight: seen, lastSeen: h.lastSeen() }, { vision, lastSeen: true }, ms.has("sight"), true);
          expect(drawOn).toEqual(drawOff);
          const want = vision === "all" || vision === p.team || seen ? { as: "seen" } : { as: "faded" };
          expect(drawOff, `${key} under ${vision}`).toEqual(want);
        }
      }

      // Lanes store edges that match split and follow dragged splits via shiftEdges (Q7).
      const e4 = ms.lane("lane4").edges()!;
      expect(e4).toBeDefined();
      const s4 = ms.lane("lane4").split()!;
      expect(shiftEdges(e4, s4)).toEqual(e4);
      const dragged = shiftEdges(e4, 800);
      expect(dragged.amber).toBeLessThanOrEqual(dragged.sapphire);
      expect(Math.round((dragged.amber + dragged.sapphire) / 2)).toBe(800);

      // Skulls: all deaths under All, filtered by team sight under Amber / Sapphire.
      const allSkulls = shownDeaths(ms, "all");
      expect(allSkulls.length).toBeGreaterThan(0);
      for (const team of ["amber", "sapphire"] as const) {
        expect(shownDeaths(ms, team)).toEqual(allSkulls.filter((d) => d.team === team || d.seen));
      }
      dispose();
    });

    // At t = 2: CC and zipline are active on living heroes (pinned on R1's dormant Group A reader).
    const cap2 = buildScene(tl, 2, 27);
    createRoot((dispose) => {
      const ms = fromScene({
        heroes: () => cap2.heroes,
        roster: () => cap2.rs,
        objectives: () => cap2.objectives,
        waves: () => cap2.waves,
        state: () => cap2.sceneState,
        tier: () => cap2.tier,
        frame: () => cap2.frameT,
        markers: () => markers,
      });
      expect(tl.players.some((p) => ms.hero(slotKey(p.team, p.slot)).cc() === "Stunned")).toBe(true);
      expect(tl.players.some((p) => ms.hero(slotKey(p.team, p.slot)).zipline())).toBe(true);
      dispose();
    });
  });
});
