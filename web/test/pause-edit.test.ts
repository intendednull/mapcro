// GitHub #61 (docs/specs/player-pause-edit.md): unit tests for liveScene pause-edit primitives,
// deterministic upsert & zero tombstone growth on the real WASM replica, frame-seeded doors &
// #55 objective health, fromPausedPlayer overlay scoping, Save as scene fold, and clock follow.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Use the browser (reactive) SolidJS build in Node Vitest so signals & memos track updates.
vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));

import { createRoot, createSignal } from "solid-js";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import type { Doc } from "../src/gen/Doc";
import type { Entry } from "../src/gen/Entry";
import type { More } from "../src/gen/More";
import type { Op } from "../src/gen/Op";
import type { PlayerState } from "../src/gen/PlayerState";
import type { RecordId } from "../src/gen/RecordId";
import type { RosterSlot } from "../src/gen/RosterSlot";
import type { Tx } from "../src/gen/Tx";
import type { WireIn } from "../src/gen/WireIn";
import type { WireOut } from "../src/gen/WireOut";
import { LIMITS } from "../src/gen/limits";
import { FALLBACK } from "../src/map/fallback-data";
import { modelFromFallback } from "../src/map/model";
import { decodeDoors, decodeObjHealth, encodeDoors, encodeObjHealth } from "../src/mapstate/codec";
import { clearTeamDoorsOps, placeDoorwayOps, removeDoorwayOps, setObjectiveHealthOps } from "../src/mapstate/edit";
import {
  type MutablePausedBoard,
  fromPausedPlayer,
  liveObjUpsert,
  liveWaveUpsertOps,
  pauseClockOps,
  pauseHeroOps,
  pauseKillOps,
  pauseMoveOps,
  pauseRenameOps,
  pauseRespawnOps,
  pauseReviveOps,
  pauseSoulsOps,
  pauseToggleSightOps,
  pauseUltOps,
  prepareLivePauseEdit,
  preparePausedSceneState,
  seedObjHealthMap,
} from "../src/mapstate/paused";
import { fromTimeline } from "../src/mapstate/state";
import { type PauseOverrides, matchSceneOps, opsBytes, sourceOf } from "../src/match/save";
import { PICKUPS_FORMAT } from "../src/match/stats";
import type { DoorNow, Timeline, TimelinePlayer } from "../src/match/timeline";
import { follow } from "../src/player/clock";
import {
  clearPauseOverridesOps,
  collectPauseOverrides,
  ensureLiveOps,
  hasLiveAnnotations,
  hasPauseEntityOverrides,
  hasRawDirtyLiveEntities,
  isBaselinePlayerState,
  isLegacyUntouchedPlayerState,
  isLiveEntityCreate,
  liveEntityRecordIds,
  liveIds,
  liveObjId,
  liveSceneStateId,
  liveWaveId,
  normalizeLegacyLiveOps,
  pauseClock,
} from "../src/player/live";
import { BoardReplica, initSync, newClientId, newClientSecret } from "../src/wasm/mapcro_wasm.js";

const ROOT = resolve(__dirname, "../..");
initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

const MODEL = modelFromFallback(FALLBACK);
const MARKERS = MODEL.markers;
const WALKER = MARKERS.find((m) => m.kind === "t2" && m.team === "amber")!;
const GUARDIAN = MARKERS.find((m) => m.kind === "t1" && m.team === "sapphire")!;
const PATRON = MARKERS.find((m) => m.kind === "t3" && m.team === "amber")!;
const MIDBOSS = MARKERS.find((m) => m.kind === "midboss")!;
const BOARD_ID = "board-test-61";
const MATCH_ID = 42;

const mkPlayer = (team: "amber" | "sapphire", slot: number): TimelinePlayer => {
  const i = (team === "amber" ? 0 : 6) + slot;
  return {
    team,
    slot,
    hero_id: i === 0 ? 69 : 10 + i, // slot 0 amber = Doorman
    name: "",
    x: i === 1 ? [110, 130, null, null, 190] : [100 + i * 10, 120 + i * 10, 140 + i * 10, 160 + i * 10, 180 + i * 10],
    y: i === 1 ? [210, 230, null, null, 290] : [200 + i * 10, 220 + i * 10, 240 + i * 10, 260 + i * 10, 280 + i * 10],
    health: i === 1 ? [100, 50, 0, 0, 100] : [100, 90, 80, 70, 60],
    deaths: i === 1 ? [2] : [],
    respawn: i === 1 ? [[2, 32]] : [],
    souls: [[0, 1000 + i * 100]],
    ult: [null, 100, 50, 25, 0],
    level: [[0, 1], [2, 5 + i]],
    max_health: [[0, 750]],
    kills: [[0, i]],
    assists: [[0, 1]],
    pickups: [[1, [20, 1, 2, 3, 4]]],
    items: [[0, 4_000_000_000 + i, 0]],
    abilities: [[0, 7000 + i, 1]],
    casts: [],
    charges: [],
    stacks: [],
  } as TimelinePlayer;
};

const makeTimeline = (extra: Record<string, unknown> = {}): Timeline =>
  ({
    match_id: MATCH_ID,
    start_time: 0,
    duration_s: 4,
    source: "replay",
    tier: "replay",
    build: 6839,
    format: PICKUPS_FORMAT,
    reanchored: 0,
    players: (["amber", "sapphire"] as const).flatMap((team) => [0, 1, 2, 3, 4, 5].map((slot) => mkPlayer(team, slot))),
    objectives: [],
    mid_boss: [],
    doors: [{ id: 0, team: "amber", x: -100, y: -100, start_ds: 0, end_ds: 40, seen: [[0, 40]] }],
    objective_health: [{ key: WALKER.key, at: [[0, 100], [2, 60]] }],
    ...extra,
  }) as unknown as Timeline;

const hexId = (n: number): RecordId => n.toString(16).padStart(32, "0");

function makeHarness(legacy = false) {
  const rosterSlots: { id: RecordId; slot: RosterSlot }[] = [];
  const records: Record<RecordId, Entry> = {};
  const metaId = hexId(1);
  const realSceneId = hexId(2);
  records[metaId] = {
    deleted: false,
    record: { BoardMeta: { title: "Test", match_id: null, match_source: null } },
  } as unknown as Entry;
  records[realSceneId] = {
    deleted: false,
    record: { Scene: { name: "Scene 1", order: "a0", clock: 0, source: null, live: false, parent: null } },
  } as unknown as Entry;

  for (let i = 0; i < 12; i++) {
    const id = hexId(100 + i);
    const team = i < 6 ? ("Amber" as const) : ("Sapphire" as const);
    const slot: RosterSlot = { team, slot: i % 6, hero: i === 0 ? 69 : 10 + i, name: "" };
    rosterSlots.push({ id, slot });
    records[id] = { deleted: false, record: { RosterSlot: slot } } as unknown as Entry;
    records[hexId(200 + i)] = {
      deleted: false,
      record: {
        PlayerState: {
          scene: realSceneId,
          slot: id,
          pos: { x: 0, y: 0 },
          alive: true,
          placed: false,
          souls: null,
          ult_cooldown: null,
          visible: true,
          respawn: null,
        },
      },
    } as unknown as Entry;
  }

  const replica = new BoardReplica(newClientId(), newClientSecret(), JSON.stringify({ seq: 0, doc: Object.entries(records) }));
  const ids = liveIds(BOARD_ID, MATCH_ID, rosterSlots);
  const liveOps = ensureLiveOps(records, BOARD_ID, MATCH_ID, rosterSlots);
  if (legacy) {
    for (const op of liveOps) {
      if ("Create" in op && "PlayerState" in op.Create.record) {
        op.Create.record.PlayerState.placed = true;
      }
    }
  }
  const initRes = JSON.parse(replica.edit_silent(JSON.stringify(liveOps)));
  expect(initRes.error, JSON.stringify(initRes)).toBeUndefined();

  const readDoc = (): Record<RecordId, Entry> => Object.fromEntries(JSON.parse(replica.view()) as Doc);
  const [store, setStore] = createSignal<Record<RecordId, Entry | undefined>>(readDoc());
  const syncStore = () => setStore(readDoc());

  const apply = (ops: Op[], silent = false) => {
    if (!ops.length) return { refused: null };
    const raw = silent ? replica.edit_silent(JSON.stringify(ops)) : replica.edit(JSON.stringify(ops));
    const parsed = JSON.parse(raw);
    expect(parsed.refused, JSON.stringify(parsed)).toBeNull();
    syncStore();
    return parsed;
  };

  const board: MutablePausedBoard = {
    get records() {
      return store();
    },
    roster: () => rosterSlots,
    playersIn: (scene) => {
      if (!scene) return [];
      const out: { id: RecordId; state: PlayerState }[] = [];
      for (const [id, e] of Object.entries(store())) {
        if (!e || e.deleted) continue;
        if ("PlayerState" in e.record && e.record.PlayerState.scene === scene) {
          out.push({ id, state: e.record.PlayerState });
        }
      }
      return out;
    },
    inScene: (kind, scene) => {
      if (!scene) return [];
      const out: Array<readonly [RecordId, unknown]> = [];
      for (const [id, e] of Object.entries(store())) {
        if (!e || e.deleted) continue;
        const r = e.record as Record<string, { scene?: RecordId } | undefined>;
        const inner = r[kind];
        if (inner && inner.scene === scene) out.push([id, e.record] as const);
      }
      return out;
    },
    rowsIn: <T extends { scene: RecordId }>(kind: string, scene: RecordId | undefined) => {
      if (!scene) return [];
      const out: { id: RecordId; r: T }[] = [];
      for (const [id, e] of Object.entries(store())) {
        if (!e || e.deleted) continue;
        const inner = (e.record as unknown as Record<string, T | undefined>)[kind];
        if (inner && inner.scene === scene) out.push({ id, r: inner });
      }
      return out;
    },
    edit: (ops) => {
      apply(ops, false);
      return true;
    },
    editSilent: (ops) => {
      apply(ops, true);
      return true;
    },
    ensure: (ops) => {
      apply(ops, true);
      return true;
    },
    dropHistoryFor: (idsList) => {
      replica.dropHistoryFor(JSON.stringify(idsList));
    },
  };

  const pl = (index: number) => {
    const id = ids.players[index]![0];
    const e = board.records[id]!;
    if (!("PlayerState" in e.record)) throw new Error("expected PlayerState");
    return { id, state: e.record.PlayerState };
  };

  return { replica, ids, rosterSlots, board, readDoc, apply, pl };
}

describe("pause-edit baseline & legacy migration (B1, M3)", () => {
  it("ensureLiveOps creates liveScene PlayerStates with placed: false", () => {
    createRoot((dispose) => {
      const { board, ids } = makeHarness(false);
      const players = board.playersIn(ids.scene);
      expect(players).toHaveLength(12);
      for (const p of players) {
        expect(p.state.placed).toBe(false);
        expect(isBaselinePlayerState(p.state, null)).toBe(true);
      }
      expect(hasPauseEntityOverrides(board.records, ids.scene, false, 2)).toBe(false);
      dispose();
    });
  });

  it("treats pre-#61 legacy untouched liveScene PlayerStates (placed: true, pos {0,0}, clock: null) and empty more: {} as clean", () => {
    createRoot((dispose) => {
      const { board, ids, apply, pl } = makeHarness(true);
      expect(hasPauseEntityOverrides(board.records, ids.scene, false, 2)).toBe(false);
      expect(isLegacyUntouchedPlayerState(pl(0).state, null)).toBe(true);
      expect(isBaselinePlayerState(pl(0).state, null)).toBe(true);
      expect(
        isBaselinePlayerState(
          {
            scene: ids.scene,
            slot: hexId(100),
            pos: { x: 0, y: 0 },
            alive: true,
            placed: false,
            souls: null,
            ult_cooldown: null,
            visible: true,
            respawn: null,
            more: {},
          },
          2,
        ),
      ).toBe(true);

      const normOps = normalizeLegacyLiveOps(board.records, ids.scene);
      expect(normOps).toHaveLength(12);
      apply(normOps, true);
      expect(pl(0).state.placed).toBe(false);
      dispose();
    });
  });
});

describe("deterministic upsert & zero tombstone growth on real WASM BoardReplica (B3, B2)", () => {
  it("reuses liveSceneStateId, liveWaveId, and liveObjId across 25 pause->edit->clear cycles with zero tombstone growth and clean undo/redo", () => {
    createRoot((dispose) => {
      const { replica, ids, board, readDoc, apply, pl } = makeHarness(false);

      // Create a live annotation (must survive all 25 pause-edit clear cycles per D1).
      const calloutId = hexId(9001);
      apply([
        {
          Create: {
            id: calloutId,
            record: {
              Callout: { scene: ids.scene, pos: { x: 50, y: 60 }, text: "hold mid", color: null, side: "Below" },
            },
          },
        },
      ]);

      const doCycle = (sec: number) => {
        const clock = pauseClock(sec);
        // 1. Move hero 0
        apply(pauseMoveOps(board.records, ids.scene, clock, [{ id: pl(0).id, pos: { x: 100 + sec, y: 200 } }]));
        // 2. Toggle objective
        const objUpsert = liveObjUpsert(board.records, BOARD_ID, MATCH_ID, ids.scene, new Map());
        apply(objUpsert(WALKER.key, "Destroyed"));
        // 3. Drag wave
        apply(liveWaveUpsertOps(board.records, BOARD_ID, MATCH_ID, ids.scene, clock, new Map(), "yellow", 650));
        // 4. Write SceneState (door)
        const prep = preparePausedSceneState(board, BOARD_ID, MATCH_ID, ids.scene);
        const doorOps = placeDoorwayOps(
          { scene: ids.scene, state: prep.state, mint: () => hexId(99999), seed: [] },
          "amber",
          { x: 10, y: 10 },
        );
        apply([...prep.prefix, ...doorOps]);

        // Verify deterministic IDs are in use and live.
        expect(board.records[liveSceneStateId(BOARD_ID, MATCH_ID)]?.deleted).toBe(false);
        expect(board.records[liveWaveId(BOARD_ID, MATCH_ID, "yellow")]?.deleted).toBe(false);
        expect(board.records[liveObjId(BOARD_ID, MATCH_ID, WALKER.key)]?.deleted).toBe(false);
        expect(hasPauseEntityOverrides(board.records, ids.scene, false, sec)).toBe(true);

        // Silent clear (simulating Play / scrub) + dropHistoryFor.
        const chunks = clearPauseOverridesOps(board.records, ids.scene);
        expect(chunks.length).toBeGreaterThan(0);
        for (const ch of chunks) apply(ch, true);
        const dropRes = JSON.parse(replica.dropHistoryFor(JSON.stringify(liveEntityRecordIds(board.records, ids.scene))));
        expect(dropRes.canRedo).toBe(false);
        expect(dropRes.canUndo).toBe(true); // callout survives!
      };

      doCycle(10);
      const totalAfterFirstCycle = Object.keys(readDoc()).length;

      for (let i = 1; i < 25; i++) {
        doCycle(10 + i);
      }

      // Total record count (live + tombstones) MUST NOT GROW after cycle 1!
      expect(Object.keys(readDoc()).length).toBe(totalAfterFirstCycle);
      expect(hasPauseEntityOverrides(board.records, ids.scene, false, 34)).toBe(false);
      expect(hasLiveAnnotations(board.records, ids.scene)).toBe(true);

      // Undo removes live callout and leaves no pause edits on the undo stack.
      const undoRes = JSON.parse(replica.undo());
      expect(undoRes.refused).toBeNull();
      expect(readDoc()[calloutId]?.deleted).toBe(true);
      expect(undoRes.canUndo).toBe(false);
      dispose();
    });
  });

  it("emits Restore strictly before Set when resurrecting a tombstoned deterministic live entity", () => {
    createRoot((dispose) => {
      const { ids, board, apply } = makeHarness(false);
      const clock = pauseClock(12);
      apply(liveWaveUpsertOps(board.records, BOARD_ID, MATCH_ID, ids.scene, clock, new Map(), "blue", 300));
      for (const ch of clearPauseOverridesOps(board.records, ids.scene)) apply(ch, true);
      expect(board.records[liveWaveId(BOARD_ID, MATCH_ID, "blue")]?.deleted).toBe(true);

      const ops = liveWaveUpsertOps(board.records, BOARD_ID, MATCH_ID, ids.scene, clock, new Map(), "blue", 700);
      const restoreIdx = ops.findIndex((o) => "Restore" in o);
      const setIdx = ops.findIndex((o) => "Set" in o && "WavePos" in o.Set.value);
      expect(restoreIdx).toBeGreaterThanOrEqual(0);
      expect(setIdx).toBeGreaterThan(restoreIdx);
      apply(ops);
      const rec = board.records[liveWaveId(BOARD_ID, MATCH_ID, "blue")]!;
      expect(rec.deleted).toBe(false);
      expect("Wave" in rec.record && rec.record.Wave.t).toBe(700);
      dispose();
    });
  });

  it("liveEntityRecordIds includes tombstoned live entities and excludes live ink; isLiveEntityCreate classifies accurately", () => {
    createRoot((dispose) => {
      const { ids, board, readDoc, apply } = makeHarness(false);
      const strokeId = hexId(9002);
      apply([
        {
          Create: {
            id: strokeId,
            record: { Stroke: { scene: ids.scene, color: 0, width: 6, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] } },
          },
        },
        ...liveWaveUpsertOps(board.records, BOARD_ID, MATCH_ID, ids.scene, 10, new Map(), "green", 500),
      ]);
      for (const ch of clearPauseOverridesOps(board.records, ids.scene)) apply(ch, true);

      const entityIds = new Set(liveEntityRecordIds(board.records, ids.scene));
      expect(entityIds.has(ids.scene)).toBe(true);
      expect(entityIds.has(ids.players[0]![0])).toBe(true);
      expect(entityIds.has(liveWaveId(BOARD_ID, MATCH_ID, "green"))).toBe(true); // tombstoned wave included!
      expect(entityIds.has(strokeId)).toBe(false); // live ink excluded!

      const recMap = new Map(Object.entries(readDoc()));
      expect(
        isLiveEntityCreate(BOARD_ID, recMap, {
          kind: "Edit",
          ops: [{ Create: { id: liveWaveId(BOARD_ID, MATCH_ID, "green"), record: { Wave: { scene: ids.scene, lane: "green", t: 500 } } } }],
        }),
      ).toBe(true);
      expect(
        isLiveEntityCreate(BOARD_ID, recMap, {
          kind: "Edit",
          ops: [{ Create: { id: strokeId, record: { Stroke: { scene: ids.scene, color: 0, width: 6, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] } } } }],
        }),
      ).toBe(false);
      dispose();
    });
  });
});

describe("frame seeding for doors and #55 objective health while paused (B4)", () => {
  it("removing the last seeded replay doorway writes has_doors: true, rows: 42 with empty decoded doors", () => {
    createRoot((dispose) => {
      const { ids, board, apply } = makeHarness(false);
      const seedDoors: DoorNow[] = [{ id: 0, team: "amber", at: { x: -100, y: -100 }, role: "unpaired", partner: null, inSight: true }];
      const prep = preparePausedSceneState(board, BOARD_ID, MATCH_ID, ids.scene);
      const ops = removeDoorwayOps({ scene: ids.scene, state: prep.state, mint: () => hexId(99998), seed: seedDoors }, 0);
      apply([...prep.prefix, ...ops]);

      const ss = board.records[liveSceneStateId(BOARD_ID, MATCH_ID)]!;
      expect(ss.deleted).toBe(false);
      if ("SceneState" in ss.record) {
        expect(ss.record.SceneState.more?.has_doors).toBe(true);
        expect(ss.record.SceneState.more?.rows).toBe(42);
        expect(decodeDoors(ss.record.SceneState.more?.doors)).toEqual([]);
      }
      dispose();
    });
  });

  it("raising the only damaged seeded replay objective back to 100% writes has_obj_health: true, rows: 33 with empty decoded health", () => {
    createRoot((dispose) => {
      const { ids, board, apply } = makeHarness(false);
      const seedHealth = new Map<string, { pct: number; stage?: 1 | 2 } | null>([[WALKER.key, { pct: 60 }]]);
      const prep = preparePausedSceneState(board, BOARD_ID, MATCH_ID, ids.scene);
      const ops = setObjectiveHealthOps(
        {
          scene: ids.scene,
          state: prep.state,
          objectives: new Map(),
          markers: MARKERS,
          mint: () => hexId(99997),
          seed: seedHealth,
          upsertObjective: liveObjUpsert(board.records, BOARD_ID, MATCH_ID, ids.scene, new Map()),
        },
        WALKER,
        100,
      );
      apply([...prep.prefix, ...ops]);

      const ss = board.records[liveSceneStateId(BOARD_ID, MATCH_ID)]!;
      expect(ss.deleted).toBe(false);
      if ("SceneState" in ss.record) {
        expect(ss.record.SceneState.more?.has_obj_health).toBe(true);
        expect(ss.record.SceneState.more?.rows).toBe(33);
        expect(decodeObjHealth(ss.record.SceneState.more?.obj_health, MARKERS).size).toBe(0);
      }
      dispose();
    });
  });
});

describe("fromPausedPlayer overlay & Scene.clock scoping (B6, B7, B8)", () => {
  it("overlays hero, objective, #55 obj_health, wave, and door overrides only when paused at matching clock", () => {
    createRoot((dispose) => {
      const tl = makeTimeline();
      const [t, setT] = createSignal(2);
      const [playing, setPlaying] = createSignal(false);
      const { ids, board, apply, pl } = makeHarness(false);

      const base = fromTimeline({ tl: () => tl, t, markers: () => MARKERS });
      const paused = fromPausedPlayer(
        base,
        board,
        () => ids.scene,
        () => !playing(),
        () => pauseClock(t()),
        () => MARKERS,
      );

      // Before any edits: passes through replay values.
      expect(paused.hero("amber-0").pos()).toEqual({ x: 140, y: 240 });
      expect(paused.hero("amber-1").alive()).toBe(false);
      expect(paused.marker(WALKER.key).health()).toEqual({ pct: 60 });
      expect(paused.scene().doors()).toHaveLength(1);
      expect(paused.scene().deaths().some((d) => d.slot === "amber-1")).toBe(true);

      // Edit hero 0 (move, souls, ult, sight, rename), hero 1 (revive), hero 2 (kill+respawn), hero 3 (swap).
      const clock = pauseClock(2);
      apply([
        ...pauseMoveOps(board.records, ids.scene, clock, [{ id: pl(0).id, pos: { x: 500, y: -400 } }]),
        ...pauseSoulsOps(board.records, ids.scene, clock, pl(0), 15000),
        ...pauseUltOps(board.records, ids.scene, clock, pl(0), 75),
        ...pauseToggleSightOps(board.records, ids.scene, clock, pl(0), true), // currentlyInSight=true => unseen=true
        ...pauseRenameOps(board.records, ids.scene, clock, pl(0), "Coach"),
        ...pauseReviveOps(board.records, ids.scene, clock, pl(1), { x: -300, y: 300 }),
        ...pauseKillOps(board.records, ids.scene, clock, pl(2), { x: 160, y: 260 }),
        ...pauseHeroOps(board.records, ids.scene, clock, pl(3), 69),
      ]);
      apply(pauseRespawnOps(board.records, ids.scene, clock, pl(2), 33));

      // Edit objective status, #55 health, wave, and remove replay door.
      apply(liveObjUpsert(board.records, BOARD_ID, MATCH_ID, ids.scene, new Map())(GUARDIAN.key, "Destroyed"));
      apply(liveWaveUpsertOps(board.records, BOARD_ID, MATCH_ID, ids.scene, clock, new Map(), "yellow", 800));
      const prep = preparePausedSceneState(board, BOARD_ID, MATCH_ID, ids.scene);
      const seedH = seedObjHealthMap(tl, 2, MARKERS);
      apply([
        ...prep.prefix,
        ...setObjectiveHealthOps(
          {
            scene: ids.scene,
            state: prep.state,
            objectives: new Map(),
            markers: MARKERS,
            mint: () => hexId(99996),
            seed: seedH,
            upsertObjective: liveObjUpsert(board.records, BOARD_ID, MATCH_ID, ids.scene, new Map()),
          },
          WALKER,
          25,
        ),
      ]);
      const prep2 = preparePausedSceneState(board, BOARD_ID, MATCH_ID, ids.scene);
      apply([
        ...prep2.prefix,
        ...removeDoorwayOps({ scene: ids.scene, state: prep2.state, mint: () => hexId(99995), seed: paused.scene().doors() }, 0),
      ]);

      // Verify overlays while paused at t = 2.
      expect(paused.hero("amber-0").pos()).toEqual({ x: 500, y: -400 });
      expect(paused.hero("amber-0").souls()).toBe(15000);
      expect(paused.hero("amber-0").ult()).toBe(75);
      expect(paused.hero("amber-0").inSight()).toBe(false);
      expect(paused.hero("amber-0").name()).toBe("Coach");

      expect(paused.hero("amber-1").alive()).toBe(true);
      expect(paused.hero("amber-1").health()).toBe(100);
      expect(paused.hero("amber-1").pos()).toEqual({ x: -300, y: 300 });
      expect(paused.scene().deaths().some((d) => d.slot === "amber-1")).toBe(false);

      expect(paused.hero("amber-2").alive()).toBe(false);
      expect(paused.hero("amber-2").health()).toBe(0);
      expect(paused.hero("amber-2").respawn()).toBe(33);

      expect(paused.hero("amber-3").hero()).toBe(69);

      expect(paused.marker(GUARDIAN.key).status()).toBe("Destroyed");
      expect(paused.marker(WALKER.key).health()).toEqual({ pct: 25 });
      expect(paused.lane("yellow").split()).toBe(800);
      expect(paused.scene().doors()).toEqual([]);

      // While playing: overlay MUST be completely bypassed!
      setPlaying(true);
      expect(paused.hero("amber-0").pos()).toEqual({ x: 140, y: 240 });
      expect(paused.hero("amber-1").alive()).toBe(false);
      expect(paused.marker(WALKER.key).health()).toEqual({ pct: 60 });
      expect(paused.scene().doors()).toHaveLength(1);

      // Paused at a DIFFERENT timestamp (t = 3 vs liveScene.clock = 2): overlay MUST be bypassed!
      setPlaying(false);
      setT(3);
      expect(paused.hero("amber-0").pos()).toEqual({ x: 160, y: 260 });
      expect(paused.marker(WALKER.key).health()).toEqual({ pct: 60 });
      expect(hasPauseEntityOverrides(board.records, ids.scene, false, 3)).toBe(false);

      dispose();
    });
  });

  it("exposes has('doors'), has('obj_health'), has('sight') when paused edits introduce them on metadata tier", () => {
    createRoot((dispose) => {
      const metaTl = makeTimeline({ tier: undefined, source: "api", doors: undefined, objective_health: undefined });
      const { ids, board, apply, pl } = makeHarness(false);
      const base = fromTimeline({ tl: () => metaTl, t: () => 2, markers: () => MARKERS });
      const paused = fromPausedPlayer(
        base,
        board,
        () => ids.scene,
        () => true,
        () => 2,
        () => MARKERS,
      );
      expect(paused.has("doors")).toBe(false);
      expect(paused.has("obj_health")).toBe(false);
      expect(paused.has("sight")).toBe(false);

      const prep = preparePausedSceneState(board, BOARD_ID, MATCH_ID, ids.scene);
      apply([
        ...prep.prefix,
        ...placeDoorwayOps({ scene: ids.scene, state: prep.state, mint: () => hexId(99994), seed: [] }, "amber", { x: 0, y: 0 }),
        ...pauseToggleSightOps(board.records, ids.scene, 2, pl(0), true),
      ]);
      const prep2 = preparePausedSceneState(board, BOARD_ID, MATCH_ID, ids.scene);
      apply([
        ...prep2.prefix,
        ...setObjectiveHealthOps(
          {
            scene: ids.scene,
            state: prep2.state,
            objectives: new Map(),
            markers: MARKERS,
            mint: () => hexId(99993),
            seed: new Map(),
          },
          WALKER,
          40,
        ),
      ]);

      expect(paused.has("doors")).toBe(true);
      expect(paused.has("obj_health")).toBe(true);
      expect(paused.has("sight")).toBe(true);
      dispose();
    });
  });
});

describe("matchSceneOps with PauseOverrides (B5)", () => {
  it("bakes hero edits, builds, sight, hero swap, Stage2 patron, seeded obj_health, doors, and waves within tx limits", () => {
    createRoot((dispose) => {
      const tl = makeTimeline();
      const { ids, board, apply, rosterSlots, pl } = makeHarness(false);
      const clock = pauseClock(2);

      apply([
        ...pauseMoveOps(board.records, ids.scene, clock, [{ id: pl(0).id, pos: { x: 400, y: -300 } }]),
        ...pauseSoulsOps(board.records, ids.scene, clock, pl(0), 22000),
        ...pauseUltOps(board.records, ids.scene, clock, pl(0), 60),
        ...pauseToggleSightOps(board.records, ids.scene, clock, pl(0), true),
        ...pauseRenameOps(board.records, ids.scene, clock, pl(0), "Carry"),
        ...pauseReviveOps(board.records, ids.scene, clock, pl(1), { x: -120, y: 220 }),
        ...pauseKillOps(board.records, ids.scene, clock, pl(2), { x: 160, y: 260 }),
        ...pauseRespawnOps(board.records, ids.scene, clock, pl(2), 42),
        ...pauseHeroOps(board.records, ids.scene, clock, pl(3), 52),
        ...liveObjUpsert(board.records, BOARD_ID, MATCH_ID, ids.scene, new Map())(PATRON.key, "Stage2"),
        ...liveObjUpsert(board.records, BOARD_ID, MATCH_ID, ids.scene, new Map())(MIDBOSS.key, "Destroyed"),
        ...liveWaveUpsertOps(board.records, BOARD_ID, MATCH_ID, ids.scene, clock, new Map(), "yellow", 720),
      ]);
      const prep = preparePausedSceneState(board, BOARD_ID, MATCH_ID, ids.scene);
      apply([
        ...prep.prefix,
        ...placeDoorwayOps({ scene: ids.scene, state: prep.state, mint: () => hexId(99992), seed: [] }, "amber", { x: 10, y: 20 }),
      ]);
      const prep2 = preparePausedSceneState(board, BOARD_ID, MATCH_ID, ids.scene);
      apply([
        ...prep2.prefix,
        ...setObjectiveHealthOps(
          {
            scene: ids.scene,
            state: prep2.state,
            objectives: new Map(),
            markers: MARKERS,
            mint: () => hexId(99991),
            seed: new Map([[WALKER.key, { pct: 60 }]]),
            upsertObjective: liveObjUpsert(board.records, BOARD_ID, MATCH_ID, ids.scene, new Map()),
          },
          WALKER,
          35,
        ),
      ]);

      const overrides: PauseOverrides = collectPauseOverrides(board.records, ids.scene, false, 2)!;
      expect(overrides).toBeDefined();

      let n = 5000;
      const saved = matchSceneOps(rosterSlots, [], undefined, tl, 2, MARKERS, () => hexId(n++), [], {
        source: sourceOf(tl),
        overrides,
      });

      expect(saved.ops.length).toBeLessThanOrEqual(LIMITS.max_ops_per_tx);
      expect(opsBytes(saved.ops)).toBeLessThan(LIMITS.max_tx_bytes);

      const createdScene = saved.ops.find((o) => "Create" in o && "Scene" in o.Create.record);
      expect(
        createdScene && "Create" in createdScene && "Scene" in createdScene.Create.record && createdScene.Create.record.Scene.clock,
      ).toBe(2);

      const players = saved.ops.flatMap((o) => ("Create" in o && "PlayerState" in o.Create.record ? [o.Create.record.PlayerState] : []));
      expect(players).toHaveLength(12);

      // Hero 0: moved, souls, ult, unseen, renamed, and STILL keeps build items!
      const h0 = players.find((p) => p.slot === hexId(100))!;
      expect(h0.pos).toEqual({ x: 400, y: -300 });
      expect(h0.souls).toBe(22000);
      expect(h0.ult_cooldown).toBe(60);
      expect(h0.more?.unseen).toBe(true);
      expect(h0.more?.name).toBe("Carry");
      expect(h0.more?.items).toBeDefined();

      // Hero 1: revived from timeline death -> alive: true, respawn cleared, health: 100
      const h1 = players.find((p) => p.slot === hexId(101))!;
      expect(h1.alive).toBe(true);
      expect(h1.respawn ?? null).toBeNull();
      expect(h1.pos).toEqual({ x: -120, y: 220 });
      expect(h1.more?.health).toBe(100);

      // Hero 2: killed while paused -> alive: false, respawn: 42, health stripped
      const h2 = players.find((p) => p.slot === hexId(102))!;
      expect(h2.alive).toBe(false);
      expect(h2.respawn).toBe(42);
      expect(h2.more?.health).toBeUndefined();

      // Hero 3: swapped hero -> more.hero === 52 and old build keys omitted
      const h3 = players.find((p) => p.slot === hexId(103))!;
      expect(h3.more?.hero).toBe(52);
      expect(h3.more?.items).toBeUndefined();

      // Objectives: Patron Stage2 + Mid-Boss Destroyed
      const objs = saved.ops.flatMap((o) => ("Create" in o && "ObjectiveState" in o.Create.record ? [o.Create.record.ObjectiveState] : []));
      expect(objs.find((o) => o.key === PATRON.key)?.status).toBe("Stage2");
      expect(objs.find((o) => o.key === MIDBOSS.key)?.status).toBe("Destroyed");

      // Wave override saved
      const waves = saved.ops.flatMap((o) => ("Create" in o && "Wave" in o.Create.record ? [o.Create.record.Wave] : []));
      expect(waves.find((w) => w.lane === "yellow")?.t).toBe(720);

      // SceneState: seeded doors + seeded obj_health + has_sight
      const ss = saved.ops.flatMap((o) => ("Create" in o && "SceneState" in o.Create.record ? [o.Create.record.SceneState] : []))[0]!;
      expect(ss.more?.has_doors).toBe(true);
      expect(decodeDoors(ss.more?.doors)).toEqual([{ id: 0, team: "amber", at: { x: 10, y: 20 }, role: "unpaired", partner: null, inSight: true }]);
      expect(ss.more?.has_obj_health).toBe(true);
      expect(decodeObjHealth(ss.more?.obj_health, MARKERS).get(WALKER.key)).toEqual({ pct: 35 });
      expect(ss.more?.has_sight).toBe(true);
      dispose();
    });
  });

  it("clears stale replay obj_health when an objective is toggled without seeded obj_health", () => {
    createRoot((dispose) => {
      const tl = makeTimeline();
      const { rosterSlots } = makeHarness(false);
      const overrides: PauseOverrides = {
        players: new Map(),
        objectives: new Map([[WALKER.key, "Destroyed"]]),
        waves: new Map(),
      };
      let n = 6000;
      const saved = matchSceneOps(rosterSlots, [], undefined, tl, 2, MARKERS, () => hexId(n++), [], {
        source: sourceOf(tl),
        overrides,
      });
      const ss = saved.ops.flatMap((o) => ("Create" in o && "SceneState" in o.Create.record ? [o.Create.record.SceneState] : []))[0]!;
      // WALKER was 60% in replay, toggled to Destroyed -> its stale 60% entry must be dropped from obj_health.
      expect(decodeObjHealth(ss.more?.obj_health, MARKERS).has(WALKER.key)).toBe(false);
      dispose();
    });
  });

  it("bakes seeded doors and obj_health even on metadata-tier matches", () => {
    createRoot((dispose) => {
      const metaTl = makeTimeline({ tier: undefined, source: "api", doors: undefined, objective_health: undefined });
      const { rosterSlots } = makeHarness(false);
      const overrides: PauseOverrides = {
        players: new Map(),
        objectives: new Map(),
        waves: new Map(),
        state: {
          rows: 42,
          has_doors: true,
          doors: encodeDoors([{ id: 0, team: "amber", at: { x: 10, y: 20 }, role: "unpaired", partner: null, inSight: true }]),
          has_obj_health: true,
          obj_health: encodeObjHealth(new Map([[WALKER.key, { pct: 45 }]]), MARKERS).ints,
        } as More,
      };
      let n = 7000;
      const saved = matchSceneOps(rosterSlots, [], undefined, metaTl, 2, MARKERS, () => hexId(n++), [], {
        source: sourceOf(metaTl),
        overrides,
      });
      const ss = saved.ops.flatMap((o) => ("Create" in o && "SceneState" in o.Create.record ? [o.Create.record.SceneState] : []))[0]!;
      expect(ss.more?.has_doors).toBe(true);
      expect(ss.more?.has_obj_health).toBe(true);
      expect(decodeObjHealth(ss.more?.obj_health, MARKERS).get(WALKER.key)).toEqual({ pct: 45 });
      dispose();
    });
  });
});

describe("playback clock follow while paused (M5)", () => {
  it("snaps a paused follower on any >= 0.01s timestamp difference while keeping playing slack", () => {
    const pausedMine = { t: 10.0, playing: false, speed: 1, at: 0 };
    expect(follow(pausedMine, { t: 10.2, playing: false, speed: 1, at: 0 }, 0, 100)).toEqual({
      t: 10.2,
      playing: false,
      speed: 1,
      at: 0,
    });
    expect(follow(pausedMine, { t: 10.004, playing: false, speed: 1, at: 0 }, 0, 100)).toBe(pausedMine);
    const playingMine = { t: 10.0, playing: true, speed: 1, at: 0 };
    expect(follow(playingMine, { t: 10.2, playing: true, speed: 1, at: 0 }, 0, 100)).toBe(playingMine);
  });
});

const sceneClockOf = (records: Record<RecordId, Entry | undefined>, sceneId: RecordId) => {
  const e = records[sceneId];
  return e && "Scene" in e.record ? (e.record.Scene.clock ?? null) : undefined;
};

const sessionRecords = (s: BoardSession): Record<RecordId, Entry | undefined> =>
  Object.fromEntries(s.records.entries());

const sessionBoardAdapter = (s: BoardSession, rosterSlots: Array<{ id: RecordId; slot: RosterSlot }>): MutablePausedBoard => ({
  get records() {
    return sessionRecords(s);
  },
  roster: () => rosterSlots,
  playersIn: (sc) =>
    [...s.records.entries()].flatMap(([id, e]) =>
      !e.deleted && "PlayerState" in e.record && e.record.PlayerState.scene === sc ? [{ id, state: e.record.PlayerState }] : [],
    ),
  inScene: (kind, sc) =>
    [...s.records.entries()].flatMap(([id, e]) => {
      if (e.deleted) return [];
      const body = (e.record as Record<string, { scene?: RecordId }>)[kind];
      return body?.scene === sc ? [[id, e.record] as const] : [];
    }),
  rowsIn: <T extends { scene: RecordId }>(kind: string, sc: RecordId | undefined) =>
    [...s.records.entries()].flatMap(([id, e]) => {
      if (e.deleted) return [];
      const body = (e.record as unknown as Record<string, T | undefined>)[kind];
      return body && body.scene === sc ? [{ id, r: body }] : [];
    }),
  edit: (ops) => s.edit(ops),
  editSilent: (ops) => s.editSilent(ops),
  ensure: (ops) => s.ensure(ops),
  dropHistoryFor: (ids) => s.dropHistoryFor(ids),
});

/**
 * Deterministic in-memory authoritative hub driving two real `BoardSession` instances (and real
 * WASM `BoardReplica`s + Rust `crates/schema` rules) with exact control over `Submit` delivery order.
 */
async function createTwoClientHub(baseDoc: Doc) {
  const auth = new BoardReplica(newClientId(), newClientSecret(), JSON.stringify({ seq: 0, doc: baseDoc }));
  let seq = 0;
  const log: Array<{ seq: number; tx: Tx }> = [];
  const decided = new Set<string>();
  type Peer = {
    name: "A" | "B";
    peerId: number;
    socket: SocketLike;
    queue: Tx[];
    online: boolean;
  };
  const peers: Record<"A" | "B", Peer | undefined> = { A: undefined, B: undefined };
  const persists: Record<"A" | "B", MemoryPersist> = { A: new MemoryPersist(), B: new MemoryPersist() };
  const heldConnect: Record<"A" | "B", (() => void) | undefined> = { A: undefined, B: undefined };
  const holdReconnect: Record<"A" | "B", boolean> = { A: false, B: false };
  const rebaseNextHello: Record<"A" | "B", { decidedBelow: number } | undefined> = { A: undefined, B: undefined };

  const sendOut = (p: Peer, frame: WireOut) => {
    if (p.online) p.socket.onmessage?.({ data: JSON.stringify(frame) });
  };

  const makeSession = (name: "A" | "B", peerId: number): BoardSession =>
    new BoardSession({
      wsUrl: "ws://in-memory",
      board: BOARD_ID,
      token: "tok",
      persist: persists[name],
      minDelayMs: 5,
      maxDelayMs: 10,
      openSocket: () => {
        const sock: SocketLike = {
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
          send: (raw: string) => {
            const frame = JSON.parse(raw) as WireIn;
            const peer = peers[name]!;
            if (frame.t === "auth") {
              sendOut(peer, {
                t: "ready",
                peer: peerId,
                role: "edit",
                head: seq,
                base: { seq: 0, doc: baseDoc },
                kind: "board",
              });
            } else if (frame.t === "msg" && "Hello" in frame.msg) {
              const rb = rebaseNextHello[name];
              if (rb) {
                rebaseNextHello[name] = undefined;
                sendOut(peer, {
                  t: "msg",
                  msg: { Rebase: { doc: JSON.parse(auth.view()) as Doc, seq, decided_below: rb.decidedBelow } },
                });
              } else {
                for (const entry of log) {
                  if (entry.seq > frame.msg.Hello.last_seq) {
                    sendOut(peer, { t: "msg", msg: { Entry: entry } });
                  }
                }
              }
            } else if (frame.t === "msg" && "Submit" in frame.msg) {
              peer.queue.push(frame.msg.Submit);
            }
          },
          close: () => {
            if (peers[name]?.socket === sock) peers[name]!.online = false;
          },
        };
        const prevQueue = peers[name]?.queue ?? [];
        const openNow = () => {
          peers[name] = { name, peerId, socket: sock, queue: prevQueue, online: true };
          sock.onopen?.({});
        };
        if (holdReconnect[name]) {
          peers[name] = { name, peerId, socket: sock, queue: prevQueue, online: false };
          heldConnect[name] = openNow;
        } else {
          peers[name] = { name, peerId, socket: sock, queue: prevQueue, online: true };
          queueMicrotask(() => sock.onopen?.({}));
        }
        return sock;
      },
    });

  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  };

  const sessions: { a: BoardSession; b: BoardSession } = {
    a: makeSession("A", 1),
    b: makeSession("B", 2),
  };
  await sessions.a.start();
  await sessions.b.start();
  await flush();

  const deliverOne = (name: "A" | "B"): boolean => {
    const peer = peers[name]!;
    const tx = peer.queue.shift();
    if (!tx) return false;
    const key = `${tx.client}:${tx.cseq}`;
    // Match real server authority.rs: ignore resent Submits already decided on a prior connection.
    if (decided.has(key)) return true;
    decided.add(key);
    const res = JSON.parse(auth.edit_silent(JSON.stringify(tx.ops))) as { refused: string | null };
    if (res.refused) {
      sendOut(peer, { t: "msg", msg: { Rejected: { cseq: tx.cseq, reason: res.refused as never } } });
      return true;
    }
    seq += 1;
    const entry = { seq, tx };
    log.push(entry);
    for (const p of Object.values(peers)) if (p && p.online) sendOut(p, { t: "msg", msg: { Entry: entry } });
    return true;
  };

  const deliverAll = async (name: "A" | "B") => {
    await flush();
    while (deliverOne(name)) await flush();
  };

  const drop = async (name: "A" | "B") => {
    holdReconnect[name] = true;
    const peer = peers[name]!;
    peer.online = false;
    peer.socket.onclose?.({});
    await flush();
  };

  const reconnect = async (name: "A" | "B", opts?: { rebase?: { decidedBelow: number } }) => {
    if (opts?.rebase) rebaseNextHello[name] = opts.rebase;
    holdReconnect[name] = false;
    // Wait until BoardSession's retry timer invokes openSocket if it hasn't yet.
    for (let i = 0; i < 20 && !heldConnect[name]; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const fn = heldConnect[name];
    heldConnect[name] = undefined;
    fn?.();
    await flush();
  };

  const reload = async (name: "A" | "B", opts?: { rebase?: { decidedBelow: number } }) => {
    const key = name === "A" ? "a" : "b";
    sessions[key].stop();
    holdReconnect[name] = false;
    heldConnect[name] = undefined;
    if (opts?.rebase) rebaseNextHello[name] = opts.rebase;
    const next = makeSession(name, name === "A" ? 1 : 2);
    sessions[key] = next;
    await next.start();
    await flush();
    return next;
  };

  const settle = async () => {
    for (let round = 0; round < 20; round++) {
      await flush();
      let moved = false;
      while (deliverOne("A")) moved = true;
      while (deliverOne("B")) moved = true;
      if (!moved && sessions.a.status.kind === "saved" && sessions.b.status.kind === "saved") break;
    }
    await flush();
  };

  return {
    get a() {
      return sessions.a;
    },
    get b() {
      return sessions.b;
    },
    persists,
    flush,
    deliverOne,
    deliverAll,
    drop,
    reconnect,
    reload,
    settle,
    stop: () => {
      sessions.a.stop();
      sessions.b.stop();
    },
  };
}

describe("adversarial review regressions (clock CAS + lost-race rollback, tombstone SceneState race, no-op isolation, undo pruning, fallback bake)", () => {
  it("Race 1: first-edit race (20s vs 60s, different heroes + 2 consecutive in-flight edits) rolls back loser entities & undo stack", async () => {
    const base = makeHarness(false);
    const baseDoc = JSON.parse(base.replica.view()) as Doc;
    const ids = base.ids;
    const amber0 = ids.players[0]![0];
    const sapph0 = ids.players[6]![0];
    const hub = await createTwoClientHub(baseDoc);
    try {
      // Coach A (20s) moves Amber-0; Coach B (60s) makes TWO consecutive moves on Sapphire-0 before either lands.
      const aOps = pauseMoveOps(sessionRecords(hub.a), ids.scene, 20, [{ id: amber0, pos: { x: 200, y: 200 } }]);
      const bOps1 = pauseMoveOps(sessionRecords(hub.b), ids.scene, 60, [{ id: sapph0, pos: { x: 600, y: 600 } }]);
      expect(hub.a.edit(aOps)).toBe(true);
      expect(hub.b.edit(bOps1)).toBe(true);
      const bOps2 = pauseMoveOps(sessionRecords(hub.b), ids.scene, 60, [{ id: sapph0, pos: { x: 650, y: 650 } }]);
      expect(hub.b.edit(bOps2)).toBe(true);
      await hub.flush();

      // Server accepts A first, then both of B's in-flight edits, then B's LIFO rollback settles.
      await hub.deliverAll("A");
      await hub.deliverAll("B");
      await hub.settle();

      for (const s of [hub.a, hub.b]) {
        const recs = sessionRecords(s);
        expect(sceneClockOf(recs, ids.scene)).toBe(20);
        const aRec = recs[amber0]!.record;
        const bRec = recs[sapph0]!.record;
        expect("PlayerState" in aRec && aRec.PlayerState.placed).toBe(true);
        expect("PlayerState" in aRec && aRec.PlayerState.pos).toEqual({ x: 200, y: 200 });
        expect("PlayerState" in bRec && bRec.PlayerState.placed).toBe(false);
        expect("PlayerState" in bRec && bRec.PlayerState.pos).toEqual({ x: 0, y: 0 });
        expect(s.problems).toEqual([]);
      }
      // Loser B's dead 60s edits were removed from undo; winner A keeps undo.
      expect(hub.b.canUndo).toBe(false);
      expect(hub.a.canUndo).toBe(true);

      // Verify fromPausedPlayer at 20s shows A's Amber-0 move and pure timeline for Sapphire-0.
      createRoot((dispose) => {
        const tl = makeTimeline();
        const ms = fromPausedPlayer(
          fromTimeline({ tl: () => tl, t: () => 20, markers: () => MARKERS }),
          sessionBoardAdapter(hub.a, base.rosterSlots),
          () => ids.scene,
          () => true,
          () => 20,
          () => MARKERS,
        );
        expect(ms.hero("amber-0").pos()).toEqual({ x: 200, y: 200 });
        expect(ms.hero("sapphire-0").pos()).not.toEqual({ x: 600, y: 600 });
        expect(ms.hero("sapphire-0").pos()).not.toEqual({ x: 650, y: 650 });
        dispose();
      });
    } finally {
      hub.stop();
    }
  });

  it("Race 2a: first-edit race (20s vs 60s) on the SAME hero preserves winner's position when loser rolls back", async () => {
    const base = makeHarness(false);
    const baseDoc = JSON.parse(base.replica.view()) as Doc;
    const ids = base.ids;
    const amber0 = ids.players[0]![0];
    const hub = await createTwoClientHub(baseDoc);
    try {
      const aOps = pauseMoveOps(sessionRecords(hub.a), ids.scene, 20, [{ id: amber0, pos: { x: 200, y: 200 } }]);
      const bOps = pauseMoveOps(sessionRecords(hub.b), ids.scene, 60, [{ id: amber0, pos: { x: 600, y: 600 } }]);
      expect(hub.a.edit(aOps)).toBe(true);
      expect(hub.b.edit(bOps)).toBe(true);
      await hub.flush();

      await hub.deliverAll("A");
      await hub.deliverAll("B");
      await hub.settle();

      for (const s of [hub.a, hub.b]) {
        const recs = sessionRecords(s);
        expect(sceneClockOf(recs, ids.scene)).toBe(20);
        const aRec = recs[amber0]!.record;
        expect("PlayerState" in aRec && aRec.PlayerState.placed).toBe(true);
        expect("PlayerState" in aRec && aRec.PlayerState.pos).toEqual({ x: 200, y: 200 });
        expect(s.problems).toEqual([]);
      }
      expect(hub.a.canUndo).toBe(true);
      expect(hub.b.canUndo).toBe(false);
    } finally {
      hub.stop();
    }
  });

  it("Race 2b: first-edit race (20s vs 60s) on the SAME tombstoned SceneState reverts loser doors without deleting or clobbering winner obj_health", async () => {
    const base = makeHarness(false);
    const ids = base.ids;
    // Create & clear SceneState so ssId is a clean tombstone at clock = null.
    const prep0 = preparePausedSceneState(base.board, BOARD_ID, MATCH_ID, ids.scene);
    base.apply([
      ...pauseClockOps(base.board.records, ids.scene, 10),
      ...prep0.prefix,
      ...placeDoorwayOps({ scene: ids.scene, state: prep0.state, mint: () => hexId(8201), seed: [] }, "amber", { x: 10, y: 10 }),
    ]);
    for (const tx of clearPauseOverridesOps(base.board.records, ids.scene)) base.apply(tx, true);
    const ssId = liveSceneStateId(BOARD_ID, MATCH_ID);
    expect(base.board.records[ssId]?.deleted).toBe(true);

    const baseDoc = JSON.parse(base.replica.view()) as Doc;
    const hub = await createTwoClientHub(baseDoc);
    try {
      const boardA = sessionBoardAdapter(hub.a, base.rosterSlots);
      const boardB = sessionBoardAdapter(hub.b, base.rosterSlots);

      // Coach A (20s) restores SceneState with obj_health (WALKER = 45%, rows = 33).
      const prepA = preparePausedSceneState(boardA, BOARD_ID, MATCH_ID, ids.scene);
      const aOps = [
        ...pauseClockOps(boardA.records, ids.scene, 20),
        ...prepA.prefix,
        ...setObjectiveHealthOps(
          {
            scene: ids.scene,
            state: prepA.state,
            objectives: new Map(),
            markers: MARKERS,
            mint: () => hexId(8211),
            seed: new Map(),
            upsertObjective: liveObjUpsert(boardA.records, BOARD_ID, MATCH_ID, ids.scene, new Map()),
          },
          WALKER,
          45,
        ),
      ];
      // Coach B (60s) concurrently restores SceneState with a Doorman doorway (rows = 42).
      const prepB = preparePausedSceneState(boardB, BOARD_ID, MATCH_ID, ids.scene);
      const bOps = [
        ...pauseClockOps(boardB.records, ids.scene, 60),
        ...prepB.prefix,
        ...placeDoorwayOps({ scene: ids.scene, state: prepB.state, mint: () => hexId(8212), seed: [] }, "amber", { x: 50, y: 60 }),
      ];

      expect(hub.a.edit(aOps)).toBe(true);
      expect(hub.b.edit(bOps)).toBe(true);
      await hub.flush();

      await hub.deliverAll("A");
      await hub.deliverAll("B");
      await hub.settle();

      for (const s of [hub.a, hub.b]) {
        const recs = sessionRecords(s);
        expect(sceneClockOf(recs, ids.scene)).toBe(20);
        const ss = recs[ssId]!;
        expect(ss.deleted).toBe(false);
        expect("SceneState" in ss.record).toBe(true);
        if ("SceneState" in ss.record) {
          expect(ss.record.SceneState.more?.rows).toBe(33);
          expect(ss.record.SceneState.more?.has_obj_health).toBe(true);
          expect(decodeObjHealth(ss.record.SceneState.more?.obj_health, MARKERS).get(WALKER.key)).toEqual({ pct: 45 });
          expect(ss.record.SceneState.more?.has_doors).toBeUndefined();
          expect(ss.record.SceneState.more?.doors).toBeUndefined();
        }
        expect(s.problems).toEqual([]);
      }
      expect(hub.a.canUndo).toBe(true);
      expect(hub.b.canUndo).toBe(false);
    } finally {
      hub.stop();
    }
  });

  it("Race 3: stale 20s edit arriving after Play clears 20 -> null rolls back cleanly to baseline with pure timeline", async () => {
    const base = makeHarness(false);
    const ids = base.ids;
    const amber0 = ids.players[0]![0];
    const sapph0 = ids.players[6]![0];
    // Seed liveScene at clock = 20 with Amber-0 moved.
    base.apply(pauseMoveOps(base.board.records, ids.scene, 20, [{ id: amber0, pos: { x: 200, y: 200 } }]));
    const baseDoc = JSON.parse(base.replica.view()) as Doc;
    const hub = await createTwoClientHub(baseDoc);
    try {
      // Coach A (still paused at 20s) moves Sapphire-0 (includes no-op SetIf(20 -> 20) tag);
      // Coach B presses Play (clears 20 -> null + resets Amber-0).
      const aOps = pauseMoveOps(sessionRecords(hub.a), ids.scene, 20, [{ id: sapph0, pos: { x: 300, y: 300 } }]);
      expect(
        aOps.some(
          (o) =>
            "SetIf" in o &&
            "SceneClock" in o.SetIf.expect &&
            "SceneClock" in o.SetIf.value &&
            o.SetIf.expect.SceneClock === 20 &&
            o.SetIf.value.SceneClock === 20,
        ),
      ).toBe(true);
      const playTxs = clearPauseOverridesOps(sessionRecords(hub.b), ids.scene);

      expect(hub.a.edit(aOps)).toBe(true);
      for (const tx of playTxs) expect(hub.b.editSilent(tx)).toBe(true);
      await hub.flush();

      // Play lands first, then A's stale 20s edit lands -> A rolls back Sapphire-0!
      await hub.deliverAll("B");
      await hub.deliverAll("A");
      await hub.settle();

      for (const s of [hub.a, hub.b]) {
        const recs = sessionRecords(s);
        expect(sceneClockOf(recs, ids.scene)).toBeNull();
        const aRec = recs[amber0]!.record;
        const bRec = recs[sapph0]!.record;
        expect("PlayerState" in aRec && aRec.PlayerState.placed).toBe(false);
        expect("PlayerState" in bRec && bRec.PlayerState.placed).toBe(false);
        expect("PlayerState" in bRec && bRec.PlayerState.pos).toEqual({ x: 0, y: 0 });
        expect(hasPauseEntityOverrides(recs, ids.scene, false, 20)).toBe(false);
        expect(hasRawDirtyLiveEntities(recs, ids.scene)).toBe(false);
        expect(s.problems).toEqual([]);
      }
      expect(hub.a.canUndo).toBe(false);
      createRoot((dispose) => {
        const tl = makeTimeline();
        const pure = fromTimeline({ tl: () => tl, t: () => 2, markers: () => MARKERS });
        const ms = fromPausedPlayer(
          pure,
          sessionBoardAdapter(hub.a, base.rosterSlots),
          () => ids.scene,
          () => true,
          () => 20,
          () => MARKERS,
        );
        expect(ms.hero("amber-0").pos()).toEqual(pure.hero("amber-0").pos());
        expect(ms.hero("sapphire-0").pos()).toEqual(pure.hero("sapphire-0").pos());
        dispose();
      });
    } finally {
      hub.stop();
    }
  });

  it("Race 4: timestamp-switch race (20 -> 60 vs stale 20s edit, and Play vs 20 -> 60 switch) keeps winner clean and reverts loser", async () => {
    const base = makeHarness(false);
    const ids = base.ids;
    const amber0 = ids.players[0]![0];
    const sapph0 = ids.players[6]![0];
    base.apply(pauseMoveOps(base.board.records, ids.scene, 20, [{ id: amber0, pos: { x: 200, y: 200 } }]));
    const baseDoc = JSON.parse(base.replica.view()) as Doc;

    // 4a: Coach B switches 20 -> 60 and moves Sapphire-0 while Coach A's stale 20s edit on Amber-0 is in flight.
    const hub = await createTwoClientHub(baseDoc);
    try {
      const boardB = sessionBoardAdapter(hub.b, base.rosterSlots);
      const aOps = pauseMoveOps(sessionRecords(hub.a), ids.scene, 20, [{ id: amber0, pos: { x: 250, y: 250 } }]);
      expect(hub.a.edit(aOps)).toBe(true);

      prepareLivePauseEdit(boardB, ids.scene, 60);
      const bOps = pauseMoveOps(boardB.records, ids.scene, 60, [{ id: sapph0, pos: { x: 600, y: 600 } }]);
      expect(hub.b.edit(bOps)).toBe(true);
      await hub.flush();

      // B's switch + 60s edit land first, then A's stale 20s edit lands -> A reverts Amber-0 to baseline!
      await hub.deliverAll("B");
      await hub.deliverAll("A");
      await hub.settle();

      for (const s of [hub.a, hub.b]) {
        const recs = sessionRecords(s);
        expect(sceneClockOf(recs, ids.scene)).toBe(60);
        const aRec = recs[amber0]!.record;
        const bRec = recs[sapph0]!.record;
        expect("PlayerState" in aRec && aRec.PlayerState.placed).toBe(false);
        expect("PlayerState" in aRec && aRec.PlayerState.pos).toEqual({ x: 0, y: 0 });
        expect("PlayerState" in bRec && bRec.PlayerState.placed).toBe(true);
        expect("PlayerState" in bRec && bRec.PlayerState.pos).toEqual({ x: 600, y: 600 });
        expect(s.problems).toEqual([]);
      }
      expect(hub.a.canUndo).toBe(false);
      expect(hub.b.canUndo).toBe(true);
    } finally {
      hub.stop();
    }

    // 4b: Play (20 -> null) lands before Coach B's timestamp switch (20 -> null, then null -> 60) -> B stamps 60 cleanly!
    const hub2 = await createTwoClientHub(baseDoc);
    try {
      const boardB = sessionBoardAdapter(hub2.b, base.rosterSlots);
      for (const tx of clearPauseOverridesOps(sessionRecords(hub2.a), ids.scene)) {
        expect(hub2.a.editSilent(tx)).toBe(true);
      }
      prepareLivePauseEdit(boardB, ids.scene, 60);
      const bOps = pauseMoveOps(boardB.records, ids.scene, 60, [{ id: sapph0, pos: { x: 600, y: 600 } }]);
      expect(hub2.b.edit(bOps)).toBe(true);
      await hub2.flush();

      await hub2.deliverAll("A");
      await hub2.deliverAll("B");
      await hub2.settle();

      for (const s of [hub2.a, hub2.b]) {
        const recs = sessionRecords(s);
        expect(sceneClockOf(recs, ids.scene)).toBe(60);
        const bRec = recs[sapph0]!.record;
        expect("PlayerState" in bRec && bRec.PlayerState.placed).toBe(true);
        expect("PlayerState" in bRec && bRec.PlayerState.pos).toEqual({ x: 600, y: 600 });
        expect(s.problems).toEqual([]);
      }
      expect(hub2.b.canUndo).toBe(true);
    } finally {
      hub2.stop();
    }
  });

  it("Reconnect silent-cleanup (Major A): pending editSilent timestamp-switch tx across connected() is NOT re-tagged or rolled back on lost CAS", async () => {
    const base = makeHarness(false);
    const ids = base.ids;
    const amber0 = ids.players[0]![0];
    const sapph0 = ids.players[6]![0];
    // Start at clock = 20 with Amber-0 moved to (200, 200).
    base.apply(pauseMoveOps(base.board.records, ids.scene, 20, [{ id: amber0, pos: { x: 200, y: 200 } }]));
    const baseDoc = JSON.parse(base.replica.view()) as Doc;

    const hub = await createTwoClientHub(baseDoc);
    try {
      const boardA = sessionBoardAdapter(hub.a, base.rosterSlots);
      const boardB = sessionBoardAdapter(hub.b, base.rosterSlots);

      // Disconnect B, then B queues an editSilent timestamp-switch cleanup (20 -> null) while offline.
      await hub.drop("B");
      prepareLivePauseEdit(boardB, ids.scene, 60);
      await hub.flush();

      // Meanwhile A switches 20 -> null -> 40 and moves Sapphire-0 to (400, 400), settling on the server.
      prepareLivePauseEdit(boardA, ids.scene, 40);
      const aOps = pauseMoveOps(boardA.records, ids.scene, 40, [{ id: sapph0, pos: { x: 400, y: 400 } }]);
      expect(hub.a.edit(aOps)).toBe(true);
      await hub.deliverAll("A");

      // Reconnect B: connected() replays pending frames including B's editSilent clear (20 -> null).
      // Because clearPauseOverridesOps only clears to null, connected() never tags it in pauseEditClocks!
      await hub.reconnect("B");
      const tagged = (hub.b as unknown as { pauseEditClocks: Map<number, unknown> }).pauseEditClocks;
      expect(tagged.size).toBe(0);

      await hub.settle();

      for (const s of [hub.a, hub.b]) {
        const recs = sessionRecords(s);
        expect(sceneClockOf(recs, ids.scene)).toBe(40);
        const aRec = recs[amber0]!.record;
        const sRec = recs[sapph0]!.record;
        // Stale 20s Amber-0 override must NOT be resurrected!
        expect("PlayerState" in aRec && aRec.PlayerState.placed).toBe(false);
        expect("PlayerState" in aRec && aRec.PlayerState.pos).toEqual({ x: 0, y: 0 });
        expect("PlayerState" in sRec && sRec.PlayerState.placed).toBe(true);
        expect("PlayerState" in sRec && sRec.PlayerState.pos).toEqual({ x: 400, y: 400 });
        expect(s.problems).toEqual([]);
      }
      expect(hub.b.canUndo).toBe(false);
    } finally {
      hub.stop();
    }
  });

  it("Rebase-only delivery (Major B): losing pause edits below decided_below are reverted without clobbering winner and dead undo entries are dropped", async () => {
    const base = makeHarness(false);
    const ids = base.ids;
    const amber0 = ids.players[0]![0];
    const sapph0 = ids.players[6]![0];
    const baseDoc = JSON.parse(base.replica.view()) as Doc;

    const hub = await createTwoClientHub(baseDoc);
    try {
      // Both clients submit concurrently from clock = null:
      // - Coach A (20s): moves Amber-0 to (200, 200)
      // - Coach B (60s): cseq 0 moves Sapphire-0 to (600, 600), cseq 1 moves Amber-0 to (610, 610)
      expect(hub.a.edit(pauseMoveOps(sessionRecords(hub.a), ids.scene, 20, [{ id: amber0, pos: { x: 200, y: 200 } }]))).toBe(true);
      expect(hub.b.edit(pauseMoveOps(sessionRecords(hub.b), ids.scene, 60, [{ id: sapph0, pos: { x: 600, y: 600 } }]))).toBe(true);
      expect(hub.b.edit(pauseMoveOps(sessionRecords(hub.b), ids.scene, 60, [{ id: amber0, pos: { x: 610, y: 610 } }]))).toBe(true);
      await hub.flush();

      // Drop B before B receives ANY Entry (its two submits are already queued at the server).
      await hub.drop("B");

      // Server accepts A (20s -> Amber-0 at 200,200), then B's two submits (leaking Sapphire-0 at 600,600
      // and Amber-0 at 610,610 onto clock = 20), then A moves Amber-0 to (250, 250) overwriting B's 610,610.
      await hub.deliverAll("A");
      await hub.deliverAll("B");
      expect(hub.a.edit(pauseMoveOps(sessionRecords(hub.a), ids.scene, 20, [{ id: amber0, pos: { x: 250, y: 250 } }]))).toBe(true);
      await hub.deliverAll("A");

      // Reconnect B via ServerMsg::Rebase (compaction floor past B's cseq 0 and 1 -> decided_below = 2).
      await hub.reconnect("B", { rebase: { decidedBelow: 2 } });
      await hub.settle();

      for (const s of [hub.a, hub.b]) {
        const recs = sessionRecords(s);
        expect(sceneClockOf(recs, ids.scene)).toBe(20);
        const aRec = recs[amber0]!.record;
        const sRec = recs[sapph0]!.record;
        // Coach A's winning Amber-0 position (250, 250) is 100% preserved (never unplaced or overwritten!).
        expect("PlayerState" in aRec && aRec.PlayerState.placed).toBe(true);
        expect("PlayerState" in aRec && aRec.PlayerState.pos).toEqual({ x: 250, y: 250 });
        // Coach B's leaked Sapphire-0 override is 100% reverted back to baseline!
        expect("PlayerState" in sRec && sRec.PlayerState.placed).toBe(false);
        expect("PlayerState" in sRec && sRec.PlayerState.pos).toEqual({ x: 0, y: 0 });
        expect(s.problems).toEqual([]);
      }
      // Both of Coach B's dead undo entries were removed on Rebase!
      expect(hub.b.canUndo).toBe(false);
      expect(hub.a.canUndo).toBe(true);
    } finally {
      hub.stop();
    }
  });

  it("Journal-restored pending pause edit (empty undo stack after reload) rolls back cleanly on both own-Entry and Rebase", async () => {
    const base = makeHarness(false);
    const ids = base.ids;
    const amber0 = ids.players[0]![0];
    const sapph0 = ids.players[6]![0];
    const baseDoc = JSON.parse(base.replica.view()) as Doc;

    // Part 1: Journal-restored pending pause edit delivered via own-Entry after reload.
    const hub1 = await createTwoClientHub(baseDoc);
    try {
      // B submits a 60s pause edit while live -> MemoryPersist.savePending journals it while base state keeps undo: [].
      expect(hub1.b.edit(pauseMoveOps(sessionRecords(hub1.b), ids.scene, 60, [{ id: sapph0, pos: { x: 600, y: 600 } }]))).toBe(true);
      await hub1.flush();
      expect((JSON.parse(hub1.persists.B.data.get(BOARD_ID)!) as { undo: unknown[] }).undo).toHaveLength(0);
      expect(hub1.persists.B.journal.get(BOARD_ID)?.size).toBe(1);

      // Drop B before the server processes B's queued submit (tab crash/reload mid-flight).
      await hub1.drop("B");

      // Coach A (20s) wins on the server while B is reloading.
      expect(hub1.a.edit(pauseMoveOps(sessionRecords(hub1.a), ids.scene, 20, [{ id: amber0, pos: { x: 200, y: 200 } }]))).toBe(true);
      await hub1.deliverAll("A");

      // Reload B from persist (journal folds pending tx with empty undo stack -> canUndo === false!).
      await hub1.reload("B");
      expect(hub1.b.canUndo).toBe(false);
      const tagged = (hub1.b as unknown as { pauseEditClocks: Map<number, unknown> }).pauseEditClocks;
      expect(tagged.size).toBe(1);

      // Deliver B's journal-restored edit + rollback.
      await hub1.settle();

      for (const s of [hub1.a, hub1.b]) {
        const recs = sessionRecords(s);
        expect(sceneClockOf(recs, ids.scene)).toBe(20);
        const aRec = recs[amber0]!.record;
        const sRec = recs[sapph0]!.record;
        expect("PlayerState" in aRec && aRec.PlayerState.placed).toBe(true);
        expect("PlayerState" in aRec && aRec.PlayerState.pos).toEqual({ x: 200, y: 200 });
        expect("PlayerState" in sRec && sRec.PlayerState.placed).toBe(false);
        expect("PlayerState" in sRec && sRec.PlayerState.pos).toEqual({ x: 0, y: 0 });
        expect(s.problems).toEqual([]);
      }
    } finally {
      hub1.stop();
    }

    // Part 2: Journal-restored pending pause edits delivered ONLY via ServerMsg::Rebase after reload.
    const hub2 = await createTwoClientHub(baseDoc);
    try {
      // Both submit concurrently: A (20s) moves Amber-0; B (60s) moves Sapphire-0 and Amber-0 (journaled).
      expect(hub2.a.edit(pauseMoveOps(sessionRecords(hub2.a), ids.scene, 20, [{ id: amber0, pos: { x: 200, y: 200 } }]))).toBe(true);
      expect(hub2.b.edit(pauseMoveOps(sessionRecords(hub2.b), ids.scene, 60, [{ id: sapph0, pos: { x: 600, y: 600 } }]))).toBe(true);
      expect(hub2.b.edit(pauseMoveOps(sessionRecords(hub2.b), ids.scene, 60, [{ id: amber0, pos: { x: 610, y: 610 } }]))).toBe(true);
      await hub2.flush();

      // Drop B before seeing any Entry; server commits A, then B's two submits, then A overwrites Amber-0 to (250, 250).
      await hub2.drop("B");
      await hub2.deliverAll("A");
      await hub2.deliverAll("B");
      expect(hub2.a.edit(pauseMoveOps(sessionRecords(hub2.a), ids.scene, 20, [{ id: amber0, pos: { x: 250, y: 250 } }]))).toBe(true);
      await hub2.deliverAll("A");

      // Reload B from persist (folds journal with empty undo stack!) and reconnect via ServerMsg::Rebase.
      await hub2.reload("B", { rebase: { decidedBelow: 2 } });
      expect(hub2.b.canUndo).toBe(false);
      await hub2.settle();

      for (const s of [hub2.a, hub2.b]) {
        const recs = sessionRecords(s);
        expect(sceneClockOf(recs, ids.scene)).toBe(20);
        const aRec = recs[amber0]!.record;
        const sRec = recs[sapph0]!.record;
        // Winner's Amber-0 (250, 250) preserved; journal-restored leaked Sapphire-0 reverted!
        expect("PlayerState" in aRec && aRec.PlayerState.placed).toBe(true);
        expect("PlayerState" in aRec && aRec.PlayerState.pos).toEqual({ x: 250, y: 250 });
        expect("PlayerState" in sRec && sRec.PlayerState.placed).toBe(false);
        expect("PlayerState" in sRec && sRec.PlayerState.pos).toEqual({ x: 0, y: 0 });
        expect(s.problems).toEqual([]);
      }
    } finally {
      hub2.stop();
    }
  });

  it("concurrent 2-replica same-clock tombstone SceneState restore preserves both doors & obj_health and never regresses rows 42 -> 33", () => {
    createRoot((dispose) => {
      // Seed a cycle that creates SceneState with rows: 42 (doors), then clears it via clearPauseOverridesOps -> clean tombstone!
      const h = makeHarness(false);
      const prep0 = preparePausedSceneState(h.board, BOARD_ID, MATCH_ID, h.ids.scene);
      h.apply([
        ...pauseClockOps(h.board.records, h.ids.scene, 10),
        ...prep0.prefix,
        ...placeDoorwayOps({ scene: h.ids.scene, state: prep0.state, mint: () => hexId(8001), seed: [] }, "amber", { x: 10, y: 10 }),
      ]);
      for (const tx of clearPauseOverridesOps(h.board.records, h.ids.scene)) h.apply(tx, true);
      const ssId = liveSceneStateId(BOARD_ID, MATCH_ID);
      expect(h.board.records[ssId]?.deleted).toBe(true);

      // Snapshot the tombstoned state for two independent concurrent replicas A (doors, rows 42) and B (obj_health, rows 33).
      const snapTomb = JSON.stringify({ seq: 0, doc: JSON.parse(h.replica.view()) as Doc });

      const buildSide = (which: "doors" | "health"): Op[] => {
        const rep = new BoardReplica(newClientId(), newClientSecret(), snapTomb);
        const doc = Object.fromEntries(JSON.parse(rep.view()) as Doc) as Record<RecordId, Entry>;
        const miniBoard: MutablePausedBoard = {
          records: doc,
          roster: () => h.rosterSlots,
          playersIn: () => [],
          inScene: () => [],
          rowsIn: () => [],
          edit: () => true,
          editSilent: () => true,
          ensure: () => true,
          dropHistoryFor: () => {},
        };
        const prep = preparePausedSceneState(miniBoard, BOARD_ID, MATCH_ID, h.ids.scene);
        const clockOps = pauseClockOps(doc, h.ids.scene, 20);
        if (which === "doors") {
          return [
            ...clockOps,
            ...prep.prefix,
            ...placeDoorwayOps({ scene: h.ids.scene, state: prep.state, mint: () => hexId(8101), seed: [] }, "amber", { x: 50, y: 60 }),
          ];
        }
        return [
          ...clockOps,
          ...prep.prefix,
          ...setObjectiveHealthOps(
            {
              scene: h.ids.scene,
              state: prep.state,
              objectives: new Map(),
              markers: MARKERS,
              mint: () => hexId(8102),
              seed: new Map(),
              upsertObjective: liveObjUpsert(doc, BOARD_ID, MATCH_ID, h.ids.scene, new Map()),
            },
            WALKER,
            45,
          ),
        ];
      };

      const opsA = buildSide("doors");
      const opsB = buildSide("health");

      // Verify BOTH serialization orders (A-then-B and B-then-A)!
      for (const order of [
        [opsA, opsB],
        [opsB, opsA],
      ] as const) {
        const srv = new BoardReplica(newClientId(), newClientSecret(), snapTomb);
        for (const tx of order) {
          const res = JSON.parse(srv.edit(JSON.stringify(tx)));
          expect(res.refused, JSON.stringify(res)).toBeNull();
        }
        const finalDoc = Object.fromEntries(JSON.parse(srv.view()) as Doc) as Record<RecordId, Entry>;
        const ss = finalDoc[ssId]!;
        expect(ss.deleted).toBe(false);
        expect("SceneState" in ss.record).toBe(true);
        if ("SceneState" in ss.record) {
          expect(ss.record.SceneState.more?.rows).toBe(42);
          expect(ss.record.SceneState.more?.has_doors).toBe(true);
          expect(decodeDoors(ss.record.SceneState.more?.doors)).toHaveLength(1);
          expect(ss.record.SceneState.more?.has_obj_health).toBe(true);
          expect(decodeObjHealth(ss.record.SceneState.more?.obj_health, MARKERS).get(WALKER.key)).toEqual({ pct: 45 });
        }
      }
      dispose();
    });
  });

  it("no-op edit checks at a different timestamp leave peer overrides untouched", () => {
    createRoot((dispose) => {
      const { ids, board, apply, pl } = makeHarness(false);
      // Coach A edits at 20s.
      apply(pauseMoveOps(board.records, ids.scene, 20, [{ id: pl(0).id, pos: { x: 350, y: -250 } }]));
      expect(sceneClockOf(board.records, ids.scene)).toBe(20);

      // Coach B at 60s checks no-op actions before calling prepareLivePauseEdit:
      // 1. clearTeamDoorsOps with 0 doors on amber -> returns []
      expect(clearTeamDoorsOps({ scene: ids.scene, state: undefined, mint: () => hexId(8201), seed: [] }, "amber")).toEqual([]);
      // 2. pauseRenameOps with empty string on untouched baseline -> returns []
      expect(pauseRenameOps(board.records, ids.scene, 60, { id: pl(1).id, state: pl(1).state }, "   ")).toEqual([]);
      // 3. pauseRespawnOps with null on untouched baseline -> returns []
      expect(pauseRespawnOps(board.records, ids.scene, 60, { id: pl(1).id, state: pl(1).state }, null)).toEqual([]);

      // Coach A's 20s edits are completely untouched!
      expect(sceneClockOf(board.records, ids.scene)).toBe(20);
      expect(pl(0).state.placed).toBe(true);
      expect(pl(0).state.pos).toEqual({ x: 350, y: -250 });
      dispose();
    });
  });

  it("timestamp-switch clear in prepareLivePauseEdit prunes prior undo/redo entries via dropHistoryFor", () => {
    createRoot((dispose) => {
      const { replica, ids, board, apply, pl } = makeHarness(false);
      // Edit at 20s (pushes onto undo stack).
      apply(pauseMoveOps(board.records, ids.scene, 20, [{ id: pl(0).id, pos: { x: 200, y: 200 } }]));
      // Switch to 60s via prepareLivePauseEdit -> clears 20s to null and prunes 20s undo entries!
      prepareLivePauseEdit(board, ids.scene, 60);
      const edit60 = pauseMoveOps(board.records, ids.scene, 60, [{ id: pl(1).id, pos: { x: 600, y: 600 } }]);
      apply(edit60);

      // Undo once -> undoes ONLY the 60s edit, leaves canUndo === false (never resurrects 20s!).
      const u1 = JSON.parse(replica.undo());
      expect(u1.refused).toBeNull();
      expect(u1.canUndo).toBe(false);
      const afterUndo = Object.fromEntries(JSON.parse(replica.view()) as Doc) as Record<RecordId, Entry>;
      const p0 = afterUndo[pl(0).id]!;
      expect("PlayerState" in p0.record && p0.record.PlayerState.placed).toBe(false);
      dispose();
    });
  });

  it("reload cleanup scrubs stale liveScene overrides and prunes live-entity undo/redo while keeping real-scene undo", () => {
    createRoot((dispose) => {
      const { replica, ids, board, apply, pl } = makeHarness(false);
      const realCallout = hexId(8301);
      // Real scene edit (must survive reload cleanup).
      apply([
        {
          Create: {
            id: realCallout,
            record: { Callout: { scene: hexId(2), pos: { x: 10, y: 20 }, text: "plan", color: null, side: "Below" } },
          },
        },
      ]);
      // Stale liveScene pause edits (one undone onto redo stack, one on undo stack).
      apply(pauseMoveOps(board.records, ids.scene, 20, [{ id: pl(0).id, pos: { x: 111, y: 222 } }]));
      apply(pauseMoveOps(board.records, ids.scene, 20, [{ id: pl(1).id, pos: { x: 333, y: 444 } }]));
      replica.undo();

      // Simulate layer.ts SETTLE_MS reload cleanup: silent clear + dropHistoryFor(liveEntityRecordIds).
      for (const tx of clearPauseOverridesOps(board.records, ids.scene)) apply(tx, true);
      const dropRes = JSON.parse(replica.dropHistoryFor(JSON.stringify(liveEntityRecordIds(board.records, ids.scene))));
      expect(dropRes.canRedo).toBe(false);
      expect(dropRes.canUndo).toBe(true);

      // Undo removes the real-scene callout, NOT any scrubbed live entity.
      const u1 = JSON.parse(replica.undo());
      expect(u1.canUndo).toBe(false);
      const finalDoc = Object.fromEntries(JSON.parse(replica.view()) as Doc) as Record<RecordId, Entry>;
      expect(finalDoc[realCallout]?.deleted).toBe(true);
      dispose();
    });
  });

  it("Save as scene builds-overflow fallback still bakes ov.state doors and obj_health", () => {
    createRoot((dispose) => {
      // Force the heroes-only fallback by creating 220 objectives + huge builds so builds cannot fit,
      // while heroes + SceneState with pause overrides DO fit!
      const { rosterSlots } = makeHarness(false);
      const longPlayers = (["amber", "sapphire"] as const).flatMap((team) =>
        [0, 1, 2, 3, 4, 5].map((slot) => {
          const base = mkPlayer(team, slot);
          return {
            ...base,
            items: Array.from({ length: 220 }, (_, k) => [100_000 + k, 4_000_000_000 + k, 0] as [number, number, number]),
          };
        }),
      );
      const extraKeys = Array.from({ length: 190 }, (_, k) => `camp:neutral:lane0:extra_${k}`);
      const bigTl = makeTimeline({
        players: longPlayers,
        objectives: extraKeys.map((key) => ({ key, kind: "walker", team: "amber", lane: 1, destroyed_s: 1 })),
      });
      const bigMarkers = [
        ...MARKERS,
        ...extraKeys.map((key) => ({ key, kind: "t2" as const, team: "amber" as const, lane: "yellow" as const, at: { x: 0, y: 0 } })),
      ];
      const overrides: PauseOverrides = {
        players: new Map(),
        objectives: new Map(),
        waves: new Map(),
        state: {
          rows: 42,
          has_doors: true,
          doors: encodeDoors([{ id: 0, team: "amber", at: { x: 77, y: 88 }, role: "unpaired", partner: null, inSight: true }]),
          has_obj_health: true,
          obj_health: encodeObjHealth(new Map([[WALKER.key, { pct: 40 }]]), MARKERS).ints,
        } as More,
      };
      let n = 8400;
      const saved = matchSceneOps(rosterSlots, [], undefined, bigTl, 2, bigMarkers, () => hexId(n++), [], {
        source: sourceOf(bigTl),
        builds: false, // explicitly exercise the builds: false / heroes-only fallback path
        overrides,
      });
      expect(saved.builds).toBe(false);
      expect(saved.ops.length).toBeGreaterThan(0);
      expect(saved.ops.length).toBeLessThanOrEqual(LIMITS.max_ops_per_tx);
      expect(opsBytes(saved.ops)).toBeLessThanOrEqual(LIMITS.max_tx_bytes);
      const ss = saved.ops.flatMap((o) => ("Create" in o && "SceneState" in o.Create.record ? [o.Create.record.SceneState] : []))[0]!;
      expect(ss.more?.has_doors).toBe(true);
      expect(decodeDoors(ss.more?.doors)).toEqual([{ id: 0, team: "amber", at: { x: 77, y: 88 }, role: "unpaired", partner: null, inSight: true }]);
      expect(ss.more?.has_obj_health).toBe(true);
      expect(decodeObjHealth(ss.more?.obj_health, MARKERS).get(WALKER.key)).toEqual({ pct: 40 });
      dispose();
    });
  });

  it("isLiveEntityCreate returns false for mixed live-entity + unrelated Create transactions (Minor #12)", () => {
    createRoot((dispose) => {
      const { ids, readDoc } = makeHarness(false);
      const recMap = new Map(Object.entries(readDoc()));
      expect(
        isLiveEntityCreate(BOARD_ID, recMap, {
          kind: "Edit",
          ops: [
            { Create: { id: liveWaveId(BOARD_ID, MATCH_ID, "yellow"), record: { Wave: { scene: ids.scene, lane: "yellow", t: 500 } } } },
            { Create: { id: hexId(8501), record: { Stroke: { scene: ids.scene, color: 0, width: 6, points: [{ x: 0, y: 0 }, { x: 50, y: 50 }] } } } },
          ],
        }),
      ).toBe(false);
      dispose();
    });
  });
});
